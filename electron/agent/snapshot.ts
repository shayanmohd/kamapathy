import { createHash } from "node:crypto";
import { cleanAgentText } from "../../shared/agent-text";
import { extensionLabel } from "../../shared/extensions";
import { PAGE_BUDGET } from "../../shared/state";
import type { OpenedBy } from "../../shared/types";
import type { Actions } from "./actions";
import { fail } from "./errors";
import {
  NO_EXTENSION_NAMES,
  blockedFramesByPath,
  extensionFrame,
  type ExtensionNames,
} from "./extension-frames";
import {
  boundGroup,
  countUnread,
  mergeControls,
  nestOutline,
  orderReads,
  prefixPath,
  spliceText,
  type GroupRead,
  type OwnerPlaceholder,
} from "./frames/compose";
import { emptyArea, innerArea } from "./frames/geometry";
import {
  READ_LIMITS,
  type FrameContent,
  type FrameGroups,
  type FrameGroupsByTab,
  type GroupInfo,
} from "./frames/groups";
import { findLocators, type LocatorSource } from "./locators";
import type { Resolver } from "./resolve";
import type { SearchAst } from "./selectors";
import type { AutomationController } from "./server";
import type { TabSession } from "./session/tab-session";
import type { Step } from "./session/types";

// The one snapshot path, shared by the routes and the batch step: the read
// plan over the page's frame groups, the composition of what they report,
// the cursor that chains its parts, and the header naming the page, its
// space and the space's tabs.

// A cursor holds only where the next part starts, which document it was
// made on and which options it continues. Nothing of the page's content or
// the agent's selector travels in it.
export const CURSOR_PREFIX = "c1.";
export const MAX_CURSOR = 512;
export interface CursorState {
  e: number;
  u: string;
  t: number;
  c: number;
  l: number;
  h: string;
}
// The largest offset a cursor carries, by field.
const BOUNDS = { t: 10_000_000, c: 100_000, l: 1_000_000 };
const CURSOR_REFUSAL =
  "This cursor does not continue this snapshot. Ask for the snapshot again without a cursor.";

const hashOf = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url")
    .slice(0, 16);

/** The options a part may not change: the scope, what it is rooted at and the format. */
export function optionsHash(request: {
  scope: string;
  selector?: string;
  root?: string;
  format?: string;
}): string {
  return hashOf([
    request.scope,
    request.selector ?? null,
    request.root ?? null,
    request.format ?? "list",
  ]);
}
export function urlHash(url: string): string {
  return hashOf(url);
}
export function encodeCursor(state: CursorState): string {
  const { e, u, t, c, l, h } = state;
  return (
    CURSOR_PREFIX +
    Buffer.from(JSON.stringify({ e, u, t, c, l, h }), "utf8").toString(
      "base64url",
    )
  );
}
const isOffset = (value: unknown, maximum: number): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= maximum;
const isHash = (value: unknown): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= 32;

