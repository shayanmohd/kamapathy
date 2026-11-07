import type { AutomationController } from "../server";
import type { TabSession } from "../session/tab-session";
import type { Step } from "../session/types";
import { NavigationTracker } from "./tracker";

// The events a tracker reads. The session's own loading events are among
// them, and a listener hears only Kamapathy's own sessions.
const WATCHED = [
  "Page.frameStartedNavigating",
  "Page.frameNavigated",
  "Page.navigatedWithinDocument",
  "Page.frameStoppedLoading",
  "Page.lifecycleEvent",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFailed",
];

export interface Trackers {
  for(session: TabSession): NavigationTracker;
  probe(session: TabSession, step: Step & { namespace: string }): Promise<void>;
  dispose(): void;
}
export interface TrackersDeps {
  controller: AutomationController;
  sessions: {
    get(tabId: string): TabSession | undefined;
    onSession(listener: (session: TabSession) => void): () => void;
  };
}

// One navigation tracker per live tab session, subscribed to the session's
// events and to the controller's blocked redirects and downloads.
export function createTrackers({
  controller,
  sessions,
}: TrackersDeps): Trackers {
  const live = new WeakMap<
    TabSession,
    { tracker: NavigationTracker; stop: (() => void)[] }
  >();
  const trackerFor = (tabId: string) => {
    const session = sessions.get(tabId);
    return session ? live.get(session)?.tracker : undefined;
  };
  const stops = [
    controller.onBlockedRedirect((tabId, url) =>
      trackerFor(tabId)?.markBlocked(url),
    ),
    controller.onDownloadStarted((tabId) => trackerFor(tabId)?.markDownload()),
  ];
  const open = (session: TabSession) => {
    const held = live.get(session);
    if (held) return held;
    const tracker = new NavigationTracker(() => session.mainFrame);
    const stop: (() => void)[] = [];
    for (const method of WATCHED)
      stop.push(session.on(method, (event) => tracker.apply(event)));
    // The page's own failure report, the only source of the numeric code.
    const onFailLoad = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      _url: string,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame)
        tracker.markFailed({ netError: errorDescription, errorCode });
    };
    session.contents.on("did-fail-load", onFailLoad);
    stop.push(() =>
      session.contents.removeListener("did-fail-load", onFailLoad),
    );
    // The page's own report of a commit, for one Chromium does not report.
    const onNavigate = (_event: unknown, url: string) =>
      tracker.markNavigated(url);
    session.contents.on("did-navigate", onNavigate);
    stop.push(() =>
      session.contents.removeListener("did-navigate", onNavigate),
    );
    stop.push(session.on("attached", () => tracker.attached()));
    // A debugger that detached missed what the page did meanwhile; a released
    // session hears nothing more, and a closed tab keeps nothing.
    stop.push(session.on("detached", () => tracker.reset()));
    const end = () => {
      for (const unsubscribe of stop.splice(0)) unsubscribe();
      live.delete(session);
    };
    stop.push(session.on("releasing", end), session.on("closed", end));
    const entry = { tracker, stop };
    live.set(session, entry);
    return entry;
  };
  // Every session's tracker listens from before its attach: a new view starts
  // its first navigation inside the load that follows.
  stops.push(
    sessions.onSession((session) => {
      open(session);
    }),
  );
  return {
    for: (session) => open(session).tracker,
    async probe(session, step) {
      const tracker = open(session).tracker;
      const frameId = await session.mainFrameId(step);
      const probe = await session.evaluateInFrame(
        frameId,
        "loadProbe",
        {},
        step,
      );
      tracker.settle(
        {
          readyState: String(probe.readyState ?? ""),
          domContentLoaded: probe.domContentLoaded === true,
          load: probe.load === true,
        },
        session.contents.getURL(),
      );
    },
    dispose() {
      for (const stop of stops) stop();
    },
  };
}
