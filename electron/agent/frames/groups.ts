import { ApiError } from "../errors";
import type { RefBook } from "../refs";
import {
  CdpTimeoutError,
  FrameBlockedError,
  PageCrashedError,
  SessionLostError,
  TabClosedError,
} from "../session/errors";
import { FRAME_OWNER_SOURCE } from "../session/operations";
import type { TabSession } from "../session/tab-session";
import type { TabSessions } from "../session/tab-sessions";
import type { KnownFrame, Step } from "../session/types";
import { comparePaths, prefixPath } from "./compose";
import type { OwnerBox } from "./geometry";

// Section 9's frame groups, one per tab session: the shape of the tab's
// frames as the registry reports it, corrected by what each world can
// actually read, the owner element every frame is reached through, the plan
// one read per group follows, and the home frame of every ref a read gave
// out. Nothing here reads a page itself; the caller's own read does that.

/** What a frame's entry says about its content. */
export type FrameContent =
  "read" | "pending" | "unavailable" | "limit" | "blocked";
/** A frame's owner element, as the world around it knows it. */
export interface OwnerBinding {
  frameId: string;
  /** The frame path of the group whose world holds the owner. */
  group: string;
  /** The frame's own path inside that group. */
  local: string;
  /** What the page's owner table calls it. */
  key: string;
  /** Whether that world can read the frame's document. */
  readable: boolean;
  box?: OwnerBox;
}
export interface GroupInfo {
  /** The frame the group starts at, whose world reads it. */
  root: string;
  /** The root's frame path, "" for the top group. */
  path: string;
  sessionId?: string;
  origin: string;
  /** How many group boundaries lie between the top document and this group. */
  level: number;
  owner?: OwnerBinding;
}
export interface ReadLimits {
  groups: number;
  levels: number;
  inFlight: number;
  perGroupMs: number;
}
export const READ_LIMITS: ReadLimits = {
  groups: 32,
  levels: 8,
  inFlight: 4,
  perGroupMs: 2000,
};
/** What one group gets for a wait check. */
export const WAIT_GROUP_MS = 1000;
/** How long a frame that did not answer stays unavailable. */
export const SILENT_FOR_MS = 10000;
/** What a silent frame gets to prove it is back. */
export const READY_PROBE_MS = 250;
// The owner objects of one pass, released together. Phase 1's own frame
// reads use this group too, so nothing resolved here outlives a pass.
const OBJECT_GROUP = "kamapathy-frames";

/**
 * A group a read did not reach. unreadFrames counts the pending, unavailable
 * and limit ones; a blocked group is listed for the entry it belongs to.
 */
export interface UnreadFrame {
  frameId: string;
  local: string;
  content: FrameContent;
}
export interface FrameGroups {
  groups(step: Step): Promise<GroupInfo[]>;
  /** The owners between the top document and the frame, outermost first. */
  ownerChain(frameId: string): OwnerBinding[];
  focusedFrame(step: Step): Promise<{
    frameId: string;
    path: string;
    blocked: boolean;
    editable: boolean;
  }>;
  bind(step: Step): Promise<void>;
  /**
   * Runs one read per group under the limits, newly found groups after the
   * read that found their owner. `perGroupMs` bounds each read, `from` names
   * the frame whose group the read starts at, `stop` ends the plan once the
   * caller has what it needs, leaving the groups left over untouched, and
   * the scope's own group fails the whole call rather than being listed
   * unread.
   */
  read<T>(
    step: Step & {
      budgetMs: number;
      perGroupMs?: number;
      from?: string;
      stop?: () => boolean;
    },
    run: (group: GroupInfo) => Promise<T>,
  ): Promise<{
    results: { group: GroupInfo; value: T }[];
    unread: UnreadFrame[];
  }>;
  contentOf(frameId: string): FrameContent;
  pathOf(frameId: string): string | undefined;
  frameAt(
    path: string,
  ): { frameId: string; sessionId?: string; ownSession: boolean } | undefined;
  groupOf(frameId: string): GroupInfo | undefined;
  setHome(ref: string, frameId: string, opens?: string): void;
  /**
   * The frame a ref was issued in, with the path it carries now, the one it
   * was given in and the frame an `iframe` entry's ref opens. Throws
   * stale_ref with the frame path once the home moved on.
   */
  homeFrame(ref: string):
    | { frameId: string; path?: string; group: string; opens?: string }
    | undefined;
  dispose(): void;
}

