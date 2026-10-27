// Kamapathy scripting client. Node built-ins only. It finds Kamapathy the way
// the CLI does and every method sends exactly one documented HTTP route over
// the local socket; nothing here runs inside a page. Each method checks its
// arguments against the schema before anything is sent. The site pack calls
// send nothing at all: they read the workspace and the skill.
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { KamapathyError } from "./lib/errors.mjs";
import { formatSnapshot } from "./lib/format.mjs";
import {
  choices,
  pointerOptions,
  pressArguments,
  readFiles,
  readUploadFiles,
  target,
  uploadRef,
} from "./lib/input.mjs";
import {
  isLabel,
  pageBudgetFrom,
  resolveLabels,
  Session,
  streamTo,
} from "./lib/request.mjs";
import { listSitePacks, runToolIn, siteContextFor } from "./lib/sites.mjs";
import {
  checkBody,
  checkCall,
  findEntry,
  matchRoute,
  requestBudget,
} from "./schema/index.mjs";

export { help } from "./help.mjs";
export { KamapathyError } from "./lib/errors.mjs";
export * as schema from "./schema/index.mjs";

const UPLOAD_BODY_LIMIT = 24 * 1024 * 1024;
// Popups a run names one by one before it counts the rest.
const POPUP_NOTICES = 20;
// How long a download wait may take outside a run, which has its own
// deadline: section 3's default run time.
const DOWNLOAD_WAIT_MS = 300000;
// How long a URL watch waits before asking for this page's commits again.
const WATCH_TICK_MS = 100;
// How much of a URL a message carries, as Kamapathy's own messages do.
const URL_CHARS = 100;
const PASTE_BODY_LIMIT = 192 * 1024;
// input/release declares a plain budget, which a request does not read from
// its route, so the release passes the route's own. The route arrived with
// this API level, and an older app is never asked for it.
const RELEASE_ROUTE = matchRoute("POST", "/tabs/:id/input/release");
const RELEASE_BUDGET_MS = requestBudget(RELEASE_ROUTE);
const RELEASE_LEVEL = RELEASE_ROUTE.since;
// The body a page script, a fetch or a protocol command may send, as their
// routes declare it.
const SCRIPT_LIMIT = matchRoute("POST", "/tabs/:id/evaluate").limit;

// What a page script sends: a function as its source, called with its
// argument, or an expression as written.
function scriptSource(fnOrString) {
  return typeof fnOrString === "function"
    ? { function: String(fnOrString) }
    : { expression: fnOrString };
}

// The value an evaluate answered with: JSON as it came, the values JSON
// cannot carry rebuilt, and undefined when the answer has none.
function decodeValue(answer) {
  if ("value" in answer) return answer.value;
  const token = answer.unserializable;
  if (token === undefined) return undefined;
  if (token === "NaN") return Number.NaN;
  if (token === "Infinity") return Number.POSITIVE_INFINITY;
  if (token === "-Infinity") return Number.NEGATIVE_INFINITY;
  if (token === "-0") return -0;
  if (/^-?\d+n$/.test(token)) return BigInt(token.slice(0, -1));
  throw new KamapathyError(
    "invalid_response",
    `Kamapathy answered with a value this client cannot read: ${String(token).slice(0, 40)}.`,
  );
}

// The label an input method was given, for its body.
const labelOf = (options) =>
  options?.label === undefined ? {} : { label: options.label };

// Local files as a route takes them. A path this computer cannot use is the
// call's own invalid_files, before anything is sent.
async function fileBodies(paths) {
  try {
    return await readFiles(paths);
  } catch (error) {
    if (error instanceof KamapathyError) throw error;
    throw new KamapathyError("invalid_files", error.message);
  }
}

// The downloads each session took bytes from, deleted when its run ends.
const received = new WeakMap();
function receivedIn(session) {
  const held = received.get(session) ?? new Set();
  received.set(session, held);
  return held;
}

// The labels a session has seen, so the end-of-run notices name a page the
// way the script does.
const labels = new WeakMap();
function rememberLabel(session, tab) {
  if (typeof tab?.id !== "string" || typeof tab?.label !== "string") return;
  const known = labels.get(session) ?? new Map();
  known.set(tab.id, tab.label);
  labels.set(session, known);
}
const labelOrId = (session, id) => labels.get(session)?.get(id) ?? id;

// The private folders path() wrote into. delete() removes its own, and
// leaving the process removes whatever is left.
const copies = new Set();
let sweeping = false;
function rememberCopy(folder) {
  copies.add(folder);
  if (sweeping) return;
  sweeping = true;
  process.once("exit", () => {
    for (const path of copies)
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {}
  });
}

// What a private copy is called: the name the site suggested as a bare file
// name, or the download's id when that is nothing to call a file.
function copyName({ id, suggestedFilename }) {
  const name = basename(String(suggestedFilename ?? "")).replace(/[/\\]/g, "");
  return name && name !== "." && name !== ".." ? name : id;
}
const cut = (url) => String(url ?? "").slice(0, URL_CHARS);
// The URL the script waited for opened in a popup this page opened, so the
// action already happened and must not be repeated.
const openedInPopup = (page, lastUrl, popup) => {
  const name = popup.label ?? popup.id;
  return new KamapathyError(
    "url_opened_in_popup",
    `${page} stayed at ${cut(lastUrl)}, but popup ${name} opened from it at ${cut(popup.url)}. The action already happened, so do not repeat it. Continue in ${name}.`,
    { lastUrl, popup },
  );
};
// A URL wait the client ran out of time on, naming the matcher it held.
const urlTimeout = (timeoutMs, lastUrl, expected) =>
  new KamapathyError(
    "wait_timeout",
    `The page did not reach a URL matching ${cut(expected)} within ${timeoutMs} ms. It is at ${cut(lastUrl)}.`,
    { awaited: "url", timeoutMs, expected, lastUrl },
  );
// An options object where a page function's own argument belongs.
const misplacedOptions = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length > 0 &&
  Object.keys(value).every((key) => ["timeout", "interval"].includes(key));

/**
 * @typedef {"@e1" | string} Target A ref such as "@e3" from a current
 * snapshot, or a selector: CSS, css=, text=, role=, href= or xpath=, with an
 * optional final `>> nth=N`. It must pick one element the action can take.
 */
/**
 * @typedef {object} Control
 * @property {string} ref
 * @property {string} [role]
 * @property {string} [tag]
 * @property {string} label
 * @property {string} [type]
 * @property {string} [value]
 * @property {boolean} [valueHidden]
 * @property {boolean | "mixed"} [checked]
 * @property {boolean} [selected]
 * @property {boolean} [expanded]
 * @property {boolean} [pressed]
 * @property {boolean} [disabled]
 * @property {string} [group]
 * @property {string} [href] A link's absolute address.
 * @property {string} [locator] A selector naming this control alone.
 * @property {{ value: string, label: string, disabled?: boolean, selected?: boolean }[]} [options]
 * @property {string} [extension] The extension a blocked frame belongs to.
 */
/**
 * @typedef {object} SnapshotTab
 * @property {string} id
 * @property {string} [label]
 * @property {string} title
 * @property {"agent" | "page" | "person"} [openedBy]
 * @property {boolean} managed
 * @property {true} [current]
 */
/**
 * @typedef {object} SnapshotHeader
 * @property {{ id: string, label?: string, title: string }} page
 * @property {{ id: string, name: string }} space
 * @property {SnapshotTab[]} tabs
 * @property {{ used: number, limit: number }} [budget] Near the page budget.
 * @property {true} [pdf]
 */
/**
 * @typedef {object} Snapshot
 * @property {string} tabId
 * @property {string} url
 * @property {string} title
 * @property {string} [text] The page's text, in the list format.
 * @property {string} [outline] The page's structure, in the outline format.
 * @property {Control[]} interactables
 * @property {number} [omittedControls]
 * @property {boolean} truncated
 * @property {SnapshotHeader} [header]
 * @property {string} [next] Pass back as `cursor` for the next part.
 * @property {string[]} [rebound]
 * @property {true} [locatorsIncomplete]
 */
/**
 * @typedef {object} SnapshotOptions
 * @property {"compact" | "full"} [mode] Compact is the default.
 * @property {string} [selector] Scope to one matching element, of any form.
 * @property {number} [maxChars] 0 to 24000.
 * @property {number} [maxControls] 0 to 100.
 * @property {"page" | "viewport"} [scope] Page is the default.
 * @property {string} [root] Scope to a ref's subtree or a frame's document.
 * @property {"list" | "outline"} [format] List is the default.
 * @property {boolean} [locators] Give each control a durable locator.
 * @property {boolean} [header] Name the page, space and tabs. On by default.
 * @property {string} [cursor] An earlier part's `next`.
 */
/**
 * @typedef {object} ScreenshotOptions
 * @property {string} [path] Also write the PNG to this new .png file.
 * @property {boolean} [fullPage] Capture the whole scrollable document.
 * @property {{ x: number, y: number, width: number, height: number }} [clip]
 * The part to capture, in CSS pixels of the image's own space.
 * @property {"css" | "device"} [scale] CSS is the default.
 * @property {number} [timeout] 1 to 60000 ms, default 15000.
 */
/**
 * @typedef {object} WaitOptions
 * @property {string} [selector]
 * @property {string} [text]
 * @property {number} [timeoutMs] 0 to 15000, default 5000.
 */
/**
 * @typedef {"commit" | "domcontentloaded" | "load" | "networkidle"} WaitUntil
 * How far a navigation or a load state wait waits.
 */
/**
 * @typedef {object} NavigationResult
 * @property {true} ok
 * @property {object} tab The tab as Kamapathy sees it after the navigation.
 * @property {number} [httpStatus] The new document's status, when it had one.
 * @property {WaitUntil} waitUntil The state the navigation waited for.
 * @property {{ type: "beforeunload", message: string, answer: "accepted" }} [dialog]
 * The page's leave guard, overridden because the agent is in control.
 */
