import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeError,
  describeScriptError,
  formatApiError,
  hintsFor,
  locateSyntaxError,
} from "../skills/kamapathy/scripts/diagnostics.mjs";
import { KamapathyError } from "../skills/kamapathy/scripts/lib/errors.mjs";
import { API_LEVEL, CLIENT_VERSION } from "../skills/kamapathy/scripts/schema/index.mjs";

const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function script(name, source) {
  const directory = await mkdtemp(join(tmpdir(), "kamapathy-diagnostics-"));
  directories.push(directory);
  const path = join(directory, name);
  await writeFile(path, source, { mode: 0o600 });
  return path;
}
// What node --check prints for a file whose line 3 is `  c: 2,,`.
const checkOutput = (path) =>
  `${path}:3\n  c: 2,,\n       ^\n\nSyntaxError: Unexpected token ','\n    at checkSyntax (node:internal/main/check_syntax:74:5)\n\nNode.js v22.13.0\n`;
const failingCheck = (stderr) => (_command, _args, _options, done) => done(Object.assign(new Error("exit 1"), { code: 1 }), "", stderr);
const passingCheck = (_command, _args, _options, done) => done(null, "", "");
// A compile error: a SyntaxError with only Node's own frames.
const compileError = () => {
  const error = new SyntaxError("Unexpected token ','");
  error.stack = "SyntaxError: Unexpected token ','\n    at compileSourceTextModule (node:internal/modules/esm/utils:338:16)";
  return error;
};

