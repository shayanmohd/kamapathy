#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { KamapathyError } from "./lib/errors.mjs";
import { formatResult, line, printable } from "./lib/format.mjs";
import {
  readFiles,
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
import { connect, Download, Page } from "./api.mjs";
import { formatApiError } from "./diagnostics.mjs";
import {
  formatCommand,
  formatGeneralHelp,
  helpTopic,
  programName,
  skillFolder,
  skillPath,
} from "./help.mjs";
import { startRepl } from "./lib/repl.mjs";
import { runScript } from "./lib/run.mjs";
import { megabytes, updateNotice, upgradeLines } from "./lib/updates.mjs";
import {
  ensureWorkspace,
  prepareWorkspace,
  workspacePath,
} from "./lib/workspace.mjs";
import {
  API_LEVEL,
  checkBody,
  CLIENT_VERSION,
  ERRORS,
  findCommand,
  matchRoute,
  outdated,
  requestBudget,
} from "./schema/index.mjs";

export { formatResult, formatSnapshot } from "./lib/format.mjs";
export { readUploadFiles, target, uploadRef } from "./lib/input.mjs";
export { updateNotice } from "./lib/updates.mjs";
export {
  agentPaths,
  checkSocket,
  launchEnvironment,
  launchKamapathy,
  launchRecord,
  resolveSocket,
  socketFetch,
} from "./lib/transport.mjs";
import { discover } from "./lib/transport.mjs";

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
const UPLOAD_LIMIT = 24 * 1024 * 1024;
const EVENTS = matchRoute("POST", "/tabs/:id/expectations").body.event.values;
const POLICY = matchRoute("POST", "/tabs/:id/dialog-policy").body;
// A route's own time budget, for a long poll the transport must outlast.
const budgetOf = (method, path) => requestBudget(matchRoute(method, path));
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
// A clip written x,y,width,height, as --clip takes it and the
// X-Kamapathy-Clip header reports it, or undefined.
function clipOf(value) {
  const numbers = String(value ?? "")
    .split(",")
    .map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  if (
    numbers.length !== 4 ||
    numbers.some((number) => !Number.isFinite(number))
  )
    return undefined;
  const [x, y, width, height] = numbers;
  return { x, y, width, height };
}
function clip(value) {
  const parsed = clipOf(value);
  if (!parsed)
    throw new Error("--clip must be x,y,width,height in CSS pixels.");
  return parsed;
}
// --scale css or device.
function scale(value) {
  if (!["css", "device"].includes(value))
    throw new Error("--scale must be css or device.");
  return value;
}
// A PNG's pixel size, from the IHDR chunk the signature is followed by.
function pngSize(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((byte, at) => bytes[at] !== byte))
    return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// --label and its value, taken out of an action command's arguments
// wherever they sit, with the rest left in order.
function takeLabel(args) {
  const rest = [];
  let label;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== "--label") {
      rest.push(args[index]);
      continue;
    }
    if (label !== undefined)
      throw new Error("Give --label once. Run help for usage.");
    label = required(args[++index], "--label");
  }
  return { rest, label: label === undefined ? {} : { label } };
}

// The session the commands that drive the client themselves work through.
const ownSession = ({ env, fetch, connect, health }) =>
  new Session({ env, fetch, connect, health });

// The page a <tab-id> or <space-id>:<label> names, resolved once.
async function pageFor(session, value) {
  const labeled = LABELED.exec(value);
  if (!labeled) return new Page(session, { id: value });
  const [found] = await resolveLabels(session, labeled[1], [labeled[2]]);
  return new Page(session, found);
}

