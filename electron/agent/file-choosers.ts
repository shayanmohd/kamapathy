import { randomBytes } from "node:crypto";
import type { Space } from "../../shared/types";
import { ERRORS } from "../../skills/kamapathy/scripts/schema/index.mjs";
import { activeSpace } from "./authority";
import type { Dialogs } from "./dialogs";
import { applyCallSource } from "./dom/files";
import { ApiError, fail } from "./errors";
import type { Expectations } from "./expectations";
import type { Run } from "./http";
import type { AutomationController } from "./server";
import { FrameBlockedError, SessionLostError } from "./session/errors";
import type { TabSession } from "./session/tab-session";
import type { TabSessions } from "./session/tab-sessions";
import type { CdpEvent, Step } from "./session/types";
import type { TabLog } from "./tab-log";

/** How long a chooser the agent has not filed stays open. */
export const CHOOSER_TTL_MS = 60_000;
const SETUP_TIMEOUT_MS = 15000;
const READ_TIMEOUT_MS = 10000;
// The input's accepted file types, read on the node the chooser named: the
// attribute as the page wrote it, trimmed and lowercased.
const ACCEPT_CALL = `function(){var raw=this.getAttribute&&this.getAttribute("accept")||"";return {ok:true,accept:raw.toLowerCase().split(",").map(function(part){return part.trim()}).filter(Boolean)}}`;
// The event a person's own cancel sends, which the page waits for when a
// chooser closes with nothing.
const CANCEL_CALL = `function(){var view=this.ownerDocument&&this.ownerDocument.defaultView||window;this.dispatchEvent(new view.Event("cancel",{bubbles:true}));return {ok:true}}`;

export interface FileChooserRecord {
  id: string;
  tabId: string;
  spaceId: string;
  frameId: string;
  loaderId: string;
  backendNodeId: number;
  multiple: boolean;
  accept: string[];
  expiresAt: number;
}
export interface FileChooserView {
  id: string;
  tabId: string;
  multiple: boolean;
  accept: string[];
}
export interface FileChoosers {
  /** Registers the interception setup hook and the event listeners. */
  attach(session: TabSession, tabId: string): () => void;
  get(id: string): FileChooserRecord | undefined;
  /** Applies the bytes to the chooser's input and consumes the chooser. */
  setFiles(
    id: string,
    files: { name: string; type: string; data: string }[],
    run: Run,
  ): Promise<{ ok: true; selected: number }>;
  /** True when an unarmed chooser opened on this tab after seq. */
  openedSince(tabId: string, seq: number): boolean;
  endTab(
    tabId: string,
    reason: "takeover" | "navigation" | "used" | "expired",
  ): void;
  forget(tabId: string): void;
}

// The one answer for an id that names no live chooser.
export const chooserNotFound = () =>
  new ApiError(
    "file_chooser_not_found",
    "No live file chooser has this ID: it was filed, its page moved on, or its sixty seconds ran out. Arm another wait before the action that opens one.",
  );

// A tab's session as this module uses it: the interception it switches, the
// documents of its frames, and the chooser events it hears.
interface Live {
  session: TabSession;
  /** The sessions interception was sent on; undefined is the page session. */
  sessionIds: Set<string | undefined>;
  /** Each frame's current document, for a chooser's frame expiry. */
  loaders: Map<string, string>;
  intercepting: boolean;
  stopped: boolean;
  end(): void;
}

