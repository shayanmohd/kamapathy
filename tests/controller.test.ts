import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { BrowserWindow, Session } from "electron";
import {
  app,
  BaseWindow,
  clipboard,
  dialog,
  Menu,
  screen,
  session,
  shell,
  WebContentsView,
} from "electron";
import {
  BrowserController,
  restoredPartitions,
  type ExtensionSessions,
} from "../electron/controller";
import { inputMarker } from "../electron/agent/input/marker";
import { writeState } from "../electron/persistence";
import type { DefaultBrowserStatus, UpdateState } from "../shared/types";
import { PDF_VIEWER_ID } from "../electron/agent/session/frames";
import { ExtensionHost } from "../electron/extensions/host";
import { spaceTabs } from "../src/lib/tabs";
import {
  agentRules,
  HOME_URL,
  initialState,
  newTab,
  PAGE_BUDGET,
} from "../shared/state";
import type { ControllerOptions } from "../electron/controller";
import { fakePng, FakeDownloadItem } from "./fake-automation";

vi.mock("electron", () => ({
  app: { getApplicationNameForProtocol: vi.fn(() => "") },
  BaseWindow: vi.fn(function (options?: Record<string, unknown>) {
    return new FakeBaseWindow(options ?? {});
  }),
  BrowserWindow: vi.fn(),
  Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
  WebContentsView: vi.fn(function (options?: { webContents?: FakeContents }) {
    return new FakeView(options?.webContents);
  }),
  nativeImage: { createFromBuffer: vi.fn((png: Buffer) => fakeImageOf(png)) },
  screen: { getDisplayMatching: vi.fn(() => ({ scaleFactor: 2 })) },
  nativeTheme: { themeSource: "system" },
  session: {
    fromPartition: vi.fn((partition: string) => {
      if (!sessions.has(partition)) sessions.set(partition, new FakeSession());
      return sessions.get(partition)!;
    }),
  },
  webContents: {
    fromFrame: vi.fn(
      (frame: { contents?: FakeContents } | null) => frame?.contents ?? null,
    ),
  },
  dialog: {
    showMessageBox: vi.fn(),
    showMessageBoxSync: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(async () => {}) },
  clipboard: { writeText: vi.fn() },
}));
vi.mock("../electron/default-browser", () => ({
  defaultBrowserStatus: vi.fn(async () => defaultBrowser),
  electronDefaultBrowserEnv: vi.fn(() => ({})),
}));
vi.mock("../electron/persistence", async (original) => ({
  ...(await original<typeof import("../electron/persistence")>()),
  writeState: vi.fn(),
}));

class FakeSession extends EventEmitter {
  // Store builds sit in Extensions/<id>/<version>, so the folder names the id.
  extensions = {
    loadExtension: vi.fn(async (path: string) => ({
      id: basename(dirname(path)),
    })),
    removeExtension: vi.fn(),
  };
  setPermissionCheckHandler = vi.fn();
  setPermissionRequestHandler = vi.fn();
  setDevicePermissionHandler = vi.fn();
  setBluetoothPairingHandler = vi.fn();
  clearStorageData = vi.fn(async () => {});
  clearCache = vi.fn(async () => {});
  registered: Electron.PreloadScript[] = [];
  // Like Electron, registering an id twice on one session throws.
  registerPreloadScript = vi.fn(
    (script: Electron.PreloadScriptRegistration) => {
      const id = script.id ?? "random";
      if (this.registered.some((item) => item.id === id))
        throw new Error(
          `Cannot register preload script with existing ID '${id}'`,
        );
      this.registered.push({ ...script, id });
      return id;
    },
  );
  getPreloadScripts = vi.fn(() => this.registered);
  cookies = {
    set: vi.fn(async (_details: Electron.CookiesSetDetails) => {}),
    flushStore: vi.fn(async () => {}),
  };
}
interface FakeImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width: number }): FakeImage;
  toJPEG(quality: number): Buffer;
}
function fakeImage(width = 1000): FakeImage {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height: 700 }),
    resize: ({ width: next }) => fakeImage(next),
    toJPEG: () => Buffer.from(`jpeg-${width}`),
  };
}
const jpegOf = (width: number) =>
  `data:image/jpeg;base64,${Buffer.from(`jpeg-${width}`).toString("base64")}`;
let contentsIds = 0;
class FakeContents extends EventEmitter {
  id = ++contentsIds;
  url = "";
  destroyed = false;
  zoom = 0;
  pending: { url: string; reject: (reason: Error) => void }[] = [];
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  setWindowOpenHandler = vi.fn();
  setBackgroundThrottling = vi.fn();
  send = vi.fn();
  capturePage = vi.fn(
    async (_rect?: unknown, _options?: { stayHidden?: boolean }): Promise<FakeImage> =>
      fakeImage(),
  );
  focus = () => this.emit("focus");
  isDestroyed = () => this.destroyed;
  getURL = () => this.url;
  getZoomLevel = () => this.zoom;
  setZoomLevel = (value: number) => {
    this.zoom = value;
  };
  reload = vi.fn();
  reloadIgnoringCache = vi.fn();
  loadURL = vi.fn(
    (url: string) =>
      new Promise<void>((_resolve, reject) => {
        this.pending.push({ url, reject });
      }),
  );
  close() {
    // Chromium can finish stopping a navigation while a view is being closed.
    this.emit("did-stop-loading");
    this.destroyed = true;
  }
  commit(url: string) {
    this.url = url;
    this.emit("did-navigate", {}, url);
    this.emit("did-stop-loading");
  }
}
type Bounds = { x: number; y: number; width: number; height: number };
class FakeView {
  constructor(public webContents = new FakeContents()) {}
  visible = false;
  bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  setVisible = vi.fn((value: boolean) => {
    this.visible = value;
  });
  setBounds = vi.fn((value: Bounds) => {
    this.bounds = value;
  });
  setBorderRadius = vi.fn();
  getVisible() {
    return this.visible;
  }
  getBounds() {
    return this.bounds;
  }
}
// A View's children as Electron keeps them: addChildView appends or inserts
// at an index, and removeChildView takes a view out.
function contentViewFake() {
  const children: FakeView[] = [];
  return {
    children,
    addChildView: vi.fn((view: FakeView, index?: number) => {
      children.splice(index ?? children.length, 0, view);
    }),
    removeChildView: vi.fn((view: FakeView) => {
      const at = children.indexOf(view);
      if (at >= 0) children.splice(at, 1);
    }),
  };
}
// The never-shown window a capture lends a view to.
class FakeBaseWindow {
  contentView = contentViewFake();
  bounds: Bounds;
  size: number[];
  show = vi.fn();
  focus = vi.fn();
  destroy = vi.fn(() => {
    this.destroyed = true;
  });
  setContentSize = vi.fn((width: number, height: number) => {
    this.size = [width, height];
  });
  private destroyed = false;
  constructor(options: Record<string, unknown>) {
    this.bounds = {
      x: Number(options.x ?? 0),
      y: Number(options.y ?? 0),
      width: Number(options.width ?? 0),
      height: Number(options.height ?? 0),
    };
    this.size = [this.bounds.width, this.bounds.height];
  }
  setBounds(value: Bounds) {
    this.bounds = value;
    this.size = [value.width, value.height];
  }
  getBounds() {
    return this.bounds;
  }
  getContentSize() {
    return this.size;
  }
  isDestroyed() {
    return this.destroyed;
  }
}
// nativeImage over the fake PNGs, which carry only a size.
function fakeImageOf(png: Buffer) {
  const width = png.length >= 24 ? png.readUInt32BE(16) : 0;
  const height = png.length >= 24 ? png.readUInt32BE(20) : 0;
  return {
    isEmpty: () => !width || !height,
    getSize: () => ({ width, height }),
    crop: (area: { width: number; height: number }) =>
      fakeImageOf(fakePng(area.width, area.height)),
    toPNG: () => fakePng(width, height),
  };
}
const sessions = new Map<string, FakeSession>();
const controllers: BrowserController[] = [];
type WindowFake = EventEmitter & {
  webContents: FakeContents;
  contentView: ReturnType<typeof contentViewFake>;
  isDestroyed: () => boolean;
  getContentSize: () => number[];
  getBounds: () => Bounds;
  isVisible: () => boolean;
  isMinimized: () => boolean;
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  restore: ReturnType<typeof vi.fn>;
};
function controller(
  statePath = "unused-test-state.json",
  state = initialState(),
  options?: ControllerOptions,
  extensions?: ExtensionSessions,
) {
  const window = new EventEmitter() as WindowFake;
  window.webContents = new FakeContents();
  window.close = vi.fn();
  window.restore = vi.fn();
  window.show = vi.fn();
  window.focus = vi.fn();
  window.contentView = contentViewFake();
  window.isDestroyed = () => false;
  window.getContentSize = () => [1400, 900];
  window.getBounds = () => ({ x: 0, y: 0, width: 1400, height: 928 });
  window.isVisible = () => true;
  window.isMinimized = () => false;
  const result = new BrowserController(
    window as unknown as BrowserWindow,
    state,
    statePath,
    options,
    extensions,
  );
  result.setContentBounds({
    x: 200,
    y: 80,
    width: 1000,
    height: 700,
    hidden: false,
  });
  controllers.push(result);
  return result;
}
function contents(browser: BrowserController, tabId: string) {
  return browser.getWebContents(tabId) as unknown as FakeContents;
}
function viewFor(contents: FakeContents) {
  return vi
    .mocked(WebContentsView)
    .mock.results.map((result) => result.value as FakeView)
    .find((view) => view.webContents === contents)!;
}
function preferencesOf(page: FakeContents) {
  const { calls, results } = vi.mocked(WebContentsView).mock;
  const index = results.findIndex(
    (result) => (result.value as FakeView).webContents === page,
  );
  return calls[index][0]!.webPreferences!;
}
function windowOf(browser: BrowserController) {
  return browser.window as unknown as WindowFake;
}
type OpenDecision =
  | { action: "deny" }
  | {
      action: "allow";
      outlivesOpener: boolean;
      overrideBrowserWindowOptions: {
        show: boolean;
        webPreferences: Electron.WebPreferences;
      };
      createWindow(options: { webContents?: FakeContents }): FakeContents;
    };
// Opens a popup from page as Chromium does: the open handler decides, then
// createWindow adopts the guest Chromium made, or gets none for a modifier
// click.
function popup(
  page: FakeContents,
  details: Record<string, unknown> & { url: string },
  guest: FakeContents | null = new FakeContents(),
) {
  const handler = page.setWindowOpenHandler.mock.calls[0][0];
  const decision: OpenDecision = handler({
    frameName: "",
    features: "",
    disposition: "foreground-tab",
    referrer: { url: page.url, policy: "default" },
    ...details,
  });
  const returned =
    decision.action === "allow"
      ? decision.createWindow(guest ? { webContents: guest } : {})
      : undefined;
  return { decision, returned };
}
// Starts a navigation as Chromium reports it to will-navigate,
// will-frame-navigate or will-redirect, and returns its preventDefault.
function attempt(
  page: FakeContents,
  type: "will-navigate" | "will-frame-navigate" | "will-redirect",
  url: string,
  isMainFrame = true,
) {
  const event = { url, isMainFrame, preventDefault: vi.fn() };
  page.emit(type, event, url);
  return event.preventDefault;
}
let defaultBrowser: DefaultBrowserStatus = { state: "available" };
beforeEach(() => {
  sessions.clear();
  vi.clearAllMocks();
  defaultBrowser = { state: "available" };
  vi.mocked(app.getApplicationNameForProtocol).mockReturnValue("");
});
afterEach(() => {
  for (const browser of controllers.splice(0)) browser.dispose();
});

