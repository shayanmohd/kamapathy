// Kamapathy scripting client. Node built-ins only. It finds Kamapathy the way
// the CLI does and every method sends exactly one documented HTTP route over
// the local socket; nothing here runs inside a page.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  formatSnapshot,
  readUploadFiles,
  resolveSocket,
  socketFetch,
  target,
  uploadRef,
} from "./kamapathy.mjs";

export * as schema from "./schema/index.mjs";

const ORIGIN = "http://kamapathy.invalid";
const REQUEST_TIMEOUT_MS = 45000;
const BATCH_TIMEOUT_MS = 180000;
const BODY_LIMIT = 65536;
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
/**
 * @typedef {(url: URL, options: object) => Promise<Response>} Send
 */

/** An API failure. `code` and `message` come from Kamapathy. */
export class KamapathyError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, results?: object[], failedIndex?: number }} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "KamapathyError";
    /** @type {string} */
    this.code = code;
    /** @type {number | undefined} HTTP status of the failed request. */
    this.status = details.status;
    /** @type {object[] | undefined} Steps a failed batch completed before stopping. */
    this.results = details.results;
    /** @type {number | undefined} Zero-based index of the batch step that failed. */
    this.failedIndex = details.failedIndex;
  }
}

async function request(send, path, { method = "GET", body, timeoutMs = REQUEST_TIMEOUT_MS, limit = BODY_LIMIT, png = false } = {}) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && Buffer.byteLength(encoded) > limit)
    throw new KamapathyError(
      "request_too_large",
      "Encoded request exceeds 64 KiB. Split the batch or reduce field values.",
    );
  let response;
  try {
    response = await send(new URL(path, ORIGIN), {
      method,
      headers: encoded ? { "Content-Type": "application/json" } : {},
      body: encoded,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError")
      throw new KamapathyError(
        "timeout",
        "Request timed out. Inspect the page before retrying an action that may have submitted a form.",
      );
    throw error;
  }
  if (png && response.ok) {
    if (!response.headers.get("content-type")?.startsWith("image/png"))
      throw new KamapathyError("invalid_response", "The API did not return a PNG screenshot.");
    return Buffer.from(await response.arrayBuffer());
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.ok === false)
    throw new KamapathyError(
      data?.error?.code || "request_failed",
      data?.error?.message || "The API request failed.",
      {
        status: response.status,
        ...(Array.isArray(data?.results)
          ? { results: data.results, failedIndex: data.failedIndex }
          : {}),
      },
    );
  if (data === null)
    throw new KamapathyError("invalid_response", "The API did not return valid JSON.");
  return data;
}

/** One tab in an agent space. */
export class Page {
  #send;
  /**
   * @param {Send} send
   * @param {{ id: string, spaceId?: string, url: string, title: string }} tab
   */
  constructor(send, tab) {
    this.#send = send;
    /** @type {string} */
    this.id = tab.id;
    /** @type {string | undefined} */
    this.spaceId = tab.spaceId;
    /** @type {string} Last known URL; navigate and snapshot refresh it. */
    this.url = tab.url;
    /** @type {string} Last known title; navigate and snapshot refresh it. */
    this.title = tab.title;
  }
  #post(route, body, options) {
    return request(this.#send, `/tabs/${this.id}/${route}`, { method: "POST", body, ...options });
  }
  /**
   * Loads a complete http or https URL. Refs from before become stale.
   * @param {string} url
   * @returns {Promise<Page>} This page, with `url` and `title` updated.
   */
  async navigate(url) {
    const { tab } = await this.#post("navigate", { url });
    this.url = tab.url;
    this.title = tab.title;
    return this;
  }
  /**
   * Reads bounded visible text and controls with refs.
   * @param {SnapshotOptions} [options]
   * @returns {Promise<Snapshot>}
   */
  async snapshot(options = {}) {
    const data = await this.#post("snapshot", { mode: "compact", ...options });
    this.url = data.url;
    this.title = data.title;
    return data;
  }
  /**
   * The same compact text the CLI's snapshot command prints.
   * @param {SnapshotOptions} [options]
   * @returns {Promise<string>}
   */
  async text(options) {
    return formatSnapshot(await this.snapshot(options));
  }
  /**
   * @param {Target} control
   * @returns {Promise<{ ok: true, url: string, fallback?: "dom_click", rebound?: string[] }>}
   */
  click(control) {
    return this.#post("click", target(control));
  }
  /**
   * Replaces the value of a field, select or editable region.
   * @param {Target} control
   * @param {string} value
   * @returns {Promise<{ ok: true, rebound?: string[] }>}
   */
  fill(control, value) {
    return this.#post("fill", { ...target(control), value });
  }
  /**
   * @param {"Enter" | "Tab" | "Escape" | "Backspace" | "Delete" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End" | "PageUp" | "PageDown" | "Space"} key
   * @param {Target} [control] Focus this control first.
   * @returns {Promise<{ ok: true, rebound?: string[] }>}
   */
  press(key, control) {
    return this.#post("press", { key, ...(control ? target(control) : {}) });
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
    if (typeof pixels === "string") [pixels, control] = [undefined, pixels];
    return this.#post("scroll", {
      direction,
      ...(pixels !== undefined ? { pixels } : {}),
      ...(control ? target(control) : {}),
    });
  }
  /**
   * Drags one element onto another with native mouse input or HTML drag and drop.
   * @param {Target} source
   * @param {Target} destination
   * @returns {Promise<{ ok: true, url: string, drag: "html5" | "mouse", rebound?: string[] }>}
   */
  drag(source, destination) {
    return this.#post("drag", { source: target(source), target: target(destination) });
  }
  /**
   * Waits for a visible element, text, or both.
   * @param {WaitOptions} [options]
   * @returns {Promise<{ ok: true }>}
   */
  wait(options = {}) {
    return this.#post("wait", options);
  }
  /**
   * Runs 1 to 20 actions in order. Stops at the first failure and throws a
   * KamapathyError carrying `results` and `failedIndex`; earlier steps may
   * already have changed the page.
   * @param {Action[]} actions
   * @returns {Promise<BatchResult>}
   */
  batch(actions) {
    return this.#post("actions", { actions }, { timeoutMs: BATCH_TIMEOUT_MS });
  }
  /**
   * Selects local files on a file input. The site may upload them at once.
   * @param {string} ref A file input ref from a current snapshot.
   * @param {string[]} files 1 to 8 paths, at most 16 MiB together.
   * @returns {Promise<{ ok: true, selected: number }>}
   */
  async upload(ref, files) {
    return this.#post(
      "upload",
      { ref: uploadRef(ref), files: await readUploadFiles(files) },
      { limit: UPLOAD_BODY_LIMIT },
    );
  }
  /**
   * Saves a viewport PNG. Never overwrites an existing file.
   * @param {string} path Ends with .png.
   * @returns {Promise<string>} The absolute path written.
   */
  async screenshot(path) {
    const output = resolve(path);
    if (!output.toLowerCase().endsWith(".png"))
      throw new Error("Screenshot output must have a .png extension.");
    const bytes = await request(this.#send, `/tabs/${this.id}/screenshot`, { png: true });
    await writeFile(output, bytes, { flag: "wx" });
    return output;
  }
  /** @returns {Promise<{ ok: true }>} */
  close() {
    return request(this.#send, `/tabs/${this.id}`, { method: "DELETE" });
  }
}

/** An agent space the API can reach. */
export class Space {
  #send;
  /**
   * @param {Send} send
   * @param {{ id: string, name: string, owner: "agent" | "human", signIns?: "shared" | "separate" }} info
   */
  constructor(send, info) {
    this.#send = send;
    /** @type {string} */
    this.id = info.id;
    /** @type {string} */
    this.name = info.name;
    /** @type {"agent" | "human"} Who controls the space; handoff and resume update it. */
    this.owner = info.owner;
    /** @type {"shared" | "separate" | undefined} Whether the space uses the person's sign-ins. */
    this.signIns = info.signIns;
  }
  /**
   * Opens a background tab.
   * @param {string} url
   * @returns {Promise<Page>}
   */
  async open(url) {
    const { tab } = await request(this.#send, `/spaces/${this.id}/tabs`, { method: "POST", body: { url } });
    return new Page(this.#send, tab);
  }
  /** @returns {Promise<Page[]>} */
  async tabs() {
    const { tabs } = await request(this.#send, `/spaces/${this.id}/tabs`);
    return tabs.map((tab) => new Page(this.#send, tab));
  }
  /**
   * Pauses automation so the person can continue, for example to sign in.
   * @returns {Promise<{ ok: true, owner: "human" }>}
   */
  async handoff() {
    const result = await request(this.#send, `/spaces/${this.id}/handoff`, { method: "POST", body: {} });
    this.owner = result.owner;
    return result;
  }
  /**
   * Takes control back once the reason for the handoff is finished.
   * @returns {Promise<{ ok: true, owner: "agent" }>}
   */
  async resume() {
    const result = await request(this.#send, `/spaces/${this.id}/resume`, { method: "POST", body: {} });
    this.owner = result.owner;
    return result;
  }
  /** Closes the space and its tabs. @returns {Promise<{ ok: true }>} */
  close() {
    return request(this.#send, `/spaces/${this.id}`, { method: "DELETE" });
  }
}

/** A connected Kamapathy. */
export class Client {
  #send;
  /** @param {Send} send */
  constructor(send) {
    this.#send = send;
  }
  /**
   * Creates a background agent space.
   * @param {string} name
   * @param {{ isolated?: boolean }} [choices] `isolated` gives the space a
   * session of its own instead of the person's sign-ins.
   * @returns {Promise<Space>}
   */
  async createSpace(name, { isolated } = {}) {
    const { space } = await request(this.#send, "/spaces", {
      method: "POST",
      body: { name, ...(isolated ? { isolated: true } : {}) },
    });
    return new Space(this.#send, space);
  }
  /** @returns {Promise<Space[]>} The agent spaces this API session can reach. */
  async spaces() {
    const { spaces } = await request(this.#send, "/spaces");
    return spaces.map((info) => new Space(this.#send, info));
  }
  /**
   * An accessible space by ID.
   * @param {string} id
   * @returns {Promise<Space>}
   */
  async space(id) {
    const found = (await this.spaces()).find((space) => space.id === id);
    if (!found)
      throw new KamapathyError(
        "space_not_found",
        `No accessible agent space has the ID ${String(id)}. Call spaces() to list them.`,
      );
    return found;
  }
}

/**
 * Connects to Kamapathy: finds it through the profile's agent folder, starts
 * it when agent access was left on, and checks that it is the Kamapathy that
 * published the endpoint.
 * @param {{ env?: NodeJS.ProcessEnv, connect?: object, fetch?: Send }} [options]
 * `env` chooses the profile (`KAMAPATHY_USER_DATA`) and whether starting is
 * allowed (`KAMAPATHY_NO_LAUNCH`). `connect` and `fetch` are for tests.
 * @returns {Promise<Client>}
 */
export async function connect(options = {}) {
  const send =
    options.fetch ||
    socketFetch(await resolveSocket(options.env || process.env, options.connect));
  return new Client(send);
}
