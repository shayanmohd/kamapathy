// Finding, starting and talking to Kamapathy over its local socket. Node
// built-ins only.
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { KamapathyError } from "./errors.mjs";

// A discovery failure and why; discover turns it into not_connected.
const refused = (reason, message) =>
  Object.assign(new Error(message), { reason });

export const SANDBOX_HINT =
  "Kamapathy refused the connection (permission denied). If an agent sandbox runs this command, allow local sockets or run it outside the sandbox.";

// Mirrors electron/agent-socket.ts: each Kamapathy profile keeps its agent
// rendezvous in <userData>/agent, a folder only this account can open.
export function agentPaths(env = process.env, platform = process.platform) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const userData = env.KAMAPATHY_USER_DATA
    ? resolve(env.KAMAPATHY_USER_DATA)
    : platform === "darwin"
      ? join(home, "Library", "Application Support", "Kamapathy")
      : platform === "win32"
        ? join(env.APPDATA || join(home, "AppData", "Roaming"), "Kamapathy")
        : join(env.XDG_CONFIG_HOME || join(home, ".config"), "Kamapathy");
  const directory = join(userData, "agent");
  return {
    userData,
    directory,
    endpoint: join(directory, "endpoint"),
    off: join(directory, "off"),
    quit: join(directory, "quit"),
    launch: join(directory, "launch.json"),
  };
}

export async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function privateDirectory(directory) {
  if (process.platform === "win32") return;
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid() ||
    (metadata.mode & 0o077) !== 0
  )
    throw refused(
      "untrusted_files",
      "Kamapathy's agent folder must be a private directory owned by your account.",
    );
}

// Returns null when the file does not exist. Anything present must be a small,
// private regular file: a link or a file others can write is refused.
async function readPrivate(path, limit) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP")
      throw refused(
        "untrusted_files",
        `${basename(path)} in Kamapathy's agent folder must not be a link.`,
      );
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > limit)
      throw refused(
        "untrusted_files",
        `${basename(path)} in Kamapathy's agent folder is not a small regular file.`,
      );
    if (
      process.platform !== "win32" &&
      ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid())
    )
      throw refused(
        "untrusted_files",
        `${basename(path)} in Kamapathy's agent folder must belong to your account with mode 0600.`,
      );
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

// The socket's folder is checked separately: it must be private to this account.
export function checkSocket(value, paths, platform = process.platform) {
  const socket = String(value ?? "").trim();
  if (platform === "win32") {
    if (!/^\\\\\.\\pipe\\kamapathy-[a-f0-9]{32}$/.test(socket))
      throw refused(
        "untrusted_files",
        "Kamapathy's agent endpoint is not a Kamapathy pipe.",
      );
    return socket;
  }
  if (!isAbsolute(socket) || basename(socket) !== "kamapathy.sock")
    throw refused(
      "untrusted_files",
      "Kamapathy's agent endpoint must be a kamapathy.sock socket in a private folder.",
    );
  return socket;
}

export class IdentityError extends Error {}

// Kamapathy answers health outside its action queue with the instance it
// published. Anything else at the socket or pipe, or nothing answering in
// time, is treated as not running, and no command is sent to it. Returns
// the health body, or null.
async function answers(connection, timeoutMs = 5000) {
  try {
    const response = await socketFetch(connection)("/health", {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const health = await response.json().catch(() => null);
    return health && typeof health === "object" ? health : {};
  } catch (error) {
    if (error instanceof IdentityError) return null;
    if (["ENOENT", "ECONNREFUSED"].includes(error?.code)) return null;
    if (
      ["AbortError", "TimeoutError"].includes(error?.name) ||
      String(error?.code).startsWith("HPE_")
    )
      return null;
    // Something accepted the connection and then dropped it: Kamapathy at its
    // connection limit. Starting another Kamapathy would not help.
    if (["ECONNRESET", "EPIPE"].includes(error?.code))
      throw refused("busy", "Kamapathy is busy. Retry shortly.");
    if (["EACCES", "EPERM"].includes(error?.code))
      throw refused("permission_denied", SANDBOX_HINT);
    throw error;
  }
}

// Editors such as VS Code set ELECTRON_RUN_AS_NODE for their terminals. Kamapathy
// launched with it runs as plain Node and exits, so it is never passed on.
// AppImage and portable-app variables inherited from another application
// would make the started Kamapathy record that application as its launcher.
export function launchEnvironment(env) {
  const environment = { ...env };
  for (const name of [
    "ELECTRON_RUN_AS_NODE",
    "APPIMAGE",
    "APPDIR",
    "ARGV0",
    "OWD",
    "PORTABLE_EXECUTABLE_FILE",
    "PORTABLE_EXECUTABLE_DIR",
    "PORTABLE_EXECUTABLE_APP_FILENAME",
  ])
    delete environment[name];
  return environment;
}

function run(command, args, env, wait) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      detached: !wait,
      stdio: "ignore",
      env: launchEnvironment(env),
    });
    child.once("error", (error) =>
      reject(
        refused(
          error.code === "ENOENT"
            ? "not_installed"
            : ["EACCES", "EPERM"].includes(error.code)
              ? "permission_denied"
              : "not_running",
          `Could not start Kamapathy (${error.code || "failed"}). Open Kamapathy, then retry.`,
        ),
      ),
    );
    if (wait)
      child.once("exit", (code) =>
        code === 0
          ? resolvePromise()
          : reject(
              refused(
                "not_installed",
                "Kamapathy is not installed or could not open. Start Kamapathy, then retry.",
              ),
            ),
      );
    else
      child.once("spawn", () => {
        child.unref();
        resolvePromise();
      });
  });
}

