import { EventEmitter } from "node:events";

export type SentCommand = {
  method: string;
  params: Record<string, any>;
  sessionId?: string;
};
export type Reply = (
  params: Record<string, any>,
  sessionId?: string,
) => unknown;
type Command = { answer(): void; reject(error: Error): void };

// A scripted webContents.debugger. Replies arrive at once unless holdReplies
// keeps them for flush(), as a view with no renderer yet does.
export class FakeDebugger extends EventEmitter {
  attached = false;
  attachCount = 0;
  detachCount = 0;
  attachError?: Error;
  holdReplies = false;
  readonly sent: SentCommand[] = [];
  // Frame targets announced through attachedTarget, by session.
  readonly targets = new Map<string, { targetId: string; url: string }>();
  private replies: Map<string, Reply>;
  private pending = new Set<Command>();
  private held: Command[] = [];

  constructor(replies: Record<string, Reply> = {}) {
    super();
    let context = 0;
    let scripts = 0;
    let agents = 0;
    // The target of each session Target.attachToTarget opened.
    const opened = new Map<string, string>();
    this.replies = new Map(
      Object.entries({
        // A frame target's session reports the frame it was attached for.
        "Page.getFrameTree": (_params, sessionId) => {
          const target =
            sessionId === undefined ? undefined : this.targets.get(sessionId);
          return frameTree([
            target
              ? { id: target.targetId, url: target.url }
              : {
                  id: "main",
                  url: "https://example.com/",
                  loaderId: "loader-1",
                },
          ]);
        },
        "Page.createIsolatedWorld": () => ({ executionContextId: ++context }),
        // Each session gives an init script its own identifier.
        "Page.addScriptToEvaluateOnNewDocument": () => ({
          identifier: String(++scripts),
        }),
        // The page session names its own target, whose id is the main
        // frame's.
        "Target.getTargetInfo": () => ({
          targetInfo: {
            targetId: "main",
            type: "page",
            title: "",
            url: "https://example.com/",
            attached: true,
            canAccessOpener: false,
          },
        }),
        // Chromium reports the new flat session on the session that asked,
        // before it answers.
        "Target.attachToTarget": (
          params: Record<string, any>,
          sessionId?: string,
        ) => {
          const attached = `agent-${++agents}`;
          opened.set(attached, params.targetId);
          this.event(
            "Target.attachedToTarget",
            {
              sessionId: attached,
              targetInfo: {
                targetId: params.targetId,
                type: params.targetId === "main" ? "page" : "iframe",
                title: "",
                url: "",
                attached: true,
                canAccessOpener: false,
              },
              waitingForDebugger: false,
            },
            sessionId,
          );
          return { sessionId: attached };
        },
        // Chromium reports the detach on the session that asked, before it
        // answers.
        "Target.detachFromTarget": (
          params: Record<string, any>,
          sessionId?: string,
        ) => {
          this.event(
            "Target.detachedFromTarget",
            {
              sessionId: params.sessionId,
              targetId:
                opened.get(params.sessionId) ??
                this.targets.get(params.sessionId)?.targetId,
            },
            sessionId,
          );
          return {};
        },
        ...replies,
      }),
    );
  }
  isAttached() {
    return this.attached;
  }
  attach(_protocolVersion?: string) {
    if (this.attached)
      throw new Error("Debugger is already attached to the target");
    if (this.attachError) throw this.attachError;
    this.attached = true;
    this.attachCount += 1;
  }
  // Electron emits detach for a detach() it was asked for, too.
  detach() {
    this.detachCount += 1;
    this.end("target closed");
  }
  sendCommand(
    method: string,
    params: Record<string, any> = {},
    sessionId?: string,
  ): Promise<any> {
    if (sessionId === "")
      return Promise.reject(new Error("Empty session id is not allowed"));
    if (!this.attached)
      return Promise.reject(new Error("No target available"));
    this.sent.push(
      sessionId === undefined
        ? { method, params }
        : { method, params, sessionId },
    );
    return new Promise((resolve, reject) => {
      const command: Command = {
        reject,
        answer: () => {
          try {
            const reply = this.replies.get(method) ?? (() => ({}));
            Promise.resolve(reply(params, sessionId)).then(
              (value) => {
                if (this.pending.delete(command)) resolve(value);
              },
              (error) => {
                if (this.pending.delete(command)) reject(error);
              },
            );
          } catch (error) {
            if (this.pending.delete(command)) reject(error);
          }
        },
      };
      this.pending.add(command);
      if (this.holdReplies) this.held.push(command);
      else command.answer();
    });
  }
  reply(method: string, reply: Reply) {
    this.replies.set(method, reply);
  }
  flush() {
    const held = this.held;
    this.held = [];
    for (const command of held) command.answer();
  }
  // A protocol event; Electron reports the page session's as "".
  event(method: string, params: object, sessionId?: string) {
    this.emit("message", {}, method, params, sessionId ?? "");
  }
  // A detach nobody asked for, such as the target going away.
  lose(reason = "target closed") {
    this.end(reason);
  }
  methods(sessionId?: string) {
    return this.sent
      .filter((command) => command.sessionId === sessionId)
      .map((command) => command.method);
  }
  // Electron rejects every pending command when the session ends.
  private end(reason: string) {
    if (!this.attached) return;
    this.attached = false;
    const pending = [...this.pending];
    this.pending.clear();
    this.held = [];
    for (const command of pending)
      command.reject(new Error("target closed while handling command"));
    this.emit("detach", {}, reason);
  }
}