describe("native browser lifecycle", () => {
  it("edits a shortcut in place and refuses an address another shortcut has", async () => {
    const browser = controller();
    await browser.dispatch({
      type: "bookmark:update",
      id: "github",
      title: "Code",
      url: "github.com/shayanmohd",
    });
    expect(browser.state.bookmarks[0]).toMatchObject({
      id: "github",
      title: "Code",
      url: "https://github.com/shayanmohd",
    });
    await expect(
      browser.dispatch({
        type: "bookmark:update",
        id: "figma",
        title: "Figma",
        url: "https://github.com/shayanmohd",
      }),
    ).rejects.toThrow("already bookmarked");
    await expect(
      browser.dispatch({
        type: "bookmark:update",
        id: "missing",
        title: "Gone",
        url: "https://example.com/",
      }),
    ).rejects.toThrow("no longer exists");
  });
  it("recolours a space and rejects unknown colours", async () => {
    const browser = controller();
    await browser.dispatch({ type: "space:color", id: "work", color: "orange" });
    expect(browser.state.spaces.find((space) => space.id === "work")?.color).toBe("orange");
    await expect(
      browser.dispatch({
        type: "space:color",
        id: "work",
        color: "pink" as "green",
      }),
    ).rejects.toThrow("Invalid space options.");
  });
  it("opens only the active rejected Google page through a fixed external destination", async () => {
    const browser = controller();
    const tab = browser.state.tabs.find((item) => item.id === browser.state.activeTabId)!;
    await browser.dispatch({ type: "tab:open-external", id: tab.id });
    expect(shell.openExternal).not.toHaveBeenCalled();
    tab.url = "https://accounts.google.com/v3/signin/rejected?continue=" + encodeURIComponent("https://play.google.com/console/private?state=secret");
    await browser.dispatch({ type: "tab:open-external", id: "missing" });
    expect(shell.openExternal).not.toHaveBeenCalled();
    await browser.dispatch({ type: "tab:open-external", id: tab.id });
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith("https://play.google.com/console/");
    browser.state.activeTabId = browser.state.tabs.find((item) => item.id !== tab.id)!.id;
    await browser.dispatch({ type: "tab:open-external", id: tab.id });
    expect(shell.openExternal).toHaveBeenCalledTimes(1);
  });
  it("no loop: copies the rejected sign-in link and opens nothing while Kamapathy is the default", async () => {
    const browser = controller();
    const tab = browser.state.tabs.find((item) => item.id === browser.state.activeTabId)!;
    tab.url = "https://accounts.google.com/v3/signin/rejected?continue=" + encodeURIComponent("https://play.google.com/console/private?state=secret");
    defaultBrowser = { state: "default" };
    await browser.dispatch({ type: "tab:open-external", id: tab.id });
    expect(shell.openExternal).not.toHaveBeenCalled();
    await browser.dispatch({ type: "tab:copy-external", id: tab.id });
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith("https://play.google.com/console/");
    defaultBrowser = { state: "available" };
    await browser.dispatch({ type: "tab:open-external", id: tab.id });
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith("https://play.google.com/console/");
    const other = browser.state.tabs.find((item) => item.id !== tab.id)!;
    await browser.dispatch({ type: "tab:copy-external", id: other.id });
    tab.url = "https://example.com/";
    await browser.dispatch({ type: "tab:copy-external", id: tab.id });
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
  });
  it("preserves a new-window form's POST body and referrer when opening its tab", async () => {
    const browser = controller();
    const sourceId = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id: sourceId,
      url: "https://example.com/form",
    });
    const source = contents(browser, sourceId);
    const referrer = {
      url: "https://example.com/form",
      policy: "strict-origin-when-cross-origin",
    };
    const postBody = {
      contentType: "application/x-www-form-urlencoded",
      data: [{ type: "rawData", bytes: Buffer.from("name=Probe") }],
    };
    // A modifier click gives createWindow no contents, so Kamapathy loads
    // the page itself.
    const { returned } = popup(
      source,
      { url: "https://example.com/receipt", referrer, postBody },
      null,
    );
    expect(browser.state.activeTabId).not.toBe(sourceId);
    const destination = contents(browser, browser.state.activeTabId);
    expect(returned).toBe(destination);
    expect(destination.loadURL).toHaveBeenCalledWith(
      "https://example.com/receipt",
      {
        httpReferrer: referrer,
        postData: postBody.data,
        extraHeaders: "Content-Type: application/x-www-form-urlencoded",
      },
    );
  });

  it("does not reuse a microphone grant for a camera request", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/",
    });
    const page = contents(browser, id);
    page.commit("https://example.com/");
    const partition = session.fromPartition(
      "persist:space-personal",
    ) as unknown as FakeSession;
    const request = partition.setPermissionRequestHandler.mock.calls[0][0];
    const check = partition.setPermissionCheckHandler.mock.calls[0][0];
    const microphone = vi.fn();
    request(page, "media", microphone, {
      requestingUrl: page.url,
      isMainFrame: true,
      mediaTypes: ["audio"],
    });
    expect(browser.state.prompts).toMatchObject([
      { kind: "microphone", origin: "https://example.com", agent: false },
    ]);
    browser.prompts.answer({ id: browser.state.prompts[0].id, allow: true });
    expect(microphone).toHaveBeenCalledExactlyOnceWith(true);
    expect(
      check(page, "media", "https://example.com", { mediaType: "audio" }),
    ).toBe(true);
    expect(
      check(page, "media", "https://example.com", { mediaType: "video" }),
    ).toBe(false);
    expect(
      check(page, "media", "https://example.com", { mediaType: "unknown" }),
    ).toBe(false);
    // The camera is a request of its own, and a Block is remembered.
    const camera = vi.fn();
    request(page, "media", camera, {
      requestingUrl: page.url,
      isMainFrame: true,
      mediaTypes: ["video"],
    });
    expect(browser.state.prompts).toMatchObject([{ kind: "camera" }]);
    browser.prompts.answer({ id: browser.state.prompts[0].id, allow: false });
    expect(camera).toHaveBeenCalledExactlyOnceWith(false);
    expect(browser.state.prompts).toEqual([]);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it("a personal space asks through the prompt center instead of a native box, and a saved Allow answers the next request without asking", async () => {
    const browser = controller();
    const tab = browser.state.tabs[0];
    await browser.dispatch({
      type: "tab:navigate",
      id: tab.id,
      url: "https://example.com/",
    });
    const page = contents(browser, tab.id);
    page.commit("https://example.com/");
    const partition = session.fromPartition(
      "persist:space-personal",
    ) as unknown as FakeSession;
    const request = partition.setPermissionRequestHandler.mock.calls[0][0];
    const asked = vi.fn();
    request(page, "notifications", asked, {
      requestingUrl: page.url,
      isMainFrame: true,
    });
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    expect(asked).not.toHaveBeenCalled();
    expect(browser.state.prompts).toMatchObject([
      { spaceId: "personal", tabId: tab.id, kind: "notifications" },
    ]);
    // Opening the space shows the tab whose site is waiting.
    await browser.dispatch({ type: "space:activate", id: "work" });
    await browser.dispatch({ type: "space:activate", id: "personal" });
    expect(browser.state.activeTabId).toBe(tab.id);
    browser.prompts.answer({ id: browser.state.prompts[0].id, allow: true });
    expect(asked).toHaveBeenCalledExactlyOnceWith(true);
    expect(browser.state.sitePermissions).toMatchObject([
      {
        spaceId: "personal",
        origin: "https://example.com",
        permission: "notifications",
        allow: true,
      },
    ]);
    const again = vi.fn();
    request(page, "notifications", again, {
      requestingUrl: page.url,
      isMainFrame: true,
    });
    expect(again).toHaveBeenCalledExactlyOnceWith(true);
    expect(browser.state.prompts).toEqual([]);
    // Settings removes the decision, and the site asks again.
    await browser.dispatch({
      type: "site-permission:remove",
      spaceId: "personal",
      origin: "https://example.com",
      permission: "notifications",
    });
    expect(browser.state.sitePermissions).toEqual([]);
    await expect(
      browser.dispatch({
        type: "site-permission:remove",
        spaceId: "personal",
        origin: "https://example.com",
        permission: "camera-microphone" as "camera",
      }),
    ).rejects.toThrow("Invalid site permission.");
    const third = vi.fn();
    request(page, "notifications", third, {
      requestingUrl: page.url,
      isMainFrame: true,
    });
    expect(third).not.toHaveBeenCalled();
    browser.prompts.answer({ id: browser.state.prompts[0].id, allow: true });
    expect(browser.state.sitePermissions).toHaveLength(1);
    await browser.dispatch({ type: "site-permission:clear" });
    expect(browser.state.sitePermissions).toEqual([]);
  });

  it("installs the device handlers per partition and asks the person which device to connect", async () => {
    const browser = controller();
    const tab = browser.state.tabs[0];
    await browser.dispatch({
      type: "tab:navigate",
      id: tab.id,
      url: "https://example.com/",
    });
    const page = contents(browser, tab.id);
    page.commit("https://example.com/");
    const partition = session.fromPartition(
      "persist:space-personal",
    ) as unknown as FakeSession;
    expect(partition.setDevicePermissionHandler).toHaveBeenCalled();
    expect(partition.setBluetoothPairingHandler).toHaveBeenCalled();
    expect(partition.listenerCount("select-usb-device")).toBe(1);
    expect(partition.listenerCount("select-hid-device")).toBe(1);
    expect(partition.listenerCount("usb-device-added")).toBe(1);
    // The Bluetooth chooser belongs to the page, not to the partition.
    expect(page.listenerCount("select-bluetooth-device")).toBe(1);
    const callback = vi.fn();
    partition.emit(
      "select-usb-device",
      { preventDefault: vi.fn() },
      {
        deviceList: [
          { deviceId: "dev-a", vendorId: 1, productId: 2, productName: "Phone" },
        ],
        frame: { contents: page },
      },
      callback,
    );
    expect(browser.state.prompts).toMatchObject([
      {
        spaceId: "personal",
        tabId: tab.id,
        kind: "usb",
        devices: [{ id: "1:2:dev-a", name: "Phone" }],
      },
    ]);
    browser.prompts.answer({
      id: browser.state.prompts[0].id,
      allow: true,
      deviceId: "1:2:dev-a",
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith("dev-a");
    const mayUse = partition.setDevicePermissionHandler.mock.lastCall![0];
    expect(
      mayUse({
        deviceType: "usb",
        origin: "https://example.com",
        device: { deviceId: "dev-a" },
      }),
    ).toBe(true);
    // A device is granted for this run only, and nothing is written down.
    expect(browser.state.sitePermissions).toEqual([]);
    browser.dispose();
    expect(partition.listenerCount("select-usb-device")).toBe(0);
    expect(partition.setDevicePermissionHandler).toHaveBeenLastCalledWith(null);
  });

  it("a certificate request without a page sends nothing and a sign-in without a page is cancelled", async () => {
    const browser = controller();
    const tab = browser.state.tabs[0];
    await browser.dispatch({
      type: "tab:navigate",
      id: tab.id,
      url: "https://example.com/",
    });
    const page = contents(browser, tab.id);
    page.commit("https://example.com/");
    // A page's challenge reaches the bar through the tab's own login event.
    const callback = vi.fn();
    const event = { preventDefault: vi.fn() };
    page.emit(
      "login",
      event,
      {
        url: "https://example.com/area",
        isMainFrame: true,
        isRequestForNavigation: true,
        firstAuthAttempt: true,
      },
      {
        isProxy: false,
        scheme: "basic",
        host: "example.com",
        port: 443,
        realm: "Members",
      },
      callback,
    );
    expect(event.preventDefault).toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(browser.state.prompts).toMatchObject([
      {
        spaceId: "personal",
        tabId: tab.id,
        kind: "http_sign_in",
        agent: false,
        signIn: {
          host: "example.com",
          realm: "Members",
          proxy: false,
          retry: false,
        },
      },
    ]);
    browser.prompts.answer({
      id: browser.state.prompts[0].id,
      allow: true,
      credentials: { username: "person", password: "hunter2" },
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith("person", "hunter2");
    // What the person typed is never written down.
    expect(JSON.stringify(browser.state)).not.toContain("hunter2");
    expect(browser.state.sitePermissions).toEqual([]);
    // A request with no page gets nobody to ask and nothing to send.
    const certificate = vi.fn();
    browser.prompts.selectClientCertificate(
      null,
      "https://example.com/area",
      [],
      certificate,
    );
    expect(certificate).toHaveBeenCalledExactlyOnceWith();
    const signIn = vi.fn();
    browser.prompts.appLogin(signIn);
    expect(signIn).toHaveBeenCalledExactlyOnceWith();
    expect(browser.state.prompts).toEqual([]);
  });

  it("rejects a pending permission when the requesting space is deleted", async () => {
    const browser = controller();
    browser.state.spaces[1].signIns = "separate";
    const tab = browser.state.tabs.find((item) => item.spaceId === "work")!;
    await browser.dispatch({
      type: "tab:navigate",
      id: tab.id,
      url: "https://example.com/",
    });
    const page = contents(browser, tab.id);
    page.commit("https://example.com/");
    const partition = session.fromPartition(
      "persist:space-work",
    ) as unknown as FakeSession;
    const request = partition.setPermissionRequestHandler.mock.calls[0][0];
    const callback = vi.fn();
    request(page, "notifications", callback, {
      requestingUrl: page.url,
      isMainFrame: true,
    });
    expect(browser.state.prompts).toHaveLength(1);
    await browser.dispatch({ type: "space:delete", id: "work" });
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(browser.state.prompts).toEqual([]);
    expect(browser.state.sitePermissions).toEqual([]);
  });

  it("rejects a pending permission after a reload at the same URL", async () => {
    const browser = controller();
    const tab = browser.state.tabs[0];
    await browser.dispatch({
      type: "tab:navigate",
      id: tab.id,
      url: "https://example.com/",
    });
    const page = contents(browser, tab.id);
    page.commit("https://example.com/");
    const partition = session.fromPartition(
      "persist:space-personal",
    ) as unknown as FakeSession;
    const request = partition.setPermissionRequestHandler.mock.calls[0][0];
    const callback = vi.fn();
    request(page, "notifications", callback, {
      requestingUrl: page.url,
      isMainFrame: true,
    });
    page.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(browser.state.prompts).toEqual([]);
    expect(browser.state.sitePermissions).toEqual([]);
  });

  it("asks the person in a human-owned agent space and still denies its downloads", async () => {
    const browser = controller();
    await browser.dispatch({
      type: "space:create",
      kind: "agent",
      color: "purple",
      name: "Manual task",
    });
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/",
    });
    const partition = [...sessions.values()][0];
    const request = partition.setPermissionRequestHandler.mock.calls[0][0];
    const callback = vi.fn();
    request(contents(browser, id), "notifications", callback, {
      requestingUrl: "https://example.com/",
      isMainFrame: true,
    });
    expect(callback).not.toHaveBeenCalled();
    expect(browser.state.prompts).toMatchObject([
      { kind: "notifications", agent: false },
    ]);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    browser.prompts.answer({ id: browser.state.prompts[0].id, allow: true });
    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
    // An agent space keeps its decisions in memory, never on disk.
    expect(browser.state.sitePermissions).toEqual([]);
    const event = { preventDefault: vi.fn() };
    partition.emit("will-download", event, {});
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(browser.state.downloads).toHaveLength(0);
  });

  it("Take over records manual, a handoff records handoff, and taking over during a hold makes it manual", async () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    const ownership = (owner: "human" | "agent", reason?: "handoff") =>
      browser.dispatch({
        type: "space:ownership",
        id: space.id,
        owner,
        ...(reason ? { reason } : {}),
      });
    await ownership("human");
    expect(space.owner).toBe("human");
    expect(space.control).toEqual({ reason: "manual", since: expect.any(Number) });
    await ownership("agent");
    expect(space.owner).toBe("agent");
    expect(space).not.toHaveProperty("control");
    await ownership("human", "handoff");
    expect(space.control).toEqual({ reason: "handoff", since: expect.any(Number) });
    await ownership("agent");
    const hold = browser.holdForPerson(space.id, "permission", "camera");
    expect(space).toMatchObject({
      owner: "human",
      control: { reason: "permission", prompt: "camera", hold },
    });
    await ownership("human");
    expect(space.control).toEqual({ reason: "manual", since: expect.any(Number) });
    browser.releaseHold(hold);
    expect(space.owner).toBe("human");
    await ownership("agent");
    browser.releaseHold(browser.holdForPerson(space.id, "device", "usb"));
    expect(space.owner).toBe("agent");
    expect(space).not.toHaveProperty("control");
    await expect(
      browser.dispatch({
        type: "space:ownership",
        id: space.id,
        owner: "human",
        reason: "failed",
      } as never),
    ).rejects.toThrow();
    expect(space.owner).toBe("agent");
  });

  it("keeps unwatched agent pages painting after every navigation, but not personal pages", async () => {
    const browser = controller();
    await browser.dispatch({ type: "tab:navigate", id: browser.state.activeTabId, url: "https://example.com/" });
    const personal = contents(browser, browser.state.activeTabId);
    await browser.dispatch({ type: "space:create", kind: "agent", color: "purple", name: "Task" });
    const id = browser.state.activeTabId;
    await browser.dispatch({ type: "tab:navigate", id, url: "https://example.com/" });
    const agent = contents(browser, id);
    // Chromium paints nothing for a page never shown, and each new document starts hidden.
    expect(agent.setBackgroundThrottling).toHaveBeenCalledWith(false);
    const before = agent.setBackgroundThrottling.mock.calls.length;
    agent.commit("https://example.org/");
    expect(agent.setBackgroundThrottling.mock.calls.length).toBe(before + 1);
    expect(agent.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    expect(personal.setBackgroundThrottling).not.toHaveBeenCalled();
  });

  it("enforces the tab limit before creating either kind of space", async () => {
    const browser = controller();
    while (browser.state.tabs.length < 200)
      browser.state.tabs.push(newTab("personal"));
    const spaces = browser.state.spaces.length;
    await expect(
      browser.dispatch({
        type: "space:create",
        kind: "personal",
        color: "green",
        name: "Full",
      }),
    ).rejects.toThrow("200 tabs");
    await expect(
      browser.dispatch({
        type: "space:create",
        kind: "agent",
        color: "purple",
        name: "Full",
      }),
    ).rejects.toThrow("200 tabs");
    expect(() => browser.createAgentSpace("Full")).toThrow("200 tabs");
    expect(browser.state.spaces).toHaveLength(spaces);
    expect(browser.state.tabs).toHaveLength(200);
  });

  it("preserves a closed tab when reopening it would exceed the tab limit", async () => {
    const browser = controller();
    const original = browser.state.tabs[0];
    original.title = "Reopen me";
    original.url = "https://example.com/reopen";
    await browser.dispatch({ type: "tab:close", id: original.id });
    while (browser.state.tabs.length < 200)
      browser.state.tabs.push(newTab("personal"));
    await expect(browser.dispatch({ type: "tab:reopen" })).rejects.toThrow(
      "200 tabs",
    );
    expect(browser.state.tabs).toHaveLength(200);
    await browser.dispatch({
      type: "tab:close",
      id: browser.state.tabs.at(-1)!.id,
    });
    // Consume the most recently closed tab before retrying the older entry.
    await browser.dispatch({ type: "tab:reopen" });
    browser.state.tabs.pop();
    await browser.dispatch({ type: "tab:reopen" });
    expect(
      browser.state.tabs.find((tab) => tab.id === browser.state.activeTabId)
        ?.title,
    ).toBe("Reopen me");
  });

  it("closes the window when the last tab of a personal space is an empty new tab", async () => {
    const browser = controller();
    const only = browser.state.tabs.find((tab) => tab.spaceId === "personal")!;
    await browser.dispatch({ type: "tab:navigate", id: only.id, url: "https://example.com/" });
    await browser.dispatch({ type: "tab:close", id: only.id });
    expect(browser.window.close).not.toHaveBeenCalled();
    const replacement = browser.state.tabs.find((tab) => tab.spaceId === "personal")!;
    expect(replacement.url).toBe(HOME_URL);
    await browser.dispatch({ type: "tab:close", id: replacement.id });
    expect(browser.window.close).toHaveBeenCalledOnce();
    expect(browser.state.tabs.some((tab) => tab.id === replacement.id)).toBe(true);
  });
  it("never closes the window for an agent space's last tab", async () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    const only = browser.state.tabs.find((tab) => tab.spaceId === space.id)!;
    await browser.dispatch({ type: "tab:close", id: only.id });
    expect(browser.window.close).not.toHaveBeenCalled();
    expect(browser.state.tabs.filter((tab) => tab.spaceId === space.id)).toHaveLength(1);
  });
  it("selects the neighboring tab within its own space after closing a tab", async () => {
    const browser = controller();
    const work = browser.state.tabs.find((tab) => tab.spaceId === "work")!;
    const next = newTab("work");
    const last = newTab("work");
    browser.state.tabs.push(next, last);
    await browser.dispatch({ type: "tab:activate", id: work.id });
    await browser.dispatch({ type: "tab:close", id: work.id });
    expect(browser.state.activeTabId).toBe(next.id);
  });

  it("keeps Home active when a removed page finishes stopping", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/",
    });
    contents(browser, id).commit("https://example.com/");
    await browser.dispatch({ type: "tab:navigate", id, url: HOME_URL });
    expect(browser.state.tabs.find((tab) => tab.id === id)?.url).toBe(HOME_URL);
    expect(browser.getWebContents(id)).toBeUndefined();
    expect(WebContentsView).toHaveBeenCalledTimes(1);
  });

  it("ends split view when opening a new blank tab", async () => {
    const browser = controller();
    const first = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id: first,
      url: "https://example.com/",
    });
    await browser.dispatch({
      type: "tab:create",
      url: "https://example.org/",
      background: true,
    });
    const second = browser.state.tabs.find(
      (tab) => tab.url === "https://example.org/",
    )!.id;
    await browser.dispatch({ type: "tab:split", id: second });
    await browser.dispatch({ type: "tab:create" });
    expect(browser.state.splitTabId).toBeNull();
    expect(viewFor(contents(browser, second)).visible).toBe(false);
  });

  it("applies page controls to the focused split pane without moving either pane", async () => {
    const browser = controller();
    const first = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id: first,
      url: "https://example.com/",
    });
    await browser.dispatch({
      type: "tab:create",
      url: "https://example.org/",
      background: true,
    });
    const second = browser.state.tabs.find(
      (tab) => tab.url === "https://example.org/",
    )!.id;
    await browser.dispatch({ type: "tab:split", id: second });
    const left = contents(browser, first);
    const right = contents(browser, second);
    const leftBounds = { ...viewFor(left).bounds };
    const rightBounds = { ...viewFor(right).bounds };
    right.focus();
    await browser.dispatch({ type: "page:zoom", direction: "in" });
    expect(browser.state.activeTabId).toBe(second);
    expect(right.zoom).toBe(1);
    expect(left.zoom).toBe(0);
    expect(viewFor(left).bounds).toEqual(leftBounds);
    expect(viewFor(right).bounds).toEqual(rightBounds);
    left.emit("before-mouse-event", {}, { type: "mouseMove" });
    expect(browser.state.activeTabId).toBe(second);
    left.emit("before-mouse-event", {}, { type: "mouseDown" });
    expect(browser.state.activeTabId).toBe(first);
    expect(viewFor(left).bounds).toEqual(leftBounds);
  });

  it("ignores a rejected older load after a newer destination succeeds", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/slow",
    });
    const page = contents(browser, id);
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/new",
    });
    page.commit("https://example.com/new");
    page.pending[0].reject(new Error("ERR_CONNECTION_RESET"));
    await Promise.resolve();
    expect(
      browser.state.tabs.find((tab) => tab.id === id)?.error,
    ).toBeUndefined();
  });

  it("keeps the failed destination visible instead of replacing it with the previous page URL", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/previous",
    });
    const page = contents(browser, id);
    page.commit("https://example.com/previous");
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/failing",
    });
    page.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      "https://example.com/failing",
      true,
    );
    page.emit("did-stop-loading");
    expect(browser.state.tabs.find((tab) => tab.id === id)?.url).toBe(
      "https://example.com/failing",
    );
    await browser.dispatch({ type: "tab:reload", id });
    expect(page.loadURL).toHaveBeenLastCalledWith(
      "https://example.com/failing",
    );
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("ignores an old request failure after a page starts its own navigation", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/previous",
    });
    const page = contents(browser, id);
    page.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://example.com/new",
    });
    page.commit("https://example.com/new");
    page.pending[0].reject(new Error("ERR_CONNECTION_RESET"));
    await Promise.resolve();
    expect(
      browser.state.tabs.find((tab) => tab.id === id)?.error,
    ).toBeUndefined();
  });

  it("keeps a failed page recoverable through unrelated loading notifications", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/failing",
    });
    const page = contents(browser, id);
    page.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      "https://example.com/failing",
      true,
    );
    page.emit("did-start-loading");
    page.emit("did-stop-loading");
    expect(browser.state.tabs.find((tab) => tab.id === id)?.error).toBe(
      "ERR_CONNECTION_REFUSED",
    );
    await browser.dispatch({ type: "tab:reload", id });
    expect(
      browser.state.tabs.find((tab) => tab.id === id)?.error,
    ).toBeUndefined();
    expect(page.loadURL).toHaveBeenLastCalledWith(
      "https://example.com/failing",
    );
  });

  it("clears a deleted separate partition even if no tab opened it this launch", async () => {
    const browser = controller();
    browser.state.spaces[1].signIns = "separate";
    const existing = session.fromPartition(
      "persist:space-work",
    ) as unknown as FakeSession;
    await browser.dispatch({ type: "space:delete", id: "work" });
    expect(existing.clearStorageData).toHaveBeenCalledOnce();
    expect(existing.clearCache).toHaveBeenCalledOnce();
  });
  it("keeps the shared session when a space that shares sign-ins is deleted", async () => {
    const browser = controller();
    const shared = session.fromPartition(
      "persist:space-personal",
    ) as unknown as FakeSession;
    await browser.dispatch({ type: "space:delete", id: "work" });
    expect(shared.clearStorageData).not.toHaveBeenCalled();
    expect(session.fromPartition).not.toHaveBeenCalledWith("persist:space-work");
  });

  it("removes session download listeners when its window closes", async () => {
    const browser = controller();
    await browser.dispatch({
      type: "tab:navigate",
      id: browser.state.activeTabId,
      url: "https://example.com/",
    });
    const partition = session.fromPartition(
      "persist:space-personal",
    ) as unknown as FakeSession;
    expect(partition.listenerCount("will-download")).toBe(1);
    browser.dispose();
    expect(partition.listenerCount("will-download")).toBe(0);
  });
});

describe("sign-ins", () => {
  async function navigate(browser: BrowserController, id: string, url: string) {
    await browser.dispatch({ type: "tab:navigate", id, url });
    return contents(browser, id);
  }
  it("shares one session across personal spaces and agent spaces by default", async () => {
    const browser = controller();
    await navigate(browser, browser.state.activeTabId, "https://a.example/");
    await browser.dispatch({ type: "space:activate", id: "work" });
    await navigate(browser, browser.state.activeTabId, "https://b.example/");
    await browser.dispatch({
      type: "space:create",
      kind: "agent",
      color: "purple",
      name: "Task",
    });
    await navigate(browser, browser.state.activeTabId, "https://c.example/");
    const agent = browser.createAgentSpace("Api task");
    await navigate(
      browser,
      browser.state.tabs.find((tab) => tab.spaceId === agent.id)!.id,
      "https://d.example/",
    );
    expect([...sessions.keys()]).toEqual(["persist:space-personal"]);
    expect(browser.state.spaces.map((space) => space.signIns)).toEqual([
      "shared",
      "shared",
      "shared",
      "shared",
    ]);
    expect(browser.state.activity[0].message).toBe(
      "Api task started with your sign-ins.",
    );
  });
  it("gives separate spaces and isolated agents partitions of their own", async () => {
    const browser = controller();
    await browser.dispatch({
      type: "space:create",
      kind: "personal",
      color: "blue",
      name: "Private",
      signIns: "separate",
    });
    const separate = browser.state.activeSpaceId;
    await navigate(browser, browser.state.activeTabId, "https://a.example/");
    const flagged = browser.createAgentSpace("Clean", { isolated: true });
    await navigate(
      browser,
      browser.state.tabs.find((tab) => tab.spaceId === flagged.id)!.id,
      "https://b.example/",
    );
    await browser.dispatch({
      type: "settings:update",
      settings: { isolateAgentSpaces: true },
    });
    const bySetting = browser.createAgentSpace("Also clean");
    await navigate(
      browser,
      browser.state.tabs.find((tab) => tab.spaceId === bySetting.id)!.id,
      "https://c.example/",
    );
    expect([...sessions.keys()]).toEqual([
      `persist:space-${separate}`,
      expect.stringMatching(new RegExp(`^agent-.*-${flagged.id}$`)),
      expect.stringMatching(new RegExp(`^agent-.*-${bySetting.id}$`)),
    ]);
    expect(bySetting.signIns).toBe("separate");
    expect(browser.state.activity[0].message).toBe(
      "Also clean started in an isolated session.",
    );
    await expect(
      browser.dispatch({
        type: "space:create",
        kind: "personal",
        color: "blue",
        name: "Odd",
        signIns: "private" as "shared",
      }),
    ).rejects.toThrow("Invalid sign-in option.");
  });
  it("blocks agent downloads on the shared session and records personal ones", async () => {
    const browser = controller();
    const personal = await navigate(
      browser,
      browser.state.activeTabId,
      "https://a.example/",
    );
    await browser.dispatch({
      type: "space:create",
      kind: "agent",
      color: "purple",
      name: "Task",
    });
    const agent = await navigate(
      browser,
      browser.state.activeTabId,
      "https://b.example/",
    );
    const shared = sessions.get("persist:space-personal")!;
    const blocked = { preventDefault: vi.fn() };
    const item = {
      setSaveDialogOptions: vi.fn(),
      getFilename: () => "report.pdf",
      getTotalBytes: () => 10,
      on: vi.fn(),
      once: vi.fn(),
    };
    shared.emit("will-download", blocked, item, agent);
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    expect(browser.state.downloads).toHaveLength(0);
    expect(browser.state.activity[0].message).toBe(
      "A download was blocked in the agent space.",
    );
    const allowed = { preventDefault: vi.fn() };
    shared.emit("will-download", allowed, item, personal);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    expect(browser.state.downloads[0].filename).toBe("report.pdf");
    const unknown = { preventDefault: vi.fn() };
    shared.emit("will-download", unknown, item, {});
    expect(unknown.preventDefault).toHaveBeenCalledOnce();
  });
  it("a personal space still saves through the dialog, and a space under human control still blocks", async () => {
    const profile = mkdtempSync(join(tmpdir(), "kamapathy-profile-"));
    const browser = controller(join(profile, "browser-state.json"));
    expect(browser.userDataPath()).toBe(profile);
    const personal = await navigate(
      browser,
      browser.state.activeTabId,
      "https://a.example/",
    );
    const space = browser.createAgentSpace("Task");
    const agentTab = browser.state.tabs.find(
      (tab) => tab.spaceId === space.id,
    )!;
    const agent = await navigate(browser, agentTab.id, "https://b.example/");
    // The agent server's decision, as the server registers it.
    const asked: string[] = [];
    const stop = browser.onDownload((_contents, item) => {
      asked.push(item.getFilename());
      return browser.agentControlled(agentTab.id)
        ? { captured: true as const, id: "0123456789abcdef" }
        : { captured: false as const };
    });
    const shared = sessions.get("persist:space-personal")!;
    // A personal space never reaches the decider: Electron's save dialog
    // and the person's Downloads list are unchanged.
    const saved = { preventDefault: vi.fn() };
    const personalItem = new FakeDownloadItem({ filename: "report.pdf" });
    shared.emit("will-download", saved, personalItem, personal);
    expect(saved.preventDefault).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
    expect(personalItem.dialogOptions).toEqual({ title: "Save download" });
    expect(browser.state.downloads[0].filename).toBe("report.pdf");
    // An armed download in the agent space runs on, with nothing in the
    // person's list and no blocked line.
    const armed = { preventDefault: vi.fn() };
    shared.emit(
      "will-download",
      armed,
      new FakeDownloadItem({ filename: "armed.pdf" }),
      agent,
    );
    expect(asked).toEqual(["armed.pdf"]);
    expect(armed.preventDefault).not.toHaveBeenCalled();
    expect(browser.state.downloads).toHaveLength(1);
    expect(
      browser.state.activity.some((entry) =>
        entry.message.includes("A download was blocked"),
      ),
    ).toBe(false);
    // The person taking the space over leaves no tab under agent control,
    // so its downloads are blocked again.
    await browser.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    const takenOver = { preventDefault: vi.fn() };
    shared.emit(
      "will-download",
      takenOver,
      new FakeDownloadItem({ filename: "during.pdf" }),
      agent,
    );
    expect(takenOver.preventDefault).toHaveBeenCalledOnce();
    expect(browser.state.activity[0].message).toBe(
      "A download was blocked in the agent space.",
    );
    expect(browser.state.downloads).toHaveLength(1);
    // With the server stopped, the handler does what it always did.
    stop();
    const stopped = { preventDefault: vi.fn() };
    shared.emit(
      "will-download",
      stopped,
      new FakeDownloadItem({ filename: "after.pdf" }),
      agent,
    );
    expect(stopped.preventDefault).toHaveBeenCalledOnce();
    expect(asked).toEqual(["armed.pdf", "during.pdf"]);
    rmSync(profile, { recursive: true, force: true });
  });
  it("keeps a permission grant inside the space that allowed it", async () => {
    const browser = controller();
    const personal = await navigate(
      browser,
      browser.state.activeTabId,
      "https://example.com/",
    );
    personal.commit("https://example.com/");
    await browser.dispatch({ type: "space:activate", id: "work" });
    const work = await navigate(
      browser,
      browser.state.activeTabId,
      "https://example.com/",
    );
    work.commit("https://example.com/");
    const shared = sessions.get("persist:space-personal")!;
    const request = shared.setPermissionRequestHandler.mock.calls[0][0];
    const check = shared.setPermissionCheckHandler.mock.calls[0][0];
    const callback = vi.fn();
    request(personal, "notifications", callback, {
      requestingUrl: "https://example.com/",
      isMainFrame: true,
    });
    browser.prompts.answer({ id: browser.state.prompts[0].id, allow: true });
    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
    expect(check(personal, "notifications", "https://example.com/", {})).toBe(
      true,
    );
    expect(check(work, "notifications", "https://example.com/", {})).toBe(
      false,
    );
    expect(check(null, "notifications", "https://example.com/", {})).toBe(
      false,
    );
  });
  it("reloads a space's pages in a partition of its own when it separates its sign-ins, and clears it when it shares again", async () => {
    const browser = controller();
    await browser.dispatch({ type: "space:activate", id: "work" });
    const id = browser.state.activeTabId;
    const before = await navigate(browser, id, "https://example.com/");
    await browser.dispatch({
      type: "space:sign-ins",
      id: "work",
      signIns: "separate",
    });
    expect(before.destroyed).toBe(true);
    const after = contents(browser, id);
    expect(after).not.toBe(before);
    expect(after.loadURL).toHaveBeenCalledWith("https://example.com/");
    const separate = sessions.get("persist:space-work")!;
    expect(separate).toBeDefined();
    await browser.dispatch({
      type: "space:sign-ins",
      id: "work",
      signIns: "shared",
    });
    expect(separate.clearStorageData).toHaveBeenCalledOnce();
    expect(separate.listenerCount("will-download")).toBe(0);
    expect(browser.state.spaces[1].signIns).toBe("shared");
    await expect(
      browser.dispatch({
        type: "space:sign-ins",
        id: "personal",
        signIns: "shared",
      }),
    ).resolves.toBeTruthy();
    await browser.dispatch({
      type: "space:create",
      kind: "agent",
      color: "purple",
      name: "Task",
    });
    await expect(
      browser.dispatch({
        type: "space:sign-ins",
        id: browser.state.activeSpaceId,
        signIns: "separate",
      }),
    ).rejects.toThrow("Only personal spaces");
  });
});