/**
 * @typedef {object} PageInfo
 * @property {object} tab
 * @property {{ width: number, height: number }} [viewport] In CSS pixels.
 * @property {{ x: number, y: number }} [scroll]
 * @property {{ width: number, height: number }} [document]
 * @property {"loading" | "interactive" | "complete"} [readyState]
 * @property {boolean} [loading] Whether the main frame is still loading.
 * @property {{ type: string, message: string }} [dialog] The dialog holding
 * the page, instead of everything above.
 */
/**
 * @typedef {string | RegExp | ((url: URL) => boolean)} UrlMatcher A glob
 * Kamapathy matches, or a RegExp or predicate the client tests against every
 * URL this page commits.
 */
/**
 * @typedef {object} ActionOptions
 * @property {string} [label] A few words naming this step, at most 60
 * characters, shown by the agent's cursor and in the agent bar.
 */
/**
 * @typedef {{ x: number, y: number }} Point A point in viewport CSS pixels.
 */
/**
 * @typedef {object} PointerOptions What a click or dblclick takes.
 * @property {"left" | "middle" | "right"} [button]
 * @property {number} [clickCount] 1 to 3; not on dblclick.
 * @property {number} [delay] How long each press is held, 0 to 5000 ms.
 * @property {Point | string} [position] Where in the element to act,
 * as { x, y } or "x,y" from its top left corner.
 * @property {boolean} [force] Act even when something covers the target.
 * @property {number} [timeout] How long to wait for a target that can take
 * the input, 0 to 60000 ms, 3000 by default.
 * @property {string} [label]
 */
/**
 * @typedef {{ value?: string, label?: string, index?: number }} SelectChoice
 */
/**
 * @typedef {object} InputState What a page's mouse and keyboard hold.
 * @property {number} x
 * @property {number} y
 * @property {number} buttons Left 1, right 2, middle 4.
 * @property {string[]} keys
 * @property {number} modifiers Alt 1, Control 2, Meta 4, Shift 8.
 */
/**
 * @typedef {object} Action One batch step, as documented in actions.md.
 * @property {"snapshot" | "click" | "fill" | "press" | "scroll" | "drag" | "wait"} type
 * @property {string} [ref]
 * @property {string} [selector]
 * @property {string} [value]
 * @property {string} [key]
 * @property {"up" | "down" | "left" | "right"} [direction]
 * @property {number} [pixels]
 * @property {{ ref?: string, selector?: string }} [source]
 * @property {{ ref?: string, selector?: string }} [target]
 * @property {string} [text]
 * @property {number} [timeoutMs]
 * @property {"compact" | "full"} [mode]
 * @property {number} [maxChars]
 * @property {number} [maxControls]
 */
/**
 * @typedef {object} DialogRecord One dialog Kamapathy answered in a tab.
 * @property {"alert" | "confirm" | "prompt" | "beforeunload"} type
 * @property {string} message
 * @property {string} [defaultValue]
 * @property {"accepted" | "dismissed"} answer
 * @property {string} [promptText] What an accepted prompt returned.
 * @property {string} url
 * @property {number} at
 */
/**
 * @typedef {object} DialogPolicy How a tab answers its next dialogs.
 * @property {boolean} accept
 * @property {string} [promptText]
 * @property {number} remaining Confirms and prompts the policy still answers.
 * @property {number} expiresAt
 */
/**
 * @typedef {object} UpdateRelease The release an update check found.
 * @property {string} version
 * @property {number} publishedAt
 * @property {string} url
 * @property {{ name: string, size: number, url: string, sha256?: string }} installer
 */
/**
 * @typedef {object} UpdateStatus Kamapathy's update status.
 * @property {string} version The running Kamapathy's version.
 * @property {boolean} checks Whether Kamapathy checks for updates daily.
 * @property {"mac-arm64" | "mac-x64" | "windows-setup" | "windows-portable" | "linux-appimage" | "linux-deb" | "source" | "other"} kind
 * @property {"unchecked" | "current" | "available" | "downloading" | "ready" | "unsupported"} state
 * @property {number} [checkedAt] When the last check finished.
 * @property {UpdateRelease} [latest]
 * @property {{ receivedBytes: number, totalBytes: number }} [progress]
 * @property {{ path: string, sha256: string }} [installer] The file the person installs.
 * @property {{ code: string, message: string, reason?: string, retryable?: boolean, httpStatus?: number, file?: string }} [error]
 */
/**
 * @typedef {object} BatchResult
 * @property {true} ok
 * @property {{ index: number, type: string, result: object }[]} results
 */
/**
 * @typedef {object} PdfText
 * @property {string} url
 * @property {string} title The document's title, else the tab's.
 * @property {number} pageCount
 * @property {number} from
 * @property {number} to
 * @property {{ number: number, text: string }[]} pages
 * @property {number} chars
 * @property {boolean} truncated
 * @property {number} [nextPage] The first page not fully returned.
 * @property {true} [noText] The pages carry no text, such as scans.
 */
/**
 * @typedef {object} SiteTool A tool a site pack declares.
 * @property {string} name
 * @property {"node" | "page"} kind A Node tool, or one that runs in the page.
 * @property {string} description
 */
/**
 * @typedef {object} SiteToolContext A tool with its arguments and an example.
 * @property {string} name
 * @property {"node" | "page"} kind
 * @property {string} description
 * @property {{ name: string, type: string, required: boolean, description: string }[]} args
 * @property {{ type: string, description: string }} returns
 * @property {string} example A call ready to run, with the required arguments.
 */
/**
 * @typedef {object} SitePack One site pack, as sitePacks lists it.
 * @property {string} id
 * @property {string} name
 * @property {"workspace" | "bundled"} source
 * @property {string} dir The pack's folder.
 * @property {string[]} domains The hosts the pack matches.
 * @property {string[]} notes The note files it declares.
 * @property {SiteTool[]} tools Node tools first, then page tools.
 */
/**
 * @typedef {object} SiteContext One matching pack, with its notes read.
 * @property {string} id
 * @property {string} name
 * @property {"workspace" | "bundled"} source
 * @property {string} dir
 * @property {string[]} domains
 * @property {string} matchedBy The domain entry the page matched.
 * @property {{ file: string, text: string }[]} notes
 * @property {SiteToolContext[]} tools
 */
/**
 * @typedef {object} SiteSkipped A pack, or a root, that broke a rule.
 * @property {string} path
 * @property {"workspace" | "bundled"} source
 * @property {string} problem
 */
/**
 * @typedef {object} NodeToolContext What a pack's Node tool is given.
 * @property {Page} page The page the tool works in.
 * @property {Client} kamapathy This client.
 * @property {{ id: string, name: string, dir: string, source: "workspace" | "bundled" }} pack
 */

// Refreshes a page from a response that carries its tab.
const REFRESH = Symbol("refresh");
const PAGE_FIELDS = [
  "id",
  "label",
  "spaceId",
  "openedBy",
  "openerId",
  "managed",
  "url",
  "title",
];

const DOWNLOAD_TIMEOUT =
  "The download is still running in Kamapathy. Run kamapathy upgrade again to wait for it.";

// The pause between download polls, which the session's signal cuts short.
async function sleep(ms, signal) {
  try {
    await pause(ms, undefined, { signal });
  } catch {
    const reason = signal.reason;
    throw new KamapathyError(
      reason?.code ?? "interrupted",
      reason?.message ?? "The call was interrupted.",
    );
  }
}

// A download that stopped: the status carries the failure instead of an HTTP
// status, so the client raises it.
function stopped(status) {
  const error = status.error;
  if (!error || ["downloading", "ready"].includes(status.state)) return;
  throw new KamapathyError(error.code, error.message, {
    reason: error.reason,
    retryable: error.retryable,
    httpStatus: error.httpStatus,
    file: error.file,
  });
}

// A route's own time budget, for a long poll that outlasts the transport's
// default timeout.
const budgetOf = (method, path) => requestBudget(matchRoute(method, path));

// How long a wait of several polls may still take: the rest of the run's
// time, or a single command's own allowance.
const timeLeft = (session) =>
  session.deadline
    ? Math.max(session.deadline - Date.now(), 0)
    : DOWNLOAD_WAIT_MS;

// The dialog policy as its route takes it: the client's lifetime is the
// route's lifetimeMs, and a key the client does not define travels as it is
// so the route's own check names it.
function dialogPolicyBody({ lifetime, ...rest }) {
  return {
    ...rest,
    ...(lifetime === undefined ? {} : { lifetimeMs: lifetime }),
  };
}

// The absolute file a screenshot writes, which must end in .png.
function pngPath(path) {
  const output = resolve(path);
  if (!output.toLowerCase().endsWith(".png"))
    throw new Error("Screenshot output must have a .png extension.");
  return output;
}

// A synchronous method's check, against the app's level when it is known.
function checkNow(session, name, args) {
  const problem = checkCall(findEntry(name), args, session.app ?? undefined);
  if (problem)
    throw new KamapathyError(problem.code, problem.message, problem.fields);
}

// Runs one public method. Its arguments are checked before anything is sent,
// and against the app's level once Kamapathy is found; errors leaving it name
// the call.
async function call(session, name, args, send) {
  const entry = findEntry(name);
  try {
    const problem = checkCall(entry, args);
    if (problem)
      throw new KamapathyError(problem.code, problem.message, problem.fields);
    await session.ready();
    const outdated = checkCall(entry, args, session.app);
    if (outdated)
      throw new KamapathyError(outdated.code, outdated.message, outdated.fields);
    return await send();
  } catch (error) {
    if (error instanceof KamapathyError && error.entry === undefined)
      error.entry = entry.signature.split("(")[0];
    throw error;
  }
}

/**
 * One page's mouse, kept in the main process: it moves, presses and scrolls
 * where it stands, without resolving a target. Coordinates are viewport CSS
 * pixels of the top frame, as snapshots and screenshots give them.
 */
