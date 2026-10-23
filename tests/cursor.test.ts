import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContentsView as View } from "electron";
import { WebContentsView } from "electron";
import {
  CURSOR,
  CursorOverlay,
  type CursorHost,
  type CursorMetrics,
  type CursorUpdate,
} from "../electron/agent/cursor";

vi.mock("electron", () => ({
  WebContentsView: vi.fn(function () {
    return new FakeView();
  }),
}));

class FakeContents extends EventEmitter {
  destroyed = false;
  zoomFactor = 1;
  url = "";
  // Every update the page was given, already parsed.
  updates: CursorUpdate[] = [];
  measure = (update: CursorUpdate): CursorMetrics =>
    update.label
      ? { width: 160, height: 54, reducedMotion: false }
      : { width: CURSOR.size, height: CURSOR.size, reducedMotion: false };
  setWindowOpenHandler = vi.fn();
  loadFile = vi.fn(async (file: string) => {
    this.url = `file://${file}`;
  });
  loadURL = vi.fn(async (url: string) => {
    this.url = url;
  });
  executeJavaScript = vi.fn(async (code: string) => {
    const argument = code.slice(code.indexOf("(") + 1, code.lastIndexOf(")"));
    const update = JSON.parse(argument) as CursorUpdate;
    this.updates.push(update);
    return this.measure(update);
  });
  isDestroyed = () => this.destroyed;
  getURL = () => this.url;
  getZoomFactor = () => this.zoomFactor;
  close = vi.fn(() => {
    this.destroyed = true;
  });
}
class FakeView {
  constructor(public webContents = new FakeContents()) {}
  visible = false;
  bounds = { x: 0, y: 0, width: 0, height: 0 };
  setBackgroundColor = vi.fn();
  setVisible(value: boolean) {
    this.visible = value;
  }
  setBounds(value: typeof this.bounds) {
    this.bounds = value;
  }
  getVisible() {
    return this.visible;
  }
  getBounds() {
    return this.bounds;
  }
}

const PAGE = { x: 200, y: 80, width: 1000, height: 700 };
// Everything the overlay awaits is already resolved, so one turn is enough.
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const page = new FakeView();
  page.bounds = { ...PAGE };
  const views = new Map([["tab-1", page]]);
  // What the controller's cursorShows decides, as far as the overlay can
  // tell: one flag per condition, and the tab its space shows.
  const rules = {
    frozen: false,
    humanControl: false,
    accessOff: false,
    windowHidden: false,
    windowGone: false,
    shown: "tab-1",
  };
  const contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
  const window = {
    contentView,
    isDestroyed: () => rules.windowGone,
  } as unknown as BrowserWindow;
  const host: CursorHost = {
    window,
    view: (tabId) => views.get(tabId) as unknown as View | undefined,
    shows: (tabId) =>
      views.has(tabId) &&
      rules.shown === tabId &&
      !rules.frozen &&
      !rules.humanControl &&
      !rules.accessOff &&
      !rules.windowHidden,
  };
  const overlay = new CursorOverlay(host, {
    page: { file: "/app/src/cursor/index.html" },
  });
  const cursor = () => contentView.addChildView.mock.calls[0]?.[0] as FakeView;
  return { contentView, cursor, overlay, page, rules, views };
}

beforeEach(() => {
  vi.mocked(WebContentsView).mockClear();
});

