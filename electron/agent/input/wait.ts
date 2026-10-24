// Section 5's attempt loop and the waits around a gesture. The loop knows
// nothing about pages: each route hands it one attempt closure, so click,
// fill and select share the backoff, the blockers and the two endings.
import type { WebContents } from "electron";
import type { ActionBlocker, ActionKind, Blocked } from "../dom/actions";
import type { Level } from "../dom/select";
import { ApiError, fail } from "../errors";
import type { Park } from "../http";
import { CdpTimeoutError } from "../session/errors";

// The gaps between attempts: 50, 100, 250 and then 500 until the timeout.
export const BACKOFF_MS: readonly number[] = [50, 100, 250, 500];
export const DEFAULT_ACTION_TIMEOUT_MS = 3000;
// What a press waits for afterwards: the page's own handlers, then a load.
export const SETTLE_MS = 100;
export const LOAD_WAIT_MS = 15000;
// How many wheel gestures bring a target into view before the page scrolls
// itself, and how long its box may keep moving afterwards. A probe of
// Electron 44 scrolled same-process and out-of-process containers within
// 55 ms, so 500 ms is room to spare.
export const MAX_SCROLL_GESTURES = 6;
export const SCROLL_SETTLE_MS = 500;
// The least budget a further wait or send is worth starting with.
const SPARE_MS = 250;
// How many times one gesture is sent in all.
const MAX_DELIVERIES = 3;

// The blockers an attempt may report, which the loop waits out.
export const TRANSIENT_BLOCKERS: readonly string[] = [
  "no_match",
  "detached",
  "hidden",
  "disabled",
  "read_only",
  "not_focused",
  "moving",
  "covered",
  "outside_viewport",
  "option_missing",
  "frame_not_ready",
];
// What a blocker reads as in an action_timeout message.
const REASONS: Readonly<Record<ActionBlocker | "no_match", string>> = {
  no_match: "Nothing on the page matches the selector.",
  detached: "The target left the page.",
  hidden: "The target is not visible.",
  disabled: "The target is disabled.",
  read_only: "The field is read only.",
  not_focused: "The field did not take focus.",
  moving: "The target is still moving.",
  covered: "Another element covers the target.",
  outside_viewport: "The target could not be brought on screen.",
  option_missing: "The select has no matching option.",
  frame_not_ready: "The frame holding the target is still loading.",
};
// A blocker the page reports about its own surroundings rather than about
// the target, kept only while the page has reported nothing else.
const WEAK: readonly string[] = ["frame_not_ready"];
// The strictness each action counts its matches at (section 4's levels).
export const ACTION_LEVELS: Readonly<Record<ActionKind, Level>> = {
  click: "pointer-enabled",
  dblclick: "pointer-enabled",
  hover: "pointer",
  drag: "pointer",
  fill: "enabled",
  select: "enabled",
  focus: "enabled",
  press: "enabled",
};

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

// The record of what one action already sent. A route marks it right before
// its first press, and from then on the loop sends nothing again.
export interface Gesture {
  readonly presses: number;
  readonly committed: boolean;
  press(): void;
  refuse(): never;
}
export function createGesture(): Gesture {
  let presses = 0;
  return {
    get presses() {
      return presses;
    },
    get committed() {
      return presses > 0;
    },
    press() {
      presses += 1;
    },
    refuse: () =>
      fail(
        "element_obscured",
        "Another element covers the target. The input Kamapathy already sent was not repeated; inspect the page before retrying.",
        { presses },
      ),
  };
}

export interface AttemptContext {
  attempt: number;
  scrolls: number;
  waitedMs: number;
  gesture: Gesture;
}
// What the loop waits out: one of the page's blockers, or a selector that
// matched nothing, which the attempt translates from section 4's failure.
export interface LoopBlocker extends Omit<Blocked, "blocker"> {
  blocker: ActionBlocker | "no_match";
  selector?: string;
}
export interface AttemptResult<T> {
  done: boolean;
  value?: T;
  blocked?: LoopBlocker;
}
export interface LoopOptions {
  timeoutMs: number;
  deadline: number;
  park: Park;
  selector?: string;
  signal?: AbortSignal;
  action: string;
}

