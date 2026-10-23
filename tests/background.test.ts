import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { Notification } from "electron";
import {
  BACKGROUND_NOTICE,
  BackgroundService,
  type BackgroundHost,
} from "../electron/background";
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
  show = vi.fn();
  constructor(readonly options: { title: string; body: string }) {
    notices.push(this);
  }
}

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
  const service = (platform: NodeJS.Platform) =>
    new BackgroundService(host, { platform });
  beforeEach(() => {
    vi.clearAllMocks();
    notices.length = 0;
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
});
