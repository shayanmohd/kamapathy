import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { linkTarget } from "./links";
import {
  ensureTools,
  errorCode,
  SetupError,
  writeFailure,
  type SetupEnvironment,
  type ToolPaths,
} from "./paths";
import type { ProbeResult } from "./probe";

const HEADER =
  "kamapathy command, launcher 1. Written by Kamapathy; Settings > Agents removes it.";
const NODE_MESSAGE =
  "Kamapathy: the kamapathy command needs Node.js 22.13 or later from https://nodejs.org.";

// Help names the program kamapathy when KAMAPATHY_PROGRAM is set.
const shLauncher = (skill: string) =>
  [
    "#!/bin/sh",
    `# ${HEADER}`,
    `skill=${skill}`,
    `command -v node >/dev/null 2>&1 || { echo "${NODE_MESSAGE}" >&2; exit 127; }`,
    "KAMAPATHY_PROGRAM=kamapathy",
    "export KAMAPATHY_PROGRAM",
    'exec node "$skill/scripts/kamapathy.mjs" "$@"',
    "",
  ].join("\n");

export const posixLauncher = (stable: string) =>
  shLauncher(`'${stable.replaceAll("'", "'\\''")}'`);

export const gitBashLauncher = () => shLauncher('"$(dirname "$0")/../skill"');

export const cmdLauncher = () =>
  [
    "@echo off",
    `rem ${HEADER}`,
    "setlocal",
    `where node >nul 2>nul || (echo ${NODE_MESSAGE} 1>&2 & exit /b 127)`,
    'set "KAMAPATHY_PROGRAM=kamapathy"',
    'node "%~dp0..\\skill\\scripts\\kamapathy.mjs" %*',
    "",
  ].join("\r\n");

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
};

// With create false only launchers that exist and differ are rewritten, so
// a refresh never brings back a command the person removed.
export function writeLaunchers(
  env: SetupEnvironment,
  paths: ToolPaths,
  options: { create: boolean },
): boolean {
  const launchers: [string, string][] = paths.launcherCmd
    ? [
        [paths.launcher, gitBashLauncher()],
        [paths.launcherCmd, cmdLauncher()],
      ]
    : [[paths.launcher, posixLauncher(paths.stable)]];
  let written = false;
  for (const [file, text] of launchers) {
    const current = readText(file);
    if (current === text || (current === null && !options.create)) continue;
    ensureTools(env, paths);
    mkdirSync(paths.bin, { recursive: true });
    const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, text, { mode: 0o755 });
      chmodSync(temporary, 0o755);
      renameSync(temporary, file);
    } finally {
      rmSync(temporary, { force: true });
    }
    written = true;
  }
  return written;
}

export function removeLaunchers(paths: ToolPaths): void {
  for (const file of [paths.launcher, paths.launcherCmd])
    if (file) rmSync(file, { force: true });
}

export type CommandLinkState = "ours" | "absent" | "taken";

export function commandLinkState(paths: ToolPaths): CommandLinkState {
  if (!paths.commandLink) return "absent";
  let target;
  try {
    target = linkTarget(paths.commandLink);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "absent";
    throw error;
  }
  return target === resolve(paths.launcher) ? "ours" : "taken";
}

export function addCommandLink(paths: ToolPaths): CommandLinkState {
  const state = commandLinkState(paths);
  if (state !== "absent" || !paths.localBin || !paths.commandLink) return state;
  try {
    mkdirSync(paths.localBin, { recursive: true, mode: 0o755 });
    symlinkSync(paths.launcher, paths.commandLink);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return commandLinkState(paths);
    throw writeFailure(error, paths.commandLink);
  }
  return "ours";
}

export function removeCommandLink(paths: ToolPaths): void {
  if (paths.commandLink && commandLinkState(paths) === "ours")
    unlinkSync(paths.commandLink);
}

export interface ProfileTarget {
  path: string;
  kind: "sh" | "fish";
}

// A login bash reads the first of these that exists, so a new
// ~/.bash_profile would hide ~/.bash_login or ~/.profile.
function bashLoginFile(home: string): string {
  const files = [".bash_profile", ".bash_login", ".profile"].map((name) =>
    join(home, name),
  );
  return files.find((file) => existsSync(file)) ?? files[0];
}

export function profileFile(env: SetupEnvironment): ProfileTarget | null {
  if (env.platform === "win32" || !env.shell) return null;
  switch (basename(env.shell)) {
    case "zsh":
      return { path: join(env.env.ZDOTDIR || env.home, ".zshrc"), kind: "sh" };
    case "bash":
      return {
        path:
          env.platform === "darwin"
            ? bashLoginFile(env.home)
            : join(env.home, ".bashrc"),
        kind: "sh",
      };
    case "fish":
      return {
        path: join(env.home, ".config", "fish", "conf.d", "kamapathy.fish"),
        kind: "fish",
      };
    default:
      return null;
  }
}

const MARKER = "# Added by Kamapathy for the kamapathy command";
export const SH_PATH_BLOCK = `${MARKER}\nexport PATH="$HOME/.local/bin:$PATH"\n# End of Kamapathy lines\n`;
export const FISH_PATH_BLOCK = `${MARKER}\nset -gx PATH $HOME/.local/bin $PATH\n# End of Kamapathy lines\n`;

const blockFor = (target: ProfileTarget) =>
  target.kind === "fish" ? FISH_PATH_BLOCK : SH_PATH_BLOCK;
