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
  private replies: Map<string, Reply>;
  private pending = new Set<Command>();
  private held: Command[] = [];

  constructor(replies: Record<string, Reply> = {}) {
    super();
    let context = 0;
    this.replies = new Map(
      Object.entries({
        "Page.getFrameTree": () =>
          frameTree([
            { id: "main", url: "https://example.com/", loaderId: "loader-1" },
          ]),
        "Page.createIsolatedWorld": () => ({ executionContextId: ++context }),
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
