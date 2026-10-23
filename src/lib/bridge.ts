import type {
  BrowserAction,
  BrowserState,
  KamapathyBridge,
} from "../../shared/types";
import { HOME_URL, id, initialState, newTab } from "../../shared/state";
import { restoreState } from "../../shared/restore";
import { hostname, normalizeUrl } from "../../shared/url";
import { extensionsCopy } from "../copy";

const STORAGE_KEY = "kamapathy-preview-v1";
export function createPreviewBridge(): KamapathyBridge {
  let state = initialState();
  try {
    state = restoreState(
      JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"),
      "web",
      state.version,
    );
  } catch {
    state = initialState();
  }
  // The web preview has no agent service.
  state.settings.automationEnabled = false;
  const listeners = new Set<(value: BrowserState) => void>();
  const closed: BrowserState["tabs"] = [];
  const navigation = new Map<string, { urls: string[]; position: number }>();
  function activate(tab: BrowserState["tabs"][number]) {
    if (
      state.activeSpaceId !== tab.spaceId ||
      tab.url === HOME_URL ||
      state.splitTabId === tab.id
    )
      state.splitTabId = null;
    state.activeSpaceId = tab.spaceId;
    state.activeTabId = tab.id;
  }
  function emit() {
    const primary = state.tabs.find((tab) => tab.id === state.activeTabId);
    const secondary = state.tabs.find((tab) => tab.id === state.splitTabId);
    if (
      !primary ||
      !secondary ||
      primary.id === secondary.id ||
      primary.spaceId !== state.activeSpaceId ||
      secondary.spaceId !== state.activeSpaceId ||
      primary.url === HOME_URL ||
      secondary.url === HOME_URL
    )
      state.splitTabId = null;
    state = structuredClone(state);
    const personalSpaces = state.spaces.filter(
      (space) => space.kind === "personal",
    );
    const personalTabs = state.tabs.filter((tab) =>
      personalSpaces.some((space) => space.id === tab.spaceId),
    );
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          ...state,
          spaces: personalSpaces,
          tabs: personalTabs,
          activity: [],
        }),
      );
    } catch {
      /* Browsing remains usable without persistence. */
    }
    listeners.forEach((fn) => fn(state));
    return state;
  }
  function record(url: string, title: string, spaceId: string) {
    if (
      url === HOME_URL ||
      state.spaces.find((space) => space.id === spaceId)?.kind === "agent"
    )
      return;
    state.history = [
      { id: id(), url, title, visitedAt: Date.now() },
      ...state.history.filter((entry) => entry.url !== url),
    ].slice(0, 500);
  }
  async function dispatch(action: BrowserAction): Promise<BrowserState> {
    const tab =
      "id" in action
        ? state.tabs.find((item) => item.id === action.id)
        : undefined;
    switch (action.type) {
      case "tab:create": {
        const spaceId = action.spaceId || state.activeSpaceId;
        const created = newTab(
          spaceId,
          normalizeUrl(action.url || HOME_URL, state.settings.searchEngine),
        );
        if (created.url !== HOME_URL) created.title = hostname(created.url);
        state.tabs.push(created);
        if (!action.background) {
          activate(created);
        }
        record(created.url, created.title, spaceId);
        break;
      }
      case "tab:close": {
        if (!tab) break;
        closed.push(tab);
        state.tabs = state.tabs.filter((item) => item.id !== tab.id);
        if (state.splitTabId === tab.id) state.splitTabId = null;
        if (state.activeTabId === tab.id) {
          let next =
            state.tabs.find((item) => item.id === state.splitTabId) ||
            state.tabs.find((item) => item.spaceId === state.activeSpaceId);
          if (!next) {
            next = newTab(state.activeSpaceId);
            state.tabs.push(next);
          }
          activate(next);
          state.splitTabId = null;
        }
        break;
      }
      case "tab:activate":
        if (tab) {
          activate(tab);
        }
        break;
      case "tab:navigate":
        if (tab) {
          const url = normalizeUrl(action.url, state.settings.searchEngine);
          const stack = navigation.get(tab.id) || {
            urls: [tab.url],
            position: 0,
          };
          stack.urls = [...stack.urls.slice(0, stack.position + 1), url];
          stack.position++;
          navigation.set(tab.id, stack);
          tab.url = url;
          if (tab.id === state.activeTabId && url === HOME_URL)
            state.splitTabId = null;
          tab.title = url === HOME_URL ? "New tab" : hostname(url);
          tab.canGoBack = true;
          tab.canGoForward = false;
          record(url, tab.title, tab.spaceId);
        }
        break;
      case "tab:back":
      case "tab:forward":
        if (tab) {
          const stack = navigation.get(tab.id);
          if (!stack) break;
          stack.position = Math.max(
            0,
            Math.min(
              stack.urls.length - 1,
              stack.position + (action.type === "tab:back" ? -1 : 1),
            ),
          );
          tab.url = stack.urls[stack.position];
          tab.title = tab.url === HOME_URL ? "New tab" : hostname(tab.url);
          tab.canGoBack = stack.position > 0;
          tab.canGoForward = stack.position < stack.urls.length - 1;
        }
        break;
      case "tab:pin":
        if (tab) tab.pinned = !tab.pinned;
        break;
      case "tab:duplicate":
        if (tab) {
          const copy = { ...newTab(tab.spaceId, tab.url), title: tab.title };
          state.tabs.push(copy);
          activate(copy);
        }
        break;
      case "tab:reopen": {
        const last = closed.pop();
        if (last && state.spaces.some((space) => space.id === last.spaceId)) {
          state.tabs.push(last);
          activate(last);
        }
        break;
      }
      case "tab:split": {
        if (
          action.id &&
          (!tab ||
            tab.spaceId !== state.activeSpaceId ||
            tab.id === state.activeTabId ||
            tab.url === HOME_URL ||
            state.tabs.find((item) => item.id === state.activeTabId)?.url ===
              HOME_URL)
        )
          throw new Error("Open two web pages in this space for split view.");
        state.splitTabId = action.id;
        break;
      }
      case "space:create": {
        const name = action.name.trim().slice(0, 40);
        if (!name) throw new Error("Give your space a name.");
        const space = {
          id: id(),
          name,
          color: action.color,
          kind: action.kind,
          owner: "human" as const,
          signIns:
            action.signIns === "separate"
              ? ("separate" as const)
              : ("shared" as const),
          createdAt: Date.now(),
        };
        state.spaces.push(space);
        const created = newTab(space.id);
        state.tabs.push(created);
        state.activeSpaceId = space.id;
        state.activeTabId = created.id;
        state.splitTabId = null;
        state.activity.unshift({
          id: id(),
          spaceId: space.id,
          message: `Created ${name}`,
          time: Date.now(),
          kind: "success",
        });
        break;
      }
      case "space:activate": {
        if (!state.spaces.some((space) => space.id === action.id)) break;
        state.activeSpaceId = action.id;
        let next = state.tabs.find((item) => item.spaceId === action.id);
        if (!next) {
          next = newTab(action.id);
          state.tabs.push(next);
        }
        state.activeTabId = next.id;
        state.splitTabId = null;
        break;
      }
      case "space:rename": {
        const space = state.spaces.find((item) => item.id === action.id);
        if (space && action.name.trim())
          space.name = action.name.trim().slice(0, 40);
        break;
      }
      case "space:color": {
        if (!["green", "blue", "orange", "purple"].includes(action.color))
          throw new Error("Invalid space options.");
        const space = state.spaces.find((item) => item.id === action.id);
        if (space) space.color = action.color;
        break;
      }
      case "space:sign-ins": {
        const space = state.spaces.find((item) => item.id === action.id);
        if (space?.kind === "personal") space.signIns = action.signIns;
        break;
      }
      case "space:delete": {
        if (
          state.spaces.find((space) => space.id === action.id)?.kind ===
            "personal" &&
          state.spaces.filter((space) => space.kind === "personal").length === 1
        )
          throw new Error("Keep at least one personal space.");
        state.spaces = state.spaces.filter((space) => space.id !== action.id);
        state.tabs = state.tabs.filter((item) => item.spaceId !== action.id);
        if (state.activeSpaceId === action.id)
          await dispatch({ type: "space:activate", id: state.spaces[0].id });
        break;
      }
      case "space:ownership": {
        const space = state.spaces.find((item) => item.id === action.id);
        if (space?.kind === "agent") {
          space.owner = action.owner;
          state.activity.unshift({
            id: id(),
            spaceId: space.id,
            message:
              action.owner === "human"
                ? `You took control of ${space.name}`
                : `${space.name} is ready for an agent`,
            kind: "info",
            time: Date.now(),
          });
        }
        break;
      }
      case "bookmark:add": {
        const url = normalizeUrl(action.url);
        if (url === HOME_URL) throw new Error("Open a website to bookmark it.");
        if (!state.bookmarks.some((item) => item.url === url))
          state.bookmarks.push({
            id: id(),
            url,
            title: action.title.trim() || hostname(url),
            createdAt: Date.now(),
          });
        break;
      }
      case "bookmark:remove":
        state.bookmarks = state.bookmarks.filter(
          (item) => item.id !== action.id,
        );
        break;
      case "bookmark:update": {
        const bookmark = state.bookmarks.find((item) => item.id === action.id);
        if (!bookmark) throw new Error("That shortcut no longer exists.");
        const url = normalizeUrl(action.url);
        if (url === HOME_URL) throw new Error("Open a website to bookmark it.");
        if (
          state.bookmarks.some(
            (item) => item.url === url && item.id !== bookmark.id,
          )
        )
          throw new Error("That page is already bookmarked.");
        bookmark.url = url;
        bookmark.title = action.title.trim() || hostname(url);
        break;
      }
      case "history:clear":
        state.history = [];
        break;
      case "settings:update": {
        if (action.settings.automationEnabled)
          throw new Error(
            "The agent connection is available in the desktop app.",
          );
        state.settings = { ...state.settings, ...action.settings };
        break;
      }
      case "page:find":
      case "page:stop-find":
      case "tab:reload":
      case "tab:stop":
        break;
      // The web preview has no agent service.
      case "space:grant":
      case "space:stop":
      case "space:keep":
      case "space-request:answer":
        break;
      case "page:devtools":
      case "page:screenshot":
      case "page:zoom":
      case "download:show":
      case "import:apply":
        throw new Error("This feature is available in the desktop app.");
    }
    return emit();
  }
  return {
    getState: async () => state,
    dispatch,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    onShortcut: () => () => {},
    setContentBounds: () => {},
    freeze: async () => [],
    hidePages: () => {},
    unfreeze: async () => {},
    thumbnails: async () => ({}),
    windowControl: () => {},
    importSources: async () => [],
    importBrowserData: async () => {
      throw new Error("Install the desktop app to import from another browser.");
    },
    extensions: async () => ({
      rows: [],
      actions: [],
      installing: [],
      imports: [],
    }),
    onExtensions: () => () => {},
    extensionCommand: async () => {
      throw new Error(extensionsCopy.desktopOnly);
    },
  };
}
export const bridge: KamapathyBridge = window.kamapathy || createPreviewBridge();
export const isDesktop = Boolean(window.kamapathy);
