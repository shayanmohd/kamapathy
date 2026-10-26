import type { FrameContext, PageOperation } from "../automation-dom";
import {
  AX_RESET_MS,
  axSources,
  matchRole,
  readAx,
  resetAccessibility,
  type AxEntry,
  type AxSource,
} from "./accessibility";
import { remaining } from "./actions";
import type { PageStateOperation } from "./dom/page-state";
import type { Level, Mode, Query, Tally, WaitState } from "./dom/select";
import { comparePaths } from "./frames/compose";
import {
  READ_LIMITS,
  WAIT_GROUP_MS,
  type FrameGroups,
  type FrameGroupsByTab,
  type GroupInfo,
} from "./frames/groups";
import { CANDIDATE_REFS, REF_BLOCK, type RefBook } from "./refs";
import { FORMS, type NameMatch, type SearchAst } from "./selectors";
import type { TabSession } from "./session/tab-session";
import type { KnownFrame, Step } from "./session/types";

// The one path for a page operation with targets: refs are classified
// before any page work, each query gets the action's level and its mode,
// role selectors are resolved through Chromium's accessibility tree into
// Kamapathy's world, and the refs the page assigned are recorded. Section
// 9's search puts one layer around it: a ref goes to the frame that issued
// it, and a selector covers the whole page, the top document first and then
// each frame group in owner order.

/** The level each operation's strict matching counts candidates at. */
export const LEVELS: Readonly<
  Partial<Record<PageOperation | PageStateOperation, Level>>
> = {
  target: "pointer-enabled",
  click: "pointer-enabled",
  drag: "pointer",
  focus: "enabled",
  fill: "enabled",
  scroll: "visible",
  check: "visible",
  snapshot: "none",
  upload: "none",
};

// A wait's mode and level: raw CSS and XPath take the first match, every
// other form must name one element, and a wait for something gone counts
// every match.
export function waitMode(
  ast: SearchAst,
  state: WaitState,
): { mode: Mode; level: Level } {
  if (state === "hidden") return { mode: "count", level: "visible" };
  if (state === "detached") return { mode: "count", level: "none" };
  const first = (ast.kind === "css" && ast.raw) || ast.kind === "xpath";
  return {
    mode: first ? "first" : "strict",
    level: state === "visible" ? "visible" : "none",
  };
}

/** The groups one search reached, and the frames it left out of the attempt. */
export interface FrameSearch {
  groups: GroupInfo[];
  unreadFrames: number;
}
/** What a search does in one group: the operation itself, or a read of it. */
export interface GroupSearchDeps {
  frames: FrameGroups;
  /** Runs the operation itself in one group's world, at a local nth. */
  run(
    group: GroupInfo,
    context: FrameContext,
    nth?: number,
  ): Promise<Record<string, unknown>>;
  /** Reads what one group holds for the query, without acting in it. */
  probe(group: GroupInfo, context: FrameContext): Promise<Tally | undefined>;
}
/** The query a search covers: its mode and level, its nth and its text. */
export interface SearchQuery {
  mode: Mode;
  level: Level;
  nth?: number;
  selector?: string;
}

// The blockers that say a match does not pass the level, which is what the
// spec calls holding nothing at the level: the search goes on to the frames.
const LEVEL_BLOCKERS: readonly string[] = ["hidden", "disabled", "covered"];

/** Whether one group's answer holds a candidate at the query's level. */
export function atLevel(result: Record<string, unknown>): boolean {
  if (result.matched === false) return false;
  const blocked = result.blocked as { blocker?: unknown } | undefined;
  if (
    blocked &&
    typeof blocked.blocker === "string" &&
    LEVEL_BLOCKERS.includes(blocked.blocker)
  )
    return false;
  if (result.ok !== false) return true;
  return result.code !== "no_match" && result.code !== "element_obscured";
}

type Answer =
  | { kind: "run"; value: Record<string, unknown> }
  | { kind: "tally"; value?: Tally };
