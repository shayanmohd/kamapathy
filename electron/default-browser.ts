import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { promisify } from "node:util";
import { app, shell } from "electron";
import type { DefaultBrowserStatus } from "../shared/types";
import { launchCommand } from "./agent-socket";
import { handlerName } from "./import";

export const LINUX_DESKTOP_FILE = "app.kamapathy.browser.desktop";
export const WINDOWS_URL_PROG_ID = "KamapathyURL";
const COMMAND_TIMEOUT_MS = 5000;
// build/installer.nsh writes this command for the installed executable.
const START_MENU_COMMAND =
  "HKCU\\Software\\Clients\\StartMenuInternet\\Kamapathy\\shell\\open\\command";
const USER_CHOICE =
  "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";

// Tests point the module at stubs, as ImportEnv does for the import.
export interface DefaultBrowserEnv {
  platform: NodeJS.Platform;
  defaultApp: boolean;
  execPath: string;
  env: NodeJS.ProcessEnv;
  home: string;
  isDefaultProtocolClient(protocol: "http" | "https"): boolean;
  setAsDefaultProtocolClient(protocol: "http" | "https"): boolean;
  openExternal(url: string): Promise<void>;
  /** Runs a command; rejects on failure, a non-zero exit or the timeout. */
  run(
    command: string,
    args: string[],
    options?: { timeoutMs?: number },
  ): Promise<string>;
  exists(path: string): boolean;
}

const runFile = promisify(execFile);

export function electronDefaultBrowserEnv(): DefaultBrowserEnv {
  return {
    platform: process.platform,
    defaultApp: process.defaultApp === true,
    execPath: process.execPath,
    env: process.env,
    home: homedir(),
    isDefaultProtocolClient: (protocol) =>
      app.isDefaultProtocolClient(protocol),
    setAsDefaultProtocolClient: (protocol) =>
      app.setAsDefaultProtocolClient(protocol),
    openExternal: (url) => shell.openExternal(url),
    run: async (command, args, options) =>
      (
        await runFile(command, args, {
          encoding: "utf8",
          timeout: options?.timeoutMs,
          windowsHide: true,
        })
      ).stdout,
    exists: existsSync,
  };
}

type Reason = Extract<DefaultBrowserStatus, { state: "unavailable" }>["reason"];
const unavailable = (reason: Reason): DefaultBrowserStatus => ({
  state: "unavailable",
  reason,
});
const chosen = (isDefault: boolean): DefaultBrowserStatus => ({
  state: isDefault ? "default" : "available",
});

// A status query's output, or nothing when it fails.
function query(
  env: DefaultBrowserEnv,
  command: string,
  args: string[],
): Promise<string | undefined> {
  return env
    .run(command, args, { timeoutMs: COMMAND_TIMEOUT_MS })
    .catch(() => undefined);
}

// reg prints "    (Default)    REG_SZ    <command>", with the name translated
// on other languages. The executable is the quoted path, or the first word.
function commandExecutable(output: string): string | undefined {
  const command = /[ \t]REG_SZ[ \t]+(.*)/.exec(output)?.[1].trim();
  if (!command) return undefined;
  if (!command.startsWith('"')) return command.split(" ")[0];
  const end = command.indexOf('"', 1);
  return end > 1 ? command.slice(1, end) : undefined;
}

async function windowsStatus(
  env: DefaultBrowserEnv,
): Promise<DefaultBrowserStatus> {
  // The portable build runs from a temporary copy that is gone once it quits.
  const launch = launchCommand({
    env: env.env,
    execPath: env.execPath,
    defaultApp: false,
    appPath: "",
    platform: "win32",
  });
  if (launch.command !== env.execPath) return unavailable("portable");
  const registered = commandExecutable(
    (await query(env, "reg", ["query", START_MENU_COMMAND, "/ve"])) ?? "",
  );
  if (
    !registered ||
    win32.resolve(registered).toLowerCase() !==
      win32.resolve(env.execPath).toLowerCase()
  )
    return unavailable("not-installed");
  // handlerName reads the https UserChoice as the import list does; the
  // query itself runs here so the main process never waits on reg.
  const choice =
    (await query(env, "reg", ["query", USER_CHOICE, "/v", "ProgId"])) ?? "";
  const progId = handlerName({
    platform: "win32",
    home: env.home,
    exec: () => choice,
  });
  return chosen(progId?.toLowerCase() === WINDOWS_URL_PROG_ID.toLowerCase());
}

async function linuxStatus(
  env: DefaultBrowserEnv,
): Promise<DefaultBrowserStatus> {
  const directories = [
    env.env.XDG_DATA_HOME || posix.join(env.home, ".local/share"),
    ...(env.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
  ];
  // An AppImage nothing integrated has no desktop file to name.
  if (
    !directories.some(
      (directory) =>
        directory &&
        env.exists(posix.join(directory, "applications", LINUX_DESKTOP_FILE)),
    )
  )
    return unavailable("not-installed");
  const current = await query(env, "xdg-settings", [
    "get",
    "default-web-browser",
  ]);
  return chosen(current?.trim() === LINUX_DESKTOP_FILE);
}

export async function defaultBrowserStatus(
  env: DefaultBrowserEnv,
): Promise<DefaultBrowserStatus> {
  // Registering a development run would name the Electron binary.
  if (env.defaultApp) return unavailable("development");
  if (env.platform === "darwin") {
    if (env.execPath.startsWith("/Volumes/")) return unavailable("disk-image");
    return chosen(
      env.isDefaultProtocolClient("http") &&
        env.isDefaultProtocolClient("https"),
    );
  }
  if (env.platform === "win32") return windowsStatus(env);
  if (env.platform === "linux") return linuxStatus(env);
  return unavailable("not-installed");
}

// Returns once the request is made; callers read the status again.
export async function makeDefaultBrowser(
  env: DefaultBrowserEnv,
): Promise<void> {
  if ((await defaultBrowserStatus(env)).state !== "available") return;
  if (env.platform === "darwin") {
    // macOS asks the person to confirm.
    env.setAsDefaultProtocolClient("http");
    env.setAsDefaultProtocolClient("https");
  } else if (env.platform === "win32") {
    await env.openExternal(
      "ms-settings:defaultapps?registeredAppUser=Kamapathy",
    );
  } else if (env.platform === "linux") {
    await env.run(
      "xdg-settings",
      ["set", "default-web-browser", LINUX_DESKTOP_FILE],
      { timeoutMs: COMMAND_TIMEOUT_MS },
    );
  }
}