// File choosers in agent tabs: every one is held back by Chromium, an armed
// wait receives it, and an unarmed one closes with the cancel event a person
// would have sent. Nothing here opens a window or touches disk.
export function createFileChoosers(deps: {
  tabLog: TabLog;
  arms: () => Pick<Expectations, "armFor" | "deliver">;
  controller: Pick<
    AutomationController,
    "state" | "subscribe" | "agentControlled"
  >;
  sessions: Pick<TabSessions, "get">;
  now?(): number;
}): FileChoosers {
  const { tabLog, controller, sessions } = deps;
  const now = deps.now ?? Date.now;
  const live = new Map<string, Live>();
  const records = new Map<string, FileChooserRecord>();
  // Each tab's last unarmed chooser, by tab log seq, which the guard reads.
  const unarmed = new Map<string, number>();
  // One object group per call, so releasing one never drops another's node.
  let groups = 0;

  const sweep = () => {
    const at = now();
    for (const [id, record] of records)
      if (record.expiresAt <= at) records.delete(id);
  };
  const drop = (tabId: string) => {
    for (const [id, record] of records)
      if (record.tabId === tabId) records.delete(id);
  };
  const viewOf = (record: FileChooserRecord): FileChooserView => ({
    id: record.id,
    tabId: record.tabId,
    multiple: record.multiple,
    accept: [...record.accept],
  });
  // Interception follows ownership, so a tab the person has opens its own
  // choosers for them as it always did.
  const intercept = (entry: Live, enabled: boolean) => {
    entry.intercepting = enabled;
    for (const sessionId of entry.sessionIds)
      void entry.session
        .send(
          "Page.setInterceptFileChooserDialog",
          { enabled },
          { sessionId, deadline: now() + SETUP_TIMEOUT_MS },
        )
        .catch(() => undefined);
  };
  // What the page answered, as a failure the agent can act on. A code the
  // registry does not know is reported as element_action_failed.
  const refusal = (result: Record<string, unknown>): never => {
    const known =
      typeof result.code === "string" && Object.hasOwn(ERRORS, result.code);
    const { fields } = result;
    return fail(
      known ? (result.code as string) : "element_action_failed",
      typeof result.error === "string"
        ? result.error
        : "The file input refused these files.",
      known && fields && typeof fields === "object" && !Array.isArray(fields)
        ? (fields as Record<string, unknown>)
        : undefined,
    );
  };
  // One fixed call on the input the chooser named. DOM.resolveNode keeps a
  // node the page has removed alive, which is why a chooser never goes
  // through the resolver.
  const onNode = async <T>(
    entry: Live,
    record: FileChooserRecord,
    declaration: string,
    args: unknown[],
    step: Step & { mutates?: true },
  ): Promise<T | undefined> => {
    const { session } = entry;
    const world = await session.world(record.frameId, step);
    const objectGroup = `kamapathy-chooser-${(groups += 1)}`;
    const at = {
      sessionId: world.sessionId,
      deadline: step.deadline,
      signal: step.signal,
      guard: step.guard,
    };
    try {
      const node = await session.send<{ object?: { objectId?: string } }>(
        "DOM.resolveNode",
        {
          backendNodeId: record.backendNodeId,
          executionContextId: world.contextId,
          objectGroup,
        },
        at,
      );
      const objectId = node.object?.objectId;
      if (objectId === undefined) return undefined;
      const reply = await session.send<{ result?: { value?: T } }>(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: declaration,
          arguments: args.map((value) => ({ value })),
          returnByValue: true,
          awaitPromise: true,
        },
        {
          ...at,
          ...(step.dispatch === undefined ? {} : { dispatch: step.dispatch }),
          ...(step.mutates ? { mutates: true as const } : {}),
        },
      );
      return reply.result?.value;
    } finally {
      await session
        .send("Runtime.releaseObjectGroup", { objectGroup }, at)
        .catch(() => undefined);
    }
  };
  // One chooser Chromium held back. An armed wait receives it; anything else
  // closes with the cancel event, and the action that opened it fails.
  const opened = (tabId: string, entry: Live, event: CdpEvent) => {
    const { frameId, backendNodeId, mode } = event.params as {
      frameId?: unknown;
      backendNodeId?: unknown;
      mode?: unknown;
    };
    if (typeof frameId !== "string" || typeof backendNodeId !== "number")
      return;
    const tab = controller.state.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const multiple = mode === "selectMultiple";
    const arm = deps.arms().armFor(tabId, "filechooser");
    const record: FileChooserRecord = {
      id: randomBytes(8).toString("hex"),
      tabId,
      spaceId: tab.spaceId,
      frameId,
      loaderId: entry.loaders.get(frameId) ?? "",
      backendNodeId,
      multiple,
      accept: [],
      expiresAt: now() + CHOOSER_TTL_MS,
    };
    const logged = tabLog.append(tabId, "file_chooser", {
      id: record.id,
      multiple,
    });
    const step: Step = { deadline: now() + READ_TIMEOUT_MS };
    if (!arm) {
      unarmed.set(tabId, logged.seq);
      void onNode(entry, record, CANCEL_CALL, [], {
        ...step,
        mutates: true,
      }).catch(() => undefined);
      return;
    }
    records.set(record.id, record);
    // What the page will take travels with the chooser, so the agent can
    // pick files the input accepts.
    void (async () => {
      try {
        const read = await onNode<{ accept?: unknown }>(
          entry,
          record,
          ACCEPT_CALL,
          [],
          step,
        );
        if (Array.isArray(read?.accept))
          record.accept = read.accept.filter(
            (item): item is string => typeof item === "string",
          );
      } catch (error) {
        // An extension frame or the PDF viewer has no world, so its chooser
        // is no one's: nothing opened for the person either.
        if (error instanceof FrameBlockedError) {
          records.delete(record.id);
          return;
        }
      }
      if (records.get(record.id) === record)
        deps.arms().deliver(tabId, "filechooser", {
          fileChooser: viewOf(record),
        });
    })();
  };

  const choosers: FileChoosers = {
    attach(session, tabId) {
      // A tab that attaches again leaves nothing of its last session behind.
      live.get(tabId)?.end();
      const entry: Live = {
        session,
        sessionIds: new Set(),
        loaders: new Map(),
        intercepting: controller.agentControlled(tabId),
        stopped: false,
        end: () => {},
      };
      live.set(tabId, entry);
      const stops: (() => void)[] = [];
      const end = () => {
        if (entry.stopped) return;
        entry.stopped = true;
        for (const stop of stops) stop();
        if (live.get(tabId) === entry) live.delete(tabId);
        drop(tabId);
      };
      entry.end = end;
      const track = (event: CdpEvent) => {
        const { frameId, loaderId, frame } = event.params as {
          frameId?: unknown;
          loaderId?: unknown;
          frame?: { id?: unknown; loaderId?: unknown };
        };
        const id = typeof frameId === "string" ? frameId : frame?.id;
        const loader =
          typeof loaderId === "string" ? loaderId : frame?.loaderId;
        if (typeof id === "string" && typeof loader === "string")
          entry.loaders.set(id, loader);
      };
      stops.push(
        // Interception does not cross a process boundary, so every session
        // this tab attaches switches it on for itself.
        session.onSessionSetup(async (sessionId) => {
          entry.sessionIds.add(sessionId);
          if (!controller.agentControlled(tabId)) return;
          await session.send(
            "Page.setInterceptFileChooserDialog",
            { enabled: true },
            { sessionId, deadline: now() + SETUP_TIMEOUT_MS },
          );
          entry.intercepting = true;
        }),
        session.on("Page.fileChooserOpened", (event) =>
          opened(tabId, entry, event),
        ),
        session.on("Page.lifecycleEvent", track),
        session.on("Page.frameNavigated", (event) => {
          const { frame } = event.params as {
            frame?: { id?: unknown; loaderId?: unknown };
          };
          const frameId = frame?.id;
          const loaderId = frame?.loaderId;
          track(event);
          if (typeof frameId !== "string") return;
          // The frame's next document leaves its chooser's node behind.
          for (const record of records.values())
            if (
              record.tabId === tabId &&
              record.frameId === frameId &&
              record.loaderId !== loaderId
            ) {
              choosers.endTab(tabId, "navigation");
              return;
            }
        }),
        session.on("releasing", end),
        session.on("closed", end),
      );
      return end;
    },
    get(id) {
      sweep();
      return records.get(id);
    },
    async setFiles(id, files, run) {
      const record = choosers.get(id);
      if (!record) throw chooserNotFound();
      const entry = live.get(record.tabId);
      const session = sessions.get(record.tabId);
      if (!entry || entry.stopped || !session || session !== entry.session)
        throw new SessionLostError("unavailable");
      const step: Step = {
        deadline: run.deadline,
        signal: run.signal,
        dispatch: run.dispatch,
      };
      const applied = await onNode<Record<string, unknown>>(
        entry,
        record,
        applyCallSource(),
        [{ files }],
        { ...step, mutates: true },
      );
      if (!applied)
        return fail(
          "page_changed",
          "The file chooser's input is gone from the page. Take a fresh snapshot.",
        );
      if (applied.ok === false) return refusal(applied);
      // An empty list closes the chooser with nothing, which the page hears
      // as the cancel a person's own would have sent.
      if (!files.length)
        await onNode(entry, record, CANCEL_CALL, [], {
          ...step,
          mutates: true,
        });
      records.delete(id);
      return {
        ok: true as const,
        selected:
          typeof applied.selected === "number"
            ? applied.selected
            : files.length,
      };
    },
    openedSince: (tabId, seq) => (unarmed.get(tabId) ?? 0) > seq,
    // Used, sixty seconds, the frame's next document and a takeover all end
    // a chooser the same way: the agent's next call answers that it is gone.
    endTab(tabId) {
      drop(tabId);
    },
    forget(tabId) {
      live.get(tabId)?.end();
      drop(tabId);
      unarmed.delete(tabId);
    },
  };

  controller.subscribe(() => {
    for (const [tabId, entry] of [...live]) {
      const wanted = controller.agentControlled(tabId);
      if (entry.stopped || wanted === entry.intercepting) continue;
      intercept(entry, wanted);
    }
  });
  return choosers;
}

