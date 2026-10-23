import { Notification } from "electron";
import type { BrowserWindow } from "electron";
import { agentRules } from "../shared/state";
import type { AgentPaths } from "./agent-socket";
import type { BrowserController } from "./controller";

// What the person is told the first time Kamapathy keeps running without a
// window, once per profile. Each platform names the way to stop it.
export const BACKGROUND_NOTICE = {
  title: "Kamapathy is still running",
  body: "Agents can keep working while the window is closed. Quit from the tray icon to stop them.",
  darwin:
    "Agents can keep working while the window is closed. Quit from the Dock to stop them.",
  linux:
    "Agents can keep working while the window is closed. Quit from the tray icon to stop them, or open Kamapathy again.",
} as const;

export interface BackgroundHost {
  window(): BrowserWindow | null;
  controller(): BrowserController | null;
  /** True while the agent service is listening. */
  serviceRunning(): boolean;
  /** True once a quit has been accepted. */
  quitting(): boolean;
  /** Creates or shows the window. */
  show(): void;
  agent: AgentPaths;
}

// Kamapathy without a window: closing hides it while agents can still work,
// and the person is told once how to stop them.
export class BackgroundService {
  private readonly platform: NodeJS.Platform;
  private isHidden = false;
  private shutdown = false;
  private disposed = false;

  constructor(
    private readonly host: BackgroundHost,
    options: {
      platform?: NodeJS.Platform;
      resources?: string;
      now?(): number;
    } = {},
  ) {
    this.platform = options.platform ?? process.platform;
  }

  /** Whether this close must hide the window instead of closing it. */
  hidesOnClose(): boolean {
    const window = this.host.window();
    const controller = this.host.controller();
    if (
      this.disposed ||
      this.shutdown ||
      this.host.quitting() ||
      !window ||
      window.isDestroyed() ||
      !controller ||
      !controller.state.settings.automationEnabled ||
      !this.host.serviceRunning()
    )
      return false;
    // macOS applications run without a window. Elsewhere the window is the
    // way back, so Kamapathy stays only while an agent has somewhere to
    // work: a space whose access ended holds nothing open.
    if (this.platform === "darwin") return true;
    return controller.state.spaces.some(
      (space) => agentRules(space) && space.access !== "ended",
    );
  }

  /** Hides the window, closes the person's pages and tells them once. */
  enterBackground(): void {
    const window = this.host.window();
    const controller = this.host.controller();
    if (!window || window.isDestroyed() || !controller) return;
    window.hide();
    this.isHidden = true;
    // A probe confirmed pages in a hidden window keep loading, keep their
    // timers and answer isolated-world calls. Where a platform stops them,
    // minimize with setSkipTaskbar(true) instead; where that stops them
    // too, keep the old close there and rely on the quit question.
    controller.enterBackground();
    this.notice(controller);
    this.update();
  }

  /** The window is back. */
  leaveBackground(): void {
    this.isHidden = false;
    const window = this.host.window();
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.show();
    }
    this.host.controller()?.leaveBackground();
    this.update();
  }

  hidden(): boolean {
    return this.isHidden;
  }

  /** The system is shutting down: never hide, never ask. */
  shuttingDown(): void {
    this.shutdown = true;
  }

  /** What the background shows follows the state through here. */
  update(): void {}

  dispose(): void {
    this.disposed = true;
  }

  private notice(controller: BrowserController): void {
    if (controller.state.settings.backgroundNoticeShown) return;
    const body =
      this.platform === "darwin"
        ? BACKGROUND_NOTICE.darwin
        : this.platform === "linux"
          ? BACKGROUND_NOTICE.linux
          : BACKGROUND_NOTICE.body;
    // Notifications work for this unsigned development build, as a probe
    // confirmed; where they do not, the same words become one activity entry.
    if (Notification.isSupported())
      new Notification({ title: BACKGROUND_NOTICE.title, body }).show();
    else
      controller.addActivity(
        undefined,
        `${BACKGROUND_NOTICE.title}. ${body}`,
        "info",
      );
    void controller.dispatch({
      type: "settings:update",
      settings: { backgroundNoticeShown: true },
    });
  }
}
