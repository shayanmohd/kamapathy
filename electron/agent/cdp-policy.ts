import { isWebUrl } from "../../shared/url";
import { extensionOrigin } from "./extension-frames";
import { WORLD_NAME } from "./session/operations";
import type { CdpEvent } from "./session/types";

// Section 8's protocol policy, as data: which commands an agent may send on
// its own session, which identifiers it may name, and what a recorded event
// may say. Nothing here reaches Chromium or the state of a tab.

export type BlockReason =
  | "browser"
  | "session"
  | "process"
  | "filesystem"
  | "person"
  | "managed"
  | "scope"
  | "unknown";
export interface PolicyContext {
  /** Whether the tab delivered this id to the agent, in a result or an event. */
  delivered(
    kind: "object" | "context" | "world" | "handle",
    id: string | number,
  ): boolean;
  /** The world names the agent made on this tab itself. */
  worlds: ReadonlySet<string>;
  platform: NodeJS.Platform;
}
export type Verdict =
  | { allow: true; dispatcher?: true }
  | { block: BlockReason; param?: string; message?: string };

export const METHOD_PATTERN = /^[A-Z][A-Za-z]+\.[a-z][A-Za-z]+$/;
// What each reason means, said once. A row that names an alternative says so
// itself instead.
const SAYS: Record<BlockReason, string> = {
  browser:
    "It reaches the browser itself and other tabs, which only Kamapathy may do.",
  session:
    "It reaches the data of every site in this session. Run a script in the page's own origin, or clear one site's data with clearSiteData.",
  process:
    "It pauses or reads a renderer that may be hosting the person's own tabs.",
  filesystem: "It reaches files on this computer.",
  person:
    "Only the person can answer this one. Ask them, or hand the space to them.",
  managed: "Kamapathy sends this one itself.",
  scope: "It reaches outside this tab's own page and frames.",
  unknown: "Kamapathy passes only the commands of this tab's own page.",
};
// Blocked domains, with the reason they are out of reach.
const DOMAINS: Record<string, BlockReason> = {
  Target: "browser",
  Browser: "browser",
  SystemInfo: "browser",
  Tethering: "browser",
  Tracing: "browser",
  Storage: "session",
  ServiceWorker: "session",
  BackgroundService: "session",
  CacheStorage: "session",
  IndexedDB: "session",
  DOMStorage: "session",
  FileSystem: "session",
  Debugger: "process",
  DOMDebugger: "process",
  EventBreakpoints: "process",
  HeapProfiler: "process",
  Profiler: "process",
  Memory: "process",
  Autofill: "person",
  BluetoothEmulation: "person",
  Cast: "person",
  DeviceAccess: "person",
  Extensions: "person",
  FedCm: "person",
  PWA: "person",
  WebAuthn: "person",
};
// Domains an agent may use, whole except for the rows below.
const ALLOWED = new Set([
  "Accessibility",
  "Animation",
  "Audits",
  "Console",
  "CSS",
  "DeviceOrientation",
  "DOMSnapshot",
  "Inspector",
  "IO",
  "LayerTree",
  "Log",
  "Media",
  "Overlay",
  "Performance",
  "PerformanceTimeline",
  "Preload",
  "Schema",
  "WebAudio",
  "DOM",
  "Emulation",
  "Fetch",
  "Input",
  "Network",
  "Page",
  "Runtime",
  "Security",
]);
// The only methods of a domain an agent may use. Everything else in it is
// the person's.
const ONLY: Record<
  string,
  { methods: readonly string[]; reason: BlockReason }