// What a saved download prints: the file written and how much it holds.
async function saved(path, options) {
  const { size } = await stat(path);
  (options.stdout || process.stdout).write(
    `${
      options.json
        ? JSON.stringify({ saved: path, bytes: size })
        : `saved ${path} (${size} bytes)`
    }\n`,
  );
  return 0;
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
  help: (args, { env, stdout }) => {
    const program = programName(env);
    (stdout || process.stdout).write(
      args.length
        ? `${helpTopic(args, program)}\n`
        : formatGeneralHelp(program, skillPath()),
    );
    return 0;
  },
  health: () => ({ path: "/health" }),
  upgrade: async (args, options) => {
    const stdout = options.stdout || process.stdout;
    const stderr = options.stderr || process.stderr;
    let checkOnly = false;
    let timeout;
    for (let index = 0; index < args.length; index++)
      if (args[index] === "--check") checkOnly = true;
      else if (args[index] === "--timeout")
        timeout = bounded(args[++index], "--timeout", 0, 1800000);
      else
        throw new Error(`Unknown option: ${args[index]}. Run help for usage.`);
    const client = await connect({
      env: options.env,
      fetch: options.fetch,
      connect: options.connect,
      health: options.health,
    });
    try {
      let status = await client.checkForUpdates();
      if (!checkOnly) {
        const installer = status.latest?.installer;
        // A download is about to start or to be joined.
        if (
          ["available", "downloading"].includes(status.state) &&
          typeof installer?.name === "string" &&
          typeof installer?.size === "number"
        )
          stderr.write(
            `Downloading ${line(installer.name)} (${megabytes(installer.size)} MB)...\n`,
          );
        status = await client.downloadUpdate(
          timeout === undefined ? {} : { timeout },
        );
      }
      stdout.write(
        `${options.json ? JSON.stringify(status) : upgradeLines(status).join("\n")}\n`,
      );
      return 0;
    } catch (error) {
      // A download or checksum failure has no HTTP status of its own; every
      // other error prints as any other command's does.
      if (
        !(error instanceof KamapathyError) ||
        error.status !== undefined ||
        !ERRORS[error.code]?.carriedIn
      )
        throw error;
      const [, ...rest] = formatApiError(error);
      stderr.write(
        [
          `Kamapathy: ${line(error.code)}: ${line(error.message)}`,
          ...rest,
          "",
        ].join("\n"),
      );
      return 1;
    }
  },
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
  // A text or --clear, never both and never neither.
  status: (args) => {
    const rest = args.filter((argument) => argument !== "--clear");
    const clear = rest.length < args.length;
    if (clear === (rest[1] !== undefined) || rest.length > 2)
      throw new Error(
        "Use status <space-id> <text>, or status <space-id> --clear.",
      );
    return {
      path: `/spaces/${identifier(rest[0])}/status`,
      method: "POST",
      body: { text: clear ? "" : rest[1] },
    };
  },
  fail: (args) => {
    if (args.length > 2) throw new Error("Use fail <space-id> <message>.");
    return {
      path: `/spaces/${identifier(args[0])}/fail`,
      method: "POST",
      body: { message: required(args[1], "message") },
    };
  },
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
        body.selector = required(args[++index], "selector");
      else if (args[index] === "--root")
        body.root = required(args[++index], "--root");
      else if (args[index] === "--viewport") body.scope = "viewport";
      else if (args[index] === "--outline") body.format = "outline";
      else if (args[index] === "--locators") body.locators = true;
      else if (args[index] === "--no-header") body.header = false;
      else if (args[index] === "--cursor")
        body.cursor = required(args[++index], "--cursor");
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
  click: (args) => {
    const { rest, label } = takeLabel(args);
    return {
      path: `/tabs/${tab(rest[0])}/click`,
      method: "POST",
      body: { ...target(rest[1]), ...label },
    };
  },
  fill: async (args, { stdin, stdinTimeoutMs }) => {
    const { rest, label } = takeLabel(args);
    if (rest[2] !== "--stdin")
      throw new Error(
        "Use fill <tab-id> <ref-or-selector> --stdin and pipe the field value.",
      );
    return {
      path: `/tabs/${tab(rest[0])}/fill`,
      method: "POST",
      body: {
        ...target(rest[1]),
        value: await readInput(stdin || process.stdin, {
          timeoutMs: stdinTimeoutMs,
        }),
        ...label,
      },
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
  press: (args) => {
    const { rest, label } = takeLabel(args);
    return {
      path: `/tabs/${tab(rest[0])}/press`,
      method: "POST",
      body: {
        key: required(rest[1], "key"),
        ...(rest[2] ? target(rest[2]) : {}),
        ...label,
      },
    };
  },
  drag: (args) => {
    const { rest, label } = takeLabel(args);
    if (rest.length > 3)
      throw new Error("Use drag <tab-id> <source> <target>.");
    return {
      path: `/tabs/${tab(rest[0])}/drag`,
      method: "POST",
      body: {
        source: target(required(rest[1], "drag source")),
        target: target(required(rest[2], "drag target")),
        ...label,
      },
    };
  },
  scroll: (args) => {
    // Pixels come before the optional target; a target alone is also fine.
    // No CSS selector starts with a digit, a sign, or a dot before a digit,
    // so those are pixels. A class selector such as .panel is a target.
    const { rest, label } = takeLabel(args);
    const pixels = /^[-+]?\.?\d/.test(rest[2] || "");
    const scrolled = pixels ? rest[3] : rest[2];
    if (rest.length > (pixels ? 4 : 3))
      throw new Error(
        "Use scroll <tab-id> <direction> [pixels] [ref-or-selector].",
      );
    return {
      path: `/tabs/${tab(rest[0])}/scroll`,
      method: "POST",
      body: {
        direction: required(rest[1], "direction"),
        ...(pixels ? { pixels: integer(rest[2], "pixels", 1) } : {}),
        ...(scrolled ? target(scrolled) : {}),
        ...label,
      },
    };
  },
  wait: async (args, { stdin, stdinTimeoutMs }) => {
    if (args[1] !== "--stdin")
      throw new Error("Use wait <tab-id> --stdin and pipe JSON wait options.");
    const path = `/tabs/${tab(args[0])}/wait`;
    const body = await readJson(stdin || process.stdin, {
      timeoutMs: stdinTimeoutMs,
    });
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error("Wait options must be a JSON object.");
    return { path, method: "POST", body };
  },
  batch: async (args, { stdin, stdinTimeoutMs }) => {
    const path = `/tabs/${tab(args[0])}/actions`;
    const input = await readJson(stdin || process.stdin, {
      timeoutMs: stdinTimeoutMs,
    });
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
  // Without flags the viewport capture stays a GET; any flag posts a body.
  screenshot: (args) => {
    const output = resolve(required(args[1], "output PNG path"));
    if (!output.toLowerCase().endsWith(".png"))
      throw new Error("Screenshot output must have a .png extension.");
    const body = {};
    for (let index = 2; index < args.length; index++) {
      if (args[index] === "--full-page") body.fullPage = true;
      else if (args[index] === "--clip")
        body.clip = clip(required(args[++index], "--clip"));
      else if (args[index] === "--scale")
        body.scale = scale(required(args[++index], "--scale"));
      else throw new Error(`Unknown screenshot option: ${args[index]}`);
    }
    const path = `/tabs/${tab(args[0])}/screenshot`;
    return Object.keys(body).length
      ? { path, method: "POST", body, output }
      : { path, output };
  },
  "pdf-text": (args) => {
    const values = flags(args.slice(1), [
      "--from",
      "--to",
      "--max-chars",
      "--timeout",
    ]);
    const field = (flag, name, minimum, maximum) =>
      values[flag] === undefined
        ? {}
        : { [name]: bounded(values[flag], flag, minimum, maximum) };
    return {
      path: `/tabs/${tab(args[0])}/pdf/text`,
      method: "POST",
      body: {
        ...field("--from", "from", 1, 100000),
        ...field("--to", "to", 1, 100000),
        ...field("--max-chars", "maxChars", 0, 1000000),
        ...field("--timeout", "timeoutMs", 0, 60000),
      },
    };
  },
  // The CLI arms for a minute by default, to cover the agent's pause
  // between commands.
  expect: (args) => {
    const path = `/tabs/${tab(args[0])}/expectations`;
    const event = required(args[1], "event");
    if (!EVENTS.includes(event))
      throw new Error(`Use expect <tab-id> ${EVENTS.join("|")}.`);
    const { "--timeout": timeout } = flags(args.slice(2), ["--timeout"]);
    return {
      path,
      method: "POST",
      body: {
        event,
        timeoutMs:
          timeout === undefined
            ? 60000
            : bounded(timeout, "--timeout", 1, 60000),
      },
    };
  },
  "wait-expectation": (args) => {
    if (args.length > 1) throw new Error("Use wait-expectation <id>.");
    const path = `/expectations/${identifier(args[0])}/wait`;
    return { path, method: "POST", body: {}, budgetMs: budgetOf("POST", path) };
  },
  "dialog-policy": async (args, { stdin, stdinTimeoutMs }) => {
    const [id, answer, ...rest] = args;
    if (!["accept", "dismiss", "reset"].includes(answer))
      throw new Error("Use dialog-policy <tab-id> accept|dismiss|reset.");
    const path = `/tabs/${tab(id)}/dialog-policy`;
    const fromStdin = rest.includes("--prompt-stdin");
    const values = flags(
      rest.filter((argument) => argument !== "--prompt-stdin"),
      ["--times", "--lifetime"],
    );
    if (answer === "reset") {
      if (fromStdin || Object.keys(values).length)
        throw new Error("dialog-policy reset takes no other options.");
      return { path, method: "DELETE" };
    }
    let promptText;
    if (fromStdin) {
      promptText = await readInput(stdin || process.stdin, {
        timeoutMs: stdinTimeoutMs,
      });
      if (promptText.length > POLICY.promptText.max)
        throw new Error(
          `The prompt text must be at most ${POLICY.promptText.max} characters.`,
        );
    }
    return {
      path,
      method: "POST",
      body: {
        accept: answer === "accept",
        ...(values["--times"] === undefined
          ? {}
          : { times: bounded(values["--times"], "--times", 1, 20) }),
        ...(values["--lifetime"] === undefined
          ? {}
          : {
              lifetimeMs: bounded(
                values["--lifetime"],
                "--lifetime",
                1000,
                600000,
              ),
            }),
        ...(promptText === undefined ? {} : { promptText }),
      },
    };
  },
  dialogs: (args) => ({ path: `/tabs/${tab(args[0])}/dialogs` }),
  "set-input-files": async (args) => ({
    path: `/tabs/${tab(args[0])}/set-input-files`,
    method: "POST",
    body: { ...target(args[1]), files: await readFiles(args.slice(2)) },
    limit: UPLOAD_LIMIT,
  }),
  "set-files": async (args) => ({
    path: `/file-choosers/${identifier(args[0])}/files`,
    method: "POST",
    body: { files: await readFiles(args.slice(1)) },
    limit: UPLOAD_LIMIT,
  }),
  // One command for the whole path: arm the wait, click, then save what
  // arrives. Nothing downloaded fails with the wait's own error.
  download: async (args, options) => {
    const [id, selector, output, ...rest] = args;
    const where = resolve(required(output, "output path"));
    const chosen = required(selector, "element ref or CSS selector");
    const { "--timeout": timeout } = flags(rest, ["--timeout"]);
    const timeoutMs =
      timeout === undefined ? 60000 : bounded(timeout, "--timeout", 1, 60000);
    const session = ownSession(options);
    const page = await pageFor(session, tab(id));
    const next = page.waitForEvent("download", { timeout: timeoutMs });
    try {
      await page.click(chosen);
    } catch (error) {
      // The arm's own failure is already this error.
      next.catch(() => {});
      throw error;
    }
    const download = await next;
    return saved(await download.saveAs(where), options);
  },
  downloads: (args) => ({ path: `/spaces/${identifier(args[0])}/downloads` }),
  "save-download": async (args, options) => {
    const id = identifier(args[0]);
    const where = resolve(required(args[1], "output path"));
    if (args.length > 2) throw new Error("Use save-download <id> <path>.");
    const session = ownSession(options);
    const { download } = await session.request(`/downloads/${id}`);
    return saved(await new Download(session, download).saveAs(where), options);
  },
  "cancel-download": (args) => ({
    path: `/downloads/${identifier(args[0])}/cancel`,
    method: "POST",
    body: {},
  }),
  "delete-download": (args) => ({
    path: `/downloads/${identifier(args[0])}`,
    method: "DELETE",
  }),
  // The name and password come from standard input, never from the command
  // line, and nothing prints them back.
  "http-credentials": async (args, { stdin, stdinTimeoutMs }) => {
    const path = `/spaces/${identifier(args[0])}/http-credentials`;
    const usage =
      "Use http-credentials <space-id> <origin> --stdin and pipe JSON with a username and a password, or http-credentials <space-id> clear.";
    if (args[1] === "clear") {
      if (args.length > 2) throw new Error(usage);
      return { path, method: "DELETE" };
    }
    const origin = required(args[1], "origin");
    if (args[2] !== "--stdin" || args.length > 3) throw new Error(usage);
    const given = await readJson(stdin || process.stdin, {
      timeoutMs: stdinTimeoutMs,
    });
    const { username, password } = given ?? {};
    if (typeof username !== "string" || typeof password !== "string")
      throw new Error(
        "Standard input must be a JSON object with a username and a password.",
      );
    return { path, method: "POST", body: { origin, username, password } };
  },
  run: (args, options) => runScript(args, options),
  repl: async (args, options) => {
    const input = options.stdin || process.stdin;
    const output = options.stdout || process.stdout;
    if (!(options.terminal ?? (input.isTTY && output.isTTY)))
      throw new Error("repl needs a terminal. Pipe a script to run - instead.");
    const envFiles = [];
    for (let index = 0; index < args.length; index++)
      if (args[index] === "--env-file")
        envFiles.push(required(args[++index], "--env-file path"));
      else
        throw new Error(
          `Unknown repl option: ${args[index]}. Run help for usage.`,
        );
    const { applied } = await prepareWorkspace(options.env, envFiles, {
      stderr: options.stderr || process.stderr,
    });
    const session = new Session({
      env: options.env,
      fetch: options.fetch,
      connect: options.connect,
      health: options.health,
      lazy: true,
      envFileNames: applied,
    });
    return startRepl({
      input,
      output,
      session,
      client: await connect({ session, lazy: true }),
      terminal: true,
    });
  },
  workspace: async (_args, { env, json, stdout }) => {
    const workspace = await ensureWorkspace(workspacePath(env));
    (stdout || process.stdout).write(
      `${json ? JSON.stringify({ workspace }) : workspace}\n`,
    );
    return 0;
  },
};

export async function runCli(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  // Arguments after -- are read literally, never as --help, --version or
  // --json.
  const end = argv.indexOf("--");
  const flagged = end < 0 ? argv : argv.slice(0, end);
  const json = flagged.includes("--json");
  const asksHelp = flagged.some((argument) =>
    ["--help", "-h"].includes(argument),
  );
  const [command = "help", ...rest] = [
    ...flagged.filter(
      (argument) => !["--json", "--help", "-h"].includes(argument),
    ),
    ...(end < 0 ? [] : argv.slice(end + 1)),
  ];
  const env = options.env || process.env;
  if (command === "--version" || command === "-v")
    return versions(env, options, json, stdout);
  const name =
    rest.length && PARSERS[`${command} ${rest[0]}`]
      ? `${command} ${rest[0]}`
      : command;
  const parse = Object.hasOwn(PARSERS, name) ? PARSERS[name] : undefined;
  // <command> --help shows that command's help and nothing else runs; on
  // its own, --help is general help.
  if (asksHelp && parse && name !== "help") {
    stdout.write(`${formatCommand(findCommand(name), programName(env))}\n`);
    return 0;
  }
  if (!parse) {
    if (command === "space")
      throw new Error(
        "Use space create, space open, space finish, space request or space close.",
      );
    throw new Error(`Unknown command: ${command}. Run help for usage.`);
  }
  // Parsers get the caller's own streams, so run can tell a test's sinks
  // from the real process.
  const parsed = await parse(name === command ? rest : rest.slice(1), {
    ...options,
    env,
    json,
  });
  if (typeof parsed === "number") return parsed;
  const { path, method = "GET", body, output, limit, budgetMs } = parsed;
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
  // The health command tells the agent about a waiting update.
  if (name === "health") {
    const notice = updateNotice(session.app);
    if (notice) session.notice(notice.key, notice.text);
  }
  const { since } = findCommand(name);
  if (session.app && since > session.app.apiLevel) {
    const problem = outdated(name, since, session.app);
    throw new KamapathyError(problem.code, problem.message, problem.fields);
  }
  // Snapshot and screenshot flags reach routes and fields older apps do not
  // have, so each is refused by name before it is sent.
  if (["snapshot", "screenshot"].includes(name) && session.app) {
    const route = matchRoute(method, path);
    const refuse = (required, field) => {
      const problem = outdated(name, required, session.app, field);
      throw new KamapathyError(problem.code, problem.message, problem.fields);
    };
    if (route && route.since > session.app.apiLevel) refuse(route.since);
    for (const [field, spec] of Object.entries(route?.body ?? {}))
      if (
        body?.[field] !== undefined &&
        (spec.since ?? 1) > session.app.apiLevel
      )
        refuse(spec.since, field);
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
  const response = await session.send(target, {
    method,
    body: sent,
    limit,
    budgetMs,
  });
  if (output && response.ok) {
    if (!response.headers.get("content-type")?.startsWith("image/png"))
      throw new Error("The API did not return a PNG screenshot.");
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(output, bytes, { flag: "wx" });
    const size = pngSize(bytes);
    const captured = clipOf(response.headers.get("X-Kamapathy-Clip"));
    const ratio = Number(response.headers.get("X-Kamapathy-Pixel-Ratio"));
    stdout.write(
      `${
        json
          ? JSON.stringify({
              saved: output,
              ...(size ?? {}),
              ...(captured ? { clip: captured } : {}),
              ...(Number.isFinite(ratio) && ratio > 0
                ? { pixelRatio: ratio }
                : {}),
            })
          : `saved ${output}${size ? ` (${size.width}x${size.height})` : ""}`
      }\n`,
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

// kamapathy --version: the client, the skill and the running Kamapathy,
// found without starting it.
async function versions(env, options, json, stdout) {
  const client = {
    version: CLIENT_VERSION,
    apiLevel: API_LEVEL,
    node: process.versions.node,
    skill: skillFolder(),
  };
  let app = null;
  let appStatus = "running";
  let problem;
  try {
    const { health } = await discover(env, {
      ...options.connect,
      allowLaunch: false,
      healthTimeoutMs: 2000,
    });
    app = {
      version: health.version,
      apiLevel: Number.isInteger(health.apiLevel) ? health.apiLevel : 1,
      electron: health.versions?.electron,
      chromium: health.versions?.chromium,
      node: health.versions?.node,
    };
  } catch (error) {
    appStatus =
      error?.reason === "access_off"
        ? "access_off"
        : ["not_running", "quit_by_person"].includes(error?.reason)
          ? "not_running"
          : "unreachable";
    problem = error instanceof Error ? error.message : String(error);
  }
  if (json) {
    stdout.write(`${JSON.stringify({ client, app, appStatus })}\n`);
    return 0;
  }
  const named = app?.version ? `Kamapathy ${line(app.version)}` : "Kamapathy";
  const lines = [
    `Kamapathy client ${CLIENT_VERSION}, API level ${API_LEVEL}, Node ${process.versions.node}`,
    `Skill ${client.skill ?? "folder not found"}`,
  ];
  if (!app)
    lines.push(
      appStatus === "access_off"
        ? "Agent access is off in Kamapathy."
        : appStatus === "not_running"
          ? "Kamapathy is not running."
          : `Kamapathy did not answer: ${line(problem)}.`,
    );
  else {
    lines.push(
      [
        `${named}, API level ${app.apiLevel}`,
        ...(app.electron ? [`Electron ${line(app.electron)}`] : []),
        ...(app.chromium ? [`Chromium ${line(app.chromium)}`] : []),
        ...(app.node ? [`Node ${line(app.node)}`] : []),
      ].join(", "),
    );
    if (app.apiLevel < API_LEVEL)
      lines.push(
        `${named} has API level ${app.apiLevel} and this client uses ${API_LEVEL}. Calls added after level ${app.apiLevel} fail until the person updates Kamapathy.`,
      );
    else if (app.apiLevel > API_LEVEL)
      lines.push(
        `This skill copy (${CLIENT_VERSION}) is older than ${named}. Update this skill copy, then read its SKILL.md again.`,
      );
  }
  stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

// Every command but help and version needs this Node.js.
function supported(version) {
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const stderr = options.stderr || process.stderr;
  const version = options.nodeVersion ?? process.versions.node;
  if (
    argv[0] !== "help" &&
    !argv.some((argument) =>
      ["--help", "-h", "--version", "-v"].includes(argument),
    ) &&
    !supported(version)
  ) {
    stderr.write(
      `Kamapathy: Kamapathy's client needs Node.js 22.13 or later. This is Node.js ${printable(version)}.\n`,
    );
    return 1;
  }
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
      ? `${formatApiError(failure).join("\n")}\n`
      : `Kamapathy: ${printable(message)}\n`,
  );
  return 1;
}

// Node loads this module from its real path, also when it was started through
// a linked skill folder.
function startedDirectly() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (startedDirectly()) {
  process.exitCode = 1;
  // A script whose work never settles keeps the failing code set above.
  main().then((code) => {
    process.exitCode = code;
  });
}
