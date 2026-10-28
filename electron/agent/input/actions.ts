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
import {
  finitePoint,
  frameNote,
  noteFrame,
  reboundOf,
  remaining,
  type Actions,
  type RanIn,
} from "../actions";
import type { Authority } from "../authority";
import { ApiError, fail } from "../errors";
import {
  NO_EXTENSION_NAMES,
  blockedFramesByPath,
  extensionFrame,
  type ExtensionNames,
} from "../extension-frames";
import type { FrameGroupsByTab } from "../frames/groups";
import type { Run } from "../http";
import {
  frameTargetOf,
  inArea,
  placeInFrame,
  revealThroughFrames,
  translatePoint,
  type FrameTarget,
  type PlacedPoint,
} from "../resolve";
import type { Level } from "../dom/select";
import {
  classifyFill,
  type FillMatch,
  type Point,
  type ScrollRequest,
} from "../dom/actions";
import type { AutomationController } from "../server";
import { CdpTimeoutError } from "../session/errors";
import type { TabSession } from "../session/tab-session";
import type { Step } from "../session/types";
import type { TargetPayload } from "../validate";
import type { InputDispatcher, InputDispatchers } from "./dispatch";
import {
  checkKeyTarget,
  checkPointerTarget,
  type FocusedControl,
} from "./guards";
import { inputMarker } from "./marker";
import {
  KEYS,
  MODIFIER_BITS,
  checkClipboardChord,
  chordCommands,
  keyParams,
  keyType,
  parseChord,
  textCommands,
  type Chord,
  type InputCommand,
  type KeyDef,
  type Modifier,
} from "./keys";
import { macCommands } from "./mac-commands";
import { BUTTON_BITS, interpolate, type Button } from "./state";
import {
  ACTION_LEVELS,
  DEFAULT_ACTION_TIMEOUT_MS,
  MAX_SCROLL_GESTURES,
  SCROLL_FRAMES_MS,
  SCROLL_SETTLE_MS,
  confirmDelivery,
  createGesture,
  landedAt,
  runAttempts,
  settleAfterInput,
  unreadOf,
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
// operating system drag begins, and is moved with drag events instead. Only
// the left button starts an HTML drag, so a middle or right drag is a plain
// mouse drag.
export async function nativeDrag(deps: {
  session: TabSession;
  from: Point;
  to: Point;
  button: Button;
  armed: Record<string, unknown>;
  gesture: Step;
  epoch: number;
  guard(): void;
  evaluate(
    operation: "frame" | "input",
    deadline: number,
  ): Promise<Record<string, unknown>>;
}): Promise<"html5" | "mouse"> {
  const { session, from, to, button, armed, gesture, epoch, guard, evaluate } =
    deps;
  guard();
  const intercepts = button === "left";
  const bit = BUTTON_BITS[button];
  let data: unknown;
  let intercepted = () => {};
  const stopListening = intercepts
    ? session.on("Input.dragIntercepted", (event) => {
        data = event.params.data;
        intercepted();
      })
    : () => {};
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
        button: type === "mouseMoved" && !buttons ? "none" : button,
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
    if (intercepts)
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
    await mouse("mousePressed", from, bit);
    await mouse("mouseMoved", start, bit);
    last = start;
    // The page decides in its dragstart handlers whether an HTML drag
    // starts. Its data reaches Kamapathy shortly after.
    if (intercepts) {
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
      } else await mouse("mouseMoved", point, bit);
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
    if (intercepts)
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
  /**
   * Section 9's frame groups, for targets and the focus inside a frame, and
   * for the path a refused frame is named by.
   */
  frames?: FrameGroupsByTab;
  platform?: NodeJS.Platform;
  /** Section 17's loaded extensions, which name the frame a refusal is about. */
  extensions?: ExtensionNames;
}
/** One drag as its route parsed it. */
export interface DragAction {
  source: TargetPayload;
  target: TargetPayload;
  sourcePosition?: Point;
  targetPosition?: Point;
  button: Button;
  force: boolean;
  timeoutMs: number;
}
export type FieldKind = "fill" | "select" | "focus";
/** One option a select route asks for. */
export type SelectChoice =
  string | { value?: string; label?: string; index?: number };
/** One field action as its route parsed it. */
export interface FieldAction {
  kind: FieldKind;
  target: TargetPayload;
  value?: string;
  append?: boolean;
  values?: SelectChoice[];
  timeoutMs: number;
}
/** One press as its route parsed it. */
export interface PressAction {
  key: string;
  target?: TargetPayload;
  delayMs: number;
  timeoutMs: number;
}
export type MouseKind = "move" | "down" | "up" | "click" | "wheel";
/** One raw mouse request as its route parsed it. */
export interface MouseAction {
  kind: MouseKind;
  x?: number;
  y?: number;
  steps: number;
  button: Button;
  clickCount: number;
  delayMs: number;
  deltaX?: number;
  deltaY?: number;
}
export type KeyboardKind = "down" | "up" | "type" | "insert-text" | "paste";
/** One raw keyboard request as its route parsed it. */
export interface KeyboardAction {
  kind: KeyboardKind;
  key?: string;
  text?: string;
  html?: string;
  delayMs: number;
}
export interface InputActions {
  pointer(
    id: string,
    action: PointerAction,
    run: Run,
  ): Promise<Record<string, unknown>>;
  press(
    id: string,
    action: PressAction,
    run: Run,
  ): Promise<Record<string, unknown>>;
  keyboard(
    id: string,
    action: KeyboardAction,
    run: Run,
  ): Promise<Record<string, unknown>>;
  mouse(
    id: string,
    action: MouseAction,
    run: Run,
  ): Promise<Record<string, unknown>>;
  /** Lets go of every key and button the tab holds. */
  release(id: string, run: Run): Promise<Record<string, unknown>>;
  /** Refuses keys and text while focus is in a frame agent input never reaches. */
  checkFocus(id: string, session: TabSession, step: Step): Promise<void>;
  drag(
    id: string,
    action: DragAction,
    run: Run,
  ): Promise<Record<string, unknown>>;
  field(
    id: string,
    action: FieldAction,
    run: Run,
  ): Promise<Record<string, unknown>>;
}

// The key a built command names, by its code. The table is keyed by the
// lowercased name, which every key a typed text sends spells the same as its
// code.
const keyByCode = (code: string): KeyDef | undefined => {
  const name = code.toLowerCase();
  return Object.hasOwn(KEYS, name) ? KEYS[name] : undefined;
};
// The characters a typed text sends as a key that could open a focused
// control's picker, with the key each one types.
const TYPED_PICKER_KEYS: readonly (readonly [string, KeyDef])[] = [
  [" ", KEYS.space],
  ["\n", KEYS.enter],
];
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
// What one drag ended with: the way the page took it, and the refs it moved.
type DragOutcome = { mode: "html5" | "mouse"; rebound?: string[] };
// The page operations a field action runs.
type FieldOperation =
  | "fillPrepare"
  | "fillRead"
  | "setDirectValue"
  | "selectChoose"
  | "focusTarget";
// The matches that mean the field took what was asked for; the other two
// get one real click and one more round.
const FILL_KEPT: readonly FillMatch[] = ["unchanged", "appended"];
// The first characters of the value an answer carries, and of the options a
// select names when none matched.
const MAX_FILL_VALUE = 200;
const MAX_DETAIL = 200;
// What one field action ended with: the fields of its own answer.
type FieldOutcome = Record<string, unknown>;
// Where section 9 puts an action's target: the frame it sits in, or the
// blocker that frame is not ready.
type FramePlace = { target?: FrameTarget; blocked?: LoopBlocker };
// Where a press lands, for section 5's routing check: the point on the page,
// the same point in the own pixels of the frame group whose world counts the
// input of the document holding it, that group's root, and what its owners
// scale it by. A point no group can place has no own pixels to compare.
type Landing = {
  point: Point;
  local?: Point;
  frameId?: string;
  scale?: { x: number; y: number };
};
// A blocker of section 5's routing check, about the frame the target sits in.
const notDrawn = (frame?: FrameTarget): LoopBlocker => ({
  blocker: "not_drawn",
  ...(frame?.path ? { frame: frame.path } : {}),
});
// The frame group whose world measured a frame target's point: the root its
// innermost owner holds.
const rootOf = (frame: FrameTarget): string =>
  frame.owners.at(-1)?.frameId ?? frame.frameId;

export function createInputActions(deps: InputActionDeps): InputActions {
  const { authority, actions } = deps;
  const { authorizeTab } = authority;
  // What every pointer guard is given beside the point: the platform under
  // test, and section 17's loaded extensions, which name a refused frame.
  const guards = {
    ...(deps.platform ? { platform: deps.platform } : {}),
    extensions: deps.extensions ?? NO_EXTENSION_NAMES,
  };
  const platformName = deps.platform ?? process.platform;
  // Section 9: where the target of an action sits. A target in the page's
  // own document answers nothing here, so a page without frames pays for
  // none of it.
  const framePlace = async (
    id: string,
    session: TabSession,
    ran: RanIn,
    step: Step,
  ): Promise<FramePlace> => {
    const frames = deps.frames?.for(id);
    if (!frames || ran.frameId === undefined) return {};
    if (ran.frameId === (await session.mainFrameId(step))) return {};
    const group = frames.groupOf(ran.frameId);
    const content = frames.contentOf(ran.frameId);
    // A frame the last pass could not place keeps the path its ref carried.
    const path = frames.pathOf(ran.frameId) ?? group?.path ?? ran.path;
    const named = path ? { frame: path } : {};
    const known = (await session.knownFrames(step)).find(
      (frame) => frame.frameId === ran.frameId,
    );
    if (content === "blocked" || known?.blocked)
      fail(
        "input_target_blocked",
        "This point belongs to an extension or an internal page, which agent input never reaches. Act on the page itself.",
        named,
      );
    const unready = (
      detail: "attaching" | "navigating" | "not_responding",
    ): { blocked: LoopBlocker } => ({
      blocked: { blocker: "frame_not_ready", detail, ...named },
    });
    // An owner Kamapathy has not bound yet is a frame it cannot place.
    if (!group) return unready("attaching");
    if (!known || known.unavailable || content === "unavailable")
      return unready("not_responding");
    if (known.navigating) return unready("navigating");
    const target = frameTargetOf(frames, ran.frameId);
    return target.owners.length ? { target } : {};
  };
  // The frame a ref lives in, before any page call: a frame that cannot
  // take input is answered without touching it, since a page call into a
  // frame whose session has gone fails as a lost connection instead.
  const refPlace = async (
    id: string,
    session: TabSession,
    target: TargetPayload | undefined,
    step: Step,
  ): Promise<FramePlace> => {
    const frames = deps.frames?.for(id);
    const ref = (target as { ref?: unknown } | undefined)?.ref;
    if (!frames || typeof ref !== "string") return {};
    await frames.bind(step);
    const home = frames.homeFrame(ref);
    if (!home) return {};
    return framePlace(
      id,
      session,
      { frameId: home.frameId, path: home.path ?? home.group },
      step,
    );
  };
  // Section 5's routing check. Chromium routes input by the layout it last
  // drew, which trails a scroll by a frame on an idle machine and by seconds
  // on a loaded one, so a press sent before the page draws again can reach
  // whatever was drawn at the point before: the page around a frame, another
  // frame, an extension's among them, or the frame itself at a shifted point.
  // One move goes to the point first, with no dispatch record, as a scroll
  // into view has none, and the press may follow only once the target's own
  // document saw it land there. A held button takes every move to the frame
  // its press went to, so the caller sends no check then.
  const routed = async (
    id: string,
    session: TabSession,
    dispatcher: InputDispatcher,
    landing: Landing,
    step: Step,
  ): Promise<boolean> => {
    const counters = () =>
      actions.evaluatePage(
        id,
        session,
        "input",
        {},
        step.deadline,
        step,
        landing.frameId,
      );
    const move = () =>
      dispatcher.pointer(
        pointerCommands({
          type: "moved",
          point: landing.point,
          button: "none",
          buttons: 0,
          modifiers: dispatcher.state.modifiers,
        }),
        { deadline: step.deadline, signal: step.signal, guard: step.guard },
      );
    const { local } = landing;
    if (local === undefined) {
      await move();
      return true;
    }
    const before = await counters();
    await move();
    return landedAt(before, await counters(), local, landing.scale ?? { x: 1, y: 1 });
  };
  // The documents around the one holding a frame target, which a press
  // routed by a layout drawn before reaches instead: the page's own and each
  // frame group an owner on the way sits in. Their counters tell a press
  // that went astray from one nothing received.
  const straysOf = async (
    id: string,
    session: TabSession,
    frame: FrameTarget | undefined,
    step: Step,
    refuse: () => never,
  ) => {
    if (!frame) return undefined;
    const around = [
      await session.mainFrameId(step),
      ...frame.owners.slice(0, -1).map((owner) => owner.frameId),
    ];
    return {
      counters: () =>
        Promise.all(
          around.map((frameId) =>
            actions.evaluatePage(
              id,
              session,
              "input",
              {},
              step.deadline,
              step,
              frameId,
            ),
          ),
        ),
      refuse,
    };
  };
  // The modifiers the tab is holding, which join a chord's own.
  const heldModifiers = (dispatcher: InputDispatcher): Modifier[] =>
    dispatcher.state
      .heldKeys()
      .map((key) => key.modifier)
      .filter((modifier): modifier is Modifier => modifier !== undefined);
  // Section 9: the frame the keys reach, found by following the active
  // element from the top document through each owner. A frame agents never
  // reach refuses the keys before anything is sent.
  const focusedFrame = async (
    id: string,
    session: TabSession,
    step: Step,
  ): Promise<{ frameId: string; path: string } | undefined> => {
    const frames = deps.frames?.for(id);
    if (!frames) return undefined;
    // A page with no frame group of its own holds the focus itself, so
    // nothing is read for it.
    if ((await frames.groups(step)).length < 2) return undefined;
    const found = await frames.focusedFrame(step);
    // The key guards hold the one rule for a frame input never reaches, so
    // a frame of one of the person's extensions is named for them here too.
    if (found.blocked)
      checkKeyTarget(
        {
          kind: "other",
          blockedFrame: true,
          ...(await blockedFrameNames(session, found.path, step)),
        },
        undefined,
        platformName,
      );
    return found.path === "" ? undefined : found;
  };
  // The focused control as the page reports it, which the key guards read:
  // a key that would open a native picker, or one aimed at a frame agents
  // never reach, is refused before anything is sent.
  const focusedControl = async (
    id: string,
    session: TabSession,
    deadline: number,
    step: Step,
    frameId?: string,
  ): Promise<FocusedControl> => {
    const found = await actions.evaluatePage(
      id,
      session,
      "focusedKind",
      {},
      deadline,
      step,
      frameId,
    );
    const kind = typeof found.kind === "string" ? found.kind : "none";
    if (found.blockedFrame !== true) return { kind };
    return {
      kind,
      blockedFrame: true as const,
      ...(await focusedExtension(id, session, step)),
    };
  };
  // How a refusal names a frame input never reaches: section 9's path for
  // it, and section 17's extension when the page it holds is one of the
  // person's. Only the registry holds the URL a blocked frame committed.
  const blockedFrameNames = async (
    session: TabSession,
    path: string,
    step: Step,
  ): Promise<{ frame?: string; extension?: string }> => {
    const named = path === "" ? {} : { frame: path };
    // A registry read that fails, or runs out of time, leaves the plain
    // refusal rather than another error.
    const blocked = await blockedFramesByPath(session, step).catch(
      () => undefined,
    );
    const url = blocked?.get(path)?.url;
    const extension =
      url === undefined ? undefined : extensionFrame(url, guards.extensions);
    return extension ? { ...named, extension: extension.name } : named;
  };
  // The frame holding focus, when it is one agents never reach: section 9
  // says which frame that is, and the naming above how to answer for it.
  // Anything the two cannot answer leaves the plain refusal.
  const focusedExtension = async (
    id: string,
    session: TabSession,
    step: Step,
  ): Promise<{ frame?: string; extension?: string }> => {
    const groups = deps.frames?.for(id);
    if (!groups) return {};
    try {
      const focus = await groups.focusedFrame(step);
      if (!focus.blocked) return {};
      return await blockedFrameNames(session, focus.path, step);
    } catch {
      return {};
    }
  };
  // The content the page is offered, as one mutating page call. A walk that
  // ended at a frame Kamapathy cannot read is the refusal the guards answer
  // wherever else a key goes out, so it is raised with their own wording.
  const pasteOnPage = async (
    id: string,
    session: TabSession,
    action: KeyboardAction,
    deadline: number,
    step: Step,
    frameId?: string,
  ) => {
    try {
      return await actions.evaluatePage(
        id,
        session,
        "pasteDispatch",
        {
          text: action.text ?? "",
          ...(action.html === undefined ? {} : { html: action.html }),
        },
        deadline,
        step,
        frameId,
      );
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === "not_editable" &&
        error.fields.reason === "frame"
      )
        checkKeyTarget(
          {
            kind: "other",
            blockedFrame: true,
            ...(await focusedExtension(id, session, step)),
          },
          undefined,
          platformName,
        );
      throw error;
    }
  };
  // One key as a chord of its own, for the guards and the raw routes.
  const chordOf = (key: KeyDef, mask: number): Chord => ({
    tokens: [key.name],
    modifiers: [],
    mask,
    key,
  });

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

    // The frame the resolution ran in, which section 9 places the point
    // through. Each read records it again, so a target that moved to
    // another frame between attempts is followed.
    const ran: RanIn = {};
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
        undefined,
        ran,
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
            ...unreadOf(error.fields),
          },
        };
      }
    };
    // A scroll reaches the page, and Chromium's routing of input, at the
    // page's next frames. A page that renders none in the window is read as
    // it was.
    const nextFrames = (until: number) =>
      actions
        .evaluatePage(
          id,
          session,
          "frame",
          {},
          Math.min(step.deadline, until),
          step,
        )
        .catch((error: unknown) => {
          if (!(error instanceof CdpTimeoutError)) throw error;
        });
    // After a wheel gesture the target may still be moving: the page's own
    // frames go by first, then the box gets its window to come to rest.
    const holdStill = async () => {
      await nextFrames(Date.now() + SCROLL_FRAMES_MS);
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
        ...guards,
      });
    // The move a press or a hover follows: section 5's routing check, or,
    // while a button is held, the move that button drags, which goes to the
    // frame its press went to whatever the page has drawn. Both are sent on
    // the page the point was measured on.
    const arrive = async (
      landing: Landing,
      at: Step,
      epoch: number,
    ): Promise<boolean> => {
      if (dispatcher.state.buttons) {
        await moveTo(landing.point, epoch);
        return true;
      }
      onSamePage(epoch);
      return routed(id, session, dispatcher, landing, at);
    };
    // The document a frame holds, so a new one after input started is told
    // from the one the point was measured in.
    const documentOf = async (frame: FrameTarget, at: Step) =>
      (await session.knownFrames(at)).find(
        (item) => item.frameId === frame.frameId,
      )?.loaderId;
    // The checks a press runs again once the gesture has pressed: before a
    // later click and before a resend. Nothing already sent is repeated, so
    // a target that is now covered ends the action.
    const recheck = async (
      context: AttemptContext,
      point: Point,
      inside?: { frame: FrameTarget; local: Point; document?: string },
    ) => {
      // A new document in the target's frame after input started is section
      // 9's page_changed, answered before the target is looked for again in
      // a document it no longer belongs to.
      if (inside && (await documentOf(inside.frame, gesture)) !== inside.document)
        fail(
          "page_changed",
          "The frame holding the target loaded another page during this action. Inspect it before continuing.",
          inside.frame.path ? { frame: inside.frame.path } : {},
        );
      const looked = await look(gesture);
      if (looked.blocked || !finitePoint(looked.point))
        context.gesture.refuse();
      // Section 9's hit test runs again too: an owner that moved, or
      // something drawn over it, ends the action where it stands.
      if (inside) {
        const now = await translatePoint(
          session,
          inside.frame,
          inside.local,
          gesture,
        );
        if (
          now.covered ||
          now.point.x !== point.x ||
          now.point.y !== point.y
        )
          context.gesture.refuse();
      }
      await aim(point, gesture);
    };
    // The whole gesture after the move: a press and a release per click,
    // with a delay in each gap, on the page the point was measured on. The
    // held buttons and modifiers travel with every event, so a click while
    // the agent holds one behaves as a person's would.
    const press = async (
      context: AttemptContext,
      point: Point,
      epoch: number,
      inside?: { frame: FrameTarget; local: Point; document?: string },
    ) => {
      const bit = BUTTON_BITS[button];
      for (let click = 1; click <= action.clickCount; click += 1) {
        if (click > 1) {
          if (action.delayMs) await pause(action.delayMs);
          await recheck(context, point, inside);
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
    // frame received it, after the checks its first press ran.
    const deliver = async (
      context: AttemptContext,
      send: () => Promise<void>,
      again: () => Promise<void>,
      frame?: FrameTarget,
    ) =>
      confirmDelivery({
        kind: "mouse",
        // The counters of the frame that holds the target: a press inside a
        // frame never reaches the page's own document.
        counters: () =>
          actions.evaluatePage(
            id,
            session,
            "input",
            {},
            step.deadline,
            step,
            frame?.frameId,
          ),
        strays: await straysOf(id, session, frame, step, () =>
          context.gesture.refuse(),
        ),
        again,
        frames: async () => {
          await actions.evaluatePage(
            id,
            session,
            "frame",
            {},
            Math.min(step.deadline, Date.now() + 2000),
            step,
            frame?.frameId,
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
      // The page this attempt measures, which its input must land on.
      const epoch = session.epoch;
      // Section 9: a ref names its frame before any page call, so a frame
      // that cannot take input is answered without being touched.
      const early = await refPlace(id, session, action.target, step);
      if (early.blocked) return stop(early.blocked);
      let found = await look();
      if (found.blocked) return stop(found.blocked);
      // The frame the target sits in, which the point travels out of and
      // which must be ready to take the input.
      const place = early.target
        ? early
        : await framePlace(id, session, ran, step);
      if (place.blocked) return stop(place.blocked);
      const frame = place.target;
      const named = frame?.path ? { frame: frame.path } : {};
      if (frame) noteFrame(run, frameNote(frame, contents.getURL()));
      // A wheel for a target inside a frame goes to the translated point,
      // with the delta the owners scale the frame's own pixels by.
      const gestureFor = async (request: ScrollRequest) => {
        if (!frame) return request;
        const at = await translatePoint(
          session,
          frame,
          { x: request.x, y: request.y },
          step,
        );
        return {
          ...request,
          x: at.point.x,
          y: at.point.y,
          deltaX: request.deltaX * at.scaleX,
          deltaY: request.deltaY * at.scaleY,
        };
      };
      if (found.scroll) {
        let request = found.scroll as ScrollRequest;
        for (;;) {
          await scrollToPoint({
            request: await gestureFor(request),
            dispatcher,
            step,
          });
          context.scrolls += 1;
          await holdStill();
          const next = await read("scrollRequest", {
            scrolls: context.scrolls,
          });
          if (next.blocked) return stop(next.blocked);
          // The page scrolled the target into view itself, by script.
          if (next.intoView === true)
            await nextFrames(Date.now() + SCROLL_FRAMES_MS);
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
      const local = found.point;
      if (!finitePoint(local)) return stop({ blocker: "outside_viewport" });
      let placed: PlacedPoint | undefined;
      if (frame) {
        placed = await translatePoint(session, frame, local, step);
        if (placed.covered)
          return stop({
            blocker: "covered",
            ...(placed.interceptor ? { interceptor: placed.interceptor } : {}),
            ...named,
          });
        // A boundary leaves the point off screen: each owner is brought into
        // view by script, outermost first, and once the page has drawn the
        // scroll the next attempt measures again.
        if (!inArea(placed.point, placed.area)) {
          await revealThroughFrames(session, frame, step);
          context.scrolls += 1;
          await nextFrames(Date.now() + SCROLL_FRAMES_MS);
          return stop({ blocker: "outside_viewport", ...named });
        }
      }
      const point = placed?.point ?? local;
      await aim(point, step);
      // Nothing goes out until a move at the point reaches the document
      // that holds the target, there.
      const landing: Landing = {
        point,
        local,
        ...(frame && placed
          ? {
              frameId: rootOf(frame),
              scale: { x: placed.scaleX, y: placed.scaleY },
            }
          : {}),
      };
      if (!(await arrive(landing, step, epoch))) return stop(notDrawn(frame));
      const rest = { point, ...reboundOf(found) };
      if (kind === "hover")
        return { done: true, value: { ...rest, pressed: false } };
      const document = frame ? await documentOf(frame, step) : undefined;
      const inside = frame
        ? { frame, local, ...(document ? { document } : {}) }
        : undefined;
      await deliver(
        context,
        () => press(context, point, epoch, inside),
        // A resend runs the first press's checks again, its move included.
        async () => {
          await recheck(context, point, inside);
          if (!(await arrive(landing, gesture, epoch)))
            fail(
              "input_not_delivered",
              "The page did not accept native input. Inspect the page before retrying.",
            );
        },
        frame,
      );
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
  // Today's drag engine on the attempt loop: both ends are measured in one
  // look, in hover mode with their own positions, and the gesture itself is
  // unchanged.
  const drag = async (id: string, action: DragAction, run: Run) => {
    const { button, force } = action;
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
    // Both ends travel in one payload, so the page measures them against one
    // layout, and each counts its matches at the drag level.
    const ends = [action.source, action.target];
    for (const end of ends) {
      const query = (end as { query?: { level?: Level } }).query;
      if (query) query.level = ACTION_LEVELS.drag;
    }
    const payload: Record<string, unknown> = {
      source: action.source,
      target: action.target,
      kind: "drag",
      force,
      ...(action.sourcePosition
        ? { sourcePosition: action.sourcePosition }
        : {}),
      ...(action.targetPosition
        ? { targetPosition: action.targetPosition }
        : {}),
    };
    // The frame both ends were measured in, which the two points travel
    // out of together.
    const ran: RanIn = {};
    const evaluate = (
      operation: "actionPoint" | "stableBox" | "input" | "frame",
      body: Record<string, unknown>,
      at: Step = step,
      deadline = run.deadline,
    ) =>
      actions.evaluatePage(
        id,
        session,
        operation,
        body,
        deadline,
        at,
        undefined,
        ran,
      );
    // The two points, with a selector that matched nothing folded into the
    // blocker the loop waits out. Either end's selector may be the one.
    const look = async (
      context: AttemptContext,
      at: Step = step,
    ): Promise<Record<string, unknown>> => {
      try {
        return await evaluate(
          "actionPoint",
          { ...payload, scrolls: context.scrolls },
          at,
        );
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "no_match")
          throw error;
        const selector = error.fields.selector;
        return {
          ok: true,
          blocked: {
            blocker: "no_match",
            ...(typeof selector === "string" ? { selector } : {}),
            ...unreadOf(error.fields),
          },
        };
      }
    };
    const measured = (found: Record<string, unknown>) =>
      finitePoint(found.from) && finitePoint(found.to);
    // Each end must hold still, as hover's one does.
    const unstable = async (): Promise<LoopBlocker | undefined> => {
      for (const end of ends) {
        const box = await evaluate("stableBox", { ...end });
        if (box.blocked) return box.blocked as LoopBlocker;
      }
      return undefined;
    };
    // After a wheel gesture the page's own frames go by, since they carry
    // the scroll the compositor has already made, and each end then gets the
    // rest of the window to come to rest before it is measured again.
    const holdStill = async () => {
      await evaluate(
        "frame",
        {},
        step,
        Math.min(run.deadline, Date.now() + SCROLL_FRAMES_MS),
      ).catch((error: unknown) => {
        if (!(error instanceof CdpTimeoutError)) throw error;
      });
      const until = Date.now() + SCROLL_SETTLE_MS;
      for (const end of ends)
        for (;;) {
          const box = await evaluate("stableBox", { ...end });
          if (!box.blocked || Date.now() >= until) break;
        }
    };
    const aim = (point: Point, press: boolean, at: Step = step) =>
      checkPointerTarget(session, point, at, { button, press, ...guards });
    // The page operations of the frame both ends sit in, run in that frame's
    // own world: a press inside a frame never reaches the page's own
    // counters.
    const inFrame = (
      operation: "input" | "frame",
      frameId: string | undefined,
      at: Step = step,
      deadline = run.deadline,
    ) =>
      actions.evaluatePage(id, session, operation, {}, deadline, at, frameId);
    // A scroll by script reaches the page, and Chromium's routing of input,
    // at the page's next frames.
    const drawn = () =>
      inFrame(
        "frame",
        undefined,
        step,
        Math.min(run.deadline, Date.now() + SCROLL_FRAMES_MS),
      ).catch((error: unknown) => {
        if (!(error instanceof CdpTimeoutError)) throw error;
      });
    // The end a blocker belongs to reads as its detail, so a timeout says
    // which of the two was not ready.
    const stop = (blocked: unknown): AttemptResult<DragOutcome> => {
      const { end, ...rest } = blocked as LoopBlocker & { end?: string };
      return {
        done: false,
        blocked: {
          ...rest,
          ...(rest.detail === undefined && end ? { detail: end } : {}),
        } as LoopBlocker,
      };
    };
    // The counters the gesture was armed with, which the drag compares
    // against to tell an HTML drag the page started.
    let armed: Record<string, unknown> = {};

    const attempt = async (
      context: AttemptContext,
    ): Promise<AttemptResult<DragOutcome>> => {
      // The page this attempt measures, which the drag must run on.
      const epoch = session.epoch;
      let found = await look(context);
      // The wheel brings both ends into view; after six gestures the page
      // scrolls the end that is off screen itself.
      while (found.scroll && context.scrolls < MAX_SCROLL_GESTURES) {
        await scrollToPoint({
          request: found.scroll as ScrollRequest,
          dispatcher,
          step,
        });
        context.scrolls += 1;
        await holdStill();
        found = await look(context);
      }
      if (found.blocked) return stop(found.blocked);
      // Still off screen, or scrolled by the page itself: the next attempt
      // measures again, once the page has drawn its own scroll.
      if (!measured(found)) {
        if (found.intoView === true) await drawn();
        return { done: false };
      }
      if (!force) {
        const moving = await unstable();
        if (moving) return stop(moving);
        found = await look(context);
        if (found.blocked) return stop(found.blocked);
        if (!measured(found)) return { done: false };
      }
      // Section 9: both ends were measured in one world, so both points
      // travel out through the same owners.
      const place = await framePlace(id, session, ran, step);
      if (place.blocked) return stop(place.blocked);
      const frame = place.target;
      if (frame) noteFrame(run, frameNote(frame, contents.getURL()));
      const outward = async (point: Point, at: Step = step) => {
        if (!frame) return { point, scale: { x: 1, y: 1 } };
        const placed = await translatePoint(session, frame, point, at);
        if (placed.covered || !inArea(placed.point, placed.area))
          return undefined;
        return {
          point: placed.point,
          scale: { x: placed.scaleX, y: placed.scaleY },
        };
      };
      const source = await outward(found.from as Point);
      const drop = await outward(found.to as Point);
      if (!source || !drop)
        return stop({
          blocker: "outside_viewport",
          ...(frame?.path ? { frame: frame.path } : {}),
        });
      const from = source.point;
      const to = drop.point;
      // The press lands on the source and the drop on the target, so both
      // points go through section 5's guards.
      await aim(from, true);
      await aim(to, false);
      // The press waits for a move at the source to reach the document that
      // holds it, there, as a click's does.
      const landing: Landing = {
        point: from,
        local: found.from as Point,
        ...(frame ? { frameId: rootOf(frame), scale: source.scale } : {}),
      };
      if (session.epoch !== epoch)
        fail(
          "page_changed",
          "The page navigated before input completed. Inspect the new page before continuing.",
        );
      if (
        !dispatcher.state.buttons &&
        !(await routed(id, session, dispatcher, landing, step))
      )
        return stop(notDrawn(frame));
      const mode = await confirmDelivery({
        kind: "mouse",
        counters: async () =>
          (armed = await inFrame("input", frame?.frameId)),
        strays: await straysOf(id, session, frame, step, () =>
          context.gesture.refuse(),
        ),
        // A gesture the page never received is sent again, so the ends are
        // checked once more, as its first press was, and nothing is
        // repeated if they moved.
        again: async () => {
          const looked = await look(context, gesture);
          if (looked.blocked || !measured(looked)) context.gesture.refuse();
          const sent = [from, to];
          const now = [
            await outward(looked.from as Point, gesture),
            await outward(looked.to as Point, gesture),
          ];
          if (
            now.some(
              (end, index) =>
                !end ||
                end.point.x !== sent[index].x ||
                end.point.y !== sent[index].y,
            )
          )
            context.gesture.refuse();
          await aim(from, true, gesture);
          await aim(to, false, gesture);
          if (
            !dispatcher.state.buttons &&
            !(await routed(id, session, dispatcher, landing, gesture))
          )
            fail(
              "input_not_delivered",
              "The page did not accept native input. Inspect the page before retrying.",
            );
        },
        frames: async () => {
          await inFrame(
            "frame",
            frame?.frameId,
            step,
            Math.min(step.deadline, Date.now() + 2000),
          );
        },
        epoch: () => session.epoch,
        budget: step.deadline,
        deliver: async () => {
          context.gesture.press();
          // The shell reads the marker, so no native menu follows the
          // button this gesture holds and no pane takes its moves.
          const done = inputMarker.begin(contents);
          inputMarker.markPointer(contents);
          try {
            return await nativeDrag({
              session,
              from,
              to,
              button,
              armed,
              gesture,
              epoch,
              guard,
              evaluate: (operation, deadline) =>
                inFrame(operation, frame?.frameId, gesture, deadline),
            });
          } finally {
            done();
          }
        },
      });
      return { done: true, value: { mode, ...reboundOf(found) } };
    };

    const outcome = await runAttempts<DragOutcome>(
      {
        timeoutMs: action.timeoutMs,
        deadline: run.deadline,
        park: run.park,
        signal: run.signal,
        action: "drag",
      },
      attempt,
    );
    // The page's own handlers, then a load the drop started.
    const settled = await settleAfterInput({
      contents,
      park: run.park,
      budget: run.deadline,
      guard,
    });
    return {
      ok: true,
      url: contents.getURL(),
      drag: outcome.mode,
      ...settled,
      ...(outcome.rebound ? { rebound: outcome.rebound } : {}),
    };
  };
  // The field actions: fill, select and focus. None of them scrolls, none
  // takes force, and the insertion that reaches the field is the commit
  // point, so nothing after it is sent twice.
  const field = async (id: string, action: FieldAction, run: Run) => {
    const { kind } = action;
    const guard = () => {
      authorizeTab(id);
    };
    const step: Step = {
      deadline: run.deadline,
      signal: run.signal,
      guard,
      dispatch: run.dispatch,
    };
    // Everything from the commit point on runs to its end even if the
    // client goes away.
    const gesture: Step = {
      deadline: run.deadline,
      guard,
      dispatch: run.dispatch,
    };
    const { session } = await actions.readyContents(
      id,
      remaining(run.deadline),
      false,
      run.park,
    );
    const dispatcher = actions.dispatcher(id, session);
    // The target as the page receives it, counted at this action's level.
    const payload: Record<string, unknown> = { ...action.target };
    const query = (payload as { query?: { level?: Level } }).query;
    if (query) query.level = ACTION_LEVELS[kind];
    const selector = (action.target as { selector?: string }).selector;
    const value = action.value ?? "";
    const append = action.append === true;
    const asked = { value, append };

    // The frame the resolution ran in, which section 9 places the field's
    // own point through.
    const ran: RanIn = {};
    const evaluate = (
      operation: FieldOperation,
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
        undefined,
        ran,
      );
    // A selector that matched nothing is folded into the blocker the loop
    // waits out, so a field the page draws late still gets its action.
    const look = async (
      operation: FieldOperation,
      extra: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      try {
        return await evaluate(operation, extra);
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "no_match")
          throw error;
        return {
          ok: true,
          blocked: {
            blocker: "no_match",
            ...(selector === undefined ? {} : { selector }),
            ...unreadOf(error.fields),
          },
        };
      }
    };
    const stop = (blocked: unknown): AttemptResult<FieldOutcome> => ({
      done: false,
      blocked: blocked as LoopBlocker,
    });
    // Section 9: the frame the field sits in. A ref names it before any page
    // call; a selector names it once the resolution has run.
    const before = () => refPlace(id, session, action.target, step);
    const after = async (early: FramePlace) => {
      const place = early.target
        ? early
        : await framePlace(id, session, ran, step);
      if (place.target)
        noteFrame(run, frameNote(place.target, session.contents.getURL()));
      return place;
    };
    // The page the field was prepared on must still be the page the text
    // lands on.
    const onSamePage = (epoch: number) => {
      if (session.epoch === epoch) return;
      fail(
        "page_changed",
        "The page navigated before input completed. Inspect the new page before continuing.",
      );
    };
    const previousOf = (found: Record<string, unknown>) =>
      typeof found.previous === "string" ? found.previous : "";
    // What the field holds afterwards, cut to its first characters, or
    // nothing at all when the field is secret.
    const valueOf = (found: Record<string, unknown>) =>
      found.valueHidden === true
        ? { valueHidden: true as const }
        : typeof found.value === "string"
          ? { value: found.value.slice(0, MAX_FILL_VALUE) }
          : {};
    // One trusted insertion at the prepared caret, or the Delete key for an
    // empty value. The key carries no modifier of its own, so a held Shift
    // can never turn it into a clipboard chord.
    const insert = async (mode: unknown) => {
      if (mode !== "delete") {
        await dispatcher.send(
          [{ method: "Input.insertText", params: { text: value } }],
          gesture,
        );
        return;
      }
      const key = KEYS.delete;
      await dispatcher.key(
        [
          {
            method: "Input.dispatchKeyEvent",
            params: keyParams(key, keyType(key, 0), 0),
          },
          {
            method: "Input.dispatchKeyEvent",
            params: keyParams(key, "keyUp", 0),
          },
        ],
        gesture,
      );
    };
    // The one retry click, at the point the page reported for the field and
    // through the same guards and routing check a click route runs. A click
    // whose move never reached the field's own document is not sent.
    const clickField = async (
      context: AttemptContext,
      landing: Landing,
    ): Promise<boolean> => {
      const { point } = landing;
      await checkPointerTarget(session, point, gesture, {
        button: "left",
        press: true,
        ...guards,
      });
      const bit = BUTTON_BITS.left;
      const buttons = dispatcher.state.buttons;
      const modifiers = dispatcher.state.modifiers;
      if (buttons)
        await dispatcher.pointer(
          pointerCommands({
            type: "moved",
            point,
            button: "left",
            buttons,
            modifiers,
          }),
          gesture,
        );
      else if (!(await routed(id, session, dispatcher, landing, gesture)))
        return false;
      context.gesture.press();
      await dispatcher.pointer(
        pointerCommands({
          type: "pressed",
          point,
          button: "left",
          buttons: buttons | bit,
          clickCount: 1,
          modifiers,
        }),
        gesture,
      );
      await dispatcher.pointer(
        pointerCommands({
          type: "released",
          point,
          button: "left",
          buttons: buttons & ~bit,
          clickCount: 1,
          modifiers,
        }),
        gesture,
      );
      return true;
    };
    const refuse = (match: FillMatch | undefined, clicked: boolean): never =>
      fail(
        "fill_not_accepted",
        clicked
          ? "The field kept its old value after Kamapathy typed into it and clicked it once. Inspect the page before retrying."
          : "The field kept its old value, and a click on it would land on another control or out of view. Inspect the page before retrying.",
        match === undefined ? {} : { match },
      );
    // One round of a fill: the insertion, then the verified read of what the
    // field kept. A read the page could not classify carries its blocker,
    // which ends the action, since the text has already gone out.
    const round = async (
      context: AttemptContext,
      prepared: Record<string, unknown>,
      epoch: number,
    ) => {
      onSamePage(epoch);
      context.gesture.press();
      await insert(prepared.mode);
      onSamePage(epoch);
      const read = await evaluate(
        "fillRead",
        { ...asked, previous: previousOf(prepared) },
        gesture,
      );
      const match =
        typeof read.match === "string" ? (read.match as FillMatch) : undefined;
      return {
        blocked: read.blocked,
        match,
        kept: match !== undefined && FILL_KEPT.includes(match),
        value: {
          ...(match === undefined ? {} : { match }),
          ...valueOf(read),
          ...reboundOf(prepared),
          ...reboundOf(read),
        } as FieldOutcome,
      };
    };

    const fillAttempt = async (
      context: AttemptContext,
    ): Promise<AttemptResult<FieldOutcome>> => {
      const early = await before();
      if (early.blocked) return stop(early.blocked);
      const epoch = session.epoch;
      const prepared = await look("fillPrepare", asked);
      if (prepared.blocked) return stop(prepared.blocked);
      const place = await after(early);
      if (place.blocked) return stop(place.blocked);
      // A date, time, range or colour field takes its value from its own
      // setter instead of typing, and a single select keeps today's fill.
      if (prepared.mode === "direct") {
        const set = await evaluate("setDirectValue", { value });
        if (set.blocked) return stop(set.blocked);
        const now = typeof set.value === "string" ? set.value : value;
        return {
          done: true,
          value: {
            match: classifyFill(previousOf(prepared), value, now, {
              append: false,
            }),
            ...valueOf(set),
            ...reboundOf(prepared),
            ...reboundOf(set),
          },
        };
      }
      const first = await round(context, prepared, epoch);
      if (first.blocked) return stop(first.blocked);
      if (!first.kept) return { done: true, value: first.value };
      // The field kept its old value: one real click at it, then one more
      // round. A field the page reported no point for would take the click
      // on another control, so there is nothing left to try.
      const point = prepared.point;
      if (!finitePoint(point)) return refuse(first.match, false);
      // The click lands at top level, through the owners around the field's
      // own frame, and a covered boundary leaves nothing to try.
      let landing: Landing = { point, local: point };
      if (place.target) {
        const placed = await translatePoint(
          session,
          place.target,
          point,
          gesture,
        );
        if (placed.covered || !inArea(placed.point, placed.area))
          return refuse(first.match, false);
        landing = {
          point: placed.point,
          local: point,
          frameId: rootOf(place.target),
          scale: { x: placed.scaleX, y: placed.scaleY },
        };
      }
      if (!(await clickField(context, landing)))
        return refuse(first.match, false);
      const again = await evaluate("fillPrepare", asked, gesture);
      if (again.blocked) return refuse(first.match, true);
      const second = await round(context, again, epoch);
      if (second.blocked) return stop(second.blocked);
      if (!second.kept) return { done: true, value: second.value };
      return refuse(second.match, true);
    };
    // A select with no matching option names the options it has instead of
    // the one that was asked for.
    const withOptions = (chosen: Record<string, unknown>) => {
      const blocked = chosen.blocked as LoopBlocker;
      const options = Array.isArray(chosen.options)
        ? chosen.options.filter(
            (name): name is string => typeof name === "string",
          )
        : [];
      if (blocked.blocker !== "option_missing" || options.length === 0)
        return blocked;
      return { ...blocked, detail: options.join(", ").slice(0, MAX_DETAIL) };
    };
    const selectAttempt = async (): Promise<AttemptResult<FieldOutcome>> => {
      const early = await before();
      if (early.blocked) return stop(early.blocked);
      const chosen = await look("selectChoose", {
        values: action.values ?? [],
      });
      if (chosen.blocked) return stop(withOptions(chosen));
      const place = await after(early);
      if (place.blocked) return stop(place.blocked);
      return {
        done: true,
        value: {
          values: Array.isArray(chosen.values) ? chosen.values : [],
          ...reboundOf(chosen),
        },
      };
    };
    const focusAttempt = async (): Promise<AttemptResult<FieldOutcome>> => {
      const early = await before();
      if (early.blocked) return stop(early.blocked);
      const focused = await look("focusTarget");
      if (focused.blocked) return stop(focused.blocked);
      const place = await after(early);
      if (place.blocked) return stop(place.blocked);
      return { done: true, value: { ...reboundOf(focused) } };
    };

    const outcome = await runAttempts<FieldOutcome>(
      {
        timeoutMs: action.timeoutMs,
        deadline: run.deadline,
        park: run.park,
        signal: run.signal,
        action: kind,
        ...(selector === undefined ? {} : { selector }),
      },
      kind === "fill"
        ? fillAttempt
        : kind === "select"
          ? selectAttempt
          : focusAttempt,
    );
    return { ok: true, ...outcome };
  };
  // press: an optional target focused through the field path, then one chord
  // as its modifier downs, the key's own down with its text or raw, its up
  // and the modifier ups in reverse. The first keyDown is the commit point,
  // so a modifier that went out is always released.
  //
  // Keys go out on the top page session, which reaches a focused field in a
  // frame of its own process: a probe of Electron 44 (Chromium 152) typed
  // into a cross-origin frame's field that way and read the value back from
  // the frame itself. The macOS editing commands ride along on the key's own
  // down, where the same probe showed they take effect; with no commands the
  // chord did nothing at all.
  const press = async (id: string, action: PressAction, run: Run) => {
    const guard = () => {
      authorizeTab(id);
    };
    const step: Step = {
      deadline: run.deadline,
      signal: run.signal,
      guard,
      dispatch: run.dispatch,
    };
    // The gesture runs to its end even if the client goes away, so a key
    // that went down always comes up.
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
    const chord = parseChord(action.key, platformName);
    // The chord's own modifiers plus the held ones, checked once, before
    // anything is sent.
    checkClipboardChord(chord, heldModifiers(dispatcher), platformName);
    // The target is focused exactly as the focus route focuses it, on the
    // same loop and at the same level.
    const focused = action.target
      ? await field(
          id,
          { kind: "focus", target: action.target, timeoutMs: action.timeoutMs },
          run,
        )
      : {};
    // The keys go to the frame that holds the focus, which the target's own
    // focus step may just have changed.
    const focus = await focusedFrame(id, session, step);
    checkKeyTarget(
      await focusedControl(id, session, run.deadline, step, focus?.frameId),
      chord,
      platformName,
    );
    const epoch = session.epoch;
    const { down, up } = chordCommands(
      chord,
      { mask: dispatcher.state.modifiers },
      platformName,
    );
    const send = async () => {
      guard();
      if (session.epoch !== epoch)
        fail(
          "page_changed",
          "The page navigated before input completed. Inspect the new page before continuing.",
        );
      await dispatcher.key(down, gesture);
      if (action.delayMs) await pause(action.delayMs);
      await dispatcher.key(up, gesture);
    };
    await confirmDelivery({
      kind: "key",
      // The counters of the frame that holds the focus: a key inside a frame
      // never reaches the page's own document.
      counters: () =>
        actions.evaluatePage(
          id,
          session,
          "input",
          {},
          step.deadline,
          step,
          focus?.frameId,
        ),
      frames: async () => {
        await actions.evaluatePage(
          id,
          session,
          "frame",
          {},
          Math.min(step.deadline, Date.now() + 2000),
          step,
          focus?.frameId,
        );
      },
      epoch: () => session.epoch,
      budget: step.deadline,
      deliver: send,
    });
    // The page's own handlers, then a load the key started.
    const settled = await settleAfterInput({
      contents,
      park: run.park,
      budget: run.deadline,
      guard,
    });
    return {
      ok: true,
      url: contents.getURL(),
      ...settled,
      ...reboundOf(focused),
    };
  };
  // The raw keyboard routes: one key held or let go, text typed character by
  // character, or text inserted at the caret. None of them settles and none
  // waits for a load, so a key that navigates leaves the load to the next
  // request, and none is ever sent twice.
  const keyboard = async (id: string, action: KeyboardAction, run: Run) => {
    const guard = () => {
      authorizeTab(id);
    };
    const step: Step = {
      deadline: run.deadline,
      signal: run.signal,
      guard,
      dispatch: run.dispatch,
    };
    const gesture: Step = {
      deadline: run.deadline,
      guard,
      dispatch: run.dispatch,
    };
    const { session } = await actions.readyContents(
      id,
      remaining(run.deadline),
      false,
      run.park,
    );
    const dispatcher = actions.dispatcher(id, session);
    const state = dispatcher.state;
    // Keys and inserted text act in the frame that holds the focus, so that
    // frame's own world answers for the control and takes the paste.
    const focus = await focusedFrame(id, session, step);
    const look = () =>
      focusedControl(id, session, run.deadline, step, focus?.frameId);
    const withState = () => ({ ok: true, input: state.view() });
    if (action.kind === "down" || action.kind === "up") {
      const chord = parseChord(action.key ?? "", platformName);
      const key = chord.key;
      const own = key.modifier ? MODIFIER_BITS[key.modifier] : 0;
      if (action.kind === "down") {
        const mask = state.modifiers | chord.mask | own;
        // Holding a modifier is how a chord is built by hand, so the key
        // that completes a copy, cut or paste is refused here too.
        checkClipboardChord(chordOf(key, mask), [], platformName);
        checkKeyTarget(await look(), chordOf(key, mask), platformName);
        // A key already held repeats, as a person's keyboard repeats it.
        const repeat = state
          .heldKeys()
          .some((other) => other.name === key.name);
        await dispatcher.key(
          [
            {
              method: "Input.dispatchKeyEvent",
              params: keyParams(key, keyType(key, mask), mask, {
                ...(repeat ? { autoRepeat: true } : {}),
                commands: macCommands(chordOf(key, mask), platformName),
              }),
            },
          ],
          gesture,
        );
        return withState();
      }
      // A release carries the mask as it is once the key is up, and only a
      // key the tab holds can be released, so the stored state and the
      // page's never drift apart.
      if (!state.heldKeys().some((other) => other.name === key.name))
        return fail(
          "invalid_field",
          "The key is not held. Hold it with keyboard/down first.",
          { field: "key", expected: "a key this tab holds" },
        );
      const mask = state.modifiers & ~own;
      await dispatcher.key(
        [
          {
            method: "Input.dispatchKeyEvent",
            params: keyParams(key, "keyUp", mask),
          },
        ],
        gesture,
      );
      return withState();
    }
    const text = action.text ?? "";
    if (action.kind === "paste") {
      // The page is offered the content first, in a DataTransfer of its own,
      // and nothing here ever touches the system clipboard.
      const offered = await pasteOnPage(
        id,
        session,
        action,
        run.deadline,
        step,
        focus?.frameId,
      );
      if (offered.handled === "page") return { ok: true, handled: "page" };
      // The page ignored the event, so Kamapathy inserts the plain text, and
      // only the plain text, at the focused editable's caret.
      await dispatcher.send(
        [{ method: "Input.insertText", params: { text } }],
        gesture,
      );
      return { ok: true, handled: "text" };
    }
    if (action.kind === "insert-text") {
      // Inserted text opens no picker, so only its frame is checked.
      const focused = await look();
      checkKeyTarget(focused, undefined, platformName);
      if (focused.kind !== "editable")
        return fail(
          "not_editable",
          "Nothing that takes typing has focus, so there is nowhere to insert this text. Focus a field or use fill.",
          { reason: "none" },
        );
      await dispatcher.send(
        [{ method: "Input.insertText", params: { text } }],
        gesture,
      );
      return { ok: true };
    }
    const focused = await look();
    checkKeyTarget(focused, undefined, platformName);
    // Space and Enter are the only keys a typed text sends that could open a
    // focused control's own picker.
    for (const [character, key] of TYPED_PICKER_KEYS)
      if (text.includes(character))
        checkKeyTarget(focused, chordOf(key, state.modifiers), platformName);
    const groups = textCommands(text, platformName, { mask: state.modifiers });
    // A held modifier turns a typed character into a chord, which may be a
    // clipboard one.
    for (const group of groups) {
      const { code, modifiers } = group[0].params;
      const typed = typeof code === "string" ? keyByCode(code) : undefined;
      if (typed)
        checkClipboardChord(
          chordOf(typed, typeof modifiers === "number" ? modifiers : 0),
          [],
          platformName,
        );
    }
    for (const [index, group] of groups.entries()) {
      if (index > 0 && action.delayMs) await pause(action.delayMs);
      const insertion = group[0].method === "Input.insertText";
      await (insertion
        ? dispatcher.send(group, gesture)
        : dispatcher.key(group, gesture));
    }
    return withState();
  };
  // The raw mouse routes: the pointer moves where it is told, presses and
  // releases where it stands, or scrolls there. None of them resolves a
  // target or waits for actionability, as section 5 says, and each answers
  // with the tab's stored input state.
  const mouse = async (id: string, action: MouseAction, run: Run) => {
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
    const state = dispatcher.state;
    const here = () => ({ x: state.x, y: state.y });
    const withState = () => ({ ok: true, input: state.view() });
    // The point an agent names has to lie inside the page's own viewport,
    // which a tab that was never shown answers for its content area, so
    // nothing here assumes a size.
    const inViewport = async (point: Point) => {
      const view = await actions.evaluatePage(
        id,
        session,
        "viewport",
        {},
        run.deadline,
        step,
      );
      const width = typeof view.width === "number" ? view.width : 0;
      const height = typeof view.height === "number" ? view.height : 0;
      if (
        point.x >= 0 &&
        point.x <= width &&
        point.y >= 0 &&
        point.y <= height
      )
        return;
      fail(
        "point_outside_viewport",
        `The point ${point.x},${point.y} lies outside this page's viewport of ${width} by ${height} pixels. Take a snapshot or a screenshot to measure the page.`,
        { width, height },
      );
    };
    const aim = (
      point: Point,
      press: boolean,
      reached?: { frameId?: string },
      at: Step = step,
    ) =>
      checkPointerTarget(session, point, at, {
        button: action.button,
        press,
        ...guards,
        ...(reached ? { reached } : {}),
      });
    // Where a raw press lands, for the routing and delivery checks: the
    // frame group of the frame the guard's hit test says the point reaches,
    // and the point in that group's own pixels. A point over the page's own
    // document is the page's; one no group can place is read in the frame
    // it reaches, with no pixels to compare.
    const reach = async (
      point: Point,
      frameId: string | undefined,
    ): Promise<{ landing: Landing; frame?: FrameTarget }> => {
      const main = await session.mainFrameId(step);
      if (frameId === undefined || frameId === main)
        return { landing: { point, local: point } };
      const frames = deps.frames?.for(id);
      if (frames) await frames.bind(step);
      const root = frames?.groupOf(frameId)?.root;
      if (root === main) return { landing: { point, local: point } };
      if (!frames || root === undefined) return { landing: { point, frameId } };
      const frame = frameTargetOf(frames, root);
      const inside = frame.owners.length
        ? await placeInFrame(session, frame, point, step)
        : undefined;
      return {
        frame,
        landing: inside
          ? {
              point,
              local: inside.point,
              frameId: root,
              scale: { x: inside.scaleX, y: inside.scaleY },
            }
          : { point, frameId: root },
      };
    };
    // A raw press waits, as an element action does, until a move at its
    // point reaches the document the guard says it lands in, there, for up
    // to the default action timeout, and nothing is pressed before. A held
    // button takes the move to the frame its own press went to instead.
    const arrival = (point: Point, name: string) =>
      runAttempts<{ landing: Landing; frame?: FrameTarget }>(
        {
          timeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
          deadline: run.deadline,
          park: run.park,
          signal: run.signal,
          action: name,
        },
        async () => {
          const reached: { frameId?: string } = {};
          await aim(point, true, reached);
          const place = await reach(point, reached.frameId);
          if (
            state.buttons ||
            (await routed(id, session, dispatcher, place.landing, step))
          )
            return { done: true, value: place };
          return { done: false, blocked: notDrawn(place.frame) };
        },
      );
    if (action.kind === "move") {
      const to = { x: action.x ?? 0, y: action.y ?? 0 };
      await inViewport(to);
      await aim(to, false);
      // A move while a button is held drags, so the held button travels
      // with each event, as a person's would.
      const held = state.heldButtons()[0];
      for (const point of interpolate(here(), to, action.steps))
        await dispatcher.pointer(
          pointerCommands({
            type: "moved",
            point,
            button: held ?? "none",
            buttons: state.buttons,
            modifiers: state.modifiers,
          }),
          gesture,
        );
      return withState();
    }
    if (action.kind === "down" || action.kind === "up") {
      const bit = BUTTON_BITS[action.button];
      // Only a button the tab holds can be released, so the stored state
      // and the page's never drift apart. A release runs no guard: the
      // press that put it there passed one, and refusing it would leave the
      // button held with no way to let it go.
      if (action.kind === "up" && !state.heldButtons().includes(action.button))
        return fail(
          "invalid_field",
          "The button is not held. Press it with mouse/down first.",
          { field: "button", expected: "a button this tab holds" },
        );
      const point = here();
      if (action.kind === "down") await arrival(point, "mouse/down");
      await dispatcher.pointer(
        pointerCommands({
          type: action.kind === "down" ? "pressed" : "released",
          point,
          button: action.button,
          buttons:
            action.kind === "down" ? state.buttons | bit : state.buttons & ~bit,
          clickCount: action.clickCount,
          modifiers: state.modifiers,
        }),
        gesture,
      );
      return withState();
    }
    if (action.kind === "click") {
      const to = { x: action.x ?? 0, y: action.y ?? 0 };
      await inViewport(to);
      const place = await arrival(to, "mouse/click");
      const bit = BUTTON_BITS[action.button];
      const presses = createGesture();
      // A press and a release per click after the move, with a delay in
      // each gap, exactly as an element click sends them. A held button's
      // move goes with the gesture, since no check sent one.
      const send = async () => {
        if (state.buttons)
          await dispatcher.pointer(
            pointerCommands({
              type: "moved",
              point: to,
              button: action.button,
              buttons: state.buttons,
              modifiers: state.modifiers,
            }),
            gesture,
          );
        for (let click = 1; click <= action.clickCount; click += 1) {
          if (click > 1 && action.delayMs) await pause(action.delayMs);
          guard();
          presses.press();
          await dispatcher.pointer(
            pointerCommands({
              type: "pressed",
              point: to,
              button: action.button,
              buttons: state.buttons | bit,
              clickCount: click,
              modifiers: state.modifiers,
            }),
            gesture,
          );
          if (action.delayMs) await pause(action.delayMs);
          await dispatcher.pointer(
            pointerCommands({
              type: "released",
              point: to,
              button: action.button,
              buttons: state.buttons & ~bit,
              clickCount: click,
              modifiers: state.modifiers,
            }),
            gesture,
          );
        }
      };
      // Section 5's delivery check, as every route that presses runs it, on
      // the counters of the frame the press reaches.
      const { frameId } = place.landing;
      await confirmDelivery({
        kind: "mouse",
        counters: () =>
          actions.evaluatePage(
            id,
            session,
            "input",
            {},
            step.deadline,
            step,
            frameId,
          ),
        strays: await straysOf(id, session, place.frame, step, () =>
          presses.refuse(),
        ),
        // A resend runs the checks of the first press again.
        again: async () => {
          await aim(to, true, undefined, gesture);
          if (
            !state.buttons &&
            !(await routed(id, session, dispatcher, place.landing, gesture))
          )
            fail(
              "input_not_delivered",
              "The page did not accept native input. Inspect the page before retrying.",
            );
        },
        frames: async () => {
          await actions.evaluatePage(
            id,
            session,
            "frame",
            {},
            Math.min(step.deadline, Date.now() + 2000),
            step,
            frameId,
          );
        },
        epoch: () => session.epoch,
        budget: step.deadline,
        deliver: send,
      });
      // The page's own handlers, then a load the click started.
      const settled = await settleAfterInput({
        contents,
        park: run.park,
        budget: run.deadline,
        guard,
      });
      return {
        ok: true,
        url: contents.getURL(),
        input: state.view(),
        ...settled,
      };
    }
    const point = here();
    await aim(point, false);
    const events = wheelEvents(action.deltaX ?? 0, action.deltaY ?? 0);
    for (const [index, event] of events.entries()) {
      if (index) await pause(WHEEL_GAP_MS);
      await dispatcher.pointer(
        wheelCommands(point, event, state.modifiers),
        gesture,
      );
    }
    return withState();
  };
  // input/release: everything the tab holds goes, the keys last held first
  // and then the buttons, and the answer names what was let go. It reveals
  // no tab and reports no point.
  const release = async (id: string, run: Run) => {
    const guard = () => {
      authorizeTab(id);
    };
    // A key that started a load can still be let go, so a loading page is
    // not waited for here.
    const { session } = await actions.readyContents(
      id,
      remaining(run.deadline),
      true,
      run.park,
    );
    const released = await actions.dispatcher(id, session).release({
      deadline: run.deadline,
      signal: run.signal,
      guard,
      dispatch: run.dispatch,
    });
    return { ok: true, released };
  };
  // The keyboard routes' own check on the frame holding focus, for section
  // 8's raw keys and text.
  const checkFocus = async (id: string, session: TabSession, step: Step) => {
    const focus = await focusedFrame(id, session, step);
    checkKeyTarget(
      await focusedControl(id, session, step.deadline, step, focus?.frameId),
      undefined,
      platformName,
    );
  };
  return { pointer, drag, field, press, keyboard, mouse, release, checkFocus };
}