> = {
  Security: { methods: ["enable", "disable"], reason: "person" },
};
// Methods of the allowed domains that are refused, in the policy table's
// order. A message names what to use instead.
const REFUSED: Record<string, { reason: BlockReason; message?: string }> = {
  "DOM.setFileInputFiles": {
    reason: "filesystem",
    message: "Choose files with upload (page.upload) instead.",
  },
  "DOM.getFileInfo": { reason: "filesystem" },
  "Emulation.setCPUThrottlingRate": { reason: "process" },
  "Emulation.setTimezoneOverride": { reason: "process" },
  "Emulation.setLocaleOverride": { reason: "process" },
  // With mouse events turned into touch events, a mouse command Kamapathy
  // sends on its own session is delivered but never answered again.
  "Emulation.setEmitTouchEventsForMouse": {
    reason: "managed",
    message:
      "Kamapathy would lose the answer to every mouse command it sends. Send touch with Input.dispatchTouchEvent instead.",
  },
  "Fetch.continueWithAuth": {
    reason: "person",
    message:
      "HTTP and proxy sign-ins go to the person, or to space.setHTTPCredentials.",
  },
  "Input.setIgnoreInputEvents": { reason: "person" },
  "Input.setInterceptDrags": {
    reason: "managed",
    message: "Kamapathy owns drags; drag with drag (page.drag).",
  },
  "Input.dispatchDragEvent": {
    reason: "managed",
    message: "Kamapathy owns drags; drag with drag (page.drag).",
  },
  "Network.getCookies": { reason: "session" },
  "Network.getAllCookies": { reason: "session" },
  "Network.setCookie": { reason: "session" },
  "Network.setCookies": { reason: "session" },
  "Network.deleteCookies": { reason: "session" },
  "Network.clearBrowserCookies": { reason: "session" },
  "Network.clearBrowserCache": { reason: "session" },
  "Network.setCookieControls": { reason: "session" },
  "Network.loadNetworkResource": { reason: "filesystem" },
  "Page.setDownloadBehavior": { reason: "filesystem" },
  "Page.crash": { reason: "process" },
  "Page.waitForDebugger": { reason: "process" },
  "Page.deleteCookie": { reason: "session" },
  "Page.close": {
    reason: "managed",
    message: "Close the tab with page.close().",
  },
  "Page.bringToFront": { reason: "person" },
  "Page.setWebLifecycleState": { reason: "person" },
  "Page.setSPCTransactionMode": { reason: "person" },
  "Page.setRPHRegistrationMode": { reason: "person" },
  "Page.handleJavaScriptDialog": {
    reason: "managed",
    message: "Answer dialogs with the dialog policy (page.setDialogPolicy).",
  },
  "Page.setInterceptFileChooserDialog": {
    reason: "managed",
    message: "Choose files with upload (page.upload) instead.",
  },
  "Runtime.terminateExecution": { reason: "process" },
};
// Clipboard editing commands, and the keys that run them with the
// accelerator held.
const CLIPBOARD_COMMANDS = /^(copy|cut|paste)/i;
const CLIPBOARD_KEYS = /^(c|x|v|insert)$/i;
const CLIPBOARD_CODES = /^(KeyC|KeyX|KeyV|Insert)$/i;
// The editor's own clipboard keys, held with Shift: Insert pastes and
// Delete cuts, both through the system clipboard.
const CLIPBOARD_SHIFT = /^(insert|delete)$/i;
// CDP's modifier bits: Alt 1, Control 2, Meta 4, Shift 8.
const CONTROL = 2;
const META = 4;
const SHIFT = 8;
// Every Input method Chromium 152 lists. Section 5's dispatcher sends the
// ones the policy allows, so section 12 needs no table of its own.
export const INPUT_METHODS: readonly string[] = [
  "cancelDragging",
  "dispatchDragEvent",
  "dispatchKeyEvent",
  "dispatchMouseEvent",
  "dispatchTouchEvent",
  "emulateTouchFromMouseEvent",
  "imeSetComposition",
  "insertText",
  "setIgnoreInputEvents",
  "setInterceptDrags",
  "synthesizePinchGesture",
  "synthesizeScrollGesture",
  "synthesizeTapGesture",
].map((name) => `Input.${name}`);

