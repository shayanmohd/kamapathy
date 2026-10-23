import { randomBytes } from "node:crypto";
import { cleanAgentText } from "../../shared/agent-text";
import {
  DIALOG_DRAIN_SOURCE,
  dialogHandlerSource,
  dialogQueueSource,
  MAX_REPORT_BYTES,
} from "./dom/dialog-handler";
import type { Expectation } from "./expectations";
import { SessionLostError } from "./session/errors";
import type { TabSession } from "./session/tab-session";
import type { TabSessions } from "./session/tab-sessions";
import type { DialogInfo, Step } from "./session/types";
import type { AutomationController } from "./server";
import type { DialogData, TabLog } from "./tab-log";

export const DIALOG_RECORDS = 20;
export const MAX_PROMPT_TEXT = 4096;
export const MAX_DIALOG_MESSAGE = 2000;
/** How long a reported dialog keeps the backstop from recording it again. */
export const BACKSTOP_WINDOW_MS = 250;
const MAX_DIALOG_URL = 2048;
const SETUP_TIMEOUT_MS = 15000;
// How often, and for how long, a drain runs while a dialog wait is armed.
const DRAIN_EVERY_MS = 250;
const DRAIN_TIMEOUT_MS = 5000;
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
  /** The backstop: answers an opening the handler never saw, from the same
   *  policy. Returns the record it made, or undefined when the person has
   *  control, the answer failed or another path reported the dialog. */
  backstop(
    tabId: string,
    dialog: DialogInfo,
    url?: string,
  ): Promise<DialogRecord | undefined>;
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
  /** Expectations.onArm, which starts the drain a dialog wait needs. */
  onArm?(
    listener: (expectation: Expectation) => (() => void) | void,
  ): () => void;
  now?(): number;
  random?(bytes: number): string;
}): Dialogs {
  const { tabLog, controller, sessions } = deps;
  const now = deps.now ?? Date.now;
  const random =
    deps.random ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const live = new Map<string, Live>();
  const logs = new Map<string, DialogRecord[]>();
  // What the page and Kamapathy itself reported lately, so the backstop
  // never records the same dialog a second time.
  const reported = new Map<string, { key: string; at: number }[]>();
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
  const append = (tabId: string, record: DialogData): DialogRecord => {
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
    return full;
  };
  // A dialog another path answered, keyed by type and message for the
  // backstop's 250 ms window.
  const keyOf = (type: string, message: string) => `${type}\u0000${message}`;
  const keep = (tabId: string, at: number) => {
    const kept = (reported.get(tabId) ?? []).filter(
      (item) => item.at > at - BACKSTOP_WINDOW_MS,
    );
    reported.set(tabId, kept);
    return kept;
  };
  const note = (tabId: string, record: DialogData) => {
    const at = now();
    keep(tabId, at).push({ key: keyOf(record.type, record.message), at });
  };
  const noted = (tabId: string, type: string, message: string) =>
    keep(tabId, now()).some((item) => item.key === keyOf(type, message));
  const pageUrl = (entry: Live) => {
    try {
      return entry.session.contents.getURL();
    } catch {
      return "";
    }
  };
  // One dialog Chromium reported because the handler never saw it. It is
  // answered from the policy the handler uses, and it spends the arm the
  // same way, so a page cannot win more accepts by going around the handler.
  const backstop = async (
    tabId: string,
    dialog: DialogInfo,
    url?: string,
  ): Promise<DialogRecord | undefined> => {
    const entry = live.get(tabId);
    if (!entry || entry.stopped) return undefined;
    // The person's dialogs stay the person's: Electron shows and answers them.
    if (!controller.agentControlled(tabId)) return undefined;
    // A leave guard belongs to section 6: it is always accepted and never
    // spends the policy.
    const guard = dialog.type === "beforeunload";
    const armed = guard ? undefined : armedFor(tabId);
    const accept = guard || armed !== undefined;
    const promptText =
      dialog.type === "prompt" && accept
        ? (armed?.promptText ?? dialog.defaultValue ?? "")
        : undefined;
    const sent = await entry.session
      .handleDialog(accept, promptText)
      .then(() => true)
      .catch(() => false);
    // Chromium refuses an answer for a dialog that is no longer open, such
    // as a leave guard Electron answered itself; the record still names what
    // Kamapathy accepted. One that is still open was never answered, so
    // phase 1's dialog_open holds this tab's page routes instead.
    if (!sent && entry.session.dialog() === dialog) return undefined;
    const message = guard ? "" : clean(dialog.message, MAX_DIALOG_MESSAGE);
    if (noted(tabId, dialog.type, message)) return undefined;
    return append(tabId, {
      type: dialog.type,
      message,
      ...(dialog.defaultValue === undefined
        ? {}
        : { defaultValue: clean(dialog.defaultValue, MAX_DIALOG_MESSAGE) }),
      answer: accept ? "accepted" : "dismissed",
      ...(promptText === undefined
        ? {}
        : { promptText: clean(promptText, MAX_PROMPT_TEXT) }),
      url: clean(url ?? pageUrl(entry), MAX_DIALOG_URL),
    });
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
    const data: DialogData = {
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
    };
    note(tabId, data);
    append(tabId, data);
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

  const api: Dialogs = {
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
        // A dialog the handler never saw reaches Chromium, which holds the
        // page until something answers it.
        session.on("Page.javascriptDialogOpening", (event) => {
          const dialog = session.dialog();
          if (!dialog) return;
          const { url } = event.params as Record<string, unknown>;
          void backstop(
            tabId,
            dialog,
            typeof url === "string" ? url : undefined,
          );
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
      note(tabId, record);
      append(tabId, record);
    },
    backstop,
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
      reported.delete(tabId);
    },
  };

  // A report a context without the binding queued reaches a dialog wait only
  // when something drains the tab, so one drain runs every 250 ms while an
  // arm is live.
  deps.onArm?.((expectation) => {
    if (expectation.event !== "dialog") return undefined;
    let running = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await api.drain(expectation.tabId, {
        deadline: now() + DRAIN_TIMEOUT_MS,
      });
      if (running) timer = setTimeout(tick, DRAIN_EVERY_MS);
    };
    timer = setTimeout(tick, DRAIN_EVERY_MS);
    return () => {
      running = false;
      if (timer) clearTimeout(timer);
    };
  });
  return api;
}
