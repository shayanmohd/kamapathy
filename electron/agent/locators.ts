import {
  AX_RESET_MS,
  axSources,
  matchRole,
  readAx,
  resetAccessibility,
  type AxEntry,
} from "./accessibility";
import { ApiError } from "./errors";
import type { Resolver } from "./resolve";
import { parseSelector, roleWordFor, type SearchAst } from "./selectors";
import { CdpTimeoutError } from "./session/errors";
import { operationExpression } from "./session/operations";
import type { TabSession } from "./session/tab-session";
import type { Step } from "./session/types";

// A locator is a selector a snapshot proposes for one control, kept only
// when it resolves to that control alone. The candidates are built here
// from what the page reported about the control, and the page and the
// accessibility tree decide which of them stands.

/** How long one snapshot's locator pass may take. */
export const LOCATOR_BUDGET_MS = 1500;
/** The object group the pass holds the listed controls in. */
export const LOCATOR_GROUP = "kamapathy-locators";
// A locator value an agent can read and write back: short, and on one line.
const MAX_VALUE = 100;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const TEST_ID = ["data-testid", "data-test", "data-qa", "data-cy"] as const;
const NAMED = ["name", "aria-label", "placeholder"] as const;
const GENERATED_PREFIXES = [
  "react-",
  "radix-",
  "headlessui-",
  "mui-",
  "ember",
  "yui_",
  "ext-gen",
];

export interface LocatorSource {
  ref: string;
  tag: string;
  attributes: Partial<
    Record<(typeof TEST_ID)[number] | "id" | (typeof NAMED)[number], string>
  >;
  href?: string;
}
export interface Candidate {
  locator: string;
  kind: "css" | "role" | "href";
}

// An id a framework made, which the next render changes. A colon, three
// digits in a row, a long run mixing letters and digits, or a framework's
// own prefix.
export function generatedId(id: string): boolean {
  if (id.includes(":") || /\d{3}/.test(id)) return true;
  for (const run of id.match(/[A-Za-z0-9]{8,}/g) ?? [])
    if (/[A-Za-z]/.test(run) && /\d/.test(run)) return true;
  return GENERATED_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** A value as a double-quoted CSS string. */
export function cssString(value: string): string {
  return `"${value.replace(/[\\"]/g, (character) => `\\${character}`)}"`;
}

// A value as a CSS identifier, serialized as CSS.escape does: an escape
// reads to the end of a hexadecimal run, so an escaped code point is
// followed by a space.
export function cssIdentifier(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const code = value.charCodeAt(index);
    const digit = code >= 0x30 && code <= 0x39;
    if (code === 0) out += "\ufffd";
    else if (
      code <= 0x1f ||
      code === 0x7f ||
      (index === 0 && digit) ||
      (index === 1 && digit && value[0] === "-")
    )
      out += `\\${code.toString(16)} `;
    else if (index === 0 && character === "-" && value.length === 1)
      out += "\\-";
    else if (
      code >= 0x80 ||
      digit ||
      character === "-" ||
      character === "_" ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a)
    )
      out += character;
    else out += `\\${character}`;
  }
  return out;
}

const writable = (value: string | undefined): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_VALUE &&
  !CONTROL_CHARACTER.test(value);

// Where a link goes, as a locator says it: the path, query and hash on the
// page's own origin, and the whole address anywhere else.
function hrefValue(href: string, pageUrl: string): string | undefined {
  const read = (value: string) => {
    try {
      return new URL(value);
    } catch {
      return undefined;
    }
  };
  const link = read(href);
  if (!link) return undefined;
  const page = read(pageUrl);
  return page && link.origin !== "null" && link.origin === page.origin
    ? `${link.pathname}${link.search}${link.hash}`
    : link.href;
}

// The candidates for one control, in the order the first that resolves to
// it alone wins. Field values are never read, so nothing an agent types
// becomes part of a locator.
export function locatorCandidates(
  source: LocatorSource,
  pageUrl: string,
  role?: { word: string; name: string },
): Candidate[] {
  const candidates: Candidate[] = [];
  const css = (locator: string) =>
    candidates.push({ locator: `css=${locator}`, kind: "css" });
  for (const name of TEST_ID) {
    const value = source.attributes[name];
    if (writable(value)) css(`[${name}=${cssString(value)}]`);
  }
  const id = source.attributes.id;
  if (writable(id) && !generatedId(id)) css(`#${cssIdentifier(id)}`);
  if (role && /^[a-z]+$/.test(role.word) && writable(role.name))
    candidates.push({
      locator: `role=${role.word}[name=${JSON.stringify(role.name)}]`,
      kind: "role",
    });
  if (source.tag === "a" && source.href !== undefined) {
    const value = hrefValue(source.href, pageUrl);
    if (writable(value))
      candidates.push({ locator: `href=${value}`, kind: "href" });
  }
  const tag = cssIdentifier(source.tag);
  for (const name of NAMED) {
    const value = source.attributes[name];
    if (writable(value)) css(`${tag}[${name}=${cssString(value)}]`);
  }
  return candidates;
}

type Planned = {
  ref: string;
  entry?: AxEntry;
  candidates: (Candidate & { ast?: SearchAst })[];
};

// An accessibility node, keyed by the session that reported it: backend
// node ids are the renderer's own, so two renderers reuse them.
const nodeKey = (sessionId: string | undefined, backendNodeId: number) =>
  `${sessionId ?? ""}|${backendNodeId}`;

