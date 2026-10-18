import {
  AGENT_TEXT_LIMITS,
  cleanAgentText,
  type AgentTextField,
} from "../../shared/agent-text";
import { isWebUrl } from "../../shared/url";
import {
  ACTIONS,
  API_LEVEL,
  checkBody,
} from "../../skills/kamapathy/scripts/schema/index.mjs";
import type { SnapshotOptions } from "../automation-dom";
import { ApiError, fail } from "./errors";
import type { Route } from "./http";

export const UPLOAD_FILE_LIMIT = 16 * 1024 * 1024;
export const PRESS_KEYS: Record<
  string,
  { key: string; code: string; keyCode: number; text?: string }
> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};
export type ToolAction = {
  type: "snapshot" | "click" | "fill" | "press" | "scroll" | "drag" | "wait";
  payload: Record<string, unknown>;
  // The step's cleaned label; only the batch loop reads it.
  label?: string;
};

export function integerField(
  body: Record<string, unknown>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = body[name] === undefined ? fallback : body[name];
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  )
    return fail(
      "invalid_field",
      `${name} must be an integer from ${minimum} to ${maximum}.`,
    );
  return value;
}
export function targetFields(
  body: Record<string, unknown>,
  optional = false,
): Record<string, unknown> {
  const hasRef = body.ref !== undefined,
    hasSelector = body.selector !== undefined;
  if (!hasRef && !hasSelector && optional) return {};
  if (hasRef === hasSelector)
    return fail(
      "invalid_target",
      "Provide exactly one of ref or selector.",
    );
  if (hasRef) {
    const ref = stringField(body, "ref", 32);
    if (!/^@e[1-9]\d*$/.test(ref))
      return fail(
        "invalid_ref",
        "Use an element reference from a snapshot, such as @e1.",
      );
    return { ref };
  }
  return { selector: stringField(body, "selector", 2048) };
}
function parseAction(type: string, body: Record<string, unknown>): ToolAction {
  if (type === "snapshot") {
    const mode = body.mode ?? "compact";
    if (mode !== "compact" && mode !== "full")
      return fail("invalid_field", "mode must be compact or full.");
    const options: Omit<SnapshotOptions, "firstRef"> = {
      mode,
      maxChars: integerField(
        body,
        "maxChars",
        mode === "compact" ? 4000 : 24000,
        0,
        24000,
      ),
      maxControls: integerField(
        body,
        "maxControls",
        mode === "compact" ? 40 : 100,
        0,
        100,
      ),
      ...(body.selector !== undefined
        ? { selector: stringField(body, "selector", 2048) }
        : {}),
    };
    return { type, payload: options };
  }
  if (type === "click" || type === "fill")
    return {
      type,
      payload: {
        ...targetFields(body),
        ...(type === "fill"
          ? { value: stringField(body, "value", 16384, true) }
          : {}),
      },
    };
  if (type === "press") {
    const key = stringField(body, "key", 20);
    if (!Object.hasOwn(PRESS_KEYS, key))
      return fail(
        "invalid_key",
        `Supported keys: ${Object.keys(PRESS_KEYS).join(", ")}.`,
      );
    return { type, payload: { key, ...targetFields(body, true) } };
  }
  if (type === "scroll") {
    const direction = stringField(body, "direction", 5);
    if (!["up", "down", "left", "right"].includes(direction))
      return fail(
        "invalid_field",
        "direction must be up, down, left, or right.",
      );
    return {
      type,
      payload: {
        direction,
        pixels: integerField(body, "pixels", 600, 1, 2000),
        ...targetFields(body, true),
      },
    };
  }
  if (type === "drag") {
    const endpoint = (name: "source" | "target") => {
      const value = body[name];
      if (!value || typeof value !== "object" || Array.isArray(value))
        return fail(
          "invalid_target",
          `${name} must be an object with a ref or selector.`,
        );
      return targetFields(value as Record<string, unknown>);
    };
    return {
      type,
      payload: { source: endpoint("source"), target: endpoint("target") },
    };
  }
  if (type === "wait")
    return {
      type,
      payload: {
        timeoutMs: integerField(body, "timeoutMs", 5000, 0, 15000),
        ...(body.selector !== undefined
          ? { selector: stringField(body, "selector", 2048) }
          : {}),
        ...(body.text !== undefined
          ? { text: stringField(body, "text", 1000) }
          : {}),
      },
    };
  const types = ACTIONS.map((action) => action.type);
  return fail(
    "invalid_action",
    `Batch actions support ${types.slice(0, -1).join(", ")}, and ${types.at(-1)}.`,
  );
}

// A step, with the label its own route or batch entry may carry.
export function parseToolAction(
  type: string,
  body: Record<string, unknown>,
): ToolAction {
  const action = parseAction(type, body);
  return body.label === undefined
    ? action
    : { ...action, label: agentTextField(body, "label", "label") };
}

