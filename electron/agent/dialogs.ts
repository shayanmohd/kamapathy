import { randomBytes } from "node:crypto";
import { cleanAgentText } from "../../shared/agent-text";
import {
  DIALOG_DRAIN_SOURCE,
  dialogHandlerSource,
  dialogQueueSource,
  MAX_REPORT_BYTES,
} from "./dom/dialog-handler";
import { SessionLostError } from "./session/errors";
import type { TabSession } from "./session/tab-session";
import type { TabSessions } from "./session/tab-sessions";
import type { Step } from "./session/types";
import type { AutomationController } from "./server";
import type { DialogData, TabLog } from "./tab-log";

export const DIALOG_RECORDS = 20;
export const MAX_PROMPT_TEXT = 4096;
export const MAX_DIALOG_MESSAGE = 2000;
const MAX_DIALOG_URL = 2048;
const SETUP_TIMEOUT_MS = 15000;
const TYPES: readonly DialogData["type"][] = [
  "alert",
  "confirm",
  "prompt",
  "beforeunload",
];

export interface DialogPolicyInput {
  accept: boolean;
  promptText?: string;
  times: number;
  lifetimeMs: number;
}
export interface DialogPolicyView {
  accept: boolean;
  promptText?: string;
  remaining: number;
  expiresAt: number;
}
export interface DialogRecord extends DialogData {
  at: number;
}
export interface Dialogs {
  /** Registers the setup hook, the binding, the init script and the listeners. */
  attach(session: TabSession, tabId: string): () => void;
  setPolicy(
    tabId: string,
    policy: DialogPolicyInput | null,
  ): DialogPolicyView | null;
  policy(tabId: string): DialogPolicyView | null;
  records(tabId: string): DialogRecord[];
  /** A record Kamapathy made itself, such as section 6's leave guard. */
  record(tabId: string, record: Omit<DialogRecord, "at">): void;
  /** Collects the reports a context without the binding queued. */
  drain(tabId: string, step: Step): Promise<void>;
  clear(
    tabId: string,
    reason: "takeover" | "release" | "access_off" | "policy",
  ): void;
  forget(tabId: string): void;
}

// A policy in force on one tab.
interface Armed {
  accept: boolean;
  promptText?: string;
  remaining: number;
  expiresAt: number;
}
// An attached tab: the names its handler uses, the mode, the policy and the
// init script in force.
interface Live {
  session: TabSession;
  binding: string;
  key: string;
  event: string;
  mode: "agent" | "person";
  policy?: Armed;
  timer?: ReturnType<typeof setTimeout>;
  handler?: string;
  installing: Promise<void>;
  stopped: boolean;
  end?(): void;
}

