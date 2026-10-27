import type { WebContents } from "electron";
import { cleanAgentText } from "../../shared/agent-text";
import type { Tab } from "../../shared/types";
import { reducedUserAgent } from "../identity";
import { remaining, type Actions } from "./actions";
import { createAgentCdp, type AgentCdp } from "./agent-cdp";
import type { Authority } from "./authority";
import {
  classify,
  contextIds,
  type PolicyContext,
  type Verdict,
} from "./cdp-policy";
import { ApiError, fail, toApiError } from "./errors";
import { recoverFromTimeout } from "./evaluate";
import type { EventRecording } from "./events";
import {
  NO_EXTENSION_NAMES,
  blockedFrameOf,
  blockedFramesByPath,
  extensionFrame,
  extensionInputMessage,
  type ExtensionNames,
} from "./extension-frames";
import type { FrameGroupsByTab } from "./frames/groups";
import type { Run } from "./http";
import { checkPointerTarget } from "./input/guards";
import type { Button } from "./input/state";
import type { PageScripts } from "./page-scripts";
import type { RefBook } from "./refs";
import type { AutomationController } from "./server";
import { CdpTimeoutError } from "./session/errors";
import type { TabSession } from "./session/tab-session";
import type { TabSessions } from "./session/tab-sessions";
import type { Step } from "./session/types";
import { agentVisible } from "./views";

// Section 8's filter: the only path a space's agent protocol traffic takes.
// Every command goes through the same order here, so no route reaches a tab
// session itself.

/** The narrow port over section 5's dispatcher and its keyboard check, one adapter line each. */
export interface InputDispatcherPort {
  dispatch(
    tabId: string,
    method: string,
    params: Record<string, unknown>,
    step: Step & { timeoutMs: number },
  ): Promise<unknown>;
  /** Section 5's keyboard check: refuses while focus is in a frame agent input never reaches. */
  checkFocus(tabId: string, session: TabSession, step: Step): Promise<void>;
}
/** The two protocol methods Kamapathy answers for a space, itself. */
export const SPACE_METHODS: readonly [
  "Target.getTargets",
  "Browser.getVersion",
] = ["Target.getTargets", "Browser.getVersion"];
/** One of this space's pages, as Target.getTargets reports it. */
export interface TargetInfoView {
  targetId: string;
  type: "page";
  title: string;
  url: string;
  attached: true;
  browserContextId: string;
}
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
  /** The space's own two methods, answered here; everything else is refused. */
  space(
    spaceId: string,
    method: string,
    params: Record<string, unknown>,
  ): { result: unknown };
  cdpFor(tabId: string): AgentCdp | undefined;
  dispose(): void;
}

// How often one tab's protocol traffic is named in Recent activity.
const ACTIVITY_MS = 60000;
const NO_WORLDS: ReadonlySet<string> = new Set<string>();
// The Input methods that act wherever focus is, which the person or the page
// may have put in a frame agent input never reaches.
const KEY_METHODS: readonly string[] = [
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Input.imeSetComposition",
];
// A frame agents never reach, named by its path, an iframe entry's ref or a
// frameId. One of the person's extensions is named for them instead.
const OUT_OF_REACH =
  "This frame belongs to an extension or an internal page, which agents never reach.";

type RawPoint = { x: number; y: number; press: boolean; button: Button };
// Every point a raw pointer command lands on, in the top page's CSS pixels,
// and whether it presses there. A touch, a tap and a gesture take CSS pixels
// as a mouse event does; a probe of Electron 44 saw a scroll or a pinch send
// its touches or wheel events to the frame under the point it starts at. An
// emulated touch takes the page's device-independent pixels, which the
// probe saw land at x / zoom.
function pointsOf(
  method: string,
  params: Record<string, unknown>,
  zoom: () => number,
): RawPoint[] {
  const at = (
    point: unknown,
    press: boolean,
    button: unknown = "left",
    scale = 1,
  ): RawPoint[] => {
    const { x, y } = (point ?? {}) as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || !Number.isFinite(x)) return [];
    if (typeof y !== "number" || !Number.isFinite(y)) return [];
    return [
      {
        x: x / scale,
        y: y / scale,
        press,
        button: (typeof button === "string" ? button : "left") as Button,
      },
    ];
  };
  const pressed = params.type === "mousePressed";
  switch (method) {
    case "Input.dispatchMouseEvent":
      return at(params, pressed, params.button);
    case "Input.emulateTouchFromMouseEvent":
      return at(params, pressed, params.button, zoom());
    case "Input.synthesizeTapGesture":
      return at(params, true);
    case "Input.synthesizeScrollGesture":
    case "Input.synthesizePinchGesture":
      return at(params, false);
    case "Input.dispatchTouchEvent": {
      const touches = Array.isArray(params.touchPoints)
        ? params.touchPoints
        : [];
      return touches.flatMap((touch: unknown) =>
        at(touch, params.type === "touchStart"),
      );
    }
    default:
      return [];
  }
}

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

