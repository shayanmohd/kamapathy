#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connect } from "./api.mjs";
import { KamapathyError } from "./lib/errors.mjs";
import { formatResult, line, printable } from "./lib/format.mjs";
import {
  readInput,
  readJson,
  readUploadFiles,
  required,
  target,
  uploadRef,
} from "./lib/input.mjs";
import {
  encode,
  isLabel,
  pageBudgetFrom,
  resolveLabels,
  Session,
  takeNotices,
} from "./lib/request.mjs";
import { exists } from "./lib/transport.mjs";
import {
  checkBody,
  findCommand,
  matchRoute,
  outdated,
} from "./schema/index.mjs";

export { formatResult, formatSnapshot } from "./lib/format.mjs";
export { readUploadFiles, target, uploadRef } from "./lib/input.mjs";
export {
  agentPaths,
  checkSocket,
  launchEnvironment,
  launchKamapathy,
  launchRecord,
  resolveSocket,
  socketFetch,
} from "./lib/transport.mjs";

const HELP = `Kamapathy browser client

Kamapathy connects automatically. Each command finds Kamapathy on this
computer and starts it when agent access was left on. The switch in Settings,
under Agents, turns access off. Set KAMAPATHY_USER_DATA to use another profile.
Requires Node.js 22.12 or later.

Usage: node kamapathy.mjs <command> [arguments] [--json]

  health                              Check the connection
  spaces                              List accessible spaces
  space create <name> [--isolated]    Create a background agent space, with
                                      its own sign-ins when --isolated is given
  space open <name-or-id> [--isolated] [--page-budget <n>]
                                      Reuse the listed space with this ID or
                                      name, or create it
  space finish <space-id> --keep all|none|<tab-id>[,<tab-id>]
                                      Close the pages the agent does not keep
                                      and end its access
  space request --reason <text> [--name <name>] [--timeout <ms>]
                                      Ask the person to let an agent use one
                                      of their spaces
  space close <space-id>               Close a space and its tabs
  tabs <space-id>                      List tabs in an agent space
  open <space-id> <url>                Open a background tab
  new-page <space-id>                  Open a blank background page
  adopt <tab-id>                       Make a page the agent did not open its own
  release <tab-id>                     Give a page back to the person
  navigate <tab-id> <url>              Navigate a tab
  snapshot <tab-id> [options]          Read bounded page text and control refs
    --full                            Request the larger snapshot mode
    --selector <css>                   Scope the snapshot to one element
    --max-chars <n> --max-controls <n>  Override snapshot bounds
  click <tab-id> <ref-or-selector>     Click a control
  fill <tab-id> <ref-or-selector> --stdin
                                      Read the exact field value from stdin
  upload <tab-id> <ref> <file> [files] Select up to 8 files, 16 MiB total
  press <tab-id> <key> [ref-or-selector]
                                      Press a supported key
  drag <tab-id> <source> <target>     Drag one element onto another (refs or selectors)
  scroll <tab-id> <direction> [pixels] [ref-or-selector]
                                      Scroll up, down, left or right: the page,
                                      the panel holding a control, or the panel
                                      in the middle when the page cannot scroll
  wait <tab-id> --stdin               Read wait options as JSON from stdin
  batch <tab-id>                      Read an actions array or {actions} JSON
  screenshot <tab-id> <file.png>       Save a viewport PNG without overwriting
  close <tab-id>                      Close a tab
  handoff <space-id>                  Pause automation for human control
  resume <space-id>                   Take control back when the person says to continue
  wait-for-control <space-id> [--timeout <ms>]
                                      Wait until the agent has control again
  run <file.mjs>                      Run a script with the connected client as
                                      the globals kamapathy, createSpace, space
                                      and spaces; run - reads it from stdin and
                                      run -e <code> runs the code itself

A <tab-id> may also be <space-id>:<label>, such as s1:p2.
Default output is concise text. --json returns compact JSON for programs.
Batch stops at the first failed action. Submitted actions are never retried.
Take a snapshot again after navigation before reusing element refs. A ref
follows a control the page draws again only when that control is unmistakable.
`;

