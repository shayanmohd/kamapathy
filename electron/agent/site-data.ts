import { randomUUID } from "node:crypto";
import type { ClearSiteDataApproval, Space, Tab } from "../../shared/types";
import type { Authority } from "./authority";
import { ApiError, fail } from "./errors";
import type { Run } from "./http";
import type { AgentPresence } from "./presence";
import { DroppedError } from "./scheduler";
import type { AutomationController } from "./server";
import type { TabSessions } from "./session/tab-sessions";

// Section 8's clearing of one site's data. An isolated agent space's
// partition is the agent's alone, so a clear there runs at once. In a
// session the person uses, the clear counts what would go, holds the space
// for the person and runs only when they press Clear.

export type StorageKind =
  | "localStorage"
  | "indexedDB"
  | "cacheStorage"
  | "serviceWorkers"
  | "fileSystem";
type ElectronStorage = NonNullable<
  Electron.ClearStorageDataOptions["storages"]
>[number];
/** The names Electron's clearStorageData takes for each kind. */
export const STORAGE_NAMES: Record<StorageKind, ElectronStorage> = {
  localStorage: "localstorage",
  indexedDB: "indexdb",
  cacheStorage: "cachestorage",
  serviceWorkers: "serviceworkers",
  fileSystem: "filesystem",
};
export const STORAGE_KINDS = Object.keys(STORAGE_NAMES) as StorageKind[];

export type PartitionUse = "isolated" | "person";
// An agent space with separate sign-ins has a temporary partition nobody
// else uses. Every other space shares the person's sign-ins or is theirs.
export function partitionUse(space: Space): PartitionUse {
  return space.kind === "agent" && space.signIns === "separate"
    ? "isolated"
    : "person";
}

