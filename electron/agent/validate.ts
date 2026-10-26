import {
  AGENT_TEXT_LIMITS,
  cleanAgentText,
  type AgentTextField,
} from "../../shared/agent-text";
import {
  AGENT_URL_LIMIT,
  agentUrlHint,
  isAgentUrl,
  isWebUrl,
} from "../../shared/url";
import {
  ACTIONS,
  API_LEVEL,
  checkBody,
} from "../../skills/kamapathy/scripts/schema/index.mjs";
import { MAX_PROMPT_TEXT, type DialogPolicyInput } from "./dialogs";
import type { FetchStart } from "./dom/fetch";
import { MAX_INPUT_FILES } from "./dom/files";
import type { WaitState } from "./dom/select";
import { WAIT_POLL_MS } from "./downloads";
import { ApiError, fail } from "./errors";
import { requireScripts, scriptFields, type ScriptSource } from "./evaluate";
import { EXPECTATION_EVENTS, type ExpectationEvent } from "./expectations";
import type { Route } from "./http";
import type {
  DragAction,
  FieldAction,
  FieldKind,
  KeyboardAction,
  KeyboardKind,
  MouseAction,
  MouseKind,
  PointerAction,
  PointerKind,
  PressAction,
  SelectChoice,
} from "./input/actions";
import { MAX_CHORD_CHARS, parseChord } from "./input/keys";
import type { Button } from "./input/state";
import { WAIT_UNTIL, type WaitUntil } from "./navigation/await";
import { MAX_GLOB, compileUrlGlob } from "./navigation/url-glob";
import type { UrlWaitBody } from "./navigation/waits";
import {
  MAX_SELECTOR,
  parseSelector,
  selectorError,
  type SearchAst,
} from "./selectors";
import type { AutomationController } from "./server";
import { MAX_CURSOR } from "./snapshot";

export const UPLOAD_FILE_LIMIT = 16 * 1024 * 1024;
export type ToolAction = {
  type:
    | "snapshot"
    | "click"
    | "dblclick"
    | "hover"
    | "fill"
    | "select"
    | "press"
    | "scroll"
    | "drag"
    | "mouse-click"
    | "wait"
    | "navigate"
    | "reload"
    | "wait-for-url"
    | "wait-for-load-state"
    | "wait-for-selector"
    | "wait-for-function";
  payload: Record<string, unknown>;
  // The step's cleaned label; only the batch loop reads it.
  label?: string;
};

