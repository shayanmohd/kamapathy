import { HOME_URL, initialState, newTab } from "./state";
import { isWebUrl } from "./url";
import type { BrowserState, Settings, Space } from "./types";

export function validSettings(value: unknown, base: Settings): Settings {
  if (!value || typeof value !== "object") return base;
  const settings = value as Partial<Settings>;
  return {
    theme: ["system", "light", "dark"].includes(settings.theme ?? "")
      ? settings.theme!
      : base.theme,
    searchEngine: ["duckduckgo", "google", "bing"].includes(
      settings.searchEngine ?? "",
    )
      ? settings.searchEngine!
      : base.searchEngine,
    restoreSession:
      typeof settings.restoreSession === "boolean"
        ? settings.restoreSession
        : base.restoreSession,
    showBookmarksBar:
      typeof settings.showBookmarksBar === "boolean"
        ? settings.showBookmarksBar
        : base.showBookmarksBar,
    automationEnabled:
      typeof settings.automationEnabled === "boolean"
        ? settings.automationEnabled
        : base.automationEnabled,
    isolateAgentSpaces:
      typeof settings.isolateAgentSpaces === "boolean"
        ? settings.isolateAgentSpaces
        : base.isolateAgentSpaces,
    welcomed:
      typeof settings.welcomed === "boolean" ? settings.welcomed : base.welcomed,
  };
}

export function restoreState(
  value: unknown,
  platform: BrowserState["platform"],
  version: string,
): BrowserState {
  let state = initialState(platform);
  state.version = version;
  try {
    if (!value || typeof value !== "object") return state;
    const saved = value as Partial<BrowserState>;
    state.settings = validSettings(saved.settings, state.settings);
    const spaceIds = new Set<string>();
    const spaces = Array.isArray(saved.spaces)
      ? saved.spaces
          .filter(
            (space): space is Space =>
              !!space &&
              typeof space.id === "string" &&
              /^[a-z\d-]{1,80}$/i.test(space.id) &&
              typeof space.name === "string" &&
              space.name.length > 0 &&
              space.name.length <= 48 &&
              space.kind === "personal" &&
              ["green", "blue", "orange", "purple"].includes(space.color),
          )
          .filter((space) => {
            if (spaceIds.has(space.id)) return false;
            spaceIds.add(space.id);
            return true;
          })
          // Only saved fields come back; agent state never outlives a run.
          .map(
            (space): Space => ({
              id: space.id,
              name: space.name,
              color: space.color,
              kind: "personal",
              owner: "human",
              signIns: space.signIns === "separate" ? "separate" : "shared",
              createdAt: Number.isFinite(space.createdAt)
                ? space.createdAt
                : Date.now(),
            }),
          )
      : [];
    if (spaces.length) state.spaces = spaces.slice(0, 30);
    state.tabs = state.spaces.map((space) => newTab(space.id));
    if (state.settings.restoreSession && Array.isArray(saved.tabs)) {
      const tabIds = new Set<string>();
      const restored = saved.tabs
        .filter(
          (tab) =>
            tab &&
            typeof tab.id === "string" &&
            /^[a-z\d-]{1,80}$/i.test(tab.id) &&
            state.spaces.some((space) => space.id === tab.spaceId) &&
            typeof tab.title === "string" &&
            (tab.url === HOME_URL || isWebUrl(tab.url)),
        )
        .filter((tab) => {
          if (tabIds.has(tab.id)) return false;
          tabIds.add(tab.id);
          return true;
        })
        .slice(0, 200);
      const missingSpaces = state.spaces.filter(
        (space) => !restored.some((tab) => tab.spaceId === space.id),
      );
      // Reserve room for a usable tab in every space, including spaces whose
      // last tab was invalid or beyond the restoration limit.
      for (
        let index = restored.length - 1;
        restored.length + missingSpaces.length > 200 && index >= 0;
        index--
      ) {
        if (
          restored.some(
            (tab, otherIndex) =>
              otherIndex !== index && tab.spaceId === restored[index].spaceId,
          )
        )
          restored.splice(index, 1);
      }
      if (restored.length)
        state.tabs = restored.map((tab) => ({
          ...newTab(tab.spaceId, tab.url),
          id: tab.id,
          title: tab.title.slice(0, 300),
          pinned: !!tab.pinned,
        }));
      for (const space of state.spaces)
        if (!state.tabs.some((tab) => tab.spaceId === space.id))
          state.tabs.push(newTab(space.id));
    }
    state.activeSpaceId = state.spaces.some(
      (space) => space.id === saved.activeSpaceId,
    )
      ? saved.activeSpaceId!
      : state.spaces[0].id;
    state.activeTabId = state.tabs.some(
      (tab) =>
        tab.id === saved.activeTabId && tab.spaceId === state.activeSpaceId,
    )
      ? saved.activeTabId!
      : state.tabs.find((tab) => tab.spaceId === state.activeSpaceId)!.id;
    if (Array.isArray(saved.bookmarks))
      state.bookmarks = saved.bookmarks
        .filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.title === "string" &&
            isWebUrl(item.url),
        )
        .slice(0, 1000);
    if (Array.isArray(saved.history))
      state.history = saved.history
        .filter(
          (item) =>
            item &&
            typeof item.id === "string" &&
            typeof item.title === "string" &&
            Number.isFinite(item.visitedAt) &&
            isWebUrl(item.url),
        )
        .map(({ visits, ...item }) =>
          Number.isInteger(visits) && visits! > 0 ? { ...item, visits } : item,
        )
        .slice(0, 1000);
  } catch {
    // Invalid saved data must never leave a partially restored session.
    state = initialState(platform);
    state.version = version;
  }
  return state;
}