/** The part a cursor continues, or `invalid_cursor` for any other cursor. */
export function readCursor(
  cursor: string,
  expected: { h: string },
): CursorState {
  const refuse = () => fail("invalid_cursor", CURSOR_REFUSAL);
  if (!cursor.startsWith(CURSOR_PREFIX) || cursor.length > MAX_CURSOR)
    return refuse();
  // Node's base64url decoder drops characters it does not know, so the text
  // is checked before it is decoded.
  const encoded = cursor.slice(CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return refuse();
  let state: unknown;
  try {
    state = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return refuse();
  }
  if (!state || typeof state !== "object" || Array.isArray(state))
    return refuse();
  const { e, u, t, c, l, h } = state as Record<string, unknown>;
  if (
    !isOffset(e, Number.MAX_SAFE_INTEGER) ||
    !isHash(u) ||
    !isOffset(t, BOUNDS.t) ||
    !isOffset(c, BOUNDS.c) ||
    !isOffset(l, BOUNDS.l) ||
    !isHash(h) ||
    h !== expected.h
  )
    return refuse();
  return { e, u, t, c, l, h };
}
/** A cursor is good only on the document and URL that made it. */
export function checkCursorPage(
  state: CursorState,
  page: { epoch: number; url?: string },
): void {
  if (
    state.e !== page.epoch ||
    (page.url !== undefined && urlHash(page.url) !== state.u)
  )
    fail(
      "page_changed",
      "The page changed since this cursor's part. Take a snapshot again without a cursor.",
    );
}

export interface HeaderTab {
  id: string;
  label?: string;
  title: string;
  openedBy?: OpenedBy;
  managed: boolean;
  current?: true;
}
export interface SnapshotHeader {
  page: { id: string; label?: string; title: string };
  space: { id: string; name: string };
  tabs: HeaderTab[];
  budget?: { used: number; limit: number };
  pdf?: true;
}

/** A title in the header: cleaned like other agent text and cut at 60. */
export function headerTitle(title: string): string {
  const shown = cleanAgentText(title);
  return shown.length > 60 ? `${shown.slice(0, 57)}...` : shown;
}

// What the tabs route reports about this page and its space, and nothing
// else: no URLs, and the budget only once the space is near its limit.
export function snapshotHeader(
  controller: AutomationController,
  tabId: string,
): SnapshotHeader {
  const { tabs, spaces } = controller.state;
  const page = tabs.find((tab) => tab.id === tabId);
  const space = spaces.find((item) => item.id === page?.spaceId);
  if (!page || !space)
    return fail("tab_not_found", "Agent tab was not found.", { tabId });
  const limit = space.pageBudget ?? PAGE_BUDGET;
  const used = controller.registry.used(space.id);
  return {
    page: {
      id: page.id,
      ...(page.label === undefined ? {} : { label: page.label }),
      title: headerTitle(page.title),
    },
    space: { id: space.id, name: space.name },
    tabs: tabs
      .filter((tab) => tab.spaceId === space.id)
      .map((tab) => ({
        id: tab.id,
        ...(tab.label === undefined ? {} : { label: tab.label }),
        title: headerTitle(tab.title),
        ...(tab.openedBy === undefined ? {} : { openedBy: tab.openedBy }),
        managed: tab.managed === true,
        ...(tab.id === tabId ? { current: true as const } : {}),
      })),
    ...(used >= limit - 1 ? { budget: { used, limit } } : {}),
    ...(controller.pdfDocument?.(tabId) === true ? { pdf: true as const } : {}),
  };
}

// Each control line of an outline carries its locator at the end: an
// indented role word, an optional name, and the ref the locator belongs to.
const CONTROL_LINE = /^ *[a-z][a-z0-9-]*(?: "(?:[^"\\]|\\.)*")? (@e\d+)(?= |$)/;

/** The outline with each control's locator at the end of its line. */
export function appendLocators(
  outline: string,
  locators: ReadonlyMap<string, string>,
): string {
  if (!locators.size) return outline;
  return outline
    .split("\n")
    .map((line) => {
      const found = CONTROL_LINE.exec(line);
      if (!found) return line;
      const locator = locators.get(found[1]);
      return locator === undefined ? line : `${line} locator: ${locator}`;
    })
    .join("\n");
}

export interface SnapshotRequest {
  mode: "compact" | "full";
  maxChars: number;
  maxControls: number;
  scope: "page" | "viewport";
  format: "list" | "outline";
  locators: boolean;
  header: boolean;
  root?: string;
  selector?: string;
  query?: { ast: SearchAst };
  cursor?: string;
}

// Where the next part starts, as the page reported it, becomes the cursor an
// agent sends back. The offsets themselves never leave the main process.
function nextCursor(
  result: Record<string, unknown>,
  page: { epoch: number; url: string },
  h: string,
): string | undefined {
  const next = result.next;
  delete result.next;
  if (!next || typeof next !== "object" || Array.isArray(next))
    return undefined;
  const { text, control, line } = next as Record<string, unknown>;
  // An offset past what a cursor carries ends the parts; `truncated` still
  // reports that content was left out.
  if (
    !isOffset(text, BOUNDS.t) ||
    !isOffset(control, BOUNDS.c) ||
    !isOffset(line, BOUNDS.l)
  )
    return undefined;
  return encodeCursor({
    e: page.epoch,
    u: urlHash(page.url),
    t: text,
    c: control,
    l: line,
    h,
  });
}

