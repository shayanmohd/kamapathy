import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import {
  NEW_TAB_URL,
  PLACEHOLDER_BASE,
  WINDOW_ID_CURRENT,
  WINDOW_ID_NONE,
  tabObject,
  type BridgeTab,
  type BridgeWindow,
  type ExtensionAction,
  type ExtensionAnchor,
  type ExtensionEntry,
  type TabModel,
} from "../shared/extensions";
import { HOME_URL, initialState, newTab } from "../shared/state";
import type {
  BrowserAction,
  BrowserState,
  ClosedBy,
  Space,
  Tab,
} from "../shared/types";
import {
  ExtensionBridge,
  type BridgeController,
  type ExtensionWindowInfo,
  type ExtensionWindowOpener,
} from "../electron/extensions/bridge";
import type { ExtensionTabOptions } from "../electron/controller";
import type { ExtensionHost, SurfaceInfo } from "../electron/extensions/host";
import type { CheckedManifest } from "../electron/extensions/manifest";
import type { ExtensionPopups } from "../electron/extensions/popup";
import type {
  ApiHandler,
  Caller,
  ExtensionChannel,
} from "../electron/extensions/channel";
import { extensionBridgeCopy } from "../src/copy";

// The icon sizes the fake nativeImage reports, by path or data URL.
const { imageSizes } = vi.hoisted(() => ({
  imageSizes: new Map<string, number>(),
}));
vi.mock("electron", () => {
  const image = (source: string) => {
    const size = imageSizes.get(source) ?? 0;
    return {
      isEmpty: () => size === 0,
      getSize: () => ({ width: size, height: size }),
      toDataURL: () =>
        source.startsWith("data:") ? source : `data:image/png;base64,${source}`,
    };
  };
  return {
    ipcMain: {
      handle: vi.fn(),
      removeHandler: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    },
    nativeImage: {
      createFromPath: vi.fn((path: string) => image(path)),
      createFromDataURL: vi.fn((url: string) => image(url)),
    },
  };
});

// A distinct valid id per number: its hex digits as the letters a to p.
function idAt(index: number): string {
  return Array.from(index.toString(16).padStart(32, "0"), (digit) =>
    String.fromCharCode(97 + parseInt(digit, 16)),
  ).join("");
}
// ALL sees every tab, HOSTS one site, NONE nothing, EVERY every site.
const [ALL, HOSTS, NONE, EVERY] = [1, 2, 3, 4].map(idAt);
const PERSONAL = "persist:space-personal";
const WORK = "persist:space-work";

function entryFor(
  id: string,
  permissions: string[],
  hosts: string[],
): ExtensionEntry {
  return {
    id,
    source: "unpacked",
    version: "1.0.0",
    path: "/tmp/extension",
    enabled: true,
    pinned: false,
    installedAt: 1,
    grantedPermissions: permissions,
    grantedHosts: hosts,
  };
}

class FakeImage {
  toPNG = vi.fn(() => Buffer.from("png-bytes"));
  toJPEG = vi.fn((quality: number) => Buffer.from(`jpeg-${quality}`));
}
class FakeContents extends EventEmitter {
  zoom = 1;
  audible = false;
  muted = false;
  destroyed = false;
  capturePage = vi.fn(async () => new FakeImage());
  reload = vi.fn();
  reloadIgnoringCache = vi.fn();
  setAudioMuted = vi.fn((value: boolean) => {
    this.muted = value;
  });
  setZoomFactor = vi.fn((value: number) => {
    this.zoom = value;
  });
  navigationHistory = {
    canGoBack: vi.fn(() => true),
    canGoForward: vi.fn(() => true),
    goBack: vi.fn(),
    goForward: vi.fn(),
  };
  constructor(readonly id: number) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getZoomFactor(): number {
    return this.zoom;
  }
  isCurrentlyAudible(): boolean {
    return this.audible;
  }
  isAudioMuted(): boolean {
    return this.muted;
  }
}
class FakeWindow extends EventEmitter {
  focused = true;
  bounds = { x: 120, y: 60, width: 1440, height: 960 };
  maximized = false;
  minimized = false;
  fullScreen = false;
  isFocused(): boolean {
    return this.focused;
  }
  getBounds() {
    return this.bounds;
  }
  isMaximized(): boolean {
    return this.maximized;
  }
  isMinimized(): boolean {
    return this.minimized;
  }
  isFullScreen(): boolean {
    return this.fullScreen;
  }
  isDestroyed(): boolean {
    return false;
  }
}

function spaceAt(id: string, extra: Partial<Space> = {}): Space {
  return {
    id,
    name: id,
    color: "green",
    kind: "personal",
    owner: "human",
    signIns: "shared",
    createdAt: 1,
    ...extra,
  };
}
function tabAt(spaceId: string, url: string, extra: Partial<Tab> = {}): Tab {
  return { ...newTab(spaceId, url), id: `tab-${++tabCount}`, ...extra };
}
let tabCount = 0;

// The controller members the bridge reads, over a plain state.
class FakeController implements BridgeController {
  readonly window = new FakeWindow() as unknown as BrowserWindow;
  readonly state: BrowserState;
  readonly views = new Map<string, FakeContents>();
  private readonly listeners = new Set<(state: BrowserState) => void>();
  private shown = new Map<string, string>();
  private nextContentsId = 10;
  readonly reloaded: string[] = [];
  openExtensionTab = vi.fn(
    (spaceId: string, url: string, options: ExtensionTabOptions = {}): Tab => {
      const space = this.state.spaces.find((item) => item.id === spaceId);
      if (!space || space.kind !== "personal" || space.access === "granted")
        throw new Error("Extensions open tabs only in your personal spaces.");
      const tab = tabAt(spaceId, url === "" ? HOME_URL : url, {
        pinned: !!options.pinned,
      });
      this.place(tab, options.index);
      if (options.active !== false) this.show(spaceId, tab.id);
      this.emit();
      return tab;
    },
  );
  moveTab = vi.fn((tabId: string, index: number): Tab => {
    const tab = this.tabOr(tabId);
    this.place(tab, index);
    this.emit();
    return tab;
  });
  closeTab = vi.fn(
    (tabId: string, by: ClosedBy): { closed?: string; replacement?: Tab } => {
      expect(by).toBe("person");
      const tab = this.tabOr(tabId);
      this.state.tabs.splice(this.state.tabs.indexOf(tab), 1);
      this.views.delete(tabId);
      const rest = this.state.tabs.filter(
        (item) => item.spaceId === tab.spaceId,
      );
      // A space keeps a tab, so Kamapathy's window stays open.
      const replacement = rest.length
        ? undefined
        : tabAt(tab.spaceId, HOME_URL);
      if (replacement) this.state.tabs.push(replacement);
      if (this.state.activeTabId === tabId)
        this.show(tab.spaceId, replacement?.id ?? rest[0]?.id);
      this.emit();
      return { closed: tabId, replacement };
    },
  );
  dispatch = vi.fn(async (action: BrowserAction): Promise<BrowserState> => {
    this.apply(action);
    this.emit();
    return this.state;
  });

  constructor(spaces: Space[], tabs: Tab[]) {
    this.state = {
      ...initialState("darwin"),
      spaces,
      tabs,
      activeSpaceId: spaces[0].id,
      activeTabId: tabs.find((tab) => tab.spaceId === spaces[0].id)?.id ?? "",
    };
  }

  get fakeWindow(): FakeWindow {
    return this.window as unknown as FakeWindow;
  }

  subscribe(listener: (state: BrowserState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of [...this.listeners]) listener(this.state);
  }

  partitionOf(spaceId: string): string {
    const space = this.state.spaces.find((item) => item.id === spaceId);
    if (!space) throw new Error("Space was not found.");
    if (space.signIns === "shared") return PERSONAL;
    return space.kind === "agent"
      ? `agent-run-${space.id}`
      : `persist:space-${space.id}`;
  }

  peekWebContents(tabId: string): WebContents | undefined {
    return this.views.get(tabId) as unknown as WebContents | undefined;
  }

  shownTab(spaceId: string): Tab | undefined {
    const tabs = this.state.tabs.filter((tab) => tab.spaceId === spaceId);
    if (spaceId === this.state.activeSpaceId)
      return tabs.find((tab) => tab.id === this.state.activeTabId) ?? tabs[0];
    const last = this.shown.get(spaceId);
    return tabs.find((tab) => tab.id === last) ?? tabs[0];
  }

  tabOfContents(contents: WebContents): Tab | undefined {
    for (const [tabId, view] of this.views)
      if ((view as unknown as WebContents) === contents)
        return this.state.tabs.find((tab) => tab.id === tabId);
    return undefined;
  }

  // Gives a tab a view, as the controller does when it loads.
  load(tabId: string): FakeContents {
    const contents = new FakeContents(this.nextContentsId++);
    this.views.set(tabId, contents);
    return contents;
  }

  show(spaceId: string, tabId?: string): void {
    this.state.activeSpaceId = spaceId;
    const tabs = this.state.tabs.filter((tab) => tab.spaceId === spaceId);
    const next = tabId ?? tabs[0]?.id ?? "";
    this.state.activeTabId = next;
    this.shown.set(spaceId, next);
  }

  private tabOr(tabId: string): Tab {
    const tab = this.state.tabs.find((item) => item.id === tabId);
    if (!tab) throw new Error("Tab was not found.");
    return tab;
  }

  // Puts a tab at an index of its space's strip. Pin groups don't matter
  // here, so the tests that move tabs keep them unpinned.
  private place(tab: Tab, index?: number): void {
    const at = this.state.tabs.indexOf(tab);
    if (at >= 0) this.state.tabs.splice(at, 1);
    const strip = this.state.tabs.filter(
      (item) => item.spaceId === tab.spaceId,
    );
    const rank =
      index === undefined || index < 0
        ? strip.length
        : Math.min(index, strip.length);
    const before = strip[rank];
    if (before) this.state.tabs.splice(this.state.tabs.indexOf(before), 0, tab);
    else this.state.tabs.push(tab);
  }

