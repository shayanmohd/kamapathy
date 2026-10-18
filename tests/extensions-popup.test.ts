import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import { initialState } from "../shared/state";
import type { BrowserState } from "../shared/types";
import {
  ExtensionPopups,
  extensionWindowBounds,
  popupBounds,
  type PopupDeps,
  type Rect,
} from "../electron/extensions/popup";
import type {
  ExtensionHost,
  HostEvent,
  SurfaceInfo,
} from "../electron/extensions/host";
import { extensionBridgeCopy } from "../src/copy";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  screen: { getAllDisplays: vi.fn(() => []), getDisplayMatching: vi.fn() },
}));

// A distinct valid id per number: its hex digits as the letters a to p.
function idAt(index: number): string {
  return Array.from(index.toString(16).padStart(32, "0"), (digit) =>
    String.fromCharCode(97 + parseInt(digit, 16)),
  ).join("");
}
const [ONE, TWO] = [1, 2].map(idAt);
const PERSONAL = "persist:space-personal";
const ANCHOR = { x: 900, y: 40, width: 32, height: 32 };
const CONTENT: Rect = { x: 100, y: 108, width: 1200, height: 772 };
const WORK_AREA: Rect = { x: 0, y: 25, width: 1440, height: 807 };

class FakeContents extends EventEmitter {
  static next = 500;
  readonly id = FakeContents.next++;
  url = "";
  destroyed = false;
  openHandler?: (details: { url: string }) => { action: string };
  loadURL = vi.fn(async (url: string) => {
    this.url = url;
  });
  setWindowOpenHandler = vi.fn(
    (handler: (details: { url: string }) => { action: string }) => {
      this.openHandler = handler;
    },
  );
  focus = vi.fn();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getURL(): string {
    return this.url;
  }
  // Electron's events, with whether the page's navigation was stopped.
  navigate(url: string): boolean {
    let prevented = false;
    this.emit(
      "will-navigate",
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      url,
    );
    return prevented;
  }
  press(key: string, type = "keyDown"): boolean {
    let prevented = false;
    this.emit(
      "before-input-event",
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      { key, type },
    );
    return prevented;
  }
  preferredSize(width: number, height: number): void {
    this.emit("preferred-size-changed", {}, { width, height });
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents = new FakeContents();
  bounds: Rect;
  shown: boolean;
  focused = false;
  destroyed = false;
  setBounds = vi.fn((next: Partial<Rect>) => {
    this.bounds = { ...this.bounds, ...next };
  });
  show = vi.fn(() => {
    this.shown = true;
  });
  focus = vi.fn(() => {
    this.focused = true;
  });
  close = vi.fn(() => this.kill());
  destroy = vi.fn(() => this.kill());
  constructor(readonly options: Record<string, unknown> = {}) {
    super();
    this.bounds = {
      x: (options.x as number) ?? 0,
      y: (options.y as number) ?? 0,
      width: (options.width as number) ?? 1200,
      height: (options.height as number) ?? 800,
    };
    this.shown = options.show !== false;
  }
  getBounds(): Rect {
    return this.bounds;
  }
  getContentBounds(): Rect {
    return this.bounds;
  }
  isFocused(): boolean {
    return this.focused;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  private kill(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }
}

class FakeHost {
  readonly surfaces = new Map<WebContents, SurfaceInfo>();
  readonly sessions = new Map<string, object>([[PERSONAL, { name: "ses" }]]);
  readonly names = new Map<string, string>([
    [ONE, "First extension"],
    [TWO, "Second extension"],
  ]);
  private readonly listeners = new Set<(event: HostEvent) => void>();
  addSurface = vi.fn((contents: WebContents, info: SurfaceInfo) => {
    this.surfaces.set(contents, info);
  });
  surfaceOf(contents: WebContents): SurfaceInfo | undefined {
    return this.surfaces.get(contents);
  }
  sessionOf(partition: string): object | undefined {
    return this.sessions.get(partition);
  }
  nameOf(id: string): string | undefined {
    return this.names.get(id);
  }
  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  send(event: HostEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

const displays = [
  { workArea: WORK_AREA, bounds: { x: 0, y: 0, width: 1440, height: 832 } },
  {
    workArea: { x: 1440, y: 0, width: 1000, height: 800 },
    bounds: { x: 1440, y: 0, width: 1000, height: 800 },
  },
];
const inside = (area: Rect, x: number, y: number) =>
  x >= area.x &&
  x < area.x + area.width &&
  y >= area.y &&
  y < area.y + area.height;

interface Setup {
  popups: ExtensionPopups;
  host: FakeHost;
  main: FakeWindow;
  made: FakeWindow[];
  opened: {
    url: string;
    from: { extensionId: string; partition: string; spaceId?: string };
  }[];
}
function setUp(): Setup {
  const host = new FakeHost();
  const main = new FakeWindow({ width: 1200, height: 772 });
  main.bounds = { ...CONTENT };
  const made: FakeWindow[] = [];
  const opened: Setup["opened"] = [];
  const deps: PopupDeps = {
    host: host as unknown as ExtensionHost,
    window: () => main as unknown as BrowserWindow,
    openLink: (url, from) => opened.push({ url, from }),
    screen: {
      getAllDisplays: () => displays,
      getDisplayMatching: (rect: { x: number; y: number }) =>
        displays.find((display) => inside(display.workArea, rect.x, rect.y)) ??
        displays[0],
    } as unknown as PopupDeps["screen"],
    createWindow: (options) => {
      const window = new FakeWindow(options as Record<string, unknown>);
      made.push(window);
      return window as unknown as BrowserWindow;
    },
  };
  return { popups: new ExtensionPopups(deps), host, main, made, opened };
}
const popupRequest = (extensionId = ONE, spaceId = "personal") => ({
  extensionId,
  partition: PERSONAL,
  spaceId,
  url: `chrome-extension://${extensionId}/popup.html`,
  anchor: ANCHOR,
});
function stateWith(spaceId: string, tabId: string): BrowserState {
  return {
    ...initialState("darwin"),
    activeSpaceId: spaceId,
    activeTabId: tabId,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extension popups and windows", () => {
  it("sizes the popup from its preferred size within 25 to 800 by 25 to 600 and places it under its button", () => {
    // Right aligned under the button, 4 px below it.
    expect(
      popupBounds(ANCHOR, { width: 360, height: 252 }, CONTENT, WORK_AREA),
    ).toEqual({ x: 672, y: 184, width: 360, height: 252 });
    // The limits hold both ways.
    expect(
      popupBounds(ANCHOR, { width: 4, height: 2000 }, CONTENT, WORK_AREA),
    ).toMatchObject({ width: 25, height: 600 });
    expect(
      popupBounds(ANCHOR, { width: 2000, height: 10 }, CONTENT, WORK_AREA),
    ).toMatchObject({ width: 800, height: 25 });
    // A button near an edge keeps the popup inside the work area.
    const far = popupBounds(
      { x: 1100, y: 700, width: 32, height: 32 },
      { width: 360, height: 252 },
      { x: 1000, y: 100, width: 1200, height: 700 },
      WORK_AREA,
    );
    expect(far).toEqual({ x: 1080, y: 580, width: 360, height: 252 });

    const { popups, host, main, made } = setUp();
    popups.togglePopup(popupRequest());
    expect(made).toHaveLength(1);
    const popup = made[0];
    expect(popup.options).toMatchObject({
      parent: main,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      width: 25,
      height: 25,
    });
    expect(popup.options.webPreferences).toMatchObject({
      session: host.sessions.get(PERSONAL),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      enablePreferredSizeMode: true,
      spellcheck: false,
    });
    expect(popup.webContents.loadURL).toHaveBeenCalledWith(
      `chrome-extension://${ONE}/popup.html`,
    );
    expect(host.addSurface).toHaveBeenCalledWith(popup.webContents, {
      kind: "popup",
      extensionId: ONE,
      partition: PERSONAL,
      spaceId: "personal",
    });
    expect(popup.shown).toBe(false);

    // The page reports its size, so the popup takes it and shows once.
    popup.webContents.preferredSize(360, 252);
    expect(popup.setBounds).toHaveBeenLastCalledWith({
      x: 672,
      y: 184,
      width: 360,
      height: 252,
    });
    expect(popup.show).toHaveBeenCalledTimes(1);
    popup.webContents.preferredSize(300, 120);
    expect(popup.setBounds).toHaveBeenLastCalledWith({
      x: 732,
      y: 184,
      width: 300,
      height: 120,
    });
    expect(popup.show).toHaveBeenCalledTimes(1);
  });

  it("keeps one popup open and closes it on blur, Escape, a second click, a tab or space switch and unload", () => {
    const { popups, host, main, made } = setUp();
    popups.onState(stateWith("personal", "tab-1"));
    popups.togglePopup(popupRequest());
    expect(popups.shownPopup()).toEqual({ extensionId: ONE });

    // Another extension's popup replaces the first.
    popups.togglePopup(popupRequest(TWO));
    expect(made[0].destroyed).toBe(true);
    expect(popups.shownPopup()).toEqual({ extensionId: TWO });

    // A second click on the same button closes it.
    popups.togglePopup(popupRequest(TWO));
    expect(made[1].destroyed).toBe(true);
    expect(popups.shownPopup()).toBeUndefined();

    popups.togglePopup(popupRequest());
    made[2].emit("blur");
    expect(made[2].destroyed).toBe(true);
    expect(popups.shownPopup()).toBeUndefined();

    popups.togglePopup(popupRequest());
    expect(made[3].webContents.press("Escape")).toBe(true);
    expect(made[3].destroyed).toBe(true);
    // Other keys reach the page.
    popups.togglePopup(popupRequest());
    expect(made[4].webContents.press("a")).toBe(false);
    expect(made[4].destroyed).toBe(false);
    // Escape going up is the same key press, not a second one.
    expect(made[4].webContents.press("Escape", "keyUp")).toBe(false);
    expect(made[4].destroyed).toBe(false);

    // Another tab, then another space.
    popups.onState(stateWith("personal", "tab-2"));
    expect(made[4].destroyed).toBe(true);
    popups.togglePopup(popupRequest());
    popups.onState(stateWith("work", "tab-9"));
    expect(made[5].destroyed).toBe(true);
    // The same state again leaves it open.
    popups.togglePopup(popupRequest());
    popups.onState(stateWith("work", "tab-9"));
    expect(made[6].destroyed).toBe(false);

    // The extension unloading in that session closes its popup.
    host.send({ type: "unloaded", id: TWO, partition: PERSONAL });
    expect(made[6].destroyed).toBe(false);
    host.send({ type: "unloaded", id: ONE, partition: PERSONAL });
    expect(made[6].destroyed).toBe(true);
    expect(popups.shownPopup()).toBeUndefined();

    // Kamapathy's window closing takes the popup with it.
    popups.togglePopup(popupRequest());
    main.emit("closed");
    expect(made[7].destroyed).toBe(true);
    expect(made).toHaveLength(8);
  });

  it("opens popup links as tabs in the target personal space and cancels other navigation away from its origin", () => {
    const { popups, made, opened } = setUp();
    popups.togglePopup(popupRequest());
    const page = made[0].webContents;

    // window.open never opens a window; web links become tabs.
    expect(page.openHandler?.({ url: "https://example.com/help" })).toEqual({
      action: "deny",
    });
    expect(opened).toEqual([
      {
        url: "https://example.com/help",
        from: { extensionId: ONE, partition: PERSONAL, spaceId: "personal" },
      },
    ]);
    expect(
      page.openHandler?.({ url: `chrome-extension://${ONE}/other.html` }),
    ).toEqual({ action: "deny" });
    expect(page.openHandler?.({ url: "file:///etc/hosts" })).toEqual({
      action: "deny",
    });
    expect(opened).toHaveLength(1);

    // A link click to the web opens a tab and the popup stays where it is.
    expect(page.navigate("http://example.com/docs")).toBe(true);
    expect(opened[1]).toMatchObject({ url: "http://example.com/docs" });
    // Its own pages load in the popup.
    expect(page.navigate(`chrome-extension://${ONE}/second.html`)).toBe(false);
    // Another extension's page, and anything else, is cancelled.
    expect(page.navigate(`chrome-extension://${TWO}/page.html`)).toBe(true);
    expect(page.navigate("file:///etc/hosts")).toBe(true);
    expect(opened).toHaveLength(2);
  });

  it("extension windows take their size within 200 to 1600 by 150 to 1200, sit on a visible display or centered, and stop at 4 per extension", () => {
    const fallback: Rect = { x: 100, y: 100, width: 1000, height: 800 };
    const areas = displays.map((display) => display.workArea);
    // Nothing asked for: the standard size, centered in the fallback.
    expect(extensionWindowBounds({}, areas, fallback)).toEqual({
      x: 350,
      y: 200,
      width: 500,
      height: 600,
    });
    expect(
      extensionWindowBounds({ width: 50, height: 40 }, areas, fallback),
    ).toMatchObject({ width: 200, height: 150 });
    expect(
      extensionWindowBounds({ width: 4000, height: 4000 }, areas, fallback),
    ).toMatchObject({ width: 1600, height: 1200 });
    // A point on the second display is used as given.
    expect(
      extensionWindowBounds(
        { left: 1500, top: 120, width: 600, height: 400 },
        areas,
        fallback,
      ),
    ).toEqual({ x: 1500, y: 120, width: 600, height: 400 });
    // A point on no display centers the window instead.
    expect(
      extensionWindowBounds(
        { left: 5000, top: 5000, width: 600, height: 400 },
        areas,
        fallback,
      ),
    ).toEqual({ x: 300, y: 300, width: 600, height: 400 });

    const { popups, host, made } = setUp();
    const info = popups.openWindow({
      windowId: 7,
      extensionId: ONE,
      partition: PERSONAL,
      url: `chrome-extension://${ONE}/page.html`,
      left: 200,
      top: 150,
      width: 640,
      height: 480,
      focused: true,
    });
    expect(info).toMatchObject({
      windowId: 7,
      extensionId: ONE,
      partition: PERSONAL,
      url: `chrome-extension://${ONE}/page.html`,
      focused: true,
      bounds: { left: 200, top: 150, width: 640, height: 480 },
    });
    expect(info.tabId).toBe(made[0].webContents.id);
    expect(made[0].options).toMatchObject({
      x: 200,
      y: 150,
      width: 640,
      height: 480,
      show: true,
      autoHideMenuBar: true,
      title: "First extension",
    });
    expect(made[0].options.webPreferences).toMatchObject({
      session: host.sessions.get(PERSONAL),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    });
    expect(host.addSurface).toHaveBeenCalledWith(made[0].webContents, {
      kind: "window",
      extensionId: ONE,
      partition: PERSONAL,
      windowId: 7,
    });
    // Its pages follow the popup's rules.
    expect(made[0].webContents.navigate("https://example.com/")).toBe(true);
    expect(
      made[0].webContents.navigate(`chrome-extension://${ONE}/next.html`),
    ).toBe(false);

    // A window the extension does not want in front stays hidden.
    popups.openWindow({
      windowId: 8,
      extensionId: ONE,
      partition: PERSONAL,
      url: `chrome-extension://${ONE}/two.html`,
      focused: false,
    });
    expect(made[1].options).toMatchObject({ show: false });
    expect(
      popups.windowsOf(ONE, PERSONAL).map((item) => item.windowId),
    ).toEqual([7, 8]);
    expect(popups.windowsOf(TWO, PERSONAL)).toEqual([]);

    // Four each, and no more.
    for (const windowId of [9, 10])
      popups.openWindow({
        windowId,
        extensionId: ONE,
        partition: PERSONAL,
        url: `chrome-extension://${ONE}/more.html`,
        focused: false,
      });
    expect(() =>
      popups.openWindow({
        windowId: 11,
        extensionId: ONE,
        partition: PERSONAL,
        url: `chrome-extension://${ONE}/fifth.html`,
        focused: false,
      }),
    ).toThrow(extensionBridgeCopy.tooManyWindows);
    expect(popups.windowsOf(ONE, PERSONAL)).toHaveLength(4);
    // Another extension has its own four.
    expect(
      popups.openWindow({
        windowId: 12,
        extensionId: TWO,
        partition: PERSONAL,
        url: `chrome-extension://${TWO}/page.html`,
        focused: true,
      }).windowId,
    ).toBe(12);

    // Moving, resizing, bringing to the front and closing one.
    const moved = popups.updateWindow(7, { left: 300, width: 4000 });
    expect(moved.bounds).toEqual({
      left: 300,
      top: 150,
      width: 1600,
      height: 480,
    });
    expect(popups.updateWindow(8, { focused: true }).focused).toBe(true);
    expect(made[1].shown).toBe(true);
    expect(popups.closeWindow(7)).toBe(true);
    expect(made[0].destroyed).toBe(true);
    expect(popups.closeWindow(7)).toBe(false);
    expect(popups.windowsOf(ONE, PERSONAL)).toHaveLength(3);
  });

  it("extension windows close with the main window or their extension", () => {
    const { popups, host, main, made } = setUp();
    for (const [windowId, extensionId] of [
      [1, ONE],
      [2, ONE],
      [3, TWO],
    ] as const)
      popups.openWindow({
        windowId,
        extensionId,
        partition: PERSONAL,
        url: `chrome-extension://${extensionId}/page.html`,
        focused: false,
      });

    // The extension unloading closes only its own windows.
    host.send({ type: "unloaded", id: ONE, partition: "persist:space-other" });
    expect(made.map((item) => item.destroyed)).toEqual([false, false, false]);
    host.send({ type: "unloaded", id: ONE, partition: PERSONAL });
    expect(made.map((item) => item.destroyed)).toEqual([true, true, false]);
    expect(popups.windowsOf(ONE, PERSONAL)).toEqual([]);

    // Kamapathy's window closing closes the rest.
    main.emit("closed");
    expect(made[2].destroyed).toBe(true);
    expect(popups.windowsOf(TWO, PERSONAL)).toEqual([]);

    // The session going away closes its windows too, and so does quitting.
    popups.openWindow({
      windowId: 4,
      extensionId: TWO,
      partition: PERSONAL,
      url: `chrome-extension://${TWO}/page.html`,
      focused: false,
    });
    host.send({ type: "detached", partition: PERSONAL });
    expect(made[3].destroyed).toBe(true);
    popups.openWindow({
      windowId: 5,
      extensionId: TWO,
      partition: PERSONAL,
      url: `chrome-extension://${TWO}/page.html`,
      focused: false,
    });
    popups.dispose();
    expect(made[4].destroyed).toBe(true);
  });
});