describe("frame preload", () => {
  const framePreload = "/app/out/preload/forms.cjs";
  const registration = {
    type: "frame",
    id: "kamapathy-forms",
    filePath: framePreload,
  };
  const withPreload = (state?: ReturnType<typeof initialState>) =>
    controller(undefined, state, { framePreload });
  // Pages in the active personal tab and in a new isolated agent space, whose
  // partition lives in memory. Returns that space's session.
  async function openPages(browser: BrowserController) {
    await browser.dispatch({
      type: "tab:navigate",
      id: browser.state.activeTabId,
      url: "https://a.example/",
    });
    const before = new Set(sessions.keys());
    const space = browser.createAgentSpace("Clean", { isolated: true });
    await browser.dispatch({
      type: "tab:navigate",
      id: browser.state.tabs.find((tab) => tab.spaceId === space.id)!.id,
      url: "https://b.example/",
    });
    const partition = [...sessions.keys()].find((key) => !before.has(key))!;
    expect(partition).toMatch(/^agent-/);
    return sessions.get(partition)!;
  }

  it("registers the form preload once on every page session, in-memory ones included", async () => {
    const plain = await openPages(controller());
    const shared = sessions.get("persist:space-personal")!;
    expect(shared.registerPreloadScript).not.toHaveBeenCalled();
    expect(plain.registerPreloadScript).not.toHaveBeenCalled();

    // A restored web tab gets its view while the controller is made.
    const restored = initialState();
    restored.tabs[0].url = "https://a.example/";
    const browser = withPreload(restored);
    expect(shared.registerPreloadScript).toHaveBeenCalledExactlyOnceWith(
      registration,
    );
    const memory = await openPages(browser);
    expect(shared.registerPreloadScript).toHaveBeenCalledOnce();
    expect(memory.registerPreloadScript).toHaveBeenCalledExactlyOnceWith(
      registration,
    );
    await browser.dispatch({ type: "tab:create", url: "https://c.example/" });
    expect(contents(browser, browser.state.activeTabId)).toBeDefined();
    expect(shared.registerPreloadScript).toHaveBeenCalledOnce();

    // A new window's controller gets the same sessions, which already hold
    // the preload.
    const second = withPreload();
    const secondMemory = await openPages(second);
    expect(shared.getPreloadScripts).toHaveBeenCalled();
    expect(shared.registerPreloadScript).toHaveBeenCalledOnce();
    expect(secondMemory.registerPreloadScript).toHaveBeenCalledExactlyOnceWith(
      registration,
    );
    expect(plain.registerPreloadScript).not.toHaveBeenCalled();
  });

  it("tab views and popups run preloads in subframes, sandboxed", async () => {
    const browser = withPreload();
    const personal = browser.state.activeTabId;
    const space = browser.createAgentSpace("Task");
    const agent = browser.state.tabs.find((tab) => tab.spaceId === space.id)!;
    const sandboxed = {
      nodeIntegrationInSubFrames: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    };
    for (const [id, url] of [
      [personal, "https://example.org/"],
      [agent.id, "https://example.com/"],
    ]) {
      await browser.dispatch({ type: "tab:navigate", id, url });
      const page = contents(browser, id);
      page.commit(url);
      const view = preferencesOf(page);
      expect(view).toMatchObject(sandboxed);
      expect(view).not.toHaveProperty("preload");
      const guest = new FakeContents();
      const { decision } = popup(page, { url: `${url}popup` }, guest);
      const override =
        decision.action === "allow"
          ? decision.overrideBrowserWindowOptions.webPreferences
          : undefined;
      expect(override).toMatchObject(sandboxed);
      expect(override).not.toHaveProperty("preload");
      // A view made around Chromium's contents replaces their preferences,
      // so the popup's view is given the same ones.
      expect(preferencesOf(guest)).toEqual(override);
    }
  });
});

describe("partition housekeeping", () => {
  it("waits for a pending clear before a space separates its sign-ins again", async () => {
    const browser = controller();
    browser.state.spaces[1].signIns = "separate";
    await browser.dispatch({ type: "space:activate", id: "work" });
    const id = browser.state.activeTabId;
    await browser.dispatch({ type: "tab:navigate", id, url: "https://example.com/" });
    const separate = sessions.get("persist:space-work")!;
    let finishClear!: () => void;
    separate.clearStorageData.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishClear = resolve)),
    );
    const toShared = browser.dispatch({
      type: "space:sign-ins",
      id: "work",
      signIns: "shared",
    });
    await vi.waitFor(() => expect(separate.clearStorageData).toHaveBeenCalled());
    expect(separate.listenerCount("will-download")).toBe(0);
    let backAgain = false;
    const toSeparate = browser
      .dispatch({ type: "space:sign-ins", id: "work", signIns: "separate" })
      .then(() => (backAgain = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backAgain).toBe(false);
    finishClear();
    await toShared;
    await toSeparate;
    expect(browser.state.spaces[1].signIns).toBe("separate");
    await browser.dispatch({ type: "tab:navigate", id, url: "https://example.org/" });
    expect(separate.listenerCount("will-download")).toBe(1);
    const check = separate.setPermissionCheckHandler.mock.lastCall![0];
    expect(typeof check).toBe("function");
  });
  it("clears the partition a shared space used before it shared sign-ins when it is deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "kamapathy-partitions-"));
    mkdirSync(join(root, "Partitions", "space-work"), { recursive: true });
    const browser = controller(join(root, "browser-state.json"));
    await browser.dispatch({ type: "space:delete", id: "work" });
    expect(session.fromPartition).toHaveBeenCalledWith("persist:space-work");
    expect(sessions.get("persist:space-work")!.clearStorageData).toHaveBeenCalledOnce();
    expect(sessions.get("persist:space-personal")?.clearStorageData ?? vi.fn()).not.toHaveBeenCalled();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("extension sessions", () => {
  it("sessionFor attaches extensions to persistent partitions only, and discarding a partition detaches it first", async () => {
    const extensions = {
      attach: vi.fn(async (_partition: string, _ses: Session) => {}),
      detach: vi.fn((_partition: string) => {}),
      loadedIds: vi.fn((_partition: string) => new Set<string>()),
      permissionFor: vi.fn(() => undefined),
      isExtensionSurface: vi.fn(() => false),
    };
    const browser = controller(undefined, undefined, undefined, extensions);
    const open = async (id: string, url: string) => {
      await browser.dispatch({ type: "tab:navigate", id, url });
      contents(browser, id);
    };
    await open(browser.state.activeTabId, "https://a.example/");
    const shared = sessions.get("persist:space-personal")!;
    expect(extensions.attach).toHaveBeenCalledExactlyOnceWith(
      "persist:space-personal",
      shared,
    );
    // The session's own handlers are in place first.
    const [attached] = extensions.attach.mock.invocationCallOrder;
    expect(attached).toBeGreaterThan(
      shared.setPermissionRequestHandler.mock.invocationCallOrder[0],
    );
    expect(attached).toBeGreaterThan(
      shared.setPermissionCheckHandler.mock.invocationCallOrder[0],
    );
    const isolated = browser.createAgentSpace("Clean", { isolated: true });
    await open(
      browser.state.tabs.find((tab) => tab.spaceId === isolated.id)!.id,
      "https://b.example/",
    );
    await browser.dispatch({
      type: "space:create",
      kind: "personal",
      color: "blue",
      name: "Private",
      signIns: "separate",
    });
    const separate = `persist:space-${browser.state.activeSpaceId}`;
    await open(browser.state.activeTabId, "https://c.example/");
    expect([...sessions.keys()]).toEqual([
      "persist:space-personal",
      expect.stringMatching(new RegExp(`^agent-.*-${isolated.id}$`)),
      separate,
    ]);
    expect(
      extensions.attach.mock.calls.map(([partition]) => partition),
    ).toEqual(["persist:space-personal", separate]);
    expect(extensions.detach).not.toHaveBeenCalled();

    const separateSession = sessions.get(separate)!;
    await browser.dispatch({
      type: "space:delete",
      id: browser.state.activeSpaceId,
    });
    expect(extensions.detach).toHaveBeenCalledExactlyOnceWith(separate);
    const [detached] = extensions.detach.mock.invocationCallOrder;
    expect(detached).toBeLessThan(
      separateSession.clearStorageData.mock.invocationCallOrder[0],
    );
    // The handlers come off after the extensions.
    const handlers = separateSession.setPermissionCheckHandler.mock;
    expect(detached).toBeLessThan(handlers.invocationCallOrder.at(-1)!);

    // A partition no tab used this launch is attached as it is created for
    // clearing, and detached before anything is cleared.
    browser.state.spaces[1].signIns = "separate";
    await browser.dispatch({ type: "space:delete", id: "work" });
    const work = sessions.get("persist:space-work")!;
    expect(extensions.attach).toHaveBeenLastCalledWith(
      "persist:space-work",
      work,
    );
    expect(extensions.detach).toHaveBeenLastCalledWith("persist:space-work");
    expect(extensions.detach.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      work.clearStorageData.mock.invocationCallOrder[0],
    );
    expect(extensions.attach).toHaveBeenCalledTimes(3);
  });

  it("restoredPartitions lists the shared partition and each separate personal space's", () => {
    const state = initialState();
    expect(restoredPartitions(state)).toEqual(["persist:space-personal"]);
    state.spaces[0].signIns = "separate";
    state.spaces[1].signIns = "separate";
    state.spaces.push({
      ...state.spaces[1],
      id: "agent",
      kind: "agent",
      owner: "agent",
    });
    expect(restoredPartitions(state)).toEqual([
      "persist:space-personal",
      "persist:space-work",
    ]);
  });
});

describe("extension pages", () => {
  const ID = "abcdefghijklmnopabcdefghijklmnop";
  const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";
  const page = (id: string, path = "options.html") =>
    `chrome-extension://${id}/${path}`;
  // Sessions running the extensions listed for their partition.
  function running(
    loaded: Record<string, string[]>,
    overrides: Partial<ExtensionSessions> = {},
  ) {
    return {
      attach: vi.fn(async () => {}),
      detach: vi.fn(),
      loadedIds: vi.fn((partition: string) => new Set(loaded[partition] ?? [])),
      permissionFor: vi.fn(() => undefined),
      isExtensionSurface: vi.fn(() => false),
      ...overrides,
    };
  }
  // A space's tabs as the tab strip shows them, pinned first.
  const strip = (browser: BrowserController, spaceId: string) =>
    spaceTabs({ tabs: browser.state.tabs, activeSpaceId: spaceId }).map(
      (tab) => tab.id,
    );
  const folders: string[] = [];
  afterEach(() => {
    for (const folder of folders.splice(0))
      rmSync(folder, { recursive: true, force: true });
  });
  // A host whose extensions.json lists one enabled store extension.
  async function hostWith(id: string, manifest: Record<string, unknown>) {
    const userData = mkdtempSync(join(tmpdir(), "kamapathy-extension-pages-"));
    folders.push(userData);
    const path = `Extensions/${id}/1.0.0`;
    mkdirSync(join(userData, path), { recursive: true });
    writeFileSync(
      join(userData, path, "manifest.json"),
      JSON.stringify({
        manifest_version: 3,
        name: "Clipper",
        version: "1.0.0",
        ...manifest,
      }),
    );
    writeFileSync(
      join(userData, "extensions.json"),
      JSON.stringify({
        extensions: [
          {
            id,
            source: "webstore",
            version: "1.0.0",
            path,
            enabled: true,
            pinned: false,
            installedAt: 1,
            grantedPermissions: [],
            grantedHosts: [],
          },
        ],
        removals: [],
      }),
    );
    const host = new ExtensionHost({
      userData,
      locale: "en-US",
      chromeVersion: "152.0.7977.76",
    });
    await host.init();
    return host;
  }

  it("opens an extension's page in an ungranted personal space and refuses it in agent and granted spaces", async () => {
    const browser = controller(
      undefined,
      undefined,
      undefined,
      running({ "persist:space-personal": [ID] }),
    );
    const id = browser.state.activeTabId;
    const tab = browser.state.tabs.find((item) => item.id === id)!;
    await browser.dispatch({ type: "tab:navigate", id, url: page(ID) });
    expect(tab).toMatchObject({ url: page(ID), title: page(ID) });
    expect(WebContentsView).toHaveBeenCalledOnce();
    const shown = contents(browser, id);
    expect(shown.loadURL).toHaveBeenCalledExactlyOnceWith(page(ID));
    shown.commit(page(ID));
    expect(tab.url).toBe(page(ID));
    expect(viewFor(shown).visible).toBe(true);
    // The page moves between its own pages, and a page of an extension the
    // session doesn't run stays out.
    const own = { preventDefault: vi.fn() };
    shown.emit("will-navigate", own, page(ID, "other.html"));
    expect(own.preventDefault).not.toHaveBeenCalled();
    shown.emit("did-start-navigation", {
      url: page(ID, "other.html"),
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(tab.url).toBe(page(ID, "other.html"));
    const foreign = { preventDefault: vi.fn() };
    shown.emit("will-navigate", foreign, page(OTHER));
    expect(foreign.preventDefault).toHaveBeenCalledOnce();
    await expect(
      browser.dispatch({ type: "tab:navigate", id, url: page(OTHER) }),
    ).rejects.toThrow("That extension isn't installed or is turned off.");
    // History, bookmarks and split view keep to web pages.
    expect(browser.state.history).toEqual([]);
    await expect(
      browser.dispatch({
        type: "bookmark:add",
        url: page(ID),
        title: "Options",
      }),
    ).rejects.toThrow();
    // Spaces that share the session open them too.
    await browser.dispatch({
      type: "tab:create",
      spaceId: "work",
      url: page(ID, "welcome.html"),
      background: true,
    });
    const welcome = browser.state.tabs.at(-1)!;
    expect(welcome).toMatchObject({
      spaceId: "work",
      url: page(ID, "welcome.html"),
    });
    expect(
      browser.peekWebContents(welcome.id)!.loadURL,
    ).toHaveBeenCalledExactlyOnceWith(page(ID, "welcome.html"));
    await browser.dispatch({
      type: "tab:create",
      url: "https://example.com/",
      background: true,
    });
    await expect(
      browser.dispatch({
        type: "tab:split",
        id: browser.state.tabs.at(-1)!.id,
      }),
    ).rejects.toThrow("Open two web pages in this space for split view.");
    // A space with separate sign-ins runs only what its own session loaded.
    await browser.dispatch({
      type: "space:create",
      kind: "personal",
      color: "blue",
      name: "Private",
      signIns: "separate",
    });
    await expect(
      browser.dispatch({
        type: "tab:create",
        spaceId: browser.state.activeSpaceId,
        url: page(ID),
      }),
    ).rejects.toThrow("That extension isn't installed or is turned off.");
    // Spaces an agent can reach refuse them, whoever asks.
    const agent = browser.createAgentSpace("Task");
    const agentTab = browser.state.tabs.find(
      (item) => item.spaceId === agent.id,
    )!;
    for (const action of [
      { type: "tab:navigate" as const, id: agentTab.id, url: page(ID) },
      { type: "tab:create" as const, spaceId: agent.id, url: page(ID) },
    ])
      await expect(browser.dispatch(action)).rejects.toThrow(
        "Extension pages open only in your personal spaces.",
      );
    await browser.dispatch({
      type: "tab:navigate",
      id: agentTab.id,
      url: "https://example.com/",
    });
    const refused = { preventDefault: vi.fn() };
    contents(browser, agentTab.id).emit("will-navigate", refused, page(ID));
    expect(refused.preventDefault).toHaveBeenCalledOnce();
    browser.grantAccess("personal");
    await expect(
      browser.dispatch({ type: "tab:navigate", id, url: page(ID) }),
    ).rejects.toThrow("Extension pages open only in your personal spaces.");
    const granted = { preventDefault: vi.fn() };
    shown.emit("will-navigate", granted, page(ID));
    expect(granted.preventDefault).toHaveBeenCalledOnce();
  });

  it("a restored page of a removed extension becomes a new tab", () => {
    const state = initialState();
    state.spaces[1].signIns = "separate";
    const [personal, work] = state.tabs;
    Object.assign(personal, { url: page(ID), title: "Options" });
    // The extension isn't loaded in this space's own session.
    Object.assign(work, { url: page(ID), title: "Options" });
    const removed = {
      ...newTab("personal", page(OTHER, "welcome.html")),
      title: "Welcome",
    };
    state.tabs.push(removed);
    const browser = controller(
      undefined,
      state,
      undefined,
      running({ "persist:space-personal": [ID] }),
    );
    for (const tab of [work, removed])
      expect(tab).toMatchObject({ url: HOME_URL, title: "New tab" });
    expect(personal).toMatchObject({ url: page(ID), title: "Options" });
    expect(browser.state.tabs).toEqual([personal, work, removed]);
    expect(
      browser.peekWebContents(personal.id)!.loadURL,
    ).toHaveBeenCalledExactlyOnceWith(page(ID));
  });

  it("openExtensionTab places, pins and activates tabs only as asked, and moveTab stays within the space", () => {
    const browser = controller(
      undefined,
      undefined,
      undefined,
      running({ "persist:space-personal": [ID] }),
    );
    const first = browser.state.activeTabId;
    const [work] = strip(browser, "work");
    const emitted = vi.fn();
    browser.subscribe(emitted);
    const pinned = browser.openExtensionTab(
      "personal",
      "https://example.com/pinned",
      { pinned: true, active: false },
    );
    expect(pinned).toMatchObject({
      spaceId: "personal",
      url: "https://example.com/pinned",
      pinned: true,
      openedBy: "person",
      managed: false,
    });
    expect(pinned).not.toHaveProperty("label");
    expect(emitted).toHaveBeenCalled();
    expect(browser.state.activeTabId).toBe(first);
    expect(
      browser.peekWebContents(pinned.id)!.loadURL,
    ).toHaveBeenCalledExactlyOnceWith("https://example.com/pinned");
    // Unpinned tabs stay after the pinned ones, wherever asked.
    const start = browser.openExtensionTab(
      "personal",
      "https://example.com/start",
      { index: 0, active: false },
    );
    expect(strip(browser, "personal")).toEqual([pinned.id, start.id, first]);
    // A tab opens last and shown unless asked otherwise.
    const options = browser.openExtensionTab("personal", page(ID));
    expect(strip(browser, "personal")).toEqual([
      pinned.id,
      start.id,
      first,
      options.id,
    ]);
    expect(browser.state.activeTabId).toBe(options.id);
    expect(
      browser.peekWebContents(options.id)!.loadURL,
    ).toHaveBeenCalledExactlyOnceWith(page(ID));
    // Blank pages open the new tab page.
    const blank = browser.openExtensionTab("personal", "about:blank", {
      index: 2,
      active: false,
    });
    const empty = browser.openExtensionTab("personal", "", {
      pinned: true,
      index: 99,
      active: false,
    });
    for (const tab of [blank, empty]) {
      expect(tab).toMatchObject({ url: HOME_URL, title: "New tab" });
      expect(browser.peekWebContents(tab.id)).toBeUndefined();
    }
    expect(strip(browser, "personal")).toEqual([
      pinned.id,
      empty.id,
      start.id,
      blank.id,
      first,
      options.id,
    ]);
    // Showing a tab in a space that isn't shown shows that space.
    const elsewhere = browser.openExtensionTab("work", "https://example.org/");
    expect([browser.state.activeSpaceId, browser.state.activeTabId]).toEqual([
      "work",
      elsewhere.id,
    ]);
    expect(strip(browser, "work")).toEqual([work, elsewhere.id]);
    for (const url of [
      "file:///etc/hosts",
      "javascript:alert(1)",
      "data:text/html,hi",
      "chrome://extensions/",
      "kamapathy://settings",
      "https://user:secret@example.com/",
      page(OTHER),
    ])
      expect(() => browser.openExtensionTab("personal", url), url).toThrow(
        "Extensions can't open this URL.",
      );
    const agent = browser.createAgentSpace("Task");
    browser.grantAccess("work");
    for (const spaceId of [agent.id, "work"])
      expect(() =>
        browser.openExtensionTab(spaceId, "https://example.com/"),
      ).toThrow("Extensions open tabs only in your personal spaces.");
    const tabs = browser.state.tabs.length;
    // moveTab keeps a tab within its pin group, and -1 is last.
    expect(browser.moveTab(first, 0)).toMatchObject({ id: first });
    expect(strip(browser, "personal")).toEqual([
      pinned.id,
      empty.id,
      first,
      start.id,
      blank.id,
      options.id,
    ]);
    browser.moveTab(first, -1);
    expect(strip(browser, "personal")).toEqual([
      pinned.id,
      empty.id,
      start.id,
      blank.id,
      options.id,
      first,
    ]);
    browser.moveTab(pinned.id, 99);
    browser.moveTab(options.id, 3);
    expect(strip(browser, "personal")).toEqual([
      empty.id,
      pinned.id,
      start.id,
      options.id,
      blank.id,
      first,
    ]);
    expect(strip(browser, "work")).toEqual([work, elsewhere.id]);
    expect(browser.state.tabs).toHaveLength(tabs);
  });

  it("closing an extension's pages closes its tabs everywhere", async () => {
    const browser = controller(
      undefined,
      undefined,
      undefined,
      running({ "persist:space-personal": [ID, OTHER] }),
    );
    const blank = browser.state.activeTabId;
    const options = browser.openExtensionTab("personal", page(ID));
    const web = browser.openExtensionTab("personal", "https://example.com/", {
      active: false,
    });
    const other = browser.openExtensionTab("personal", page(OTHER), {
      active: false,
    });
    const [work] = browser.state.tabs.filter((tab) => tab.spaceId === "work");
    await browser.dispatch({
      type: "tab:navigate",
      id: work.id,
      url: page(ID, "welcome.html"),
    });
    const closing = [options, work].map((tab) => contents(browser, tab.id));
    expect(browser.extensionPageTabs(ID)).toEqual([options, work]);
    expect(browser.extensionPageTabs(OTHER)).toEqual([other]);
    const emitted = vi.fn();
    browser.subscribe(emitted);
    browser.closeExtensionPages(ID);
    expect(emitted).toHaveBeenCalledOnce();
    expect(browser.extensionPageTabs(ID)).toEqual([]);
    for (const page of closing) expect(page.destroyed).toBe(true);
    expect(strip(browser, "personal")).toEqual([blank, web.id, other.id]);
    // A space left without tabs gets a blank one.
    expect(
      browser.state.tabs.filter((tab) => tab.spaceId === "work"),
    ).toMatchObject([{ url: HOME_URL, openedBy: "person", managed: false }]);
    browser.closeExtensionPages(ID);
    expect(emitted).toHaveBeenCalledOnce();
  });

  it("downloads from an extension popup follow the personal flow, and downloads without a page are blocked", async () => {
    const popupPage = new FakeContents();
    const extensions = running(
      {},
      {
        isExtensionSurface: vi.fn(
          (contents: Electron.WebContents) =>
            contents === (popupPage as unknown as Electron.WebContents),
        ),
      },
    );
    const browser = controller(undefined, undefined, undefined, extensions);
    await browser.dispatch({
      type: "tab:navigate",
      id: browser.state.activeTabId,
      url: "https://example.com/",
    });
    const shared = sessions.get("persist:space-personal")!;
    let done!: (event: unknown, state: string) => void;
    const item = {
      setSaveDialogOptions: vi.fn(),
      getFilename: () => "export.csv",
      getTotalBytes: () => 10,
      getReceivedBytes: () => 10,
      getSavePath: () => "/Users/person/Downloads/export.csv",
      on: vi.fn(),
      once: vi.fn((_event: string, listener: typeof done) => {
        done = listener;
      }),
    };
    const allowed = { preventDefault: vi.fn() };
    shared.emit("will-download", allowed, item, popupPage);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith({
      title: "Save download",
    });
    expect(browser.state.downloads).toMatchObject([
      { filename: "export.csv", state: "progressing" },
    ]);
    done({}, "completed");
    expect(browser.state.activity[0]).toMatchObject({
      message: "export.csv: completed.",
      kind: "success",
    });
    expect(browser.state.activity[0].spaceId).toBeUndefined();
    // No tab and no popup or extension window, such as a service worker.
    const blocked = { preventDefault: vi.fn() };
    shared.emit("will-download", blocked, item, new FakeContents());
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    expect(browser.state.downloads).toHaveLength(1);
  });

  it("extension pages get clipboard and location only when declared, and nothing else", async () => {
    const host = await hostWith(ID, {
      permissions: ["clipboardWrite", "geolocation", "notifications", "tabs"],
    });
    const browser = controller(undefined, undefined, undefined, host);
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/",
    });
    const web = contents(browser, id);
    web.commit("https://example.com/");
    await vi.waitFor(() =>
      expect(host.isLoaded("persist:space-personal", ID)).toBe(true),
    );
    const shared = sessions.get("persist:space-personal")!;
    const request = shared.setPermissionRequestHandler.mock.calls[0][0];
    const check = shared.setPermissionCheckHandler.mock.calls[0][0];
    const ask = (
      target: FakeContents | null,
      permission: string,
      details: Record<string, unknown>,
    ) => {
      const callback = vi.fn();
      request(target, permission, callback, { isMainFrame: true, ...details });
      return callback.mock.calls.map(([answer]) => answer);
    };
    // The action popup is no tab, so it has no space.
    const popupPage = new FakeContents();
    popupPage.url = page(ID, "popup.html");
    const answers = Object.fromEntries(
      [
        "clipboard-read",
        "clipboard-sanitized-write",
        "geolocation",
        "notifications",
        "media",
        "fullscreen",
        "openExternal",
      ].map((permission) => [
        permission,
        [
          ask(popupPage, permission, { requestingUrl: popupPage.url }),
          check(popupPage, permission, `chrome-extension://${ID}/`, {
            requestingUrl: popupPage.url,
            isMainFrame: true,
          }),
        ],
      ]),
    );
    expect(answers).toEqual({
      "clipboard-read": [[false], false],
      "clipboard-sanitized-write": [[true], true],
      geolocation: [[true], true],
      notifications: [[false], false],
      media: [[false], false],
      fullscreen: [[false], false],
      openExternal: [[false], false],
    });
    // The page is the requesting URL, else the security or requesting origin,
    // else the page's own URL; an extension's frame in a web page is the
    // extension's.
    expect(ask(popupPage, "geolocation", {})).toEqual([true]);
    expect(check(popupPage, "geolocation", "", { isMainFrame: true })).toBe(
      true,
    );
    expect(
      ask(web, "geolocation", {
        requestingUrl: page(ID, "frame.html"),
        isMainFrame: false,
      }),
    ).toEqual([true]);
    expect(
      ask(web, "geolocation", {
        securityOrigin: `chrome-extension://${ID}/`,
        isMainFrame: false,
      }),
    ).toEqual([true]);
    expect(
      check(web, "geolocation", `chrome-extension://${ID}/`, {
        isMainFrame: false,
      }),
    ).toBe(true);
    expect(
      check(null, "clipboard-sanitized-write", `chrome-extension://${ID}/`, {
        isMainFrame: true,
      }),
    ).toBe(true);
    // An extension this session doesn't run gets nothing, and the PDF viewer
    // keeps Kamapathy's own handling.
    const stranger = new FakeContents();
    stranger.url = page(OTHER, "popup.html");
    expect(
      ask(stranger, "geolocation", { requestingUrl: stranger.url }),
    ).toEqual([false]);
    expect(
      ask(web, "geolocation", {
        requestingUrl:
          "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
        isMainFrame: false,
      }),
    ).toEqual([false]);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    // Web origins go to the prompt bar, where the person answers.
    const asked = vi.fn();
    request(web, "geolocation", asked, {
      requestingUrl: "https://example.com/",
      isMainFrame: true,
    });
    await vi.waitFor(() => expect(browser.state.prompts).toHaveLength(1));
    expect(browser.state.prompts[0]).toMatchObject({
      spaceId: "personal",
      tabId: id,
      kind: "location",
      origin: "https://example.com",
      agent: false,
    });
    expect(asked).not.toHaveBeenCalled();
    browser.prompts.answer({ id: browser.state.prompts[0].id, allow: true });
    expect(asked).toHaveBeenCalledWith(true);
    expect(browser.state.prompts).toEqual([]);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
  });
});

describe("imported browsing data", () => {
  it("adds bookmarks and history without duplicates and within the limits", async () => {
    const browser = controller();
    browser.state.history.push({
      id: "old",
      title: "Old title",
      url: "https://known.example/",
      visitedAt: 50,
      visits: 2,
    });
    await browser.dispatch({
      type: "import:apply",
      bookmarks: [
        { title: "GitHub", url: "https://github.com" },
        { title: "New", url: "https://new.example/" },
        { title: "New", url: "https://new.example/" },
        { title: "Local", url: "file:///etc/passwd" },
      ],
      history: [
        { title: "Known", url: "https://known.example/", visitedAt: 90, visits: 3 },
        { title: "", url: "https://fresh.example/", visitedAt: 70, visits: 0 },
        { title: "Future", url: "https://future.example/", visitedAt: 9e15, visits: 1 },
      ],
    });
    expect(browser.state.bookmarks.map((item) => item.url)).toEqual([
      "https://github.com",
      "https://www.figma.com",
      "https://linear.app",
      "https://www.notion.so",
      "https://www.youtube.com",
      "https://new.example/",
    ]);
    expect(browser.state.history.map((item) => item.url)).toEqual([
      "https://future.example/",
      "https://known.example/",
      "https://fresh.example/",
    ]);
    expect(browser.state.history[1]).toMatchObject({
      title: "Known",
      visitedAt: 90,
      visits: 5,
    });
    expect(browser.state.history[2]).toMatchObject({
      title: "https://fresh.example/",
      visits: 1,
    });
    expect(browser.state.history[0].visitedAt).toBeLessThanOrEqual(Date.now());
    await expect(
      browser.dispatch({
        type: "import:apply",
        bookmarks: Array.from({ length: 1001 }, () => ({ title: "x", url: "https://x.example/" })),
        history: [],
      }),
    ).rejects.toThrow("Invalid import.");
  });
  it("counts repeat visits to a page", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({ type: "tab:navigate", id, url: "https://example.com/" });
    contents(browser, id).commit("https://example.com/");
    expect(browser.state.history[0].visits).toBeUndefined();
    contents(browser, id).commit("https://example.com/");
    expect(browser.state.history).toHaveLength(1);
    expect(browser.state.history[0].visits).toBe(2);
  });
});

