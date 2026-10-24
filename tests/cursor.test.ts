import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow, WebContentsView as View } from "electron";
import { WebContentsView } from "electron";
import {
  CURSOR,
  CursorOverlay,
  GLIDE,
  PERSON_HIDE_MS,
  PRESS_RING_MS,
  type CursorHost,
  type CursorMetrics,
  type CursorUpdate,
} from "../electron/agent/cursor";

vi.mock("electron", () => ({
  WebContentsView: vi.fn(function () {
    return new FakeView();
  }),
  webContents: { getFocusedWebContents: () => shellContents },
}));
// What holds the keyboard when the overlay's view joins the window.
let shellContents: FakeContents | undefined;

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
  focus = vi.fn();
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
  // Every rect the view was given, so a glide can be read back frame by
  // frame.
  history: (typeof this.bounds)[] = [];
  setBackgroundColor = vi.fn();
  setVisible(value: boolean) {
    this.visible = value;
  }
  setBounds(value: typeof this.bounds) {
    this.bounds = value;
    this.history.push(value);
  }
  getVisible() {
    return this.visible;
  }
  getBounds() {
    return this.bounds;
  }
}

const PAGE = { x: 200, y: 80, width: 1000, height: 700 };

// The clock the overlay glides on, stepped by hand so no test waits.
function clockOf() {
  let at = 1000;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => at,
    schedule(run: () => void, ms: number) {
      const id = next++;
      timers.set(id, { at: at + ms, run });
      return { id, unref() {} };
    },
    cancel(timer: unknown) {
      timers.delete((timer as { id: number }).id);
    },
    pending: () => timers.size,
    // Runs every timer due by then, earliest first, with the clock at its
    // own time, as a real one would.
    advance(ms: number) {
      const until = at + ms;
      for (;;) {
        let due: number | undefined;
        let soonest = Infinity;
        for (const [id, timer] of timers)
          if (timer.at <= until && timer.at < soonest) {
            soonest = timer.at;
            due = id;
          }
        if (due === undefined) break;
        const timer = timers.get(due)!;
        timers.delete(due);
        at = timer.at;
        timer.run();
      }
      at = until;
    },
  };
}
let clock = clockOf();

// Everything the overlay awaits is already resolved, so one turn is enough.
const flush = () => new Promise((resolve) => setImmediate(resolve));
// One turn, then the clock long enough for any glide to end.
const settle = async () => {
  await flush();
  clock.advance(GLIDE.maxMs);
  await flush();
};

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
    now: clock.now,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  const cursor = () => contentView.addChildView.mock.calls[0]?.[0] as FakeView;
  return { contentView, cursor, overlay, page, rules, views };
}

