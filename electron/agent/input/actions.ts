// Gestures as command lists: the wheel events a scroll needs, the pointer
// events an action sends, and the native drag. Nothing here waits for an
// element or decides whether an action may run; the attempt loop and the
// routes do that.
//
// A wheel goes out as Input.dispatchMouseEvent with type "mouseWheel": the
// protocol has no separate wheel command. A probe of Electron 44 (Chromium
// 152) in a hidden window showed such a gesture at top-level coordinates
// scrolling a same-process container in 19 ms and an out-of-process frame's
// container in 18 ms, each settling within 55 ms.
//
// Points go out exactly as getBoundingClientRect reports them, in the top
// frame's CSS pixels. A probe of Electron 44 in a hidden window on a 2x
// display pressed the measured centre of four boxes at browser zoom 1,
// 1.25, 1.5 and 2 and hit the right element every time, while the same
// point multiplied by getZoomFactor() missed above zoom 1, so nothing here
// scales a point.
import { finitePoint, reboundOf, remaining, type Actions } from "../actions";
import type { Authority } from "../authority";
import { ApiError, fail } from "../errors";
import type { Run } from "../http";
import type { Level } from "../dom/select";
import type { Point, ScrollRequest } from "../dom/actions";
import type { AutomationController } from "../server";
import type { TabSession } from "../session/tab-session";
import type { Step } from "../session/types";
import type { TargetPayload } from "../validate";
import type { InputDispatcher, InputDispatchers } from "./dispatch";
import { checkPointerTarget } from "./guards";
import type { InputCommand } from "./keys";
import { BUTTON_BITS, type Button } from "./state";
import {
  ACTION_LEVELS,
  MAX_SCROLL_GESTURES,
  SCROLL_SETTLE_MS,
  confirmDelivery,
  runAttempts,
  settleAfterInput,
  type AttemptContext,
  type AttemptResult,
  type LoopBlocker,
} from "./wait";

// How far one wheel event scrolls before a delta is eased into several, and
// the gap between them.
export const WHEEL_STEP_PX = 100;
export const WHEEL_GAP_MS = 12;
// The largest delta a gesture carries, and the most events it takes.
const MAX_DELTA_PX = 10000;
const MAX_WHEEL_EVENTS = 10;

const MOUSE_TYPES = {
  moved: "mouseMoved",
  pressed: "mousePressed",
  released: "mouseReleased",
} as const;

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// A wheel delta as the events it is sent in: one event up to a step, else up
// to ten that rise and fall. The weights are computed and the last event
// carries the remainder, so the deltas sum to exactly what was asked for.
export function wheelEvents(
  deltaX: number,
  deltaY: number,
): { deltaX: number; deltaY: number }[] {
  for (const [name, value] of [
    ["deltaX", deltaX],
    ["deltaY", deltaY],
  ] as const)
    if (!Number.isFinite(value) || Math.abs(value) > MAX_DELTA_PX)
      fail("invalid_field", `${name} must be a number from -10000 to 10000.`, {
        field: name,
        expected: "a number from -10000 to 10000",
      });
  const distance = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  if (distance <= WHEEL_STEP_PX) return [{ deltaX, deltaY }];
  const count = Math.min(MAX_WHEEL_EVENTS, Math.ceil(distance / WHEEL_STEP_PX));
  const weights = Array.from({ length: count }, (_, index) =>
    Math.sin(((index + 1) / (count + 1)) * Math.PI),
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const events: { deltaX: number; deltaY: number }[] = [];
  let sentX = 0;
  let sentY = 0;
  for (const [index, weight] of weights.entries()) {
    const last = index === count - 1;
    const stepX = last ? deltaX - sentX : Math.round((deltaX * weight) / total);
    const stepY = last ? deltaY - sentY : Math.round((deltaY * weight) / total);
    sentX += stepX;
    sentY += stepY;
    events.push({ deltaX: stepX, deltaY: stepY });
  }
  return events;
}

export function wheelCommands(
  point: Point,
  step: { deltaX: number; deltaY: number },
  modifiers: number,
): InputCommand[] {
  return [
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX: step.deltaX,
        deltaY: step.deltaY,
        modifiers,
      },
    },
  ];
}