describe("imported sign-ins", () => {
  const cookie = (name: string): Electron.CookiesSetDetails => ({
    url: `https://${name}.example/`,
    name,
    value: `${name}-value`,
    secure: true,
    httpOnly: false,
    sameSite: "lax",
  });
  const chrome = (profile: string, ...names: string[]) => ({
    source: "chrome" as const,
    browser: "Google Chrome",
    profile,
    cookies: names.map(cookie),
  });
  const setCalls = (store: FakeSession) =>
    store.cookies.set.mock.calls.map(([details]) => details);
  it("import: separate destination creates one space per profile", async () => {
    const browser = controller();
    // The shared session exists, so a write to it would show.
    await browser.dispatch({
      type: "tab:navigate",
      id: browser.state.activeTabId,
      url: "https://a.example/",
    });
    await browser.dispatch({ type: "space:activate", id: "work" });
    const activeTabId = browser.state.activeTabId;
    const activity = browser.state.activity.length;
    const person = chrome("Person 1", "a", "b");
    const work = chrome("Work", "c");

    const outcome = await browser.applyImportedCookies("separate", [
      person,
      { source: "edge", browser: "Microsoft Edge", profile: "Default", cookies: [] },
      work,
    ]);

    const created = browser.state.spaces.slice(2);
    expect(
      created.map(({ name, color, kind, owner, signIns }) => ({
        name,
        color,
        kind,
        owner,
        signIns,
      })),
    ).toEqual([
      {
        name: "Person 1 from Google Chrome",
        color: "blue",
        kind: "personal",
        owner: "human",
        signIns: "separate",
      },
      {
        name: "Work from Google Chrome",
        color: "orange",
        kind: "personal",
        owner: "human",
        signIns: "separate",
      },
    ]);
    expect(outcome).toEqual({
      written: 3,
      failed: 0,
      spaces: created.map(({ id, name }) => ({ id, name })),
      warnings: [],
    });
    const [first, second] = created.map(
      (space) => sessions.get(`persist:space-${space.id}`)!,
    );
    expect(setCalls(first)).toEqual(person.cookies);
    expect(setCalls(second)).toEqual(work.cookies);
    expect(first.cookies.flushStore).toHaveBeenCalledTimes(1);
    expect(second.cookies.flushStore).toHaveBeenCalledTimes(1);
    expect(sessions.get("persist:space-personal")!.cookies.set).not.toHaveBeenCalled();
    expect(browser.state.activeSpaceId).toBe("work");
    expect(browser.state.activeTabId).toBe(activeTabId);
    expect(browser.state.activity).toHaveLength(activity);
  });
  it("shared destination", async () => {
    const browser = controller();
    const shared = session.fromPartition(
      "persist:space-personal",
    ) as unknown as FakeSession;
    shared.cookies.set.mockImplementation(async (details) => {
      if (details.name === "c" || (details.name === "b" && details.sameSite))
        throw new Error("Failed to set cookie");
    });
    const activity = browser.state.activity.length;

    const outcome = await browser.applyImportedCookies("shared", [
      chrome("Person 1", "a", "b"),
      chrome("Work", "c"),
    ]);

    expect(
      setCalls(shared).map((details) => [details.name, details.sameSite]),
    ).toEqual([
      ["a", "lax"],
      ["b", "lax"],
      ["b", undefined],
      ["c", "lax"],
      ["c", undefined],
    ]);
    const { sameSite: _, ...withoutSameSite } = cookie("b");
    expect(setCalls(shared)[2]).toEqual(withoutSameSite);
    expect(shared.cookies.flushStore).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      written: 2,
      failed: 1,
      spaces: [],
      warnings: ["1 sign-in could not be saved."],
    });
    expect(browser.state.spaces).toHaveLength(2);
    expect(browser.state.activity).toHaveLength(activity);
    shared.cookies.set.mockRejectedValue(new Error("Failed to set cookie"));
    expect(
      (await browser.applyImportedCookies("shared", [chrome("Person 1", "a", "b")]))
        .warnings,
    ).toEqual(["2 sign-ins could not be saved."]);
  });
  it("stops at the 30-space limit and cuts long names", async () => {
    const browser = controller();
    for (let index = browser.state.spaces.length; index < 29; index++)
      await browser.dispatch({
        type: "space:create",
        kind: "personal",
        color: "green",
        name: `Space ${index}`,
      });
    const activeTabId = browser.state.activeTabId;

    const outcome = await browser.applyImportedCookies("separate", [
      chrome("P".repeat(60), "a"),
      chrome("Work", "b"),
    ]);

    expect(browser.state.spaces).toHaveLength(30);
    expect(outcome.spaces.map((space) => space.name)).toEqual(["P".repeat(48)]);
    expect(outcome.written).toBe(1);
    expect(outcome.warnings).toEqual([
      "Kamapathy holds at most 30 spaces, so some profiles were left out.",
    ]);
    expect(browser.state.activeTabId).toBe(activeTabId);
  });
});

describe("freeze-frame", () => {
  it("captures the visible page and leaves it showing", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({ type: "tab:navigate", id, url: "https://example.com/" });
    const page = contents(browser, id);
    const view = viewFor(page);
    expect(view.setBorderRadius).toHaveBeenCalledWith(10);
    expect(await browser.freeze()).toEqual([
      { x: 200, y: 80, width: 1000, height: 700, image: jpegOf(1000) },
    ]);
    expect(page.capturePage).toHaveBeenCalledWith(undefined, { stayHidden: false });
    expect(view.visible).toBe(true);
  });

  it("keeps hidden pages hidden through layouts until unfreeze", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({ type: "tab:navigate", id, url: "https://example.com/" });
    const view = viewFor(contents(browser, id));
    browser.hidePages();
    expect(view.visible).toBe(false);
    await browser.dispatch({ type: "tab:reload", id });
    browser.setContentBounds({ x: 200, y: 80, width: 900, height: 700, hidden: false });
    expect(view.visible).toBe(false);
    expect(await browser.freeze()).toEqual([]);
    browser.unfreeze();
    expect(view.visible).toBe(true);
    expect(view.bounds.width).toBe(900);
  });

  it("returns one frame per split pane and keeps the active pane while hidden", async () => {
    const browser = controller();
    const first = browser.state.activeTabId;
    await browser.dispatch({ type: "tab:navigate", id: first, url: "https://example.com/" });
    await browser.dispatch({ type: "tab:create", url: "https://example.org/", background: true });
    const second = browser.state.tabs.find((tab) => tab.url === "https://example.org/")!.id;
    await browser.dispatch({ type: "tab:split", id: second });
    const frames = await browser.freeze();
    expect(frames.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
      { x: 200, y: 80, width: 496, height: 700 },
      { x: 704, y: 80, width: 496, height: 700 },
    ]);
    browser.hidePages();
    contents(browser, second).emit("before-mouse-event", {}, { type: "mouseDown" });
    expect(browser.state.activeTabId).toBe(first);
  });

  it("returns no image when capture fails, is slow, or the window is minimized", async () => {
    vi.useFakeTimers();
    try {
      const browser = controller();
      const id = browser.state.activeTabId;
      await browser.dispatch({ type: "tab:navigate", id, url: "https://example.com/" });
      const page = contents(browser, id);
      page.capturePage.mockReturnValueOnce(new Promise<FakeImage>(() => {}));
      const slow = browser.freeze();
      await vi.advanceTimersByTimeAsync(300);
      expect(await slow).toEqual([]);
      page.capturePage.mockRejectedValueOnce(new Error("GPU process gone"));
      expect(await browser.freeze()).toEqual([]);
      (browser.window as unknown as { isMinimized: () => boolean }).isMinimized = () => true;
      const calls = page.capturePage.mock.calls.length;
      expect(await browser.freeze()).toEqual([]);
      expect(page.capturePage).toHaveBeenCalledTimes(calls);
      expect(viewFor(page).visible).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("passwords", () => {
  it("publishes password prompts and tells where a tab's view is", async () => {
    const browser = controller();
    const published: unknown[] = [];
    browser.subscribe((state) => published.push(state.passwordPrompts));
    const first = browser.state.activeTabId;
    const prompt = {
      id: "prompt-1",
      tabId: first,
      kind: "save",
      host: "example.com",
      username: "alice",
    } as const;
    browser.setPasswordPrompts([prompt]);
    expect(browser.state.passwordPrompts).toEqual([prompt]);
    expect(published).toEqual([[prompt]]);
    expect(
      (browser.window.webContents as unknown as FakeContents).send,
    ).toHaveBeenLastCalledWith("kamapathy:state-changed", browser.state);
    browser.setPasswordPrompts([]);
    expect(published).toEqual([[prompt], []]);

    // Home has no view.
    expect(browser.viewPlacement(first)).toBeUndefined();
    await browser.dispatch({
      type: "tab:navigate",
      id: first,
      url: "https://example.com/",
    });
    const bounds = { x: 200, y: 80, width: 1000, height: 700 };
    expect(browser.viewPlacement(first)).toEqual({ bounds, visible: true });
    browser.hidePages();
    expect(browser.viewPlacement(first)).toEqual({ bounds, visible: false });
    browser.unfreeze();
    expect(browser.viewPlacement(first)).toEqual({ bounds, visible: true });
    await browser.dispatch({ type: "tab:create", url: "https://example.org/" });
    const second = browser.state.activeTabId;
    expect(browser.viewPlacement(first)).toEqual({ bounds, visible: false });
    expect(browser.viewPlacement(second)).toEqual({ bounds, visible: true });
    expect(browser.viewPlacement("missing")).toBeUndefined();
    contents(browser, first).destroyed = true;
    expect(browser.viewPlacement(first)).toBeUndefined();
  });
});

describe("space thumbnails", () => {
  it("keeps a small capture of a space the person leaves", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({ type: "tab:navigate", id, url: "https://example.com/" });
    await browser.dispatch({ type: "space:activate", id: "work" });
    await vi.waitFor(async () =>
      expect(await browser.thumbnails()).toEqual({ personal: jpegOf(480) }),
    );
  });

  it("stores the current space when a popover or the grid freezes the page", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({ type: "tab:navigate", id, url: "https://example.com/" });
    await browser.freeze();
    expect(await browser.thumbnails()).toEqual({ personal: jpegOf(480) });
  });

  it("captures agent spaces on request without showing them, and forgets deleted spaces", async () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    const tab = browser.state.tabs.find((item) => item.spaceId === space.id)!;
    await browser.dispatch({ type: "tab:navigate", id: tab.id, url: "https://example.com/" });
    const page = contents(browser, tab.id);
    expect(viewFor(page).visible).toBe(false);
    expect(await browser.thumbnails()).toEqual({ [space.id]: jpegOf(480) });
    expect(page.capturePage).toHaveBeenCalledWith(undefined, { stayHidden: true });
    await browser.dispatch({ type: "space:delete", id: space.id });
    expect(await browser.thumbnails()).toEqual({});
  });

  it("shows an agent's latest page, not its blank first tab, in the grid and when opened", async () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    const blank = browser.state.tabs.find((item) => item.spaceId === space.id)!;
    for (const url of ["https://example.com/one", "https://example.com/two"])
      await browser.dispatch({ type: "tab:create", spaceId: space.id, url, background: true });
    const latest = browser.state.tabs.filter((item) => item.spaceId === space.id).at(-1)!;
    expect(latest.id).not.toBe(blank.id);
    expect(await browser.thumbnails()).toEqual({ [space.id]: jpegOf(480) });
    expect(contents(browser, latest.id).capturePage).toHaveBeenCalled();
    await browser.dispatch({ type: "space:activate", id: space.id });
    expect(browser.state.activeTabId).toBe(latest.id);
  });
});

