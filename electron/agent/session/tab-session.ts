import {
  CdpTimeoutError,
  PageCrashedError,
  SessionLostError,
  TabClosedError,
  TargetRefusedError,
} from "./errors";
import type {
  CdpEvent,
  SendStep,
  SessionHost,
  SessionState,
  SetupHook,
  Step,
} from "./types";

export const SETUP_TIMEOUT_MS = 5000;
export const REATTACH_AT_MS = [0, 250, 1000, 4000];

export interface TabSessionOptions {
  tabId: string;
  waitForSpaceIdle(timeoutMs: number): Promise<void>;
}

type Listener = (event: CdpEvent) => void | Promise<unknown>;
type Pending = { guard?: () => void; fail(error: unknown): void };
type TreeFrame = { id: string; loaderId: string };
type FrameTree = { frameTree: { frame: TreeFrame } };

const REFUSED = /^(Target|Browser)\./;
const DISPATCHES =
  /^(Input\.|Page\.(navigate|reload|navigateToHistoryEntry)$|DOM\.setFileInputFiles$)/;

// Once release starts, only commands that let go of held keys and end an
// intercepted drag reach the page.
const releasesInput = (method: string, params: Record<string, unknown>) =>
  (method === "Input.dispatchKeyEvent" && params.type === "keyUp") ||
  (method === "Input.dispatchDragEvent" && params.type === "dragCancel") ||
  (method === "Input.setInterceptDrags" && params.enabled === false);
const report = (error: unknown) =>
  console.error("A tab session listener failed:", error);

// The only code that uses a tab's webContents.debugger, for as long as an
// agent drives the tab.
export class TabSession {
  readonly tabId: string;
  private readonly cdp: SessionHost["debugger"];
  private current: SessionState = "attaching";
  private connected = false;
  private releasing = false;
  private closed = false;
  private released?: Promise<void>;
  // Changes with every connection, so replies meant for an earlier one are
  // ignored.
  private generation = 0;
  private navigations = 0;
  private attaches = 0;
  private setupDepth = 0;
  private awaitingCommit = false;
  private setupTimer?: ReturnType<typeof setTimeout>;
  private retries: ReturnType<typeof setTimeout>[] = [];
  private main?: { frameId: string; loaderId: string };
  // Iframe sessions, each with the session that reported it.
  private children = new Map<string, { parent?: string }>();
  private hooks = new Set<SetupHook>();
  private listeners = new Map<string, Set<Listener>>();
  private pending = new Set<Pending>();
  private waiters = new Set<() => void>();

  constructor(
    readonly contents: SessionHost,
    private readonly options: TabSessionOptions,
  ) {
    this.tabId = options.tabId;
    this.cdp = contents.debugger;
    contents.on("did-start-navigation", this.onStartNavigation);
    contents.on("did-navigate", this.onNavigate);
    contents.on("did-fail-load", this.onFailLoad);
    contents.on("render-process-gone", this.onGone);
    contents.on("devtools-closed", this.onDevToolsClosed);
    contents.on("destroyed", this.onDestroyed);
    this.cdp.on("message", this.onMessage);
    this.cdp.on("detach", this.onDetach);
  }

  get state(): SessionState {
    return this.current;
  }
  get epoch(): number {
    return this.navigations;
  }
  get attachCount(): number {
    return this.attaches;
  }

  attach(): void {
    if (
      this.current === "attaching" &&
      !this.connected &&
      !this.releasing &&
      !this.closed
    )
      this.connect();
  }

  release(): Promise<void> {
    this.released ??= this.leave();
    return this.released;
  }

  async send<T = any>(
    method: string,
    params: object = {},
    step?: SendStep,
  ): Promise<T> {
    const sessionId = step?.sessionId || undefined;
    if (
      REFUSED.test(method) ||
      (sessionId !== undefined && !this.children.has(sessionId))
    )
      throw new TargetRefusedError(method);
    step?.guard?.();
    if (this.releasing || this.current === "released") {
      if (
        this.closed ||
        !releasesInput(method, params as Record<string, unknown>)
      )
        throw this.lostError();
    } else if (
      this.current !== "ready" &&
      !(this.setupDepth > 0 && this.current === "attaching")
    ) {
      try {
        await this.usable(step?.deadline ?? Date.now() + 15000);
      } catch (error) {
        step?.guard?.();
        throw error;
      }
      step?.guard?.();
    }
    const timeoutMs = Math.min(
      step?.timeoutMs ?? 15000,
      step ? step.deadline - Date.now() : Infinity,
    );
    if (timeoutMs <= 0) throw new CdpTimeoutError("page");
    if (step?.dispatch && (step.mutates || DISPATCHES.test(method)))
      step.dispatch.dispatched = true;
    const reply = await this.command<T>(
      method,
      params,
      sessionId,
      timeoutMs,
      step?.guard,
    );
    step?.guard?.();
    return reply;
  }

