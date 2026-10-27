// Site packs: the two roots a pack can live in, the files a pack may hold and
// the rules its pack.json must pass. Reading a pack never runs its code.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { domainToASCII, fileURLToPath, pathToFileURL } from "node:url";
import { KamapathyError } from "./errors.mjs";
import { line } from "./format.mjs";
import { checkWorkspace, workspacePath } from "./workspace.mjs";

export const LIMITS = {
  manifest: 65536,
  tool: 262144,
  pageTool: 32768,
  note: 16384,
  packs: 200,
  skipped: 20,
  pageToolArgs: 16384,
  problems: 10,
};
export const PACK_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
export const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
export const FILE_PART = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const ARG_NAME = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
export const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
];
export const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
export const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

const CONTROL_ALL = /[\u0000-\u001f\u007f-\u009f]/g;
// The same, keeping tab and newline for note text.
const CONTROL_LINES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const BIDI_ALL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const POSIX = process.platform !== "win32";

/** One rule a pack breaks. `field` names a pack.json path, `file` a file in the pack. */
export class PackProblem extends Error {
  constructor(message, { field, file, line: at } = {}) {
    super(message);
    this.name = "PackProblem";
    /** @type {string | undefined} */
    this.field = field;
    /** @type {string | undefined} */
    this.file = file;
    /** @type {number | undefined} */
    this.line = at;
  }
}

/** "<field or file[:line]>: <message>", the one form every caller prints. */
export function problemText(problem) {
  const place = problem.field
    ? problem.field
    : problem.file
      ? problem.line
        ? `${problem.file}:${problem.line}`
        : problem.file
      : "";
  return place ? `${place}: ${problem.message}` : problem.message;
}

/** Drops control characters, keeping tab and newline when `newlines` is true, and every bidirectional control. */
export function cleanText(text, { newlines = false } = {}) {
  return String(text ?? "")
    .replace(newlines ? CONTROL_LINES : CONTROL_ALL, "")
    .replace(BIDI_ALL, "");
}

// A value from a pack quoted for a problem, with nothing that can disguise it.
const shown = (value) => JSON.stringify(cleanText(String(value)));

/** The workspace root first, then the bundled one. */
export function siteRoots(env = process.env) {
  return [
    { path: join(workspacePath(env), "sites"), source: "workspace" },
    {
      path: resolve(fileURLToPath(new URL("../../sites/", import.meta.url))),
      source: "bundled",
    },
  ];
}

// What is wrong with one component of a path, with its own stat when nothing
// is: a link anywhere, and under the workspace a path another account owns or
// can change.
async function componentCheck(path, name, { owner }) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    const missing = error?.code === "ENOENT";
    return {
      missing,
      message: missing
        ? `${name} is missing.`
        : `${name} could not be read (${error?.code ?? "unknown"}).`,
    };
  }
  if (metadata.isSymbolicLink())
    return {
      message: `${name} is a link. Site packs hold only regular files and folders.`,
    };
  if (owner && POSIX && !ownedPrivately(metadata))
    return { message: refuseOwner(name, path) };
  return { metadata };
}

const ownedPrivately = (metadata) =>
  metadata.uid === process.getuid() && (metadata.mode & 0o022) === 0;
const refuseOwner = (name, path) =>
  `${name} must be owned by your account and not changeable by others. Run chmod go-w ${path}.`;

/** Every component from the root down, lstat'ed. Throws PackProblem. */
export async function trustedPath(root, relative, { owner }) {
  const parts = String(relative ?? "")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  const file = parts.join("/") || undefined;
  const base = resolve(root.path);
  let path = base;
  // The root is named by its own path; everything under it by its place in
  // the pack, which is what a problem line shows.
  let check = await componentCheck(path, path, { owner });
  if (check.message) throw new PackProblem(check.message, { file });
  const walked = [];
  for (const part of parts) {
    path = join(path, part);
    walked.push(part);
    check = await componentCheck(path, walked.join("/"), { owner });
    if (check.message) throw new PackProblem(check.message, { file });
  }
  // A Windows junction need not read as a link, so the real path must stay
  // inside the root as well.
  if (!POSIX) {
    const real = await realpath(path);
    const inside = await realpath(base);
    if (real !== inside && !real.startsWith(inside + sep))
      throw new PackProblem(
        `${file ?? path} leaves ${base}. Site packs hold only regular files and folders.`,
        { file },
      );
  }
  return path;
}

