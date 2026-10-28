import type { Authority } from "./authority";
import { redactEvent } from "./cdp-policy";
import type { PageScripts } from "./page-scripts";
import type { AutomationController } from "./server";
import { EVENT_LIMITS } from "./session/event-buffer";
import type { TabSession } from "./session/tab-session";
import type { TabSessions } from "./session/tab-sessions";
import type { CdpEvent, Gap, Step, TooLarge } from "./session/types";

// Section 8's recording control: when a tab's log records, what its redactor
// hides, and the drain the events route answers with. The events themselves
// live in section 1's buffer; nothing here stores one.

export interface AgentDomains {
  owns(tabId: string, domain: "Page" | "Network"): boolean;
  delivered(
    tabId: string,
    kind: "object" | "context" | "world" | "handle",
    id: string | number,
  ): boolean;
}
// One drained event, as the route answers it. A frame path is absent for the
// tab's own page, and null for a frame that has gone by the drain.
export type RecordedEvent =
  | { time: number; method: string; params: unknown; frame?: string | null }
  | {
      time: number;
      method: string;
      frame?: string | null;
      omitted: "too_large";
      bytes: number;
    };
export interface EventRecording {
  /** Section 11 registers AgentCdp here; until then nothing is owned and nothing is delivered. */
  setAgentDomains(domains: AgentDomains): void;
  sync(): void;
  drain(
    tabId: string,
    max: number,
    step: Step,
  ): Promise<{
    events: RecordedEvent[];
    dropped: number;
    gaps: Gap[];
    remaining: number;
  }>;
  pause(spaceId: string, reason: "human_control"): void;
  dispose(): void;
}
// Until section 11 fills the seam, an agent owns no domain and holds no id.
const NO_DOMAINS: AgentDomains = {
  owns: () => false,
  delivered: () => false,
};
// How many segments a frame path has. The frame a session was attached for is
// the one nearest the top of the tab.
const depth = (path: string) => path.split("/").length;
// One drained entry as the route answers it. frameOf names the path of the
// frame a session's event came from: undefined for the page itself, null for
// a frame that has gone.
const view = (
  event: CdpEvent | TooLarge,
  frameOf: (sessionId: string) => string | null | undefined,
): RecordedEvent => {
  const path =
    event.sessionId === undefined ? undefined : frameOf(event.sessionId);
  const frame = path === undefined ? {} : { frame: path };
  return "omitted" in event
    ? {
        time: event.at,
        method: event.method,
        ...frame,
        omitted: event.omitted,
        bytes: event.bytes,
      }
    : { time: event.at, method: event.method, params: event.params, ...frame };
};

export function createEventRecording(deps: {
  controller: AutomationController;
  authority: Authority;
  sessions: TabSessions;
  pageScripts: PageScripts;
}): EventRecording {
  const { controller, authority, sessions, pageScripts } = deps;
  let domains = NO_DOMAINS;
  // Each tab's log, kept while the tab is open, so a drain answers between
  // one session and the next.
  const logs = new Map<string, TabSession["events"]>();
  // Recording needs the switch on and the agent in control. The switch names
  // the gap when it is the cause; a takeover or a hold is the person's.
  const apply = (log: TabSession["events"], spaceId: string) => {
    const on = pageScripts.on && authority.agentDriven(spaceId);
    log.setRecording(on, pageScripts.on ? "human_control" : "page_scripts_off");
  };
  const sync = () => {
    for (const [tabId, log] of logs) {
      const tab = controller.state.tabs.find((item) => item.id === tabId);
      if (!tab) {
        logs.delete(tabId);
        continue;
      }
      apply(log, tab.spaceId);
    }
  };
  const stopSessions = sessions.onSession((session, tab) => {
    logs.set(tab.id, session.events);
    // One redactor per tab: the policy decides, the session says whose event
    // it is and which frames it blocks, and section 11's AgentCdp says what
    // the agent holds.
    session.events.setRedactor((event, source) =>
      redactEvent(event, {
        delivered: (kind, id) => domains.delivered(tab.id, kind, id),
        owns: (domain) => domains.owns(tab.id, domain),
        fromAgent: source.fromAgent,
        blocked: (frameId) => session.frameBlocked(frameId),
      }),
    );
    apply(session.events, tab.spaceId);
  });
  const stopState = controller.subscribe(() => sync());
  // The switch off stops recording and leaves no events behind.
  const stopSwitch = pageScripts.onOff(() => {
    sync();
    for (const log of logs.values()) log.drain(EVENT_LIMITS.events);
  });
  return {
    setAgentDomains(next) {
      domains = next;
    },
    sync,
    async drain(tabId, max, step) {
      const log = logs.get(tabId);
      if (!log) return { events: [], dropped: 0, gaps: [], remaining: 0 };
      const drained = log.drain(max);
      const session = sessions.get(tabId);
      // Paths are worked out here, with one frames() read per call, and only
      // when a drained event came from a frame's own session.
      const framed = drained.events.some(
        (event) => event.sessionId !== undefined,
      );
      const paths =
        framed && session ? await framePaths(session, step) : undefined;
      // An agent's own session belongs to the page or to the frame it was
      // opened for; any other session is one of Kamapathy's frame sessions.
      const frameOf = (sessionId: string) => {
        const opened = session?.agentFrame(sessionId);
        if (opened === null) return undefined;
        if (opened !== undefined) return paths?.byFrame.get(opened) ?? null;
        return paths?.bySession.get(sessionId) ?? null;
      };
      return {
        events: drained.events.map((event) => view(event, frameOf)),
        dropped: drained.dropped,
        gaps: drained.gaps,
        remaining: drained.remaining,
      };
    },
    pause(spaceId, reason) {
      for (const tab of controller.state.tabs)
        if (tab.spaceId === spaceId)
          logs.get(tab.id)?.setRecording(false, reason);
    },
    dispose() {
      stopSessions();
      stopState();
      stopSwitch();
      logs.clear();
    },
  };
}

// Each frame session's path, by session id, and each frame's own path, by
// frame id. A read that fails leaves every path unknown, which is what a
// frame that has gone reports anyway.
async function framePaths(
  session: TabSession,
  step: Step,
): Promise<{
  bySession: Map<string, string>;
  byFrame: Map<string, string>;
}> {
  const paths = new Map<string, string>();
  const byFrame = new Map<string, string>();
  const frames = await session.frames(step).catch(() => []);
  for (const frame of frames) {
    byFrame.set(frame.frameId, frame.path);
    if (frame.sessionId === undefined) continue;
    const held = paths.get(frame.sessionId);
    if (held === undefined || depth(frame.path) < depth(held))
      paths.set(frame.sessionId, frame.path);
  }
  return { bySession: paths, byFrame };
}
