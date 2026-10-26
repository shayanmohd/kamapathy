import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import type { CursorPoint } from "../electron/agent/cursor";
import type { LayoutMetrics } from "../electron/agent/screenshot";
import type { AutomationController } from "../electron/agent/server";
import type { HttpCredentials, PromptReceipts } from "../electron/prompts";
import { TabRegistry } from "../electron/agent/tab-registry";
import {
  agentRules,
  HOME_URL,
  initialState,
  newTab,
  openingTab,
  PAGE_BUDGET,
  patchTask,
} from "../shared/state";
import type {
  AgentTask,
  BrowserAction,
  BrowserState,
  ClosedBy,
  HoldReason,
  Space,
  SpaceRequest,
  Tab,
} from "../shared/types";
import { isWebUrl } from "../shared/url";
import { FakeHost } from "./fake-cdp";

// A PNG's signature and header, which is all a capture's size needs.
export function fakePng(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

// A node the tab's hit test finds at one point: the element itself, and the
// frame it holds when it owns one.
export type FakeHit = {
  x: number;
  y: number;
  // The frame the hit belongs to, as DOM.getNodeForLocation reports it.
  frameId?: string;
  nodeName: string;
  attributes?: Record<string, string>;
  // The frame this node owns, as DOM.describeNode reports it.
  holds?: string;
};

// A page whose debugger answers page operations with `result`. It records
// each operation with the world it ran in, and each input command.
export class FakeContents extends FakeHost {
  scripts: { world: string; code: string }[] = [];
  // The clip of each capture, in the order they were sent.
  captures: Record<string, any>[] = [];
  captureError?: Error;
  // A 1,200 by 800 viewport at the document origin, showing a document of
  // the same size, in CSS pixels at zoom 1.
  metrics: LayoutMetrics = {
    cssVisualViewport: {
      pageX: 0,
      pageY: 0,
      clientWidth: 1200,
      clientHeight: 800,
      zoom: 1,
    },
    contentSize: { width: 1200, height: 800 },
  };
  zoom = 1;
  inputs: { method: string; parameters: Record<string, unknown> }[] = [];
  afterInput?: () => void;
  // What the tab's own session was asked to fetch, as the PDF re-read does.
  fetches: { url: string; init?: RequestInit }[] = [];
  fetchPdf?: (url: string, init?: RequestInit) => Promise<Response>;
  session = {
    fetch: (url: string, init?: RequestInit) => {
      this.fetches.push({ url, init });
      return this.fetchPdf
        ? this.fetchPdf(url, init)
        : Promise.reject(new Error("No fetch in this test."));
    },
  };
  result: unknown = {
    url: "https://example.com/",
    title: "Example",
    text: "Hello from the agent page",
    interactables: [],
    truncated: false,
  };
  // What section 5's action operations answer with. Each entry is a value, or
  // a function of what `result` already gave, so a test that sets a point or
  // a refusal still drives them, and one that needs a blocker, a scroll or a
  // moving box replaces the entry. A refusal is never adapted.
  pageActions: Record<string, unknown> = {
    actionPoint: (given: any) =>
      given && Number.isFinite(given.x) && Number.isFinite(given.y)
        ? { ...given, point: { x: given.x, y: given.y } }
        : given,
    stableBox: (given: any) => ({ ...given, moved: 0 }),
    // Section 9's owner: at the document origin, at full scale, showing the
    // whole viewport, so a frame action behaves like one on the page itself
    // until a test places the owner itself.
    frameBox: (given: any) => ({
      box: { x: 0, y: 0, scaleX: 1, scaleY: 1, width: 1200, height: 800 },
      area: { left: 0, top: 0, right: 1200, bottom: 800 },
      ...given,
    }),
    scrollRequest: (given: any) => ({ ...given, settled: true }),
    viewport: () => ({ ok: true, width: 1200, height: 800, zoom: 1 }),
    focusedKind: () => ({ ok: true, kind: "none" }),
  };
  // What the tab's own hit test finds under a point, for section 5's guards.
  // Without a spot the hit test finds nothing, so an ordinary press goes out.
  hits: FakeHit[] = [];
  // What the controller asked the page to load or reload. A load is not a
  // commit, so a test drives the page's own events itself.
  loads: { url: string; options?: Electron.LoadURLOptions }[] = [];
  reloads: { ignoreCache: boolean }[] = [];
  private contextWorlds = new Map<number, string>();
  constructor() {
    super({ url: "https://example.com/" });
    this.debugger.reply("Page.createIsolatedWorld", (params) => {
      const executionContextId = this.contextWorlds.size + 1;
      this.contextWorlds.set(executionContextId, params.worldName);
      return { executionContextId };
    });
    this.debugger.reply("Runtime.evaluate", async (params) => {
      const code: string = params.expression;
      this.scripts.push({
        world: this.contextWorlds.get(params.contextId) ?? "",
        code,
      });
      const value = await (typeof this.result === "function"
        ? this.result(code)
        : this.result);
      return {
        result: { type: "object", value: this.actionReply(code, value) },
      };
    });
    this.debugger.reply("DOM.getNodeForLocation", (params) => {
      const at = this.hits.findIndex(
        (hit) => hit.x === params.x && hit.y === params.y,
      );
      if (at < 0) throw new Error("No node found at given location");
      const hit = this.hits[at];
      return {
        backendNodeId: at + 1,
        ...(hit.frameId === undefined ? {} : { frameId: hit.frameId }),
      };
    });
    this.debugger.reply("DOM.describeNode", (params) => {
      const hit = this.hits[params.backendNodeId - 1];
      if (!hit) throw new Error("Could not find node with given id");
      return {
        node: {
          nodeType: 1,
          nodeName: hit.nodeName.toUpperCase(),
          attributes: Object.entries(hit.attributes ?? {}).flat(),
          ...(hit.holds === undefined ? {} : { frameId: hit.holds }),
        },
      };
    });
    this.debugger.reply("Page.getLayoutMetrics", () => this.metrics);
    // Chromium sizes the image from the clip, in device-independent pixels,
    // times its scale.
    this.debugger.reply("Page.captureScreenshot", (params) => {
      this.captures.push(params);
      if (this.captureError) throw this.captureError;
      const { clip } = params;
      return {
        data: fakePng(
          Math.ceil(clip.width * clip.scale),
          Math.ceil(clip.height * clip.scale),
        ).toString("base64"),
      };
    });
    for (const method of [
      "Input.dispatchMouseEvent",
      "Input.dispatchKeyEvent",
      "Input.dispatchDragEvent",
      "Input.setInterceptDrags",
    ])
      this.debugger.reply(method, (parameters) => {
        this.inputs.push({ method, parameters });
        this.afterInput?.();
        return {};
      });
  }
  async loadURL(url: string, options?: Electron.LoadURLOptions) {
    this.loads.push({ url, ...(options ? { options } : {}) });
  }
  reload() {
    this.reloads.push({ ignoreCache: false });
  }
  reloadIgnoringCache() {
    this.reloads.push({ ignoreCache: true });
  }
  // A protocol event Chromium sends to an attached debugger.
  emitProtocol(method: string, parameters: Record<string, unknown>) {
    this.debugger.event(method, parameters);
  }
  getZoomFactor() {
    return this.zoom;
  }
  // The operation a page script names, and what pageActions answers it with.
  private actionReply(code: string, value: unknown) {
    const operation = Object.keys(this.pageActions).find((name) =>
      code.includes(`)(${JSON.stringify(name)},`),
    );
    const reply =
      operation === undefined ? undefined : this.pageActions[operation];
    if (
      reply === undefined ||
      (value && typeof value === "object" && (value as any).ok === false)
    )
      return value;
    return typeof reply === "function" ? reply(value) : reply;
  }
}
// Profile folders the fakes made, removed by FakeController.cleanup.
const profiles: string[] = [];

// A download as Electron hands one to will-download: the methods the agent
// server reads, and the progress and end a test drives by hand.
export class FakeDownloadItem extends EventEmitter {
  savePath = "";
  dialogOptions?: unknown;
  cancelled = false;
  private received = 0;
  constructor(
    private readonly file: {
      filename: string;
      url?: string;
      mimeType?: string;
      totalBytes?: number;
    },
  ) {
    super();
  }
  getFilename = () => this.file.filename;
  getURL = () => this.file.url ?? `https://example.com/${this.file.filename}`;
  getMimeType = () => this.file.mimeType ?? "application/octet-stream";
  getTotalBytes = () => this.file.totalBytes ?? 0;
  getReceivedBytes = () => this.received;
  setSavePath = (path: string) => {
    this.savePath = path;
  };
  getSavePath = () => this.savePath;
  setSaveDialogOptions = (options: unknown) => {
    this.dialogOptions = options;
  };
  cancel = () => {
    this.cancelled = true;
  };
  /** Bytes arriving, as Chromium reports them. */
  progress(
    bytes: number,
    state: "progressing" | "interrupted" = "progressing",
  ) {
    this.received = bytes;
    this.emit("updated", {}, state);
  }
  /** The end of the download. */
  finish(
    state: "completed" | "cancelled" | "interrupted" = "completed",
    bytes = this.received,
  ) {
    this.received = bytes;
    this.emit("done", {}, state);
  }
}
// BrowserController's state, registry and server-facing methods, without
// windows. Tabs get their origin before they join the state, as there.
export class FakeController implements AutomationController {
  state: BrowserState = initialState("linux");
  readonly registry = new TabRegistry(() => this.state);
  // One page per web tab, made with its view as in BrowserController. Most
  // tests drive the newest page through `contents`.
  pages = new Map<string, FakeContents>();
  private fallback = new FakeContents();
  private stateListeners = new Set<(state: BrowserState) => void>();
  private viewListeners = new Set<
    (tabId: string, contents: WebContents) => void
  >();
  calls: BrowserAction[] = [];
  activity: {
    spaceId?: string;
    message: string;
    kind: string;
    agentText?: string;
  }[] = [];
  accessedTabs: string[] = [];
  private blockedRedirects = new Set<(tabId: string, url: string) => void>();
  private downloadStarts = new Set<(tabId: string) => void>();
  private leaveGuards = new Set<(tabId: string, at: number) => void>();
  // The tabs whose views were lent to a capture window, in order.
  lent: string[] = [];
  scale = 1;
  emptyCapture = false;
  captureAvailable = true;
  // What the receipt wrapper tells the prompt center about each route, and
  // what the server hands it or clears while it runs.
  routeSignals: string[] = [];
  deniedSink: PromptReceipts | null = null;
  clearedPrompts: string[] = [];
  // The origins each space stored credentials for, in the order they arrived.
  // The names and passwords themselves are never kept here either.
  credentialOrigins = new Map<string, string[]>();
  readonly prompts = {
    routeStarted: (tabId: string) => {
      this.routeSignals.push(`start ${tabId}`);
    },
    routeEnded: (tabId: string) => {
      this.routeSignals.push(`end ${tabId}`);
    },
    setReceipts: (receipts: PromptReceipts | null) => {
      this.deniedSink = receipts;
    },
    setHTTPCredentials: (
      spaceId: string,
      credentials: HttpCredentials | null,
    ) => {
      if (!credentials) {
        this.credentialOrigins.delete(spaceId);
        return;
      }
      const origins = this.credentialOrigins.get(spaceId) ?? [];
      this.credentialOrigins.set(spaceId, [
        ...origins.filter((origin) => origin !== credentials.origin),
        credentials.origin,
      ]);
    },
    clearCredentials: () => {
      this.credentialOrigins.clear();
      this.clearedPrompts.push("credentials");
    },
    clearSpace: (spaceId: string) => {
      this.clearedPrompts.push(spaceId);
    },
    clearAll: () => {
      this.clearedPrompts.push("all");
    },
  };
  constructor() {
    this.state.spaces.push({
      id: "manual-agent",
      name: "Created by a person",
      color: "purple",
      kind: "agent",
      owner: "agent",
      signIns: "separate",
      createdAt: Date.now(),
      createdBy: "person",
      pageBudget: PAGE_BUDGET,
    });
    this.state.tabs.push(newTab("manual-agent", "https://private.example/"));
    // Every tab so far is the person's.
    for (const tab of this.state.tabs)
      this.registry.register(tab, { openedBy: "person", managed: false });
  }
  get contents(): FakeContents {
    return [...this.pages.values()].at(-1) ?? this.fallback;
  }
  set contents(page: FakeContents) {
    const newest = [...this.pages.keys()].at(-1);
    if (newest) this.pages.set(newest, page);
    else this.fallback = page;
  }
  isolatedRequests: boolean[] = [];
  createAgentSpace(
    name: string,
    options?: { isolated?: boolean; pageBudget?: number },
  ): Space {
    this.isolatedRequests.push(!!options?.isolated);
    const space: Space = {
      id: crypto.randomUUID(),
      name,
      color: "purple",
      kind: "agent",
      owner: "agent",
      signIns: options?.isolated ? "separate" : "shared",
      createdAt: Date.now(),
      createdBy: "agent",
      pageBudget: options?.pageBudget ?? PAGE_BUDGET,
      access: "granted",
    };
    this.state.spaces.push(space);
    const tab = newTab(space.id);
    this.registry.register(tab, { openedBy: "agent", managed: true });
    this.state.tabs.push(tab);
    return space;
  }
  getWebContents(id: string) {
    this.accessedTabs.push(id);
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!tab || tab.url === HOME_URL) return undefined;
    return this.ensureView(tab) as unknown as WebContents;
  }
  peekWebContents(id: string) {
    const tab = this.state.tabs.find((item) => item.id === id);
    const page = this.pages.get(id);
    if (!tab || tab.url === HOME_URL || !page || page.isDestroyed())
      return undefined;
    return page as unknown as WebContents;
  }
  subscribe(listener: (state: BrowserState) => void) {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }
  onViewCreated(listener: (tabId: string, contents: WebContents) => void) {
    this.viewListeners.add(listener);
    return () => {
      this.viewListeners.delete(listener);
    };
  }
  emit() {
    for (const listener of this.stateListeners) listener(this.state);
  }
  // A web tab gets its page once, and view listeners hear of it before it
  // would load, as in BrowserController.ensureView.
  private ensureView(tab: Tab) {
    let page = this.pages.get(tab.id);
    if (!page) {
      page = new FakeContents();
      this.pages.set(tab.id, page);
      for (const listener of this.viewListeners)
        listener(tab.id, page as unknown as WebContents);
    }
    return page;
  }
  async withVisibleView<T>(tabId: string, capture: () => Promise<T>) {
    this.lent.push(tabId);
    return capture();
  }
  deviceScale() {
    return this.scale;
  }
  cropPng(png: Buffer, width: number, height: number) {
    if (this.emptyCapture || png.length < 24) return null;
    const cropped = {
      width: Math.min(width, png.readUInt32BE(16)),
      height: Math.min(height, png.readUInt32BE(20)),
    };
    return { png: fakePng(cropped.width, cropped.height), ...cropped };
  }
  // The tabs showing a PDF, which a snapshot header reports.
  pdfTabs = new Set<string>();
  pdfDocument(tabId: string) {
    return this.pdfTabs.has(tabId);
  }
  addActivity(
    spaceId: string | undefined,
    message: string,
    kind: string,
    agentText?: string,
  ) {
    this.activity.push({
      spaceId,
      message,
      kind,
      ...(agentText ? { agentText } : {}),
    });
  }
  setTask(spaceId: string, patch: Partial<AgentTask> | null) {
    const space = this.state.spaces.find((item) => item.id === spaceId);
    if (!space) throw new Error("Space was not found.");
    if (patchTask(space, patch)) this.emit();
    return space.task;
  }
  shownTab(spaceId: string): Tab | undefined {
    if (spaceId === this.state.activeSpaceId)
      return this.state.tabs.find((tab) => tab.id === this.state.activeTabId);
    return openingTab(this.state, spaceId, this.lastShown.get(spaceId));
  }
  // The tab ids showAgentTab was called with, in order, and how many turns
  // the fake takes over a reveal, so tests can order it without timers.
  shown: string[] = [];
  frames = 0;
  private lastShown = new Map<string, string>();
  async showAgentTab(tabId: string) {
    this.shown.push(tabId);
    const tab = this.state.tabs.find((item) => item.id === tabId);
    if (tab) {
      if (tab.spaceId === this.state.activeSpaceId)
        this.state.activeTabId = tab.id;
      else this.lastShown.set(tab.spaceId, tab.id);
      this.emit();
    }
    for (let frame = 0; frame < this.frames; frame += 1)
      await new Promise((resolve) => setImmediate(resolve));
  }
  // Every point reported for the agent's cursor, with the label it carried.
  pointers: { tabId: string; point: CursorPoint; label?: string }[] = [];
  reportPointer(tabId: string, point: CursorPoint, label?: string) {
    this.pointers.push({ tabId, point, ...(label ? { label } : {}) });
  }
  // Also recorded in calls, as the tab:create it replaces.
  openAgentTab(spaceId: string, url?: string): Tab {
    this.calls.push({ type: "tab:create", spaceId, url, background: true });
    const tab = newTab(spaceId, url);
    this.registry.register(tab, { openedBy: "agent", managed: true });
    this.state.tabs.push(tab);
    if (isWebUrl(tab.url)) this.ensureView(tab);
    this.emit();
    return tab;
  }
  // As BrowserController navigates an agent tab: the address is loaded as
  // given, so nothing normalizes it.
  navigateAgentTab(
    tabId: string,
    url: string,
    options: { referer?: string } = {},
  ) {
    const tab = this.getTab(tabId);
    if (!isWebUrl(url) && url !== "about:blank")
      throw new Error("This address cannot be opened.");
    tab.url = url;
    tab.title = url;
    delete tab.favicon;
    delete tab.error;
    void this.ensureView(tab).loadURL(
      url,
      options.referer
        ? { httpReferrer: { url: options.referer, policy: "unsafe-url" } }
        : undefined,
    );
    this.emit();
  }
  reloadAgentTab(tabId: string, options: { ignoreCache?: boolean } = {}) {
    const tab = this.getTab(tabId);
    const page = this.pages.get(tab.id);
    if (!page) return;
    if (tab.error) void page.loadURL(tab.url);
    else if (options.ignoreCache) page.reloadIgnoringCache();
    else page.reload();
  }
  onBlockedRedirect(listener: (tabId: string, url: string) => void) {
    this.blockedRedirects.add(listener);
    return () => {
      this.blockedRedirects.delete(listener);
    };
  }
  onDownloadStarted(listener: (tabId: string) => void) {
    this.downloadStarts.add(listener);
    return () => {
      this.downloadStarts.delete(listener);
    };
  }
  onLeaveGuard(listener: (tabId: string, at: number) => void) {
    this.leaveGuards.add(listener);
    return () => {
      this.leaveGuards.delete(listener);
    };
  }
  // The hook listeners still subscribed, so a test can see a closed server
  // let go of them.
  get hookCount() {
    return (
      this.blockedRedirects.size +
      this.downloadStarts.size +
      this.leaveGuards.size
    );
  }
  // The controller's own hooks, as a test fires them.
  blockRedirect(tabId: string, url: string) {
    for (const listener of this.blockedRedirects) listener(tabId, url);
  }
  leaveGuard(tabId: string) {
    for (const listener of this.leaveGuards) listener(tabId, Date.now());
  }
  closeTab(tabId: string, by: ClosedBy) {
    const result = this.removeTab(this.getTab(tabId), by);
    this.emit();
    return result;
  }
  setManaged(tabId: string, managed: boolean): Tab {
    const tab = this.getTab(tabId);
    this.registry.setManaged(tab, managed);
    this.emit();
    return tab;
  }
  setPageBudget(spaceId: string, pageBudget: number) {
    const space = this.state.spaces.find((item) => item.id === spaceId);
    if (!space) throw new Error("Space was not found.");
    space.pageBudget = pageBudget;
    this.emit();
  }
  markSeen(tabId: string) {
    const tab = this.getTab(tabId);
    if (!tab.unseen) return;
    delete tab.unseen;
    this.emit();
  }
  // Where the agent server keeps held downloads, made on first use so most
  // tests leave no folder behind. FakeController.cleanup removes them.
  private profile?: string;
  userDataPath() {
    if (!this.profile) {
      this.profile = mkdtempSync(join(tmpdir(), "kamapathy-profile-"));
      profiles.push(this.profile);
    }
    return this.profile;
  }
  private decider?: (
    contents: WebContents,
    item: Electron.DownloadItem,
  ) => { captured: true; id: string } | { captured: false };
  onDownload(
    decide: (
      contents: WebContents,
      item: Electron.DownloadItem,
    ) => { captured: true; id: string } | { captured: false },
  ) {
    this.decider = decide;
    return () => {
      if (this.decider === decide) delete this.decider;
    };
  }
  /** A download starting in a tab: the server's hook hears of it, then its
   *  own decision answers, as the controller's handler does both. Without an
   *  item there is nothing to decide, so only the hook fires. */
  startDownload(tabId: string, item?: unknown) {
    for (const listener of this.downloadStarts) listener(tabId);
    if (item === undefined) return { captured: false as const };
    const contents = this.pages.get(tabId) as unknown as WebContents;
    return (
      this.decider?.(contents, item as Electron.DownloadItem) ?? {
        captured: false as const,
      }
    );
  }
  /** Removes every profile folder the fakes made. */
  static cleanup() {
    for (const path of profiles.splice(0))
      rmSync(path, { recursive: true, force: true });
  }
  agentControlled(tabId: string) {
    const tab = this.state.tabs.find((item) => item.id === tabId);
    if (!tab?.managed) return false;
    const space = this.state.spaces.find((item) => item.id === tab.spaceId);
    return (
      !!space &&
      space.owner === "agent" &&
      space.access !== "ended" &&
      agentRules(space)
    );
  }
  holdForPerson(spaceId: string, reason: HoldReason, prompt: string) {
    const space = this.state.spaces.find((item) => item.id === spaceId);
    if (space?.owner !== "agent")
      throw new Error("The agent does not have control of this space.");
    const hold = crypto.randomUUID();
    this.registry.handOver(spaceId, {
      reason,
      prompt: prompt.slice(0, 120),
      hold,
    });
    this.emit();
    return hold;
  }
  releaseHold(holdId: string) {
    const space = this.state.spaces.find(
      (item) => item.control?.hold === holdId,
    );
    if (!space) return;
    this.registry.takeBack(space.id, this.shownTab(space.id) ?? null);
    this.emit();
  }
  grantAccess(spaceId: string) {
    this.registry.grant(spaceId);
    this.emit();
  }
  endAccess(
    spaceId: string,
    ended: { by: "agent" | "person"; reason: "finished" | "stopped" },
  ) {
    this.registry.end(spaceId, ended);
    this.addActivity(
      spaceId,
      ended.by === "agent" ? "Agent finished" : "You stopped the agent",
      ended.by === "agent" ? "success" : "info",
    );
    this.emit();
  }
  resetAgentAccess() {
    this.registry.reset();
    this.state.spaceRequests = [];
    this.emit();
  }
  addSpaceRequest(request: { reason: string; name?: string }) {
    const added: SpaceRequest = {
      id: crypto.randomUUID(),
      reason: request.reason,
      ...(request.name === undefined ? {} : { name: request.name }),
      at: Date.now(),
    };
    this.state.spaceRequests.push(added);
    this.emit();
    return added;
  }
  removeSpaceRequest(id: string) {
    this.state.spaceRequests = this.state.spaceRequests.filter(
      (request) => request.id !== id,
    );
    this.emit();
  }
  async keepAsPersonal(spaceId: string) {
    const space = this.state.spaces.find((item) => item.id === spaceId);
    if (space?.kind !== "agent" || space.access !== "ended")
      throw new Error(
        "Only a space whose agent has finished or stopped can be kept.",
      );
    space.kind = "personal";
    delete space.access;
    delete space.ended;
    this.emit();
  }
  // A popup the page at openerId opens, as BrowserController adopts one.
  openPopup(openerId: string, url: string): Tab {
    const opener = this.getTab(openerId);
    const space = this.state.spaces.find(
      (item) => item.id === opener.spaceId,
    )!;
    const tab = newTab(space.id, url);
    this.registry.register(tab, {
      openedBy: "page",
      openerId,
      managed: !!opener.managed && space.owner === "agent",
    });
    this.state.tabs.push(tab);
    if (!agentRules(space)) {
      this.state.activeSpaceId = tab.spaceId;
      this.state.activeTabId = tab.id;
    }
    if (isWebUrl(tab.url)) this.ensureView(tab);
    this.emit();
    return tab;
  }
  // A tab the person opened in a space, registered the way the
  // controller's tab:create registers it.
  openPersonTab(spaceId: string, url = HOME_URL): Tab {
    const tab = newTab(spaceId, url);
    this.registry.register(tab, { openedBy: "person", managed: false });
    this.state.tabs.push(tab);
    if (isWebUrl(tab.url)) this.ensureView(tab);
    this.emit();
    return tab;
  }
  private getTab(id: string): Tab {
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!tab) throw new Error("Tab was not found.");
    return tab;
  }
  // As in BrowserController: the label retires, and a space left without
  // tabs gets a blank one with the closer's origin.
  private removeTab(tab: Tab, by: ClosedBy) {
    this.registry.retire(tab, by);
    this.state.tabs = this.state.tabs.filter((item) => item !== tab);
    let replacement: Tab | undefined;
    if (!this.state.tabs.some((item) => item.spaceId === tab.spaceId)) {
      replacement = newTab(tab.spaceId);
      this.registry.register(
        replacement,
        by === "agent"
          ? { openedBy: "agent", managed: true }
          : by === "person"
            ? { openedBy: "person", managed: false }
            : { openedBy: tab.openedBy ?? "person", managed: !!tab.managed },
      );
      this.state.tabs.push(replacement);
    }
    return {
      ...(tab.label ? { closed: tab.label } : {}),
      ...(replacement ? { replacement } : {}),
    };
  }
  async dispatch(action: BrowserAction) {
    this.calls.push(action);
    if (action.type === "tab:create") {
      const tab = newTab(action.spaceId!, action.url);
      this.registry.register(tab, { openedBy: "person", managed: false });
      this.state.tabs.push(tab);
      if (!action.background) {
        this.state.activeSpaceId = tab.spaceId;
        this.state.activeTabId = tab.id;
      }
      if (isWebUrl(tab.url)) this.ensureView(tab);
    } else if (action.type === "tab:navigate") {
      const tab = this.state.tabs.find((item) => item.id === action.id)!;
      tab.url = action.url;
      if (isWebUrl(tab.url)) this.ensureView(tab);
    } else if (action.type === "space:ownership") {
      if (action.owner === "human")
        this.registry.handOver(action.id, {
          reason: action.reason ?? "manual",
        });
      else this.registry.takeBack(action.id, this.shownTab(action.id) ?? null);
    } else if (action.type === "space:delete") {
      this.state.spaces = this.state.spaces.filter(
        (space) => space.id !== action.id,
      );
      this.state.tabs = this.state.tabs.filter(
        (tab) => tab.spaceId !== action.id,
      );
      this.registry.forget(action.id);
    } else if (action.type === "tab:close") {
      const tab = this.state.tabs.find((item) => item.id === action.id);
      if (tab) this.removeTab(tab, "person");
    }
    this.emit();
    return this.state;
  }
}

// Each test gets its own short socket; Windows uses a unique named pipe.
export function testSocket() {
  if (process.platform === "win32")
    return {
      path: `\\\\.\\pipe\\kamapathy-test-${randomBytes(12).toString("hex")}`,
      cleanup: () => {},
    };
  const directory = mkdtempSync(join(tmpdir(), "kamapathy-api-"));
  return {
    path: join(directory, "api.sock"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

// fetch cannot reach a socket; this mirrors the skill client's socketFetch.
export function socketFetch(socketPath: string) {
  return (
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        {
          socketPath,
          path,
          agent: false,
          method: init.method || "GET",
          headers: {
            Host: "kamapathy",
            ...init.headers,
            ...(init.body !== undefined
              ? { "Content-Length": String(Buffer.byteLength(init.body)) }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers))
              for (const item of ([] as string[]).concat(value ?? []))
                headers.append(name, item);
            resolve(
              new Response(Buffer.concat(chunks), {
                status: response.statusCode!,
                headers,
              }),
            );
          });
        },
      );
      request.once("error", reject);
      request.end(init.body);
    });
}