/** trustedPath, then one O_NOFOLLOW read of a regular file within `limit`. Throws PackProblem. */
export async function readTrustedFile(
  root,
  relative,
  { owner, kind, limit = LIMITS[kind] },
) {
  const path = await trustedPath(root, relative, { owner });
  const refuse = (message) => new PackProblem(message, { file: relative });
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    throw refuse(
      error?.code === "ENOENT"
        ? `${relative} is missing.`
        : `${relative} could not be read (${error?.code ?? "unknown"}).`,
    );
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw refuse(`${relative} must be a regular file.`);
    if (metadata.size > limit)
      throw refuse(`${relative} must be at most ${limit / 1024} KiB.`);
    // The same rules again on the open handle, as the workspace does for
    // .env, so a file swapped between the lstat and the open is refused too.
    if (owner && POSIX && !ownedPrivately(metadata))
      throw refuse(refuseOwner(relative, path));
    return await file.readFile();
  } finally {
    await file.close();
  }
}

/** Whether a root can be read, and why not when it cannot. */
export async function rootState(root) {
  const base = { path: resolve(root.path), source: root.source };
  const owner = root.source === "workspace";
  // The workspace itself answers first, in its own words.
  if (owner)
    try {
      await checkWorkspace(dirname(base.path));
    } catch (error) {
      return { ...base, state: "refused", problem: error.message };
    }
  const check = await componentCheck(base.path, base.path, { owner });
  if (check.message)
    return check.missing
      ? { ...base, state: "missing" }
      : { ...base, state: "refused", problem: check.message };
  if (!check.metadata.isDirectory())
    return {
      ...base,
      state: "refused",
      problem: `${base.path} must be a folder of site packs.`,
    };
  return { ...base, state: "ok" };
}

const PACK_KEYS = [
  "format",
  "id",
  "name",
  "domains",
  "notes",
  "tools",
  "pageTools",
];
const NODE_TOOL_KEYS = ["description", "file", "export", "args", "returns"];
const PAGE_TOOL_KEYS = ["description", "file", "args", "returns"];
const ARG_KEYS = ["type", "required", "description"];
const KINDS = [
  { key: "tools", kind: "node", prefix: "tools", extension: ".mjs" },
  { key: "pageTools", kind: "page", prefix: "page-tools", extension: ".js" },
];
const LABELS = { node: "a tool", page: "a page tool" };
// How a problem names the map a tool is already in.
const KINDS_TAKEN = { node: "a Node tool", page: "a page tool" };
const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const isHost = (value, least) => {
  const labels = value.split(".");
  return (
    labels.length >= least &&
    labels.every((label) => label.length <= 63 && LABEL.test(label))
  );
};

// A name or description: there, within its length and free of anything that
// can hide or reorder what it says.
function textProblem(value, { label, limit }) {
  const length = typeof value === "string" ? [...value].length : 0;
  if (length < 1 || length > limit)
    return `${label} must be 1 to ${limit} characters.`;
  if (CONTROL.test(value) || BIDI.test(value))
    return `${label} holds a control or bidirectional character.`;
  return null;
}

// A lowercase host or IPv4 address, or "*." and a host of two or more labels.
function domainProblem(entry) {
  const wildcard = entry.startsWith("*.");
  const least = wildcard ? 2 : 1;
  const host = wildcard ? entry.slice(2) : entry;
  if (!isHost(host, least)) {
    const ascii = /^[\x20-\x7e]*$/.test(entry) ? "" : domainToASCII(entry);
    if (ascii && isHost(ascii.startsWith("*.") ? ascii.slice(2) : ascii, least))
      return `a host is written in punycode: use ${ascii}.`;
    return `${shown(entry)} must be a lowercase host, an IPv4 address, or *. and a host of two or more labels.`;
  }
  if (host.length > 253) return "a host must be at most 253 characters.";
  return null;
}

// A declared file is "<prefix>/<name><extension>" with <name> matching
// FILE_PART, so nothing reaches outside the pack.
function fileProblem(value, { prefix, extension }) {
  const want = `${prefix}/<name>${extension}`;
  if (typeof value !== "string") return `a file must be ${want}.`;
  const name =
    value.startsWith(`${prefix}/`) && value.endsWith(extension)
      ? value.slice(prefix.length + 1, value.length - extension.length)
      : null;
  if (name === null || !FILE_PART.test(name))
    return `${shown(value)} must be ${want}, with <name> of lowercase letters, digits, dots, hyphens and underscores.`;
  return null;
}