export function pointerCommands(options: {
  type: "moved" | "pressed" | "released";
  point: Point;
  button: Button | "none";
  buttons: number;
  clickCount?: number;
  modifiers: number;
}): InputCommand[] {
  const { type, point, button, buttons, clickCount, modifiers } = options;
  return [
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: MOUSE_TYPES[type],
        x: point.x,
        y: point.y,
        button,
        buttons,
        ...(clickCount === undefined ? {} : { clickCount }),
        modifiers,
      },
    },
  ];
}

// The wheel gesture the page asked for. It goes out with a step that carries
// no dispatch record: bringing a target into view before the first press
// never marks the request as having changed the page.
export async function scrollToPoint(deps: {
  request: ScrollRequest;
  dispatcher: InputDispatcher;
  step: Step;
}): Promise<void> {
  const { request, dispatcher, step } = deps;
  const point = { x: request.x, y: request.y };
  const modifiers = dispatcher.state.modifiers;
  const events = wheelEvents(request.deltaX, request.deltaY);
  for (const [index, event] of events.entries()) {
    if (index) await pause(WHEEL_GAP_MS);
    await dispatcher.pointer(wheelCommands(point, event, modifiers), {
      deadline: step.deadline,
      signal: step.signal,
      guard: step.guard,
    });
  }
}

// Presses on the source, moves past the distance pages wait for before a
// drag starts (4 pixels in Chromium, 5 to 8 in pointer libraries), then on to
// the target in steps. An HTML drag the page starts is intercepted, so no
// operating system drag begins, and is moved with drag events instead.
export async function nativeDrag(deps: {
  session: TabSession;
  from: Point;
  to: Point;
  armed: Record<string, unknown>;
  gesture: Step;
  epoch: number;
  guard(): void;
  evaluate(
    operation: "frame" | "input",
    deadline: number,
  ): Promise<Record<string, unknown>>;
}): Promise<"html5" | "mouse"> {
  const { session, from, to, armed, gesture, epoch, guard, evaluate } = deps;
  guard();
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
    guard();
    if (!final && session.epoch !== epoch)
      return fail(
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
    send(
      "Input.dispatchDragEvent",
      { type, x: point.x, y: point.y, data },
      final,
    );
  const wait = () => new Promise((resolve) => setTimeout(resolve, 16));
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
    await evaluate("frame", gesture.deadline);
    const counts = await evaluate("input", gesture.deadline);
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
      await wait();
      if (dragging) await drag("dragOver", point);
      else if (data !== undefined) {
        dragging = true;
        await drag("dragEnter", point);
      } else await mouse("mouseMoved", point, 1);
      last = point;
    }
    await wait();
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
}

export type PointerKind = "click" | "dblclick" | "hover";
/** One pointer action as its route parsed it. */
export interface PointerAction {
  kind: PointerKind;
  target: TargetPayload;
  button: Button;
  clickCount: number;
  delayMs: number;
  position?: Point;
  force: boolean;
  timeoutMs: number;
}
export interface InputActionDeps {
  controller: AutomationController;
  authority: Authority;
  actions: Pick<Actions, "readyContents" | "evaluatePage" | "dispatcher">;
  dispatchers: InputDispatchers;
  platform?: NodeJS.Platform;
}
export interface InputActions {
  pointer(
    id: string,
    action: PointerAction,
    run: Run,
  ): Promise<Record<string, unknown>>;
}

// The kinds that need a box holding still before they act. A click may land
// on one that is still moving, as a person's would.
const NEEDS_STABLE: readonly PointerKind[] = ["hover"];

// What one pointer action ended with: the point it used, or the page
// fallback it took instead, and whether input went out that the page's own
// handlers and a load follow.
type PointerOutcome = {
  point?: Point;
  fallback?: "dom_click";
  rebound?: string[];
  pressed: boolean;
};

