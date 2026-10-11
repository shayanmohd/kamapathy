// A raw DevTools Protocol connection to a page of Playwright's Chromium,
// shaped like the parts of a WebContents a tab session uses, so TabSession
// can be tested against real frames, processes and replies.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import type { SessionHost } from "../electron/agent/session/types";

const executable = chromium.executablePath();
export const chromiumAvailable = !!executable && existsSync(executable);

export interface ChromiumPage {
  host: SessionHost;
  targetId: string;
  close(): Promise<void>;
}
export interface ChromiumBrowser {
  newPage(): Promise<ChromiumPage>;
  close(): Promise<void>;
}

type Waiting = { resolve(value: unknown): void; reject(error: Error): void };

// webContents.debugger over the page's socket. Like Electron, it reports the
// page session's events with an empty session id, emits detach for its own
// detach() too and rejects pending commands when the session ends.
class SocketDebugger extends EventEmitter {
  private attached = false;
  private nextId = 1;
  private waiting = new Map<number, Waiting>();

  constructor(private readonly socket: WebSocket) {
    super();
    socket.addEventListener("message", (event) =>
      this.receive(JSON.parse(String(event.data))),
    );
    socket.addEventListener("close", () => this.end("target closed"));
  }
  attach(_protocolVersion?: string) {
    if (this.attached)
      throw new Error("Debugger is already attached to the target");
    if (this.socket.readyState !== WebSocket.OPEN)
      throw new Error("No target available");
    this.attached = true;
  }
  detach() {
    this.end("target closed");
  }
  sendCommand(
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<any> {
    if (!this.attached) return Promise.reject(new Error("No target available"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  private receive(message: {
    id?: number;
    result?: unknown;
    error?: { message: string };
    method?: string;
    params?: unknown;
    sessionId?: string;
  }) {
    if (message.id === undefined) {
      if (this.attached)
        this.emit(
          "message",
          {},
          message.method,
          message.params,
          message.sessionId ?? "",
        );
      return;
    }
    const waiting = this.waiting.get(message.id);
    if (!waiting) return;
    this.waiting.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message));
    else waiting.resolve(message.result);
  }
  private end(reason: string) {
    if (!this.attached) return;
    this.attached = false;
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    for (const command of waiting)
      command.reject(new Error("target closed while handling command"));
    this.emit("detach", {}, reason);
  }
}

class SocketHost extends EventEmitter {
  readonly debugger: SocketDebugger;
  private destroyed = false;

  constructor(
    socket: WebSocket,
    private url: string,
  ) {
    super();
    this.debugger = new SocketDebugger(socket);
    // The page's URL follows its main frame, which is when Electron reports
    // did-navigate.
    this.debugger.on("message", (_event, method, params, sessionId) => {
      if (
        method !== "Page.frameNavigated" ||
        sessionId ||
        params.frame.parentId
      )
        return;
      this.url = params.frame.url + (params.frame.urlFragment ?? "");
      this.emit("did-navigate", {}, this.url, 200, "OK");
    });
  }
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return this.destroyed;
  }
  isDevToolsOpened() {
    return false;
  }
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

// Starts Playwright's Chromium with a debugging port and a throwaway
// profile. Pages are opened and closed through its HTTP endpoints.
export async function launchChromium(): Promise<ChromiumBrowser> {
  const profile = mkdtempSync(join(tmpdir(), "kamapathy-cdp-"));
  const browser = spawn(
    executable,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const exited = new Promise<void>((resolve) =>
    browser.once("exit", () => resolve()),
  );
  // Chromium writes the port it chose to this file once it listens.
  const portFile = join(profile, "DevToolsActivePort");
  const started = Date.now();
  while (
    !existsSync(portFile) ||
    !readFileSync(portFile, "utf8").includes("\n")
  ) {
    if (browser.exitCode !== null || Date.now() - started > 20000) {
      browser.kill();
      rmSync(profile, { recursive: true, force: true });
      throw new Error("Chromium did not start.");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const endpoint = `http://127.0.0.1:${readFileSync(portFile, "utf8").split("\n")[0]}`;
  return {
    async newPage() {
      const response = await fetch(`${endpoint}/json/new?about:blank`, {
        method: "PUT",
      });
      const target = (await response.json()) as {
        id: string;
        url: string;
        webSocketDebuggerUrl: string;
      };
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () =>
          reject(new Error("Could not connect to the page.")),
        );
      });
      const host = new SocketHost(socket, target.url);
      return {
        host: host as unknown as SessionHost,
        targetId: target.id,
        async close() {
          host.destroy();
          if (socket.readyState === WebSocket.CLOSED) return;
          const closed = new Promise((resolve) =>
            socket.addEventListener("close", resolve),
          );
          await fetch(`${endpoint}/json/close/${target.id}`);
          await closed;
        },
      };
    },
    async close() {
      browser.kill();
      await exited;
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