function unknownKeys(value, known, field, label, add) {
  for (const key of Object.keys(value))
    if (!known.includes(key))
      add(
        field ? `${field}.${cleanText(key)}` : cleanText(key),
        `${shown(key)} is not a field of ${label}.`,
      );
}

function toolProblems(tool, { field, kind, prefix, extension }, add) {
  if (!isPlainObject(tool)) {
    add(field, `${LABELS[kind]} must be an object.`);
    return;
  }
  const description = textProblem(tool.description, {
    label: "description",
    limit: 200,
  });
  if (description) add(`${field}.description`, description);
  const file = fileProblem(tool.file, { prefix, extension });
  if (file) add(`${field}.file`, file);
  if (
    kind === "node" &&
    (typeof tool.export !== "string" || !IDENTIFIER.test(tool.export))
  )
    add(
      `${field}.export`,
      "export must name the function the tool's module exports.",
    );
  if (tool.args !== undefined) {
    if (!isPlainObject(tool.args) || Object.keys(tool.args).length > 16)
      add(`${field}.args`, "args must be an object of up to 16 arguments.");
    else
      for (const [name, arg] of Object.entries(tool.args)) {
        const at = `${field}.args.${cleanText(name)}`;
        if (!ARG_NAME.test(name)) {
          add(
            at,
            "an argument name must be 1 to 48 characters of letters, digits and underscores, starting with a letter.",
          );
          continue;
        }
        if (!isPlainObject(arg)) {
          add(
            at,
            "an argument must be an object with a type and a description.",
          );
          continue;
        }
        if (!TYPES.includes(arg.type))
          add(`${at}.type`, `type must be one of ${TYPES.join(", ")}.`);
        if (arg.required !== undefined && typeof arg.required !== "boolean")
          add(`${at}.required`, "required must be true or false.");
        const text = textProblem(arg.description, {
          label: "description",
          limit: 200,
        });
        if (text) add(`${at}.description`, text);
        unknownKeys(arg, ARG_KEYS, at, "an argument", add);
      }
  }
  if (!isPlainObject(tool.returns))
    add(
      `${field}.returns`,
      "returns must be an object with a type and a description.",
    );
  else {
    if (!TYPES.includes(tool.returns.type))
      add(`${field}.returns.type`, `type must be one of ${TYPES.join(", ")}.`);
    const text = textProblem(tool.returns.description, {
      label: "description",
      limit: 300,
    });
    if (text) add(`${field}.returns.description`, text);
    unknownKeys(
      tool.returns,
      ["type", "description"],
      `${field}.returns`,
      "returns",
      add,
    );
  }
  unknownKeys(
    tool,
    kind === "node" ? NODE_TOOL_KEYS : PAGE_TOOL_KEYS,
    field,
    LABELS[kind],
    add,
  );
}

/** Pure: every rule of the manifest table, in file order. */
export function manifestProblems(value, { id }) {
  if (!isPlainObject(value))
    return [
      new PackProblem("pack.json must hold a JSON object.", {
        file: "pack.json",
      }),
    ];
  const problems = [];
  const add = (field, message) =>
    problems.push(new PackProblem(message, { field }));
  if (value.format !== 1) add("format", "format must be 1.");
  if (typeof value.id !== "string" || !PACK_ID.test(value.id))
    add(
      "id",
      "id must be 1 to 48 characters of lowercase letters, digits and hyphens, starting with a letter or digit.",
    );
  else if (value.id !== id)
    add("id", `id must be ${shown(id)}, the name of the pack's folder.`);
  const name = textProblem(value.name, { label: "name", limit: 48 });
  if (name) add("name", name);
  if (
    !Array.isArray(value.domains) ||
    value.domains.length < 1 ||
    value.domains.length > 32
  )
    add("domains", "domains must list 1 to 32 hosts.");
  else {
    const seen = new Set();
    for (const [index, entry] of value.domains.entries()) {
      const field = `domains.${index}`;
      if (typeof entry !== "string") {
        add(field, "a domain must be a host.");
        continue;
      }
      const problem = domainProblem(entry);
      if (problem) add(field, problem);
      else if (seen.has(entry)) add(field, `${shown(entry)} is listed twice.`);
      else seen.add(entry);
    }
  }
  if (value.notes !== undefined) {
    if (!Array.isArray(value.notes) || value.notes.length > 8)
      add("notes", "notes must list up to 8 files in notes/.");
    else {
      const seen = new Set();
      for (const [index, entry] of value.notes.entries()) {
        const field = `notes.${index}`;
        const problem = fileProblem(entry, {
          prefix: "notes",
          extension: ".md",
        });
        if (problem) add(field, problem);
        else if (seen.has(entry))
          add(field, `${shown(entry)} is listed twice.`);
        else seen.add(entry);
      }
    }
  }
  const named = new Map();
  for (const { key, kind, prefix, extension } of KINDS) {
    const map = value[key];
    if (map === undefined) continue;
    if (!isPlainObject(map) || Object.keys(map).length > 32) {
      add(key, `${key} must be an object of up to 32 tools.`);
      continue;
    }
    for (const [name, tool] of Object.entries(map)) {
      const field = `${key}.${cleanText(name)}`;
      if (!TOOL_NAME.test(name)) {
        add(
          field,
          "a tool name must be 1 to 48 characters of lowercase letters, digits and underscores, starting with a letter.",
        );
        continue;
      }
      if (named.has(name)) {
        add(
          field,
          `${name} is already ${KINDS_TAKEN[named.get(name)]} of this pack.`,
        );
        continue;
      }
      named.set(name, kind);
      toolProblems(tool, { field, kind, prefix, extension }, add);
    }
  }
  unknownKeys(value, PACK_KEYS, "", "pack.json", add);
  return problems;
}

