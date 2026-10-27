import type { WaitState } from "../dom/select";
import { ApiError, fail } from "../errors";
import {
  evaluateOnce,
  isTruthy,
  requireScripts,
  type ScriptSource,
} from "../evaluate";
import type { Run } from "../http";
import { waitMode } from "../resolve";
import type { AutomationController } from "../server";
import { CdpTimeoutError, ContextLostError } from "../session/errors";
import type { TabSession } from "../session/tab-session";
import type { TargetPayload } from "../validate";
import { tabView, type TabView } from "../views";
import { awaitLoadState, type NavigationScope, type WaitUntil } from "./await";
import type { GoDeps } from "./go";
import type { UrlGlob } from "./url-glob";

// The waits share navigation's dependencies: the tracker set tells them what
// the page committed, and the gate counts them against the tab's four.
export interface WaitsDeps extends GoDeps {}
export interface UrlWaitBody {
  // Set in match mode only. Watch mode hands the log to the client instead.
  glob?: UrlGlob;
  waitUntil: WaitUntil;
  after?: number;
  timeoutMs: number;
}
export interface SelectorWaitBody {
  target: TargetPayload;
  state: WaitState;
  // The text the answer and the timeout echo, which a ref names itself.
  selector: string;
  timeoutMs: number;
}
export interface FunctionWaitBody {
  source: ScriptSource;
  intervalMs: number;
  timeoutMs: number;
}
// What one check of a selector wait saw in the page.
interface SelectorCounts {
  matched: number;
  visible: number;
}
export interface PopupView {
  id: string;
  label?: string;
  url: string;
}

// How often a sleeping wait wakes up to look again and re-authorize.
const TICK_MS = 100;
// The page allowance a zero timeout still gets, as the wait route has.
const ALLOWANCE_MS = 250;
// Commits one watch answer carries, the tracker's whole log.
const COMMIT_LIMIT = 32;
// How many characters of a URL a message carries.
const URL_CHARS = 100;

const cut = (url: string) => url.slice(0, URL_CHARS);

// Tabs this tab opened since `since`, as the spec's candidate popups. Only
// tabs of spaces the agent manages are listed at all, so a personal tab is
// never one.
export function candidatePopups(
  controller: AutomationController,
  tabId: string,
  since: number,
): PopupView[] {
  return controller.state.tabs
    .filter((tab) => tab.openerId === tabId && (tab.createdAt ?? 0) >= since)
    .map((tab) => ({
      id: tab.id,
      ...(tab.label === undefined ? {} : { label: tab.label }),
      url: tab.url,
    }));
}

// The action happened in a popup, so the agent must continue there instead of
// repeating it.
const openedInPopup = (page: string, lastUrl: string, popup: PopupView) => {
  const name = popup.label ?? popup.id;
  return new ApiError(
    "url_opened_in_popup",
    `${page} stayed at ${cut(lastUrl)}, but popup ${name} opened from it at ${cut(popup.url)}. The action already happened, so do not repeat it. Continue in ${name}.`,
    { lastUrl, popup },
  );
};
// A URL wait that ran out: match mode names the glob it tested, watch mode
// has none, because the client holds the matcher.
const urlTimeout = (timeoutMs: number, lastUrl: string, expected?: string) =>
  new ApiError(
    "wait_timeout",
    expected === undefined
      ? `The page did not commit another URL within ${timeoutMs} ms. It is at ${cut(lastUrl)}.`
      : `The page did not reach a URL matching ${cut(expected)} within ${timeoutMs} ms. It is at ${cut(lastUrl)}.`,
    {
      awaited: "url",
      timeoutMs,
      ...(expected === undefined ? {} : { expected }),
      lastUrl,
    },
  );

// A selector wait that ran out, with what its last check saw and the frames
// section 9 left out of it.
const selectorTimeout = (
  timeoutMs: number,
  selector: string,
  state: WaitState,
  seen: SelectorCounts,
  unread = 0,
) =>
  new ApiError(
    "wait_timeout",
    `The selector ${cut(selector)} did not reach ${state} within ${timeoutMs} ms. The last check matched ${seen.matched} ${seen.matched === 1 ? "element" : "elements"}, ${seen.visible} of them visible.`,
    {
      awaited: "selector",
      timeoutMs,
      selector,
      state,
      matched: seen.matched,
      visible: seen.visible,
      ...(unread > 0 ? { unreadFrames: unread } : {}),
    },
  );