export class Mouse {
  #send;
  /**
   * @param {(name: string, args: unknown[], route: string, body: object, options?: object) => Promise<any>} send
   */
  constructor(send) {
    this.#send = send;
  }
  /**
   * @param {number} x
   * @param {number} y
   * @param {{ steps?: number }} [options] 1 to 100 events, 1 by default.
   * @returns {Promise<{ ok: true, input: InputState }>}
   */
  move(x, y, options = {}) {
    return this.#send("Mouse.move", [x, y, options], "mouse/move", {
      x,
      y,
      ...pointerOptions(options, "page.mouse.move"),
    });
  }
  /**
   * @param {{ button?: "left" | "middle" | "right", clickCount?: number }} [options]
   * @returns {Promise<{ ok: true, input: InputState }>}
   */
  down(options = {}) {
    return this.#send(
      "Mouse.down",
      [options],
      "mouse/down",
      pointerOptions(options, "page.mouse.down"),
    );
  }
  /**
   * @param {{ button?: "left" | "middle" | "right", clickCount?: number }} [options]
   * @returns {Promise<{ ok: true, input: InputState }>}
   */
  up(options = {}) {
    return this.#send(
      "Mouse.up",
      [options],
      "mouse/up",
      pointerOptions(options, "page.mouse.up"),
    );
  }
  /**
   * @param {number} x
   * @param {number} y
   * @param {{ button?: "left" | "middle" | "right", clickCount?: number, delay?: number }} [options]
   * @returns {Promise<{ ok: true, url: string, input: InputState, loading?: true }>}
   */
  click(x, y, options = {}) {
    return this.#send("Mouse.click", [x, y, options], "mouse/click", {
      x,
      y,
      ...pointerOptions(options, "page.mouse.click"),
    });
  }
  /**
   * @param {number} x
   * @param {number} y
   * @param {{ button?: "left" | "middle" | "right", delay?: number }} [options]
   * @returns {Promise<{ ok: true, url: string, input: InputState, loading?: true }>}
   */
  dblclick(x, y, options = {}) {
    return this.#send("Mouse.dblclick", [x, y, options], "mouse/click", {
      x,
      y,
      clickCount: 2,
      ...pointerOptions(options, "page.mouse.dblclick"),
    });
  }
  /**
   * @param {number} deltaX
   * @param {number} deltaY
   * @returns {Promise<{ ok: true, input: InputState }>}
   */
  wheel(deltaX, deltaY) {
    return this.#send("Mouse.wheel", [deltaX, deltaY], "mouse/wheel", {
      deltaX,
      deltaY,
    });
  }
}

/**
 * One page's keyboard: it holds keys, presses chords, types text and pastes
 * without ever using the system clipboard.
 */
export class Keyboard {
  #send;
  /**
   * @param {(name: string, args: unknown[], route: string, body: object, options?: object) => Promise<any>} send
   */
  constructor(send) {
    this.#send = send;
  }
  /**
   * @param {string} key One key name or printable character, not a chord.
   * @returns {Promise<{ ok: true, input: InputState }>}
   */
  down(key) {
    return this.#send("Keyboard.down", [key], "keyboard/down", { key });
  }
  /**
   * @param {string} key A key this page holds.
   * @returns {Promise<{ ok: true, input: InputState }>}
   */
  up(key) {
    return this.#send("Keyboard.up", [key], "keyboard/up", { key });
  }
  /**
   * @param {string} chord A key name, a printable character or a chord.
   * @param {{ delay?: number }} [options]
   * @returns {Promise<{ ok: true, url: string, loading?: true }>}
   */
  press(chord, options = {}) {
    return this.#send("Keyboard.press", [chord, options], "press", {
      key: chord,
      ...pointerOptions(options, "page.keyboard.press"),
    });
  }
  /**
   * @param {string} text At most 2000 characters.
   * @param {{ delay?: number }} [options]
   * @returns {Promise<{ ok: true, input: InputState }>}
   */
  type(text, options = {}) {
    return this.#send("Keyboard.type", [text, options], "keyboard/type", {
      text,
      ...pointerOptions(options, "page.keyboard.type"),
    });
  }
  /**
   * @param {string} text At most 16384 characters.
   * @returns {Promise<{ ok: true }>}
   */
  insertText(text) {
    return this.#send("Keyboard.insertText", [text], "keyboard/insert-text", {
      text,
    });
  }
  /**
   * Offers the page a paste in a DataTransfer of its own, and inserts the
   * plain text when the page does not take it.
   * @param {string | { text: string, html?: string }} input
   * @returns {Promise<{ ok: true, handled: "page" | "text" }>}
   */
  paste(input) {
    const given = typeof input === "string" ? { text: input } : input;
    return this.#send(
      "Keyboard.paste",
      [input],
      "keyboard/paste",
      {
        text: given?.text,
        ...(given?.html === undefined ? {} : { html: given.html }),
      },
      { limit: PASTE_BODY_LIMIT },
    );
  }
}