// Every component of the program's real path must belong to root or this
// account and must not be writable by other accounts, so no one else could have
// placed the program there. Group write is accepted only for root's group,
// macOS's admin group (/Applications), and a Linux user's own group.
// Returns the resolved program path to run, or null. Running the resolved path
// means a link swapped after this check cannot redirect the start.
async function trustedProgram(path) {
  let resolved;
  try {
    resolved = await realpath(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (process.platform === "win32") return resolved;
  if (!(await lstat(resolved)).isFile()) return null;
  let current = resolved;
  for (;;) {
    const metadata = await lstat(current);
    const owner = metadata.uid === 0 || metadata.uid === process.getuid();
    const othersWrite =
      (metadata.mode & 0o002) !== 0 &&
      !(metadata.isDirectory() && (metadata.mode & 0o1000) !== 0);
    const groupWrite =
      (metadata.mode & 0o020) !== 0 &&
      metadata.gid !== 0 &&
      !(process.platform === "darwin" && metadata.gid === 80) &&
      !(process.platform === "linux" && metadata.gid === process.getgid());
    if (!owner || othersWrite || groupWrite) return null;
    const parent = dirname(current);
    if (parent === current) return resolved;
    current = parent;
  }
}

// The recorded start command, with its program resolved, or null when there is
// none or its program could have been replaced by another account.
export async function launchRecord(paths) {
  const saved = await readPrivate(paths.launch, 65536);
  if (saved === null) return null;
  let info;
  try {
    info = JSON.parse(saved);
  } catch {
    return null;
  }
  if (
    typeof info?.command !== "string" ||
    !isAbsolute(info.command) ||
    !Array.isArray(info.args) ||
    !info.args.every((argument) => typeof argument === "string")
  )
    return null;
  const command = await trustedProgram(info.command);
  return command ? { command, args: info.args } : null;
}

// Starts the Kamapathy that last ran with this profile, or the installed app.
export async function launchKamapathy(paths, env = process.env, options = {}) {
  const platform = options.platform || process.platform;
  const info = await launchRecord(paths);
  if (info) return run(info.command, info.args, env, false);
  // macOS opens the installed app through LaunchServices, which drops
  // KAMAPATHY_USER_DATA and would start the default profile instead.
  if (platform === "darwin" && env.KAMAPATHY_USER_DATA) {
    // A recorded program that still exists was refused by the ownership check.
    let untrusted = false;
    try {
      const command = JSON.parse(
        (await readPrivate(paths.launch, 65536)) ?? "{}",
      ).command;
      untrusted = typeof command === "string" && (await exists(command));
    } catch {}
    throw untrusted
      ? refused(
          "untrusted_files",
          "Kamapathy's recorded program is in a folder other accounts can change. Open Kamapathy with KAMAPATHY_USER_DATA set yourself, then retry.",
        )
      : refused(
          "not_running",
          "Kamapathy has not started with this profile yet. Start Kamapathy with KAMAPATHY_USER_DATA set to it once, then retry.",
        );
  }
  if (platform === "darwin")
    return run("/usr/bin/open", ["-b", "app.kamapathy.browser"], env, true);
  if (platform === "win32") {
    const home = env.USERPROFILE || homedir();
    const executable = join(
      env.LOCALAPPDATA || join(home, "AppData", "Local"),
      "Programs",
      "Kamapathy",
      "Kamapathy.exe",
    );
    if (!(await exists(executable)))
      throw refused(
        "not_installed",
        "Kamapathy is not installed. Start Kamapathy, then retry.",
      );
    return run(executable, [], env, false);
  }
  return run("kamapathy", [], env, false);
}

const OFF =
  "Agent access is turned off in Kamapathy. Turn it on in Settings, under Agents, then retry.";
const QUIT_MS = 600000;

// The person quit Kamapathy while an agent was working, within ten minutes.
async function quitRecently(paths) {
  const saved = await readPrivate(paths.quit, 4096);
  if (saved === null) return false;
  try {
    const { at } = JSON.parse(saved);
    return Number.isFinite(at) && Date.now() - at < QUIT_MS;
  } catch {
    return false;
  }
}

// Finds Kamapathy's socket for this profile, starting Kamapathy when agent
// access was left on and starting is allowed (by default unless
// KAMAPATHY_NO_LAUNCH is 1). There is no token: the socket is reachable only
// by this account, and Kamapathy proves it is the server that published the
// endpoint. Failures are not_connected errors that name their reason.
export async function discover(env = process.env, options = {}) {
  const paths = agentPaths(env);
  try {
    return await find(paths, env, options);
  } catch (error) {
    if (typeof error?.reason !== "string" || error instanceof KamapathyError)
      throw error;
    throw new KamapathyError("not_connected", error.message, {
      reason: error.reason,
    });
  }
}

async function find(paths, env, options) {
  const probe = async () => {
    if (!(await exists(paths.directory))) return null;
    await privateDirectory(paths.directory);
    const recorded = await readPrivate(paths.endpoint, 4096);
    if (recorded === null) return null;
    let endpoint;
    try {
      endpoint = JSON.parse(recorded);
    } catch {
      return null;
    }
    if (
      typeof endpoint?.instance !== "string" ||
      !/^[a-f0-9]{32}$/.test(endpoint.instance)
    )
      return null;
    const connection = {
      socket: checkSocket(endpoint.socket, paths),
      instance: endpoint.instance,
    };
    if (process.platform !== "win32") {
      try {
        await privateDirectory(dirname(connection.socket));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    }
    const health = await answers(connection, options.healthTimeoutMs);
    return health ? { ...connection, health } : null;
  };
  const found = await probe();
  if (found) return found;
  if (await exists(paths.off)) throw refused("access_off", OFF);
  if (await quitRecently(paths))
    throw refused(
      "quit_by_person",
      "The person quit Kamapathy while an agent was working. Ask them before starting it again.",
    );
  if (!(options.allowLaunch ?? env.KAMAPATHY_NO_LAUNCH !== "1"))
    throw refused(
      "not_running",
      "Kamapathy is not running. Start Kamapathy, then retry.",
    );
  await (options.launch || launchKamapathy)(paths, env);
  const timeout = options.timeoutMs ?? 30000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(options.intervalMs ?? 250);
    const socket = await probe();
    if (socket) return socket;
    if (await exists(paths.off)) throw refused("access_off", OFF);
  }
  throw refused(
    "start_timeout",
    `Kamapathy did not accept agents within ${Math.round(timeout / 1000)} seconds. Open Kamapathy and check Recent activity in Settings, then retry.`,
  );
}

// The connection discover finds, without its health body.
export async function resolveSocket(env = process.env, options = {}) {
  const { socket, instance } = await discover(env, options);
  return { socket, instance };
}

// fetch cannot reach a Unix socket or named pipe, so requests go through
// node:http and come back as a standard Response. Each call gets its own
// keep-alive connection, closed afterwards: nothing is reused across a Kamapathy
// restart, and Kamapathy can answer early without cutting off the request.
export function socketFetch(connection) {
  const { socket, instance } = connection;
  return (url, options = {}) =>
    new Promise((resolvePromise, reject) => {
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        agent.destroy();
        callback(value);
      };
      const target = new URL(url, "http://kamapathy.invalid");
      const body = options.body;
      const request = httpRequest(
        {
          socketPath: socket,
          path: `${target.pathname}${target.search}`,
          agent,
          method: options.method || "GET",
          headers: {
            Host: "kamapathy",
            ...options.headers,
            ...(body !== undefined
              ? { "Content-Length": Buffer.byteLength(body) }
              : {}),
          },
          signal: options.signal,
        },
        (response) => {
          if (
            instance &&
            response.headers["x-kamapathy-instance"] !== instance
          ) {
            response.resume();
            settle(
              reject,
              new IdentityError(
                "Another program answered at Kamapathy's socket. Restart Kamapathy, then retry.",
              ),
            );
            return;
          }
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.once("error", (error) => settle(reject, error));
          response.once("end", () => {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers))
              for (const item of [].concat(value ?? []))
                headers.append(name, item);
            const status = response.statusCode;
            settle(
              resolvePromise,
              new Response(
                [204, 304].includes(status) ? null : Buffer.concat(chunks),
                {
                  status,
                  headers,
                },
              ),
            );
          });
        },
      );
      request.once("error", (error) => settle(reject, error));
      request.end(body);
    });
}