// The dialog handler's lifecycle in agent tabs: one main-world source per
// tab that answers alert, confirm and prompt at once, the policy that arms
// accepting, and the reports it sends back. Reports are untrusted, like
// page text, so each one is validated before it counts.
export function createDialogs(deps: {
  tabLog: TabLog;
  controller: Pick<
    AutomationController,
    "state" | "subscribe" | "agentControlled"
  >;
  sessions: Pick<TabSessions, "get">;
  onAnswer?(tabId: string, record: DialogRecord): void;
  now?(): number;
  random?(bytes: number): string;
}): Dialogs {
  const { tabLog, controller, sessions } = deps;
  const now = deps.now ?? Date.now;
  const random =
    deps.random ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const live = new Map<string, Live>();
  const logs = new Map<string, DialogRecord[]>();
  const clean = (value: string, max: number) =>
    cleanAgentText(value).slice(0, max);
  const view = (armed?: Armed): DialogPolicyView | null =>
    armed
      ? {
          accept: armed.accept,
          ...(armed.promptText === undefined
            ? {}
            : { promptText: armed.promptText }),
          remaining: armed.remaining,
          expiresAt: armed.expiresAt,
        }
      : null;

  const sourceFor = (entry: Live) =>
    dialogHandlerSource({
      binding: entry.binding,
      key: entry.key,
      mode: entry.mode,
      policy: entry.policy
        ? {
            accept: entry.policy.accept,
            ...(entry.policy.promptText === undefined
              ? {}
              : { promptText: entry.policy.promptText }),
          }
        : null,
      event: entry.event,
    });
  // Adds the handler for the current mode and policy, then drops the one it
  // replaces, so no document loads without a handler. Installs run in order.
  // `atOnce` sends in this tick, which the hand-back needs: a tab leaving
  // the agent releases its session in the same state change.
  const install = (entry: Live, atOnce = false) => {
    if (entry.stopped) return;
    const source = sourceFor(entry);
    const sending = atOnce
      ? entry.session
          .addInitScript(source, { world: "main" })
          .catch(() => undefined)
      : undefined;
    entry.installing = entry.installing
      .then(async () => {
        if (entry.stopped) return;
        const added = sending
          ? await sending
          : await entry.session.addInitScript(source, { world: "main" });
        if (added === undefined) return;
        const previous = entry.handler;
        entry.handler = added;
        if (previous) await entry.session.removeInitScript(previous);
      })
      .catch(() => {
        // A session that went away installs nothing.
      });
  };
  const revert = (entry: Live) => {
    if (entry.timer) {
      clearTimeout(entry.timer);
      delete entry.timer;
    }
    if (!entry.policy) return;
    delete entry.policy;
    install(entry);
  };
  const armedFor = (tabId: string): Armed | undefined => {
    const entry = live.get(tabId);
    if (!entry?.policy) return undefined;
    // A lifetime that has run out reverts before anyone reads it.
    if (entry.policy.expiresAt <= now()) {
      revert(entry);
      return undefined;
    }
    return entry.policy;
  };
  // One answered dialog: the tab's own log for page.dialogs(), the tab log
  // for receipts and waits, and the arm it used up.
  const append = (tabId: string, record: DialogData) => {
    const full: DialogRecord = { ...record, at: now() };
    const log = logs.get(tabId) ?? [];
    log.push(full);
    if (log.length > DIALOG_RECORDS) log.splice(0, log.length - DIALOG_RECORDS);
    logs.set(tabId, log);
    tabLog.append(tabId, "dialog", record);
    const entry = live.get(tabId);
    const armed = armedFor(tabId);
    // Only an accepted confirm or prompt uses up an arm; alerts and the
    // records Kamapathy makes itself leave it alone.
    if (
      entry &&
      armed &&
      record.answer === "accepted" &&
      (record.type === "confirm" || record.type === "prompt")
    ) {
      armed.remaining -= 1;
      if (armed.remaining <= 0) revert(entry);
    }
    deps.onAnswer?.(tabId, full);
  };
  // A page can forge a report, so one is taken only when every field is the
  // kind it must be.
  const take = (tabId: string, payload: unknown) => {
    if (typeof payload !== "string" || payload.length > MAX_REPORT_BYTES)
      return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const { type, message, defaultValue, answer, promptText, url } =
      parsed as Record<string, unknown>;
    if (!TYPES.includes(type as DialogData["type"])) return;
    if (typeof message !== "string" || typeof url !== "string") return;
    if (answer !== "accepted" && answer !== "dismissed") return;
    if (defaultValue !== undefined && typeof defaultValue !== "string") return;
    if (promptText !== undefined && typeof promptText !== "string") return;
    append(tabId, {
      type: type as DialogData["type"],
      message: clean(message, MAX_DIALOG_MESSAGE),
      ...(defaultValue === undefined
        ? {}
        : { defaultValue: clean(defaultValue, MAX_DIALOG_MESSAGE) }),
      answer,
      ...(promptText === undefined
        ? {}
        : { promptText: clean(promptText, MAX_PROMPT_TEXT) }),
      url: clean(url, MAX_DIALOG_URL),
    });
  };
  // Takeover, a hold, Stop and agent access off all show up here as the tab
  // leaving the agent. This listener is registered before the one that
  // releases sessions, so a page gets its own functions back first.
  controller.subscribe(() => {
    for (const [tabId, entry] of [...live]) {
      const mode = controller.agentControlled(tabId) ? "agent" : "person";
      if (entry.stopped || mode === entry.mode) continue;
      entry.mode = mode;
      if (mode === "person") {
        revert(entry);
        install(entry, true);
      } else install(entry);
    }
  });
  const stop = (tabId: string, entry: Live, stops: (() => void)[]) => {
    if (entry.stopped) return;
    entry.stopped = true;
    if (entry.timer) clearTimeout(entry.timer);
    delete entry.policy;
    delete entry.timer;
    for (const unsubscribe of stops) unsubscribe();
    if (live.get(tabId) === entry) live.delete(tabId);
  };

  return {
    attach(session, tabId) {
      // A tab that attaches again leaves nothing of its last session behind.
      live.get(tabId)?.end?.();
      const entry: Live = {
        session,
        binding: `__kamapathy${random(8)}`,
        key: `__kamapathy${random(8)}`,
        event: `kamapathy-dialog-${random(8)}`,
        mode: controller.agentControlled(tabId) ? "agent" : "person",
        installing: Promise.resolve(),
        stopped: false,
      };
      live.set(tabId, entry);
      const stops: (() => void)[] = [];
      const end = () => stop(tabId, entry, stops);
      entry.end = end;
      stops.push(
        // The binding goes out before this session's init scripts, on the
        // page and on every frame session, and again after a re-attach.
        session.onSessionSetup(async (sessionId) => {
          await session.send(
            "Runtime.addBinding",
            { name: entry.binding },
            { sessionId, deadline: now() + SETUP_TIMEOUT_MS },
          );
        }),
        session.on("Runtime.bindingCalled", (event) => {
          const { name, payload } = event.params as Record<string, unknown>;
          if (name === entry.binding) take(tabId, payload);
        }),
        session.on("releasing", end),
        session.on("closed", end),
      );
      void session.addInitScript(dialogQueueSource(entry.event), {
        world: "isolated",
      });
      install(entry);
      return end;
    },
    setPolicy(tabId, policy) {
      const entry = live.get(tabId);
      if (!entry || sessions.get(tabId) !== entry.session)
        throw new SessionLostError("unavailable");
      if (entry.timer) {
        clearTimeout(entry.timer);
        delete entry.timer;
      }
      if (!policy) {
        delete entry.policy;
        install(entry);
        return null;
      }
      entry.policy = {
        accept: policy.accept,
        ...(policy.promptText === undefined
          ? {}
          : { promptText: policy.promptText }),
        remaining: policy.times,
        expiresAt: now() + policy.lifetimeMs,
      };
      entry.timer = setTimeout(() => {
        if (live.get(tabId) === entry) revert(entry);
      }, policy.lifetimeMs);
      install(entry);
      return view(entry.policy);
    },
    policy: (tabId) => view(armedFor(tabId)),
    records: (tabId) =>
      (logs.get(tabId) ?? []).map((record) => ({ ...record })),
    record(tabId, record) {
      append(tabId, record);
    },
    async drain(tabId, step) {
      const entry = live.get(tabId);
      const session = sessions.get(tabId);
      if (!entry || !session || session !== entry.session) return;
      let frames;
      try {
        frames = await session.frames(step);
      } catch {
        return;
      }
      for (const frame of frames) {
        if (frame.blocked || frame.unavailable) continue;
        try {
          const world = await session.world(frame.frameId, step);
          const reply = await session.send<{ result?: { value?: unknown } }>(
            "Runtime.evaluate",
            {
              expression: DIALOG_DRAIN_SOURCE,
              contextId: world.contextId,
              returnByValue: true,
              silent: true,
            },
            { ...step, sessionId: world.sessionId },
          );
          const queued = reply.result?.value;
          if (Array.isArray(queued))
            for (const item of queued) take(tabId, item);
        } catch {
          // A frame that goes away mid-drain has nothing left to report.
        }
      }
    },
    clear(tabId, reason) {
      const entry = live.get(tabId);
      if (!entry) return;
      revert(entry);
      if (reason === "release" || reason === "access_off") return;
      install(entry);
    },
    forget(tabId) {
      const entry = live.get(tabId);
      if (entry) {
        entry.stopped = true;
        if (entry.timer) clearTimeout(entry.timer);
        live.delete(tabId);
      }
      logs.delete(tabId);
    },
  };
}
