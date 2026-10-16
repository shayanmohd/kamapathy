import { PAGE_BUDGET } from "../../shared/state";
import type {
  ControlReason,
  OpenedBy,
  SignIns,
  Space,
  SpaceColor,
  Tab,
} from "../../shared/types";
import type { Boundary } from "./tab-registry";

export interface TabView {
  id: string;
  spaceId: string;
  title: string;
  url: string;
  favicon?: string;
  pinned: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  label?: string;
  openedBy?: OpenedBy;
  openerId?: string;
  managed: boolean;
  active: boolean;
  unseen?: true;
}
export interface SpaceView {
  id: string;
  name: string;
  color: SpaceColor;
  kind: "personal" | "agent";
  owner: "human" | "agent";
  signIns: SignIns;
  createdAt: number;
  createdBy: "agent" | "person";
  pageBudget: number;
  reason?: ControlReason;
  prompt?: string;
  since?: number;
  recentTabTitles?: string[];
}

// Agents never see a tab showing a file on this computer, whatever host its
// URL names.
export function agentVisible(tab: Pick<Tab, "url">): boolean {
  return !/^file:/i.test(tab.url);
}

// The tab fields agents see. `shown` is the tab its space shows, so the
// result says whether this tab is the active one.
export function tabView(tab: Tab, shown: Tab | undefined): TabView {
  return {
    id: tab.id,
    spaceId: tab.spaceId,
    title: tab.title,
    url: tab.url,
    ...(tab.favicon === undefined ? {} : { favicon: tab.favicon }),
    pinned: tab.pinned,
    loading: tab.loading,
    canGoBack: tab.canGoBack,
    canGoForward: tab.canGoForward,
    ...(tab.error === undefined ? {} : { error: tab.error }),
    ...(tab.label === undefined ? {} : { label: tab.label }),
    ...(tab.openedBy === undefined ? {} : { openedBy: tab.openedBy }),
    ...(tab.openerId === undefined ? {} : { openerId: tab.openerId }),
    managed: tab.managed === true,
    active: tab.id === shown?.id,
    ...(tab.unseen ? { unseen: true as const } : {}),
  };
}

export interface BoundaryView {
  active: TabView | null;
  opened: TabView[];
  closed: string[];
}

// What resume and wait-for-control return about the person's time in
// control. A file shown there leaves no active tab.
export function boundaryView(
  boundary: Boundary,
  shown: Tab | undefined,
): BoundaryView {
  return {
    active:
      boundary.active && agentVisible(boundary.active)
        ? tabView(boundary.active, shown)
        : null,
    opened: boundary.opened
      .filter(agentVisible)
      .map((tab) => tabView(tab, shown)),
    closed: boundary.closed,
  };
}

// While the person has control, a space says why. Otherwise it names its
// newest managed pages, so an agent can tell its spaces apart.
export function spaceView(space: Space, tabs: readonly Tab[]): SpaceView {
  const view: SpaceView = {
    id: space.id,
    name: space.name,
    color: space.color,
    kind: space.kind,
    owner: space.owner,
    signIns: space.signIns,
    createdAt: space.createdAt,
    createdBy: space.createdBy ?? "person",
    pageBudget: space.pageBudget ?? PAGE_BUDGET,
  };
  if (space.owner === "human") {
    const control = space.control;
    view.reason = control?.reason ?? "manual";
    if (control?.prompt !== undefined) view.prompt = control.prompt;
    if (control !== undefined) view.since = control.since;
    return view;
  }
  // Tabs are kept in creation order, so reversing first puts the later of
  // two tabs made in the same millisecond first.
  view.recentTabTitles = tabs
    .filter((tab) => tab.spaceId === space.id && tab.managed)
    .reverse()
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, 3)
    .map((tab) => tab.title.slice(0, 80));
  return view;
}

// The pages that count toward a space's budget, as page_budget lists them.
export function pagesOf(
  tabs: readonly Tab[],
  spaceId: string,
  shown: Tab | undefined,
): { id: string; label?: string; title: string; url: string; active: boolean }[] {
  return tabs
    .filter((tab) => tab.spaceId === spaceId && tab.managed)
    .map((tab) => ({
      id: tab.id,
      ...(tab.label === undefined ? {} : { label: tab.label }),
      title: tab.title,
      url: tab.url,
      active: tab.id === shown?.id,
    }));
}
