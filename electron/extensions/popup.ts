import { BrowserWindow, screen } from "electron";
import type { WebContents } from "electron";
import { extensionIdOf, type ExtensionAnchor } from "../../shared/extensions";
import type { BrowserState } from "../../shared/types";
import { extensionBridgeCopy } from "../../src/copy";
import type { ExtensionWindowInfo, ExtensionWindowOpener } from "./bridge";
import type { ExtensionHost } from "./host";

// The action popup sizes itself from its page, between these limits.
export const POPUP_SIZE = {
  minWidth: 25,
  maxWidth: 800,
  minHeight: 25,
  maxHeight: 600,
} as const;
// An extension's own windows: their limits, how many each extension gets and
// the size one takes when it asks for none.
export const EXTENSION_WINDOW = {
  minWidth: 200,
  maxWidth: 1600,
  minHeight: 150,
  maxHeight: 1200,
  perExtension: 4,
  width: 500,
  height: 600,
} as const;
// The gap between a button and the popup under it.
const POPUP_GAP = 4;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function logError(context: string, error: unknown): void {
  console.error(`${context}:`, messageOf(error));
}
function safely<T>(run: () => T, fallback: T): T {
  try {
    return run();
  } catch {
    return fallback;
  }
}
function clamp(value: number, least: number, most: number): number {
  return Math.max(least, Math.min(Math.round(value), most));
}
// Keeps a span of that size inside a work area's edge.
function fit(at: number, size: number, start: number, span: number): number {
  return Math.max(start, Math.min(Math.round(at), start + span - size));
}
function isWeb(url: string): boolean {
  const protocol = safely(() => new URL(url).protocol, "");
  return protocol === "http:" || protocol === "https:";
}

// The popup hangs under its button, right aligned with it, and stays on the
// button's display.
export function popupBounds(
  anchor: ExtensionAnchor,
  size: { width: number; height: number },
  content: Rect,
  workArea: Rect,
): Rect {
  const width = clamp(size.width, POPUP_SIZE.minWidth, POPUP_SIZE.maxWidth);
  const height = clamp(size.height, POPUP_SIZE.minHeight, POPUP_SIZE.maxHeight);
  return {
    x: fit(
      content.x + anchor.x + anchor.width - width,
      width,
      workArea.x,
      workArea.width,
    ),
    y: fit(
      content.y + anchor.y + anchor.height + POPUP_GAP,
      height,
      workArea.y,
      workArea.height,
    ),
    width,
    height,
  };
}

// An extension window takes the size it asks for within the limits, and the
// place it asks for when that point is on a display the person can see.
export function extensionWindowBounds(
  request: { left?: number; top?: number; width?: number; height?: number },
  workAreas: readonly Rect[],
  fallback: Rect,
): Rect {
  const width = clamp(
    request.width ?? EXTENSION_WINDOW.width,
    EXTENSION_WINDOW.minWidth,
    EXTENSION_WINDOW.maxWidth,
  );
  const height = clamp(
    request.height ?? EXTENSION_WINDOW.height,
    EXTENSION_WINDOW.minHeight,
    EXTENSION_WINDOW.maxHeight,
  );
  const left =
    request.left === undefined ? undefined : Math.round(request.left);
  const top = request.top === undefined ? undefined : Math.round(request.top);
  const seen =
    left !== undefined &&
    top !== undefined &&
    workAreas.some(
      (area) =>
        left >= area.x &&
        left < area.x + area.width &&
        top >= area.y &&
        top < area.y + area.height,
    );
  if (seen) return { x: left, y: top, width, height };
  return {
    x: fallback.x + Math.round((fallback.width - width) / 2),
    y: fallback.y + Math.round((fallback.height - height) / 2),
    width,
    height,
  };
}

export interface PopupDeps {
  host: ExtensionHost;
  window(): BrowserWindow | null;
  openLink(
    url: string,
    from: { extensionId: string; partition: string; spaceId?: string },
  ): void;
  screen?: Pick<Electron.Screen, "getAllDisplays" | "getDisplayMatching">;
  createWindow?: (
    options: Electron.BrowserWindowConstructorOptions,
  ) => BrowserWindow;
}

interface OpenPopup {
  window: BrowserWindow;
  extensionId: string;
  partition: string;
  spaceId: string;
  anchor: ExtensionAnchor;
  shown: boolean;
  // The shown space and tab when it opened; a switch closes it.
  seen?: { spaceId: string; tabId: string };
}
interface OpenWindow {
  window: BrowserWindow;
  windowId: number;
  tabId: number;
  extensionId: string;
  partition: string;
  url: string;
}

// The windows extensions draw in: one action popup at a time, under the
// button the person clicked, and an extension's own windows holding its
// pages. Both live in their extension's session and open web links as tabs.
export class ExtensionPopups implements ExtensionWindowOpener {
  private readonly deps: PopupDeps;
  private readonly offHost: () => void;
  private readonly windows = new Map<number, OpenWindow>();
  private popup?: OpenPopup;
  private seen?: { spaceId: string; tabId: string };

