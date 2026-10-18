import { describe, expect, it } from "vitest";
import {
  COMMIT_RING,
  NavigationTracker,
  type TrackerEvent,
} from "../electron/agent/navigation/tracker";
import { createTrackers } from "../electron/agent/navigation/trackers";
import type { AutomationController } from "../electron/agent/server";
import type { TabSession } from "../electron/agent/session/tab-session";
import type { CdpEvent } from "../electron/agent/session/types";

const MAIN = "frame-main";
const event = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): CdpEvent => ({
  method,
  params,
  at: Date.now(),
  ...(sessionId === undefined ? {} : { sessionId }),
});
const started = (
  loaderId: string,
  url: string,
  navigationType = "differentDocument",
  frameId = MAIN,
) =>
  event("Page.frameStartedNavigating", {
    frameId,
    loaderId,
    url,
    navigationType,
  });
const navigated = (loaderId: string, url: string, frameId = MAIN) =>
  event("Page.frameNavigated", { frame: { id: frameId, loaderId, url } });
const inDocument = (url: string, frameId = MAIN) =>
  event("Page.navigatedWithinDocument", {
    frameId,
    url,
    navigationType: "fragment",
  });
const lifecycle = (loaderId: string, name: string, frameId = MAIN) =>
  event("Page.lifecycleEvent", { frameId, loaderId, name });
const stopped = (frameId = MAIN) =>
  event("Page.frameStoppedLoading", { frameId });
const request = (loaderId: string, url: string, method = "GET") =>
  event("Network.requestWillBeSent", {
    requestId: loaderId,
    loaderId,
    request: { method, url },
    type: "Document",
  });
const response = (loaderId: string, status: number) =>
  event("Network.responseReceived", {
    requestId: loaderId,
    loaderId,
    response: { status },
    type: "Document",
  });
const failed = (loaderId: string, errorText: string, canceled = true) =>
  event("Network.loadingFailed", {
    requestId: loaderId,
    errorText,
    canceled,
    type: "Document",
  });

const track = () => {
  const tracker = new NavigationTracker(() => MAIN);
  const events: TrackerEvent[] = [];
  tracker.subscribe((seen) => events.push(seen));
  const feed = (...items: CdpEvent[]) => {
    for (const item of items) tracker.apply(item);
  };
  const ends = () => events.filter((seen) => seen.type === "ended");
  return { tracker, events, feed, ends };
};
// A document loaded, with its own request.
const load = (loaderId: string, url: string, method = "GET", status = 200) => [
  started(loaderId, url),
  request(loaderId, url, method),
  response(loaderId, status),
  navigated(loaderId, url),
  lifecycle(loaderId, "DOMContentLoaded"),
  lifecycle(loaderId, "load"),
  stopped(),
];