// Runs the attempt until it is done, until a permanent failure, or until the
// timeout. A transient blocker releases the space's lane for the gap, so the
// space's other requests run between attempts.
export async function runAttempts<T>(
  options: LoopOptions,
  attempt: (context: AttemptContext) => Promise<AttemptResult<T>>,
): Promise<T> {
  const started = Date.now();
  const until = Math.min(started + options.timeoutMs, options.deadline);
  const context: AttemptContext = {
    attempt: 0,
    scrolls: 0,
    waitedMs: 0,
    gesture: createGesture(),
  };
  // The latest blocker the page reported about the target, and the weaker
  // report kept while it reported nothing else.
  let real: LoopBlocker | undefined;
  let weak: LoopBlocker | undefined;
  for (;;) {
    context.waitedMs = Date.now() - started;
    let result: AttemptResult<T>;
    try {
      result = await attempt(context);
    } catch (error) {
      // A page that did not answer in time is as weak a report as an unready
      // frame: the loop keeps looking while the budget lasts.
      if (!(error instanceof CdpTimeoutError)) throw error;
      result = {
        done: false,
        blocked: { blocker: "frame_not_ready", detail: "stalled" },
      };
    }
    if (result.done) return result.value as T;
    if (result.blocked) {
      if (WEAK.includes(result.blocked.blocker)) weak = result.blocked;
      else real = result.blocked;
    }
    // Nothing is sent again once a press has gone out.
    if (context.gesture.committed) break;
    context.attempt += 1;
    const left = until - Date.now();
    if (left <= 0) break;
    const gap = Math.min(
      BACKOFF_MS[Math.min(context.attempt - 1, BACKOFF_MS.length - 1)],
      left,
    );
    await options.park(() => pause(gap));
  }
  const waitedMs = Date.now() - started;
  const stop = real ?? weak;
  if (stop?.blocker === "no_match")
    return fail(
      "no_match",
      "Nothing on the page matched this selector before the timeout. Take a snapshot to check the page.",
      {
        ...((options.selector ?? stop.selector)
          ? { selector: options.selector ?? stop.selector }
          : {}),
        waitedMs,
      },
    );
  const reason = stop ? REASONS[stop.blocker] : "The target was not ready.";
  return fail(
    "action_timeout",
    `${options.action} timed out after ${options.timeoutMs} ms: ${reason}`,
    {
      awaited: "actionable",
      ...(stop ? { blocker: stop.blocker } : {}),
      ...(stop?.detail === undefined ? {} : { detail: stop.detail }),
      ...(stop?.interceptor === undefined
        ? {}
        : { interceptor: stop.interceptor }),
      timeoutMs: options.timeoutMs,
    },
  );
}

// After a press: the page's own handlers run, then a main-frame load that
// started is waited out. A load still running is reported, never an error.
// Section 6 replaces the load wait with its own tracking.
export async function settleAfterInput(deps: {
  contents: WebContents;
  park: Park;
  // When the request's own budget ends.
  budget: number;
  guard(): void;
}): Promise<{ loading?: true }> {
  const left = () => deps.budget - Date.now();
  const settle = Math.min(SETTLE_MS, left());
  if (settle > 0) await deps.park(() => pause(settle));
  deps.guard();
  if (!deps.contents.isLoadingMainFrame()) return {};
  const wait = Math.min(LOAD_WAIT_MS, left());
  if (wait < SPARE_MS) return { loading: true };
  const loaded = await deps.park(
    () =>
      new Promise<boolean>((resolve) => {
        const stopped = () => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          deps.contents.removeListener("did-stop-loading", stopped);
          resolve(false);
        }, wait);
        deps.contents.once("did-stop-loading", stopped);
      }),
  );
  deps.guard();
  return loaded ? {} : { loading: true };
}

// Chromium reports a successful dispatch for native input it drops while a
// page has not rendered a frame since its last navigation, so a gesture is
// repeated only on positive evidence that no frame received it. The counters
// come from section 1's init script, and a resend that would run past the
// request's budget is not sent.
export async function confirmDelivery<T>(deps: {
  kind: "mouse" | "key" | "drag";
  counters(): Promise<Record<string, unknown>>;
  frames(): Promise<void>;
  epoch(): number;
  budget: number;
  deliver(): Promise<T>;
}): Promise<T> {
  const epoch = deps.epoch();
  for (let attempt = 0; ; attempt += 1) {
    const armed = await deps.counters();
    const delivered = await deps.deliver();
    // Input that already changed the page was delivered.
    if (deps.epoch() !== epoch) return delivered;
    const received = await deps.counters();
    const before = armed[deps.kind];
    const after = received[deps.kind];
    if (
      typeof before !== "number" ||
      typeof after !== "number" ||
      after > before
    )
      return delivered;
    if (attempt >= MAX_DELIVERIES - 1 || deps.budget - Date.now() < SPARE_MS)
      throw new ApiError(
        "input_not_delivered",
        "The page did not accept native input. Inspect the page before retrying.",
      );
    await deps.frames().catch(() => {});
  }
}