/** One tab in an agent space. */
export class Page {
  #session;
  /** @type {Promise<object> | null} The arm later calls wait for. */
  #armed = null;
  /**
   * @param {Session} session
   * @param {{ id: string, spaceId?: string, url: string, title: string }} tab
   */
  constructor(session, tab) {
    this.#session = session;
    /** @type {string} Undefined until a page from space.page(label) is used. */
    this.id = tab.id;
    /** @type {string | undefined} Its label in the space, such as p2. */
    this.label = tab.label;
    /** @type {string | undefined} */
    this.spaceId = tab.spaceId;
    /** @type {"agent" | "page" | "person" | undefined} */
    this.openedBy = tab.openedBy;
    /** @type {string | undefined} The page that opened this popup. */
    this.openerId = tab.openerId;
    /** @type {boolean | undefined} Whether the agent may use the page. */
    this.managed = tab.managed;
    /** @type {string} Last known URL; navigate and snapshot refresh it. */
    this.url = tab.url;
    /** @type {string} Last known title; navigate and snapshot refresh it. */
    this.title = tab.title;
    rememberLabel(session, tab);
    // The controllers send on this page's tab, under their own entries.
    const input = (name, args, route, body, options) =>
      call(this.#session, name, args, async () => {
        await this.#find();
        return this.#post(route, body, options);
      });
    /** @type {Mouse} This page's mouse. */
    this.mouse = new Mouse(input);
    /** @type {Keyboard} This page's keyboard. */
    this.keyboard = new Keyboard(input);
  }
  [REFRESH](tab) {
    for (const key of PAGE_FIELDS)
      if (tab[key] !== undefined) this[key] = tab[key];
    rememberLabel(this.#session, this);
    return this;
  }
  // A page from space.page(label) finds its tab on first use, once.
  async #find() {
    if (this.id !== undefined) return;
    const [tab] = await resolveLabels(this.#session, this.spaceId, [
      this.label,
    ]);
    this[REFRESH](tab);
  }
  #call(name, args, send) {
    return call(this.#session, `Page.${name}`, args, async () => {
      // A live arm is acknowledged before anything else is sent, so the
      // action that causes the event cannot outrun it; an arm that fails
      // fails the call behind it instead of letting it run unarmed.
      if (this.#armed) await this.#armed;
      await this.#find();
      return send();
    });
  }
  #post(route, body, options) {
    return this.#session.request(`/tabs/${this.id}/${route}`, {
      method: "POST",
      body,
      ...options,
    });
  }
  // Every navigation and wait answers with the tab, so the page's url and
  // title follow each one.
  #refreshed(result) {
    if (result.tab) this[REFRESH](result.tab);
    return result;
  }
  /**
   * Loads a complete http or https URL, or about:blank, and returns once the
   * new document commits. Refs from before become stale.
   * @param {string} url
   * @returns {Promise<Page>} This page, with `url` and `title` updated.
   */
  navigate(url) {
    return this.#call("navigate", [url], async () => {
      // commit is the point this method has always returned at.
      const { tab } = await this.#post("navigate", {
        url,
        waitUntil: "commit",
      });
      return this[REFRESH](tab);
    });
  }
  /**
   * Loads a URL and waits for the new document to reach a state.
   * @param {string} url A complete http or https URL, or about:blank.
   * @param {{ waitUntil?: WaitUntil, timeout?: number, referer?: string }} [options]
   * `timeout` is 1 to 60000 ms, 15000 by default.
   * @returns {Promise<NavigationResult>}
   */
  goto(url, options = {}) {
    return this.#call("goto", [url, options], async () => {
      const { waitUntil = "load", timeout = 15000, referer } = options;
      return this.#refreshed(
        await this.#post("navigate", {
          url,
          waitUntil,
          timeoutMs: timeout,
          ...(referer === undefined ? {} : { referer }),
        }),
      );
    });
  }
  /**
   * Reloads the page and waits for the new document to reach a state. The
   * tab keeps its ID and label.
   * @param {{ waitUntil?: WaitUntil, timeout?: number, ignoreCache?: boolean }} [options]
   * `ignoreCache` refetches the page and its subresources past the cache.
   * @returns {Promise<NavigationResult>}
   */
  reload(options = {}) {
    return this.#call("reload", [options], async () => {
      const {
        waitUntil = "load",
        timeout = 15000,
        ignoreCache = false,
      } = options;
      return this.#refreshed(
        await this.#post("reload", {
          waitUntil,
          timeoutMs: timeout,
          ignoreCache,
        }),
      );
    });
  }
  /**
   * Reads the viewport, scroll offsets, document size and ready state, fresh
   * from the page.
   * @returns {Promise<PageInfo>}
   */
  info() {
    return this.#call("info", [], async () =>
      this.#refreshed(await this.#session.request(`/tabs/${this.id}/info`)),
    );
  }
  /**
   * Waits for this page's URL to match, then for the state asked for.
   * @param {UrlMatcher} url
   * @param {{ timeout?: number, waitUntil?: WaitUntil }} [options]
   * @returns {Promise<{ ok: true, tab: object, url: string }>}
   */
  waitForURL(url, options = {}) {
    return this.#call("waitForURL", [url, options], async () => {
      const { timeout = 10000, waitUntil = "load" } = options;
      if (typeof url === "string")
        return this.#refreshed(
          await this.#post("wait-for-url", {
            url,
            waitUntil,
            timeoutMs: timeout,
          }),
        );
      return this.#watchUrl(url, waitUntil, timeout);
    });
  }
  // A RegExp or a predicate runs in the agent's own Node, so Kamapathy
  // reports this page's commits and the client tests them itself.
  async #watchUrl(matcher, waitUntil, timeout) {
    const deadline = Date.now() + timeout;
    const left = () => Math.max(0, deadline - Date.now());
    const expected =
      typeof matcher === "function" ? "a URL predicate" : matcher.source;
    const matches = (address) => {
      if (typeof matcher !== "function") {
        matcher.lastIndex = 0;
        return matcher.test(address);
      }
      // A predicate never sees an address that does not parse.
      try {
        return !!matcher(new URL(address));
      } catch {
        return false;
      }
    };
    // One watch request. The client holds the matcher, so it raises the
    // timeout itself, naming what it waited for.
    const watch = async (after) => {
      try {
        return await this.#post("wait-for-url", {
          ...(after === undefined ? {} : { after }),
          timeoutMs: left(),
        });
      } catch (error) {
        if (error instanceof KamapathyError && error.code === "wait_timeout")
          throw urlTimeout(timeout, error.lastUrl ?? this.url, expected);
        throw error;
      }
    };
    let after;
    for (;;) {
      const answer = this.#refreshed(await watch(after));
      // The URL at entry or every commit since, oldest first, then the one
      // the page shows now.
      const found = [
        ...(answer.committed ?? []).map((commit) => commit.url),
        answer.url,
      ].find(matches);
      if (found !== undefined) {
        // The state the script asked for, inside the same deadline.
        const { tab } = this.#refreshed(
          await this.#post("wait-for-load-state", {
            state: waitUntil,
            timeoutMs: left(),
          }),
        );
        return { ok: true, tab, url: found };
      }
      const popup = (answer.popups ?? []).find((item) => matches(item.url));
      if (popup) throw openedInPopup(this.label ?? this.id, answer.url, popup);
      if (left() === 0) throw urlTimeout(timeout, answer.url, expected);
      // A candidate popup makes the watch answer at once, so the client
      // paces itself instead of asking again with nothing new to see.
      if (after === answer.navigation)
        await sleep(Math.min(WATCH_TICK_MS, left()), this.#session.signal);
      after = answer.navigation;
    }
  }
  /**
   * Waits for the document the page shows to reach a state, following a
   * navigation already in flight.
   * @param {WaitUntil} [state] load by default.
   * @param {{ timeout?: number, idleMs?: number }} [options] `idleMs` is the
   * quiet window networkidle asks for, 500 by default.
   * @returns {Promise<{ ok: true, tab: object, state: WaitUntil }>}
   */
  waitForLoadState(state = "load", options = {}) {
    return this.#call("waitForLoadState", [state, options], async () => {
      const { timeout = 10000, idleMs = 500 } = options;
      return this.#refreshed(
        await this.#post("wait-for-load-state", {
          state,
          idleMs,
          timeoutMs: timeout,
        }),
      );
    });
  }
  /**
   * Waits for an element to be attached, visible, hidden or detached.
   * @param {Target} selector
   * @param {{ state?: "attached" | "visible" | "hidden" | "detached", timeout?: number }} [options]
   * @returns {Promise<{ ok: true, tab: object, state: string, matched: number }>}
   */
  waitForSelector(selector, options = {}) {
    return this.#call("waitForSelector", [selector, options], async () => {
      const { state = "visible", timeout = 10000 } = options;
      return this.#refreshed(
        await this.#post("wait-for-selector", {
          ...target(selector),
          state,
          timeoutMs: timeout,
        }),
      );
    });
  }
  /**
   * Waits for a function in the page to return a truthy value.
   * @param {Function | string} pageFunction A function called with `arg`, or
   * an expression.
   * @param {unknown} [arg] The one JSON argument the function is called with.
   * @param {{ timeout?: number, interval?: number }} [options]
   * @returns {Promise<{ ok: true, tab: object, value?: unknown, unserializable?: string }>}
   */
  async waitForFunction(pageFunction, arg, options = {}) {
    // Options in the argument's place would be sent to the page as the
    // function's own argument, which is almost never what the script meant.
    if (misplacedOptions(arg)) {
      const { expected } = findEntry("Page.waitForFunction");
      throw new KamapathyError(
        "invalid_argument",
        `page.waitForFunction got options in the argument's place. Expected ${expected}.`,
        { entry: "page.waitForFunction", expected },
      );
    }
    return this.#call(
      "waitForFunction",
      [pageFunction, arg, options],
      async () => {
        const { timeout = 10000, interval = 100 } = options;
        const source =
          typeof pageFunction === "function"
            ? { function: String(pageFunction) }
            : { expression: pageFunction };
        return this.#refreshed(
          await this.#post("wait-for-function", {
            ...source,
            ...(arg === undefined ? {} : { arg }),
            intervalMs: interval,
            timeoutMs: timeout,
          }),
        );
      },
    );
  }
  /**
   * Sleeps in the script and sends nothing. Prefer a wait on what the page
   * does.
   * @param {number} ms 0 to 600000.
   * @returns {Promise<void>}
   */
  async waitForTimeout(ms) {
    checkNow(this.#session, "Page.waitForTimeout", [ms]);
    await sleep(ms, this.#session.signal);
  }
  /**
   * Reads bounded visible text and controls with refs.
   * @param {SnapshotOptions} [options]
   * @returns {Promise<Snapshot>}
   */
  snapshot(options = {}) {
    return this.#call("snapshot", [options], async () => {
      const data = await this.#post("snapshot", { mode: "compact", ...options });
      this.url = data.url;
      this.title = data.title;
      return data;
    });
  }
  /**
   * The same compact text the CLI's snapshot command prints.
   * @param {SnapshotOptions} [options]
   * @returns {Promise<string>}
   */
  text(options) {
    return this.#call("text", [options], async () =>
      formatSnapshot(await this.snapshot(options)),
    );
  }
  /**
   * Clicks a control, waiting until it can take the press.
   * @param {Target} control
   * @param {PointerOptions} [options]
   * @returns {Promise<{ ok: true, url: string, point: Point, loading?: true, fallback?: "dom_click", rebound?: string[] }>}
   */
  click(control, options) {
    return this.#call("click", [control, options], () =>
      this.#post("click", {
        ...target(control),
        ...pointerOptions(options, "page.click"),
      }),
    );
  }
  /**
   * Double-clicks a control with one gesture of two presses.
   * @param {Target} control
   * @param {PointerOptions} [options] Without clickCount.
   * @returns {Promise<{ ok: true, url: string, point: Point, loading?: true, fallback?: "dom_click", rebound?: string[] }>}
   */
  dblclick(control, options) {
    return this.#call("dblclick", [control, options], () =>
      this.#post("dblclick", {
        ...target(control),
        ...pointerOptions(options, "page.dblclick"),
      }),
    );
  }
  /**
   * Moves the mouse onto a control and leaves it there.
   * @param {Target} control
   * @param {{ position?: Point | string, force?: boolean, timeout?: number, label?: string }} [options]
   * @returns {Promise<{ ok: true, point: Point, rebound?: string[] }>}
   */
  hover(control, options) {
    return this.#call("hover", [control, options], () =>
      this.#post("hover", {
        ...target(control),
        ...pointerOptions(options, "page.hover"),
      }),
    );
  }
  /**
   * Replaces the value of a field, select or editable region, or adds to it.
   * @param {Target} control
   * @param {string} value
   * @param {{ append?: boolean, timeout?: number, label?: string }} [options]
   * @returns {Promise<{ ok: true, match: string, value?: string, valueHidden?: true, rebound?: string[] }>}
   */
  fill(control, value, options) {
    return this.#call("fill", [control, value, options], () =>
      this.#post("fill", {
        ...target(control),
        value,
        ...pointerOptions(options, "page.fill"),
      }),
    );
  }
  /**
   * Chooses a select's options by value, label or index. A lone choice is
   * wrapped; null and [] clear the select.
   * @param {Target} control
   * @param {string | SelectChoice | null | (string | SelectChoice)[]} values
   * @param {{ timeout?: number, label?: string }} [options]
   * @returns {Promise<{ ok: true, values: string[], rebound?: string[] }>}
   */
  selectOption(control, values, options) {
    return this.#call("selectOption", [control, values, options], () =>
      this.#post("select", {
        ...target(control),
        values: choices(values),
        ...pointerOptions(options, "page.selectOption"),
      }),
    );
  }
  /**
   * Focuses a control, retargeting to the nearest one that takes focus.
   * @param {Target} control
   * @param {{ timeout?: number, label?: string }} [options]
   * @returns {Promise<{ ok: true, rebound?: string[] }>}
   */
  focus(control, options) {
    return this.#call("focus", [control, options], () =>
      this.#post("focus", {
        ...target(control),
        ...pointerOptions(options, "page.focus"),
      }),
    );
  }
  /**
   * Presses a key name, a printable character or a chord, focusing a
   * control first when given. The key may come first or second: a chord is
   * the key and anything else is the target.
   * @param {string} key
   * @param {Target} [control] Focus this control first.
   * @param {{ delay?: number, timeout?: number, label?: string }} [options]
   * @returns {Promise<{ ok: true, url: string, loading?: true, rebound?: string[] }>}
   */
  press(key, control, options) {
    return this.#call("press", [key, control, options], () => {
      const pressed = pressArguments(key, control);
      return this.#post("press", {
        key: pressed.key,
        ...(pressed.target ? target(pressed.target) : {}),
        ...pointerOptions(options, "page.press"),
      });
    });
  }
  /**
   * Scrolls the page, the panel holding a control, or the panel in the
   * middle when the page cannot scroll. A target may take the pixels' place.
   * @param {"up" | "down" | "left" | "right"} direction
   * @param {number} [pixels] 1 to 2000, default 600.
   * @param {Target} [control]
   * @param {ActionOptions} [options]
   * @returns {Promise<{ ok: true, scrolled: "page" | "element", selector?: string, x: number, y: number, moved: boolean }>}
   */
  scroll(direction, pixels, control, options) {
    return this.#call("scroll", [direction, pixels, control, options], () => {
      // A target in the pixels' place moves the options along with it.
      if (typeof pixels === "string")
        [pixels, control, options] = [undefined, pixels, control];
      return this.#post("scroll", {
        direction,
        ...(pixels !== undefined ? { pixels } : {}),
        ...(control ? target(control) : {}),
        ...labelOf(options),
      });
    });
  }
  /**
   * Drags one element onto another with native mouse input or HTML drag and drop.
   * @param {Target} source
   * @param {Target} destination
   * @param {ActionOptions} [options]
   * @returns {Promise<{ ok: true, url: string, drag: "html5" | "mouse", rebound?: string[] }>}
   */
  drag(source, destination, options) {
    return this.#call("drag", [source, destination, options], () =>
      this.#post("drag", {
        source: target(source),
        target: target(destination),
        ...labelOf(options),
      }),
    );
  }
  /**
   * Drags one element onto another, with its own positions and a button.
   * @param {Target} source
   * @param {Target} destination
   * @param {{ sourcePosition?: Point | string, targetPosition?: Point | string, button?: "left" | "middle" | "right", force?: boolean, timeout?: number, label?: string }} [options]
   * @returns {Promise<{ ok: true, url: string, drag: "html5" | "mouse", loading?: true, rebound?: string[] }>}
   */
  dragAndDrop(source, destination, options) {
    return this.#call("dragAndDrop", [source, destination, options], () =>
      this.#post("drag", {
        source: target(source),
        target: target(destination),
        ...pointerOptions(options, "page.dragAndDrop"),
      }),
    );
  }
  /**
   * Waits for a visible element, text, or both.
   * @param {WaitOptions} [options]
   * @returns {Promise<{ ok: true }>}
   */
  wait(options = {}) {
    return this.#call("wait", [options], () => this.#post("wait", options));
  }
  /**
   * Runs 1 to 20 actions in order. Stops at the first failure and throws a
   * KamapathyError carrying `results` and `failedIndex`; earlier steps may
   * already have changed the page.
   * @param {Action[]} actions
   * @returns {Promise<BatchResult>}
   */
  batch(actions) {
    return this.#call("batch", [actions], () =>
      this.#post("actions", { actions }),
    );
  }
  /**
   * Selects local files on a file input. The site may upload them at once.
   * @param {string} ref A file input ref from a current snapshot.
   * @param {string[]} files 1 to 8 paths, at most 16 MiB together.
   * @returns {Promise<{ ok: true, selected: number }>}
   */
  upload(ref, files) {
    return this.#call("upload", [ref, files], async () =>
      this.#post(
        "upload",
        { ref: uploadRef(ref), files: await readUploadFiles(files) },
        { limit: UPLOAD_BODY_LIMIT },
      ),
    );
  }
  /**
   * Puts local files on the file input a target names, retargeting from a
   * label or the panel around it, hidden inputs included.
   * @param {Target} element A ref or any selector, hidden or not.
   * @param {string[]} files 0 to 8 paths, at most 16 MiB together. An empty
   * list clears the selection.
   * @param {{ timeout?: number }} [options] How long to wait for the target,
   * 3000 by default.
   * @returns {Promise<{ ok: true, selected: number }>} With what the action
   * caused.
   */
  setInputFiles(element, files, options = {}) {
    return this.#call("setInputFiles", [element, files, options], async () =>
      this.#post(
        "set-input-files",
        {
          ...target(element),
          files: await fileBodies(files),
          ...(options.timeout === undefined
            ? {}
            : { timeoutMs: options.timeout }),
        },
        { limit: UPLOAD_BODY_LIMIT },
      ),
    );
  }
  /**
   * Captures the page as PNG: the viewport, the whole page or a clip, at CSS
   * scale by default. Never overwrites an existing file.
   * @param {ScreenshotOptions | string} [target] Options, or a .png path.
   * @returns {Promise<Buffer | string>} The PNG bytes, or the absolute path
   * written when a path string is given.
   */
  screenshot(target = {}) {
    return this.#call("screenshot", [target], async () => {
      if (typeof target === "string") {
        const output = pngPath(target);
        const bytes = await this.#session.request(
          `/tabs/${this.id}/screenshot`,
          { response: "png" },
        );
        await writeFile(output, bytes, { flag: "wx" });
        return output;
      }
      const { path, timeout, ...rest } = target;
      const output = path === undefined ? undefined : pngPath(path);
      const bytes = await this.#post(
        "screenshot",
        { ...rest, ...(timeout === undefined ? {} : { timeoutMs: timeout }) },
        { response: "png" },
      );
      if (output !== undefined) await writeFile(output, bytes, { flag: "wx" });
      return bytes;
    });
  }
  /**
   * Reads a PDF's text by page, without entering Chromium's viewer.
   * Continue a truncated read from nextPage.
   * @param {{ from?: number, to?: number, maxChars?: number, timeout?: number }} [options]
   * @returns {Promise<PdfText>}
   */
  pdfText(options = {}) {
    return this.#call("pdfText", [options], () => {
      const { timeout, ...fields } = options;
      return this.#post("pdf/text", {
        ...fields,
        ...(timeout === undefined ? {} : { timeoutMs: timeout }),
      });
    });
  }
  /**
   * Arms a wait for the tab's next popup, download, file chooser or dialog.
   * The arm is sent as this is called and every later call on this page
   * waits for it, so `const next = page.waitForEvent("popup")` before
   * `await page.click("#share")` cannot miss the popup.
   * @param {"popup" | "download" | "filechooser" | "dialog"} event
   * @param {{ timeout?: number }} [options] 1 to 60000 ms, 10000 by default.
   * @returns {Promise<Page | Download | FileChooser | DialogRecord>}
   */
  waitForEvent(event, options = {}) {
    // A second arm queues behind the first, so the barrier covers both.
    const previous = this.#armed;
    const armed = call(
      this.#session,
      "Page.waitForEvent",
      [event, options],
      async () => {
        if (previous) await previous;
        await this.#find();
        const { expectation } = await this.#post("expectations", {
          event,
          ...(options.timeout === undefined
            ? {}
            : { timeoutMs: options.timeout }),
        });
        return expectation;
      },
    );
    this.#armed = armed;
    const settled = () => {
      if (this.#armed === armed) this.#armed = null;
    };
    return armed.then(
      (expectation) => {
        settled();
        // The poll is the wait itself, so it passes no barrier of its own.
        return call(
          this.#session,
          "Page.waitForEvent",
          [event, options],
          async () => {
            const path = `/expectations/${expectation.id}/wait`;
            return this.#event(
              await this.#session.request(path, {
                method: "POST",
                body: {},
                budgetMs: budgetOf("POST", path),
              }),
            );
          },
        );
      },
      (error) => {
        settled();
        throw error;
      },
    );
  }
  // What an armed wait answers with: a Page, a Download, a FileChooser, or
  // the dialog record as Kamapathy recorded it.
  #event(answer) {
    if (answer.popup) return this.#popup(answer.popup);
    if (answer.download) return new Download(this.#session, answer.download);
    if (answer.fileChooser)
      return new FileChooser(this.#session, answer.fileChooser);
    if (answer.dialog) return answer.dialog;
    throw new KamapathyError(
      "invalid_response",
      "The wait answered with no popup, download, file chooser or dialog.",
    );
  }
  // A page this page opened, from a wait's answer or the popup list, which
  // name neither the space nor the opener.
  #popup(tab) {
    return new Page(this.#session, {
      spaceId: this.spaceId,
      openerId: this.id,
      openedBy: "page",
      ...tab,
    });
  }
  /** @returns {Promise<Page[]>} The open tabs this tab opened. */
  popups() {
    return this.#call("popups", [], async () => {
      const { popups } = await this.#session.request(`/tabs/${this.id}/popups`);
      return popups.map((tab) => this.#popup(tab));
    });
  }
  /**
   * Arms how the tab answers its next confirms and prompts, before the
   * action that opens one, or clears the policy with null.
   * @param {{ accept: boolean, promptText?: string, times?: number,
   *           lifetime?: number } | null} policy
   * @returns {Promise<{ policy: DialogPolicy | null }>}
   */
  setDialogPolicy(policy) {
    return this.#call("setDialogPolicy", [policy], () => {
      const path = `/tabs/${this.id}/dialog-policy`;
      if (policy === null)
        return this.#session.request(path, { method: "DELETE" });
      const body = dialogPolicyBody(policy);
      const problem = checkBody(matchRoute("POST", path), body);
      if (problem)
        throw new KamapathyError(problem.code, problem.message, problem.fields);
      return this.#post("dialog-policy", body);
    });
  }
  /**
   * The tab's dialog policy and the last 20 dialogs Kamapathy answered in
   * it, oldest first.
   * @returns {Promise<{ policy: DialogPolicy | null, dialogs: DialogRecord[] }>}
   */
  dialogs() {
    return this.#call("dialogs", [], () =>
      this.#session.request(`/tabs/${this.id}/dialogs`),
    );
  }
  /**
   * The open page that opened this popup.
   * @returns {Promise<Page | null>}
   */
  opener() {
    return this.#call("opener", [], async () => {
      if (!this.openerId) return null;
      const { tabs } = await this.#session.request(
        `/spaces/${this.spaceId}/tabs`,
      );
      const opener = tabs.find((tab) => tab.id === this.openerId);
      return opener ? new Page(this.#session, opener) : null;
    });
  }
  /**
   * Lets go of every key and mouse button this page holds. A run sends it
   * for each page it touched.
   * @returns {Promise<{ ok: true, released: string[] }>}
   */
  releaseInput() {
    return this.#call("releaseInput", [], () =>
      this.#post("input/release", {}, { budgetMs: RELEASE_BUDGET_MS }),
    );
  }
  /** @returns {Promise<{ ok: true }>} */
  close() {
    return this.#call("close", [], () =>
      this.#session.request(`/tabs/${this.id}`, { method: "DELETE" }),
    );
  }
  /**
   * Runs a function or an expression in the page's main frame and returns
   * its value. A function is sent as its source and called with `arg`, so it
   * cannot see this script's variables; an expression takes no argument and
   * may use top-level await. Needs Page scripts on.
   * @param {Function | string} fnOrString
   * @param {unknown} [arg] JSON data: no BigInt, NaN, Infinity, function,
   * symbol or cycle.
   * @param {{ timeout?: number }} [options] 2000 to 60000 ms, 15000 by default.
   * @returns {Promise<unknown>} The value, with NaN, Infinity, -0 and a
   * BigInt as themselves, and undefined when there is none.
   */
  evaluate(fnOrString, arg, options = {}) {
    return this.#call("evaluate", [fnOrString, arg, options], async () => {
      if (typeof fnOrString === "string" && arg !== undefined) {
        const { expected } = findEntry("Page.evaluate");
        throw new KamapathyError(
          "invalid_argument",
          `page.evaluate got an argument for an expression, which takes none. Pass a function to give it one, such as page.evaluate((x) => x * 2, 21). Expected ${expected}.`,
          { entry: "page.evaluate", expected },
        );
      }
      const { timeout = 15000 } = options;
      const answer = await this.#post(
        "evaluate",
        {
          ...scriptSource(fnOrString),
          ...(arg === undefined ? {} : { arg }),
          timeoutMs: timeout,
        },
        { limit: SCRIPT_LIMIT },
      );
      return decodeValue(this.#refreshed(answer));
    });
  }
}

