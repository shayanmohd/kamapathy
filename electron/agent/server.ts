import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { WebContents } from "electron";
import type {
  BrowserAction,
  BrowserState,
  Space,
  Tab,
} from "../../shared/types";
import { createActions } from "./actions";
import { createAuthority } from "./authority";
import { ApiError, fail } from "./errors";
import {
  BODY_LIMIT,
  findRoute,
  readBody,
  send,
  UPLOAD_BODY_LIMIT,
  type RouteDeps,
} from "./http";
import { spaceRoutes } from "./routes/spaces";
import { tabRoutes } from "./routes/tabs";
import { uploadFields } from "./validate";

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
  const { authorizeSpace, authorizeTab } = authority;
  let pending = 0;
  let uploading = false;
  let queue: Promise<unknown> = Promise.resolve();
  const referenceSession = randomBytes(12).toString("hex");
  const actions = createActions({ controller, authority, referenceSession });
  const { trackContents, evaluatePage } = actions;
  const deps: RouteDeps = { controller, authority, actions };
  const routes = [...spaceRoutes(deps), ...tabRoutes(deps)];

  const route = async (
    request: IncomingMessage,
    response: ServerResponse,
    body?: Record<string, unknown>,
    resumeFromHuman = false,
  ) => {
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
    let space: Space | undefined;
    let tab: Tab | undefined;
    if (parts[0] === "spaces" && parts.length >= 2) {
      const resuming =
        parts.length === 3 && parts[2] === "resume" && method === "POST";
      space = authorizeSpace(parts[1], resuming && resumeFromHuman);
    }
    if (parts[0] === "tabs" && parts.length >= 2) {
      tab = authorizeTab(parts[1]);
    }
    const match = findRoute(routes, method, parts);
    if (!match)
      return fail(404, "route_not_found", "Automation route was not found.");
    return match.handler({
      request,
      response,
      body,
      space,
      tab,
      resumeFromHuman,
    });
  };

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
      if (pending >= 16)
        return fail(429, "busy", "Too many pending requests. Try again later.");
      pending++;
      let ownsUpload = false;
      try {
        // Only this fixed route accepts a larger body. Reserve one transfer
        // before reading bytes, so concurrent uploads cannot multiply memory.
        const upload = request.method === "POST"
          ? /^\/tabs\/([a-zA-Z0-9_-]{1,128})\/upload$/.exec(request.url || "")
          : null;
        let uploadContents: WebContents | undefined;
        let uploadEpoch: number | undefined;
        if (upload) {
          authorizeTab(upload[1]);
          if (uploading)
            return fail(429, "upload_busy", "Another file transfer is in progress.");
          uploading = ownsUpload = true;
          uploadContents = controller.getWebContents(upload[1]);
          if (!uploadContents || uploadContents.isDestroyed())
            return fail(409, "no_web_page", "Open a web page before uploading files.");
          uploadEpoch = trackContents(uploadContents).epoch;
        }
        // A resume passes human control only if the person had control when
        // it arrived, so a queued one cannot undo a takeover the agent never saw.
        const resumeRoute = request.method === "POST"
          ? /^\/spaces\/([a-zA-Z0-9_-]{1,128})\/resume$/.exec(request.url || "")
          : null;
        const resumeFromHuman = resumeRoute !== null &&
          controller.state.spaces.find((space) => space.id === resumeRoute[1])?.owner === "human";
        const body =
          request.method === "POST" ? await readBody(request, upload ? UPLOAD_BODY_LIMIT : BODY_LIMIT) : undefined;
        const operation = queue.then(() => {
          if (response.destroyed || response.writableEnded) return;
          if (upload) return (async () => {
            authorizeTab(upload[1]);
            if (uploadContents!.isDestroyed() ||
                controller.getWebContents(upload[1]) !== uploadContents ||
                trackContents(uploadContents!).epoch !== uploadEpoch)
              return fail(409, "page_changed", "The page changed during the transfer. Take a fresh snapshot.");
            const payload = uploadFields(body!);
            const result = await evaluatePage(upload[1], uploadContents!, "upload", payload, Date.now() + 30000);
            const tab = authorizeTab(upload[1]);
            controller.addActivity(tab.spaceId, `Agent selected ${payload.files.length} file(s) for upload`, "info");
            return send(response, 200, result);
          })();
          return route(request, response, body, resumeFromHuman);
        });
        queue = operation.catch(() => {});
        await operation;
      } finally {
        if (ownsUpload) uploading = false;
        pending--;
      }
    } catch (error) {
      const known = error instanceof ApiError;
      send(response, known ? error.status : 500, {
        error: {
          code: known ? error.code : "operation_failed",
          message: known
            ? error.message
            : "The browser could not complete this operation. Retry after the page finishes loading.",
        },
      });
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