const toolList = (map, kind) =>
  Object.entries(map ?? {}).map(([name, tool]) => ({
    name,
    kind,
    description: tool.description,
    file: tool.file,
    ...(kind === "node" ? { export: tool.export } : {}),
    args: Object.entries(tool.args ?? {}).map(([argument, arg]) => ({
      name: argument,
      type: arg.type,
      required: arg.required === true,
      description: arg.description,
    })),
    returns: {
      type: tool.returns.type,
      description: tool.returns.description,
    },
  }));

/** Reads <dir>/pack.json through readTrustedFile and parses it. */
export async function readManifest(dir, { source, id }) {
  const root = { path: dir, source };
  const only = (problem) => ({ pack: null, problems: [problem] });
  let text;
  try {
    const buffer = await readTrustedFile(root, "pack.json", {
      owner: source === "workspace",
      kind: "manifest",
    });
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    if (error instanceof PackProblem) return only(error);
    if (error instanceof TypeError)
      return only(
        new PackProblem("pack.json must be UTF-8 text.", {
          file: "pack.json",
        }),
      );
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return only(
      new PackProblem(`pack.json is not valid JSON (${line(error.message)}).`, {
        file: "pack.json",
      }),
    );
  }
  const problems = manifestProblems(value, { id });
  if (problems.length) return { pack: null, problems };
  return {
    pack: {
      id,
      name: value.name,
      dir: resolve(dir),
      source,
      domains: [...value.domains],
      notes: [...(value.notes ?? [])],
      tools: toolList(value.tools, "node"),
      pageTools: toolList(value.pageTools, "page"),
    },
    problems: [],
  };
}

/** Every file the manifest declares, for the checker and the file rules. */
export function declaredFiles(pack) {
  const files = [];
  const seen = new Set();
  const addFile = (relative, kind) => {
    if (seen.has(relative)) return;
    seen.add(relative);
    files.push({ relative, limit: LIMITS[kind], kind });
  };
  for (const note of pack.notes) addFile(note, "note");
  for (const tool of pack.tools) addFile(tool.file, "tool");
  for (const tool of pack.pageTools) addFile(tool.file, "pageTool");
  return files;
}

const TARGET_EXPECTED =
  "Expected a complete http or https URL, a host such as github.com, or a Page.";

// The target as a URL: as it is written, else with https:// in front. Null
// when neither parses.
function parsedTarget(value) {
  for (const candidate of [value, `https://${value}`])
    try {
      return new URL(candidate);
    } catch {
      // The next form, or nothing.
    }
  return null;
}

/** A string URL, a bare host or anything with a string `url`. Throws KamapathyError invalid_argument. */
export function hostOf(target, { entry }) {
  const refuse = (value) =>
    new KamapathyError(
      "invalid_argument",
      `${entry} got ${shown(value)} for target. ${TARGET_EXPECTED}`,
      { entry },
    );
  let value;
  if (typeof target === "string") value = target;
  else if (target !== null && typeof target === "object") {
    // A page that has not navigated holds no URL, so it matches nothing.
    if (typeof target.url !== "string" || target.url === "")
      return { url: null, host: null };
    value = target.url;
  } else throw refuse(target);
  const url = parsedTarget(value);
  if (!url) throw refuse(value);
  // Only the web reaches a pack: about:blank and file: match nothing.
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return { url: url.href, host: null };
  return { url: url.href, host: url.hostname.replace(/\.$/, "") };
}