describe("agent captures", () => {
  // The window the last capture lent a view to.
  const captureWindow = () =>
    vi.mocked(BaseWindow).mock.results.at(-1)!.value as FakeBaseWindow;
  // A loaded page in an agent space, whose view the window keeps hidden.
  async function backgroundTab(browser: BrowserController) {
    const space = browser.createAgentSpace("Task");
    const tab = browser.state.tabs.find((item) => item.spaceId === space.id)!;
    await browser.dispatch({
      type: "tab:navigate",
      id: tab.id,
      url: "https://example.com/agent",
    });
    const view = viewFor(contents(browser, tab.id));
    expect(view.visible).toBe(false);
    return { tab, view };
  }

  it("a capture of a background tab lends its view to a never-shown capture window and puts it back at its old index", async () => {
    const browser = controller();
    const window = windowOf(browser);
    // The person shrank the window below the size a never-shown view keeps.
    window.getBounds = () => ({ x: 40, y: 60, width: 900, height: 600 });
    const first = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id: first,
      url: "https://example.com/one",
    });
    const shown = viewFor(contents(browser, first));
    const { tab, view } = await backgroundTab(browser);
    await browser.dispatch({
      type: "tab:create",
      url: "https://example.com/two",
      background: true,
    });
    const last = browser.state.tabs.at(-1)!;
    viewFor(contents(browser, last.id));
    const index = window.contentView.children.indexOf(view);
    expect(index).toBe(1);
    expect(window.contentView.children).toHaveLength(3);
    const layout = vi.spyOn(
      browser as unknown as { layout: () => void },
      "layout",
    );
    let during: Record<string, unknown> = {};
    expect(
      await browser.withVisibleView(tab.id, async () => {
        const host = captureWindow();
        during = {
          inMain: window.contentView.children.includes(view),
          inHost: host.contentView.children.includes(view),
          visible: view.visible,
          bounds: host.bounds,
          grown: host.setContentSize.mock.calls,
        };
        return "png";
      }),
    ).toBe("png");
    expect(during).toEqual({
      inMain: false,
      inHost: true,
      visible: true,
      bounds: { x: 40, y: 60, width: 900, height: 600 },
      grown: [[1200, 800]],
    });
    const host = captureWindow();
    expect(vi.mocked(BaseWindow).mock.calls).toEqual([
      [
        {
          show: false,
          skipTaskbar: true,
          frame: process.platform === "darwin",
          titleBarStyle:
            process.platform === "darwin" ? "hiddenInset" : "hidden",
          x: 40,
          y: 60,
          width: 900,
          height: 600,
        },
      ],
    ]);
    expect(host.contentView.children).toEqual([]);
    expect(window.contentView.children.indexOf(view)).toBe(index);
    expect(view.visible).toBe(false);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
    expect(layout).toHaveBeenCalledTimes(1);
    for (const spy of [window.show, window.focus, host.show, host.focus])
      expect(spy).not.toHaveBeenCalled();
    expect(shown.visible).toBe(true);
  });

  it("layout and freeze leave a lent view alone while state changes", async () => {
    const browser = controller();
    const { tab, view } = await backgroundTab(browser);
    let touched = 0;
    let frames: unknown[] = [];
    await browser.withVisibleView(tab.id, async () => {
      const before =
        view.setVisible.mock.calls.length + view.setBounds.mock.calls.length;
      // Another space's agent writes activity, which lays the window out.
      browser.addActivity("personal", "Agent opened a page", "info");
      browser.setContentBounds({
        x: 100,
        y: 60,
        width: 800,
        height: 600,
        hidden: false,
      });
      frames = await browser.freeze();
      touched =
        view.setVisible.mock.calls.length +
        view.setBounds.mock.calls.length -
        before;
      return "png";
    });
    expect(touched).toBe(0);
    expect(frames).toEqual([]);
    expect(contents(browser, tab.id).capturePage).not.toHaveBeenCalled();
    // The layout that follows gives it the hidden state it had.
    expect(view.visible).toBe(false);
  });

  it("the shown tab captures in place, and the shown tab of a minimized window is lent", async () => {
    const browser = controller();
    const window = windowOf(browser);
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/",
    });
    const view = viewFor(contents(browser, id));
    expect(view.visible).toBe(true);
    const visibility = view.setVisible.mock.calls.length;
    expect(await browser.withVisibleView(id, async () => "in place")).toBe(
      "in place",
    );
    expect(BaseWindow).not.toHaveBeenCalled();
    expect(view.setVisible.mock.calls).toHaveLength(visibility);
    expect(window.contentView.children).toContain(view);
    // A tab with no page of its own captures as it is.
    await browser.dispatch({ type: "tab:create", background: true });
    const blank = browser.state.tabs.at(-1)!;
    expect(blank.url).toBe(HOME_URL);
    expect(await browser.withVisibleView(blank.id, async () => "no view")).toBe(
      "no view",
    );
    expect(BaseWindow).not.toHaveBeenCalled();
    // Minimized, Chromium stops painting the view where it is.
    window.isMinimized = () => true;
    expect(await browser.withVisibleView(id, async () => "lent")).toBe("lent");
    expect(BaseWindow).toHaveBeenCalledTimes(1);
    expect(captureWindow().contentView.children).toEqual([]);
    expect(window.contentView.children).toContain(view);
    expect(view.visible).toBe(true);
  });

  it("a tab closed during a capture is not put back, and dispose destroys the capture window", async () => {
    const browser = controller();
    const window = windowOf(browser);
    const { tab, view } = await backgroundTab(browser);
    await browser.withVisibleView(tab.id, async () => {
      browser.closeTab(tab.id, "agent");
      return "png";
    });
    const host = captureWindow();
    expect(host.contentView.children).toEqual([]);
    expect(window.contentView.children).not.toContain(view);
    expect(host.destroy).not.toHaveBeenCalled();
    browser.dispose();
    expect(host.destroy).toHaveBeenCalledTimes(1);
  });

  it("a window closed during a capture takes the capture window with it", async () => {
    const browser = controller();
    const window = windowOf(browser);
    const { tab, view } = await backgroundTab(browser);
    expect(
      await browser.withVisibleView(tab.id, async () => {
        // The person closes the window, which disposes the controller.
        browser.dispose();
        return "png";
      }),
    ).toBe("png");
    const host = captureWindow();
    expect(host.destroy).toHaveBeenCalledTimes(1);
    expect(host.contentView.children).toEqual([]);
    expect(window.contentView.children).not.toContain(view);
  });

  it("cropPng crops from the top left, and deviceScale reads the display the window is on", async () => {
    const browser = controller();
    const exact = fakePng(200, 100);
    expect(browser.cropPng(exact, 200, 100)).toEqual({
      png: exact,
      width: 200,
      height: 100,
    });
    expect(browser.cropPng(exact, 200, 100)!.png).toBe(exact);
    expect(browser.cropPng(fakePng(201, 101), 200, 100)).toEqual({
      png: fakePng(200, 100),
      width: 200,
      height: 100,
    });
    // Never past the image Chromium sent.
    expect(browser.cropPng(fakePng(100, 50), 200, 100)).toEqual({
      png: fakePng(100, 50),
      width: 100,
      height: 50,
    });
    expect(browser.cropPng(Buffer.alloc(0), 200, 100)).toBeNull();
    expect(browser.deviceScale()).toBe(2);
    expect(screen.getDisplayMatching).toHaveBeenCalledWith(
      windowOf(browser).getBounds(),
    );
  });
});

describe("keyboard shortcuts", () => {
  const primary =
    process.platform === "darwin" ? { meta: true } : { control: true };
  function press(browser: BrowserController, input: Record<string, unknown>) {
    const shell = browser.window.webContents as unknown as FakeContents;
    shell.send.mockClear();
    shell.emit(
      "before-input-event",
      { preventDefault: vi.fn() },
      {
        type: "keyDown",
        key: "",
        code: "",
        meta: false,
        control: false,
        alt: false,
        shift: false,
        ...input,
      },
    );
    return shell.send.mock.calls.find(
      ([channel]) => channel === "kamapathy:shortcut",
    )?.[1];
  }
  it("has no sidebar shortcut", () => {
    const browser = controller();
    expect(press(browser, { ...primary, key: "b", code: "KeyB" })).toBeUndefined();
  });
  it("leaves Option+S to web pages and text fields", () => {
    const browser = controller();
    expect(press(browser, { alt: true, key: "ß", code: "KeyS" })).toBeUndefined();
  });
  it("opens bookmarks, history and downloads from the keyboard", () => {
    const browser = controller();
    expect(press(browser, { ...primary, shift: true, key: "B", code: "KeyB" })).toBe("bookmarks");
    const history =
      process.platform === "darwin"
        ? { key: "y", code: "KeyY" }
        : { key: "h", code: "KeyH" };
    expect(press(browser, { ...primary, ...history })).toBe("history");
    expect(press(browser, { ...primary, shift: true, key: "J", code: "KeyJ" })).toBe("downloads");
    expect(press(browser, { ...primary, key: "j", code: "KeyJ" })).toBeUndefined();
  });
});

describe("view hooks", () => {
  it("runs view-created listeners before the first loadURL", async () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    const created: {
      tabId: string;
      page: unknown;
      loads: number;
      menus: number;
    }[] = [];
    const stop = browser.onViewCreated((tabId, page) => {
      created.push({
        tabId,
        page,
        loads: vi.mocked(page.loadURL).mock.calls.length,
        // The context menu handler is the last event ensureView wires.
        menus: page.listenerCount("context-menu"),
      });
    });
    await browser.dispatch({
      type: "tab:create",
      spaceId: space.id,
      url: "https://example.com/",
      background: true,
    });
    const tab = browser.state.tabs.at(-1)!;
    const page = contents(browser, tab.id);
    expect(created).toEqual([{ tabId: tab.id, page, loads: 0, menus: 1 }]);
    expect(page.loadURL).toHaveBeenCalledExactlyOnceWith("https://example.com/");
    const guest = new FakeContents();
    expect(popup(page, { url: "https://example.com/popup" }, guest).returned).toBe(
      guest,
    );
    const opened = browser.state.tabs.at(-1)!;
    expect(opened).toMatchObject({
      spaceId: space.id,
      url: "https://example.com/popup",
    });
    expect(contents(browser, opened.id)).toBe(guest);
    expect(created).toEqual([
      { tabId: tab.id, page, loads: 0, menus: 1 },
      { tabId: opened.id, page: guest, loads: 0, menus: 1 },
    ]);
    // Chromium loads the popup itself.
    expect(guest.loadURL).not.toHaveBeenCalled();
    // Navigating a page that has a view reuses it, so listeners do not run again.
    await browser.dispatch({
      type: "tab:navigate",
      id: tab.id,
      url: "https://example.com/next",
    });
    expect(created).toHaveLength(2);
    stop();
    await browser.dispatch({
      type: "tab:create",
      spaceId: space.id,
      url: "https://example.org/",
      background: true,
    });
    expect(created).toHaveLength(2);
  });

  it("peekWebContents never creates a view", () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    const blank = browser.state.tabs.find((tab) => tab.spaceId === space.id)!;
    // A saved web tab has no view until it is shown or used.
    const saved = newTab(space.id, "https://example.com/");
    browser.state.tabs.push(saved);
    for (const id of [blank.id, saved.id, "missing"])
      expect(browser.peekWebContents(id)).toBeUndefined();
    expect(WebContentsView).not.toHaveBeenCalled();
    const page = contents(browser, saved.id);
    expect(WebContentsView).toHaveBeenCalledOnce();
    expect(browser.peekWebContents(saved.id)).toBe(page);
    page.destroyed = true;
    expect(browser.peekWebContents(saved.id)).toBeUndefined();
    expect(WebContentsView).toHaveBeenCalledOnce();
  });

  it("keeps loading a page when a view-created listener throws", async () => {
    const browser = controller();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const order: string[] = [];
      browser.onViewCreated(() => {
        order.push("first");
        throw new Error("Listener failed");
      });
      browser.onViewCreated(() => {
        order.push("second");
      });
      await browser.dispatch({
        type: "tab:create",
        url: "https://example.com/",
        background: true,
      });
      const tab = browser.state.tabs.at(-1)!;
      expect(order).toEqual(["first", "second"]);
      expect(contents(browser, tab.id).loadURL).toHaveBeenCalledExactlyOnceWith(
        "https://example.com/",
      );
      expect(logged).toHaveBeenCalledExactlyOnceWith(
        "View listener failed:",
        "Listener failed",
      );
    } finally {
      logged.mockRestore();
    }
  });
});


describe("tab origins and agent rules", () => {
  const person = {
    openedBy: "person",
    managed: false,
    createdAt: expect.any(Number),
  };
  // The web preferences the view of a page was created with.
  it("interface tabs are stamped person", async () => {
    const browser = controller();
    for (const tab of browser.state.tabs) {
      expect(tab).toMatchObject(person);
      expect(tab).not.toHaveProperty("label");
    }
    await browser.dispatch({ type: "tab:create", url: "https://example.com/" });
    const created = browser.state.tabs.at(-1)!;
    expect(created).toMatchObject(person);
    await browser.dispatch({ type: "tab:duplicate", id: created.id });
    expect(browser.state.tabs.at(-1)).toMatchObject({
      ...person,
      url: "https://example.com/",
    });
    await browser.dispatch({ type: "tab:close", id: created.id });
    await browser.dispatch({ type: "tab:reopen" });
    expect(browser.state.tabs.at(-1)).toMatchObject({
      ...person,
      url: "https://example.com/",
    });
    await browser.dispatch({
      type: "space:create",
      kind: "personal",
      color: "blue",
      name: "Errands",
    });
    const errands = browser.state.spaces.at(-1)!;
    expect(errands).toMatchObject({ kind: "personal", createdBy: "person" });
    expect(errands).not.toHaveProperty("access");
    expect(browser.state.tabs.at(-1)).toMatchObject({
      ...person,
      spaceId: errands.id,
    });
    // An agent space the person makes follows agent rules, so its tabs are
    // labeled, but they stay the person's.
    await browser.dispatch({
      type: "space:create",
      kind: "agent",
      color: "purple",
      name: "Manual task",
    });
    const manual = browser.state.spaces.at(-1)!;
    expect(manual).toMatchObject({
      kind: "agent",
      owner: "human",
      createdBy: "person",
      pageBudget: PAGE_BUDGET,
    });
    expect(manual).not.toHaveProperty("access");
    const first = browser.state.tabs.at(-1)!;
    expect(first).toMatchObject({ ...person, spaceId: manual.id, label: "p1" });
    // Links opened from the context menu or another app come in as tab:create.
    await browser.dispatch({
      type: "tab:create",
      spaceId: manual.id,
      url: "https://example.org/",
      background: true,
    });
    const linked = browser.state.tabs.at(-1)!;
    expect(linked).toMatchObject({ ...person, label: "p2" });
    // A reopened tab is a new tab with a new label.
    await browser.dispatch({ type: "tab:close", id: linked.id });
    await browser.dispatch({ type: "tab:reopen" });
    expect(browser.state.tabs.at(-1)).toMatchObject({
      ...person,
      url: "https://example.org/",
      label: "p3",
    });
    expect(browser.registry.closed(manual.id)).toEqual([
      { label: "p2", closedBy: "person", at: expect.any(Number) },
    ]);
  });

  it("an API space's first tab is p1, agent-opened and managed, and openAgentTab adds managed agent tabs in the background", () => {
    const browser = controller();
    const selection = {
      space: browser.state.activeSpaceId,
      tab: browser.state.activeTabId,
    };
    const space = browser.createAgentSpace("Task", { pageBudget: 5 });
    expect(space).toMatchObject({
      kind: "agent",
      owner: "agent",
      createdBy: "agent",
      pageBudget: 5,
      access: "granted",
    });
    expect(browser.createAgentSpace("Other").pageBudget).toBe(PAGE_BUDGET);
    const first = browser.state.tabs.find((tab) => tab.spaceId === space.id)!;
    expect(first).toMatchObject({
      url: HOME_URL,
      label: "p1",
      openedBy: "agent",
      managed: true,
      createdAt: expect.any(Number),
    });
    expect(first).not.toHaveProperty("unseen");
    const emitted = vi.fn();
    browser.subscribe(emitted);
    const page = browser.openAgentTab(space.id, "example.com/docs");
    expect(page).toMatchObject({
      spaceId: space.id,
      url: "https://example.com/docs",
      label: "p2",
      openedBy: "agent",
      managed: true,
    });
    expect(browser.state.tabs.at(-1)).toBe(page);
    expect(emitted).toHaveBeenCalled();
    expect(
      contents(browser, page.id).loadURL,
    ).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
    const blank = browser.openAgentTab(space.id);
    expect(blank).toMatchObject({
      url: HOME_URL,
      label: "p3",
      openedBy: "agent",
      managed: true,
    });
    expect(browser.peekWebContents(blank.id)).toBeUndefined();
    expect(WebContentsView).toHaveBeenCalledOnce();
    expect({
      space: browser.state.activeSpaceId,
      tab: browser.state.activeTabId,
    }).toEqual(selection);
    expect(browser.registry.used(space.id)).toBe(3);
    while (browser.state.tabs.length < 200)
      browser.state.tabs.push(newTab("personal"));
    expect(() => browser.openAgentTab(space.id)).toThrow("200 tabs");
  });

  it("closeTab retires the label and gives a last closed tab a blank replacement with the closer's origin", async () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    const first = browser.state.tabs.find((tab) => tab.spaceId === space.id)!;
    const second = browser.openAgentTab(space.id, "https://example.com/");
    const page = contents(browser, second.id);
    const emitted = vi.fn();
    browser.subscribe(emitted);
    expect(browser.closeTab(second.id, "agent")).toEqual({ closed: "p2" });
    expect(emitted).toHaveBeenCalled();
    expect(page.destroyed).toBe(true);
    expect(browser.state.tabs).not.toContain(second);
    const spaceTabs = () =>
      browser.state.tabs.filter((tab) => tab.spaceId === space.id);
    // A page that closes the agent's last tab leaves one like it.
    const byPage = browser.closeTab(first.id, "page");
    expect(byPage).toEqual({
      closed: "p1",
      replacement: expect.objectContaining({
        url: HOME_URL,
        label: "p3",
        openedBy: "agent",
        managed: true,
      }),
    });
    expect(spaceTabs()).toEqual([byPage.replacement]);
    const byPerson = browser.closeTab(byPage.replacement!.id, "person");
    expect(byPerson.replacement).toMatchObject({
      label: "p4",
      openedBy: "person",
      managed: false,
    });
    const byAgent = browser.closeTab(byPerson.replacement!.id, "agent");
    expect(byAgent.replacement).toMatchObject({
      label: "p5",
      openedBy: "agent",
      managed: true,
    });
    // The person's own close goes through the same path.
    await browser.dispatch({ type: "tab:close", id: byAgent.replacement!.id });
    expect(spaceTabs()).toMatchObject([
      { label: "p6", openedBy: "person", managed: false },
    ]);
    expect(browser.registry.closed(space.id)).toEqual(
      [
        ["p2", "agent"],
        ["p1", "page"],
        ["p3", "person"],
        ["p4", "agent"],
        ["p5", "person"],
      ].map(([label, closedBy]) => ({
        label,
        closedBy,
        at: expect.any(Number),
      })),
    );
    // Only the person's close of a personal space's last empty tab closes
    // the window.
    const work = browser.state.tabs.find((tab) => tab.spaceId === "work")!;
    expect(browser.closeTab(work.id, "agent")).toEqual({
      replacement: expect.objectContaining({ spaceId: "work", url: HOME_URL }),
    });
    expect(browser.window.close).not.toHaveBeenCalled();
    expect(() => browser.closeTab("missing", "agent")).toThrow(
      "Tab was not found.",
    );
  });

  it("agent rules follow kind and grants for history, popup activation, permissions, downloads, throttling and thumbnails", async () => {
    expect(agentRules({ kind: "agent" })).toBe(true);
    expect(agentRules({ kind: "agent", access: "ended" })).toBe(true);
    expect(agentRules({ kind: "personal" })).toBe(false);
    expect(agentRules({ kind: "personal", access: "granted" })).toBe(true);
    expect(agentRules({ kind: "personal", access: "ended" })).toBe(false);
    const browser = controller();
    const work = browser.state.spaces.find((space) => space.id === "work")!;
    await browser.dispatch({ type: "space:activate", id: "work" });
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "https://example.com/",
    });
    const page = contents(browser, id);
    page.commit("https://example.com/");
    page.emit("page-title-updated", {}, "Before");
    expect(browser.state.history).toMatchObject([
      { url: "https://example.com/", title: "Before" },
    ]);
    // A grant hands the space to the agent, sets access and labels its
    // tabs; set them directly.
    work.access = "granted";
    work.owner = "agent";
    browser.registry.labelSpace(work.id);
    const shared = sessions.get("persist:space-personal")!;
    const request = shared.setPermissionRequestHandler.mock.calls[0][0];
    const check = shared.setPermissionCheckHandler.mock.calls[0][0];
    const item = {
      setSaveDialogOptions: vi.fn(),
      getFilename: () => "report.pdf",
      getTotalBytes: () => 10,
      on: vi.fn(),
      once: vi.fn(),
    };
    expect(page.setBackgroundThrottling).not.toHaveBeenCalled();
    page.emit("page-title-updated", {}, "Granted");
    page.commit("https://example.com/next");
    expect(page.setBackgroundThrottling).toHaveBeenCalledExactlyOnceWith(false);
    expect(browser.state.history).toMatchObject([
      { url: "https://example.com/", title: "Before" },
    ]);
    const backgroundPage = new FakeContents();
    const granted = popup(
      page,
      { url: "https://example.com/popup" },
      backgroundPage,
    );
    const background = browser.state.tabs.at(-1)!;
    expect(background).toMatchObject({
      url: "https://example.com/popup",
      openedBy: "page",
      openerId: id,
      managed: false,
      label: "p2",
      unseen: true,
    });
    expect(browser.state.activeTabId).toBe(id);
    expect(granted.decision).toMatchObject({
      overrideBrowserWindowOptions: {
        webPreferences: { backgroundThrottling: false },
      },
    });
    expect(backgroundPage.setBackgroundThrottling).toHaveBeenCalledWith(false);
    const refused = vi.fn();
    request(page, "notifications", refused, {
      requestingUrl: "https://example.com/",
      isMainFrame: true,
    });
    expect(refused).toHaveBeenCalledExactlyOnceWith(false);
    expect(check(page, "notifications", "https://example.com/", {})).toBe(
      false,
    );
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    const blocked = { preventDefault: vi.fn() };
    shared.emit("will-download", blocked, item, page);
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    expect(browser.state.downloads).toEqual([]);
    expect(await browser.thumbnails()).toEqual({ work: jpegOf(480) });
    expect(page.capturePage).toHaveBeenCalledExactlyOnceWith(undefined, {
      stayHidden: true,
    });
    // When the grant ends, personal rules apply again.
    delete work.access;
    work.owner = "human";
    page.commit("https://example.org/");
    expect(page.setBackgroundThrottling).toHaveBeenCalledOnce();
    expect(browser.state.history).toMatchObject([
      { url: "https://example.org/" },
      { url: "https://example.com/" },
    ]);
    page.emit("page-title-updated", {}, "Personal again");
    expect(browser.state.history[0].title).toBe("Personal again");
    const personalPopup = popup(page, { url: "https://example.org/popup" });
    const foreground = browser.state.tabs.at(-1)!;
    expect(browser.state.activeTabId).toBe(foreground.id);
    expect(foreground).toMatchObject({ openedBy: "page", openerId: id });
    expect(foreground).not.toHaveProperty("label");
    expect(foreground).not.toHaveProperty("unseen");
    expect(personalPopup.decision).toMatchObject({
      overrideBrowserWindowOptions: {
        webPreferences: { backgroundThrottling: true },
      },
    });
    const asked = vi.fn();
    request(page, "notifications", asked, {
      requestingUrl: "https://example.org/",
      isMainFrame: true,
    });
    expect(browser.state.prompts).toMatchObject([
      { spaceId: "work", kind: "notifications", agent: false },
    ]);
    browser.prompts.answer({ id: browser.state.prompts[0].id, allow: false });
    expect(asked).toHaveBeenCalledExactlyOnceWith(false);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    const allowed = { preventDefault: vi.fn() };
    shared.emit("will-download", allowed, item, page);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    expect(browser.state.downloads[0].filename).toBe("report.pdf");
    await browser.thumbnails();
    expect(page.capturePage).toHaveBeenCalledOnce();
  });
});