// What this space holds, as the protocol describes a target: the pages the
// agent has, each under its own tab id, in the browser context the space is.
const targetsOf = (
  tabs: readonly Tab[],
  spaceId: string,
): { targetInfos: TargetInfoView[] } => ({
  targetInfos: tabs
    .filter(
      (tab) =>
        tab.spaceId === spaceId && tab.managed === true && agentVisible(tab),
    )
    .map((tab) => ({
      targetId: tab.id,
      type: "page" as const,
      title: cleanAgentText(tab.title),
      url: tab.url,
      attached: true as const,
      browserContextId: spaceId,
    })),
});
// What Kamapathy is, as Browser.getVersion describes a browser. Nothing of
// this comes from Chromium: the agent never reaches the browser itself.
const versionOf = () => ({
  protocolVersion: "1.3",
  product: `Chrome/${process.versions.chrome ?? ""}`,
  userAgent: reducedUserAgent(process.versions.chrome ?? ""),
  jsVersion: process.versions.v8 ?? "",
});

export function createSpaceCdp(deps: {
  controller: AutomationController;
  authority: Authority;
  actions: Pick<Actions, "readyContents">;
  sessions: TabSessions;
  frames: FrameGroupsByTab;
  refs: RefBook;
  pageScripts: PageScripts;
  events: Pick<EventRecording, "pause">;
  /** Without it, an Input command is refused as one Kamapathy sends itself. */
  input?: InputDispatcherPort;
  /** Section 17's loaded extensions, which name the frames agents never reach. */
  extensions?: ExtensionNames;
}): SpaceCdpFilter {
  const {
    controller,
    authority,
    actions,
    sessions,
    frames,
    refs,
    pageScripts,
    events,
    input,
  } = deps;
  const extensions = deps.extensions ?? NO_EXTENSION_NAMES;
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
  // Everything a tab's agent holds, closed and forgotten. A session whose
  // debugger has gone is forgotten without an error.
  const closeFor = async (tabId: string) => {
    const entry = held.get(tabId);
    if (!entry) return;
    held.delete(tabId);
    named.delete(tabId);
    await entry.cdp.close();
    entry.cdp.dispose();
  };
  // A tab keeps its agent sessions only while the agent has the tab: a
  // takeover, a hold, access ending, the tab released or closed and the
  // space closing all end them.
  const stopState = controller.subscribe(() => {
    for (const tabId of [...held.keys()]) {
      if (controller.agentControlled(tabId)) continue;
      const tab = controller.state.tabs.find((item) => item.id === tabId);
      const space = controller.state.spaces.find(
        (item) => item.id === tab?.spaceId,
      );
      void closeFor(tabId);
      // The log pauses with the sessions, so nothing the person does next
      // is recorded.
      if (space?.owner === "human") events.pause(space.id, "human_control");
    }
  });
  // The switch off ends them too, in flight commands included.
  const stopSwitch = pageScripts.onOff(() => {
    for (const tabId of [...held.keys()]) void closeFor(tabId);
  });
  const context = (tabId: string): PolicyContext => {
    const cdp = cdpFor(tabId);
    return {
      delivered: (kind, id) => cdp?.delivered(kind, id) ?? false,
      worlds: cdp?.worlds() ?? NO_WORLDS,
      platform: process.platform,
    };
  };
  // A command aimed at a frame agents never reach, as section 17 says: the
  // refusal names the extension whose page the frame shows when it is one of
  // the person's.
  const unreachable = (
    method: string,
    url: string | undefined,
    param?: string,
  ): never => {
    const extension =
      url === undefined ? undefined : extensionFrame(url, extensions);
    return refuse(method, {
      block: "scope",
      ...(param === undefined ? {} : { param }),
      message: extension ? extensionInputMessage(extension.name) : OUT_OF_REACH,
    });
  };
  // The URL of the blocked frame around a frame, which only names it. A
  // registry read that fails leaves the plain refusal.
  const blockedUrl = async (session: TabSession, frameId: string, step: Step) =>
    (await blockedFrameOf(session, frameId, step).catch(() => undefined))?.url;
  // The frame a command names, by its section 9 path or by the ref of the
  // `iframe` entry that opens it. A frame in the page's own process has no
  // session of its own to send on.
  const frameTarget = async (
    session: TabSession,
    call: CdpCall,
    frame: string,
    step: Step,
  ): Promise<string> => {
    const groups = frames.for(call.tabId);
    const missing = () =>
      fail(
        "frame_not_found",
        `This tab has no frame at ${frame}. Take a snapshot: each iframe entry carries the contentFrame path of the frame it opens.`,
        { frame },
      );
    if (!groups) return missing();
    await groups.bind(step);
    let frameId: string | undefined;
    if (frame.startsWith("@")) {
      refs.check(call.tabId, frame);
      const home = groups.homeFrame(frame);
      frameId = home?.opens ?? home?.frameId;
    } else {
      frameId = groups.frameAt(frame)?.frameId;
      // A blocked frame is never one of the groups: only the registry
      // places it.
      if (frameId === undefined) {
        const blocked = await blockedFramesByPath(session, step).catch(
          () => undefined,
        );
        const url = blocked?.get(frame)?.url;
        if (url !== undefined) return unreachable(call.method, url);
      }
    }
    if (frameId !== undefined && session.frameBlocked(frameId))
      return unreachable(
        call.method,
        await blockedUrl(session, frameId, step),
      );
    const path = frameId === undefined ? undefined : groups.pathOf(frameId);
    if (frameId === undefined || path === undefined) return missing();
    if (groups.frameAt(path)?.ownSession !== true)
      return fail(
        "invalid_field",
        "This frame runs in the page's process. Leave frame out and pass this frameId, or a context id, in params instead.",
        { field: "frame", frameId },
      );
    return frameId;
  };
  // Section 5's guards on a raw pointer command, at each point it lands on:
  // the point may belong to a frame agent input never reaches, and a press
  // on a select, a colour or a date field would open a native picker no
  // agent can answer.
  const guardPoint = async (
    session: TabSession,
    contents: WebContents,
    call: CdpCall,
    step: Step,
  ): Promise<void> => {
    const points = pointsOf(call.method, call.params, () =>
      contents.getZoomFactor(),
    );
    for (const { x, y, press, button } of points)
      await checkPointerTarget(session, { x, y }, step, {
        button,
        press,
        extensions,
      });
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
      // Input never goes out on an agent session: section 5's dispatcher
      // sends it on Kamapathy's own, at the top page's coordinates.
      if (verdict.dispatcher) {
        if (call.frame !== undefined)
          return fail(
            "invalid_field",
            "Input uses the top page's coordinates, which Kamapathy translates into the frame the point falls in. Leave frame out.",
            { field: "frame" },
          );
        if (!input)
          return refuse(call.method, {
            block: "managed",
            message:
              "Kamapathy sends input itself: use the click, press, scroll and drag routes.",
          });
      }
      const { contents, session } = await actions.readyContents(
        call.tabId,
        remaining(run.deadline),
        true,
        run.park,
      );
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
        let answered: { result: unknown; newSession?: true };
        if (verdict.dispatcher) {
          await guardPoint(session, contents, call, step);
          if (KEY_METHODS.includes(call.method))
            await input!.checkFocus(call.tabId, session, step);
          const dispatching = input!.dispatch(
            call.tabId,
            call.method,
            call.params,
            step,
          );
          void dispatching.catch(() => {});
          await Promise.race([dispatching, aborted]);
          // An Input command carries no result of its own.
          answered = { result: {} };
        } else {
          // A frameId in params aims at its frame as surely as frame does.
          const aimed = call.params.frameId;
          if (typeof aimed === "string" && session.frameBlocked(aimed))
            return unreachable(
              call.method,
              await blockedUrl(session, aimed, step),
              "frameId",
            );
          const frameId =
            call.frame === undefined
              ? undefined
              : await frameTarget(session, call, call.frame, step);
          // Each renderer numbers its own worlds, so on another target the
          // same number may be another world, an extension's among them.
          const cdp = cdpOf(call.tabId, session);
          for (const { key, id } of contextIds(call.params))
            if (!cdp.deliveredOn(frameId ?? "", id))
              return refuse(call.method, {
                block: "scope",
                param: key,
                message:
                  "A context id names a context only on the page or frame that gave it.",
              });
          const sending = cdp.send(
            call.method,
            call.params,
            {
              ...step,
              ...(frameId === undefined ? {} : { frameId }),
            },
          );
          void sending.catch(() => {});
          const { result, newSession } = await Promise.race([sending, aborted]);
          answered = {
            result,
            ...(newSession ? { newSession: true as const } : {}),
          };
        }
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
        return answered;
      } catch (error) {
        throw await mapped(error, session, call, step);
      } finally {
        // Anything that went out on an agent session may have changed the
        // page, so the refs it gave out are no longer the page's.
        if (run.dispatch.dispatched) refs.expireTab(call.tabId);
      }
    },
    space(spaceId, method) {
      authority.authorizeSpace(spaceId);
      pageScripts.require();
      if (method === "Target.getTargets")
        return { result: targetsOf(controller.state.tabs, spaceId) };
      if (method === "Browser.getVersion") return { result: versionOf() };
      return refuse(method, {
        block: "browser",
        message: `About itself Kamapathy answers ${SPACE_METHODS.join(" and ")}, and nothing else.`,
      });
    },
    cdpFor,
    dispose() {
      stopState();
      stopSwitch();
      stopSessions();
      for (const entry of held.values()) entry.cdp.dispose();
      held.clear();
      named.clear();
    },
  };
}