export interface CookiePick {
  name: string;
  domain?: string;
  path?: string;
}
type CookieFields = {
  name: string;
  domain: string;
  path: string;
  secure: boolean;
};
// The hosts Chromium sends a secure cookie to over http.
const LOOPBACK = /^(?:localhost|.+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;
const bareDomain = (domain: string) => domain.replace(/^\./, "").toLowerCase();
// RFC 6265's path match: the request path is the cookie's path or below it.
const pathMatches = (path: string, cookiePath: string) =>
  path === cookiePath ||
  (path.startsWith(cookiePath) &&
    (cookiePath.endsWith("/") || path[cookiePath.length] === "/"));

/**
 * Whether the origin receives the cookie, on any path. By RFC 6265's domain
 * match a host-only cookie goes to its own host alone, and a parent-domain
 * cookie to that domain and every host under it, never to a sibling. A pick
 * narrows it to a name, and to a domain and a request path when it gives
 * them.
 */
export function cookieMatches(
  cookie: CookieFields,
  origin: URL,
  pick?: CookiePick,
): boolean {
  const host = origin.hostname;
  const domain = cookie.domain.toLowerCase();
  const sent = domain.startsWith(".")
    ? host === domain.slice(1) || host.endsWith(domain)
    : host === domain;
  if (!sent) return false;
  if (cookie.secure && origin.protocol !== "https:" && !LOOPBACK.test(host))
    return false;
  if (!pick) return true;
  return (
    cookie.name === pick.name &&
    (pick.domain === undefined ||
      bareDomain(pick.domain) === bareDomain(cookie.domain)) &&
    (pick.path === undefined || pathMatches(pick.path, cookie.path))
  );
}

/**
 * The URL a matched cookie is removed with: its own scheme and path, on the
 * origin's host. Chromium removes every cookie of the name that a request to
 * the URL carries, so the parent domain's own host would also take that
 * host's cookies, which the origin never receives.
 */
export function cookieUrl(
  cookie: { path: string; secure: boolean },
  origin: URL,
): string {
  return `${cookie.secure ? "https" : "http"}://${origin.hostname}${cookie.path}`;
}

// The most domains an approval or an answer lists.
const MAX_DOMAINS = 8;
const fieldsOf = (cookie: Electron.Cookie): CookieFields => ({
  name: cookie.name,
  domain: cookie.domain ?? "",
  path: cookie.path ?? "/",
  secure: cookie.secure === true,
});
const keyOf = (cookie: CookieFields) =>
  `${cookie.name}\n${cookie.domain}\n${cookie.path}`;
// The domains a clear signs the person out of, without a parent's dot.
const domainsOf = (cookies: CookieFields[]) =>
  [...new Set(cookies.map((cookie) => bareDomain(cookie.domain)))]
    .sort()
    .slice(0, MAX_DOMAINS);
// What clearing the origin's cookies takes. Each removal takes every cookie
// of its name that a request to its URL carries, so the count and the
// domains name all of them.
function planCookies(
  jar: Electron.Cookie[],
  origin: URL,
  cookies: true | CookiePick[],
): { taken: CookieFields[]; removals: { url: string; name: string }[] } {
  const all = jar.map(fieldsOf);
  const removals = new Map<string, { url: string; name: string }>();
  for (const cookie of all)
    if (
      cookies === true
        ? cookieMatches(cookie, origin)
        : cookies.some((pick) => cookieMatches(cookie, origin, pick))
    ) {
      const url = cookieUrl(cookie, origin);
      removals.set(`${cookie.name}\n${url}`, { url, name: cookie.name });
    }
  const taken = all.filter((cookie) =>
    [...removals.values()].some(({ url, name }) => {
      const target = new URL(url);
      return cookieMatches(cookie, target, { name, path: target.pathname });
    }),
  );
  return { taken, removals: [...removals.values()] };
}

type ClearSession = Pick<
  Electron.Session,
  "cookies" | "clearStorageData" | "clearData"
>;
// Chromium does not say what a removal took, so the jar is read again and
// only what is gone counts.
async function removeCookies(
  session: ClearSession,
  origin: URL,
  cookies: true | CookiePick[],
): Promise<{ removed: number; domains: string[] }> {
  const { taken, removals } = planCookies(
    await session.cookies.get({}),
    origin,
    cookies,
  );
  for (const { url, name } of removals) await session.cookies.remove(url, name);
  const left = new Map<string, number>();
  for (const cookie of (await session.cookies.get({})).map(fieldsOf))
    left.set(keyOf(cookie), (left.get(keyOf(cookie)) ?? 0) + 1);
  const gone = taken.filter((cookie) => {
    const count = left.get(keyOf(cookie)) ?? 0;
    left.set(keyOf(cookie), count - 1);
    return count < 1;
  });
  return { removed: gone.length, domains: domainsOf(gone) };
}

export interface ClearRequest {
  origin: string;
  cookies?: true | CookiePick[];
  storage?: true | StorageKind[];
  cache?: true;
  timeoutMs: number;
}
export interface ClearResult {
  ok: true;
  origin: string;
  cleared: {
    cookies?: { removed: number; domains: string[] };
    storage?: string[];
    cache?: true;
  };
  approvedBy?: "person";
}
export interface SiteData {
  clear(tabId: string, request: ClearRequest, run: Run): Promise<ClearResult>;
  /** The person's answer. An unknown or settled id changes nothing. */
  answer(id: string, clear: boolean): void;
  /** Agent access went off: every request waiting for the person ends. */
  dispose(): void;
}
// How a request waiting for the person ends.
type Outcome =
  "clear" | "declined" | "timeout" | "withdrawn" | "dropped" | "stopped";
const CLOSED = "The tab was closed before the person answered.";
const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

export function createSiteData({
  controller,
  authority,
  sessions,
  presence,
}: {
  controller: AutomationController;
  authority: Pick<Authority, "authorizeTab" | "stopped">;
  sessions: Pick<TabSessions, "get">;
  presence: Pick<AgentPresence, "setState" | "clearNeedsYou">;
}): SiteData {
  // Each request waiting for the person, by its approval's id.
  const waiting = new Map<string, (outcome: Outcome) => void>();
  const tabOf = (tabId: string) =>
    controller.state.tabs.find((tab) => tab.id === tabId);
  // The checks every route makes again after a wait. A tab that closed
  // meanwhile is gone from the state, which they would call not found.
  const closedTab = (tabId: string) => !authority.stopped && !tabOf(tabId);
  const check = (tabId: string) => {
    if (closedTab(tabId)) fail("tab_closed", CLOSED);
    authority.authorizeTab(tabId);
  };
  // The origins the tab has loaded: its page, and every frame its session
  // knows of.
  const loaded = async (tab: Tab, run: Run): Promise<Set<string>> => {
    const origins = new Set<string>();
    const page = originOf(tab.url);
    if (page) origins.add(page);
    const session = sessions.get(tab.id);
    if (session)
      for (const frame of await session.knownFrames({
        deadline: run.deadline,
        signal: run.signal,
      }))
        origins.add(frame.origin);
    return origins;
  };
  // Only what the request names goes, and only the origin's own.
  const remove = async (
    session: ClearSession,
    origin: URL,
    request: ClearRequest,
  ): Promise<ClearResult["cleared"]> => {
    const cleared: ClearResult["cleared"] = {};
    if (request.cookies)
      cleared.cookies = await removeCookies(session, origin, request.cookies);
    if (request.storage) {
      const kinds = request.storage === true ? STORAGE_KINDS : request.storage;
      await session.clearStorageData({
        origin: origin.origin,
        storages: kinds.map((kind) => STORAGE_NAMES[kind]),
      });
      cleared.storage = [...kinds];
    }
    if (request.cache) {
      await session.clearData({
        dataTypes: ["cache"],
        origins: [origin.origin],
      });
      cleared.cache = true;
    }
    return cleared;
  };
  return {
    async clear(tabId, request, run) {
      const tab = authority.authorizeTab(tabId);
      const space = controller.state.spaces.find(
        (item) => item.id === tab.spaceId,
      )!;
      const contents = controller.getWebContents(tab.id);
      if (!contents || contents.isDestroyed())
        return fail(
          "no_web_page",
          "Open a web page in this tab before clearing a site's data.",
        );
      const { session } = contents;
      const origin = new URL(request.origin);
      // The only place anything is cleared: in an isolated space at once,
      // elsewhere after the person's Clear.
      const runClear = async () => {
        run.dispatch.dispatched = true;
        const cleared = await remove(session, origin, request);
        controller.addActivity(
          space.id,
          `Agent cleared site data for ${origin.origin}`,
          "info",
        );
        return cleared;
      };
      if (partitionUse(space) === "isolated") {
        const cleared = await runClear();
        authority.authorizeTab(tab.id);
        return { ok: true, origin: origin.origin, cleared };
      }
      if (!(await loaded(tab, run)).has(origin.origin))
        return fail(
          "origin_not_in_tab",
          `${origin.origin} is not loaded in this tab or its frames. Clear data only for a site this tab shows.`,
          { origin: origin.origin },
        );
      const counted = request.cookies
        ? planCookies(await session.cookies.get({}), origin, request.cookies)
            .taken
        : [];
      authority.authorizeTab(tab.id);
      // Cookies the origin does not have are nothing to ask the person about.
      if (!request.storage && !request.cache && !counted.length)
        return {
          ok: true,
          origin: origin.origin,
          cleared: { cookies: { removed: 0, domains: [] } },
        };
      const prompt = `clear data for ${origin.host}`.slice(0, 120);
      const hold = controller.holdForPerson(space.id, "approval", prompt);
      const marked = presence.setState(space.id, "needs-you", prompt);
      const approval: ClearSiteDataApproval = {
        id: randomUUID(),
        spaceId: space.id,
        tabId: tab.id,
        origin: origin.origin,
        ...(request.cookies
          ? { cookies: { count: counted.length, domains: domainsOf(counted) } }
          : {}),
        ...(request.storage
          ? {
              storage: [
                ...(request.storage === true ? STORAGE_KINDS : request.storage),
              ],
            }
          : {}),
        ...(request.cache ? { cache: true as const } : {}),
      };
      controller.addApproval(approval);
      // The request waits while its own hold does: a takeover, Stop, agent
      // access off and a closed tab each end it.
      const pending = () =>
        !authority.stopped &&
        tabOf(tab.id) !== undefined &&
        controller.state.spaces.find((item) => item.id === space.id)?.control
          ?.hold === hold;
      let settled: { outcome: Outcome; cleared?: ClearResult["cleared"] };
      try {
        // Parked, so the space's other requests answer at once.
        settled = await run.park(async () => {
          const outcome = await new Promise<Outcome>((resolve) => {
            const settle = (value: Outcome) => {
              if (!waiting.delete(approval.id)) return;
              clearTimeout(timer);
              unsubscribe();
              run.signal.removeEventListener("abort", dropped);
              resolve(value);
            };
            const dropped = () => settle("dropped");
            waiting.set(approval.id, settle);
            const timer = setTimeout(
              () => settle("timeout"),
              request.timeoutMs,
            );
            const unsubscribe = controller.subscribe(() => {
              if (!pending()) settle("withdrawn");
            });
            run.signal.addEventListener("abort", dropped);
            if (run.signal.aborted) dropped();
            else if (!pending()) settle("withdrawn");
          });
          try {
            if (outcome !== "clear") return { outcome };
            // Clear runs once, while the hold is still the request's own.
            if (!pending()) return { outcome: "withdrawn" as const };
            return { outcome, cleared: await runClear() };
          } finally {
            // The bar goes with the request, and control returns to the
            // agent unless the person took over.
            controller.removeApproval(approval.id);
            controller.releaseHold(hold);
            presence.clearNeedsYou(space.id, marked);
          }
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code === "tab_not_found" &&
          closedTab(tab.id)
        )
          return fail("tab_closed", CLOSED);
        throw error;
      }
      if (settled.outcome === "dropped") throw new DroppedError();
      if (settled.outcome === "stopped")
        return fail("automation_stopped", "Automation is disabled.");
      check(tab.id);
      if (settled.outcome === "clear")
        return {
          ok: true,
          origin: origin.origin,
          cleared: settled.cleared!,
          approvedBy: "person",
        };
      if (settled.outcome === "timeout")
        return fail(
          "approval_timeout",
          `The person did not answer within ${request.timeoutMs} ms, so nothing was cleared.`,
          {
            awaited: "approval",
            origin: origin.origin,
            timeoutMs: request.timeoutMs,
          },
        );
      // Don't clear, or control given back to the agent without an answer.
      return fail(
        "clear_declined",
        `The person chose not to clear data for ${origin.origin}. Continue without clearing it.`,
        { origin: origin.origin },
      );
    },
    answer(id, clear) {
      waiting.get(id)?.(clear ? "clear" : "declined");
    },
    dispose() {
      for (const settle of [...waiting.values()]) settle("stopped");
    },
  };
}
