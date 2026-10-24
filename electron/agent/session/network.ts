import { CdpTimeoutError } from "./errors";
import type { CdpEvent, Step } from "./types";

type Request = {
  frameId: string;
  loaderId: string;
  sessionId?: string;
  url: string;
};

// How many characters of a pending URL a wait's answer carries. The cut is
// made here, so no caller can hand out a longer one.
const URL_CHARS = 200;

const favicon = (url: string) => {
  try {
    return new URL(url).pathname.endsWith("/favicon.ico");
  } catch {
    return false;
  }
};

// One tab's requests in flight, by requestId across Kamapathy's own
// sessions, so a frame's document request may start on its parent's session
// and end on the frame's own.
export class NetworkTracker {
  private requests = new Map<string, Request>();
  private lastActivity = 0;
  private waits = new Set<() => void>();

  apply(event: CdpEvent): void {
    const { method, params } = event;
    if (method === "Network.requestWillBeSent") {
      // A redirect keeps its request's entry. Requests with no loaderId come
      // from workers and end only on the worker's own target, which
      // Kamapathy never attaches.
      if (!this.requests.has(params.requestId)) {
        if (!params.loaderId || favicon(params.request.url)) return;
        this.requests.set(params.requestId, {
          frameId: params.frameId ?? "",
          loaderId: params.loaderId,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          url: params.request.url,
        });
      }
      this.changed();
    } else if (
      method === "Network.loadingFinished" ||
      method === "Network.loadingFailed"
    ) {
      if (this.requests.delete(params.requestId)) this.changed();
    } else if (
      method === "Page.lifecycleEvent" &&
      (params.name === "DOMContentLoaded" || params.name === "load")
    ) {
      // A document's own request has its loaderId for requestId. In a frame
      // with its own process it can end on the frame's session before
      // Kamapathy has set that session up, so the parsed document ends it.
      if (this.requests.delete(params.loaderId)) this.changed();
    }
  }

  dropFrame(frameId: string): void {
    this.drop((request) => request.frameId === frameId);
  }

  dropOtherLoaders(frameId: string, loaderId: string): void {
    this.drop(
      (request) => request.frameId === frameId && request.loaderId !== loaderId,
    );
  }

  dropSession(sessionId: string): void {
    this.drop((request) => request.sessionId === sessionId);
  }

  clear(): void {
    this.drop(() => true);
  }

  inFlight(): number {
    return this.requests.size;
  }

  // Up to limit of the URLs in flight, oldest first, for a wait that ran out.
  pending(limit: number): string[] {
    const urls: string[] = [];
    for (const request of this.requests.values()) {
      if (urls.length >= limit) break;
      urls.push(request.url.slice(0, URL_CHARS));
    }
    return urls;
  }

  lastActivityAt(): number {
    return this.lastActivity;
  }

  // Resolves once nothing has been in flight for idleMs since the last
  // request started or ended.
  waitForIdle(idleMs: number, step: Step): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        clearTimeout(quiet);
        clearTimeout(expiry);
        this.waits.delete(check);
        step.signal?.removeEventListener("abort", aborted);
      };
      const fail = (error: unknown) => {
        stop();
        reject(error);
      };
      const check = () => {
        try {
          step.guard?.();
        } catch (error) {
          return fail(error);
        }
        clearTimeout(quiet);
        if (this.requests.size > 0) return;
        const left = this.lastActivity + idleMs - Date.now();
        if (left > 0) {
          quiet = setTimeout(check, left);
          return;
        }
        stop();
        resolve();
      };
      const aborted = () => {
        try {
          step.guard?.();
        } catch (error) {
          return fail(error);
        }
        fail(step.signal?.reason);
      };
      const timeoutMs = Math.max(0, step.deadline - Date.now());
      const expiry = setTimeout(
        () => fail(new CdpTimeoutError("load", timeoutMs)),
        timeoutMs,
      );
      if (step.signal?.aborted) return aborted();
      step.signal?.addEventListener("abort", aborted);
      this.waits.add(check);
      check();
    });
  }

  private drop(match: (request: Request) => boolean): void {
    let dropped = false;
    for (const [requestId, request] of this.requests)
      if (match(request)) {
        this.requests.delete(requestId);
        dropped = true;
      }
    if (dropped) this.changed();
  }

  private changed(): void {
    this.lastActivity = Date.now();
    for (const check of [...this.waits]) check();
  }
}
