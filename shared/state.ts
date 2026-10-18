import type { AgentTask, BrowserState, Space, Tab } from "./types";
import { version } from "../package.json";

export const HOME_URL = "kamapathy://newtab";
// The most pages an agent manages in one space unless it asks for fewer.
export const PAGE_BUDGET = 20;
// Agent spaces follow agent rules, and so does a personal space while the
// person lets an agent use it: no history, background popups and pages that
// keep painting.
export function agentRules(space: Pick<Space, "kind" | "access">): boolean {
  return space.kind === "agent" || space.access === "granted";
}
export const id = () => globalThis.crypto.randomUUID();
// The one way a space's task changes, shared so the controller and the test
// controller behave alike. Fields a patch leaves undefined are deleted, a
// null patch deletes the task, and changedAt moves only when the state does,
// so a status or label change keeps the key the renderer marks as seen. A
// patch cannot set changedAt itself. True when anything changed.
export function patchTask(
  space: Space,
  patch: Partial<AgentTask> | null,
): boolean {
  if (!patch) {
    if (!space.task) return false;
    delete space.task;
    return true;
  }
  const now = Date.now();
  const task: AgentTask = space.task ? { ...space.task } : { changedAt: now };
  let changed = !space.task;
  const fields = task as unknown as Record<string, unknown>;
  const next = patch as Record<string, unknown>;
  for (const key of ["status", "state", "reason", "label"]) {
    if (!(key in patch)) continue;
    if (next[key] === undefined) {
      if (!(key in fields)) continue;
      delete fields[key];
    } else {
      if (fields[key] === next[key]) continue;
      fields[key] = next[key];
    }
    changed = true;
  }
  if (task.state !== space.task?.state) task.changedAt = now;
  if (!changed) return false;
  space.task = task;
  return true;
}
export function newTab(spaceId: string, url = HOME_URL): Tab {
  return {
    id: id(),
    spaceId,
    url,
    title: url === HOME_URL ? "New tab" : url,
    pinned: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}
// The tab a space opens on: the one it last showed, else an agent's latest
// page (agents open pages beside a blank first tab), else its first tab.
export function openingTab(
  state: BrowserState,
  spaceId: string,
  lastShown?: string,
): Tab | undefined {
  const tabs = state.tabs.filter((tab) => tab.spaceId === spaceId);
  const agent =
    state.spaces.find((space) => space.id === spaceId)?.kind === "agent";
  return (
    tabs.find((tab) => tab.id === lastShown) ??
    (agent ? tabs.filter((tab) => tab.url !== HOME_URL).at(-1) : undefined) ??
    tabs[0]
  );
}
export function initialState(
  platform: BrowserState["platform"] = "web",
): BrowserState {
  const now = Date.now();
  const tab = newTab("personal");
  return {
    spaces: [
      {
        id: "personal",
        name: "Personal",
        color: "green",
        kind: "personal",
        owner: "human",
        signIns: "shared",
        createdAt: now,
      },
      {
        id: "work",
        name: "Work",
        color: "blue",
        kind: "personal",
        owner: "human",
        signIns: "shared",
        createdAt: now,
      },
    ],
    tabs: [tab, newTab("work")],
    activeSpaceId: "personal",
    activeTabId: tab.id,
    splitTabId: null,
    bookmarks: [
      {
        id: "github",
        title: "GitHub",
        url: "https://github.com",
        createdAt: now,
      },
      {
        id: "figma",
        title: "Figma",
        url: "https://www.figma.com",
        createdAt: now,
      },
      {
        id: "linear",
        title: "Linear",
        url: "https://linear.app",
        createdAt: now,
      },
      {
        id: "notion",
        title: "Notion",
        url: "https://www.notion.so",
        createdAt: now,
      },
      {
        id: "youtube",
        title: "YouTube",
        url: "https://www.youtube.com",
        createdAt: now,
      },
    ],
    history: [],
    downloads: [],
    activity: [],
    spaceRequests: [],
    settings: {
      theme: "system",
      searchEngine: "duckduckgo",
      restoreSession: true,
      showBookmarksBar: false,
      // Local agents may connect unless the person turns this off.
      automationEnabled: true,
      isolateAgentSpaces: false,
      welcomed: false,
      backgroundNoticeShown: false,
    },
    platform,
    version,
    automation: { running: false },
  };
}
