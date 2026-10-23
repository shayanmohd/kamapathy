import { createHash } from "node:crypto";
import { cleanAgentText } from "../../shared/agent-text";
import { PAGE_BUDGET } from "../../shared/state";
import type { OpenedBy } from "../../shared/types";
import type { Actions } from "./actions";
import { fail } from "./errors";
import type { SearchAst } from "./selectors";
import type { AutomationController } from "./server";
import type { TabSession } from "./session/tab-session";
import type { Step } from "./session/types";

// The one snapshot path, shared by the routes and the batch step: the page
// call with its scope and bounds, the cursor that chains its parts, and the
// header naming the page, its space and the space's tabs.

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

export interface SnapshotRequest {
  mode: "compact" | "full";
  maxChars: number;
  maxControls: number;
  scope: "page" | "viewport";
  format: "list" | "outline";
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

export function createSnapshots(deps: {
  controller: AutomationController;
  evaluatePage: Actions["evaluatePage"];
}): {
  take(
    tabId: string,
    session: TabSession,
    request: SnapshotRequest,
    deadline: number,
    step: Step,
  ): Promise<Record<string, unknown>>;
} {
  const { controller, evaluatePage } = deps;
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
      // The resolver checks a root, reserves the ref block and adds it to
      // this copy of the payload, so the request keeps none of it.
      const result = await evaluatePage(
        tabId,
        session,
        "snapshot",
        {
          mode: request.mode,
          maxChars: request.maxChars,
          maxControls: request.maxControls,
          ...(request.selector === undefined
            ? {}
            : { selector: request.selector }),
          ...(request.query === undefined ? {} : { query: request.query }),
          ...(request.root === undefined ? {} : { root: request.root }),
          scope: request.scope,
          format: request.format,
          offsets: {
            text: state?.t ?? 0,
            control: state?.c ?? 0,
            line: state?.l ?? 0,
          },
        },
        deadline,
        step,
      );
      const url = typeof result.url === "string" ? result.url : "";
      // A URL change inside the same document shows only in the answer.
      if (state) checkCursorPage(state, { epoch: session.epoch, url });
      const next = nextCursor(result, { epoch: session.epoch, url }, hash);
      // The header is read after the page call, which checks the tab again.
      return {
        tabId,
        ...result,
        ...(next === undefined ? {} : { next }),
        ...(request.header
          ? { header: snapshotHeader(controller, tabId) }
          : {}),
      };
    },
  };
}