/** What an `iframe` entry says about the frame it opens. */
export interface FrameEntryFields {
  origin?: string;
  contentFrame?: string;
  content: FrameContent;
  crossOrigin?: true;
}
/**
 * One frame group's read: what the composition needs, the group it belongs
 * to, and the page's own answer, which carries the URL, the locator sources
 * and the refs the read moved.
 */
export interface GroupSnapshot {
  read: GroupRead;
  group: GroupInfo;
  value: Record<string, unknown>;
}

// A page that reported no group read answered the whole listing itself, as
// a page read without a frame context does.
function groupReadOf(
  group: GroupInfo,
  value: unknown,
  owner?: OwnerPlaceholder,
): GroupRead | undefined {
  if (!value || typeof value !== "object") return undefined;
  const read = value as Record<string, unknown>;
  if (typeof read.group !== "string" || !Array.isArray(read.placeholders))
    return undefined;
  return {
    group: group.path,
    ...(owner === undefined ? {} : { owner }),
    text: Array.isArray(read.text) ? (read.text as GroupRead["text"]) : [],
    controls: Array.isArray(read.controls)
      ? (read.controls as GroupRead["controls"])
      : [],
    outline: Array.isArray(read.outline)
      ? (read.outline as GroupRead["outline"])
      : [],
    placeholders: read.placeholders as OwnerPlaceholder[],
    chars: typeof read.chars === "number" ? read.chars : 0,
    ...(read.truncated === true ? { truncated: true as const } : {}),
  };
}

/**
 * The reads the scope reaches: the group the scope sits in, and every group
 * whose owner a reached read left a placeholder for. A group read while its
 * owner's read failed, or one outside the scope, is left out.
 */
function reached(
  reads: readonly GroupSnapshot[],
  from: string,
): GroupSnapshot[] {
  const placed = new Set([from]);
  for (const read of orderReads(reads.map((item) => item.read)))
    if (placed.has(read.group))
      for (const placeholder of read.placeholders)
        placed.add(prefixPath(read.group, placeholder.local));
  return reads.filter((item) => placed.has(item.read.group));
}

const omittedOf = (value: Record<string, unknown>) =>
  typeof value.omittedControls === "number" ? value.omittedControls : 0;
// A frame's origin as an entry reports it: an http or https origin, or
// opaque for a sandboxed, data or blob document.
const webOrigin = (origin: string) =>
  /^https?:\/\/[^/]+$/.test(origin) ? origin : "opaque";

/**
 * The text, controls and outline of every reached group as one listing, cut
 * to the part the cursor asks for.
 */
function composeReads(
  reads: readonly GroupSnapshot[],
  request: SnapshotRequest,
  offsets: { text: number; control: number; line: number },
): Record<string, unknown> {
  // One character past the part's own budget, so the composition can see
  // that a group's text goes on and give the part after it a cursor.
  const list = reads.map(({ read }) =>
    boundGroup(read, offsets.text, request.maxChars + 1),
  );
  const cut = list.some((read) => read.truncated === true);
  const outline = request.format === "outline";
  const merged = mergeControls(list, {
    maxControls: outline ? Number.MAX_SAFE_INTEGER : request.maxControls,
    from: outline ? 0 : offsets.control,
  });
  // What each group's own bound left out, plus what the ranking across them
  // did not reach.
  const omitted =
    merged.omitted +
    reads.reduce((total, { value }) => total + omittedOf(value), 0);
  if (outline) {
    const nested = nestOutline(list, {
      maxChars: request.maxChars,
      from: offsets.line,
    });
    // A read keeps one line past its own budget, so a cut listing leaves a
    // line for the part after this one.
    const line =
      nested.next ??
      (cut ? offsets.line + nested.outline.length : undefined);
    // An outline lists the controls its lines printed.
    const printed = new Set(
      nested.outline.flatMap((line) => line.match(/@e\d+/g) ?? []),
    );
    const entries = merged.controls.filter(
      (entry) => typeof entry.ref === "string" && printed.has(entry.ref),
    );
    for (const [index, entry] of entries.entries())
      if (typeof entry.index === "number") entry.index = index;
    return {
      outline: nested.outline.join("\n"),
      interactables: entries,
      ...(omitted ? { omittedControls: omitted } : {}),
      ...(line === undefined ? {} : { next: { text: 0, control: 0, line } }),
      truncated: cut || nested.next !== undefined,
    };
  }
  const spliced = spliceText(list, {
    maxChars: request.maxChars,
    from: offsets.text,
  });
  // A bound of 0 cannot print its half of the page, so it never asks for it
  // again; truncated still reports that content was left out.
  const more =
    (spliced.next !== undefined && request.maxChars > 0) ||
    (merged.omitted > 0 && request.maxControls > 0);
  return {
    text: spliced.text,
    interactables: merged.controls,
    ...(omitted ? { omittedControls: omitted } : {}),
    ...(more
      ? {
          next: {
            text: spliced.next ?? spliced.chars,
            control: offsets.control + merged.controls.length,
            line: 0,
          },
        }
      : {}),
    truncated: cut || spliced.next !== undefined || omitted > 0,
  };
}

