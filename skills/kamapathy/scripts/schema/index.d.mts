export const CLIENT_VERSION: string;
export const API_LEVEL: number;

export type FieldKind =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "enum"
  | "array"
  | "map"
  | "json"
  | "ms"
  | "target"
  | "url"
  | "object";
export interface Field {
  kind: FieldKind;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  values?: readonly string[];
  fields?: Readonly<Record<string, Field>>;
  of?: Field | "action";
  field?: string;
  since?: number;
  description: string;
}
export type Budget =
  | number
  | { field: string; plusMs?: number }
  | { compute: string; maxMs: number };
export type SchemaLane = "space" | "server" | "none" | "body" | "preadmission";
export interface SchemaRoute {
  method: "GET" | "POST" | "DELETE";
  path: string;
  summary: string;
  response: string;
  body: Readonly<Record<string, Field>> | null;
  limit: number;
  budget: Budget;
  lane: SchemaLane;
  follow: boolean;
  label: boolean;
  since: number;
}
export interface ActionSpec {
  type: string;
  summary: string;
  fields: Readonly<Record<string, Field>>;
  since: number;
}
export type TransientRule =
  | { field: string; values: readonly unknown[] }
  | { field: string; min?: number; max?: number }
  | { field: string; absent: true };
export interface ErrorSpec {
  status: number | null;
  override?: { status: number; route: string; action: string };
  /** A code with no status of its own, carried in this route's response. */
  carriedIn?: string;
  transient: boolean | readonly TransientRule[];
  summary: string;
  fields: readonly string[];
  since: number;
}
export interface Arg {
  name: string;
  kind: string;
  optional?: boolean;
  values?: readonly string[];
  since?: number;
  min?: number;
  max?: number;
  nullable?: boolean;
}
export interface Entry {
  name: string;
  kind: "method" | "property" | "global";
  signature: string;
  summary: string;
  args: readonly Arg[];
  overloads?: readonly (readonly Arg[])[];
  options?: Readonly<Record<string, Field>>;
  expected?: string;
  returns: string;
  route?: string;
  errors: readonly string[];
  pageFunction?: true;
  since: number;
}
export interface CommandFlag {
  name: string;
  value?: string;
  description: string;
  since?: number;
}
export interface Command {
  name: string;
  group: string;
  usage: string;
  summary: string;
  arguments: readonly { name: string; description: string }[];
  flags: readonly CommandFlag[];
  stdin?: string;
  route?: string;
  script?: string;
  examples: readonly string[];
  since: number;
}
export interface SelectorForm {
  form: string;
  example: string;
  matches: string;
}
export interface Problem {
  code: string;
  message: string;
  fields: Record<string, unknown>;
}

export const ENTRIES: readonly Entry[];
export const COMMANDS: readonly Command[];
export const ROUTES: readonly SchemaRoute[];
export const ACTIONS: readonly ActionSpec[];
export const ERRORS: Readonly<Record<string, ErrorSpec>>;
export const SELECTOR_FORMS: readonly SelectorForm[];
export const COMPUTE: Readonly<Record<string, (body: Record<string, unknown>) => number>>;

export function routeKey(route: Pick<SchemaRoute, "method" | "path">): string;
export function matchRoute(method: string, path: string): SchemaRoute | undefined;
export function requestBudget(route: SchemaRoute, body?: Record<string, unknown>): number | undefined;
export function isTransient(code: string, fields?: Record<string, unknown>): boolean;
export function checkCall(
  entry: Entry,
  args: readonly unknown[],
  app?: { apiLevel: number; version?: string },
): Problem | null;
export function checkBody(route: Pick<SchemaRoute, "method" | "path" | "body">, body: unknown): Problem | null;
export function outdated(
  name: string,
  required: number,
  app: { apiLevel: number; version?: string },
  option?: string,
): Problem;
export function suggest(name: string, candidates: readonly string[]): string | undefined;
export function editDistance(a: string, b: string): number;
export const GLOBAL_FLAGS: readonly { name: string; description: string }[];
export const ENVIRONMENT: readonly { name: string; description: string }[];
export function findEntry(name: string): Entry | undefined;
export function findCommand(name: string): Command | undefined;
