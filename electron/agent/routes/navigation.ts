import { remaining } from "../actions";
import { send, type Run, type RouteDeps, type RouteImpl } from "../http";
import { createPendingGate, type WaitUntil } from "../navigation/await";
import { createGo } from "../navigation/go";
import { createTrackers } from "../navigation/trackers";
import type { AutomationController } from "../server";
import { navigationFields, type ToolAction } from "../validate";
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
  // The body a navigate route or step takes, already validated.
  type NavigateBody = {
    url: string;
    waitUntil: WaitUntil;
    timeoutMs: number;
    referer?: string;
  };
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
    stepTypes: ["navigate"],
    step: async (tabId, action, run) => {
      if (action.type !== "navigate")
        throw new Error("This batch step has no navigation handler.");
      const body = action.payload as NavigateBody;
      // A step waits only as long as the batch's budget has left, and its
      // timeout error reports the value it was cut to.
      return go.navigate(
        tabId,
        {
          ...body,
          timeoutMs: Math.min(
            body.timeoutMs,
            Math.max(0, run.deadline - Date.now()),
          ),
        },
        run,
      );
    },
  };
}
