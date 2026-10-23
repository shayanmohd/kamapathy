import type { InstallKind, UpdateState } from "../../shared/types";
import { updatesCopy as copy } from "../copy";
import { activityTime } from "./spaces";

const percent = (progress: UpdateState["progress"]) =>
  progress?.totalBytes
    ? Math.round((progress.receivedBytes / progress.totalBytes) * 100)
    : 0;

// A failure comes first, then the kinds with no installer, then the state.
export function updateLine(
  update: UpdateState,
  version: string,
  now: number,
): string {
  const { error } = update;
  if (error?.code === "update_check_failed") return copy.checkFailed;
  if (error?.code === "update_download_failed")
    return error.reason === "cancelled" ? copy.cancelled : copy.downloadStopped;
  if (error?.code === "update_verify_failed") return copy.verifyFailed;
  if (update.kind === "source") return copy.source;
  if (update.kind === "other") return copy.noInstaller;
  const latest = update.latest?.version ?? version;
  switch (update.state) {
    case "current":
      return copy.current(activityTime(update.checkedAt ?? now));
    case "available":
      return copy.available(latest);
    case "downloading":
      return copy.downloading(latest, percent(update.progress));
    case "ready":
      return copy.ready(latest);
    default:
      return copy.unchecked;
  }
}

export function installSteps(kind: InstallKind): {
  steps: string;
  primary: "install" | "show";
  command: boolean;
} {
  switch (kind) {
    case "mac-arm64":
    case "mac-x64":
      return { steps: copy.steps.mac, primary: "install", command: false };
    case "windows-setup":
      return { steps: copy.steps.windows, primary: "install", command: false };
    case "linux-deb":
      return { steps: copy.steps.debian, primary: "show", command: true };
    // The portable kinds, and the two with no installer, which never open it.
    default:
      return { steps: copy.steps.portable, primary: "show", command: false };
  }
}

export function agentSpacesLine(count: number): string | null {
  return count > 0 ? copy.agentSpaces(count) : null;
}