/** One download Kamapathy holds for the agent in its space. */
export class Download {
  #session;
  #data;
  /** @type {{ folder: string, file: string } | null} The copy path() wrote. */
  #copy = null;
  /**
   * @param {Session} session
   * @param {{ id: string, tabId: string, url: string, suggestedFilename: string,
   *   mimeType: string, state: string, receivedBytes: number,
   *   totalBytes: number, failure: string | null }} download
   */
  constructor(session, download) {
    this.#session = session;
    this.#data = download;
  }
  /** @returns {string} The address the download came from. */
  url() {
    return this.#data.url;
  }
  /** @returns {string} The file name the site suggested. */
  suggestedFilename() {
    return this.#data.suggestedFilename;
  }
  /** @returns {Page} The page it started in, which may since have closed. */
  page() {
    return new Page(this.#session, { id: this.#data.tabId });
  }
  #stream(path, mode) {
    const from = `/downloads/${this.#data.id}/content`;
    return streamTo(this.#session, path, {
      from,
      downloadId: this.#data.id,
      mode,
      budgetMs: budgetOf("GET", from),
    });
  }
  // Waits in long polls until the record stops progressing: the caller's
  // timeout, or what is left of the run, bounds the whole wait. A download
  // that failed has no bytes, and says so.
  async #ready(timeout) {
    const limit = timeout ?? timeLeft(this.#session);
    const until = Date.now() + limit;
    const path = `/downloads/${this.#data.id}/wait`;
    while (this.#data.state === "progressing") {
      const left = until - Date.now();
      if (left <= 0)
        throw new KamapathyError(
          "download_timeout",
          `The download was still running after ${limit} ms. Wait for it again, or cancel it.`,
          {
            awaited: "download",
            downloadId: this.#data.id,
            receivedBytes: this.#data.receivedBytes,
            totalBytes: this.#data.totalBytes,
            timeoutMs: limit,
            retryable: true,
          },
        );
      const timeoutMs = Math.max(Math.min(30000, left), 1);
      try {
        const { download } = await this.#session.request(path, {
          method: "POST",
          body: { timeoutMs },
          budgetMs: timeoutMs,
        });
        this.#data = download;
      } catch (error) {
        // Kamapathy's own poll ran out; what it saw carries over and the
        // next one asks again.
        if (
          !(error instanceof KamapathyError) ||
          error.code !== "download_timeout"
        )
          throw error;
        this.#data = {
          ...this.#data,
          receivedBytes: error.receivedBytes ?? this.#data.receivedBytes,
          totalBytes: error.totalBytes ?? this.#data.totalBytes,
        };
      }
    }
    const failure =
      this.#data.failure ??
      (this.#data.state === "completed" ? null : this.#data.state);
    if (failure)
      throw new KamapathyError(
        "download_failed",
        `This download ended as ${failure}, so it has no bytes to read.`,
        { failure },
      );
  }
  /**
   * Waits for the download, then writes its bytes to a new file at mode
   * 0600, creating missing folders. It never overwrites.
   * @param {string} path Where to write, on this computer.
   * @param {{ timeout?: number }} [options] How long to wait for the
   * download, what is left of the run by default.
   * @returns {Promise<string>} The absolute path written.
   */
  saveAs(path, options = {}) {
    return call(this.#session, "Download.saveAs", [path, options], async () => {
      const output = resolve(path);
      await this.#ready(options.timeout);
      await mkdir(dirname(output), { recursive: true });
      await this.#stream(output, 0o600);
      receivedIn(this.#session).add(this.#data.id);
      return output;
    });
  }
  /**
   * A private copy of the download on this computer, in a folder only this
   * account can read.
   * @returns {Promise<string>} The copy's path, which delete() removes.
   */
  path() {
    return call(this.#session, "Download.path", [], async () => {
      if (this.#copy) return this.#copy.file;
      await this.#ready();
      const folder = await mkdtemp(join(tmpdir(), "kamapathy-download-"));
      const file = join(folder, copyName(this.#data));
      try {
        await this.#stream(file, 0o600);
      } catch (error) {
        await rm(folder, { recursive: true, force: true });
        throw error;
      }
      this.#copy = { folder, file };
      rememberCopy(folder);
      receivedIn(this.#session).add(this.#data.id);
      return file;
    });
  }
  /**
   * Why the download did not finish, read again while it still runs.
   * @returns {Promise<null | "cancelled" | "interrupted" | "too_large">}
   */
  failure() {
    return call(this.#session, "Download.failure", [], async () => {
      if (this.#data.state === "progressing") {
        const { download } = await this.#session.request(
          `/downloads/${this.#data.id}`,
        );
        this.#data = download;
      }
      return this.#data.failure ?? null;
    });
  }
  /** Stops a download still running. @returns {Promise<{ download: object }>} */
  cancel() {
    return call(this.#session, "Download.cancel", [], async () => {
      const result = await this.#session.request(
        `/downloads/${this.#data.id}/cancel`,
        { method: "POST", body: {} },
      );
      if (result.download) this.#data = result.download;
      return result;
    });
  }
  /**
   * Deletes the download's bytes from the browser's profile, and the
   * private copy path() wrote.
   * @returns {Promise<{ ok: true }>}
   */
  delete() {
    return call(this.#session, "Download.delete", [], async () => {
      const copy = this.#copy;
      this.#copy = null;
      if (copy) {
        copies.delete(copy.folder);
        await rm(copy.folder, { recursive: true, force: true });
      }
      receivedIn(this.#session).delete(this.#data.id);
      return this.#session.request(`/downloads/${this.#data.id}`, {
        method: "DELETE",
      });
    });
  }
}

