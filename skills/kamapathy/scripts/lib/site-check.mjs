// The site pack validator: every rule a pack must pass, reported as lines a
// person can read. A Node tool's module is imported, which runs the file's
// own top level code; no tool is ever called and no page tool is ever run.
import { lstat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Script } from "node:vm";
import { line } from "./format.mjs";
import {
  PackProblem,
  cleanText,
  declaredFiles,
  importToolExport,
  loadPacks,
  readManifest,
  readTrustedFile,
} from "./sites.mjs";

/** @typedef {{ field?: string, file?: string, line?: number, message: string }} Problem */
/** @typedef {{ id: string, source: "workspace" | "bundled", dir: string, ok: boolean, problems: Problem[] }} Checked */

export const TEMPORARY_REF = /(?<![\w@.])@e\d+/g;
export const BIDI_CODES = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** After comments and whitespace, a page tool must start like a function expression. */
export const PAGE_TOOL_START =
  /^(?:function\b|async\b|\(|[A-Za-z_$][\w$]*\s*=>)/;

// A problem as the CLI prints it and --json holds it: a plain object, so
// nothing an Error carries travels with it.
const plain = (problem) => ({
  ...(problem.field ? { field: problem.field } : {}),
  ...(problem.file ? { file: problem.file } : {}),
  ...(problem.line ? { line: problem.line } : {}),
  message: problem.message,
});

const decode = (buffer) =>
  new TextDecoder("utf-8", { fatal: true }).decode(buffer);
// A message from a pack's own code: one line, with nothing that can hide or
// reorder what it says.
const shortText = (value, limit) => cleanText(line(value)).slice(0, limit);
const codePoint = (character) =>
  `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;

// What a page tool says after the comments it may open with.
function afterComments(source) {
  let rest = source;
  for (;;) {
    const start = rest.trimStart();
    if (start.startsWith("//")) {
      const end = start.indexOf("\n");
      rest = end < 0 ? "" : start.slice(end + 1);
      continue;
    }
    if (start.startsWith("/*")) {
      const end = start.indexOf("*/");
      rest = end < 0 ? "" : start.slice(end + 2);
      continue;
    }
    return start;
  }
}

// A temporary ref or a bidirectional control in a note or a tool file, with
// the line it sits on.
function textProblems(file, text, add) {
  for (const [index, row] of text.split(/\r?\n/).entries()) {
    const at = index + 1;
    for (const found of row.matchAll(TEMPORARY_REF))
      add({
        file,
        line: at,
        message: `holds the temporary ref ${found[0]}. Refs change with every snapshot; use a locator such as role=button[name="Save"].`,
      });
    for (const found of row.matchAll(BIDI_CODES))
      add({
        file,
        line: at,
        message: `holds a bidirectional control (${codePoint(found[0])}), which can hide what the text says.`,
      });
  }
}

// The line a compile failure sits on: a Script's stack opens with
// "<file>:<line>", and the wrapper below adds no line of its own.
function errorLine(error) {
  const first = String(error?.stack ?? "").split("\n")[0] ?? "";
  const found = /:(\d+)$/.exec(first);
  return found ? Number(found[1]) : undefined;
}

// One function expression that compiles the way runPageTool wraps it. The
// script is compiled and dropped, never run.
function pageToolProblems(file, source, add) {
  if (!PAGE_TOOL_START.test(afterComments(source))) {
    add({
      file,
      message:
        "must hold one function expression, such as (args) => document.title.",
    });
    return;
  }
  try {
    new Script(`(${source}\n)`, { filename: file });
  } catch (error) {
    add({
      file,
      line: errorLine(error),
      message: `does not compile (${shortText(error?.message ?? error, 200)}).`,
    });
  }
}

/**
 * Every problem this pack has, in rule order: the manifest, then each
 * declared file, then the Node tool imports and the page tool compiles.
 * @param {string} dir
 * @param {{ source?: "workspace" | "bundled", id?: string }} [options]
 * @returns {Promise<Checked>}
 */
export async function checkPack(dir, { source = "workspace", id } = {}) {
  const base = resolve(dir);
  const name = id ?? basename(base);
  /** @type {Problem[]} */
  const problems = [];
  const add = (problem) => problems.push(plain(problem));
  const { pack, problems: manifest } = await readManifest(base, {
    source,
    id: name,
  });
  // Without a manifest there is nothing to read, so its problems stand alone.
  if (!pack) {
    for (const problem of manifest) add(problem);
    return { id: name, source, dir: base, ok: false, problems };
  }
  const root = { path: base, source };
  const owner = source === "workspace";
  // The text of every file that could be read, so a file the rules already
  // refused is never imported or compiled.
  const texts = new Map();
  for (const { relative, kind } of declaredFiles(pack)) {
    let text;
    try {
      text = decode(await readTrustedFile(root, relative, { owner, kind }));
    } catch (error) {
      if (error instanceof PackProblem) add(error);
      else if (error instanceof TypeError)
        add({ file: relative, message: `${relative} must be UTF-8 text.` });
      else throw error;
      continue;
    }
    texts.set(relative, text);
    textProblems(relative, text, add);
  }
  for (const tool of pack.tools) {
    if (!texts.has(tool.file)) continue;
    try {
      await importToolExport(pack, tool);
    } catch (error) {
      if (!(error instanceof PackProblem)) throw error;
      add(error);
    }
  }
  for (const tool of pack.pageTools) {
    const text = texts.get(tool.file);
    if (text !== undefined) pageToolProblems(tool.file, text, add);
  }
  return { id: name, source, dir: base, ok: problems.length === 0, problems };
}

const ROOT_ORDER = { workspace: 0, bundled: 1 };
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// An argument naming a folder rather than a pack id, as the command says.
const isFolder = (target) =>
  target.includes("/") || target.includes("\\") || target.startsWith(".");

// Every pack folder the client would read, valid or not, in root and name
// order: loadPacks names the valid packs and reports the rest under skipped.
async function discover(env, roots) {
  const { packs, skipped, roots: states } = await loadPacks(env, { roots });
  const paths = new Set(states.map((state) => state.path));
  return [
    ...packs.map(({ id, dir, source }) => ({ id, dir, source })),
    // A root's own problem is reported under the root's path, which is no
    // pack of its own.
    ...skipped
      .filter((entry) => !paths.has(entry.path))
      .map((entry) => ({
        id: basename(entry.path),
        dir: entry.path,
        source: entry.source,
      })),
  ].sort(
    (a, b) => ROOT_ORDER[a.source] - ROOT_ORDER[b.source] || byText(a.id, b.id),
  );
}

// The pack a folder argument names. A folder inside a root is read as that
// root's pack; one outside both follows the workspace rules.
async function folderRow(target, found) {
  const dir = resolve(target);
  const row = found.find((item) => item.dir === dir);
  if (row) return row;
  try {
    const metadata = await lstat(dir);
    // A linked folder is checked too, so its refusal is what the person reads.
    if (!metadata.isDirectory() && !metadata.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  return { id: basename(dir), dir, source: "workspace" };
}

/**
 * Every pack in both roots, or only the ids and folders named.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ targets?: string[], roots?: { path: string, source: "workspace" | "bundled" }[] }} [options]
 * @returns {Promise<{ ok: boolean, packs: Checked[], missing: string[] }>}
 */
export async function checkAll(
  env = process.env,
  { targets = [], roots } = {},
) {
  const found = await discover(env, roots);
  /** @type {Checked[]} */
  const checked = [];
  /** @type {string[]} */
  const missing = [];
  if (!targets.length)
    for (const row of found) checked.push(await checkPack(row.dir, row));
  else
    for (const target of targets) {
      const row = isFolder(target)
        ? await folderRow(target, found)
        : found.find((item) => item.id === target);
      if (row) checked.push(await checkPack(row.dir, row));
      else missing.push(target);
    }
  return {
    ok: missing.length === 0 && checked.every((pack) => pack.ok),
    packs: checked,
    missing,
  };
}
