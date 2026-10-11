import type { WebContents } from "electron";
import { pageOperation, type PageOperation } from "../automation-dom";
import type { Authority } from "./authority";
import { ApiError, fail } from "./errors";
import type { Park, Run } from "./http";
import { allocateRefs } from "./refs";
import type { AutomationController } from "./server";
import { PRESS_KEYS, type ToolAction } from "./validate";

const WORLD_ID = 1001;
export type Point = { x: number; y: number };

export const finitePoint = (point: unknown): point is Point =>
  !!point &&
  Number.isFinite((point as Point).x) &&
  Number.isFinite((point as Point).y);
// Refs the page moved to a control it drew again, as the page reported them.
export const reboundOf = (result: Record<string, unknown>) =>
  Array.isArray(result.rebound) ? { rebound: result.rebound } : {};

export async function bounded<T>(operation: Promise<T>, timeout = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ApiError(
                504,
                "page_timeout",
                "The page did not respond in time.",
                { awaited: "page" },
              ),
            ),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function remaining(deadline: number): number {
  const milliseconds = deadline - Date.now();
  if (milliseconds <= 0)
    return fail(
      504,
      "action_timeout",
      "The action time budget expired. Inspect the page before retrying a side effect.",
    );
  return Math.min(15000, milliseconds);
}

export interface Actions {
  trackContents(contents: WebContents): { epoch: number };
  readyContents(
    id: string,
    timeout?: number,
    allowLoading?: boolean,
    park?: Park,
  ): Promise<WebContents>;
  evaluatePage(
    id: string,
    contents: WebContents,
    operation: PageOperation,
    payload: Record<string, unknown>,
    deadline: number,
  ): Promise<Record<string, unknown>>;
  executeToolAction(
    id: string,
    action: ToolAction,
    run: Run,
  ): Promise<Record<string, unknown>>;
  dispose(): void;
}