describe("the navigation tracker", () => {
  it("attributes events by loaderId and ignores older commits", () => {
    const { tracker, events, feed } = track();
    feed(started("b", "https://a.test/b"));
    feed(navigated("a", "https://a.test/a"));
    expect(tracker.pending?.loaderId).toBe("b");
    expect(tracker.navigation).toBe(0);
    expect(tracker.document).toBeUndefined();
    // Another frame's events, and an out-of-process frame's session.
    feed(started("c", "https://a.test/c", "differentDocument", "frame-child"));
    feed(
      event(
        "Page.frameNavigated",
        { frame: { id: MAIN, loaderId: "d" } },
        "s1",
      ),
    );
    expect(tracker.pending?.loaderId).toBe("b");
    feed(navigated("b", "https://a.test/b"));
    expect(tracker.navigation).toBe(1);
    expect(tracker.pending).toBeUndefined();
    expect(tracker.document).toMatchObject({
      loaderId: "b",
      url: "https://a.test/b",
      method: "GET",
      domContentLoaded: false,
      load: false,
    });
    expect(events.at(-1)).toEqual({
      type: "committed",
      navigation: 1,
      url: "https://a.test/b",
      loaderId: "b",
      inPlace: false,
    });
  });

  it("commits a fragment-only change in place", () => {
    const { tracker, events, feed, ends } = track();
    feed(...load("a", "https://a.test/form", "POST"));
    feed(inDocument("https://a.test/form#two"));
    expect(tracker.navigation).toBe(2);
    expect(tracker.document).toEqual({
      loaderId: "a",
      url: "https://a.test/form#two",
      method: "POST",
      httpStatus: 200,
      domContentLoaded: true,
      load: true,
    });
    expect(events.at(-1)).toEqual({
      type: "committed",
      navigation: 2,
      url: "https://a.test/form#two",
      loaderId: "a",
      inPlace: true,
    });
    // A same-document navigation commits in place and ends nothing.
    feed(started("s", "https://a.test/form#three", "sameDocument"));
    feed(inDocument("https://a.test/form#three"));
    feed(stopped());
    expect(tracker.pending).toBeUndefined();
    expect(tracker.document?.loaderId).toBe("a");
    expect(ends()).toEqual([]);
  });

  it("follows a post-commit client redirect for the load state", () => {
    const { tracker, feed, events } = track();
    feed(...load("a", "https://a.test/one"));
    expect(tracker.document?.load).toBe(true);
    feed(
      started("b", "https://a.test/two"),
      request("b", "https://a.test/two"),
    );
    feed(response("b", 200), navigated("b", "https://a.test/two"));
    expect(tracker.document).toMatchObject({
      loaderId: "b",
      url: "https://a.test/two",
      domContentLoaded: false,
      load: false,
    });
    // The old document's lifecycle events no longer count.
    feed(lifecycle("a", "load"));
    expect(tracker.document?.load).toBe(false);
    feed(lifecycle("b", "DOMContentLoaded"));
    expect(tracker.document?.domContentLoaded).toBe(true);
    expect(tracker.document?.load).toBe(false);
    feed(lifecycle("b", "load"));
    expect(tracker.document?.load).toBe(true);
    expect(events.filter((seen) => seen.type === "lifecycle")).toEqual([
      { type: "lifecycle", state: "domcontentloaded", loaderId: "a" },
      { type: "lifecycle", state: "load", loaderId: "a" },
      { type: "lifecycle", state: "domcontentloaded", loaderId: "b" },
      { type: "lifecycle", state: "load", loaderId: "b" },
    ]);
  });

  it("records the document's method and status from its own request", () => {
    const { tracker, feed } = track();
    feed(started("a", "https://a.test/posted"));
    feed(request("a", "https://a.test/posted", "POST"));
    expect(tracker.pending).toMatchObject({ requested: true });
    feed(response("a", 200));
    expect(tracker.pending).toMatchObject({ requested: true, responded: true });
    feed(navigated("a", "https://a.test/posted"));
    expect(tracker.document).toMatchObject({ method: "POST", httpStatus: 200 });
  });

  it("classifies an abort as download, interrupted, blocked or failed", () => {
    // A download the session reported before the abort, and one reported
    // after it, as Chromium 152 does.
    const early = track();
    early.feed(
      started("a", "https://a.test/file"),
      request("a", "https://a.test/file"),
    );
    early.feed(response("a", 200));
    early.tracker.markDownload();
    early.feed(failed("a", "net::ERR_ABORTED"));
    expect(early.ends()).toEqual([
      {
        type: "ended",
        loaderId: "a",
        url: "https://a.test/file",
        httpStatus: 200,
        download: true,
        failure: { netError: "ERR_ABORTED", errorCode: 0 },
      },
    ]);
    const late = track();
    late.feed(
      ...[
        started("a", "https://a.test/file"),
        request("a", "https://a.test/file"),
      ],
    );
    late.feed(response("a", 200), failed("a", "net::ERR_ABORTED"), stopped());
    late.tracker.markDownload();
    expect(late.ends()).toHaveLength(2);
    expect(late.ends().at(-1)).toMatchObject({ loaderId: "a", download: true });

    // A newer navigation before the end, and one after it.
    const before = track();
    before.feed(
      started("a", "https://a.test/slow"),
      started("b", "https://a.test/next"),
    );
    expect(before.tracker.pending?.loaderId).toBe("b");
    before.feed(failed("a", "net::ERR_ABORTED"));
    expect(before.ends()).toEqual([
      {
        type: "ended",
        loaderId: "a",
        url: "https://a.test/slow",
        by: "https://a.test/next",
      },
    ]);
    const after = track();
    after.feed(
      started("a", "https://a.test/slow"),
      failed("a", "net::ERR_ABORTED"),
    );
    after.feed(started("b", "https://a.test/next"));
    expect(after.ends().at(-1)).toMatchObject({
      loaderId: "a",
      by: "https://a.test/next",
      failure: { netError: "ERR_ABORTED" },
    });

    const blocked = track();
    blocked.feed(
      started("a", "https://a.test/go"),
      request("a", "https://a.test/go"),
    );
    blocked.tracker.markBlocked("file:///etc/hosts");
    blocked.feed(failed("a", "net::ERR_ABORTED"));
    // The block keeps the code of a request the browser itself cancelled,
    // while Chromium's own text names the abort.
    expect(blocked.ends().at(-1)?.failure).toEqual({
      netError: "ERR_ABORTED",
      errorCode: -20,
      blockedUrl: "file:///etc/hosts",
    });

    const refused = track();
    refused.feed(
      started("a", "https://a.test/go"),
      request("a", "https://a.test/go"),
    );
    refused.feed(failed("a", "net::ERR_CONNECTION_REFUSED", false));
    refused.tracker.markFailed({
      netError: "ERR_CONNECTION_REFUSED",
      errorCode: -102,
    });
    expect(refused.ends().at(-1)?.failure).toEqual({
      netError: "ERR_CONNECTION_REFUSED",
      errorCode: -102,
    });

    const noContent = track();
    noContent.feed(
      started("a", "https://a.test/204"),
      request("a", "https://a.test/204"),
    );
    noContent.feed(response("a", 204), failed("a", "net::ERR_ABORTED"));
    expect(noContent.ends().at(-1)).toMatchObject({
      httpStatus: 204,
      failure: { netError: "ERR_ABORTED" },
    });
    expect(noContent.tracker.document).toBeUndefined();
  });

  it("settles a document that loaded before tracking began", () => {
    const { tracker, events } = track();
    tracker.settle(
      { readyState: "complete", domContentLoaded: true, load: true },
      "https://a.test/already",
    );
    expect(tracker.document).toEqual({
      loaderId: "",
      url: "https://a.test/already",
      method: "GET",
      domContentLoaded: true,
      load: true,
    });
    expect(tracker.navigation).toBe(0);
    expect(tracker.commits).toEqual([]);
    expect(events).toEqual([
      { type: "lifecycle", state: "domcontentloaded", loaderId: "" },
      { type: "lifecycle", state: "load", loaderId: "" },
    ]);
  });

  it("keeps 32 commits and reports older ones as missed", () => {
    const { tracker, feed } = track();
    for (let index = 1; index <= 40; index += 1)
      feed(
        started(`l${index}`, `https://a.test/${index}`),
        navigated(`l${index}`, `https://a.test/${index}`),
      );
    expect(tracker.navigation).toBe(40);
    expect(tracker.commits).toHaveLength(COMMIT_RING);
    expect(tracker.commits[0]).toEqual({
      navigation: 9,
      url: "https://a.test/9",
    });
    expect(tracker.missed).toBe(true);
    expect(tracker.since(1)).toBeUndefined();
    expect(tracker.since(9)).toHaveLength(31);
    expect(tracker.since(9)?.[0]).toEqual({
      navigation: 10,
      url: "https://a.test/10",
    });
    expect(tracker.since(39)).toEqual([
      { navigation: 40, url: "https://a.test/40" },
    ]);
    expect(tracker.since(40)).toEqual([]);
    expect(tracker.since(41)).toBeUndefined();
  });
});

