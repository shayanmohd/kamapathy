import { contextBridge, ipcRenderer } from "electron";
import { isComponentExtension } from "../../shared/extensions";
import {
  EXTENSION_CALL,
  EXTENSION_EVENT,
  EXTENSION_LISTEN,
  EXTENSION_READY,
  installChromeApi,
} from "./chrome-api";

// This runs in every service worker of a session that loads the person's
// extensions, web sites' workers included, so only an extension's own worker
// gets the bridges. A service worker preload has no location of its own, so
// the worker's context reports where it runs.
const host = where();
if (host && !isComponentExtension(host)) install();

function where(): string {
  try {
    return (contextBridge.executeInMainWorld({ func: scriptHost }) ??
      "") as string;
  } catch (error) {
    return "";
  }
}

function announce(ready: () => void): void {
  setTimeout(ready, 0);
}

// Serialized into the worker's context, so these stand alone.
function scriptHost(): string {
  const url = (
    globalThis as { location?: { protocol: string; hostname: string } }
  ).location;
  return url && url.protocol === "chrome-extension:" ? url.hostname : "";
}

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
  // The main process holds events until the worker's own script has had a
  // turn to register its listeners. This context has no timers, so the
  // worker's own context schedules the report.
  contextBridge.executeInMainWorld({
    func: announce,
    args: [() => ipcRenderer.send(EXTENSION_READY)],
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
