import { AsyncLocalStorage } from "node:async_hooks";
import type { PageOperation } from "../../automation-dom";
import type { PageStateOperation } from "../dom/page-state";
import { ApiError } from "../errors";
import {
  CaptureFailedError,
  CdpTimeoutError,
  ContextLostError,
  DialogOpenError,
  FrameBlockedError,
  FrameGoneError,
  PageCrashedError,
  SessionLostError,
  TabClosedError,
  TargetRefusedError,
} from "./errors";
import type { EventBuffer } from "./event-buffer";
import { FrameRegistry, type FrameRecord } from "./frames";
import { LifecycleTracker, reached } from "./lifecycle";
import { NetworkTracker, type RequestFailure } from "./network";
import {
  OPERATIONS,
  PAGE_SOURCE,
  WORLD_NAME,
  operationExpression,
} from "./operations";
import type {
  CdpEvent,
  DialogInfo,
  FrameInfo,
  KnownFrame,
  SendStep,
  SessionHost,
  SessionState,
  SetupHook,
  Step,
} from "./types";

export const SETUP_TIMEOUT_MS = 5000;
export const REATTACH_AT_MS = [0, 250, 1000, 4000];
// How long the frame tree a crashed session's next document needs may take
// before the session counts as crashed again.
export const RECOVER_TIMEOUT_MS = 2000;

export interface TabSessionOptions {
  tabId: string;
  waitForSpaceIdle(timeoutMs: number): Promise<void>;
  buffer: EventBuffer;
}

type Listener = (event: CdpEvent) => void | Promise<unknown>;
type Pending = {
  method: string;
  guard?: () => void;
  fail(error: unknown): void;
};
// An init script, with the identifier each live session gave it, keyed by
// session id ("" for the page session).
type InitScript = {
  source: string;
  world: "main" | "isolated";
  identifiers: Map<string, string>;
};
type FrameTree = { frameTree: { frame: { id: string } } };
type World = Promise<{ contextId: number }>;
type FrameChange = {
  frameId: string;
  change: "attached" | "navigated" | "detached";
};

const REFUSED = /^(Target|Browser)\./;
// The connection each running setup hook belongs to, kept across the hook's
// awaits, so every command it sends goes out while its session sets up.
const hookSetup = new AsyncLocalStorage<{
  session: TabSession;
  generation: number;
}>();
// The execution context a command names, if any.
const contextOf = (params: object): number | undefined => {
  const { executionContextId, contextId } = params as {
    executionContextId?: unknown;
    contextId?: unknown;
  };
  const id = executionContextId ?? contextId;
  return typeof id === "number" ? id : undefined;
};
const DISPATCHES =
  /^(Input\.|Page\.(navigate|reload|navigateToHistoryEntry)$|DOM\.setFileInputFiles$)/;
// An open JavaScript dialog holds these until it closes: the renderer is
// stopped inside the dialog, so none of them answers. Page.getFrameTree
// stays out, because setup sends it through the same pending set.
const DIALOG_HOLDS =
  /^(Input\.|Runtime\.|DOM\.|Accessibility\.|Page\.(navigate|reload|captureScreenshot|getLayoutMetrics)$)/;
// The one command a navigation of the main frame's document leaves without
// a reply.
const CAPTURES = /^Page\.captureScreenshot$/;
// What a failed capture means. A crash, a lost session and the deadline all
// stop it; anything else Chromium reports is a rendering failure, and its
// message stays in the main process. Failures with a meaning of their own,
// a guard's refusal included, pass through.
const captureFailure = (error: unknown): unknown => {
  if (error instanceof PageCrashedError)
    return new CaptureFailedError("crashed");
  if (error instanceof SessionLostError)
    return new CaptureFailedError("detached");
  if (error instanceof CdpTimeoutError)
    return new CaptureFailedError("timeout");
  if (
    error instanceof CaptureFailedError ||
    error instanceof ApiError ||
    error instanceof TabClosedError ||
    error instanceof DialogOpenError ||
    error instanceof TargetRefusedError ||
    !(error instanceof Error)
  )
    return error;
  return new CaptureFailedError("failed");
};
// Kamapathy's own sessions record only page and network events.
const RECORDED = /^(Page|Network)\./;
// How many agent sessions a tab remembers the frame of.
const AGENT_FRAMES = 256;
// Dialog text keeps tab and newline, and loses other control characters and
// bidirectional overrides.
const UNSAFE_TEXT =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const dialogText = (text: unknown) =>
  String(text ?? "")
    .replace(UNSAFE_TEXT, "")
    .slice(0, 2000);
// An init script runs only in a web frame's document, so a blocked frame that
// shares a session runs none. The check and the source run in separate
// functions, so the source may declare any name.
const initSource = (source: string) =>
  `if ((() => { const p = location.protocol, o = location.origin; return ["http:", "https:", "about:", "data:", "blob:"].includes(p) && (o === "null" || o.startsWith("http:") || o.startsWith("https:")); })()) (() => { ${source}\n})();`;

// Once release starts, only commands that let go of held keys and end an
// intercepted drag reach the page.
const releasesInput = (method: string, params: Record<string, unknown>) =>
  (method === "Input.dispatchKeyEvent" && params.type === "keyUp") ||
  (method === "Input.dispatchDragEvent" && params.type === "dragCancel") ||
  (method === "Input.setInterceptDrags" && params.enabled === false);
const report = (error: unknown) =>
  console.error("A tab session listener failed:", error);