type Held = { group: GroupInfo; tally: Tally };

const countOf = (tally: Tally | undefined) => tally?.count ?? 0;
const numberOf = (value: unknown) => (typeof value === "number" ? value : 0);

/**
 * One attempt across the page's frame groups: the top document decides for
 * strict and first while it holds a candidate at the level, a count sums
 * every document, and an nth counts them document by document in owner
 * order. Only the group the search picks runs the operation itself.
 */
export async function searchGroups(
  deps: GroupSearchDeps,
  query: SearchQuery | undefined,
  step: Step & { budgetMs: number; perGroupMs?: number },
): Promise<{ decision: Record<string, unknown>; unreadFrames: number }> {
  const { frames } = deps;
  const context = (group: GroupInfo): FrameContext => ({
    group: group.path,
    tier: 0,
  });
  const counting = query?.mode === "count";
  const indexed = query?.nth !== undefined;
  let start: GroupInfo | undefined;
  let settled: Record<string, unknown> | undefined;
  const plan = await frames.read<Answer>(
    // The page's own group answers first and alone, so a group the search
    // no longer needs is never read at all.
    { ...step, stop: () => settled !== undefined },
    async (group) => {
      const own = context(group);
      if (start === undefined) {
        start = group;
        if (!indexed) {
          const value = await deps.run(group, own);
          if (!counting && atLevel(value)) settled = value;
          return { kind: "run", value };
        }
      }
      if (counting || !query)
        return { kind: "run", value: await deps.run(group, own) };
      return { kind: "tally", value: await deps.probe(group, own) };
    },
  );
  const answers = new Map<GroupInfo, Answer>(
    plan.results.map((item) => [item.group, item.value]),
  );
  // What this attempt reached: the groups that answered, in document order,
  // and the frames it was left without.
  const reached: FrameSearch = {
    groups: plan.results
      .map((item) => item.group)
      .sort((first, second) => comparePaths(first.path, second.path)),
    unreadFrames: plan.unread.filter((frame) => frame.content !== "blocked")
      .length,
  };
  const unreadFrames = reached.unreadFrames;
  const begun = start === undefined ? undefined : answers.get(start);
  const own = begun?.kind === "run" ? begun.value : undefined;
  if (settled) return { decision: settled, unreadFrames };
  // A count and the text of a wait read every group and answer together.
  if (counting || !query) {
    const runs = reached.groups.flatMap((group) => {
      const answer = answers.get(group);
      return answer?.kind === "run" ? [answer.value] : [];
    });
    const refused = runs.find((value) => value.ok === false);
    if (refused) return { decision: refused, unreadFrames };
    const matched = runs.filter((value) => value.matched === true);
    if (!counting)
      return {
        decision: matched[0] ?? own ?? { ok: true, matched: false },
        unreadFrames,
      };
    let count = 0;
    let visible = 0;
    for (const value of runs) {
      const counts = (value.counts ?? {}) as Record<string, unknown>;
      count += numberOf(counts.matched);
      visible += numberOf(counts.visible);
    }
    return {
      decision: {
        ok: true,
        matched: runs.length > 0 && matched.length === runs.length,
        counts: { matched: count, visible },
      },
      unreadFrames,
    };
  }
  const held: Held[] = reached.groups.flatMap((group) => {
    const answer = answers.get(group);
    return answer?.kind === "tally" && countOf(answer.value) > 0
      ? [{ group, tally: answer.value! }]
      : [];
  });
  // An nth counts the documents in owner order and resolves to one of them.
  if (indexed && start) {
    const total = held.reduce((sum, item) => sum + item.tally.count, 0);
    const nth = query.nth!;
    let index = nth < 0 ? total + nth : nth;
    for (const item of held) {
      if (index >= 0 && index < item.tally.count)
        return {
          decision: await deps.run(item.group, context(item.group), index),
          unreadFrames,
        };
      index -= item.tally.count;
    }
    // Past every document: the page's own answer names the selector.
    return { decision: await deps.run(start, context(start)), unreadFrames };
  }
  const strong = held.filter((item) => item.tally.actionable > 0);
  // strict counts all frame documents together: candidates in two of them
  // are ambiguous, and no ref can be given out without acting in one.
  if (query.mode === "strict" && strong.length > 1) {
    const total = { count: 0, visible: 0, hidden: 0, actionable: 0 };
    for (const item of held) {
      total.count += item.tally.count;
      total.visible += item.tally.visible;
      total.hidden += item.tally.hidden;
      total.actionable += item.tally.actionable;
    }
    return {
      decision: {
        ok: false,
        code: "ambiguous_match",
        error: `Selector matched ${total.count} elements (${total.visible} visible, ${total.hidden} hidden) in ${strong.length} frames. Take a snapshot and use a ref from the frame you mean.`,
        fields: {
          ...(query.selector === undefined ? {} : { selector: query.selector }),
          ...total,
          candidates: [],
        },
      },
      unreadFrames,
    };
  }
  const picked = strong[0] ?? held[0];
  if (!picked)
    return { decision: own ?? { ok: true, matched: false }, unreadFrames };
  return {
    decision: await deps.run(picked.group, context(picked.group)),
    unreadFrames,
  };
}

