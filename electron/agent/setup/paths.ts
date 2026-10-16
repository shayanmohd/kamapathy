import {
  chmodSync,
  lstatSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, posix, win32 } from "node:path";

export type Runner = (
  file: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number },
) => Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}>;

// What agent setup reads from this computer. Tests pass temporary homes and
// a fake runner.
export interface SetupEnvironment {
  platform: NodeJS.Platform;
  home: string;
  accountHome: string;
  env: NodeJS.ProcessEnv;
  testProfile: boolean;
  bundledSkill: string | null;
  version: string;
  shell: string | null;
  run: Runner;
  now?: () => number;
}

export type SetupReason =
  "not_private" | "not_writable" | "busy" | "unsupported";

export class SetupError extends Error {
  constructor(
    readonly reason: SetupReason,
    message: string,
  ) {
    super(message);
    this.name = "SetupError";
  }
}

export interface ToolPaths {
  tools: string;
  skills: string;
  stable: string;
  bin: string;
  launcher: string;
  launcherCmd: string | null;
  localBin: string | null;
  commandLink: string | null;
  lock: string;
}

const LOCK_STALE_MS = 30000;

export function toolPaths(env: SetupEnvironment): ToolPaths {
  const windows = env.platform === "win32";
  const { join } = windows ? win32 : posix;
  const tools = windows
    ? join(
        env.env.LOCALAPPDATA || join(env.home, "AppData", "Local"),
        "Kamapathy",
        "tools",
      )
    : join(env.home, ".local", "share", "kamapathy");
  const bin = join(tools, "bin");
  const localBin = windows ? null : join(env.home, ".local", "bin");
  return {
    tools,
    skills: join(tools, "skills"),
    stable: join(tools, "skill"),
    bin,
    launcher: join(bin, "kamapathy"),
    launcherCmd: windows ? join(bin, "kamapathy.cmd") : null,
    localBin,
    commandLink: localBin && join(localBin, "kamapathy"),
    lock: join(tools, ".lock"),
  };
}

// A test profile must never change the real account's agents.
export function setupSupported(env: SetupEnvironment): boolean {
  if (!env.testProfile) return true;
  const windows = env.platform === "win32";
  const { resolve } = windows ? win32 : posix;
  const [home, account] = [env.home, env.accountHome].map((path) =>
    windows ? resolve(path).toLowerCase() : resolve(path),
  );
  return home !== account;
}

export const errorCode = (error: unknown) =>
  (error as NodeJS.ErrnoException | null)?.code;

// A permission failure becomes not_writable; other errors pass unchanged.
export function writeFailure(error: unknown, path: string): unknown {
  const code = errorCode(error);
  if (code !== "EACCES" && code !== "EPERM") return error;
  const failed = (error as NodeJS.ErrnoException).path ?? path;
  return new SetupError(
    "not_writable",
    `Kamapathy could not write to ${failed}.`,
  );
}

// Agents trust the skill as instructions, so T is a folder this account
// owns, never a link, and private to it.
export function ensureTools(env: SetupEnvironment, paths: ToolPaths): void {
  const { tools } = paths;
  const windows = env.platform === "win32";
  let metadata;
  try {
    mkdirSync(dirname(tools), { recursive: true });
    try {
      mkdirSync(tools, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    metadata = lstatSync(tools);
  } catch (error) {
    throw writeFailure(error, tools);
  }
  if (
    !metadata.isDirectory() ||
    (!windows && metadata.uid !== process.getuid?.())
  )
    throw new SetupError(
      "not_private",
      `Kamapathy's tools folder ${tools} must be a folder your account owns, not a link.`,
    );
  if (!windows && metadata.mode & 0o077) chmodSync(tools, 0o700);
}

// T/.lock keeps two Kamapathy processes from changing setup at once. A lock
// older than 30 seconds belongs to one that stopped and is taken once.
function takeLock(env: SetupEnvironment, paths: ToolPaths): void {
  const now = env.now ?? Date.now;
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(
        paths.lock,
        JSON.stringify({ pid: process.pid, at: now() }),
        { flag: "wx", mode: 0o600 },
      );
      return;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw writeFailure(error, paths.lock);
    }
    let age = Infinity;
    try {
      age = Math.abs(now() - statSync(paths.lock).mtimeMs);
    } catch {}
    if (attempt > 0 || age < LOCK_STALE_MS)
      throw new SetupError(
        "busy",
        "Another Kamapathy is changing agent setup. Try again in a moment.",
      );
    rmSync(paths.lock, { force: true });
  }
}

export async function withLock<T>(
  env: SetupEnvironment,
  paths: ToolPaths,
  fn: () => Promise<T>,
): Promise<T> {
  ensureTools(env, paths);
  takeLock(env, paths);
  try {
    return await fn();
  } finally {
    rmSync(paths.lock, { force: true });
  }
}
