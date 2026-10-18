// What the client and the CLI say about a newer Kamapathy: the agent notice
// the session queues, and the lines the upgrade command prints. Node
// built-ins only.
import { line } from "./format.mjs";

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

export const isVersion = (value) =>
  typeof value === "string" && VERSION.test(value);

/**
 * The one notice an agent sees while an update waits, or null.
 * @param {{ version?: string, update?: { version: string, state: string } } | null} app
 * @returns {{ key: "update", text: string } | null}
 */
export function updateNotice(app) {
  const version = app?.version;
  const next = app?.update?.version;
  if (!isVersion(version) || !isVersion(next)) return null;
  const notice = (text) => ({ key: "update", text });
  switch (app.update.state) {
    case "available":
    case "downloading":
      return notice(
        `update_available: Kamapathy ${next} is out (this is ${version}). Finish this task first, then ask the person before you run kamapathy upgrade. Read the Kamapathy skill again after the update.`,
      );
    case "ready":
      return notice(
        `update_ready: Kamapathy ${next} is downloaded (this is ${version}). Finish this task first, then tell the person they can install it from Settings, under Updates. Read the Kamapathy skill again after the update.`,
      );
    default:
      return null;
  }
}

// What the person does with a downloaded installer, by install kind.
const SETTINGS_STEP =
  "Next: when your task is done, ask the person to choose Install in Kamapathy's Settings, under Updates. Kamapathy quits to install, which closes agent spaces.";
const NEXT_STEP = {
  "mac-arm64": SETTINGS_STEP,
  "mac-x64": SETTINGS_STEP,
  "windows-setup": SETTINGS_STEP,
  "windows-portable":
    "Next: when your task is done, ask the person to replace their copy of Kamapathy with this file.",
  "linux-appimage":
    "Next: when your task is done, ask the person to replace their copy of Kamapathy with this file.",
  "linux-deb":
    "Next: when your task is done, ask the person to install it from Kamapathy's Settings, under Updates, or with sudo apt install.",
};

/** The installer's size as whole megabytes, at least 1. */
export const megabytes = (size) => Math.max(1, Math.round(size / 1000000));

/**
 * The upgrade command's stdout lines for an update status.
 * @param {{ version?: string, state?: string, kind?: string, latest?: { version?: string }, installer?: { path?: string } }} status
 * @returns {string[]}
 */
export function upgradeLines(status) {
  const running = line(status?.version);
  const next = line(status?.latest?.version);
  switch (status?.state) {
    case "available":
      return [
        `Kamapathy ${next} is available (this is ${running}). Run kamapathy upgrade, with the person's approval, to download it.`,
      ];
    case "downloading":
      return [
        `Kamapathy is downloading ${next}. Run kamapathy upgrade again to wait for it.`,
      ];
    case "ready":
      return [
        `Kamapathy ${next} is downloaded and checked (this is ${running}).`,
        `Installer: ${line(status.installer?.path)}`,
        NEXT_STEP[status.kind] ?? SETTINGS_STEP,
        "Read the Kamapathy skill again once the new version runs.",
      ];
    default:
      return [`Kamapathy ${running} is up to date.`];
  }
}
