// The person's own functions: <workspace>/helpers.mjs, imported once per
// process after .env and the client globals, with each export of its own a
// global the script can call.
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { KamapathyError } from "./errors.mjs";
import { line } from "./format.mjs";
import {
  IDENTIFIER,
  LIMITS,
  cleanText,
  readTrustedFile,
  trustedPath,
} from "./sites.mjs";

/** A helper module is code like a Node tool, so it shares the tool's size. */
export const HELPER_LIMIT = LIMITS.tool;

const NAME = "helpers.mjs";
const CAUSE = 300;
const RENAME = "Rename it, or start the name with _ to keep it private.";

const failed = (message, fields) =>
  new KamapathyError("helpers_failed", message, fields);

// The file rules in the words the workspace uses for its .env.
const refused = (path) =>
  failed(
    `Kamapathy will not load ${path}: it must be a regular file of at most ${HELPER_LIMIT / 1024} KiB that your account owns and others cannot change.`,
    { path },
  );

// Whether there is anything at the path at all; a file the account cannot
// trust is there and refused below.
async function present(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

/**
 * Imports `<workspace>/helpers.mjs` when it exists and defines its exports
 * on `target`. Returns null when there is no such file.
 * @param {string | undefined} workspace
 * @param {object} target
 * @returns {Promise<{ path: string, names: string[] } | null>}
 * @throws {KamapathyError} `helpers_failed` with `path`, and `export` or
 * `cause` when there is one.
 */
export async function loadHelperModule(workspace, target) {
  if (!workspace) return null;
  const root = { path: resolve(workspace), source: "workspace" };
  const path = join(root.path, NAME);
  if (!(await present(path))) return null;
  let file;
  try {
    file = await trustedPath(root, NAME, { owner: true });
    await readTrustedFile(root, NAME, { owner: true, limit: HELPER_LIMIT });
  } catch {
    throw refused(path);
  }
  let module;
  try {
    module = await import(pathToFileURL(file).href);
  } catch (error) {
    const thrown = error instanceof Error ? error.message : String(error);
    const cause = cleanText(line(thrown)).slice(0, CAUSE) || String(error);
    const failure = failed(`Kamapathy could not load ${NAME}: ${cause}`, {
      path,
    });
    // KamapathyError keeps Error's own cause out of its fields, so the text
    // is set here.
    failure.cause = cause;
    throw failure;
  }
  // default is ignored even when it is a function, and a name starting with
  // _ stays the module's own.
  const names = Object.keys(module).filter(
    (name) => name !== "default" && !name.startsWith("_"),
  );
  // Every name answers before any of them is installed, so a file that
  // breaks a rule leaves no half of itself behind.
  for (const name of names) {
    if (!IDENTIFIER.test(name))
      throw failed(
        `Kamapathy could not load ${NAME}: it exports ${JSON.stringify(cleanText(name))}, which is not a name a script can use. ${RENAME}`,
        { path, export: name },
      );
    if (name in target)
      throw failed(
        `Kamapathy could not load ${NAME}: it exports ${name}, which is already a global. ${RENAME}`,
        { path, export: name },
      );
  }
  for (const name of names)
    Object.defineProperty(target, name, {
      value: module[name],
      writable: true,
      configurable: true,
      enumerable: false,
    });
  return { path: file, names };
}