// A function wait that ran out. The page may have moved on into a popup it
// opened, so the first one is named.
const functionTimeout = (
  timeoutMs: number,
  page: { url: string; title: string },
  popups: PopupView[],
) => {
  const popup = popups[0];
  const elsewhere = popup
    ? ` Popup ${popup.label ?? popup.id} opened from it at ${cut(popup.url)}, so the condition may be there.`
    : "";
  return new ApiError(
    "wait_timeout",
    `The page function did not return a truthy value within ${timeoutMs} ms. It is at ${cut(page.url)}.${elsewhere}`,
    {
      awaited: "function",
      timeoutMs,
      url: page.url,
      title: page.title,
      popups,
    },
  );
};

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

// The waits of section 6. Each one authorizes at entry, on every wake-up and
// before answering, and sleeps outside its space lane.
export function createWaits(deps: WaitsDeps) {
  const { controller, sessions, trackers, gate } = deps;
  const { authorizeTab } = deps.authority;
  // The session of the page a wait reads, or why this tab has none.
  const pageFor = (tabId: string): TabSession => {
    const session = sessions.get(tabId);
    if (session) return session;
    return controller.peekWebContents(tabId)
      ? fail(
          "debugger_busy",
          "Kamapathy lost its connection to this tab. Try again shortly.",
          { reason: "unavailable" },
        )
      : fail(
          "no_web_page",
          "Navigate this tab to an HTTP or HTTPS page first.",
        );
  };
  // The tab an answer carries, authorized once more as the wait answers.
  const viewFor = (tabId: string) => {
    const now = authorizeTab(tabId);
    return tabView(now, controller.shownTab(now.spaceId));
  };
  // What a wait's page checks run under: its own deadline, its guard, and the
  // lane it gives up between checks. A zero timeout still allows the page the
  // time one check needs.
  const scopeFor = (
    tabId: string,
    session: TabSession,
    body: { timeoutMs: number; idleMs?: number },
    deadline: number,
    run: Run,
  ): NavigationScope => ({
    tabId,
    session,
    tracker: trackers.for(session),
    step: {
      deadline:
        body.timeoutMs === 0
          ? Math.min(run.deadline, Date.now() + ALLOWANCE_MS)
          : deadline,
      signal: run.signal,
      guard: () => {
        authorizeTab(tabId);
      },
      dispatch: run.dispatch,
    },
    park: run.park,
    timeoutMs: body.timeoutMs,
    ...(body.idleMs === undefined ? {} : { idleMs: body.idleMs }),
  });

  const url = async (
    tabId: string,
    body: UrlWaitBody,
    run: Run,
  ): Promise<Record<string, unknown>> => {
    const tab = authorizeTab(tabId);
    // This phase's stand-in for section 7's action window: a popup counts
    // when this page opened it while the wait ran.
    const since = Date.now();
    const session = pageFor(tabId);
    const release = gate.enter(tabId);
    const tracker = trackers.for(session);
    const hold: { wake?: () => void } = {};
    const stops: (() => void)[] = [];
    // The URL the page shows: the document the tracker saw commit, or the
    // page's own address before it saw one.
    const current = () => tracker.document?.url ?? session.contents.getURL();
    // The URL at entry, then every main-frame commit in arrival order.
    const seen: string[] = [current()];
    stops.push(
      tracker.subscribe((event) => {
        if (event.type === "committed") seen.push(event.url);
        hold.wake?.();
      }),
    );
    const watched = new Set<string>();
    // The popups this page opened during the wait. Their commits wake it too,
    // so one that reaches the URL ends it without waiting for a tick.
    const popups = (): PopupView[] => {
      const found = candidatePopups(controller, tabId, since);
      for (const popup of found) {
        if (watched.has(popup.id)) continue;
        watched.add(popup.id);
        const page = sessions.get(popup.id);
        if (page) stops.push(trackers.for(page).subscribe(() => hold.wake?.()));
      }
      return found;
    };
    const deadline = Math.min(run.deadline, since + body.timeoutMs);
    const scope = () => scopeFor(tabId, session, body, deadline, run);
    const sleep = () =>
      run.park(() => nap(Math.min(TICK_MS, deadline - Date.now()), hold));
    try {
      const glob = body.glob;
      if (glob) {
        for (;;) {
          authorizeTab(tabId);
          const matched = seen
            .splice(0)
            .find((address) => glob.matches(address));
          if (matched !== undefined) {
            // The state the agent asked for, inside the wait's own deadline.
            await awaitLoadState(scope(), {
              state: body.waitUntil,
              awaited: "load_state",
            });
            // Authorized once more before the answer, so a takeover at the
            // last moment leaves no activity line behind.
            const answered = viewFor(tabId);
            controller.addActivity(
              tab.spaceId,
              "Agent observed a page condition",
              "info",
            );
            return { ok: true, tab: answered, url: matched };
          }
          const popup = popups().find((entry) => glob.matches(entry.url));
          if (popup) throw openedInPopup(tab.label ?? tab.id, current(), popup);
          if (Date.now() >= deadline)
            throw urlTimeout(body.timeoutMs, current(), glob.source);
          await sleep();
        }
      }
      // Watch mode, so a RegExp or a predicate runs in the agent's own Node
      // and never in Kamapathy.
      const after = body.after;
      if (after === undefined)
        return {
          ok: true,
          tab: viewFor(tabId),
          url: current(),
          navigation: tracker.navigation,
          committed: [],
          popups: popups(),
        };
      for (;;) {
        authorizeTab(tabId);
        const found = popups();
        // Every candidate opened during this wait, so one that exists is the
        // popup commit the client has to test.
        if (tracker.navigation > after || found.length > 0) {
          const later = tracker.since(after);
          const committed = (
            later ?? tracker.commits.filter((item) => item.navigation > after)
          ).slice(-COMMIT_LIMIT);
          return {
            ok: true,
            tab: viewFor(tabId),
            url: current(),
            navigation: tracker.navigation,
            committed,
            ...(later === undefined ? { missed: true as const } : {}),
            popups: found,
          };
        }
        if (Date.now() >= deadline) throw urlTimeout(body.timeoutMs, current());
        await sleep();
      }
    } finally {
      hold.wake = undefined;
      for (const stop of stops) stop();
      release();
    }
  };

  // The state of the document the page shows, under navigate's definitions.
  const loadState = async (
    tabId: string,
    body: { state: WaitUntil; idleMs: number; timeoutMs: number },
    run: Run,
  ): Promise<{ ok: true; tab: TabView; state: WaitUntil }> => {
    const tab = authorizeTab(tabId);
    const session = pageFor(tabId);
    const release = gate.enter(tabId);
    const deadline = Math.min(run.deadline, Date.now() + body.timeoutMs);
    const scope = scopeFor(tabId, session, body, deadline, run);
    try {
      // A document the tracker never saw commit, as in a tab the person just
      // granted: one fixed read gives the wait its state and its address. A
      // page that cannot answer leaves both unknown, and the wait goes on,
      // authorizing again before it judges anything.
      if (!scope.tracker.document)
        await trackers
          .probe(session, { ...scope.step, namespace: "internal" })
          .catch(() => {});
      await awaitLoadState(scope, { state: body.state, awaited: "load_state" });
      const answered = viewFor(tabId);
      controller.addActivity(
        tab.spaceId,
        "Agent observed a page condition",
        "info",
      );
      return { ok: true, tab: answered, state: body.state };
    } finally {
      release();
    }
  };
  // An element in the state the agent asked for, looked for the way an
  // action resolves its target.
  const selector = async (
    tabId: string,
    body: SelectorWaitBody,
    run: Run,
  ): Promise<{
    ok: true;
    tab: TabView;
    state: WaitState;
    matched: number;
  }> => {
    let tab = authorizeTab(tabId);
    const release = gate.enter(tabId);
    const hold: { wake?: () => void } = {};
    const deadline = Math.min(run.deadline, Date.now() + body.timeoutMs);
    // A zero timeout still allows the page the time one check needs.
    const pageDeadline = () =>
      body.timeoutMs === 0
        ? Math.min(run.deadline, Date.now() + ALLOWANCE_MS)
        : deadline;
    // What the last check saw, which the answer and the timeout report.
    let seen: SelectorCounts = { matched: 0, visible: 0 };
    // The frames the last check was left without, which its timeout names.
    let unread = 0;
    // The target as the page reads it. A ref carries the state beside it; a
    // selector carries it in the query, with the mode and level that state
    // asks for, so a hidden duplicate never blocks a visible wait.
    const payload = (): Record<string, unknown> =>
      "ref" in body.target
        ? { ref: body.target.ref, state: body.state }
        : {
            selector: body.target.selector,
            query: {
              ast: body.target.query.ast,
              state: body.state,
              ...waitMode(body.target.query.ast, body.state),
            },
          };
    try {
      for (;;) {
        tab = authorizeTab(tabId);
        const session = pageFor(tabId);
        const limit = pageDeadline();
        const observation = await deps.actions
          .evaluatePage(tabId, session, "check", payload(), limit, {
            deadline: limit,
            signal: run.signal,
            guard: () => {
              authorizeTab(tabId);
            },
            dispatch: run.dispatch,
          })
          .catch((error: unknown) => {
            // The page was still busy at the deadline, which is this wait
            // running out rather than a page failure.
            const timedOut =
              error instanceof CdpTimeoutError ||
              (error instanceof ApiError &&
                ["page_timeout", "action_timeout"].includes(error.code));
            if (!timedOut || Date.now() < deadline) throw error;
            throw selectorTimeout(
              body.timeoutMs,
              body.selector,
              body.state,
              seen,
              unread,
            );
          });
        const counts = observation.counts as SelectorCounts | undefined;
        if (counts) seen = counts;
        unread =
          typeof observation.unreadFrames === "number"
            ? observation.unreadFrames
            : 0;
        if (observation.matched) {
          // Authorized once more before the answer, so a takeover at the
          // last moment leaves no activity line behind.
          const answered = viewFor(tabId);
          controller.addActivity(
            tab.spaceId,
            "Agent observed a page condition",
            "info",
          );
          return {
            ok: true,
            tab: answered,
            state: body.state,
            matched: seen.matched,
          };
        }
        if (Date.now() >= deadline)
          throw selectorTimeout(
            body.timeoutMs,
            body.selector,
            body.state,
            seen,
            unread,
          );
        await run.park(() =>
          nap(Math.min(TICK_MS, deadline - Date.now()), hold),
        );
      }
    } finally {
      hold.wake = undefined;
      release();
    }
  };
  // A condition the agent wrote itself, run in the page every interval
  // while the Page scripts setting allows it.
  const fn = async (
    tabId: string,
    body: FunctionWaitBody,
    run: Run,
  ): Promise<Record<string, unknown>> => {
    let tab = authorizeTab(tabId);
    requireScripts(controller);
    // This phase's stand-in for section 7's action window, as the URL wait
    // has it: a popup counts when this page opened it while the wait ran.
    const since = Date.now();
    const session = pageFor(tabId);
    const release = gate.enter(tabId);
    const tracker = trackers.for(session);
    const hold: { wake?: () => void } = {};
    const deadline = Math.min(run.deadline, since + body.timeoutMs);
    // A zero timeout still allows the page the time one check needs.
    const pageDeadline = () =>
      body.timeoutMs === 0
        ? Math.min(run.deadline, Date.now() + ALLOWANCE_MS)
        : deadline;
    const timedOut = () =>
      functionTimeout(
        body.timeoutMs,
        {
          url: tracker.document?.url ?? session.contents.getURL(),
          title: tab.title,
        },
        candidatePopups(controller, tabId, since),
      );
    try {
      for (;;) {
        tab = authorizeTab(tabId);
        requireScripts(controller);
        const limit = pageDeadline();
        // A check reads the page without stopping its own scripts, so it
        // sends no execution limit and keeps its exceptions out of the
        // page's console.
        const result = await evaluateOnce(session, body.source, {
          deadline: limit,
          signal: run.signal,
          guard: () => {
            authorizeTab(tabId);
          },
          dispatch: run.dispatch,
          timeoutMs: Math.max(1, limit - Date.now()),
          silent: true,
        }).catch((error: unknown) => {
          // A navigation ended the context, or the page was still busy at
          // the deadline: the next check runs in the document it shows now.
          if (error instanceof ContextLostError) return undefined;
          if (error instanceof CdpTimeoutError) return undefined;
          throw error;
        });
        if (result && isTruthy(result)) {
          // Authorized once more before the answer, so a takeover at the
          // last moment leaves no activity line behind.
          const answered = viewFor(tabId);
          controller.addActivity(
            tab.spaceId,
            "Agent observed a page condition",
            "info",
          );
          return { ok: true, tab: answered, ...result };
        }
        if (Date.now() >= deadline) throw timedOut();
        // Sleeping in ticks keeps a takeover within TICK_MS, however long
        // the interval between checks is.
        const nextAt = Date.now() + body.intervalMs;
        while (Date.now() < nextAt) {
          authorizeTab(tabId);
          if (Date.now() >= deadline) throw timedOut();
          await run.park(() =>
            nap(Math.min(TICK_MS, nextAt - Date.now()), hold),
          );
        }
      }
    } finally {
      hold.wake = undefined;
      release();
    }
  };
  return { url, loadState, selector, fn };
}
