import type { IncomingMessage, ServerResponse } from "node:http";
import type { Space, Tab } from "../../shared/types";
import {
  COMPUTE,
  ROUTES,
  routeKey,
  type SchemaRoute,
} from "../../skills/kamapathy/scripts/schema/index.mjs";
import type { Actions } from "./actions";
import type { Authority } from "./authority";
import type { Dialogs } from "./dialogs";
import type { Downloads } from "./downloads";
import { ApiError, fail } from "./errors";
import type { FileChoosers } from "./file-choosers";
import type { Navigation } from "./routes/navigation";
import type { Expectations } from "./expectations";
import type { AgentPresence } from "./presence";
import type { Receipts } from "./receipts";
import type { RefBook } from "./refs";
import type { AutomationController } from "./server";
import type { TabSessions } from "./session/tab-sessions";
import type { TabLog } from "./tab-log";

export const BODY_LIMIT = 65536;

// Gives up the request's lane and slot while the wait runs, then takes them
// back and checks the request is still allowed.
export type Park = <T>(wait: () => Promise<T>) => Promise<T>;
export interface Run {
  readonly deadline: number;
  readonly signal: AbortSignal;
  // Set once anything that can change the page has been sent.
  readonly dispatch: { dispatched: boolean };
  park: Park;
}
export interface RouteCall {
  request: IncomingMessage;
  response: ServerResponse;
  body: Record<string, unknown> | undefined;
  space?: Space;
  tab?: Tab;
  resumeFromHuman: boolean;
  run: Run;
  prepared?: unknown;
}
// What a route does. Its lane, budget and body limit come from the schema.
export interface RouteImpl {
  // human "allow" answers while the person has control, and "resume" lets a
  // resume take control back (server.ts decides when). unmanaged lets the
  // route reach tabs the agent has not adopted.
  access?: { human?: "allow" | "resume"; unmanaged?: true };
  // For a route whose path names neither a space nor a tab: the ids its id
  // segment belongs to, which the server authorizes instead of the path's.
  // Throws its own 404 when the id is unknown.
  resolve?(parts: string[]): { spaceId?: string; tabId?: string };
  // Runs after admission, before the body is read.
  beforeBody?(
    call: Pick<RouteCall, "request" | "response" | "space" | "tab">,
  ): { prepared?: unknown; release?(): void };
  handler(call: RouteCall): Promise<unknown>;
}
// Path segments; ":id" matches any one segment.
export interface Route extends RouteImpl {
  key: string;
  method: "GET" | "POST" | "DELETE";
  path: string[];
  lane: "space" | "server" | "none";
  budgetMs: number;
  // A route whose budget depends on its body: what this request gets, which
  // never widens the maximum admission counted.
  budgetOf?(body: Record<string, unknown> | undefined): number;
  bodyLimit: number;
  schema: SchemaRoute;
}

// One route's time budget: a fixed number, a body field's largest value, or
// a computed maximum the request narrows itself.
export function routeBudget(schema: SchemaRoute): {
  budgetMs: number;
  budgetOf?(body: Record<string, unknown> | undefined): number;
} {
  const key = routeKey(schema);
  const { budget } = schema;
  if (typeof budget === "number") return { budgetMs: budget };
  if ("compute" in budget) {
    const compute = COMPUTE[budget.compute];
    if (!compute)
      throw new Error(
        `${key} budgets on ${budget.compute}, which the schema does not compute.`,
      );
    return {
      budgetMs: budget.maxMs,
      budgetOf: (body) => compute(body ?? {}),
    };
  }
  // A wait's own field bounds it; admission counts its largest value.
  const max = schema.body?.[budget.field]?.max;
  if (max === undefined)
    throw new Error(`${key} budgets on a field without a maximum.`);
  return { budgetMs: max + (budget.plusMs ?? 0) };
}

// One route object for each route the schema declares, except /health,
// which the server answers before admission.
export function buildRoutes(impls: Record<string, RouteImpl>): Route[] {
  const declared = ROUTES.filter((route) => route.lane !== "preadmission");
  for (const key of Object.keys(impls))
    if (!declared.some((route) => routeKey(route) === key))
      throw new Error(`${key} is not declared in the schema.`);
  return declared.map((schema) => {
    const key = routeKey(schema);
    const impl = impls[key];
    if (!impl) throw new Error(`${key} has no handler.`);
    if (schema.lane === "body" || schema.lane === "preadmission")
      throw new Error(`${key} uses a lane this router does not run.`);
    const { budgetMs, budgetOf } = routeBudget(schema);
    return {
      ...impl,
      key,
      method: schema.method,
      path: schema.path.split("/").filter(Boolean),
      lane: schema.lane,
      budgetMs,
      ...(budgetOf ? { budgetOf } : {}),
      bodyLimit: schema.limit,
      schema,
    };
  });
}
export interface RouteDeps {
  controller: AutomationController;
  authority: Authority;
  actions: Actions;
  sessions: TabSessions;
  navigation: Navigation;
  tabLog: TabLog;
  receipts: Receipts;
  expectations: Expectations;
  dialogs: Dialogs;
  downloads: Downloads;
  choosers: FileChoosers;
  presence: AgentPresence;
  // The ref numbers a route may hand out, for the file routes, which name
  // the input they picked between two page steps.
  refs: RefBook;
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
    return fail("content_type", "Use Content-Type: application/json.");
  const sizeError = `Request body exceeds ${limit / 1024} KiB.`;
  if (Number(request.headers["content-length"] || 0) > limit)
    return fail("body_too_large", sizeError);
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
          new ApiError("invalid_json", "Body must be a JSON object."),
        );
      }
    };
    const timer = setTimeout(
      () =>
        finish(new ApiError("body_timeout", "Request body timed out.")),
      5000,
    );
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit)
        finish(
          new ApiError("body_too_large", sizeError),
        );
      else chunks.push(chunk);
    });
    request.once("end", () => finish());
    request.once("error", () =>
      finish(new ApiError("invalid_body", "Could not read request body.")),
    );
    request.once("aborted", () =>
      finish(new ApiError("invalid_body", "Request was interrupted.")),
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
