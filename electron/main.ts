import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, powerMonitor, safeStorage, session, shell, systemPreferences } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, Session } from "electron";
import { existsSync } from "node:fs";
import { readFile, stat, statfs } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BackgroundService } from "./background";
import {
  BrowserController,
  NO_EXTENSIONS,
  restoredPartitions,
} from "./controller";
import {
  defaultBrowserStatus,
  electronDefaultBrowserEnv,
  makeDefaultBrowser,
} from "./default-browser";
import { ExtensionBridge } from "./extensions/bridge";
import { ExtensionChannel } from "./extensions/channel";
import { chooseFolder, confirmAdd, confirmRemove } from "./extensions/dialogs";
import { ExtensionHost } from "./extensions/host";
import { ExtensionInstaller } from "./extensions/install";
import { registerExtensionIpc, type ExtensionIpc } from "./extensions/ipc";
import { ExtensionPopups } from "./extensions/popup";
import { ExtensionUpdates } from "./extensions/updates";
import {
  STORE_PARTITION,
  sessionFetcher,
  storeEnv,
} from "./extensions/webstore";
import { chromeUserAgent } from "./identity";
import { incomingItem, incomingItems, incomingLimiter } from "./incoming";
import { menuTemplate } from "./menu";
import { maybeMoveToApplications } from "./move-to-applications";
import { readState } from "./persistence";
import {
  INSTALLER_KINDS,
  installKind,
  repository,
  updateSource,
} from "./update-release";
import {
  netTransport,
  realTimers,
  UpdateFailure,
  Updater,
} from "./updates";
import {
  availableBrowsers,
  exclusive,
  ImportError,
  parseImportRequest,
  runImport,
} from "./import";
import { runSafariImport } from "./import-safari";
import { clearDownloadFolder } from "./agent/downloads";
import { startAutomation } from "./agent/server";
import { writeCsvFile } from "./passwords/csv";
import { connectForms, type FormBroker } from "./passwords/forms";
import { registerPasswordIpc } from "./passwords/ipc";
import { createReauth } from "./passwords/reauth";
import { safeStorageSealer } from "./passwords/seal";
import { Vault } from "./passwords/vault";
import {
  createAgentSetup,
  parseAgentSetupRequest,
  SetupError,
  type AgentSetup,
} from "./agent/setup/index";
import type { SetupEnvironment } from "./agent/setup/paths";
import { execRunner } from "./agent/setup/probe";
import {
  agentPaths,
  chooseSocketPath,
  clearQuitMarker,
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
import { homepage, version } from "../package.json";
import type {
  BrowserAction,
  BrowserState,
  ContentBounds,
  ImportOutcome,
  ImportReply,
  ImportRequest,
  InstallKind,
  UpdateCommand,
  PromptAnswer,
} from "../shared/types";
import { surfaceColor } from "../shared/theme";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
if (process.env.KAMAPATHY_USER_DATA)
  app.setPath("userData", resolve(process.env.KAMAPATHY_USER_DATA));
app.setName("Kamapathy");
if (process.platform === "win32") app.setAppUserModelId("app.kamapathy.browser");
if (process.platform === "linux") app.setDesktopName("app.kamapathy.browser.desktop");
// Every session, worker and service worker presents Chrome's reduced user agent.
app.userAgentFallback = chromeUserAgent(
  app.userAgentFallback,
  process.versions.chrome,
  (message) => console.warn(message),
);
// Agents on this computer find Kamapathy through this profile's agent folder.
const agent = agentPaths(app.getPath("userData"));

let window: BrowserWindow | null = null;
let controller: BrowserController | null = null;
// The person's extensions, from ready on and across windows. Windows wait
// until extensions.json is read.
let extensionHost: ExtensionHost | null = null;
let extensionsReady: Promise<void> = Promise.resolve();
// The path between extension contexts and the main process. It exists before
// any session attaches, so the preloads are registered before loads.
let extensionChannel: ExtensionChannel | null = null;
// The spaces and tabs extensions see as windows and tabs. It binds to each
// window's controller.
let extensionBridge: ExtensionBridge | null = null;
// The action popups and the windows extensions open for their own pages.
let extensionPopups: ExtensionPopups | null = null;
// Adds extensions the person asked for, one install at a time.
let extensionInstaller: ExtensionInstaller | null = null;
// The daily Chrome Web Store check, while the person leaves it on.
let extensionUpdates: ExtensionUpdates | null = null;
// The shell's view of the person's extensions, and its commands.
let extensionIpc: ExtensionIpc | null = null;
// A window waiting for its extensions; later calls share it.
let windowOpening: Promise<void> | null = null;
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
let updater: Updater | null = null;
let updaterStarted = false;
// A quit the person has answered: the question is asked once.
let quitConfirmed = false;
// Closing the window keeps agents working, so the window and the application
// no longer end together.
const background = new BackgroundService({
  window: () => window,
  controller: () => controller,
  serviceRunning: () => !!automation,
  quitting: () => quitting,
  show: () => {
    if (!window) createWindow();
    else background.leaveBackground();
  },
  agent,
});
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
// Set up agents and the skill it gives them, both built once the app is
// ready.
let agentSetup: AgentSetup | null = null;
let bundledSkill: string | null = null;
let skillRefreshed = false;

function agentSetupEnvironment(): SetupEnvironment {
  // Development reads the checkout's skill.
  const skill = externalApplication
    ? join(moduleDirectory, "../../skills/kamapathy")
    : join(process.resourcesPath, "skills/kamapathy");
  const home = homedir();
  let accountHome = home;
  let shell = process.env.SHELL || "/bin/sh";
  // The account's own home ignores HOME, so a test profile changes agents
  // only under a temporary HOME.
  try {
    const account = userInfo();
    accountHome = account.homedir;
    shell = account.shell || shell;
  } catch {}
  return {
    platform: process.platform,
    home,
    accountHome,
    env: process.env,
    testProfile: Boolean(process.env.KAMAPATHY_USER_DATA),
    bundledSkill: existsSync(join(skill, "SKILL.md")) ? skill : null,
    version,
    shell: process.platform === "win32" ? null : shell,
    run: execRunner,
  };
}

// Once per process, after the first window shows. It changes only a setup
// the person chose.
function refreshAgentSkill(): void {
  if (skillRefreshed || !agentSetup) return;
  skillRefreshed = true;
  void agentSetup.refresh().catch((error) => {
    controller?.addActivity(
      undefined,
      "Kamapathy could not update the agent skill. Open Set up agents to check it.",
      "warning",
    );
    console.error(
      "Agent skill refresh failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
  });
}

// Electron passes a rejection on as "<name>: <message>" and the bridge removes
// only "Error: ", so a setup failure travels as a plain Error.
function plainError(error: unknown): never {
  throw error instanceof SetupError ? new Error(error.message) : error;
}

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
          automation = await startAutomation(owner, {
            socketPath,
            skillPath: bundledSkill ?? undefined,
            updates: updater ?? undefined,
          });
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
    // The running server follows the Page scripts switch, so turning it off
    // fails the script calls in flight.
    automation?.setPageScripts(
      controller?.state.settings.agentPageScripts !== false,
    );
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

async function createWindow(): Promise<void> {
  windowOpening ??= openWindow().finally(() => {
    windowOpening = null;
  });
  return windowOpening;
}

// Extensions load into these sessions before the controller sets their
// handlers, so until then they refuse every permission.
function extensionSession(partition: string): Session {
  const browsingSession = session.fromPartition(partition);
  browsingSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  browsingSession.setPermissionCheckHandler(() => false);
  return browsingSession;
}

async function openWindow(): Promise<void> {
  await extensionsReady;
  const platform: BrowserState["platform"] =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "win32"
        : "linux";
  const statePath = join(app.getPath("userData"), "browser-state.json");
  const state = readState(statePath, platform, version);
  extensionUpdates?.setEnabled(state.settings.extensionUpdates);
  const host = extensionHost;
  if (host) {
    await host.setDeveloperMode(state.settings.extensionDeveloperMode);
    // Restored tabs open with their extensions, unless loading takes longer.
    await host.attachAll(restoredPartitions(state), 5000, extensionSession);
  }
  if (quitting || window) return;
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
  controller = new BrowserController(
    currentWindow,
    state,
    statePath,
    { framePreload: join(moduleDirectory, "../preload/forms.cjs") },
    host ?? NO_EXTENSIONS,
  );
  const currentController = controller;
  const unbindBridge = extensionBridge?.bind(currentController);
  currentController.subscribe((next) => {
    extensionPopups?.onState(next);
    // The shown tab decides which buttons the toolbar draws.
    extensionIpc?.push();
    extensionUpdates?.setEnabled(next.settings.extensionUpdates);
    if (host && next.settings.extensionDeveloperMode !== host.developerMode)
      void host.setDeveloperMode(next.settings.extensionDeveloperMode);
    void syncAutomation();
    updater?.settingsChanged();
  });
  const currentForms =
    vault &&
    connectForms(currentController, currentWindow, vault, {
      openManager: () => shortcut("passwords"),
    });
  forms = currentForms;
  // A window built later shows what the updater already knows. The first one
  // keeps its saved record, which the updater reads when it starts.
  if (updater && updaterStarted) currentController.setUpdate(updater.state);
  // The tray, the Dock menu and the badge follow the same state the window
  // shows.
  currentController.subscribe(() => background.update());
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
  currentWindow.once("ready-to-show", () => {
    currentWindow.show();
    refreshAgentSkill();
  });
  // Windows ends the session through the window, not the application.
  currentWindow.on("session-end", () => background.shuttingDown());
  currentWindow.on("close", (event) => {
    // The person's pages close either way; with agents at work the window
    // only goes away.
    if (background.hidesOnClose()) {
      event.preventDefault();
      background.enterBackground();
      return;
    }
    currentForms?.dispose();
    currentController.dispose();
  });
  currentWindow.on("closed", () => {
    unbindBridge?.();
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

// One import at a time. Its failures resolve as values, since the bridge
// would keep only an Error's message.
async function importReply(
  run: () => Promise<ImportOutcome>,
): Promise<ImportReply> {
  try {
    return await exclusive(run);
  } catch (error) {
    if (!(error instanceof ImportError)) throw error;
    return {
      error: { code: error.code, message: error.message, ...error.fields },
    };
  }
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
  ipcMain.handle("kamapathy:import", (event, request: unknown) => {
    const owner = validateSender(event);
    return importReply(() => runImport(owner, parseImportRequest(request)));
  });
  // The export file the person chose, up to SAFARI_ARCHIVE_LIMIT.
  ipcMain.handle(
    "kamapathy:import-safari",
    (event, bytes: unknown, options: unknown) => {
      const owner = validateSender(event);
      return importReply(() => runSafariImport(owner, bytes, options));
    },
  );
  // Opens the macOS privacy pane where the person lets Kamapathy read
  // another browser's data.
  ipcMain.on("kamapathy:open-import-permissions", (event, options: unknown) => {
    try {
      validateSender(event);
    } catch {
      return;
    }
    const pane = (options as { pane?: unknown } | null)?.pane;
    const privacy =
      pane === "full-disk"
        ? "Privacy_AllFiles"
        : pane === "files-folders"
          ? "Privacy_FilesAndFolders"
          : undefined;
    if (process.platform !== "darwin" || !privacy) return;
    void shell
      .openExternal(
        `x-apple.systempreferences:com.apple.preference.security?${privacy}`,
      )
      .catch(() => undefined);
  });
  ipcMain.handle("kamapathy:default-browser", (event) => {
    validateSender(event);
    return defaultBrowserStatus(electronDefaultBrowserEnv());
  });
  // Runs only while Kamapathy can become the default browser.
  ipcMain.handle("kamapathy:make-default-browser", async (event) => {
    validateSender(event);
    await makeDefaultBrowser(electronDefaultBrowserEnv());
  });
  // Its own channel, not an action: an answer may carry a password, which
  // never belongs in the action log or in the state an action returns.
  ipcMain.handle("kamapathy:answer-prompt", (event, answer: PromptAnswer) => {
    const owner = validateSender(event);
    if (!answer || typeof answer !== "object" || typeof answer.id !== "string")
      throw new Error("Invalid prompt answer.");
    owner.prompts.answer(answer);
  });
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
    files: {
      async choose() {
        if (!window || window.isDestroyed()) return undefined;
        const chosen = await dialog.showOpenDialog(window, {
          properties: ["openFile"],
          filters: [{ name: "CSV files", extensions: ["csv"] }],
        });
        return chosen.canceled ? undefined : chosen.filePaths[0];
      },
      size: async (path) => (await stat(path)).size,
      read: (path) => readFile(path),
      async saveTo(defaultPath) {
        if (!window || window.isDestroyed()) return undefined;
        const chosen = await dialog.showSaveDialog(window, {
          defaultPath,
          filters: [{ name: "CSV files", extensions: ["csv"] }],
        });
        return chosen.canceled ? undefined : chosen.filePath;
      },
      write: (path, text) => writeCsvFile(path, text),
      trash: (path) => shell.trashItem(path),
    },
    // An export holds passwords in plain text, so it says so first.
    confirmExport: async () =>
      !!window &&
      !window.isDestroyed() &&
      (
        await dialog.showMessageBox(window, {
          type: "question",
          message: "Export passwords?",
          detail:
            "The file holds your passwords in plain text. Anyone who can open it can read them.",
          buttons: ["Export", "Cancel"],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        })
      ).response === 0,
    downloads: () => app.getPath("downloads"),
    exclusive,
  });
  // Set up agents.
  ipcMain.handle(
    "kamapathy:agent-setup-status",
    (event, options?: { probe?: unknown }) => {
      validateSender(event);
      return agentSetup!.status({ probe: options?.probe === true });
    },
  );
  ipcMain.handle("kamapathy:agent-setup-apply", (event, request: unknown) => {
    validateSender(event);
    return agentSetup!.apply(parseAgentSetupRequest(request)).catch(plainError);
  });
  ipcMain.handle("kamapathy:agent-setup-remove", (event) => {
    validateSender(event);
    return agentSetup!.remove().catch(plainError);
  });
  ipcMain.handle("kamapathy:copy-text", (event, text: unknown) => {
    validateSender(event);
    if (typeof text !== "string" || text.length > 4096)
      throw new Error("Invalid text.");
    clipboard.writeText(text);
  });
  // Only the main process knows which space was used last.
  ipcMain.handle(
    "kamapathy:help-space",
    (event) => validateSender(event).incomingSpace().id,
  );
  // Opening, installing, cancelling and quitting live only here, never on a
  // route an agent can reach.
  ipcMain.handle("kamapathy:update", async (event, command: unknown) => {
    validateSender(event);
    const current = updater!;
    const wanted = updateCommand(command);
    try {
      if (wanted.command === "check") await current.check();
      else if (wanted.command === "download") await current.download();
      else if (wanted.command === "cancel") await current.cancel();
      else if (wanted.command === "install") await current.install();
      else if (wanted.command === "show") current.showFile();
      else if (wanted.command === "copy-command") current.copyCommand();
      else if (wanted.command === "notes") await current.openNotes(wanted.which);
    } catch (error) {
      // A check or download failure is already part of the status.
      if (!(error instanceof UpdateFailure)) throw error;
    }
    return current.status();
  });
}

function updateCommand(value: unknown): UpdateCommand {
  const wanted = value as { command?: unknown; which?: unknown } | null;
  if (
    wanted?.command === "notes" &&
    (wanted.which === "running" || wanted.which === "latest")
  )
    return { command: "notes", which: wanted.which };
  if (
    wanted?.command === "check" ||
    wanted?.command === "download" ||
    wanted?.command === "cancel" ||
    wanted?.command === "install" ||
    wanted?.command === "show" ||
    wanted?.command === "copy-command"
  )
    return { command: wanted.command };
  throw new Error("Invalid update command.");
}

// The kind this copy installs, and the releases it reads. A source run may
// name a test feed and kind; a packaged build ignores both.
function createUpdater(): Updater {
  // The development runtime is a renamed Electron, so app.isPackaged alone is
  // true there too, as electron/move-to-applications.ts explains.
  const packaged = app.isPackaged && !externalApplication;
  const named = process.env.KAMAPATHY_UPDATE_KIND as InstallKind | undefined;
  const kind =
    !packaged && named && INSTALLER_KINDS.includes(named)
      ? named
      : installKind({
          platform: process.platform,
          arch: process.arch,
          translated: app.runningUnderARM64Translation,
          packaged,
          env: process.env,
          execPath: process.execPath,
        });
  const repo = repository(homepage);
  return new Updater({
    version,
    kind,
    source: repo
      ? updateSource(
          repo,
          !packaged ? process.env.KAMAPATHY_UPDATE_FEED : undefined,
        )
      : null,
    directory: join(app.getPath("userData"), "updates"),
    transport: netTransport(),
    online: () => net.isOnline(),
    now: () => Date.now(),
    timers: realTimers(),
    statfs: (path) => statfs(path),
    settings: () => ({
      updateChecks: controller?.state.settings.updateChecks ?? false,
    }),
    saved: () => ({
      checkedAt: controller?.state.update.checkedAt,
      latest: controller?.state.update.latest,
    }),
    publish: (next) => controller?.setUpdate(next),
    dispatch: (action) =>
      controller ? controller.dispatch(action) : Promise.resolve(),
    helpSpaceId: () => controller!.incomingSpace().id,
    openPath: (path) => shell.openPath(path),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    writeClipboard: (text) => clipboard.writeText(text),
    quit: () => app.quit(),
  });
}

// Help pages open as the person's tab in a personal space no agent can
// reach. A closed window comes back and shows once it is ready.
async function openLink(url: string): Promise<void> {
  try {
    if (!window) createWindow();
    else {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
    const owner = controller!;
    await owner.dispatch({
      type: "tab:create",
      url,
      spaceId: owner.incomingSpace().id,
    });
  } catch (error) {
    console.error(
      "Help page could not open:",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

function installMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate({
        darwin: process.platform === "darwin",
        appName: app.getName(),
        shell: () => window,
        send: shortcut,
        open: (url) => void openLink(url),
      }),
    ),
  );
}

// Links and files from other apps open in a personal space no agent can
// reach. They wait for the window, and a closed macOS window comes back.
const pendingIncoming: string[] = [];
const allowIncoming = incomingLimiter();

function deliverIncoming(urls: readonly string[]): void {
  if (!urls.length) return;
  if (!app.isReady()) {
    pendingIncoming.push(...urls);
    return;
  }
  try {
    if (!window) createWindow();
    controller?.openIncoming(urls);
  } catch (error) {
    console.error(
      "Links from other apps could not open:",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
}

// macOS hands them over as events, from before ready on.
function receiveIncoming(event: Electron.Event, value: string): void {
  event.preventDefault();
  if (!allowIncoming()) return;
  const url = incomingItem(value, process.cwd());
  if (url) deliverIncoming([url]);
}
app.on("open-url", receiveIncoming);
app.on("open-file", receiveIncoming);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", async (_event, argv, workingDirectory) => {
    if (!window) await createWindow();
    else background.leaveBackground();
    if (window?.isMinimized()) window.restore();
    window?.focus();
    deliverIncoming(
      incomingItems(argv, workingDirectory, {
        defaultApp: externalApplication,
      }),
    );
  });
  // A page's sign-in belongs to its own tab, which answers it in the prompt
  // bar; one without a page has nobody to ask.
  app.on("login", (event, contents, _details, _authInfo, callback) => {
    if (contents) return;
    event.preventDefault();
    if (controller) controller.prompts.appLogin(callback);
    else callback();
  });
  app.on("select-client-certificate", (event, contents, url, list, callback) => {
    // Without this Electron sends the first certificate in the store.
    event.preventDefault();
    if (controller)
      controller.prompts.selectClientCertificate(contents, url, list, callback);
    else callback();
  });
  app.on("before-quit", (event) => {
    // A quit that would stop agents at work asks first. The answer comes back
    // after this handler, so the second quit is the one that ends Kamapathy.
    if (!quitConfirmed && background.needsQuestion()) {
      event.preventDefault();
      void background.confirmQuit().then((confirmed) => {
        if (!confirmed) return;
        quitConfirmed = true;
        app.quit();
      });
      return;
    }
    quitting = true;
    // Closing the service may not finish before exit; stop advertising it now.
    try {
      withdrawEndpoint(agent);
    } catch {}
    controller?.dispose();
    void updater?.stop();
    extensionPopups?.dispose();
    extensionIpc?.dispose();
    void syncAutomation();
    // Times saved logins were last used are written in batches.
    void vault?.flush();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("activate", () => {
    if (!window) void createWindow();
    else background.leaveBackground();
  });
  void app.whenReady().then(async () => {
    if (
      (await maybeMoveToApplications({
        app,
        dialog,
        platform: process.platform,
        execPath: process.execPath,
        defaultApp: externalApplication,
      })) === "moved"
    )
      return;
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
    // Downloads an agent held are never kept across starts, so a crash
    // leaves nothing behind.
    clearDownloadFolder(app.getPath("userData"));
    // A shutdown or a logout is not a quit the person can answer: Kamapathy
    // neither asks nor stays behind. powerMonitor is ready only now.
    powerMonitor.on("shutdown", () => background.shuttingDown());
    try {
      // A crash leaves the last endpoint behind; record how agents can start
      // this Kamapathy again.
      prepareAgentDirectory(agent);
      clearStaleEndpoint(agent);
      // Kamapathy is running again, so the person's last quit no longer
      // stands in an agent's way.
      clearQuitMarker(agent);
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
    const setupEnvironment = agentSetupEnvironment();
    bundledSkill = setupEnvironment.bundledSkill;
    agentSetup = createAgentSetup(setupEnvironment);
    registerIpc();
    installMenu();
    // Before the window, so the agent service it starts already has it.
    updater = createUpdater();
    createWindow();
    updaterStarted = true;
    void updater.start();
    extensionHost = new ExtensionHost({
      userData: app.getPath("userData"),
      locale: app.getLocale(),
      chromeVersion: process.versions.chrome,
    });
    extensionsReady = extensionHost.init().catch((error) => {
      console.error(
        "Extensions could not be prepared:",
        error instanceof Error ? error.message : "Unknown error",
      );
    });
    const extensions = extensionHost;
    // Pages of an extension that runs in no session any more close.
    extensions.onEvent((event) => {
      if (
        event.type !== "unloaded" ||
        extensions
          .partitions()
          .some((partition) => extensions.isLoaded(partition, event.id))
      )
        return;
      controller?.closeExtensionPages(event.id);
    });
    extensionChannel = new ExtensionChannel({
      host: extensionHost,
      preloads: {
        page: join(moduleDirectory, "../preload/extension-page.cjs"),
        worker: join(moduleDirectory, "../preload/extension-worker.cjs"),
      },
      surfaceOf: (contents) =>
        controller?.tabOfContents(contents)
          ? "tab"
          : extensionHost?.surfaceOf(contents)?.kind,
    });
    extensionBridge = new ExtensionBridge({
      host: extensionHost,
      channel: extensionChannel,
    });
    const bridge = extensionBridge;
    extensionPopups = new ExtensionPopups({
      host: extensionHost,
      window: () => window,
      // A popup's web links become tabs in a space of the person's.
      openLink: (url, from) => {
        try {
          bridge.openTab(
            {
              extensionId: from.extensionId,
              partition: from.partition,
              surface: "popup",
            },
            url,
            {
              windowId: from.spaceId
                ? bridge.windowIdOf(from.spaceId)
                : undefined,
            },
          );
        } catch (error) {
          console.error(
            "An extension could not open a tab:",
            error instanceof Error ? error.message : "Unknown error",
          );
        }
      },
    });
    bridge.setPopups(extensionPopups);
    extensionInstaller = new ExtensionInstaller({
      host: extensionHost,
      // An in-memory session with no cookies, used by no tab.
      fetcher: sessionFetcher(session.fromPartition(STORE_PARTITION)),
      env: storeEnv(),
      locale: app.getLocale(),
      confirm: confirmAdd(() => window),
      chooseFolder: chooseFolder(() => window),
    });
    extensionUpdates = new ExtensionUpdates({
      host: extensionHost,
      installer: extensionInstaller,
      fetcher: sessionFetcher(session.fromPartition(STORE_PARTITION)),
      env: storeEnv(),
      pagesOpen: (id) =>
        (controller?.extensionPageTabs(id).length ?? 0) > 0 ||
        (extensionHost?.surfacesOf(id).length ?? 0) > 0,
      confirm: confirmAdd(() => window),
    });
    const installer = extensionInstaller;
    const updates = extensionUpdates;
    extensionIpc = registerExtensionIpc({
      ipc: ipcMain,
      validateSender,
      window: () => window,
      controller: () => controller,
      host: extensions,
      installer,
      updates,
      bridge,
      confirmRemove: confirmRemove(() => window),
    });
    const pushExtensions = () => extensionIpc?.push();
    extensions.onEvent(pushExtensions);
    installer.onChange(pushExtensions);
    updates.onChange(pushExtensions);
    bridge.onToolbarChange(pushExtensions);
    await createWindow();
    deliverIncoming([
      ...pendingIncoming.splice(0),
      ...incomingItems(process.argv, process.cwd(), {
        defaultApp: externalApplication,
      }),
    ]);
  });
}