// The block counts only from the start of a line.
const holdsBlock = (text: string, block: string) =>
  `\n${text}`.includes(`\n${block}`);

export function pathBlockState(
  target: ProfileTarget,
): "present" | "absent" | "changed" {
  const text = readText(target.path);
  if (text === null) return "absent";
  if (holdsBlock(text, blockFor(target))) return "present";
  return text.includes(MARKER) ? "changed" : "absent";
}

// Appending keeps a linked dotfile a link.
export function addPathBlock(target: ProfileTarget): void {
  const block = blockFor(target);
  try {
    const text = readText(target.path) ?? "";
    if (holdsBlock(text, block)) return;
    mkdirSync(dirname(target.path), { recursive: true });
    appendFileSync(
      target.path,
      text && !text.endsWith("\n") ? `\n${block}` : block,
      { mode: 0o644 },
    );
  } catch (error) {
    throw writeFailure(error, target.path);
  }
}

// Removes only Kamapathy's exact block and keeps every other line. The
// fish file is Kamapathy's own, so it goes when it holds only the block.
export function removePathBlock(
  target: ProfileTarget,
): "removed" | "absent" | "profile_changed" {
  const state = pathBlockState(target);
  if (state === "changed") return "profile_changed";
  if (state === "absent") return "absent";
  const block = blockFor(target);
  const text = readText(target.path) ?? "";
  try {
    if (target.kind === "fish" && text === block) unlinkSync(target.path);
    else
      writeFileSync(
        target.path,
        `\n${text}`.split(`\n${block}`).join("\n").slice(1),
      );
  } catch (error) {
    throw writeFailure(error, target.path);
  }
  return "removed";
}

const withoutSlash = (path: string) => path.replace(/\/+$/, "");

export function onPathFrom(
  probe: ProbeResult | null,
  profileText: string | null,
  localBin: string,
): boolean | null {
  const mentioned = profileText?.includes(".local/bin") ?? false;
  if (!probe) return mentioned ? true : null;
  return (
    mentioned ||
    probe.path.some((entry) => withoutSlash(entry) === withoutSlash(localBin))
  );
}

// Reads HKCU\Environment Path unexpanded, keeps its value kind and every
// other entry, and compares entries ignoring case and a trailing backslash.
export const WINDOWS_PATH_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$name = 'Environment'
if ($env:KAMAPATHY_PATH_KEY) { $name = $env:KAMAPATHY_PATH_KEY }
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($name, $true)
if ($null -eq $key) { throw "HKCU\$name could not be opened." }
$bin = $env:KAMAPATHY_BIN
$action = $env:KAMAPATHY_PATH_ACTION
$value = $key.GetValue('Path', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
$kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
if ($null -eq $value) { $value = '' } else { $kind = $key.GetValueKind('Path') }
$entries = @($value -split ';')
$others = @($entries | Where-Object { -not [string]::Equals($_.TrimEnd('\'), $bin.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase) })
$present = $others.Count -lt $entries.Count
$next = $null
if ($action -eq 'add' -and -not $present) {
  if ($value -eq '') { $next = $bin } elseif ($value.EndsWith(';')) { $next = $value + $bin } else { $next = $value + ';' + $bin }
  $result = 'added'
} elseif ($action -eq 'remove' -and $present) {
  $next = $others -join ';'
  $result = 'removed'
} elseif ($action -eq 'add' -or $action -eq 'remove' -or $action -eq 'query') {
  if ($present) { $result = 'present' } else { $result = 'absent' }
} else {
  throw "Unknown action $action."
}
if ($null -ne $next) {
  if ($next -eq '') { $key.DeleteValue('Path', $false) } else { $key.SetValue('Path', $next, $kind) }
  if (-not $env:KAMAPATHY_PATH_KEY) {
    Add-Type -Namespace KamapathySetup -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
    $ignored = [UIntPtr]::Zero
    [void][KamapathySetup.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$ignored)
  }
}
$key.Close()
$result
`;

const PATH_ANSWERS = ["present", "absent", "added", "removed"] as const;

// options.key is a throwaway HKCU subkey for tests; only the real
// Environment key announces the change to other programs.
export async function windowsPath(
  env: SetupEnvironment,
  bin: string,
  action: "add" | "remove" | "query",
  options: { key?: string } = {},
): Promise<"present" | "absent" | "added" | "removed"> {
  const systemRoot = env.env.SystemRoot || "C:\\Windows";
  const scriptEnv: Record<string, string> = { SystemRoot: systemRoot };
  // Add-Type compiles in the temporary folder.
  for (const name of ["TEMP", "TMP"]) {
    const value = env.env[name];
    if (value) scriptEnv[name] = value;
  }
  scriptEnv.KAMAPATHY_BIN = bin;
  scriptEnv.KAMAPATHY_PATH_ACTION = action;
  if (options.key) scriptEnv.KAMAPATHY_PATH_KEY = options.key;
  const result = await env
    .run(
      win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(WINDOWS_PATH_SCRIPT, "utf16le").toString("base64"),
      ],
      { env: scriptEnv, timeoutMs: 30000 },
    )
    .catch(() => null);
  const answer =
    result?.code === 0 ? result.stdout.trim().split(/\s+/).pop() : undefined;
  const known = PATH_ANSWERS.find((value) => value === answer);
  if (!known)
    throw new SetupError(
      "not_writable",
      `Kamapathy could not write to HKCU\\${options.key ?? "Environment"}.`,
    );
  return known;
}
