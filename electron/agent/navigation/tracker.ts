import type { CdpEvent } from "../session/types";

// How many main-frame commits a tab keeps.
export const COMMIT_RING = 32;
// How long after a navigation ended a download or a block still explains it.
// Chromium reports a download a few milliseconds after the abort, so the end
// is reported again once its reason arrives.
export const ENDED_GRACE_MS = 1000;
// How soon a newer navigation counts as the one that replaced an abort.
export const REPLACED_WITHIN_MS = 150;
// What Chromium reports for a request the browser itself cancelled, used when
// nothing else named the failure.
const BLOCKED_BY_CLIENT = "ERR_BLOCKED_BY_CLIENT";
const BLOCKED_BY_CLIENT_CODE = -20;

export interface MainDocument {
  loaderId: string;
  url: string;
  method: string;
  httpStatus?: number;
  domContentLoaded: boolean;
  load: boolean;
}
export interface NavigationFailure {
  netError: string;
  errorCode: number;
  blockedUrl?: string;
}
export interface PendingNavigation {
  loaderId: string;
  type: string;
  url: string;
  startedAt: number;
  download?: boolean;
  requested?: true;
  responded?: true;
  failure?: NavigationFailure;
  // The document request's method and status, which its commit keeps.
  method?: string;
  httpStatus?: number;
}
export type TrackerEvent =
  | { type: "started"; loaderId: string; url: string; navigationType: string }
  | {
      type: "committed";
      navigation: number;
      url: string;
      loaderId: string;
      inPlace: boolean;
    }
  | {
      type: "lifecycle";
      state: "domcontentloaded" | "load";
      loaderId: string;
    }
  | {
      type: "ended";
      loaderId: string;
      url: string;
      httpStatus?: number;
      failure?: NavigationFailure;
      download?: boolean;
      by?: string;
    }
  | { type: "reset" };

// A navigation that ended without the document it asked for, kept for as long
// as a late reason can still explain it.
type Ended = PendingNavigation & { endedAt: number; by?: string };

const name = (netError: string) => netError.replace(/^net::/, "");
// A download or a newer navigation says more about an abort than its error
// text, so a late error does not report the end again.
const explained = (ended: Ended) =>
  ended.download === true || ended.by !== undefined;
const report = (error: unknown) =>
  console.error("A navigation tracker listener failed:", error);

// One tab's main-frame navigation log, fed by its session's CDP events and by
// the marks the controller's redirects, downloads and failed loads leave. It
// knows nothing about other frames: every event from another frame, or from an
// out-of-process frame's own session, is ignored.
export class NavigationTracker {
  private count = 0;
  private ring: { navigation: number; url: string }[] = [];
  private dropped = false;
  private doc?: MainDocument;
  private current?: PendingNavigation;
  private recent?: Ended;
  private listeners = new Set<(event: TrackerEvent) => void>();

  constructor(private readonly mainFrame: () => string | undefined) {}

  get navigation(): number {
    return this.count;
  }
  get commits(): readonly { navigation: number; url: string }[] {
    return this.ring;
  }
  get document(): MainDocument | undefined {
    return this.doc;
  }
  get pending(): PendingNavigation | undefined {
    return this.current;
  }
  get missed(): boolean {
    return this.dropped;
  }

  apply(event: CdpEvent): void {
    // An out-of-process frame reports on its own session, never the page's.
    if (event.sessionId !== undefined) return;
    const { params } = event;
    switch (event.method) {
      case "Page.frameStartedNavigating":
        if (this.main(params.frameId)) this.started(params);
        return;
      case "Page.frameNavigated":
        if (this.main(params.frame?.id)) this.committed(params.frame);
        return;
      case "Page.navigatedWithinDocument":
        if (this.main(params.frameId)) this.committedInPlace(params.url);
        return;
      case "Page.lifecycleEvent":
        if (this.main(params.frameId)) this.lifecycle(params);
        return;
      case "Page.frameStoppedLoading":
        // A navigation that stops without committing leaves no document.
        if (this.main(params.frameId) && this.current)
          this.end(this.current, {});
        return;
      case "Network.requestWillBeSent":
        this.request(params);
        return;
      case "Network.responseReceived":
        this.response(params);
        return;
      case "Network.loadingFailed":
        this.failed(params);
        return;
      default:
    }
  }

  // A download the session started. It reaches the tracker a few milliseconds
  // after the navigation's abort, so an end that just happened is reported
  // again as a download.
  markDownload(): void {
    const ended = this.current ? undefined : this.explainable(ENDED_GRACE_MS);
    const target = this.current ?? ended;
    if (!target || target.download) return;
    target.download = true;
    if (ended) this.report(ended);
  }

