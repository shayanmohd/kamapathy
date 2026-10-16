import { contextBridge, ipcRenderer } from "electron";
import type {
  BrowserAction,
  BrowserState,
  ContentBounds,
  KamapathyBridge,
} from "../shared/types";

// Electron wraps a rejection in "Error invoking remote method ..."; the
// interface shows the message itself.
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""),
    );
  }
}

const bridge: KamapathyBridge = {
  getState: () => invoke("kamapathy:state"),
  dispatch: (action: BrowserAction) => invoke("kamapathy:dispatch", action),
  subscribe(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserState) =>
      callback(state);
    ipcRenderer.on("kamapathy:state-changed", listener);
    return () => ipcRenderer.removeListener("kamapathy:state-changed", listener);
  },
  onShortcut(callback) {
    const listener = (_event: Electron.IpcRendererEvent, shortcut: string) =>
      callback(shortcut);
    ipcRenderer.on("kamapathy:shortcut", listener);
    return () => ipcRenderer.removeListener("kamapathy:shortcut", listener);
  },
  setContentBounds: (bounds: ContentBounds) =>
    ipcRenderer.send("kamapathy:bounds", bounds),
  freeze: () => invoke("kamapathy:freeze"),
  hidePages: () => ipcRenderer.send("kamapathy:hide-pages"),
  unfreeze: () => invoke("kamapathy:unfreeze"),
  thumbnails: () => invoke("kamapathy:thumbnails"),
  windowControl: (action) => ipcRenderer.send("kamapathy:window", action),
  importSources: () => invoke("kamapathy:import-sources"),
  importBrowserData: (request) => invoke("kamapathy:import", request),
  agentSetupStatus: (options) => invoke("kamapathy:agent-setup-status", options),
  applyAgentSetup: (request) => invoke("kamapathy:agent-setup-apply", request),
  removeAgentSetup: () => invoke("kamapathy:agent-setup-remove"),
  copyText: (text) => invoke("kamapathy:copy-text", text),
};

contextBridge.exposeInMainWorld("kamapathy", bridge);