export interface RunOptions {
  deadline: number;
  namespace: string;
  signal?: AbortSignal;
  guard?: () => void;
  dispatch?: { dispatched: boolean };
  /** The frame whose world runs the operation, instead of the main frame. */
  frameId?: string;
}
export interface Resolver {
  run(
    tabId: string,
    session: TabSession,
    operation: PageOperation | PageStateOperation,
    payload: Record<string, unknown>,
    options: RunOptions,
  ): Promise<Record<string, unknown>>;
}

type Incoming = Partial<Query> & { ast?: SearchAst };
type Target = { ref?: unknown; selector?: unknown; query?: Incoming };
type RoleTarget = { query: Incoming; role: string; name?: NameMatch };
type World = { sessionId?: string; contextId: number };
type Match = { entry: AxEntry; editable: boolean };

// Keeps the picked nodes the operation about to run asked for, without
// touching them: the page checks each one against its own walk first.
const PICK = `function(key, flags, ...nodes){const store = globalThis.__kamapathyPicked || (globalThis.__kamapathyPicked = new Map()); store.set(key, nodes.map((node, i) => ({ node, editable: flags[i] === 1 }))); while (store.size > 16) store.delete(store.keys().next().value); return nodes.length}`;
// A group and key per call, so a wait and a click running together in one
// space never share them.
let picks = 0;

const isTarget = (value: unknown): value is Target =>
  !!value &&
  typeof value === "object" &&
  ("ref" in value || "selector" in value || "query" in value);
// The targets of an operation: the payload itself, a drag's ends, and a
// snapshot root, which is a ref.
const targetsOf = (payload: Record<string, unknown>): Target[] => {
  const targets: Target[] = [];
  if (isTarget(payload)) targets.push(payload);
  for (const part of [payload.source, payload.target])
    if (isTarget(part)) targets.push(part);
  if (typeof payload.root === "string") targets.push({ ref: payload.root });
  return targets;
};
// The same search without its nth, so a group can count every match it
// holds before the index is resolved across the documents.
const withoutNth = (ast: SearchAst): SearchAst => {
  const copy = { ...ast } as SearchAst & { nth?: number };
  delete copy.nth;
  return copy;
};

/**
 * Where a role read looks for one group's nodes: the group's own root
 * document, read in its own session or by its frame id, and then the frames
 * inside it that its world reads.
 */