// A session that records its listeners, so the tracker set can be driven
// without a debugger.
class FakeSession {
  readonly tabId = "tab-1";
  mainFrame: string | undefined = MAIN;
  url = "https://a.test/already";
  private listeners = new Map<string, Set<(event: CdpEvent) => void>>();
  private page = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly contents = {
    on: (name: string, listener: (...args: unknown[]) => void) => {
      const set = this.page.get(name) ?? new Set();
      this.page.set(name, set);
      set.add(listener);
    },
    removeListener: (name: string, listener: (...args: unknown[]) => void) => {
      this.page.get(name)?.delete(listener);
    },
    getURL: () => this.url,
  };
  probed = 0;

  on(name: string, listener: (event: CdpEvent) => void): () => void {
    const set = this.listeners.get(name) ?? new Set();
    this.listeners.set(name, set);
    set.add(listener);
    return () => set.delete(listener);
  }
  emit(event: CdpEvent): void {
    for (const listener of this.listeners.get(event.method) ?? [])
      listener(event);
  }
  signal(name: string): void {
    for (const listener of this.listeners.get(name) ?? [])
      listener({ method: name, params: {}, at: Date.now() });
  }
  failLoad(code: number, description: string): void {
    for (const listener of this.page.get("did-fail-load") ?? [])
      listener({}, code, description, this.url, true);
  }
  async mainFrameId(): Promise<string> {
    return MAIN;
  }
  async evaluateInFrame(): Promise<Record<string, unknown>> {
    this.probed += 1;
    return { readyState: "complete", domContentLoaded: true, load: true };
  }
}

