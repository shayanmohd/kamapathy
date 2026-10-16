import { moveCopy } from "../src/copy";

export interface MoveDeps {
  app: Pick<
    Electron.App,
    "isPackaged" | "isInApplicationsFolder" | "moveToApplicationsFolder"
  >;
  dialog: Pick<Electron.Dialog, "showMessageBox" | "showMessageBoxSync">;
  platform: NodeJS.Platform;
  execPath: string;
  // process.defaultApp: Electron runs the checkout. The development runtime is
  // a renamed Electron, so app.isPackaged alone is true there too.
  defaultApp?: boolean;
}

// A packaged macOS build running from a disk image, or from the copy macOS
// translocates a downloaded app to, offers to move itself.
export function needsMove({
  app,
  platform,
  execPath,
  defaultApp,
}: MoveDeps): boolean {
  return (
    platform === "darwin" &&
    app.isPackaged &&
    !defaultApp &&
    !app.isInApplicationsFolder() &&
    (execPath.startsWith("/Volumes/") ||
      execPath.includes("/AppTranslocation/"))
  );
}

export async function maybeMoveToApplications(
  deps: MoveDeps,
): Promise<"not_needed" | "declined" | "moved" | "failed"> {
  if (!needsMove(deps)) return "not_needed";
  const { app, dialog } = deps;
  // No window exists yet, so the boxes stand alone.
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: [moveCopy.move, moveCopy.notNow],
    defaultId: 0,
    cancelId: 1,
    message: moveCopy.question,
    detail: moveCopy.detail,
  });
  if (response !== 0) return "declined";
  try {
    // True means Electron relaunches from Applications, or focuses the copy
    // already running there, and this process quits.
    const moved = app.moveToApplicationsFolder({
      conflictHandler: (type) =>
        type === "existsAndRunning" ||
        dialog.showMessageBoxSync({
          type: "question",
          buttons: [moveCopy.replaceButton, moveCopy.cancel],
          defaultId: 0,
          cancelId: 1,
          message: moveCopy.replace,
        }) === 0,
    });
    return moved ? "moved" : "declined";
  } catch (error) {
    console.error(
      "Move to Applications failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    await dialog.showMessageBox({
      type: "info",
      message: moveCopy.failed,
      detail: moveCopy.failedDetail,
    });
    return "failed";
  }
}
