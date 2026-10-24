import type { WebContents } from "electron";
import type { Tab } from "../../../shared/types";
import type { AutomationController } from "../server";
import type { EventBuffer, EventBufferPool } from "./event-buffer";
import { TabSession } from "./tab-session";
import type { SessionHost } from "./types";

export interface TabSessionsOptions {
  controller: AutomationController;
  agentDriven(spaceId: string): boolean;
  managedTab(tabId: string): boolean;
  waitForSpaceIdle(spaceId: string, timeoutMs: number): Promise<void>;
  buffers: EventBufferPool;
  // Called with each new session before it attaches.
  onOpen?(session: TabSession): void;
}

// Decides which tabs hold a debugger session: those with a page, in a space
// the agent drives, that the agent manages. Every other tab, the person's
// included, holds none.
export class TabSessions {
  private current = new Map<string, TabSession>();
  // Sessions until their release ends; after that only their attach counts.
  private live = new Set<TabSession>();
  private retired = new Map<string, number>();
  // A page's next session attaches only after its last one has detached.
  private releases = new Map<SessionHost, Promise<void>>();
  private waiting = new WeakMap<TabSession, Promise<void>>();
  private stops: (() => void)[] = [];
  // Told of every session this policy opens, before it attaches.
  private openListeners = new Set<(session: TabSession, tab: Tab) => void>();
  private closed = false;
  // Each tab's event log, kept across its sessions until the tab closes.
  private buffers = new Map<string, EventBuffer>();

  constructor(private readonly options: TabSessionsOptions) {}

  start(): void {
    const { controller } = this.options;
    this.stops.push(
      controller.subscribe(() => this.sync()),
      controller.onViewCreated((tabId, contents) =>
        this.viewCreated(tabId, contents),
      ),
    );
    this.sync();
  }

  sync(): void {
    if (this.closed) return;
    const { tabs } = this.options.controller.state;
    const wanted = new Map<string, WebContents>();
    for (const tab of tabs) {
      const contents = this.wanted(tab);
      if (contents) wanted.set(tab.id, contents);
    }
    for (const [tabId, session] of this.current)
      if (wanted.get(tabId) !== session.contents) this.release(tabId);
    for (const [tabId, buffer] of this.buffers)
      if (!tabs.some((tab) => tab.id === tabId)) {
        buffer.dispose();
        this.buffers.delete(tabId);
      }
    for (const tab of tabs) {
      const contents = wanted.get(tab.id);
      if (contents && !this.current.has(tab.id)) this.open(tab, contents);
    }
  }

  get(tabId: string): TabSession | undefined {
    const session = this.current.get(tabId);
    return session?.state === "released" ? undefined : session;
  }

  /** Every session this policy opens, before it attaches. */
  onSession(listener: (session: TabSession, tab: Tab) => void): () => void {
    this.openListeners.add(listener);
    return () => {
      this.openListeners.delete(listener);
    };
  }

  attaches(tabId: string): number {
    let total = this.retired.get(tabId) ?? 0;
    for (const session of this.live)
      if (session.tabId === tabId) total += session.attachCount;
    return total;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const stop of this.stops.splice(0)) stop();
      for (const tabId of [...this.current.keys()]) this.release(tabId);
    }
    await Promise.all(this.releases.values());
    for (const buffer of this.buffers.values()) buffer.dispose();
    this.buffers.clear();
  }

  // The space is checked first, so the person's own tabs are never looked up.
  private wanted(tab: Tab): WebContents | undefined {
    if (
      !this.options.agentDriven(tab.spaceId) ||
      !this.options.managedTab(tab.id)
    )
      return undefined;
    const contents = this.options.controller.peekWebContents(tab.id);
    return contents && !contents.isDestroyed() ? contents : undefined;
  }

  // A new page gets its session here, before its first load.
  private viewCreated(tabId: string, contents: WebContents): void {
    if (this.closed) return;
    const tab = this.options.controller.state.tabs.find(
      (item) => item.id === tabId,
    );
    if (
      !tab ||
      !this.options.agentDriven(tab.spaceId) ||
      !this.options.managedTab(tabId) ||
      this.current.get(tabId)?.contents === contents
    )
      return;
    this.release(tabId);
    this.open(tab, contents);
  }

  private open(tab: Tab, contents: WebContents): void {
    let buffer = this.buffers.get(tab.id);
    if (!buffer) {
      buffer = this.options.buffers.create(tab.id);
      this.buffers.set(tab.id, buffer);
    }
    const session = new TabSession(contents, {
      tabId: tab.id,
      waitForSpaceIdle: (timeoutMs) =>
        this.options.waitForSpaceIdle(tab.spaceId, timeoutMs),
      buffer,
    });
    this.options.onOpen?.(session);
    this.current.set(tab.id, session);
    this.live.add(session);
    session.on("closed", () => {
      if (this.current.get(tab.id) === session) this.current.delete(tab.id);
      this.retire(session);
    });
    // Setup hooks and init scripts are registered here, before the attach.
    for (const listener of [...this.openListeners])
      try {
        listener(session, tab);
      } catch (error) {
        console.error("A tab session listener failed:", error);
      }
    const previous = this.releases.get(contents);
    if (!previous) {
      session.attach();
      return;
    }
    this.waiting.set(session, previous);
    void previous.then(() => {
      if (this.current.get(tab.id) === session) session.attach();
    });
  }

  private release(tabId: string): void {
    const session = this.current.get(tabId);
    if (!session) return;
    this.current.delete(tabId);
    const previous = this.waiting.get(session);
    const done = (
      previous ? previous.then(() => session.release()) : session.release()
    )
      .catch(() => {})
      .then(() => this.retire(session));
    this.releases.set(session.contents, done);
    void done.then(() => {
      if (this.releases.get(session.contents) === done)
        this.releases.delete(session.contents);
    });
  }

  private retire(session: TabSession): void {
    if (!this.live.delete(session)) return;
    this.retired.set(
      session.tabId,
      (this.retired.get(session.tabId) ?? 0) + session.attachCount,
    );
  }
}
