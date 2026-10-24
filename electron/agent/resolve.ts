import type { PageOperation } from "../automation-dom";
import {
  AX_RESET_MS,
  axSources,
  matchRole,
  readAx,
  resetAccessibility,
  type AxEntry,
} from "./accessibility";
import { remaining } from "./actions";
import type { PageStateOperation } from "./dom/page-state";
import type { Level, Mode, Query, WaitState } from "./dom/select";
import { CANDIDATE_REFS, REF_BLOCK, type RefBook } from "./refs";
import { FORMS, type NameMatch, type SearchAst } from "./selectors";
import type { TabSession } from "./session/tab-session";
import type { Step } from "./session/types";

// The one path for a page operation with targets: refs are classified
// before any page work, each query gets the action's level and its mode,
// role selectors are resolved through Chromium's accessibility tree into
// Kamapathy's world, and the refs the page assigned are recorded.

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

export interface RunOptions {
  deadline: number;
  namespace: string;
  signal?: AbortSignal;
  guard?: () => void;
  dispatch?: { dispatched: boolean };
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

export function createResolver(deps: { refs: RefBook }): Resolver {
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
      const roles: RoleTarget[] = [];
      for (const target of targets) {
        const query = target.query;
        const ast = query?.ast;
        if (!query || !ast) continue;
        query.level ??= LEVELS[operation] ?? "none";
        query.mode ??= "strict";
        if (query.mode === "strict") query.firstRef = reserve(CANDIDATE_REFS);
        if (ast.kind === "role")
          roles.push({
            query,
            role: ast.role,
            ...(ast.name === undefined ? {} : { name: ast.name }),
          });
      }
      if (operation === "snapshot") payload.firstRef = reserve(REF_BLOCK);
      const group = `kamapathy-pick-${++picks}`;
      // The sessions whose accessibility state this call woke, if any.
      let queried: (string | undefined)[] | undefined;
      try {
        const frameId = await session.mainFrameId(step);
        if (roles.length) {
          // Every role node of the call belongs to the world that owns the
          // top document and the frames it reads.
          const world = await session.world(frameId, step);
          const sources = axSources(await session.knownFrames(step), frameId);
          queried = [...new Set(sources.map((source) => source.sessionId))];
          const entries = await readAx(session, sources, step);
          for (const [index, role] of roles.entries()) {
            const key = `${group}-${index}`;
            await pick(
              session,
              world,
              group,
              key,
              matchRole(entries, role.role, role.name),
              step,
            );
            role.query.picked = key;
          }
        }
        const result = await session.evaluateInFrame(
          frameId,
          operation,
          payload,
          {
            deadline: options.deadline,
            signal: options.signal,
            guard: options.guard,
            dispatch: options.dispatch,
            namespace: options.namespace,
            timeoutMs: remaining(options.deadline),
          },
        );
        return result ? recordIssued(tabId, blocks, result, started) : result;
      } finally {
        if (queried) {
          await Promise.all(
            queried.map((sessionId) =>
              session
                .send(
                  "Runtime.releaseObjectGroup",
                  { objectGroup: group },
                  { sessionId, deadline: Date.now() + AX_RESET_MS },
                )
                .catch(() => {}),
            ),
          );
          await resetAccessibility(session, queried);
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