// The agent has a space while it owns it and its access holds. A hold hands
// control over for one answer, so it is not the person taking the space.
const agentHas = (space: Space) =>
  activeSpace(space) && space.owner === "agent";

/**
 * The one place a takeover cancels what the agent armed: its waits, its
 * arms, its choosers and the tab's dialog policy. A space's Stop and agent
 * access off reach it the same way; a hold leaves everything in place.
 */
export function watchTakeover(deps: {
  controller: Pick<
    AutomationController,
    "state" | "subscribe" | "agentControlled"
  >;
  expectations: Pick<Expectations, "endSpace">;
  choosers: Pick<FileChoosers, "endTab">;
  dialogs: Pick<Dialogs, "clear">;
}): () => void {
  const { controller } = deps;
  const mine = new Set(
    controller.state.spaces.filter(agentHas).map((space) => space.id),
  );
  return controller.subscribe(() => {
    for (const space of controller.state.spaces) {
      if (agentHas(space)) {
        mine.add(space.id);
        continue;
      }
      if (!mine.delete(space.id)) continue;
      if (space.control?.hold !== undefined) {
        mine.add(space.id);
        continue;
      }
      deps.expectations.endSpace(space.id, "takeover");
      for (const tab of controller.state.tabs)
        if (tab.spaceId === space.id) {
          deps.choosers.endTab(tab.id, "takeover");
          deps.dialogs.clear(tab.id, "takeover");
        }
    }
  });
}
