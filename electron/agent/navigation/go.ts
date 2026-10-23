import type { Actions } from "../actions";
import type { Authority } from "../authority";
import { fail } from "../errors";
import type { Run } from "../http";
import { watchLeaveGuard, type LeaveReceipt } from "../routes/navigation";
import type { AutomationController } from "../server";
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

// Navigation as an operation: the route and the batch step share it.
export function createGo(deps: GoDeps) {
  const { controller, sessions, trackers, gate } = deps;
  const { authorizeTab } = deps.authority;
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
      const scope: NavigationScope = {
        tabId,
        session,
        tracker: trackers.for(session),
        step: {
          deadline: Math.min(run.deadline, Date.now() + body.timeoutMs),
          signal: run.signal,
          guard: () => {
            authorizeTab(tabId);
          },
          dispatch: run.dispatch,
        },
        park: run.park,
        timeoutMs: body.timeoutMs,
      };
      const outcome = await awaitNavigation(scope, {
        waitUntil: body.waitUntil,
        from: session === before ? from : 0,
        expect: "navigate",
        url: body.url,
      }).catch((error: unknown) => {
        // The one failure that reached no server is safe to send again.
        if (retryableNavigation(error)) run.dispatch.dispatched = false;
        throw error;
      });
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
  return { navigate };
}
