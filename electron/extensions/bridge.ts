import type { BrowserWindow, WebContents } from "electron";
import {
  agentHeld,
  coversAllHosts,
  diffModels,
  eventFor,
  extensionIdOf,
  NEW_TAB_URL,
  PLACEHOLDER_BASE,
  queryTabs,
  runsExtensions,
  tabObject,
  windowObject,
  WINDOW_ID_CURRENT,
  WINDOW_ID_NONE,
  type Access,
  type BridgeTab,
  type BridgeWindow,
  type ModelChange,
  type SessionModel,
  type TabModel,
  type TabQuery,
  type WindowModel,
} from "../../shared/extensions";
import { HOME_URL } from "../../shared/state";
import type {
  BrowserAction,
  BrowserState,
  ClosedBy,
  Space,
  Tab,
} from "../../shared/types";
import { extensionBridgeCopy } from "../../src/copy";
import { EVENT_NAMES } from "./chrome-api";
import {
  BridgeError,
  type ApiHandler,
  type Caller,
  type Surface,
} from "./channel";
import type { ExtensionChannel } from "./channel";
import type { ExtensionHost } from "./host";
import type { ExtensionTabOptions } from "../controller";

// What the bridges need from the window's controller.
export interface BridgeController {
  readonly state: BrowserState;
  readonly window: BrowserWindow;
  subscribe(listener: (state: BrowserState) => void): () => void;
  partitionOf(spaceId: string): string;
  peekWebContents(tabId: string): WebContents | undefined;
  shownTab(spaceId: string): Tab | undefined;
  tabOfContents(contents: WebContents): Tab | undefined;
  openExtensionTab(
    spaceId: string,
    url: string,
    options?: ExtensionTabOptions,
  ): Tab;
  moveTab(tabId: string, index: number): Tab;
  closeTab(tabId: string, by: ClosedBy): { closed?: string; replacement?: Tab };
  dispatch(action: BrowserAction): Promise<BrowserState>;
}
export interface BridgeDeps {
  host: ExtensionHost;
  channel: ExtensionChannel;
}
// One of an extension's own OS windows, holding one of its pages.
export interface ExtensionWindowInfo {
  windowId: number;
  tabId: number;
  extensionId: string;
  partition: string;
  url: string;
  focused: boolean;
  bounds: { left: number; top: number; width: number; height: number };
}
export interface ExtensionWindowOpener {
  openWindow(request: {
    windowId: number;
    extensionId: string;
    partition: string;
    url: string;
    left?: number;
    top?: number;
    width?: number;
    height?: number;
    focused: boolean;
  }): ExtensionWindowInfo;
  updateWindow(
    windowId: number,
    changes: {
      left?: number;
      top?: number;
      width?: number;
      height?: number;
      focused?: boolean;
    },
  ): ExtensionWindowInfo;
  closeWindow(windowId: number): boolean;
  windowsOf(extensionId: string, partition: string): ExtensionWindowInfo[];
}

// Extensions may open their own pages, http and https without credentials,
// and about:blank. Everything else is refused.
export function allowedExtensionUrl(
  url: string,
  extensionId: string,
): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, `chrome-extension://${extensionId}/`);
  } catch {
    return undefined;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:")
    return parsed.username || parsed.password ? undefined : parsed.href;
  if (parsed.protocol === "about:")
    return parsed.href === "about:blank" ? "about:blank" : undefined;
  if (parsed.protocol === "chrome-extension:")
    return extensionIdOf(parsed.href) === extensionId ? parsed.href : undefined;
  return undefined;
}

// The window changes that move or resize every space's window.
const WINDOW_EVENTS = [
  "focus",
  "blur",
  "resize",
  "move",
  "maximize",
  "unmaximize",
  "minimize",
  "restore",
  "enter-full-screen",
  "leave-full-screen",
] as const;
// The events these bridges send; action's are task 11's.
const BRIDGE_EVENTS = EVENT_NAMES.filter(
  (event) => event.startsWith("tabs.") || event.startsWith("windows."),
);
const ZOOM_SETTINGS = {
  mode: "automatic",
  scope: "per-origin",
  defaultZoomFactor: 1,
} as const;
const NO_GRANTS: ReadonlySet<number> = new Set();
// Spaces shown earlier than this many switches ago no longer count.
const SHOWN_LIMIT = 32;
const MAX_EXTENSION_WINDOWS = 4;
// Section 16's file tabs. Phase 10's isFileUrl replaces this check.
const isFileTab = (url: string) => /^file:/i.test(url);
const key = (partition: string, extensionId: string) =>
  `${partition}\u0000${extensionId}`;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function logError(context: string, error: unknown): void {
  console.error(`${context}:`, messageOf(error));
}
function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}
// Pinned tabs come first, as in the tab strip.
function strip(state: BrowserState, spaceId: string): Tab[] {
  const tabs = state.tabs.filter((tab) => tab.spaceId === spaceId);
  return [
    ...tabs.filter((tab) => tab.pinned),
    ...tabs.filter((tab) => !tab.pinned),
  ];
}
function asInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new BridgeError(extensionBridgeCopy.invalid(name));
  return value;
}
function asObject(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    throw new BridgeError(extensionBridgeCopy.invalid(name));
  return value as Record<string, unknown>;
}
function asBoolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new BridgeError(extensionBridgeCopy.invalid(name));
  return value;
}
const BOOLEAN_KEYS = [
  "active",
  "pinned",
  "audible",
  "muted",
  "highlighted",
  "discarded",
  "autoDiscardable",
  "currentWindow",
  "lastFocusedWindow",
  "frozen",
] as const;
function asQuery(value: unknown): TabQuery {
  const given = asObject(value, "tabs.query");
  const invalid = () =>
    new BridgeError(extensionBridgeCopy.invalid("tabs.query"));
  const query: TabQuery = {};
  for (const name of BOOLEAN_KEYS) {
    const item = given[name];
    if (item === undefined) continue;
    if (typeof item !== "boolean") throw invalid();
    query[name] = item;
  }
  for (const name of ["status", "title", "windowType"] as const) {
    const item = given[name];
    if (item === undefined) continue;
    if (typeof item !== "string") throw invalid();
    query[name] = item;
  }
  for (const name of ["windowId", "index", "groupId"] as const) {
    const item = given[name];
    if (item === undefined) continue;
    if (typeof item !== "number" || !Number.isInteger(item)) throw invalid();
    query[name] = item;
  }
  if (given.url !== undefined) {
    const url = given.url;
    if (typeof url === "string") query.url = url;
    else if (
      Array.isArray(url) &&
      url.every((item): item is string => typeof item === "string")
    )
      query.url = url;
    else throw invalid();
  }
  return query;
}

