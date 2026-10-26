import { collectIds } from "./cdp-policy";
import type { TabSession } from "./session/tab-session";
import type { Step } from "./session/types";

// Section 8's agent side of one tab's protocol: the sessions an agent holds,
// the identifiers that tab has given it, the worlds it made for itself and
// the domains it turned on. Nothing here decides what an agent may send.

/** Identifiers one tab keeps for its agent; past this the oldest goes. */
export const MAX_DELIVERED = 100000;

export type IdKind = "object" | "context" | "world" | "handle";
export interface AgentCdp {
  /** Opens the session for the target on first use; answers the raw result and whether it was new. */
  send(
    method: string,
    params: Record<string, unknown>,
    step: Step & { timeoutMs: number; frameId?: string },
  ): Promise<{ result: unknown; newSession: boolean }>;
  /** Records every id collectIds finds in a reply or an event. */
  deliver(method: string, value: unknown): void;
  delivered(kind: IdKind, id: string | number): boolean;
  worlds(): ReadonlySet<string>;
  owns(domain: "Page" | "Network"): boolean;
  /** Best effort: a session whose debugger has gone is forgotten, not an error. */
  close(): Promise<void>;
  dispose(): void;
}

// The commands that make a world the agent may then name, and the domains
// whose events replace Kamapathy's once the agent turns them on.
const WORLD_METHODS = new Set([
  "Page.createIsolatedWorld",
  "Page.addScriptToEvaluateOnNewDocument",
]);
const OWNED: readonly string[] = ["Page", "Network"];

// A context an agent may be given: the page's own world, or one the agent
// made itself. Kamapathy's worlds and an extension's content scripts report
// auxData.type "isolated" and are never in the agent's own world names.
const addressable = (value: unknown, worlds: ReadonlySet<string>): boolean => {
  const context = (value as { context?: Record<string, unknown> })?.context;
  const auxData = context?.auxData as { type?: unknown } | undefined;
  if (auxData?.type === "default") return true;
  return typeof context?.name === "string" && worlds.has(context.name);
};

export function createAgentCdp(session: TabSession): AgentCdp {
  // One session per target: the tab's own page under "", a frame under its
  // frame id.
  const sessions = new Map<string, string>();
  // Opens in flight, so two commands for one target share a session.
  const opening = new Map<string, Promise<string>>();
  // Insertion ordered, so the oldest id is the one evicted.
  const ids = new Map<string, true>();
  const made = new Set<string>();
  // Which of the agent's sessions hold each domain.
  const on = new Map<string, Set<string>>();

  const remember = (kind: IdKind, id: string | number) => {
    const key = `${kind}|${id}`;
    ids.delete(key);
    ids.set(key, true);
    while (ids.size > MAX_DELIVERED)
      ids.delete(ids.keys().next().value as string);
  };
  const deliver = (method: string, value: unknown) => {
    if (
      method === "Runtime.executionContextCreated" &&
      !addressable(value, made)
    )
      return;
    for (const found of collectIds(method, value))
      // A world is the agent's only when the agent made it, never because
      // an event named one.
      if (found.kind !== "world") remember(found.kind, found.id);
  };
  const open = (key: string) => {
    const held = opening.get(key);
    if (held) return held;
    const started = session
      .openAgentSession(key === "" ? undefined : key)
      .then((sessionId) => {
        sessions.set(key, sessionId);
        return sessionId;
      })
      .finally(() => {
        if (opening.get(key) === started) opening.delete(key);
      });
    opening.set(key, started);
    return started;
  };
  // What a command the page accepted changed about the agent's own reach.
  const note = (
    method: string,
    params: Record<string, unknown>,
    sessionId: string,
  ) => {
    if (WORLD_METHODS.has(method) && typeof params.worldName === "string")
      made.add(params.worldName);
    const [domain, name] = method.split(".");
    if (!OWNED.includes(domain)) return;
    if (name !== "enable" && name !== "disable") return;
    const holders = on.get(domain) ?? new Set<string>();
    if (name === "enable") holders.add(sessionId);
    else holders.delete(sessionId);
    on.set(domain, holders);
  };
  // Every event of the agent's own sessions delivers the ids it names.
  const stopEvents = session.on("agent", (event) => {
    deliver(event.method, event.params);
  });
  // A new document leaves no object, context or stream of the old one.
  const stopNavigation = session.on("Page.frameNavigated", (event) => {
    if (
      event.sessionId === undefined &&
      (event.params as { frame?: { parentId?: string } })?.frame?.parentId ===
        undefined
    )
      ids.clear();
  });
  // A lost debugger took every session with it, domains and all.
  const stopDetached = session.on("detached", () => {
    sessions.clear();
    opening.clear();
    on.clear();
  });
  return {
    async send(method, params, step) {
      const { frameId, ...rest } = step;
      const key = frameId ?? "";
      const held = sessions.get(key);
      const sessionId = held ?? (await open(key));
      const result = await session.send(method, params, { ...rest, sessionId });
      note(method, params, sessionId);
      deliver(method, result);
      return { result, newSession: held === undefined };
    },
    deliver,
    delivered: (kind, id) => ids.has(`${kind}|${id}`),
    worlds: () => made,
    owns: (domain) => (on.get(domain)?.size ?? 0) > 0,
    async close() {
      const held = [...sessions.values()];
      sessions.clear();
      opening.clear();
      on.clear();
      await Promise.all(
        held.map((sessionId) =>
          session.closeAgentSession(sessionId).catch(() => {}),
        ),
      );
    },
    dispose() {
      stopEvents();
      stopNavigation();
      stopDetached();
      sessions.clear();
      opening.clear();
      ids.clear();
      made.clear();
      on.clear();
    },
  };
}
