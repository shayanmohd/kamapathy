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
import { fail } from "../errors";
import type { Point, ScrollRequest } from "../dom/actions";
import type { TabSession } from "../session/tab-session";
import type { Step } from "../session/types";
import type { InputDispatcher } from "./dispatch";
import type { InputCommand } from "./keys";
import type { Button } from "./state";

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
