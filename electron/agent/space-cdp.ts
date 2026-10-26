import { remaining, type Actions } from "./actions";
import { createAgentCdp, type AgentCdp } from "./agent-cdp";
import type { Authority } from "./authority";
import { classify, type PolicyContext, type Verdict } from "./cdp-policy";
import { ApiError, fail, toApiError } from "./errors";
import { recoverFromTimeout } from "./evaluate";
import type { Run } from "./http";
import type { PageScripts } from "./page-scripts";
import type { RefBook } from "./refs";
import type { AutomationController } from "./server";
import { CdpTimeoutError } from "./session/errors";
import type { TabSession } from "./session/tab-session";
import type { TabSessions } from "./session/tab-sessions";
import type { Step } from "./session/types";

// Section 8's filter: the only path a space's agent protocol traffic takes.
// Every command goes through the same order here, so no route reaches a tab
// session itself.

/** One command, as the route read it. */
export interface CdpCall {
  tabId: string;
  method: string;
  params: Record<string, unknown>;
  frame?: string;
  timeoutMs: number;
}
export interface SpaceCdpFilter {
  /** The only path a page command takes: authorize, switch, policy, session, ids, refs. */
  page(
    call: CdpCall,
    run: Run,
  ): Promise<{ result: unknown; newSession?: true }>;
  cdpFor(tabId: string): AgentCdp | undefined;
  dispose(): void;
}

// How often one tab's protocol traffic is named in Recent activity.
const ACTIVITY_MS = 60000;
const NO_WORLDS: ReadonlySet<string> = new Set<string>();

// Electron's debugger rejects with the protocol message alone. Chromium's own
// dispatcher writes these two, each with a fixed code of its own; a domain's
// refusal carries its text and no code.
const protocolCode = (message: string): number | undefined => {
  if (/^'.+' wasn't found$/.test(message)) return -32601;
  if (/^Invalid parameters/.test(message)) return -32602;
  return undefined;
};
// A call ends as soon as its signal aborts: a switch-off, or a client that
// left. Chromium's own reply waits on the deadline alone.
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}
const refuse = (
  method: string,
  verdict: Extract<Verdict, { block: string }>,
): never =>
  fail(
    "cdp_method_blocked",
    `Kamapathy does not pass ${method}. ${verdict.message ?? ""}`.trim(),
    {
      method,
      reason: verdict.block,
      ...(verdict.param === undefined ? {} : { param: verdict.param }),
    },
  );

export function createSpaceCdp(deps: {
  controller: AutomationController;
  authority: Authority;
  actions: Pick<Actions, "readyContents">;
  sessions: TabSessions;
  refs: RefBook;
  pageScripts: PageScripts;
}): SpaceCdpFilter {
  const { controller, authority, actions, sessions, refs, pageScripts } = deps;
  // One AgentCdp per live tab session, made on the tab's first command.
  const held = new Map<string, { session: TabSession; cdp: AgentCdp }>();
  const named = new Map<string, number>();
  // A new session holds none of the old one's sessions, ids or worlds.
  const stopSessions = sessions.onSession((session, tab) => {
    const entry = held.get(tab.id);
    if (!entry || entry.session === session) return;
    entry.cdp.dispose();
    held.delete(tab.id);
  });
  const cdpFor = (tabId: string) => held.get(tabId)?.cdp;
  const cdpOf = (tabId: string, session: TabSession): AgentCdp => {
    const entry = held.get(tabId);
    if (entry?.session === session) return entry.cdp;
    entry?.cdp.dispose();
    const cdp = createAgentCdp(session);
    held.set(tabId, { session, cdp });
    return cdp;
  };
  const context = (tabId: string): PolicyContext => {
    const cdp = cdpFor(tabId);
    return {
      delivered: (kind, id) => cdp?.delivered(kind, id) ?? false,
      worlds: cdp?.worlds() ?? NO_WORLDS,
      platform: process.platform,
    };
  };
  // What Chromium's refusal, or its silence, means to the agent.
  const mapped = async (
    error: unknown,
    session: TabSession,
    call: CdpCall,
    step: Step,
  ): Promise<unknown> => {
    if (error instanceof CdpTimeoutError) {
      const recovery = await recoverFromTimeout(session, step, false);
      const outcome = !recovery.pageResponsive
        ? "The page stopped answering. Reload or close the page before continuing."
        : recovery.executionStopped
          ? "Kamapathy stopped what the page was running, and it answers again."
          : "The page answers.";
      return new ApiError(
        "cdp_timeout",
        `${call.method} did not answer within ${call.timeoutMs} ms. ${outcome} The command may still apply.`,
        {
          awaited: "cdp",
          method: call.method,
          timeoutMs: call.timeoutMs,
          executionStopped: recovery.executionStopped,
          pageResponsive: recovery.pageResponsive,
        },
      );
    }
    // An error with a meaning of its own, such as a lost session, keeps it.
    if (toApiError(error) !== undefined || !(error instanceof Error))
      return error;
    const code = protocolCode(error.message);
    return new ApiError(
      "cdp_error",
      `Chromium refused ${call.method}: ${error.message}`,
      {
        method: call.method,
        ...(code === undefined ? {} : { protocolCode: code }),
        protocolMessage: error.message,
      },
    );
  };
  return {
    async page(call, run) {
      const tab = authority.authorizeTab(call.tabId);
      pageScripts.require();
      const verdict = classify(call.method, call.params, context(call.tabId));
      if ("block" in verdict) return refuse(call.method, verdict);
      // Input never goes out on an agent session; Kamapathy sends it.
      if (verdict.dispatcher)
        return refuse(call.method, {
          block: "managed",
          message:
            "Kamapathy sends input itself: use the click, press, scroll and drag routes.",
        });
      const { session } = await actions.readyContents(
        call.tabId,
        remaining(run.deadline),
        true,
        run.park,
      );
      const cdp = cdpOf(call.tabId, session);
      const signal = AbortSignal.any([run.signal, pageScripts.signal()]);
      const aborted = untilAborted(signal);
      void aborted.catch(() => {});
      // Checked before the command and again on its reply: a takeover or a
      // switch-off withholds whatever it answered.
      const guard = () => {
        authority.authorizeTab(call.tabId);
        pageScripts.require();
      };
      const step = {
        deadline: Math.min(run.deadline, Date.now() + call.timeoutMs),
        signal,
        guard,
        dispatch: run.dispatch,
        timeoutMs: call.timeoutMs,
      };
      try {
        const sending = cdp.send(call.method, call.params, step);
        void sending.catch(() => {});
        const { result, newSession } = await Promise.race([sending, aborted]);
        guard();
        const now = Date.now();
        if ((named.get(call.tabId) ?? 0) + ACTIVITY_MS <= now) {
          named.set(call.tabId, now);
          controller.addActivity(
            tab.spaceId,
            "Agent sent protocol commands to the page",
            "info",
          );
        }
        return { result, ...(newSession ? { newSession: true as const } : {}) };
      } catch (error) {
        throw await mapped(error, session, call, step);
      } finally {
        // Anything that went out on an agent session may have changed the
        // page, so the refs it gave out are no longer the page's.
        if (run.dispatch.dispatched) refs.expireTab(call.tabId);
      }
    },
    cdpFor,
    dispose() {
      stopSessions();
      for (const entry of held.values()) entry.cdp.dispose();
      held.clear();
      named.clear();
    },
  };
}
