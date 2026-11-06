import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApiError, envelope } from "../electron/agent/errors.ts";
import { buildRoutes, routeBudget } from "../electron/agent/http.ts";
import { createNavigation } from "../electron/agent/routes/navigation.ts";
import { pdfRoutes } from "../electron/agent/routes/pdf.ts";
import { downloadRoutes } from "../electron/agent/routes/downloads.ts";
import { eventRoutes } from "../electron/agent/routes/events.ts";
import { fileRoutes } from "../electron/agent/routes/files.ts";
import { spaceRequestRoutes } from "../electron/agent/routes/space-requests.ts";
import { spaceRoutes } from "../electron/agent/routes/spaces.ts";
import { statusRoutes } from "../electron/agent/routes/status.ts";
import { tabRoutes } from "../electron/agent/routes/tabs.ts";
import { updateRoutes } from "../electron/agent/routes/update.ts";
import { parseToolAction } from "../electron/agent/validate.ts";
import { METHOD_PATTERN as SERVER_METHOD_PATTERN } from "../electron/agent/cdp-policy.ts";
import {
  Client,
  Download,
  FileChooser,
  Keyboard,
  Mouse,
  Page,
  Space,
  schema,
} from "../skills/kamapathy/scripts/api.mjs";
import { PARSERS } from "../skills/kamapathy/scripts/kamapathy.mjs";
import { installGlobals } from "../skills/kamapathy/scripts/lib/run.mjs";
import {
  generateReference,
  help,
  helpTopic,
  resolveNames,
} from "../skills/kamapathy/scripts/help.mjs";

const {
  ACTIONS,
  API_LEVEL,
  CLIENT_VERSION,
  COMMANDS,
  COMPUTE,
  ENTRIES,
  ERRORS,
  GLOBAL_FLAGS,
  ROUTES,
  SELECTOR_FORMS,
  checkBody,
  checkCall,
  findCommand,
  findEntry,
  isTransient,
  matchRoute,
  requestBudget,
  routeKey,
  suggest,
} = schema;

const read = (path) => readFileSync(path, "utf8");
const files = (directory) =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
// The arguments of every call to name, as source text.
const calls = (source, name) => {
  const found = [];
  for (
    let at = source.indexOf(`${name}(`);
    at >= 0;
    at = source.indexOf(`${name}(`, at + 1)
  ) {
    if (/[\w$.]/.test(source[at - 1] ?? "")) continue;
    let depth = 0;
    let quote;
    let end = at + name.length;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) {
        if (char === "\\") end++;
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "(") depth++;
      else if (char === ")" && --depth === 0) break;
    }
    found.push(source.slice(at + name.length + 1, end));
  }
  return found;
};
const sinceOf = (field) =>
  Math.max(
    field.since ?? 1,
    ...Object.values(field.fields ?? {}).map(sinceOf),
    ...(field.of && field.of !== "action" ? [sinceOf(field.of)] : []),
  );
const route = (key) => ROUTES.find((item) => routeKey(item) === key);
const entry = (name) => ENTRIES.find((item) => item.name === name);