  // The few actions the bridges dispatch, as the controller applies them.
  private apply(action: BrowserAction): void {
    if (action.type === "space:activate") {
      this.show(action.id);
      return;
    }
    if (action.type === "tab:activate") {
      const tab = this.tabOr(action.id);
      this.show(tab.spaceId, tab.id);
      return;
    }
    if (action.type === "tab:navigate") {
      const tab = this.tabOr(action.id);
      tab.url = action.url;
      tab.title = action.url === HOME_URL ? "New tab" : action.url;
      return;
    }
    if (action.type === "tab:pin") {
      this.tabOr(action.id).pinned = !this.tabOr(action.id).pinned;
      return;
    }
    if (action.type === "tab:reload") {
      this.reloaded.push(action.id);
      return;
    }
    throw new Error(`Unexpected action: ${action.type}`);
  }
}

type Emitted = {
  partition: string;
  extensionId: string;
  event: string;
  args: unknown[];
};
// What the bridge registers, emits and asks about listeners.
class FakeChannel {
  readonly handlers = new Map<string, ApiHandler>();
  readonly events: Emitted[] = [];
  private readonly listeners = new Set<string>();
  register = vi.fn((api: string, handler: ApiHandler) => {
    this.handlers.set(api, handler);
  });
  emit = vi.fn(
    (
      partition: string,
      extensionId: string,
      event: string,
      args: unknown[],
    ) => {
      this.events.push({ partition, extensionId, event, args });
    },
  );
  listening = vi.fn((partition: string, extensionId: string, event: string) =>
    this.listeners.has(`${partition}|${extensionId}|${event}`),
  );
  listen(partition: string, extensionId: string, ...events: string[]): void {
    for (const event of events)
      this.listeners.add(`${partition}|${extensionId}|${event}`);
  }
  call(api: string, caller: Caller, method: string, args: unknown[] = []) {
    const handler = this.handlers.get(api);
    if (!handler) throw new Error(`No handler for ${api}`);
    return handler(caller, method, args);
  }
  // Change calls answer later; a refusal thrown at once rejects the same way.
  async run(
    api: string,
    caller: Caller,
    method: string,
    args: unknown[] = [],
  ): Promise<unknown> {
    return await this.call(api, caller, method, args);
  }
  take(extensionId?: string): Emitted[] {
    const taken = this.events.splice(0);
    return extensionId
      ? taken.filter((item) => item.extensionId === extensionId)
      : taken;
  }
}
// The host members the bridge reads.
class FakeHost {
  readonly records: ExtensionEntry[] = [];
  readonly loaded = new Map<string, Set<string>>();
  readonly surfaces = new Map<WebContents, SurfaceInfo>();
  private readonly listeners = new Set<(event: unknown) => void>();
  entries(): readonly ExtensionEntry[] {
    return this.records;
  }
  entry(id: string): ExtensionEntry | undefined {
    return this.records.find((item) => item.id === id);
  }
  isLoaded(partition: string, id: string): boolean {
    return this.loaded.get(partition)?.has(id) ?? false;
  }
  loadedIds(partition: string): ReadonlySet<string> {
    return this.loaded.get(partition) ?? new Set();
  }
  partitions(): string[] {
    return [...this.loaded.keys()];
  }
  surfaceOf(contents: WebContents): SurfaceInfo | undefined {
    return this.surfaces.get(contents);
  }
  readonly options = new Map<string, string>();
  readonly manifests = new Map<string, Partial<CheckedManifest>>();
  manifestOf(id: string): Partial<CheckedManifest> {
    return { options: this.options.get(id), ...this.manifests.get(id) };
  }
  nameOf(id: string): string | undefined {
    return this.manifests.get(id)?.name;
  }
  folderOf(entry: ExtensionEntry): string {
    return entry.path;
  }
  onEvent(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  send(event: unknown): void {
    for (const listener of [...this.listeners]) listener(event);
  }
  load(partition: string, entry: ExtensionEntry): void {
    if (!this.entry(entry.id)) this.records.push(entry);
    const ids = this.loaded.get(partition) ?? new Set<string>();
    ids.add(entry.id);
    this.loaded.set(partition, ids);
  }
}

class FakeOpener implements ExtensionWindowOpener {
  readonly windows: ExtensionWindowInfo[] = [];
  private nextTabId = 900;
  openWindow = vi.fn(
    (request: {
      windowId: number;
      extensionId: string;
      partition: string;
      url: string;
      left?: number;
      top?: number;
      width?: number;
      height?: number;
      focused: boolean;
    }): ExtensionWindowInfo => {
      const info: ExtensionWindowInfo = {
        windowId: request.windowId,
        tabId: this.nextTabId++,
        extensionId: request.extensionId,
        partition: request.partition,
        url: request.url,
        focused: request.focused,
        bounds: {
          left: request.left ?? 0,
          top: request.top ?? 0,
          width: request.width ?? 400,
          height: request.height ?? 300,
        },
      };
      this.windows.push(info);
      return info;
    },
  );
  updateWindow = vi.fn(
    (
      windowId: number,
      changes: {
        left?: number;
        top?: number;
        width?: number;
        height?: number;
        focused?: boolean;
      },
    ): ExtensionWindowInfo => {
      const info = this.windows.find((item) => item.windowId === windowId);
      if (!info) throw new Error("Window was not found.");
      info.bounds = {
        left: changes.left ?? info.bounds.left,
        top: changes.top ?? info.bounds.top,
        width: changes.width ?? info.bounds.width,
        height: changes.height ?? info.bounds.height,
      };
      if (changes.focused !== undefined) info.focused = changes.focused;
      return info;
    },
  );
  closeWindow = vi.fn((windowId: number): boolean => {
    const at = this.windows.findIndex((item) => item.windowId === windowId);
    if (at < 0) return false;
    this.windows.splice(at, 1);
    return true;
  });
  windowsOf = vi.fn(
    (extensionId: string, partition: string): ExtensionWindowInfo[] =>
      this.windows.filter(
        (item) =>
          item.extensionId === extensionId && item.partition === partition,
      ),
  );
}

// The popups the person's clicks reach (task 11), opener included.
class FakePopups extends FakeOpener {
  togglePopup = vi.fn(
    (_request: {
      extensionId: string;
      partition: string;
      spaceId: string;
      url: string;
      anchor: ExtensionAnchor;
    }) => {},
  );
  closePopup = vi.fn();
  shownPopup = vi.fn(() => undefined);
}
const ANCHOR: ExtensionAnchor = { x: 900, y: 40, width: 32, height: 32 };

interface Setup {
  bridge: ExtensionBridge;
  controller: FakeController;
  channel: FakeChannel;
  host: FakeHost;
  unbind: () => void;
}
function setUp(spaces: Space[], tabs: Tab[]): Setup {
  const host = new FakeHost();
  const channel = new FakeChannel();
  host.load(PERSONAL, entryFor(ALL, ["tabs"], []));
  host.load(PERSONAL, entryFor(HOSTS, [], ["https://example.com/*"]));
  host.load(PERSONAL, entryFor(NONE, [], []));
  host.load(PERSONAL, entryFor(EVERY, [], ["<all_urls>"]));
  host.load(WORK, entryFor(ALL, ["tabs"], []));
  const controller = new FakeController(spaces, tabs);
  const bridge = new ExtensionBridge({
    host: host as unknown as ExtensionHost,
    channel: channel as unknown as ExtensionChannel,
  });
  const unbind = bridge.bind(controller);
  return { bridge, controller, channel, host, unbind };
}
function callerFor(
  extensionId: string,
  partition: string,
  surface: Caller["surface"],
  contents?: FakeContents,
): Caller {
  return {
    extensionId,
    partition,
    surface,
    contents: contents as unknown as WebContents,
  };
}
const tabsOf = (bridge: ExtensionBridge, partition: string): TabModel[] =>
  bridge.model(partition).windows.flatMap((window) => window.tabs);

beforeEach(() => {
  tabCount = 0;
  vi.clearAllMocks();
});

describe("extension tab objects", () => {
  it("tab objects for new, unloaded and loaded tabs", () => {
    const pinned = tabAt("personal", "https://news.example/", {
      pinned: true,
      title: "News",
    });
    const blank = tabAt("personal", HOME_URL);
    const restored = tabAt("personal", "https://example.com/saved", {
      title: "Saved",
    });
    const live = tabAt("personal", "https://example.com/page", {
      title: "Page",
      loading: true,
      favicon: "https://example.com/icon.png",
    });
    const other = tabAt("work", "https://example.com/work");
    const { bridge, controller, channel } = setUp(
      [spaceAt("personal"), spaceAt("work", { signIns: "separate" })],
      [blank, restored, live, pinned, other],
    );
    const contents = controller.load(live.id);
    controller.show("personal", live.id);

    const model = bridge.model(PERSONAL);
    expect(model.windows).toHaveLength(1);
    const window = model.windows[0];
    // Pinned tabs come first, as in the tab strip.
    expect(window.tabs.map((tab) => tab.tabId)).toEqual([
      pinned.id,
      blank.id,
      restored.id,
      live.id,
    ]);
    expect(window.tabs.map((tab) => tab.index)).toEqual([0, 1, 2, 3]);
    const [first, second, third, fourth] = window.tabs;

    expect(first.id).toBeGreaterThanOrEqual(PLACEHOLDER_BASE);
    expect(second).toMatchObject({
      url: NEW_TAB_URL,
      title: "New tab",
      status: "complete",
      newTab: true,
      discarded: false,
    });
    expect(second.id).toBeGreaterThanOrEqual(PLACEHOLDER_BASE);
    expect(second.id).not.toBe(first.id);
    expect(third).toMatchObject({ status: "unloaded", discarded: true });
    expect(third.id).toBeGreaterThanOrEqual(PLACEHOLDER_BASE);
    expect(fourth).toMatchObject({
      id: contents.id,
      status: "loading",
      discarded: false,
      active: true,
      zoomFactor: 1,
      audible: false,
      muted: false,
      windowId: bridge.windowIdOf("personal"),
    });
    expect(fourth.id).toBeLessThan(PLACEHOLDER_BASE);
    // Every tab of the session answers to its numeric id.
    expect(bridge.numericId(live.id)).toBe(contents.id);
    expect(bridge.tabIdOf(contents.id)).toBe(live.id);
    expect(bridge.tabIdOf(second.id)).toBe(blank.id);
    // The placeholder stays the same for the tab's life.
    expect(bridge.model(PERSONAL).windows[0].tabs[2].id).toBe(third.id);

    live.loading = false;
    contents.zoom = 1.25;
    contents.audible = true;
    contents.muted = true;
    expect(tabsOf(bridge, PERSONAL).at(-1)).toMatchObject({
      status: "complete",
      zoomFactor: 1.25,
      audible: true,
      muted: true,
    });

    const caller = callerFor(ALL, PERSONAL, "tab", contents);
    expect(channel.call("tabs", caller, "get", [contents.id])).toMatchObject({
      id: contents.id,
      index: 3,
      windowId: bridge.windowIdOf("personal"),
      active: true,
      highlighted: true,
      selected: true,
      pinned: false,
      incognito: false,
      groupId: -1,
      autoDiscardable: true,
      frozen: false,
      mutedInfo: { muted: true },
      status: "complete",
      url: "https://example.com/page",
      title: "Page",
      favIconUrl: "https://example.com/icon.png",
    });
    expect(channel.call("tabs", caller, "getCurrent", [])).toMatchObject({
      id: contents.id,
    });
    expect(
      channel.call(
        "tabs",
        callerFor(ALL, PERSONAL, "worker"),
        "getCurrent",
        [],
      ),
    ).toBeUndefined();
    expect(channel.call("tabs", caller, "getZoom", [])).toBe(1.25);
    expect(channel.call("tabs", caller, "getZoomSettings", [])).toEqual({
      mode: "automatic",
      scope: "per-origin",
      defaultZoomFactor: 1,
    });
    // Tabs of another session, unknown ids and bad arguments are refused.
    const stranger = tabsOf(bridge, WORK)[0];
    expect(() => channel.call("tabs", caller, "get", [stranger.id])).toThrow(
      extensionBridgeCopy.noTab(stranger.id),
    );
    expect(() => channel.call("tabs", caller, "get", ["7"])).toThrow(
      extensionBridgeCopy.invalid("tabs.get"),
    );
    expect(() => channel.call("tabs", caller, "detectLanguage", [])).toThrow(
      extensionBridgeCopy.notSupported,
    );
  });

  it("field hiding and activeTab grants", () => {
    const shop = tabAt("personal", "https://example.com/shop", {
      title: "Shop",
      favicon: "https://example.com/icon.png",
    });
    const news = tabAt("personal", "https://news.example/today", {
      title: "News",
    });
    const file = tabAt("personal", "file:///Users/sherry/notes.pdf", {
      title: "notes.pdf",
    });
    const { bridge, controller } = setUp(
      [spaceAt("personal")],
      [shop, news, file],
    );
    const shopContents = controller.load(shop.id);
    controller.load(news.id);
    controller.load(file.id);
    const [shopTab, newsTab, fileTab] = tabsOf(bridge, PERSONAL);
    expect(fileTab.file).toBe(true);

    const seen = (id: string, tab: TabModel) => {
      const object = tabObject(tab, bridge.access(PERSONAL, id));
      return [object.url, object.title, object.favIconUrl, object.pendingUrl];
    };
    // The tabs permission shows every tab but a file tab.
    expect(seen(ALL, shopTab)).toEqual([
      "https://example.com/shop",
      "Shop",
      "https://example.com/icon.png",
      undefined,
    ]);
    expect(seen(ALL, newsTab)).toEqual([
      "https://news.example/today",
      "News",
      undefined,
      undefined,
    ]);
    expect(seen(ALL, fileTab)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // A host permission shows only the sites it matches.
    expect(seen(HOSTS, shopTab)[0]).toBe("https://example.com/shop");
    expect(seen(HOSTS, newsTab)[0]).toBeUndefined();
    expect(seen(NONE, shopTab)[0]).toBeUndefined();

    // The person's click on the toolbar grants that one tab.
    bridge.grantActiveTab(PERSONAL, NONE, newsTab.id);
    expect([...bridge.access(PERSONAL, NONE).activeTabs]).toEqual([newsTab.id]);
    expect(seen(NONE, newsTab)[0]).toBe("https://news.example/today");
    expect(seen(NONE, shopTab)[0]).toBeUndefined();
    // A file tab stays hidden even with a grant.
    bridge.grantActiveTab(PERSONAL, ALL, fileTab.id);
    expect(seen(ALL, fileTab)[0]).toBeUndefined();
    // Another session's extension keeps its own grants.
    expect([...bridge.access(WORK, NONE).activeTabs]).toEqual([]);

    // The grant ends when that tab's main frame loads another document.
    bridge.grantActiveTab(PERSONAL, NONE, shopTab.id);
    expect([...bridge.access(PERSONAL, NONE).activeTabs]).toContain(shopTab.id);
    shopContents.emit("did-navigate", {}, "https://example.com/other");
    expect([...bridge.access(PERSONAL, NONE).activeTabs]).not.toContain(
      shopTab.id,
    );
    expect(seen(NONE, shopTab)[0]).toBeUndefined();
    // A loading tab also reports its pending URL.
    news.loading = true;
    expect(seen(NONE, tabsOf(bridge, PERSONAL)[1])).toEqual([
      "https://news.example/today",
      "News",
      undefined,
      "https://news.example/today",
    ]);
  });

  it("query patterns and currentWindow", () => {
    const shop = tabAt("personal", "https://example.com/shop", {
      title: "Example shop",
      pinned: true,
    });
    const news = tabAt("personal", "https://news.example/today", {
      title: "Today",
    });
    const agentTab = tabAt("shared-agent", "https://example.com/agent", {
      title: "Agent page",
    });
    const workTab = tabAt("work", "https://example.com/work", {
      title: "Work page",
    });
    const { bridge, controller, channel, host } = setUp(
      [
        spaceAt("personal"),
        spaceAt("shared-agent", { kind: "agent", owner: "agent" }),
        spaceAt("work", { signIns: "separate" }),
      ],
      [shop, news, agentTab, workTab],
    );
    const shopContents = controller.load(shop.id);
    controller.load(news.id);
    controller.load(agentTab.id);
    controller.show("personal", news.id);
    const personalWindow = bridge.windowIdOf("personal");
    const agentWindow = bridge.windowIdOf("shared-agent");
    const caller = callerFor(ALL, PERSONAL, "tab", shopContents);
    const query = (queryInfo: unknown, from: Caller = caller) =>
      (
        channel.call("tabs", from, "query", [queryInfo]) as {
          id: number;
          windowId: number;
        }[]
      ).map((tab) => `${tab.windowId}:${tab.id}`);
    const idOf = (tab: Tab) => bridge.numericId(tab.id);

    expect(query({})).toEqual([
      `${personalWindow}:${idOf(shop)}`,
      `${personalWindow}:${idOf(news)}`,
      `${agentWindow}:${idOf(agentTab)}`,
    ]);
    expect(query({ url: "https://example.com/*" })).toEqual([
      `${personalWindow}:${idOf(shop)}`,
      `${agentWindow}:${idOf(agentTab)}`,
    ]);
    expect(
      query({ url: ["https://news.example/*", "https://example.com/shop"] }),
    ).toEqual([
      `${personalWindow}:${idOf(shop)}`,
      `${personalWindow}:${idOf(news)}`,
    ]);
    expect(query({ title: "Example*" })).toEqual([
      `${personalWindow}:${idOf(shop)}`,
    ]);
    // Each window reports its own active tab.
    expect(query({ active: true })).toEqual([
      `${personalWindow}:${idOf(news)}`,
      `${agentWindow}:${idOf(agentTab)}`,
    ]);
    expect(query({ pinned: true })).toEqual([
      `${personalWindow}:${idOf(shop)}`,
    ]);
    expect(query({ status: "complete" })).toHaveLength(3);
    expect(query({ status: "loading" })).toEqual([]);
    expect(query({ windowId: WINDOW_ID_CURRENT })).toEqual([
      `${personalWindow}:${idOf(shop)}`,
      `${personalWindow}:${idOf(news)}`,
    ]);
    expect(query({ windowId: agentWindow })).toEqual([
      `${agentWindow}:${idOf(agentTab)}`,
    ]);
    expect(query({ currentWindow: true })).toHaveLength(2);
    expect(query({ lastFocusedWindow: true })).toHaveLength(2);
    expect(query({ windowType: "popup" })).toEqual([]);
    // Tabs whose fields are hidden never match a URL or a title.
    expect(
      query(
        { url: "https://example.com/*" },
        callerFor(NONE, PERSONAL, "worker"),
      ),
    ).toEqual([]);
    expect(
      query({ title: "Today" }, callerFor(NONE, PERSONAL, "worker")),
    ).toEqual([]);
    expect(query({}, callerFor(NONE, PERSONAL, "worker"))).toHaveLength(3);
    expect(() => channel.call("tabs", caller, "query", [{ url: 7 }])).toThrow(
      extensionBridgeCopy.invalid("tabs.query"),
    );

    // A popup's current window is the space it belongs to.
    const popupContents = new FakeContents(99);
    host.surfaces.set(popupContents as unknown as WebContents, {
      kind: "popup",
      extensionId: ALL,
      partition: PERSONAL,
      spaceId: "shared-agent",
    });
    const popup = callerFor(ALL, PERSONAL, "popup", popupContents);
    expect(bridge.callerWindowId(popup)).toBe(agentWindow);
    expect(query({ currentWindow: true }, popup)).toEqual([
      `${agentWindow}:${idOf(agentTab)}`,
    ]);
    // A worker has no window of its own, so it gets the space shown last on
    // its session. Another session's spaces never count.
    const worker = callerFor(ALL, PERSONAL, "worker");
    expect(bridge.callerWindowId(worker)).toBeUndefined();
    expect(bridge.currentWindowId(worker)).toBe(personalWindow);
    controller.show("work", workTab.id);
    controller.emit();
    expect(bridge.currentWindowId(worker)).toBe(personalWindow);
    controller.show("shared-agent", agentTab.id);
    controller.emit();
    expect(bridge.currentWindowId(worker)).toBe(agentWindow);
    expect(query({ currentWindow: true }, worker)).toEqual([
      `${agentWindow}:${idOf(agentTab)}`,
    ]);
  });

  it("onReplaced", () => {
    const blank = tabAt("personal", "https://example.com/slow", {
      title: "Slow",
    });
    const { bridge, controller, channel } = setUp(
      [spaceAt("personal")],
      [blank],
    );
    channel.listen(
      PERSONAL,
      ALL,
      "tabs.onReplaced",
      "tabs.onUpdated",
      "tabs.onActivated",
      "tabs.onHighlighted",
    );
    controller.emit();
    const placeholder = tabsOf(bridge, PERSONAL)[0].id;
    expect(placeholder).toBeGreaterThanOrEqual(PLACEHOLDER_BASE);
    channel.take();

    // The view appears: the tab keeps its place and takes its contents id.
    const contents = controller.load(blank.id);
    blank.loading = true;
    controller.emit();
    const events = channel.take(ALL);
    expect(events.map((item) => item.event)).toEqual([
      "tabs.onReplaced",
      "tabs.onUpdated",
    ]);
    expect(events[0].args).toEqual([contents.id, placeholder]);
    expect(events[1].args[0]).toBe(contents.id);
    expect(events[1].args[1]).toEqual({
      status: "loading",
      discarded: false,
    });
    // Later calls and events use the new id.
    const caller = callerFor(ALL, PERSONAL, "worker");
    expect(channel.call("tabs", caller, "get", [contents.id])).toMatchObject({
      id: contents.id,
      status: "loading",
    });
    expect(() => channel.call("tabs", caller, "get", [placeholder])).toThrow(
      extensionBridgeCopy.noTab(placeholder),
    );
    expect(bridge.numericId(blank.id)).toBe(contents.id);
    expect(bridge.tabIdOf(placeholder)).toBeUndefined();
    blank.loading = false;
    controller.emit();
    expect(channel.take(ALL)).toEqual([
      {
        partition: PERSONAL,
        extensionId: ALL,
        event: "tabs.onUpdated",
        args: [
          contents.id,
          { status: "complete" },
          expect.objectContaining({ id: contents.id, status: "complete" }),
        ],
      },
    ]);
  });

  it("windows are this session's spaces with the main window's state and bounds, focused only while shown and the window has focus", () => {
    const personalTab = tabAt("personal", "https://example.com/");
    const agentTab = tabAt("shared-agent", "https://example.com/agent");
    const isolatedTab = tabAt("isolated", "https://example.com/isolated");
    const workTab = tabAt("work", "https://example.com/work");
    const { bridge, controller, channel } = setUp(
      [
        spaceAt("personal"),
        spaceAt("shared-agent", { kind: "agent", owner: "agent" }),
        spaceAt("isolated", {
          kind: "agent",
          owner: "agent",
          signIns: "separate",
        }),
        spaceAt("work", { signIns: "separate" }),
      ],
      [personalTab, agentTab, isolatedTab, workTab],
    );
    const model = bridge.model(PERSONAL);
    // Agent spaces that share sign-ins are windows too; isolated ones and
    // other sessions' spaces are not.
    expect(model.windows.map((window) => window.spaceId)).toEqual([
      "personal",
      "shared-agent",
    ]);
    expect(model.partition).toBe(PERSONAL);
    expect(model.windows.map((window) => window.id)).toEqual([
      bridge.windowIdOf("personal"),
      bridge.windowIdOf("shared-agent"),
    ]);
    expect(model.windows[0]).toMatchObject({
      focused: true,
      agentHeld: false,
      personal: true,
      state: "normal",
      bounds: { left: 120, top: 60, width: 1440, height: 960 },
    });
    expect(model.windows[1]).toMatchObject({
      focused: false,
      agentHeld: true,
      personal: false,
    });
    expect(bridge.model(WORK).windows.map((window) => window.spaceId)).toEqual([
      "work",
    ]);
    expect(bridge.model("agent-run-isolated").windows).toEqual([]);

    const caller = callerFor(ALL, PERSONAL, "worker");
    const all = channel.call("windows", caller, "getAll", [
      { populate: true },
    ]) as { id: number; tabs?: unknown[] }[];
    expect(all.map((window) => window.id)).toEqual([
      bridge.windowIdOf("personal"),
      bridge.windowIdOf("shared-agent"),
    ]);
    expect(all[0].tabs).toHaveLength(1);
    expect(
      channel.call("windows", caller, "getAll", [{ windowTypes: ["popup"] }]),
    ).toEqual([]);
    expect(
      channel.call("windows", caller, "get", [bridge.windowIdOf("personal")]),
    ).toMatchObject({
      id: bridge.windowIdOf("personal"),
      focused: true,
      top: 60,
      left: 120,
      width: 1440,
      height: 960,
      incognito: false,
      type: "normal",
      state: "normal",
      alwaysOnTop: false,
      tabs: undefined,
    });
    expect(
      channel.call("windows", caller, "getCurrent", [{ populate: true }]),
    ).toMatchObject({ id: bridge.windowIdOf("personal") });
    expect(channel.call("windows", caller, "getLastFocused", [])).toMatchObject(
      { id: bridge.windowIdOf("personal") },
    );
    expect(() => channel.call("windows", caller, "get", [404])).toThrow(
      extensionBridgeCopy.noWindow(404),
    );
    expect(() => channel.call("windows", caller, "get", ["x"])).toThrow(
      extensionBridgeCopy.invalid("windows.get"),
    );

    // Focus follows the shown space and the main window together.
    controller.show("shared-agent", agentTab.id);
    expect(
      bridge.model(PERSONAL).windows.map((window) => window.focused),
    ).toEqual([false, true]);
    controller.fakeWindow.focused = false;
    expect(
      bridge.model(PERSONAL).windows.map((window) => window.focused),
    ).toEqual([false, false]);
    controller.fakeWindow.focused = true;
    // State comes from the main window.
    controller.fakeWindow.maximized = true;
    expect(bridge.model(PERSONAL).windows[0].state).toBe("maximized");
    controller.fakeWindow.minimized = true;
    expect(bridge.model(PERSONAL).windows[0].state).toBe("minimized");
    controller.fakeWindow.fullScreen = true;
    expect(bridge.model(PERSONAL).windows[0].state).toBe("fullscreen");
  });

  it("events reach only extensions listening in that session, with the fields each may see", () => {
    const home = tabAt("personal", "https://example.com/", { title: "Home" });
    const agentTab = tabAt("shared-agent", "https://example.com/agent");
    const workTab = tabAt("work", "https://example.com/work");
    const { bridge, controller, channel } = setUp(
      [
        spaceAt("personal"),
        spaceAt("shared-agent", { kind: "agent", owner: "agent" }),
        spaceAt("work", { signIns: "separate" }),
      ],
      [home, agentTab, workTab],
    );
    const events = [
      "tabs.onCreated",
      "tabs.onUpdated",
      "tabs.onActivated",
      "tabs.onHighlighted",
      "tabs.onRemoved",
      "tabs.onMoved",
      "tabs.onAttached",
      "tabs.onDetached",
      "tabs.onZoomChange",
      "windows.onCreated",
      "windows.onRemoved",
      "windows.onFocusChanged",
      "windows.onBoundsChanged",
    ];
    channel.listen(PERSONAL, ALL, ...events);
    channel.listen(PERSONAL, NONE, ...events);
    channel.listen(WORK, ALL, ...events);
    const homeContents = controller.load(home.id);
    controller.load(agentTab.id);
    controller.emit();
    channel.take();
    const personalWindow = bridge.windowIdOf("personal");
    const agentWindow = bridge.windowIdOf("shared-agent");
    // Everything sent since the last step, by extension and in order.
    const step = () => {
      const sent = channel.take();
      return (extensionId: string) =>
        sent.filter((item) => item.extensionId === extensionId);
    };

    // A new tab in a space of this session.
    const added = tabAt("personal", "https://news.example/", {
      title: "News",
    });
    controller.state.tabs.push(added);
    controller.show("personal", added.id);
    controller.emit();
    let sent = step();
    expect(sent(ALL).map((item) => item.event)).toEqual([
      "tabs.onCreated",
      "tabs.onActivated",
      "tabs.onHighlighted",
    ]);
    expect(sent(ALL)[0].args[0]).toMatchObject({
      id: bridge.numericId(added.id),
      index: 1,
      windowId: personalWindow,
      url: "https://news.example/",
      title: "News",
    });
    // An extension without access sees the tab, not its URL or title.
    const hidden = sent(NONE)[0].args[0] as Record<string, unknown>;
    expect(hidden.id).toBe(bridge.numericId(added.id));
    expect(hidden.url).toBeUndefined();
    expect(hidden.title).toBeUndefined();
    expect(sent(ALL)[1].args).toEqual([
      { tabId: bridge.numericId(added.id), windowId: personalWindow },
    ]);
    expect(sent(ALL)[2].args).toEqual([
      { windowId: personalWindow, tabIds: [bridge.numericId(added.id)] },
    ]);
    // Another session's extension hears nothing about this one.
    expect(sent(ALL).every((item) => item.partition === PERSONAL)).toBe(true);

    // A title change only reaches extensions that may read titles.
    added.title = "Later";
    controller.emit();
    sent = step();
    expect(sent(ALL).map((item) => item.event)).toEqual(["tabs.onUpdated"]);
    expect(sent(ALL)[0].args[1]).toEqual({ title: "Later" });
    expect(sent(NONE)).toEqual([]);

    // Pinning moves a tab to the front of the strip; zoom and audio change
    // the tab that stays.
    added.pinned = true;
    homeContents.zoom = 1.5;
    homeContents.audible = true;
    controller.emit();
    sent = step();
    expect(sent(NONE).map((item) => item.event)).toEqual([
      "tabs.onUpdated",
      "tabs.onUpdated",
      "tabs.onZoomChange",
      "tabs.onMoved",
    ]);
    expect(sent(NONE)[0].args[1]).toEqual({ pinned: true });
    expect(sent(NONE)[3].args).toEqual([
      bridge.numericId(added.id),
      { windowId: personalWindow, fromIndex: 1, toIndex: 0 },
    ]);
    expect(sent(NONE)[1].args[1]).toEqual({ audible: true });
    expect(sent(NONE)[2].args).toEqual([
      {
        tabId: homeContents.id,
        oldZoomFactor: 1,
        newZoomFactor: 1.5,
        zoomSettings: { mode: "automatic", scope: "per-origin" },
      },
    ]);

    // A tab moving to another space of the same session.
    const moved = bridge.numericId(added.id);
    added.spaceId = "shared-agent";
    added.pinned = false;
    controller.emit();
    sent = step();
    expect(sent(ALL).map((item) => item.event)).toEqual([
      "tabs.onDetached",
      "tabs.onAttached",
      "tabs.onUpdated",
      "tabs.onActivated",
      "tabs.onHighlighted",
    ]);
    expect(sent(ALL)[0].args).toEqual([
      moved,
      { oldWindowId: personalWindow, oldPosition: 0 },
    ]);
    expect(sent(ALL)[1].args).toEqual([
      moved,
      { newWindowId: agentWindow, newPosition: 1 },
    ]);
    // The space it left shows another tab now.
    expect(sent(ALL)[3].args).toEqual([
      { tabId: homeContents.id, windowId: personalWindow },
    ]);

    // Closing a tab, and closing a space with its tabs.
    controller.state.tabs = controller.state.tabs.filter(
      (tab) => tab.id !== added.id,
    );
    controller.emit();
    sent = step();
    expect(sent(ALL).map((item) => item.event)).toEqual(["tabs.onRemoved"]);
    expect(sent(ALL)[0].args).toEqual([
      moved,
      { windowId: agentWindow, isWindowClosing: false },
    ]);
    const agentNumeric = bridge.numericId(agentTab.id);
    controller.state.spaces = controller.state.spaces.filter(
      (space) => space.id !== "shared-agent",
    );
    controller.state.tabs = controller.state.tabs.filter(
      (tab) => tab.spaceId !== "shared-agent",
    );
    controller.emit();
    sent = step();
    expect(sent(ALL).map((item) => item.event)).toEqual([
      "tabs.onRemoved",
      "windows.onRemoved",
    ]);
    expect(sent(ALL)[0].args).toEqual([
      agentNumeric,
      { windowId: agentWindow, isWindowClosing: true },
    ]);
    expect(sent(ALL)[1].args).toEqual([agentWindow]);

    // A new space of this session is a new window.
    controller.state.spaces.push(spaceAt("second"));
    const secondTab = tabAt("second", "https://example.com/second");
    controller.state.tabs.push(secondTab);
    controller.emit();
    sent = step();
    const secondWindow = bridge.windowIdOf("second");
    expect(sent(ALL).map((item) => item.event)).toEqual([
      "windows.onCreated",
      "tabs.onCreated",
      "tabs.onActivated",
      "tabs.onHighlighted",
    ]);
    expect(sent(ALL)[0].args[0]).toMatchObject({
      id: secondWindow,
      type: "normal",
      focused: false,
      tabs: undefined,
    });
    expect(sent(ALL)[1].args[0]).toMatchObject({ windowId: secondWindow });

    // The main window's focus and bounds.
    controller.fakeWindow.focused = false;
    controller.fakeWindow.emit("blur");
    sent = step();
    expect(sent(ALL).map((item) => item.event)).toEqual([
      "windows.onFocusChanged",
    ]);
    expect(sent(ALL)[0].args).toEqual([WINDOW_ID_NONE]);
    controller.fakeWindow.focused = true;
    controller.fakeWindow.emit("focus");
    sent = step();
    expect(sent(ALL)[0].args).toEqual([personalWindow]);
    controller.fakeWindow.bounds = { x: 0, y: 0, width: 1200, height: 800 };
    controller.fakeWindow.emit("resize");
    sent = step();
    // Every window of every session this extension listens in moved.
    expect(sent(ALL).map((item) => [item.partition, item.event])).toEqual([
      [PERSONAL, "windows.onBoundsChanged"],
      [PERSONAL, "windows.onBoundsChanged"],
      [WORK, "windows.onBoundsChanged"],
    ]);
    expect(sent(ALL).map((item) => item.args[0])).toEqual([
      expect.objectContaining({ id: personalWindow, width: 1200, left: 0 }),
      expect.objectContaining({ id: secondWindow, width: 1200, left: 0 }),
      expect.objectContaining({
        id: bridge.windowIdOf("work"),
        width: 1200,
        left: 0,
      }),
    ]);
    // Nothing is sent while nothing changed.
    controller.emit();
    expect(channel.events).toEqual([]);
  });

  it("captureVisibleTab serves only the shown space and needs <all_urls> or the grant", async () => {
    const shown = tabAt("personal", "https://example.com/", { title: "Home" });
    const other = tabAt("second", "https://example.com/second");
    const { bridge, controller, channel } = setUp(
      [spaceAt("personal"), spaceAt("second")],
      [shown, other],
    );
    const contents = controller.load(shown.id);
    controller.show("personal", shown.id);
    const personalWindow = bridge.windowIdOf("personal");
    const capture = (extensionId: string, args: unknown[]) =>
      channel.call(
        "tabs",
        callerFor(extensionId, PERSONAL, "worker"),
        "captureVisibleTab",
        args,
      );

    await expect(capture(EVERY, [])).resolves.toBe(
      `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`,
    );
    await expect(
      capture(EVERY, [personalWindow, { format: "jpeg" }]),
    ).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from("jpeg-92").toString("base64")}`,
    );
    await expect(
      capture(EVERY, [{ format: "jpeg", quality: 40 }]),
    ).resolves.toBe(
      `data:image/jpeg;base64,${Buffer.from("jpeg-40").toString("base64")}`,
    );
    // Only the shown space can be captured.
    await expect(capture(EVERY, [bridge.windowIdOf("second")])).rejects.toThrow(
      extensionBridgeCopy.notShown,
    );
    await expect(capture(EVERY, [404])).rejects.toThrow(
      extensionBridgeCopy.noWindow(404),
    );
    // Host access to every site, or the grant on the shown tab.
    await expect(capture(NONE, [])).rejects.toThrow(
      extensionBridgeCopy.cantCapture,
    );
    await expect(capture(HOSTS, [])).rejects.toThrow(
      extensionBridgeCopy.cantCapture,
    );
    bridge.grantActiveTab(PERSONAL, NONE, contents.id);
    await expect(capture(NONE, [])).resolves.toContain(
      "data:image/png;base64,",
    );
    // A shown tab without a view has nothing to capture.
    controller.views.delete(shown.id);
    await expect(capture(EVERY, [])).rejects.toThrow(
      extensionBridgeCopy.cantCapture,
    );
  });
});

describe("extension tab and window changes", () => {
  it("agent-held refusals and URL rules", async () => {
    const mine = tabAt("personal", "https://example.com/");
    const agent = tabAt("robot", "https://example.com/agent");
    const granted = tabAt("granted", "https://example.com/granted");
    const { bridge, controller, channel } = setUp(
      [
        spaceAt("personal"),
        spaceAt("robot", { kind: "agent", owner: "agent" }),
        spaceAt("granted", { access: "granted" }),
      ],
      [mine, agent, granted],
    );
    const contents = controller.load(mine.id);
    controller.show("personal", mine.id);
    const caller = callerFor(ALL, PERSONAL, "tab", contents);
    const held = [bridge.numericId(agent.id)!, bridge.numericId(granted.id)!];

    for (const id of held) {
      const changes: [string, unknown[]][] = [
        ["update", [id, { url: "https://example.com/other" }]],
        ["remove", [id]],
        ["reload", [id]],
        ["move", [id, { index: 0 }]],
        ["goBack", [id]],
        ["goForward", [id]],
        ["setZoom", [id, 1.5]],
        ["duplicate", [id]],
      ];
      for (const [method, args] of changes)
        await expect(channel.run("tabs", caller, method, args)).rejects.toThrow(
          extensionBridgeCopy.agentTab,
        );
    }
    // Nothing changed before the refusal.
    expect(controller.closeTab).not.toHaveBeenCalled();
    expect(controller.moveTab).not.toHaveBeenCalled();
    expect(controller.dispatch).not.toHaveBeenCalled();
    expect(controller.openExtensionTab).not.toHaveBeenCalled();

    for (const url of [
      "javascript:alert(1)",
      "file:///etc/hosts",
      "chrome://settings",
      "data:text/html,<p>hi</p>",
      `chrome-extension://${HOSTS}/page.html`,
      "https://someone:secret@example.com/",
    ]) {
      await expect(
        channel.run("tabs", caller, "create", [{ url }]),
      ).rejects.toThrow(extensionBridgeCopy.cantOpen);
      await expect(
        channel.run("tabs", caller, "update", [
          bridge.numericId(mine.id),
          { url },
        ]),
      ).rejects.toThrow(extensionBridgeCopy.cantOpen);
    }

    // A relative URL is one of the extension's own pages.
    const own = (await channel.run("tabs", caller, "create", [
      { url: "options.html" },
    ])) as BridgeTab;
    expect(own.url).toBe(`chrome-extension://${ALL}/options.html`);
    // about:blank opens the new tab page.
    const blank = (await channel.run("tabs", caller, "create", [
      { url: "about:blank" },
    ])) as BridgeTab;
    expect(blank).toMatchObject({ url: NEW_TAB_URL, title: "New tab" });
    const sent = (await channel.run("tabs", caller, "update", [
      bridge.numericId(mine.id),
      { url: "about:blank" },
    ])) as BridgeTab;
    expect(sent.url).toBe(NEW_TAB_URL);
  });

