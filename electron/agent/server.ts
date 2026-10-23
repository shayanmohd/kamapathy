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
import { createDialogs } from "./dialogs";
import { createDownloads } from "./downloads";
import { envelope, fail } from "./errors";
import { createExpectations } from "./expectations";
import {
  buildRoutes,
  findRoute,
  readBody,
  send,
  type RouteDeps,
} from "./http";
import { createReceipts } from "./receipts";
import { downloadRoutes } from "./routes/downloads";
import { eventRoutes } from "./routes/events";
import { spaceRequestRoutes } from "./routes/space-requests";
import { spaceRoutes } from "./routes/spaces";
import { tabRoutes } from "./routes/tabs";
import { Scheduler, type Lane } from "./scheduler";
import { EventBufferPool } from "./session/event-buffer";
import { TabSessions } from "./session/tab-sessions";
import type { FrameInfo } from "./session/types";
import { createTabLog, watchPopups } from "./tab-log";
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
  /** Retires the tab's label; a space left empty gets a blank tab. */
  closeTab(tabId: string, by: ClosedBy): { closed?: string; replacement?: Tab };
  setManaged(tabId: string, managed: boolean): Tab;
  setPageBudget(spaceId: string, pageBudget: number): void;
  /** Clears a popup's unseen flag once the agent has addressed it. */
  markSeen(tabId: string): void;
  /** Whether the agent has this tab now: managed, in a space it owns under
   *  agent rules whose access has not ended. */
  agentControlled(tabId: string): boolean;
  /** The profile directory downloads are stored under. */
  userDataPath(): string;
  /** Lets the agent server decide a download before the space refuses it. */
  onDownload(
    decide: (
      contents: WebContents,
      item: Electron.DownloadItem,
    ) => { captured: true; id: string } | { captured: false },
  ): () => void;
  /** The prompt center, told when each route on a tab starts and ends. */
  readonly prompts?: {
    routeStarted(tabId: string): void;
    routeEnded(tabId: string): void;
  };
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
  options: { socketPath: string },
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
  const actions = createActions({
    controller,
    authority,
    sessions,
    referenceSession,
  });
  const tabLog = createTabLog();
  const receipts = createReceipts({
    tabLog,
    controller,
    prompts: controller.prompts,
  });
  const stopPopupLog = watchPopups(
    tabLog,
    controller.registry,
    () => controller.state,
  );
  const expectations = createExpectations({
    tabLog,
    controller,
    authority,
    sessions,
  });
  const dialogs = createDialogs({
    tabLog,
    controller,
    sessions,
    // An answered dialog resolves a live dialog wait with the record itself.
    onAnswer: (tabId, record) => {
      expectations.deliver(tabId, "dialog", { dialog: record });
    },
    onArm: expectations.onArm,
  });
  // Every agent tab answers its own dialogs, so the person never sees a
  // dialog box from a page an agent drives.
  const dialogStops = new Set<() => void>();
  const stopDialogSessions = sessions.onSession((session, tab) => {
    const stop = dialogs.attach(session, tab.id);
    dialogStops.add(stop);
    session.on("closed", () => {
      dialogStops.delete(stop);
    });
  });
  // Only downloads an agent armed are kept, in a private folder under the
  // profile, and the controller asks before its space refuses one.
  const downloads = createDownloads({
    tabLog,
    arms: () => expectations,
    controller,
    tabOf: (contents) =>
      controller.state.tabs.find(
        (tab) => controller.peekWebContents(tab.id) === contents,
      ),
  });
  const stopDecider = controller.onDownload(downloads.decide);
  // A long run keeps no ring, request window or arm for a tab that is gone.
  const stopTabForget = controller.registry.on((event) => {
    if (event.type !== "closed") return;
    expectations.endTab(event.tabId, "tab_closed");
    tabLog.forget(event.tabId);
    receipts.forget(event.tabId);
    dialogs.forget(event.tabId);
  });
  const deps: RouteDeps = {
    controller,
    authority,
    actions,
    sessions,
    tabLog,
    receipts,
    expectations,
    dialogs,
    downloads,
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
    ...eventRoutes(deps),
    ...downloadRoutes(deps),
    ...requests.routes,
  });
  const versions = Object.fromEntries(
    Object.entries({
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    }).filter(([, value]) => value !== undefined),
  );

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
        return send(response, 200, {
          status: "ok",
          version: controller.state.version,
          apiLevel: API_LEVEL,
          versions,
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
        // A route whose path names neither a space nor a tab says which ids
        // its own id belongs to, and answers 404 for an unknown one.
        const named = route?.resolve?.(parts);
        const spaceId =
          named?.spaceId ??
          (parts[0] === "spaces" && parts.length >= 2 ? parts[1] : undefined);
        const tabId =
          named?.tabId ??
          (parts[0] === "tabs" && parts.length >= 2 ? parts[1] : undefined);
        return {
          space:
            spaceId === undefined
              ? undefined
              : authority.authorizeSpace(spaceId, {
                  human:
                    access?.human === "resume" && !resumeFromHuman
                      ? undefined
                      : access?.human,
                }),
          tab:
            tabId === undefined
              ? undefined
              : authority.authorizeTab(tabId, {
                  unmanaged: access?.unmanaged,
                }),
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
        // A pending wait is answered before its tab session is released.
        expectations.endAll("access_off");
        // No tab keeps an armed policy or a handler once the server stops.
        for (const tab of controller.state.tabs)
          dialogs.clear(tab.id, "access_off");
        for (const stop of dialogStops) stop();
        dialogStops.clear();
        stopDialogSessions();
        // Nothing an agent downloaded outlives its access.
        stopDecider();
        downloads.clearAll();
        stopPopupLog();
        stopTabForget();
        // Nothing keeps a request window open once the server stops.
        for (const tab of controller.state.tabs) receipts.forget(tab.id);
        closing = new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }).then(() => sessions.close());
      }
      return closing;
    },
  };
}
