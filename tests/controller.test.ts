import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { dialog, session, shell, WebContentsView } from "electron";
import { BrowserController } from "../electron/controller";
import {
  agentRules,
  HOME_URL,
  initialState,
  newTab,
  PAGE_BUDGET,
} from "../shared/state";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  WebContentsView: vi.fn(function (options?: { webContents?: FakeContents }) {
    return new FakeView(options?.webContents);
  }),
  nativeTheme: { themeSource: "system" },
  session: {
    fromPartition: vi.fn((partition: string) => {
      if (!sessions.has(partition)) sessions.set(partition, new FakeSession());
      return sessions.get(partition)!;
    }),
  },
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
  clearStorageData = vi.fn(async () => {});
  clearCache = vi.fn(async () => {});
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
class FakeContents extends EventEmitter {
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
  // Only the cursor page is loaded from a file, and only it is scripted.
  loadFile = vi.fn(async (file: string) => {
    this.url = `file://${file}`;
  });
  executeJavaScript = vi.fn(async () => ({
    width: 44,
    height: 44,
    reducedMotion: false,
  }));
  getZoomFactor = () => 1.2 ** this.zoom;
  getZoomLevel = () => this.zoom;
  setZoomLevel = (value: number) => {
    this.zoom = value;
  };
  reload = vi.fn();
  loadURL = vi.fn(
    (url: string) =>
      new Promise<void>((_resolve, reject) => {
        this.pending.push({ url, reject });
      }),
  );
  frames?: (image: unknown) => void;
  beginFrameSubscription = vi.fn(
    (_onlyDirty: boolean, callback: (image: unknown) => void) => {
      this.frames = callback;
    },
  );
  endFrameSubscription = vi.fn(() => {
    this.frames = undefined;
  });
  // One rendered frame, as Chromium reports it to a subscriber.
  frame() {
    this.frames?.({});
  }
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
class FakeView {
  constructor(public webContents = new FakeContents()) {}
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  setVisible(value: boolean) {
    this.visible = value;
  }
  setBounds(value: typeof this.bounds) {
    this.bounds = value;
  }
  setBackgroundColor = vi.fn();
  setBorderRadius = vi.fn();
  getVisible() {
    return this.visible;
  }
  getBounds() {
    return this.bounds;
  }
}
const sessions = new Map<string, FakeSession>();
const controllers: BrowserController[] = [];
function controller(statePath = "unused-test-state.json") {
  const window = new EventEmitter() as EventEmitter & {
    webContents: FakeContents;
    contentView: {
      addChildView: ReturnType<typeof vi.fn>;
      removeChildView: ReturnType<typeof vi.fn>;
    };
    isDestroyed: () => boolean;
    getContentSize: () => number[];
    isVisible: () => boolean;
    isMinimized: () => boolean;
    close: ReturnType<typeof vi.fn>;
  };
  window.webContents = new FakeContents();
  window.close = vi.fn();
  window.contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
  window.isDestroyed = () => false;
  window.getContentSize = () => [1400, 900];
  window.isVisible = () => true;
  window.isMinimized = () => false;
  const result = new BrowserController(
    window as unknown as BrowserWindow,
    initialState(),
    statePath,
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
  return (
    browser as unknown as {
      window: {
        contentView: {
          addChildView: ReturnType<typeof vi.fn>;
          removeChildView: ReturnType<typeof vi.fn>;
        };
      };
    }
  ).window;
}
// The cursor's view is the only one that loads a local file.
function overlayViews() {
  return vi
    .mocked(WebContentsView)
    .mock.results.map((result) => result.value as FakeView)
    .filter((view) => view.webContents.loadFile.mock.calls.length > 0);
}
const overlayView = () => overlayViews()[0];
// Everything the overlay awaits is already resolved, so one turn is enough.
const settle = () => new Promise((resolve) => setImmediate(resolve));
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
beforeEach(() => {
  sessions.clear();
  vi.clearAllMocks();
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
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 1,
      checkboxChecked: false,
    });
    const microphone = vi.fn();
    request(page, "media", microphone, {
      requestingUrl: page.url,
      isMainFrame: true,
      mediaTypes: ["audio"],
    });
    await Promise.resolve();
    expect(microphone).toHaveBeenCalledWith(true);
    expect(
      check(page, "media", "https://example.com", { mediaType: "audio" }),
    ).toBe(true);
    expect(
      check(page, "media", "https://example.com", { mediaType: "video" }),
    ).toBe(false);
    expect(
      check(page, "media", "https://example.com", { mediaType: "unknown" }),
    ).toBe(false);
    expect(dialog.showMessageBox).toHaveBeenLastCalledWith(
      browser.window,
      expect.objectContaining({
        message: "https://example.com wants to use microphone.",
      }),
    );
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 0,
      checkboxChecked: false,
    });
    const camera = vi.fn();
    request(page, "media", camera, {
      requestingUrl: page.url,
      isMainFrame: true,
      mediaTypes: ["video"],
    });
    await Promise.resolve();
    expect(dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(camera).toHaveBeenCalledWith(false);
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
    let answer!: (value: {
      response: number;
      checkboxChecked: boolean;
    }) => void;
    vi.mocked(dialog.showMessageBox).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const callback = vi.fn();
    request(page, "notifications", callback, {
      requestingUrl: page.url,
      isMainFrame: true,
    });
    await browser.dispatch({ type: "space:delete", id: "work" });
    answer({ response: 1, checkboxChecked: false });
    await Promise.resolve();
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
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
    let answer!: (value: {
      response: number;
      checkboxChecked: boolean;
    }) => void;
    vi.mocked(dialog.showMessageBox).mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    const callback = vi.fn();
    request(page, "notifications", callback, {
      requestingUrl: page.url,
      isMainFrame: true,
    });
    page.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    answer({ response: 1, checkboxChecked: false });
    await Promise.resolve();
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("denies website permissions and downloads in human-owned agent spaces", async () => {
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
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(dialog.showMessageBox).not.toHaveBeenCalled();
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
    // Only a handoff and a reported failure name their own reason.
    await expect(
      browser.dispatch({
        type: "space:ownership",
        id: space.id,
        owner: "human",
        reason: "approval",
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
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 1,
      checkboxChecked: false,
    });
    const callback = vi.fn();
    request(personal, "notifications", callback, {
      requestingUrl: "https://example.com/",
      isMainFrame: true,
    });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(true));
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
    // A grant sets access and labels the space's tabs; set them directly.
    work.access = "granted";
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
    vi.mocked(dialog.showMessageBox).mockResolvedValueOnce({
      response: 0,
      checkboxChecked: false,
    });
    const asked = vi.fn();
    request(page, "notifications", asked, {
      requestingUrl: "https://example.org/",
      isMainFrame: true,
    });
    await vi.waitFor(() => expect(asked).toHaveBeenCalledWith(false));
    expect(dialog.showMessageBox).toHaveBeenCalledOnce();
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

describe("agent task state", () => {
  it("setTask creates, patches and deletes a space's task and bumps changedAt only on a state change", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const browser = controller();
      const space = browser.createAgentSpace("Task");
      let emits = 0;
      browser.subscribe(() => (emits += 1));
      expect(browser.setTask(space.id, { status: "Comparing prices" })).toEqual({
        status: "Comparing prices",
        changedAt: 1000,
      });
      expect(emits).toBe(1);
      // A status change leaves the key the renderer marks as seen alone.
      vi.setSystemTime(2000);
      expect(browser.setTask(space.id, { status: "Checking stock" })).toEqual({
        status: "Checking stock",
        changedAt: 1000,
      });
      expect(emits).toBe(2);
      browser.setTask(space.id, { status: "Checking stock" });
      expect(emits).toBe(2);
      expect(
        browser.setTask(space.id, { state: "needs-you", reason: "Sign in" }),
      ).toEqual({
        status: "Checking stock",
        state: "needs-you",
        reason: "Sign in",
        changedAt: 2000,
      });
      expect(emits).toBe(3);
      vi.setSystemTime(3000);
      expect(
        browser.setTask(space.id, { state: undefined, reason: undefined }),
      ).toEqual({ status: "Checking stock", changedAt: 3000 });
      expect(space.task).not.toHaveProperty("state");
      expect(space.task).not.toHaveProperty("reason");
      expect(emits).toBe(4);
      expect(browser.setTask(space.id, null)).toBeUndefined();
      expect(space).not.toHaveProperty("task");
      expect(emits).toBe(5);
      browser.setTask(space.id, null);
      expect(emits).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a crashed agent page is flagged, logged once and cleared when its next main-frame navigation starts", async () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    await browser.dispatch({
      type: "tab:create",
      spaceId: space.id,
      url: "https://example.com/",
      background: true,
    });
    const tab = browser.state.tabs.at(-1)!;
    const page = contents(browser, tab.id);
    const crashes = () =>
      browser.state.activity.filter(
        (entry) => entry.message === "A page stopped working in this space",
      );
    page.emit("render-process-gone", {}, { reason: "crashed" });
    expect(tab.crashed).toBe(true);
    expect(tab.error).toBe(
      "The page process stopped (crashed). Reload to try again.",
    );
    expect(crashes()).toEqual([
      expect.objectContaining({ spaceId: space.id, kind: "warning" }),
    ]);
    // The flag itself keeps a second crash of the same page quiet.
    page.emit("render-process-gone", {}, { reason: "oom" });
    expect(crashes()).toHaveLength(1);
    page.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://example.com/again",
    });
    expect(tab).not.toHaveProperty("crashed");
    expect(tab).not.toHaveProperty("error");
    page.emit("render-process-gone", {}, { reason: "crashed" });
    expect(crashes()).toHaveLength(2);
    // A crash while the person has control is theirs to see on the page.
    await browser.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    page.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://example.com/third",
    });
    page.emit("render-process-gone", {}, { reason: "crashed" });
    expect(tab.crashed).toBe(true);
    expect(crashes()).toHaveLength(2);
    // A personal space nobody granted writes nothing either.
    const own = browser.state.tabs.find((item) => item.spaceId === "work")!;
    await browser.dispatch({
      type: "tab:navigate",
      id: own.id,
      url: "https://example.org/",
    });
    contents(browser, own.id).emit(
      "render-process-gone",
      {},
      { reason: "crashed" },
    );
    expect(own.crashed).toBe(true);
    expect(crashes()).toHaveLength(2);
  });

  it("activity entries carry the active label, the finish entry the status, and nothing else", () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    browser.setTask(space.id, {
      status: "Booking a table",
      label: { text: "Pick a time", active: true, at: Date.now() },
    });
    browser.addActivity(space.id, "Agent clicked Reserve");
    expect(browser.state.activity[0]).toMatchObject({
      message: "Agent clicked Reserve",
      agentText: "Pick a time",
    });
    // An explicit text wins over the label, and keeps its own limit.
    browser.addActivity(
      space.id,
      "Agent updated its status",
      "info",
      "y".repeat(400),
    );
    expect(browser.state.activity[0].agentText).toBe("y".repeat(300));
    browser.setTask(space.id, {
      label: { text: "Pick a time", active: false, at: Date.now() },
    });
    browser.addActivity(space.id, "Agent opened example.com");
    expect(browser.state.activity[0]).not.toHaveProperty("agentText");
    browser.addActivity(space.id, "Agent finished", "success");
    expect(browser.state.activity[0].agentText).toBe("Booking a table");
    // Kamapathy's own words and the person's are never shown as the agent's.
    browser.addActivity(space.id, "You took control. Agent access is paused.");
    expect(browser.state.activity[0]).not.toHaveProperty("agentText");
    browser.setTask(space.id, null);
    browser.addActivity(space.id, "Agent finished", "success");
    expect(browser.state.activity[0]).not.toHaveProperty("agentText");
  });

  it("a failure handover changes the owner without a control entry", async () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    await browser.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
      reason: "failed",
    });
    expect(space.owner).toBe("human");
    expect(space.control).toMatchObject({ reason: "failed" });
    expect(
      browser.state.activity.some((entry) =>
        entry.message.startsWith("You took control"),
      ),
    ).toBe(false);
  });

  it("space names are cleaned as agent text", async () => {
    const browser = controller();
    await browser.dispatch({
      type: "space:create",
      name: "Pa\u202eid\u200e work",
      color: "blue",
      kind: "personal",
    });
    const space = browser.state.spaces.at(-1)!;
    expect(space.name).toBe("Paid work");
    await browser.dispatch({
      type: "space:rename",
      id: space.id,
      name: "\u200e\u202a ",
    });
    expect(space.name).toBe("Untitled space");
    await expect(
      browser.dispatch({
        type: "space:rename",
        id: space.id,
        name: "x".repeat(49),
      }),
    ).rejects.toThrow("Invalid text value.");
    expect(browser.createAgentSpace("Trip\u200e planning").name).toBe(
      "Trip planning",
    );
    expect(browser.createAgentSpace("\u202a\u200f").name).toBe("Agent space");
  });

  it("showAgentTab reveals a tab in place and waits at most 500 ms for a frame", async () => {
    vi.useFakeTimers();
    try {
      const browser = controller();
      const space = browser.createAgentSpace("Task");
      const first = browser.openAgentTab(space.id, "https://example.com/one");
      const second = browser.openAgentTab(space.id, "https://example.com/two");
      await browser.dispatch({ type: "tab:activate", id: first.id });
      const page = contents(browser, second.id);
      // The reveal makes the tab the shown one at once and then waits for
      // the frame the view draws in its place.
      let revealed = false;
      const reveal = browser
        .showAgentTab(second.id)
        .then(() => (revealed = true));
      expect(browser.state.activeTabId).toBe(second.id);
      expect(browser.state.activeSpaceId).toBe(space.id);
      await vi.advanceTimersByTimeAsync(400);
      expect(revealed).toBe(false);
      page.frame();
      await reveal;
      expect(revealed).toBe(true);
      expect(page.endFrameSubscription).toHaveBeenCalledTimes(1);
      // A page that never draws lets the reveal through at the cap.
      let capped = false;
      const next = browser.showAgentTab(first.id).then(() => (capped = true));
      await vi.advanceTimersByTimeAsync(499);
      expect(capped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await next;
      expect(capped).toBe(true);
      // A tab the window is not showing has no frame to wait for: another
      // space's page, and any page while the content area is hidden.
      const other = browser.createAgentSpace("Other");
      const elsewhere = browser.openAgentTab(
        other.id,
        "https://example.com/three",
      );
      const background = contents(browser, elsewhere.id);
      await browser.showAgentTab(elsewhere.id);
      expect(browser.state.activeSpaceId).toBe(space.id);
      expect(background.beginFrameSubscription).not.toHaveBeenCalled();
      browser.setContentBounds({
        x: 200,
        y: 80,
        width: 1000,
        height: 700,
        hidden: true,
      });
      vi.mocked(page.beginFrameSubscription).mockClear();
      await browser.showAgentTab(second.id);
      expect(browser.state.activeTabId).toBe(second.id);
      expect(page.beginFrameSubscription).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("agent views are created at the content area size and other views keep 1200 by 800", async () => {
    const browser = controller();
    const area = { x: 200, y: 80, width: 1000, height: 700 };
    const space = browser.createAgentSpace("Task");
    const agentTab = browser.openAgentTab(space.id, "https://example.com/");
    expect(viewFor(contents(browser, agentTab.id)).getBounds()).toEqual(area);
    // The person's own page keeps the size it has always had.
    const own = browser.state.tabs.find((tab) => tab.spaceId === "work")!;
    await browser.dispatch({
      type: "tab:navigate",
      id: own.id,
      url: "https://example.org/",
    });
    expect(viewFor(contents(browser, own.id)).getBounds()).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
    // A granted space follows agent rules, so its next page does too.
    browser.grantAccess("work");
    await browser.dispatch({
      type: "tab:create",
      spaceId: "work",
      url: "https://example.net/",
      background: true,
    });
    const granted = browser.state.tabs.at(-1)!;
    expect(viewFor(contents(browser, granted.id)).getBounds()).toEqual(area);
    // Without a content area to copy, agent pages keep today's size.
    browser.setContentBounds({ ...area, hidden: true });
    const hidden = browser.openAgentTab(space.id, "https://example.com/two");
    expect(viewFor(contents(browser, hidden.id)).getBounds()).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
    browser.setContentBounds({ ...area, width: 0, hidden: false });
    const zero = browser.openAgentTab(space.id, "https://example.com/three");
    expect(viewFor(contents(browser, zero.id)).getBounds()).toEqual({
      x: 0,
      y: 0,
      width: 1200,
      height: 800,
    });
  });
});

describe("agent cursor", () => {
  it("the cursor overlay is created once, raised above each new page view and disposed with the controller", async () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    const tab = browser.openAgentTab(space.id, "https://example.com/");
    await browser.dispatch({ type: "tab:activate", id: tab.id });
    const window = windowOf(browser);
    const added = () =>
      window.contentView.addChildView.mock.calls.map(([view]) => view);
    browser.reportPointer(tab.id, { type: "move", x: 100, y: 50 });
    await settle();
    const overlay = overlayView();
    expect(overlay.getVisible()).toBe(true);
    expect(added().filter((view) => view === overlay)).toHaveLength(1);
    // A page view made later joins the window above the cursor, so the
    // overlay is added again over it.
    browser.openAgentTab(space.id, "https://example.com/two");
    expect(added().at(-1)).toBe(overlay);
    expect(added().filter((view) => view === overlay)).toHaveLength(2);
    expect(overlayViews()).toHaveLength(1);
    // Every layout re-checks the rules: the page view moved, so the place
    // the cursor had is no longer the point the agent acted on.
    browser.setContentBounds({
      x: 200,
      y: 80,
      width: 900,
      height: 700,
      hidden: false,
    });
    expect(overlay.getVisible()).toBe(false);
    browser.dispose();
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(overlay);
    expect(overlay.webContents.isDestroyed()).toBe(true);
  });

  it("reportPointer shows the cursor only for the shown tab of an agent-owned space", async () => {
    const browser = controller();
    const space = browser.createAgentSpace("Task");
    const tab = browser.openAgentTab(space.id, "https://example.com/");
    const background = browser.openAgentTab(
      space.id,
      "https://example.com/two",
    );
    await browser.dispatch({ type: "tab:activate", id: tab.id });
    const point = async (id: string) => {
      browser.reportPointer(
        id,
        { type: "press", x: 100, y: 50 },
        "Pick a time",
      );
      await settle();
      return overlayView().getVisible();
    };
    expect(await point(tab.id)).toBe(true);
    expect(overlayView().getBounds()).toMatchObject({
      x: 200 + 100 - 14,
      y: 80 + 50 - 14,
    });
    // A page of the same space that the person is not looking at.
    expect(await point(background.id)).toBe(false);
    expect(await point(tab.id)).toBe(true);
    // The person's own page, even while they are looking at it.
    const own = browser.state.tabs.find((item) => item.spaceId === "work")!;
    await browser.dispatch({
      type: "tab:navigate",
      id: own.id,
      url: "https://example.org/",
    });
    await browser.dispatch({ type: "tab:activate", id: own.id });
    expect(await point(own.id)).toBe(false);
    await browser.dispatch({ type: "tab:activate", id: tab.id });
    expect(await point(tab.id)).toBe(true);
    // The person has control of the agent's space.
    await browser.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    // The change hides it where it stands, without waiting for a point.
    expect(overlayView().getVisible()).toBe(false);
    expect(await point(tab.id)).toBe(false);
    await browser.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "agent",
    });
    expect(await point(tab.id)).toBe(true);
    // Agent access off is the hard stop.
    await browser.dispatch({
      type: "settings:update",
      settings: { automationEnabled: false },
    });
    expect(overlayView().getVisible()).toBe(false);
    expect(await point(tab.id)).toBe(false);
    await browser.dispatch({
      type: "settings:update",
      settings: { automationEnabled: true },
    });
    expect(await point(tab.id)).toBe(true);
    // A space whose access ended is no agent's any more.
    browser.endAccess(space.id, { by: "agent", reason: "finished" });
    expect(await point(tab.id)).toBe(false);
    // Nothing an agent reports can cost it its action.
    expect(() =>
      browser.reportPointer("missing", { type: "move", x: 1, y: 1 }),
    ).not.toThrow();
    browser.dispose();
    expect(() =>
      browser.reportPointer(tab.id, { type: "move", x: 1, y: 1 }),
    ).not.toThrow();
  });
});