describe("script diagnostics", () => {
  it("locates compile errors in a file, stdin and -e", async () => {
    const file = await script("broken.mjs", "const a = {\n  b: 1,\n  c: 2,,\n};\n");
    const real = realpathSync(file);
    const calls = [];
    const execFile = (command, args, options, done) => {
      calls.push({ command, args, options });
      failingCheck(checkOutput(real))(command, args, options, done);
    };
    for (const label of [file, "stdin", "-e"])
      expect(
        await describeScriptError(compileError(), { label, file, execFile, execPath: "/bin/node" }),
        label,
      ).toEqual([`error: SyntaxError: Unexpected token ',' (${label}:3:8)`, "  3 |   c: 2,,", "    |        ^"]);
    expect(calls[0].command).toBe("/bin/node");
    expect(calls[0].args).toEqual(["--check", file]);
    expect(calls[0].options).toMatchObject({ timeout: 5000, maxBuffer: 65536 });
    expect(calls[0].options.env).not.toHaveProperty("NODE_OPTIONS");
    // A long line shows the 200 characters around the column.
    const long = `${"x".repeat(300)},,${"y".repeat(300)}`;
    const located = await describeScriptError(compileError(), {
      label: "-e",
      file,
      execFile: failingCheck(`${real}:1\n${long}\n${" ".repeat(301)}^\n\nSyntaxError: Unexpected token ','\n`),
    });
    expect(located[0]).toBe("error: SyntaxError: Unexpected token ',' (-e:1:302)");
    expect(located[1].length).toBeLessThanOrEqual(210);
    expect(located[1]).toContain(",,");
    expect(located[2].indexOf("^") - located[2].indexOf("|")).toBe(located[1].indexOf(",,") + 1 - located[1].indexOf("|"));
    // locateSyntaxError reports the raw location.
    expect(await locateSyntaxError(file, { execFile: failingCheck(checkOutput(real)) })).toEqual({
      line: 3,
      column: 8,
      source: "  c: 2,,",
    });
  });

  it("tells runtime SyntaxErrors apart without node --check", async () => {
    const file = await script("runtime.mjs", 'JSON.parse("{");\n');
    let checked = false;
    const error = new SyntaxError("Expected property name or '}' in JSON at position 1 (line 1 column 2)");
    error.stack = `SyntaxError: ${error.message}\n    at JSON.parse (<anonymous>)\n    at ${pathToFileURL(file).href}:1:6`;
    expect(
      await describeScriptError(error, { label: "task.mjs", file, execFile: () => (checked = true) }),
    ).toEqual([`error: SyntaxError: ${error.message}`, "  at task.mjs:1:6"]);
    expect(checked).toBe(false);
  });

  it("blames an imported module when the script parses", async () => {
    const file = await script("main.mjs", 'import "./helper.mjs";\n');
    expect(await describeScriptError(compileError(), { label: "main.mjs", file, execFile: passingCheck })).toEqual([
      "error: SyntaxError: Unexpected token ',' (in a module the script imports)",
    ]);
  });

  it("falls back to the message on unreadable check output", async () => {
    const file = await script("broken.mjs", "{{{\n");
    expect(
      await describeScriptError(compileError(), { label: "-e", file, execFile: failingCheck("Killed\n") }),
    ).toEqual(["error: SyntaxError: Unexpected token ','"]);
  });

  it("adds the page hint and leaves typeof and Node globals alone", () => {
    const missing = (name) => new ReferenceError(`${name} is not defined`);
    expect(hintsFor(missing("document"))).toEqual([
      "hint: Scripts run in Node.js on this computer, not in the page, so document does not exist here. Read the page with page.snapshot() or page.text(), or run page code with page.evaluate(() => document.title).",
    ]);
    expect(hintsFor(missing("localStorage"))[0]).toContain("so localStorage does not exist here");
    // A page name this Node defines gets no page hint.
    globalThis.alert = () => {};
    try {
      expect(hintsFor(missing("alert"))).toEqual([]);
    } finally {
      delete globalThis.alert;
    }
    expect(hintsFor(missing("alert"))[0]).toContain("so alert does not exist here");
    expect(hintsFor(missing("somethingElse"))).toEqual([]);
  });

  it("suggests close names, or the bundled skill when the app is newer", () => {
    const names = "hint: No Kamapathy method is named clik. Did you mean page.click? help() lists every method.";
    expect(hintsFor(new TypeError("page.clik is not a function"))).toEqual([names]);
    expect(hintsFor(new TypeError("(intermediate value).clik is not a function"))).toEqual([names]);
    expect(hintsFor(new TypeError("page?.clik is not a function"))).toEqual([names]);
    expect(hintsFor(new ReferenceError("creatSpace is not defined"))).toEqual([
      "hint: No Kamapathy method is named creatSpace. Did you mean createSpace? help() lists every method.",
    ]);
    expect(hintsFor(new TypeError("page.zzzzzzzz is not a function"))).toEqual([]);
    // Dialog hints come first.
    expect(hintsFor(new TypeError("page.acceptDialog is not a function"))).toEqual([
      'hint: Kamapathy answers page dialogs as they open. Call page.setDialogPolicy({ accept: true }) before the action, then read the answer in its dialog field, page.dialogs() or page.waitForEvent("dialog").',
    ]);
    expect(hintsFor(new TypeError("page.on is not a function"))[0]).toContain("Kamapathy answers page dialogs");
    const newer = { app: { version: "9.0.0", apiLevel: API_LEVEL + 1 } };
    expect(hintsFor(new TypeError("page.goto is not a function"), { client: newer })).toEqual([
      `hint: This skill copy (${CLIENT_VERSION}) is older than Kamapathy 9.0.0. Update this skill copy, then read its SKILL.md again.`,
    ]);
  });

  it("adds the closure hint to page function failures", () => {
    const entries = [
      { name: "Page.evaluate", signature: "page.evaluate(fn, arg?)", pageFunction: true, kind: "method" },
    ];
    const failed = new KamapathyError("evaluation_failed", "ReferenceError: total is not defined", {
      entry: "page.evaluate",
    });
    expect(hintsFor(failed, { entries })).toEqual([
      "hint: Page functions run in the page and cannot see script variables. Pass values as the argument: page.evaluate((x) => x * 2, x).",
    ]);
    expect(hintsFor(new KamapathyError("stale_ref", "ReferenceError", { entry: "page.click" }), { entries })).toEqual([]);
  });

  it("locates TypeScript syntax errors from the message on 22.13 to 22.17 and from the stack head on 22.18 and later, never running node --check", async () => {
    const file = await script("broken.mts", "interface S {}\n");
    const real = realpathSync(file);
    const execFile = () => {
      throw new Error("node --check must not run on TypeScript");
    };
    const old = Object.assign(
      new SyntaxError(
        "  x Unexpected token `,`. Expected identifier\n   ,-[5:1]\n 2 |   b: number;\n 5 |   b: 1,,\n   :        ^\n 6 | };\n   `----\n\n\nCaused by:\n    failed to parse",
      ),
      { code: "ERR_INVALID_TYPESCRIPT_SYNTAX" },
    );
    old.stack = `SyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: ${old.message}\n    at parseTypeScript (node:internal/modules/typescript:62:40)`;
    expect(await describeScriptError(old, { label: "-e", file, execFile })).toEqual([
      "error: SyntaxError: Unexpected token `,`. Expected identifier (-e:5:8)",
      "  5 |   b: 1,,",
      "    |        ^",
    ]);
    const current = Object.assign(new SyntaxError("Unexpected token `,`. Expected identifier"), {
      code: "ERR_INVALID_TYPESCRIPT_SYNTAX",
    });
    current.stack = `${pathToFileURL(real).href}:5\n  b: number;\n  b: 1,,\n       ^\n};\n\nSyntaxError [ERR_INVALID_TYPESCRIPT_SYNTAX]: Unexpected token \`,\`. Expected identifier\n    at parseTypeScript (node:internal/modules/typescript:62:40)`;
    expect(await describeScriptError(current, { label: "task.mts", file, execFile })).toEqual([
      "error: SyntaxError: Unexpected token `,`. Expected identifier (task.mts:5:8)",
      "  5 |   b: 1,,",
      "    |        ^",
    ]);
  });

  it("names the call in the headline, the script location and the retry or inspect line", () => {
    const file = "/tmp/kamapathy-run-0123456789abcdef.mjs";
    const error = new KamapathyError("action_timeout", `Timed out in ${file}.`, { retryable: true, status: 504 });
    error.stack = `KamapathyError: ${error.message}\n    at Session.request (/skill/lib/request.mjs:10:5)\n    at async ${pathToFileURL(file).href}:4:3`;
    expect(describeError(error, { label: "-e", file })).toEqual([
      "error: action_timeout: Timed out in -e.",
      "  at -e:4:3",
      "Kamapathy: Nothing reached the page, so the same command can be retried.",
    ]);
    expect(formatApiError(new KamapathyError("element_obscured", "Covered.", { status: 409, dispatched: true }))).toEqual([
      "Kamapathy: 409 element_obscured: Covered.",
      "Kamapathy: The action reached the page before it failed. Inspect the page before retrying.",
    ]);
    expect(describeError(new Error("boom"), { label: "-e", file })).toEqual(["error: boom"]);
    expect(describeError(new RangeError("too far"), { label: "-e", file })).toEqual(["error: RangeError: too far"]);
  });
});