export function axSourcesFor(
  known: readonly KnownFrame[],
  rootId: string,
): AxSource[] {
  const sources = axSources(known, rootId);
  const root = known.find((frame) => frame.frameId === rootId);
  if (!root || root.parentFrameId === undefined) return sources;
  const held = root.sessionId;
  const own: AxSource =
    root.ownSession && held !== undefined
      ? { sessionId: held }
      : {
          frameId: rootId,
          ...(held === undefined ? {} : { sessionId: held }),
        };
  return sources.map((source, index) =>
    index === 0
      ? own
      : held === undefined
        ? source
        : { ...source, sessionId: held },
  );
}

export function createResolver(deps: {
  refs: RefBook;
  frames?: FrameGroupsByTab;
}): Resolver {
  const { refs } = deps;
  // The numbers the page may hand out in this call, and nothing else.
  const recordIssued = (
    tabId: string,
    blocks: readonly [number, number][],
    result: Record<string, unknown>,
    started: number,
  ) => {
    const issued = Array.isArray(result.issued) ? result.issued : [];
    refs.record(
      tabId,
      issued.filter(
        (number): number is number =>
          typeof number === "number" &&
          blocks.some(([first, end]) => number >= first && number < end),
      ),
    );
    delete result.issued;
    if (result.ok === false) {
      const fields = (result.fields ?? {}) as Record<string, unknown>;
      if (result.code === "invalid_selector")
        result.fields = { ...fields, forms: FORMS };
      else if (result.code === "no_match")
        result.fields = { ...fields, waitedMs: Date.now() - started };
    }
    return result;
  };
  // The frames an attempt left out, where its answer can carry them: a
  // resolution failure, a check a wait reads, and a blocker the action loop
  // waits out and reports at its deadline.
  const attachUnread = (
    result: Record<string, unknown>,
    unread: number,
    operation: PageOperation | PageStateOperation,
  ) => {
    if (unread <= 0) return result;
    if (
      result.ok === false &&
      (result.code === "no_match" || result.code === "ambiguous_match")
    ) {
      const fields = (result.fields ?? {}) as Record<string, unknown>;
      result.fields = { ...fields, unreadFrames: unread };
    }
    const blocked = result.blocked;
    if (blocked && typeof blocked === "object" && !Array.isArray(blocked))
      (blocked as Record<string, unknown>).unreadFrames = unread;
    if (operation === "check" && result.ok !== false)
      result.unreadFrames = unread;
    return result;
  };

  return {
    async run(tabId, session, operation, payload, options) {
      const started = Date.now();
      const step: Step = {
        deadline: options.deadline,
        signal: options.signal,
        guard: options.guard,
      };
      const targets = targetsOf(payload);
      // A ref outside every range the tab was issued, or one its refs
      // retired, is answered here, before anything reaches the page.
      for (const target of targets)
        if (typeof target.ref === "string") refs.check(tabId, target.ref);
      const blocks: [number, number][] = [];
      const reserve = (count: number) => {
        const first = refs.reserve(count);
        blocks.push([first, first + count]);
        return first;
      };
      for (const target of targets) {
        const query = target.query;
        const ast = query?.ast;
        if (!query || !ast) continue;
        query.level ??= LEVELS[operation] ?? "none";
        query.mode ??= "strict";
        if (query.mode === "strict") query.firstRef = reserve(CANDIDATE_REFS);
      }
      if (operation === "snapshot") payload.firstRef = reserve(REF_BLOCK);
      const objectGroup = `kamapathy-pick-${++picks}`;
      // The sessions whose accessibility state this call woke, if any.
      const queried = new Set<string | undefined>();
      let keys = 0;
      const frames = deps.frames?.for(tabId);
      // The role nodes one world holds for a body's queries, left in it
      // under keys of their own.
      const pickRoles = async (
        frameId: string,
        body: Record<string, unknown>,
      ) => {
        const roles: RoleTarget[] = [];
        for (const target of targetsOf(body)) {
          const query = target.query;
          const ast = query?.ast;
          if (query && ast?.kind === "role")
            roles.push({
              query,
              role: ast.role,
              ...(ast.name === undefined ? {} : { name: ast.name }),
            });
        }
        if (!roles.length) return;
        // Every role node of a group belongs to the world that reads it.
        const world = await session.world(frameId, step);
        const sources = axSourcesFor(await session.knownFrames(step), frameId);
        for (const source of sources) queried.add(source.sessionId);
        const entries = await readAx(session, sources, step);
        for (const role of roles) {
          const key = `${objectGroup}-${keys++}`;
          await pick(
            session,
            world,
            objectGroup,
            key,
            matchRole(entries, role.role, role.name),
            step,
          );
          role.query.picked = key;
        }
      };
      const evaluate = (
        frameId: string,
        page: PageOperation | PageStateOperation,
        body: Record<string, unknown>,
      ) =>
        session.evaluateInFrame(frameId, page, body, {
          deadline: options.deadline,
          signal: options.signal,
          guard: options.guard,
          dispatch: options.dispatch,
          namespace: options.namespace,
          timeoutMs: remaining(options.deadline),
        });
      try {
        // The payload one group reads: the page's own group reads it as it
        // stands, and a frame group gets its own ref block and its context.
        const target =
          targets.length === 1 && targets[0] === payload
            ? targets[0]
            : undefined;
        const query = target?.query;
        const bodyOf = (
          context: FrameContext | undefined,
          nth?: number,
        ): Record<string, unknown> => {
          if (context === undefined && nth === undefined) return payload;
          const body: Record<string, unknown> = {
            ...payload,
            ...(context ? { frameContext: context } : {}),
          };
          const incoming = body.query as Incoming | undefined;
          if (incoming) {
            const copy: Incoming = { ...incoming };
            if (context && copy.mode === "strict")
              copy.firstRef = reserve(CANDIDATE_REFS);
            if (nth !== undefined && copy.ast)
              copy.ast = { ...withoutNth(copy.ast), nth } as SearchAst;
            body.query = copy;
          }
          return body;
        };
        const runGroup = async (
          group: GroupInfo,
          context: FrameContext,
          nth?: number,
        ) => {
          const body = bodyOf(group.path === "" ? undefined : context, nth);
          await pickRoles(group.root, body);
          const answer = await evaluate(group.root, operation, body);
          // The candidates a group named live in that group's own world, so
          // a ref from them goes back to it and never searches again.
          const issued = Array.isArray(answer?.issued) ? answer.issued : [];
          for (const number of issued)
            if (typeof number === "number")
              frames?.setHome(`@e${number}`, group.root);
          return answer;
        };
        // What a group holds, read without acting in it: the engine's own
        // tally of the query at this operation's level.
        const probeGroup = async (
          group: GroupInfo,
          context: FrameContext,
        ): Promise<Tally | undefined> => {
          const ast = query?.ast;
          if (!ast) return undefined;
          const body: Record<string, unknown> = {
            ...(typeof target?.selector === "string"
              ? { selector: target.selector }
              : {}),
            query: {
              ast: withoutNth(ast),
              mode: "count",
              level: query?.level ?? "none",
            },
            tally: true,
            ...(group.path === "" ? {} : { frameContext: context }),
          };
          await pickRoles(group.root, body);
          const answer = await evaluate(group.root, "check", body);
          const held = answer?.tally;
          return held && typeof held === "object"
            ? (held as unknown as Tally)
            : undefined;
        };
        // A ref never searches: it goes to the frame that issued it, which
        // answers stale once that frame has loaded another document.
        let home: string | undefined;
        if (options.frameId === undefined && frames) {
          const homes = new Set<string>();
          let bound = false;
          for (const item of targets) {
            const ref = item.ref;
            if (typeof ref !== "string" || !refs.home(tabId, ref)) continue;
            if (!bound) {
              await frames.bind(step);
              bound = true;
            }
            const found = frames.homeFrame(ref);
            if (found) homes.add(found.frameId);
          }
          // Two ends in two frames keep today's one world; section 10 takes
          // them apart.
          if (homes.size === 1) home = [...homes][0];
        }
        let result: Record<string, unknown> | undefined;
        let unread = 0;
        // A selector covers the whole page, and so does the text a wait
        // looks for: each frame group reads its own document.
        const searchable =
          options.frameId === undefined &&
          home === undefined &&
          frames !== undefined &&
          !targets.some((item) => typeof item.ref === "string") &&
          (query?.ast !== undefined ||
            (operation === "check" && typeof payload.text === "string"));
        if (searchable && frames) {
          const groups = await frames.groups(step);
          if (groups.length > 1) {
            const ast = query?.ast;
            const search = await searchGroups(
              { frames, run: runGroup, probe: probeGroup },
              ast === undefined
                ? undefined
                : {
                    mode: query?.mode ?? "strict",
                    level: query?.level ?? "none",
                    ...(ast.nth === undefined ? {} : { nth: ast.nth }),
                    ...(typeof target?.selector === "string"
                      ? { selector: target.selector }
                      : {}),
                  },
              {
                ...step,
                budgetMs: Math.max(0, options.deadline - Date.now()),
                perGroupMs:
                  operation === "check"
                    ? WAIT_GROUP_MS
                    : READ_LIMITS.perGroupMs,
              },
            );
            result = search.decision;
            unread = search.unreadFrames;
          }
        }
        if (!result) {
          const frameId =
            options.frameId ?? home ?? (await session.mainFrameId(step));
          const path = home === undefined ? undefined : frames?.pathOf(home);
          const body = bodyOf(
            path === undefined || path === ""
              ? undefined
              : { group: path, tier: 0 },
          );
          await pickRoles(frameId, body);
          result = await evaluate(frameId, operation, body);
        }
        return result
          ? attachUnread(
              recordIssued(tabId, blocks, result, started),
              unread,
              operation,
            )
          : result;
      } finally {
        if (queried.size) {
          await Promise.all(
            [...queried].map((sessionId) =>
              session
                .send(
                  "Runtime.releaseObjectGroup",
                  { objectGroup },
                  { sessionId, deadline: Date.now() + AX_RESET_MS },
                )
                .catch(() => {}),
            ),
          );
          await resetAccessibility(session, [...queried]);
        }
      }
    },
  };
}

