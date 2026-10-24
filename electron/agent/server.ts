import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { createServer } from "node:http";
import type { WebContents } from "electron";
import type {
  BrowserAction,
  BrowserState,
  ClosedBy,
  HoldReason,
  Space,
  SpaceRequest,
  Tab,
} from "../../shared/types";
import { API_LEVEL } from "../../skills/kamapathy/scripts/schema/index.mjs";
import { createActions } from "./actions";
import { activeSpace, createAuthority } from "./authority";
import { envelope, fail } from "./errors";
import {
  buildRoutes,
  findRoute,
  readBody,
  send,
  type RouteDeps,
} from "./http";
import { createDispatchers } from "./input/dispatch";
import { createNavigation } from "./routes/navigation";
import { spaceRequestRoutes } from "./routes/space-requests";
import { spaceRoutes } from "./routes/spaces";
import { tabRoutes } from "./routes/tabs";
import { updateRoutes, type UpdateService } from "./routes/update";
import { Scheduler, type Lane } from "./scheduler";
import { EventBufferPool } from "./session/event-buffer";
import { TabSessions } from "./session/tab-sessions";
import type { FrameInfo } from "./session/types";
import type { TabRegistry } from "./tab-registry";
import { routeNotFound, validateBody } from "./validate";

export interface AutomationController {
  readonly state: BrowserState;
  /** Labels, origins and managed flags of tabs, and retired labels. */
  readonly registry: TabRegistry;
  dispatch(action: BrowserAction): Promise<BrowserState>;
  createAgentSpace(
    name: string,
    options?: { isolated?: boolean; pageBudget?: number },
  ): Space;
  getWebContents(tabId: string): WebContents | undefined;
  canCapturePage(): boolean;
  addActivity(
    spaceId: string | undefined,
    message: string,
    kind: "info" | "success" | "warning",
  ): void;
  subscribe(listener: (state: BrowserState) => void): () => void;
  /** The tab's live page, if it has one. Never creates a view. */
  peekWebContents(tabId: string): WebContents | undefined;
  /** Called for each new page, popups included, before its first load. */
  onViewCreated(
    listener: (tabId: string, contents: WebContents) => void,
  ): () => void;
  /** The tab the space shows, or would show when the person opens it. */
  shownTab(spaceId: string): Tab | undefined;
  /** A managed agent tab in the background; a blank page without url. */
  openAgentTab(spaceId: string, url?: string): Tab;
  /** Not a BrowserAction: only the agent server navigates an agent tab. */
  navigateAgentTab(
    tabId: string,
    url: string,
    options?: { referer?: string },
  ): void;
  /** The tab:reload path, past the cache with ignoreCache. */
  reloadAgentTab(tabId: string, options?: { ignoreCache?: boolean }): void;
  /** A server redirect the agent URL rule cancelled. */
  onBlockedRedirect(listener: (tabId: string, url: string) => void): () => void;
  /** A download the session started for a tab, before any refusal. */
  onDownloadStarted(listener: (tabId: string) => void): () => void;
  /** A leave guard this agent overrode, with the moment it happened. */
  onLeaveGuard(listener: (tabId: string, at: number) => void): () => void;
  /** Retires the tab's label; a space left empty gets a blank tab. */
  closeTab(tabId: string, by: ClosedBy): { closed?: string; replacement?: Tab };
  setManaged(tabId: string, managed: boolean): Tab;
  setPageBudget(spaceId: string, pageBudget: number): void;
  /** Clears a popup's unseen flag once the agent has addressed it. */
  markSeen(tabId: string): void;
  /** Gives the person control until they answer; returns the hold's id. */
  holdForPerson(spaceId: string, reason: HoldReason, prompt: string): string;
  /** Returns control to the agent unless the person took over since. */
  releaseHold(holdId: string): void;
  /** The person lets an agent use the space; every tab in it stays unmanaged. */
  grantAccess(spaceId: string): void;
  /** Finish or the person's Stop: the space stays open and leaves the agent. */
  endAccess(
    spaceId: string,
    ended: { by: "agent" | "person"; reason: "finished" | "stopped" },
  ): void;
  /** Agent access went off: every grant ends. */
  resetAgentAccess(): void;
  /** An agent space whose access ended becomes a personal space. */
  keepAsPersonal(spaceId: string): Promise<void>;
  /** Shows the person an agent's request for one of their spaces. */
  addSpaceRequest(request: { reason: string; name?: string }): SpaceRequest;
  removeSpaceRequest(id: string): void;
}
export interface AutomationServer {
  /** The socket path, or named pipe on Windows, that agents connect to. */
  endpoint: string;
  /** Random per start; returned on every response so clients can verify it. */
  instance: string;
  /** The person's grant from the app. Throws, changing nothing, when it cannot. */
  grantSpace(id: string): Space;
  /** The person's Stop for one space. */
  endSpace(id: string): void;
  /** The person's answer to a request for a space. */
  answerRequest(id: string, answer: { allow: boolean; spaceId?: string }): void;
  close(): Promise<void>;
}
// End-to-end checks read tab sessions through this probe on globalThis in the
// main process. It exists only while KAMAPATHY_TEST_HOOKS=1.
export interface TestProbe {
  attaches(tabId: string): number;
  hasSession(tabId: string): boolean;
  frames(tabId: string): Promise<FrameInfo[]>;
  ready(tabId: string, frameId: string): Promise<string>;
  networkIdle(
    tabId: string,
    idleMs: number,
    timeoutMs: number,
  ): Promise<number>;
}
type ProbeHost = { __kamapathyTest?: TestProbe };

