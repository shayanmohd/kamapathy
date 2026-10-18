import { dialog } from "electron";
import type { BrowserWindow } from "electron";
import { extensionInstallCopy } from "../../src/copy";

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