function identifier(value) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(required(value, "ID")))
    throw new Error("Invalid space or tab ID.");
  return value;
}
function integer(value, label, minimum = 0) {
  if (!/^\d+$/.test(required(value, label)))
    throw new Error(`${label} must be an integer of at least ${minimum}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum)
    throw new Error(`${label} must be an integer of at least ${minimum}.`);
  return parsed;
}
// Runs an agent's script in this Node process with a connected client as
// globals. The script reaches pages only through the API's documented routes.
async function runScript(args, options) {
  const stderr = options.stderr || process.stderr;
  let source;
  let file;
  if (args[0] === "-e") source = required(args[1], "script code");
  else if (args[0] === "-")
    source = await readInput(options.stdin || process.stdin);
  else {
    file = resolve(required(args[0], "script file"));
    if (!(await exists(file)))
      throw new Error(
        "Script file not found. Use run <file.mjs>, run - or run -e <code>.",
      );
  }
  const client = await connect({
    env: options.env,
    connect: options.connect,
    fetch: options.fetch,
  });
  Object.assign(globalThis, {
    kamapathy: client,
    createSpace: (name, choices) => client.createSpace(name, choices),
    space: (id) => client.space(id),
    spaces: () => client.spaces(),
  });
  let temporary;
  let failed = false;
  const report = (error) => {
    const code = typeof error?.code === "string" ? `${error.code}: ` : "";
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`error: ${code}${printable(message)}\n`);
  };
  // A rejection the script never awaited would otherwise print Node's stack.
  const rejected = (error) => {
    failed = true;
    process.exitCode = 1;
    report(error);
  };
  // process.exit() inside the script skips the finally block below.
  const exited = () => {
    if (temporary) rmSync(temporary, { force: true });
  };
  // The loop drained before the import settled: an await that never resolves.
  const stalled = () => {
    failed = true;
    process.exitCode = 1;
    stderr.write(
      "error: The script stopped with work still pending. Await every call.\n",
    );
    exited();
  };
  process.on("unhandledRejection", rejected);
  process.once("exit", exited);
  process.once("beforeExit", stalled);
  let outcome = 0;
  try {
    if (source !== undefined) {
      temporary = join(
        tmpdir(),
        `kamapathy-run-${randomBytes(8).toString("hex")}.mjs`,
      );
      await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
      file = temporary;
    }
    await import(pathToFileURL(file).href);
  } catch (error) {
    report(error);
    outcome = 1;
  } finally {
    process.off("beforeExit", stalled);
    if (temporary) await rm(temporary, { force: true });
  }
  // A rejection can land while the file is being removed, so this comes last.
  return failed ? 1 : outcome;
}

const UPLOAD_LIMIT = 24 * 1024 * 1024;
const LABELED = /^([a-zA-Z0-9_-]{1,128}):(p[1-9][0-9]*)$/;

// A tab ID, or <space-id>:<label>, which resolves once Kamapathy is found.
function tab(value) {
  const text = required(value, "ID");
  return LABELED.test(text) ? text : identifier(text);
}
// An integer flag value within its bounds.
function bounded(value, flag, minimum, maximum) {
  if (
    !/^\d+$/.test(required(value, flag)) ||
    Number(value) < minimum ||
    Number(value) > maximum
  )
    throw new Error(
      `${flag} must be an integer from ${minimum} to ${maximum}.`,
    );
  return Number(value);
}
// The values of the named flags, each followed by its value.
function flags(args, names) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    if (!names.includes(args[index]))
      throw new Error(`Unknown option: ${args[index]}. Run help for usage.`);
    values[args[index]] = required(args[index + 1], args[index]);
    index++;
  }
  return values;
}
// --page-budget, or else KAMAPATHY_PAGE_BUDGET when it is set.
function budget(value, env) {
  const pageBudget =
    value === undefined
      ? pageBudgetFrom(env)
      : bounded(value, "--page-budget", 1, 20);
  return pageBudget === undefined ? {} : { pageBudget };
}

// One parser per command, keyed by the schema's command names. Each checks
// its arguments before anything connects and returns the request, or runs
// the command itself and returns its exit status.
export const PARSERS = {
  help: (_args, { stdout }) => {
    stdout.write(HELP);
    return 0;
  },
  health: () => ({ path: "/health" }),
  spaces: () => ({ path: "/spaces" }),
  "space create": (args, { env }) => {
    const isolated = args.includes("--isolated");
    return {
      path: "/spaces",
      method: "POST",
      body: {
        name: required(
          args.find((argument) => argument !== "--isolated"),
          "space name",
        ),
        ...(isolated ? { isolated: true } : {}),
        ...budget(undefined, env),
      },
    };
  },
  "space open": (args, { env }) => {
    const isolated = args.includes("--isolated");
    const [name, ...rest] = args.filter(
      (argument) => argument !== "--isolated",
    );
    const { "--page-budget": pageBudget } = flags(rest, ["--page-budget"]);
    return {
      path: "/spaces",
      method: "POST",
      body: {
        name: required(name, "space name or ID"),
        reuse: true,
        ...(isolated ? { isolated: true } : {}),
        ...budget(pageBudget, env),
      },
    };
  },
  // Kept pages are tab IDs or labels in this space, resolved once found.
  "space finish": (args) => {
    const [spaceId, flag, value] = args;
    if (flag !== "--keep" || !value || args.length > 3)
      throw new Error(
        "Use space finish <space-id> --keep all|none|<tab-id>[,<tab-id>].",
      );
    return {
      path: `/spaces/${identifier(spaceId)}/finish`,
      method: "POST",
      body: {
        keep:
          value === "all"
            ? "all"
            : value === "none"
              ? []
              : value
                  .split(",")
                  .map((item) => (isLabel(item) ? item : tab(item))),
      },
    };
  },
  "space request": (args) => {
    const values = flags(args, ["--reason", "--name", "--timeout"]);
    return {
      path: "/space-requests",
      method: "POST",
      body: {
        reason: required(values["--reason"], "--reason"),
        ...(values["--name"] === undefined ? {} : { name: values["--name"] }),
        ...(values["--timeout"] === undefined
          ? {}
          : {
              timeoutMs: bounded(
                values["--timeout"],
                "--timeout",
                5000,
                600000,
              ),
            }),
      },
    };
  },
  "space close": (args) => ({
    path: `/spaces/${identifier(args[0])}`,
    method: "DELETE",
  }),
  handoff: (args) => ({
    path: `/spaces/${identifier(args[0])}/handoff`,
    method: "POST",
    body: {},
  }),
  resume: (args) => ({
    path: `/spaces/${identifier(args[0])}/resume`,
    method: "POST",
    body: {},
  }),
  tabs: (args) => ({ path: `/spaces/${identifier(args[0])}/tabs` }),
  "new-page": (args) => ({
    path: `/spaces/${identifier(args[0])}/tabs`,
    method: "POST",
    body: {},
  }),
  adopt: (args) => ({
    path: `/tabs/${tab(args[0])}/adopt`,
    method: "POST",
    body: {},
  }),
  release: (args) => ({
    path: `/tabs/${tab(args[0])}/release`,
    method: "POST",
    body: {},
  }),
  "wait-for-control": (args) => {
    const { "--timeout": timeout } = flags(args.slice(1), ["--timeout"]);
    return {
      path: `/spaces/${identifier(args[0])}/wait-for-control`,
      method: "POST",
      body:
        timeout === undefined
          ? {}
          : { timeoutMs: bounded(timeout, "--timeout", 0, 600000) },
    };
  },
  open: (args) => ({
    path: `/spaces/${identifier(args[0])}/tabs`,
    method: "POST",
    body: { url: required(args[1], "URL") },
  }),
  navigate: (args) => ({
    path: `/tabs/${tab(args[0])}/navigate`,
    method: "POST",
    body: { url: required(args[1], "URL") },
  }),
  close: (args) => ({ path: `/tabs/${tab(args[0])}`, method: "DELETE" }),
  snapshot: (args) => {
    const body = { mode: "compact" };
    for (let index = 1; index < args.length; index++) {
      if (args[index] === "--full") body.mode = "full";
      else if (args[index] === "--selector")
        body.selector = required(args[++index], "CSS selector");
      else if (args[index] === "--max-chars")
        body.maxChars = integer(args[++index], "maximum characters");
      else if (args[index] === "--max-controls")
        body.maxControls = integer(args[++index], "maximum controls");
      else throw new Error(`Unknown snapshot option: ${args[index]}`);
    }
    return {
      path: `/tabs/${tab(args[0])}/snapshot`,
      method: "POST",
      body,
    };
  },
  click: (args) => ({
    path: `/tabs/${tab(args[0])}/click`,
    method: "POST",
    body: target(args[1]),
  }),
  fill: async (args, { stdin }) => {
    if (args[2] !== "--stdin")
      throw new Error(
        "Use fill <tab-id> <ref-or-selector> --stdin and pipe the field value.",
      );
    return {
      path: `/tabs/${tab(args[0])}/fill`,
      method: "POST",
      body: { ...target(args[1]), value: await readInput(stdin) },
    };
  },
  upload: async (args) => ({
    path: `/tabs/${tab(args[0])}/upload`,
    method: "POST",
    body: {
      ref: uploadRef(args[1]),
      files: await readUploadFiles(args.slice(2)),
    },
    limit: UPLOAD_LIMIT,
  }),
  press: (args) => ({
    path: `/tabs/${tab(args[0])}/press`,
    method: "POST",
    body: {
      key: required(args[1], "key"),
      ...(args[2] ? target(args[2]) : {}),
    },
  }),
  drag: (args) => {
    if (args.length > 3)
      throw new Error("Use drag <tab-id> <source> <target>.");
    return {
      path: `/tabs/${tab(args[0])}/drag`,
      method: "POST",
      body: {
        source: target(required(args[1], "drag source")),
        target: target(required(args[2], "drag target")),
      },
    };
  },
  scroll: (args) => {
    // Pixels come before the optional target; a target alone is also fine.
    // No CSS selector starts with a digit, a sign, or a dot before a digit,
    // so those are pixels. A class selector such as .panel is a target.
    const pixels = /^[-+]?\.?\d/.test(args[2] || "");
    const scrolled = pixels ? args[3] : args[2];
    if (args.length > (pixels ? 4 : 3))
      throw new Error(
        "Use scroll <tab-id> <direction> [pixels] [ref-or-selector].",
      );
    return {
      path: `/tabs/${tab(args[0])}/scroll`,
      method: "POST",
      body: {
        direction: required(args[1], "direction"),
        ...(pixels ? { pixels: integer(args[2], "pixels", 1) } : {}),
        ...(scrolled ? target(scrolled) : {}),
      },
    };
  },
  wait: async (args, { stdin }) => {
    if (args[1] !== "--stdin")
      throw new Error("Use wait <tab-id> --stdin and pipe JSON wait options.");
    const path = `/tabs/${tab(args[0])}/wait`;
    const body = await readJson(stdin);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Wait options must be a JSON object.");
    return { path, method: "POST", body };
  },
  batch: async (args, { stdin }) => {
    const path = `/tabs/${tab(args[0])}/actions`;
    const input = await readJson(stdin);
    const body = Array.isArray(input) ? { actions: input } : input;
    if (
      !body ||
      !Array.isArray(body.actions) ||
      !body.actions.length ||
      body.actions.length > 20
    )
      throw new Error(
        "Batch input requires an actions array with 1 to 20 actions.",
      );
    return { path, method: "POST", body };
  },
  screenshot: (args) => {
    const output = resolve(required(args[1], "output PNG path"));
    if (!output.toLowerCase().endsWith(".png"))
      throw new Error("Screenshot output must have a .png extension.");
    return { path: `/tabs/${tab(args[0])}/screenshot`, output };
  },
  run: (args, options) => runScript(args, options),
};

export async function runCli(argv, options = {}) {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const json = argv.includes("--json");
  const [command = "help", ...rest] = argv.filter(
    (argument) => argument !== "--json",
  );
  const name =
    rest.length && PARSERS[`${command} ${rest[0]}`]
      ? `${command} ${rest[0]}`
      : ["--help", "-h"].includes(command)
        ? "help"
        : command;
  const parse = Object.hasOwn(PARSERS, name) ? PARSERS[name] : undefined;
  if (!parse) {
    if (command === "space")
      throw new Error(
        "Use space create, space open, space finish, space request or space close.",
      );
    throw new Error(`Unknown command: ${command}. Run help for usage.`);
  }
  const env = options.env || process.env;
  const parsed = await parse(name === command ? rest : rest.slice(1), {
    ...options,
    env,
    stdin,
    stdout,
  });
  if (typeof parsed === "number") return parsed;
  const { path, method = "GET", body, output, limit } = parsed;
  // Piped wait options and batches are checked before anything connects.
  if (name === "wait" || name === "batch") {
    const problem = checkBody(matchRoute(method, path), body);
    if (problem)
      throw new KamapathyError(problem.code, problem.message, problem.fields);
  }
  encode(body, limit);
  const session = new Session({
    env,
    fetch: options.fetch,
    connect: options.connect,
    health: options.health,
  });
  await session.ready();
  const { since } = findCommand(name);
  if (session.app && since > session.app.apiLevel) {
    const problem = outdated(name, since, session.app);
    throw new KamapathyError(problem.code, problem.message, problem.fields);
  }
  // <space-id>:<label> tabs and finish's labels resolve with one tabs request.
  let target = path;
  const labeled = /^\/tabs\/([^/]+)(\/.*)?$/.exec(path);
  const tabLabel = labeled && LABELED.exec(labeled[1]);
  if (tabLabel) {
    const [found] = await resolveLabels(session, tabLabel[1], [tabLabel[2]]);
    target = `/tabs/${found.id}${labeled[2] ?? ""}`;
  }
  let sent = body;
  if (name === "space finish" && Array.isArray(body.keep)) {
    const label = (item) => (isLabel(item) ? item : LABELED.exec(item)?.[2]);
    const labels = body.keep.map(label).filter(Boolean);
    const found = labels.length
      ? await resolveLabels(session, path.split("/")[2], labels)
      : [];
    sent = {
      keep: body.keep.map((item) =>
        label(item) ? found.find((tab) => tab.label === label(item)).id : item,
      ),
    };
  }
  const response = await session.send(target, { method, body: sent, limit });
  if (output && response.ok) {
    if (!response.headers.get("content-type")?.startsWith("image/png"))
      throw new Error("The API did not return a PNG screenshot.");
    await writeFile(output, Buffer.from(await response.arrayBuffer()), {
      flag: "wx",
    });
    stdout.write(
      `${json ? JSON.stringify({ saved: output }) : `saved ${output}`}\n`,
    );
    return 0;
  }
  const data = await response.json().catch(() => null);
  if (Array.isArray(data?.results)) {
    stdout.write(`${json ? JSON.stringify(data) : formatResult(data, name)}\n`);
    return data.ok === false || !response.ok ? 1 : 0;
  }
  if (!response.ok) {
    const { code, message, ...fields } = data?.error ?? {};
    throw new KamapathyError(
      code || "request_failed",
      message || "The API request failed.",
      { ...fields, status: response.status },
    );
  }
  if (data === null) throw new Error("The API did not return valid JSON.");
  stdout.write(`${json ? JSON.stringify(data) : formatResult(data, name)}\n`);
  return data?.ok === false ? 1 : 0;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const stderr = options.stderr || process.stderr;
  let status;
  let failure;
  try {
    status = await runCli(argv, options);
  } catch (error) {
    failure = error;
  }
  // Notices follow the command's output and come before its error line.
  for (const text of takeNotices()) stderr.write(`notice: ${line(text)}\n`);
  if (failure === undefined) return status;
  let message = failure instanceof Error ? failure.message : "Command failed.";
  if (failure?.name === "TimeoutError" || failure?.name === "AbortError")
    message =
      "Request timed out. Inspect the page before retrying an action that may have submitted a form.";
  stderr.write(
    failure instanceof KamapathyError && failure.status !== undefined
      ? `Kamapathy: ${failure.status} ${line(failure.code)}: ${line(message)}\n`
      : `Kamapathy: ${printable(message)}\n`,
  );
  return 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = 1;
  // A script whose work never settles keeps the failing code set above.
  main().then((code) => {
    process.exitCode = code;
  });
}
