import type { WebContents } from "electron";
import type { PageOperation } from "../automation-dom";
import type { Authority } from "./authority";
import { ApiError, fail } from "./errors";
import type { Park, Run } from "./http";
import { allocateRefs } from "./refs";
import type { AutomationController } from "./server";
import { CdpTimeoutError, PageCrashedError } from "./session/errors";
import type { TabSession } from "./session/tab-session";
import type { TabSessions } from "./session/tab-sessions";
import type { Step } from "./session/types";
import { PRESS_KEYS, type ToolAction } from "./validate";

export type Point = { x: number; y: number };

export const finitePoint = (point: unknown): point is Point =>
  !!point &&
  Number.isFinite((point as Point).x) &&
  Number.isFinite((point as Point).y);
// Refs the page moved to a control it drew again, as the page reported them.
export const reboundOf = (result: Record<string, unknown>) =>
  Array.isArray(result.rebound) ? { rebound: result.rebound } : {};

export async function bounded<T>(
  operation: Promise<T>,
  timeout = 15000,
): Promise<T> {
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
  readyContents(
    id: string,
    timeout?: number,
    allowLoading?: boolean,
    park?: Park,
  ): Promise<{ contents: WebContents; session: TabSession }>;
  evaluatePage(
    id: string,
    session: TabSession,
    operation: PageOperation,
    payload: Record<string, unknown>,
    deadline: number,
    step?: Step,
  ): Promise<Record<string, unknown>>;
  executeToolAction(
    id: string,
    action: ToolAction,
    run: Run,
  ): Promise<Record<string, unknown>>;
}