export function integerField(
  body: Record<string, unknown>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = body[name] === undefined ? fallback : body[name];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  )
    return fail(
      "invalid_field",
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  return value;
}
export function booleanField(
  body: Record<string, unknown>,
  name: string,
  fallback: boolean,
): boolean {
  const value = body[name] === undefined ? fallback : body[name];
  if (typeof value !== "boolean")
    return fail("invalid_field", `${name} must be true or false.`, {
      field: name,
    });
  return value;
}
// The schema's wording for a list of accepted values.
const either = (values: readonly string[]) =>
  values.length < 3
    ? values.join(" or ")
    : `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
export function enumField<T extends string>(
  body: Record<string, unknown>,
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = body[name] === undefined ? fallback : body[name];
  if (typeof value !== "string" || !values.includes(value as T))
    return fail("invalid_field", `${name} must be ${either(values)}.`, {
      field: name,
    });
  return value as T;
}
export function waitUntilField(
  body: Record<string, unknown>,
  fallback: WaitUntil = "load",
): WaitUntil {
  return enumField(body, "waitUntil", WAIT_UNTIL, fallback);
}
// The Referer header an agent may send, kept exactly as given.
export function refererField(body: Record<string, unknown>): string {
  const value = stringField(body, "referer", 8192);
  if (!isWebUrl(value))
    return fail(
      "invalid_field",
      "referer must be a complete HTTP or HTTPS URL without embedded credentials.",
      { field: "referer" },
    );
  return value;
}
export function navigationFields(body: Record<string, unknown>): {
  url: string;
  waitUntil: WaitUntil;
  timeoutMs: number;
  referer?: string;
} {
  return {
    url: urlField(body),
    waitUntil: waitUntilField(body),
    timeoutMs: integerField(body, "timeoutMs", 15000, 1, 60000),
    ...(body.referer === undefined ? {} : { referer: refererField(body) }),
  };
}
export function reloadFields(body: Record<string, unknown>): {
  waitUntil: WaitUntil;
  timeoutMs: number;
  ignoreCache: boolean;
} {
  return {
    waitUntil: waitUntilField(body),
    timeoutMs: integerField(body, "timeoutMs", 15000, 1, 60000),
    ignoreCache: booleanField(body, "ignoreCache", false),
  };
}
// The URL wait serves two modes: a glob to match, or a navigation count to
// watch from. One body never asks for both.
export function waitForUrlFields(body: Record<string, unknown>): UrlWaitBody {
  const hasGlob = body.url !== undefined;
  const watching = body.after !== undefined;
  if (hasGlob && watching)
    return fail(
      "invalid_field",
      "Give url to match a glob, or after to watch this page's commits, not both.",
      { field: "after" },
    );
  if (!hasGlob && body.waitUntil !== undefined)
    return fail(
      "invalid_field",
      "waitUntil needs a url to match. Watching commits returns as soon as one arrives.",
      { field: "waitUntil" },
    );
  return {
    ...(hasGlob
      ? { glob: compileUrlGlob(stringField(body, "url", MAX_GLOB), "url") }
      : {}),
    waitUntil: waitUntilField(body),
    ...(watching
      ? { after: integerField(body, "after", 0, 0, 2147483647) }
      : {}),
    timeoutMs: integerField(body, "timeoutMs", 10000, 0, 60000),
  };
}
// The load-state wait takes navigate's states, with the quiet window
// networkidle asks for.
export function loadStateFields(body: Record<string, unknown>): {
  state: WaitUntil;
  idleMs: number;
  timeoutMs: number;
} {
  return {
    state: enumField(body, "state", WAIT_UNTIL, "load"),
    idleMs: integerField(body, "idleMs", 500, 0, 10000),
    timeoutMs: integerField(body, "timeoutMs", 10000, 0, 60000),
  };
}
/** The four states a selector wait judges a page's matches against. */
export const WAIT_STATES: readonly WaitState[] = [
  "attached",
  "visible",
  "hidden",
  "detached",
];
// The selector wait takes any target of section 4 beside the state it waits
// for.
export function waitForSelectorFields(body: Record<string, unknown>): {
  target: TargetPayload;
  state: WaitState;
  selector: string;
  timeoutMs: number;
} {
  const target = targetFields(body) as TargetPayload;
  return {
    target,
    state: enumField(body, "state", WAIT_STATES, "visible"),
    // The text the answer and the timeout echo: a ref names itself.
    selector: "ref" in target ? target.ref : target.selector,
    timeoutMs: integerField(body, "timeoutMs", 10000, 0, 60000),
  };
}
// Section 8's evaluate takes the page script fields, which the Page scripts
// setting gates, with a timeout the page keeps a margin of.
export function evaluateFields(
  body: Record<string, unknown>,
): ScriptSource & { timeoutMs: number } {
  return {
    ...scriptFields(body),
    timeoutMs: integerField(body, "timeoutMs", 15000, 2000, 60000),
  };
}
// Section 8's fetch takes the Fetch standard's own option names, plus the
// timeout and the stream flag of the route.
export interface FetchRequest extends FetchStart {
  timeoutMs: number;
  stream: boolean;
}
// Headers the browser sets itself. A request that names one is refused, so
// nothing an agent sent is dropped silently.
export const FORBIDDEN_HEADERS: readonly string[] = [
  "accept-charset",
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
];
const FORBIDDEN_PREFIXES = ["proxy-", "sec-"];
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FETCH_URL_EXPECTED =
  "a complete HTTP or HTTPS URL without credentials, a URL relative to the page, or a blob: URL of the page's own origin";
const origin = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};
// What the page may fetch: its own relative URLs, any http or https URL, or
// a blob: URL its own origin made.
function fetchUrlField(body: Record<string, unknown>, tabUrl: string): string {
  const value = stringField(body, "url", 8192);
  const refuse = (): never => fail("invalid_url", `Use ${FETCH_URL_EXPECTED}.`);
  let resolved: URL;
  try {
    resolved = new URL(value, tabUrl);
  } catch {
    return refuse();
  }
  if (isWebUrl(resolved.href)) return resolved.href;
  // A blob: URL carries the origin that made it in its path.
  if (
    resolved.protocol === "blob:" &&
    isWebUrl(resolved.pathname) &&
    origin(resolved.pathname) === origin(tabUrl)
  )
    return resolved.href;
  return refuse();
}
function fetchHeaderField(body: Record<string, unknown>): [string, string][] {
  const value = body.headers;
  if (value === undefined) return [];
  const refuse = (expected: string): never =>
    fail("invalid_field", `headers must be ${expected}.`, {
      field: "headers",
      expected,
    });
  const shape = "an object of header names and string values";
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return refuse(shape);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) return refuse("an object of at most 64 headers");
  const headers: [string, string][] = [];
  for (const [name, item] of entries) {
    if (
      !HEADER_NAME.test(name) ||
      typeof item !== "string" ||
      item.length > 8192 ||
      /[\r\n\u0000]/.test(item)
    )
      return refuse(shape);
    const lower = name.toLowerCase();
    if (
      FORBIDDEN_HEADERS.includes(lower) ||
      FORBIDDEN_PREFIXES.some((prefix) => lower.startsWith(prefix))
    )
      return refuse(
        `a header the Fetch standard allows (${name} is set by the browser)`,
      );
    headers.push([name, item]);
  }
  return headers;
}
const optionalEnum = <T extends string>(
  body: Record<string, unknown>,
  name: string,
  values: readonly T[],
): T | undefined =>
  body[name] === undefined
    ? undefined
    : enumField(body, name, values, values[0]);

export function fetchFields(
  body: Record<string, unknown>,
  tabUrl: string,
): FetchRequest {
  const stream = booleanField(body, "stream", false);
  const timeoutMs = integerField(body, "timeoutMs", 20000, 1000, 300000);
  // The schema declares the longest a saved body may take, so admission
  // reserves it; only a stream may ask for more than a minute.
  if (timeoutMs > 60000 && !stream) {
    const expected = "1000 to 60000 ms, or up to 300000 with saveAs";
    return fail("invalid_field", `timeoutMs must be ${expected}.`, {
      field: "timeoutMs",
      expected,
    });
  }
  const method =
    body.method === undefined ? "GET" : stringField(body, "method", 32);
  if (!HEADER_NAME.test(method))
    return fail("invalid_field", "method must be a method name.", {
      field: "method",
    });
  if (["CONNECT", "TRACE", "TRACK"].includes(method.toUpperCase()))
    return fail(
      "invalid_field",
      `method must be a method the Fetch standard allows (${method.toUpperCase()} is not).`,
      { field: "method", expected: "a method the Fetch standard allows" },
    );
  const sent =
    body.body === undefined
      ? undefined
      : stringField(body, "body", 524288, true);
  if (sent !== undefined && ["GET", "HEAD"].includes(method.toUpperCase()))
    return fail(
      "invalid_field",
      `method ${method.toUpperCase()} takes no body. Use POST, PUT or PATCH to send one.`,
      { field: "body" },
    );
  const referrer =
    body.referrer === undefined
      ? undefined
      : stringField(body, "referrer", 8192, true);
  const integrity =
    body.integrity === undefined
      ? undefined
      : stringField(body, "integrity", 256);
  const cache = optionalEnum(body, "cache", [
    "default",
    "no-store",
    "reload",
    "no-cache",
    "force-cache",
    "only-if-cached",
  ] as const);
  const credentials = optionalEnum(body, "credentials", [
    "omit",
    "same-origin",
    "include",
  ] as const);
  const redirect = optionalEnum(body, "redirect", [
    "follow",
    "error",
    "manual",
  ] as const);
  const referrerPolicy = optionalEnum(body, "referrerPolicy", [
    "",
    "no-referrer",
    "no-referrer-when-downgrade",
    "same-origin",
    "origin",
    "strict-origin",
    "origin-when-cross-origin",
    "strict-origin-when-cross-origin",
    "unsafe-url",
  ] as const);
  return {
    url: fetchUrlField(body, tabUrl),
    method,
    headers: fetchHeaderField(body),
    mode: enumField(
      body,
      "mode",
      ["cors", "no-cors", "same-origin"] as const,
      "cors",
    ),
    timeoutMs,
    stream,
    ...(sent === undefined ? {} : { body: sent }),
    ...(cache === undefined ? {} : { cache }),
    ...(credentials === undefined ? {} : { credentials }),
    ...(integrity === undefined ? {} : { integrity }),
    ...(body.keepalive === undefined
      ? {}
      : { keepalive: booleanField(body, "keepalive", false) }),
    ...(redirect === undefined ? {} : { redirect }),
    ...(referrer === undefined ? {} : { referrer }),
    ...(referrerPolicy === undefined ? {} : { referrerPolicy }),
  };
}
// The function wait takes the page script fields, which the Page scripts
// setting gates, plus how often it looks.
export function waitForFunctionFields(body: Record<string, unknown>): {
  source: ScriptSource;
  intervalMs: number;
  timeoutMs: number;
} {
  return {
    source: scriptFields(body),
    intervalMs: integerField(body, "intervalMs", 100, 10, 10000),
    timeoutMs: integerField(body, "timeoutMs", 10000, 0, 60000),
  };
}
// The one ref form, in the field that carries it.
function refField(body: Record<string, unknown>, name: string): string {
  const ref = stringField(body, name, 32);
  if (!/^@e[1-9]\d*$/.test(ref))
    return fail(
      "invalid_ref",
      "Use an element reference from a snapshot, such as @e1.",
    );
  return ref;
}
/** A target as the page receives it: a ref, or a selector beside its AST. */
export type TargetPayload =
  | { ref: string }
  | { selector: string; query: { ast: SearchAst } };

export function targetFields(
  body: Record<string, unknown>,
  optional = false,
): TargetPayload | Record<string, never> {
  const hasRef = body.ref !== undefined,
    hasSelector = body.selector !== undefined;
  if (!hasRef && !hasSelector && optional) return {};
  if (hasRef === hasSelector)
    return fail(
      "invalid_target",
      "Provide exactly one of ref or selector.",
    );
  if (hasRef) return { ref: refField(body, "ref") };
  // The grammar is parsed here, so a selector reaches the page only as an
  // AST. A ref written as a selector is the ref.
  const selector = stringField(body, "selector", MAX_SELECTOR);
  const parsed = parseSelector(selector);
  if (!parsed.ok) throw selectorError(selector, parsed.problem);
  return parsed.ast.kind === "ref"
    ? { ref: parsed.ast.ref }
    : { selector, query: { ast: parsed.ast } };
}
/** The mouse buttons an agent may press. */
export const BUTTONS: readonly Button[] = ["left", "middle", "right"];
// A point inside an element, measured from its border box's top left. The
// schema has already refused a wrong shape; this reads it back.
export function positionField(
  body: Record<string, unknown>,
  name: string,
): { x: number; y: number } | undefined {
  const value = body[name];
  if (value === undefined) return undefined;
  const expected = "an object with x and y, each a number from -10000 to 10000";
  const refuse = (): never =>
    fail("invalid_field", `${name} must be ${expected}.`, {
      field: name,
      expected,
    });
  if (!value || typeof value !== "object" || Array.isArray(value))
    return refuse();
  const point = value as Record<string, unknown>;
  const axis = (key: "x" | "y") => {
    const number = point[key];
    if (
      typeof number !== "number" ||
      !Number.isFinite(number) ||
      Math.abs(number) > 10000
    )
      return refuse();
    return number;
  };
  return { x: axis("x"), y: axis("y") };
}
// The fields click, dblclick and hover share. Each kind reads only the ones
// its route declares, so the schema and this never disagree.
export function pointerFields(
  body: Record<string, unknown>,
  kind: PointerKind,
): PointerAction {
  const position = positionField(body, "position");
  return {
    kind,
    target: targetFields(body) as TargetPayload,
    button:
      kind === "hover" ? "left" : enumField(body, "button", BUTTONS, "left"),
    clickCount:
      kind === "click"
        ? integerField(body, "clickCount", 1, 1, 3)
        : kind === "dblclick"
          ? 2
          : 1,
    delayMs: kind === "hover" ? 0 : integerField(body, "delayMs", 0, 0, 5000),
    ...(position === undefined ? {} : { position }),
    force: booleanField(body, "force", false),
    timeoutMs: integerField(body, "timeoutMs", 3000, 0, 60000),
  };
}
// The most choices one select route takes.
const MAX_CHOICES = 100;
// The options a select route chooses: strings, or objects naming a value, a
// label or an index. Every field an object carries has to match, so an empty
// object names nothing and is refused here, before any page work.
export function selectValues(body: Record<string, unknown>): SelectChoice[] {
  const expected = `an array of at most ${MAX_CHOICES} choices, each a string or an object with value, label or index`;
  const refuse = (): never =>
    fail("invalid_field", `values must be ${expected}.`, {
      field: "values",
      expected,
    });
  const list = body.values;
  if (!Array.isArray(list) || list.length > MAX_CHOICES) return refuse();
  return list.map((entry) => {
    if (typeof entry === "string") return entry;
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return refuse();
    const given = entry as Record<string, unknown>;
    const choice: { value?: string; label?: string; index?: number } = {};
    for (const [key, value] of Object.entries(given)) {
      if (value === undefined) continue;
      if (key === "value" || key === "label") {
        if (typeof value !== "string") return refuse();
        choice[key] = value;
      } else if (key === "index") {
        if (!Number.isInteger(value) || (value as number) < 0) return refuse();
        choice.index = value as number;
      } else return refuse();
    }
    if (Object.keys(choice).length === 0) return refuse();
    return choice;
  });
}
// The fields fill, select and focus share. Each kind reads only the ones its
// route declares, so the schema and this never disagree.
export function fieldFields(
  body: Record<string, unknown>,
  kind: FieldKind,
): FieldAction {
  return {
    kind,
    target: targetFields(body) as TargetPayload,
    ...(kind === "fill"
      ? {
          value: stringField(body, "value", 16384, true),
          append: booleanField(body, "append", false),
        }
      : {}),
    ...(kind === "select" ? { values: selectValues(body) } : {}),
    timeoutMs: integerField(body, "timeoutMs", 3000, 0, 60000),
  };
}
// press takes any key name, printable character or chord, and focuses an
// optional target first. The chord is parsed here, so an unknown name is
// refused before the lane.
export function pressFields(body: Record<string, unknown>): PressAction {
  const key = stringField(body, "key", MAX_CHORD_CHARS);
  parseChord(key);
  const target = targetFields(body, true);
  return {
    key,
    ...("ref" in target || "selector" in target
      ? { target: target as TargetPayload }
      : {}),
    delayMs: integerField(body, "delayMs", 0, 0, 5000),
    timeoutMs: integerField(body, "timeoutMs", 3000, 0, 60000),
  };
}
// The farthest a point or a wheel delta may lie from the origin. The page's
// own viewport decides whether a point is inside it; this only keeps a
// nonsense number out of the page.
const MAX_PIXELS = 10000;
// A point or a delta as a number, which may be fractional. The schema has
// already refused a wrong shape; this reads it back.
function pixelField(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  const expected = `a number from -${MAX_PIXELS} to ${MAX_PIXELS}`;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    Math.abs(value) > MAX_PIXELS
  )
    return fail("invalid_field", `${name} must be ${expected}.`, {
      field: name,
      expected,
    });
  return value;
}
// The fields the raw mouse routes take. Each kind reads only the ones its
// route declares, so the schema and this never disagree.
export function mouseFields(
  body: Record<string, unknown>,
  kind: MouseKind,
): MouseAction {
  const press = kind !== "move" && kind !== "wheel";
  return {
    kind,
    ...(kind === "move" || kind === "click"
      ? { x: pixelField(body, "x"), y: pixelField(body, "y") }
      : {}),
    ...(kind === "wheel"
      ? {
          deltaX: pixelField(body, "deltaX"),
          deltaY: pixelField(body, "deltaY"),
        }
      : {}),
    steps: kind === "move" ? integerField(body, "steps", 1, 1, 100) : 1,
    button: press ? enumField(body, "button", BUTTONS, "left") : "left",
    clickCount: press ? integerField(body, "clickCount", 1, 1, 3) : 1,
    delayMs: kind === "click" ? integerField(body, "delayMs", 0, 0, 5000) : 0,
  };
}

// The most text one type route sends, one insertion takes, and the gaps a
// type may spend in all.
const MAX_TYPE_TEXT = 2000;
const MAX_INSERT_TEXT = 16384;
const MAX_TYPE_GAPS_MS = 60000;
// The raw keyboard routes: one key to hold or let go, or the text to type or
// insert. One key means one key, so a chord is refused here.
export function keyboardFields(
  body: Record<string, unknown>,
  kind: KeyboardKind,
): KeyboardAction {
  if (kind === "paste") return { kind, ...pasteFields(body), delayMs: 0 };
  if (kind === "down" || kind === "up") {
    const key = stringField(body, "key", MAX_CHORD_CHARS);
    if (parseChord(key).tokens.length > 1)
      return fail(
        "invalid_field",
        "key must name one key, not a chord. Hold each modifier with keyboard/down.",
        { field: "key", expected: "one key name or printable character" },
      );
    return { kind, key, delayMs: 0 };
  }
  const text = stringField(
    body,
    "text",
    kind === "type" ? MAX_TYPE_TEXT : MAX_INSERT_TEXT,
    true,
  );
  const delayMs =
    kind === "type" ? integerField(body, "delayMs", 0, 0, 1000) : 0;
  if (delayMs * text.length > MAX_TYPE_GAPS_MS)
    return fail(
      "invalid_field",
      `delayMs times the text length must be at most ${MAX_TYPE_GAPS_MS} ms.`,
      { field: "delayMs", expected: `a delay that fits ${MAX_TYPE_GAPS_MS} ms` },
    );
  return { kind, text, delayMs };
}
// The most a paste carries of each flavour. The route's own 192 KiB body
// limit leaves room for both, escaped.
const MAX_PASTE_TEXT = 16384;
const MAX_PASTE_HTML = 32768;
// What one paste offers the page. Empty text means something only beside
// html, since a paste of nothing at all is a mistake, not a request.
export function pasteFields(body: Record<string, unknown>): {
  text: string;
  html?: string;
} {
  const text = stringField(body, "text", MAX_PASTE_TEXT, true);
  const html =
    body.html === undefined
      ? undefined
      : stringField(body, "html", MAX_PASTE_HTML, true);
  if (!text && html === undefined)
    return fail("invalid_field", "text may be empty only when html is given.", {
      field: "text",
      expected: "the text to paste",
    });
  return { text, ...(html === undefined ? {} : { html }) };
}
// A drag's two ends and the options the gesture takes. Both ends resolve
// like any other target, each with its own position.
export function dragFields(body: Record<string, unknown>): DragAction {
  const endpoint = (name: "source" | "target") => {
    const value = body[name];
    if (!value || typeof value !== "object" || Array.isArray(value))
      return fail(
        "invalid_target",
        `${name} must be an object with a ref or selector.`,
      );
    return targetFields(value as Record<string, unknown>) as TargetPayload;
  };
  const source = endpoint("source");
  const target = endpoint("target");
  const sourcePosition = positionField(body, "sourcePosition");
  const targetPosition = positionField(body, "targetPosition");
  return {
    source,
    target,
    ...(sourcePosition === undefined ? {} : { sourcePosition }),
    ...(targetPosition === undefined ? {} : { targetPosition }),
    button: enumField(body, "button", BUTTONS, "left"),
    force: booleanField(body, "force", false),
    timeoutMs: integerField(body, "timeoutMs", 3000, 0, 60000),
  };
}
// The one grammar check that runs before the request waits for its lane, so
// a malformed selector costs no page work, no activity and no batch step.
export function checkSelectors(
  route: Route,
  body: Record<string, unknown> | undefined,
): void {
  if (!body) return;
  const check = (value: unknown, index?: number) => {
    if (typeof value !== "string") return;
    const parsed = parseSelector(value);
    if (!parsed.ok) throw selectorError(value, parsed.problem, index);
  };
  const targets = (step: Record<string, unknown>, index?: number) => {
    check(step.selector, index);
    for (const end of [step.source, step.target])
      if (end && typeof end === "object" && !Array.isArray(end))
        check((end as Record<string, unknown>).selector, index);
  };
  if (route.key !== "POST /tabs/:id/actions") {
    targets(body);
    return;
  }
  if (!Array.isArray(body.actions)) return;
  for (const [index, step] of body.actions.entries())
    if (step && typeof step === "object" && !Array.isArray(step))
      targets(step as Record<string, unknown>, index);
}
function parseAction(
  type: string,
  body: Record<string, unknown>,
  // A batch validates its whole plan first, so a step the Page scripts
  // setting gates is refused there, before the first action runs. The wait
  // itself checks the setting again when it runs.
  deps?: { controller: AutomationController },
): ToolAction {
  if (type === "snapshot") {
    const mode = body.mode ?? "compact";
    if (mode !== "compact" && mode !== "full")
      return fail("invalid_field", "mode must be compact or full.");
    const maxChars = integerField(
      body,
      "maxChars",
      mode === "compact" ? 4000 : 24000,
      0,
      24000,
    );
    const maxControls = integerField(
      body,
      "maxControls",
      mode === "compact" ? 40 : 100,
      0,
      100,
    );
    const scope = body.scope ?? "page";
    if (scope !== "page" && scope !== "viewport")
      return fail("invalid_field", "scope must be page or viewport.");
    const format = body.format ?? "list";
    if (format !== "list" && format !== "outline")
      return fail("invalid_field", "format must be list or outline.");
    const locators = body.locators ?? false;
    if (typeof locators !== "boolean")
      return fail("invalid_field", "locators must be true or false.");
    const header = body.header ?? true;
    if (typeof header !== "boolean")
      return fail("invalid_field", "header must be true or false.");
    if (body.root !== undefined && body.selector !== undefined)
      return fail(
        "invalid_field",
        "root and selector cannot be combined. Give one of them.",
        { field: "root", expected: "a ref, without selector" },
      );
    // A ref written as the selector is the root it names.
    const scoped =
      body.root === undefined
        ? targetFields(body, true)
        : { ref: refField(body, "root") };
    const options: Record<string, unknown> = {
      mode,
      maxChars,
      maxControls,
      ...("selector" in scoped
        ? { selector: scoped.selector, query: scoped.query }
        : {}),
      ...("ref" in scoped ? { root: scoped.ref } : {}),
      scope,
      format,
      locators,
      header,
      // The part to continue. The snapshot path reads what it carries.
      ...(body.cursor === undefined
        ? {}
        : { cursor: stringField(body, "cursor", MAX_CURSOR) }),
    };
    return { type, payload: options };
  }
  if (type === "click" || type === "dblclick" || type === "hover")
    return {
      type,
      payload: pointerFields(body, type) as unknown as Record<string, unknown>,
    };
  if (type === "fill" || type === "select")
    return {
      type,
      payload: fieldFields(body, type) as unknown as Record<string, unknown>,
    };
  if (type === "press")
    return {
      type,
      payload: pressFields(body) as unknown as Record<string, unknown>,
    };
  if (type === "scroll") {
    const direction = stringField(body, "direction", 5);
    if (!["up", "down", "left", "right"].includes(direction))
      return fail(
        "invalid_field",
        "direction must be up, down, left, or right.",
      );
    return {
      type,
      payload: {
        direction,
        pixels: integerField(body, "pixels", 600, 1, 2000),
        ...targetFields(body, true),
      },
    };
  }
  if (type === "drag")
    return {
      type,
      payload: dragFields(body) as unknown as Record<string, unknown>,
    };
  if (type === "mouse-click")
    return {
      type,
      payload: mouseFields(body, "click") as unknown as Record<
        string,
        unknown
      >,
    };
  if (type === "navigate") return { type, payload: navigationFields(body) };
  if (type === "reload") return { type, payload: reloadFields(body) };
  if (type === "wait-for-url") {
    const fields = waitForUrlFields(body);
    // A step matches a glob; watching commits belongs to the route, which a
    // client loop calls with its own matcher.
    if (!fields.glob)
      return fail("invalid_field", "A wait-for-url step needs a url glob.", {
        field: "url",
      });
    return { type, payload: { ...fields } };
  }
  if (type === "wait-for-load-state")
    return { type, payload: loadStateFields(body) };
  if (type === "wait-for-selector")
    return { type, payload: { ...waitForSelectorFields(body) } };
  if (type === "wait-for-function") {
    if (deps) requireScripts(deps.controller);
    return { type, payload: { ...waitForFunctionFields(body) } };
  }
  if (type === "wait")
    return {
      type,
      payload: {
        timeoutMs: integerField(body, "timeoutMs", 5000, 0, 15000),
        ...targetFields(body, true),
        ...(body.text !== undefined
          ? { text: stringField(body, "text", 1000) }
          : {}),
      },
    };
  const types = ACTIONS.map((action) => action.type);
  return fail(
    "invalid_action",
    `Batch actions support ${types.slice(0, -1).join(", ")}, and ${types.at(-1)}.`,
  );
}

// A step, with the label its own route or batch entry may carry.
export function parseToolAction(
  type: string,
  body: Record<string, unknown>,
  deps?: { controller: AutomationController },
): ToolAction {
  const action = parseAction(type, body, deps);
  return body.label === undefined
    ? action
    : { ...action, label: agentTextField(body, "label", "label") };
}

// Rejects a body with a field its route does not declare, or a declared
// field of the wrong kind, before the request waits for its lane.
export function validateBody(
  route: Route,
  body: Record<string, unknown> | undefined,
): void {
  const problem = checkBody(route.schema, body);
  if (problem)
    throw new ApiError(
      problem.code,
      problem.message,
      problem.code === "unknown_field"
        ? { ...problem.fields, route: route.key, apiLevel: API_LEVEL }
        : problem.fields,
    );
  checkSelectors(route, body);
}

// Checks every agent label a body carries, including each batch step's,
// before the request waits for its lane. The schema has already refused a
// label where no field declares one, so only the cleaning rule is left.
export function checkAgentText(
  route: Route,
  body: Record<string, unknown> | undefined,
): void {
  if (!body) return;
  if (route.schema.label && body.label !== undefined)
    agentTextField(body, "label", "label");
  const steps =
    route.schema.body?.actions?.of === "action" ? body.actions : undefined;
  if (!Array.isArray(steps)) return;
  for (const [index, step] of steps.entries()) {
    const fields = (step ?? {}) as Record<string, unknown>;
    if (fields.label !== undefined)
      agentTextField(fields, "label", "label", { index });
  }
}

// The cleaned label of a single input route's body, or undefined.
export function bodyLabel(
  route: Route,
  body: Record<string, unknown> | undefined,
): string | undefined {
  if (!route.schema.label || body?.label === undefined) return undefined;
  return agentTextField(body, "label", "label");
}

// The segment after /spaces or /tabs is shown as :id.
export function routeNotFound(
  method: string,
  path: string,
  version: string,
): ApiError {
  const route = path
    .replace(/^\/(spaces|tabs)\/[^/]+/, "/$1/:id")
    .slice(0, 200);
  return new ApiError(
    "route_not_found",
    `Kamapathy ${version} (API level ${API_LEVEL}) has no route ${method} ${route}. A newer client may need a newer Kamapathy.`,
    { method, route, apiLevel: API_LEVEL, version },
  );
}

export function stringField(
  body: Record<string, unknown>,
  key: string,
  max: number,
  empty = false,
): string {
  const value = body[key];
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max
  )
    return fail(
      "invalid_field",
      `${key} must be ${empty ? "a" : "a nonempty"} string of at most ${max} characters.`,
    );
  return value;
}
// Text an agent wrote for the person to read. The raw length is checked
// against its limit before cleaning, so nothing is silently trimmed, and an
// empty result is refused unless an empty value means something to the route.
export function agentTextField(
  body: Record<string, unknown>,
  key: string,
  field: AgentTextField,
  options: { allowEmpty?: boolean; index?: number } = {},
): string {
  const limit = AGENT_TEXT_LIMITS[field];
  const refuse = (expected: string): never =>
    fail("invalid_field", `${key} must be ${expected}.`, {
      field: key,
      expected,
      ...(options.index === undefined ? {} : { index: options.index }),
    });
  const value = body[key];
  if (typeof value !== "string")
    return refuse(`a string of at most ${limit} characters`);
  if (value.length > limit) return refuse(`at most ${limit} characters`);
  const cleaned = cleanAgentText(value);
  if (!cleaned && !options.allowEmpty)
    return refuse("text that is not empty after cleaning");
  return cleaned;
}
// Every address an agent asks for, under the one agent URL rule. The refusal
// carries the value it got, cut for a message, and what to do instead.
export function urlField(body: Record<string, unknown>): string {
  const value = stringField(body, "url", AGENT_URL_LIMIT);
  if (!isAgentUrl(value)) {
    const hint = agentUrlHint(value);
    return fail(
      "invalid_url",
      "Use a complete HTTP or HTTPS URL without embedded credentials, or about:blank.",
      { url: value.slice(0, 100), ...(hint === undefined ? {} : { hint }) },
    );
  }
  return new URL(value).href;
}
// How many of a tab's recorded events one drain takes.
export function eventFields(body: Record<string, unknown>): { max: number } {
  return { max: integerField(body, "max", 10000, 1, 10000) };
}
export function expectationFields(body: Record<string, unknown>): {
  event: ExpectationEvent;
  timeoutMs: number;
} {
  const event = stringField(body, "event", 20);
  if (!(EXPECTATION_EVENTS as readonly string[]).includes(event))
    return fail(
      "invalid_field",
      `event must be ${EXPECTATION_EVENTS.slice(0, -1).join(", ")}, or ${EXPECTATION_EVENTS.at(-1)}.`,
      { field: "event" },
    );
  return {
    event: event as ExpectationEvent,
    timeoutMs: integerField(body, "timeoutMs", 10000, 1, 60000),
  };
}
export function dialogPolicyFields(
  body: Record<string, unknown>,
): DialogPolicyInput {
  if (typeof body.accept !== "boolean")
    return fail("invalid_field", "accept must be true or false.", {
      field: "accept",
    });
  const promptText =
    body.promptText === undefined
      ? undefined
      : stringField(body, "promptText", MAX_PROMPT_TEXT, true);
  return {
    accept: body.accept,
    ...(promptText === undefined ? {} : { promptText }),
    times: integerField(body, "times", 1, 1, 20),
    lifetimeMs: integerField(body, "lifetimeMs", 60000, 1000, 600000),
  };
}
export function downloadWaitFields(body: Record<string, unknown>): {
  timeoutMs: number;
} {
  return { timeoutMs: integerField(body, "timeoutMs", WAIT_POLL_MS, 1, 60000) };
}
const ORIGIN_EXPECTED =
  "origin must be an http or https origin, such as https://example.com, with no path, query, fragment or credentials.";
export function credentialFields(body: Record<string, unknown>): {
  origin: string;
  username: string;
  password: string;
} {
  const origin = stringField(body, "origin", 2048);
  const username = stringField(body, "username", 256);
  const password = stringField(body, "password", 1024, true);
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return fail("invalid_field", ORIGIN_EXPECTED, { field: "origin" });
  }
  if (
    !isWebUrl(origin) ||
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  )
    return fail("invalid_field", ORIGIN_EXPECTED, { field: "origin" });
  return { origin: parsed.origin, username, password };
}
// The files of an upload or a file input: metadata and canonical base64, read
// once so both routes keep the same rules.
export function filesField(
  body: Record<string, unknown>,
  options: { min: number; max: number },
) {
  const { min, max } = options;
  if (
    !Array.isArray(body.files) ||
    body.files.length < min ||
    body.files.length > max
  )
    return fail(
      "invalid_files",
      min === 0
        ? `Provide at most ${max} files.`
        : `Provide between ${min} and ${max} files.`,
    );
  let total = 0;
  const files = body.files.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return fail("invalid_files", "Each file needs a name, MIME type, and base64 content.");
    const file = entry as Record<string, unknown>;
    const name = stringField(file, "name", 255);
    if (/[\\/\u0000-\u001f\u007f]/.test(name) || name === "." || name === "..")
      return fail("invalid_files", "File names must be basenames without control characters.");
    const type = stringField(file, "type", 128, true);
    if (type && !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(type))
      return fail("invalid_files", "Use a valid MIME type or an empty string.");
    const data = stringField(file, "data", Math.ceil(UPLOAD_FILE_LIMIT / 3) * 4, true);
    if (data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
      return fail("invalid_files", "File content must be canonical base64.");
    const decoded = Buffer.from(data, "base64");
    if (decoded.toString("base64") !== data)
      return fail("invalid_files", "File content must be canonical base64.");
    total += decoded.length;
    if (total > UPLOAD_FILE_LIMIT)
      return fail("files_too_large", "Files must total at most 16 MiB per upload.");
    return { name, type, data };
  });
  return files;
}
export function uploadFields(body: Record<string, unknown>) {
  const target = targetFields(body);
  if (!("ref" in target))
    return fail("invalid_target", "Uploads require a current file input ref from a snapshot.");
  return { ...target, files: filesField(body, { min: 1, max: MAX_INPUT_FILES }) };
}
// setInputFiles takes any target, a hidden one included, and an empty list
// that clears the input.
export function setInputFilesFields(body: Record<string, unknown>) {
  return {
    ...targetFields(body),
    files: filesField(body, { min: 0, max: MAX_INPUT_FILES }),
    timeoutMs: integerField(body, "timeoutMs", 3000, 0, 60000),
  };
}
// A file chooser names its own input, so its body carries the files alone.
export function chooserFilesFields(body: Record<string, unknown>): {
  files: { name: string; type: string; data: string }[];
} {
  return { files: filesField(body, { min: 0, max: MAX_INPUT_FILES }) };
}
