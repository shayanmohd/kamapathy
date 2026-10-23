import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { app, dialog, Menu, Notification } from "electron";
import {
  BACKGROUND_NOTICE,
  BackgroundService,
  TRAY_COPY,
  type BackgroundHost,
} from "../electron/background";
import { agentBarCopy, statusCopy } from "../src/copy";
import { BrowserController } from "../electron/controller";
import { agentPaths } from "../electron/agent-socket";
import { HOME_URL, initialState } from "../shared/state";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  WebContentsView: vi.fn(function () {
    return new FakePageView();
  }),
  Notification: Object.assign(
    vi.fn(function (options: { title: string; body: string }) {
      return new FakeNotification(options);
    }),
    { isSupported: vi.fn(() => true) },
  ),
  nativeTheme: { themeSource: "system" },
  session: { fromPartition: vi.fn(() => new FakeSession()) },
  dialog: { showMessageBox: vi.fn(), showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(async () => {}) },
  app: { quit: vi.fn(), dock: { setMenu: vi.fn(), setBadge: vi.fn() } },
  Menu: {
    buildFromTemplate: vi.fn((template: FakeMenuItem[]) => ({ template })),
  },
  Tray: vi.fn(function (image: { path: string }) {
    return new FakeTray(image);
  }),
  nativeImage: { createFromPath: vi.fn((path: string) => ({ path })) },
}));
vi.mock("../electron/persistence", async (original) => ({
  ...(await original<typeof import("../electron/persistence")>()),
  writeState: vi.fn(),
}));