// Rejects a body with a field its route does not declare, or a declared
// field of the wrong kind, before the request waits for its lane.
export function validateBody(
  route: Route,
  body: Record<string, unknown> | undefined,
): void {
  const problem = checkBody(route.schema, body);
  if (problem)
    throw new ApiError(
      problem.code,
      problem.message,
      problem.code === "unknown_field"
        ? { ...problem.fields, route: route.key, apiLevel: API_LEVEL }
        : problem.fields,
    );
}

// Checks every agent label a body carries, including each batch step's,
// before the request waits for its lane. The schema has already refused a
// label where no field declares one, so only the cleaning rule is left.
export function checkAgentText(
  route: Route,
  body: Record<string, unknown> | undefined,
): void {
  if (!body) return;
  if (route.schema.label && body.label !== undefined)
    agentTextField(body, "label", "label");
  const steps =
    route.schema.body?.actions?.of === "action" ? body.actions : undefined;
  if (!Array.isArray(steps)) return;
  for (const [index, step] of steps.entries()) {
    const fields = (step ?? {}) as Record<string, unknown>;
    if (fields.label !== undefined)
      agentTextField(fields, "label", "label", { index });
  }
}

// The cleaned label of a single input route's body, or undefined.
export function bodyLabel(
  route: Route,
  body: Record<string, unknown> | undefined,
): string | undefined {
  if (!route.schema.label || body?.label === undefined) return undefined;
  return agentTextField(body, "label", "label");
}

// The segment after /spaces or /tabs is shown as :id.
export function routeNotFound(
  method: string,
  path: string,
  version: string,
): ApiError {
  const route = path
    .replace(/^\/(spaces|tabs)\/[^/]+/, "/$1/:id")
    .slice(0, 200);
  return new ApiError(
    "route_not_found",
    `Kamapathy ${version} (API level ${API_LEVEL}) has no route ${method} ${route}. A newer client may need a newer Kamapathy.`,
    { method, route, apiLevel: API_LEVEL, version },
  );
}

export function stringField(
  body: Record<string, unknown>,
  key: string,
  max: number,
  empty = false,
): string {
  const value = body[key];
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > max
  )
    return fail(
      "invalid_field",
      `${key} must be ${empty ? "a" : "a nonempty"} string of at most ${max} characters.`,
    );
  return value;
}
// Text an agent wrote for the person to read. The raw length is checked
// against its limit before cleaning, so nothing is silently trimmed, and an
// empty result is refused unless an empty value means something to the route.
export function agentTextField(
  body: Record<string, unknown>,
  key: string,
  field: AgentTextField,
  options: { allowEmpty?: boolean; index?: number } = {},
): string {
  const limit = AGENT_TEXT_LIMITS[field];
  const refuse = (expected: string): never =>
    fail("invalid_field", `${key} must be ${expected}.`, {
      field: key,
      expected,
      ...(options.index === undefined ? {} : { index: options.index }),
    });
  const value = body[key];
  if (typeof value !== "string")
    return refuse(`a string of at most ${limit} characters`);
  if (value.length > limit) return refuse(`at most ${limit} characters`);
  const cleaned = cleanAgentText(value);
  if (!cleaned && !options.allowEmpty)
    return refuse("text that is not empty after cleaning");
  return cleaned;
}
export function urlField(body: Record<string, unknown>): string {
  const value = stringField(body, "url", 8192);
  if (!isWebUrl(value))
    return fail(
      "invalid_url",
      "Use a complete HTTP or HTTPS URL without embedded credentials.",
    );
  return new URL(value).href;
}
export function uploadFields(body: Record<string, unknown>) {
  const target = targetFields(body);
  if (!target.ref)
    return fail("invalid_target", "Uploads require a current file input ref from a snapshot.");
  if (!Array.isArray(body.files) || body.files.length < 1 || body.files.length > 8)
    return fail("invalid_files", "Provide between 1 and 8 files.");
  let total = 0;
  const files = body.files.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return fail("invalid_files", "Each file needs a name, MIME type, and base64 content.");
    const file = entry as Record<string, unknown>;
    const name = stringField(file, "name", 255);
    if (/[\\/\u0000-\u001f\u007f]/.test(name) || name === "." || name === "..")
      return fail("invalid_files", "File names must be basenames without control characters.");
    const type = stringField(file, "type", 128, true);
    if (type && !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(type))
      return fail("invalid_files", "Use a valid MIME type or an empty string.");
    const data = stringField(file, "data", Math.ceil(UPLOAD_FILE_LIMIT / 3) * 4, true);
    if (data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(data) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data))
      return fail("invalid_files", "File content must be canonical base64.");
    const decoded = Buffer.from(data, "base64");
    if (decoded.toString("base64") !== data)
      return fail("invalid_files", "File content must be canonical base64.");
    total += decoded.length;
    if (total > UPLOAD_FILE_LIMIT)
      return fail("files_too_large", "Files must total at most 16 MiB per upload.");
    return { name, type, data };
  });
  return { ...target, files };
}
