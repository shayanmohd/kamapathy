import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError, envelope } from "../electron/agent/errors.ts";
import { buildRoutes, routeBudget } from "../electron/agent/http.ts";
import { createNavigation } from "../electron/agent/routes/navigation.ts";
import { pdfRoutes } from "../electron/agent/routes/pdf.ts";
import { downloadRoutes } from "../electron/agent/routes/downloads.ts";
import { eventRoutes } from "../electron/agent/routes/events.ts";
import { spaceRequestRoutes } from "../electron/agent/routes/space-requests.ts";
import { spaceRoutes } from "../electron/agent/routes/spaces.ts";
import { statusRoutes } from "../electron/agent/routes/status.ts";
import { tabRoutes } from "../electron/agent/routes/tabs.ts";
import { updateRoutes } from "../electron/agent/routes/update.ts";
import { parseToolAction } from "../electron/agent/validate.ts";
import {
  Client,
  Page,
  Space,
  schema,
} from "../skills/kamapathy/scripts/api.mjs";
import { PARSERS } from "../skills/kamapathy/scripts/kamapathy.mjs";
import { installGlobals } from "../skills/kamapathy/scripts/lib/run.mjs";
import {
  generateReference,
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
    expect(() => parseToolAction("hover", {})).toThrow(
      "Batch actions support snapshot, click, fill, press, scroll, drag, wait, navigate, reload, wait-for-url, wait-for-load-state, and wait-for-function.",
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
    ])
      expect(ERRORS[code].status, code).toBeNull();
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
      "fill",
      "press",
      "scroll",
      "drag",
      "wait",
      "navigate",
      "reload",
      "wait-for-url",
      "wait-for-load-state",
      "wait-for-function",
    ];
    expect(checkBody(batch, { actions: [{ type: "hover" }] })).toEqual({
      code: "invalid_action",
      message:
        "Batch actions support snapshot, click, fill, press, scroll, drag, wait, navigate, reload, wait-for-url, wait-for-load-state, and wait-for-function.",
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
        "page.click got no target. Expected page.click(target, { label? }).",
      fields: {
        entry: "page.click",
        expected: "page.click(target, { label? })",
      },
    });
    expect(checkCall(click, ["#a", "#b"])?.message).toBe(
      "page.click got a string instead of an options object. Expected page.click(target, { label? }).",
    );
    expect(checkCall(click, [42])?.message).toBe(
      "page.click got a number for target. Expected page.click(target, { label? }).",
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
      30000,
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
    expect(COMPUTE.mouseClickBudget({})).toBe(15100);
    expect(COMPUTE.mouseClickBudget({ clickCount: 2, delayMs: 5000 })).toBe(
      30100,
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
      routeBudget({ ...click, budget: { field: "timeoutMs" } }),
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

  it("the input routes and their batch steps declare label at level 3", () => {
    const inputs = ["click", "fill", "press", "scroll", "drag"];
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
      const step = ACTIONS.find((action) => action.type === type);
      expect(step.fields.label, type).toBe(item.body.label);
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
    ];
    for (const [path, sentence] of retired)
      expect(read(path), `${path} still says ${sentence}`).not.toContain(
        sentence,
      );
  });
});