describe("API schema", () => {
  it("declares every member, command, route, action and code once", () => {
    const names = ENTRIES.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
    // Methods and getters on each prototype, and the fields every instance
    // carries, match the schema's methods and properties.
    const send = async () => {};
    const instances = {
      Client: new Client(send),
      Space: new Space(send, { id: "s", name: "n", owner: "agent" }),
      Page: new Page(send, { id: "t", spaceId: "s", url: "", title: "" }),
      Download: new Download(send, {
        id: "d",
        tabId: "t",
        url: "",
        suggestedFilename: "f",
        mimeType: "",
        state: "completed",
        receivedBytes: 0,
        totalBytes: 0,
        failure: null,
      }),
      FileChooser: new FileChooser(send, {
        id: "c",
        tabId: "t",
        multiple: false,
        accept: [],
      }),
      // A page's own controllers, which it builds in its constructor.
      Mouse: new Mouse(send),
      Keyboard: new Keyboard(send),
    };
    for (const [type, instance] of Object.entries(instances)) {
      const prototype = Object.getPrototypeOf(instance);
      const members = Object.getOwnPropertyNames(prototype).filter(
        (name) => name !== "constructor",
      );
      const getters = members.filter(
        (name) => Object.getOwnPropertyDescriptor(prototype, name).get,
      );
      const methods = members.filter((name) => !getters.includes(name));
      const declared = (kind) =>
        ENTRIES.filter(
          (item) => item.kind === kind && item.name.startsWith(`${type}.`),
        )
          .map((item) => item.name.slice(type.length + 1))
          .sort();
      expect(declared("method"), type).toEqual(methods.sort());
      expect(declared("property"), type).toEqual(
        [...getters, ...Object.keys(instance)].sort(),
      );
    }
    // run defines exactly the declared globals.
    const globals = {};
    installGlobals(globals, new Client(send));
    expect(
      ENTRIES.filter((item) => item.kind === "global")
        .map((item) => item.name)
        .sort(),
    ).toEqual(Object.getOwnPropertyNames(globals).sort());
    // The CLI's commands: one parser each, keyed by the command's name.
    const commands = COMMANDS.map((item) => item.name);
    expect(new Set(commands).size).toBe(commands.length);
    expect(Object.keys(PARSERS).sort()).toEqual(commands.sort());
    // The router's routes, plus /health, which is answered before them.
    const keys = ROUTES.map(routeKey);
    expect(new Set(keys).size).toBe(keys.length);
    const deps = {
      controller: {
        onBlockedRedirect: () => () => {},
        onDownloadStarted: () => () => {},
      },
      authority: {
        managedSpaces: new Set(),
        authorizeSpace() {},
        authorizeTab() {},
      },
      actions: {
        readyContents() {},
        evaluatePage() {},
        executeToolAction() {},
      },
      sessions: { get() {} },
      presence: { setStatus() {}, fail() {}, setState() {} },
    };
    const impls = {
      ...spaceRoutes(deps),
      ...statusRoutes(deps),
      ...tabRoutes(deps),
      ...createNavigation(deps).routes,
      ...pdfRoutes(deps),
      ...eventRoutes(deps),
      ...downloadRoutes(deps),
      ...fileRoutes(deps),
      ...spaceRequestRoutes({ ...deps, grantSpace() {} }).routes,
      ...updateRoutes({}),
    };
    expect(keys.sort()).toEqual([...Object.keys(impls), "GET /health"].sort());
    // The router's lane, budget and body limit come from each entry.
    const built = buildRoutes(impls);
    expect(built.map((item) => item.key).sort()).toEqual(
      ROUTES.filter((item) => item.lane !== "preadmission")
        .map(routeKey)
        .sort(),
    );
    for (const item of built) {
      expect(item.schema, item.key).toBe(route(item.key));
      expect(item.lane, item.key).toBe(item.schema.lane);
      // A field budget admits the field's longest value, and a computed one
      // the maximum it declares.
      const { budget } = item.schema;
      const computed = typeof budget === "object" && "compute" in budget;
      expect(item.budgetMs, item.key).toBe(
        typeof budget === "number"
          ? budget
          : computed
            ? budget.maxMs
            : item.schema.body[budget.field].max + (budget.plusMs ?? 0),
      );
      // Only a computed budget narrows the request from its own body.
      if (computed) {
        expect(item.budgetOf({}), item.key).toBe(COMPUTE[budget.compute]({}));
        expect(item.budgetOf(undefined), item.key).toBe(item.budgetOf({}));
        expect(item.budgetMs, item.key).toBeGreaterThanOrEqual(
          item.budgetOf({}),
        );
      } else expect(item.budgetOf, item.key).toBeUndefined();
      expect(item.bodyLimit, item.key).toBe(item.schema.limit);
      expect(`${item.method} /${item.path.join("/")}`, item.key).toBe(item.key);
    }
    expect(() =>
      buildRoutes({
        ...impls,
        "POST /tabs/:id/goto": impls["POST /tabs/:id/click"],
      }),
    ).toThrow("POST /tabs/:id/goto is not declared in the schema.");
    for (const item of ROUTES) {
      expect(item.limit, routeKey(item)).toBeGreaterThan(0);
      expect(item.budget, routeKey(item)).toBeDefined();
      // Every compute name a route declares has a function and a maximum.
      if (typeof item.budget === "object" && "compute" in item.budget) {
        expect(COMPUTE[item.budget.compute], routeKey(item)).toBeTypeOf(
          "function",
        );
        expect(item.budget.maxMs, routeKey(item)).toBeGreaterThan(0);
      }
      expect(["space", "server", "none", "body", "preadmission"]).toContain(
        item.lane,
      );
      expect(typeof item.follow).toBe("boolean");
      expect(typeof item.label).toBe("boolean");
      expect(Number.isInteger(item.since)).toBe(true);
    }
    // Batch step types: the ones the server parses, which it lists when a
    // step has another.
    const union = read("electron/agent/validate.ts").match(
      /type:\s*([^;]+);/,
    )[1];
    expect(ACTIONS.map((item) => item.type).sort()).toEqual(
      [...union.matchAll(/"([\w-]+)"/g)].map((m) => m[1]).sort(),
    );
    expect(() => parseToolAction("nope", {})).toThrow(
      "Batch actions support snapshot, click, dblclick, hover, fill, select, press, scroll, drag, mouse-click, wait, navigate, reload, wait-for-url, wait-for-load-state, wait-for-selector, and wait-for-function.",
    );
    // Every code the server, the isolated-world code and the client raise.
    const raised = new Set(["element_action_failed"]);
    for (const path of files("electron/agent").filter((name) =>
      name.endsWith(".ts"),
    )) {
      for (const match of read(path).matchAll(
        /\b(?:fail|new ApiError)\(\s*(?:\d+\s*,\s*)?"([a-z_]+)"/g,
      ))
        raised.add(match[1]);
    }
    // The page operations raise through their host, with the code as the last
    // string literal of the call.
    for (const page of [
      "electron/automation-dom.ts",
      "electron/agent/dom/actions.ts",
    ])
      for (const args of calls(read(page), "failure")) {
        const codes = [...args.matchAll(/"([a-z][a-z_]*)"/g)].map((m) => m[1]);
        if (codes.length) raised.add(codes.at(-1));
      }
    const client = read("skills/kamapathy/scripts/api.mjs");
    for (const match of client.matchAll(/new KamapathyError\(\s*"([a-z_]+)"/g))
      raised.add(match[1]);
    expect(raised.size).toBeGreaterThan(40);
    for (const code of raised) expect(ERRORS, code).toHaveProperty(code);
    // What the schema itself names exists.
    for (const item of ENTRIES) {
      for (const code of item.errors)
        expect(ERRORS, item.name).toHaveProperty(code);
      if (item.route) expect(route(item.route), item.name).toBeDefined();
    }
    for (const item of COMMANDS)
      if (item.route) expect(route(item.route), item.name).toBeDefined();
  });

  it("keeps API_LEVEL at the highest since and CLIENT_VERSION at package.json", () => {
    expect(CLIENT_VERSION).toBe(JSON.parse(read("package.json")).version);
    const since = [
      ...ENTRIES.flatMap((item) => [
        item.since,
        ...Object.values(item.options ?? {}).map(sinceOf),
      ]),
      ...COMMANDS.flatMap((item) => [
        item.since,
        ...item.flags.map((flag) => flag.since ?? 1),
      ]),
      ...ROUTES.flatMap((item) => [
        item.since,
        ...Object.values(item.body ?? {}).map(sinceOf),
      ]),
      ...ACTIONS.flatMap((item) => [
        item.since,
        ...Object.values(item.fields).map(sinceOf),
      ]),
      ...Object.values(ERRORS).map((item) => item.since),
    ];
    expect(Math.max(...since)).toBe(API_LEVEL);
    expect(API_LEVEL).toBe(4);
    expect(Math.min(...since)).toBe(1);
    expect(read("docs/automation.md")).toContain(
      `This version is level ${API_LEVEL},`,
    );
  });

  it("assigns statuses by class", () => {
    for (const [code, spec] of Object.entries(ERRORS)) {
      expect(
        spec.status === null || (spec.status >= 400 && spec.status < 600),
        code,
      ).toBe(true);
      if (spec.transient !== false)
        expect([400, 403, 404], code).not.toContain(spec.status);
      if (spec.status === 504) expect(spec.fields, code).toContain("timeoutMs");
      if (code !== "wait_timeout") expect(spec.override, code).toBeUndefined();
    }
    for (const code of ["page_timeout", "action_timeout", "wait_timeout"])
      expect(ERRORS[code].fields).toContain("awaited");
    expect(ERRORS.action_timeout.fields).toEqual(
      expect.arrayContaining(["blocker", "detail", "interceptor"]),
    );
    expect(ERRORS.wait_timeout.status).toBe(504);
    expect(ERRORS.wait_timeout.override).toEqual({
      status: 408,
      route: "POST /tabs/:id/wait",
      action: "wait",
    });
    expect(ERRORS.stale_ref.status).toBe(409);
    expect(ERRORS.element_obscured.status).toBe(409);
    expect(ERRORS.clipboard_blocked).toMatchObject({
      status: 403,
      transient: false,
      since: 4,
    });
    // The codes retargeting and verifying a field raise.
    for (const code of [
      "not_editable",
      "not_selectable",
      "not_focusable",
      "ambiguous_field",
      "fill_not_accepted",
    ])
      expect(ERRORS[code], code).toMatchObject({
        status: 422,
        transient: false,
        since: 4,
      });
    expect(ERRORS.not_editable.fields).toEqual(["reason"]);
    expect(ERRORS.ambiguous_field.fields).toEqual(["candidates"]);
    expect(ERRORS.fill_not_accepted.fields).toEqual(["match"]);
    expect(ERRORS.invalid_selector.status).toBe(400);
    for (const code of [
      "not_connected",
      "timeout",
      "invalid_option",
      "invalid_argument",
      "app_outdated",
      "file_exists",
      "download_interrupted",
    ])
      expect(ERRORS[code].status, code).toBeNull();
    // What the client raises while it writes a download's bytes.
    expect(ERRORS.file_exists).toMatchObject({ transient: false, fields: ["path"] });
    expect(ERRORS.download_interrupted.fields).toEqual(["downloadId", "path"]);
    // One upstream service failure, and codes that only ride in a status
    // name the response that carries them.
    expect(
      Object.entries(ERRORS)
        .filter(([, spec]) => spec.status === 502)
        .map(([code]) => code),
    ).toEqual(["update_check_failed"]);
    for (const [code, spec] of Object.entries(ERRORS))
      if (spec.carriedIn !== undefined) {
        expect(spec.status, code).toBeNull();
        expect(spec.carriedIn, code).toBe("GET /update");
      }
    for (const code of ["update_download_failed", "update_verify_failed"])
      expect(ERRORS[code].carriedIn, code).toBe("GET /update");
  });

  it("evaluates transient rules on fields", () => {
    expect(isTransient("debugger_busy", { reason: "unavailable" })).toBe(true);
    expect(isTransient("debugger_busy", { reason: "devtools" })).toBe(false);
    expect(isTransient("debugger_busy")).toBe(false);
    expect(isTransient("not_connected", { reason: "busy" })).toBe(true);
    expect(isTransient("not_connected", { reason: "access_off" })).toBe(false);
    expect(isTransient("busy", { scope: "space" })).toBe(true);
    expect(isTransient("wait_timeout")).toBe(true);
    expect(isTransient("input_not_delivered")).toBe(true);
    for (const code of [
      "human_control",
      "stale_ref",
      "page_changed",
      "element_action_failed",
      "invalid_field",
    ])
      expect(isTransient(code), code).toBe(false);
    for (const fields of [
      { reason: "offline" },
      { reason: "network" },
      { reason: "timeout" },
      { reason: "rate_limited" },
      { reason: "http_status", httpStatus: 503 },
    ])
      expect(
        isTransient("update_check_failed", fields),
        JSON.stringify(fields),
      ).toBe(true);
    for (const fields of [
      { reason: "invalid_response" },
      { reason: "http_status", httpStatus: 404 },
    ])
      expect(
        isTransient("update_check_failed", fields),
        JSON.stringify(fields),
      ).toBe(false);
    for (const fields of [
      { reason: "network" },
      { reason: "stalled" },
      { reason: "http_status", httpStatus: 502 },
    ])
      expect(
        isTransient("update_download_failed", fields),
        JSON.stringify(fields),
      ).toBe(true);
    for (const fields of [
      { reason: "cancelled" },
      { reason: "size_mismatch" },
      { reason: "insecure_redirect" },
      { reason: "http_status", httpStatus: 404 },
    ])
      expect(
        isTransient("update_download_failed", fields),
        JSON.stringify(fields),
      ).toBe(false);
    for (const reason of ["sums_mismatch", "digest_mismatch", "sums_invalid"])
      expect(isTransient("update_verify_failed", { reason }), reason).toBe(
        false,
      );
    expect(isTransient("no_such_code")).toBe(false);
    // Nothing is retryable once anything reached the page.
    const covered = new ApiError(
      "element_obscured",
      "Another element covers the target.",
    );
    expect(envelope(covered, false).error).toMatchObject({ retryable: true });
    expect(envelope(covered, true).error).toEqual({
      code: "element_obscured",
      message: "Another element covers the target.",
      dispatched: true,
    });
    expect(envelope(new ApiError("stale_ref", "Stale."), false).error).toEqual({
      code: "stale_ref",
      message: "Stale.",
    });
    // A route's own fields never set the flags.
    expect(
      envelope(
        new ApiError("busy", "Busy.", { scope: "space", retryable: false }),
        false,
      ).error,
    ).toEqual({
      code: "busy",
      message: "Busy.",
      scope: "space",
      retryable: true,
    });
    expect(
      envelope(new ApiError("wait_timeout", "Late."), false, { action: "wait" })
        .status,
    ).toBe(408);
    expect(envelope(new ApiError("wait_timeout", "Late."), false).status).toBe(
      504,
    );
    expect(
      envelope(new Error("internal"), true, { fallback: "Try again." }),
    ).toEqual({
      status: 500,
      error: {
        code: "operation_failed",
        message: "Try again.",
        dispatched: true,
      },
    });
    const noisy = `Moved \u202Eon\u0007.${"x".repeat(400)}`;
    expect(
      envelope(new ApiError("page_changed", noisy), false).error.message,
    ).toBe(`Moved on.${"x".repeat(291)}`);
  });

  it("checks options and bodies with today's wording", () => {
    const wait = route("POST /tabs/:id/wait");
    expect(checkBody(wait, { selector: "#done", state: "hidden" })).toEqual({
      code: "unknown_field",
      message:
        'POST /tabs/:id/wait has no field "state". Allowed: selector, text, timeoutMs.',
      fields: { field: "state", allowed: ["selector", "text", "timeoutMs"] },
    });
    expect(checkBody(wait, { timeout: 10000 })).toMatchObject({
      message:
        'POST /tabs/:id/wait has no field "timeout". Allowed: selector, text, timeoutMs. Did you mean "timeoutMs"?',
      fields: { suggestion: "timeoutMs" },
    });
    expect(checkBody(wait, { timeoutMs: 99999 })).toEqual({
      code: "invalid_field",
      message: "timeoutMs must be an integer from 0 to 15000.",
      fields: { field: "timeoutMs", expected: "an integer from 0 to 15000" },
    });
    expect(checkBody(wait, { selector: undefined, text: "Done" })).toBeNull();
    const spaces = route("POST /spaces");
    for (const body of [{ name: "  " }, {}, { name: "x".repeat(49) }])
      expect(checkBody(spaces, body)?.message).toBe(
        "name must be a nonempty string of at most 48 characters.",
      );
    expect(
      checkBody(spaces, { name: "Research", isolated: "yes" })?.message,
    ).toBe("isolated must be true or false.");
    expect(
      checkBody(route("POST /tabs/:id/snapshot"), { mode: "big" })?.message,
    ).toBe("mode must be compact or full.");
    expect(
      checkBody(route("POST /tabs/:id/scroll"), { direction: "sideways" })
        ?.message,
    ).toBe("direction must be up, down, left, or right.");
    expect(
      checkBody(route("POST /tabs/:id/fill"), { ref: "@e1", value: "" }),
    ).toBeNull();
    expect(
      checkBody(route("POST /spaces/:id/handoff"), { now: true })?.message,
    ).toBe('POST /spaces/:id/handoff has no field "now". Allowed: none.');
    const drag = route("POST /tabs/:id/drag");
    expect(
      checkBody(drag, {
        source: { ref: "@e1", extra: 1 },
        target: { selector: "#b" },
      }),
    ).toEqual({
      code: "unknown_field",
      message:
        'POST /tabs/:id/drag has no field "source.extra". Allowed: ref, selector.',
      fields: { field: "source.extra", allowed: ["ref", "selector"] },
    });
    expect(
      checkBody(drag, { source: "#a", target: { selector: "#b" } })?.message,
    ).toBe("source must be an object.");
    expect(
      checkBody(drag, { source: { ref: 5 }, target: { selector: "#b" } })
        ?.message,
    ).toBe("source.ref must be a nonempty string of at most 32 characters.");
    const batch = route("POST /tabs/:id/actions");
    expect(
      checkBody(batch, {
        actions: [
          { type: "click", ref: "@e1" },
          { type: "wait", timeout: 5 },
        ],
      }),
    ).toEqual({
      code: "unknown_field",
      message:
        'Batch step 2 (wait) has no field "timeout". Allowed: type, selector, text, timeoutMs. Did you mean "timeoutMs"?',
      fields: {
        field: "timeout",
        allowed: ["type", "selector", "text", "timeoutMs"],
        index: 1,
        action: "wait",
        suggestion: "timeoutMs",
      },
    });
    const types = [
      "snapshot",
      "click",
      "dblclick",
      "hover",
      "fill",
      "select",
      "press",
      "scroll",
      "drag",
      "mouse-click",
      "wait",
      "navigate",
      "reload",
      "wait-for-url",
      "wait-for-load-state",
      "wait-for-selector",
      "wait-for-function",
    ];
    expect(checkBody(batch, { actions: [{ type: "nope" }] })).toEqual({
      code: "invalid_action",
      message:
        "Batch actions support snapshot, click, dblclick, hover, fill, select, press, scroll, drag, mouse-click, wait, navigate, reload, wait-for-url, wait-for-load-state, wait-for-selector, and wait-for-function.",
      fields: { allowed: types, index: 0 },
    });
    for (const action of ["click", {}, null, { type: 5 }])
      expect(checkBody(batch, { actions: [action] })).toEqual({
        code: "invalid_action",
        message: "Each action must be an object with a type.",
        fields: { allowed: types, index: 0 },
      });
    expect(
      checkBody(batch, {
        actions: [
          { type: "snapshot" },
          { type: "scroll", direction: "up", pixels: 0 },
        ],
      }),
    ).toEqual({
      code: "invalid_field",
      message: "pixels must be an integer from 1 to 2000.",
      fields: {
        field: "pixels",
        expected: "an integer from 1 to 2000",
        index: 1,
      },
    });
    // The route keeps its own count check.
    expect(checkBody(batch, { actions: [] })).toBeNull();
    expect(checkBody(batch, {})?.message).toBe("actions must be an array.");

    const pageWait = entry("Page.wait");
    expect(
      checkCall(pageWait, [{ selector: "#done", state: "hidden" }]),
    ).toEqual({
      code: "invalid_option",
      message:
        'page.wait got unknown option "state". Expected page.wait({ selector?, text?, timeoutMs? }).',
      fields: {
        entry: "page.wait",
        option: "state",
        expected: "page.wait({ selector?, text?, timeoutMs? })",
      },
    });
    expect(checkCall(pageWait, [{ timeout: 10000 }])).toMatchObject({
      message:
        'page.wait got unknown option "timeout". Expected page.wait({ selector?, text?, timeoutMs? }). Did you mean "timeoutMs"?',
      fields: { suggestion: "timeoutMs" },
    });
    expect(checkCall(pageWait, [{ timeoutMs: 20000 }])).toMatchObject({
      code: "invalid_option",
      message:
        "page.wait got an invalid option: timeoutMs must be an integer from 0 to 15000. Expected page.wait({ selector?, text?, timeoutMs? }).",
      fields: { option: "timeoutMs" },
    });
    expect(checkCall(pageWait, [{ timeoutMs: undefined }])).toBeNull();
    expect(checkCall(pageWait, [])).toBeNull();
    expect(checkCall(pageWait, ["#done"])).toMatchObject({
      code: "invalid_option",
      message:
        "page.wait got a string instead of an options object. Expected page.wait({ selector?, text?, timeoutMs? }).",
    });
    const click = entry("Page.click");
    expect(checkCall(click, [])).toEqual({
      code: "invalid_argument",
      message:
        "page.click got no target. Expected page.click(target, { button?, clickCount?, delay?, position?, force?, timeout?, label? }).",
      fields: {
        entry: "page.click",
        expected: "page.click(target, { button?, clickCount?, delay?, position?, force?, timeout?, label? })",
      },
    });
    expect(checkCall(click, ["#a", "#b"])?.message).toBe(
      "page.click got a string instead of an options object. Expected page.click(target, { button?, clickCount?, delay?, position?, force?, timeout?, label? }).",
    );
    expect(checkCall(click, [42])?.message).toBe(
      "page.click got a number for target. Expected page.click(target, { button?, clickCount?, delay?, position?, force?, timeout?, label? }).",
    );
    expect(checkCall(click, ["@e1", undefined])).toBeNull();
    expect(checkCall(click, ["@e1", { label: "Add to cart" }])).toBeNull();
    const scroll = entry("Page.scroll");
    for (const args of [
      ["down"],
      ["down", 300],
      ["down", ".panel"],
      ["down", 300, "#list"],
      ["down", 300, "#list", { label: "Read the terms" }],
      ["down", ".panel", { label: "Read the panel" }],
      ["down", undefined, undefined, { label: "Read the page" }],
    ])
      expect(checkCall(scroll, args), JSON.stringify(args)).toBeNull();
    expect(checkCall(scroll, ["sideways"])?.message).toBe(
      'page.scroll got "sideways" for direction. Expected page.scroll(direction, pixels?, target?, { label? }) or page.scroll(direction, target, { label? }).',
    );
    expect(checkCall(scroll, ["down", 300, "#list", 1])?.code).toBe(
      "invalid_option",
    );
    expect(
      checkCall(entry("Page.batch"), [[{ type: "wait", timeout: 5 }]]),
    ).toMatchObject({
      code: "invalid_argument",
      fields: { entry: "page.batch", index: 0 },
    });
    expect(
      checkCall(entry("Client.createSpace"), ["Research", { isolated: true }]),
    ).toBeNull();
    expect(
      checkCall(entry("createSpace"), ["Research", { isolate: true }])?.message,
    ).toBe(
      'createSpace got unknown option "isolate". Expected createSpace(name, { isolated?, pageBudget? }). Did you mean "isolated"?',
    );

    const goto = {
      name: "Page.goto",
      kind: "method",
      signature: "page.goto(url)",
      args: [{ name: "url", kind: "url" }],
      errors: [],
      since: 2,
    };
    expect(checkCall(goto, ["https://example.com/"])).toBeNull();
    expect(
      checkCall(goto, ["https://example.com/"], {
        apiLevel: 1,
        version: "0.2.0",
      }),
    ).toEqual({
      code: "app_outdated",
      message:
        "page.goto needs Kamapathy API level 2, and Kamapathy 0.2.0 has level 1. Ask the person to update Kamapathy, then read the skill again.",
      fields: {
        entry: "page.goto",
        required: 2,
        available: 1,
        appVersion: "0.2.0",
      },
    });
    expect(
      checkCall(goto, ["https://example.com/"], { apiLevel: 1 })?.message,
    ).toBe(
      "page.goto needs Kamapathy API level 2, and Kamapathy has level 1. Ask the person to update Kamapathy, then read the skill again.",
    );
    expect(
      checkCall(goto, ["https://example.com/"], { apiLevel: 2 }),
    ).toBeNull();

    // An argument the app predates, and the overload order that keeps a path
    // string working while an options object is checked as options.
    const screenshot = entry("Page.screenshot");
    expect(screenshot.overloads[0][0]).toMatchObject({
      kind: "options",
      since: 3,
    });
    expect(checkCall(screenshot, [{}], { apiLevel: 3 })).toBeNull();
    expect(
      checkCall(screenshot, [{}], { apiLevel: 2, version: "0.2.0" }),
    ).toEqual({
      code: "app_outdated",
      message:
        "page.screenshot needs Kamapathy API level 3, and Kamapathy 0.2.0 has level 2. Ask the person to update Kamapathy, then read the skill again.",
      fields: {
        entry: "page.screenshot",
        required: 3,
        available: 2,
        appVersion: "0.2.0",
      },
    });
    expect(checkCall(screenshot, ["/tmp/a.png"], { apiLevel: 2 })).toBeNull();
    expect(checkCall(screenshot, [{ timeoutMs: 5000 }])).toMatchObject({
      code: "invalid_option",
      fields: {
        entry: "page.screenshot",
        option: "timeoutMs",
        suggestion: "timeout",
        expected: "page.screenshot(options?) or page.screenshot(path)",
      },
    });
    expect(
      checkCall(screenshot, [{ fullPage: true }], { apiLevel: 2 }),
    ).toMatchObject({ code: "app_outdated", fields: { option: "fullPage" } });
    expect(checkCall(screenshot, [5])?.code).toBe("invalid_option");

    // File lists are counted, and credentials are checked as a body, before
    // anything is read or sent.
    const setInputFiles = entry("Page.setInputFiles");
    for (const args of [
      ["@e1", []],
      ["#resume", ["a.pdf"]],
      ["#resume", Array(8).fill("a.pdf"), { timeout: 0 }],
    ])
      expect(checkCall(setInputFiles, args), JSON.stringify(args)).toBeNull();
    for (const files of [Array(9).fill("a.pdf"), "a.pdf", ["a.pdf", ""], [5], undefined])
      expect(checkCall(setInputFiles, ["@e1", files]), JSON.stringify(files)).toMatchObject({
        code: "invalid_argument",
        fields: {
          entry: "page.setInputFiles",
          expected: "page.setInputFiles(target, files, { timeout? }) with 0 to 8 file paths",
        },
      });
    expect(checkCall(setInputFiles, ["@e1", [], { timeoutMs: 1000 }])).toMatchObject({
      code: "invalid_option",
      fields: { option: "timeoutMs", suggestion: "timeout" },
    });
    const setFiles = entry("FileChooser.setFiles");
    expect(checkCall(setFiles, [[]])).toBeNull();
    expect(checkCall(setFiles, [Array(9).fill("a.pdf")])?.fields.expected).toBe(
      "fileChooser.setFiles(files) with 0 to 8 file paths",
    );
    const credentials = entry("Space.setHTTPCredentials");
    for (const value of [null, { origin: "https://example.com", username: "a", password: "b" }])
      expect(checkCall(credentials, [value]), JSON.stringify(value)).toBeNull();
    for (const value of [undefined, "https://example.com", 5, [], {}, { origin: 5 }])
      expect(checkCall(credentials, [value]), JSON.stringify(value)).toMatchObject({
        code: "invalid_argument",
        fields: {
          entry: "space.setHTTPCredentials",
          expected:
            "space.setHTTPCredentials({ origin, username, password }) or space.setHTTPCredentials(null)",
        },
      });
    const signIn = route("POST /spaces/:id/http-credentials");
    expect(checkBody(signIn, { origin: "https://example.com", username: "a", password: "" })).toBeNull();
    expect(checkBody(signIn, { origin: "https://example.com", username: "a" })?.message).toBe(
      "password must be a string of at most 1024 characters.",
    );
    expect(checkBody(signIn, { origin: "https://example.com", username: "a", password: "b", host: "x" })).toMatchObject(
      { code: "unknown_field", fields: { field: "host" } },
    );

    expect(suggest("timeout", ["selector", "timeoutMs"])).toBe("timeoutMs");
    expect(suggest("selecter", ["selector", "text"])).toBe("selector");
    expect(suggest("zzz", ["ref", "selector"])).toBeUndefined();
  });

  it("finds entries, commands, routes and budgets", () => {
    expect(findEntry("Page.wait")?.signature).toBe("page.wait(options?)");
    expect(findEntry("page.wait")?.name).toBe("Page.wait");
    expect(findEntry("createSpace")?.kind).toBe("global");
    expect(findCommand("space create")?.route).toBe("POST /spaces");
    expect(matchRoute("POST", "/tabs/t-1/wait")).toBe(
      route("POST /tabs/:id/wait"),
    );
    expect(matchRoute("GET", "/tabs/t-1/wait")).toBeUndefined();
    expect(matchRoute("DELETE", "/spaces/s-1")).toBe(
      route("DELETE /spaces/:id"),
    );
    expect(requestBudget(route("POST /tabs/:id/actions"))).toBe(60000);
    expect(requestBudget(route("POST /tabs/:id/click"), { ref: "@e1" })).toBe(
      18100,
    );
    expect(route("POST /tabs/:id/upload").limit).toBe(24 * 1024 * 1024);
    expect(route("GET /health").lane).toBe("preadmission");
  });

  it("computes the budget a pressing route's own body asks for", () => {
    // The timeout, one delay per gap, and the settle and load wait of 15100.
    expect(COMPUTE.clickBudget({ ref: "@e1" })).toBe(18100);
    expect(COMPUTE.clickBudget({ ref: "@e1", timeoutMs: 10000 })).toBe(25100);
    expect(
      COMPUTE.clickBudget({ timeoutMs: 0, clickCount: 3, delayMs: 100 }),
    ).toBe(15600);
    expect(
      COMPUTE.clickBudget({ timeoutMs: 60000, clickCount: 3, delayMs: 5000 }),
    ).toBe(100100);
    expect(COMPUTE.dblclickBudget({ delayMs: 50 })).toBe(18250);
    expect(COMPUTE.dblclickBudget({ timeoutMs: 60000, delayMs: 5000 })).toBe(
      90100,
    );
    expect(COMPUTE.dragBudget({})).toBe(18100);
    expect(COMPUTE.dragBudget({ timeoutMs: 60000 })).toBe(75100);
    // A press without a target waits for no element.
    expect(COMPUTE.pressBudget({ key: "Enter" })).toBe(15100);
    expect(COMPUTE.pressBudget({ key: "Enter", ref: "@e1" })).toBe(18100);
    expect(
      COMPUTE.pressBudget({ key: "a", selector: "#name", delayMs: 5000 }),
    ).toBe(23100);
    // mouse/click also waits up to 3000 ms for its move to land.
    expect(COMPUTE.mouseClickBudget({})).toBe(18100);
    expect(COMPUTE.mouseClickBudget({ clickCount: 2, delayMs: 5000 })).toBe(
      33100,
    );
    expect(COMPUTE.typeBudget({ text: "hello" })).toBe(10000);
    expect(COMPUTE.typeBudget({ text: "hello", delayMs: 1000 })).toBe(15000);
    expect(COMPUTE.rawBudget({})).toBe(10000);
    // The router takes the declared maximum and narrows each request itself.
    const click = {
      ...route("POST /tabs/:id/click"),
      budget: { compute: "clickBudget", maxMs: 100100 },
    };
    const budget = routeBudget(click);
    expect(budget.budgetMs).toBe(100100);
    expect(budget.budgetOf({ ref: "@e1", timeoutMs: 10000 })).toBe(25100);
    expect(() =>
      routeBudget({ ...click, budget: { compute: "noBudget", maxMs: 10 } }),
    ).toThrow(
      "POST /tabs/:id/click budgets on noBudget, which the schema does not compute.",
    );
    expect(() =>
      routeBudget({ ...click, budget: { field: "force" } }),
    ).toThrow("POST /tabs/:id/click budgets on a field without a maximum.");
  });

  it("the status and fail routes are declared at level 3", () => {
    const declared = [
      [
        "POST /spaces/:id/status",
        "text",
        { kind: "string", min: 0, max: 120, required: true, since: 3 },
      ],
      [
        "POST /spaces/:id/fail",
        "message",
        { kind: "string", min: 1, max: 300, required: true, since: 3 },
      ],
    ];
    for (const [key, name, field] of declared) {
      const item = route(key);
      expect(item, key).toBeDefined();
      expect(item.lane, key).toBe("space");
      expect(item.budget, key).toBe(10000);
      expect(item.limit, key).toBe(65536);
      expect(item.follow, key).toBe(false);
      expect(item.label, key).toBe(false);
      expect(item.since, key).toBe(3);
      expect(Object.keys(item.body), key).toEqual([name]);
      expect(item.body[name], key).toMatchObject(field);
      expect(typeof item.body[name].description, key).toBe("string");
    }
    expect(API_LEVEL).toBeGreaterThanOrEqual(3);
    // The reference and the documented table carry them.
    const reference = read("skills/kamapathy/references/api.md");
    const docs = read("docs/automation.md");
    for (const [key] of declared) {
      const path = key.split(" ")[1];
      expect(reference, key).toContain(`\`${path}\``);
      expect(docs, key).toContain(`\`${path}\``);
    }
  });

  it("the body lane is declared and built", () => {
    const item = route("POST /tabs/:id/cdp");
    expect(item).toBeDefined();
    expect(item.lane).toBe("body");
    expect(item.limit).toBe(1048576);
    expect(item.follow).toBe(true);
    expect(item.label).toBe(false);
    expect(item.since).toBe(4);
    expect(item.budget).toEqual({ field: "timeoutMs" });
    expect(Object.keys(item.body)).toEqual([
      "method",
      "params",
      "frame",
      "timeoutMs",
    ]);
    expect(item.body.method).toMatchObject({
      kind: "string",
      max: 64,
      required: true,
      since: 4,
    });
    expect(item.body.params).toMatchObject({ kind: "json", since: 4 });
    expect(item.body.frame).toMatchObject({
      kind: "string",
      max: 160,
      since: 4,
    });
    // The budget is the field's own maximum, as the router admits it.
    expect(routeBudget(item)).toEqual({ budgetMs: 60000 });
    // The router runs the lane only with a way to pick it from the body.
    const stub = Object.fromEntries(
      ROUTES.filter((entry) => entry.lane !== "preadmission").map((entry) => [
        routeKey(entry),
        {
          handler: () => {},
          ...(entry.lane === "body" ? { laneFor: () => "space" } : {}),
        },
      ]),
    );
    const built = buildRoutes(stub).find(
      (entry) => entry.key === routeKey(item),
    );
    expect(built.lane).toBe("body");
    expect(built.budgetMs).toBe(60000);
    expect(() =>
      buildRoutes({ ...stub, [routeKey(item)]: { handler: () => {} } }),
    ).toThrow("POST /tabs/:id/cdp needs a lane for its body.");
    // The route the client and the person read about.
    expect(read("skills/kamapathy/references/api.md")).toContain(
      "`/tabs/:id/cdp`",
    );
    expect(read("docs/automation.md")).toContain("`/tabs/:id/cdp`");
  });

  it("the input routes and their batch steps declare label at level 3", () => {
    const inputs = [
      "click",
      "dblclick",
      "hover",
      "fill",
      "select",
      "focus",
      "press",
      "scroll",
      "drag",
    ];
    for (const type of inputs) {
      const key = `POST /tabs/:id/${type}`;
      const item = route(key);
      expect(item.label, key).toBe(true);
      expect(item.body.label, key).toMatchObject({
        kind: "string",
        min: 1,
        max: 60,
        since: 3,
      });
      expect(item.body.label.required, key).toBeUndefined();
      expect(typeof item.body.label.description, key).toBe("string");
      // Focus is the one input route with no batch step of its own.
      const step = ACTIONS.find((action) => action.type === type);
      if (step) expect(step.fields.label, type).toBe(item.body.label);
    }
    // Only the routes that take one declare the flag, and the flag and the
    // field never disagree.
    for (const item of ROUTES)
      expect(item.label, routeKey(item)).toBe(item.body?.label !== undefined);
    expect(
      ROUTES.filter((item) => item.label).map(routeKey),
      "routes that take a label",
    ).toEqual(inputs.map((type) => `POST /tabs/:id/${type}`));
    // Every other batch step keeps refusing one.
    for (const action of ACTIONS)
      if (!inputs.includes(action.type))
        expect(action.fields.label, action.type).toBeUndefined();
    // The generated reference and the documented table show the field.
    for (const text of [
      read("skills/kamapathy/references/api.md"),
      read("docs/automation.md"),
    ])
      for (const type of inputs) {
        const row = text
          .split("\n")
          .find(
            (line) =>
              line.startsWith("| POST") &&
              line.includes(`\`/tabs/:id/${type}\``),
          );
        expect(row, type).toContain("`label?`");
      }
  });

  it("the new members and commands are declared at level 3", () => {
    for (const [name, returns] of [
      ["Space.status", "string | undefined"],
      ["Space.state", '"needs-you" | "done" | "failed" | "error" | undefined'],
    ]) {
      const item = entry(name);
      expect(item, name).toMatchObject({ kind: "property", since: 3, returns });
      expect(item.signature, name).toBe(`space.${name.slice(6)}`);
    }
    const setStatus = entry("Space.setStatus");
    expect(setStatus).toMatchObject({
      kind: "method",
      signature: "space.setStatus(text)",
      returns: "Promise<{ ok: true, status?: string }>",
      route: "POST /spaces/:id/status",
      since: 3,
    });
    const fail = entry("Space.fail");
    expect(fail).toMatchObject({
      kind: "method",
      signature: "space.fail(message)",
      returns:
        'Promise<{ ok: true, owner: "human", state: "failed", status: string }>',
      route: "POST /spaces/:id/fail",
      since: 3,
    });
    for (const item of [setStatus, fail])
      expect(item.errors, item.name).toEqual(
        expect.arrayContaining([
          "invalid_field",
          "human_control",
          "space_not_found",
          "automation_stopped",
        ]),
      );
    // The text and the message are bounded before anything connects.
    for (const text of [null, "", "x".repeat(120)])
      expect(checkCall(setStatus, [text]), String(text)).toBeNull();
    expect(checkCall(setStatus, ["x".repeat(121)])).toEqual({
      code: "invalid_argument",
      message:
        "space.setStatus got a string for text. Expected space.setStatus(text) with at most 120 characters, or null to clear.",
      fields: {
        entry: "space.setStatus",
        expected:
          "space.setStatus(text) with at most 120 characters, or null to clear",
      },
    });
    expect(checkCall(setStatus, [5])?.code).toBe("invalid_argument");
    expect(checkCall(setStatus, [])?.message).toBe(
      "space.setStatus got no text. Expected space.setStatus(text) with at most 120 characters, or null to clear.",
    );
    expect(checkCall(fail, ["No phone number"])).toBeNull();
    expect(checkCall(fail, [""])).toMatchObject({
      code: "invalid_argument",
      message:
        "space.fail got an empty string for message. Expected space.fail(message) with 1 to 300 characters.",
    });
    for (const message of [null, "x".repeat(301)])
      expect(checkCall(fail, [message])?.code, String(message)).toBe(
        "invalid_argument",
      );
    // The commands and the flag.
    expect(findCommand("status")).toMatchObject({
      group: "Spaces",
      usage: "status <space-id> <text> | status <space-id> --clear",
      route: "POST /spaces/:id/status",
      script: "space.setStatus",
      since: 3,
    });
    expect(findCommand("status").flags.map((flag) => flag.name)).toEqual([
      "--clear",
    ]);
    expect(findCommand("fail")).toMatchObject({
      group: "Spaces",
      usage: "fail <space-id> <message>",
      route: "POST /spaces/:id/fail",
      script: "space.fail",
      since: 3,
    });
    for (const name of ["click", "fill", "press", "scroll", "drag"]) {
      const command = findCommand(name);
      const flag = command.flags.find((item) => item.name === "--label");
      expect(flag, name).toMatchObject({ value: "<text>", since: 3 });
      expect(typeof flag.description, name).toBe("string");
      expect(command.usage, name).toContain("[--label <text>]");
    }
    // Each new member is found by canonical, instance-style and bare name.
    const names = (query) => resolveNames(query).map((item) => item.name);
    for (const name of ["status", "state", "setStatus", "fail"]) {
      expect(names(`Space.${name}`), name).toEqual([`Space.${name}`]);
      expect(names(`space.${name}`), name).toEqual([`Space.${name}`]);
      expect(names(name), name).toEqual([`Space.${name}`]);
    }
    // The generated reference carries the members and the commands.
    const reference = read("skills/kamapathy/references/api.md");
    for (const text of [
      "`space.setStatus(text)`",
      "`space.fail(message)`",
      "`space.status`",
      "`space.state`",
      "`status <space-id> <text> | status <space-id> --clear`",
      "`fail <space-id> <message>`",
      "`page.click(target, options?)`",
    ])
      expect(reference, text).toContain(text);
  });

  it("the site pack members, globals and commands are declared at level 4", () => {
    const summaries = {
      sitePacks:
        "Lists the site packs in the workspace and the skill, or the ones matching a page.",
      siteContext:
        "Reads the notes and tools of every pack matching a page, with example calls.",
    };
    const returns = {
      sitePacks:
        "Promise<{ host?: string | null, packs: PackSummary[], skipped: Skipped[] }>",
      siteContext:
        "Promise<{ url: string, host: string | null, packs: PackContext[], skipped: Skipped[] }>",
    };
    for (const [name, signature] of [
      ["sitePacks", "sitePacks(target?)"],
      ["siteContext", "siteContext(target)"],
    ]) {
      const global = entry(name);
      const method = entry(`Client.${name}`);
      expect(global, name).toMatchObject({
        kind: "global",
        signature,
        summary: summaries[name],
        returns: returns[name],
        errors: ["invalid_argument"],
        since: 4,
      });
      expect(method, name).toMatchObject({
        kind: "method",
        signature: `kamapathy.${signature}`,
        summary: summaries[name],
        returns: returns[name],
        errors: ["invalid_argument"],
        since: 4,
      });
      for (const item of [global, method]) {
        // Neither declares a route: both are answered from the files on this
        // computer, so the client checks them without the app's level and no
        // argument carries one of its own.
        expect(item.route, item.name).toBeUndefined();
        expect(item.args, item.name).toEqual([
          {
            name: "target",
            kind: "site",
            ...(name === "sitePacks" ? { optional: true } : {}),
          },
        ]);
        // A URL, a host and a Page fit; anything else is invalid_argument,
        // and a second argument is refused.
        for (const target of [
          "github.com",
          "https://github.com/kamapathy",
          { url: "https://github.com/" },
        ])
          expect(checkCall(item, [target]), item.name).toBeNull();
        for (const target of [5, true, null, {}, "", { id: "tab-1" }])
          expect(
            checkCall(item, [target])?.code,
            `${item.name} ${JSON.stringify(target)}`,
          ).toBe("invalid_argument");
        expect(
          checkCall(item, ["github.com", { json: true }])?.message,
          item.name,
        ).toContain("got 2 arguments");
      }
    }
    expect(checkCall(entry("sitePacks"), [])).toBeNull();
    expect(checkCall(entry("Client.sitePacks"), [])).toBeNull();
    expect(checkCall(entry("siteContext"), [])?.message).toBe(
      "siteContext got no target. Expected siteContext(target).",
    );
    // runSiteTool: the same declaration as a global and as a method, with
    // the page option and the codes it raises.
    const page = new Page(async () => {}, {
      id: "t",
      spaceId: "s",
      url: "",
      title: "",
    });
    for (const item of [entry("runSiteTool"), entry("Client.runSiteTool")]) {
      expect(item, item.name).toMatchObject({
        summary: "Runs a site pack's Node tool in the agent's own Node.js.",
        returns: "Promise<unknown>",
        errors: [
          "invalid_argument",
          "site_pack_not_found",
          "site_tool_not_found",
          "site_pack_invalid",
          "invalid_tool_args",
          "site_tool_failed",
        ],
        since: 4,
      });
      // It declares no route: the client reads the pack and runs its file.
      expect(item.route, item.name).toBeUndefined();
      expect(item.args, item.name).toEqual([
        { name: "packId", kind: "string" },
        { name: "tool", kind: "string" },
        { name: "args", kind: "json", optional: true },
        { name: "options", kind: "options" },
      ]);
      expect(item.options, item.name).toEqual({
        page: {
          kind: "page",
          required: true,
          description: "The agent page the tool works in.",
        },
      });
      // A Page fits the page option, and arguments may be left out.
      for (const args of [
        ["github", "search_repositories", { query: "kamapathy" }, { page }],
        ["github", "search_repositories", undefined, { page }],
      ])
        expect(checkCall(item, args), item.name).toBeNull();
      expect(
        checkCall(item, ["github", "search_repositories", {}])?.code,
        item.name,
      ).toBe("invalid_argument");
      for (const options of [{}, { page: "p1" }, { page: null }, { page: 5 }])
        expect(
          checkCall(item, ["github", "search_repositories", {}, options])?.code,
          `${item.name} ${JSON.stringify(options)}`,
        ).toBe("invalid_option");
    }
    expect(entry("runSiteTool")).toMatchObject({
      kind: "global",
      signature: "runSiteTool(packId, tool, args, options)",
    });
    expect(entry("Client.runSiteTool")).toMatchObject({
      kind: "method",
      signature: "kamapathy.runSiteTool(packId, tool, args, options)",
    });
    // runPageTool: the same arguments and option, with the page script codes
    // beside the pack's own and nothing of its own to send.
    for (const item of [entry("runPageTool"), entry("Client.runPageTool")]) {
      expect(item, item.name).toMatchObject({
        summary:
          "Runs a site pack's page tool in the page, through one evaluate.",
        returns: "Promise<unknown>",
        // The hint about page functions not seeing script variables belongs
        // to this call too.
        pageFunction: true,
        errors: [
          "invalid_argument",
          "site_pack_not_found",
          "site_tool_not_found",
          "site_pack_invalid",
          "invalid_tool_args",
          "agent_scripts_off",
          "script_error",
          "result_too_large",
          "evaluation_timeout",
          "request_too_large",
        ],
        since: 4,
      });
      expect(item.route, item.name).toBeUndefined();
      expect(item.args, item.name).toEqual(entry("runSiteTool").args);
      expect(item.options, item.name).toEqual(entry("runSiteTool").options);
      expect(
        checkCall(item, ["github", "repository_stats", {}, { page }]),
        item.name,
      ).toBeNull();
      expect(
        checkCall(item, ["github", "repository_stats", undefined, { page }]),
        item.name,
      ).toBeNull();
      for (const options of [{}, { page: "p1" }, { page: null }])
        expect(
          checkCall(item, ["github", "repository_stats", {}, options])?.code,
          `${item.name} ${JSON.stringify(options)}`,
        ).toBe("invalid_option");
    }
    expect(entry("runPageTool")).toMatchObject({
      kind: "global",
      signature: "runPageTool(packId, tool, args, options)",
    });
    expect(entry("Client.runPageTool")).toMatchObject({
      kind: "method",
      signature: "kamapathy.runPageTool(packId, tool, args, options)",
    });
    // The four codes a page script raises are the ones section 8 declares,
    // so runPageTool adds none of its own.
    for (const code of [
      "agent_scripts_off",
      "script_error",
      "result_too_large",
      "evaluation_timeout",
      "request_too_large",
    ])
      expect(Object.hasOwn(ERRORS, code), code).toBe(true);
    // Every code it raises is client side and stays as it is on a retry.
    for (const [code, fields] of [
      ["site_pack_not_found", ["packId", "roots"]],
      ["site_tool_not_found", ["packId", "tool", "kind", "available"]],
      ["site_pack_invalid", ["packId", "dir", "problems"]],
      ["invalid_tool_args", ["packId", "tool", "problems", "expected"]],
      ["site_tool_failed", ["packId", "tool", "at", "cause"]],
    ]) {
      expect(ERRORS[code], code).toMatchObject({
        status: null,
        transient: false,
        since: 4,
      });
      expect(ERRORS[code].fields, code).toEqual(fields);
    }
    // run and repl raise one code of their own for a workspace helpers.mjs
    // they cannot load or install.
    expect(ERRORS.helpers_failed).toMatchObject({
      status: null,
      transient: false,
      since: 4,
    });
    expect(ERRORS.helpers_failed.fields).toEqual(["path", "export", "cause"]);
    // The CLI's two commands, both answered from the files on this computer.
    for (const [name, usage, summary, script] of [
      [
        "sites",
        "sites [<url-or-host>] [--json]",
        "List the site packs, or the notes and tools for one site",
        "siteContext",
      ],
      [
        "sites check",
        "sites check [<pack-id-or-folder>]... [--json]",
        "Check every site pack, or the ones named, and report each problem",
        undefined,
      ],
    ]) {
      const command = findCommand(name);
      expect(command, name).toMatchObject({
        group: "Scripts",
        usage,
        summary,
        since: 4,
      });
      expect(command.route, name).toBeUndefined();
      expect(command.script, name).toBe(script);
      expect(command.arguments.length, name).toBe(1);
      // --json is a global flag, so neither command declares one of its own.
      expect(command.flags, name).toEqual([]);
      expect(Object.hasOwn(PARSERS, name), name).toBe(true);
    }
    expect(GLOBAL_FLAGS.map((flag) => flag.name)).toContain("--json");
    // The generated reference carries every form.
    const reference = read("skills/kamapathy/references/api.md");
    for (const text of [
      "`sitePacks(target?)`",
      "`siteContext(target)`",
      "`runSiteTool(packId, tool, args, options)`",
      "`runPageTool(packId, tool, args, options)`",
      "`kamapathy.sitePacks(target?)`",
      "`kamapathy.siteContext(target)`",
      "`kamapathy.runSiteTool(packId, tool, args, options)`",
      "`kamapathy.runPageTool(packId, tool, args, options)`",
      "`sites [<url-or-host>] [--json]`",
      "`sites check [<pack-id-or-folder>]... [--json]`",
    ])
      expect(reference, text).toContain(text);
  });

  it("the navigation members and commands are declared at level 4", () => {
    // The millisecond, matcher and page function argument kinds.
    const timeout = entry("Page.waitForTimeout");
    for (const ms of [0, 1000, 600000])
      expect(checkCall(timeout, [ms]), String(ms)).toBeNull();
    for (const ms of [-1, 600001, 1.5, "1000", null])
      expect(checkCall(timeout, [ms])?.code, String(ms)).toBe(
        "invalid_argument",
      );
    expect(checkCall(timeout, [])?.message).toBe(
      "page.waitForTimeout got no ms. Expected page.waitForTimeout(ms).",
    );
    const url = entry("Page.waitForURL");
    for (const matcher of [
      "https://example.test/**/done",
      /done$/,
      (address) => address.pathname === "/done",
    ])
      expect(checkCall(url, [matcher]), String(matcher)).toBeNull();
    for (const matcher of ["", "  ", 5, null, {}])
      expect(checkCall(url, [matcher])?.code, String(matcher)).toBe(
        "invalid_argument",
      );
    const fn = entry("Page.waitForFunction");
    expect(checkCall(fn, ["window.slots > 0"])).toBeNull();
    expect(checkCall(fn, [() => true, { rows: 3 }, { timeout: 1000 }])).toBeNull();
    for (const source of ["", 5, {}, null])
      expect(checkCall(fn, [source])?.code, String(source)).toBe(
        "invalid_argument",
      );
    // Options still map by name, with the client's own spelling.
    expect(checkCall(fn, [() => true, undefined, { timeoutMs: 1000 }])).toMatchObject({
      code: "invalid_option",
      fields: { option: "timeoutMs", suggestion: "timeout" },
    });
    expect(
      checkCall(entry("Page.goto"), ["https://example.test/", { waitUntil: "soon" }])
        ?.code,
    ).toBe("invalid_option");
    expect(
      checkCall(entry("Page.waitForSelector"), ["@e2", { state: "gone" }])?.code,
    ).toBe("invalid_option");
    expect(
      checkCall(entry("Page.waitForLoadState"), ["networkidle", { idleMs: 20000 }])
        ?.code,
    ).toBe("invalid_option");
    // The level and signature every new member declares.
    const members = [
      ["Page.goto", "page.goto(url, options?)"],
      ["Page.reload", "page.reload(options?)"],
      ["Page.info", "page.info()"],
      ["Page.waitForURL", "page.waitForURL(url, options?)"],
      ["Page.waitForLoadState", "page.waitForLoadState(state?, options?)"],
      ["Page.waitForSelector", "page.waitForSelector(selector, options?)"],
      [
        "Page.waitForFunction",
        "page.waitForFunction(pageFunction, arg?, options?)",
      ],
      ["Page.waitForTimeout", "page.waitForTimeout(ms)"],
    ];
    for (const [name, signature] of members)
      expect(entry(name), name).toMatchObject({
        kind: "method",
        since: 4,
        signature,
      });
    expect(entry("Page.waitForTimeout").route).toBeUndefined();
    for (const name of [
      "reload",
      "info",
      "wait-for-url",
      "wait-for-load-state",
      "wait-for-selector",
      "wait-for-function",
    ]) {
      const command = findCommand(name);
      expect(command, name).toMatchObject({ since: 4 });
      expect(route(command.route), name).toBeDefined();
      expect(Object.hasOwn(PARSERS, name), name).toBe(true);
    }
    expect(findCommand("navigate").flags.map((flag) => flag.name)).toEqual([
      "--wait-until",
      "--timeout",
      "--referer",
    ]);
    for (const flag of findCommand("navigate").flags)
      expect(flag.since, flag.name).toBe(4);
    expect(findCommand("navigate").usage).toBe(
      "navigate <tab-id> <url> [--wait-until <state>] [--timeout <ms>] [--referer <url>]",
    );
    // The URL rule of this level, in the entry and in the two commands.
    for (const text of [
      entry("Page.navigate").summary,
      findCommand("navigate").arguments[1].description,
      findCommand("open").arguments[1].description,
    ])
      expect(text).toContain("about:blank");
    // The generated reference carries the members and the commands.
    const reference = read("skills/kamapathy/references/api.md");
    for (const text of [
      "`page.goto(url, options?)`",
      "`page.info()`",
      "`page.waitForURL(url, options?)`",
      "`page.waitForTimeout(ms)`",
      "`reload <tab-id> [--wait-until <state>] [--timeout <ms>] [--ignore-cache]`",
      "`info <tab-id>`",
      "`wait-for-selector <tab-id> <ref-or-selector> [--state <state>] [--timeout <ms>]`",
    ])
      expect(reference, text).toContain(text);
  });

  it("the new entries, commands and topics are complete", () => {
    // Every section 8 route has its client entry and its command, at this
    // API level.
    for (const [key, name, commandName] of [
      ["POST /tabs/:id/evaluate", "Page.evaluate", "evaluate"],
      ["POST /tabs/:id/fetch", "Page.fetch", "fetch"],
      ["POST /tabs/:id/cdp", "Page.cdp", "cdp"],
      ["POST /spaces/:id/cdp", "Space.cdp", "space cdp"],
      ["POST /tabs/:id/events", "Page.events", "events"],
      ["POST /tabs/:id/clear-site-data", "Page.clearSiteData", "clear-site-data"],
    ]) {
      expect(route(key), key).toBeDefined();
      const item = entry(name);
      expect(item, name).toMatchObject({ kind: "method", route: key, since: 4 });
      const command = findCommand(commandName);
      expect(command, commandName).toMatchObject({
        route: key,
        script: item.signature.split("(")[0],
        since: 4,
      });
      for (const flag of command.flags)
        expect(flag.since, `${commandName} ${flag.name}`).toBe(4);
      expect(Object.hasOwn(PARSERS, commandName), commandName).toBe(true);
    }
    expect(
      [
        "Page.evaluate",
        "Page.fetch",
        "Page.cdp",
        "Page.events",
        "Page.clearSiteData",
        "Space.cdp",
      ].map((name) => entry(name).signature),
    ).toEqual([
      "page.evaluate(fnOrString, arg?, options?)",
      "page.fetch(url, options?)",
      "page.cdp(method, params?, options?)",
      "page.events(options?)",
      "page.clearSiteData(options)",
      "space.cdp(method, params?)",
    ]);
    // Each option is its route's field under the Playwright name.
    expect(Object.keys(entry("Page.fetch").options)).toEqual([
      "method",
      "headers",
      "body",
      "cache",
      "credentials",
      "integrity",
      "keepalive",
      "mode",
      "redirect",
      "referrer",
      "referrerPolicy",
      "timeout",
      "saveAs",
    ]);
    for (const [name, key, max] of [
      ["Page.evaluate", "POST /tabs/:id/evaluate", 60000],
      ["Page.fetch", "POST /tabs/:id/fetch", 300000],
      ["Page.cdp", "POST /tabs/:id/cdp", 60000],
      ["Page.clearSiteData", "POST /tabs/:id/clear-site-data", 300000],
    ])
      expect(entry(name).options.timeout, name).toMatchObject({
        kind: "ms",
        min: route(key).body.timeoutMs.min,
        max,
        default: route(key).body.timeoutMs.default,
        field: "timeoutMs",
      });
    expect(entry("Page.cdp").options.frame).toBe(
      route("POST /tabs/:id/cdp").body.frame,
    );
    expect(entry("Page.events").options.max).toBe(
      route("POST /tabs/:id/events").body.max,
    );
    // The new argument kinds: JSON data names where it stops being JSON, and
    // a method keeps the server's pattern.
    const evaluate = entry("Page.evaluate");
    expect(evaluate.pageFunction).toBe(true);
    for (const args of [
      [() => 1, { rows: [1, 2], at: null, gone: undefined }],
      ["document.title"],
      [() => 1, undefined, { timeout: 2000 }],
    ])
      expect(checkCall(evaluate, args), String(args[0])).toBeNull();
    expect(checkCall(evaluate, [() => 1, { rows: [1, 2n] }])).toEqual({
      code: "invalid_argument",
      message:
        "page.evaluate got a BigInt at arg.rows[1], which JSON cannot carry. Pass strings, finite numbers, booleans, null, arrays and objects.",
      fields: { entry: "page.evaluate", expected: "JSON data at arg.rows[1]" },
    });
    expect(
      checkCall(entry("Page.waitForFunction"), [(x) => x, Number.NaN]),
    ).toMatchObject({ fields: { expected: "JSON data at arg" } });
    const cdp = entry("Page.cdp");
    for (const method of ["Page.reload", "DOM.getDocument", "Runtime.evaluate"])
      expect(checkCall(cdp, [method]), method).toBeNull();
    for (const method of [
      "page.reload",
      "Page.Reload",
      "Page",
      "Page.reload.now",
      "",
      5,
    ])
      expect(checkCall(cdp, [method])?.code, String(method)).toBe(
        "invalid_argument",
      );
    expect(schema.METHOD_PATTERN.source).toBe(SERVER_METHOD_PATTERN.source);
    // The page-scripts topic, from the CLI and from a script.
    const topic = helpTopic(["page-scripts"], "kamapathy");
    const folded = topic.split("\n").join(" ");
    for (const text of [
      "Page scripts is on in Kamapathy's Settings, under Agents",
      "agent_scripts_off",
      "page.evaluate",
      "page.fetch",
      "page.cdp",
      "page.events",
      "space.cdp",
      "page.waitForFunction",
      "the wait-for-function, evaluate, fetch, cdp, space cdp and events commands",
      "Take a fresh snapshot after it.",
      "page.clearSiteData is not gated.",
      "references/api.md",
    ])
      expect(folded, text).toContain(text);
    for (const text of topic.split("\n"))
      expect(text.length, text).toBeLessThanOrEqual(80);
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      help("page-scripts");
      expect(logged).toHaveBeenCalledWith(topic);
    } finally {
      logged.mockRestore();
    }
    expect(findCommand("help").arguments[0].description).toContain(
      "page-scripts",
    );
    // The generated reference carries the members and the commands.
    const reference = read("skills/kamapathy/references/api.md");
    for (const text of [
      "`page.evaluate(fnOrString, arg?, options?)`",
      "`page.fetch(url, options?)`",
      "`page.cdp(method, params?, options?)`",
      "`page.events(options?)`",
      "`page.clearSiteData(options)`",
      "`space.cdp(method, params?)`",
      "`evaluate <tab-id> --stdin [--timeout <ms>]`",
      '`fetch <tab-id> <url> [--method <m>] [--header "Name: value"]... [--stdin] [--save <file>] [--timeout <ms>]`',
      "`cdp <tab-id> <method> [--stdin] [--frame <path-or-ref>] [--timeout <ms>]`",
      "`space cdp <space-id> <method> [--stdin]`",
      "`events <tab-id> [--max <n>]`",
      "`clear-site-data <tab-id> [--origin <o>] [--cookies | --cookie <name>]... [--storage] [--cache] [--timeout <ms>]`",
    ])
      expect(reference, text).toContain(text);
  });

  it("resolves help names in every accepted form", () => {
    const names = (query) => resolveNames(query).map((entry) => entry.name);
    expect(names("Page.wait")).toEqual(["Page.wait"]);
    expect(names("page.wait")).toEqual(["Page.wait"]);
    expect(names("PAGE.wait()")).toEqual(["Page.wait"]);
    expect(names("kamapathy.createSpace")).toEqual(["Client.createSpace"]);
    expect(names("wait")).toEqual(["Page.wait"]);
    expect(names("close")).toEqual(["Space.close", "Page.close"]);
    expect(names("createSpace")).toEqual(["createSpace"]);
    expect(names("clik")).toEqual([]);
  });

  it("keeps the generated API reference current", () => {
    const { apiMarkdown, routesBlock, errorsBlock } = generateReference();
    expect(read("skills/kamapathy/references/api.md")).toBe(apiMarkdown);
    const docs = read("docs/automation.md");
    // Each block is one start marker before one end marker, so a block that
    // lost one fails here rather than as a long difference below.
    expect(
      ["routes", "errors"].map((name) => {
        const start = `<!-- generated:${name} -->`;
        const end = `<!-- /generated:${name} -->`;
        return [
          name,
          docs.split(start).length,
          docs.split(end).length,
          docs.indexOf(start) < docs.indexOf(end),
        ];
      }),
    ).toEqual([
      ["routes", 2, 2, true],
      ["errors", 2, 2, true],
    ]);
    const between = (start, end) =>
      docs.slice(docs.indexOf(start) + start.length, docs.indexOf(end));
    expect(
      between("<!-- generated:routes -->", "<!-- /generated:routes -->"),
    ).toBe(routesBlock);
    expect(
      between("<!-- generated:errors -->", "<!-- /generated:errors -->"),
    ).toBe(errorsBlock);
    for (const text of [apiMarkdown, routesBlock, errorsBlock])
      expect(text).not.toMatch(/[\u2013\u2014]/);
  });
});

describe("hand written docs", () => {
  const GRAMMAR = [
    "docs/automation.md",
    "skills/kamapathy/references/actions.md",
  ];

  it("documents every selector form and the level the schema declares", () => {
    for (const path of GRAMMAR) {
      const text = read(path);
      for (const { example } of SELECTOR_FORMS)
        expect(text, `${path} is missing ${example}`).toContain(example);
      // The css:, role:, href: and loc= aliases stay undocumented.
      expect(text, `${path} documents a loc= alias`).not.toContain("loc=");
    }
    expect(read("docs/automation.md")).toContain(
      `This version is level ${API_LEVEL}`,
    );
  });

  it("names the snapshot and screenshot flags the skill promises", () => {
    const skill = read("skills/kamapathy/SKILL.md");
    for (const flag of [
      "--viewport",
      "--root",
      "--outline",
      "--locators",
      "--cursor",
      "--full-page",
      "--clip",
    ])
      expect(skill, `SKILL.md is missing ${flag}`).toContain(flag);
  });

  it("drops the sentences this API level made wrong", () => {
    const retired = [
      ["docs/automation.md", "CSS selectors do not enter shadow roots"],
      ["docs/automation.md", "must uniquely match"],
      ["docs/automation.md", "Screenshots require a shown"],
      ["docs/automation.md", "Screenshots capture the viewport, not the full"],
      ["docs/SECURITY.md", "viewport screenshots"],
      ["skills/kamapathy/SKILL.md", "Screenshots require a shown"],
      ["skills/kamapathy/SKILL.md", "screenshot_unavailable"],
      [
        "skills/kamapathy/references/actions.md",
        "CSS selectors must match exactly one visible element",
      ],
      [
        "skills/kamapathy/references/actions.md",
        "CSS selectors do not enter shadow roots",
      ],
      [
        "skills/kamapathy/references/actions.md",
        "Screenshot files contain only the current viewport",
      ],
      ["skills/kamapathy/references/scripting.md", "unminimized window"],
      ["skills/kamapathy/references/scripting.md", "screenshot_unavailable"],
      [
        "docs/automation.md",
        "Modifier combinations, shell shortcuts, and arbitrary key sequences",
      ],
      ["docs/automation.md", "Clicks require a visible, enabled element"],
      ["docs/SECURITY.md", "trusted clicks, keys and drags"],
      ["skills/kamapathy/SKILL.md", "canvas controls"],
      ["skills/kamapathy/references/actions.md", "Supported keys:"],
      [
        "skills/kamapathy/references/actions.md",
        "Modifier combinations are unsupported",
      ],
      ["skills/kamapathy/references/actions.md", "Press a supported key"],
      [
        "skills/kamapathy/references/scripting.md",
        "Home, End, PageUp, PageDown, Space",
      ],
      [
        "README.md",
        "canvas editors and JavaScript dialogs still need a handoff",
      ],
      [
        "site/index.html",
        "Canvas editors and JavaScript dialogs are out of reach too",
      ],
      // Agents read and act in frames from any web origin, run their own page
      // scripts, and imports bring passwords and extensions over.
      ["docs/automation.md", "open shadow roots and same-origin frames"],
      ["docs/automation.md", "inside a same-origin iframe"],
      [
        "docs/automation.md",
        "so an agent knows content exists that Kamapathy cannot read",
      ],
      [
        "docs/automation.md",
        "Any action on it fails with `409 cross_origin_frame`",
      ],
      ["docs/automation.md", "so list `tabs SPACE_ID` to find the popup"],
      ["docs/automation.md", "then its same-origin frames depth first"],
      [
        "docs/automation.md",
        "the one place where an agent's own code runs in a page",
      ],
      ["docs/automation.md", "today it gates this wait alone"],
      ["docs/automation.md", "`requestSpace` and `help`, which are writable"],
      ["docs/automation.md", "Responses are JSON except screenshots."],
      [
        "docs/automation.md",
        "The only code of the agent's own that a page runs",
      ],
      [
        "docs/automation.md",
        "list a frame from another origin without reading it",
      ],
      [
        "docs/automation.md",
        "does not implement Chrome DevTools Protocol compatibility",
      ],
      ["docs/SECURITY.md", "downloads and permission prompts are denied"],
      ["docs/SECURITY.md", "the only code of an agent's own that a page runs"],
      [
        "docs/SECURITY.md",
        "listed by its title, name, or host and refuses every action",
      ],
      [
        "docs/architecture.md",
        "Reads bookmarks, history and sign-ins from other browsers",
      ],
      [
        "README.md",
        "list cross-origin frames so an agent knows they are there",
      ],
      ["README.md", "Sees shadow roots and same-origin frames"],
      ["README.md", "no JavaScript from the script ever reaches a web page"],
      ["README.md", "list cross-origin frames without reading them"],
      ["README.md", "Cross-origin frames still need a handoff"],
      ["README.md", "makes one new outbound request"],
      ["README.md", "is the one agent code a page runs"],
      ["site/index.html", "passwords do not come over yet"],
      ["site/index.html", "Extensions do not come over yet"],
      [
        "site/index.html",
        "your sign-ins from Chrome, Edge, Brave, Arc, Vivaldi, Opera or Firefox",
      ],
      ["site/index.html", "open shadow roots and same-origin frames"],
      ["site/index.html", "so the agent asks you instead of guessing"],
      [
        "site/index.html",
        "are listed in a snapshot but cannot be read or clicked",
      ],
      ["site/index.html", "frames from another origin still need you"],
      ["skills/kamapathy/SKILL.md", "nothing runs inside the page"],
      ["skills/kamapathy/SKILL.md", "same-origin iframes"],
      ["skills/kamapathy/SKILL.md", "`requestSpace` and `help`, and connects"],
      ["skills/kamapathy/references/actions.md", "same-origin iframes"],
      [
        "skills/kamapathy/references/actions.md",
        "then its same-origin frames depth first",
      ],
      [
        "skills/kamapathy/references/actions.md",
        "any action on it fails with `cross_origin_frame`",
      ],
      [
        "skills/kamapathy/references/actions.md",
        "The action covers the top document only.",
      ],
      [
        "skills/kamapathy/references/actions.md",
        "is the one code of yours a page runs",
      ],
      [
        "skills/kamapathy/references/actions.md",
        "there is no other script evaluation",
      ],
      [
        "skills/kamapathy/references/connection.md",
        "DevTools or remote-debugging port",
      ],
      [
        "skills/kamapathy/references/scripting.md",
        "so no JavaScript reaches a website through it",
      ],
      [
        "skills/kamapathy/references/scripting.md",
        "there is no other page JavaScript",
      ],
      [
        "skills/kamapathy/references/scripting.md",
        "`requestSpace` and `help` are set",
      ],
    ];
    for (const [path, sentence] of retired)
      expect(read(path), `${path} still says ${sentence}`).not.toContain(
        sentence,
      );
  });
  it("documents the navigation and wait surface", () => {
    const promised = [
      // The agent URL rule, in the three places a reader looks.
      ["docs/automation.md", "Agents open HTTP, HTTPS and `about:blank` only"],
      ["docs/SECURITY.md", "Agents open HTTP, HTTPS and `about:blank` only"],
      ["docs/architecture.md", "its one extra destination"],
      ["docs/architecture.md", "`electron/agent/navigation/`"],
      // The section, the states, the commands and the methods.
      ["docs/automation.md", "## Navigate and wait"],
      [
        "docs/automation.md",
        "`commit`, `domcontentloaded`, `load` or `networkidle`",
      ],
      ["docs/automation.md", "wait-for-selector"],
      ["docs/automation.md", "waitForFunction"],
      ["docs/automation.md", "four navigations and waits"],
      ["docs/automation.md", "`ignoreCache` runs no page script"],
      ["docs/automation.md", "refreshes the page's `url` and `title`"],
      // The guard policy and the waits SECURITY.md names.
      [
        "docs/SECURITY.md",
        "waits for a URL, a load state, an element state or a page function",
      ],
      ["docs/SECURITY.md", "overridden only under agent control"],
      ["docs/SECURITY.md", "The person in control is always asked"],
      // What a reader of README learns.
      ["README.md", "`goto`, `reload`, `info`"],
      [
        "README.md",
        "wait for a URL, a load state, an element or a page condition",
      ],
      [
        "README.md",
        "wait for the new document instead of returning as soon as the load",
      ],
      ["README.md", "url_opened_in_popup"],
      // The skill's own rules.
      ["skills/kamapathy/SKILL.md", "returns once the new document commits"],
      ["skills/kamapathy/SKILL.md", "waits for the page's load event"],
      ["skills/kamapathy/SKILL.md", "never on a sleep"],
      ["skills/kamapathy/SKILL.md", "`url_opened_in_popup`"],
      ["skills/kamapathy/SKILL.md", "waitForSelector"],
      // The six batch steps.
      ["skills/kamapathy/references/actions.md", "| `navigate` |"],
      ["skills/kamapathy/references/actions.md", "| `reload` |"],
      ["skills/kamapathy/references/actions.md", "| `wait-for-url` |"],
      ["skills/kamapathy/references/actions.md", "| `wait-for-load-state` |"],
      ["skills/kamapathy/references/actions.md", "| `wait-for-selector` |"],
      ["skills/kamapathy/references/actions.md", "| `wait-for-function` |"],
      // The methods, with ignoreCache and the commit rule.
      [
        "skills/kamapathy/references/scripting.md",
        "`goto(url, { waitUntil?, timeout?, referer? })`",
      ],
      [
        "skills/kamapathy/references/scripting.md",
        "`reload({ waitUntil?, timeout?, ignoreCache? })`",
      ],
      ["skills/kamapathy/references/scripting.md", "`info()`"],
      [
        "skills/kamapathy/references/scripting.md",
        "`waitForURL(url, { timeout?, waitUntil? })`",
      ],
      [
        "skills/kamapathy/references/scripting.md",
        "`waitForLoadState(state?, { timeout?, idleMs? })`",
      ],
      [
        "skills/kamapathy/references/scripting.md",
        "`waitForSelector(selector, { state?, timeout? })`",
      ],
      [
        "skills/kamapathy/references/scripting.md",
        "`waitForFunction(pageFunction, arg?, { timeout?, interval? })`",
      ],
      ["skills/kamapathy/references/scripting.md", "`waitForTimeout(ms)`"],
      ["skills/kamapathy/references/scripting.md", "`ignoreCache`"],
      [
        "skills/kamapathy/references/scripting.md",
        "returns once the new document commits",
      ],
    ];
    for (const [path, sentence] of promised)
      expect(read(path), `${path} is missing ${sentence}`).toContain(sentence);
    // The sentences this section made wrong.
    for (const [path, sentence] of [
      ["docs/automation.md", "Navigation accepts only complete HTTP or HTTPS"],
      ["docs/SECURITY.md", "conditional waits"],
      ["README.md", "wait for changes"],
    ])
      expect(read(path), `${path} still says ${sentence}`).not.toContain(
        sentence,
      );
  });
});