  it("no tabs ever go to agent spaces", async () => {
    const mine = tabAt("personal", "https://example.com/");
    const agent = tabAt("robot", "https://example.com/agent");
    const { bridge, controller, channel, host } = setUp(
      [
        spaceAt("personal"),
        spaceAt("robot", { kind: "agent", owner: "agent" }),
      ],
      [mine, agent],
    );
    host.options.set(ALL, "options.html");
    controller.show("personal", mine.id);
    controller.emit();
    const worker = callerFor(ALL, PERSONAL, "worker");
    const spaceOf = (id: number) =>
      controller.state.tabs.find((tab) => bridge.numericId(tab.id) === id)
        ?.spaceId;

    const aimed = (await channel.run("tabs", worker, "create", [
      { windowId: bridge.windowIdOf("robot"), url: "https://example.com/a" },
    ])) as BridgeTab;
    expect(spaceOf(aimed.id)).toBe("personal");
    // The agent space is shown, so the personal space shown last takes it.
    controller.show("robot", agent.id);
    controller.emit();
    const next = (await channel.run("tabs", worker, "create", [
      { url: "https://example.com/b" },
    ])) as BridgeTab;
    expect(spaceOf(next.id)).toBe("personal");
    const window = (await channel.run("windows", worker, "create", [
      { url: "https://example.com/c" },
    ])) as BridgeWindow;
    expect(window.id).toBe(bridge.windowIdOf("personal"));
    expect(
      window.tabs?.some((tab) => tab.url === "https://example.com/c"),
    ).toBe(true);
    await channel.run("runtime", worker, "openOptionsPage");
    expect(
      controller.state.tabs.find(
        (tab) => tab.url === `chrome-extension://${ALL}/options.html`,
      )?.spaceId,
    ).toBe("personal");
    expect(controller.state.activeSpaceId).toBe("robot");

    // A session whose only spaces an agent holds has nowhere to put a tab.
    const held = setUp(
      [
        spaceAt("robot", { kind: "agent", owner: "agent" }),
        spaceAt("granted", { access: "granted" }),
      ],
      [tabAt("robot", "https://example.com/")],
    );
    held.host.options.set(ALL, "options.html");
    const calls: [string, string, unknown[]][] = [
      ["tabs", "create", [{ url: "https://example.com/" }]],
      ["windows", "create", [{ url: "https://example.com/" }]],
      ["runtime", "openOptionsPage", []],
    ];
    for (const [api, method, args] of calls)
      await expect(
        held.channel.run(api, callerFor(ALL, PERSONAL, "worker"), method, args),
      ).rejects.toThrow(extensionBridgeCopy.noSpace);
    expect(held.controller.openExtensionTab).not.toHaveBeenCalled();
  });