// The events lifecycle and network tracking follow. Method listeners hear
// only Kamapathy's own sessions, never an agent's.
const LOADING_EVENTS = [
  "Page.lifecycleEvent",
  "Page.frameNavigated",
  "Network.requestWillBeSent",
  "Network.loadingFinished",
  "Network.loadingFailed",
];
type Commit = { frameId: string; loaderId: string };
// The document an event says a frame committed: a live init, the commit
// that turning lifecycle events on replays, or Page.frameNavigated.
const commitOf = ({ method, params }: CdpEvent): Commit | undefined => {
  if (method === "Page.frameNavigated")
    return { frameId: params.frame.id, loaderId: params.frame.loaderId };
  if (
    method === "Page.lifecycleEvent" &&
    (params.name === "init" || params.name === "commit")
  )
    return { frameId: params.frameId, loaderId: params.loaderId };
  return undefined;
};
// What a failed call into one of Kamapathy's worlds means: a context gone
// before the call ran, or one destroyed while it ran.
const lostContext = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (
    /Cannot find context with specified id|Node with given id does not belong to the document/.test(
      message,
    )
  )
    return new ContextLostError(false);
  if (
    /Execution context was destroyed|Inspected target navigated or closed/.test(
      message,
    )
  )
    return new ContextLostError(true);
  return error;
};
// Frame paths hold their owner elements in this object group until released.
const FRAME_GROUP = "kamapathy-frames";
const FRAME_INDEX = `function(namespace){return (${PAGE_SOURCE})("frameIndex",{element:this},namespace)}`;

