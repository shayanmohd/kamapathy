import { remaining } from "../actions";
import { send, type Run, type RouteDeps, type RouteImpl } from "../http";
import { createPendingGate, type WaitUntil } from "../navigation/await";
import { createGo } from "../navigation/go";
import { createTrackers } from "../navigation/trackers";
import { createWaits, type UrlWaitBody } from "../navigation/waits";
import type { AutomationController } from "../server";
import {
  loadStateFields,
  navigationFields,
  reloadFields,
  waitForUrlFields,
  type ToolAction,
} from "../validate";
import { tabView } from "../views";

// The navigation and wait routes, and the batch steps that share their work.
export interface Navigation {
  readonly routes: Record<string, RouteImpl>;
  readonly stepTypes: readonly string[];
  step(
    tabId: string,
    action: ToolAction,
    run: Run,
  ): Promise<Record<string, unknown>>;
}
// What pageState("info") reads in the page. The route adds the frame's load
// state, which a document cannot see about itself.
interface PageStateInfo {
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  document: { width: number; height: number };
  readyState: "loading" | "interactive" | "complete";
}
// A page state read is capped well below the route's budget, so a page that
// slow is reported as page_timeout instead of holding its space's lane.
const INFO_MS = 2000;
// The leave guard an agent overrode while its operation ran. Section 7's
// other receipt fields arrive later; navigate and reload report this one.
export interface LeaveReceipt {
  type: "beforeunload";
  message: "";
  answer: "accepted";
}

// Collects the guards overridden on one tab for as long as an operation
// runs. stop() unsubscribes and answers with the operation's receipt.
export function watchLeaveGuard(
  controller: AutomationController,
  tabId: string,
): { stop(): { dialog?: LeaveReceipt } } {
  let overridden = false;
  const unsubscribe = controller.onLeaveGuard((id) => {
    if (id === tabId) overridden = true;
  });
  return {
    stop() {
      unsubscribe();
      if (!overridden) return {};
      return {
        dialog: { type: "beforeunload", message: "", answer: "accepted" },
      };
    },
  };
}

export function createNavigation(
  deps: Omit<RouteDeps, "navigation">,
): Navigation {
  const { controller, sessions } = deps;
  const { authorizeTab } = deps.authority;
  const { readyContents, evaluatePage } = deps.actions;
  // One tracker per live tab session, and one gate for every tab's pending
  // navigations and waits.
  const trackers = createTrackers({ controller, sessions });
  const gate = createPendingGate();
  const go = createGo({ ...deps, trackers, gate });
  const waits = createWaits({ ...deps, trackers, gate });
  // The body a navigate route or step takes, already validated.
  type NavigateBody = {
    url: string;
    waitUntil: WaitUntil;
    timeoutMs: number;
    referer?: string;
  };
  type ReloadBody = {
    waitUntil: WaitUntil;
    timeoutMs: number;
    ignoreCache: boolean;
  };
  type LoadStateBody = {
    state: WaitUntil;
    idleMs: number;
    timeoutMs: number;
  };
  // What a batch step waits: its own timeout, cut to the budget the batch
  // has left, which its timeout error then reports.
  const cutTo = (timeoutMs: number, run: Run) =>
    Math.min(timeoutMs, Math.max(0, run.deadline - Date.now()));
  return {
    routes: {
      "POST /tabs/:id/navigate": {
        handler: async ({ response, body, tab, run }) =>
          send(
            response,
            200,
            await go.navigate(tab!.id, navigationFields(body!), run),
          ),
      },
      "POST /tabs/:id/reload": {
        handler: async ({ response, body, tab, run }) =>
          send(
            response,
            200,
            await go.reload(tab!.id, reloadFields(body!), run),
          ),
      },
      "POST /tabs/:id/wait-for-url": {
        handler: async ({ response, body, tab, run }) =>
          send(
            response,
            200,
            await waits.url(tab!.id, waitForUrlFields(body!), run),
          ),
      },
      "POST /tabs/:id/wait-for-load-state": {
        handler: async ({ response, body, tab, run }) =>
          send(
            response,
            200,
            await waits.loadState(tab!.id, loadStateFields(body!), run),
          ),
      },
      "GET /tabs/:id/info": {
        handler: async ({ response, tab, run }) => {
          const view = () => {
            const current = authorizeTab(tab!.id);
            return tabView(current, controller.shownTab(current.spaceId));
          };
          // A dialog holds the page, so the state comes from the session.
          const dialog = sessions.get(tab!.id)?.dialog();
          if (dialog)
            return send(response, 200, {
              tab: view(),
              dialog: { type: dialog.type, message: dialog.message },
            });
          const { contents, session } = await readyContents(
            tab!.id,
            remaining(run.deadline),
            true,
          );
          const state = (await evaluatePage(
            tab!.id,
            session,
            "info",
            {},
            Math.min(run.deadline, Date.now() + INFO_MS),
          )) as unknown as PageStateInfo;
          controller.addActivity(
            tab!.spaceId,
            "Agent read the page state",
            "info",
          );
          return send(response, 200, {
            tab: view(),
            viewport: state.viewport,
            scroll: state.scroll,
            document: state.document,
            readyState: state.readyState,
            loading: contents.isLoadingMainFrame(),
          });
        },
      },
    },
    stepTypes: ["navigate", "reload", "wait-for-url", "wait-for-load-state"],
    step: async (tabId, action, run) => {
      if (action.type === "navigate") {
        const body = action.payload as NavigateBody;
        return go.navigate(
          tabId,
          { ...body, timeoutMs: cutTo(body.timeoutMs, run) },
          run,
        );
      }
      if (action.type === "reload") {
        const body = action.payload as ReloadBody;
        return go.reload(
          tabId,
          { ...body, timeoutMs: cutTo(body.timeoutMs, run) },
          run,
        );
      }
      if (action.type === "wait-for-url") {
        const body = action.payload as unknown as UrlWaitBody;
        return waits.url(
          tabId,
          { ...body, timeoutMs: cutTo(body.timeoutMs, run) },
          run,
        );
      }
      if (action.type === "wait-for-load-state") {
        const body = action.payload as LoadStateBody;
        return waits.loadState(
          tabId,
          { ...body, timeoutMs: cutTo(body.timeoutMs, run) },
          run,
        );
      }
      throw new Error("This batch step has no navigation handler.");
    },
  };
}
