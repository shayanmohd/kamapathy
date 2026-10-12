// One Session per client: it finds Kamapathy when first needed, sends each
// call as one request with its own timeout, and keeps what a run needs
// afterwards.
import {
  API_LEVEL,
  CLIENT_VERSION,
  matchRoute,
  requestBudget,
  routeKey,
} from "../schema/index.mjs";
import { hardStopCause, KamapathyError } from "./errors.mjs";
import { discover, IdentityError, socketFetch } from "./transport.mjs";

export const REQUEST_TIMEOUT_MS = 45000;
export const BATCH_TIMEOUT_MS = 180000;
const ORIGIN = "http://kamapathy.invalid";
const TIMEOUT =
  "Request timed out. Inspect the page before retrying an action that may have submitted a form.";
const LOST =
  "Lost the connection to Kamapathy during this call. It may have quit or restarted, and the call may still have taken effect.";

// A route whose budget the body declares gets that budget plus 5000 ms; a
// batch keeps 180000 ms and every other route 45000 ms.
export function httpTimeout(budgetMs, route) {
  if (route && routeKey(route) === "POST /tabs/:id/actions")
    return BATCH_TIMEOUT_MS;
  return budgetMs === undefined ? REQUEST_TIMEOUT_MS : budgetMs + 5000;
}

// Notices print once per key in this process, on stderr.
const notices = new Map();
export function queueNotice(key, text) {
  if (!notices.has(key)) notices.set(key, { text, taken: false });
}
export function takeNotices() {
  const taken = [];
  for (const notice of notices.values())
    if (!notice.taken) {
      notice.taken = true;
      taken.push(notice.text);
    }
  return taken;
}

// A request body as sent, refused before anything is sent when it is over
// the route's limit.
export function encode(body, limit = 65536) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded && Buffer.byteLength(encoded) > limit)
    throw new KamapathyError(
      "request_too_large",
      "Encoded request exceeds 64 KiB. Split the batch or reduce field values.",
    );
  return encoded;
}

// The connection dropped, or another program now answers at the socket.
const lost = (error) =>
  error instanceof IdentityError ||
  ["ENOENT", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error?.code) ||
  String(error?.code).startsWith("HPE_");

const ownFields = (error) =>
  Object.fromEntries(
    Object.entries(error).filter(([key]) => !["name", "stack"].includes(key)),
  );

