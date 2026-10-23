import { WebContentsView } from "electron";
import type { BrowserWindow, Rectangle, WebContents } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The view the cursor is drawn in, where its tip sits inside it, and the
// label pill beside the tip. src/cursor/cursor.css draws to the same numbers.
export const CURSOR = {
  size: 44,
  tip: { x: 14, y: 14 },
  pill: { x: 30, y: 30, height: 24, maxWidth: 240 },
} as const;

// How the cursor travels to a new point. A probe asked for 16 ms frames and
// got 17 to 22 ms, so each frame is placed from the clock, not its number.
export const GLIDE = {
  baseMs: 80,
  perPixelMs: 0.35,
  maxMs: 220,
  frameMs: 16,
} as const;
/** How long a press plays its ring at the tip. */
export const PRESS_RING_MS = 300;
/** How long the person's own pointer keeps the cursor away. */
export const PERSON_HIDE_MS = 1000;

export interface CursorPoint {
  type: "move" | "press" | "release";
  x: number;
  y: number;
}
/** What the page is asked to draw. */
export interface CursorUpdate {
  label: string;
  press: boolean;
  flipX: boolean;
  flipY: boolean;
}
/** What it measures out to. */
export interface CursorMetrics {
  width: number;
  height: number;
  reducedMotion: boolean;
}
export interface CursorHost {
  window: BrowserWindow;
  /** The page view of this tab, or nothing. */
  view(tabId: string): WebContentsView | undefined;
  /** False whenever no cursor may show for this tab. */
  shows(tabId: string): boolean;
}

/** Where the cursor page lives: a dev server URL or a packaged file. */
export function cursorPage(): { url?: string; file?: string } {
  const development =
    process.defaultApp === true ? process.env.ELECTRON_RENDERER_URL : undefined;
  if (development) return { url: `${development}/src/cursor/index.html` };
  return {
    file: join(
      dirname(fileURLToPath(import.meta.url)),
      "../renderer/src/cursor/index.html",
    ),
  };
}

// The point an agent last acted on, with the page view it belongs to as it
// was then.
interface Recorded {
  tabId: string;
  point: CursorPoint;
  label: string;
  bounds: Rectangle;
  zoom: number;
}
interface Placement {
  rect: Rectangle;
  flipX: boolean;
  flipY: boolean;
}
interface Timer {
  unref?(): void;
}
interface CursorOptions {
  page?: { url?: string; file?: string };
  now?(): number;
  schedule?(run: () => void, ms: number): Timer;
  cancel?(timer: unknown): void;
}
// The arrow on its own, until the page reports what a label measures.
const BARE: CursorMetrics = {
  width: CURSOR.size,
  height: CURSOR.size,
  reducedMotion: false,
};
// A run can use many labels; the cache only saves the page a measurement.
const SIZES = 32;

const clamp = (value: number, least: number, most: number) =>
  Math.max(least, Math.min(most, value));
const sameRect = (one: Rectangle, two: Rectangle) =>
  one.x === two.x &&
  one.y === two.y &&
  one.width === two.width &&
  one.height === two.height;

// The tip lands on the point: the page view's origin plus the point in CSS
// pixels times the page's zoom factor, which a probe confirmed holds at 1
// and 1.25 on a 2x display. The pill turns to whichever side of the tip
// keeps it inside the page, and the whole view is kept inside the page
// view's rect, so it can never cover the toolbar, the tabs or the agent bar.
function place(recorded: Recorded, size: CursorMetrics): Placement {
  const { bounds, point, zoom } = recorded;
  const width = clamp(
    Math.ceil(size.width),
    CURSOR.size,
    CURSOR.pill.x + CURSOR.pill.maxWidth,
  );
  const height = clamp(
    Math.ceil(size.height),
    CURSOR.size,
    CURSOR.pill.y + CURSOR.pill.height,
  );
  const tipX = bounds.x + point.x * zoom;
  const tipY = bounds.y + point.y * zoom;
  const flipX = tipX - CURSOR.tip.x + width > bounds.x + bounds.width;
  const flipY = tipY - CURSOR.tip.y + height > bounds.y + bounds.height;
  const x = flipX ? tipX + CURSOR.tip.x - width : tipX - CURSOR.tip.x;
  const y = flipY ? tipY + CURSOR.tip.y - height : tipY - CURSOR.tip.y;
  return {
    rect: {
      x: Math.round(clamp(x, bounds.x, bounds.x + bounds.width - width)),
      y: Math.round(clamp(y, bounds.y, bounds.y + bounds.height - height)),
      width,
      height,
    },
    flipX,
    flipY,
  };
}

// A glide stays inside the page view its point was taken in, as the
// placement does, so no frame of it can reach the toolbar or the agent bar.
function within(
  bounds: Rectangle,
  rect: Rectangle,
  at: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: Math.round(clamp(at.x, bounds.x, bounds.x + bounds.width - rect.width)),
    y: Math.round(
      clamp(at.y, bounds.y, bounds.y + bounds.height - rect.height),
    ),
  };
}

