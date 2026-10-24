import { contextBridge, ipcRenderer } from "electron";
import { isComponentExtension } from "../../shared/extensions";
import {
  EXTENSION_CALL,
  EXTENSION_EVENT,
  EXTENSION_LISTEN,
  installChromeApi,
} from "./chrome-api";

// This runs in every frame of a session that loads the person's extensions,
// so only an extension's own pages get the bridges: web pages, their frames
// and Kamapathy's PDF viewer get nothing.
if (
  location.protocol === "chrome-extension:" &&
  !isComponentExtension(location.hostname)
)
  install();

function install(): void {
  let dispatch: ((event: string, args: unknown[]) => void) | undefined;
  ipcRenderer.on(EXTENSION_EVENT, (_event, name: string, args: unknown[]) => {
    dispatch?.(name, args);
  });
  contextBridge.executeInMainWorld({
    func: installChromeApi,
    args: [
      (api: string, method: string, args: unknown[]) => call(api, method, args),
      (
        events: string[],
        listener: (event: string, args: unknown[]) => void,
      ) => {
        dispatch = listener;
        ipcRenderer.send(EXTENSION_LISTEN, events);
      },
    ],
  });
}

// Electron wraps a rejection in "Error invoking remote method ..."; the
// extension gets the message itself.
async function call(
  api: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  try {
    return await ipcRenderer.invoke(EXTENSION_CALL, { api, method, args });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.replace(
        /^Error invoking remote method '[^']*': (?:Error: )?/,
        "",
      ),
    );
  }
}
