import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, session } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserController } from "./controller";
import { menuTemplate } from "./menu";
import { readState } from "./persistence";
import { availableBrowsers, importFrom, type BrowserId } from "./import";
import { startAutomation } from "./agent/server";
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
  controller = new BrowserController(currentWindow, state, statePath);
  const currentController = controller;
  currentController.subscribe(() => {
    void syncAutomation();
  });
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
  currentWindow.once("ready-to-show", () => {
    currentWindow.show();
    refreshAgentSkill();
  });
  currentWindow.on("close", () => currentController.dispose());
  currentWindow.on("closed", () => {
    if (window === currentWindow) {
      window = null;
      controller = null;
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
    const setupEnvironment = agentSetupEnvironment();
    bundledSkill = setupEnvironment.bundledSkill;
    agentSetup = createAgentSetup(setupEnvironment);
    registerIpc();
    installMenu();
    createWindow();
  });
}