export function createInputActions(deps: InputActionDeps): InputActions {
  const { authority, actions } = deps;
  const { authorizeTab } = authority;
  const platform = deps.platform ? { platform: deps.platform } : {};

  const pointer = async (id: string, action: PointerAction, run: Run) => {
    const { kind, button, force } = action;
    const guard = () => {
      authorizeTab(id);
    };
    const step: Step = {
      deadline: run.deadline,
      signal: run.signal,
      guard,
      dispatch: run.dispatch,
    };
    // A gesture runs to its end even if the client goes away.
    const gesture: Step = {
      deadline: run.deadline,
      guard,
      dispatch: run.dispatch,
    };
    const { contents, session } = await actions.readyContents(
      id,
      remaining(run.deadline),
      false,
      run.park,
    );
    const dispatcher = actions.dispatcher(id, session);
    // The target as the page receives it, with this action's checks and the
    // strictness its level counts matches at.
    const payload: Record<string, unknown> = {
      ...action.target,
      kind,
      force,
      ...(action.position ? { position: action.position } : {}),
    };
    const query = (payload as { query?: { level?: Level } }).query;
    if (query) query.level = ACTION_LEVELS[kind];
    const selector = (action.target as { selector?: string }).selector;

    const read = (
      operation: "actionPoint" | "stableBox" | "scrollRequest",
      extra: Record<string, unknown> = {},
      at: Step = step,
    ) =>
      actions.evaluatePage(
        id,
        session,
        operation,
        { ...payload, ...extra },
        run.deadline,
        at,
      );
    // The point and the checks, with a selector that matched nothing folded
    // into the blocker the loop waits out.
    const look = async (at: Step = step): Promise<Record<string, unknown>> => {
      try {
        return await read("actionPoint", {}, at);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "no_match")
          throw error;
        return {
          ok: true,
          blocked: {
            blocker: "no_match",
            ...(selector === undefined ? {} : { selector }),
          },
        };
      }
    };
    // After a wheel gesture the target may still be moving; it gets two
    // frames at a time to come to rest.
    const holdStill = async () => {
      const until = Date.now() + SCROLL_SETTLE_MS;
      for (;;) {
        const box = await read("stableBox");
        if (!box.blocked || Date.now() >= until) return;
      }
    };
    // The page the point was measured on must still be the page the input
    // lands on. A release is sent either way, so nothing stays held.
    const onSamePage = (epoch: number) => {
      if (session.epoch === epoch) return;
      fail(
        "page_changed",
        "The page navigated before input completed. Inspect the new page before continuing.",
      );
    };
    const moveTo = (point: Point, epoch: number) => {
      const buttons = dispatcher.state.buttons;
      onSamePage(epoch);
      return dispatcher.pointer(
        pointerCommands({
          type: "moved",
          point,
          button: buttons ? button : "none",
          buttons,
          modifiers: dispatcher.state.modifiers,
        }),
        gesture,
      );
    };
    const aim = (point: Point, at: Step) =>
      checkPointerTarget(session, point, at, {
        button,
        press: kind !== "hover",
        ...platform,
      });
    // The whole gesture: one move, then a press and a release per click,
    // with a delay in each gap. The held buttons and modifiers travel with
    // every event, so a click while the agent holds one behaves as a
    // person's would.
    const press = async (context: AttemptContext, point: Point) => {
      const bit = BUTTON_BITS[button];
      const epoch = session.epoch;
      await moveTo(point, epoch);
      for (let click = 1; click <= action.clickCount; click += 1) {
        if (click > 1) {
          if (action.delayMs) await pause(action.delayMs);
          // The checks run again before a later press. Nothing already sent
          // is repeated, so a target that is now covered ends the action.
          const again = await look(gesture);
          if (again.blocked || !finitePoint(again.point))
            context.gesture.refuse();
          await aim(point, gesture);
        }
        guard();
        onSamePage(epoch);
        context.gesture.press();
        await dispatcher.pointer(
          pointerCommands({
            type: "pressed",
            point,
            button,
            buttons: dispatcher.state.buttons | bit,
            clickCount: click,
            modifiers: dispatcher.state.modifiers,
          }),
          gesture,
        );
        if (action.delayMs) await pause(action.delayMs);
        await dispatcher.pointer(
          pointerCommands({
            type: "released",
            point,
            button,
            buttons: dispatcher.state.buttons & ~bit,
            clickCount: click,
            modifiers: dispatcher.state.modifiers,
          }),
          gesture,
        );
      }
    };
    // Section 5's delivery check for this tab: the counters come from the
    // page, and the gesture goes out again only on positive evidence that no
    // frame received it.
    const deliver = (send: () => Promise<void>) =>
      confirmDelivery({
        kind: "mouse",
        counters: () =>
          actions.evaluatePage(id, session, "input", {}, step.deadline, step),
        frames: async () => {
          await actions.evaluatePage(
            id,
            session,
            "frame",
            {},
            Math.min(step.deadline, Date.now() + 2000),
            step,
          );
        },
        epoch: () => session.epoch,
        budget: step.deadline,
        deliver: send,
      });
    // A control drawn with no size has no point to press, so the page
    // presses it where its surroundings are on screen and uncovered. Only a
    // single click has a page equivalent.
    const pageClick = async (
      context: AttemptContext,
      found: Record<string, unknown>,
    ): Promise<PointerOutcome> => {
      if (kind !== "click")
        return fail(
          "element_action_failed",
          `This control has no size of its own, so there is no point to ${
            kind === "hover" ? "hover over" : "double-click"
          }. Click it instead.`,
        );
      context.gesture.press();
      await actions.evaluatePage(
        id,
        session,
        "click",
        payload,
        run.deadline,
        step,
      );
      return { fallback: "dom_click", pressed: true, ...reboundOf(found) };
    };

    const attempt = async (
      context: AttemptContext,
    ): Promise<AttemptResult<PointerOutcome>> => {
      const stop = (blocked: unknown): AttemptResult<PointerOutcome> => ({
        done: false,
        blocked: blocked as LoopBlocker,
      });
      let found = await look();
      if (found.blocked) return stop(found.blocked);
      if (found.scroll) {
        let request = found.scroll as ScrollRequest;
        for (;;) {
          await scrollToPoint({ request, dispatcher, step });
          context.scrolls += 1;
          await holdStill();
          const next = await read("scrollRequest", {
            scrolls: context.scrolls,
          });
          if (next.blocked) return stop(next.blocked);
          if (!next.scroll || context.scrolls >= MAX_SCROLL_GESTURES) break;
          request = next.scroll as ScrollRequest;
        }
        found = await look();
        if (found.blocked) return stop(found.blocked);
        // Still off screen: the next attempt asks for another gesture.
        if (found.scroll) return { done: false };
      }
      if (found.empty === true)
        return { done: true, value: await pageClick(context, found) };
      if (NEEDS_STABLE.includes(kind) && !force) {
        const box = await read("stableBox");
        if (box.blocked) return stop(box.blocked);
        found = await look();
        if (found.blocked) return stop(found.blocked);
      }
      const point = found.point;
      if (!finitePoint(point)) return stop({ blocker: "outside_viewport" });
      await aim(point, step);
      const rest = { point, ...reboundOf(found) };
      if (kind === "hover") {
        await moveTo(point, session.epoch);
        return { done: true, value: { ...rest, pressed: false } };
      }
      await deliver(() => press(context, point));
      return { done: true, value: { ...rest, pressed: true } };
    };

    const outcome = await runAttempts<PointerOutcome>(
      {
        timeoutMs: action.timeoutMs,
        deadline: run.deadline,
        park: run.park,
        signal: run.signal,
        action: kind,
        ...(selector === undefined ? {} : { selector }),
      },
      attempt,
    );
    // The page's own handlers, then a load that started, before the answer.
    const settled = outcome.pressed
      ? await settleAfterInput({
          contents,
          park: run.park,
          budget: run.deadline,
          guard,
        })
      : {};
    return {
      ok: true,
      ...(kind === "hover" ? {} : { url: contents.getURL() }),
      ...(outcome.point ? { point: outcome.point } : {}),
      ...settled,
      ...(outcome.fallback ? { fallback: outcome.fallback } : {}),
      ...(outcome.rebound ? { rebound: outcome.rebound } : {}),
    };
  };
  return { pointer };
}
