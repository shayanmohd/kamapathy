import { describe, expect, it, vi } from "vitest";
import {
  maybeMoveToApplications,
  needsMove,
  type MoveDeps,
} from "../electron/move-to-applications";

type ConflictHandler = (type: "exists" | "existsAndRunning") => boolean;

const diskImage = "/Volumes/Kamapathy/Kamapathy.app/Contents/MacOS/Kamapathy";
const translocated =
  "/private/var/folders/x1/abc/T/AppTranslocation/7E1C2D3A-0B4F-4C5D-8E9F-0A1B2C3D4E5F/d/Kamapathy.app/Contents/MacOS/Kamapathy";
const downloads =
  "/Users/person/Downloads/Kamapathy.app/Contents/MacOS/Kamapathy";

function fakes({
  platform = "darwin",
  execPath = diskImage,
  isPackaged = true,
  defaultApp = false,
  inApplications = false,
  choice = 0,
  move = () => true,
}: {
  platform?: NodeJS.Platform;
  execPath?: string;
  isPackaged?: boolean;
  defaultApp?: boolean;
  inApplications?: boolean;
  choice?: number;
  move?: (options?: { conflictHandler?: ConflictHandler }) => boolean;
} = {}) {
  const app = {
    isPackaged,
    isInApplicationsFolder: vi.fn(() => inApplications),
    moveToApplicationsFolder: vi.fn(move),
  };
  const dialog = {
    showMessageBox: vi.fn(async (_options: unknown) => ({
      response: choice,
      checkboxChecked: false,
    })),
    showMessageBoxSync: vi.fn((_options: unknown) => 0),
  };
  const deps = {
    app,
    dialog,
    platform,
    execPath,
    defaultApp,
  } as unknown as MoveDeps;
  return { app, dialog, deps };
}

const question = {
  type: "question",
  buttons: ["Move to Applications", "Not now"],
  defaultId: 0,
  cancelId: 1,
  message: "Move Kamapathy to Applications?",
  detail:
    "From Applications it keeps working after you eject the disk image, and agents can start it.",
};

describe("Move to Applications", () => {
  it("asks only from /Volumes/ or translocated paths, never in development or off macOS", async () => {
    for (const options of [
      { isPackaged: false },
      // The development runtime is a renamed Electron, which reports
      // isPackaged while it runs the checkout.
      { defaultApp: true },
      { platform: "win32" as const },
      { platform: "linux" as const },
      { inApplications: true },
      { execPath: downloads },
      {
        execPath: "/Applications/Kamapathy.app/Contents/MacOS/Kamapathy",
      },
    ]) {
      const { app, dialog, deps } = fakes(options);
      expect(needsMove(deps)).toBe(false);
      expect(await maybeMoveToApplications(deps)).toBe("not_needed");
      expect(dialog.showMessageBox).not.toHaveBeenCalled();
      expect(app.moveToApplicationsFolder).not.toHaveBeenCalled();
      // The Applications check exists only on macOS.
      if (options.platform)
        expect(app.isInApplicationsFolder).not.toHaveBeenCalled();
    }

    for (const execPath of [diskImage, translocated]) {
      const { app, dialog, deps } = fakes({ execPath, choice: 1 });
      expect(needsMove(deps)).toBe(true);
      // Not now stores and moves nothing.
      expect(await maybeMoveToApplications(deps)).toBe("declined");
      expect(dialog.showMessageBox.mock.calls).toEqual([[question]]);
      expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
      expect(app.moveToApplicationsFolder).not.toHaveBeenCalled();
    }
  });

  it("Replace confirms", async () => {
    let conflictHandler: ConflictHandler | undefined;
    const { app, dialog, deps } = fakes({
      move: (options) => {
        conflictHandler = options?.conflictHandler;
        return true;
      },
    });
    // A true move means Electron relaunches from Applications, or focuses the
    // copy already running there, and quits this process.
    expect(await maybeMoveToApplications(deps)).toBe("moved");
    expect(dialog.showMessageBox.mock.calls).toEqual([[question]]);
    expect(app.moveToApplicationsFolder).toHaveBeenCalledTimes(1);

    expect(conflictHandler?.("existsAndRunning")).toBe(true);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();

    dialog.showMessageBoxSync.mockReturnValueOnce(0).mockReturnValueOnce(1);
    expect(conflictHandler?.("exists")).toBe(true);
    expect(conflictHandler?.("exists")).toBe(false);
    const replace = {
      type: "question",
      buttons: ["Replace", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      message: "Replace Kamapathy in Applications?",
    };
    expect(dialog.showMessageBoxSync.mock.calls).toEqual([
      [replace],
      [replace],
    ]);

    // Cancel, here or in the authorization prompt, leaves Kamapathy where it is.
    const cancelled = fakes({ execPath: translocated, move: () => false });
    expect(await maybeMoveToApplications(cancelled.deps)).toBe("declined");
  });

  it("a failed move continues", async () => {
    const failing = () =>
      fakes({
        move: () => {
          throw new Error("Failed to copy the application");
        },
      });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { dialog, deps } = failing();
      expect(await maybeMoveToApplications(deps)).toBe("failed");
      expect(dialog.showMessageBox.mock.calls).toEqual([
        [question],
        [
          {
            type: "info",
            message: "Kamapathy couldn't move itself.",
            detail:
              "Drag Kamapathy into the Applications folder, then open it from there.",
          },
        ],
      ]);
      expect(logged).toHaveBeenCalledWith(
        "Move to Applications failed:",
        "Failed to copy the application",
      );

      // main.ts's first whenReady statement returns only after a move.
      const started = vi.fn();
      const whenReady = async () => {
        if ((await maybeMoveToApplications(failing().deps)) === "moved") return;
        started();
      };
      await whenReady();
      expect(started).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});
