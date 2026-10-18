import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, safeStorage, session, systemPreferences } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserController } from "./controller";
import { menuTemplate } from "./menu";
import { readState } from "./persistence";
import { availableBrowsers, importFrom, type BrowserId } from "./import";
import { startAutomation } from "./agent/server";
import { connectForms, type FormBroker } from "./passwords/forms";
import { registerPasswordIpc } from "./passwords/ipc";
import { createReauth } from "./passwords/reauth";
import { safeStorageSealer } from "./passwords/seal";
import { Vault } from "./passwords/vault";
import {
  agentPaths,
  chooseSocketPath,
  clearStaleEndpoint,
  launchCommand,
  prepareAgentDirectory,
  publishEndpoint,
  releaseSocket,
  removeStaleSocket,
  setAgentAccess,
  withdrawEndpoint,
  writeLaunchInfo,
} from "./agent-socket";
import { isWebUrl } from "../shared/url";
import { version } from "../package.json";
import type {
  BrowserAction,
  BrowserState,
  ContentBounds,
  ImportOutcome,
  ImportRequest,
} from "../shared/types";
import { surfaceColor } from "../shared/theme";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
if (process.env.KAMAPATHY_USER_DATA)
  app.setPath("userData", resolve(process.env.KAMAPATHY_USER_DATA));
app.setName("Kamapathy");
if (process.platform === "win32") app.setAppUserModelId("app.kamapathy.browser");
if (process.platform === "linux") app.setDesktopName("app.kamapathy.browser.desktop");
// Agents on this computer find Kamapathy through this profile's agent folder.
const agent = agentPaths(app.getPath("userData"));

let window: BrowserWindow | null = null;
let controller: BrowserController | null = null;
let automation: Awaited<ReturnType<typeof startAutomation>> | null = null;
let automationSyncing = false;
// A failed start waits until the person turns access off and on again. It is
// never saved as their choice, which would also stop agents from starting Kamapathy.
let automationFailed = false;
let quitting = false;
// Saved passwords serve every window; each window has its own form broker.
let vault: Vault | null = null;
let forms: FormBroker | null = null;
let vaultOpenScheduled = false;
const rendererFile = join(moduleDirectory, "../renderer/index.html");
const externalApplication = process.defaultApp === true;
const iconFile = process.platform === "win32" ? "icon.ico" : "icon.png";
const iconPath = externalApplication
  ? join(moduleDirectory, "../../build", iconFile)
  : join(process.resourcesPath, iconFile);
const developmentUrl = externalApplication
  ? process.env.ELECTRON_RENDERER_URL
  : undefined;
const rendererUrl = developmentUrl || pathToFileURL(rendererFile).href;

