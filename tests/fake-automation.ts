import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import type { AutomationController } from "../electron/agent/server";
import { TabRegistry } from "../electron/agent/tab-registry";
import {
  agentRules,
  HOME_URL,
  initialState,
  newTab,
  openingTab,
  PAGE_BUDGET,
} from "../shared/state";
import type {
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

// A page whose debugger answers page operations with `result`. It records
// each operation with the world it ran in, and each input command.
export class FakeContents extends FakeHost {
  scripts: { world: string; code: string }[] = [];
  captureCalls = 0;
  captureError?: Error;
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
      return { result: { type: "object", value } };
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
  // A protocol event Chromium sends to an attached debugger.
  emitProtocol(method: string, parameters: Record<string, unknown>) {
    this.debugger.event(method, parameters);
  }
  async capturePage() {
    this.captureCalls += 1;
    if (this.captureError) throw this.captureError;
    return {
      isEmpty: () => false,
      toPNG: () => Buffer.from([137, 80, 78, 71]),
    };
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
  activity: { spaceId?: string; message: string; kind: string }[] = [];
  accessedTabs: string[] = [];
  captureAvailable = true;
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
  canCapturePage() {
    return this.captureAvailable;
  }
  addActivity(spaceId: string | undefined, message: string, kind: string) {
    this.activity.push({ spaceId, message, kind });
  }
  shownTab(spaceId: string): Tab | undefined {
    if (spaceId === this.state.activeSpaceId)
      return this.state.tabs.find((tab) => tab.id === this.state.activeTabId);
    return openingTab(this.state, spaceId);
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