/** A file chooser Kamapathy held back while a wait was armed. */
export class FileChooser {
  #session;
  #data;
  /**
   * @param {Session} session
   * @param {{ id: string, tabId: string, multiple: boolean, accept: string[] }} chooser
   */
  constructor(session, chooser) {
    this.#session = session;
    this.#data = chooser;
  }
  /** @returns {Page} The page whose chooser this is. */
  page() {
    return new Page(this.#session, { id: this.#data.tabId });
  }
  /** @returns {boolean} Whether the input takes more than one file. */
  isMultiple() {
    return this.#data.multiple === true;
  }
  /**
   * Puts local files on the chooser's input, even one the page has removed.
   * @param {string[]} files 0 to 8 paths, at most 16 MiB together. An empty
   * list cancels the chooser.
   * @returns {Promise<{ ok: true, selected: number }>}
   */
  setFiles(files) {
    return call(this.#session, "FileChooser.setFiles", [files], async () =>
      this.#session.request(`/file-choosers/${this.#data.id}/files`, {
        method: "POST",
        body: { files: await fileBodies(files) },
        limit: UPLOAD_BODY_LIMIT,
      }),
    );
  }
}

/** An agent space the API can reach. */
export class Space {
  #session;
  #user;
  /**
   * @param {Session} session
   * @param {{ id: string, name: string, owner: "agent" | "human", signIns?: "shared" | "separate" }} info
   * @param {Page | null} [user] The page the person left, as userPage().
   */
  constructor(session, info, user = null) {
    this.#session = session;
    this.#user = user;
    /** @type {string} */
    this.id = info.id;
    /** @type {string} */
    this.name = info.name;
    /** @type {"agent" | "human"} Who controls the space; handoff and resume update it. */
    this.owner = info.owner;
    /** @type {"shared" | "separate" | undefined} Whether the space uses the person's sign-ins. */
    this.signIns = info.signIns;
    /** @type {"agent" | "personal" | undefined} */
    this.kind = info.kind;
    /** @type {"agent" | "person" | undefined} */
    this.createdBy = info.createdBy;
    /** @type {number | undefined} Pages the agent may manage at once. */
    this.pageBudget = info.pageBudget;
    /** @type {string | undefined} Why the person has control, while they have it. */
    this.reason = info.reason;
    /** @type {string | undefined} What the person is asked to answer. */
    this.prompt = info.prompt;
    /** @type {number | undefined} When the person got control. */
    this.since = info.since;
    /** @type {string | undefined} The status the person is reading. */
    this.status = info.status;
    /** @type {"needs-you" | "done" | "failed" | "error" | undefined} How the space stands. */
    this.state = info.state;
  }
  #call(name, args, send) {
    return call(this.#session, `Space.${name}`, args, send);
  }
  // Tab ids for pages given as Pages, ids or labels. Labels resolve with one
  // tabs request for the whole call.
  async #ids(pages) {
    const labelOf = (page) =>
      isLabel(page)
        ? page
        : typeof page === "object" && page.id === undefined
          ? page.label
          : undefined;
    const labels = pages.map(labelOf).filter(Boolean);
    const tabs = labels.length
      ? await resolveLabels(this.#session, this.id, labels)
      : [];
    return pages.map((page) => {
      const label = labelOf(page);
      if (label === undefined) return typeof page === "string" ? page : page.id;
      const tab = tabs.find((item) => item.label === label);
      if (page instanceof Page) page[REFRESH](tab);
      return tab.id;
    });
  }
  // Pages for a boundary's tabs. Older apps answer without one.
  #boundary(result) {
    if (!("active" in result)) return result;
    this.#user = result.active ? new Page(this.#session, result.active) : null;
    return {
      ...result,
      active: this.#user,
      opened: (result.opened ?? []).map((tab) => new Page(this.#session, tab)),
    };
  }
  /**
   * The page with this label, such as p2. It finds its tab when first used
   * and keeps it.
   * @param {string} label
   * @returns {Page}
   */
  page(label) {
    checkNow(this.#session, "Space.page", [label]);
    return new Page(this.#session, { label, spaceId: this.id });
  }
  /** @returns {Promise<Page[]>} The pages the agent manages, in tab order. */
  pages() {
    return this.#call("pages", [], async () => {
      const { tabs } = await this.#session.request(`/spaces/${this.id}/tabs`);
      return tabs
        .filter((tab) => tab.managed)
        .map((tab) => new Page(this.#session, tab));
    });
  }
  /**
   * Opens a blank background page.
   * @returns {Promise<Page>}
   */
  newPage() {
    return this.#call("newPage", [], async () => {
      const { tab } = await this.#session.request(`/spaces/${this.id}/tabs`, {
        method: "POST",
        body: {},
      });
      return new Page(this.#session, tab);
    });
  }
  /**
   * Makes a page the agent did not open its own, within the page budget.
   * @param {Page | string} page A Page, a tab ID or a label.
   * @returns {Promise<Page>}
   */
  adopt(page) {
    return this.#call("adopt", [page], () => this.#managed(page, "adopt"));
  }
  /**
   * Gives a page the agent did not open back to the person. It stays open.
   * @param {Page | string} page A Page, a tab ID or a label.
   * @returns {Promise<Page>}
   */
  release(page) {
    return this.#call("release", [page], () => this.#managed(page, "release"));
  }
  async #managed(page, route) {
    const [id] = await this.#ids([page]);
    const { tab } = await this.#session.request(`/tabs/${id}/${route}`, {
      method: "POST",
      body: {},
    });
    return page instanceof Page
      ? page[REFRESH](tab)
      : new Page(this.#session, tab);
  }
  /**
   * Ends the agent's task: closes the pages it does not keep and ends its
   * access. The person's tabs and pages the agent never adopted stay.
   * @param {{ keep: "all" | (Page | string)[] }} options
   * @returns {Promise<{ ok: true, spaceId: string, closedSpace: boolean, closed: string[], kept: string[], protected: string[] }>}
   */
  finish(options) {
    return this.#call("finish", [options], async () =>
      this.#session.request(`/spaces/${this.id}/finish`, {
        method: "POST",
        body: {
          keep:
            options.keep === "all" ? "all" : await this.#ids(options.keep),
        },
      }),
    );
  }
  /**
   * Waits until the agent has control, at once when it has, and reports
   * what changed meanwhile.
   * @param {{ timeout?: number }} [options] Up to 600000 ms, the default.
   * @returns {Promise<{ ok: true, owner: "agent", active: Page | null, opened: Page[], closed: string[] }>}
   */
  waitForControl(options = {}) {
    return this.#call("waitForControl", [options], async () => {
      const result = await this.#session.request(
        `/spaces/${this.id}/wait-for-control`,
        {
          method: "POST",
          body:
            options.timeout === undefined ? {} : { timeoutMs: options.timeout },
        },
      );
      this.owner = result.owner;
      return this.#boundary(result);
    });
  }
  /**
   * The page the space showed when control last came back to this object.
   * @returns {Page | null}
   */
  userPage() {
    checkNow(this.#session, "Space.userPage", []);
    return this.#user;
  }
  /**
   * Opens a background tab.
   * @param {string} url
   * @returns {Promise<Page>}
   */
  open(url) {
    return this.#call("open", [url], async () => {
      const { tab } = await this.#session.request(`/spaces/${this.id}/tabs`, {
        method: "POST",
        body: { url },
      });
      return new Page(this.#session, tab);
    });
  }
  /** @returns {Promise<Page[]>} */
  tabs() {
    return this.#call("tabs", [], async () => {
      const { tabs } = await this.#session.request(`/spaces/${this.id}/tabs`);
      return tabs.map((tab) => new Page(this.#session, tab));
    });
  }
  /**
   * Shows the person what the agent is doing, and updates `status`.
   * @param {string | null} text At most 120 characters; null or "" clears it.
   * @returns {Promise<{ ok: true, status?: string }>}
   */
  setStatus(text) {
    return this.#call("setStatus", [text], async () => {
      const result = await this.#session.request(`/spaces/${this.id}/status`, {
        method: "POST",
        body: { text: text ?? "" },
      });
      this.status = result.status;
      return result;
    });
  }
  /**
   * Reports that the task cannot be done and hands the space to the person,
   * updating `owner`, `state` and `status`.
   * @param {string} message At most 300 characters.
   * @returns {Promise<{ ok: true, owner: "human", state: "failed", status: string }>}
   */
  fail(message) {
    return this.#call("fail", [message], async () => {
      const result = await this.#session.request(`/spaces/${this.id}/fail`, {
        method: "POST",
        body: { message },
      });
      this.owner = result.owner;
      this.state = result.state;
      this.status = result.status;
      return result;
    });
  }
  /**
   * The downloads this space holds, newest first.
   * @returns {Promise<Download[]>}
   */
  downloads() {
    return this.#call("downloads", [], async () => {
      const { downloads } = await this.#session.request(
        `/spaces/${this.id}/downloads`,
      );
      return downloads.map((item) => new Download(this.#session, item));
    });
  }
  /**
   * Stores a name and password for one origin, in Kamapathy's memory only,
   * to answer the first server sign-in from that origin in this space's own
   * pages.
   * @param {{ origin: string, username: string, password: string } | null} credentials
   * null forgets every origin the space stored.
   * @returns {Promise<{ ok: true, origin?: string }>}
   */
  setHTTPCredentials(credentials) {
    return this.#call("setHTTPCredentials", [credentials], () => {
      const path = `/spaces/${this.id}/http-credentials`;
      if (credentials === null)
        return this.#session.request(path, { method: "DELETE" });
      const problem = checkBody(matchRoute("POST", path), credentials);
      if (problem)
        throw new KamapathyError(problem.code, problem.message, problem.fields);
      return this.#session.request(path, { method: "POST", body: credentials });
    });
  }
  /**
   * Pauses automation so the person can continue, for example to sign in.
   * @returns {Promise<{ ok: true, owner: "human" }>}
   */
  handoff() {
    return this.#call("handoff", [], async () => {
      const result = await this.#session.request(`/spaces/${this.id}/handoff`, {
        method: "POST",
        body: {},
      });
      this.owner = result.owner;
      return result;
    });
  }
  /**
   * Takes control back once the reason for the handoff is finished.
   * @returns {Promise<{ ok: true, owner: "agent" }>}
   */
  resume() {
    return this.#call("resume", [], async () => {
      const result = await this.#session.request(`/spaces/${this.id}/resume`, {
        method: "POST",
        body: {},
      });
      this.owner = result.owner;
      return this.#boundary(result);
    });
  }
  /** Closes the space and its tabs. @returns {Promise<{ ok: true }>} */
  close() {
    return this.#call("close", [], () =>
      this.#session.request(`/spaces/${this.id}`, { method: "DELETE" }),
    );
  }
}