/**
 * Every ref the listing hands out gets its home frame, and every `iframe`
 * entry the frame it opens: its origin, the path its controls carry and
 * whether that frame was read. Only the main process knows these.
 */
function fillFrames(
  groups: FrameGroups,
  entries: readonly Record<string, unknown>[],
  blockedFrames: ReadonlyMap<string, BlockedFrame>,
): void {
  for (const entry of entries) {
    const frame = typeof entry.frame === "string" ? entry.frame : "";
    if (typeof entry.ref === "string")
      groups.setHome(entry.ref, groups.frameAt(frame)?.frameId ?? "");
    const content =
      typeof entry.contentFrame === "string" ? entry.contentFrame : undefined;
    if (content === undefined && entry.crossOrigin !== true) continue;
    // The binding key is the frame's own id; a frame the main process has
    // not bound is placed by its path alone.
    const key = typeof entry.key === "string" ? entry.key : undefined;
    const blocked = entry.blocked === true;
    delete entry.key;
    delete entry.blocked;
    const frameId =
      key ?? (content === undefined ? undefined : groups.frameAt(content)?.frameId);
    const state: FrameContent = blocked
      ? "blocked"
      : frameId === undefined
        ? "pending"
        : groups.contentOf(frameId);
    entry.content = state;
    if (state === "blocked") {
      // A frame of one of the person's extensions is named for them, as
      // section 17 says. Every other blocked frame stays a plain entry.
      const held =
        content === undefined ? undefined : blockedFrames.get(content);
      if (held?.extension !== undefined) {
        entry.extension = held.extension;
        entry.label = extensionLabel(held.extension);
      }
      // Section 8's cdp route refuses this entry's ref as the frame it opens.
      const opens = frameId ?? held?.frameId;
      if (typeof entry.ref === "string" && opens !== undefined)
        groups.setHome(entry.ref, groups.frameAt(frame)?.frameId ?? "", opens);
      delete entry.contentFrame;
      continue;
    }
    // Section 8's cdp route takes this entry's ref for the frame it opens.
    if (typeof entry.ref === "string" && frameId !== undefined)
      groups.setHome(entry.ref, groups.frameAt(frame)?.frameId ?? "", frameId);
    const origin = frameId === undefined ? undefined : groups.groupOf(frameId)?.origin;
    if (origin) entry.origin = webOrigin(origin);
  }
}

