import type { BrowserWindow, WebContents } from "electron";
import {
  agentHeld,
  coversAllHosts,
  diffModels,
  eventFor,
  NEW_TAB_URL,
  PLACEHOLDER_BASE,
  queryTabs,
  runsExtensions,
  tabObject,
  windowObject,
  WINDOW_ID_CURRENT,
  WINDOW_ID_NONE,
  type Access,
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
import { BridgeError, type ApiHandler, type Caller } from "./channel";
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
  // Spaces in the order they were last shown, newest first.
  private shownOrder: string[] = [];

  constructor(deps: BridgeDeps) {
    this.deps = deps;
    this.deps.channel.register("tabs", this.onTabs);
    this.deps.channel.register("windows", this.onWindows);
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
    const own = this.callerWindowId(caller);
    if (own !== undefined) return own;
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
      default:
        throw new BridgeError(extensionBridgeCopy.notSupported);
    }
  };

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
