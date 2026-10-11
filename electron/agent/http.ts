import type { IncomingMessage, ServerResponse } from "node:http";
import type { Space, Tab } from "../../shared/types";
import type { Actions } from "./actions";
import type { Authority } from "./authority";
import { ApiError, fail } from "./errors";
import type { AutomationController } from "./server";

export const BODY_LIMIT = 65536;
export const UPLOAD_BODY_LIMIT = 24 * 1024 * 1024;

export interface RouteCall {
  request: IncomingMessage;
  response: ServerResponse;
  body: Record<string, unknown> | undefined;
  space?: Space;
  tab?: Tab;
  resumeFromHuman: boolean;
}
export interface Route {
  method: "GET" | "POST" | "DELETE";
  path: string[];
  handler(call: RouteCall): Promise<unknown>;
}
export interface RouteDeps {
  controller: AutomationController;
  authority: Authority;
  actions: Actions;
}

export function send(response: ServerResponse, status: number, data: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

export async function readBody(
  request: IncomingMessage,
  limit = BODY_LIMIT,
): Promise<Record<string, unknown>> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")
  )
    return fail(415, "content_type", "Use Content-Type: application/json.");
  const sizeError = `Request body exceeds ${limit / 1024} KiB.`;
  if (Number(request.headers["content-length"] || 0) > limit)
    return fail(413, "body_too_large", sizeError);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error?: ApiError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        request.resume();
        reject(error);
        return;
      }
      try {
        const body: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("Invalid body");
        resolve(body as Record<string, unknown>);
      } catch {
        reject(
          new ApiError(400, "invalid_json", "Body must be a JSON object."),
        );
      }
    };
    const timer = setTimeout(
      () =>
        finish(new ApiError(408, "body_timeout", "Request body timed out.")),
      5000,
    );
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit)
        finish(
          new ApiError(413, "body_too_large", sizeError),
        );
      else chunks.push(chunk);
    });
    request.once("end", () => finish());
    request.once("error", () =>
      finish(new ApiError(400, "invalid_body", "Could not read request body.")),
    );
    request.once("aborted", () =>
      finish(new ApiError(400, "invalid_body", "Request was interrupted.")),
    );
  });
}

export function findRoute(
  routes: Route[],
  method: string | undefined,
  parts: string[],
): Route | undefined {
  return routes.find(
    (route) =>
      route.method === method &&
      route.path.length === parts.length &&
      route.path.every(
        (segment, index) => segment === ":id" || segment === parts[index],
      ),
  );
}
