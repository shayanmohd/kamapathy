import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { createServer } from "node:http";
import type { WebContents } from "electron";
import type { BrowserAction, BrowserState, Space } from "../../shared/types";
import { createActions } from "./actions";
import { createAuthority } from "./authority";
import { errorBody, fail } from "./errors";
import { findRoute, readBody, send } from "./http";
import { spaceRoutes } from "./routes/spaces";
import { tabRoutes } from "./routes/tabs";
import { Scheduler, type Lane } from "./scheduler";

export interface AutomationController {
  readonly state: BrowserState;
  dispatch(action: BrowserAction): Promise<BrowserState>;
  createAgentSpace(name: string, options?: { isolated?: boolean }): Space;
  getWebContents(tabId: string): WebContents | undefined;
  canCapturePage(): boolean;
  addActivity(
    spaceId: string | undefined,
    message: string,
    kind: "info" | "success" | "warning",
  ): void;
}
export interface AutomationServer {
  /** The socket path, or named pipe on Windows, that agents connect to. */
  endpoint: string;
  /** Random per start; returned on every response so clients can verify it. */
  instance: string;
  grantSpace(id: string): void;
  close(): Promise<void>;
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
  const referenceSession = randomBytes(12).toString("hex");
  const actions = createActions({ controller, authority, referenceSession });
  const routes = [
    ...spaceRoutes({ controller, authority, actions }),
    ...tabRoutes({ controller, authority, actions }),
  ];

  const server = createServer(async (request, response) => {
    response.setHeader("X-Kamapathy-Instance", instance);
    try {
      if (
        request.headers.origin !== undefined ||
        request.headers["sec-fetch-site"] !== undefined
      )
        return fail(
          403,
          "local_clients_only",
          "Only direct local clients may use this API.",
        );
      // Clients check liveness and identity here before every command, so it
      // never waits behind another agent's page actions.
      if (request.method === "GET" && request.url === "/health") {
        if (authority.stopped)
          return fail(503, "automation_stopped", "Automation is disabled.");
        return send(response, 200, {
          status: "ok",
          version: controller.state.version,
        });
      }
      if (authority.stopped)
        return fail(503, "automation_stopped", "Automation is disabled.");
      const rawPath = request.url || "/";
      if (!/^\/[a-zA-Z0-9/_-]*$/.test(rawPath))
        return fail(
          400,
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
      // every wait it parks.
      const authorize = () => ({
        space:
          parts[0] === "spaces" && parts.length >= 2
            ? authority.authorizeSpace(parts[1], resumeFromHuman)
            : undefined,
        tab:
          parts[0] === "tabs" && parts.length >= 2
            ? authority.authorizeTab(parts[1])
            : undefined,
      });
      const scope = authorize();
      const route = findRoute(routes, method, parts);
      if (!route)
        return fail(404, "route_not_found", "Automation route was not found.");
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
      const failure = errorBody(
        error,
        "The browser could not complete this operation. Retry after the page finishes loading.",
      );
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
  let closing: Promise<void> | undefined;
  return {
    endpoint: options.socketPath,
    instance,
    grantSpace(id: string) {
      authority.grantSpace(id);
    },
    close() {
      if (!closing) {
        authority.stop();
        scheduler.close();
        actions.dispose();
        closing = new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}