beforeEach(() => {
  clock = clockOf();
  shellContents = undefined;
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

  it("glides scale with distance and reduced motion jumps", async () => {
    const { cursor, overlay } = setup();
    // The first point has nowhere to glide from, so it is placed at once.
    overlay.point("tab-1", { type: "move", x: 100, y: 200 });
    await settle();
    const view = cursor();
    const first = view.getBounds();
    expect(view.getVisible()).toBe(true);

    // 100 px along: 80 ms plus 0.35 ms a pixel, stepped every 16 ms.
    view.history.length = 0;
    overlay.point("tab-1", { type: "move", x: 200, y: 200 });
    await flush();
    expect(view.history[0]).toEqual(first);
    let frames = 0;
    while (clock.pending() > 0 && frames < 40) {
      clock.advance(GLIDE.frameMs);
      frames += 1;
    }
    expect(frames).toBe(
      Math.ceil((GLIDE.baseMs + GLIDE.perPixelMs * 100) / GLIDE.frameMs),
    );
    expect(view.getBounds()).toEqual({ ...first, x: first.x + 100 });
    const along = view.history.map((rect) => rect.x);
    const steps = along.slice(1).map((x, index) => x - along[index]);
    expect(steps[0]).toBeGreaterThan(0);
    // Ease out: each step covers less ground than the one before it, and
    // the cursor never travels backwards.
    expect(steps.slice(1).every((step, index) => step <= steps[index])).toBe(
      true,
    );
    expect(steps.every((step) => step >= 0)).toBe(true);
    expect(steps[0]).toBeGreaterThan(steps.at(-1)!);

    // A move of about a thousand pixels stops at the cap.
    overlay.point("tab-1", { type: "move", x: 20, y: 20 });
    await settle();
    overlay.point("tab-1", { type: "move", x: 980, y: 680 });
    await flush();
    frames = 0;
    while (clock.pending() > 0 && frames < 40) {
      clock.advance(GLIDE.frameMs);
      frames += 1;
    }
    expect(frames).toBe(Math.ceil(GLIDE.maxMs / GLIDE.frameMs));

    // A point part way through a glide becomes the new target from where
    // the cursor stands, never a jump back.
    overlay.point("tab-1", { type: "move", x: 100, y: 200 });
    await settle();
    view.history.length = 0;
    overlay.point("tab-1", { type: "move", x: 400, y: 200 });
    await flush();
    clock.advance(GLIDE.frameMs * 2);
    const midway = view.getBounds().x;
    expect(midway).toBeGreaterThan(PAGE.x + 100 - CURSOR.tip.x);
    overlay.point("tab-1", { type: "move", x: 600, y: 200 });
    await flush();
    expect(view.getBounds().x).toBe(midway);
    frames = 0;
    while (clock.pending() > 0 && frames < 40) {
      clock.advance(GLIDE.frameMs);
      frames += 1;
    }
    expect(view.getBounds().x).toBe(PAGE.x + 600 - CURSOR.tip.x);
    const onward = view.history.map((rect) => rect.x);
    expect(onward.slice(1).every((x, index) => x >= onward[index])).toBe(true);

    // A press plays its ring for 300 ms and then lets it go.
    overlay.point("tab-1", { type: "press", x: 400, y: 200 });
    await settle();
    expect(view.webContents.updates.at(-1)).toMatchObject({ press: true });
    clock.advance(PRESS_RING_MS);
    await flush();
    expect(view.webContents.updates.at(-1)).toEqual({
      label: "",
      press: false,
      flipX: false,
      flipY: false,
    });

    // A page that asks for less motion is given one placement.
    const still = setup();
    still.overlay.point("tab-1", { type: "move", x: 100, y: 200 });
    await settle();
    const jumping = still.cursor();
    jumping.webContents.measure = () => ({
      width: 160,
      height: 54,
      reducedMotion: true,
    });
    jumping.history.length = 0;
    still.overlay.point(
      "tab-1",
      { type: "move", x: 400, y: 260 },
      "Pick a time",
    );
    await settle();
    expect(jumping.history).toEqual([
      {
        x: PAGE.x + 400 - CURSOR.tip.x,
        y: PAGE.y + 260 - CURSOR.tip.y,
        width: 160,
        height: 54,
      },
    ]);
    expect(clock.pending()).toBe(0);
  });

  it("the person's pointer hides it until a later point", async () => {
    const { cursor, overlay, page } = setup();
    const show = async () => {
      overlay.point("tab-1", { type: "move", x: 300, y: 200 });
      await settle();
    };
    await show();
    const view = cursor();
    const touch = (type: string) => {
      const event = { preventDefault: vi.fn() };
      view.webContents.emit("before-mouse-event", event, { type });
      return event;
    };
    for (const type of ["mouseEnter", "mouseMove", "mouseDown"]) {
      await show();
      expect(view.getVisible()).toBe(true);
      expect(touch(type).preventDefault).toHaveBeenCalledTimes(1);
      expect(view.getVisible()).toBe(false);
      clock.advance(PERSON_HIDE_MS);
    }

    // The person's own pointer owns the spot for a second: points there are
    // kept but nothing is drawn.
    await show();
    touch("mouseEnter");
    overlay.point("tab-1", { type: "move", x: 320, y: 220 });
    await settle();
    expect(view.getVisible()).toBe(false);
    clock.advance(PERSON_HIDE_MS);
    overlay.point("tab-1", { type: "move", x: 340, y: 240 });
    await settle();
    expect(view.getVisible()).toBe(true);
    expect(view.getBounds()).toMatchObject({
      x: PAGE.x + 340 - CURSOR.tip.x,
      y: PAGE.y + 240 - CURSOR.tip.y,
    });

    // Scrolling past is not reaching for the cursor.
    expect(touch("mouseWheel").preventDefault).not.toHaveBeenCalled();
    expect(view.getVisible()).toBe(true);

    // A stray click must never leave the person typing into the overlay.
    view.webContents.emit("focus");
    expect(view.getVisible()).toBe(false);
    expect(page.webContents.focus).toHaveBeenCalledTimes(1);
  });

  it("the focus a new view takes as it joins the window keeps its first point and the person's keyboard", async () => {
    // The person is typing in the shell as the agent's first point arrives.
    const shell = new FakeContents();
    shellContents = shell;
    const { cursor, overlay, page } = setup();
    overlay.point("tab-1", { type: "press", x: 300, y: 200 }, "Save the topic");
    // The view is built for this point, and focused, before it has drawn.
    const view = cursor();
    expect(view.getVisible()).toBe(false);
    view.webContents.emit("focus");
    await settle();
    expect(view.getVisible()).toBe(true);
    expect(view.webContents.updates.at(-1)).toMatchObject({
      label: "Save the topic",
    });
    expect(shell.focus).toHaveBeenCalledTimes(1);
    expect(page.webContents.focus).not.toHaveBeenCalled();
    // A focus it gains once the person can see it is theirs reaching for it.
    view.webContents.emit("focus");
    expect(view.getVisible()).toBe(false);
    expect(page.webContents.focus).toHaveBeenCalledTimes(1);
    expect(shell.focus).toHaveBeenCalledTimes(1);
  });
});