function trustedUrl(url: string): boolean {
  try {
    const actual = new URL(url);
    const expected = new URL(rendererUrl);
    return (
      actual.origin === expected.origin &&
      actual.protocol === expected.protocol &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

function validateSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
): BrowserController {
  if (
    !window ||
    !controller ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame !== window.webContents.mainFrame ||
    !trustedUrl(event.senderFrame.url)
  )
    throw new Error(
      "This operation is available only to the browser interface.",
    );
  return controller;
}

async function syncAutomation(): Promise<void> {
  if (automationSyncing) return;
  automationSyncing = true;
  try {
    if (!controller?.state.settings.automationEnabled) automationFailed = false;
    const wanted = () =>
      Boolean(
        controller?.state.settings.automationEnabled &&
          !quitting &&
          !automationFailed,
      );
    while (wanted() !== Boolean(automation)) {
      if (wanted()) {
        const owner = controller!;
        let socketPath: string | undefined;
        try {
          prepareAgentDirectory(agent);
          socketPath = chooseSocketPath(app.getPath("userData"));
          removeStaleSocket(socketPath);
          automation = await startAutomation(owner, { socketPath });
          if (owner === controller) {
            publishEndpoint(agent, automation.endpoint, automation.instance);
            owner.setAutomation(true);
          } else {
            await automation.close();
            releaseSocket(agent, automation.endpoint);
            automation = null;
          }
        } catch (error) {
          automationFailed = true;
          if (socketPath) releaseSocket(agent, socketPath);
          if (owner === controller)
            owner.addActivity(
              undefined,
              "The local agent service could not start. Turn agent access off and on to try again.",
              "warning",
            );
          console.error(
            "Agent service startup failed:",
            error instanceof Error ? error.message : "Unknown error",
          );
        }
      } else if (automation) {
        const closing = automation;
        automation = null;
        withdrawEndpoint(agent);
        await closing.close();
        releaseSocket(agent, closing.endpoint);
        controller?.setAutomation(false);
        // Agent access off ends every grant.
        controller?.resetAgentAccess();
      }
    }
    // The client reads this to avoid starting Kamapathy after access was turned off.
    if (controller && !quitting)
      setAgentAccess(agent, controller.state.settings.automationEnabled);
  } catch (error) {
    console.error(
      "Agent access could not be updated:",
      error instanceof Error ? error.message : "Unknown error",
    );
  } finally {
    automationSyncing = false;
  }
}

function shortcut(name: string): void {
  if (window && !window.isDestroyed()) {
    window.webContents.focus();
    window.webContents.send("kamapathy:shortcut", name);
  }
}

function createWindow(): void {
  const platform: BrowserState["platform"] =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "win32"
        : "linux";
  const statePath = join(app.getPath("userData"), "browser-state.json");
  const state = readState(statePath, platform, version);
  window = new BrowserWindow({
    title: "Kamapathy",
    width: 1440,
    height: 960,
    minWidth: 850,
    minHeight: 600,
    show: false,
    backgroundColor:
      state.settings.theme === "dark" ||
      (state.settings.theme === "system" && nativeTheme.shouldUseDarkColors)
        ? surfaceColor.dark
        : surfaceColor.light,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition:
      process.platform === "darwin" ? { x: 16, y: 15 } : undefined,
    frame: process.platform === "darwin",
    autoHideMenuBar: true,
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(moduleDirectory, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  const currentWindow = window;
  controller = new BrowserController(currentWindow, state, statePath, {
    framePreload: join(moduleDirectory, "../preload/forms.cjs"),
  });
  const currentController = controller;
  currentController.subscribe(() => {
    void syncAutomation();
  });
  const currentForms =
    vault &&
    connectForms(currentController, currentWindow, vault, {
      openManager: () => shortcut("passwords"),
    });
  forms = currentForms;
  currentWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  currentWindow.webContents.on("will-navigate", (event, url) => {
    if (!trustedUrl(url)) event.preventDefault();
  });
  currentWindow.webContents.on("will-redirect", (event) =>
    event.preventDefault(),
  );
  currentWindow.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  currentWindow.once("ready-to-show", () => currentWindow.show());
  // A saved vault opens soon after launch, so any keychain prompt comes then.
  currentWindow.once("show", () => {
    if (vaultOpenScheduled) return;
    vaultOpenScheduled = true;
    setTimeout(() => void vault?.open(), 2000);
  });
  currentWindow.on("close", () => {
    currentForms?.dispose();
    currentController.dispose();
  });
  currentWindow.on("closed", () => {
    if (window === currentWindow) {
      window = null;
      controller = null;
      forms = null;
    }
    void syncAutomation();
  });
  void (developmentUrl
    ? currentWindow.loadURL(developmentUrl)
    : currentWindow.loadFile(rendererFile));
  void syncAutomation();
}

function registerIpc(): void {
  ipcMain.handle("kamapathy:state", (event) => validateSender(event).state);
  ipcMain.handle("kamapathy:dispatch", async (event, action: BrowserAction) => {
    const owner = validateSender(event);
    // Only the person's own click in the app grants a space to agents.
    if (action?.type === "space:grant") {
      if (!automation) throw new Error("Turn on agent access first.");
      automation.grantSpace(action.id);
      return owner.state;
    }
    if (action?.type === "space:ownership" && action.owner === "agent") {
      if (!automation)
        throw new Error(
          "Turn on the agent connection before letting an agent continue.",
        );
      // Let agent continue on a space without access is a new grant. A grant
      // changes nothing when it fails, so there is nothing to undo.
      const { id } = action;
      if (
        owner.state.spaces.find((space) => space.id === id)?.access !==
        "granted"
      ) {
        automation.grantSpace(id);
        return owner.state;
      }
    }
    if (action?.type === "space:stop" && automation) {
      automation.endSpace(action.id);
      return owner.state;
    }
    if (action?.type === "space-request:answer" && automation) {
      automation.answerRequest(action.id, {
        allow: action.allow === true,
        spaceId: action.spaceId,
      });
      return owner.state;
    }
    return owner.dispatch(action);
  });
  ipcMain.on("kamapathy:bounds", (event, bounds: ContentBounds) => {
    try {
      validateSender(event).setContentBounds(bounds);
    } catch {
      /* Untrusted frames have no native window access. */
    }
  });
  ipcMain.handle("kamapathy:freeze", (event) => validateSender(event).freeze());
  ipcMain.on("kamapathy:hide-pages", (event) => {
    try {
      validateSender(event).hidePages();
    } catch {
      /* Untrusted frames have no native window access. */
    }
  });
  ipcMain.handle("kamapathy:unfreeze", (event) => validateSender(event).unfreeze());
  ipcMain.handle("kamapathy:thumbnails", (event) =>
    validateSender(event).thumbnails(),
  );
  ipcMain.handle("kamapathy:import-sources", (event) => {
    validateSender(event);
    return availableBrowsers();
  });
  ipcMain.handle(
    "kamapathy:import",
    async (event, request: ImportRequest): Promise<ImportOutcome> => {
      const owner = validateSender(event);
      if (
        !request ||
        typeof request !== "object" ||
        typeof request.source !== "string" ||
        (request.profile !== undefined && typeof request.profile !== "string") ||
        typeof request.bookmarks !== "boolean" ||
        typeof request.history !== "boolean"
      )
        throw new Error("Invalid import request.");
      const source = availableBrowsers().find(
        (item) => item.id === request.source,
      );
      if (!source) throw new Error("That browser was not found.");
      const data = await importFrom(
        source.id as BrowserId,
        request.profile,
        { bookmarks: request.bookmarks, history: request.history },
      );
      const bookmarksBefore = owner.state.bookmarks.length;
      const known = new Set(owner.state.history.map((entry) => entry.url));
      await owner.dispatch({
        type: "import:apply",
        bookmarks: data.bookmarks,
        history: data.history,
      });
      return {
        bookmarks: owner.state.bookmarks.length - bookmarksBefore,
        history: owner.state.history.filter((entry) => !known.has(entry.url))
          .length,
        warnings: data.warnings,
      };
    },
  );
  ipcMain.on("kamapathy:window", (event, action: string) => {
    try {
      const current = validateSender(event).window;
      if (action === "minimize") current.minimize();
      if (action === "maximize") {
        if (current.isMaximized()) current.unmaximize();
        else current.maximize();
      }
      if (action === "close") current.close();
    } catch {
      /* Ignore messages from untrusted frames. */
    }
  });
  // Showing, copying and editing a password asks who is at the computer.
  const reauth = createReauth({
    canPromptTouchID: () =>
      process.platform === "darwin" && systemPreferences.canPromptTouchID(),
    promptTouchID: (reason) => systemPreferences.promptTouchID(reason),
    confirm: async () =>
      !!window &&
      !window.isDestroyed() &&
      (
        await dialog.showMessageBox(window, {
          type: "question",
          message: "Show passwords?",
          detail: "Anyone using this computer account can see saved passwords.",
          buttons: ["Show", "Cancel"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
      ).response === 0,
  });
  registerPasswordIpc({
    ipcMain,
    validate: (event) => void validateSender(event),
    vault: () => vault!,
    reauth,
    forms: () => forms,
    clipboard,
  });
}

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate({
        darwin: process.platform === "darwin",
        appName: app.getName(),
        shell: () => window,
        send: shortcut,
      }),
    ),
  );
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    if (!window) createWindow();
    if (window?.isMinimized()) window.restore();
    window?.focus();
    const url = argv.find((argument) => isWebUrl(argument));
    if (url) void controller?.dispatch({ type: "tab:create", url });
  });
  app.on("before-quit", () => {
    quitting = true;
    // Closing the service may not finish before exit; stop advertising it now.
    try {
      withdrawEndpoint(agent);
    } catch {}
    controller?.dispose();
    void syncAutomation();
    // Times saved logins were last used are written in batches.
    void vault?.flush();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!window) createWindow();
    else window.show();
  });
  void app.whenReady().then(() => {
    if (existsSync(iconPath)) app.dock?.setIcon(iconPath);
    app.setAboutPanelOptions({
      applicationName: "Kamapathy",
      applicationVersion: version,
      ...(existsSync(iconPath) ? { iconPath } : {}),
    });
    // The browser interface needs no web permissions. Without handlers,
    // Electron would grant every request.
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    try {
      // A crash leaves the last endpoint behind; record how agents can start
      // this Kamapathy again.
      prepareAgentDirectory(agent);
      clearStaleEndpoint(agent);
      const launch = launchCommand({
        env: process.env,
        execPath: process.execPath,
        defaultApp: process.defaultApp === true,
        appPath: app.getAppPath(),
      });
      writeLaunchInfo(agent, launch.command, launch.args);
    } catch (error) {
      console.error(
        "Agent folder could not be prepared:",
        error instanceof Error ? error.message : "Unknown error",
      );
    }
    // safeStorage works once the app is ready. Nothing reads the keychain
    // until a saved vault opens or the first password is saved.
    vault = new Vault({
      path: join(app.getPath("userData"), "passwords", "vault.bin"),
      sealer: safeStorageSealer(safeStorage, process.platform),
    });
    registerIpc();
    installMenu();
    createWindow();
  });
}