const block = (
  reason: BlockReason,
  extra: { param?: string; message?: string } = {},
): Verdict => ({
  block: reason,
  ...(extra.param === undefined ? {} : { param: extra.param }),
  message: extra.message ?? SAYS[reason],
});
const httpUrl = (value: unknown): boolean => {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
// The world Electron runs a page's preload scripts in, Kamapathy's form
// preload among them. A probe of Electron 44 saw an agent session report it
// under this name, as an isolated world of the page's own origin.
const PRELOAD_WORLD = "Electron Isolated Context";
// A world no agent takes, names or is given: Kamapathy's own, whose names
// start with WORLD_NAME, and Electron's preload world. Names are compared
// trimmed, with each run of whitespace as one space, in lower case.
const normalName = (name: string) =>
  name.trim().replace(/\s+/g, " ").toLowerCase();
const reservedWorld = (value: unknown) => {
  if (typeof value !== "string") return false;
  const name = normalName(value);
  return (
    name.startsWith(normalName(WORLD_NAME)) ||
    name === normalName(PRELOAD_WORLD)
  );
};
const RESERVED_WORLD = `A world named ${WORLD_NAME} or starting with it is Kamapathy's, and ${PRELOAD_WORLD} is Electron's. Give an agent's world a name of its own.`;
// What a command's own parameters may not say. Each check reads the params it
// names and nothing else.
const CHECKS: Record<
  string,
  (params: Record<string, any>, ctx: PolicyContext) => Verdict | undefined
> = {
  "Fetch.enable": (params) =>
    params.handleAuthRequests === true
      ? block("person", {
          param: "handleAuthRequests",
          message:
            "HTTP and proxy sign-ins go to the person, or to space.setHTTPCredentials.",
        })
      : undefined,
  "Fetch.continueRequest": (params) =>
    params.url !== undefined && !httpUrl(params.url)
      ? block("scope", {
          param: "url",
          message: "A request continues to an http or https URL only.",
        })
      : undefined,
  "Input.dispatchKeyEvent": (params) => {
    const commands = Array.isArray(params.commands) ? params.commands : [];
    if (commands.some((name: unknown) => CLIPBOARD_COMMANDS.test(String(name))))
      return block("person", {
        param: "commands",
        message: "The clipboard is the person's.",
      });
    const modifiers =
      typeof params.modifiers === "number" ? params.modifiers : 0;
    const chord = (modifiers & CONTROL) !== 0 || (modifiers & META) !== 0;
    const insert =
      (modifiers & SHIFT) !== 0 &&
      (CLIPBOARD_SHIFT.test(String(params.key ?? "")) ||
        CLIPBOARD_SHIFT.test(String(params.code ?? "")));
    if (
      (chord &&
        (CLIPBOARD_KEYS.test(String(params.key ?? "")) ||
          CLIPBOARD_CODES.test(String(params.code ?? "")))) ||
      insert
    )
      return block("person", {
        param: "key",
        message: "The clipboard is the person's.",
      });
    return undefined;
  },
  // Middle-button presses paste the selection on Linux.
  "Input.dispatchMouseEvent": (params, ctx) =>
    ctx.platform === "linux" && params.button === "middle"
      ? block("person", {
          param: "button",
          message: "The clipboard is the person's.",
        })
      : undefined,
  "Page.navigate": (params) =>
    isWebUrl(String(params.url ?? ""))
      ? undefined
      : block("scope", {
          param: "url",
          message:
            "Agents open complete http or https URLs. Navigate with navigate (page.goto).",
        }),
  "Page.createIsolatedWorld": (params) => worldCheck(params),
  "Page.addScriptToEvaluateOnNewDocument": (params) => worldCheck(params),
};
function worldCheck(params: Record<string, any>): Verdict | undefined {
  if (reservedWorld(params.worldName))
    return block("scope", { param: "worldName", message: RESERVED_WORLD });
  if (params.grantUniveralAccess === true)
    return block("scope", {
      param: "grantUniveralAccess",
      message: "A world of the agent's own may not reach other origins.",
    });
  return undefined;
}
// The identifier kinds a command's parameters may name, by key.
const PARAM_IDS: Record<string, "context" | "world" | "handle"> = {
  contextId: "context",
  executionContextId: "context",
  uniqueContextId: "context",
  executionContextName: "world",
  handle: "handle",
};
type Id = {
  kind: "object" | "context" | "world" | "handle";
  id: string | number;
};
type Found = Id & { key: string };
const isId = (value: unknown): value is string | number =>
  typeof value === "string" || typeof value === "number";
// Every identifier a value names, with the key that holds it. Object ids are
// any key ending in objectId or ObjectId.
function walk(
  value: unknown,
  keys: Record<string, Id["kind"]>,
  found: Found[],
  depth = 0,
): Found[] {
  if (depth > 8 || value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) walk(item, keys, found, depth + 1);
    return found;
  }
  for (const [key, item] of Object.entries(value)) {
    const kind =
      keys[key] ??
      (key.endsWith("objectId") || key.endsWith("ObjectId")
        ? ("object" as const)
        : undefined);
    if (kind !== undefined && isId(item)) found.push({ kind, id: item, key });
    else walk(item, keys, found, depth + 1);
  }
  return found;
}
// What a result or an event delivered to the agent: ids it may name later.
export function collectIds(method: string, value: unknown): Id[] {
  if (method === "Runtime.executionContextCreated") {
    const context = (value as { context?: Record<string, unknown> })?.context;
    const found: Id[] = [];
    if (context && isId(context.id))
      found.push({ kind: "context", id: context.id });
    if (context && isId(context.uniqueId))
      found.push({ kind: "context", id: context.uniqueId });
    if (typeof context?.name === "string" && context.name)
      found.push({ kind: "world", id: context.name });
    return found;
  }
  return walk(
    value,
    {
      contextId: "context",
      executionContextId: "context",
      uniqueContextId: "context",
      executionContextUniqueId: "context",
      handle: "handle",
      stream: "handle",
      uuid: "handle",
    },
    [],
  ).map(({ kind, id }) => ({ kind, id }));
}
/** The context ids a command's parameters name, with the key that holds each. */
export function contextIds(
  params: Record<string, unknown>,
): { key: string; id: string | number }[] {
  return walk(params, PARAM_IDS, [])
    .filter((found) => found.kind === "context")
    .map(({ key, id }) => ({ key, id }));
}

