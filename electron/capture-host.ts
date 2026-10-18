import { BaseWindow } from "electron";
import type { BrowserWindow, WebContentsView } from "electron";

// Chromium answers a surface capture right away only for a view it paints.
// A view the window hides, which is every tab but the shown one, takes
// seconds, answers with an older frame or never answers at all, so it is
// lent to this window for the capture: never shown, never focused, and at
// the main window's size and place so the page's own measurements and the
// display scale do not change. It is a BaseWindow, so
// BrowserWindow.getAllWindows() keeps returning only the main window.
export class CaptureHost {
  private window?: BaseWindow;
  private lent = new Set<WebContentsView>();

  constructor(private readonly main: BrowserWindow) {}

  // A view this window holds for a capture. The layout leaves it alone.
  lends(view: WebContentsView): boolean {
    return this.lent.has(view);
  }

  // Runs the capture with the view in this window, then puts it back where
  // it was, as long as keep() says its tab still wants it.
  async present<T>(
    view: WebContentsView,
    capture: () => Promise<T>,
    keep: () => boolean,
  ): Promise<T> {
    const host = this.ensure();
    host.setBounds(this.main.getBounds());
    const bounds = view.getBounds();
    const [width, height] = host.getContentSize();
    // A tab that was never shown keeps the size it was made with, which may
    // be larger than the window the person has now.
    if (bounds.x + bounds.width > width || bounds.y + bounds.height > height)
      host.setContentSize(
        Math.max(width, bounds.x + bounds.width),
        Math.max(height, bounds.y + bounds.height),
      );
    const index = this.main.contentView.children.indexOf(view);
    this.lent.add(view);
    this.main.contentView.removeChildView(view);
    host.contentView.addChildView(view);
    view.setVisible(true);
    try {
      return await capture();
    } finally {
      this.lent.delete(view);
      view.setVisible(false);
      this.remove(view);
      if (keep() && !this.main.isDestroyed()) {
        const { children } = this.main.contentView;
        this.main.contentView.addChildView(
          view,
          index < 0 ? children.length : Math.min(index, children.length),
        );
      }
    }
  }

  // Takes a view out of this window without putting it back, for a tab that
  // closed while its capture ran.
  remove(view: WebContentsView): void {
    if (this.window && !this.window.isDestroyed())
      this.window.contentView.removeChildView(view);
  }

  // Closing this window lets window-all-closed fire on Windows and Linux.
  dispose(): void {
    this.lent.clear();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = undefined;
  }

  private ensure(): BaseWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const mac = process.platform === "darwin";
    this.window = new BaseWindow({
      show: false,
      skipTaskbar: true,
      frame: mac,
      titleBarStyle: mac ? "hiddenInset" : "hidden",
      ...this.main.getBounds(),
    });
    return this.window;
  }
}