describe("agent access", () => {
  it("grants apply and remove agent rules", async () => {
    const browser = controller();
    const tab = browser.state.tabs.find((item) => item.spaceId === "work")!;
    await browser.dispatch({
      type: "tab:navigate",
      id: tab.id,
      url: "https://example.com/",
    });
    const page = contents(browser, tab.id);
    page.commit("https://example.com/");
    expect(browser.state.history.map((entry) => entry.url)).toEqual([
      "https://example.com/",
    ]);
    // Only the agent service grants a space, and a personal space nobody
    // granted has no owner but the person.
    await expect(
      browser.dispatch({ type: "space:grant", id: "work" }),
    ).rejects.toThrow("Turn on agent access first.");
    await expect(
      browser.dispatch({ type: "space:ownership", id: "work", owner: "human" }),
    ).rejects.toThrow("change ownership");
    browser.grantAccess("work");
    const work = browser.state.spaces.find((space) => space.id === "work")!;
    expect(work).toMatchObject({
      kind: "personal",
      owner: "agent",
      access: "granted",
    });
    expect(tab).toMatchObject({
      label: "p1",
      openedBy: "person",
      managed: false,
    });
    expect(page.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    // The whole space follows agent rules: no history, prompts or downloads.
    page.commit("https://example.org/");
    expect(browser.state.history.map((entry) => entry.url)).toEqual([
      "https://example.com/",
    ]);
    const shared = sessions.get("persist:space-personal")!;
    const answer = vi.fn();
    shared.setPermissionRequestHandler.mock.calls[0][0](
      page,
      "notifications",
      answer,
      { requestingUrl: "https://example.org/", isMainFrame: true },
    );
    expect(answer).toHaveBeenCalledExactlyOnceWith(false);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    const download = { preventDefault: vi.fn() };
    shared.emit("will-download", download, {}, page);
    expect(download.preventDefault).toHaveBeenCalledOnce();
    // The person can take over a granted space and hand it back.
    await browser.dispatch({
      type: "space:ownership",
      id: "work",
      owner: "human",
    });
    expect(work).toMatchObject({
      owner: "human",
      control: { reason: "manual" },
    });
    await browser.dispatch({
      type: "space:ownership",
      id: "work",
      owner: "agent",
    });
    expect(work.owner).toBe("agent");
    // Stop ends the grant and its rules, and the pages throttle again.
    await browser.dispatch({ type: "space:stop", id: "work" });
    expect(work).toMatchObject({
      owner: "human",
      access: "ended",
      ended: { by: "person", reason: "stopped" },
    });
    expect(tab.managed).toBe(false);
    expect(page.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(browser.state.activity[0]).toMatchObject({
      spaceId: "work",
      message: "You stopped the agent",
      kind: "info",
    });
    page.commit("https://example.net/");
    expect(browser.state.history[0].url).toBe("https://example.net/");
    // Finish ends a grant the same way, and so does agent access going off.
    browser.grantAccess("work");
    expect(work.ended).toBeUndefined();
    expect(page.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    browser.endAccess("work", { by: "agent", reason: "finished" });
    expect(browser.state.activity[0]).toMatchObject({
      spaceId: "work",
      message: "Agent finished",
      kind: "success",
    });
    browser.grantAccess("work");
    browser.resetAgentAccess();
    expect(work).toMatchObject({ kind: "personal", owner: "human" });
    expect(work.access).toBeUndefined();
    expect(page.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
  });

  it("a kept isolated space moves to a persistent partition and a shared one keeps its pages", async () => {
    const browser = controller();
    const isolated = browser.createAgentSpace("Clean", { isolated: true });
    const shared = browser.createAgentSpace("Task");
    const open = async (spaceId: string) => {
      const tab = browser.state.tabs.find((item) => item.spaceId === spaceId)!;
      await browser.dispatch({
        type: "tab:navigate",
        id: tab.id,
        url: "https://example.com/",
      });
      return { tab, page: contents(browser, tab.id) };
    };
    const clean = await open(isolated.id);
    const task = await open(shared.id);
    const temporary = [...sessions.keys()].find((partition) =>
      partition.endsWith(isolated.id),
    )!;
    expect(temporary).toMatch(/^agent-/);
    // Only an agent space whose access ended can be kept.
    for (const id of [isolated.id, "work"])
      await expect(
        browser.dispatch({ type: "space:keep", id }),
      ).rejects.toThrow(
        "Only a space whose agent has finished or stopped can be kept.",
      );
    browser.endAccess(isolated.id, { by: "agent", reason: "finished" });
    await browser.dispatch({ type: "space:keep", id: isolated.id });
    expect(isolated).toMatchObject({
      kind: "personal",
      owner: "human",
      signIns: "separate",
    });
    expect(isolated.access).toBeUndefined();
    expect(isolated.ended).toBeUndefined();
    // Its temporary sign-ins end, and its pages reload in its own
    // persistent session.
    expect(clean.page.destroyed).toBe(true);
    expect(sessions.get(temporary)!.clearStorageData).toHaveBeenCalledOnce();
    const reloaded = contents(browser, clean.tab.id);
    expect(reloaded).not.toBe(clean.page);
    expect(reloaded.loadURL).toHaveBeenCalledWith("https://example.com/");
    expect(sessions.has(`persist:space-${isolated.id}`)).toBe(true);
    // Shared sign-ins stay and so do the pages, which now throttle like any
    // personal page.
    browser.endAccess(shared.id, { by: "person", reason: "stopped" });
    await browser.dispatch({ type: "space:keep", id: shared.id });
    expect(shared).toMatchObject({
      kind: "personal",
      owner: "human",
      signIns: "shared",
    });
    expect(task.page.destroyed).toBe(false);
    expect(contents(browser, task.tab.id)).toBe(task.page);
    expect(task.page.setBackgroundThrottling).toHaveBeenLastCalledWith(true);
    expect(
      sessions.get("persist:space-personal")!.clearStorageData,
    ).not.toHaveBeenCalled();
  });

  it("space:sign-ins refuses a granted space", async () => {
    const browser = controller();
    browser.grantAccess("work");
    await expect(
      browser.dispatch({ type: "space:sign-ins", id: "work", signIns: "separate" }),
    ).rejects.toThrow(
      "Stop agent access to this space before changing its sign-ins.",
    );
    expect(browser.state.spaces[1].signIns).toBe("shared");
    await browser.dispatch({ type: "space:stop", id: "work" });
    await browser.dispatch({
      type: "space:sign-ins",
      id: "work",
      signIns: "separate",
    });
    expect(browser.state.spaces[1].signIns).toBe("separate");
  });
});

describe("popups", () => {
  // An agent space with a page at https://example.com/, the opener of the
  // popups each test makes.
  async function agentPage(browser: BrowserController) {
    const space = browser.createAgentSpace("Task");
    const opener = browser.state.tabs.find((tab) => tab.spaceId === space.id)!;
    await browser.dispatch({
      type: "tab:navigate",
      id: opener.id,
      url: "https://example.com/",
    });
    const page = contents(browser, opener.id);
    page.commit("https://example.com/");
    return { space, opener, page };
  }

  it("a window.open popup becomes a background agent tab with opener, label and managed state, and a foreground personal one", async () => {
    const browser = controller();
    const { space, opener, page } = await agentPage(browser);
    const selection = [browser.state.activeSpaceId, browser.state.activeTabId];
    const guest = new FakeContents();
    const { decision, returned } = popup(
      page,
      { url: "https://example.com/popup" },
      guest,
    );
    expect(decision).toMatchObject({
      action: "allow",
      outlivesOpener: true,
      overrideBrowserWindowOptions: { show: false },
    });
    expect(returned).toBe(guest);
    const tab = browser.state.tabs.at(-1)!;
    expect(tab).toMatchObject({
      spaceId: space.id,
      url: "https://example.com/popup",
      openedBy: "page",
      openerId: opener.id,
      label: "p2",
      managed: true,
      unseen: true,
    });
    expect(contents(browser, tab.id)).toBe(guest);
    expect(viewFor(guest).visible).toBe(false);
    expect([browser.state.activeSpaceId, browser.state.activeTabId]).toEqual(
      selection,
    );
    // A popup is the agent's only when its opener is and the agent has
    // control.
    browser.setManaged(opener.id, false);
    popup(page, { url: "https://example.com/second" });
    expect(browser.state.tabs.at(-1)).toMatchObject({
      openerId: opener.id,
      label: "p3",
      managed: false,
    });
    browser.setManaged(opener.id, true);
    await browser.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    popup(page, { url: "https://example.com/third" });
    expect(browser.state.tabs.at(-1)).toMatchObject({
      label: "p4",
      managed: false,
    });
    // A personal popup opens in front, without a label.
    const personalId = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id: personalId,
      url: "https://example.org/",
    });
    popup(contents(browser, personalId), { url: "https://example.org/popup" });
    const personal = browser.state.tabs.at(-1)!;
    expect(personal).toMatchObject({
      spaceId: "personal",
      openedBy: "page",
      openerId: personalId,
      managed: false,
    });
    expect(personal).not.toHaveProperty("label");
    expect(browser.state.activeTabId).toBe(personal.id);
  });

  it("popup web preferences match tab views", async () => {
    const browser = controller();
    const { page } = await agentPage(browser);
    const personalId = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id: personalId,
      url: "https://example.org/",
    });
    const personalPage = contents(browser, personalId);
    for (const opener of [page, personalPage]) {
      const { session: _session, ...expected } = preferencesOf(opener);
      const { decision } = popup(opener, { url: "https://example.com/popup" });
      expect(decision).toMatchObject({
        overrideBrowserWindowOptions: { webPreferences: expected },
      });
      expect(
        decision.action === "allow" &&
          decision.overrideBrowserWindowOptions.webPreferences,
      ).toEqual(expected);
    }
  });

  it("other schemes, credential URLs, data: URLs and popups past 20 tabs are denied, and the 20-tab denial is logged", async () => {
    const browser = controller();
    const { space, page } = await agentPage(browser);
    const tabs = browser.state.tabs.length;
    for (const url of [
      "mailto:someone@example.com",
      "file:///etc/hosts",
      "javascript:alert(1)",
      "https://user:secret@example.com/",
      "data:text/html,<p>Hello</p>",
      "about:srcdoc",
      "blob:null/1234",
    ])
      expect(popup(page, { url }).decision, url).toEqual({ action: "deny" });
    expect(browser.state.tabs).toHaveLength(tabs);
    for (const url of ["about:blank", "blob:https://example.com/1234"])
      expect(popup(page, { url }).decision.action, url).toBe("allow");
    while (
      browser.state.tabs.filter((tab) => tab.spaceId === space.id).length < 20
    )
      browser.openAgentTab(space.id);
    expect(popup(page, { url: "https://example.com/more" }).decision).toEqual({
      action: "deny",
    });
    expect(browser.state.activity[0]).toMatchObject({
      spaceId: space.id,
      message: "A popup was blocked. This space has 20 tabs.",
      kind: "warning",
    });
  });

  it("an about:blank popup is followed to its web URL, and closing itself closes its tab", async () => {
    const browser = controller();
    const { space, page } = await agentPage(browser);
    const guest = new FakeContents();
    popup(page, { url: "about:blank" }, guest);
    const tab = browser.state.tabs.at(-1)!;
    expect(tab).toMatchObject({ url: "about:blank", label: "p2" });
    guest.emit("did-start-navigation", {
      url: "https://example.com/written",
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(tab.url).toBe("https://example.com/written");
    guest.commit("https://example.com/written");
    // window.close() destroys the contents and leaves the view behind.
    const view = viewFor(guest);
    guest.destroyed = true;
    guest.emit("destroyed");
    expect(browser.state.tabs).not.toContain(tab);
    expect(windowOf(browser).contentView.removeChildView).toHaveBeenCalledWith(
      view,
    );
    expect(browser.registry.closed(space.id)).toMatchObject([
      { label: "p2", closedBy: "page" },
    ]);
  });

  it("popups without an opener load with referrer and form body, and refuse URLs Kamapathy would load outside their opener", async () => {
    const browser = controller();
    const { page } = await agentPage(browser);
    const referrer = { url: "https://example.com/", policy: "default" };
    const { returned } = popup(
      page,
      {
        url: "https://example.com/next",
        referrer,
        disposition: "background-tab",
      },
      null,
    );
    const opened = browser.state.tabs.at(-1)!;
    expect(returned).toBe(contents(browser, opened.id));
    expect(returned!.loadURL).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/next",
      { httpReferrer: referrer },
    );
    // Loaded by Kamapathy, these would run outside their opener, and a body
    // Kamapathy cannot send as it came is refused too.
    for (const details of [
      { url: "about:blank" },
      { url: "blob:https://example.com/1234" },
      {
        url: "https://example.com/form",
        postBody: {
          contentType: "text/plain",
          data: [{ type: "rawData", bytes: Buffer.from("name=Probe") }],
        },
      },
    ]) {
      const refused = popup(page, details, null).returned!;
      const tab = browser.state.tabs.at(-1)!;
      expect(refused.loadURL, details.url).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(browser.state.tabs).not.toContain(tab));
    }
  });

  it("throttling is turned off inside createWindow and after every navigation under agent rules", async () => {
    const browser = controller();
    const { page } = await agentPage(browser);
    const guest = new FakeContents();
    popup(page, { url: "https://example.com/popup" }, guest);
    expect(guest.setBackgroundThrottling).toHaveBeenCalledExactlyOnceWith(
      false,
    );
    guest.commit("https://example.com/next");
    expect(guest.setBackgroundThrottling).toHaveBeenCalledTimes(2);
    expect(guest.setBackgroundThrottling).toHaveBeenLastCalledWith(false);
    const personalId = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id: personalId,
      url: "https://example.org/",
    });
    const personal = new FakeContents();
    popup(
      contents(browser, personalId),
      { url: "https://example.org/popup" },
      personal,
    );
    personal.commit("https://example.org/next");
    expect(personal.setBackgroundThrottling).not.toHaveBeenCalled();
  });

  it("a popup whose first navigation is refused closes its tab", async () => {
    const browser = controller();
    const { page } = await agentPage(browser);
    const empty = new FakeContents();
    popup(page, { url: "https://example.com/popup" }, empty);
    const tab = browser.state.tabs.at(-1)!;
    const refusal = { preventDefault: vi.fn() };
    empty.emit("will-navigate", refusal, "mailto:someone@example.com");
    expect(refusal.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(browser.state.tabs).not.toContain(tab));
    // A popup with a document keeps its tab when a later navigation is refused.
    const loaded = new FakeContents();
    popup(page, { url: "https://example.com/popup" }, loaded);
    const kept = browser.state.tabs.at(-1)!;
    loaded.commit("https://example.com/popup");
    const later = { preventDefault: vi.fn() };
    loaded.emit("will-navigate", later, "mailto:someone@example.com");
    expect(later.preventDefault).toHaveBeenCalledOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(browser.state.tabs).toContain(kept);
    // Popups may go to about:blank and web-origin blob: URLs later on.
    for (const url of ["about:blank", "blob:https://example.com/1234"]) {
      const allowed = { preventDefault: vi.fn() };
      loaded.emit("will-navigate", allowed, url);
      expect(allowed.preventDefault, url).not.toHaveBeenCalled();
    }
  });

  it("any tab whose page closes itself is removed and its view leaves the window", async () => {
    const browser = controller();
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:create",
      url: "https://example.com/",
    });
    const tab = browser.state.tabs.find(
      (item) => item.id === browser.state.activeTabId,
    )!;
    expect(tab.id).not.toBe(id);
    const page = contents(browser, tab.id);
    const view = viewFor(page);
    page.destroyed = true;
    page.emit("destroyed");
    expect(browser.state.tabs).not.toContain(tab);
    expect(windowOf(browser).contentView.removeChildView).toHaveBeenCalledWith(
      view,
    );
    expect(browser.state.activeTabId).toBe(id);
    // Closing a tab from Kamapathy is not mistaken for the page closing it.
    await browser.dispatch({ type: "tab:create", url: "https://example.org/" });
    const other = browser.state.activeTabId;
    const otherPage = contents(browser, other);
    await browser.dispatch({ type: "tab:close", id: other });
    const remaining = [...browser.state.tabs];
    otherPage.emit("destroyed");
    expect(browser.state.tabs).toEqual(remaining);
    expect(browser.state.activeTabId).toBe(id);
  });
});

// Section 5: input an agent sent reaches the page and nothing else.
describe("agent input and the shell", () => {
  const primary =
    process.platform === "darwin" ? { meta: true } : { control: true };
  type Key = {
    key: string;
    code: string;
    alt?: boolean;
    control?: boolean;
    meta?: boolean;
    shift?: boolean;
  };
  const maskOf = (key: Key) =>
    (key.alt ? 1 : 0) |
    (key.control ? 2 : 0) |
    (key.meta ? 4 : 0) |
    (key.shift ? 8 : 0);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function agentTab() {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    await browser.dispatch({
      type: "tab:create",
      spaceId: space.id,
      url: "https://example.com/",
      background: true,
    });
    const tab = browser.state.tabs.at(-1)!;
    return { browser, page: contents(browser, tab.id) };
  }
  function sendKey(browser: BrowserController, page: FakeContents, key: Key) {
    const shell = browser.window.webContents as unknown as FakeContents;
    shell.send.mockClear();
    const event = { preventDefault: vi.fn() };
    page.emit("before-input-event", event, {
      type: "keyDown",
      meta: false,
      control: false,
      alt: false,
      shift: false,
      ...key,
    });
    return {
      shortcut: shell.send.mock.calls.find(
        ([channel]) => channel === "kamapathy:shortcut",
      )?.[1],
      prevented: event.preventDefault.mock.calls.length > 0,
    };
  }
  const menu = (page: FakeContents) =>
    page.emit(
      "context-menu",
      {},
      { x: 10, y: 20, linkURL: "", isEditable: false, selectionText: "" },
    );

  it("keeps agent keys out of the window's shortcuts while the person's keys still work", async () => {
    const { browser, page } = await agentTab();
    const keys: Key[] = [
      { ...primary, key: "w", code: "KeyW" },
      { key: "F12", code: "F12" },
      { alt: true, key: "ArrowLeft", code: "ArrowLeft" },
    ];
    for (const key of keys) {
      inputMarker.markKey(page, {
        key: key.key,
        code: key.code,
        type: "rawKeyDown",
        mask: maskOf(key),
      });
      expect(sendKey(browser, page, key)).toEqual({
        shortcut: undefined,
        prevented: false,
      });
    }
    // The same keys from the person keep today's behavior: each of these
    // prevents the page default and acts.
    expect(sendKey(browser, page, keys[0]).shortcut).toBe("close-tab");
    expect(sendKey(browser, page, keys[1]).prevented).toBe(true);
    expect(sendKey(browser, page, keys[2]).prevented).toBe(true);
    // A key of the person's ends the guard an agent's input leaves behind.
    inputMarker.markPointer(page);
    expect(inputMarker.pointerRecent(page)).toBe(true);
    sendKey(browser, page, { key: "a", code: "KeyA" });
    expect(inputMarker.pointerRecent(page)).toBe(false);
  });

  it("opens no native menu for an agent right click", async () => {
    const { page } = await agentTab();
    vi.mocked(Menu.buildFromTemplate).mockClear();
    inputMarker.markPointer(page);
    menu(page);
    await flush();
    expect(Menu.buildFromTemplate).not.toHaveBeenCalled();
    // The person's own click ends the guard at once.
    page.emit("before-mouse-event", {}, { type: "mouseDown" });
    menu(page);
    await flush();
    expect(Menu.buildFromTemplate).toHaveBeenCalledOnce();
  });

  it("activates no split pane from agent input", async () => {
    const browser = controller();
    const first = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id: first,
      url: "https://example.com/",
    });
    await browser.dispatch({
      type: "tab:create",
      url: "https://example.org/",
      background: true,
    });
    const second = browser.state.tabs.find(
      (tab) => tab.url === "https://example.org/",
    )!.id;
    await browser.dispatch({ type: "tab:split", id: second });
    const left = contents(browser, first);
    contents(browser, second).focus();
    expect(browser.state.activeTabId).toBe(second);
    const end = inputMarker.begin(left);
    left.emit("before-mouse-event", {}, { type: "mouseDown" });
    expect(browser.state.activeTabId).toBe(second);
    end();
    left.emit("before-mouse-event", {}, { type: "mouseDown" });
    expect(browser.state.activeTabId).toBe(first);
  });
});

