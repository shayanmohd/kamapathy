import { contextBridge, ipcRenderer } from "electron";
import type {
  BrowserAction,
  BrowserState,
  ContentBounds,
  KamapathyBridge,
  PromptAnswer,
} from "../shared/types";
import type {
  ExtensionCommand,
  ExtensionImportRequest,
  ExtensionsView,
} from "../shared/extensions";

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
  passwords: {
    status: () => invoke("kamapathy:passwords:status"),
    list: () => invoke("kamapathy:passwords:list"),
    reveal: (id) => invoke("kamapathy:passwords:reveal", id),
    copy: (id, field) => invoke("kamapathy:passwords:copy", id, field),
    add: (login) => invoke("kamapathy:passwords:add", login),
    update: (id, changes) => invoke("kamapathy:passwords:update", id, changes),
    remove: (id) => invoke("kamapathy:passwords:remove", id),
    importFile: (options) => invoke("kamapathy:passwords:import-file", options),
    trashFile: (token) => invoke("kamapathy:passwords:trash-file", token),
    exportFile: () => invoke("kamapathy:passwords:export-file"),
    answer: (promptId, answer) =>
      invoke("kamapathy:passwords:answer", promptId, answer),
    retry: () => invoke("kamapathy:passwords:retry"),
    startOver: () => invoke("kamapathy:passwords:start-over"),
    neverSaved: () => invoke("kamapathy:passwords:never-saved"),
    removeNeverSaved: (origin) =>
      invoke("kamapathy:passwords:remove-never-saved", origin),
  },
  windowControl: (action) => ipcRenderer.send("kamapathy:window", action),
  importSources: () => invoke("kamapathy:import-sources"),
  importBrowserData: (request) => invoke("kamapathy:import", request),
  agentSetupStatus: (options) => invoke("kamapathy:agent-setup-status", options),
  applyAgentSetup: (request) => invoke("kamapathy:agent-setup-apply", request),
  removeAgentSetup: () => invoke("kamapathy:agent-setup-remove"),
  copyText: (text) => invoke("kamapathy:copy-text", text),
  helpSpaceId: () => invoke("kamapathy:help-space"),
  update: (command) => invoke("kamapathy:update", command),
  extensions: () => invoke("kamapathy:extensions"),
  onExtensions(callback) {
    const listener = (
      _event: Electron.IpcRendererEvent,
      view: ExtensionsView,
    ) => callback(view);
    ipcRenderer.on("kamapathy:extensions-changed", listener);
    return () =>
      ipcRenderer.removeListener("kamapathy:extensions-changed", listener);
  },
  extensionCommand: (command: ExtensionCommand) =>
    invoke("kamapathy:extension-command", command),
  extensionImportCandidates: (selection) =>
    invoke("kamapathy:extension-import-candidates", selection),
  importExtensions: (request: ExtensionImportRequest) =>
    invoke("kamapathy:import-extensions", request),
  importSafariArchive: (bytes, request) =>
    invoke("kamapathy:import-safari", bytes, request),
  openImportPermissions: (pane) =>
    ipcRenderer.send("kamapathy:open-import-permissions", { pane }),
  defaultBrowser: () => invoke("kamapathy:default-browser"),
  makeDefaultBrowser: () => invoke("kamapathy:make-default-browser"),
  // Its own channel: an answer may carry a password, which never belongs in
  // an action or in the state an action returns.
  answerPrompt: (answer: PromptAnswer) =>
    invoke("kamapathy:answer-prompt", answer),
};

contextBridge.exposeInMainWorld("kamapathy", bridge);