  it("the windows.create choice between an extension window and tabs", async () => {
    const mine = tabAt("personal", "https://example.com/");
    const { bridge, controller, channel } = setUp(
      [spaceAt("personal")],
      [mine],
    );
    const contents = controller.load(mine.id);
    controller.show("personal", mine.id);
    const caller = callerFor(ALL, PERSONAL, "tab", contents);

    // Until the popups are built there are no extension windows.
    await expect(
      channel.run("windows", caller, "create", [
        { type: "popup", url: "page.html" },
      ]),
    ).rejects.toThrow(extensionBridgeCopy.notSupported);
    const opener = new FakeOpener();
    bridge.setWindowOpener(opener);

    const popup = (await channel.run("windows", caller, "create", [
      {
        type: "popup",
        url: `chrome-extension://${ALL}/page.html`,
        left: 20,
        top: 30,
        width: 500,
        height: 400,
      },
    ])) as BridgeWindow;
    expect(opener.openWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: ALL,
        partition: PERSONAL,
        url: `chrome-extension://${ALL}/page.html`,
        left: 20,
        top: 30,
        width: 500,
        height: 400,
        focused: true,
      }),
    );
    expect(popup).toMatchObject({
      id: opener.windows[0].windowId,
      type: "popup",
      left: 20,
      top: 30,
      width: 500,
      height: 400,
    });
    expect(popup.id).not.toBe(bridge.windowIdOf("personal"));
    // A panel holding one of its own pages is an extension window too.
    await channel.run("windows", caller, "create", [
      { type: "panel", url: ["panel.html"] },
    ]);
    expect(opener.windows[1].url).toBe(`chrome-extension://${ALL}/panel.html`);