// Each extension's view of one window's spaces: the models the read side of
// tabs and windows answers from, and the events their changes come out as.
export class ExtensionBridge {
  private readonly deps: BridgeDeps;
  private controller?: BridgeController;
  private offState?: () => void;
  private offWindow?: () => void;
  // Per run, kept for the space's or tab's lifetime.
  private readonly windowIds = new Map<string, number>();
  private readonly placeholders = new Map<string, number>();
  private nextWindowId = 1;
  private nextPlaceholder = 0;
  // The last model sent out per partition, for the next diff.
  private readonly models = new Map<string, SessionModel>();
  // activeTab grants, by partition and extension.
  private readonly grants = new Map<string, Set<number>>();
  private readonly watched = new WeakSet<WebContents>();
  private opener?: ExtensionWindowOpener;
  // Spaces in the order they were last shown, newest first.
  private shownOrder: string[] = [];

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    this.deps.channel.register("tabs", this.onTabs);
    this.deps.channel.register("windows", this.onWindows);
    this.deps.channel.register("runtime", this.onRuntime);
    this.deps.host.onEvent((event) => {
      if (event.type === "unloaded")
        this.grants.delete(key(event.partition, event.id));
      if (event.type === "detached") {
        this.models.delete(event.partition);
        for (const name of [...this.grants.keys()])
          if (name.startsWith(`${event.partition}\u0000`))
            this.grants.delete(name);
      }
    });
  }

  // Main calls this for each window; the returned function unbinds.
  bind(controller: BridgeController): () => void {
    this.unbind();
    this.controller = controller;
    this.shownOrder = [controller.state.activeSpaceId];
    this.offState = controller.subscribe(() => this.onState());
    const refresh = () => this.refresh();
    // One listener per window change, whatever each one is named.
    const window = controller.window as unknown as {
      on(event: string, listener: () => void): unknown;
      removeListener(event: string, listener: () => void): unknown;
    };
    for (const event of WINDOW_EVENTS) window.on(event, refresh);
    this.offWindow = () => {
      for (const event of WINDOW_EVENTS) window.removeListener(event, refresh);
    };
    this.refresh();
    return () => {
      if (this.controller === controller) this.unbind();
    };
  }

  // Task 11 builds the extension windows.
  setWindowOpener(opener: ExtensionWindowOpener): void {
    this.opener = opener;
  }

  // Only the person's own spaces take an extension's tabs: the named
  // window's space when it is one, else the one shown last on that session.
  newTabSpace(partition: string, windowId?: number): string {
    const model = this.model(partition);
    const open = (window: WindowModel) => window.personal && !window.agentHeld;
    const wanted =
      windowId === WINDOW_ID_CURRENT ? this.shownFirst(model) : windowId;
    const named =
      wanted === undefined
        ? undefined
        : model.windows.find((window) => window.id === wanted);
    if (named && open(named)) return named.spaceId;
    for (const spaceId of this.shownOrder) {
      const window = model.windows.find((item) => item.spaceId === spaceId);
      if (window && open(window)) return window.spaceId;
    }
    const any = model.windows.find(open);
    if (!any) throw new BridgeError(extensionBridgeCopy.noSpace);
    return any.spaceId;
  }

  // A worker never switches the shown space.
  canSwitch(caller: Pick<Caller, "surface">): boolean {
    return caller.surface !== "worker";
  }

  openTab(
    from: { extensionId: string; partition: string; surface: Surface },
    url: string,
    options: {
      windowId?: number;
      active?: boolean;
      index?: number;
      pinned?: boolean;
    } = {},
  ): Tab {
    const controller = this.bound();
    const spaceId = this.newTabSpace(from.partition, options.windowId);
    const shown = spaceId === controller.state.activeSpaceId;
    return controller.openExtensionTab(
      spaceId,
      url === "" || url === "about:blank" ? HOME_URL : url,
      {
        active: options.active !== false && (shown || this.canSwitch(from)),
        index: options.index,
        pinned: options.pinned,
      },
    );
  }

  // The Extensions modal opens an options page the same way (task 12).
  openOptionsPage(
    extensionId: string,
    partition: string,
    fromPerson: boolean,
  ): Tab {
    const url = this.optionsUrl(extensionId);
    const shown = this.controller?.state.activeSpaceId;
    const windowId = this.model(partition).windows.find(
      (window) => window.spaceId === shown,
    )?.id;
    return this.openTab(
      { extensionId, partition, surface: fromPerson ? "tab" : "worker" },
      url,
      { windowId },
    );
  }

  model(partition: string): SessionModel {
    const controller = this.controller;
    if (!controller) return { partition, windows: [] };
    const state = controller.state;
    const shape = this.windowShape();
    const windows: WindowModel[] = [];
    for (const space of state.spaces) {
      if (!runsExtensions(space)) continue;
      const own = safely(() => controller.partitionOf(space.id), undefined);
      if (own !== partition) continue;
      const windowId = this.idForSpace(space.id);
      const shownTabId = safely(
        () => controller.shownTab(space.id)?.id,
        undefined,
      );
      windows.push({
        id: windowId,
        spaceId: space.id,
        focused: shape.focused && space.id === state.activeSpaceId,
        agentHeld: agentHeld(space),
        personal: space.kind === "personal",
        state: shape.state,
        bounds: shape.bounds,
        tabs: strip(state, space.id).map((tab, index) =>
          this.tabModel(controller, space, tab, windowId, index, shownTabId),
        ),
      });
    }
    return { partition, windows };
  }

  access(partition: string, extensionId: string): Access {
    const entry = this.deps.host.entry(extensionId);
    return {
      tabs: !!entry?.grantedPermissions.includes("tabs"),
      hosts: entry?.grantedHosts ?? [],
      activeTabs: this.grants.get(key(partition, extensionId)) ?? NO_GRANTS,
    };
  }

  numericId(tabId: string): number | undefined {
    const controller = this.controller;
    if (!controller?.state.tabs.some((tab) => tab.id === tabId))
      return undefined;
    return (
      safely(() => controller.peekWebContents(tabId)?.id, undefined) ??
      this.placeholder(tabId)
    );
  }

  tabIdOf(numericId: number): string | undefined {
    for (const tab of this.controller?.state.tabs ?? [])
      if (this.numericId(tab.id) === numericId) return tab.id;
    return undefined;
  }

  // The person clicked this extension's button on that tab (task 11).
  grantActiveTab(
    partition: string,
    extensionId: string,
    numericTabId: number,
  ): void {
    const name = key(partition, extensionId);
    const grants = this.grants.get(name) ?? new Set<number>();
    grants.add(numericTabId);
    this.grants.set(name, grants);
    const tabId = this.tabIdOf(numericTabId);
    const contents = tabId
      ? safely(() => this.controller?.peekWebContents(tabId), undefined)
      : undefined;
    if (!contents || this.watched.has(contents)) return;
    this.watched.add(contents);
    const id = contents.id;
    // The grant ends when the tab's main frame loads another document.
    const end = () => {
      for (const set of this.grants.values()) set.delete(id);
    };
    contents.on("did-navigate", end);
    contents.once("destroyed", end);
  }

  callerWindowId(caller: Caller): number | undefined {
    const controller = this.controller;
    const contents = caller.contents;
    if (!controller || !contents) return undefined;
    if (caller.surface === "tab") {
      const tab = safely(() => controller.tabOfContents(contents), undefined);
      return tab ? this.windowIdOf(tab.spaceId) : undefined;
    }
    if (caller.surface === "popup") {
      const spaceId = this.deps.host.surfaceOf(contents)?.spaceId;
      return spaceId ? this.windowIdOf(spaceId) : undefined;
    }
    // Task 11 adds extension windows.
    return undefined;
  }

  currentWindowId(caller: Caller): number {
    return this.current(caller, this.model(caller.partition));
  }

  windowIdOf(spaceId: string): number | undefined {
    const known = this.windowIds.get(spaceId);
    if (known !== undefined) return known;
    return this.controller?.state.spaces.some((space) => space.id === spaceId)
      ? this.idForSpace(spaceId)
      : undefined;
  }

  private unbind(): void {
    this.offState?.();
    this.offWindow?.();
    this.offState = undefined;
    this.offWindow = undefined;
    this.controller = undefined;
    this.models.clear();
    this.grants.clear();
    this.shownOrder = [];
  }

  private onState(): void {
    const shown = this.controller?.state.activeSpaceId;
    if (shown && this.shownOrder[0] !== shown)
      this.shownOrder = [
        shown,
        ...this.shownOrder.filter((id) => id !== shown),
      ].slice(0, SHOWN_LIMIT);
    this.refresh();
  }

  // Keeps a model only while some loaded extension listens in that session,
  // so an extension that starts listening gets no events about the past.
  private refresh(): void {
    if (!this.controller) return;
    this.prune();
    for (const partition of this.deps.host.partitions()) {
      if (!this.listened(partition)) {
        this.models.delete(partition);
        continue;
      }
      const next = this.model(partition);
      const previous = this.models.get(partition);
      this.models.set(partition, next);
      if (!previous) continue;
      for (const change of diffModels(previous, next))
        this.dispatch(partition, change);
    }
  }

  private listened(partition: string): boolean {
    for (const id of this.deps.host.loadedIds(partition))
      for (const event of BRIDGE_EVENTS)
        if (
          safely(() => this.deps.channel.listening(partition, id, event), false)
        )
          return true;
    return false;
  }

  private dispatch(partition: string, change: ModelChange): void {
    for (const id of this.deps.host.loadedIds(partition)) {
      const access = this.access(partition, id);
      for (const { event, args } of eventFor(change, access)) {
        if (
          !safely(
            () => this.deps.channel.listening(partition, id, event),
            false,
          )
        )
          continue;
        try {
          this.deps.channel.emit(partition, id, event, args);
        } catch (error) {
          logError(`${id} missed ${event}`, error);
        }
      }
    }
  }

  // Window ids, placeholders and grants of spaces and tabs that are gone.
  private prune(): void {
    const state = this.controller?.state;
    if (!state) return;
    const spaces = new Set(state.spaces.map((space) => space.id));
    for (const spaceId of [...this.windowIds.keys()])
      if (!spaces.has(spaceId)) this.windowIds.delete(spaceId);
    const tabs = new Set(state.tabs.map((tab) => tab.id));
    for (const tabId of [...this.placeholders.keys()])
      if (!tabs.has(tabId)) this.placeholders.delete(tabId);
    const live = new Set(
      state.tabs.map(
        (tab) =>
          safely(
            () => this.controller?.peekWebContents(tab.id)?.id,
            undefined,
          ) ?? this.placeholder(tab.id),
      ),
    );
    for (const grants of this.grants.values())
      for (const id of [...grants]) if (!live.has(id)) grants.delete(id);
  }

  private windowShape(): {
    focused: boolean;
    state: WindowModel["state"];
    bounds: WindowModel["bounds"];
  } {
    const window = this.controller?.window;
    const none = {
      focused: false,
      state: "normal" as const,
      bounds: { left: 0, top: 0, width: 0, height: 0 },
    };
    if (!window || safely(() => window.isDestroyed(), true)) return none;
    return safely(() => {
      const bounds = window.getBounds();
      return {
        focused: window.isFocused(),
        state: window.isFullScreen()
          ? ("fullscreen" as const)
          : window.isMinimized()
            ? ("minimized" as const)
            : window.isMaximized()
              ? ("maximized" as const)
              : ("normal" as const),
        bounds: {
          left: bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
      };
    }, none);
  }

  private tabModel(
    controller: BridgeController,
    space: Space,
    tab: Tab,
    windowId: number,
    index: number,
    shownTabId: string | undefined,
  ): TabModel {
    const contents = safely(
      () => controller.peekWebContents(tab.id),
      undefined,
    );
    const newTab = tab.url === HOME_URL;
    const status = newTab
      ? ("complete" as const)
      : !contents
        ? ("unloaded" as const)
        : tab.loading
          ? ("loading" as const)
          : ("complete" as const);
    return {
      id: contents?.id ?? this.placeholder(tab.id),
      tabId: tab.id,
      windowId,
      index,
      url: newTab ? NEW_TAB_URL : tab.url,
      title: newTab ? "New tab" : tab.title,
      ...(tab.favicon ? { favIconUrl: tab.favicon } : {}),
      status,
      active: shownTabId === tab.id,
      pinned: tab.pinned,
      discarded: !newTab && !contents,
      audible: contents
        ? safely(() => contents.isCurrentlyAudible(), false)
        : false,
      muted: contents ? safely(() => contents.isAudioMuted(), false) : false,
      zoomFactor: contents ? safely(() => contents.getZoomFactor(), 1) : 1,
      agentHeld: agentHeld(space),
      file: isFileTab(tab.url),
      newTab,
    };
  }

  private idForSpace(spaceId: string): number {
    const known = this.windowIds.get(spaceId);
    if (known !== undefined) return known;
    const id = this.nextWindowId++;
    this.windowIds.set(spaceId, id);
    return id;
  }

  private placeholder(tabId: string): number {
    const known = this.placeholders.get(tabId);
    if (known !== undefined) return known;
    const id = PLACEHOLDER_BASE + this.nextPlaceholder++;
    this.placeholders.set(tabId, id);
    return id;
  }

  // The caller's own window, else the space shown last on its session.
  private current(caller: Caller, model: SessionModel): number {
    return this.callerWindowId(caller) ?? this.shownFirst(model);
  }

  private shownFirst(model: SessionModel): number {
    for (const spaceId of this.shownOrder) {
      const window = model.windows.find((item) => item.spaceId === spaceId);
      if (window) return window.id;
    }
    return model.windows[0]?.id ?? WINDOW_ID_NONE;
  }

  private lastFocused(caller: Caller, model: SessionModel): number {
    return (
      model.windows.find((window) => window.focused)?.id ??
      this.current(caller, model)
    );
  }

  private callerTab(caller: Caller, model: SessionModel): TabModel | undefined {
    const contents = caller.contents;
    if (caller.surface !== "tab" || !contents || !this.controller)
      return undefined;
    const tab = safely(
      () => this.controller?.tabOfContents(contents),
      undefined,
    );
    return tab
      ? model.windows
          .flatMap((window) => window.tabs)
          .find((item) => item.tabId === tab.id)
      : undefined;
  }

  private tabOr(model: SessionModel, numericId: number): TabModel {
    const tab = model.windows
      .flatMap((window) => window.tabs)
      .find((item) => item.id === numericId);
    if (!tab) throw new BridgeError(extensionBridgeCopy.noTab(numericId));
    return tab;
  }

  private windowOr(model: SessionModel, windowId: number): WindowModel {
    const window = model.windows.find((item) => item.id === windowId);
    if (!window) throw new BridgeError(extensionBridgeCopy.noWindow(windowId));
    return window;
  }

  // No tab id means the active tab of the caller's current window.
  private aimedTab(
    caller: Caller,
    model: SessionModel,
    value: unknown,
    name: string,
  ): TabModel {
    if (value === undefined || value === null) {
      const windowId = this.current(caller, model);
      const tab = this.windowOr(model, windowId).tabs.find(
        (item) => item.active,
      );
      if (!tab) throw new BridgeError(extensionBridgeCopy.noWindow(windowId));
      return tab;
    }
    return this.tabOr(model, asInteger(value, name));
  }

  private readonly onTabs: ApiHandler = (caller, method, args) => {
    const model = this.model(caller.partition);
    const access = this.access(caller.partition, caller.extensionId);
    switch (method) {
      case "get":
        return tabObject(
          this.tabOr(model, asInteger(args[0], "tabs.get")),
          access,
        );
      case "getCurrent": {
        const tab = this.callerTab(caller, model);
        return tab ? tabObject(tab, access) : undefined;
      }
      case "query": {
        const query = asQuery(args[0]);
        const context = {
          currentWindowId: this.current(caller, model),
          lastFocusedWindowId: this.lastFocused(caller, model),
        };
        return queryTabs(model, query, context, access).map((tab) =>
          tabObject(tab, access),
        );
      }
      case "getZoom":
        return this.aimedTab(caller, model, args[0], "tabs.getZoom").zoomFactor;
      case "getZoomSettings":
        this.aimedTab(caller, model, args[0], "tabs.getZoomSettings");
        return { ...ZOOM_SETTINGS };
      case "captureVisibleTab":
        return this.capture(caller, args);
      case "create":
        return this.createTab(caller, args);
      case "duplicate":
        return this.duplicateTab(caller, args);
      case "update":
        return this.updateTab(caller, args);
      case "move":
        return this.moveTabs(caller, args);
      case "reload":
        return this.reloadTab(caller, args);
      case "remove":
        return this.removeTabs(caller, args);
      case "goBack":
      case "goForward":
        return this.walk(caller, args, method === "goBack");
      case "setZoom":
        return this.setZoom(caller, args);
      case "setZoomSettings":
        return this.setZoomSettings(caller, args);
      case "highlight":
        return this.highlight(caller, args);
      default:
        throw new BridgeError(extensionBridgeCopy.notSupported);
    }
  };

  private readonly onWindows: ApiHandler = (caller, method, args) => {
    const model = this.model(caller.partition);
    const access = this.access(caller.partition, caller.extensionId);
    switch (method) {
      case "get": {
        const windowId = asInteger(args[0], "windows.get");
        return windowObject(
          this.windowOr(model, windowId),
          access,
          populate(args[1], "windows.get"),
        );
      }
      case "getCurrent":
        return windowObject(
          this.windowOr(model, this.current(caller, model)),
          access,
          populate(args[0], "windows.getCurrent"),
        );
      case "getLastFocused":
        return windowObject(
          this.windowOr(model, this.lastFocused(caller, model)),
          access,
          populate(args[0], "windows.getLastFocused"),
        );
      case "getAll": {
        const options = asObject(args[0], "windows.getAll");
        const types = options.windowTypes;
        if (types !== undefined) {
          if (
            !Array.isArray(types) ||
            !types.every((type) => typeof type === "string")
          )
            throw new BridgeError(
              extensionBridgeCopy.invalid("windows.getAll"),
            );
          if (!types.includes("normal")) return [];
        }
        const wanted = asBoolean(options.populate, "windows.getAll", false);
        return model.windows.map((window) =>
          windowObject(window, access, wanted),
        );
      }
      case "create":
        return this.createWindow(caller, args);
      case "update":
        return this.updateWindow(caller, args);
      case "remove":
        return this.removeWindow(caller, args);
      default:
        throw new BridgeError(extensionBridgeCopy.notSupported);
    }
  };

  private readonly onRuntime: ApiHandler = async (caller, method) => {
    if (method !== "openOptionsPage")
      throw new BridgeError(extensionBridgeCopy.notSupported);
    this.openTab(caller, this.optionsUrl(caller.extensionId), {
      windowId: this.current(caller, this.model(caller.partition)),
    });
  };

  private async createTab(caller: Caller, args: unknown[]): Promise<BridgeTab> {
    const given = asObject(args[0], "tabs.create");
    const url = this.urlOf(given.url, caller.extensionId, "tabs.create");
    const model = this.model(caller.partition);
    const tab = this.openTab(caller, url ?? HOME_URL, {
      windowId: this.windowFor(caller, model, given.windowId, "tabs.create"),
      active: asBoolean(given.active, "tabs.create", true),
      index:
        given.index === undefined || given.index === null
          ? undefined
          : asInteger(given.index, "tabs.create"),
      pinned: asBoolean(given.pinned, "tabs.create", false),
    });
    return this.tabAfter(caller, tab.id);
  }

  private async duplicateTab(
    caller: Caller,
    args: unknown[],
  ): Promise<BridgeTab> {
    const model = this.model(caller.partition);
    const tab = this.changeable(
      this.tabOr(model, asInteger(args[0], "tabs.duplicate")),
    );
    const url = tab.newTab
      ? HOME_URL
      : (this.urlOf(tab.url, caller.extensionId, "tabs.duplicate") ?? HOME_URL);
    const made = this.openTab(caller, url, {
      windowId: tab.windowId,
      active: true,
      index: tab.index + 1,
      pinned: tab.pinned,
    });
    return this.tabAfter(caller, made.id);
  }

  private async updateTab(caller: Caller, args: unknown[]): Promise<BridgeTab> {
    const model = this.model(caller.partition);
    const [aim, details] = this.aimed(args);
    const given = asObject(details, "tabs.update");
    const tab = this.changeable(
      this.aimedTab(caller, model, aim, "tabs.update"),
    );
    const url = this.urlOf(given.url, caller.extensionId, "tabs.update");
    const active =
      asBoolean(given.active, "tabs.update", false) ||
      asBoolean(given.highlighted, "tabs.update", false) ||
      asBoolean(given.selected, "tabs.update", false);
    const pinned =
      given.pinned === undefined
        ? undefined
        : asBoolean(given.pinned, "tabs.update", false);
    const muted =
      given.muted === undefined
        ? undefined
        : asBoolean(given.muted, "tabs.update", false);
    const controller = this.bound();
    if (url !== undefined)
      await controller.dispatch({ type: "tab:navigate", id: tab.tabId, url });
    if (active && !tab.active && this.mayShow(caller, model, tab.windowId))
      await controller.dispatch({ type: "tab:activate", id: tab.tabId });
    if (pinned !== undefined && pinned !== tab.pinned)
      await controller.dispatch({ type: "tab:pin", id: tab.tabId });
    if (muted !== undefined) this.viewOf(tab.tabId)?.setAudioMuted(muted);
    return this.tabAfter(caller, tab.tabId);
  }

  private async moveTabs(
    caller: Caller,
    args: unknown[],
  ): Promise<BridgeTab | BridgeTab[]> {
    const model = this.model(caller.partition);
    const given = asObject(args[1], "tabs.move");
    const index = asInteger(given.index, "tabs.move");
    const windowId = this.windowFor(caller, model, given.windowId, "tabs.move");
    const tabs = this.idList(args[0], "tabs.move").map((id) =>
      this.changeable(this.tabOr(model, id)),
    );
    // A move stays within its window.
    if (windowId !== undefined && tabs.some((tab) => tab.windowId !== windowId))
      throw new BridgeError(extensionBridgeCopy.notSupported);
    const controller = this.bound();
    for (const [offset, tab] of tabs.entries())
      controller.moveTab(tab.tabId, index < 0 ? index : index + offset);
    const moved = tabs.map((tab) => this.tabAfter(caller, tab.tabId));
    return Array.isArray(args[0]) ? moved : moved[0];
  }

  private async reloadTab(caller: Caller, args: unknown[]): Promise<void> {
    const [aim, details] = this.aimed(args);
    const given = asObject(details, "tabs.reload");
    const tab = this.changeable(
      this.aimedTab(caller, this.model(caller.partition), aim, "tabs.reload"),
    );
    const view = this.viewOf(tab.tabId);
    if (!view) {
      await this.bound().dispatch({ type: "tab:reload", id: tab.tabId });
      return;
    }
    if (asBoolean(given.bypassCache, "tabs.reload", false))
      view.reloadIgnoringCache();
    else view.reload();
  }

  private async removeTabs(caller: Caller, args: unknown[]): Promise<void> {
    const model = this.model(caller.partition);
    const tabs = this.idList(args[0], "tabs.remove").map((id) =>
      this.changeable(this.tabOr(model, id)),
    );
    const controller = this.bound();
    // Never tab:close, which closes Kamapathy's window for a last empty tab.
    for (const tab of tabs) controller.closeTab(tab.tabId, "person");
  }

  private async walk(
    caller: Caller,
    args: unknown[],
    back: boolean,
  ): Promise<void> {
    const name = back ? "tabs.goBack" : "tabs.goForward";
    const tab = this.changeable(
      this.aimedTab(caller, this.model(caller.partition), args[0], name),
    );
    const history = this.viewOf(tab.tabId)?.navigationHistory;
    if (!history) return;
    if (back && history.canGoBack()) history.goBack();
    if (!back && history.canGoForward()) history.goForward();
  }

  private async setZoom(caller: Caller, args: unknown[]): Promise<void> {
    const [aim, value] =
      args.length > 1 ? [args[0], args[1]] : [undefined, args[0]];
    const tab = this.changeable(
      this.aimedTab(caller, this.model(caller.partition), aim, "tabs.setZoom"),
    );
    const invalid = new BridgeError(
      extensionBridgeCopy.invalid("tabs.setZoom"),
    );
    if (typeof value !== "number" || !Number.isFinite(value)) throw invalid;
    const factor = value === 0 ? 1 : value;
    if (factor < 0.25 || factor > 5) throw invalid;
    this.viewOf(tab.tabId)?.setZoomFactor(factor);
  }

  private async setZoomSettings(
    caller: Caller,
    args: unknown[],
  ): Promise<void> {
    const [aim, details] = this.aimed(args);
    this.aimedTab(
      caller,
      this.model(caller.partition),
      aim,
      "tabs.setZoomSettings",
    );
    const given = asObject(details, "tabs.setZoomSettings");
    const mode = given.mode ?? ZOOM_SETTINGS.mode;
    const scope = given.scope ?? ZOOM_SETTINGS.scope;
    // Kamapathy zooms per origin, as the person set it.
    if (mode !== ZOOM_SETTINGS.mode || scope !== ZOOM_SETTINGS.scope)
      throw new BridgeError(extensionBridgeCopy.notSupported);
  }

  private async highlight(
    caller: Caller,
    args: unknown[],
  ): Promise<BridgeWindow> {
    const model = this.model(caller.partition);
    const given = asObject(args[0], "tabs.highlight");
    const windowId =
      this.windowFor(caller, model, given.windowId, "tabs.highlight") ??
      this.current(caller, model);
    const window = this.windowOr(model, windowId);
    const first = this.idList(given.tabs, "tabs.highlight")[0];
    const tab = window.tabs.find((item) => item.index === first);
    if (!tab)
      throw new BridgeError(extensionBridgeCopy.invalid("tabs.highlight"));
    this.changeable(tab);
    if (!tab.active && this.mayShow(caller, model, window.id))
      await this.bound().dispatch({ type: "tab:activate", id: tab.tabId });
    const access = this.access(caller.partition, caller.extensionId);
    return windowObject(
      this.windowOr(this.model(caller.partition), window.id),
      access,
      true,
    );
  }

  private async createWindow(
    caller: Caller,
    args: unknown[],
  ): Promise<BridgeWindow> {
    const given = asObject(args[0], "windows.create");
    // Kamapathy has no incognito windows and moves no tab into a window.
    if (given.incognito === true || given.tabId !== undefined)
      throw new BridgeError(extensionBridgeCopy.notSupported);
    const listed =
      given.url === undefined || given.url === null
        ? []
        : Array.isArray(given.url)
          ? given.url
          : [given.url];
    const urls = listed.map(
      (item) =>
        this.urlOf(item, caller.extensionId, "windows.create") ?? HOME_URL,
    );
    const type = given.type === undefined ? "normal" : given.type;
    if (typeof type !== "string")
      throw new BridgeError(extensionBridgeCopy.invalid("windows.create"));
    const focused = asBoolean(given.focused, "windows.create", true);
    const own = (url: string) => extensionIdOf(url) === caller.extensionId;
    if (
      (type === "popup" || type === "panel") &&
      urls.length > 0 &&
      urls.every(own)
    )
      return this.openWindow(caller, urls[0], given, focused);
    // Everything else opens tabs in a space of the person's.
    let spaceId = "";
    for (const [offset, url] of (urls.length ? urls : [HOME_URL]).entries())
      spaceId = this.openTab(caller, url, {
        active: focused && offset === 0,
      }).spaceId;
    const window = this.model(caller.partition).windows.find(
      (item) => item.spaceId === spaceId,
    );
    if (!window) throw new BridgeError(extensionBridgeCopy.failed);
    return windowObject(
      window,
      this.access(caller.partition, caller.extensionId),
      true,
    );
  }

  private openWindow(
    caller: Caller,
    url: string,
    given: Record<string, unknown>,
    focused: boolean,
  ): BridgeWindow {
    const opener = this.opener;
    if (!opener) throw new BridgeError(extensionBridgeCopy.notSupported);
    const mine = safely(
      () => opener.windowsOf(caller.extensionId, caller.partition),
      [] as ExtensionWindowInfo[],
    );
    if (mine.length >= MAX_EXTENSION_WINDOWS)
      throw new BridgeError(extensionBridgeCopy.tooManyWindows);
    return extensionWindow(
      opener.openWindow({
        windowId: this.nextWindowId++,
        extensionId: caller.extensionId,
        partition: caller.partition,
        url,
        ...this.boundsOf(given, "windows.create"),
        focused,
      }),
    );
  }

  private async updateWindow(
    caller: Caller,
    args: unknown[],
  ): Promise<BridgeWindow> {
    const windowId = asInteger(args[0], "windows.update");
    const given = asObject(args[1], "windows.update");
    const focused =
      given.focused === undefined
        ? undefined
        : asBoolean(given.focused, "windows.update", false);
    if (this.isOwnWindow(caller, windowId))
      return extensionWindow(
        this.opener!.updateWindow(windowId, {
          ...this.boundsOf(given, "windows.update"),
          focused,
        }),
      );
    const model = this.model(caller.partition);
    const window = this.windowOr(model, windowId);
    // The main window's size, place and state belong to the person.
    const others =
      given.state !== undefined ||
      ["left", "top", "width", "height"].some(
        (name) => given[name] !== undefined,
      );
    if (window.agentHeld && (others || given.drawAttention !== undefined))
      throw new BridgeError(extensionBridgeCopy.agentTab);
    if (others) throw new BridgeError(extensionBridgeCopy.notSupported);
    if (
      focused &&
      this.canSwitch(caller) &&
      window.spaceId !== this.controller?.state.activeSpaceId
    )
      await this.bound().dispatch({
        type: "space:activate",
        id: window.spaceId,
      });
    return windowObject(
      this.windowOr(this.model(caller.partition), windowId),
      this.access(caller.partition, caller.extensionId),
      false,
    );
  }

  private async removeWindow(caller: Caller, args: unknown[]): Promise<void> {
    const windowId = asInteger(args[0], "windows.remove");
    if (!this.isOwnWindow(caller, windowId))
      throw new BridgeError(extensionBridgeCopy.cantClose);
    this.opener!.closeWindow(windowId);
  }

  private isOwnWindow(caller: Caller, windowId: number): boolean {
    const opener = this.opener;
    if (!opener) return false;
    return safely(
      () => opener.windowsOf(caller.extensionId, caller.partition),
      [] as ExtensionWindowInfo[],
    ).some((item) => item.windowId === windowId);
  }

  private boundsOf(
    given: Record<string, unknown>,
    name: string,
  ): { left?: number; top?: number; width?: number; height?: number } {
    const value = (key: string) =>
      given[key] === undefined || given[key] === null
        ? undefined
        : asInteger(given[key], name);
    return {
      left: value("left"),
      top: value("top"),
      width: value("width"),
      height: value("height"),
    };
  }

  private optionsUrl(extensionId: string): string {
    const page = this.deps.host.manifestOf(extensionId)?.options;
    const url = page ? allowedExtensionUrl(page, extensionId) : undefined;
    if (!url) throw new BridgeError(extensionBridgeCopy.noOptions);
    return url;
  }

  private bound(): BridgeController {
    const controller = this.controller;
    if (!controller) throw new BridgeError(extensionBridgeCopy.failed);
    return controller;
  }

  private viewOf(tabId: string): WebContents | undefined {
    return safely(() => this.bound().peekWebContents(tabId), undefined);
  }

  private changeable<T extends { agentHeld: boolean }>(item: T): T {
    if (item.agentHeld) throw new BridgeError(extensionBridgeCopy.agentTab);
    return item;
  }

  // A tab becomes the shown one only in the shown space, unless the caller
  // may switch the shown space.
  private mayShow(
    caller: Caller,
    model: SessionModel,
    windowId: number,
  ): boolean {
    const spaceId = model.windows.find((item) => item.id === windowId)?.spaceId;
    return (
      (!!spaceId && spaceId === this.controller?.state.activeSpaceId) ||
      this.canSwitch(caller)
    );
  }

  // Chrome's (tabId?, details) calls: a leading object is the details.
  private aimed(args: unknown[]): [unknown, unknown] {
    return typeof args[0] === "object" && args[0] !== null
      ? [undefined, args[0]]
      : [args[0], args[1]];
  }

  private urlOf(
    value: unknown,
    extensionId: string,
    name: string,
  ): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string")
      throw new BridgeError(extensionBridgeCopy.invalid(name));
    const url = allowedExtensionUrl(value, extensionId);
    if (!url) throw new BridgeError(extensionBridgeCopy.cantOpen);
    return url === "about:blank" ? HOME_URL : url;
  }

  private windowFor(
    caller: Caller,
    model: SessionModel,
    value: unknown,
    name: string,
  ): number | undefined {
    if (value === undefined || value === null) return undefined;
    const windowId = asInteger(value, name);
    return windowId === WINDOW_ID_CURRENT
      ? this.current(caller, model)
      : windowId;
  }

  private idList(value: unknown, name: string): number[] {
    if (Array.isArray(value)) return value.map((item) => asInteger(item, name));
    return [asInteger(value, name)];
  }

  private tabAfter(caller: Caller, tabId: string): BridgeTab {
    const tab = this.model(caller.partition)
      .windows.flatMap((window) => window.tabs)
      .find((item) => item.tabId === tabId);
    if (!tab) throw new BridgeError(extensionBridgeCopy.failed);
    return tabObject(tab, this.access(caller.partition, caller.extensionId));
  }

  // Only the shown space, and only for an extension that may read it.
  private async capture(caller: Caller, args: unknown[]): Promise<string> {
    const controller = this.controller;
    const model = this.model(caller.partition);
    const options = asObject(
      typeof args[0] === "object" && args[0] !== null ? args[0] : args[1],
      "tabs.captureVisibleTab",
    );
    const windowId =
      typeof args[0] === "object" && args[0] !== null
        ? this.current(caller, model)
        : args[0] === undefined ||
            args[0] === null ||
            asInteger(args[0], "tabs.captureVisibleTab") === WINDOW_ID_CURRENT
          ? this.current(caller, model)
          : asInteger(args[0], "tabs.captureVisibleTab");
    const window = this.windowOr(model, windowId);
    if (!controller || window.spaceId !== controller.state.activeSpaceId)
      throw new BridgeError(extensionBridgeCopy.notShown);
    const tab = window.tabs.find((item) => item.active);
    const access = this.access(caller.partition, caller.extensionId);
    const allowed =
      !!tab &&
      !tab.file &&
      (access.hosts.some(coversAllHosts) || access.activeTabs.has(tab.id));
    const contents = tab
      ? safely(() => controller.peekWebContents(tab.tabId), undefined)
      : undefined;
    if (!allowed || !contents)
      throw new BridgeError(extensionBridgeCopy.cantCapture);
    const image = await contents.capturePage();
    const quality =
      typeof options.quality === "number"
        ? Math.min(100, Math.max(0, Math.round(options.quality)))
        : 92;
    return options.format === "jpeg"
      ? `data:image/jpeg;base64,${image.toJPEG(quality).toString("base64")}`
      : `data:image/png;base64,${image.toPNG().toString("base64")}`;
  }
}

function populate(value: unknown, name: string): boolean {
  return asBoolean(asObject(value, name).populate, name, false);
}

function extensionWindow(info: ExtensionWindowInfo): BridgeWindow {
  return {
    id: info.windowId,
    focused: info.focused,
    top: info.bounds.top,
    left: info.bounds.left,
    width: info.bounds.width,
    height: info.bounds.height,
    incognito: false,
    type: "popup",
    state: "normal",
    alwaysOnTop: false,
    tabs: [
      {
        id: info.tabId,
        index: 0,
        windowId: info.windowId,
        active: true,
        highlighted: true,
        selected: true,
        pinned: false,
        audible: false,
        discarded: false,
        autoDiscardable: true,
        frozen: false,
        mutedInfo: { muted: false },
        status: "loading",
        incognito: false,
        groupId: -1,
        url: info.url,
      },
    ],
  };
}