export class Session {
  #send;
  #finding;
  #controller = new AbortController();
  /**
   * @param {{ env?: NodeJS.ProcessEnv, fetch?: Function, connect?: object,
   * health?: object, lazy?: boolean, run?: boolean, envFileNames?: string[] }}
   * [options] `fetch` replaces the socket, and with it discovery: the app is
   * then the `health` body given, or level 1. `envFileNames` are left out of
   * the environment Kamapathy starts with.
   */
  constructor({
    env = process.env,
    fetch,
    connect,
    health,
    lazy = false,
    run = false,
    envFileNames = [],
  } = {}) {
    this.env = env;
    this.envFileNames = envFileNames;
    this.lazy = lazy;
    this.run = run;
    this.connection = null;
    this.launched = false;
    this.health = health ?? null;
    this.hardStop = null;
    /** @type {string[]} Tab ids the run used, in first-use order. */
    this.touched = [];
    this.endHooks = [];
    this.endStep = false;
    this.#send = fetch;
    this.injected = !!fetch;
    this.discovery = connect ?? {};
  }
  get signal() {
    return this.#controller.signal;
  }
  /** @returns {{ version?: string, apiLevel: number, electron?: string, chromium?: string, node?: string } | null} */
  get app() {
    if (!this.injected && !this.connection) return null;
    const health = this.health ?? {};
    const versions = health.versions ?? {};
    return {
      ...(typeof health.version === "string"
        ? { version: health.version }
        : {}),
      apiLevel: Number.isInteger(health.apiLevel) ? health.apiLevel : 1,
      ...(versions.electron ? { electron: versions.electron } : {}),
      ...(versions.chromium ? { chromium: versions.chromium } : {}),
      ...(versions.node ? { node: versions.node } : {}),
    };
  }
  // After a run's hard stop, later calls throw a copy and send nothing.
  #gate() {
    if (this.run && this.hardStop && !this.endStep)
      throw new KamapathyError(this.hardStop.code, this.hardStop.message, {
        ...ownFields(this.hardStop),
        hardStop: true,
      });
  }
  // A run records the first error that stops it for good, so catching that
  // error does not undo it.
  #record(error) {
    if (
      this.run &&
      !this.endStep &&
      !this.hardStop &&
      error instanceof KamapathyError &&
      hardStopCause(error)
    ) {
      error.hardStop = true;
      this.hardStop = error;
    }
  }
  // Finds Kamapathy once per connection. Only the first discovery may start
  // it.
  async ready() {
    this.#gate();
    if (!this.injected && !this.connection)
      try {
        await (this.#finding ??= this.#find().finally(() => {
          this.#finding = undefined;
        }));
      } catch (error) {
        this.#record(error);
        throw error;
      }
    const app = this.app;
    if (app && app.apiLevel > API_LEVEL)
      this.notice(
        "skill-stale",
        typeof this.health?.skill?.path === "string"
          ? `This skill copy (${CLIENT_VERSION}) is older than Kamapathy${app.version ? ` ${app.version}` : ""}. Read ${this.health.skill.path}/SKILL.md for the current API.`
          : "Update this skill copy, then read its SKILL.md again.",
      );
  }
  async #find() {
    const allowLaunch = !this.launched && this.env.KAMAPATHY_NO_LAUNCH !== "1";
    this.launched = true;
    const { socket, instance, health } = await discover(this.env, {
      ...this.discovery,
      allowLaunch,
      launchWithout: this.envFileNames,
    });
    this.connection = { socket, instance };
    this.health = health;
    this.#send = socketFetch(this.connection);
  }
  async appLevel() {
    await this.ready();
    return this.app?.apiLevel ?? 1;
  }
  // One request, answered with the raw Response.
  async send(path, { method = "GET", body, budgetMs, limit = 65536 } = {}) {
    this.#gate();
    const encoded = encode(body, limit);
    await this.ready();
    const tab = /^\/tabs\/([^/]+)/.exec(path)?.[1];
    if (tab && !this.touched.includes(tab)) this.touched.push(tab);
    const route = matchRoute(method, path);
    // Only a budget the body declares sets the timeout.
    const declared =
      route && typeof route.budget !== "number"
        ? requestBudget(route, body)
        : undefined;
    const signal = AbortSignal.any([
      AbortSignal.timeout(httpTimeout(budgetMs ?? declared, route)),
      this.signal,
    ]);
    try {
      return await this.#send(new URL(path, ORIGIN), {
        method,
        headers: encoded ? { "Content-Type": "application/json" } : {},
        body: encoded,
        signal,
      });
    } catch (error) {
      if (this.signal.aborted) {
        const reason = this.signal.reason;
        throw new KamapathyError(
          reason?.code ?? "interrupted",
          reason?.message ?? "The call was interrupted.",
          reason instanceof KamapathyError ? ownFields(reason) : {},
        );
      }
      if (error?.name === "TimeoutError" || error?.name === "AbortError")
        throw new KamapathyError("timeout", TIMEOUT);
      if (!this.injected && lost(error)) {
        this.connection = null;
        this.#send = undefined;
        throw new KamapathyError("not_connected", LOST, { reason: "lost" });
      }
      throw error;
    }
  }
  // One request, answered with parsed JSON, PNG bytes or the Response.
  async request(path, { response: kind = "json", ...options } = {}) {
    try {
      const response = await this.send(path, options);
      if (kind === "stream" && response.ok) return response;
      if (kind === "png" && response.ok) {
        if (!response.headers.get("content-type")?.startsWith("image/png"))
          throw new KamapathyError(
            "invalid_response",
            "The API did not return a PNG screenshot.",
          );
        return Buffer.from(await response.arrayBuffer());
      }
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok === false) {
        const { code, message, ...fields } = data?.error ?? {};
        throw new KamapathyError(
          code || "request_failed",
          message || "The API request failed.",
          {
            ...fields,
            status: response.status,
            ...(Array.isArray(data?.results)
              ? { results: data.results, failedIndex: data.failedIndex }
              : {}),
          },
        );
      }
      if (data === null)
        throw new KamapathyError(
          "invalid_response",
          "The API did not return valid JSON.",
        );
      return data;
    } catch (error) {
      this.#record(error);
      throw error;
    }
  }
  notice(key, text) {
    queueNotice(key, text);
  }
  // Runs once a run's script settles; returns a function that removes it.
  onRunEnd(hook) {
    this.endHooks.push(hook);
    return () => {
      this.endHooks = this.endHooks.filter((item) => item !== hook);
    };
  }
  abort(reason) {
    this.#controller.abort(reason);
  }
  rearm() {
    this.#controller = new AbortController();
  }
}

const CLOSER = { agent: "the agent", page: "the page", person: "the person" };

export const isLabel = (value) =>
  typeof value === "string" && /^p[1-9][0-9]*$/.test(value);

// The tabs with these labels, found with one tabs request. A label the space
// retired says who closed it.
export async function resolveLabels(session, spaceId, labels) {
  const { tabs, closed = [] } = await session.request(
    `/spaces/${spaceId}/tabs`,
  );
  return labels.map((label) => {
    const tab = tabs.find((item) => item.label === label);
    if (tab) return tab;
    const retired = closed.findLast((item) => item.label === label);
    throw new KamapathyError(
      "page_not_found",
      retired
        ? `Page ${label} was closed by ${CLOSER[retired.closedBy] ?? "someone"}. Open another with space.newPage().`
        : `No page in this space is labeled ${label}. space.pages() lists them.`,
      { label, ...(retired ? { closedBy: retired.closedBy } : {}) },
    );
  });
}

// KAMAPATHY_PAGE_BUDGET as a page budget, read when a space is opened.
export function pageBudgetFrom(env) {
  const value = env.KAMAPATHY_PAGE_BUDGET;
  if (value === undefined || value === "") return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 20)
    throw new KamapathyError(
      "invalid_option",
      "KAMAPATHY_PAGE_BUDGET must be an integer from 1 to 20.",
      { option: "KAMAPATHY_PAGE_BUDGET" },
    );
  return Number(value);
}