// A site pack target as the library reads it: a Page by the last url it
// recorded, anything else as it was given.
const siteTarget = (target) =>
  target instanceof Page ? { url: target.url } : target;

/** A connected Kamapathy. */
export class Client {
  #session;
  /** @param {Session} session */
  constructor(session) {
    this.#session = session;
  }
  /**
   * The running Kamapathy's version and API level, once it was found.
   * `update` is present while a newer version waits.
   * @returns {{ version?: string, apiLevel: number, electron?: string, chromium?: string, node?: string, update?: { version: string, state: "available" | "downloading" | "ready" } } | null}
   */
  get app() {
    return this.#session.app;
  }
  #call(name, args, send) {
    return call(this.#session, `Client.${name}`, args, send);
  }
  // A call answered from the files on this computer: checked against the
  // schema, without the app's level, since it needs no app and sends
  // nothing.
  async #local(name, args, work) {
    const entry = findEntry(`Client.${name}`);
    try {
      const problem = checkCall(entry, args);
      if (problem)
        throw new KamapathyError(problem.code, problem.message, problem.fields);
      return await work();
    } catch (error) {
      if (error instanceof KamapathyError && error.entry === undefined)
        error.entry = entry.signature.split("(")[0];
      throw error;
    }
  }
  // An explicit page budget, or KAMAPATHY_PAGE_BUDGET when it is set.
  #budget(choices) {
    const pageBudget =
      choices.pageBudget ?? pageBudgetFrom(this.#session.env);
    return pageBudget === undefined ? {} : { pageBudget };
  }
  /**
   * Creates a background agent space.
   * @param {string} name
   * @param {{ isolated?: boolean, pageBudget?: number }} [choices]
   * `isolated` gives the space a session of its own instead of the person's
   * sign-ins.
   * @returns {Promise<Space>}
   */
  createSpace(name, choices = {}) {
    return this.#call("createSpace", [name, choices], async () => {
      const { space } = await this.#session.request("/spaces", {
        method: "POST",
        body: {
          name,
          ...(choices.isolated ? { isolated: true } : {}),
          ...this.#budget(choices),
        },
      });
      return new Space(this.#session, space);
    });
  }
  /**
   * The listed space with this ID, or else the first with this name;
   * creates one when none matches.
   * @param {string} nameOrId
   * @param {{ isolated?: boolean, pageBudget?: number }} [choices]
   * @returns {Promise<Space>}
   */
  openSpace(nameOrId, choices = {}) {
    return this.#call("openSpace", [nameOrId, choices], async () => {
      const { space } = await this.#session.request("/spaces", {
        method: "POST",
        body: {
          name: nameOrId,
          reuse: true,
          ...(typeof choices.isolated === "boolean"
            ? { isolated: choices.isolated }
            : {}),
          ...this.#budget(choices),
        },
      });
      return new Space(this.#session, space);
    });
  }
  /**
   * Asks the person to let an agent use one of their spaces and waits for
   * their answer.
   * @param {{ reason: string, name?: string, timeout?: number }} options
   * @returns {Promise<Space>} The granted space; userPage() is the page it shows.
   */
  requestSpace(options) {
    return this.#call("requestSpace", [options], async () => {
      const { space, active } = await this.#session.request(
        "/space-requests",
        {
          method: "POST",
          body: {
            reason: options.reason,
            ...(options.name === undefined ? {} : { name: options.name }),
            ...(options.timeout === undefined
              ? {}
              : { timeoutMs: options.timeout }),
          },
        },
      );
      return new Space(
        this.#session,
        space,
        active ? new Page(this.#session, active) : null,
      );
    });
  }
  /** @returns {Promise<Space[]>} The agent spaces this API session can reach. */
  spaces() {
    return this.#call("spaces", [], async () => {
      const { spaces } = await this.#session.request("/spaces");
      return spaces.map((info) => new Space(this.#session, info));
    });
  }
  /**
   * An accessible space by ID.
   * @param {string} id
   * @returns {Promise<Space>}
   */
  space(id) {
    return this.#call("space", [id], async () => {
      if (
        (await this.#session.appLevel()) >= 2 &&
        /^[a-zA-Z0-9_-]{1,128}$/.test(id)
      ) {
        const { space } = await this.#session.request(`/spaces/${id}`);
        return new Space(this.#session, space);
      }
      const { spaces } = await this.#session.request("/spaces");
      const found = spaces.find((space) => space.id === id);
      if (!found)
        throw new KamapathyError(
          "space_not_found",
          `No accessible agent space has the ID ${String(id)}. Call spaces() to list them.`,
        );
      return new Space(this.#session, found);
    });
  }
  /**
   * Kamapathy's update status. Only the person installs an update.
   * @returns {Promise<UpdateStatus>}
   */
  updateStatus() {
    return this.#call("updateStatus", [], () =>
      this.#session.request("/update", { budgetMs: 0 }),
    );
  }
  /**
   * Asks Kamapathy to check GitHub Releases for a newer version; a check
   * under 60 s old answers from its result.
   * @returns {Promise<UpdateStatus>}
   */
  checkForUpdates() {
    return this.#call("checkForUpdates", [], () =>
      this.#session.request("/update/check", {
        method: "POST",
        body: {},
        budgetMs: 15000,
      }),
    );
  }
  /**
   * Starts or joins the download of this computer's installer and waits for
   * it, then leaves installing to the person.
   * @param {{ timeout?: number, interval?: number }} [options] `timeout` is
   * 0 to 1800000, 600000 by default, and 0 returns once the download is under
   * way; `interval` is how often the status is read, 250 to 10000, 1000 by
   * default.
   * @returns {Promise<UpdateStatus>}
   */
  downloadUpdate(options = {}) {
    return this.#call("downloadUpdate", [options], async () => {
      const { timeout = 600000, interval = 1000 } = options;
      const deadline = Date.now() + timeout;
      let status = await this.#session.request("/update/download", {
        method: "POST",
        body: {},
        budgetMs: 15000,
      });
      for (;;) {
        stopped(status);
        if (["ready", "current"].includes(status.state) || timeout === 0)
          return status;
        const left = deadline - Date.now();
        if (left <= 0) throw new KamapathyError("timeout", DOWNLOAD_TIMEOUT);
        await sleep(Math.min(interval, left), this.#session.signal);
        status = await this.updateStatus();
      }
    });
  }
  /**
   * Every site pack the workspace and the skill hold, or the ones matching a
   * URL, a host or a Page.
   * @param {string | Page} [target]
   * @returns {Promise<{ host?: string | null, packs: SitePack[], skipped: SiteSkipped[] }>}
   */
  sitePacks(target) {
    return this.#local("sitePacks", [target], () =>
      listSitePacks(this.#session.env, siteTarget(target)),
    );
  }
  /**
   * The notes and tools of every pack matching a URL, a host or a Page, each
   * tool with an example call.
   * @param {string | Page} target
   * @returns {Promise<{ url: string, host: string | null, packs: SiteContext[], skipped: SiteSkipped[] }>}
   */
  siteContext(target) {
    return this.#local("siteContext", [target], () =>
      siteContextFor(this.#session.env, siteTarget(target)),
    );
  }
  /**
   * Runs a site pack's Node tool in the agent's own Node.js, with the page,
   * this client and the pack.
   * @param {string} packId
   * @param {string} tool
   * @param {object | undefined} args The arguments the tool declares.
   * @param {{ page: Page }} options
   * @returns {Promise<unknown>} What the tool returned.
   */
  runSiteTool(packId, tool, args, options) {
    return this.#local("runSiteTool", [packId, tool, args, options], () => {
      if (!(options.page instanceof Page))
        throw new KamapathyError(
          "invalid_argument",
          'kamapathy.runSiteTool needs options.page to be a Page from this client, such as the one space.page("p1") returns.',
        );
      return runToolIn(this.#session.env, {
        packId,
        tool,
        args,
        page: options.page,
        client: this,
      });
    });
  }
}

