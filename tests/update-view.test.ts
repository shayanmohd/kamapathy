import { describe, expect, it } from "vitest";
import type { InstallKind, UpdateRelease, UpdateState } from "../shared/types";
import {
  agentSpacesLine,
  installSteps,
  updateLine,
} from "../src/lib/updateView";
import { activityTime } from "../src/lib/spaces";

const CHECKED = Date.UTC(2026, 9, 18, 8, 15);
const NOW = CHECKED + 60_000;
const latest: UpdateRelease = {
  version: "0.3.0",
  publishedAt: CHECKED,
  url: "https://github.com/shayanmohd/kamapathy/releases/tag/v0.3.0",
  installer: {
    name: "Kamapathy-0.3.0-mac-arm64.dmg",
    size: 100_000_000,
    url: "https://github.com/shayanmohd/kamapathy/releases/download/v0.3.0/Kamapathy-0.3.0-mac-arm64.dmg",
  },
  sums: "https://github.com/shayanmohd/kamapathy/releases/download/v0.3.0/SHA256SUMS.txt",
};
const update = (over: Partial<UpdateState> = {}): UpdateState => ({
  kind: "mac-arm64",
  state: "unchecked",
  ...over,
});
const line = (over: Partial<UpdateState> = {}) =>
  updateLine(update(over), "0.2.0", NOW);

describe("updates in Settings", () => {
  it("status lines follow the update state", () => {
    expect(line()).toBe("Not checked yet.");
    expect(line({ state: "current", checkedAt: CHECKED })).toBe(
      `Kamapathy is up to date. Checked ${activityTime(CHECKED)}.`,
    );
    expect(line({ state: "available", checkedAt: CHECKED, latest })).toBe(
      "Kamapathy 0.3.0 is available.",
    );
    expect(
      line({
        state: "downloading",
        latest,
        progress: { receivedBytes: 42_000_000, totalBytes: 100_000_000 },
      }),
    ).toBe("Downloading Kamapathy 0.3.0... 42%");
    expect(
      line({
        state: "ready",
        latest,
        installer: { path: "/tmp/Kamapathy-0.3.0-mac-arm64.dmg", sha256: "a" },
      }),
    ).toBe("Kamapathy 0.3.0 is ready to install.");
    expect(
      line({
        state: "unchecked",
        error: {
          code: "update_check_failed",
          message: "GitHub Releases did not answer.",
          reason: "network",
        },
      }),
    ).toBe("Couldn't reach GitHub. Try again later.");
    expect(
      line({
        state: "available",
        latest,
        error: {
          code: "update_download_failed",
          message: "The download stopped.",
          reason: "stalled",
        },
      }),
    ).toBe("The download stopped. Try again.");
    expect(
      line({
        state: "available",
        latest,
        error: {
          code: "update_verify_failed",
          message: "The file failed its checksum.",
          reason: "sums_mismatch",
          file: "Kamapathy-0.3.0-mac-arm64.dmg",
        },
      }),
    ).toBe("The download didn't match its checksum, so it was deleted.");
    expect(
      line({
        state: "available",
        latest,
        error: {
          code: "update_download_failed",
          message: "The download was cancelled.",
          reason: "cancelled",
        },
      }),
    ).toBe("Download cancelled.");
    expect(line({ kind: "source", state: "unsupported" })).toBe(
      "This copy runs from source. Pull the latest code to update it.",
    );
    expect(line({ kind: "other", state: "unsupported" })).toBe(
      "No installer is published for this computer yet.",
    );
  });
  it("the install dialog follows the kind and names open agent spaces", () => {
    const steps: Record<string, string> = {
      portable:
        "Quit Kamapathy, replace your copy with this file, then open it.",
      debian: "Quit Kamapathy, then run:",
      mac: "Drag Kamapathy into Applications and replace the old copy, then open it. If macOS says it can't verify the app, click Open Anyway in System Settings > Privacy & Security.",
      windows:
        "Follow the setup, then open Kamapathy. If SmartScreen appears, click More info, then Run anyway.",
    };
    const expected: Record<string, [string, "install" | "show", boolean]> = {
      "mac-arm64": [steps.mac, "install", false],
      "mac-x64": [steps.mac, "install", false],
      "windows-setup": [steps.windows, "install", false],
      "windows-portable": [steps.portable, "show", false],
      "linux-appimage": [steps.portable, "show", false],
      "linux-deb": [steps.debian, "show", true],
    };
    for (const [kind, [text, primary, command]] of Object.entries(expected))
      expect(installSteps(kind as InstallKind)).toEqual({
        steps: text,
        primary,
        command,
      });
    expect(agentSpacesLine(0)).toBe(null);
    expect(agentSpacesLine(1)).toBe(
      "1 agent space is open. It closes when Kamapathy quits.",
    );
    expect(agentSpacesLine(2)).toBe(
      "2 agent spaces are open. They close when Kamapathy quits.",
    );
  });
});