    // A normal window, another URL or no URL opens tabs instead.
    const before = controller.state.tabs.length;
    for (const options of [
      { type: "normal", url: `chrome-extension://${ALL}/page.html` },
      { type: "popup", url: "https://example.com/site" },
      { type: "popup" },
    ]) {
      const made = (await channel.run("windows", caller, "create", [
        options,
      ])) as BridgeWindow;
      expect(made.id).toBe(bridge.windowIdOf("personal"));
      expect(made.tabs).toBeDefined();
    }
    expect(opener.openWindow).toHaveBeenCalledTimes(2);
    expect(controller.state.tabs.length).toBe(before + 3);
    expect(controller.state.tabs.at(-1)!.url).toBe(HOME_URL);

    // At most four windows per extension.
    await channel.run("windows", caller, "create", [
      { type: "popup", url: "three.html" },
    ]);
    await channel.run("windows", caller, "create", [
      { type: "popup", url: "four.html" },
    ]);
    await expect(
      channel.run("windows", caller, "create", [
        { type: "popup", url: "five.html" },
      ]),
    ).rejects.toThrow(extensionBridgeCopy.tooManyWindows);
    expect(opener.windows).toHaveLength(4);

    // Kamapathy has no incognito windows and moves no tab into a window.
    await expect(
      channel.run("windows", caller, "create", [{ incognito: true }]),
    ).rejects.toThrow(extensionBridgeCopy.notSupported);
    await expect(
      channel.run("windows", caller, "create", [
        { tabId: bridge.numericId(mine.id) },
      ]),
    ).rejects.toThrow(extensionBridgeCopy.notSupported);
  });

  it("only popups, extension windows and extension tabs switch the shown space", async () => {
    const mine = tabAt("personal", "https://example.com/");
    const there = tabAt("second", "https://example.com/second");
    const { bridge, controller, channel } = setUp(
      [spaceAt("personal"), spaceAt("second")],
      [mine, there],
    );
    controller.show("personal", mine.id);
    controller.emit();
    const second = bridge.windowIdOf("second")!;
    const worker = callerFor(ALL, PERSONAL, "worker");

    const made = (await channel.run("tabs", worker, "create", [
      { windowId: second, url: "https://example.com/new", active: true },
    ])) as BridgeTab;
    expect(made.active).toBe(false);
    expect(controller.state.activeSpaceId).toBe("personal");
    await channel.run("tabs", worker, "update", [
      bridge.numericId(there.id),
      { active: true },
    ]);
    expect(controller.state.activeSpaceId).toBe("personal");
    await channel.run("windows", worker, "update", [second, { focused: true }]);
    expect(controller.state.activeSpaceId).toBe("personal");
    expect(controller.dispatch).not.toHaveBeenCalled();
    // In the shown space a worker's tab still becomes the shown tab.
    const here = (await channel.run("tabs", worker, "create", [
      { url: "https://example.com/here" },
    ])) as BridgeTab;
    expect(here.active).toBe(true);
    expect(controller.state.activeSpaceId).toBe("personal");

    // A popup, an extension window or an extension tab may switch.
    const popup = callerFor(ALL, PERSONAL, "popup");
    const shown = (await channel.run("tabs", popup, "create", [
      { windowId: second, url: "https://example.com/popup", active: true },
    ])) as BridgeTab;
    expect(shown.active).toBe(true);
    expect(controller.state.activeSpaceId).toBe("second");
    controller.show("personal", mine.id);
    controller.emit();
    await channel.run("windows", popup, "update", [second, { focused: true }]);
    expect(controller.state.activeSpaceId).toBe("second");
  });

  it("move stays within a window, and remove closes tabs without closing Kamapathy's window", async () => {
    const first = tabAt("personal", "https://example.com/one");
    const second = tabAt("personal", "https://example.com/two");
    const only = tabAt("second", "https://example.com/only");
    const { bridge, controller, channel } = setUp(
      [spaceAt("personal"), spaceAt("second")],
      [first, second, only],
    );
    const contents = controller.load(first.id);
    controller.show("personal", first.id);
    const caller = callerFor(ALL, PERSONAL, "tab", contents);
    const moving = bridge.numericId(second.id)!;
    const closing = bridge.numericId(only.id)!;

    await expect(
      channel.run("tabs", caller, "move", [
        [moving],
        { windowId: bridge.windowIdOf("second"), index: 0 },
      ]),
    ).rejects.toThrow(extensionBridgeCopy.notSupported);
    expect(controller.moveTab).not.toHaveBeenCalled();

    const moved = (await channel.run("tabs", caller, "move", [
      moving,
      { index: 0 },
    ])) as BridgeTab;
    expect(moved.index).toBe(0);
    expect(controller.moveTab).toHaveBeenCalledWith(second.id, 0);
    expect(
      bridge
        .model(PERSONAL)
        .windows.find((window) => window.spaceId === "personal")!
        .tabs.map((tab) => tab.tabId),
    ).toEqual([second.id, first.id]);

    // The last tab of a space closes as the person's would, so the space
    // keeps a blank tab and Kamapathy's window stays open.
    await channel.run("tabs", caller, "remove", [closing]);
    expect(controller.closeTab).toHaveBeenCalledWith(only.id, "person");
    expect(controller.dispatch).not.toHaveBeenCalled();
    const left = controller.state.tabs.filter(
      (tab) => tab.spaceId === "second",
    );
    expect(left).toHaveLength(1);
    expect(left[0].url).toBe(HOME_URL);
  });

  it("the rest of the change side reaches the tab, its view and its strip", async () => {
    const first = tabAt("personal", "https://example.com/one", {
      title: "One",
    });
    const resting = tabAt("personal", "https://example.com/two");
    const { bridge, controller, channel, host } = setUp(
      [spaceAt("personal")],
      [first, resting],
    );
    const contents = controller.load(first.id);
    controller.show("personal", first.id);
    const caller = callerFor(ALL, PERSONAL, "tab", contents);
    const id = bridge.numericId(first.id)!;
    const pins = () =>
      controller.dispatch.mock.calls.filter(
        ([action]) => action.type === "tab:pin",
      ).length;

    const copy = (await channel.run("tabs", caller, "duplicate", [
      id,
    ])) as BridgeTab;
    expect(copy).toMatchObject({
      url: "https://example.com/one",
      index: 1,
      active: true,
    });
    await channel.run("tabs", caller, "update", [
      id,
      { pinned: true, muted: true },
    ]);
    expect(
      controller.state.tabs.find((tab) => tab.id === first.id)!.pinned,
    ).toBe(true);
    expect(contents.setAudioMuted).toHaveBeenCalledWith(true);
    // Pinning what is pinned changes nothing.
    await channel.run("tabs", caller, "update", [id, { pinned: true }]);
    expect(pins()).toBe(1);

    await channel.run("tabs", caller, "setZoom", [id, 1.5]);
    expect(contents.setZoomFactor).toHaveBeenCalledWith(1.5);
    await channel.run("tabs", caller, "setZoom", [id, 0]);
    expect(contents.setZoomFactor).toHaveBeenLastCalledWith(1);
    await expect(
      channel.run("tabs", caller, "setZoom", [id, 9]),
    ).rejects.toThrow(extensionBridgeCopy.invalid("tabs.setZoom"));
    // Only the zoom settings Kamapathy has.
    await expect(
      channel.run("tabs", caller, "setZoomSettings", [id, { mode: "manual" }]),
    ).rejects.toThrow(extensionBridgeCopy.notSupported);
    await expect(
      channel.run("tabs", caller, "setZoomSettings", [
        id,
        { scope: "per-origin" },
      ]),
    ).resolves.toBeUndefined();

    await channel.run("tabs", caller, "reload", [id, { bypassCache: true }]);
    expect(contents.reloadIgnoringCache).toHaveBeenCalled();
    controller.show("personal", first.id);
    await channel.run("tabs", caller, "reload");
    expect(contents.reload).toHaveBeenCalled();
    // A tab without a view reloads through the window.
    await channel.run("tabs", caller, "reload", [bridge.numericId(resting.id)]);
    expect(controller.reloaded).toEqual([resting.id]);
    await channel.run("tabs", caller, "goBack", [id]);
    expect(contents.navigationHistory.goBack).toHaveBeenCalled();
    await channel.run("tabs", caller, "goForward", [id]);
    expect(contents.navigationHistory.goForward).toHaveBeenCalled();

    // highlight activates the first listed index.
    const window = (await channel.run("tabs", caller, "highlight", [
      { tabs: [2] },
    ])) as BridgeWindow;
    expect(window.tabs?.find((tab) => tab.active)?.index).toBe(2);

    // The Extensions modal opens an options page the same way.
    host.options.set(ALL, "options.html");
    const options = bridge.openOptionsPage(ALL, PERSONAL, true);
    expect(options.spaceId).toBe("personal");
    expect(options.url).toBe(`chrome-extension://${ALL}/options.html`);
    expect(() => bridge.openOptionsPage(NONE, PERSONAL, true)).toThrow(
      extensionBridgeCopy.noOptions,
    );
  });

  it("windows.remove closes only extension windows", async () => {
    const mine = tabAt("personal", "https://example.com/");
    const { bridge, controller, channel } = setUp(
      [spaceAt("personal")],
      [mine],
    );
    const contents = controller.load(mine.id);
    controller.show("personal", mine.id);
    const caller = callerFor(ALL, PERSONAL, "tab", contents);
    const opener = new FakeOpener();
    bridge.setWindowOpener(opener);

    await expect(
      channel.run("windows", caller, "remove", [bridge.windowIdOf("personal")]),
    ).rejects.toThrow(extensionBridgeCopy.cantClose);
    const own = (await channel.run("windows", caller, "create", [
      { type: "popup", url: "page.html" },
    ])) as BridgeWindow;
    const theirs = (await channel.run(
      "windows",
      callerFor(EVERY, PERSONAL, "tab", contents),
      "create",
      [{ type: "popup", url: `chrome-extension://${EVERY}/page.html` }],
    )) as BridgeWindow;

    // Only its own windows, and never another extension's.
    await expect(
      channel.run("windows", caller, "remove", [theirs.id]),
    ).rejects.toThrow(extensionBridgeCopy.cantClose);
    expect(opener.closeWindow).not.toHaveBeenCalled();
    await channel.run("windows", caller, "remove", [own.id]);
    expect(opener.closeWindow).toHaveBeenCalledWith(own.id);
    expect(opener.windows.map((item) => item.windowId)).toEqual([theirs.id]);
  });
});

