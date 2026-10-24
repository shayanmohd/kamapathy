import type {
  BrowserState,
  Space,
  Tab,
  UpdateReminder,
  UpdateState,
} from "./types";
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
    passwordPrompts: [],
    prompts: [],
    sitePermissions: [],
    settings: {
      theme: "system",
      searchEngine: "duckduckgo",
      restoreSession: true,
      showBookmarksBar: false,
      offerToSavePasswords: true,
      // Local agents may connect unless the person turns this off.
      automationEnabled: true,
      isolateAgentSpaces: false,
      // Agents may run page scripts unless the person turns this off.
      agentPageScripts: true,
      welcomed: false,
      updateChecks: true,
      seenVersion: version,
      extensionUpdates: true,
      extensionDeveloperMode: false,
    },
    platform,
    version,
    automation: { running: false },
    // The updater works out the real kind and state when it starts.
    update: { kind: "other", state: "unsupported" },
  };
}
// The Update Kamapathy menu item, the menu dot and /health remind about a
// downloaded update always, and about a newer one only while checks are on.
export function updateReminder(
  update: UpdateState,
  checks: boolean,
): UpdateReminder | null {
  const { state, latest } = update;
  if (!latest) return null;
  if (
    state === "ready" ||
    (checks && (state === "available" || state === "downloading"))
  )
    return { version: latest.version, state };
  return null;
}
// `sudo apt install` for a path with spaces or quotes in it: every quote
// closes the quoting, escapes itself and opens it again.
export function aptInstallCommand(path: string): string {
  return `sudo apt install '${path.replace(/'/g, "'\\''")}'`;
}