  // A server redirect the agent URL rule cancelled.
  markBlocked(url: string): void {
    const ended = this.current ? undefined : this.explainable(ENDED_GRACE_MS);
    const target = this.current ?? ended;
    if (!target || target.failure?.blockedUrl === url) return;
    target.failure = {
      netError: target.failure?.netError ?? BLOCKED_BY_CLIENT,
      errorCode: target.failure?.errorCode ?? BLOCKED_BY_CLIENT_CODE,
      blockedUrl: url,
    };
    if (ended && !explained(ended)) this.report(ended);
  }

  // The page's own did-fail-load, the only source of the numeric code: CDP
  // reports the name alone.
  markFailed(failure: { netError: string; errorCode: number }): void {
    const ended = this.current ? undefined : this.explainable(ENDED_GRACE_MS);
    const target = this.current ?? ended;
    if (!target) return;
    const held = target.failure;
    const netError = held?.netError || name(failure.netError);
    const errorCode = failure.errorCode || held?.errorCode || 0;
    if (held?.netError === netError && held.errorCode === errorCode) return;
    target.failure = {
      netError,
      errorCode,
      ...(held?.blockedUrl === undefined
        ? {}
        : { blockedUrl: held.blockedUrl }),
    };
    if (ended && !explained(ended)) this.report(ended);
  }

  // A document that loaded before the tracker saw it, read by loadProbe.
  settle(
    probe: { readyState: string; domContentLoaded: boolean; load: boolean },
    url: string,
  ): void {
    const doc = (this.doc ??= {
      loaderId: "",
      url,
      method: "GET",
      domContentLoaded: false,
      load: false,
    });
    if (
      (probe.domContentLoaded || probe.readyState !== "loading") &&
      !doc.domContentLoaded
    ) {
      doc.domContentLoaded = true;
      this.emit({
        type: "lifecycle",
        state: "domcontentloaded",
        loaderId: doc.loaderId,
      });
    }
    if ((probe.load || probe.readyState === "complete") && !doc.load) {
      doc.load = true;
      this.emit({ type: "lifecycle", state: "load", loaderId: doc.loaderId });
    }
  }

  // The commits after this one, oldest first, or undefined once the ring no
  // longer proves what followed it.
  since(navigation: number): { navigation: number; url: string }[] | undefined {
    if (navigation < 0 || navigation > this.count) return undefined;
    const oldest = this.ring[0]?.navigation;
    if (oldest !== undefined && navigation + 1 < oldest) return undefined;
    return this.ring.filter((commit) => commit.navigation > navigation);
  }