describe("extension action buttons and popups", () => {
  it("action state per tab with manifest defaults, badges cut to 4 characters and icons over 128 px refused", async () => {
    const first = tabAt("personal", "https://example.com/one", {
      title: "One",
    });
    const second = tabAt("personal", "https://example.com/two", {
      title: "Two",
    });
    const { bridge, controller, channel, host } = setUp(
      [spaceAt("personal")],
      [first, second],
    );
    const page = controller.load(first.id);
    controller.load(second.id);
    controller.show("personal", first.id);
    host.manifests.set(ALL, {
      name: "All tabs",
      actionTitle: "Count the tabs",
      popup: "popup.html",
      actionIcons: {
        16: "icons/16.png",
        48: "icons/48.png",
        256: "icons/256.png",
      },
      icons: { 128: "icons/128.png" },
    });
    imageSizes.set("/tmp/extension/icons/16.png", 16);
    imageSizes.set("/tmp/extension/icons/48.png", 48);
    imageSizes.set("/tmp/extension/icons/128.png", 128);
    imageSizes.set("/tmp/extension/icons/256.png", 256);

    // The manifest's defaults, with the largest action icon of 128 px or less.
    expect(bridge.actionState(PERSONAL, ALL)).toEqual({
      title: "Count the tabs",
      icon: "data:image/png;base64,/tmp/extension/icons/48.png",
      badge: "",
      badgeColor: "#5f6368",
      popup: `chrome-extension://${ALL}/popup.html`,
      enabled: true,
    });
    // An extension with no action keys falls back to its name.
    host.manifests.set(NONE, { name: "Nothing" });
    expect(bridge.actionState(PERSONAL, NONE)).toMatchObject({
      title: "Nothing",
      popup: "",
    });
    expect(bridge.actionState(PERSONAL, NONE).icon).toBeUndefined();

    const caller = callerFor(ALL, PERSONAL, "worker");
    const firstId = bridge.numericId(first.id)!;
    const secondId = bridge.numericId(second.id)!;
    await channel.run("action", caller, "setTitle", [
      { title: "On this tab", tabId: firstId },
    ]);
    await channel.run("action", caller, "setBadgeText", [
      { text: "12345", tabId: firstId },
    ]);
    await channel.run("action", caller, "setBadgeBackgroundColor", [
      { color: [255, 0, 0, 255], tabId: firstId },
    ]);
    await channel.run("action", caller, "setBadgeTextColor", [
      { color: "#000000" },
    ]);
    await channel.run("action", caller, "setPopup", [
      { popup: "other.html", tabId: firstId },
    ]);
    expect(bridge.actionState(PERSONAL, ALL, firstId)).toMatchObject({
      title: "On this tab",
      badge: "12345",
      badgeColor: "#ff0000",
      badgeTextColor: "#000000",
      popup: `chrome-extension://${ALL}/other.html`,
    });
    // Another tab keeps the defaults, plus what was set for every tab.
    expect(bridge.actionState(PERSONAL, ALL, secondId)).toMatchObject({
      title: "Count the tabs",
      badge: "",
      badgeColor: "#5f6368",
      badgeTextColor: "#000000",
      popup: `chrome-extension://${ALL}/popup.html`,
    });

    // The getters read the tab's value, else the default.
    const ask = (method: string, args: unknown[] = [{}]) =>
      channel.run("action", caller, method, args);
    expect(await ask("getTitle", [{ tabId: firstId }])).toBe("On this tab");
    expect(await ask("getTitle")).toBe("Count the tabs");
    expect(await ask("getBadgeText", [{ tabId: firstId }])).toBe("12345");
    expect(await ask("getBadgeText")).toBe("");
    expect(await ask("getBadgeBackgroundColor", [{ tabId: firstId }])).toEqual([
      255, 0, 0, 255,
    ]);
    expect(await ask("getBadgeTextColor")).toEqual([0, 0, 0, 255]);
    expect(await ask("getPopup", [{ tabId: secondId }])).toBe(
      `chrome-extension://${ALL}/popup.html`,
    );
    expect(await ask("getUserSettings", [])).toEqual({ isOnToolbar: false });
    expect(await ask("isEnabled", [firstId])).toBe(true);
    await ask("disable", [firstId]);
    expect(await ask("isEnabled", [firstId])).toBe(false);
    expect(await ask("isEnabled", [secondId])).toBe(true);
    await ask("enable", [firstId]);
    expect(await ask("isEnabled", [firstId])).toBe(true);

    // A tab's own values end when it commits another document.
    page.emit("did-navigate");
    expect(bridge.actionState(PERSONAL, ALL, firstId)).toMatchObject({
      title: "Count the tabs",
      badge: "",
      badgeColor: "#5f6368",
      popup: `chrome-extension://${ALL}/popup.html`,
    });

    // Icons come as PNG data URLs or paths inside the extension.
    imageSizes.set("data:image/png;base64,small", 32);
    imageSizes.set("data:image/png;base64,big", 129);
    await channel.run("action", caller, "setIcon", [
      { images: { "32": "data:image/png;base64,small" } },
    ]);
    expect(bridge.actionState(PERSONAL, ALL).icon).toBe(
      "data:image/png;base64,small",
    );
    await expect(
      channel.run("action", caller, "setIcon", [
        { images: { "129": "data:image/png;base64,big" } },
      ]),
    ).rejects.toThrow(extensionBridgeCopy.iconTooLarge);
    await expect(
      channel.run("action", caller, "setIcon", [{ path: "icons/256.png" }]),
    ).rejects.toThrow(extensionBridgeCopy.iconTooLarge);
    // The last icon it set stays.
    expect(bridge.actionState(PERSONAL, ALL).icon).toBe(
      "data:image/png;base64,small",
    );
    await expect(
      channel.run("action", caller, "setIcon", [{ path: "../other/48.png" }]),
    ).rejects.toThrow(extensionBridgeCopy.invalid("action.setIcon"));
    await channel.run("action", caller, "setIcon", [{ path: "icons/16.png" }]);
    expect(bridge.actionState(PERSONAL, ALL).icon).toBe(
      "data:image/png;base64,/tmp/extension/icons/16.png",
    );
    // Nothing to set puts the manifest's icon back.
    await channel.run("action", caller, "setIcon", [{}]);
    expect(bridge.actionState(PERSONAL, ALL).icon).toBe(
      "data:image/png;base64,/tmp/extension/icons/48.png",
    );

    // A popup outside the extension is refused, and "" means none.
    for (const popup of [
      "https://example.com/popup.html",
      `chrome-extension://${NONE}/popup.html`,
    ])
      await expect(
        channel.run("action", caller, "setPopup", [{ popup }]),
      ).rejects.toThrow(extensionBridgeCopy.cantOpen);
    await channel.run("action", caller, "setPopup", [{ popup: "" }]);
    expect(bridge.actionState(PERSONAL, ALL).popup).toBe("");
  });

  it("a click opens the popup or fires onClicked with the tab, and grants activeTab until the tab navigates", async () => {
    const mine = tabAt("personal", "https://example.com/page", {
      title: "Page",
    });
    const { bridge, controller, channel, host } = setUp(
      [spaceAt("personal")],
      [mine],
    );
    const contents = controller.load(mine.id);
    controller.show("personal", mine.id);
    const popups = new FakePopups();
    bridge.setPopups(popups as unknown as ExtensionPopups);
    host.manifests.set(ALL, { name: "All tabs", popup: "popup.html" });
    host.manifests.set(NONE, { name: "Nothing" });

    // With a popup, the click opens it and nothing else.
    await bridge.click(ALL, ANCHOR);
    expect(popups.togglePopup).toHaveBeenCalledWith({
      extensionId: ALL,
      partition: PERSONAL,
      spaceId: "personal",
      url: `chrome-extension://${ALL}/popup.html`,
      anchor: ANCHOR,
    });
    expect(channel.take(ALL)).toEqual([]);
    expect(bridge.access(PERSONAL, ALL).activeTabs.has(contents.id)).toBe(true);

    // Without one, the worker hears onClicked with the tab it may now read.
    await bridge.click(NONE, ANCHOR);
    expect(popups.togglePopup).toHaveBeenCalledTimes(1);
    const [clicked] = channel.take(NONE);
    expect(clicked).toMatchObject({
      partition: PERSONAL,
      extensionId: NONE,
      event: "action.onClicked",
    });
    expect(clicked.args[0]).toMatchObject({
      id: contents.id,
      url: "https://example.com/page",
      title: "Page",
      active: true,
    });

    // The grant ends when the tab loads another document.
    contents.emit("did-navigate");
    expect(bridge.access(PERSONAL, NONE).activeTabs.size).toBe(0);
    expect(bridge.access(PERSONAL, ALL).activeTabs.size).toBe(0);

    // A disabled button does nothing at all.
    await channel.run(
      "action",
      callerFor(NONE, PERSONAL, "worker"),
      "disable",
      [contents.id],
    );
    channel.take();
    await bridge.click(NONE, ANCHOR);
    expect(channel.take(NONE)).toEqual([]);
    expect(bridge.access(PERSONAL, NONE).activeTabs.size).toBe(0);
    // An extension that runs in no session there is not clickable.
    await bridge.click(idAt(9), ANCHOR);
    expect(channel.take()).toEqual([]);
    expect(popups.togglePopup).toHaveBeenCalledTimes(1);
  });

  it("openPopup works only while the window is focused and the shown space runs the extension", async () => {
    const mine = tabAt("personal", "https://example.com/page");
    const isolated = tabAt("isolated", "https://example.com/agent");
    const apart = tabAt("apart", "https://example.com/apart");
    const { bridge, controller, channel, host } = setUp(
      [
        spaceAt("personal"),
        spaceAt("isolated", {
          kind: "agent",
          owner: "human",
          signIns: "separate",
        }),
        spaceAt("apart", { signIns: "separate" }),
      ],
      [mine, isolated, apart],
    );
    controller.load(mine.id);
    controller.show("personal", mine.id);
    const popups = new FakePopups();
    bridge.setPopups(popups as unknown as ExtensionPopups);
    host.manifests.set(ALL, { name: "All tabs", popup: "popup.html" });
    host.manifests.set(NONE, { name: "Nothing" });
    const caller = callerFor(ALL, PERSONAL, "worker");
    const open = () => channel.run("action", caller, "openPopup", [{}]);

    controller.fakeWindow.focused = false;
    await expect(open()).rejects.toThrow(extensionBridgeCopy.notFocused);
    controller.fakeWindow.focused = true;

    // An isolated space runs no extension, and another session is not ours.
    controller.show("isolated", isolated.id);
    await expect(open()).rejects.toThrow(extensionBridgeCopy.noSpace);
    controller.show("apart", apart.id);
    await expect(open()).rejects.toThrow(extensionBridgeCopy.noSpace);
    controller.show("personal", mine.id);

    // An extension without a popup has nothing to open.
    await expect(
      channel.run("action", callerFor(NONE, PERSONAL, "worker"), "openPopup", [
        {},
      ]),
    ).rejects.toThrow(extensionBridgeCopy.noPopup);

    // Unpinned, it hangs under the puzzle button; pinned, under its own.
    const puzzle: ExtensionAnchor = { x: 1100, y: 40, width: 32, height: 32 };
    bridge.setAnchors({ [ALL]: ANCHOR }, puzzle);
    await open();
    expect(popups.togglePopup).toHaveBeenLastCalledWith(
      expect.objectContaining({ extensionId: ALL, anchor: puzzle }),
    );
    host.entry(ALL)!.pinned = true;
    await open();
    expect(popups.togglePopup).toHaveBeenLastCalledWith(
      expect.objectContaining({ extensionId: ALL, anchor: ANCHOR }),
    );
    // Without any anchor the popup still opens, at the toolbar's end.
    bridge.setAnchors({}, null);
    await open();
    expect(popups.togglePopup).toHaveBeenCalledTimes(3);
  });

  it("buttons are disabled in isolated and agent-held spaces", async () => {
    const mine = tabAt("personal", "https://example.com/page");
    const isolated = tabAt("isolated", "https://example.com/agent");
    const held = tabAt("held", "https://example.com/held");
    const { bridge, controller, channel, host } = setUp(
      [
        spaceAt("personal"),
        spaceAt("isolated", {
          kind: "agent",
          owner: "agent",
          signIns: "separate",
        }),
        spaceAt("held", { access: "granted" }),
      ],
      [mine, isolated, held],
    );
    controller.load(mine.id);
    controller.load(held.id);
    controller.show("personal", mine.id);
    const popups = new FakePopups();
    bridge.setPopups(popups as unknown as ExtensionPopups);
    for (const id of [ALL, HOSTS, NONE, EVERY])
      host.manifests.set(id, { name: `Extension ${id.slice(0, 4)}` });
    host.manifests.set(ALL, { name: "All tabs", popup: "popup.html" });

    expect(bridge.toolbar(controller.state).disabled).toBeUndefined();

    // An isolated space keeps every extension out, and shows defaults.
    controller.show("isolated", isolated.id);
    const isolatedBar = bridge.toolbar(controller.state);
    expect(isolatedBar.disabled).toBe("isolated");
    expect(isolatedBar.actions.map((action) => action.id)).toEqual([
      ALL,
      HOSTS,
      NONE,
      EVERY,
    ]);
    expect(isolatedBar.actions[0]).toMatchObject({
      title: "All tabs",
      badge: "",
      enabled: true,
    });
    await bridge.click(ALL, ANCHOR);

    // A space an agent holds is read-only for extensions.
    controller.show("held", held.id);
    expect(bridge.toolbar(controller.state).disabled).toBe("agent");
    await bridge.click(ALL, ANCHOR);
    expect(popups.togglePopup).not.toHaveBeenCalled();
    expect(channel.take()).toEqual([]);

    // Back in the person's own space the click lands.
    controller.show("personal", mine.id);
    await bridge.click(ALL, ANCHOR);
    expect(popups.togglePopup).toHaveBeenCalledTimes(1);
  });

  it("the toolbar lists pinned extensions first, in pin order, with the shown tab's title, icon and badge", async () => {
    const mine = tabAt("personal", "https://example.com/page");
    const second = tabAt("personal", "https://example.com/second");
    const apart = tabAt("work", "https://example.com/work");
    const { bridge, controller, channel, host } = setUp(
      [spaceAt("personal"), spaceAt("work", { signIns: "separate" })],
      [mine, second, apart],
    );
    const contents = controller.load(mine.id);
    controller.load(second.id);
    controller.show("personal", mine.id);
    host.manifests.set(ALL, {
      name: "All tabs",
      actionTitle: "Count the tabs",
      actionIcons: { 48: "icons/48.png" },
    });
    host.manifests.set(HOSTS, { name: "One site" });
    host.manifests.set(NONE, { name: "Nothing" });
    host.manifests.set(EVERY, { name: "Every site" });
    imageSizes.set("/tmp/extension/icons/48.png", 48);
    // extensions.json holds them in this order: ALL, HOSTS, NONE, EVERY.
    host.entry(NONE)!.pinned = true;
    host.entry(ALL)!.pinned = true;

    const changes: number[] = [];
    const off = bridge.onToolbarChange(() => changes.push(1));
    const bar = bridge.toolbar(controller.state);
    expect(bar.disabled).toBeUndefined();
    expect(bar.actions.map((action) => action.id)).toEqual([
      ALL,
      NONE,
      HOSTS,
      EVERY,
    ]);
    expect(bar.actions.map((action) => action.pinned)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(bar.actions[0]).toEqual<ExtensionAction>({
      id: ALL,
      name: "All tabs",
      title: "Count the tabs",
      icon: "data:image/png;base64,/tmp/extension/icons/48.png",
      badge: "",
      badgeColor: "#5f6368",
      enabled: true,
      pinned: true,
    });

    // The shown tab's own title and badge, cut to four characters.
    const caller = callerFor(ALL, PERSONAL, "worker");
    await channel.run("action", caller, "setBadgeText", [
      { text: "12345", tabId: contents.id },
    ]);
    await channel.run("action", caller, "setTitle", [
      { title: "On this tab", tabId: contents.id },
    ]);
    expect(changes).toHaveLength(2);
    expect(bridge.toolbar(controller.state).actions[0]).toMatchObject({
      badge: "1234",
      title: "On this tab",
    });
    // Another tab of the same space has its own state.
    controller.show("personal", second.id);
    expect(bridge.toolbar(controller.state).actions[0]).toMatchObject({
      badge: "",
      title: "Count the tabs",
    });

    // An extension that is off has no button.
    host.entry(HOSTS)!.enabled = false;
    expect(
      bridge.toolbar(controller.state).actions.map((action) => action.id),
    ).toEqual([ALL, NONE, EVERY]);
    // A space with its own sign-ins shows what runs in that session.
    controller.show("work", apart.id);
    expect(
      bridge.toolbar(controller.state).actions.map((action) => action.id),
    ).toEqual([ALL]);

    off();
    await channel.run("action", caller, "setBadgeText", [{ text: "7" }]);
    expect(changes).toHaveLength(2);
  });
});
