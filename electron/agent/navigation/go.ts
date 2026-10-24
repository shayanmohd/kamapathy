import type { Actions } from "../actions";
import type { Authority } from "../authority";
import { ApiError, fail } from "../errors";
import type { Run } from "../http";
import { watchLeaveGuard, type LeaveReceipt } from "../routes/navigation";
import type { AutomationController } from "../server";
import type { TabSession } from "../session/tab-session";
import type { TabSessions } from "../session/tab-sessions";
import { tabView, type TabView } from "../views";
import {
  awaitNavigation,
  retryableNavigation,
  type NavigationScope,
  type PendingGate,
  type WaitUntil,
} from "./await";
import type { Trackers } from "./trackers";

export interface GoDeps {
  controller: AutomationController;
  authority: Authority;
  actions: Actions;
  sessions: TabSessions;
  trackers: Trackers;
  gate: PendingGate;
}
export interface GoResult extends Record<string, unknown> {
  ok: true;
  tab: TabView;
  httpStatus?: number;
  waitUntil: WaitUntil;
  dialog?: LeaveReceipt;
}

// What Recent activity says about the address an agent asked for.
const activityFor = (url: string) =>
  url === "about:blank"
    ? "Agent opened a blank page"
    : `Agent navigated to ${new URL(url).hostname}`;
// The host a reload refetched, or the address itself when it has no host, as
// about:blank has none.
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname || url.slice(0, 100);
  } catch {
    return url.slice(0, 100);
  }
};
// A reload would send the document's form again, so it is refused before
// anything reaches the page.
const wouldResubmit = (url: string) =>
  new ApiError(
    "reload_would_resubmit",
    "Reloading this page would send its form again. Navigate to the address instead, or ask the person to confirm.",
    { url },
  );

// Navigation as an operation: the route and the batch step share it.
export function createGo(deps: GoDeps) {
  const { controller, sessions, trackers, gate } = deps;
  const { authorizeTab } = deps.authority;
  // What an operation's wait runs under: its own deadline, its guard, and
  // the lane it gives up between checks.
  const scopeFor = (
    tabId: string,
    session: TabSession,
    timeoutMs: number,
    run: Run,
  ): NavigationScope => ({
    tabId,
    session,
    tracker: trackers.for(session),
    step: {
      deadline: Math.min(run.deadline, Date.now() + timeoutMs),
      signal: run.signal,
      guard: () => {
        authorizeTab(tabId);
      },
      dispatch: run.dispatch,
      throughCrash: true,
    },
    park: run.park,
    timeoutMs,
  });
  // The one navigation failure an agent may send again clears the dispatch
  // record, so the envelope marks it retryable.
  const sendable = (run: Run) => (error: unknown) => {
    if (retryableNavigation(error)) run.dispatch.dispatched = false;
    throw error;
  };
  const navigate = async (
    tabId: string,
    body: {
      url: string;
      waitUntil: WaitUntil;
      timeoutMs: number;
      referer?: string;
    },
    run: Run,
  ): Promise<GoResult> => {
    const tab = authorizeTab(tabId);
    const release = gate.enter(tabId);
    const watch = watchLeaveGuard(controller, tabId);
    try {
      // The tracker must be listening before the load starts, and its count
      // read before it, so only this dispatch's navigation is followed.
      const before = sessions.get(tabId);
      const from = before ? trackers.for(before).navigation : 0;
      run.dispatch.dispatched = true;
      controller.navigateAgentTab(
        tabId,
        body.url,
        body.referer === undefined ? {} : { referer: body.referer },
      );
      controller.addActivity(tab.spaceId, activityFor(body.url), "info");
      // navigateAgentTab creates a missing view, so the session exists here.
      const session = sessions.get(tabId);
      if (!session)
        return fail(
          "debugger_busy",
          "Kamapathy lost its connection to this tab. Try again shortly.",
          { reason: "unavailable" },
        );
      const scope = scopeFor(tabId, session, body.timeoutMs, run);
      const outcome = await awaitNavigation(scope, {
        waitUntil: body.waitUntil,
        from: session === before ? from : 0,
        expect: "navigate",
        url: body.url,
      }).catch(sendable(run));
      const current = authorizeTab(tabId);
      return {
        ok: true,
        tab: tabView(current, controller.shownTab(current.spaceId)),
        ...(outcome.httpStatus === undefined
          ? {}
          : { httpStatus: outcome.httpStatus }),
        waitUntil: outcome.waitUntil,
        ...watch.stop(),
      };
    } finally {
      watch.stop();
      release();
    }
  };
  // The tab:reload path under navigate's waits, receipts and errors.
  const reload = async (
    tabId: string,
    body: { waitUntil: WaitUntil; timeoutMs: number; ignoreCache: boolean },
    run: Run,
  ): Promise<GoResult> => {
    const tab = authorizeTab(tabId);
    const contents = controller.getWebContents(tabId);
    if (!contents || contents.isDestroyed())
      return fail(
        "no_web_page",
        "Navigate this tab to an HTTP or HTTPS page first.",
      );
    // The document's own request says whether reloading would post again.
    // A document the tracker never saw has no method, and reloading a GET
    // beats refusing a reload Kamapathy cannot explain.
    const before = sessions.get(tabId);
    const tracker = before ? trackers.for(before) : undefined;
    const document = tracker?.document;
    if (document?.method === "POST") throw wouldResubmit(document.url);
    const release = gate.enter(tabId);
    const watch = watchLeaveGuard(controller, tabId);
    try {
      const from = tracker?.navigation ?? 0;
      run.dispatch.dispatched = true;
      controller.reloadAgentTab(tabId, { ignoreCache: body.ignoreCache });
      controller.addActivity(
        tab.spaceId,
        `Agent reloaded ${hostOf(tab.url)}`,
        "info",
      );
      const session = sessions.get(tabId);
      if (!session)
        return fail(
          "debugger_busy",
          "Kamapathy lost its connection to this tab. Try again shortly.",
          { reason: "unavailable" },
        );
      const scope = scopeFor(tabId, session, body.timeoutMs, run);
      // Any navigation the reload starts is its own, the retried URL of a
      // failed load included.
      const outcome = await awaitNavigation(scope, {
        waitUntil: body.waitUntil,
        from: session === before ? from : 0,
        expect: "reload",
      }).catch(sendable(run));
      const current = authorizeTab(tabId);
      return {
        ok: true,
        tab: tabView(current, controller.shownTab(current.spaceId)),
        ...(outcome.httpStatus === undefined
          ? {}
          : { httpStatus: outcome.httpStatus }),
        waitUntil: outcome.waitUntil,
        ...watch.stop(),
      };
    } finally {
      watch.stop();
      release();
    }
  };
  return { navigate, reload };
}