function testProbe(sessions: TabSessions): TestProbe {
  const session = (tabId: string) => {
    const found = sessions.get(tabId);
    if (!found) throw new Error(`Tab ${tabId} has no session.`);
    return found;
  };
  return {
    attaches: (tabId) => sessions.attaches(tabId),
    hasSession: (tabId) => sessions.get(tabId) !== undefined,
    frames: async (tabId) =>
      session(tabId).frames({ deadline: Date.now() + 5000 }),
    ready: async (tabId, frameId) =>
      (
        await session(tabId).evaluateInFrame(frameId, "ready", {}, {
          deadline: Date.now() + 5000,
          namespace: "internal",
        })
      ).readyState as string,
    networkIdle: async (tabId, idleMs, timeoutMs) => {
      await session(tabId).network.waitForIdle(idleMs, {
        deadline: Date.now() + timeoutMs,
      });
      return Date.now();
    },
  };
}

// The API listens only on a Unix socket or Windows named pipe. Browsers cannot
// open either, and the operating system limits them to this account, so the
// connection needs no token.
export async function startAutomation(
  controller: AutomationController,
  options: { socketPath: string; skillPath?: string; updates?: UpdateService },
): Promise<AutomationServer> {
  const instance = randomBytes(16).toString("hex");
  const authority = createAuthority(controller);
  const scheduler = new Scheduler();
  const sessions = new TabSessions({
    controller,
    agentDriven: (spaceId) => authority.agentDriven(spaceId),
    managedTab: (tabId) =>
      controller.state.tabs.find((tab) => tab.id === tabId)?.managed === true,
    waitForSpaceIdle: (spaceId, timeoutMs) =>
      scheduler.whenIdle(spaceId, timeoutMs),
    buffers: new EventBufferPool(),
  });
  const referenceSession = randomBytes(12).toString("hex");
  // One input dispatcher per tab session, each authorizing its commands.
  const dispatchers = createDispatchers({
    guard: (tabId) => {
      authority.authorizeTab(tabId);
    },
  });
  const actions = createActions({
    controller,
    authority,
    sessions,
    referenceSession,
    dispatchers,
  });
  const navigation = createNavigation({
    controller,
    authority,
    actions,
    sessions,
  });
  const deps: RouteDeps = {
    controller,
    authority,
    actions,
    sessions,
    navigation,
  };
  const grantSpace = (id: string) => {
    const space = authority.grantSpace(id);
    sessions.sync();
    return space;
  };
  const requests = spaceRequestRoutes({ ...deps, grantSpace });
  const routes = buildRoutes({
    ...spaceRoutes(deps),
    ...tabRoutes(deps),
    ...navigation.routes,
    ...requests.routes,
    ...updateRoutes({ updates: options.updates }),
  });
  const versions = Object.fromEntries(
    Object.entries({
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    }).filter(([, value]) => value !== undefined),
  );
  // The bundled skill's folder, reported as given; nothing is read from it.
  const skill = options.skillPath ? { skill: { path: options.skillPath } } : {};

  const server = createServer(async (request, response) => {
    response.setHeader("X-Kamapathy-Instance", instance);
    const dispatch = { dispatched: false };
    let key: string | undefined;
    try {
      if (
        request.headers.origin !== undefined ||
        request.headers["sec-fetch-site"] !== undefined
      )
        return fail(
          "local_clients_only",
          "Only direct local clients may use this API.",
        );
      // Clients check liveness and identity here before every command, so it
      // never waits behind another agent's page actions.
      if (request.method === "GET" && request.url === "/health") {
        if (authority.stopped)
          return fail("automation_stopped", "Automation is disabled.");
        // Read per request, so it goes when the reminder does.
        const update = options.updates?.reminder();
        return send(response, 200, {
          status: "ok",
          version: controller.state.version,
          apiLevel: API_LEVEL,
          versions,
          ...skill,
          ...(update ? { update } : {}),
        });
      }
      if (authority.stopped)
        return fail("automation_stopped", "Automation is disabled.");
      const rawPath = request.url || "/";
      if (!/^\/[a-zA-Z0-9/_-]*$/.test(rawPath))
        return fail(
          "invalid_path",
          "Use a route without query parameters or encoded path segments.",
        );
      const parts = rawPath.split("/").filter(Boolean);
      const method = request.method;
      // A resume passes human control only if the person had control when
      // it arrived, so a queued one cannot undo a takeover the agent never saw.
      const resumeFromHuman =
        method === "POST" &&
        parts.length === 3 &&
        parts[0] === "spaces" &&
        parts[2] === "resume" &&
        controller.state.spaces.find((space) => space.id === parts[1])
          ?.owner === "human";
      // Runs on arrival, again once the request leaves its queue, and after
      // every wait it parks. The route's access decides whether it answers
      // while the person has control and whether it reaches unadopted tabs.
      const authorize = () => {
        const access = route?.access;
        return {
          space:
            parts[0] === "spaces" && parts.length >= 2
              ? authority.authorizeSpace(parts[1], {
                  human:
                    access?.human === "resume" && !resumeFromHuman
                      ? undefined
                      : access?.human,
                })
              : undefined,
          tab:
            parts[0] === "tabs" && parts.length >= 2
              ? authority.authorizeTab(parts[1], {
                  unmanaged: access?.unmanaged,
                })
              : undefined,
        };
      };
      const route = findRoute(routes, method, parts);
      const scope = authorize();
      if (!route)
        throw routeNotFound(
          method || "GET",
          rawPath,
          controller.state.version,
        );
      key = route.key;
      // A route that addresses a popup reports it to the agent.
      if (scope.tab?.unseen) controller.markSeen(scope.tab.id);
      const spaceId = scope.space?.id ?? scope.tab?.spaceId;
      const ticket = scheduler.admit({
        spaceId: route.lane === "space" ? spaceId : undefined,
        budgetMs: route.budgetMs,
      });
      const abort = new AbortController();
      response.once("close", () => {
        if (response.writableFinished) return;
        ticket.drop();
        abort.abort();
      });
      let before: { prepared?: unknown; release?(): void } | undefined;
      try {
        before = route.beforeBody?.({ request, response, ...scope });
        const body =
          method === "POST"
            ? await readBody(request, route.bodyLimit)
            : undefined;
        // A malformed body never waits behind page work.
        validateBody(route, body);
        const lane: Lane =
          route.lane === "space"
            ? { kind: "space", spaceId: spaceId! }
            : { kind: route.lane };
        const deadline = await ticket.start(lane);
        await route.handler({
          request,
          response,
          body,
          ...authorize(),
          resumeFromHuman,
          run: {
            deadline,
            signal: abort.signal,
            dispatch,
            park: async (wait) => {
              try {
                return await ticket.park(wait);
              } finally {
                authorize();
              }
            },
          },
          prepared: before?.prepared,
        });
      } finally {
        ticket.finish();
        before?.release?.();
      }
    } catch (error) {
      const failure = envelope(error, dispatch.dispatched, { route: key });
      send(response, failure.status, { error: failure.error });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.socketPath, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  // The private directory is the real boundary; the socket itself is also
  // made unreadable to other accounts.
  if (process.platform !== "win32") chmodSync(options.socketPath, 0o600);
  sessions.start();
  const probe =
    process.env.KAMAPATHY_TEST_HOOKS === "1" ? testProbe(sessions) : undefined;
  if (probe) (globalThis as unknown as ProbeHost).__kamapathyTest = probe;
  let closing: Promise<void> | undefined;
  return {
    endpoint: options.socketPath,
    instance,
    grantSpace,
    answerRequest: requests.answer,
    endSpace(id: string) {
      const space = controller.state.spaces.find((item) => item.id === id);
      if (!space) throw new Error("Space was not found.");
      // A second Stop, or a Stop on a space no agent may use, changes
      // nothing.
      if (activeSpace(space))
        controller.endAccess(id, { by: "person", reason: "stopped" });
    },
    close() {
      if (!closing) {
        const host = globalThis as unknown as ProbeHost;
        if (probe && host.__kamapathyTest === probe)
          delete host.__kamapathyTest;
        authority.stop();
        requests.close();
        scheduler.close();
        // The dispatchers go last, so each session's release still lets go
        // of the keys it holds.
        navigation.dispose();
        closing = new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
          .then(() => sessions.close())
          .finally(() => dispatchers.dispose());
      }
      return closing;
    },
  };
}