  constructor(deps: PopupDeps) {
    this.deps = deps;
    this.offHost = deps.host.onEvent((event) => {
      if (event.type === "unloaded")
        this.closeExtension(event.id, event.partition);
      if (event.type === "detached") this.closeSession(event.partition);
    });
  }

  // The person clicked a button: the same one again closes the popup.
  togglePopup(request: {
    extensionId: string;
    partition: string;
    spaceId: string;
    url: string;
    anchor: ExtensionAnchor;
  }): void {
    const shown = this.popup;
    this.closePopup();
    if (
      shown &&
      shown.extensionId === request.extensionId &&
      shown.partition === request.partition
    )
      return;
    const main = this.deps.window();
    const ses = this.deps.host.sessionOf(request.partition);
    if (!main || main.isDestroyed() || !ses) return;
    const window = this.create({
      parent: main,
      frame: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      width: POPUP_SIZE.minWidth,
      height: POPUP_SIZE.minHeight,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        enablePreferredSizeMode: true,
        spellcheck: false,
      },
    });
    const open: OpenPopup = {
      window,
      extensionId: request.extensionId,
      partition: request.partition,
      spaceId: request.spaceId,
      anchor: request.anchor,
      shown: false,
      seen: this.seen,
    };
    this.popup = open;
    this.deps.host.addSurface(window.webContents, {
      kind: "popup",
      extensionId: request.extensionId,
      partition: request.partition,
      spaceId: request.spaceId,
    });
    const offMain = this.whenMainCloses(main, () => this.closePopup());
    window.webContents.on("preferred-size-changed", (_event, size) => {
      if (this.popup !== open || window.isDestroyed()) return;
      window.setBounds(
        popupBounds(
          open.anchor,
          size,
          safely(() => main.getContentBounds(), this.workArea(main)),
          this.workArea(main),
        ),
      );
      if (open.shown) return;
      open.shown = true;
      window.show();
    });
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.key !== "Escape") return;
      event.preventDefault();
      this.closePopup();
    });
    window.on("blur", () => {
      if (this.popup === open) this.closePopup();
    });
    window.once("closed", () => {
      offMain();
      if (this.popup === open) this.popup = undefined;
    });
    this.follow(window.webContents, {
      extensionId: request.extensionId,
      partition: request.partition,
      spaceId: request.spaceId,
    });
    void Promise.resolve(window.webContents.loadURL(request.url)).catch(
      (error) =>
        logError(`The popup of ${request.extensionId} could not load`, error),
    );
  }

  closePopup(): void {
    const open = this.popup;
    if (!open) return;
    this.popup = undefined;
    if (!open.window.isDestroyed()) open.window.close();
  }

  shownPopup(): { extensionId: string } | undefined {
    return this.popup ? { extensionId: this.popup.extensionId } : undefined;
  }

  openWindow(request: {
    windowId: number;
    extensionId: string;
    partition: string;
    url: string;
    left?: number;
    top?: number;
    width?: number;
    height?: number;
    focused: boolean;
  }): ExtensionWindowInfo {
    if (
      this.windowsOf(request.extensionId, request.partition).length >=
      EXTENSION_WINDOW.perExtension
    )
      throw new Error(extensionBridgeCopy.tooManyWindows);
    const ses = this.deps.host.sessionOf(request.partition);
    if (!ses) throw new Error(extensionBridgeCopy.failed);
    const main = this.deps.window();
    const window = this.create({
      ...extensionWindowBounds(request, this.workAreas(), this.fallback(main)),
      show: request.focused !== false,
      autoHideMenuBar: true,
      title: this.deps.host.nameOf(request.extensionId) ?? "Kamapathy",
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    const open: OpenWindow = {
      window,
      windowId: request.windowId,
      tabId: window.webContents.id,
      extensionId: request.extensionId,
      partition: request.partition,
      url: request.url,
    };
    this.windows.set(open.windowId, open);
    this.deps.host.addSurface(window.webContents, {
      kind: "window",
      extensionId: request.extensionId,
      partition: request.partition,
      windowId: request.windowId,
    });
    const offMain = this.whenMainCloses(main, () =>
      this.closeWindow(open.windowId),
    );
    window.once("closed", () => {
      offMain();
      this.windows.delete(open.windowId);
    });
    this.follow(window.webContents, {
      extensionId: request.extensionId,
      partition: request.partition,
    });
    if (request.focused !== false) window.focus();
    void Promise.resolve(window.webContents.loadURL(request.url)).catch(
      (error) =>
        logError(`A window of ${request.extensionId} could not load`, error),
    );
    return this.infoOf(open);
  }

  updateWindow(
    windowId: number,
    changes: {
      left?: number;
      top?: number;
      width?: number;
      height?: number;
      focused?: boolean;
    },
  ): ExtensionWindowInfo {
    const open = this.windows.get(windowId);
    if (!open) throw new Error(extensionBridgeCopy.noWindow(windowId));
    const now = this.infoOf(open).bounds;
    open.window.setBounds(
      extensionWindowBounds(
        {
          left: changes.left ?? now.left,
          top: changes.top ?? now.top,
          width: changes.width ?? now.width,
          height: changes.height ?? now.height,
        },
        this.workAreas(),
        this.fallback(this.deps.window()),
      ),
    );
    if (changes.focused === true) {
      open.window.show();
      open.window.focus();
    }
    return this.infoOf(open);
  }

  closeWindow(windowId: number): boolean {
    const open = this.windows.get(windowId);
    if (!open) return false;
    this.windows.delete(windowId);
    if (!open.window.isDestroyed()) open.window.close();
    return true;
  }

  windowsOf(extensionId: string, partition: string): ExtensionWindowInfo[] {
    return [...this.windows.values()]
      .filter(
        (open) =>
          open.extensionId === extensionId && open.partition === partition,
      )
      .map((open) => this.infoOf(open));
  }

  closeExtension(extensionId: string, partition?: string): void {
    const mine = (open: { extensionId: string; partition: string }) =>
      open.extensionId === extensionId &&
      (partition === undefined || open.partition === partition);
    if (this.popup && mine(this.popup)) this.closePopup();
    for (const open of [...this.windows.values()])
      if (mine(open)) this.closeWindow(open.windowId);
  }

  // The popup belongs to the tab and space the person clicked in.
  onState(state: BrowserState): void {
    const next = { spaceId: state.activeSpaceId, tabId: state.activeTabId };
    this.seen = next;
    const open = this.popup;
    if (!open) return;
    if (!open.seen) {
      open.seen = next;
      return;
    }
    if (open.seen.spaceId !== next.spaceId || open.seen.tabId !== next.tabId)
      this.closePopup();
  }

  dispose(): void {
    this.offHost();
    this.closePopup();
    for (const open of [...this.windows.values()])
      this.closeWindow(open.windowId);
  }

  private closeSession(partition: string): void {
    if (this.popup?.partition === partition) this.closePopup();
    for (const open of [...this.windows.values()])
      if (open.partition === partition) this.closeWindow(open.windowId);
  }

  private create(
    options: Electron.BrowserWindowConstructorOptions,
  ): BrowserWindow {
    return this.deps.createWindow
      ? this.deps.createWindow(options)
      : new BrowserWindow(options);
  }

  // Extension pages open the web as tabs in a space of the person's, and
  // never navigate away from their own origin.
  private follow(
    contents: WebContents,
    from: { extensionId: string; partition: string; spaceId?: string },
  ): void {
    contents.setWindowOpenHandler((details) => {
      this.openLink(details.url, from);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (extensionIdOf(url) === from.extensionId) return;
      event.preventDefault();
      this.openLink(url, from);
    });
  }

  private openLink(
    url: string,
    from: { extensionId: string; partition: string; spaceId?: string },
  ): void {
    if (!isWeb(url)) return;
    try {
      this.deps.openLink(url, from);
    } catch (error) {
      logError(`${from.extensionId} could not open a tab`, error);
    }
  }

  private infoOf(open: OpenWindow): ExtensionWindowInfo {
    const bounds = safely(() => open.window.getBounds(), {
      x: 0,
      y: 0,
      width: EXTENSION_WINDOW.width,
      height: EXTENSION_WINDOW.height,
    });
    return {
      windowId: open.windowId,
      tabId: open.tabId,
      extensionId: open.extensionId,
      partition: open.partition,
      url: open.url,
      focused: safely(() => open.window.isFocused(), false),
      bounds: {
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
      },
    };
  }

  private whenMainCloses(
    main: BrowserWindow | null,
    run: () => void,
  ): () => void {
    if (!main) return () => {};
    const listener = () => run();
    main.once("closed", listener);
    return () => main.removeListener("closed", listener);
  }

  private workAreas(): Rect[] {
    return safely(() => (this.deps.screen ?? screen).getAllDisplays(), []).map(
      (display) => display.workArea,
    );
  }

  private workArea(main: BrowserWindow): Rect {
    const display = safely(
      () => (this.deps.screen ?? screen).getDisplayMatching(main.getBounds()),
      undefined,
    );
    return (
      display?.workArea ??
      this.workAreas()[0] ?? {
        x: 0,
        y: 0,
        width: EXTENSION_WINDOW.maxWidth,
        height: EXTENSION_WINDOW.maxHeight,
      }
    );
  }

  private fallback(main: BrowserWindow | null): Rect {
    return main && !main.isDestroyed()
      ? this.workArea(main)
      : (this.workAreas()[0] ?? {
          x: 0,
          y: 0,
          width: EXTENSION_WINDOW.maxWidth,
          height: EXTENSION_WINDOW.maxHeight,
        });
  }
}
