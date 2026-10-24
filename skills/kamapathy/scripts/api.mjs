// Kamapathy scripting client. Node built-ins only. It finds Kamapathy the way
// the CLI does and every method sends exactly one documented HTTP route over
// the local socket; nothing here runs inside a page. Each method checks its
// arguments against the schema before anything is sent. The site pack calls
// send nothing at all: they read the workspace and the skill.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { KamapathyError } from "./lib/errors.mjs";
import { formatSnapshot } from "./lib/format.mjs";
import { readUploadFiles, target, uploadRef } from "./lib/input.mjs";
import {
  isLabel,
  pageBudgetFrom,
  resolveLabels,
  Session,
} from "./lib/request.mjs";
import { listSitePacks, runToolIn, siteContextFor } from "./lib/sites.mjs";
import { checkCall, findEntry } from "./schema/index.mjs";

export { help } from "./help.mjs";
export { KamapathyError } from "./lib/errors.mjs";
export * as schema from "./schema/index.mjs";

const UPLOAD_BODY_LIMIT = 24 * 1024 * 1024;

// The label an input method was given, for its body.
const labelOf = (options) =>
  options?.label === undefined ? {} : { label: options.label };

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
 * @typedef {object} ActionOptions
 * @property {string} [label] A few words naming this step, at most 60
 * characters, shown by the agent's cursor and in the agent bar.
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

/** One tab in an agent space. */
export class Page {
  #session;
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
  }
  [REFRESH](tab) {
    for (const key of PAGE_FIELDS)
      if (tab[key] !== undefined) this[key] = tab[key];
    return this;
  }
  #call(name, args, send) {
    return call(this.#session, `Page.${name}`, args, async () => {
      // A page from space.page(label) finds its tab on first use, once.
      if (this.id === undefined) {
        const [tab] = await resolveLabels(this.#session, this.spaceId, [
          this.label,
        ]);
        this[REFRESH](tab);
      }
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
  /**
   * Loads a complete http or https URL. Refs from before become stale.
   * @param {string} url
   * @returns {Promise<Page>} This page, with `url` and `title` updated.
   */
  navigate(url) {
    return this.#call("navigate", [url], async () => {
      const { tab } = await this.#post("navigate", { url });
      return this[REFRESH](tab);
    });
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
   * @param {Target} control
   * @param {ActionOptions} [options]
   * @returns {Promise<{ ok: true, url: string, fallback?: "dom_click", rebound?: string[] }>}
   */
  click(control, options) {
    return this.#call("click", [control, options], () =>
      this.#post("click", { ...target(control), ...labelOf(options) }),
    );
  }
  /**
   * Replaces the value of a field, select or editable region.
   * @param {Target} control
   * @param {string} value
   * @param {ActionOptions} [options]
   * @returns {Promise<{ ok: true, rebound?: string[] }>}
   */
  fill(control, value, options) {
    return this.#call("fill", [control, value, options], () =>
      this.#post("fill", { ...target(control), value, ...labelOf(options) }),
    );
  }
  /**
   * @param {"Enter" | "Tab" | "Escape" | "Backspace" | "Delete" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown" | "Space"} key
   * @param {Target} [control] Focus this control first.
   * @param {ActionOptions} [options]
   * @returns {Promise<{ ok: true, rebound?: string[] }>}
   */
  press(key, control, options) {
    return this.#call("press", [key, control, options], () =>
      this.#post("press", {
        key,
        ...(control ? target(control) : {}),
        ...labelOf(options),
      }),
    );
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
  /** @returns {Promise<{ ok: true }>} */
  close() {
    return this.#call("close", [], () =>
      this.#session.request(`/tabs/${this.id}`, { method: "DELETE" }),
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
  if (!lazy) await current.ready();
  return new Client(current);
}