// A binding and the document it was made in, so a root that loads another
// page binds its children again.
type Bound = { binding: OwnerBinding; root: string; rootLoaderId: string };
type Host = { sessionId?: string; ownSession: boolean };
const TIMED_OUT = Symbol("timed out");

export function createFrameGroups(
  session: TabSession,
  deps: { refs: RefBook; tabId: string },
): FrameGroups {
  const { refs, tabId } = deps;
  const bindings = new Map<string, Bound>();
  const groupOfFrame = new Map<string, GroupInfo>();
  // Each group's own groups, by the group root they sit in.
  const childGroups = new Map<string, GroupInfo[]>();
  const pathOfFrame = new Map<string, string>();
  const frameOfPath = new Map<string, string>();
  const hosts = new Map<string, Host>();
  const loaders = new Map<string, string>();
  const contents = new Map<string, FrameContent>();
  // Frames that did not answer a read, until the moment they are tried again.
  const silent = new Map<string, number>();
  let unavailable = new Set<string>();
  let groupList: GroupInfo[] = [];
  let mainFrameId = "";
  // One pass at a time: a second caller waits and then finds the bindings
  // the first one made.
  let chain: Promise<unknown> = Promise.resolve();

  // A frame that loaded another document, or went, takes the bindings made
  // in its world with it, and its own owner is measured again. Its loaderId
  // goes too, so a ref whose home it was answers stale.
  const stopFrames = session.on("frame", ({ params }) => {
    const { frameId, change } = params as { frameId: string; change: string };
    if (change === "attached") return;
    loaders.delete(frameId);
    bindings.delete(frameId);
    for (const [child, bound] of [...bindings])
      if (bound.root === frameId) bindings.delete(child);
  });
  // A session that ended took every world with it, and with them every
  // binding. The documents did not change, so the homes stand.
  const stopDetached = session.on("detached", () => {
    bindings.clear();
    silent.clear();
  });

  const silentNow = (frameId: string) =>
    (silent.get(frameId) ?? 0) > Date.now();

  const groupFor = (
    frame: KnownFrame,
    path: string,
    level: number,
    owner?: OwnerBinding,
  ): GroupInfo => ({
    root: frame.frameId,
    path,
    ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
    origin: frame.origin,
    level,
    ...(owner === undefined ? {} : { owner }),
  });

  // The four steps that bind one frame's owner, on the session and world of
  // the group around it. A failure is retried on the next pass.
  const bindOwner = async (
    frame: KnownFrame,
    around: GroupInfo,
    rootLoaderId: string,
    step: Step,
    resolved: Set<string | undefined>,
  ): Promise<OwnerBinding | undefined> => {
    const held = bindings.get(frame.frameId);
    if (held && held.root === around.root && held.rootLoaderId === rootLoaderId)
      return { ...held.binding, group: around.path };
    try {
      const world = await session.world(around.root, step);
      const at = {
        sessionId: world.sessionId,
        deadline: step.deadline,
        signal: step.signal,
        guard: step.guard,
      };
      const owner = await session.send<{ backendNodeId: number }>(
        "DOM.getFrameOwner",
        { frameId: frame.frameId },
        at,
      );
      const node = await session.send<{ object: { objectId?: string } }>(
        "DOM.resolveNode",
        {
          backendNodeId: owner.backendNodeId,
          executionContextId: world.contextId,
          objectGroup: OBJECT_GROUP,
        },
        at,
      );
      resolved.add(world.sessionId);
      const reply = await session.send<{
        result?: { value?: { local?: unknown; readable?: unknown } };
        exceptionDetails?: unknown;
      }>(
        "Runtime.callFunctionOn",
        {
          objectId: node.object.objectId,
          functionDeclaration: FRAME_OWNER_SOURCE,
          arguments: [{ value: frame.frameId }],
          returnByValue: true,
          silent: true,
        },
        at,
      );
      const value = reply.result?.value;
      if (reply.exceptionDetails || typeof value?.local !== "string")
        return undefined;
      const binding: OwnerBinding = {
        frameId: frame.frameId,
        group: around.path,
        local: value.local,
        key: frame.frameId,
        readable: value.readable === true,
      };
      bindings.set(frame.frameId, {
        binding,
        root: around.root,
        rootLoaderId,
      });
      return binding;
    } catch (error) {
      // A takeover, a lost session or the deadline ends the whole pass.
      // Anything else only leaves this frame unbound.
      step.guard?.();
      if (
        error instanceof SessionLostError ||
        error instanceof PageCrashedError ||
        error instanceof TabClosedError ||
        error instanceof CdpTimeoutError
      )
        throw error;
      return undefined;
    }
  };

  // One pass over the registry: the guess, the bindings that correct it, and
  // the paths every group and frame carries.
  const pass = async (step: Step): Promise<void> => {
    const main = await session.mainFrameId(step);
    const known = await session.knownFrames(step);
    const groups: GroupInfo[] = [];
    const nextGroupOf = new Map<string, GroupInfo>();
    const nextChildren = new Map<string, GroupInfo[]>();
    const nextPath = new Map<string, string>();
    const nextFrameOf = new Map<string, string>();
    const nextContents = new Map<string, FrameContent>();
    const nextHosts = new Map<string, Host>();
    const nextLoaders = new Map<string, string>();
    const nextUnavailable = new Set<string>();
    const resolved = new Set<string | undefined>();
    // A group whose root cannot be read holds no owner to bind children in.
    const closed = new Set<string>();
    try {
      for (const frame of known) {
        nextLoaders.set(frame.frameId, frame.loaderId);
        nextHosts.set(frame.frameId, {
          ...(frame.sessionId === undefined
            ? {}
            : { sessionId: frame.sessionId }),
          ownSession: frame.ownSession,
        });
        if (frame.unavailable) nextUnavailable.add(frame.frameId);
        if (frame.frameId === main) {
          const top = groupFor(frame, "", 0);
          groups.push(top);
          nextGroupOf.set(main, top);
          nextPath.set(main, "");
          nextFrameOf.set("", main);
          if (frame.unavailable) closed.add(main);
          continue;
        }
        // Blocked frames, and everything inside them, are never bound or
        // read. The registry blocks a frame inside a blocked one too.
        if (frame.blocked) {
          nextContents.set(frame.frameId, "blocked");
          continue;
        }
        const around =
          frame.parentFrameId === undefined
            ? undefined
            : nextGroupOf.get(frame.parentFrameId);
        if (!around || closed.has(around.root)) {
          nextContents.set(frame.frameId, "pending");
          continue;
        }
        const binding = await bindOwner(
          frame,
          around,
          nextLoaders.get(around.root) ?? "",
          step,
          resolved,
        );
        // An owner the walk could not place, such as one inside a closed
        // shadow root, has an empty path, which is the group's own. Such a
        // frame stays unbound rather than take the path of the frame
        // around it.
        if (!binding || binding.local === "") {
          nextContents.set(frame.frameId, "pending");
          continue;
        }
        const path = prefixPath(around.path, binding.local);
        nextPath.set(frame.frameId, path);
        nextFrameOf.set(path, frame.frameId);
        // The walk corrects the guess: a readable owner keeps its frame in
        // the group around it, whatever the two origins are.
        if (binding.readable) {
          nextGroupOf.set(frame.frameId, around);
          continue;
        }
        const own = groupFor(frame, path, around.level + 1, binding);
        groups.push(own);
        nextGroupOf.set(frame.frameId, own);
        const siblings = nextChildren.get(around.root) ?? [];
        siblings.push(own);
        nextChildren.set(around.root, siblings);
        if (frame.unavailable || silentNow(frame.frameId)) {
          nextContents.set(frame.frameId, "unavailable");
          closed.add(frame.frameId);
        }
      }
    } finally {
      await Promise.all(
        [...resolved].map((sessionId) =>
          session
            .send(
              "Runtime.releaseObjectGroup",
              { objectGroup: OBJECT_GROUP },
              { sessionId, deadline: step.deadline },
            )
            .catch(() => {}),
        ),
      );
    }
    // Silence that has run out, and frames that are gone, are forgotten, so
    // nothing here grows with a tab's frame churn.
    for (const [frameId, until] of [...silent])
      if (until <= Date.now() || !nextLoaders.has(frameId))
        silent.delete(frameId);
    mainFrameId = main;
    groupList = groups.sort((first, second) =>
      comparePaths(first.path, second.path),
    );
    unavailable = nextUnavailable;
    replace(groupOfFrame, nextGroupOf);
    replace(childGroups, nextChildren);
    replace(pathOfFrame, nextPath);
    replace(frameOfPath, nextFrameOf);
    replace(contents, nextContents);
    replace(hosts, nextHosts);
    replace(loaders, nextLoaders);
  };

  const bind = (step: Step): Promise<void> => {
    const next = chain.then(
      () => pass(step),
      () => pass(step),
    );
    chain = next.catch(() => {});
    return next;
  };

  // One ready probe decides whether a frame that went silent is back.
  const wake = async (group: GroupInfo, step: Step): Promise<boolean> => {
    try {
      await session.evaluateInFrame(
        group.root,
        "ready",
        {},
        {
          deadline: Math.min(step.deadline, Date.now() + READY_PROBE_MS),
          namespace: "internal",
          timeoutMs: READY_PROBE_MS,
          ...(step.signal ? { signal: step.signal } : {}),
          ...(step.guard ? { guard: step.guard } : {}),
        },
      );
      silent.delete(group.root);
      return true;
    } catch {
      step.guard?.();
      return false;
    }
  };

  const contentOf = (frameId: string): FrameContent => {
    const own = contents.get(frameId);
    if (own) return own;
    const group = groupOfFrame.get(frameId);
    if (!group || group.root === frameId) return "pending";
    return contents.get(group.root) ?? "pending";
  };

  return {
    async groups(step) {
      await bind(step);
      return [...groupList];
    },
    ownerChain(frameId) {
      const chainOf: OwnerBinding[] = [];
      let group = groupOfFrame.get(frameId);
      // One binding per group boundary: the frames inside a group are the
      // page's own work, which its own read folds in. Each step goes out to
      // the group around the last, so no chain holds more steps than there
      // are groups.
      for (
        let steps = 0;
        group?.owner && steps < groupList.length;
        steps += 1
      ) {
        chainOf.unshift(group.owner);
        const outer = frameOfPath.get(group.owner.group);
        group = outer === undefined ? undefined : groupOfFrame.get(outer);
      }
      return chainOf;
    },
    async focusedFrame(step) {
      await bind(step);
      let group = groupOfFrame.get(mainFrameId) ?? groupList[0];
      for (let hops = 0; group && hops <= READ_LIMITS.levels + 1; hops += 1) {
        const reply = await session.evaluateInFrame(
          group.root,
          "activeFrame",
          {},
          {
            deadline: step.deadline,
            namespace: "internal",
            ...(step.signal ? { signal: step.signal } : {}),
            ...(step.guard ? { guard: step.guard } : {}),
          },
        );
        const local = typeof reply.path === "string" ? reply.path : "";
        const path = prefixPath(group.path, local);
        const key = typeof reply.key === "string" ? reply.key : undefined;
        const held = key ?? frameOfPath.get(path);
        if (reply.blocked === true || (held && contentOf(held) === "blocked"))
          return {
            // A blocked frame is never bound, so the frame the walk stopped
            // at may only be known as the group it was reached from.
            frameId: held ?? group.root,
            path,
            blocked: true,
            editable: false,
          };
        const inside = key === undefined ? undefined : groupOfFrame.get(key);
        if (inside === undefined || inside.root !== key)
          return {
            frameId: held ?? group.root,
            path,
            blocked: false,
            editable: reply.editable === true,
          };
        group = inside;
      }
      return {
        frameId: group?.root ?? mainFrameId,
        path: group?.path ?? "",
        blocked: false,
        editable: false,
      };
    },
    bind,
    async read(step, run) {
      await bind(step);
      const from = step.from === undefined ? mainFrameId : step.from;
      const start = groupOfFrame.get(from) ?? groupList[0];
      const results: {
        group: GroupInfo;
        value: Awaited<ReturnType<typeof run>>;
      }[] = [];
      const unread: UnreadFrame[] = [];
      if (!start) return { results, unread };
      const until = Math.min(step.deadline, Date.now() + step.budgetMs);
      const perGroupMs = step.perGroupMs ?? READ_LIMITS.perGroupMs;
      const queue: GroupInfo[] = [start];
      const running = new Set<Promise<void>>();
      let planned = 0;
      let failure: unknown;
      const skip = (group: GroupInfo, content: FrameContent) => {
        contents.set(group.root, content);
        unread.push({
          frameId: group.root,
          local: group.owner?.local ?? group.path,
          content,
        });
      };
      const enqueue = (group: GroupInfo) => {
        if (
          group.level - start.level > READ_LIMITS.levels ||
          planned >= READ_LIMITS.groups
        ) {
          skip(group, "limit");
          return;
        }
        planned += 1;
        queue.push(group);
      };
      const readGroup = async (group: GroupInfo) => {
        if (unavailable.has(group.root)) {
          skip(group, "unavailable");
          return;
        }
        if (silentNow(group.root) && !(await wake(group, step))) {
          skip(group, "unavailable");
          return;
        }
        const bound = Math.min(perGroupMs, until - Date.now());
        if (bound <= 0) {
          skip(group, "pending");
          return;
        }
        try {
          const value = await withTimeout(run(group), bound);
          contents.set(group.root, "read");
          results.push({ group, value });
          for (const child of childGroups.get(group.root) ?? []) enqueue(child);
        } catch (error) {
          // The scope's own group fails the call it was asked for, so a
          // snapshot of a page that changed or stalled says so.
          if (group === start)
            throw error === TIMED_OUT
              ? new CdpTimeoutError("page", bound)
              : error;
          if (error === TIMED_OUT) {
            silent.set(group.root, Date.now() + SILENT_FOR_MS);
            skip(group, "unavailable");
            return;
          }
          if (
            error instanceof SessionLostError ||
            error instanceof PageCrashedError ||
            error instanceof TabClosedError ||
            error instanceof CdpTimeoutError
          )
            throw error;
          // A frame that loaded another document while it was read, or that
          // failed for its own reasons, is pending and read again next time.
          skip(
            group,
            error instanceof FrameBlockedError ? "blocked" : "pending",
          );
        }
      };
      while (queue.length || running.size) {
        // A caller that already has its answer leaves the groups it did not
        // need as they were: unread, and counted by nothing.
        if (step.stop?.()) {
          queue.length = 0;
          if (!running.size) break;
        }
        while (queue.length && running.size < READ_LIMITS.inFlight) {
          const group = queue.shift()!;
          const task = readGroup(group)
            .catch((error: unknown) => {
              failure ??= error;
            })
            .finally(() => {
              running.delete(task);
            });
          running.add(task);
        }
        if (running.size) await Promise.race([...running]);
      }
      if (failure !== undefined) throw failure;
      return { results, unread };
    },
    contentOf,
    pathOf: (frameId) => pathOfFrame.get(frameId),
    frameAt(path) {
      const frameId = frameOfPath.get(path);
      if (frameId === undefined) return undefined;
      const host = hosts.get(frameId);
      return {
        frameId,
        ...(host?.sessionId === undefined ? {} : { sessionId: host.sessionId }),
        ownSession: host?.ownSession === true,
      };
    },
    groupOf: (frameId) => groupOfFrame.get(frameId),
    setHome(ref, frameId, opens) {
      const loaderId = loaders.get(frameId);
      const group = groupOfFrame.get(frameId);
      if (loaderId === undefined || !group) return;
      refs.setHome(tabId, ref, {
        frameId,
        loaderId,
        group: group.path,
        ...(opens === undefined ? {} : { opens }),
      });
    },
    homeFrame(ref) {
      const home = refs.home(tabId, ref);
      if (!home) return undefined;
      const path = pathOfFrame.get(home.frameId);
      if (loaders.get(home.frameId) !== home.loaderId) {
        const frame = path ?? home.group;
        throw new ApiError(
          "stale_ref",
          "This element's frame changed. Take a new snapshot.",
          { ref, ...(frame ? { frame } : {}) },
        );
      }
      return {
        frameId: home.frameId,
        ...(path === undefined ? {} : { path }),
        group: home.group,
        ...(home.opens === undefined ? {} : { opens: home.opens }),
      };
    },
    dispose() {
      stopFrames();
      stopDetached();
      bindings.clear();
      loaders.clear();
      silent.clear();
      groupList = [];
      groupOfFrame.clear();
      childGroups.clear();
      pathOfFrame.clear();
      frameOfPath.clear();
      hosts.clear();
      contents.clear();
    },
  };

  function replace<K, V>(held: Map<K, V>, next: Map<K, V>): void {
    held.clear();
    for (const [key, value] of next) held.set(key, value);
  }
}

/** The page's work bounded, with its own promise left to settle alone. */
function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(TIMED_OUT), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

export interface FrameGroupsByTab {
  for(tabId: string): FrameGroups | undefined;
  dispose(): void;
}

/** One FrameGroups per live tab session, made beside it and disposed with it. */
export function createFrameGroupsByTab(deps: {
  sessions: TabSessions;
  refs: RefBook;
}): FrameGroupsByTab {
  const held = new Map<string, FrameGroups>();
  const stop = deps.sessions.onSession((session, tab) => {
    held.get(tab.id)?.dispose();
    const groups = createFrameGroups(session, {
      refs: deps.refs,
      tabId: tab.id,
    });
    held.set(tab.id, groups);
    session.on("closed", () => {
      if (held.get(tab.id) === groups) held.delete(tab.id);
      groups.dispose();
    });
  });
  return {
    for: (tabId) => held.get(tabId),
    dispose() {
      stop();
      for (const groups of held.values()) groups.dispose();
      held.clear();
    },
  };
}