  on(name: string, listener: Listener): () => void {
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    this.listeners.set(name, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  onSessionSetup(hook: SetupHook): () => void {
    this.hooks.add(hook);
    if (this.connected && !this.releasing && this.current !== "crashed") {
      this.setupDepth += 1;
      try {
        for (const sessionId of [undefined, ...this.children.keys()])
          hook(sessionId).catch(() => {});
      } finally {
        this.setupDepth -= 1;
      }
    }
    return () => {
      this.hooks.delete(hook);
    };
  }

  async mainFrameId(step: Step): Promise<string> {
    if (this.current === "ready" && !this.releasing && this.main)
      return this.main.frameId;
    const reply = await this.send<FrameTree>("Page.getFrameTree", {}, step);
    this.keepMain(reply.frameTree.frame);
    return reply.frameTree.frame.id;
  }

  private connect(): boolean {
    try {
      this.cdp.attach("1.3");
    } catch {
      this.setState(
        this.contents.isDevToolsOpened() ? "devtools" : "unavailable",
      );
      return false;
    }
    this.connected = true;
    this.attaches += 1;
    const generation = ++this.generation;
    this.setState("attaching");
    const replies = this.setup(undefined);
    // With no document yet, the clock starts at the first commit, so a slow
    // first response is not taken for a dead session.
    if (this.contents.getURL()) this.startSetupTimer();
    else this.awaitingCommit = true;
    void Promise.allSettled(replies).then(() => {
      if (
        generation !== this.generation ||
        this.current !== "attaching" ||
        this.releasing
      )
        return;
      clearTimeout(this.setupTimer);
      this.awaitingCommit = false;
      this.setState("ready");
      this.emit("attached", {});
    });
    return true;
  }

  // Sends a session's setup in order and awaits no reply. A new view answers
  // only once its first navigation starts, and that waits for attach().
  private setup(sessionId: string | undefined, waiting = false) {
    const generation = this.generation;
    this.setupDepth += 1;
    try {
      const replies: Promise<unknown>[] = [
        this.command("Page.enable", {}, sessionId),
        this.command(
          "Page.setLifecycleEventsEnabled",
          { enabled: true },
          sessionId,
        ),
        this.command(
          "Network.enable",
          { maxTotalBufferSize: 10000000, maxResourceBufferSize: 5000000 },
          sessionId,
        ),
        // Pausing new frames until their setup ended stalled their loads, so
        // they start at once, and an init script added at attach can miss a
        // frame's first scripts.
        this.command(
          "Target.setAutoAttach",
          {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,
            filter: [{ type: "iframe", exclude: false }, { exclude: true }],
          },
          sessionId,
        ),
        ...[...this.hooks].map((hook) => hook(sessionId)),
      ];
      if (waiting)
        replies.push(
          this.command("Runtime.runIfWaitingForDebugger", {}, sessionId),
        );
      replies.push(
        this.command<FrameTree>("Page.getFrameTree", {}, sessionId).then(
          (reply) => {
            if (sessionId === undefined && generation === this.generation)
              this.keepMain(reply.frameTree.frame);
          },
        ),
      );
      return replies;
    } finally {
      this.setupDepth -= 1;
    }
  }

  // The private sender behind send and setup, and the only one that sends
  // Target commands. Electron refuses an empty session id, so page commands go
  // without one.
  private command<T = any>(
    method: string,
    params: object,
    sessionId?: string,
    timeoutMs?: number,
    guard?: () => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const reply: Promise<T> =
        sessionId === undefined
          ? this.cdp.sendCommand(method, params)
          : this.cdp.sendCommand(method, params, sessionId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: Pending = {
        guard,
        fail: (error) => {
          clearTimeout(timer);
          this.pending.delete(entry);
          reject(error);
        },
      };
      this.pending.add(entry);
      if (timeoutMs !== undefined)
        timer = setTimeout(
          () => entry.fail(new CdpTimeoutError("page")),
          timeoutMs,
        );
      reply.then((value) => {
        clearTimeout(timer);
        this.pending.delete(entry);
        resolve(value);
      }, entry.fail);
    });
  }

  // Electron rejects every pending command when its session ends. Each fails
  // with the cause instead, or with its guard's error, so a command cut off
  // by a takeover still reports the person's control.
  private failPending(cause: () => Error): void {
    for (const entry of [...this.pending]) {
      let error: unknown = cause();
      try {
        entry.guard?.();
      } catch (refusal) {
        error = refusal;
      }
      entry.fail(error);
    }
  }

  private async usable(deadline: number): Promise<void> {
    if (this.current === "unavailable") {
      if (!this.connect()) throw this.lostError();
      return this.whenReady(Math.min(deadline, Date.now() + 2000));
    }
    if (this.current !== "attaching") throw this.lostError();
    // A first attach may wait out a slow first load; a re-attach gets 2000 ms.
    return this.whenReady(
      this.attaches > 1 ? Math.min(deadline, Date.now() + 2000) : deadline,
    );
  }

  private whenReady(limit: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.current === "attaching" && !this.releasing) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        if (this.current === "ready" && !this.releasing) resolve();
        else reject(this.lostError());
      };
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new CdpTimeoutError("page"));
      }, limit - Date.now());
      this.waiters.add(check);
    });
  }

  private lostError(): Error {
    if (this.closed) return new TabClosedError();
    if (this.releasing) return new SessionLostError("unavailable");
    if (this.current === "crashed") return new PageCrashedError();
    return new SessionLostError(
      this.current === "devtools" ? "devtools" : "unavailable",
    );
  }

  private setState(next: SessionState): void {
    this.current = next;
    this.notify();
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private emit(
    name: string,
    params: unknown,
    sessionId?: string,
  ): Promise<unknown>[] {
    const event: CdpEvent =
      sessionId === undefined
        ? { method: name, params, at: Date.now() }
        : { method: name, params, sessionId, at: Date.now() };
    const waits: Promise<unknown>[] = [];
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      try {
        const result = listener(event);
        if (result instanceof Promise) waits.push(result.catch(report));
      } catch (error) {
        report(error);
      }
    }
    return waits;
  }

  private keepMain(frame: TreeFrame): void {
    this.main = { frameId: frame.id, loaderId: frame.loaderId };
  }

  private adopt(params: any, parent: string | undefined): void {
    const sessionId: string = params.sessionId;
    // A releasing session sets up nothing new.
    if (params.targetInfo?.type !== "iframe" || this.releasing) {
      const resume = params.waitingForDebugger
        ? this.command("Runtime.runIfWaitingForDebugger", {}, sessionId)
        : Promise.resolve();
      resume
        .catch(() => {})
        .then(() =>
          this.command("Target.detachFromTarget", { sessionId }, parent),
        )
        .catch(() => {});
      return;
    }
    // Registered before its setup, so its hooks can address it.
    this.children.set(sessionId, { parent });
    const generation = this.generation;
    const replies = this.setup(sessionId, params.waitingForDebugger === true);
    Promise.all(replies).catch(() => {
      if (generation !== this.generation || !this.children.has(sessionId))
        return;
      this.forget(sessionId);
      this.command("Target.detachFromTarget", { sessionId }, parent).catch(
        () => {},
      );
    });
  }

  private forget(sessionId: string): void {
    if (!this.children.delete(sessionId)) return;
    for (const [id, child] of this.children)
      if (child.parent === sessionId) this.forget(id);
  }

  private committed(): void {
    if (!this.awaitingCommit || !this.connected || this.current !== "attaching")
      return;
    this.awaitingCommit = false;
    this.startSetupTimer();
  }

  private startSetupTimer(): void {
    const generation = this.generation;
    clearTimeout(this.setupTimer);
    this.setupTimer = setTimeout(() => {
      if (generation !== this.generation || this.current !== "attaching")
        return;
      this.drop("setup_timeout");
      this.cdp.detach();
    }, SETUP_TIMEOUT_MS);
  }

  // Forgets everything the lost connection held and fails what waited on it.
  private drop(reason: string): void {
    this.connected = false;
    this.generation += 1;
    this.awaitingCommit = false;
    clearTimeout(this.setupTimer);
    this.children.clear();
    this.main = undefined;
    this.failPending(() => new SessionLostError("unavailable"));
    this.setState("unavailable");
    this.emit("detached", { reason });
  }

  private scheduleReattach(): void {
    this.stopRetries();
    this.retries = REATTACH_AT_MS.map((delay) =>
      setTimeout(() => {
        if (this.current !== "unavailable" || this.releasing || this.closed)
          return;
        if (this.connect()) this.stopRetries();
      }, delay),
    );
  }

  private stopRetries(): void {
    for (const timer of this.retries) clearTimeout(timer);
    this.retries = [];
  }

  // The debugger outlives a renderer crash, so the next document only needs
  // its frame tree read again.
  private recover(): void {
    const generation = this.generation;
    this.command<FrameTree>("Page.getFrameTree", {}).then(
      (reply) => {
        if (
          generation !== this.generation ||
          this.current !== "crashed" ||
          this.releasing
        )
          return;
        this.keepMain(reply.frameTree.frame);
        this.setState("ready");
      },
      () => {},
    );
  }

  private async leave(): Promise<void> {
    if (this.closed) return;
    this.releasing = true;
    this.stopRetries();
    clearTimeout(this.setupTimer);
    this.notify();
    const waits = this.emit("releasing", {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(waits),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 500);
      }),
    ]);
    clearTimeout(timer);
    try {
      await this.options.waitForSpaceIdle(2000);
    } finally {
      if (this.connected) {
        this.connected = false;
        this.generation += 1;
        this.failPending(() => new SessionLostError("unavailable"));
        this.cdp.detach();
      }
      this.children.clear();
      this.setState("released");
      this.dispose();
    }
  }

  private dispose(): void {
    this.stopRetries();
    clearTimeout(this.setupTimer);
    this.contents.removeListener(
      "did-start-navigation",
      this.onStartNavigation,
    );
    this.contents.removeListener("did-navigate", this.onNavigate);
    this.contents.removeListener("did-fail-load", this.onFailLoad);
    this.contents.removeListener("render-process-gone", this.onGone);
    this.contents.removeListener("devtools-closed", this.onDevToolsClosed);
    this.contents.removeListener("destroyed", this.onDestroyed);
    this.cdp.removeListener("message", this.onMessage);
    this.cdp.removeListener("detach", this.onDetach);
  }

  private readonly onMessage = (
    _event: unknown,
    method: string,
    params: any,
    sessionId: string,
  ) => {
    if (!this.connected) return;
    const source = sessionId || undefined;
    if (source !== undefined && !this.children.has(source)) return;
    if (method === "Target.attachedToTarget") this.adopt(params, source);
    else if (method === "Target.detachedFromTarget")
      this.forget(params.sessionId);
    else if (
      method === "Page.frameNavigated" &&
      source === undefined &&
      !params.frame.parentId
    )
      this.keepMain(params.frame);
    this.emit(method, params, source);
  };

  // Electron reports the session's own detach() too. Every own detach clears
  // connected first, so only a loss gets past the check.
  private readonly onDetach = (_event: unknown, reason: string) => {
    if (!this.connected) return;
    this.drop(reason);
    if (!this.releasing && !this.contents.isDestroyed())
      this.scheduleReattach();
  };

  private readonly onStartNavigation = (details: {
    isMainFrame: boolean;
    isSameDocument: boolean;
  }) => {
    if (details.isMainFrame && !details.isSameDocument) this.navigations += 1;
  };

  private readonly onNavigate = () => {
    this.committed();
    if (this.current === "crashed" && this.connected && !this.releasing)
      this.recover();
  };

  private readonly onFailLoad = (
    _event: unknown,
    _code: number,
    _description: string,
    _url: string,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) this.committed();
  };

  private readonly onGone = () => {
    if (!this.connected) return;
    this.failPending(() => new PageCrashedError());
    this.setState("crashed");
  };

  private readonly onDevToolsClosed = () => {
    if (this.current === "devtools" && !this.releasing) this.connect();
  };

  private readonly onDestroyed = () => {
    this.closed = true;
    this.connected = false;
    this.generation += 1;
    this.children.clear();
    this.failPending(() => new TabClosedError());
    this.setState("released");
    this.emit("closed", {});
    this.dispose();
  };
}
