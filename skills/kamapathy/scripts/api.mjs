// Kamapathy scripting client. Node built-ins only. It finds Kamapathy the way
// the CLI does and every method sends exactly one documented HTTP route over
// the local socket; nothing here runs inside a page. Each method checks its
// arguments against the schema before anything is sent.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { KamapathyError } from "./lib/errors.mjs";
import { formatSnapshot } from "./lib/format.mjs";
import { readUploadFiles, target, uploadRef } from "./lib/input.mjs";
import { Session } from "./lib/request.mjs";
import { checkCall, findEntry } from "./schema/index.mjs";

export { KamapathyError } from "./lib/errors.mjs";
export * as schema from "./schema/index.mjs";

const UPLOAD_BODY_LIMIT = 24 * 1024 * 1024;

/**
 * @typedef {"@e1" | string} Target A ref such as "@e3" from a current
 * snapshot, or a CSS selector matching exactly one visible element.
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
 * @property {{ value: string, label: string, disabled?: boolean, selected?: boolean }[]} [options]
 */
/**
 * @typedef {object} Snapshot
 * @property {string} tabId
 * @property {string} url
 * @property {string} title
 * @property {string} text
 * @property {Control[]} interactables
 * @property {number} [omittedControls]
 * @property {boolean} truncated
 */
/**
 * @typedef {object} SnapshotOptions
 * @property {"compact" | "full"} [mode] Compact is the default.
 * @property {string} [selector] Scope to one uniquely matching element.
 * @property {number} [maxChars] 0 to 24000.
 * @property {number} [maxControls] 0 to 100.
 */
/**
 * @typedef {object} WaitOptions
 * @property {string} [selector]
 * @property {string} [text]
 * @property {number} [timeoutMs] 0 to 15000, default 5000.
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
 * @typedef {object} BatchResult
 * @property {true} ok
 * @property {{ index: number, type: string, result: object }[]} results
 */

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
    /** @type {string} */
    this.id = tab.id;
    /** @type {string | undefined} */
    this.spaceId = tab.spaceId;
    /** @type {string} Last known URL; navigate and snapshot refresh it. */
    this.url = tab.url;
    /** @type {string} Last known title; navigate and snapshot refresh it. */
    this.title = tab.title;
  }
  #call(name, args, send) {
    return call(this.#session, `Page.${name}`, args, send);
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
      this.url = tab.url;
      this.title = tab.title;
      return this;
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
   * @returns {Promise<{ ok: true, url: string, fallback?: "dom_click", rebound?: string[] }>}
   */
  click(control) {
    return this.#call("click", [control], () =>
      this.#post("click", target(control)),
    );
  }
  /**
   * Replaces the value of a field, select or editable region.
   * @param {Target} control
   * @param {string} value
   * @returns {Promise<{ ok: true, rebound?: string[] }>}
   */
  fill(control, value) {
    return this.#call("fill", [control, value], () =>
      this.#post("fill", { ...target(control), value }),
    );
  }
  /**
   * @param {"Enter" | "Tab" | "Escape" | "Backspace" | "Delete" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown" | "Space"} key
   * @param {Target} [control] Focus this control first.
   * @returns {Promise<{ ok: true, rebound?: string[] }>}
   */
  press(key, control) {
    return this.#call("press", [key, control], () =>
      this.#post("press", { key, ...(control ? target(control) : {}) }),
    );
  }
  /**
   * Scrolls the page, the panel holding a control, or the panel in the
   * middle when the page cannot scroll. A target may take the pixels' place.
   * @param {"up" | "down" | "left" | "right"} direction
   * @param {number} [pixels] 1 to 2000, default 600.
   * @param {Target} [control]
   * @returns {Promise<{ ok: true, scrolled: "page" | "element", selector?: string, x: number, y: number, moved: boolean }>}
   */
  scroll(direction, pixels, control) {
    return this.#call("scroll", [direction, pixels, control], () => {
      if (typeof pixels === "string") [pixels, control] = [undefined, pixels];
      return this.#post("scroll", {
        direction,
        ...(pixels !== undefined ? { pixels } : {}),
        ...(control ? target(control) : {}),
      });
    });
  }
  /**
   * Drags one element onto another with native mouse input or HTML drag and drop.
   * @param {Target} source
   * @param {Target} destination
   * @returns {Promise<{ ok: true, url: string, drag: "html5" | "mouse", rebound?: string[] }>}
   */
  drag(source, destination) {
    return this.#call("drag", [source, destination], () =>
      this.#post("drag", { source: target(source), target: target(destination) }),
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
   * Saves a viewport PNG. Never overwrites an existing file.
   * @param {string} path Ends with .png.
   * @returns {Promise<string>} The absolute path written.
   */
  screenshot(path) {
    return this.#call("screenshot", [path], async () => {
      const output = resolve(path);
      if (!output.toLowerCase().endsWith(".png"))
        throw new Error("Screenshot output must have a .png extension.");
      const bytes = await this.#session.request(`/tabs/${this.id}/screenshot`, {
        response: "png",
      });
      await writeFile(output, bytes, { flag: "wx" });
      return output;
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
  /**
   * @param {Session} session
   * @param {{ id: string, name: string, owner: "agent" | "human", signIns?: "shared" | "separate" }} info
   */
  constructor(session, info) {
    this.#session = session;
    /** @type {string} */
    this.id = info.id;
    /** @type {string} */
    this.name = info.name;
    /** @type {"agent" | "human"} Who controls the space; handoff and resume update it. */
    this.owner = info.owner;
    /** @type {"shared" | "separate" | undefined} Whether the space uses the person's sign-ins. */
    this.signIns = info.signIns;
  }
  #call(name, args, send) {
    return call(this.#session, `Space.${name}`, args, send);
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
      return result;
    });
  }
  /** Closes the space and its tabs. @returns {Promise<{ ok: true }>} */
  close() {
    return this.#call("close", [], () =>
      this.#session.request(`/spaces/${this.id}`, { method: "DELETE" }),
    );
  }
}

/** A connected Kamapathy. */
export class Client {
  #session;
  /** @param {Session} session */
  constructor(session) {
    this.#session = session;
  }
  /**
   * The running Kamapathy's version and API level, once it was found.
   * @returns {{ version?: string, apiLevel: number, electron?: string, chromium?: string, node?: string } | null}
   */
  get app() {
    return this.#session.app;
  }
  #call(name, args, send) {
    return call(this.#session, `Client.${name}`, args, send);
  }
  /**
   * Creates a background agent space.
   * @param {string} name
   * @param {{ isolated?: boolean }} [choices] `isolated` gives the space a
   * session of its own instead of the person's sign-ins.
   * @returns {Promise<Space>}
   */
  createSpace(name, choices = {}) {
    return this.#call("createSpace", [name, choices], async () => {
      const { space } = await this.#session.request("/spaces", {
        method: "POST",
        body: { name, ...(choices.isolated ? { isolated: true } : {}) },
      });
      return new Space(this.#session, space);
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
  if (!lazy) await current.ready();
  return new Client(current);
}