// How many main-frame navigations each page has started while a session
// watched it. A page's next session counts on from there, so refs from
// before a takeover keep their namespace when the agent takes the page back.
const pageEpochs = new WeakMap<SessionHost, number>();

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
  private awaitingCommit = false;
  private setupTimer?: ReturnType<typeof setTimeout>;
  private retries: ReturnType<typeof setTimeout>[] = [];
  private readonly registry = new FrameRegistry();
  private lifecycle = new LifecycleTracker();
  private requests = new NetworkTracker();
  // Lifecycle waits, checked again on every change that can settle them.
  private lifecycleWaits = new Set<(commit?: Commit) => void>();
  // The documents a ready probe is reading.
  private probes = new Set<string>();
  // Ends every wait once release starts or the tab closes.
  private ending = new AbortController();
  readonly network: {
    inFlight(): number;
    pending(limit: number): string[];
    lastActivityAt(): number;
    failureFor(url: string): RequestFailure | undefined;
    waitForIdle(idleMs: number, step: Step): Promise<void>;
  } = {
    inFlight: () => this.requests.inFlight(),
    pending: (limit) => this.requests.pending(limit),
    lastActivityAt: () => this.requests.lastActivityAt(),
    failureFor: (url) => this.requests.failureFor(url),
    waitForIdle: (idleMs, step) =>
      this.requests.waitForIdle(idleMs, {
        ...step,
        signal: this.waitSignal(step),
      }),
  };
  // Iframe sessions, each with the session that reported it.
  private children = new Map<string, { parent?: string }>();
  private hooks = new Set<SetupHook>();
  private listeners = new Map<string, Set<Listener>>();
  private pending = new Set<Pending>();
  private waiters = new Set<() => void>();
  private readonly buffer: EventBuffer;
  readonly events: Pick<EventBuffer, "recording" | "setRecording" | "drain"> & {
    /** Section 8's redactor, told whose session the event came from. */
    setRedactor(
      redact: (
        event: CdpEvent,
        source: { fromAgent: boolean },
      ) => CdpEvent | null,
    ): void;
  };
  private shown?: DialogInfo;
  private scripts = new Map<string, InitScript>();
  private scriptCount = 0;
  // Sessions openAgentSession attached, the targets it is attaching, and the
  // sessions closeAgentSession is detaching until Chromium reports them gone.
  private agents = new Set<string>();
  private opening = new Map<string, number>();
  private closingAgents = new Set<string>();
  // The frame each agent session was opened for, null for the tab's own
  // page. Kept after the session closes, so events it left in the buffer
  // still say where they came from.
  private agentFrames = new Map<string, string | null>();
  private targetId?: string;
  // The worlds handed out, by session and context id. Context ids restart in
  // each renderer process, so a call naming a world whose document ended
  // fails instead of running in whatever context has the id now.
  private handles = new Map<string, { frameId: string; world: World }>();

  constructor(
    readonly contents: SessionHost,
    private readonly options: TabSessionOptions,
  ) {
    this.tabId = options.tabId;
    this.cdp = contents.debugger;
    this.navigations = pageEpochs.get(contents) ?? 0;
    contents.on("did-start-navigation", this.onStartNavigation);
    contents.on("did-navigate", this.onNavigate);
    contents.on("did-fail-load", this.onFailLoad);
    contents.on("render-process-gone", this.onGone);
    contents.on("devtools-closed", this.onDevToolsClosed);
    contents.on("destroyed", this.onDestroyed);
    this.cdp.on("message", this.onMessage);
    this.cdp.on("detach", this.onDetach);
    for (const method of LOADING_EVENTS)
      this.on(method, (event) => this.trackLoading(event));
    // A session that ends takes its requests with it, and its frame's: the
    // frame's document request began on its parent's session.
    this.on("Target.detachedFromTarget", ({ params }) => {
      this.requests.dropSession(params.sessionId);
      if (params.targetId) this.requests.dropFrame(params.targetId);
    });
    this.on("frame", ({ params }) => {
      if (params.change !== "detached") return;
      this.requests.dropFrame(params.frameId);
      this.lifecycle.forget(params.frameId);
      this.wakeLifecycle();
    });
    this.on("attached", () => this.wakeLifecycle());
    // The lifecycle events that setup turns on again replay each document.
    this.on("detached", () => {
      this.lifecycle.clear();
      this.requests.clear();
    });
    this.on("releasing", () => {
      this.ending.abort(new SessionLostError("unavailable"));
    });
    this.on("closed", () => {
      this.ending.abort(new TabClosedError());
    });
    this.buffer = options.buffer;
    const buffer = this.buffer;
    this.events = {
      get recording() {
        return buffer.recording;
      },
      setRecording: (on, reason) => buffer.setRecording(on, reason),
      // Only this session knows which of its sessions are an agent's.
      setRedactor: (redact) =>
        buffer.setRedactor((event) =>
          redact(event, {
            fromAgent:
              event.sessionId !== undefined && this.agents.has(event.sessionId),
          }),
        ),
      drain: (max) => buffer.drain(max),
    };
    // A lost debugger takes its script identifiers, agent sessions, target id
    // and dialog with it, and leaves a gap in the events recorded until a
    // setup completes again.
    this.on("detached", () => {
      for (const script of this.scripts.values()) script.identifiers.clear();
      this.agents.clear();
      this.closingAgents.clear();
      this.targetId = undefined;
      this.setDialog(undefined);
      this.buffer.openGap("debugger_detached");
    });
    this.on("attached", () => this.buffer.closeGap());
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
  // The main frame the registry knows, undefined until a setup seeds it. A
  // CDP listener is synchronous and cannot await mainFrameId.
  get mainFrame(): string | undefined {
    return this.registry.mainFrameId;
  }
  // Whether the registry blocks a frame, for the same synchronous listeners.
  frameBlocked(frameId: string): boolean {
    return this.registry.get(frameId)?.blocked === true;
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
    const agent = sessionId !== undefined && this.agents.has(sessionId);
    const context = contextOf(params);
    // A world handed out on this session or on one that has since ended.
    const handle =
      context === undefined
        ? undefined
        : this.handles.get(`${sessionId ?? ""}|${context}`);
    if (
      REFUSED.test(method) ||
      (!handle &&
        sessionId !== undefined &&
        !this.children.has(sessionId) &&
        !agent)
    )
      throw new TargetRefusedError(method);
    step?.guard?.();
    // Context ids restart in each renderer process, so on Kamapathy's own
    // sessions a command may name only a world handed out for its frame's
    // current document.
    if (
      context !== undefined &&
      !agent &&
      (!handle ||
        this.registry.worldFor(handle.frameId, this.epoch) !== handle.world)
    )
      throw new ContextLostError(false);
    if (this.releasing || this.current === "released") {
      if (
        this.closed ||
        !releasesInput(method, params as Record<string, unknown>)
      )
        throw this.lostError();
    } else if (
      this.current !== "ready" &&
      !(this.current === "attaching" && this.inSetupHook())
    ) {
      try {
        await this.usable(step?.deadline ?? Date.now() + 15000, step);
      } catch (error) {
        step?.guard?.();
        throw error;
      }
      step?.guard?.();
    }
    if (this.shown && DIALOG_HOLDS.test(method))
      throw new DialogOpenError(this.shown, false);
    const timeoutMs = Math.min(
      step?.timeoutMs ?? 15000,
      step ? step.deadline - Date.now() : Infinity,
    );
    if (timeoutMs <= 0) throw new CdpTimeoutError("page");
    // Anything sent on an agent session may change the page.
    if (
      step?.dispatch &&
      (step.mutates ||
        DISPATCHES.test(method) ||
        (sessionId !== undefined && this.agents.has(sessionId)))
    )
      step.dispatch.dispatched = true;
    let reply: T;
    try {
      reply = await this.command<T>(
        method,
        params,
        sessionId,
        timeoutMs,
        step?.guard,
      );
    } catch (error) {
      throw handle ? lostContext(error) : error;
    }
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
    if (this.connected && !this.releasing && this.current !== "crashed")
      for (const sessionId of [undefined, ...this.children.keys()])
        this.runHook(hook, sessionId).catch(() => {});
    return () => {
      this.hooks.delete(hook);
    };
  }

  async mainFrameId(step: Step): Promise<string> {
    const known =
      this.current === "ready" && !this.releasing
        ? this.registry.mainFrameId
        : undefined;
    if (known) return known;
    const reply = await this.send<FrameTree>("Page.getFrameTree", {}, step);
    this.registry.seed(reply.frameTree);
    return reply.frameTree.frame.id;
  }

  // The URL a frame committed, which the registry alone holds for a frame
  // with no path, such as one inside a closed shadow root.
  frameUrl(frameId: string): string | undefined {
    return this.registry.get(frameId)?.url;
  }

  // The tab's frames as the registry holds them, main frame first and
  // parents before their children, without the page work a path needs.
  async knownFrames(step: Step): Promise<KnownFrame[]> {
    await this.mainFrameId(step);
    return this.registry.list().map((frame) => ({
      frameId: frame.frameId,
      ...(frame.parentFrameId === undefined
        ? {}
        : { parentFrameId: frame.parentFrameId }),
      origin: frame.origin,
      loaderId: frame.loaderId,
      ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
      crossOrigin: this.registry.crossOrigin(frame.frameId),
      ownSession: frame.ownSession,
      blocked: frame.blocked,
      unavailable: frame.unavailable,
      ...(frame.navigating === undefined ? {} : { navigating: true as const }),
    }));
  }

  // The tab's frames with the index paths snapshots print. A frame whose
  // path cannot be worked out is left out.
  async frames(step: Step): Promise<FrameInfo[]> {
    const main = await this.mainFrameId(step);
    const paths = new Map<string, string>();
    const sessions = new Set<string | undefined>();
    const frames: FrameInfo[] = [];
    try {
      for (const frame of this.registry.list()) {
        const path =
          frame.frameId === main
            ? ""
            : await this.framePath(frame, paths, sessions, step);
        if (path === undefined) continue;
        paths.set(frame.frameId, path);
        frames.push({
          frameId: frame.frameId,
          ...(frame.parentFrameId === undefined
            ? {}
            : { parentFrameId: frame.parentFrameId }),
          url: frame.url,
          origin: frame.origin,
          ...(frame.sessionId === undefined
            ? {}
            : { sessionId: frame.sessionId }),
          crossOrigin: this.registry.crossOrigin(frame.frameId),
          ownSession: frame.ownSession,
          path,
          loaderId: frame.loaderId,
          lifecycle: this.lifecycle.state(frame.frameId, frame.loaderId),
          ...(frame.unavailable ? { unavailable: true as const } : {}),
          ...(frame.blocked ? { blocked: true as const } : {}),
        });
      }
    } finally {
      await Promise.all(
        [...sessions].map((sessionId) =>
          this.send(
            "Runtime.releaseObjectGroup",
            { objectGroup: FRAME_GROUP },
            { sessionId, deadline: step.deadline },
          ).catch(() => {}),
        ),
      );
    }
    return frames;
  }

  // Kamapathy's world in a frame, for callers that resolve nodes into it and
  // call fixed functions there. It lasts until the frame's next document or
  // a re-attach; a call on it after that fails with ContextLostError.
  world(
    frameId: string,
    step: Step,
  ): Promise<{ sessionId?: string; contextId: number }> {
    return this.openWorld(frameId, step, false);
  }

  // Runs one of Kamapathy's fixed page operations in the frame's Kamapathy
  // world, on the session that hosts the frame.
  async evaluateInFrame(
    frameId: string,
    op: PageOperation | PageStateOperation,
    payload: object,
    step: Step & { namespace: string; timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    if (this.shown) throw new DialogOpenError(this.shown, false);
    const expression = operationExpression(op, payload, step.namespace);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const { sessionId, contextId } = await this.openWorld(
          frameId,
          step,
          attempt > 0,
        );
        const reply = await this.send<{
          result?: { value?: unknown };
          exceptionDetails?: {
            text?: string;
            exception?: { description?: string };
          };
        }>(
          "Runtime.evaluate",
          {
            expression,
            contextId,
            returnByValue: true,
            awaitPromise: true,
            silent: true,
          },
          {
            sessionId,
            deadline: step.deadline,
            signal: step.signal,
            guard: step.guard,
            dispatch: step.dispatch,
            timeoutMs: step.timeoutMs,
            ...(OPERATIONS[op].mutates ? { mutates: true as const } : {}),
          },
        );
        if (reply.exceptionDetails)
          throw new Error(
            reply.exceptionDetails.exception?.description ??
              reply.exceptionDetails.text ??
              "The page operation failed.",
          );
        return reply.result?.value as Record<string, unknown>;
      } catch (error) {
        // The world was gone before the call ran: make it again, once.
        if (
          attempt === 0 &&
          error instanceof ContextLostError &&
          !error.started
        )
          continue;
        throw error;
      }
    }
  }

  // A PNG of the page, as Chromium paints the tab's view now. The clip is in
  // DIP from the document origin, with the scale the output size needs. The
  // whole remaining deadline is the capture's: a large full page takes
  // seconds.
  async captureScreenshot(
    params: {
      clip: {
        x: number;
        y: number;
        width: number;
        height: number;
        scale: number;
      };
      captureBeyondViewport: boolean;
    },
    step: Step,
  ): Promise<Buffer> {
    try {
      const reply = await this.send<{ data: string }>(
        "Page.captureScreenshot",
        {
          format: "png",
          clip: params.clip,
          captureBeyondViewport: params.captureBeyondViewport,
          // A hidden view answers a surface capture slowly or not at all, so
          // the controller lends it to a window Chromium paints first.
          fromSurface: true,
        },
        {
          deadline: step.deadline,
          signal: step.signal,
          guard: step.guard,
          timeoutMs: step.deadline - Date.now(),
        },
      );
      return Buffer.from(reply.data, "base64");
    } catch (error) {
      throw captureFailure(error);
    }
  }

  // Resolves once a frame's document reaches state: the document loaderId
  // names, else the one the frame shows. The frame defaults to the main
  // frame.
  async waitForLifecycle(
    state: "commit" | "domcontentloaded" | "load",
    step: Step & { frameId?: string; loaderId?: string },
  ): Promise<void> {
    const frameId = step.frameId ?? (await this.mainFrameId(step));
    const signal = this.waitSignal(step);
    return new Promise<void>((resolve, reject) => {
      let probed = false;
      const stop = () => {
        clearTimeout(expiry);
        this.lifecycleWaits.delete(check);
        signal.removeEventListener("abort", aborted);
      };
      const fail = (error: unknown) => {
        stop();
        reject(error);
      };
      const check = (commit?: Commit) => {
        try {
          step.guard?.();
        } catch (error) {
          return fail(error);
        }
        // A renderer that stopped takes the load with it. A recovery brings
        // the next document back, but this document's wait ends now rather
        // than on its own deadline.
        if (this.current === "crashed") return fail(new PageCrashedError());
        const frame = this.registry.get(frameId);
        // A lost debugger empties the registry until setup reads it again.
        if (!frame) {
          if (this.state === "ready") fail(new FrameGoneError(frameId));
          return;
        }
        if (
          step.loaderId &&
          commit?.frameId === frameId &&
          commit.loaderId !== step.loaderId
        )
          return fail(new ContextLostError(false));
        const loaderId = step.loaderId ?? frame.loaderId;
        const current = this.lifecycle.state(frameId, loaderId);
        if (reached(current, state)) {
          stop();
          return resolve();
        }
        // Only a document the frame shows now can be read, and a frame that
        // has not committed one yet has none to read.
        if (
          current === "unknown" &&
          !probed &&
          loaderId &&
          loaderId === frame.loaderId
        ) {
          probed = true;
          this.probeReady(frameId, loaderId, step);
        }
      };
      const aborted = () => {
        try {
          step.guard?.();
        } catch (error) {
          return fail(error);
        }
        fail(signal.reason);
      };
      const timeoutMs = Math.max(0, step.deadline - Date.now());
      const expiry = setTimeout(
        () => fail(new CdpTimeoutError("load", timeoutMs)),
        timeoutMs,
      );
      if (signal.aborted) return aborted();
      signal.addEventListener("abort", aborted);
      this.lifecycleWaits.add(check);
      check();
    });
  }

  // The frame's Kamapathy world for its current document, made on first use
  // on the session that hosts the frame.
  private async openWorld(
    frameId: string,
    step: Step,
    fresh: boolean,
  ): Promise<{ sessionId?: string; contextId: number }> {
    // Waits, as send does, until the session is up and knows its frames.
    await this.mainFrameId(step);
    const frame = this.registry.get(frameId);
    if (!frame) throw new FrameGoneError(frameId);
    if (frame.blocked) throw new FrameBlockedError(frameId);
    if (frame.unavailable) throw new SessionLostError("unavailable");
    const { sessionId } = frame;
    const epoch = this.epoch;
    if (fresh) this.registry.dropWorld(frameId);
    let world = this.registry.worldFor(frameId, epoch);
    if (!world) {
      const made: World = this.send<{ executionContextId: number }>(
        "Page.createIsolatedWorld",
        // The protocol spells grantUniveralAccess this way.
        { frameId, worldName: WORLD_NAME, grantUniveralAccess: false },
        {
          sessionId,
          deadline: step.deadline,
          signal: step.signal,
          guard: step.guard,
        },
      ).then(
        (reply) => ({ contextId: reply.executionContextId }),
        (error: unknown) => {
          throw error instanceof Error &&
            /No frame for given id found/.test(error.message)
            ? new FrameGoneError(frameId)
            : error;
        },
      );
      this.registry.setWorld(frameId, epoch, made);
      made.catch(() => {
        if (this.registry.worldFor(frameId, epoch) === made)
          this.registry.dropWorld(frameId);
      });
      world = made;
    }
    // A world another call is still making is waited for no longer than
    // this step allows, so a frame that stopped answering cannot hold up
    // the next read of it.
    const { contextId } = await this.within(world, step);
    // The frame moved on to its next document while the world was made.
    if (this.registry.worldFor(frameId, this.epoch) !== world)
      throw new ContextLostError(false);
    this.handles.set(`${sessionId ?? ""}|${contextId}`, { frameId, world });
    return sessionId === undefined ? { contextId } : { sessionId, contextId };
  }

  // A promise of another call's, bounded by this step's own deadline.
  private async within<T>(work: Promise<T>, step: Step): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const left = Math.max(0, step.deadline - Date.now());
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new CdpTimeoutError("page", left)), left);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // A frame's path: its owner element, found on the session hosting its
  // parent, placed among the parent's frames by frameIndex in the parent's
  // world.
  private async framePath(
    frame: FrameRecord,
    paths: Map<string, string>,
    sessions: Set<string | undefined>,
    step: Step,
  ): Promise<string | undefined> {
    const parent =
      frame.parentFrameId === undefined
        ? undefined
        : this.registry.get(frame.parentFrameId);
    const parentPath = parent && paths.get(parent.frameId);
    if (
      !parent ||
      parentPath === undefined ||
      parent.blocked ||
      parent.unavailable
    )
      return undefined;
    try {
      const { sessionId, contextId } = await this.world(parent.frameId, step);
      const at = {
        sessionId,
        deadline: step.deadline,
        signal: step.signal,
        guard: step.guard,
      };
      const owner = await this.send<{ backendNodeId: number }>(
        "DOM.getFrameOwner",
        { frameId: frame.frameId },
        at,
      );
      sessions.add(sessionId);
      const node = await this.send<{ object: { objectId?: string } }>(
        "DOM.resolveNode",
        {
          backendNodeId: owner.backendNodeId,
          executionContextId: contextId,
          objectGroup: FRAME_GROUP,
        },
        at,
      );
      const reply = await this.send<{
        result?: { value?: { ok?: boolean; path?: unknown } };
      }>(
        "Runtime.callFunctionOn",
        {
          objectId: node.object.objectId,
          functionDeclaration: FRAME_INDEX,
          arguments: [{ value: "internal" }],
          returnByValue: true,
          awaitPromise: true,
        },
        at,
      );
      const index = reply.result?.value;
      if (index?.ok !== true || typeof index.path !== "string")
        return undefined;
      return parentPath ? `${parentPath}/${index.path}` : index.path;
    } catch (error) {
      // A takeover, a lost session or the deadline ends the whole read.
      // Anything else only leaves this frame out.
      step.guard?.();
      if (
        error instanceof SessionLostError ||
        error instanceof PageCrashedError ||
        error instanceof TabClosedError ||
        error instanceof CdpTimeoutError
      )
        throw error;
      return undefined;
    }
  }

  dialog(): DialogInfo | undefined {
    return this.shown;
  }

  // Answers the open dialog on the session that reported it. The dialog holds
  // other commands, so this one is never refused.
  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    await this.command(
      "Page.handleJavaScriptDialog",
      { accept, ...(promptText === undefined ? {} : { promptText }) },
      this.shown?.sessionId,
      15000,
    );
  }

  // Runs source in each web frame's new documents, and at once in the
  // current ones. A re-attach runs it again, so sources must be idempotent.
  async addInitScript(
    source: string,
    options: { world: "main" | "isolated" },
  ): Promise<string> {
    const id = `script-${++this.scriptCount}`;
    const script: InitScript = {
      source: initSource(source),
      world: options.world,
      identifiers: new Map(),
    };
    this.scripts.set(id, script);
    if (this.connected && !this.releasing)
      await Promise.allSettled(
        [undefined, ...this.children.keys()].map((sessionId) =>
          this.addScript(script, sessionId),
        ),
      );
    return id;
  }

  async removeInitScript(id: string): Promise<void> {
    const script = this.scripts.get(id);
    this.scripts.delete(id);
    if (!script || !this.connected) return;
    await Promise.allSettled(
      [...script.identifiers]
        .filter(([key]) => key === "" || this.children.has(key))
        .map(([key, identifier]) =>
          this.command(
            "Page.removeScriptToEvaluateOnNewDocument",
            { identifier },
            key || undefined,
          ),
        ),
    );
  }

  // A separate flat session for section 8, on this tab's own target or one of
  // its out-of-process frames. Any other target is refused before anything is
  // sent, so no caller can reach another tab or window.
  async openAgentSession(frameId?: string): Promise<string> {
    if (frameId !== undefined) {
      const frame = this.registry.get(frameId);
      if (frame?.blocked) throw new FrameBlockedError(frameId);
      if (!frame?.ownSession)
        throw new TargetRefusedError("Target.attachToTarget");
    }
    if (this.current !== "ready" || this.releasing) throw this.lostError();
    // An out-of-process frame's target id is its frame id.
    const targetId = frameId ?? (await this.ownTarget());
    this.opening.set(targetId, (this.opening.get(targetId) ?? 0) + 1);
    try {
      const { sessionId } = await this.command<{ sessionId: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
        undefined,
        15000,
      );
      this.agents.add(sessionId);
      this.agentFrames.set(sessionId, frameId ?? null);
      if (this.agentFrames.size > AGENT_FRAMES)
        this.agentFrames.delete(this.agentFrames.keys().next().value!);
      return sessionId;
    } finally {
      const left = this.opening.get(targetId)! - 1;
      if (left > 0) this.opening.set(targetId, left);
      else this.opening.delete(targetId);
    }
  }

  /** The frame an agent session was opened for: null for the tab's own page, undefined for a session that is not an agent's. */
  agentFrame(sessionId: string): string | null | undefined {
    return this.agentFrames.get(sessionId);
  }

  async closeAgentSession(sessionId: string): Promise<void> {
    if (!this.agents.delete(sessionId))
      throw new TargetRefusedError("Target.detachFromTarget");
    // Chromium reports the detach before it answers, and the report must not
    // reach the tab's own listeners.
    this.closingAgents.add(sessionId);
    await this.command(
      "Target.detachFromTarget",
      { sessionId },
      undefined,
      15000,
    );
  }

  // Registers an init script on one session and keeps the identifier it
  // returns there.
  private addScript(script: InitScript, sessionId?: string): Promise<void> {
    const generation = this.generation;
    return this.command<{ identifier: string }>(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: script.source,
        runImmediately: true,
        ...(script.world === "isolated" ? { worldName: WORLD_NAME } : {}),
      },
      sessionId,
    ).then(({ identifier }) => {
      if (generation === this.generation)
        script.identifiers.set(sessionId ?? "", identifier);
    });
  }

  // The tab's own target, as Target.getTargetInfo names it, read once per
  // attach. Chromium gives a page target its main frame's id, which serves
  // when the reply names no page.
  private async ownTarget(): Promise<string> {
    if (this.targetId === undefined) {
      const reply = await this.command<{
        targetInfo: { targetId: string; type: string };
      }>("Target.getTargetInfo", {}, undefined, 15000).catch(() => undefined);
      this.targetId =
        reply?.targetInfo.type === "page"
          ? reply.targetInfo.targetId
          : await this.mainFrameId({ deadline: Date.now() + 15000 });
    }
    return this.targetId;
  }

  private openDialog(params: any, sessionId?: string): void {
    const dialog: DialogInfo = {
      type: params.type,
      message: dialogText(params.message),
      ...(params.type === "prompt"
        ? { defaultValue: dialogText(params.defaultPrompt) }
        : {}),
      ...(params.frameId ? { frameId: params.frameId } : {}),
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    this.setDialog(dialog);
    // A held command was already sent, so its effect is unknown.
    this.failPending(() => new DialogOpenError(dialog, true), DIALOG_HOLDS);
  }

  private setDialog(dialog: DialogInfo | undefined): void {
    if (!dialog && !this.shown) return;
    this.shown = dialog;
    this.emit("dialog", { dialog: dialog ?? null });
  }

  // Agent sessions belong to section 8. Their events reach only on("agent")
  // and the buffer, never the frame registry, the trackers or dialog state.
  private fromAgent(method: string, params: unknown, sessionId: string): void {
    const event: CdpEvent = { method, params, sessionId, at: Date.now() };
    this.buffer.record(event);
    this.deliver("agent", event);
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

  // Runs a setup hook for the current connection.
  private runHook(hook: SetupHook, sessionId?: string): Promise<void> {
    return hookSetup.run({ session: this, generation: this.generation }, () =>
      hook(sessionId),
    );
  }

  private inSetupHook(): boolean {
    const setup = hookSetup.getStore();
    return setup?.session === this && setup.generation === this.generation;
  }

  // Sends a session's setup in order and awaits no reply. A new view answers
  // only once its first navigation starts, and that waits for attach().
  private setup(sessionId: string | undefined, waiting = false) {
    const generation = this.generation;
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
      ...[...this.hooks].map((hook) => this.runHook(hook, sessionId)),
      ...[...this.scripts.values()].map((script) =>
        this.addScript(script, sessionId),
      ),
    ];
    if (waiting)
      replies.push(
        this.command("Runtime.runIfWaitingForDebugger", {}, sessionId),
      );
    replies.push(
      this.command<FrameTree>("Page.getFrameTree", {}, sessionId).then(
        (reply) => {
          if (
            generation === this.generation &&
            (sessionId === undefined || this.children.has(sessionId))
          )
            this.registry.seed(reply.frameTree, sessionId);
        },
      ),
    );
    return replies;
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
        method,
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
          () => entry.fail(new CdpTimeoutError("page", timeoutMs, reply)),
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
  // by a takeover still reports the person's control. A dialog fails only
  // the commands it holds.
  private failPending(cause: () => Error, held?: RegExp): void {
    for (const entry of [...this.pending]) {
      if (held && !held.test(entry.method)) continue;
      let error: unknown = cause();
      try {
        entry.guard?.();
      } catch (refusal) {
        error = refusal;
      }
      entry.fail(error);
    }
  }

  private async usable(deadline: number, step?: SendStep): Promise<void> {
    if (this.current === "unavailable") {
      if (!this.connect()) throw this.lostError();
      return this.whenReady(Math.min(deadline, Date.now() + 2000));
    }
    // The next commit brings a crashed page back, and a step that dispatched
    // a navigation is waiting for its own commit anyway. A page that closes,
    // stops again or never comes back fails here instead.
    if (this.current === "crashed" && step?.throughCrash)
      return this.whenReady(deadline);
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
      const timeoutMs = Math.max(0, limit - Date.now());
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new CdpTimeoutError("page", timeoutMs));
      }, timeoutMs);
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
    return this.deliver(
      name,
      sessionId === undefined
        ? { method: name, params, at: Date.now() }
        : { method: name, params, sessionId, at: Date.now() },
    );
  }

  // Calls the listeners of name with the event, and collects the promises
  // they return.
  private deliver(name: string, event: CdpEvent): Promise<unknown>[] {
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

  private adopt(params: any, parent: string | undefined): void {
    const sessionId: string = params.sessionId;
    const target = params.targetInfo ?? {};
    // An iframe target's id is its frame id.
    if (target.type === "iframe")
      this.registry.attachTarget(target.targetId, sessionId, target.url ?? "");
    // A releasing session sets up nothing new, and a blocked frame gets
    // nothing at all.
    if (
      target.type !== "iframe" ||
      this.releasing ||
      this.registry.get(target.targetId)?.blocked
    ) {
      // Letting a target go without resuming it took the browser process
      // down when Chromium's PDF viewer opened in a popup, and that target
      // reports no wait, so every target is resumed before it is let go.
      this.command("Runtime.runIfWaitingForDebugger", {}, sessionId)
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
    // Its frames stay listed, unavailable.
    Promise.all(replies).catch(() => {
      if (generation === this.generation && this.children.has(sessionId))
        this.letGo(sessionId);
    });
  }

  // Detaches a child session on the session that reported it.
  private letGo(sessionId: string): void {
    const parent = this.children.get(sessionId)?.parent;
    this.forget(sessionId);
    this.command("Target.detachFromTarget", { sessionId }, parent).catch(
      () => {},
    );
  }

  // Forgets a session with the sessions it reported. Their frames stay
  // listed, unavailable.
  private forget(sessionId: string): void {
    this.registry.detachSession(sessionId);
    if (!this.children.delete(sessionId)) return;
    for (const [id, child] of this.children)
      if (child.parent === sessionId) this.forget(id);
  }

  // A frame that commits a blocked URL loses its own session. Frames that
  // left the registry with another are reported detached too.
  private framesChanged(
    change: FrameChange,
    before: FrameRecord[],
    source: string | undefined,
  ): void {
    const frame = this.registry.get(change.frameId);
    if (
      change.change === "navigated" &&
      frame?.blocked &&
      frame.ownSession &&
      frame.sessionId
    )
      this.letGo(frame.sessionId);
    this.emit("frame", change, source);
    for (const { frameId } of before)
      if (frameId !== change.frameId && !this.registry.get(frameId))
        this.emit("frame", { frameId, change: "detached" }, source);
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
    this.registry.clear();
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
  // its frame tree read again. That read is the session attaching to the
  // renderer the document brought, so a command sent while it runs waits it
  // out instead of failing as crashed, and a read that does not arrive
  // leaves the session crashed again.
  private recover(): void {
    const generation = this.generation;
    const recovering = () =>
      generation === this.generation &&
      this.current === "attaching" &&
      !this.releasing;
    this.setState("attaching");
    this.command<FrameTree>(
      "Page.getFrameTree",
      {},
      undefined,
      RECOVER_TIMEOUT_MS,
    ).then(
      (reply) => {
        if (!recovering()) return;
        this.registry.clear();
        this.registry.seed(reply.frameTree);
        this.setState("ready");
      },
      () => {
        if (recovering()) this.setState("crashed");
      },
    );
  }

  private async leave(): Promise<void> {
    if (this.closed) return;
    this.releasing = true;
    pageEpochs.set(this.contents, this.navigations);
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
        // Agent sessions end with the debugger, but are let go of first.
        for (const sessionId of this.agents)
          this.command("Target.detachFromTarget", { sessionId }).catch(
            () => {},
          );
        this.connected = false;
        this.generation += 1;
        this.failPending(() => new SessionLostError("unavailable"));
        this.cdp.detach();
      }
      this.children.clear();
      this.registry.clear();
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
    this.agents.clear();
    this.closingAgents.clear();
  }

  private trackLoading(event: CdpEvent): void {
    const commit = commitOf(event);
    // Requests of the frame's earlier documents can no longer end where
    // Kamapathy hears them.
    if (commit) this.requests.dropOtherLoaders(commit.frameId, commit.loaderId);
    this.requests.apply(event);
    const change = this.lifecycle.apply(event);
    if (change) this.emit("lifecycle", change, event.sessionId);
    if (change || commit) this.wakeLifecycle(commit);
  }

  private wakeLifecycle(commit?: Commit): void {
    for (const check of [...this.lifecycleWaits]) check(commit);
  }

  // Reads readyState once for a document no lifecycle event has described,
  // such as one still loading when the session attached.
  private probeReady(frameId: string, loaderId: string, step: Step): void {
    const key = `${frameId}|${loaderId}`;
    if (this.probes.has(key)) return;
    this.probes.add(key);
    this.evaluateInFrame(
      frameId,
      "ready",
      {},
      {
        deadline: step.deadline,
        signal: step.signal,
        guard: step.guard,
        namespace: "internal",
      },
    )
      .then((result) => {
        const readyState = result?.readyState;
        const frame = this.registry.get(frameId);
        // The frame may have moved on while the probe ran.
        if (
          frame?.loaderId !== loaderId ||
          (readyState !== "loading" &&
            readyState !== "interactive" &&
            readyState !== "complete")
        )
          return;
        const before = this.lifecycle.state(frameId, loaderId);
        this.lifecycle.settle(frameId, loaderId, readyState);
        const state = this.lifecycle.state(frameId, loaderId);
        if (state !== before)
          this.emit("lifecycle", { frameId, loaderId, state }, frame.sessionId);
      })
      .catch(() => {})
      .finally(() => {
        this.probes.delete(key);
        this.wakeLifecycle();
      });
  }

  // A wait also ends when release starts or the tab closes.
  private waitSignal(step: Step): AbortSignal {
    return step.signal
      ? AbortSignal.any([this.ending.signal, step.signal])
      : this.ending.signal;
  }

  private readonly onMessage = (
    _event: unknown,
    method: string,
    params: any,
    sessionId: string,
  ) => {
    if (!this.connected) return;
    const source = sessionId || undefined;
    if (source !== undefined && this.agents.has(source)) {
      this.fromAgent(method, params, source);
      return;
    }
    if (source !== undefined && !this.children.has(source)) return;
    // Chromium reports an agent session's attach and detach on the page
    // session that asked for them, each before its reply.
    if (
      method === "Target.attachedToTarget" &&
      source === undefined &&
      (this.opening.has(params.targetInfo?.targetId) ||
        this.agents.has(params.sessionId))
    ) {
      this.agents.add(params.sessionId);
      return;
    }
    if (
      method === "Target.detachedFromTarget" &&
      (this.agents.delete(params.sessionId) ||
        this.closingAgents.delete(params.sessionId))
    )
      return;
    if (RECORDED.test(method))
      this.buffer.record(
        source === undefined
          ? { method, params, at: Date.now() }
          : { method, params, sessionId: source, at: Date.now() },
      );
    if (method === "Page.javascriptDialogOpening")
      this.openDialog(params, source);
    else if (method === "Page.javascriptDialogClosed")
      this.setDialog(undefined);
    if (method === "Target.attachedToTarget") this.adopt(params, source);
    else if (method === "Target.detachedFromTarget")
      this.forget(params.sessionId);
    // A crashed session's next document commits on a renderer that is there
    // again, and Chromium reports that commit here before Electron's own
    // navigation event, which a load wait already sends on.
    if (
      this.current === "crashed" &&
      !this.releasing &&
      source === undefined &&
      method === "Page.frameNavigated" &&
      params?.frame?.parentId === undefined
    )
      this.recover();
    const before =
      method === "Page.frameNavigated" || method === "Page.frameDetached"
        ? this.registry.list()
        : [];
    const change = this.registry.apply({
      method,
      params,
      sessionId: source,
      at: Date.now(),
    });
    this.emit(method, params, source);
    if (change) this.framesChanged(change, before, source);
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
    if (!details.isMainFrame || details.isSameDocument) return;
    this.navigations += 1;
    // Every world ends with the main frame's document, and an id it had is
    // refused from now on like any other id Kamapathy did not hand out.
    this.handles.clear();
    // Chromium never answers a capture the new document interrupted.
    this.failPending(() => new CaptureFailedError("navigation"), CAPTURES);
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
    // The renderer took its dialog with it.
    this.setDialog(undefined);
    this.setState("crashed");
    this.wakeLifecycle();
  };

  private readonly onDevToolsClosed = () => {
    if (this.current === "devtools" && !this.releasing) this.connect();
  };

  private readonly onDestroyed = () => {
    this.closed = true;
    this.connected = false;
    this.generation += 1;
    this.children.clear();
    this.registry.clear();
    this.failPending(() => new TabClosedError());
    this.setState("released");
    this.emit("closed", {});
    this.dispose();
  };
}