describe("a tab's tracker set", () => {
  const setup = () => {
    const session = new FakeSession();
    const blocked: ((tabId: string, url: string) => void)[] = [];
    const downloads: ((tabId: string) => void)[] = [];
    const controller = {
      onBlockedRedirect(listener: (tabId: string, url: string) => void) {
        blocked.push(listener);
        return () => {};
      },
      onDownloadStarted(listener: (tabId: string) => void) {
        downloads.push(listener);
        return () => {};
      },
    } as unknown as AutomationController;
    const trackers = createTrackers({
      controller,
      sessions: {
        get: (tabId: string) =>
          tabId === session.tabId
            ? (session as unknown as TabSession)
            : undefined,
      },
    });
    return { session, trackers, blocked, downloads };
  };

  it("feeds one tracker per session from its events", () => {
    const { session, trackers } = setup();
    const tracker = trackers.for(session as unknown as TabSession);
    expect(trackers.for(session as unknown as TabSession)).toBe(tracker);
    session.emit(started("a", "https://a.test/one"));
    session.emit(request("a", "https://a.test/one"));
    session.emit(response("a", 200));
    session.emit(navigated("a", "https://a.test/one"));
    expect(tracker.document).toMatchObject({
      url: "https://a.test/one",
      httpStatus: 200,
    });
    session.emit(lifecycle("a", "load"));
    expect(tracker.document?.load).toBe(true);
    trackers.dispose();
  });

  it("takes the blocked redirect, the download and the failure of a tab", () => {
    const { session, trackers, blocked, downloads } = setup();
    const tracker = trackers.for(session as unknown as TabSession);
    session.emit(started("a", "https://a.test/go"));
    session.emit(request("a", "https://a.test/go"));
    for (const listener of blocked)
      listener(session.tabId, "file:///etc/hosts");
    for (const listener of downloads) listener("other-tab");
    expect(tracker.pending?.failure?.blockedUrl).toBe("file:///etc/hosts");
    expect(tracker.pending?.download).toBeUndefined();
    for (const listener of downloads) listener(session.tabId);
    expect(tracker.pending?.download).toBe(true);
    session.failLoad(-102, "ERR_CONNECTION_REFUSED");
    expect(tracker.pending?.failure?.errorCode).toBe(-102);
    trackers.dispose();
  });

  it("resets a tracker on a detach and probes a page that already loaded", async () => {
    const { session, trackers } = setup();
    const tracker = trackers.for(session as unknown as TabSession);
    session.emit(started("a", "https://a.test/one"));
    session.emit(navigated("a", "https://a.test/one"));
    expect(tracker.document?.url).toBe("https://a.test/one");
    session.signal("detached");
    expect(tracker.document).toBeUndefined();
    expect(tracker.missed).toBe(true);
    await trackers.probe(session as unknown as TabSession, {
      deadline: Date.now() + 1000,
      namespace: "test",
    });
    expect(session.probed).toBe(1);
    expect(tracker.document).toMatchObject({
      url: "https://a.test/already",
      load: true,
    });
    // A closed tab's session hands back a new tracker.
    session.signal("closed");
    expect(trackers.for(session as unknown as TabSession)).not.toBe(tracker);
    trackers.dispose();
  });
});