function zoomOf(view: WebContentsView): number {
  const zoom = view.webContents.getZoomFactor();
  // A page that reports nothing is drawn as it was written.
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

// The agent's cursor over the page it is working in: one transparent view
// per window, above every page view, placed from the points the agent's
// input dispatcher reports. Nothing here may cost an action its result, so
// every step is inside a try and a failure hides the cursor.
export class CursorOverlay {
  private view?: WebContentsView;
  private loaded?: Promise<void>;
  private recorded?: Recorded;
  private applying?: Promise<void>;
  private again = false;
  private sizes = new Map<string, CursorMetrics>();
  private closed = false;
  // Where the cursor stands, so the next point glides from there.
  private drawn?: { x: number; y: number };
  private frame?: Timer;
  private ringTimer?: Timer;
  // When the person's own pointer last touched the cursor.
  private person = -Infinity;
  // The tab of the last point, kept past a hide so a stray focus can be
  // handed back to the page below.
  private lastTab?: string;
  private now: () => number;
  private start: (run: () => void, ms: number) => Timer;
  private stop: (timer: Timer) => void;

  constructor(
    private host: CursorHost,
    private options: CursorOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.start =
      options.schedule ??
      ((run, ms) => {
        const timer = setTimeout(run, ms) as unknown as Timer;
        // A cursor in flight never holds the process open.
        timer.unref?.();
        return timer;
      });
    this.stop =
      options.cancel ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
  }

  /** A point an agent just dispatched, with the space's active label. Never throws. */
  point(tabId: string, point: CursorPoint, label = ""): void {
    if (this.closed) return;
    try {
      const view = this.host.shows(tabId) ? this.host.view(tabId) : undefined;
      if (!view) {
        this.hide();
        return;
      }
      this.recorded = {
        tabId,
        point,
        label,
        bounds: view.getBounds(),
        zoom: zoomOf(view),
      };
      this.lastTab = tabId;
      // The person's own pointer owns the spot for a second: the point is
      // kept, so one that comes after that draws, but nothing is drawn now.
      if (this.now() - this.person < PERSON_HIDE_MS) return;
      this.schedule();
    } catch {
      // A page or a window that went away draws nothing.
      this.hide();
    }
  }

  /** Hides the cursor and forgets its point. */
  hide(): void {
    this.recorded = undefined;
    this.drawn = undefined;
    this.stopGlide();
    this.stopRing();
    try {
      this.view?.setVisible(false);
    } catch {
      // A view that is already gone needs no hiding.
    }
  }

  /** Keeps the overlay above every page view. */
  raise(): void {
    const view = this.view;
    if (!view) return;
    try {
      if (!this.host.window.isDestroyed())
        this.host.window.contentView.addChildView(view);
    } catch {
      // A window that is closing has no children to order.
    }
  }

  /** Re-checks the rules; called from layout(). */
  refresh(): void {
    const recorded = this.recorded;
    if (!recorded) return;
    try {
      // The cursor keeps the place it had at its point, so a page view that
      // moved or resized since takes it away until the next point.
      const bounds = this.host.shows(recorded.tabId)
        ? this.host.view(recorded.tabId)?.getBounds()
        : undefined;
      if (!bounds || !sameRect(bounds, recorded.bounds)) this.hide();
    } catch {
      this.hide();
    }
  }

  dispose(): void {
    this.closed = true;
    this.recorded = undefined;
    this.drawn = undefined;
    this.stopGlide();
    this.stopRing();
    const view = this.view;
    this.view = undefined;
    if (!view) return;
    try {
      if (!this.host.window.isDestroyed())
        this.host.window.contentView.removeChildView(view);
    } catch {
      // The window took its children with it.
    }
    const contents = view.webContents as WebContents | undefined;
    try {
      if (contents && !contents.isDestroyed())
        contents.close({ waitForBeforeUnload: false });
    } catch {
      // Already gone.
    }
  }

  // One placement at a time, with the latest point winning: points arrive
  // from input and must never wait for the page.
  private schedule(): void {
    if (this.applying) {
      this.again = true;
      return;
    }
    this.applying = this.drain().finally(() => {
      this.applying = undefined;
    });
  }

  private async drain(): Promise<void> {
    do {
      this.again = false;
      try {
        await this.apply();
      } catch {
        this.hide();
      }
    } while (this.again && this.recorded);
  }

  private async apply(): Promise<void> {
    const recorded = this.recorded;
    if (!recorded) return;
    const view = this.ensureView();
    if (!view) return;
    await this.loaded;
    const press = recorded.point.type === "press";
    const known = this.sizes.get(recorded.label);
    let metrics = known ?? BARE;
    let placement = place(recorded, metrics);
    const update = {
      label: recorded.label,
      press,
      flipX: placement.flipX,
      flipY: placement.flipY,
    };
    if (known) this.send(view, update).catch(() => this.hide());
    else {
      // The page lays a label out once and reports its size; every later
      // point with the same text is placed without waiting for it.
      const size = await this.send(view, update);
      if (this.recorded !== recorded || this.closed) return;
      if (this.sizes.size >= SIZES) this.sizes.clear();
      this.sizes.set(recorded.label, size);
      metrics = size;
      const measured = place(recorded, size);
      // The pill may have to turn once its real width is known.
      if (
        measured.flipX !== placement.flipX ||
        measured.flipY !== placement.flipY
      )
        this.send(view, {
          ...update,
          flipX: measured.flipX,
          flipY: measured.flipY,
        }).catch(() => this.hide());
      placement = measured;
    }
    if (this.recorded !== recorded || this.closed) return;
    if (!this.host.shows(recorded.tabId)) {
      this.hide();
      return;
    }
    this.glide(view, placement.rect, recorded.bounds, metrics.reducedMotion);
    if (press)
      this.playRing(view, recorded, {
        ...update,
        flipX: placement.flipX,
        flipY: placement.flipY,
      });
    else this.stopRing();
  }

  // The cursor glides to its point over a time that grows with the distance,
  // so the person can follow where it went; a page that asks for less motion
  // is placed once instead.
  private glide(
    view: WebContentsView,
    rect: Rectangle,
    bounds: Rectangle,
    jump: boolean,
  ): void {
    this.stopGlide();
    const from = this.drawn;
    const distance = from ? Math.hypot(rect.x - from.x, rect.y - from.y) : 0;
    if (!from || jump || distance < 1) {
      this.draw(view, rect);
      return;
    }
    const duration = Math.min(
      GLIDE.maxMs,
      GLIDE.baseMs + GLIDE.perPixelMs * distance,
    );
    const started = this.now();
    const step = () => {
      this.frame = undefined;
      try {
        const part = clamp((this.now() - started) / duration, 0, 1);
        if (part >= 1) {
          this.draw(view, rect);
          return;
        }
        // Ease out, so the cursor slows into the point it is naming.
        const eased = 1 - (1 - part) ** 3;
        this.draw(view, {
          ...rect,
          ...within(bounds, rect, {
            x: from.x + (rect.x - from.x) * eased,
            y: from.y + (rect.y - from.y) * eased,
          }),
        });
        this.frame = this.start(step, GLIDE.frameMs);
      } catch {
        // A view that went away mid-glide draws nothing more.
        this.hide();
      }
    };
    // The label the cursor is carrying is shown at once, and travels with it.
    this.draw(view, { ...rect, ...within(bounds, rect, from) });
    this.frame = this.start(step, GLIDE.frameMs);
  }

  private draw(view: WebContentsView, rect: Rectangle): void {
    view.setBounds(rect);
    this.drawn = { x: rect.x, y: rect.y };
    view.setVisible(true);
  }

  // The page animates the ring for its own time; the flag is taken back
  // after it, so the next press plays it again.
  private playRing(
    view: WebContentsView,
    recorded: Recorded,
    update: CursorUpdate,
  ): void {
    this.stopRing();
    this.ringTimer = this.start(() => {
      this.ringTimer = undefined;
      if (this.recorded !== recorded || this.closed) return;
      this.send(view, { ...update, press: false }).catch(() => this.hide());
    }, PRESS_RING_MS);
  }

  private stopGlide(): void {
    const frame = this.frame;
    this.frame = undefined;
    if (frame) this.stop(frame);
  }

  private stopRing(): void {
    const ring = this.ringTimer;
    this.ringTimer = undefined;
    if (ring) this.stop(ring);
  }

  private async send(
    view: WebContentsView,
    update: CursorUpdate,
  ): Promise<CursorMetrics> {
    const metrics = (await view.webContents.executeJavaScript(
      `window.kamapathyCursor(${JSON.stringify(update)})`,
    )) as Partial<CursorMetrics> | undefined;
    return {
      width: Number(metrics?.width) || CURSOR.size,
      height: Number(metrics?.height) || CURSOR.size,
      reducedMotion: metrics?.reducedMotion === true,
    };
  }

  // Built on the first point, so a window no agent draws in never has one.
  private ensureView(): WebContentsView | undefined {
    if (this.view) return this.view;
    if (this.closed || this.host.window.isDestroyed()) return undefined;
    const view = new WebContentsView({
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    const contents = view.webContents;
    // Nothing but the file it loads can ever run in this view.
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event) => event.preventDefault());
    // The person's own pointer wins: reaching the cursor takes it away for
    // a second, and a stray click never leaves them typing into it.
    contents.on("before-mouse-event", (event, mouse) => {
      if (
        mouse.type !== "mouseEnter" &&
        mouse.type !== "mouseMove" &&
        mouse.type !== "mouseDown"
      )
        return;
      event.preventDefault();
      this.person = this.now();
      this.hide();
    });
    contents.on("focus", () => {
      const tabId = this.recorded?.tabId ?? this.lastTab;
      this.hide();
      try {
        if (tabId) this.host.view(tabId)?.webContents.focus();
      } catch {
        // A page that went away keeps no focus.
      }
    });
    const page = this.options.page ?? cursorPage();
    this.loaded = (
      page.url ? contents.loadURL(page.url) : contents.loadFile(page.file ?? "")
    ).then(
      () => undefined,
      // A page that did not load answers nothing, which hides the cursor.
      () => undefined,
    );
    this.view = view;
    this.host.window.contentView.addChildView(view);
    return view;
  }
}
