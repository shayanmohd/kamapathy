import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import {
  extensionImportCopy,
  extensionInstallCopy,
  extensionRemoveCopy,
} from "../../src/copy";

export interface ConsentDetails {
  name: string;
  lines: string[];
  wontWork: string[];
}

// The native Add dialog. dialog.showMessageBox is read at call time, so the
// end-to-end suites can stub it.
export function confirmAdd(
  window: () => BrowserWindow | null,
): (details: ConsentDetails) => Promise<boolean> {
  return async ({ name, lines, wontWork }) => {
    const options: Electron.MessageBoxOptions = {
      type: "question",
      message: extensionInstallCopy.consentTitle(name),
      detail: [
        ...lines,
        extensionInstallCopy.agentSpaces,
        ...(wontWork.length ? [extensionInstallCopy.wontWork(wontWork)] : []),
      ].join("\n"),
      buttons: [extensionInstallCopy.cancel, extensionInstallCopy.add],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const parent = window();
    const { response } = await (parent
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options));
    return response === 1;
  };
}

// The native Remove dialog, asked before Remove's four steps.
export function confirmRemove(
  window: () => BrowserWindow | null,
): (name: string) => Promise<boolean> {
  return async (name) => {
    const options: Electron.MessageBoxOptions = {
      type: "question",
      message: extensionRemoveCopy.title(name),
      detail: extensionRemoveCopy.detail,
      buttons: [extensionRemoveCopy.cancel, extensionRemoveCopy.remove],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const parent = window();
    const { response } = await (parent
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options));
    return response === 1;
  };
}

// The one native dialog an import opens, before anything is added.
export function confirmImport(
  window: () => BrowserWindow | null,
): (browser: string, count: number) => Promise<boolean> {
  return async (browser, count) => {
    const options: Electron.MessageBoxOptions = {
      type: "question",
      message: extensionImportCopy.dialogTitle(count, browser),
      detail: extensionImportCopy.dialogDetail(browser),
      buttons: [extensionImportCopy.cancel, extensionImportCopy.confirm(count)],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const parent = window();
    const { response } = await (parent
      ? dialog.showMessageBox(parent, options)
      : dialog.showMessageBox(options));
    return response === 1;
  };
}

// Load unpacked's folder chooser. Cancelling resolves undefined.
export function chooseFolder(
  window: () => BrowserWindow | null,
): () => Promise<string | undefined> {
  return async () => {
    const options: Electron.OpenDialogOptions = {
      title: extensionRemoveCopy.chooseFolder,
      properties: ["openDirectory"],
    };
    const parent = window();
    const { filePaths } = await (parent
      ? dialog.showOpenDialog(parent, options)
      : dialog.showOpenDialog(options));
    return filePaths[0];
  };
}