describe("agent cursor overlay", () => {
  it("the tip lands on the zoomed point, the pill flips inside the page view, and the view stays above later views", async () => {
    const { contentView, cursor, overlay, page } = setup();
    overlay.point("tab-1", { type: "move", x: 300, y: 200 });
    await settle();
    const view = cursor();
    expect(view.getVisible()).toBe(true);
    expect(view.getBounds()).toEqual({
      x: PAGE.x + 300 - CURSOR.tip.x,
      y: PAGE.y + 200 - CURSOR.tip.y,
      width: CURSOR.size,
      height: CURSOR.size,
    });
    expect(view.webContents.updates).toEqual([
      { label: "", press: false, flipX: false, flipY: false },
    ]);
    // A zoomed page reports its points in CSS pixels, so the tip is the
    // page view's origin plus the point times the zoom factor.
    page.webContents.zoomFactor = 1.25;
    overlay.point("tab-1", { type: "press", x: 300, y: 40 });
    await settle();
    expect(view.getBounds()).toMatchObject({
      x: PAGE.x + 300 * 1.25 - CURSOR.tip.x,
      y: PAGE.y + 40 * 1.25 - CURSOR.tip.y,
    });
    expect(view.webContents.updates.at(-1)).toEqual({
      label: "",
      press: true,
      flipX: false,
      flipY: false,
    });
    // A label widens the view by the size the page reports for it.
    page.webContents.zoomFactor = 1;
    overlay.point("tab-1", { type: "move", x: 300, y: 200 }, "Pick a time");
    await settle();
    expect(view.getBounds()).toEqual({
      x: PAGE.x + 300 - CURSOR.tip.x,
      y: PAGE.y + 200 - CURSOR.tip.y,
      width: 160,
      height: 54,
    });
    // Near the right and bottom edges the pill flips to the other side of
    // the tip instead of leaving the page.
    overlay.point("tab-1", { type: "move", x: 950, y: 680 }, "Pick a time");
    await settle();
    expect(view.webContents.updates.at(-1)).toMatchObject({
      flipX: true,
      flipY: true,
    });
    expect(view.getBounds()).toEqual({
      x: PAGE.x + 950 + CURSOR.tip.x - 160,
      y: PAGE.y + 680 + CURSOR.tip.y - 54,
      width: 160,
      height: 54,
    });
    // In the very corner the whole view is kept inside the page view, so it
    // can never cover the toolbar, the tab strip or the agent bar.
    overlay.point("tab-1", { type: "move", x: 998, y: 698 }, "Pick a time");
    await settle();
    const corner = view.getBounds();
    expect(corner.x).toBe(PAGE.x + PAGE.width - corner.width);
    expect(corner.y).toBe(PAGE.y + PAGE.height - corner.height);
    expect(corner.x).toBeGreaterThanOrEqual(PAGE.x);
    expect(corner.y).toBeGreaterThanOrEqual(PAGE.y);
    // One view for the cursor, added once, and re-added above a page view
    // that joined the window later.
    expect(vi.mocked(WebContentsView)).toHaveBeenCalledTimes(1);
    expect(contentView.addChildView.mock.calls).toEqual([[view]]);
    overlay.raise();
    expect(contentView.addChildView.mock.calls).toEqual([[view], [view]]);
  });

  it("it hides for frozen pages, human control, access off, a hidden window or a resized view", async () => {
    const { contentView, cursor, overlay, page, rules } = setup();
    const show = async () => {
      overlay.point("tab-1", { type: "move", x: 300, y: 200 });
      await settle();
    };
    await show();
    const view = cursor();
    expect(view.getVisible()).toBe(true);
    for (const condition of [
      "frozen",
      "humanControl",
      "accessOff",
      "windowHidden",
    ] as const) {
      rules[condition] = true;
      overlay.refresh();
      expect(view.getVisible()).toBe(false);
      // The point is forgotten with the cursor, so the condition ending
      // shows nothing by itself.
      rules[condition] = false;
      overlay.refresh();
      expect(view.getVisible()).toBe(false);
      await show();
      expect(view.getVisible()).toBe(true);
    }
    // A page view that moved or resized since the point: the place the
    // cursor had is only right for the rect it was measured in.
    page.bounds = { ...PAGE, width: 700 };
    overlay.refresh();
    expect(view.getVisible()).toBe(false);
    await show();
    expect(view.getVisible()).toBe(true);
    // A tab its space is not showing never draws the cursor.
    rules.shown = "tab-2";
    overlay.point("tab-1", { type: "move", x: 10, y: 10 });
    await settle();
    expect(view.getVisible()).toBe(false);
    expect(contentView.addChildView.mock.calls).toEqual([[view]]);
    // A point that may not show never even builds the overlay.
    const quiet = setup();
    quiet.rules.accessOff = true;
    quiet.overlay.point("tab-1", { type: "move", x: 10, y: 10 });
    await settle();
    expect(quiet.contentView.addChildView).not.toHaveBeenCalled();
  });

  it("overlay errors never fail an action", async () => {
    const { cursor, overlay, page } = setup();
    overlay.point("tab-1", { type: "move", x: 300, y: 200 });
    await settle();
    const view = cursor();
    expect(view.getVisible()).toBe(true);
    // The page never answers.
    view.webContents.executeJavaScript.mockRejectedValueOnce(
      new Error("Script failed to execute"),
    );
    expect(() =>
      overlay.point("tab-1", { type: "move", x: 320, y: 220 }, "Pick a time"),
    ).not.toThrow();
    await settle();
    expect(view.getVisible()).toBe(false);
    // The view goes while the page is measuring.
    overlay.point("tab-1", { type: "move", x: 300, y: 200 });
    await settle();
    expect(view.getVisible()).toBe(true);
    view.setBounds = () => {
      throw new Error("Object has been destroyed");
    };
    expect(() =>
      overlay.point("tab-1", { type: "move", x: 340, y: 240 }, "Choose a seat"),
    ).not.toThrow();
    await settle();
    expect(view.getVisible()).toBe(false);
    expect(page.webContents.updates).toEqual([]);
    // The window closed before the first point.
    const closing = setup();
    closing.rules.windowGone = true;
    expect(() =>
      closing.overlay.point("tab-1", { type: "press", x: 10, y: 10 }),
    ).not.toThrow();
    await settle();
    expect(closing.contentView.addChildView).not.toHaveBeenCalled();
    expect(() => closing.overlay.raise()).not.toThrow();
    expect(() => closing.overlay.dispose()).not.toThrow();
  });
});
