import { ApiError } from "../errors";
import type { Park } from "../http";
import { CdpTimeoutError, ContextLostError } from "../session/errors";
import type { TabSession } from "../session/tab-session";
import type { Step } from "../session/types";
import {
  ENDED_GRACE_MS,
  REPLACED_WITHIN_MS,
  type MainDocument,
  type NavigationFailure,
  type NavigationTracker,
  type TrackerEvent,
} from "./tracker";

export type WaitUntil = "commit" | "domcontentloaded" | "load" | "networkidle";
export const WAIT_UNTIL: readonly WaitUntil[] = [
  "commit",
  "domcontentloaded",
  "load",
  "networkidle",
];
// How often a wait wakes up to re-authorize and look again, so a takeover
// ends it within one tick.
const TICK_MS = 100;
// The quiet window networkidle asks for unless the body names another.
const IDLE_MS = 500;
// How many characters of a URL a message carries.
const URL_CHARS = 100;
// The failures the spec calls transient: they are raised before any request
// reached a server, so nothing can have happened at the far end.
const RETRYABLE: readonly string[] = [
  "ERR_INTERNET_DISCONNECTED",
  "ERR_NETWORK_CHANGED",
  "ERR_NETWORK_IO_SUSPENDED",
  "ERR_NAME_RESOLUTION_FAILED",
  "ERR_CONNECTION_REFUSED",
  "ERR_CONNECTION_TIMED_OUT",
];
const ABORTED = "ERR_ABORTED";

export interface NavigationScope {
  tabId: string;
  session: TabSession;
  tracker: NavigationTracker;
  // The operation's own deadline, its signal, its guard and its dispatch
  // record.
  step: Step;
  // run.park, so the space lane and the slot are free between checks.
  park: Park;
  // The operation's timeout, for the error fields.
  timeoutMs: number;
  idleMs?: number;
}
export interface NavigationOutcome {
  committed: boolean;
  url: string;
  httpStatus?: number;
  waitUntil: WaitUntil;
  inPlace: boolean;
}
export interface PendingGate {
  enter(tabId: string): () => void;
}
type Ended = Extract<TrackerEvent, { type: "ended" }>;

const cut = (url: string) => url.slice(0, URL_CHARS);
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname || cut(url);
  } catch {
    return cut(url);
  }
};
// What a document's lifecycle says its readyState is. A document that has
// not committed has none.
const readyStateOf = (document: MainDocument | undefined) =>
  document === undefined
    ? undefined
    : document.load
      ? "complete"
      : document.domContentLoaded
        ? "interactive"
        : "loading";

export function navigationFailed(
  url: string,
  failure: NavigationFailure | undefined,
  httpStatus: number | undefined,
): ApiError {
  const problem = failure ?? { netError: ABORTED, errorCode: 0 };
  const blocked = problem.blockedUrl;
  return new ApiError(
    "navigation_failed",
    blocked === undefined
      ? `Navigation to ${cut(url)} failed with ${problem.netError}.`
      : `Navigation to ${cut(url)} was cancelled: it redirected to ${cut(blocked)}, which agents may not open.`,
    {
      url,
      netError: problem.netError,
      errorCode: problem.errorCode,
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(blocked === undefined ? {} : { blockedUrl: blocked }),
      // Stripped by envelope, which sets retryable itself; it tells go.ts
      // this is the one failure that reached no server.
      ...(RETRYABLE.includes(problem.netError) && httpStatus === undefined
        ? { retryable: true as const }
        : {}),
    },
  );
}
// The one navigation failure an agent may send again: nothing reached a
// server, so no side effect can have happened.
export const retryableNavigation = (error: unknown) =>
  error instanceof ApiError &&
  error.code === "navigation_failed" &&
  error.fields.retryable === true;

const navigationDownload = (url: string) =>
  new ApiError(
    "navigation_download",
    `${cut(url)} is a download, not a page. Nothing was saved, since this navigation armed no download.`,
    { url, armed: false },
  );
const navigationInterrupted = (url: string, by: string) =>
  new ApiError(
    "navigation_interrupted",
    `Navigation to ${cut(url)} was replaced by one to ${cut(by)}. Read the page before repeating anything.`,
    { url, by },
  );