// How one domain entry fits a host: an exact entry, else the suffix of a
// wildcard the host sits strictly under.
function entryFit(entry, host) {
  if (!entry.startsWith("*."))
    return entry === host ? { wildcard: 0, length: host.length } : null;
  const suffix = entry.slice(2);
  return host.length > suffix.length && host.endsWith(`.${suffix}`)
    ? { wildcard: 1, length: suffix.length }
    : null;
}

// An exact entry beats a wildcard, and a longer wildcard suffix beats a
// shorter one.
const closer = (fit, than) =>
  fit.wildcard === than.wildcard
    ? fit.length > than.length
    : fit.wildcard < than.wildcard;
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The packs whose domains match, best entry first, each with the entry that matched. */
export function matchPacks(packs, host) {
  if (!host) return [];
  const matched = [];
  for (const pack of packs) {
    let best = null;
    for (const entry of pack.domains) {
      const fit = entryFit(entry, host);
      if (fit && (!best || closer(fit, best.fit))) best = { entry, fit };
    }
    if (best)
      matched.push({
        pack: { ...pack, matchedBy: best.entry },
        fit: best.fit,
      });
  }
  return matched
    .sort(
      (a, b) =>
        a.fit.wildcard - b.fit.wildcard ||
        b.fit.length - a.fit.length ||
        byText(a.pack.id, b.pack.id),
    )
    .map((row) => row.pack);
}

/** The pack as sitePacks and the CLI list it, Node tools before page tools. */
export function summarize(pack) {
  return {
    id: pack.id,
    name: pack.name,
    source: pack.source,
    dir: pack.dir,
    domains: [...pack.domains],
    notes: [...pack.notes],
    tools: [...pack.tools, ...pack.pageTools].map(
      ({ name, kind, description }) => ({ name, kind, description }),
    ),
  };
}