// The parts of a WebContents a tab session uses.
export class FakeHost extends EventEmitter {
  readonly debugger: FakeDebugger;
  url: string;
  devtools = false;
  destroyed = false;
  constructor(options: { url?: string; replies?: Record<string, Reply> } = {}) {
    super();
    this.url = options.url ?? "https://example.com/";
    this.debugger = new FakeDebugger(options.replies);
  }
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isDevToolsOpened() {
    return this.devtools;
  }
  isLoadingMainFrame() {
    return false;
  }
  navigate(url: string) {
    this.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url,
    });
    this.url = url;
    this.emit("did-navigate", {}, url, 200, "OK");
  }
  crash() {
    this.emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  }
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

// A Page.getFrameTree reply. The first frame is the root; the others nest
// under the frame their parentId names.
export function frameTree(
  frames: {
    id: string;
    parentId?: string;
    url: string;
    origin?: string;
    loaderId?: string;
  }[],
): object {
  const node = (frame: (typeof frames)[number]): object => {
    const children = frames.filter((child) => child.parentId === frame.id);
    return {
      frame: {
        id: frame.id,
        ...(frame.parentId ? { parentId: frame.parentId } : {}),
        loaderId: frame.loaderId ?? `loader-${frame.id}`,
        url: frame.url,
        securityOrigin: frame.origin ?? new URL(frame.url).origin,
        mimeType: "text/html",
      },
      ...(children.length ? { childFrames: children.map(node) } : {}),
    };
  };
  return { frameTree: node(frames[0]) };
}
// Chromium reports a new target on the session that hosts its parent frame.
// Unless a test replies otherwise, the target's own Page.getFrameTree names
// that frame at that URL.
export function attachedTarget(
  debuggerFake: FakeDebugger,
  options: {
    parentSessionId?: string;
    sessionId: string;
    targetId: string;
    type?: string;
    url: string;
    waitingForDebugger?: boolean;
  },
): void {
  debuggerFake.targets.set(options.sessionId, {
    targetId: options.targetId,
    url: options.url,
  });
  debuggerFake.event(
    "Target.attachedToTarget",
    {
      sessionId: options.sessionId,
      targetInfo: {
        targetId: options.targetId,
        type: options.type ?? "iframe",
        url: options.url,
        attached: true,
      },
      waitingForDebugger: options.waitingForDebugger ?? false,
    },
    options.parentSessionId,
  );
}
// Chromium telling the session that hosts a frame how far its document has
// loaded. Turning lifecycle events on replays a document's events so far.
export function lifecycleEvent(
  debuggerFake: FakeDebugger,
  options: {
    frameId: string;
    loaderId: string;
    name: string;
    sessionId?: string;
  },
): void {
  debuggerFake.event(
    "Page.lifecycleEvent",
    {
      frameId: options.frameId,
      loaderId: options.loaderId,
      name: options.name,
      timestamp: 1,
    },
    options.sessionId,
  );
}

// Chromium telling the session that hosts a frame that it committed a
// document.
export function frameNavigated(
  debuggerFake: FakeDebugger,
  options: {
    frameId: string;
    parentId?: string;
    loaderId: string;
    url: string;
    type?: string;
    sessionId?: string;
  },
): void {
  debuggerFake.event(
    "Page.frameNavigated",
    {
      frame: {
        id: options.frameId,
        ...(options.parentId ? { parentId: options.parentId } : {}),
        loaderId: options.loaderId,
        url: options.url,
        securityOrigin: new URL(options.url).origin,
        mimeType: "text/html",
      },
      type: options.type ?? "Navigation",
    },
    options.sessionId,
  );
}

// Chromium reporting a request, or a redirect of one, on the session that
// saw it start. A document's own request has its loaderId for requestId, and
// a worker's requests carry an empty loaderId.
export function requestWillBeSent(
  debuggerFake: FakeDebugger,
  options: {
    requestId: string;
    frameId: string;
    loaderId: string;
    url: string;
    redirect?: true;
    sessionId?: string;
  },
): void {
  debuggerFake.event(
    "Network.requestWillBeSent",
    {
      requestId: options.requestId,
      loaderId: options.loaderId,
      documentURL: options.url,
      request: { url: options.url, method: "GET", headers: {} },
      timestamp: 1,
      wallTime: 1,
      initiator: { type: "other" },
      type: options.requestId === options.loaderId ? "Document" : "Other",
      frameId: options.frameId,
      ...(options.redirect ? { redirectResponse: { status: 302 } } : {}),
    },
    options.sessionId,
  );
}

// Chromium reporting that a request finished, or failed, on any session.
export function loadingEnded(
  debuggerFake: FakeDebugger,
  requestId: string,
  options: { failed?: true; sessionId?: string } = {},
): void {
  if (options.failed)
    debuggerFake.event(
      "Network.loadingFailed",
      { requestId, timestamp: 2, type: "Other", errorText: "net::ERR_FAILED" },
      options.sessionId,
    );
  else
    debuggerFake.event(
      "Network.loadingFinished",
      { requestId, timestamp: 2, encodedDataLength: 0 },
      options.sessionId,
    );
}
