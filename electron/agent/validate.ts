import { isWebUrl } from "../../shared/url";
import {
  ACTIONS,
  API_LEVEL,
  checkBody,
} from "../../skills/kamapathy/scripts/schema/index.mjs";
import type { SnapshotOptions } from "../automation-dom";
import { ApiError, fail } from "./errors";
import { requireScripts, scriptFields, type ScriptSource } from "./evaluate";
import type { Route } from "./http";
import { WAIT_UNTIL, type WaitUntil } from "./navigation/await";
import { MAX_GLOB, compileUrlGlob } from "./navigation/url-glob";
import type { UrlWaitBody } from "./navigation/waits";
import type { AutomationController } from "./server";

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
  type:
    | "snapshot"
    | "click"
    | "fill"
    | "press"
    | "scroll"
    | "drag"
    | "wait"
    | "navigate"
    | "reload"
    | "wait-for-url"
    | "wait-for-load-state"
    | "wait-for-function";
  payload: Record<string, unknown>;
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
export function booleanField(
  body: Record<string, unknown>,
  name: string,
  fallback: boolean,
): boolean {
  const value = body[name] === undefined ? fallback : body[name];
  if (typeof value !== "boolean")
    return fail("invalid_field", `${name} must be true or false.`, {
      field: name,
    });
  return value;
}
// The schema's wording for a list of accepted values.
const either = (values: readonly string[]) =>
  values.length < 3
    ? values.join(" or ")
    : `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
export function enumField<T extends string>(
  body: Record<string, unknown>,
  name: string,
  values: readonly T[],
  fallback: T,
): T {
  const value = body[name] === undefined ? fallback : body[name];
  if (typeof value !== "string" || !values.includes(value as T))
    return fail("invalid_field", `${name} must be ${either(values)}.`, {
      field: name,
    });
  return value as T;
}
export function waitUntilField(
  body: Record<string, unknown>,
  fallback: WaitUntil = "load",
): WaitUntil {
  return enumField(body, "waitUntil", WAIT_UNTIL, fallback);
}
// The Referer header an agent may send, kept exactly as given.
export function refererField(body: Record<string, unknown>): string {
  const value = stringField(body, "referer", 8192);
  if (!isWebUrl(value))
    return fail(
      "invalid_field",
      "referer must be a complete HTTP or HTTPS URL without embedded credentials.",
      { field: "referer" },
    );
  return value;
}
export function navigationFields(body: Record<string, unknown>): {
  url: string;
  waitUntil: WaitUntil;
  timeoutMs: number;
  referer?: string;
} {
  return {
    url: urlField(body),
    waitUntil: waitUntilField(body),
    timeoutMs: integerField(body, "timeoutMs", 15000, 1, 60000),
    ...(body.referer === undefined ? {} : { referer: refererField(body) }),
  };
}
export function reloadFields(body: Record<string, unknown>): {
  waitUntil: WaitUntil;
  timeoutMs: number;
  ignoreCache: boolean;
} {
  return {
    waitUntil: waitUntilField(body),
    timeoutMs: integerField(body, "timeoutMs", 15000, 1, 60000),
    ignoreCache: booleanField(body, "ignoreCache", false),
  };
}
// The URL wait serves two modes: a glob to match, or a navigation count to
// watch from. One body never asks for both.
export function waitForUrlFields(body: Record<string, unknown>): UrlWaitBody {
  const hasGlob = body.url !== undefined;
  const watching = body.after !== undefined;
  if (hasGlob && watching)
    return fail(
      "invalid_field",
      "Give url to match a glob, or after to watch this page's commits, not both.",
      { field: "after" },
    );
  if (!hasGlob && body.waitUntil !== undefined)
    return fail(
      "invalid_field",
      "waitUntil needs a url to match. Watching commits returns as soon as one arrives.",
      { field: "waitUntil" },
    );
  return {
    ...(hasGlob
      ? { glob: compileUrlGlob(stringField(body, "url", MAX_GLOB), "url") }
      : {}),
    waitUntil: waitUntilField(body),
    ...(watching
      ? { after: integerField(body, "after", 0, 0, 2147483647) }
      : {}),
    timeoutMs: integerField(body, "timeoutMs", 10000, 0, 60000),
  };
}
// The load-state wait takes navigate's states, with the quiet window
// networkidle asks for.
export function loadStateFields(body: Record<string, unknown>): {
  state: WaitUntil;
  idleMs: number;
  timeoutMs: number;
} {
  return {
    state: enumField(body, "state", WAIT_UNTIL, "load"),
    idleMs: integerField(body, "idleMs", 500, 0, 10000),
    timeoutMs: integerField(body, "timeoutMs", 10000, 0, 60000),
  };
}
// The function wait takes the page script fields, which the Page scripts
// setting gates, plus how often it looks.
export function waitForFunctionFields(body: Record<string, unknown>): {
  source: ScriptSource;
  intervalMs: number;
  timeoutMs: number;
} {
  return {
    source: scriptFields(body),
    intervalMs: integerField(body, "intervalMs", 100, 10, 10000),
    timeoutMs: integerField(body, "timeoutMs", 10000, 0, 60000),
  };
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
export function parseToolAction(
  type: string,
  body: Record<string, unknown>,
  // A batch validates its whole plan first, so a step the Page scripts
  // setting gates is refused there, before the first action runs. The wait
  // itself checks the setting again when it runs.
  deps?: { controller: AutomationController },
): ToolAction {
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
  if (type === "navigate") return { type, payload: navigationFields(body) };
  if (type === "reload") return { type, payload: reloadFields(body) };
  if (type === "wait-for-url") {
    const fields = waitForUrlFields(body);
    // A step matches a glob; watching commits belongs to the route, which a
    // client loop calls with its own matcher.
    if (!fields.glob)
      return fail("invalid_field", "A wait-for-url step needs a url glob.", {
        field: "url",
      });
    return { type, payload: { ...fields } };
  }
  if (type === "wait-for-load-state")
    return { type, payload: loadStateFields(body) };
  if (type === "wait-for-function") {
    if (deps) requireScripts(deps.controller);
    return { type, payload: { ...waitForFunctionFields(body) } };
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