class FakeSession extends EventEmitter {
  setPermissionCheckHandler = vi.fn();
  setPermissionRequestHandler = vi.fn();
}
class FakePage extends EventEmitter {
  closed = false;
  focus = vi.fn();
  send = vi.fn();
  setWindowOpenHandler = vi.fn();
  setBackgroundThrottling = vi.fn();
  setZoomLevel = vi.fn();
  reload = vi.fn();
  loadURL = vi.fn(async () => {});
  capturePage = vi.fn(async () => ({ isEmpty: () => true }));
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  getURL = () => "";
  getZoomLevel = () => 0;
  isDestroyed = () => this.closed;
  close = vi.fn(() => {
    this.closed = true;
  });
  beginFrameSubscription = vi.fn();
  endFrameSubscription = vi.fn();
}
class FakePageView {
  webContents = new FakePage();
  private shown = false;
  setVisible = (value: boolean) => {
    this.shown = value;
  };
  getVisible = () => this.shown;
  setBounds = vi.fn();
  getBounds = () => ({ x: 0, y: 0, width: 1000, height: 700 });
  setBorderRadius = vi.fn();
}
const notices: FakeNotification[] = [];
class FakeNotification {
  private readonly handlers = new Map<string, () => void>();
  show = vi.fn();
  on = vi.fn((event: string, handler: () => void) => {
    this.handlers.set(event, handler);
    return this;
  });
  click = () => this.handlers.get("click")?.();
  constructor(readonly options: { title: string; body: string }) {
    notices.push(this);
  }
}
interface FakeMenuItem {
  label?: string;
  type?: string;
  click?: () => void;
}
const trays: FakeTray[] = [];
class FakeTray {
  private readonly handlers = new Map<string, () => void>();
  image: string;
  tooltip = "";
  menu: unknown = null;
  destroyed = false;
  constructor(image: { path: string }) {
    this.image = image.path;
    trays.push(this);
  }
  setImage = vi.fn((image: { path: string }) => {
    this.image = image.path;
  });
  setToolTip = vi.fn((text: string) => {
    this.tooltip = text;
  });
  setContextMenu = vi.fn((menu: unknown) => {
    this.menu = menu;
  });
  on = vi.fn((event: string, handler: () => void) => {
    this.handlers.set(event, handler);
    return this;
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
  isDestroyed = () => this.destroyed;
  click = () => this.handlers.get("click")?.();
}
const templateOf = (menu: unknown): FakeMenuItem[] =>
  (menu as { template: FakeMenuItem[] }).template;
const labelsOf = (menu: unknown): (string | undefined)[] =>
  templateOf(menu)
    .filter((item) => item.label)
    .map((item) => item.label);
const chooseIn = (menu: unknown, label: string): void => {
  const item = templateOf(menu).find((entry) => entry.label === label);
  expect(item?.click).toBeTypeOf("function");
  item!.click!();
};
const lastDockMenu = (): unknown => {
  const calls = vi.mocked(app.dock!.setMenu).mock.calls;
  return calls[calls.length - 1][0];
};

describe("running in the background", () => {
  let controller: BrowserController;
  let window: EventEmitter & Record<string, any>;
  let host: BackgroundHost;
  let running: boolean;
  let quitting: boolean;
  const viewsOf = (spaceId: string) =>
    controller.state.tabs
      .filter((tab) => tab.spaceId === spaceId)
      .map((tab) => controller.peekWebContents(tab.id))
      .filter((contents) => !!contents);
  let clock = 0;
  const resources = "/res/tray";
  const service = (platform: NodeJS.Platform) =>
    new BackgroundService(host, { platform, resources, now: () => clock });
  beforeEach(() => {
    vi.clearAllMocks();
    notices.length = 0;
    trays.length = 0;
    clock = Date.now();
    vi.mocked(Notification.isSupported).mockReturnValue(true);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 0,
      checkboxChecked: false,
    });
    running = true;
    quitting = false;
    window = new EventEmitter() as EventEmitter & Record<string, any>;
    window.webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      focus: vi.fn(),
      isDestroyed: () => false,
    });
    window.contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    window.isDestroyed = () => false;
    window.getContentSize = () => [1400, 900];
    window.visible = true;
    window.isVisible = () => window.visible;
    window.isMinimized = () => false;
    window.restore = vi.fn();
    window.hide = vi.fn(() => {
      window.visible = false;
    });
    window.show = vi.fn(() => {
      window.visible = true;
    });
    controller = new BrowserController(
      window as unknown as BrowserWindow,
      initialState(),
      "unused-test-state.json",
    );
    controller.setContentBounds({
      x: 248,
      y: 82,
      width: 1000,
      height: 700,
      hidden: false,
    });
    host = {
      window: () => window as unknown as BrowserWindow,
      controller: () => controller,
      serviceRunning: () => running,
      quitting: () => quitting,
      show: vi.fn(),
      agent: agentPaths("/tmp/kamapathy-background-test"),
    };
  });
  afterEach(() => {
    controller.dispose();
  });

  it("close hides by the platform rules", () => {
    const platforms: NodeJS.Platform[] = ["darwin", "win32", "linux"];
    const services = platforms.map((platform) => service(platform));
    const [mac, windows, linux] = services;
    // macOS keeps Kamapathy running whenever an agent could connect.
    expect(mac.hidesOnClose()).toBe(true);
    expect(windows.hidesOnClose()).toBe(false);
    expect(linux.hidesOnClose()).toBe(false);
    // A space an agent may use keeps the other platforms running.
    const space = controller.createAgentSpace("Research");
    expect(windows.hidesOnClose()).toBe(true);
    expect(linux.hidesOnClose()).toBe(true);
    // A space whose access ended holds nothing open: no agent can work in it.
    controller.endAccess(space.id, { by: "agent", reason: "finished" });
    expect(windows.hidesOnClose()).toBe(false);
    expect(mac.hidesOnClose()).toBe(true);
    // A granted personal space counts, as an agent may use it.
    controller.grantAccess("work");
    expect(windows.hidesOnClose()).toBe(true);
    expect(linux.hidesOnClose()).toBe(true);
    // Agent access off, or no service, closes as it always did.
    controller.state.settings.automationEnabled = false;
    for (const item of services) expect(item.hidesOnClose()).toBe(false);
    controller.state.settings.automationEnabled = true;
    running = false;
    for (const item of services) expect(item.hidesOnClose()).toBe(false);
    running = true;
    // A quit, and a shutdown, close for real.
    quitting = true;
    for (const item of services) expect(item.hidesOnClose()).toBe(false);
    quitting = false;
    expect(mac.hidesOnClose()).toBe(true);
    mac.shuttingDown();
    expect(mac.hidesOnClose()).toBe(false);
    for (const item of services) item.dispose();
  });

  it("hiding closes personal views, keeps agent views and honors Restore tabs", async () => {
    const agent = controller.createAgentSpace("Research");
    const agentTab = controller.openAgentTab(agent.id, "https://example.com/");
    controller.grantAccess("work");
    await controller.dispatch({
      type: "tab:create",
      spaceId: "work",
      url: "https://example.org/",
      background: true,
    });
    const own = controller.state.tabs.find(
      (tab) => tab.spaceId === "personal",
    )!;
    await controller.dispatch({
      type: "tab:navigate",
      id: own.id,
      url: "https://example.net/",
    });
    const personalPage = controller.peekWebContents(own.id);
    expect(personalPage).toBeTruthy();
    const background = service("darwin");
    background.enterBackground();
    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(background.hidden()).toBe(true);
    // The person's own pages go, so nothing of theirs runs unseen.
    expect(personalPage!.isDestroyed()).toBe(true);
    expect(viewsOf("personal")).toEqual([]);
    // Spaces an agent may use keep their pages.
    expect(controller.peekWebContents(agentTab.id)).toBeTruthy();
    expect(viewsOf("work")).toHaveLength(1);
    // Restore tabs on leaves the saved tabs in place.
    expect(
      controller.state.tabs.filter((tab) => tab.spaceId === "personal"),
    ).toEqual([
      expect.objectContaining({ id: own.id, url: "https://example.net/" }),
    ]);
    expect(controller.state.activeTabId).toBe(own.id);
    // The socket and the controller are untouched: the window comes back.
    background.leaveBackground();
    expect(background.hidden()).toBe(false);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(controller.peekWebContents(own.id)).toBeTruthy();
    // With Restore tabs off each closed space keeps one new tab, as the next
    // start would give it.
    controller.state.settings.restoreSession = false;
    background.enterBackground();
    const replacements = controller.state.tabs.filter(
      (tab) => tab.spaceId === "personal",
    );
    expect(replacements).toHaveLength(1);
    expect(replacements[0].id).not.toBe(own.id);
    expect(replacements[0].url).toBe(HOME_URL);
    expect(controller.state.activeTabId).toBe(replacements[0].id);
    expect(controller.shownTab("personal")?.id).toBe(replacements[0].id);
    expect(
      controller.state.tabs.filter((tab) => tab.spaceId === "work"),
    ).toHaveLength(2);
    expect(controller.peekWebContents(agentTab.id)).toBeTruthy();
    background.dispose();
  });

  it("the background notice shows once per profile and falls back to activity when notifications are unsupported", () => {
    const background = service("darwin");
    background.enterBackground();
    expect(notices).toHaveLength(1);
    expect(notices[0].options).toEqual({
      title: BACKGROUND_NOTICE.title,
      body: BACKGROUND_NOTICE.darwin,
    });
    expect(notices[0].show).toHaveBeenCalledTimes(1);
    expect(controller.state.settings.backgroundNoticeShown).toBe(true);
    // Once per profile: a later hide says nothing.
    background.leaveBackground();
    background.enterBackground();
    expect(notices).toHaveLength(1);
    background.dispose();
    // Each platform says how to stop the agents it has.
    for (const [platform, body] of [
      ["win32", BACKGROUND_NOTICE.body],
      ["linux", BACKGROUND_NOTICE.linux],
    ] as const) {
      notices.length = 0;
      controller.state.settings.backgroundNoticeShown = false;
      const other = service(platform);
      other.enterBackground();
      expect(notices[0].options).toEqual({
        title: BACKGROUND_NOTICE.title,
        body,
      });
      other.dispose();
    }
    // Without notifications the same words become one activity entry.
    notices.length = 0;
    controller.state.settings.backgroundNoticeShown = false;
    vi.mocked(Notification.isSupported).mockReturnValue(false);
    const quiet = service("darwin");
    quiet.enterBackground();
    expect(notices).toHaveLength(0);
    expect(controller.state.activity[0]).toMatchObject({
      message: `${BACKGROUND_NOTICE.title}. ${BACKGROUND_NOTICE.darwin}`,
      kind: "info",
    });
    expect(controller.state.settings.backgroundNoticeShown).toBe(true);
    const entries = controller.state.activity.length;
    quiet.leaveBackground();
    quiet.enterBackground();
    expect(controller.state.activity).toHaveLength(entries);
    quiet.dispose();
  });

  it("menus escape ampersands on Windows, Stop all agents asks first, and hidden-window notifications fire once per change", async () => {
    controller.state.settings.backgroundNoticeShown = true;
    const deals = controller.createAgentSpace("Deals & more");
    controller.openAgentTab(deals.id, "https://example.com/");
    // Past the moment opening that page counts as a recent agent action.
    clock += 6000;
    const windows = service("win32");
    windows.enterBackground();
    expect(labelsOf(trays[0].menu)).toEqual([
      `“Deals && more” · ${statusCopy.idle}`,
      TRAY_COPY.open,
      TRAY_COPY.stopAll,
      TRAY_COPY.quit,
    ]);
    windows.dispose();
    // Only Windows doubles the ampersand.
    const linux = service("linux");
    linux.enterBackground();
    expect(labelsOf(trays[1].menu)[0]).toBe(
      `“Deals & more” · ${statusCopy.idle}`,
    );
    linux.dispose();
    // The Dock menu carries the spaces and Stop all agents, and no tray.
    const mac = service("darwin");
    mac.enterBackground();
    expect(trays).toHaveLength(2);
    expect(labelsOf(lastDockMenu())).toEqual([
      `“Deals & more” · ${statusCopy.idle}`,
      TRAY_COPY.stopAll,
    ]);
    // At most ten spaces, newest first.
    for (let index = 1; index <= 11; index += 1) {
      const space = controller.createAgentSpace(`Space ${index}`);
      if (index >= 10) controller.openAgentTab(space.id);
    }
    clock += 6000;
    mac.update();
    expect(labelsOf(lastDockMenu())).toEqual([
      ...Array.from(
        { length: 10 },
        (_, index) => `“Space ${11 - index}” · ${statusCopy.idle}`,
      ),
      TRAY_COPY.stopAll,
    ]);
    // Choosing a space shows the window on it and changes nothing else.
    const tenth = controller.state.spaces.find(
      (space) => space.name === "Space 10",
    )!;
    const eleventh = controller.state.spaces.find(
      (space) => space.name === "Space 11",
    )!;
    chooseIn(lastDockMenu(), `“Space 10” · ${statusCopy.idle}`);
    await vi.waitFor(() =>
      expect(controller.state.activeSpaceId).toBe(tenth.id),
    );
    expect(host.show).toHaveBeenCalledTimes(1);
    expect(tenth.owner).toBe("agent");
    expect(controller.state.settings.automationEnabled).toBe(true);
    // A space that turns needs-you while hidden is announced once.
    controller.setTask(eleventh.id, {
      state: "needs-you",
      reason: "Sign in to continue",
    });
    clock += 600;
    mac.update();
    expect(notices).toHaveLength(1);
    expect(notices[0].options).toEqual({
      title: TRAY_COPY.needsYou,
      body: "“Space 11” · Sign in to continue",
    });
    expect(notices[0].show).toHaveBeenCalledTimes(1);
    clock += 600;
    mac.update();
    expect(notices).toHaveLength(1);
    // Clicking it shows the window on that space.
    notices[0].click();
    await vi.waitFor(() =>
      expect(controller.state.activeSpaceId).toBe(eleventh.id),
    );
    expect(host.show).toHaveBeenCalledTimes(2);
    // A failure is announced with the agent's own words, quoted.
    controller.setTask(eleventh.id, {
      state: "failed",
      status: "The site needs a phone number",
    });
    clock += 600;
    mac.update();
    expect(notices).toHaveLength(2);
    expect(notices[1].options).toEqual({
      title: TRAY_COPY.failed,
      body: "“Space 11” · “The site needs a phone number”",
    });
    // Done says nothing.
    controller.setTask(eleventh.id, { state: "done" });
    clock += 600;
    mac.update();
    expect(notices).toHaveLength(2);
    // Nor does a change the person was there to see.
    mac.leaveBackground();
    controller.setTask(tenth.id, {
      state: "needs-you",
      reason: "Choose a size",
    });
    clock += 600;
    mac.update();
    clock += 600;
    mac.enterBackground();
    expect(notices).toHaveLength(2);
    // Stop all agents asks before it turns agent access off.
    chooseIn(lastDockMenu(), TRAY_COPY.stopAll);
    await vi.waitFor(() => expect(dialog.showMessageBox).toHaveBeenCalled());
    expect(controller.state.settings.automationEnabled).toBe(true);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 1,
      checkboxChecked: false,
    });
    chooseIn(lastDockMenu(), TRAY_COPY.stopAll);
    await vi.waitFor(() =>
      expect(controller.state.settings.automationEnabled).toBe(false),
    );
    // The hidden window carries no dialog, so the question stands alone.
    const question = vi
      .mocked(dialog.showMessageBox)
      .mock.calls[0].at(-1) as Electron.MessageBoxOptions;
    expect(question.buttons).toEqual([
      agentBarCopy.cancel,
      agentBarCopy.stopAll,
    ]);
    mac.dispose();
  });

  it("the tray appears only while hidden on Windows and Linux, with a working count and an attention icon", async () => {
    controller.state.settings.backgroundNoticeShown = true;
    const research = controller.createAgentSpace("Research");
    controller.openAgentTab(research.id, "https://example.com/");
    const prices = controller.createAgentSpace("Prices");
    controller.openAgentTab(prices.id, "https://example.org/");
    clock += 6000;
    const windows = service("win32");
    // A window on screen needs no tray and no menu.
    windows.update();
    expect(trays).toHaveLength(0);
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
    windows.enterBackground();
    expect(trays).toHaveLength(1);
    const tray = trays[0];
    expect(tray.image).toBe(join(resources, "tray.png"));
    expect(tray.tooltip).toBe(TRAY_COPY.working(2));
    expect(labelsOf(tray.menu)).toContain(TRAY_COPY.open);
    // A burst of changes rebuilds once, and the last of them still lands.
    const builds = vi.mocked(Menu.buildFromTemplate).mock.calls.length;
    windows.update();
    windows.update();
    expect(vi.mocked(Menu.buildFromTemplate).mock.calls).toHaveLength(builds);
    await vi.waitFor(
      () =>
        expect(vi.mocked(Menu.buildFromTemplate).mock.calls).toHaveLength(
          builds + 1,
        ),
      { timeout: 2000 },
    );
    // A space that needs the person leaves the count and raises the icon.
    controller.setTask(research.id, {
      state: "needs-you",
      reason: "Sign in to continue",
    });
    clock += 600;
    windows.update();
    expect(tray.tooltip).toBe(TRAY_COPY.working(1));
    expect(tray.image).toBe(join(resources, "tray-attention.png"));
    expect(app.dock!.setBadge).not.toHaveBeenCalled();
    // A click brings the window back, and the window drops the tray.
    tray.click();
    expect(host.show).toHaveBeenCalledTimes(1);
    windows.leaveBackground();
    expect(tray.destroy).toHaveBeenCalledTimes(1);
    expect(trays).toHaveLength(1);
    windows.dispose();
    // macOS keeps no tray: the Dock carries the menu and the count.
    const mac = service("darwin");
    clock += 600;
    mac.enterBackground();
    expect(trays).toHaveLength(1);
    expect(labelsOf(lastDockMenu())).toEqual([
      `“Prices” · ${statusCopy.idle}`,
      `“Research” · ${statusCopy["needs-you"]}`,
      TRAY_COPY.stopAll,
    ]);
    expect(app.dock!.setBadge).toHaveBeenLastCalledWith("1");
    controller.setTask(research.id, null);
    clock += 600;
    mac.update();
    expect(app.dock!.setBadge).toHaveBeenLastCalledWith("");
    mac.dispose();
    // The icons the tray draws ship with the application.
    for (const [file, size] of [
      ["tray.png", 16],
      ["tray@2x.png", 32],
      ["tray-attention.png", 16],
      ["tray-attention@2x.png", 32],
    ] as const) {
      const bytes = readFileSync(
        new URL(`../build/tray/${file}`, import.meta.url),
      );
      expect(bytes.subarray(1, 4).toString()).toBe("PNG");
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([
        size,
        size,
      ]);
    }
  });
});