// The copy section 6 fixes, with the state the agent asked for.
function navigationTimeout(options: {
  awaited: WaitUntil;
  timeoutMs: number;
  url: string;
  committed?: { url: string; readyState: string };
}): ApiError {
  const { awaited, timeoutMs, committed } = options;
  const reached = committed
    ? `It committed at ${cut(committed.url)} with readyState ${committed.readyState}. Continue there, or call waitForLoadState.`
    : "It never committed. Check the address and connection.";
  return new ApiError(
    "navigation_timeout",
    `Navigation to ${hostOf(committed?.url ?? options.url)} did not reach ${awaited} within ${timeoutMs} ms. ${reached}`,
    {
      awaited,
      timeoutMs,
      committed: committed !== undefined,
      url: committed?.url ?? options.url,
      ...(committed === undefined ? {} : { readyState: committed.readyState }),
    },
  );
}

// A download or a newer navigation says more about an abort than its error
// text, and so does a cancelled redirect.
const explained = (end: Ended) =>
  end.download === true ||
  end.by !== undefined ||
  end.failure?.blockedUrl !== undefined ||
  (end.failure !== undefined && end.failure.netError !== ABORTED);
// A bare abort may still be explained moments later: by a download, which
// Chromium reports after the abort, or by the navigation that replaced it.
const graceFor = (end: Ended) =>
  end.httpStatus === undefined ? REPLACED_WITHIN_MS : ENDED_GRACE_MS;
// Download first, then the navigation that replaced it, then the failure.
function classify(end: Ended): ApiError {
  if (end.download === true) return navigationDownload(end.url);
  if (end.by !== undefined) return navigationInterrupted(end.url, end.by);
  return navigationFailed(end.url, end.failure, end.httpStatus);
}

// Sleeps up to milliseconds, or until wake is called.
function nap(milliseconds: number, hold: { wake?: () => void }) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, Math.max(1, milliseconds));
    function done() {
      clearTimeout(timer);
      hold.wake = undefined;
      resolve();
    }
    hold.wake = done;
  });
}

// Runs one of the session's own waits under the common wait rules: the lane
// is free while it runs, and every tick re-authorizes, so a takeover ends it
// within TICK_MS.
async function ticking<T>(
  scope: NavigationScope,
  start: () => Promise<T>,
): Promise<T> {
  let done: { value: T } | undefined;
  let failed: { error: unknown } | undefined;
  const running = start().then(
    (value) => {
      done = { value };
    },
    (error: unknown) => {
      failed = { error };
    },
  );
  for (;;) {
    if (done) return done.value;
    if (failed) throw failed.error;
    await scope.park(async () => {
      const hold: { wake?: () => void } = {};
      const sleeping = nap(TICK_MS, hold);
      await Promise.race([running.then(() => hold.wake?.()), sleeping]);
    });
  }
}

// Waits for the current document to reach state, following a cross-document
// navigation that commits before it does.
async function reachState(
  scope: NavigationScope,
  state: WaitUntil,
  loaderId: string | undefined,
): Promise<void> {
  if (state === "commit") return;
  const lifecycle = state === "networkidle" ? "load" : state;
  let document = loaderId || undefined;
  for (;;) {
    try {
      await ticking(scope, () =>
        scope.session.waitForLifecycle(lifecycle, {
          ...scope.step,
          ...(document === undefined ? {} : { loaderId: document }),
        }),
      );
      if (state === "networkidle")
        await ticking(scope, () =>
          scope.session.network.waitForIdle(
            scope.idleMs ?? IDLE_MS,
            scope.step,
          ),
        );
      return;
    } catch (error) {
      const next = scope.tracker.document?.loaderId || undefined;
      // The document the frame shows now is the one to judge.
      if (error instanceof ContextLostError && next !== document) {
        document = next;
        continue;
      }
      throw error;
    }
  }
}

interface Commit {
  loaderId: string;
  url: string;
  inPlace: boolean;
}

// Follows the navigation a dispatch started until it commits, with its
// document or in place, and classifies an abort before that.
async function awaitCommit(
  scope: NavigationScope,
  options: { waitUntil: WaitUntil; from: number; url?: string },
  requested: string,
): Promise<Commit> {
  const { tracker, step } = scope;
  const events: TrackerEvent[] = [];
  const hold: { wake?: () => void } = {};
  const stop = tracker.subscribe((event) => {
    events.push(event);
    hold.wake?.();
  });
  // The navigation this dispatch started: the first toward the requested
  // address, or any one for a reload.
  let followed: string | undefined;
  let ended: { end: Ended; at: number } | undefined;
  try {
    for (;;) {
      for (const event of events.splice(0)) {
        if (event.type === "started") {
          if (
            followed === undefined &&
            (options.url === undefined || event.url === options.url)
          )
            followed = event.loaderId;
        } else if (event.type === "committed") {
          // A navigation that failed commits Chromium's error page under the
          // same loader; its end has already said what went wrong.
          if (event.navigation <= options.from) continue;
          if (ended?.end.loaderId === event.loaderId) continue;
          if (
            event.inPlace ||
            followed === undefined ||
            event.loaderId === followed
          )
            return {
              loaderId: event.loaderId,
              url: event.url,
              inPlace: event.inPlace,
            };
        } else if (event.type === "ended") {
          if (followed !== undefined && event.loaderId !== followed) continue;
          ended = { end: event, at: Date.now() };
        }
      }
      if (
        ended &&
        (explained(ended.end) || Date.now() - ended.at >= graceFor(ended.end))
      )
        throw classify(ended.end);
      if (Date.now() >= step.deadline)
        throw navigationTimeout({
          awaited: options.waitUntil,
          timeoutMs: scope.timeoutMs,
          url: requested,
        });
      await scope.park(() =>
        events.length
          ? Promise.resolve()
          : nap(Math.min(TICK_MS, step.deadline - Date.now()), hold),
      );
    }
  } finally {
    hold.wake = undefined;
    stop();
  }
}