// The one verdict on a command: its domain, its own row, its parameters, then
// the identifiers it names.
export function classify(
  method: string,
  params: Record<string, unknown>,
  ctx: PolicyContext,
): Verdict {
  if (!METHOD_PATTERN.test(method)) return block("unknown");
  const [domain, name] = method.split(".");
  const blocked = DOMAINS[domain];
  if (blocked) return block(blocked);
  if (!ALLOWED.has(domain)) return block("unknown");
  const only = ONLY[domain];
  if (only && !only.methods.includes(name)) return block(only.reason);
  const refused = REFUSED[method];
  if (refused) return block(refused.reason, { message: refused.message });
  const problem = CHECKS[method]?.(params, ctx);
  if (problem) return problem;
  for (const { kind, id, key } of walk(params, PARAM_IDS, [])) {
    if (kind === "world" && reservedWorld(id))
      return block("scope", { param: key, message: RESERVED_WORLD });
    const known =
      kind === "world" ? ctx.worlds.has(String(id)) : ctx.delivered(kind, id);
    if (known) continue;
    return block("scope", {
      param: key,
      message:
        "An agent may name only the objects, contexts and streams this tab gave it.",
    });
  }
  return domain === "Input"
    ? { allow: true, dispatcher: true }
    : { allow: true };
}

const HIDDEN = "(hidden)";
const COOKIE_HEADER = /^(set-)?cookie2?$/i;
const COOKIE_LINE = /^[ \t]*(set-cookie2?|cookie2?)([ \t]*:[ \t]*)(.*)$/gim;
const HEADER_MAPS = new Set(["headers", "requestHeaders", "responseHeaders"]);
const HEADER_TEXTS = new Set([
  "headersText",
  "requestHeadersText",
  "responseHeadersText",
]);
const COOKIE_LISTS = new Set([
  "associatedCookies",
  "blockedCookies",
  "exemptedCookies",
]);
// Events that never reach an agent's log: targets are Kamapathy's to open,
// and a worker's own session is out of an agent's reach.
const NEVER = new Set(["Target", "ServiceWorker"]);
// The keys that name a V8 context an agent has to have been given. WebAudio's
// own contextId is not one of them.
const CONTEXT_KEYS = new Set([
  "executionContextId",
  "executionContextUniqueId",
  "uniqueContextId",
]);

