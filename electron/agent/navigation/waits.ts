import { ApiError, fail } from "../errors";
import type { Run } from "../http";
import type { AutomationController } from "../server";
import type { TabSession } from "../session/tab-session";
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
  return { url, loadState };
}
