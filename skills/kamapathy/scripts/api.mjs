// Kamapathy scripting client. Node built-ins only. It finds Kamapathy the way
// the CLI does and every method sends exactly one documented HTTP route over
// the local socket; nothing here runs inside a page. Each method checks its
// arguments against the schema before anything is sent.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { KamapathyError } from "./lib/errors.mjs";
import { formatSnapshot } from "./lib/format.mjs";
import { readUploadFiles, target, uploadRef } from "./lib/input.mjs";
import {
  isLabel,
  pageBudgetFrom,
  resolveLabels,
  Session,
} from "./lib/request.mjs";
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