describe("incoming space", () => {
  const tabsIn = (browser: BrowserController, spaceId: string) =>
    browser.state.tabs.filter((tab) => tab.spaceId === spaceId);

  it("help links open in the active personal space, else the one used last, else a new Personal space", async () => {
    const browser = controller();
    await browser.dispatch({ type: "space:activate", id: "work" });
    expect(browser.incomingSpace().id).toBe("work");
    const agent = browser.createAgentSpace("Task");
    await browser.dispatch({ type: "space:activate", id: agent.id });
    expect(browser.incomingSpace().id).toBe("work");
    // A granted personal space is passed over for the one used before it.
    await browser.dispatch({ type: "space:activate", id: "personal" });
    browser.grantAccess("personal");
    expect(browser.incomingSpace().id).toBe("work");
    // With every personal space granted, a new one takes the link, and
    // nothing changes the space in front.
    browser.grantAccess("work");
    const spaces = browser.state.spaces.length;
    const created = browser.incomingSpace();
    expect(created).toMatchObject({
      name: "Personal",
      color: "green",
      kind: "personal",
      owner: "human",
      signIns: "shared",
      createdBy: "person",
    });
    expect(created).not.toHaveProperty("access");
    expect(browser.state.spaces).toHaveLength(spaces + 1);
    expect(tabsIn(browser, created.id)).toEqual([
      expect.objectContaining({
        url: HOME_URL,
        openedBy: "person",
        managed: false,
      }),
    ]);
    expect(browser.state.activeSpaceId).toBe("personal");
    // It is used again rather than making another.
    expect(browser.incomingSpace()).toBe(created);
    expect(browser.state.spaces).toHaveLength(spaces + 1);
    // A 31st space is refused with the usual message.
    browser.grantAccess(created.id);
    while (browser.state.spaces.length < 30) browser.createAgentSpace("Task");
    expect(() => browser.incomingSpace()).toThrow(
      "The maximum of 30 spaces has been reached.",
    );
  });

  it("a personal space not used since start comes before a new one", () => {
    const browser = controller();
    browser.grantAccess("personal");
    expect(browser.incomingSpace().id).toBe("work");
    expect(browser.state.spaces).toHaveLength(2);
  });
});

describe("update state", () => {
  const sample = (
    progress?: { receivedBytes: number; totalBytes: number },
    over: Partial<UpdateState> = {},
  ): UpdateState => ({
    kind: "mac-arm64",
    state: "downloading",
    checkedAt: 5000,
    latest: {
      version: "0.3.0",
      publishedAt: 1000,
      url: "https://github.com/shayanmohd/kamapathy/releases/tag/v0.3.0",
      installer: {
        name: "Kamapathy-0.3.0-mac-arm64.dmg",
        size: 2097152,
        url: "https://github.com/shayanmohd/kamapathy/releases/download/v0.3.0/Kamapathy-0.3.0-mac-arm64.dmg",
      },
      sums: "https://github.com/shayanmohd/kamapathy/releases/download/v0.3.0/SHA256SUMS.txt",
    },
    ...(progress ? { progress } : {}),
    ...over,
  });

  it("sends progress at most once a second and saves only new check results", async () => {
    vi.useFakeTimers();
    try {
      const browser = controller();
      const shell = browser.window.webContents as unknown as FakeContents;
      const sent = () =>
        shell.send.mock.calls.filter(
          ([channel]) => channel === "kamapathy:state-changed",
        );
      vi.mocked(writeState).mockClear();
      const first = sent().length;
      browser.setUpdate(sample({ receivedBytes: 1, totalBytes: 10 }));
      expect(sent()).toHaveLength(first + 1);
      await vi.advanceTimersByTimeAsync(400);
      expect(writeState).toHaveBeenCalledTimes(1);

      // Progress alone waits for the trailing send, which carries the last one.
      vi.mocked(writeState).mockClear();
      browser.setUpdate(sample({ receivedBytes: 2, totalBytes: 10 }));
      browser.setUpdate(sample({ receivedBytes: 3, totalBytes: 10 }));
      expect(sent()).toHaveLength(first + 1);
      expect(browser.state.update.progress).toEqual({
        receivedBytes: 3,
        totalBytes: 10,
      });
      await vi.advanceTimersByTimeAsync(600);
      expect(sent()).toHaveLength(first + 2);
      expect(sent().at(-1)?.[1].update.progress).toEqual({
        receivedBytes: 3,
        totalBytes: 10,
      });
      await vi.advanceTimersByTimeAsync(400);
      expect(writeState).not.toHaveBeenCalled();

      // Any other change sends at once, and saves only with a new result.
      browser.setUpdate(
        sample(undefined, {
          state: "ready",
          installer: { path: "/tmp/installer.dmg", sha256: "a".repeat(64) },
        }),
      );
      expect(sent()).toHaveLength(first + 3);
      await vi.advanceTimersByTimeAsync(400);
      expect(writeState).not.toHaveBeenCalled();
      browser.setUpdate(sample(undefined, { state: "available", checkedAt: 9000 }));
      await vi.advanceTimersByTimeAsync(400);
      expect(writeState).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
describe("agent navigation", () => {
  // An agent space and its first tab, before anything loaded in it.
  function agentTab(browser: BrowserController) {
    const space = browser.createAgentSpace("Task");
    const tab = browser.state.tabs.find((item) => item.spaceId === space.id)!;
    return { space, tab };
  }
  const downloadItem = () => ({
    setSaveDialogOptions: vi.fn(),
    getFilename: () => "report.pdf",
    getTotalBytes: () => 10,
    on: vi.fn(),
    once: vi.fn(),
  });

  it("navigateAgentTab loads a URL with the referer exactly as given", async () => {
    const browser = controller();
    const { tab } = agentTab(browser);
    browser.navigateAgentTab(tab.id, "https://example.com/first");
    const page = contents(browser, tab.id);
    page.commit("https://example.com/first");
    page.emit("page-favicon-updated", {}, ["https://example.com/icon.png"]);
    page.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      "https://example.com/first",
      true,
    );
    expect(tab).toMatchObject({
      favicon: "https://example.com/icon.png",
      error: "ERR_CONNECTION_REFUSED",
    });
    browser.navigateAgentTab(tab.id, "https://example.com", {
      referer: "https://referrer.example/path?a=1",
    });
    expect(page.loadURL).toHaveBeenLastCalledWith("https://example.com", {
      httpReferrer: {
        url: "https://referrer.example/path?a=1",
        policy: "unsafe-url",
      },
    });
    // The URL reaches the page as given, so nothing normalizes it.
    expect(tab).toMatchObject({
      url: "https://example.com",
      title: "https://example.com",
      loading: true,
    });
    expect(tab).not.toHaveProperty("favicon");
    expect(tab).not.toHaveProperty("error");
  });

  it("navigateAgentTab creates a missing view and loads about:blank", async () => {
    const browser = controller();
    const { tab } = agentTab(browser);
    expect(browser.peekWebContents(tab.id)).toBeUndefined();
    browser.navigateAgentTab(tab.id, "about:blank");
    const page = contents(browser, tab.id);
    expect(page.loadURL).toHaveBeenCalledExactlyOnceWith("about:blank");
    expect(tab).toMatchObject({ url: "about:blank", title: "about:blank" });
    page.commit("about:blank");
    expect(tab).toMatchObject({ url: "about:blank", title: "about:blank" });
    page.emit("page-title-updated", {}, "Blank page");
    expect(tab.title).toBe("Blank page");
  });

  it("openAgentTab opens a blank page agents may use", async () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    const tab = browser.openAgentTab(space.id, "about:blank");
    expect(tab).toMatchObject({ url: "about:blank", title: "about:blank" });
    expect(contents(browser, tab.id).loadURL).toHaveBeenCalledExactlyOnceWith(
      "about:blank",
    );
  });

  it("navigateAgentTab refuses anything outside the agent URL rule", async () => {
    const browser = controller();
    const { tab } = agentTab(browser);
    for (const url of [
      "file:///etc/hosts",
      "data:text/html,<p>Hello</p>",
      "blob:https://example.com/1234",
      "view-source:https://example.com/",
      "https://user:secret@example.com/",
      "example.com",
      HOME_URL,
    ])
      expect(() => browser.navigateAgentTab(tab.id, url), url).toThrow(
        "This address cannot be opened.",
      );
    expect(tab.url).toBe(HOME_URL);
    expect(browser.peekWebContents(tab.id)).toBeUndefined();
    expect(() =>
      browser.navigateAgentTab("gone", "https://example.com/"),
    ).toThrow("Tab was not found.");
  });

  it("reloadAgentTab reloads, retries a failed load and bypasses the cache", async () => {
    const browser = controller();
    const { tab } = agentTab(browser);
    browser.navigateAgentTab(tab.id, "https://example.com/page");
    const page = contents(browser, tab.id);
    page.commit("https://example.com/page");
    browser.reloadAgentTab(tab.id);
    expect(page.reload).toHaveBeenCalledOnce();
    expect(page.reloadIgnoringCache).not.toHaveBeenCalled();
    browser.reloadAgentTab(tab.id, { ignoreCache: true });
    expect(page.reloadIgnoringCache).toHaveBeenCalledOnce();
    expect(page.reload).toHaveBeenCalledOnce();
    // A failed load is retried by loading its URL again, as the person's
    // reload does.
    page.emit(
      "did-fail-load",
      {},
      -102,
      "ERR_CONNECTION_REFUSED",
      "https://example.com/page",
      true,
    );
    browser.reloadAgentTab(tab.id, { ignoreCache: true });
    expect(page.loadURL).toHaveBeenCalledTimes(2);
    expect(page.loadURL).toHaveBeenLastCalledWith("https://example.com/page");
    expect(page.reloadIgnoringCache).toHaveBeenCalledOnce();
  });

  it("a cancelled server redirect is reported once", async () => {
    const browser = controller();
    const { tab } = agentTab(browser);
    browser.navigateAgentTab(tab.id, "https://example.com/page");
    const page = contents(browser, tab.id);
    const blocked: [string, string][] = [];
    const stop = browser.onBlockedRedirect((tabId, url) =>
      blocked.push([tabId, url]),
    );
    const refused = { preventDefault: vi.fn() };
    page.emit("will-redirect", refused, "file:///etc/hosts");
    expect(refused.preventDefault).toHaveBeenCalledOnce();
    expect(blocked).toEqual([[tab.id, "file:///etc/hosts"]]);
    const followed = { preventDefault: vi.fn() };
    page.emit("will-redirect", followed, "https://example.com/next");
    expect(followed.preventDefault).not.toHaveBeenCalled();
    stop();
    page.emit(
      "will-redirect",
      { preventDefault: vi.fn() },
      "data:text/html,<p>Hello</p>",
    );
    expect(blocked).toHaveLength(1);
  });

  it("a started download is reported with its tab", async () => {
    const browser = controller();
    const { tab } = agentTab(browser);
    browser.navigateAgentTab(tab.id, "https://example.com/page");
    const page = contents(browser, tab.id);
    const started: string[] = [];
    browser.onDownloadStarted((tabId) => started.push(tabId));
    const shared = sessions.get("persist:space-personal")!;
    const event = { preventDefault: vi.fn() };
    shared.emit("will-download", event, downloadItem(), page);
    // The agent side hears of it, and the agent space still refuses it.
    expect(started).toEqual([tab.id]);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(browser.state.downloads).toEqual([]);
  });

  it("a page may navigate itself to about:blank", async () => {
    const browser = controller();
    const { tab } = agentTab(browser);
    browser.navigateAgentTab(tab.id, "https://example.com/page");
    const agentPage = contents(browser, tab.id);
    agentPage.commit("https://example.com/page");
    const personId = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id: personId,
      url: "https://example.org/",
    });
    const personPage = contents(browser, personId);
    personPage.commit("https://example.org/");
    for (const page of [agentPage, personPage]) {
      const blank = { preventDefault: vi.fn() };
      page.emit("will-navigate", blank, "about:blank");
      expect(blank.preventDefault).not.toHaveBeenCalled();
      const refused = { preventDefault: vi.fn() };
      page.emit("will-navigate", refused, "file:///etc/hosts");
      expect(refused.preventDefault).toHaveBeenCalledOnce();
    }
  });
});

describe("leave guards", () => {
  const guard = () => ({ preventDefault: vi.fn() });
  // An agent space, its first tab and that tab's page.
  function agentPage(browser: BrowserController) {
    const space = browser.createAgentSpace("Task");
    const tab = browser.state.tabs.find((item) => item.spaceId === space.id)!;
    browser.navigateAgentTab(tab.id, "https://example.com/form");
    return { space, tab, page: contents(browser, tab.id) };
  }
  // The person's first tab, on a page of its own.
  async function personPage(browser: BrowserController) {
    const space = browser.state.spaces[0];
    const tab = browser.state.tabs[0];
    await browser.dispatch({
      type: "tab:navigate",
      id: tab.id,
      url: "https://example.com/form",
    });
    return { space, tab, page: contents(browser, tab.id) };
  }

  it("an agent-controlled tab leaves a guarded page without asking", async () => {
    const browser = controller();
    const { space, tab, page } = agentPage(browser);
    const overrides: { tabId: string; at: number }[] = [];
    const stop = browser.onLeaveGuard((tabId, at) =>
      overrides.push({ tabId, at }),
    );
    const leaving = guard();
    page.emit("will-prevent-unload", leaving);
    expect(leaving.preventDefault).toHaveBeenCalledOnce();
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
    expect(overrides).toHaveLength(1);
    expect(overrides[0].tabId).toBe(tab.id);
    expect(overrides[0].at).toBeGreaterThan(0);
    expect(browser.state.activity[0]).toMatchObject({
      spaceId: space.id,
      message: "Agent left a page that asked it to stay",
    });
    // A stopped listener hears no more guards.
    stop();
    page.emit("will-prevent-unload", guard());
    expect(overrides).toHaveLength(1);
  });

  it("a granted personal space follows the same rule while the agent has control", async () => {
    const browser = controller();
    const { space, page } = await personPage(browser);
    // The view was wired before the grant, so control is read as the guard
    // fires.
    browser.grantAccess(space.id);
    const leaving = guard();
    page.emit("will-prevent-unload", leaving);
    expect(leaving.preventDefault).toHaveBeenCalledOnce();
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
    expect(browser.state.activity[0]).toMatchObject({
      spaceId: space.id,
      message: "Agent left a page that asked it to stay",
    });
    await browser.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    const asked = guard();
    page.emit("will-prevent-unload", asked);
    expect(asked.preventDefault).not.toHaveBeenCalled();
    expect(dialog.showMessageBoxSync).toHaveBeenCalledOnce();
  });

  it("the person in control is asked, with Stay as the default", async () => {
    const browser = controller();
    const { tab, page } = await personPage(browser);
    const overrides: string[] = [];
    browser.onLeaveGuard((tabId) => overrides.push(tabId));
    vi.mocked(dialog.showMessageBoxSync).mockReturnValue(1);
    const staying = guard();
    page.emit("will-prevent-unload", staying);
    expect(dialog.showMessageBoxSync).toHaveBeenCalledWith(expect.anything(), {
      type: "question",
      message: "Leave site?",
      detail: "Changes you made may not be saved.",
      buttons: ["Leave", "Stay"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    expect(staying.preventDefault).not.toHaveBeenCalled();
    vi.mocked(dialog.showMessageBoxSync).mockReturnValue(0);
    const leaving = guard();
    page.emit("will-prevent-unload", leaving);
    expect(leaving.preventDefault).toHaveBeenCalledOnce();
    // The prompt is the person's, so no agent hears of it and Recent
    // activity stays quiet.
    expect(overrides).toEqual([]);
    expect(
      browser.state.activity.some((entry) =>
        entry.message.startsWith("Agent left"),
      ),
    ).toBe(false);
    expect(tab.url).toBe("https://example.com/form");
  });

  it("a background tab under the person's control keeps the page without a box", async () => {
    const browser = controller();
    const { space } = await personPage(browser);
    await browser.dispatch({
      type: "tab:create",
      url: "https://example.com/second",
      spaceId: space.id,
      background: true,
    });
    const background = browser.state.tabs.at(-1)!;
    expect(background.id).not.toBe(browser.state.activeTabId);
    const page = contents(browser, background.id);
    const staying = guard();
    page.emit("will-prevent-unload", staying);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
    expect(staying.preventDefault).not.toHaveBeenCalled();
  });

  it("closing a tab skips the guard", async () => {
    const browser = controller();
    const { tab, page } = agentPage(browser);
    const overrides: string[] = [];
    browser.onLeaveGuard((tabId) => overrides.push(tabId));
    const close = vi.spyOn(page, "close");
    browser.closeTab(tab.id, "agent");
    expect(close).toHaveBeenCalledWith({ waitForBeforeUnload: false });
    expect(page.destroyed).toBe(true);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
    expect(overrides).toEqual([]);
  });
});

describe("files, extension pages and other apps", () => {
  let folder: string;
  const fileUrl = (name: string) => pathToFileURL(join(folder, name)).href;
  const active = (browser: BrowserController) =>
    browser.state.tabs.find((tab) => tab.id === browser.state.activeTabId)!;
  // Opens url in a new tab of the space and commits it.
  async function open(
    browser: BrowserController,
    url: string,
    spaceId?: string,
  ) {
    await browser.dispatch({ type: "tab:create", url, spaceId });
    const tab = browser.state.tabs.at(-1)!;
    const page = contents(browser, tab.id);
    page.commit(url);
    return { tab, page };
  }
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "kamapathy-files-"));
    for (const name of [
      "page.html",
      "page.htm",
      "page.xhtml",
      "image.svg",
      "doc.pdf",
      "other.pdf",
      "note.txt",
    ])
      writeFileSync(join(folder, name), "file");
    mkdirSync(join(folder, "folder.pdf"));
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it("view kinds: markup files load without scripts, other pages keep them, and a change of kind gets a new view", async () => {
    const browser = controller();
    for (const name of ["page.html", "page.htm", "page.xhtml", "image.svg"]) {
      const { page } = await open(browser, fileUrl(name));
      expect(preferencesOf(page).javascript, name).toBe(false);
      expect(page.loadURL, name).toHaveBeenCalledExactlyOnceWith(fileUrl(name));
    }
    for (const url of [
      fileUrl("doc.pdf"),
      fileUrl("note.txt"),
      "https://example.com/",
    ]) {
      const { page } = await open(browser, url);
      const preferences = preferencesOf(page);
      expect(preferences.javascript, url).toBe(true);
      // Chromium's viewer shows PDFs without the plugins preference.
      expect(preferences, url).not.toHaveProperty("plugins");
    }
    // The shell gives a page of another kind a new view, without its back
    // history.
    const { tab, page: markup } = await open(browser, fileUrl("page.html"));
    await browser.dispatch({
      type: "tab:navigate",
      id: tab.id,
      url: "https://example.com/next",
    });
    expect(markup.destroyed).toBe(true);
    const web = contents(browser, tab.id);
    expect(web).not.toBe(markup);
    expect(preferencesOf(web).javascript).toBe(true);
    expect(web.loadURL).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/next",
    );
    expect(tab).toMatchObject({
      url: "https://example.com/next",
      canGoBack: false,
      canGoForward: false,
    });
    // A page's own link to another kind opens in a new tab in front, and
    // the file tab keeps its URL although Chromium reports the navigation
    // starting first.
    const second = await open(browser, fileUrl("page.html"));
    second.page.emit("did-start-navigation", {
      url: "https://example.org/",
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(
      attempt(second.page, "will-navigate", "https://example.org/"),
    ).toHaveBeenCalledOnce();
    expect(second.tab.url).toBe(fileUrl("page.html"));
    const opened = browser.state.tabs.at(-1)!;
    expect(opened).toMatchObject({
      url: "https://example.org/",
      spaceId: second.tab.spaceId,
      openedBy: "person",
    });
    expect(browser.state.activeTabId).toBe(opened.id);
    expect(preferencesOf(contents(browser, opened.id)).javascript).toBe(true);
    // From a PDF, another PDF loads in place and a markup file opens a tab.
    const pdf = await open(browser, fileUrl("doc.pdf"));
    expect(
      attempt(pdf.page, "will-navigate", fileUrl("other.pdf")),
    ).not.toHaveBeenCalled();
    pdf.page.emit("did-start-navigation", {
      url: fileUrl("other.pdf"),
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(pdf.tab.url).toBe(fileUrl("other.pdf"));
    const tabs = browser.state.tabs.length;
    expect(
      attempt(pdf.page, "will-navigate", fileUrl("page.html")),
    ).toHaveBeenCalledOnce();
    expect(browser.state.tabs).toHaveLength(tabs + 1);
    expect(browser.state.tabs.at(-1)).toMatchObject({
      url: fileUrl("page.html"),
      spaceId: pdf.tab.spaceId,
    });
    expect(pdf.tab.url).toBe(fileUrl("other.pdf"));
  });

  it("files and web pages never share a tab's history", async () => {
    const browser = controller();
    // A link from a PDF to a web page opens a new tab.
    const pdf = await open(browser, fileUrl("doc.pdf"));
    expect(
      attempt(pdf.page, "will-navigate", "https://example.com/"),
    ).toHaveBeenCalledOnce();
    expect(browser.state.tabs.at(-1)).toMatchObject({
      url: "https://example.com/",
      spaceId: pdf.tab.spaceId,
    });
    expect(pdf.tab.url).toBe(fileUrl("doc.pdf"));
    // The shell rebuilds the view between a file and a web page, either way,
    // and loads another file of the same kind in place.
    await browser.dispatch({
      type: "tab:navigate",
      id: pdf.tab.id,
      url: fileUrl("other.pdf"),
    });
    expect(contents(browser, pdf.tab.id)).toBe(pdf.page);
    expect(pdf.page.loadURL).toHaveBeenLastCalledWith(fileUrl("other.pdf"));
    await browser.dispatch({
      type: "tab:navigate",
      id: pdf.tab.id,
      url: "https://example.com/",
    });
    expect(pdf.page.destroyed).toBe(true);
    const web = contents(browser, pdf.tab.id);
    web.commit("https://example.com/");
    await browser.dispatch({
      type: "tab:navigate",
      id: pdf.tab.id,
      url: fileUrl("doc.pdf"),
    });
    expect(web.destroyed).toBe(true);
    expect(contents(browser, pdf.tab.id).loadURL).toHaveBeenCalledWith(
      fileUrl("doc.pdf"),
    );
    // A web page never reaches a file, in its tab or a new one.
    const page = contents(
      browser,
      (await open(browser, "https://example.org/")).tab.id,
    );
    const count = browser.state.tabs.length;
    expect(
      attempt(page, "will-navigate", fileUrl("doc.pdf")),
    ).toHaveBeenCalledOnce();
    expect(browser.state.tabs).toHaveLength(count);
  });

  it("file tabs excluded: no history, bookmarks, split view, agent spaces or reopening where an agent works", async () => {
    const browser = controller();
    const url = fileUrl("doc.pdf");
    const { tab, page } = await open(browser, url);
    expect(tab).toMatchObject({ url, spaceId: "personal", openedBy: "person" });
    expect(tab).not.toHaveProperty("label");
    expect(page.loadURL).toHaveBeenCalledExactlyOnceWith(url);
    page.emit("page-title-updated", {}, "doc.pdf");
    expect(browser.state.history).toEqual([]);
    await expect(
      browser.dispatch({ type: "bookmark:add", url, title: "Doc" }),
    ).rejects.toThrow("Only web pages can be bookmarked.");
    await expect(
      browser.dispatch({
        type: "bookmark:update",
        id: "github",
        url,
        title: "Doc",
      }),
    ).rejects.toThrow("Only web pages can be bookmarked.");
    await open(browser, "https://example.com/");
    await expect(
      browser.dispatch({ type: "tab:split", id: tab.id }),
    ).rejects.toThrow("Open two web pages in this space for split view.");
    // Duplicating goes through the same checks.
    await browser.dispatch({ type: "tab:duplicate", id: tab.id });
    expect(browser.state.tabs.at(-1)).toMatchObject({
      url,
      spaceId: "personal",
    });
    await expect(
      browser.dispatch({ type: "tab:create", url: fileUrl("missing.pdf") }),
    ).rejects.toThrow("That file was not found.");
    await expect(
      browser.dispatch({ type: "tab:create", url: fileUrl("folder.pdf") }),
    ).rejects.toThrow("That file was not found.");
    // No space an agent can reach takes a file.
    const agent = browser.createAgentSpace("Task");
    await expect(
      browser.dispatch({ type: "tab:create", url, spaceId: agent.id }),
    ).rejects.toThrow(
      "Files on this computer open only in your personal spaces.",
    );
    const agentTab = browser.state.tabs.find(
      (item) => item.spaceId === agent.id,
    )!;
    await expect(
      browser.dispatch({ type: "tab:navigate", id: agentTab.id, url }),
    ).rejects.toThrow(
      "Files on this computer open only in your personal spaces.",
    );
    browser.grantAccess("work");
    await expect(
      browser.dispatch({ type: "tab:create", url, spaceId: "work" }),
    ).rejects.toThrow(
      "Files on this computer open only in your personal spaces.",
    );
    // A closed file tab reopens in its personal space while nobody else can
    // reach it, and is skipped once that space is granted.
    await browser.dispatch({ type: "tab:close", id: tab.id });
    await browser.dispatch({ type: "tab:reopen" });
    const reopened = browser.state.tabs.at(-1)!;
    expect(reopened).toMatchObject({ url, spaceId: "personal" });
    expect(browser.state.activeTabId).toBe(reopened.id);
    await browser.dispatch({ type: "tab:close", id: reopened.id });
    browser.grantAccess("personal");
    const count = browser.state.tabs.length;
    await browser.dispatch({ type: "tab:reopen" });
    expect(browser.state.tabs).toHaveLength(count);
    expect(browser.state.tabs.filter((item) => item.url === url)).toHaveLength(
      1,
    );
  });

  it("a file tab in a space granted later stays hidden until the person opens a web page in it", async () => {
    const browser = controller();
    const markup = await open(browser, fileUrl("page.html"), "work");
    browser.grantAccess("work");
    expect(markup.tab).not.toHaveProperty("label");
    // Its view keeps showing the file, which the space no longer loads.
    markup.page.emit("did-start-navigation", {
      url: fileUrl("page.htm"),
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(markup.tab.url).toBe(fileUrl("page.html"));
    await browser.dispatch({
      type: "tab:navigate",
      id: markup.tab.id,
      url: "https://example.com/",
    });
    expect(markup.tab.label).toMatch(/^p\d+$/);
    expect(preferencesOf(contents(browser, markup.tab.id)).javascript).toBe(
      true,
    );
  });

  it("subframes keep about:, blob: and data: documents and Chromium's PDF viewer, and never reach files or other extensions", async () => {
    const browser = controller();
    browser.setExtensionLookup(() => ["a".repeat(32)]);
    const { page } = await open(browser, "https://example.com/");
    const space = browser.createAgentSpace("Task");
    const agentTab = browser.openAgentTab(space.id, "https://example.com/");
    const agentPage = contents(browser, agentTab.id);
    agentPage.commit("https://example.com/");
    for (const target of [page, agentPage]) {
      for (const url of [
        "https://example.org/frame",
        "about:srcdoc",
        "data:text/html,<p>Hello</p>",
        "blob:https://example.com/1234",
        `chrome-extension://${PDF_VIEWER_ID}/0c7b0a4e-5d22-4a8f-9a64-0f5d1c1e2b3a`,
      ])
        expect(
          attempt(target, "will-frame-navigate", url, false),
          url,
        ).not.toHaveBeenCalled();
      for (const url of [
        fileUrl("doc.pdf"),
        `chrome-extension://${"b".repeat(32)}/frame.html`,
        "view-source:https://example.com/",
        "ms-msdt:x",
      ])
        expect(
          attempt(target, "will-frame-navigate", url, false),
          url,
        ).toHaveBeenCalledOnce();
      // will-navigate decides for main frames.
      expect(
        attempt(target, "will-frame-navigate", "data:text/html,x", true),
      ).not.toHaveBeenCalled();
    }
    // A loaded extension's frame stays in personal pages, other apps are
    // asked for there, and an agent's page gets neither.
    const extension = `chrome-extension://${"a".repeat(32)}/frame.html`;
    expect(
      attempt(page, "will-frame-navigate", extension, false),
    ).not.toHaveBeenCalled();
    expect(
      attempt(agentPage, "will-frame-navigate", extension, false),
    ).toHaveBeenCalledOnce();
    expect(
      attempt(page, "will-frame-navigate", "zoommtg://zoom.us/j/1", false),
    ).not.toHaveBeenCalled();
    expect(
      attempt(agentPage, "will-frame-navigate", "zoommtg://zoom.us/j/1", false),
    ).toHaveBeenCalledOnce();
    // In a local markup file a frame keeps to files of its kind.
    const markup = await open(browser, fileUrl("page.html"));
    expect(
      attempt(markup.page, "will-frame-navigate", fileUrl("page.htm"), false),
    ).not.toHaveBeenCalled();
    for (const url of [fileUrl("doc.pdf"), extension])
      expect(
        attempt(markup.page, "will-frame-navigate", url, false),
        url,
      ).toHaveBeenCalledOnce();
    // The viewer's frame loads in a PDF from this computer too.
    const pdf = await open(browser, fileUrl("doc.pdf"));
    expect(
      attempt(
        pdf.page,
        "will-frame-navigate",
        `chrome-extension://${PDF_VIEWER_ID}/0c7b0a4e-5d22-4a8f-9a64-0f5d1c1e2b3a`,
        false,
      ),
    ).not.toHaveBeenCalled();
  });

  it("redirects reach web pages, and other apps only from personal tabs", async () => {
    const browser = controller();
    browser.setExtensionLookup(() => ["a".repeat(32)]);
    const { page } = await open(browser, "https://example.com/");
    for (const url of ["https://example.org/", "mailto:someone@example.com"])
      expect(attempt(page, "will-redirect", url), url).not.toHaveBeenCalled();
    for (const url of [
      fileUrl("doc.pdf"),
      `chrome-extension://${"a".repeat(32)}/options.html`,
      "data:text/html,x",
      "ms-msdt:x",
    ])
      expect(attempt(page, "will-redirect", url), url).toHaveBeenCalledOnce();
    const space = browser.createAgentSpace("Task");
    const agentPage = contents(
      browser,
      browser.openAgentTab(space.id, "https://example.com/").id,
    );
    expect(
      attempt(agentPage, "will-redirect", "https://example.org/"),
    ).not.toHaveBeenCalled();
    expect(
      attempt(agentPage, "will-redirect", "mailto:someone@example.com"),
    ).toHaveBeenCalledOnce();
  });

  it("a popup from a local markup file runs scripts like any web page", async () => {
    const browser = controller();
    const { page } = await open(browser, fileUrl("page.html"));
    const { decision } = popup(page, { url: "https://example.com/popup" });
    expect(decision).toMatchObject({
      action: "allow",
      overrideBrowserWindowOptions: { webPreferences: { javascript: true } },
    });
  });

  it("extension pages: loaded ids open in personal spaces no agent can reach", async () => {
    const browser = controller();
    const id = "a".repeat(32);
    const options = `chrome-extension://${id}/options.html`;
    await expect(
      browser.dispatch({ type: "tab:create", url: options }),
    ).rejects.toThrow("That extension isn't installed or is turned off.");
    const lookup = vi.fn((partition: string) =>
      partition === "persist:space-personal" ? [id] : [],
    );
    browser.setExtensionLookup(lookup);
    await browser.dispatch({ type: "tab:create", url: options });
    const tab = active(browser);
    expect(tab).toMatchObject({ url: options, spaceId: "personal" });
    expect(contents(browser, tab.id).loadURL).toHaveBeenCalledExactlyOnceWith(
      options,
    );
    expect(lookup).toHaveBeenCalledWith("persist:space-personal");
    await expect(
      browser.dispatch({
        type: "tab:create",
        url: `chrome-extension://${"b".repeat(32)}/options.html`,
      }),
    ).rejects.toThrow("That extension isn't installed or is turned off.");
    // A personal page may go there itself.
    const { page } = await open(browser, "https://example.com/");
    expect(attempt(page, "will-navigate", options)).not.toHaveBeenCalled();
    // Spaces an agent can reach refuse it from the shell and from pages.
    const space = browser.createAgentSpace("Task");
    const agentTab = browser.state.tabs.find(
      (item) => item.spaceId === space.id,
    )!;
    browser.grantAccess("work");
    const workTab = browser.state.tabs.find((item) => item.spaceId === "work")!;
    for (const target of [agentTab, workTab]) {
      await expect(
        browser.dispatch({
          type: "tab:create",
          url: options,
          spaceId: target.spaceId,
        }),
      ).rejects.toThrow("Extension pages open only in your personal spaces.");
      await expect(
        browser.dispatch({ type: "tab:navigate", id: target.id, url: options }),
      ).rejects.toThrow("Extension pages open only in your personal spaces.");
    }
    await browser.dispatch({
      type: "tab:navigate",
      id: agentTab.id,
      url: "https://example.com/",
    });
    const agentPage = contents(browser, agentTab.id);
    expect(attempt(agentPage, "will-navigate", options)).toHaveBeenCalledOnce();
  });

  it("open external: other apps open only after the person confirms, and never from spaces an agent can reach", async () => {
    const browser = controller();
    vi.mocked(app.getApplicationNameForProtocol).mockImplementation((url) =>
      url.startsWith("zoommtg:") ? "Zoom" : "",
    );
    const id = browser.state.activeTabId;
    await browser.dispatch({
      type: "tab:navigate",
      id,
      url: "http://127.0.0.1:8123/",
    });
    const page = contents(browser, id);
    page.commit("http://127.0.0.1:8123/");
    const shared = sessions.get("persist:space-personal")!;
    const request = shared.setPermissionRequestHandler.mock.calls[0][0];
    const ask = (target: FakeContents, externalURL: string) => {
      const callback = vi.fn();
      request(target, "openExternal", callback, {
        externalURL,
        requestingUrl: target.url,
        isMainFrame: true,
      });
      return callback;
    };
    // No app for it, or a blocked scheme: denied without asking.
    for (const url of ["kamapathyprobe://x", "ms-msdt:x"])
      expect(ask(page, url), url).toHaveBeenCalledExactlyOnceWith(false);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 1,
      checkboxChecked: false,
    });
    const opened = ask(page, "zoommtg://zoom.us/j/1");
    await vi.waitFor(() => expect(opened).toHaveBeenCalledWith(true));
    expect(dialog.showMessageBox).toHaveBeenCalledExactlyOnceWith(
      browser.window,
      {
        type: "question",
        title: "Open another app",
        message: "Open Zoom?",
        detail: "http://127.0.0.1:8123 wants to open a link in Zoom.",
        buttons: ["Cancel", "Open"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      },
    );
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 0,
      checkboxChecked: false,
    });
    const cancelled = ask(page, "zoommtg://zoom.us/j/1");
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledWith(false));
    // One box per page; a navigation meanwhile cancels it.
    let answer!: (value: {
      response: number;
      checkboxChecked: boolean;
    }) => void;
    vi.mocked(dialog.showMessageBox).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const pending = ask(page, "zoommtg://zoom.us/j/1");
    const second = ask(page, "zoommtg://zoom.us/j/2");
    expect(second).toHaveBeenCalledExactlyOnceWith(false);
    page.emit("did-start-navigation", {
      url: "http://127.0.0.1:8123/next",
      isMainFrame: true,
      isSameDocument: false,
    });
    answer({ response: 1, checkboxChecked: false });
    await vi.waitFor(() => expect(pending).toHaveBeenCalledWith(false));
    // Nothing is remembered: the next link asks again.
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 1,
      checkboxChecked: false,
    });
    const again = ask(page, "zoommtg://zoom.us/j/1");
    await vi.waitFor(() => expect(again).toHaveBeenCalledWith(true));
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(4);
    expect(
      attempt(page, "will-navigate", "zoommtg://zoom.us/j/1"),
    ).not.toHaveBeenCalled();
    // An agent space and a granted personal space block it without a box.
    const space = browser.createAgentSpace("Task");
    const agentPage = contents(
      browser,
      browser.openAgentTab(space.id, "http://127.0.0.1:8123/").id,
    );
    agentPage.commit("http://127.0.0.1:8123/");
    expect(
      ask(agentPage, "zoommtg://zoom.us/j/1"),
    ).toHaveBeenCalledExactlyOnceWith(false);
    expect(
      attempt(agentPage, "will-navigate", "zoommtg://zoom.us/j/1"),
    ).toHaveBeenCalledOnce();
    browser.grantAccess("personal");
    expect(ask(page, "zoommtg://zoom.us/j/1")).toHaveBeenCalledExactlyOnceWith(
      false,
    );
    expect(
      attempt(page, "will-navigate", "zoommtg://zoom.us/j/1"),
    ).toHaveBeenCalledOnce();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(4);
  });

  it("open external: a grant while the box is open denies it, and files never ask", async () => {
    const browser = controller();
    vi.mocked(app.getApplicationNameForProtocol).mockReturnValue("Mail");
    const web = await open(browser, "https://example.com/");
    const markup = await open(browser, fileUrl("page.html"));
    const request = sessions.get("persist:space-personal")!
      .setPermissionRequestHandler.mock.calls[0][0];
    const fromFile = vi.fn();
    request(markup.page, "openExternal", fromFile, {
      externalURL: "mailto:someone@example.com",
      requestingUrl: markup.page.url,
      isMainFrame: true,
    });
    expect(fromFile).toHaveBeenCalledExactlyOnceWith(false);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
    let answer!: (value: {
      response: number;
      checkboxChecked: boolean;
    }) => void;
    vi.mocked(dialog.showMessageBox).mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const callback = vi.fn();
    request(web.page, "openExternal", callback, {
      externalURL: "mailto:someone@example.com",
      requestingUrl: web.page.url,
      isMainFrame: true,
    });
    browser.grantAccess("personal");
    answer({ response: 1, checkboxChecked: false });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false));
  });
});