// One tab's redaction hook for section 1's event buffer: what is never
// recorded, what the agent's own sessions replace, and cookie values.
export function redactEvent(
  event: CdpEvent,
  ctx: {
    delivered: PolicyContext["delivered"];
    owns(domain: "Page" | "Network"): boolean;
    fromAgent: boolean;
    /** Whether the tab's registry blocks a frame. */
    blocked?(frameId: string): boolean;
  },
): CdpEvent | null {
  const domain = event.method.split(".")[0];
  if (NEVER.has(domain)) return null;
  // Once the agent enables a domain on its own session, its copy replaces
  // Kamapathy's, so nothing appears twice.
  if (
    !ctx.fromAgent &&
    (domain === "Page" || domain === "Network") &&
    ctx.owns(domain)
  )
    return null;
  if (
    event.method === "Runtime.executionContextCreated" &&
    outOfReach(event.params, ctx.blocked)
  )
    return null;
  if (namesUnknownContext(event, ctx.delivered)) return null;
  const params = hide(event.params);
  return params === event.params ? event : { ...event, params };
}
/**
 * Whether a context Runtime.executionContextCreated reports is one no agent
 * is given: a world one of the person's extensions runs in, a content
 * script's own or an extension page's, any world of a frame the tab blocks,
 * or Kamapathy's or Electron's own world, which carry the page's origin and
 * are known by name. Sections 8 and 17 keep agents out of them, so the
 * context is never recorded or delivered, which leaves every command naming
 * it out of scope and drops its end with it.
 */
export function outOfReach(
  params: unknown,
  blocked: (frameId: string) => boolean = () => false,
): boolean {
  const context = (
    params as {
      context?: {
        name?: unknown;
        origin?: unknown;
        auxData?: { origin?: unknown; frameId?: unknown };
      };
    }
  )?.context;
  if (reservedWorld(context?.name)) return true;
  const origins = [context?.origin, context?.auxData?.origin];
  if (
    origins.some(
      (origin) => typeof origin === "string" && extensionOrigin(origin),
    )
  )
    return true;
  const frameId = context?.auxData?.frameId;
  return typeof frameId === "string" && blocked(frameId);
}
// An event about a context the agent cannot address at all. An exception
// names its context inside its details.
function namesUnknownContext(
  event: CdpEvent,
  delivered: PolicyContext["delivered"],
): boolean {
  if (event.method === "Runtime.executionContextCreated") return false;
  const runtime = event.method.startsWith("Runtime.");
  const params = (event.params ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(params)) {
    const names = CONTEXT_KEYS.has(key) || (runtime && key === "contextId");
    if (names && isId(value) && !delivered("context", value)) return true;
  }
  const details = params.exceptionDetails as
    | { executionContextId?: unknown }
    | undefined;
  const thrown = runtime ? details?.executionContextId : undefined;
  return isId(thrown) && !delivered("context", thrown);
}
// Cookie values, in header maps, header lists, header text and the three
// cookie lists. Every other field passes through, and an event with nothing
// to hide is returned as it is.
function hide(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") {
    if (typeof value === "string" && HEADER_TEXTS.has(key))
      return value.replace(COOKIE_LINE, `$1$2${HIDDEN}`);
    if (typeof value === "string" && key === "rawCookieLine") return HIDDEN;
    if (typeof value === "string" && key === "cookieLine") return HIDDEN;
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      // A header list, as Fetch and Network report one.
      if (
        HEADER_MAPS.has(key) &&
        item &&
        typeof item === "object" &&
        typeof (item as { name?: unknown }).name === "string" &&
        COOKIE_HEADER.test((item as { name: string }).name)
      ) {
        changed = true;
        return { ...(item as object), value: HIDDEN };
      }
      const next = hide(item, COOKIE_LISTS.has(key) ? key : "", depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : value;
  }
  if (HEADER_MAPS.has(key)) {
    let changed = false;
    const headers: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      const hidden = COOKIE_HEADER.test(name) && typeof item === "string";
      if (hidden) changed = true;
      headers[name] = hidden ? HIDDEN : item;
    }
    return changed ? headers : value;
  }
  // An entry of one of the cookie lists: its line and its cookie's value.
  if (COOKIE_LISTS.has(key)) {
    const entry = value as Record<string, unknown>;
    const cookie = entry.cookie as Record<string, unknown> | undefined;
    const line = typeof entry.cookieLine === "string";
    const inner = cookie && typeof cookie.value === "string";
    if (!line && !inner) return value;
    return {
      ...entry,
      ...(line ? { cookieLine: HIDDEN } : {}),
      ...(inner ? { cookie: { ...cookie, value: HIDDEN } } : {}),
    };
  }
  let changed = false;
  const copy: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value)) {
    const next = hide(item, name, depth + 1);
    if (next !== item) changed = true;
    copy[name] = next;
  }
  return changed ? copy : value;
}
