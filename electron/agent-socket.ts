import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";

// Agents reach Kamapathy through a local socket that only this account can open,
// so there is no token to copy. Each profile keeps its own rendezvous, which
// also keeps test profiles named by KAMAPATHY_USER_DATA away from the real one.
// The standalone client derives the same paths; keep the two in step.
export interface AgentPaths {
  directory: string;
  endpoint: string;
  off: string;
  launch: string;
}

export function agentPaths(userData: string): AgentPaths {
  const directory = join(userData, "agent");
  return {
    directory,
    endpoint: join(directory, "endpoint"),
    off: join(directory, "off"),
    launch: join(directory, "launch.json"),
  };
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid!())
    throw new Error(`${path} must be a directory owned by this account.`);
  if (metadata.mode & 0o077) chmodSync(path, 0o700);
}

function writePrivate(file: string, content: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  rmSync(temporary, { force: true });
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function prepareAgentDirectory(paths: AgentPaths): void {
  privateDirectory(paths.directory);
}

// A Unix socket path must fit sun_path: 104 bytes on macOS and 108 on Linux,
// including the terminating NUL. A profile path too long for that gets a new,
// unpredictable private temporary folder, which no other account can claim
// first. Windows pipe names are global, so each start uses a new random name.
export function chooseSocketPath(
  userData: string,
  platform: NodeJS.Platform = process.platform,
  temporaryBase = tmpdir(),
): string {
  if (platform === "win32")
    return `\\\\.\\pipe\\kamapathy-${randomBytes(16).toString("hex")}`;
  const limit = platform === "darwin" ? 103 : 107;
  const preferred = join(agentPaths(userData).directory, "kamapathy.sock");
  if (Buffer.byteLength(preferred) <= limit) return preferred;
  // An unusually long TMPDIR could not hold a socket either.
  const base =
    Buffer.byteLength(join(temporaryBase, "kamapathy-XXXXXX", "kamapathy.sock")) <= limit
      ? temporaryBase
      : "/tmp";
  const directory = mkdtempSync(join(base, "kamapathy-"));
  privateDirectory(directory);
  return join(directory, "kamapathy.sock");
}

// A fallback folder is one this code made: kamapathy-XXXXXX, owned by this
// account, and never the profile's agent folder.
function removeFallbackFolder(paths: AgentPaths, socketPath: string): void {
  if (process.platform === "win32") return;
  const directory = dirname(socketPath);
  if (
    directory === paths.directory ||
    !/^kamapathy-[A-Za-z0-9]{6}$/.test(basename(directory))
  )
    return;
  try {
    const metadata = lstatSync(directory);
    if (metadata.isDirectory() && metadata.uid === process.getuid!())
      rmSync(directory, { recursive: true, force: true });
  } catch {}
}

// Removes a fallback socket folder once its server has closed.
export function releaseSocket(paths: AgentPaths, socketPath: string): void {
  removeFallbackFolder(paths, socketPath);
}

// A crash leaves the last endpoint and any fallback folder behind.
export function clearStaleEndpoint(paths: AgentPaths): void {
  try {
    const { socket } = JSON.parse(readFileSync(paths.endpoint, "utf8"));
    if (typeof socket === "string") removeFallbackFolder(paths, socket);
  } catch {}
  withdrawEndpoint(paths);
}

export function removeStaleSocket(socketPath: string): void {
  if (process.platform === "win32" || !existsSync(socketPath)) return;
  if (!lstatSync(socketPath).isSocket())
    throw new Error(`${socketPath} exists and is not a socket.`);
  rmSync(socketPath, { force: true });
}

// The instance is a secret only this account can read. Kamapathy returns it on
// every response, so the client can refuse a server that merely took over a
// socket or pipe name Kamapathy used earlier.
export function publishEndpoint(
  paths: AgentPaths,
  socket: string,
  instance: string,
): void {
  writePrivate(paths.endpoint, JSON.stringify({ socket, instance }));
}

export function withdrawEndpoint(paths: AgentPaths): void {
  rmSync(paths.endpoint, { force: true });
}

// The client reads this marker to learn that the person turned agent access
// off, so it never starts Kamapathy against that choice.
export function setAgentAccess(paths: AgentPaths, enabled: boolean): void {
  if (enabled) rmSync(paths.off, { force: true });
  else if (!existsSync(paths.off)) writePrivate(paths.off, "");
}

// The stable launcher of a running AppImage or Windows portable build. Their
// environment variables leak into programs another AppImage or portable app
// starts, so each is trusted only when it describes this running executable.
function inside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return Boolean(path) && !path.startsWith("..") && !isAbsolute(path);
}

export function runningAppImage(options: {
  env: NodeJS.ProcessEnv;
  execPath: string;
  platform?: NodeJS.Platform;
}): string | undefined {
  const { env, execPath } = options;
  const platform = options.platform ?? process.platform;
  return platform === "linux" &&
    env.APPIMAGE &&
    env.APPDIR &&
    inside(execPath, env.APPDIR)
    ? env.APPIMAGE
    : undefined;
}

export function runningPortable(options: {
  env: NodeJS.ProcessEnv;
  execPath: string;
  platform?: NodeJS.Platform;
}): string | undefined {
  const { env, execPath } = options;
  const platform = options.platform ?? process.platform;
  return platform === "win32" &&
    env.PORTABLE_EXECUTABLE_FILE &&
    env.PORTABLE_EXECUTABLE_APP_FILENAME === win32.basename(execPath, ".exe")
    ? env.PORTABLE_EXECUTABLE_FILE
    : undefined;
}

// What an automatic start runs. The recorded program must still exist after
// Kamapathy quits: AppImage and the Windows portable build run from temporary
// copies, so their stable launchers are recorded instead. Only the app folder
// Electron actually loaded is replayed for a source checkout, never a launch's
// URLs, relative paths, or switches: launchers can rewrite argv.
export function launchCommand(options: {
  env: NodeJS.ProcessEnv;
  execPath: string;
  defaultApp: boolean;
  appPath: string;
  platform?: NodeJS.Platform;
}): { command: string; args: string[] } {
  return {
    command:
      runningAppImage(options) || runningPortable(options) || options.execPath,
    args: options.defaultApp ? [resolve(options.appPath)] : [],
  };
}

// Debugging switches are never replayed in any spelling Chromium accepts: an
// automatic start must not reopen a DevTools or inspector port.
export function writeLaunchInfo(
  paths: AgentPaths,
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): void {
  writePrivate(
    paths.launch,
    JSON.stringify({
      command,
      args: args.filter(
        (argument) =>
          !/^(remote-debugging|inspect)/.test(
            argument
              .replace(/^--?/, "")
              // Chromium accepts "/switch" only on Windows, where paths never start with "/".
              .replace(platform === "win32" ? /^\// : /^$/, "")
              .toLowerCase(),
          ),
      ),
    }),
  );
}