// Waits for the navigation a dispatch started to commit, then for the state
// the agent asked for. `expect` only shapes the messages.
export async function awaitNavigation(
  scope: NavigationScope,
  options: {
    waitUntil: WaitUntil;
    from: number;
    expect: "navigate" | "reload";
    url?: string;
  },
): Promise<NavigationOutcome> {
  const { tracker } = scope;
  const requested = options.url ?? scope.session.contents.getURL();
  const committed = await awaitCommit(scope, options, requested);
  // A document request's status belongs to the document that committed, so
  // it is read before a client-side redirect can replace it.
  const httpStatus = committed.inPlace
    ? undefined
    : tracker.document?.httpStatus;
  try {
    await reachState(scope, options.waitUntil, committed.loaderId);
  } catch (error) {
    if (!(error instanceof CdpTimeoutError)) throw error;
    throw navigationTimeout({
      awaited: options.waitUntil,
      timeoutMs: scope.timeoutMs,
      url: requested,
      committed: {
        url: tracker.document?.url ?? committed.url,
        readyState: readyStateOf(tracker.document) ?? "loading",
      },
    });
  }
  return {
    committed: true,
    url: tracker.document?.url ?? committed.url,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    waitUntil: options.waitUntil,
    inPlace: committed.inPlace,
  };
}

// Judges state on the current document, following a cross-document
// navigation in flight and ending on its failure.
export async function awaitLoadState(
  scope: NavigationScope,
  options: { state: WaitUntil; awaited: "load_state" | "url" | "navigation" },
): Promise<{ state: WaitUntil; url: string; readyState: string }> {
  const { tracker } = scope;
  // A navigation that fails while the wait runs ends it with its own error.
  const ending = new AbortController();
  const stop = tracker.subscribe((event) => {
    if (event.type !== "ended" || ending.signal.aborted) return;
    if (event.download === true || event.by !== undefined) return;
    if (event.failure)
      ending.abort(
        navigationFailed(event.url, event.failure, event.httpStatus),
      );
  });
  const signal = scope.step.signal
    ? AbortSignal.any([scope.step.signal, ending.signal])
    : ending.signal;
  try {
    await reachState(
      { ...scope, step: { ...scope.step, signal } },
      options.state,
      undefined,
    );
  } catch (error) {
    if (ending.signal.aborted) throw ending.signal.reason;
    if (!(error instanceof CdpTimeoutError)) throw error;
    const document = tracker.document;
    const readyState = readyStateOf(document) ?? "loading";
    throw new ApiError(
      "wait_timeout",
      `The page did not reach ${options.state} within ${scope.timeoutMs} ms. It is at ${cut(document?.url ?? "")} with readyState ${readyState}.`,
      {
        awaited: options.awaited,
        timeoutMs: scope.timeoutMs,
        state: options.state,
        url: document?.url ?? "",
        readyState,
      },
    );
  } finally {
    stop();
  }
  return {
    state: options.state,
    url: tracker.document?.url ?? "",
    readyState: readyStateOf(tracker.document) ?? "loading",
  };
}

// How many navigations and waits one tab may have in flight.
export function createPendingGate(limit = 4): PendingGate {
  const held = new Map<string, number>();
  return {
    enter(tabId) {
      const count = held.get(tabId) ?? 0;
      if (count >= limit)
        throw new ApiError(
          "busy",
          `This page already has ${limit} navigations or waits in flight. Wait for one to finish.`,
          { scope: "tab", retryAfterMs: 250 },
        );
      held.set(tabId, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (held.get(tabId) ?? 1) - 1;
        if (left > 0) held.set(tabId, left);
        else held.delete(tabId);
      };
    },
  };
}
