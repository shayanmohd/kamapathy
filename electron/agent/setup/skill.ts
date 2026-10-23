import { createHash, randomBytes } from "node:crypto";
import { lstatSync, renameSync, rmdirSync, rmSync, symlinkSync } from "node:fs";
import { cp, lstat, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { linkTarget, samePath } from "./links";
import {
  ensureTools,
  errorCode,
  type SetupEnvironment,
  type ToolPaths,
} from "./paths";

export interface SkillCopy {
  folder: string;
  digest: string;
  swapped: boolean;
  previous: string | null;
}

const hex = () => randomBytes(4).toString("hex");

const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// 12 hex digits of SHA-256 over every file's relative path, size and bytes,
// in sorted path order. A link or other special file is an error.
export async function skillDigest(folder: string): Promise<string> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(folder, relative), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
      else
        throw new Error(
          `${join(folder, path)} is not a regular file or folder.`,
        );
    }
  };
  await walk("");
  const hash = createHash("sha256");
  for (const path of files.sort()) {
    const bytes = await readFile(join(folder, path));
    hash.update(path);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return hash.digest("hex").slice(0, 12);
}

// The copy folder S points at.
export function stableTarget(paths: ToolPaths): string | null {
  try {
    return linkTarget(paths.stable);
  } catch {
    return null;
  }
}

// A copy is staged and checked before it gets its name, so a named copy is
// always whole.
async function copySkill(
  source: string,
  paths: ToolPaths,
  name: string,
  digest: string,
): Promise<void> {
  const staging = join(paths.skills, `.staging-${hex()}`);
  try {
    await cp(source, join(staging, "kamapathy"), {
      recursive: true,
      errorOnExist: true,
      force: false,
      dereference: false,
    });
    if ((await skillDigest(join(staging, "kamapathy"))) !== digest)
      throw new Error("The bundled skill changed while Kamapathy copied it.");
    await rename(staging, join(paths.skills, name));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

// POSIX renames a new relative link over S, so S always points at a whole
// copy. Windows replaces the junction.
function pointStable(env: SetupEnvironment, paths: ToolPaths, name: string) {
  if (env.platform === "win32") {
    try {
      rmdirSync(paths.stable);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    symlinkSync(
      join(paths.skills, name, "kamapathy"),
      paths.stable,
      "junction",
    );
    return;
  }
  const link = join(paths.tools, `.skill-${hex()}`);
  symlinkSync(`skills/${name}/kamapathy`, link);
  try {
    renameSync(link, paths.stable);
  } catch (error) {
    rmSync(link, { force: true });
    throw error;
  }
}

// Keeps the current and previous copies, and never removes a link.
async function prune(
  env: SetupEnvironment,
  paths: ToolPaths,
  keep: (string | null)[],
): Promise<void> {
  for (const name of await readdir(paths.skills)) {
    const path = join(paths.skills, name);
    if (
      keep.some(
        (folder) =>
          folder !== null && samePath(dirname(folder), path, env.platform),
      )
    )
      continue;
    if ((await lstat(path)).isDirectory())
      await rm(path, { recursive: true, force: true });
  }
}

export async function refreshSkill(
  env: SetupEnvironment,
  paths: ToolPaths,
  options: { create: boolean },
): Promise<SkillCopy | null> {
  if (!env.bundledSkill || (!options.create && !exists(paths.stable)))
    return null;
  ensureTools(env, paths);
  const digest = await skillDigest(env.bundledSkill);
  const name = `${env.version}-${digest}`;
  const folder = join(paths.skills, name, "kamapathy");
  if (!exists(folder)) await copySkill(env.bundledSkill, paths, name, digest);
  const previous = stableTarget(paths);
  if (previous !== null && samePath(previous, folder, env.platform))
    return { folder, digest, swapped: false, previous: null };
  pointStable(env, paths, name);
  await prune(env, paths, [folder, previous]);
  return { folder, digest, swapped: true, previous };
}