export function createActions(deps: {
  controller: AutomationController;
  authority: Authority;
  sessions: TabSessions;
  referenceSession: string;
}): Actions {
  const { controller, authority, sessions, referenceSession } = deps;
  const { authorizeTab } = authority;
  // Each page of a tab the agent controls has a debugger session from the
  // moment its view exists.
  const sessionOf = (id: string, contents: WebContents): TabSession => {
    const session = sessions.get(id);
    if (session?.contents === contents) return session;
    return fail(
      409,
      "debugger_busy",
      "Kamapathy lost its connection to this tab. Try again shortly.",
      { reason: "unavailable" },
    );
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
    sessionOf(id, contents);
    if (!allowLoading && contents.isLoadingMainFrame()) {
      const load = () =>
        new Promise<void>((resolve, reject) => {
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
      await (park ? park(load) : load());
    }
    authorizeTab(id);
    if (contents.isDestroyed())
      return fail(409, "tab_closed", "The tab was closed.");
    const session = sessionOf(id, contents);
    if (session.state === "crashed") throw new PageCrashedError();
    return { contents, session };
  };

  const evaluatePage = async (
    id: string,
    session: TabSession,
    operation: PageOperation,
    payload: Record<string, unknown>,
    deadline: number,
    step?: Step,
  ) => {
    authorizeTab(id);
    const epoch = session.epoch;
    const namespace = `${referenceSession}:${id}:${epoch}`;
    const frameId = await session.mainFrameId({
      deadline,
      signal: step?.signal,
    });
    const result = await session.evaluateInFrame(frameId, operation, payload, {
      deadline,
      signal: step?.signal,
      guard: () => authorizeTab(id),
      dispatch: step?.dispatch,
      namespace,
      timeoutMs: remaining(deadline),
    });
    authorizeTab(id);
    if (
      ["snapshot", "target", "focus", "drag"].includes(operation) &&
      session.epoch !== epoch
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
    session: TabSession,
    commands: {
      method: "Input.dispatchMouseEvent" | "Input.dispatchKeyEvent";
      parameters: Record<string, unknown>;
    }[],
    gesture: Step,
    epoch: number,
  ) => {
    for (const command of commands) {
      authorizeTab(id);
      if (
        !["mouseReleased", "keyUp"].includes(
          command.parameters.type as string,
        ) &&
        session.epoch !== epoch
      )
        return fail(
          409,
          "page_changed",
          "The page navigated before input completed. Inspect the new page before continuing.",
        );
      await session.send(command.method, command.parameters, gesture);
    }
  };
  // Presses on the source, moves past the distance pages wait for before a
  // drag starts (4 pixels in Chromium, 5 to 8 in pointer libraries), then on to
  // the target in steps. An HTML drag the page starts is intercepted, so no
  // operating system drag begins, and is moved with drag events instead.
  const nativeDrag = async (
    id: string,
    session: TabSession,
    from: Point,
    to: Point,
    armed: Record<string, unknown>,
    gesture: Step,
    epoch: number,
  ): Promise<"html5" | "mouse"> => {
    authorizeTab(id);
    let data: unknown;
    let intercepted = () => {};
    const stopListening = session.on("Input.dragIntercepted", (event) => {
      data = event.params.data;
      intercepted();
    });
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
      if (!final && session.epoch !== epoch)
        return fail(
          409,
          "page_changed",
          "The page navigated before input completed. Inspect the new page before continuing.",
        );
      await session.send(method, parameters, gesture);
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
        // No guard: a takeover here is reported by the first mouse event.
        await session.send(
          "Input.setInterceptDrags",
          { enabled: true },
          { deadline: gesture.deadline, dispatch: gesture.dispatch },
        );
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
      await evaluatePage(id, session, "frame", {}, gesture.deadline, gesture);
      const counts = await evaluatePage(
        id,
        session,
        "input",
        {},
        gesture.deadline,
        gesture,
      );
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
      // An intercepted drag holds the tab's mouse until it ends, so it is
      // cancelled even after the person takes over. A mouse release is never
      // sent then: pointer libraries drop on it.
      if (data !== undefined && !dropped)
        await session
          .send(
            "Input.dispatchDragEvent",
            { type: "dragCancel", x: last.x, y: last.y, data },
            { deadline: Date.now() + 2000, timeoutMs: 2000 },
          )
          .catch(() => {});
      await session
        .send(
          "Input.setInterceptDrags",
          { enabled: false },
          { deadline: Date.now() + 2000, timeoutMs: 2000 },
        )
        .catch(() => {});
      stopListening();
    }
  };
  // Chromium reports a successful dispatch for native input that it drops while a
  // page has not rendered a frame since its last navigation. Confirm the page
  // received the input and repeat only input that provably never arrived.
  const deliverNativeInput = async <T>(
    id: string,
    session: TabSession,
    kind: "mouse" | "key",
    deliver: (armed: Record<string, unknown>) => Promise<T>,
    step: Step,
    epoch: number,
  ): Promise<T> => {
    for (let attempt = 0; ; attempt += 1) {
      const armed = await evaluatePage(id, session, "input", {}, step.deadline, step);
      const delivered = await deliver(armed);
      // Input that already changed the page was delivered.
      if (session.epoch !== epoch) return delivered;
      const received = await evaluatePage(
        id,
        session,
        "input",
        {},
        step.deadline,
        step,
      );
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
        session,
        "frame",
        {},
        Math.min(step.deadline, Date.now() + 2000),
        step,
      ).catch(() => {});
    }
  };
  const executeToolAction = async (
    id: string,
    action: ToolAction,
    run: Run,
  ): Promise<Record<string, unknown>> => {
    const tab = authorizeTab(id);
    const deadline = run.deadline;
    // One dispatch record per request, and per batch step.
    const step: Step = {
      deadline,
      signal: run.signal,
      guard: () => authorizeTab(id),
      dispatch: { dispatched: false },
    };
    // A gesture runs to its end even if the client goes away.
    const gesture: Step = {
      deadline,
      guard: step.guard,
      dispatch: step.dispatch,
    };
    const waitDeadline =
      action.type === "wait"
        ? Math.min(deadline, Date.now() + (action.payload.timeoutMs as number))
        : deadline;
    const ready = await readyContents(
      id,
      remaining(deadline),
      action.type === "wait",
      run.park,
    );
    const contents = ready.contents;
    let session = ready.session;
    const epoch = session.epoch;
    const payload = action.payload;
    let result: Record<string, unknown>;
    if (action.type === "snapshot") {
      const firstRef = allocateRefs();
      result = {
        tabId: id,
        ...(await evaluatePage(
          id,
          session,
          "snapshot",
          { ...payload, firstRef },
          deadline,
          step,
        )),
      };
    } else if (action.type === "click") {
      const point = await evaluatePage(
        id,
        session,
        "target",
        payload,
        deadline,
        step,
      );
      // A control drawn with no size has no point to press, so the page
      // clicks it, once its surroundings are on screen and uncovered.
      const empty = point.empty === true;
      if (empty) {
        if (session.epoch !== epoch)
          return fail(
            409,
            "page_changed",
            "The page navigated during this operation. Inspect the new page before continuing.",
          );
        await evaluatePage(id, session, "click", payload, deadline, step);
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
          session,
          "mouse",
          () =>
            nativeInput(
              id,
              session,
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
              gesture,
              epoch,
            ),
          step,
          epoch,
        );
      }
      // Let synchronous submit/navigation handlers start, then wait for their load.
      // No input operation is retried, including when navigation times out.
      await run.park(() => new Promise((resolve) => setTimeout(resolve, 100)));
      await readyContents(id, remaining(deadline), false, run.park);
      result = {
        ok: true,
        url: contents.getURL(),
        ...(empty ? { fallback: "dom_click" } : {}),
        ...reboundOf(point),
      };
    } else if (action.type === "fill") {
      result = await evaluatePage(id, session, "fill", payload, deadline, step);
    } else if (action.type === "drag") {
      const points = await evaluatePage(
        id,
        session,
        "drag",
        payload,
        deadline,
        step,
      );
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
        session,
        "mouse",
        (armed) => nativeDrag(id, session, from, to, armed, gesture, epoch),
        step,
        epoch,
      );
      await run.park(() => new Promise((resolve) => setTimeout(resolve, 100)));
      await readyContents(id, remaining(deadline), false, run.park);
      result = {
        ok: true,
        url: contents.getURL(),
        drag: mode,
        ...reboundOf(points),
      };
    } else if (action.type === "press") {
      let focused: Record<string, unknown> = {};
      if (payload.ref || payload.selector)
        focused = await evaluatePage(
          id,
          session,
          "focus",
          payload,
          deadline,
          step,
        );
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
        session,
        "key",
        () =>
          nativeInput(
            id,
            session,
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
            gesture,
            epoch,
          ),
        step,
        epoch,
      );
      await run.park(() => new Promise((resolve) => setTimeout(resolve, 100)));
      await readyContents(id, remaining(deadline), false, run.park);
      result = { ok: true, url: contents.getURL(), ...reboundOf(focused) };
    } else if (action.type === "scroll") {
      result = await evaluatePage(id, session, "scroll", payload, deadline, step);
    } else {
      for (;;) {
        authorizeTab(id);
        let observation: Record<string, unknown>;
        try {
          observation = await evaluatePage(
            id,
            session,
            "check",
            payload,
            // Zero makes one attempt with a short IPC response allowance.
            payload.timeoutMs === 0
              ? Math.min(deadline, Date.now() + 250)
              : Math.min(deadline, Math.max(Date.now() + 1, waitDeadline)),
            step,
          );
        } catch (error) {
          const timedOut =
            error instanceof CdpTimeoutError ||
            (error instanceof ApiError &&
              ["page_timeout", "action_timeout"].includes(error.code));
          if (!timedOut || Date.now() < waitDeadline) throw error;
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
        await run.park(
          () =>
            new Promise((resolve) =>
              setTimeout(resolve, Math.min(100, waitDeadline - Date.now())),
            ),
        );
        session = (await readyContents(id, remaining(deadline), true, run.park))
          .session;
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
  return { readyContents, evaluatePage, executeToolAction };
}