describe("links and files from other apps", () => {
  let folder: string;
  const fileUrl = (name: string) => pathToFileURL(join(folder, name)).href;
  const nativeWindow = (browser: BrowserController) =>
    browser.window as unknown as {
      isMinimized: () => boolean;
      restore: ReturnType<typeof vi.fn>;
      show: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
    };
  const tabsIn = (browser: BrowserController, spaceId: string) =>
    browser.state.tabs.filter((tab) => tab.spaceId === spaceId);
  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), "kamapathy-incoming-"));
    for (const name of ["doc.pdf", "page.html"])
      writeFileSync(join(folder, name), "file");
  });
  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  it("incoming space: the active personal space, else the one used last, never an agent's or a granted one, else a new Personal space", async () => {
    const browser = controller();
    expect(browser.incomingSpace().id).toBe("personal");
    await browser.dispatch({ type: "space:activate", id: "work" });
    expect(browser.incomingSpace().id).toBe("work");
    const agent = browser.createAgentSpace("Task");
    await browser.dispatch({ type: "space:activate", id: agent.id });
    expect(browser.incomingSpace().id).toBe("work");
    // A granted personal space is passed over for the one used before it.
    browser.grantAccess("work");
    await browser.dispatch({ type: "space:activate", id: "work" });
    expect(browser.incomingSpace().id).toBe("personal");
    // With every personal space granted, a new one takes the links, and
    // nothing changes the space in front.
    browser.grantAccess("personal");
    const spaces = browser.state.spaces.length;
    const created = browser.incomingSpace();
    expect(created).toMatchObject({
      name: "Personal",
      color: "green",
      kind: "personal",
      owner: "human",
      signIns: "shared",
      createdBy: "person",
    });
    expect(created).not.toHaveProperty("access");
    expect(browser.state.spaces).toHaveLength(spaces + 1);
    expect(tabsIn(browser, created.id)).toEqual([
      expect.objectContaining({
        url: HOME_URL,
        openedBy: "person",
        managed: false,
      }),
    ]);
    expect(tabsIn(browser, created.id)[0]).not.toHaveProperty("label");
    expect(browser.state.activeSpaceId).toBe("work");
    // It is used again rather than making another.
    expect(browser.incomingSpace()).toBe(created);
    expect(browser.state.spaces).toHaveLength(spaces + 1);
  });

  it("incoming space: a personal space not used this run comes before a new one, and the space and tab limits hold", async () => {
    // Restored with Work in front, which an agent then gets.
    const state = initialState();
    state.activeSpaceId = "work";
    state.activeTabId = state.tabs.find((tab) => tab.spaceId === "work")!.id;
    const restored = controller(undefined, state);
    restored.grantAccess("work");
    expect(restored.incomingSpace().id).toBe("personal");
    expect(restored.state.spaces).toHaveLength(2);
    // A 31st space or a 201st tab is refused with the usual messages.
    const browser = controller();
    browser.grantAccess("personal");
    browser.grantAccess("work");
    while (browser.state.spaces.length < 30) browser.createAgentSpace("Task");
    expect(() => browser.incomingSpace()).toThrow(
      "The maximum of 30 spaces has been reached.",
    );
    const full = controller();
    full.grantAccess("personal");
    full.grantAccess("work");
    while (full.state.tabs.length < 200) full.state.tabs.push(newTab("work"));
    expect(() => full.incomingSpace()).toThrow(
      "The maximum of 200 tabs has been reached.",
    );
  });

  it("openIncoming opens each link and existing file as the person's tab in the incoming space, the last in front, and brings the window forward", async () => {
    const browser = controller();
    browser.setExtensionLookup(() => ["a".repeat(32)]);
    const agent = browser.createAgentSpace("Task");
    await browser.dispatch({ type: "space:activate", id: "work" });
    await browser.dispatch({ type: "space:activate", id: agent.id });
    const window = nativeWindow(browser);
    window.isMinimized = () => true;
    const before = browser.state.tabs.length;
    browser.openIncoming([
      "https://a.example/",
      fileUrl("doc.pdf"),
      fileUrl("missing.pdf"),
      "mailto:someone@example.com",
      `chrome-extension://${"a".repeat(32)}/page.html`,
      "example.com",
      fileUrl("page.html"),
      "https://b.example/",
    ]);
    const opened = browser.state.tabs.slice(before);
    expect(opened.map((tab) => tab.url)).toEqual([
      "https://a.example/",
      fileUrl("doc.pdf"),
      fileUrl("page.html"),
      "https://b.example/",
    ]);
    // Each has its page loading already, local markup without scripts.
    const pages = opened.map(
      (tab) => browser.peekWebContents(tab.id) as unknown as FakeContents,
    );
    for (const [index, tab] of opened.entries()) {
      expect(tab, tab.url).toMatchObject({
        spaceId: "work",
        openedBy: "person",
        managed: false,
      });
      expect(tab, tab.url).not.toHaveProperty("label");
      expect(pages[index], tab.url).toBeDefined();
      expect(pages[index].loadURL).toHaveBeenCalledExactlyOnceWith(tab.url);
    }
    expect(preferencesOf(pages[2]).javascript).toBe(false);
    expect(browser.state.activeSpaceId).toBe("work");
    expect(browser.state.activeTabId).toBe(opened[3].id);
    expect(tabsIn(browser, agent.id)).toHaveLength(1);
    expect(browser.incomingSpace().id).toBe("work");
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    const order = (mock: ReturnType<typeof vi.fn>) =>
      mock.mock.invocationCallOrder[0];
    expect(order(window.restore)).toBeLessThan(order(window.show));
    expect(order(window.show)).toBeLessThan(order(window.focus));
  });

  it("openIncoming never opens in an agent space or a granted one, and stops at 200 tabs", async () => {
    const browser = controller();
    browser.grantAccess("personal");
    browser.grantAccess("work");
    const agent = browser.createAgentSpace("Task");
    await browser.dispatch({ type: "space:activate", id: agent.id });
    const spaces = browser.state.spaces.length;
    browser.openIncoming(["https://a.example/", fileUrl("doc.pdf")]);
    const space = browser.state.spaces.at(-1)!;
    expect(browser.state.spaces).toHaveLength(spaces + 1);
    expect(space).toMatchObject({ name: "Personal", kind: "personal" });
    expect(tabsIn(browser, space.id).map((tab) => tab.url)).toEqual([
      HOME_URL,
      "https://a.example/",
      fileUrl("doc.pdf"),
    ]);
    for (const id of ["personal", "work", agent.id])
      expect(tabsIn(browser, id), id).toHaveLength(1);
    expect(browser.state.activeSpaceId).toBe(space.id);
    const window = nativeWindow(browser);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    // Later links join the same space, as far as the tab limit allows.
    while (browser.state.tabs.length < 198)
      browser.state.tabs.push(newTab(agent.id));
    browser.openIncoming([
      "https://b.example/",
      "https://c.example/",
      "https://d.example/",
    ]);
    expect(browser.state.spaces).toHaveLength(spaces + 1);
    expect(browser.state.tabs).toHaveLength(200);
    expect(
      tabsIn(browser, space.id)
        .map((tab) => tab.url)
        .slice(3),
    ).toEqual(["https://b.example/", "https://c.example/"]);
  });
});