// A role candidate stands when its role and name name one node in every
// document read, and that node is the control's.
function alone(entries: readonly AxEntry[], entry: AxEntry): boolean {
  const word = entry.editableRoot ? "textbox" : roleWordFor(entry.role);
  const found = matchRole(entries, word, {
    value: entry.name,
    match: "exact",
  });
  const keys = new Set(
    found.map((match) =>
      nodeKey(match.entry.source.sessionId, match.entry.backendNodeId),
    ),
  );
  return (
    keys.size === 1 &&
    keys.has(nodeKey(entry.source.sessionId, entry.backendNodeId))
  );
}

// Only time ends a pass early. Everything else, such as a dialog, a page
// that changed or a person taking the tab back, is the request's answer.
const spent = (error: unknown) =>
  error instanceof CdpTimeoutError ||
  (error instanceof ApiError &&
    (error.code === "page_timeout" || error.code === "action_timeout"));

// The locator of each listed control, within one budget: the controls'
// elements, their backend nodes, the accessibility tree of every document
// this world reads, the candidates, and one page call that counts them.
export async function findLocators(input: {
  session: TabSession;
  resolver: Resolver;
  tabId: string;
  namespace: string;
  sources: readonly LocatorSource[];
  pageUrl: string;
  deadline: number;
  step: Step;
  budgetMs?: number;
}): Promise<{ locators: Map<string, string>; incomplete: boolean }> {
  const { session, resolver, tabId, namespace, sources, pageUrl, step } = input;
  const locators = new Map<string, string>();
  if (!sources.length) return { locators, incomplete: false };
  const end = Math.min(
    Date.now() + (input.budgetMs ?? LOCATOR_BUDGET_MS),
    input.deadline,
  );
  const budget: Step = { ...step, deadline: end };
  const at = (sessionId?: string) => ({
    sessionId,
    deadline: end,
    signal: step.signal,
    guard: step.guard,
    timeoutMs: Math.max(1, end - Date.now()),
  });
  let world: { sessionId?: string; contextId: number } | undefined;
  let queried: (string | undefined)[] | undefined;
  try {
    const frameId = await session.mainFrameId(budget);
    world = await session.world(frameId, budget);
    const held = await session.send<{ result?: { objectId?: string } }>(
      "Runtime.evaluate",
      {
        expression: operationExpression(
          "elements",
          { refs: sources.map((source) => source.ref) },
          namespace,
        ),
        contextId: world.contextId,
        returnByValue: false,
        objectGroup: LOCATOR_GROUP,
        silent: true,
      },
      at(world.sessionId),
    );
    const objectId = held.result?.objectId;
    if (objectId === undefined) return { locators, incomplete: false };
    const properties = await session.send<{
      result?: { name: string; value?: { objectId?: string } }[];
    }>(
      "Runtime.getProperties",
      { objectId, ownProperties: true },
      at(world.sessionId),
    );
    const objects = new Map<number, string>();
    for (const property of properties.result ?? []) {
      const index = Number(property.name);
      const id = property.value?.objectId;
      if (Number.isInteger(index) && id !== undefined) objects.set(index, id);
    }
    const owner = world.sessionId;
    const nodes = await Promise.all(
      sources.map(async (_source, index) => {
        const id = objects.get(index);
        if (id === undefined) return undefined;
        const described = await session.send<{
          node?: { backendNodeId?: number };
        }>("DOM.describeNode", { objectId: id }, at(owner));
        return described.node?.backendNodeId;
      }),
    );
    const axs = axSources(await session.knownFrames(budget), frameId);
    queried = [...new Set(axs.map((source) => source.sessionId))];
    const entries = await readAx(session, axs, budget);
    const byNode = new Map<string, AxEntry>();
    for (const entry of entries)
      byNode.set(nodeKey(entry.source.sessionId, entry.backendNodeId), entry);
    const plans: Planned[] = sources.map((source, index) => {
      const node = nodes[index];
      const entry =
        node === undefined ? undefined : byNode.get(nodeKey(owner, node));
      const role = entry
        ? {
            word: entry.editableRoot ? "textbox" : roleWordFor(entry.role),
            name: entry.name,
          }
        : undefined;
      // A candidate the grammar does not take could not be given to an
      // agent either.
      const candidates = locatorCandidates(source, pageUrl, role).flatMap(
        (candidate) => {
          if (candidate.kind === "role") return [candidate];
          const parsed = parseSelector(candidate.locator);
          return parsed.ok && parsed.ast.kind !== "ref"
            ? [{ ...candidate, ast: parsed.ast }]
            : [];
        },
      );
      return { ref: source.ref, ...(entry ? { entry } : {}), candidates };
    });
    const answer = await resolver.run(
      tabId,
      session,
      "validate",
      {
        checks: plans.map((plan) => ({
          ref: plan.ref,
          candidates: plan.candidates.flatMap((candidate) =>
            candidate.ast ? [candidate.ast] : [],
          ),
        })),
      },
      { deadline: end, namespace, signal: step.signal, guard: step.guard },
    );
    const counted = Array.isArray(answer.valid) ? answer.valid : [];
    for (const [index, plan] of plans.entries()) {
      const fromPage = (counted[index] ?? []) as unknown[];
      let at = 0;
      for (const candidate of plan.candidates) {
        const stands = candidate.ast
          ? fromPage[at++] === true
          : plan.entry !== undefined && alone(entries, plan.entry);
        if (stands) {
          locators.set(plan.ref, candidate.locator);
          break;
        }
      }
    }
    return { locators, incomplete: false };
  } catch (error) {
    if (!spent(error)) throw error;
    return { locators, incomplete: true };
  } finally {
    if (world)
      await session
        .send(
          "Runtime.releaseObjectGroup",
          { objectGroup: LOCATOR_GROUP },
          { sessionId: world.sessionId, deadline: Date.now() + AX_RESET_MS },
        )
        .catch(() => {});
    if (queried) await resetAccessibility(session, queried);
  }
}
