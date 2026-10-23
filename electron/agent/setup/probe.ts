import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Runner, SetupEnvironment } from "./paths";

export interface ProbeResult {
  path: string[];
  kamapathy: string | null;
  node: string | null;
}

const PROBE_TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 65536;
const PATH_MARKER = "__KAMAPATHY_PATH__";
const COMMAND_MARKER = "__KAMAPATHY_COMMAND__";
const NODE_MARKER = "__KAMAPATHY_NODE__";
const FORMAT = `'\\n${PATH_MARKER}%s\\n${COMMAND_MARKER}%s\\n${NODE_MARKER}%s\\n'`;
const SH_PROBE = `printf ${FORMAT} "$PATH" "$(command -v kamapathy 2>/dev/null)" "$(node -p process.versions.node 2>/dev/null)"`;
// fish drops an empty command substitution, so quoted variables keep three
// arguments.
const FISH_PROBE = `set -l p (string join : $PATH); set -l k (command -s kamapathy); set -l n (node -p process.versions.node 2>/dev/null); printf ${FORMAT} "$p" "$k" "$n"`;
const NODE_VERSION = /^\d+\.\d+\.\d+/;

const knownVersion = (value: string) =>
  NODE_VERSION.test(value) ? value : null;

// Startup files may print anything, so only the marker lines count; the
// last of each wins.
function readMarkers(stdout: string): ProbeResult | null {
  const values = new Map<string, string>();
  for (const line of stdout.split("\n"))
    for (const marker of [PATH_MARKER, COMMAND_MARKER, NODE_MARKER])
      if (line.startsWith(marker))
        values.set(marker, line.slice(marker.length).replace(/\r$/, ""));
  if (values.size < 3) return null;
  return {
    path: values.get(PATH_MARKER)!.split(":").filter(Boolean),
    kamapathy: values.get(COMMAND_MARKER) || null,
    node: knownVersion(values.get(NODE_MARKER)!),
  };
}

const definedValues = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );

// The person's login shell, as a new terminal window would start it. Null
// when it fails, times out or prints no markers.
export async function probeShell(
  env: SetupEnvironment,
): Promise<ProbeResult | null> {
  if (env.platform === "win32") {
    const result = await env
      .run("cmd.exe", ["/d", "/c", "node", "-p", "process.versions.node"], {
        env: definedValues(env.env),
        timeoutMs: PROBE_TIMEOUT_MS,
      })
      .catch(() => null);
    if (!result || result.timedOut) return null;
    return {
      path: [],
      kamapathy: null,
      node: result.code === 0 ? knownVersion(result.stdout.trim()) : null,
    };
  }
  const shell = env.shell ?? "/bin/sh";
  const name = basename(shell);
  const shellEnv: Record<string, string> = { HOME: env.home };
  for (const variable of ["USER", "LOGNAME"]) {
    const value = env.env[variable];
    if (value) shellEnv[variable] = value;
  }
  shellEnv.SHELL = shell;
  shellEnv.TERM = "dumb";
  const result = await env
    .run(
      shell,
      [
        name === "zsh" || name === "bash" ? "-ilc" : "-lc",
        name === "fish" ? FISH_PROBE : SH_PROBE,
      ],
      { env: shellEnv, timeoutMs: PROBE_TIMEOUT_MS },
    )
    .catch(() => null);
  if (!result || result.timedOut) return null;
  return readMarkers(result.stdout);
}

export function nodeStatus(version: string | null): {
  found: boolean;
  version: string | null;
  warning?: "node_missing" | "node_too_old";
} {
  if (version === null)
    return { found: false, version: null, warning: "node_missing" };
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13)
    ? { found: true, version }
    : { found: true, version, warning: "node_too_old" };
}

// Runs a file without a shell. stdin is empty, and on POSIX the command gets
// its own session, so an interactive shell cannot take the terminal and a
// timeout stops everything it started.
export const execRunner: Runner = (file, args, { env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const group = process.platform !== "win32";
    const child = spawn(file, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: group,
    });
    const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    const text = (name: "stdout" | "stderr") =>
      Buffer.concat(output[name]).toString("utf8");
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      finish();
    };
    const stop = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      stop();
      settle(() =>
        resolve({
          code: null,
          stdout: text("stdout"),
          stderr: text("stderr"),
          timedOut: true,
        }),
      );
    }, timeoutMs);
    for (const name of ["stdout", "stderr"] as const)
      child[name].on("data", (chunk: Buffer) => {
        sizes[name] += chunk.length;
        if (sizes[name] <= OUTPUT_LIMIT) output[name].push(chunk);
        else {
          stop();
          settle(() =>
            reject(
              new Error(`${file} printed more than ${OUTPUT_LIMIT} bytes.`),
            ),
          );
        }
      });
    child.on("error", (error) => {
      stop();
      settle(() => reject(error));
    });
    child.on("close", (code) =>
      settle(() =>
        resolve({
          code,
          stdout: text("stdout"),
          stderr: text("stderr"),
          timedOut: false,
        }),
      ),
    );
  });
