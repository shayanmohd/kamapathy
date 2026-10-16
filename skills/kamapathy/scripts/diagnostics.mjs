// How a failed script, REPL entry or command reads: a headline, where in the
// script it failed, whether the same call can be retried, and at most two
// hints. Node built-ins only.
import { execFile as nodeExecFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { line, printable } from "./lib/format.mjs";
import {
  API_LEVEL,
  CLIENT_VERSION,
  ENTRIES,
  suggest,
} from "./schema/index.mjs";

const BUILT_IN = [
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
];
const PAGE_GLOBALS = [
  "window",
  "document",
  "location",
  "history",
  "localStorage",
  "sessionStorage",
  "innerWidth",
  "innerHeight",
  "scrollX",
  "scrollY",
  "getComputedStyle",
  "requestAnimationFrame",
  "HTMLElement",
  "Element",
  "alert",
  "confirm",
  "prompt",
];
const RETRY =
  "Kamapathy: Nothing reached the page, so the same command can be retried.";
const INSPECT =
  "Kamapathy: The action reached the page before it failed. Inspect the page before retrying.";
export const PASSWORD_HINT =
  "hint: Saved passwords are for the person only. Hand the space to them with handoff() and say what to sign in to.";
const WINDOW = 200;

const callName = (entry) => entry.signature.split("(")[0];
const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
const memberName = (entry) =>
  entry.name.includes(".") ? entry.name.split(".").at(-1) : entry.name;
const messageOf = (error) =>
  error instanceof Error ? error.message : String(error);

function headline(error) {
  const message = printable(messageOf(error));
  if (error?.name === "KamapathyError" && typeof error.code === "string")
    return `error: ${error.code}: ${message}`;
  if (error instanceof Error && BUILT_IN.includes(error.name))
    return `error: ${error.name}: ${message}`;
  return `error: ${message}`;
}

const retryLine = (error) =>
  error?.retryable ? RETRY : error?.dispatched ? INSPECT : undefined;

// The forms a file takes in stacks and Node's own output: the path as
// given, its real path (Node loads modules by it), and both as file URLs.
function forms(file, realFile = real(file)) {
  return [...new Set([file, realFile])]
    .filter(Boolean)
    .flatMap((path) => [pathToFileURL(path).href, path]);
}

// The first stack frame inside the script, in any of the forms V8 prints:
// at async file:///x:L:C, at file:///x:L:C, at fn (file:///x:L:C) and
// at fn (/x:L:C).
function scriptFrame(error, paths) {
  const stack = typeof error?.stack === "string" ? error.stack : "";
  for (const text of stack.split("\n")) {
    const frame = /^\s*at (?:async )?(?:[^(]*\()?(.+?):(\d+):(\d+)\)?$/.exec(
      text,
    );
    if (frame && paths.includes(frame[1]))
      return { line: Number(frame[2]), column: Number(frame[3]) };
  }
  return null;
}

/**
 * Hints for an error, at most two: page globals, page functions, then
 * dialogs, or saved passwords followed by names.
 * @param {unknown} error
 * @param {{ client?: { app?: { version?: string, apiLevel: number } | null }, entries?: object[] }} [options]
 * @returns {string[]}
 */
export function hintsFor(error, { client, entries = ENTRIES } = {}) {
  const hints = [];
  const message = messageOf(error);
  const undefinedName =
    error?.name === "ReferenceError" &&
    /^([\w$]+) is not defined$/.exec(message)?.[1];
  if (
    undefinedName &&
    PAGE_GLOBALS.includes(undefinedName) &&
    !(undefinedName in globalThis)
  )
    hints.push(
      `hint: Scripts run in Node.js on this computer, not in the page, so ${undefinedName} does not exist here. Read the page with page.snapshot() or page.text(), or run page code with page.evaluate(() => document.title).`,
    );
  const entry = entries.find((item) => callName(item) === error?.entry);
  if (
    error?.name === "KamapathyError" &&
    entry?.pageFunction &&
    /ReferenceError/.test(message)
  )
    hints.push(
      "hint: Page functions run in the page and cannot see script variables. Pass values as the argument: page.evaluate((x) => x * 2, x).",
    );
  const notFunction =
    error?.name === "TypeError" &&
    /^(.+)\.([\w$]+) is not a function$/.exec(message);
  if (
    notFunction &&
    (["acceptDialog", "dismissDialog"].includes(notFunction[2]) ||
      message === "page.on is not a function")
  )
    hints.push(
      'hint: Kamapathy answers page dialogs as they open. Call page.setDialogPolicy({ accept: true }) before the action, then read the answer in its dialog field, page.dialogs() or page.waitForEvent("dialog").',
    );
  else {
    // The password hint also covers bare calls, which get no names hint.
    const called =
      (error?.name === "TypeError" &&
        /^(?:.+\.)?([\w$]+) is not a function$/.exec(message)?.[1]) ||
      undefinedName;
    if (called && /password|credential|autofill/i.test(called))
      hints.push(PASSWORD_HINT);
    const name =
      notFunction?.[2] ??
      (undefinedName && !PAGE_GLOBALS.includes(undefinedName)
        ? undefinedName
        : undefined);
    const app = client?.app;
    if (name && app && app.apiLevel > API_LEVEL)
      hints.push(
        `hint: This skill copy (${CLIENT_VERSION}) is older than Kamapathy${app.version ? ` ${app.version}` : ""}. Update this skill copy, then read its SKILL.md again.`,
      );
    else if (name) {
      const near = suggest(name, entries.map(memberName));
      const match = near && entries.find((item) => memberName(item) === near);
      if (match)
        hints.push(
          `hint: No Kamapathy method is named ${name}. Did you mean ${callName(match)}? help() lists every method.`,
        );
    }
  }
  return hints.slice(0, 2);
}

/**
 * The lines for an error that ended a run or REPL entry, without running
 * anything: the headline, the script location, the retry or inspect line
 * and hints. The script file's path and URL read as the label.
 * @param {unknown} error
 * @param {{ label?: string, file?: string, realFile?: string, client?: object, entries?: object[] }} [options]
 * @returns {string[]}
 */
export function describeError(
  error,
  { label, file, realFile, client, entries } = {},
) {
  const paths = file ? forms(file, realFile) : [];
  const named = (text) =>
    paths.reduce((result, path) => result.split(path).join(label), text);
  const frame = scriptFrame(error, paths);
  return [
    headline(error),
    ...(frame ? [`  at ${label}:${frame.line}:${frame.column}`] : []),
    ...[retryLine(error) ?? []].flat(),
    ...hintsFor(error, { client, entries }),
  ].map(named);
}

// A location block: "<path>:<line>", the source line and a caret line.
function readBlock(lines) {
  for (let index = 0; index + 2 < lines.length; index++) {
    const header = /^(.+):(\d+)$/.exec(lines[index]);
    const caret = lines[index + 2]?.indexOf("^") ?? -1;
    if (header && caret >= 0 && /^[\s^]+$/.test(lines[index + 2]))
      return {
        line: Number(header[2]),
        column: caret + 1,
        source: lines[index + 1],
      };
  }
  return null;
}

/**
 * Where node --check finds the compile error in a JavaScript file.
 * @returns {Promise<{ line: number, column: number, source: string } | { imported: true } | null>}
 * `imported` when the file itself parses, so a module it imports failed.
 */
export function locateSyntaxError(
  file,
  {
    execFile = nodeExecFile,
    execPath = process.execPath,
    env = process.env,
  } = {},
) {
  const { NODE_OPTIONS: _options, ...clean } = env;
  return new Promise((resolve) => {
    try {
      execFile(
        execPath,
        ["--check", file],
        { env: clean, timeout: 5000, maxBuffer: 65536 },
        (error, _stdout, stderr) =>
          resolve(
            error
              ? readBlock(String(stderr ?? "").split("\n"))
              : { imported: true },
          ),
      );
    } catch {
      resolve(null);
    }
  });
}

// A TypeScript syntax error's location: an swc frame in the message (Node
// 22.13 to 22.17) or a location block at the head of the stack (22.18 on).
function typeScriptLocation(error) {
  const lines = messageOf(error).split("\n");
  for (let index = 1; index < lines.length; index++) {
    const caret = /^(\s*:\s)(\s*)\^/.exec(lines[index]);
    const source = /^\s*(\d+) \| ?(.*)$/.exec(lines[index - 1]);
    if (caret && source)
      return {
        line: Number(source[1]),
        column: caret[2].length + 1,
        source: source[2],
        sentence: lines[0].replace(/^\s*x\s+/, ""),
      };
  }
  const stack = typeof error?.stack === "string" ? error.stack : "";
  const head = stack.split("\n\n")[0].split("\n");
  const header = /^(.+):(\d+)$/.exec(head[0] ?? "");
  const caretIndex = head.findIndex(
    (text, index) => index > 0 && /^[\s^]+$/.test(text) && text.includes("^"),
  );
  if (header && caretIndex > 1)
    return {
      line: Number(header[2]),
      column: head[caretIndex].indexOf("^") + 1,
      source: head[caretIndex - 1],
      sentence: messageOf(error),
    };
  return null;
}

// The source line with a caret under the column, cut to the 200 characters
// around it.
function caretLines(location) {
  let { source, column } = location;
  if (source.length > WINDOW) {
    const start = Math.max(
      0,
      Math.min(column - WINDOW / 2, source.length - WINDOW),
    );
    source = source.slice(start, start + WINDOW);
    column -= start;
  }
  const number = String(location.line);
  const lead = source.slice(0, column - 1).replace(/[^\t]/g, " ");
  return [
    `  ${number} | ${printable(source)}`,
    `  ${" ".repeat(number.length)} | ${lead}^`,
  ];
}

/**
 * describeError, and for a script that did not compile, where it failed:
 * node --check for JavaScript, the error itself for TypeScript.
 */
export async function describeScriptError(error, options = {}) {
  const { label, file } = options;
  const realFile = file && real(file);
  const lines = describeError(error, { ...options, realFile });
  if (
    error?.name !== "SyntaxError" ||
    !file ||
    scriptFrame(error, forms(file, realFile))
  )
    return lines;
  const message = messageOf(error);
  if (error.code === "ERR_INVALID_TYPESCRIPT_SYNTAX") {
    const location = typeScriptLocation(error);
    if (!location) return lines;
    return [
      `error: SyntaxError: ${printable(location.sentence)} (${label}:${location.line}:${location.column})`,
      ...caretLines(location),
    ];
  }
  if (/\.(?:ts|mts|cts)$/.test(file)) return lines;
  const location = await locateSyntaxError(file, options);
  if (!location) return lines;
  if (location.imported)
    return [
      `error: SyntaxError: ${printable(message)} (in a module the script imports)`,
    ];
  return [
    `error: SyntaxError: ${printable(message)} (${label}:${location.line}:${location.column})`,
    ...caretLines(location),
  ];
}

/**
 * A failed command's lines: the status line, then the retry or inspect line.
 * @returns {string[]}
 */
export function formatApiError(error) {
  return [
    `Kamapathy: ${error.status} ${line(error.code)}: ${line(messageOf(error))}`,
    ...[retryLine(error) ?? []].flat(),
  ];
}
