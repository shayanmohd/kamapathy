import { app, dialog, Menu, nativeImage, Notification, Tray } from "electron";
import type { BrowserWindow, MenuItemConstructorOptions } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_TEXT_LIMITS, cleanAgentText } from "../shared/agent-text";
import { agentRules } from "../shared/state";
import { agentBarCopy, statusCopy } from "../src/copy";
import { agentStatus, statusLine, type AgentStatus } from "../src/lib/spaces";
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

// What the tray and the Dock menus say. The state words come from the same
// copy the window shows, so the two can never disagree.
export const TRAY_COPY = {
  open: "Open Kamapathy",
  quit: "Quit Kamapathy",
  stopAll: "Stop all agents",
  working: (count: number) =>
    `${count} ${count === 1 ? "agent" : "agents"} working`,
  needsYou: "An agent needs you",
  failed: "An agent could not finish",
} as const;

// How often the menus, the tooltip and the icon are rebuilt, and how many
// spaces the menus list.
const MENU_INTERVAL_MS = 500;
const MENU_SPACES = 10;
// The states that count as an agent at work, as the Spaces button counts them.
const WORKING: readonly AgentStatus[] = ["browsing", "idle", "error"];
// Nothing is marked seen out here: the person is not at the window.
const SEEN_NOTHING: ReadonlySet<string> = new Set<string>();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

function quoted(text: string): string {
  return `\u201c${text}\u201d`;
}

