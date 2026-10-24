import { HOME_URL, initialState, newTab } from "./state";
import { isWebUrl } from "./url";
import { compareVersions, isVersion } from "./version";
import type {
  BrowserState,
  Settings,
  Space,
  UpdateRelease,
  UpdateState,
} from "./types";

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
    offerToSavePasswords:
      typeof settings.offerToSavePasswords === "boolean"
        ? settings.offerToSavePasswords
        : base.offerToSavePasswords,
    automationEnabled:
      typeof settings.automationEnabled === "boolean"
        ? settings.automationEnabled
        : base.automationEnabled,
    isolateAgentSpaces:
      typeof settings.isolateAgentSpaces === "boolean"
        ? settings.isolateAgentSpaces
        : base.isolateAgentSpaces,
    agentPageScripts:
      typeof settings.agentPageScripts === "boolean"
        ? settings.agentPageScripts
        : base.agentPageScripts,
    welcomed:
      typeof settings.welcomed === "boolean" ? settings.welcomed : base.welcomed,
    extensionUpdates:
      typeof settings.extensionUpdates === "boolean"
        ? settings.extensionUpdates
        : base.extensionUpdates,
    extensionDeveloperMode:
      typeof settings.extensionDeveloperMode === "boolean"
        ? settings.extensionDeveloperMode
        : base.extensionDeveloperMode,
    updateChecks:
      typeof settings.updateChecks === "boolean"
        ? settings.updateChecks
        : base.updateChecks,
    seenVersion: isVersion(settings.seenVersion)
      ? settings.seenVersion
      : base.seenVersion,
  };
}

const MiB = 1048576;

// The updater checks where saved links point; here they only need to be HTTPS.
function httpsUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 2048 &&
    value.startsWith("https://") &&
    URL.canParse(value)
  );
}

function validRelease(value: unknown): UpdateRelease | undefined {
  if (!value || typeof value !== "object") return undefined;
  const release = value as Partial<UpdateRelease>;
  const installer = release.installer as
    Partial<UpdateRelease["installer"]> | undefined;
  if (
    !isVersion(release.version) ||
    typeof release.publishedAt !== "number" ||
    !Number.isFinite(release.publishedAt) ||
    !httpsUrl(release.url) ||
    !httpsUrl(release.sums) ||
    !installer ||
    typeof installer !== "object" ||
    typeof installer.name !== "string" ||
    !/^[A-Za-z0-9._-]{1,255}$/.test(installer.name) ||
    typeof installer.size !== "number" ||
    !Number.isInteger(installer.size) ||
    installer.size < MiB ||
    installer.size > 1024 * MiB ||
    !httpsUrl(installer.url) ||
    (installer.sha256 !== undefined &&
      (typeof installer.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(installer.sha256)))
  )
    return undefined;
  const { name, size, url, sha256 } = installer;
  return {
    version: release.version,
    publishedAt: release.publishedAt,
    url: release.url,
    installer: { name, size, url, ...(sha256 === undefined ? {} : { sha256 }) },
    sums: release.sums,
  };
}

// The last check's saved result. Each part comes back only when it is exactly
// what the updater writes, and nothing else in the record ever does.
export function validUpdateRecord(
  value: unknown,
): { checkedAt?: number; latest?: UpdateRelease } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<UpdateState>;
  const latest = validRelease(record.latest);
  return {
    ...(typeof record.checkedAt === "number" &&
    Number.isFinite(record.checkedAt) &&
    record.checkedAt > 0
      ? { checkedAt: record.checkedAt }
      : {}),
    ...(latest ? { latest } : {}),
  };
}

export function restoreState(
  value: unknown,
  platform: BrowserState["platform"],
  version: string,
): BrowserState {
  let state = initialState(platform);
  state.version = version;
  state.settings.seenVersion = version;
  try {
    if (!value || typeof value !== "object") return state;
    const saved = value as Partial<BrowserState>;
    state.settings = validSettings(saved.settings, state.settings);
    // A profile from before What's new has seen none of it, while a fresh one
    // sees only Welcome. A downgrade resets silently.
    if (!isVersion(saved.settings?.seenVersion) && state.settings.welcomed)
      state.settings.seenVersion = "0.0.0";
    if (
      isVersion(version) &&
      compareVersions(state.settings.seenVersion, version) > 0
    )
      state.settings.seenVersion = version;
    state.update = { ...state.update, ...validUpdateRecord(saved.update) };
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
            (tab.url === HOME_URL ||
              isWebUrl(tab.url) ||
              // Extension pages, which the controller checks against the
              // extensions that load.
              (typeof tab.url === "string" &&
                /^chrome-extension:\/\/[a-p]{32}\//.test(tab.url))),
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
    state.settings.seenVersion = version;
  }
  return state;
}