export function createSnapshots(deps: {
  controller: AutomationController;
  evaluatePage: Actions["evaluatePage"];
  resolver: Resolver;
  namespace: Actions["namespace"];
  frames: FrameGroupsByTab;
  /** Section 17's loaded extensions, which name the frames agents may not read. */
  extensions?: ExtensionNames;
}): {
  take(
    tabId: string,
    session: TabSession,
    request: SnapshotRequest,
    deadline: number,
    step: Step,
  ): Promise<Record<string, unknown>>;
} {
  const { controller, evaluatePage, resolver, namespace, frames } = deps;
  const extensions = deps.extensions ?? NO_EXTENSION_NAMES;
  return {
    async take(tabId, session, request, deadline, step) {
      const hash = optionsHash(request);
      // A cursor for another snapshot or an earlier document is answered
      // before any page work.
      const state =
        request.cursor === undefined
          ? undefined
          : readCursor(request.cursor, { h: hash });
      if (state) checkCursorPage(state, { epoch: session.epoch });
      const groups = frames.for(tabId);
      if (!groups)
        return fail(
          "debugger_busy",
          "Kamapathy lost its connection to this tab. Try again shortly.",
          { reason: "unavailable" },
        );
      const offsets = {
        text: state?.t ?? 0,
        control: state?.c ?? 0,
        line: state?.l ?? 0,
      };
      // The resolver checks a root, reserves the ref block and adds it to
      // this copy of the payload, so the request keeps none of it.
      const scoped = {
        ...(request.selector === undefined
          ? {}
          : { selector: request.selector }),
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.root === undefined ? {} : { root: request.root }),
      };
      // A root ref is read by the group whose world holds it, and goes
      // stale once that frame has loaded another document.
      const home =
        request.root === undefined
          ? undefined
          : groups.homeFrame(request.root)?.frameId;
      // The owner each group was found through, by the group's path.
      const owners = new Map<string, OwnerPlaceholder>();
      let start: GroupInfo | undefined;
      const plan = await groups.read(
        {
          deadline,
          ...(step.signal ? { signal: step.signal } : {}),
          ...(step.guard ? { guard: step.guard } : {}),
          budgetMs: Math.max(0, deadline - Date.now()),
          perGroupMs: READ_LIMITS.perGroupMs,
          ...(home === undefined ? {} : { from: home }),
        },
        async (group) => {
          start ??= group;
          const owner = owners.get(group.path);
          // scope viewport keeps to the part of the frame the person can
          // see, through every owner around it.
          const area =
            request.scope === "viewport" && owner?.area && owner.content
              ? innerArea(owner.area, [owner.content])
              : undefined;
          if (area && emptyArea(area)) return undefined;
          // Every group reads the page with the same bounds, and only the
          // group the scope sits in is given the scope itself; the
          // composition takes this part's slice of what they report.
          const value = await evaluatePage(
            tabId,
            session,
            "snapshot",
            {
              mode: request.mode,
              maxChars: request.maxChars,
              maxControls: request.maxControls,
              ...(group === start ? scoped : {}),
              scope: request.scope,
              format: request.format,
              ...(request.locators ? { locators: true } : {}),
              offsets,
              frameContext: {
                group: group.path,
                tier: owner?.tier ?? 0,
                ...(area ? { area } : {}),
              },
            },
            deadline,
            step,
            group.root,
          );
          // The groups inside this one are read next, each placed where its
          // owner sits.
          for (const placeholder of groupReadOf(group, value)?.placeholders ??
            [])
            owners.set(prefixPath(group.path, placeholder.local), placeholder);
          return value;
        },
      );
      const first = plan.results.find((item) => item.group === start);
      if (!first || !first.value)
        return fail("page_timeout", "The page did not respond in time.", {
          awaited: "page",
          timeoutMs: READ_LIMITS.perGroupMs,
        });
      const reads: GroupSnapshot[] = [];
      for (const { group, value } of plan.results) {
        const read = groupReadOf(group, value, owners.get(group.path));
        if (read && value)
          reads.push({ read, group, value: value as Record<string, unknown> });
      }
      const scope = reads.find((item) => item.group === start);
      // A root naming a frame from another origin scopes to that frame's
      // document: the read that found its owner is only the way in.
      const shell = scope?.value.frameScope === true;
      const kept = reached(reads, scope?.read.group ?? "").filter(
        (item) => !shell || item !== scope,
      );
      const result = scope
        ? composeReads(kept, request, offsets)
        : { ...(first.value as Record<string, unknown>) };
      if (scope) {
        // The page's own URL and title, never a frame's: a snapshot scoped
        // into a frame still reports the page it is part of.
        const top = reads.find((item) => item.group.path === "")?.value;
        const tab = controller.state.tabs.find((item) => item.id === tabId);
        result.url = top?.url ?? tab?.url ?? "";
        result.title = top?.title ?? tab?.title ?? "";
        const listed = result.interactables as Record<string, unknown>[];
        fillFrames(
          groups,
          listed,
          await blockedFramesOf(session, listed, extensions, step),
        );
        // Frames the reads left pending, unavailable or past a limit, their
        // entries listed or not.
        const blocked = new Set<string>();
        for (const { read } of kept)
          for (const placeholder of read.placeholders)
            if (placeholder.blocked)
              blocked.add(prefixPath(read.group, placeholder.local));
        const unread = countUnread(
          kept.map((item) => item.read),
          (frame) =>
            blocked.has(frame)
              ? "blocked"
              : groups.contentOf(groups.frameAt(frame)?.frameId ?? ""),
        );
        if (unread > 0) result.unreadFrames = unread;
        const rebound = kept.flatMap(({ value }) =>
          Array.isArray(value.rebound) ? (value.rebound as string[]) : [],
        );
        if (rebound.length) result.rebound = rebound;
      }
      const url = typeof result.url === "string" ? result.url : "";
      // A URL change inside the same document shows only in the answer.
      if (state) checkCursorPage(state, { epoch: session.epoch, url });
      const next = nextCursor(result, { epoch: session.epoch, url }, hash);
      // What a locator may be built from stays in the main process: the
      // response carries the locators themselves.
      const sources = scope
        ? kept.map(({ group, value }) => ({
            frameId: group.root,
            sources: takeSources(value),
          }))
        : [{ frameId: undefined, sources: takeSources(result) }];
      let incomplete = false;
      if (request.locators) {
        const locators = new Map<string, string>();
        for (const read of sources) {
          if (!read.sources.length) continue;
          const found = await findLocators({
            session,
            resolver,
            tabId,
            namespace: namespace(tabId, session),
            sources: read.sources,
            pageUrl: url,
            deadline,
            step,
            ...(read.frameId === undefined ? {} : { frameId: read.frameId }),
          });
          incomplete ||= found.incomplete;
          for (const [ref, locator] of found.locators) locators.set(ref, locator);
        }
        const listed = Array.isArray(result.interactables)
          ? result.interactables
          : [];
        for (const control of listed) {
          if (!control || typeof control !== "object") continue;
          const entry = control as Record<string, unknown>;
          const locator =
            typeof entry.ref === "string"
              ? locators.get(entry.ref)
              : undefined;
          if (locator !== undefined) entry.locator = locator;
        }
        if (typeof result.outline === "string")
          result.outline = appendLocators(result.outline, locators);
      }
      // The header is read after the page calls, which check the tab again.
      return {
        tabId,
        ...result,
        ...(next === undefined ? {} : { next }),
        ...(incomplete ? { locatorsIncomplete: true as const } : {}),
        ...(request.header
          ? { header: snapshotHeader(controller, tabId) }
          : {}),
      };
    },
  };
}

/** A blocked frame a listing names, and the extension it belongs to when it is one of the person's. */
type BlockedFrame = { frameId: string; extension?: string };
/**
 * Each blocked frame of a listing, by frame path. Only the registry holds
 * the URL a blocked frame committed, so the tab's frames are read once, and
 * only for a listing that has such an entry.
 */
async function blockedFramesOf(
  session: TabSession,
  entries: readonly Record<string, unknown>[],
  names: ExtensionNames,
  step: Step,
): Promise<ReadonlyMap<string, BlockedFrame>> {
  const found = new Map<string, BlockedFrame>();
  if (!entries.some((entry) => entry.blocked === true)) return found;
  const frames = await blockedFramesByPath(session, step).catch(
    () => undefined,
  );
  for (const [path, { frameId, url }] of frames ?? []) {
    const extension = extensionFrame(url, names);
    found.set(path, {
      frameId,
      ...(extension ? { extension: extension.name } : {}),
    });
  }
  return found;
}

// The locator sources a read reported, taken out of its answer.
function takeSources(value: Record<string, unknown>): LocatorSource[] {
  const sources = value.locatorSources;
  delete value.locatorSources;
  return Array.isArray(sources) ? (sources as LocatorSource[]) : [];
}