export interface BackgroundSpace {
  id: string;
  name: string;
  status: AgentStatus;
  /** Needs the person or could not finish. */
  attention: boolean;
}

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
  private readonly resources?: string;
  private readonly now: () => number;
  private isHidden = false;
  private shutdown = false;
  private disposed = false;
  private tray: Tray | null = null;
  private trayAttention = false;
  private rebuiltAt = 0;
  private rebuiltHidden = false;
  private rebuilding: ReturnType<typeof setTimeout> | null = null;
  // The last state each space was announced in, so one change speaks once.
  private readonly announced = new Map<string, AgentStatus>();

  constructor(
    private readonly host: BackgroundHost,
    options: {
      platform?: NodeJS.Platform;
      resources?: string;
      now?(): number;
    } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.resources = options.resources;
    this.now = options.now ?? Date.now;
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

  /** The spaces the menus list, newest first, at most 10. */
  agentSpaces(): BackgroundSpace[] {
    return this.collect().slice(0, MENU_SPACES);
  }

  /** What the background shows follows the state through here. */
  update(): void {
    if (this.disposed) return;
    const wait = this.rebuiltAt + MENU_INTERVAL_MS - this.now();
    // The window coming or going is never made to wait; state changes are.
    if (wait > 0 && this.isHidden === this.rebuiltHidden) {
      // A burst of changes rebuilds once, on the last of them.
      if (!this.rebuilding)
        this.rebuilding = setTimeout(() => {
          this.rebuilding = null;
          this.rebuild();
        }, wait);
      return;
    }
    this.rebuild();
  }

  dispose(): void {
    this.disposed = true;
    if (this.rebuilding) {
      clearTimeout(this.rebuilding);
      this.rebuilding = null;
    }
    this.dropTray();
  }

  private collect(): BackgroundSpace[] {
    const controller = this.host.controller();
    if (!controller) return [];
    const state = controller.state;
    const now = this.now();
    return state.spaces
      .map((space, index) => ({ space, index }))
      .sort(
        (one, other) =>
          other.space.createdAt - one.space.createdAt ||
          other.index - one.index,
      )
      .flatMap(({ space }) => {
        const status = agentStatus(space, state, now, SEEN_NOTHING);
        if (!status) return [];
        return [
          {
            id: space.id,
            name: cleanAgentText(space.name).slice(0, AGENT_TEXT_LIMITS.name),
            status,
            attention: status === "needs-you" || status === "failed",
          },
        ];
      });
  }

  private rebuild(): void {
    if (this.disposed) return;
    this.rebuiltAt = this.now();
    if (this.rebuilding) {
      clearTimeout(this.rebuilding);
      this.rebuilding = null;
    }
    this.rebuiltHidden = this.isHidden;
    const spaces = this.collect();
    this.badge(spaces);
    this.announce(spaces);
    if (!this.isHidden) {
      this.dropTray();
      return;
    }
    if (this.platform === "darwin") {
      app.dock?.setMenu(
        Menu.buildFromTemplate([
          ...this.spaceItems(spaces),
          { type: "separator" },
          this.stopItem(),
        ]),
      );
      return;
    }
    const attention = spaces.some((space) => space.attention);
    if (!this.tray) {
      // A Linux desktop without AppIndicator support shows no tray; opening
      // Kamapathy again still brings the window back, as the docs say.
      this.tray = new Tray(this.icon(attention));
      this.trayAttention = attention;
      this.tray.on("click", () => this.host.show());
    } else if (this.trayAttention !== attention) {
      this.tray.setImage(this.icon(attention));
      this.trayAttention = attention;
    }
    this.tray.setToolTip(
      TRAY_COPY.working(
        spaces.filter((space) => WORKING.includes(space.status)).length,
      ),
    );
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        ...this.spaceItems(spaces),
        { type: "separator" },
        {
          label: this.menuLabel(TRAY_COPY.open),
          click: () => this.host.show(),
        },
        this.stopItem(),
        { type: "separator" },
        { label: this.menuLabel(TRAY_COPY.quit), click: () => app.quit() },
      ]),
    );
  }

  // Each space as the person reads it in the window, opening the window on
  // itself.
  private spaceItems(spaces: BackgroundSpace[]): MenuItemConstructorOptions[] {
    return spaces.slice(0, MENU_SPACES).map((space) => ({
      label: this.menuLabel(
        `${quoted(space.name)} \u00b7 ${statusCopy[space.status]}`,
      ),
      click: () => this.openSpace(space.id),
    }));
  }

  private stopItem(): MenuItemConstructorOptions {
    return {
      label: this.menuLabel(TRAY_COPY.stopAll),
      click: () => this.stopAllAgents(),
    };
  }

  private menuLabel(text: string): string {
    // Windows reads a single ampersand in a menu label as a shortcut mark.
    return this.platform === "win32" ? text.replace(/&/g, "&&") : text;
  }

  private icon(attention: boolean): Electron.NativeImage {
    const base =
      this.resources ??
      (process.defaultApp === true
        ? join(moduleDirectory, "../../build/tray")
        : join(process.resourcesPath, "tray"));
    return nativeImage.createFromPath(
      join(base, attention ? "tray-attention.png" : "tray.png"),
    );
  }

  private dropTray(): void {
    if (!this.tray) return;
    this.tray.destroy();
    this.tray = null;
  }

  private openSpace(id: string): void {
    const controller = this.host.controller();
    if (!controller) return;
    // A space whose last page just closed cannot be opened; the window still
    // comes back.
    void controller.dispatch({ type: "space:activate", id }).catch(() => {});
    this.host.show();
  }

  private stopAllAgents(): void {
    const controller = this.host.controller();
    if (!controller) return;
    const window = this.host.window();
    const question = {
      type: "question" as const,
      title: agentBarCopy.stopAll,
      message: `${agentBarCopy.stopAll}?`,
      buttons: [agentBarCopy.cancel, agentBarCopy.stopAll],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    void (
      window && !window.isDestroyed() && window.isVisible()
        ? dialog.showMessageBox(window, question)
        : dialog.showMessageBox(question)
    ).then(({ response }) => {
      if (response === 1 && !this.disposed)
        void controller.dispatch({
          type: "settings:update",
          settings: { automationEnabled: false },
        });
    });
  }

  // On macOS the Dock carries the count of spaces waiting for the person.
  // With the window on screen the window itself says it, so the badge goes.
  private badge(spaces: BackgroundSpace[]): void {
    if (this.platform !== "darwin") return;
    const waiting = this.isHidden
      ? spaces.filter((space) => space.attention).length
      : 0;
    app.dock?.setBadge(waiting ? String(waiting) : "");
  }

  // A space that turns needs-you or failed while the window is away says so
  // once. States the person need not act on say nothing.
  private announce(spaces: BackgroundSpace[]): void {
    const controller = this.host.controller();
    const live = new Set(spaces.map((space) => space.id));
    for (const id of [...this.announced.keys()])
      if (!live.has(id)) this.announced.delete(id);
    for (const space of spaces) {
      const was = this.announced.get(space.id);
      this.announced.set(space.id, space.status);
      if (
        !this.isHidden ||
        was === space.status ||
        !space.attention ||
        !Notification.isSupported()
      )
        continue;
      const current = controller?.state.spaces.find(
        (item) => item.id === space.id,
      );
      const line = current ? statusLine(current, this.now()) : undefined;
      const notice = new Notification({
        title:
          space.status === "failed" ? TRAY_COPY.failed : TRAY_COPY.needsYou,
        body: [
          quoted(space.name),
          line && (line.agent ? quoted(line.text) : line.text),
        ]
          .filter(Boolean)
          .join(" \u00b7 "),
      });
      notice.on("click", () => this.openSpace(space.id));
      notice.show();
    }
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