// The pack folders of one root by name, at most LIMITS.packs of them.
// Names starting with _ or . are ignored, as is anything that is neither a
// folder nor a link; a link is read so its refusal is reported.
async function packFolders(root) {
  const names = (await readdir(root.path, { withFileTypes: true }))
    .filter(
      (entry) =>
        !entry.name.startsWith("_") &&
        !entry.name.startsWith(".") &&
        (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map((entry) => entry.name)
    .sort();
  return {
    names: names.slice(0, LIMITS.packs),
    cut: names.length > LIMITS.packs,
  };
}

/** Every readable pack, workspace first, ids deduplicated with the workspace winning. */
export async function loadPacks(env = process.env, { roots } = {}) {
  const states = [];
  const packs = [];
  const skipped = [];
  const taken = new Set();
  const skip = (path, source, problem) => {
    if (skipped.length < LIMITS.skipped)
      skipped.push({ path, source, problem });
  };
  for (const root of roots ?? siteRoots(env)) {
    const state = await rootState(root);
    states.push(state);
    if (state.state === "refused") {
      skip(state.path, state.source, state.problem);
      continue;
    }
    if (state.state !== "ok") continue;
    let folders;
    try {
      folders = await packFolders(state);
    } catch (error) {
      skip(
        state.path,
        state.source,
        `${state.path} could not be read (${error?.code ?? "unknown"}).`,
      );
      continue;
    }
    if (folders.cut)
      skip(
        state.path,
        state.source,
        `${state.path} holds more than ${LIMITS.packs} pack folders. Only the first ${LIMITS.packs} by name are read.`,
      );
    for (const id of folders.names) {
      // A workspace folder hides the bundled pack with its id, so an edited
      // copy wins whether or not it passes its rules.
      if (taken.has(id)) continue;
      taken.add(id);
      const dir = join(state.path, id);
      const { pack, problems } = await readManifest(dir, {
        source: state.source,
        id,
      });
      if (pack) packs.push(pack);
      else skip(dir, state.source, problemText(problems[0]));
    }
  }
  return { packs, skipped, roots: states };
}

/** What Client.sitePacks and kamapathy sites print. */
export async function listSitePacks(env, target, options) {
  const matching = target !== undefined;
  // The target is read before the disk is, so a bad one lists nothing.
  const host = matching ? hostOf(target, { entry: "sitePacks" }).host : null;
  const { packs, skipped } = await loadPacks(env, options);
  if (!matching)
    return {
      packs: [...packs].sort((a, b) => byText(a.id, b.id)).map(summarize),
      skipped,
    };
  return { host, packs: matchPacks(packs, host).map(summarize), skipped };
}

// One note, read under the file rules and cleaned: control characters other
// than tab and newline, and bidirectional controls, are dropped.
async function noteText(pack, file) {
  const buffer = await readTrustedFile(
    { path: pack.dir, source: pack.source },
    file,
    { owner: pack.source === "workspace", kind: "note" },
  );
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new PackProblem(`${file} must be UTF-8 text.`, { file });
  }
  return cleanText(text, { newlines: true });
}

/** Each declared note, read and cleaned, in declaration order. Throws PackProblem. */
export async function readNotes(pack) {
  const notes = [];
  for (const file of pack.notes)
    notes.push({ file, text: await noteText(pack, file) });
  return notes;
}

// A required argument in an example: a string as "<name>", every other type
// as <name>.
const shownArg = (arg) =>
  arg.type === "string" ? `"<${arg.name}>"` : `<${arg.name}>`;

/** `await runSiteTool("github", "search_repositories", { query: "<query>" }, { page })`. */
export function exampleCall(pack, tool) {
  const required = tool.args.filter((arg) => arg.required);
  const args = required.length
    ? `{ ${required.map((arg) => `${arg.name}: ${shownArg(arg)}`).join(", ")} }`
    : "{}";
  const call = tool.kind === "page" ? "runPageTool" : "runSiteTool";
  return `await ${call}(${JSON.stringify(pack.id)}, ${JSON.stringify(tool.name)}, ${args}, { page })`;
}

/** The pack as siteContext gives it: the entry that matched, each note's text and each tool's arguments and example. */
export function contextOf(pack, notes) {
  return {
    id: pack.id,
    name: pack.name,
    source: pack.source,
    dir: pack.dir,
    domains: [...pack.domains],
    matchedBy: pack.matchedBy,
    notes,
    tools: [...pack.tools, ...pack.pageTools].map((tool) => ({
      name: tool.name,
      kind: tool.kind,
      description: tool.description,
      args: tool.args.map(({ name, type, required, description }) => ({
        name,
        type,
        required,
        description,
      })),
      returns: { ...tool.returns },
      example: exampleCall(pack, tool),
    })),
  };
}

/** What Client.siteContext and kamapathy sites <url> print. */
export async function siteContextFor(env, target, options) {
  const { url, host } = hostOf(target, { entry: "siteContext" });
  const { packs, skipped } = await loadPacks(env, options);
  const contexts = [];
  for (const pack of matchPacks(packs, host))
    try {
      contexts.push(contextOf(pack, await readNotes(pack)));
    } catch (error) {
      if (!(error instanceof PackProblem)) throw error;
      // A context holding half a pack's notes would mislead an agent, so the
      // whole pack is reported instead.
      if (skipped.length < LIMITS.skipped)
        skipped.push({
          path: pack.dir,
          source: pack.source,
          problem: problemText(error),
        });
    }
  return { url: url ?? "", host, packs: contexts, skipped };
}

const PACK_ID_EXPECTED =
  "Expected the name of a pack's folder: 1 to 48 lowercase letters, digits and hyphens.";
const TOOL_EXPECTED =
  "Expected a tool name of 1 to 48 lowercase letters, digits and underscores, starting with a letter.";
const KIND_WORDS = { node: "Node tool", page: "page tool" };
const KIND_CALLS = { node: "runSiteTool", page: "runPageTool" };
const ARTICLES = {
  string: "a string",
  number: "a number",
  integer: "an integer",
  boolean: "a boolean",
  array: "an array",
  object: "an object",
};

// A plain object, as a tool's arguments and its object values must be: an
// array, a class instance, a Map and null are something else.
const plainArgs = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

// A name the call itself got wrong, so nothing is read: no pack can hold it.
function checkName(value, { pattern, label, expected, entry }) {
  if (typeof value === "string" && pattern.test(value)) return value;
  throw new KamapathyError(
    "invalid_argument",
    `${entry} got ${shown(value)} for ${label}. ${expected}`,
    { entry },
  );
}

// Text from a pack or its code: one line, with nothing that can hide or
// reorder what it says.
const toolText = (value, limit) => cleanText(line(value)).slice(0, limit);
const sentence = (text) => (/[.!?]$/.test(text) ? text : `${text}.`);

// The pack, or a file it declares, breaks a rule: the first problem in the
// message and up to LIMITS.problems of them in the error.
function packInvalid(pack, problems) {
  const texts = problems.slice(0, LIMITS.problems).map(problemText);
  const more = problems.length - 1;
  return new KamapathyError(
    "site_pack_invalid",
    `The ${pack.id} pack breaks its rules: ${texts[0]}${
      more > 0 ? ` ${more} more problem${more === 1 ? "" : "s"}.` : ""
    }`,
    { packId: pack.id, dir: pack.dir, problems: texts },
  );
}

// Whether a root holds this pack's folder. A link counts, so its refusal is
// reported instead of the id reading as missing.
async function hasPackFolder(dir) {
  try {
    const metadata = await lstat(dir);
    return metadata.isDirectory() || metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

/** The pack with this id, the workspace's before the skill's. Throws site_pack_not_found or site_pack_invalid. */
export async function findPack(
  env,
  packId,
  { entry = "runSiteTool", roots } = {},
) {
  const id = checkName(packId, {
    pattern: PACK_ID,
    label: "packId",
    expected: PACK_ID_EXPECTED,
    entry,
  });
  const states = [];
  let found = null;
  for (const root of roots ?? siteRoots(env)) {
    const state = await rootState(root);
    states.push(state);
    if (found || state.state !== "ok") continue;
    // The first root holding the folder wins, whether or not the pack
    // passes its rules, so a workspace copy hides the one the skill ships.
    const dir = join(state.path, id);
    if (await hasPackFolder(dir)) found = { dir, source: state.source };
  }
  if (!found)
    throw new KamapathyError(
      "site_pack_not_found",
      `No site pack named ${JSON.stringify(id)} is in Kamapathy's workspace or the skill. Looked in ${states
        .map((state) => `${state.path} (${state.state})`)
        .join(" and ")}.`,
      { packId: id, roots: states },
    );
  const { pack, problems } = await readManifest(found.dir, {
    source: found.source,
    id,
  });
  if (!pack) throw packInvalid({ id, dir: resolve(found.dir) }, problems);
  return pack;
}

// The tool of this kind, or site_tool_not_found naming what the pack holds
// and the other map when the name sits there.
function toolNamed(pack, tool, kind) {
  const map = kind === "node" ? pack.tools : pack.pageTools;
  const found = map.find((item) => item.name === tool);
  if (found) return found;
  const other = (kind === "node" ? pack.pageTools : pack.tools).find(
    (item) => item.name === tool,
  );
  const available = map.map((item) => item.name);
  throw new KamapathyError(
    "site_tool_not_found",
    `The ${pack.id} pack has no ${KIND_WORDS[kind]} named ${tool}. Available: ${
      available.length ? available.join(", ") : "none"
    }.${
      other
        ? ` ${tool} is a ${KIND_WORDS[other.kind]}. Call ${KIND_CALLS[other.kind]}.`
        : ""
    }`,
    { packId: pack.id, tool, kind, available },
  );
}

// Whether one value fits a declared type: an integer is safe, a number is
// finite, an object is plain.
function valueFits(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    default:
      return plainArgs(value);
  }
}

// The shape the tool declares, as `{ query: string, limit?: integer }`.
function argsShape(tool) {
  const parts = tool.args.map(
    (arg) => `${arg.name}${arg.required ? "" : "?"}: ${arg.type}`,
  );
  return parts.length ? `{ ${parts.join(", ")} }` : "{}";
}

/** `args`, or none at all, against the tool's declaration. Throws invalid_tool_args. */
export function checkToolArgs(pack, tool, args) {
  const given = args === undefined ? {} : args;
  const problems = [];
  if (!plainArgs(given)) problems.push("arguments must be an object.");
  else {
    for (const [name, value] of Object.entries(given))
      if (value !== undefined && !tool.args.some((arg) => arg.name === name))
        problems.push(`${cleanText(name)} is not an argument of ${tool.name}.`);
    for (const arg of tool.args) {
      const value = given[arg.name];
      // An undefined value counts as absent; null fits no type.
      if (value === undefined) {
        if (arg.required) problems.push(`${arg.name} is required.`);
      } else if (!valueFits(value, arg.type))
        problems.push(`${arg.name} must be ${ARTICLES[arg.type]}.`);
    }
  }
  if (!problems.length) return given;
  throw new KamapathyError(
    "invalid_tool_args",
    `${tool.name} in the ${pack.id} pack got invalid arguments: ${problems[0]}`,
    { packId: pack.id, tool: tool.name, problems, expected: argsShape(tool) },
  );
}

/** The tool's own export, from a module keyed by the file's hash. Throws PackProblem. */
export async function importToolExport(pack, tool) {
  const buffer = await readTrustedFile(
    { path: pack.dir, source: pack.source },
    tool.file,
    { owner: pack.source === "workspace", kind: "tool" },
  );
  const hash = createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  // The hash in the query makes an edited file a module of its own and
  // leaves an unchanged one with the module Node already loaded.
  const url = `${pathToFileURL(join(pack.dir, tool.file)).href}?v=${hash}`;
  let module;
  try {
    module = await import(url);
  } catch (error) {
    throw new PackProblem(
      `could not be imported (${toolText(error?.message ?? error, 200)}).`,
      { file: tool.file },
    );
  }
  const exported = module[tool.export];
  if (exported === undefined)
    throw new PackProblem(`does not export ${tool.export}.`, {
      file: tool.file,
    });
  if (typeof exported !== "function")
    throw new PackProblem(`exports ${tool.export}, which is not a function.`, {
      file: tool.file,
    });
  return exported;
}

/** The first frame inside the pack, as "tools/search-repositories.mjs:31:9". */
export function toolFrame(stack, pack) {
  // Node names the module by the URL the import used; a loader that reports
  // the path instead is read too.
  const prefixes = [`${pathToFileURL(pack.dir).href}/`, `${pack.dir}${sep}`];
  for (const text of String(stack ?? "").split("\n"))
    for (const prefix of prefixes) {
      const at = text.indexOf(prefix);
      if (at < 0) continue;
      const rest = text.slice(at + prefix.length);
      const end = rest.search(/[\s)]/);
      const frame = (end < 0 ? rest : rest.slice(0, end)).replace(
        /\?v=[0-9a-f]+(?=:)/,
        "",
      );
      const found = /^(.+):(\d+):(\d+)$/.exec(frame);
      if (found)
        return `${found[1].split(sep).join("/")}:${found[2]}:${found[3]}`;
    }
  return undefined;
}

// The tool threw something of its own: its message, and the frame it threw
// from when the stack holds one inside the pack.
function toolFailed(pack, tool, error) {
  const cause = toolText(
    error instanceof Error ? error.message : String(error),
    300,
  );
  const at = toolFrame(error?.stack, pack);
  const failure = new KamapathyError(
    "site_tool_failed",
    `The ${pack.id} tool ${tool.name} failed: ${sentence(cause)}`,
    { packId: pack.id, tool: tool.name, ...(at ? { at } : {}) },
  );
  // KamapathyError keeps Error's own cause out of its fields, so the text
  // is set here.
  failure.cause = cause;
  return failure;
}

/** Finds the pack, checks the arguments, imports the export and calls it. */
export async function runToolIn(
  env,
  { packId, tool, args, page, client, entry = "runSiteTool", roots },
) {
  // Both names are checked before anything is read.
  const name = checkName(tool, {
    pattern: TOOL_NAME,
    label: "tool",
    expected: TOOL_EXPECTED,
    entry,
  });
  const pack = await findPack(env, packId, { entry, roots });
  const declared = toolNamed(pack, name, "node");
  const checked = checkToolArgs(pack, declared, args);
  let run;
  try {
    run = await importToolExport(pack, declared);
  } catch (error) {
    if (error instanceof PackProblem) throw packInvalid(pack, [error]);
    throw error;
  }
  const context = {
    page,
    kamapathy: client,
    pack: { id: pack.id, name: pack.name, dir: pack.dir, source: pack.source },
  };
  // A copy, so a tool cannot change the caller's own arguments.
  const copy = structuredClone(checked);
  try {
    return await run(context, copy);
  } catch (error) {
    // A KamapathyError is tagged in place, so the hard stop, retryable and
    // dispatched reach the run as the tool left them.
    if (error instanceof KamapathyError) {
      error.packId ??= pack.id;
      error.tool ??= declared.name;
      throw error;
    }
    throw toolFailed(pack, declared, error);
  }
}

/**
 * A page tool's source as the page function page.evaluate sends in its
 * route's function field, with the checked arguments as arg: never as an
 * expression, which would leave an async tool's promise unawaited. The
 * newline keeps a trailing line comment from swallowing the call. The
 * function only carries the text; it never runs here.
 */
export function pageToolFunction(source) {
  const tool = () => {};
  tool.toString = () => `${source}\n`;
  return tool;
}