export function createActions(deps: {
  controller: AutomationController;
  authority: Authority;
  referenceSession: string;
}): Actions {
  const { controller, referenceSession } = deps;
  const { authorizeTab } = deps.authority;
  const trackedContents = new Map<
    WebContents,
    {
      epoch: number;
      listener: (
        event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ) => void;
      destroyed: () => void;
    }
  >();
  const trackContents = (contents: WebContents) => {
    let tracked = trackedContents.get(contents);
    if (!tracked) {
      tracked = {
        epoch: 0,
        listener: (details) => {
          if (details.isMainFrame && !details.isSameDocument) tracked!.epoch++;
        },
        destroyed: () => trackedContents.delete(contents),
      };
      trackedContents.set(contents, tracked);
      contents.on("did-start-navigation", tracked.listener);
      contents.once("destroyed", tracked.destroyed);
    }
    return tracked;
  };
  const readyContents = async (
    id: string,
    timeout = 15000,
    allowLoading = false,
    park?: Park,
  ) => {
    authorizeTab(id);
    const contents = controller.getWebContents(id);
    if (!contents || contents.isDestroyed())
      return fail(
        409,
        "no_web_page",
        "Navigate this tab to an HTTP or HTTPS page first.",
      );
    trackContents(contents);
    if (!allowLoading && contents.isLoadingMainFrame()) {
      const loading = () => new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          contents.removeListener("did-stop-loading", loaded);
          contents.removeListener("destroyed", destroyed);
        };
        const loaded = () => {
          cleanup();
          resolve();
        };
        const destroyed = () => {
          cleanup();
          reject(new ApiError(409, "tab_closed", "The tab was closed."));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(
            new ApiError(
              504,
              "page_timeout",
              "The page is still loading. Try again.",
              { awaited: "load" },
            ),
          );
        }, timeout);
        contents.once("did-stop-loading", loaded);
        contents.once("destroyed", destroyed);
      });
      await (park ? park(loading) : loading());
    }
    authorizeTab(id);
    if (contents.isDestroyed())
      return fail(409, "tab_closed", "The tab was closed.");
    return contents;
  };
  const evaluatePage = async (
    id: string,
    contents: WebContents,
    operation: PageOperation,
    payload: Record<string, unknown>,
    deadline: number,
  ) => {
    authorizeTab(id);
    const epoch = trackContents(contents).epoch;
    const namespace = `${referenceSession}:${id}:${epoch}`;
    const result = (await bounded(
      contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [
        {
          code: `(${pageOperation.toString()})(${JSON.stringify(operation)},${JSON.stringify(payload)},${JSON.stringify(namespace)})`,
        },
      ]),
      remaining(deadline),
    )) as Record<string, unknown>;
    authorizeTab(id);
    if (
      ["snapshot", "target", "focus", "drag"].includes(operation) &&
      trackContents(contents).epoch !== epoch
    )
      return fail(
        409,
        "page_changed",
        "The page navigated during this operation. Inspect the new page before continuing.",
      );
    // A control inside a frame from another origin is a conflict with the
    // page, not a bad request, like a control the person is using.
    if (result?.ok === false)
      return fail(
        result.code === "cross_origin_frame" ? 409 : 422,
        typeof result.code === "string" ? result.code : "element_action_failed",
        typeof result.error === "string"
          ? result.error
          : "Could not interact with the element.",
      );
    return result;
  };
  const nativeInput = async (
    id: string,
    contents: WebContents,
    commands: {
      method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent";
      parameters: Record<string, unknown>;
    }[],
    deadline: number,
    epoch: number,
  ) => {
    authorizeTab(id);
    if (contents.debugger.isAttached())
      return fail(
        409,
        "debugger_busy",
        "Close this tab's developer tools before using native agent input.",
      );
    contents.debugger.attach("1.3");
    try {
      for (const command of commands) {
        authorizeTab(id);
        if (
          !["mouseReleased", "keyUp"].includes(
            command.parameters.type as string,
          ) &&
          trackContents(contents).epoch !== epoch
        )
          return fail(
            409,
            "page_changed",
            "The page navigated before input completed. Inspect the new page before continuing.",
          );
        await bounded(
          contents.debugger.sendCommand(command.method, command.parameters),
          remaining(deadline),
        );
      }
    } finally {
      if (!contents.isDestroyed() && contents.debugger.isAttached())
        contents.debugger.detach();
    }
    authorizeTab(id);
  };
  // Presses on the source, moves past the distance pages wait for before a
  // drag starts (4 pixels in Chromium, 5 to 8 in pointer libraries), then on to
  // the target in steps. An HTML drag the page starts is intercepted, so no
  // operating system drag begins, and is moved with drag events instead.
  const nativeDrag = async (
    id: string,
    contents: WebContents,
    from: Point,
    to: Point,
    armed: Record<string, unknown>,
    deadline: number,
    epoch: number,
  ): Promise<"html5" | "mouse"> => {
    authorizeTab(id);
    if (contents.debugger.isAttached())
      return fail(
        409,
        "debugger_busy",
        "Close this tab's developer tools before using native agent input.",
      );
    contents.debugger.attach("1.3");
    let data: unknown;
    let intercepted = () => {};
    const listener = (
      _event: Electron.Event,
      method: string,
      parameters: { data?: unknown },
    ) => {
      if (method !== "Input.dragIntercepted") return;
      data = parameters.data;
      intercepted();
    };
    contents.debugger.on("message", listener);
    let dragging = false;
    let dropped = false;
    let last = from;
    // The final release or drop is still sent after a navigation starts.
    const send = async (
      method: string,
      parameters: Record<string, unknown>,
      final = false,
    ) => {
      authorizeTab(id);
      if (!final && trackContents(contents).epoch !== epoch)
        return fail(
          409,
          "page_changed",
          "The page navigated before input completed. Inspect the new page before continuing.",
        );
      await bounded(
        contents.debugger.sendCommand(method, parameters),
        remaining(deadline),
      );
    };
    const mouse = (type: string, point: Point, buttons: number, final = false) =>
      send(
        "Input.dispatchMouseEvent",
        {
          type,
          x: point.x,
          y: point.y,
          button: type === "mouseMoved" && !buttons ? "none" : "left",
          buttons,
          ...(type === "mouseMoved" ? {} : { clickCount: 1 }),
        },
        final,
      );
    const drag = (type: string, point: Point, final = false) =>
      send("Input.dispatchDragEvent", { type, x: point.x, y: point.y, data }, final);
    const pause = () => new Promise((resolve) => setTimeout(resolve, 16));
    try {
      try {
        await contents.debugger.sendCommand("Input.setInterceptDrags", {
          enabled: true,
        });
      } catch {
        return fail(
          409,
          "drag_unavailable",
          "Kamapathy could not take over drags in this tab.",
        );
      }
      const dx = to.x - from.x,
        dy = to.y - from.y;
      const distance = Math.hypot(dx, dy);
      const start = distance
        ? { x: from.x + (dx / distance) * 10, y: from.y + (dy / distance) * 10 }
        : { x: from.x + 10, y: from.y };
      const path = Array.from({ length: 8 }, (_, step) => ({
        x: start.x + ((to.x - start.x) * (step + 1)) / 8,
        y: start.y + ((to.y - start.y) * (step + 1)) / 8,
      }));
      path.push(to);
      await mouse("mouseMoved", from, 0);
      await mouse("mousePressed", from, 1);
      await mouse("mouseMoved", start, 1);
      last = start;
      // The page decides in its dragstart handlers whether an HTML drag
      // starts. Its data reaches Kamapathy shortly after.
      await evaluatePage(id, contents, "frame", {}, deadline);
      const counts = await evaluatePage(id, contents, "input", {}, deadline);
      if (
        data === undefined &&
        typeof armed.drag === "number" &&
        typeof counts.drag === "number" &&
        counts.drag > armed.drag
      ) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          intercepted = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        if (data === undefined) {
          await mouse("mouseReleased", start, 0, true);
          return fail(
            409,
            "drag_not_delivered",
            "The page started a drag that Kamapathy could not move. Inspect the page before retrying.",
          );
        }
      }
      if (data !== undefined) {
        dragging = true;
        await drag("dragEnter", start);
      }
      for (const point of path) {
        await pause();
        if (dragging) await drag("dragOver", point);
        else if (data !== undefined) {
          dragging = true;
          await drag("dragEnter", point);
        } else await mouse("mouseMoved", point, 1);
        last = point;
      }
      await pause();
      if (dragging) {
        await drag("drop", to, true);
        dropped = true;
        return "html5";
      }
      await mouse("mouseReleased", to, 0, true);
      return "mouse";
    } finally {
      const attached = () =>
        !contents.isDestroyed() && contents.debugger.isAttached();
      // An intercepted drag holds the tab's mouse until it ends, so it is
      // cancelled even after the person takes over. A mouse release is never
      // sent then: pointer libraries drop on it.
      if (data !== undefined && !dropped && attached())
        await bounded(
          contents.debugger.sendCommand("Input.dispatchDragEvent", {
            type: "dragCancel",
            x: last.x,
            y: last.y,
            data,
          }),
          2000,
        ).catch(() => {});
      if (attached()) {
        await bounded(
          contents.debugger.sendCommand("Input.setInterceptDrags", {
            enabled: false,
          }),
          2000,
        ).catch(() => {});
        if (attached()) contents.debugger.detach();
      }
      contents.debugger.removeListener("message", listener);
    }
  };
  // Chromium reports a successful dispatch for native input that it drops while a
  // page has not rendered a frame since its last navigation. Confirm the page
  // received the input and repeat only input that provably never arrived.
  const deliverNativeInput = async <T>(
    id: string,
    contents: WebContents,
    kind: "mouse" | "key",
    deliver: (armed: Record<string, unknown>) => Promise<T>,
    deadline: number,
    epoch: number,
  ): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      const armed = await evaluatePage(id, contents, "input", {}, deadline);
      const delivered = await deliver(armed);
      // Input that already changed the page was delivered.
      if (trackContents(contents).epoch !== epoch) return delivered;
      const received = await evaluatePage(id, contents, "input", {}, deadline);
      const before = armed[kind];
      const after = received[kind];
      // Repeat input only on positive evidence that the page never received it.
      if (typeof before !== "number" || typeof after !== "number" || after > before)
        return delivered;
      if (attempt >= 2)
        return fail(
          409,
          "input_not_delivered",
          "The page did not accept native input. Inspect the page before retrying.",
        );
      await evaluatePage(
        id,
        contents,
        "frame",
        {},
        Math.min(deadline, Date.now() + 2000),
      ).catch(() => {});
    }
  };
  const executeToolAction = async (
    id: string,
    action: ToolAction,
    run: Run,
  ): Promise<Record<string, unknown>> => {
    const { deadline, park } = run;
    const tab = authorizeTab(id);
    const waitDeadline =
      action.type === "wait"
        ? Math.min(deadline, Date.now() + (action.payload.timeoutMs as number))
        : deadline;
    const contents = await readyContents(
      id,
      remaining(deadline),
      action.type === "wait",
      park,
    );
    const epoch = trackContents(contents).epoch;
    const payload = action.payload;
    let result: Record<string, unknown>;
    if (action.type === "snapshot") {
      const firstRef = allocateRefs();
      result = {
        tabId: id,
        ...(await evaluatePage(
          id,
          contents,
          "snapshot",
          { ...payload, firstRef },
          deadline,
        )),
      };
    } else if (action.type === "click") {
      const point = await evaluatePage(
        id,
        contents,
        "target",
        payload,
        deadline,
      );
      // A control drawn with no size has no point to press, so the page
      // clicks it, once its surroundings are on screen and uncovered.
      const empty = point.empty === true;
      if (empty) {
        if (trackContents(contents).epoch !== epoch)
          return fail(
            409,
            "page_changed",
            "The page navigated during this operation. Inspect the new page before continuing.",
          );
        await evaluatePage(id, contents, "click", payload, deadline);
      }
      else {
        if (!finitePoint(point))
          return fail(
            422,
            "invalid_target",
            "The page did not provide a valid click target.",
          );
        await deliverNativeInput(
          id,
          contents,
          "mouse",
          () =>
            nativeInput(
              id,
              contents,
              [
                {
                  method: "Input.dispatchMouseEvent",
                  parameters: { type: "mouseMoved", x: point.x, y: point.y },
                },
                {
                  method: "Input.dispatchMouseEvent",
                  parameters: {
                    type: "mousePressed",
                    x: point.x,
                    y: point.y,
                    button: "left",
                    clickCount: 1,
                  },
                },
                {
                  method: "Input.dispatchMouseEvent",
                  parameters: {
                    type: "mouseReleased",
                    x: point.x,
                    y: point.y,
                    button: "left",
                    clickCount: 1,
                  },
                },
              ],
              deadline,
              epoch,
            ),
          deadline,
          epoch,
        );
      }
      // Let synchronous submit/navigation handlers start, then wait for their load.
      // No input operation is retried, including when navigation times out.
      await park(() => new Promise((resolve) => setTimeout(resolve, 100)));
      await readyContents(id, remaining(deadline), false, park);
      result = {
        ok: true,
        url: contents.getURL(),
        ...(empty ? { fallback: "dom_click" } : {}),
        ...reboundOf(point),
      };
    } else if (action.type === "fill") {
      result = await evaluatePage(id, contents, "fill", payload, deadline);
    } else if (action.type === "drag") {
      const points = await evaluatePage(id, contents, "drag", payload, deadline);
      const from = points.from as Point,
        to = points.to as Point;
      if (!finitePoint(from) || !finitePoint(to))
        return fail(
          422,
          "invalid_target",
          "The page did not provide valid drag points.",
        );
      const mode = await deliverNativeInput(
        id,
        contents,
        "mouse",
        (armed) => nativeDrag(id, contents, from, to, armed, deadline, epoch),
        deadline,
        epoch,
      );
      await park(() => new Promise((resolve) => setTimeout(resolve, 100)));
      await readyContents(id, remaining(deadline), false, park);
      result = {
        ok: true,
        url: contents.getURL(),
        drag: mode,
        ...reboundOf(points),
      };
    } else if (action.type === "press") {
      let focused: Record<string, unknown> = {};
      if (payload.ref || payload.selector)
        focused = await evaluatePage(id, contents, "focus", payload, deadline);
      const key = PRESS_KEYS[payload.key as string];
      const parameters = {
        key: key.key,
        code: key.code,
        windowsVirtualKeyCode: key.keyCode,
        nativeVirtualKeyCode: key.keyCode,
        ...(key.text ? { text: key.text, unmodifiedText: key.text } : {}),
      };
      await deliverNativeInput(
        id,
        contents,
        "key",
        () =>
          nativeInput(
            id,
            contents,
            [
              {
                method: "Input.dispatchKeyEvent",
                parameters: {
                  type: key.text ? "keyDown" : "rawKeyDown",
                  ...parameters,
                },
              },
              {
                method: "Input.dispatchKeyEvent",
                parameters: {
                  type: "keyUp",
                  key: key.key,
                  code: key.code,
                  windowsVirtualKeyCode: key.keyCode,
                  nativeVirtualKeyCode: key.keyCode,
                },
              },
            ],
            deadline,
            epoch,
          ),
        deadline,
        epoch,
      );
      await park(() => new Promise((resolve) => setTimeout(resolve, 100)));
      await readyContents(id, remaining(deadline), false, park);
      result = { ok: true, url: contents.getURL(), ...reboundOf(focused) };
    } else if (action.type === "scroll") {
      result = await evaluatePage(id, contents, "scroll", payload, deadline);
    } else {
      for (;;) {
        authorizeTab(id);
        let observation: Record<string, unknown>;
        try {
          observation = await evaluatePage(
            id,
            contents,
            "check",
            payload,
            // Zero makes one attempt with a short IPC response allowance.
            payload.timeoutMs === 0
              ? Math.min(deadline, Date.now() + 250)
              : Math.min(deadline, Math.max(Date.now() + 1, waitDeadline)),
          );
        } catch (error) {
          if (
            !(error instanceof ApiError) ||
            !["page_timeout", "action_timeout"].includes(error.code) ||
            Date.now() < waitDeadline
          )
            throw error;
          return fail(
            408,
            "wait_timeout",
            "The requested page condition was not observed before the timeout.",
          );
        }
        if (observation.matched) {
          result = { ok: true };
          break;
        }
        if (Date.now() >= waitDeadline)
          return fail(
            408,
            "wait_timeout",
            "The requested page condition was not observed before the timeout.",
          );
        await park(
          () =>
            new Promise((resolve) =>
              setTimeout(resolve, Math.min(100, waitDeadline - Date.now())),
            ),
        );
        await readyContents(id, remaining(deadline), true, park);
      }
    }
    authorizeTab(id);
    const descriptions = {
      snapshot: "Agent read a page snapshot",
      click: "Agent clicked an element",
      fill: "Agent filled a field",
      press: "Agent pressed a key",
      scroll: "Agent scrolled a page",
      drag: "Agent dragged an element",
      wait: "Agent observed a page condition",
    };
    controller.addActivity(tab.spaceId, descriptions[action.type], "info");
    return result;
  };
  return {
    trackContents,
    readyContents,
    evaluatePage,
    executeToolAction,
    dispose() {
      for (const [contents, tracked] of trackedContents) {
        if (!contents.isDestroyed()) {
          contents.removeListener("did-start-navigation", tracked.listener);
          contents.removeListener("destroyed", tracked.destroyed);
        }
      }
      trackedContents.clear();
    },
  };
}