  subscribe(listener: (event: TrackerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // A session that detached may have missed commits, so what is known about
  // the page is dropped and the log counts as incomplete.
  reset(): void {
    this.current = undefined;
    this.recent = undefined;
    this.doc = undefined;
    this.dropped = true;
    this.emit({ type: "reset" });
  }

  private main(frameId: unknown): boolean {
    const main = this.mainFrame();
    return main !== undefined && frameId === main;
  }

  private started(params: {
    loaderId: string;
    url: string;
    navigationType?: string;
  }): void {
    const { loaderId, url } = params;
    const navigationType = params.navigationType ?? "differentDocument";
    const current = this.current;
    if (current?.loaderId === loaderId) {
      // A server redirect keeps one navigation; only where it points changes.
      current.url = url;
      current.type = navigationType;
    } else {
      if (current) this.end(current, { by: url });
      else this.explain(url);
      this.current = {
        loaderId,
        type: navigationType,
        url,
        startedAt: Date.now(),
      };
    }
    this.emit({ type: "started", loaderId, url, navigationType });
  }

  private committed(frame: {
    loaderId: string;
    url: string;
    unreachableUrl?: string;
  }): void {
    // A commit for another loader is an older document's: the pending
    // navigation stands.
    if (this.current && this.current.loaderId !== frame.loaderId) return;
    const source =
      this.current ??
      (this.recent?.loaderId === frame.loaderId ? this.recent : undefined);
    this.current = undefined;
    if (this.recent?.loaderId === frame.loaderId) this.recent = undefined;
    // A failed load commits Chromium's error page; the address the agent
    // asked for is the useful one.
    const url = frame.unreachableUrl || frame.url;
    this.doc = {
      loaderId: frame.loaderId,
      url,
      method: source?.method ?? "GET",
      ...(source?.httpStatus === undefined
        ? {}
        : { httpStatus: source.httpStatus }),
      domContentLoaded: false,
      load: false,
    };
    this.commit(url, frame.loaderId, false);
  }

  private committedInPlace(url: string): void {
    // Chromium reports a fragment change with no loaderId, and gives a
    // same-document navigation one it then drops.
    if (this.current?.type === "sameDocument") this.current = undefined;
    this.doc = this.doc
      ? { ...this.doc, url }
      : {
          loaderId: "",
          url,
          method: "GET",
          domContentLoaded: false,
          load: false,
        };
    this.commit(url, this.doc.loaderId, true);
  }

  private commit(url: string, loaderId: string, inPlace: boolean): void {
    this.count += 1;
    this.ring.push({ navigation: this.count, url });
    if (this.ring.length > COMMIT_RING) {
      this.ring.shift();
      this.dropped = true;
    }
    this.emit({
      type: "committed",
      navigation: this.count,
      url,
      loaderId,
      inPlace,
    });
  }

  private lifecycle(params: { loaderId: string; name: string }): void {
    const state =
      params.name === "DOMContentLoaded"
        ? "domcontentloaded"
        : params.name === "load"
          ? "load"
          : undefined;
    const doc = this.doc;
    if (!state || !doc || doc.loaderId !== params.loaderId) return;
    if (state === "load") {
      if (doc.load) return;
      doc.domContentLoaded = true;
      doc.load = true;
    } else {
      if (doc.domContentLoaded) return;
      doc.domContentLoaded = true;
    }
    this.emit({ type: "lifecycle", state, loaderId: doc.loaderId });
  }

  private request(params: {
    requestId: string;
    request?: { method?: string; url?: string };
    redirectResponse?: unknown;
  }): void {
    const target = this.forRequest(params.requestId);
    if (!target) return;
    target.requested = true;
    // A redirect reuses the request, and may turn a POST into a GET.
    target.method = params.request?.method ?? target.method ?? "GET";
    if (params.redirectResponse && params.request?.url)
      target.url = params.request.url;
  }

  private response(params: {
    requestId: string;
    response?: { status?: number };
  }): void {
    const target = this.forRequest(params.requestId);
    if (!target) return;
    target.responded = true;
    if (typeof params.response?.status === "number")
      target.httpStatus = params.response.status;
  }

  private failed(params: { requestId: string; errorText?: string }): void {
    const target = this.forRequest(params.requestId);
    if (!target) return;
    const held = target.failure;
    target.failure = {
      netError: name(params.errorText ?? "ERR_FAILED"),
      errorCode: held?.errorCode ?? 0,
      ...(held?.blockedUrl === undefined
        ? {}
        : { blockedUrl: held.blockedUrl }),
    };
    // A document request that failed ends its navigation, whether Chromium
    // then commits an error page or stops.
    if (target === this.current) this.end(target, {});
    else if (this.recent === target && !explained(this.recent) && !held)
      this.report(this.recent);
  }

  // The navigation a document request belongs to: its id is the loader's.
  private forRequest(requestId: string): PendingNavigation | undefined {
    if (this.current?.loaderId === requestId) return this.current;
    if (this.recent?.loaderId === requestId) return this.recent;
    return undefined;
  }

  private end(nav: PendingNavigation, extra: { by?: string }): void {
    if (this.current === nav) this.current = undefined;
    const ended: Ended = {
      ...nav,
      endedAt: Date.now(),
      ...(extra.by === undefined ? {} : { by: extra.by }),
    };
    this.recent = ended;
    this.report(ended);
  }

  // A navigation that ended moments ago and has no reason yet.
  private explainable(withinMs: number): Ended | undefined {
    const ended = this.recent;
    if (!ended || Date.now() - ended.endedAt > withinMs) return undefined;
    return ended;
  }

  // The navigation that just started replaced an abort of a moment ago.
  private explain(url: string): void {
    const ended = this.explainable(REPLACED_WITHIN_MS);
    if (!ended || ended.download || ended.by) return;
    ended.by = url;
    this.report(ended);
  }

  private report(ended: Ended): void {
    this.emit({
      type: "ended",
      loaderId: ended.loaderId,
      url: ended.url,
      ...(ended.httpStatus === undefined
        ? {}
        : { httpStatus: ended.httpStatus }),
      ...(ended.failure === undefined ? {} : { failure: ended.failure }),
      ...(ended.download ? { download: true } : {}),
      ...(ended.by === undefined ? {} : { by: ended.by }),
    });
  }

  private emit(event: TrackerEvent): void {
    for (const listener of [...this.listeners])
      try {
        listener(event);
      } catch (error) {
        report(error);
      }
  }
}
