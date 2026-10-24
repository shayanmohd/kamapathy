// Site packs: the two roots a pack can live in, the files a pack may hold and
// the rules its pack.json must pass. Reading a pack never runs its code.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { domainToASCII, fileURLToPath } from "node:url";
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
