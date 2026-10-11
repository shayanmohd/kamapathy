// The scripting workspace: a private folder per profile. Its .env, and any
// --env-file, fill in variables for run and repl but never change one that
// was already set, and their values are never printed.
import { constants } from "node:fs";
import { mkdir, open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { agentPaths } from "./transport.mjs";

const PROTECTED = ["KAMAPATHY_USER_DATA", "KAMAPATHY_WORKSPACE"];

// KAMAPATHY_WORKSPACE resolved against the current folder, else the
// profile's own workspace.
export function workspacePath(env = process.env, cwd = process.cwd()) {
  return env.KAMAPATHY_WORKSPACE
    ? resolve(cwd, env.KAMAPATHY_WORKSPACE)
    : join(agentPaths(env).userData, "workspace");
}

// A missing workspace is fine. One that exists must be a folder this account
// owns that group and others cannot change; Windows skips the check.
export async function checkWorkspace(path) {
  if (process.platform === "win32") return;
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o022) !== 0
  )
    throw new Error(
      `Kamapathy's workspace ${path} must be a folder your account owns that others cannot change.`,
    );
}

// Creates the workspace with mode 0700 when it is missing.
export async function ensureWorkspace(path) {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await checkWorkspace(absolute);
  return absolute;
}

async function readEnvFile(path) {
  const refused = new Error(
    `Kamapathy will not load ${path}: it must be a regular file of at most 64 KiB that your account owns and others cannot change.`,
  );
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch {
    throw refused;
  }
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size > 65536 ||
      (process.platform !== "win32" &&
        (metadata.uid !== process.getuid() || (metadata.mode & 0o022) !== 0))
    )
      throw refused;
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

// Loads the files in order into env. Names in startNames never change, a
// later file overrides an earlier one, and the profile and workspace
// variables come only from the environment. Returns names, never values.
export async function loadEnvFiles(
  paths,
  env,
  startNames,
  { stderr = process.stderr } = {},
) {
  const applied = new Set();
  const skipped = new Set();
  for (const path of paths)
    for (const [name, value] of Object.entries(
      parseEnv(await readEnvFile(path)),
    )) {
      if (PROTECTED.includes(name)) {
        stderr.write(
          `Kamapathy: ${path} cannot set ${name}. Set it in the environment instead.\n`,
        );
        skipped.add(name);
      } else if (startNames.has(name)) skipped.add(name);
      else {
        env[name] = value;
        applied.add(name);
      }
    }
  return { applied: [...applied], skipped: [...skipped] };
}

// What run and repl do first: check the workspace, name it in
// KAMAPATHY_WORKSPACE, then load its .env and each --env-file in order.
export async function prepareWorkspace(env, envFiles, { stderr } = {}) {
  const workspace = workspacePath(env);
  await checkWorkspace(workspace);
  const startNames = new Set(Object.keys(env));
  env.KAMAPATHY_WORKSPACE = workspace;
  const dotEnv = join(workspace, ".env");
  let present = true;
  try {
    await stat(dotEnv);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    present = false;
  }
  return loadEnvFiles(
    [...(present ? [dotEnv] : []), ...envFiles],
    env,
    startNames,
    { stderr },
  );
}
