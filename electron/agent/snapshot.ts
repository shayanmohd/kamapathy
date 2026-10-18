import { cleanAgentText } from "../../shared/agent-text";
import { PAGE_BUDGET } from "../../shared/state";
import type { OpenedBy } from "../../shared/types";
import type { Actions } from "./actions";
import { fail } from "./errors";
import type { SearchAst } from "./selectors";
import type { AutomationController } from "./server";
import type { TabSession } from "./session/tab-session";
import type { Step } from "./session/types";

// The one snapshot path, shared by the routes and the batch step: the page
// call with its scope and bounds, and the header naming the page, its space
// and the space's tabs.

export interface HeaderTab {
  id: string;
  label?: string;
  title: string;
  openedBy?: OpenedBy;
  managed: boolean;
  current?: true;
}
export interface SnapshotHeader {
  page: { id: string; label?: string; title: string };
  space: { id: string; name: string };
  tabs: HeaderTab[];
  budget?: { used: number; limit: number };
  pdf?: true;
}

/** A title in the header: cleaned like other agent text and cut at 60. */
export function headerTitle(title: string): string {
  const shown = cleanAgentText(title);
  return shown.length > 60 ? `${shown.slice(0, 57)}...` : shown;
}

// What the tabs route reports about this page and its space, and nothing
// else: no URLs, and the budget only once the space is near its limit.
export function snapshotHeader(
  controller: AutomationController,
  tabId: string,
): SnapshotHeader {
  const { tabs, spaces } = controller.state;
  const page = tabs.find((tab) => tab.id === tabId);
  const space = spaces.find((item) => item.id === page?.spaceId);
  if (!page || !space)
    return fail("tab_not_found", "Agent tab was not found.", { tabId });
  const limit = space.pageBudget ?? PAGE_BUDGET;
  const used = controller.registry.used(space.id);
  return {
    page: {
      id: page.id,
      ...(page.label === undefined ? {} : { label: page.label }),
      title: headerTitle(page.title),
    },
    space: { id: space.id, name: space.name },
    tabs: tabs
      .filter((tab) => tab.spaceId === space.id)
      .map((tab) => ({
        id: tab.id,
        ...(tab.label === undefined ? {} : { label: tab.label }),
        title: headerTitle(tab.title),
        ...(tab.openedBy === undefined ? {} : { openedBy: tab.openedBy }),
        managed: tab.managed === true,
        ...(tab.id === tabId ? { current: true as const } : {}),
      })),
    ...(used >= limit - 1 ? { budget: { used, limit } } : {}),
    ...(controller.pdfDocument?.(tabId) === true ? { pdf: true as const } : {}),
  };
}

export interface SnapshotRequest {
  mode: "compact" | "full";
  maxChars: number;
  maxControls: number;
  scope: "page" | "viewport";
  header: boolean;
  root?: string;
  selector?: string;
  query?: { ast: SearchAst };
}

export function createSnapshots(deps: {
  controller: AutomationController;
  evaluatePage: Actions["evaluatePage"];
}): {
  take(
    tabId: string,
    session: TabSession,
    request: SnapshotRequest,
    deadline: number,
    step: Step,
  ): Promise<Record<string, unknown>>;
} {
  const { controller, evaluatePage } = deps;
  return {
    async take(tabId, session, request, deadline, step) {
      // The resolver checks a root, reserves the ref block and adds it to
      // this copy of the payload, so the request keeps none of it.
      const result = await evaluatePage(
        tabId,
        session,
        "snapshot",
        {
          mode: request.mode,
          maxChars: request.maxChars,
          maxControls: request.maxControls,
          ...(request.selector === undefined
            ? {}
            : { selector: request.selector }),
          ...(request.query === undefined ? {} : { query: request.query }),
          ...(request.root === undefined ? {} : { root: request.root }),
          scope: request.scope,
        },
        deadline,
        step,
      );
      // The header is read after the page call, which checks the tab again.
      return {
        tabId,
        ...result,
        ...(request.header
          ? { header: snapshotHeader(controller, tabId) }
          : {}),
      };
    },
  };
}