/**
 * Connects to Kamapathy: finds it through the profile's agent folder, starts
 * it when agent access was left on, and checks that it is the Kamapathy that
 * published the endpoint.
 * @param {{ env?: NodeJS.ProcessEnv, lazy?: boolean, connect?: object, fetch?: Function, health?: object, session?: Session }} [options]
 * `env` chooses the profile (`KAMAPATHY_USER_DATA`) and whether starting is
 * allowed (`KAMAPATHY_NO_LAUNCH`). `lazy` waits for the first call to find
 * Kamapathy. `connect`, `fetch` and `health` are for tests.
 * @returns {Promise<Client>}
 */
export async function connect({ env, lazy = false, connect, fetch, health, session } = {}) {
  const current =
    session ??
    new Session({ env: env || process.env, fetch, connect, health, lazy });
  // run and the REPL pass their session in, and they announce an update.
  if (session) session.announceUpdate = true;
  installEndHooks(current);
  if (!lazy) await current.ready();
  return new Client(current);
}

// The three hooks a run's end step runs for this client, in this order: the
// popups nothing reported, the downloads it took bytes from, then the input
// every page it touched still holds. Each is best effort, and a tab or
// download that answers nothing changes nothing. run and the REPL connect
// with a session they already hold, so the set keeps a second connect from
// stacking the hooks up.
const hooked = new WeakSet();
function installEndHooks(session) {
  if (hooked.has(session)) return;
  hooked.add(session);
  session.onRunEnd(async ({ touched, signal }) => {
    const unseen = new Map();
    for (const id of touched) {
      if (signal.aborted) return;
      try {
        const { popups } = await session.request(`/tabs/${id}/popups`);
        for (const popup of popups ?? [])
          if (popup.unseen && !unseen.has(popup.id))
            unseen.set(popup.id, { popup, openedBy: id });
      } catch {}
    }
    const listed = [...unseen.values()];
    for (const { popup, openedBy } of listed.slice(0, POPUP_NOTICES))
      session.notice(
        `popup:${popup.id}`,
        `unused page ${popup.label ?? popup.id} opened by ${labelOrId(
          session,
          openedBy,
        )}: ${popup.url}`,
      );
    const rest = listed.length - POPUP_NOTICES;
    if (rest > 0)
      session.notice(
        "popups:more",
        `and ${rest} more unused ${rest === 1 ? "page" : "pages"} this run opened`,
      );
  });
  session.onRunEnd(async ({ signal }) => {
    const held = receivedIn(session);
    for (const id of [...held]) {
      if (signal.aborted) return;
      held.delete(id);
      try {
        await session.request(`/downloads/${id}`, { method: "DELETE" });
      } catch {}
    }
  });
  // A run lets go of the input of every page it touched, whatever happened
  // to the script, so a held key never outlives it. Failures are not the
  // script's business, and an app without the route is left alone.
  session.onRunEnd(async ({ touched }) => {
    if ((session.app?.apiLevel ?? 0) < RELEASE_LEVEL) return;
    for (const id of touched)
      try {
        await session.request(`/tabs/${id}/input/release`, {
          method: "POST",
          body: {},
          budgetMs: RELEASE_BUDGET_MS,
        });
      } catch {}
  });
}