// Resolves each match into the world and leaves the nodes there under key.
// The call goes out even with nothing to leave, so an operation can tell an
// empty resolution from a world that was made again.
async function pick(
  session: TabSession,
  world: World,
  group: string,
  key: string,
  matches: readonly Match[],
  step: Step,
): Promise<void> {
  const at = (sessionId?: string) => ({
    sessionId,
    deadline: step.deadline,
    signal: step.signal,
    guard: step.guard,
  });
  const resolved = await Promise.all(
    matches.map(async (match) => {
      try {
        const reply = await session.send<{ object?: { objectId?: string } }>(
          "DOM.resolveNode",
          {
            backendNodeId: match.entry.backendNodeId,
            executionContextId: world.contextId,
            objectGroup: group,
          },
          at(match.entry.source.sessionId),
        );
        const objectId = reply.object?.objectId;
        return objectId === undefined
          ? undefined
          : { objectId, editable: match.editable };
      } catch (error) {
        // The node left the page between the read and the resolve.
        if (
          error instanceof Error &&
          /No node with given id found/.test(error.message)
        )
          return undefined;
        throw error;
      }
    }),
  );
  const nodes = resolved.filter((node) => node !== undefined);
  await session.send(
    "Runtime.callFunctionOn",
    {
      executionContextId: world.contextId,
      functionDeclaration: PICK,
      arguments: [
        { value: key },
        { value: nodes.map((node) => (node.editable ? 1 : 0)) },
        ...nodes.map(({ objectId }) => ({ objectId })),
      ],
      returnByValue: true,
      silent: true,
    },
    at(world.sessionId),
  );
}
