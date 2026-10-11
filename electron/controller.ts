import {
  BrowserWindow,
  dialog,
  nativeTheme,
  session,
  shell,
  WebContentsView,
} from "electron";
import type { NativeImage, Session, WebContents } from "electron";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { HOME_URL, newTab, openingTab } from "../shared/state";
import { googleSignInFallback, isWebUrl, normalizeUrl } from "../shared/url";
import type {
  Activity,
  BrowserAction,
  BrowserState,
  ContentBounds,
  FrozenFrame,
  ImportedBookmark,
  ImportedVisit,
  SignIns,
  Space,
  SpaceColor,
  Tab,
} from "../shared/types";
import { validSettings, writeState } from "./persistence";

const colors: SpaceColor[] = ["green", "blue", "orange", "purple"];
// Spaces that share sign-ins use the first space's partition, so sign-ins
// made before shared sessions carry over.
export const SHARED_PARTITION = "persist:space-personal";
const cleanText = (value: unknown, maximum = 300): string => {
  if (typeof value !== "string" || value.length > maximum)
    throw new Error("Invalid text value.");
  return value.trim();
};
const signInsOf = (value: unknown): SignIns => {
  if (value === undefined || value === "shared") return "shared";
  if (value === "separate") return "separate";
  throw new Error("Invalid sign-in option.");
};
// Imported pages, with the same bounds saved state gets on restore.
function importedPages(value: unknown, now: number): ImportedVisit[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new Error("Invalid import.");
  const seen = new Set<string>();
  const pages: ImportedVisit[] = [];
  for (const item of value as Partial<ImportedVisit>[]) {
    if (!item || typeof item.url !== "string" || !isWebUrl(item.url))
      continue;
    const url = item.url.slice(0, 8192);
    if (seen.has(url)) continue;
    seen.add(url);
    const title =
      typeof item.title === "string" ? item.title.trim().slice(0, 300) : "";
    const visitedAt =
      typeof item.visitedAt === "number" && Number.isFinite(item.visitedAt)
        ? Math.min(item.visitedAt, now)
        : now;
    const visits =
      Number.isInteger(item.visits) && item.visits! > 0 ? item.visits! : 1;
    pages.push({ url, title: title || url, visitedAt, visits });
  }
  return pages;
}

const CAPTURE_TIMEOUT = 300;
// Keeps frames sharp on 2x displays without sending larger captures.
const FRAME_SCALE = 2;
const THUMBNAIL_WIDTH = 480;

// Resolves undefined when a capture fails, is empty or takes too long.
async function capture(
  contents: WebContents,
  stayHidden = false,
): Promise<NativeImage | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const image = await Promise.race([
      contents.capturePage(undefined, { stayHidden }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), CAPTURE_TIMEOUT);
      }),
    ]);
    return image && !image.isEmpty() ? image : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function jpeg(image: NativeImage, width: number): string {
  const scaled =
    image.getSize().width > width
      ? image.resize({ width, quality: "good" })
      : image;
  return `data:image/jpeg;base64,${scaled.toJPEG(82).toString("base64")}`;
}

export class BrowserController {
  readonly state: BrowserState;
  private views = new Map<string, WebContentsView>();
  // Sessions and their cleanups are keyed by partition, grants by space.
  private sessions = new Map<string, Session>();
  private sessionCleanups = new Map<string, () => void>();
  private discards = new Map<string, Promise<void>>();
  private grants = new Set<string>();
  private pendingLoads = new Map<string, symbol>();
  private listeners = new Set<(state: BrowserState) => void>();
  private viewListeners = new Set<
    (tabId: string, contents: WebContents) => void
  >();
  private closedTabs: Tab[] = [];
  private lastActive = new Map<string, string>();
  private bounds: ContentBounds = {
    x: 248,
    y: 82,
    width: 950,
    height: 718,
    hidden: true,
  };
  private saveTimer?: NodeJS.Timeout;
  private destroyed = false;
  private runId = randomUUID();
  private lastFind = { text: "", tabId: "" };
  private splitLeadingTabId: string | null = null;
  private frozen = false;
  private captures = new Map<string, string>();

  constructor(
    readonly window: BrowserWindow,
    state: BrowserState,
    private statePath: string,
  ) {
    this.state = state;
    nativeTheme.themeSource = state.settings.theme;
    this.bindShortcuts(window.webContents);
    window.on("resize", () => this.layout());
    this.layout();
  }

  subscribe(listener: (state: BrowserState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onViewCreated(
    listener: (tabId: string, contents: WebContents) => void,
  ): () => void {
    this.viewListeners.add(listener);
    return () => this.viewListeners.delete(listener);
  }

  private emit(): BrowserState {
    if (this.destroyed) return this.state;
    this.layout();
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed())
      this.window.webContents.send("kamapathy:state-changed", this.state);
    for (const listener of this.listeners) listener(this.state);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 350);
    return this.state;
  }

  private persist(): void {
    try {
      writeState(this.statePath, this.state);
    } catch (error) {
      console.error(
        "Unable to save browser state:",
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  addActivity(
    spaceId: string | undefined,
    message: string,
    kind: Activity["kind"] = "info",
  ): void {
    this.state.activity.unshift({
      id: randomUUID(),
      spaceId,
      message: message.slice(0, 500),
      kind,
      time: Date.now(),
    });
    this.state.activity = this.state.activity.slice(0, 100);
    this.emit();
  }

  setAutomation(running: boolean): void {
    this.state.automation = { running };
    this.emit();
  }

  setContentBounds(bounds: ContentBounds): void {
    if (
      !bounds ||
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      )
    )
      return;
    const [width, height] = this.window.getContentSize();
    this.bounds = {
      x: Math.max(0, Math.min(width, Math.round(bounds.x))),
      y: Math.max(0, Math.min(height, Math.round(bounds.y))),
      width: Math.max(0, Math.min(width, Math.round(bounds.width))),
      height: Math.max(0, Math.min(height, Math.round(bounds.height))),
      hidden: !!bounds.hidden,
    };
    this.layout();
  }

  private layout(): void {
    if (this.destroyed || this.window.isDestroyed()) return;
    const active = this.state.tabs.find(
      (tab) => tab.id === this.state.activeTabId,
    );
    const other = this.state.tabs.find(
      (tab) => tab.id === this.state.splitTabId,
    );
    if (
      !active ||
      !other ||
      active.id === other.id ||
      active.spaceId !== other.spaceId ||
      !isWebUrl(active.url) ||
      !isWebUrl(other.url)
    ) {
      this.state.splitTabId = null;
      this.splitLeadingTabId = null;
    } else if (
      this.splitLeadingTabId !== active.id &&
      this.splitLeadingTabId !== other.id
    ) {
      this.splitLeadingTabId = active.id;
    }
    const { activeTabId, splitTabId } = this.state;
    const ids = [activeTabId, splitTabId].filter((id): id is string => !!id);
    const [windowWidth, windowHeight] = this.window.getContentSize();
    const area = {
      ...this.bounds,
      width: Math.max(
        0,
        Math.min(this.bounds.width, windowWidth - this.bounds.x),
      ),
      height: Math.max(
        0,
        Math.min(this.bounds.height, windowHeight - this.bounds.y),
      ),
    };
    for (const id of ids) {
      const tab = this.state.tabs.find((item) => item.id === id);
      if (tab && isWebUrl(tab.url)) this.ensureView(tab);
    }
    for (const [id, view] of this.views) {
      const tab = this.state.tabs.find((item) => item.id === id);
      const visible =
        !this.frozen &&
        !area.hidden &&
        area.width > 0 &&
        area.height > 0 &&
        ids.includes(id) &&
        !!tab &&
        tab.url !== HOME_URL &&
        !tab.error;
      view.setVisible(visible);
      if (visible) {
        const split = !!splitTabId;
        const gap = split ? 8 : 0;
        const leftWidth = split
          ? Math.floor((area.width - gap) / 2)
          : area.width;
        const second = split && id !== this.splitLeadingTabId;
        view.setBounds({
          x: area.x + (second ? leftWidth + gap : 0),
          y: area.y,
          width: second ? area.width - leftWidth - gap : leftWidth,
          height: area.height,
        });
      }
    }
  }

  private getSpace(id: string): Space {
    const space = this.state.spaces.find((item) => item.id === id);
    if (!space) throw new Error("Space was not found.");
    return space;
  }

  private getTab(id: string): Tab {
    const tab = this.state.tabs.find((item) => item.id === id);
    if (!tab) throw new Error("Tab was not found.");
    return tab;
  }

  private partitionFor(space: Space): string {
    if (space.signIns === "shared") return SHARED_PARTITION;
    return space.kind === "agent"
      ? `agent-${this.runId}-${space.id}`
      : `persist:space-${space.id}`;
  }

  // The space a page belongs to. Session handlers need it because spaces
  // that share sign-ins share the session.
  private spaceOf(contents: WebContents | null): Space | undefined {
    if (!contents) return undefined;
    for (const [id, view] of this.views)
      if (view.webContents === contents) {
        const tab = this.state.tabs.find((item) => item.id === id);
        return tab
          ? this.state.spaces.find((space) => space.id === tab.spaceId)
          : undefined;
      }
    return undefined;
  }

  private sessionFor(partition: string): Session {
    const existing = this.sessions.get(partition);
    if (existing) return existing;
    const browsingSession = session.fromPartition(partition);
    this.sessions.set(partition, browsingSession);
    const permissionKey = (space: Space, origin: string, permission: string) =>
      `${space.id}|${origin}|${permission}`;
    const isCurrentSession = () =>
      !this.destroyed && this.sessions.get(partition) === browsingSession;
    browsingSession.setPermissionCheckHandler(
      (contents, permission, origin, details) => {
        const space = this.spaceOf(contents);
        if (!space || space.kind === "agent" || !isCurrentSession())
          return false;
        if (
          permission === "media" &&
          details.mediaType !== "audio" &&
          details.mediaType !== "video"
        )
          return false;
        try {
          return this.grants.has(
            permissionKey(
              space,
              new URL(origin).origin,
              permission === "media"
                ? `media:${details.mediaType}`
                : permission,
            ),
          );
        } catch {
          return false;
        }
      },
    );
    browsingSession.setPermissionRequestHandler(
      (contents, permission, callback, details) => {
        const space = this.spaceOf(contents);
        if (
          !space ||
          space.kind === "agent" ||
          !isCurrentSession() ||
          !contents ||
          contents.isDestroyed() ||
          this.window.isDestroyed()
        ) {
          callback(false);
          return;
        }
        const allowed = [
          "media",
          "geolocation",
          "notifications",
          "clipboard-read",
          "clipboard-sanitized-write",
          "fullscreen",
          "pointerLock",
          "display-capture",
          "speaker-selection",
        ];
        if (!allowed.includes(permission)) {
          callback(false);
          return;
        }
        let origin: string;
        try {
          const requestingUrl =
            permission === "media" &&
            "securityOrigin" in details &&
            details.securityOrigin
              ? details.securityOrigin
              : details.requestingUrl || contents.getURL();
          if (!isWebUrl(requestingUrl))
            throw new Error("Invalid permission origin.");
          origin = new URL(requestingUrl).origin;
        } catch {
          callback(false);
          return;
        }
        const mediaTypes =
          permission === "media" && "mediaTypes" in details
            ? [...new Set(details.mediaTypes ?? [])]
            : [];
        if (
          permission === "media" &&
          (!mediaTypes.length ||
            mediaTypes.some((type) => type !== "audio" && type !== "video"))
        ) {
          callback(false);
          return;
        }
        const requestedPermissions =
          permission === "media"
            ? mediaTypes.map((type) => `media:${type}`)
            : [permission];
        if (
          requestedPermissions.every((item) =>
            this.grants.has(permissionKey(space, origin, item)),
          )
        ) {
          callback(true);
          return;
        }
        const requestedPageUrl = contents.getURL();
        let navigated = false;
        const onNavigation = (
          event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (event.isMainFrame && !event.isSameDocument) navigated = true;
        };
        contents.on("did-start-navigation", onNavigation);
        const label =
          permission === "media"
            ? mediaTypes
                .map((type) => (type === "audio" ? "microphone" : "camera"))
                .join(" and ")
            : permission;
        void dialog
          .showMessageBox(this.window, {
            type: "question",
            title: "Website permission",
            message: `${origin} wants to use ${label}.`,
            detail: `This permission applies to the ${space.name} space for this browser session.`,
            buttons: ["Block", "Allow"],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          })
          .then(({ response }) => {
            const allow =
              response === 1 &&
              !navigated &&
              isCurrentSession() &&
              this.state.spaces.includes(space) &&
              !contents.isDestroyed() &&
              !this.window.isDestroyed() &&
              contents.getURL() === requestedPageUrl;
            if (allow)
              for (const item of requestedPermissions)
                this.grants.add(permissionKey(space, origin, item));
            callback(allow);
          })
          .catch(() => callback(false))
          .finally(() =>
            contents.removeListener("did-start-navigation", onNavigation),
          );
      },
    );
    const onDownload = (
      event: Electron.Event,
      item: Electron.DownloadItem,
      contents: WebContents,
    ) => {
      const space = this.spaceOf(contents);
      if (!space || space.kind === "agent") {
        event.preventDefault();
        if (space)
          this.addActivity(
            space.id,
            "A download was blocked in the agent space.",
            "warning",
          );
        return;
      }
      item.setSaveDialogOptions({ title: "Save download" });
      const download = {
        id: randomUUID(),
        filename: item.getFilename(),
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
        state: "progressing" as
          | "progressing"
          | "completed"
          | "cancelled"
          | "interrupted",
        path: "",
      };
      this.state.downloads.unshift(download);
      this.state.downloads = this.state.downloads.slice(0, 100);
      item.on("updated", (_event, status) => {
        download.receivedBytes = item.getReceivedBytes();
        download.totalBytes = item.getTotalBytes();
        download.state = status;
        download.path = item.getSavePath();
        this.emit();
      });
      item.once("done", (_event, status) => {
        download.state = status;
        download.path = item.getSavePath();
        download.receivedBytes = item.getReceivedBytes();
        this.addActivity(
          space.id,
          `${download.filename}: ${status}.`,
          status === "completed" ? "success" : "warning",
        );
      });
      this.emit();
    };
    browsingSession.on("will-download", onDownload);
    this.sessionCleanups.set(partition, () => {
      browsingSession.removeListener("will-download", onDownload);
      browsingSession.setPermissionCheckHandler(() => false);
      browsingSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
    });
    return browsingSession;
  }

  // Removes everything sites stored in a partition only one space used. The
  // handlers come off first, so a space that reuses the partition meanwhile
  // gets its own.
  private discardPartition(partition: string): Promise<void> {
    const pending = this.discards.get(partition);
    if (pending) return pending;
    const oldSession = this.sessionFor(partition);
    this.sessionCleanups.get(partition)?.();
    this.sessionCleanups.delete(partition);
    this.sessions.delete(partition);
    const discard = (async () => {
      try {
        await oldSession.clearStorageData();
        await oldSession.clearCache();
      } finally {
        this.discards.delete(partition);
      }
    })();
    this.discards.set(partition, discard);
    return discard;
  }

  // The partition a space had on disk before it shared sign-ins, if any.
  private ownPartition(space: Space): string | undefined {
    const own = `persist:space-${space.id}`;
    if (own === SHARED_PARTITION) return undefined;
    if (space.signIns === "separate") return own;
    return existsSync(
      join(dirname(this.statePath), "Partitions", `space-${space.id}`),
    )
      ? own
      : undefined;
  }

  getWebContents(tabId: string): WebContents | undefined {
    const tab = this.state.tabs.find((item) => item.id === tabId);
    if (!tab || tab.url === HOME_URL) return undefined;
    return this.ensureView(tab).webContents;
  }

  // Unlike getWebContents, this never creates a view.
  peekWebContents(tabId: string): WebContents | undefined {
    const contents = this.views.get(tabId)?.webContents;
    return contents && !contents.isDestroyed() ? contents : undefined;
  }

  canCapturePage(): boolean {
    return (
      !this.window.isDestroyed() &&
      this.window.isVisible() &&
      !this.window.isMinimized()
    );
  }

  // The pages keep showing until the renderer has drawn these captures in
  // their place and calls hidePages().
  async freeze(): Promise<FrozenFrame[]> {
    const { activeSpaceId, activeTabId } = this.state;
    const capturable = this.canCapturePage();
    const shown = [...this.views].filter(([, view]) => view.getVisible());
    const frames = await Promise.all(
      shown.map(async ([id, view]) => {
        const bounds = view.getBounds();
        const image = capturable ? await capture(view.webContents) : undefined;
        if (!image) return undefined;
        if (id === activeTabId) this.remember(activeSpaceId, image);
        return { ...bounds, image: jpeg(image, bounds.width * FRAME_SCALE) };
      }),
    );
    return frames.filter((frame): frame is FrozenFrame => !!frame);
  }

  hidePages(): void {
    if (this.frozen) return;
    this.frozen = true;
    this.layout();
  }

  unfreeze(): void {
    if (!this.frozen) return;
    this.frozen = false;
    this.layout();
  }

  async thumbnails(): Promise<Record<string, string>> {
    if (this.canCapturePage())
      await Promise.all(
        this.state.spaces
          .filter((space) => space.kind === "agent")
          .map((space) => this.captureThumbnail(space.id, true)),
      );
    return Object.fromEntries(this.captures);
  }

  private remember(spaceId: string, image: NativeImage): void {
    // The space may have been deleted while its capture ran.
    if (
      !this.destroyed &&
      this.state.spaces.some((space) => space.id === spaceId)
    )
      this.captures.set(spaceId, jpeg(image, THUMBNAIL_WIDTH));
  }

  private async captureThumbnail(
    spaceId: string,
    stayHidden = false,
  ): Promise<void> {
    const tab = this.shownTab(spaceId);
    const view = tab && this.views.get(tab.id);
    if (!view || view.webContents.isDestroyed()) return;
    const image = await capture(view.webContents, stayHidden);
    if (image) this.remember(spaceId, image);
  }

  private shownTab(spaceId: string): Tab | undefined {
    if (spaceId === this.state.activeSpaceId)
      return this.state.tabs.find((tab) => tab.id === this.state.activeTabId);
    return openingTab(this.state, spaceId, this.lastActive.get(spaceId));
  }

  private ensureView(
    tab: Tab,
    loadOptions?: Electron.LoadURLOptions,
  ): WebContentsView {
    const existing = this.views.get(tab.id);
    if (existing) return existing;
    const space = this.getSpace(tab.spaceId);
    const view = new WebContentsView({
      webPreferences: {
        session: this.sessionFor(this.partitionFor(space)),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        navigateOnDragDrop: false,
        focusOnNavigation: false,
        spellcheck: true,
        backgroundThrottling: space.kind !== "agent",
      },
    });
    this.views.set(tab.id, view);
    this.window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
    view.setVisible(false);
    view.setBorderRadius(10);
    const contents = view.webContents;
    if (space.kind === "agent") {
      // Chromium paints nothing for a page that was never shown, so an agent
      // page nobody is watching would run no animations, accept no native
      // input and have nothing to capture. Each new document starts hidden.
      const keepPainting = () => {
        if (!contents.isDestroyed()) contents.setBackgroundThrottling(false);
      };
      keepPainting();
      contents.on("did-navigate", keepPainting);
    }
    const isCurrentView = () =>
      !this.destroyed &&
      !contents.isDestroyed() &&
      this.views.get(tab.id) === view &&
      this.state.tabs.includes(tab);
    this.bindShortcuts(contents);
    const activateFocusedPane = () => {
      if (
        !isCurrentView() ||
        this.frozen ||
        this.bounds.hidden ||
        tab.id === this.state.activeTabId ||
        tab.id !== this.state.splitTabId
      )
        return;
      this.activate(tab);
      this.emit();
    };
    contents.on("focus", activateFocusedPane);
    contents.on("before-mouse-event", (_event, input) => {
      // A background page may already own Chromium focus when it becomes a
      // split pane. A physical click must still update the browser controls.
      if (input.type === "mouseDown" && space.owner === "human")
        activateFocusedPane();
    });
    contents.setWindowOpenHandler(({ url, referrer, postBody }) => {
      if (isCurrentView() && isWebUrl(url) && this.state.tabs.length < 200) {
        const options: Electron.LoadURLOptions = { httpReferrer: referrer };
        if (postBody) {
          if (
            ![
              "application/x-www-form-urlencoded",
              "multipart/form-data",
            ].includes(postBody.contentType) ||
            /[\r\n]/.test(postBody.boundary || "")
          )
            return { action: "deny" };
          options.postData = postBody.data;
          options.extraHeaders = `Content-Type: ${postBody.contentType}${postBody.boundary ? `; boundary=${postBody.boundary}` : ""}`;
        }
        const opened = newTab(space.id, url);
        this.state.tabs.push(opened);
        if (space.kind !== "agent") this.activate(opened);
        this.ensureView(opened, options);
        this.emit();
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (!isWebUrl(url)) event.preventDefault();
    });
    contents.on("will-redirect", (event, url) => {
      if (!isWebUrl(url)) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("did-start-navigation", (details) => {
      if (!isCurrentView() || !details.isMainFrame || !isWebUrl(details.url))
        return;
      tab.url = details.url;
      delete tab.error;
      if (!details.isSameDocument) {
        tab.title = details.url;
        delete tab.favicon;
      }
      this.emit();
    });
    contents.on("did-redirect-navigation", (details) => {
      if (!isCurrentView() || !details.isMainFrame || !isWebUrl(details.url))
        return;
      tab.url = details.url;
      this.emit();
    });
    const updateNavigation = () => {
      if (!isCurrentView()) return;
      const url = contents.getURL();
      if (isWebUrl(url) && !tab.error) tab.url = url;
      tab.canGoBack = contents.navigationHistory.canGoBack();
      tab.canGoForward = contents.navigationHistory.canGoForward();
      this.emit();
    };
    contents.on("did-start-loading", () => {
      if (!isCurrentView()) return;
      // Subframes and error documents can also start loading. A new main-frame
      // navigation or deliberate retry is responsible for clearing errors.
      tab.loading = true;
      this.emit();
    });
    contents.on("did-stop-loading", () => {
      if (!isCurrentView()) return;
      tab.loading = false;
      updateNavigation();
    });
    contents.on("did-navigate", () => {
      if (!isCurrentView()) return;
      delete tab.error;
      updateNavigation();
      this.recordVisit(tab);
    });
    contents.on("did-navigate-in-page", (_event, _url, mainFrame) => {
      if (mainFrame && isCurrentView()) {
        updateNavigation();
        this.recordVisit(tab);
      }
    });
    contents.on("page-title-updated", (_event, title) => {
      if (!isCurrentView()) return;
      tab.title = title.slice(0, 300) || tab.url;
      const latest = this.state.history.find((entry) => entry.url === tab.url);
      if (latest && space.kind === "personal") latest.title = tab.title;
      this.emit();
    });
    contents.on("page-favicon-updated", (_event, favicons) => {
      if (!isCurrentView()) return;
      tab.favicon = favicons.find((url) => isWebUrl(url));
      this.emit();
    });
    contents.on(
      "did-fail-load",
      (_event, code, description, url, mainFrame) => {
        if (
          !isCurrentView() ||
          !mainFrame ||
          code === -3 ||
          (isWebUrl(url) && url !== tab.url)
        )
          return;
        tab.loading = false;
        tab.error = description || "This page could not be loaded.";
        this.emit();
      },
    );
    contents.on("render-process-gone", (_event, details) => {
      if (!isCurrentView()) return;
      tab.loading = false;
      tab.error = `The page process stopped (${details.reason}). Reload to try again.`;
      this.emit();
    });
    contents.on("context-menu", (_event, params) => {
      import("electron")
        .then(({ Menu }) => {
          if (!isCurrentView() || this.window.isDestroyed()) return;
          const template: Electron.MenuItemConstructorOptions[] = [];
          if (isWebUrl(params.linkURL))
            template.push(
              {
                label: "Open link in new tab",
                click: () => {
                  void this.dispatch({
                    type: "tab:create",
                    url: params.linkURL,
                    spaceId: tab.spaceId,
                    background: true,
                  }).catch(() => undefined);
                },
              },
              { type: "separator" },
            );
          if (params.isEditable)
            template.push(
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            );
          else if (params.selectionText) template.push({ role: "copy" });
          else
            template.push(
              {
                label: "Back",
                enabled: tab.canGoBack,
                click: () => {
                  contents.navigationHistory.goBack();
                },
              },
              {
                label: "Forward",
                enabled: tab.canGoForward,
                click: () => {
                  contents.navigationHistory.goForward();
                },
              },
              { label: "Reload", click: () => contents.reload() },
            );
          Menu.buildFromTemplate(template).popup({ window: this.window });
        })
        .catch(() => undefined);
    });
    // Listeners see each new page before its first load. Commands sent to
    // the page here are answered only once that load starts.
    for (const listener of this.viewListeners) {
      try {
        listener(tab.id, contents);
      } catch (error) {
        console.error(
          "View listener failed:",
          error instanceof Error ? error.message : "Unknown error",
        );
      }
    }
    this.load(tab, contents, loadOptions);
    return view;
  }

  private load(
    tab: Tab,
    contents: WebContents,
    options?: Electron.LoadURLOptions,
  ): void {
    if (!isWebUrl(tab.url)) return;
    const request = Symbol();
    const requestedUrl = tab.url;
    this.pendingLoads.set(tab.id, request);
    tab.loading = true;
    delete tab.error;
    void (
      options ? contents.loadURL(tab.url, options) : contents.loadURL(tab.url)
    ).catch((error) => {
      if (
        contents.isDestroyed() ||
        this.views.get(tab.id)?.webContents !== contents ||
        this.pendingLoads.get(tab.id) !== request ||
        tab.url !== requestedUrl ||
        !this.state.tabs.includes(tab) ||
        String(error).includes("ERR_ABORTED")
      )
        return;
      tab.loading = false;
      tab.error =
        "This page could not be loaded. Check the address and connection, then try again.";
      this.emit();
    });
  }

  private recordVisit(tab: Tab): void {
    if (this.getSpace(tab.spaceId).kind === "agent" || !isWebUrl(tab.url))
      return;
    const previous = this.state.history.find((entry) => entry.url === tab.url);
    this.state.history = this.state.history.filter(
      (entry) => entry.url !== tab.url,
    );
    this.state.history.unshift({
      id: randomUUID(),
      title: tab.title,
      url: tab.url,
      visitedAt: Date.now(),
      ...(previous ? { visits: (previous.visits ?? 1) + 1 } : {}),
    });
    this.state.history = this.state.history.slice(0, 1000);
    this.emit();
  }

  private activate(tab: Tab): void {
    // The capture starts before this switch hides the page.
    if (
      tab.spaceId !== this.state.activeSpaceId &&
      !this.frozen &&
      !this.bounds.hidden &&
      this.canCapturePage()
    )
      void this.captureThumbnail(this.state.activeSpaceId);
    this.lastActive.set(this.state.activeSpaceId, this.state.activeTabId);
    if (this.state.activeSpaceId !== tab.spaceId) this.state.splitTabId = null;
    if (this.state.splitTabId === tab.id)
      this.state.splitTabId = this.state.activeTabId;
    else if (this.splitLeadingTabId === this.state.activeTabId)
      this.splitLeadingTabId = tab.id;
    this.state.activeSpaceId = tab.spaceId;
    this.state.activeTabId = tab.id;
  }

  private destroyTab(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    this.pendingLoads.delete(id);
    if (!this.window.isDestroyed())
      this.window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed())
      view.webContents.close({ waitForBeforeUnload: false });
  }

  createAgentSpace(
    name: string,
    { color = "purple", isolated = false }: {
      color?: SpaceColor;
      isolated?: boolean;
    } = {},
  ): Space {
    if (this.destroyed) throw new Error("Browser is closing.");
    if (this.state.spaces.length >= 30)
      throw new Error("The maximum of 30 spaces has been reached.");
    if (this.state.tabs.length >= 200)
      throw new Error("The maximum of 200 tabs has been reached.");
    const space: Space = {
      id: randomUUID(),
      name: cleanText(name, 48) || "Agent space",
      color: colors.includes(color) ? color : "purple",
      kind: "agent",
      owner: "agent",
      signIns:
        isolated || this.state.settings.isolateAgentSpaces
          ? "separate"
          : "shared",
      createdAt: Date.now(),
    };
    this.state.spaces.push(space);
    this.state.tabs.push(newTab(space.id));
    this.addActivity(
      space.id,
      space.signIns === "shared"
        ? `${space.name} started with your sign-ins.`
        : `${space.name} started in an isolated session.`,
      "info",
    );
    return space;
  }

  async dispatch(action: BrowserAction): Promise<BrowserState> {
    if (
      !action ||
      typeof action !== "object" ||
      typeof action.type !== "string"
    )
      throw new Error("Invalid browser action.");
    if (this.destroyed) throw new Error("Browser is closing.");
    switch (action.type) {
      case "tab:create": {
        if (this.state.tabs.length >= 200)
          throw new Error("The maximum of 200 tabs has been reached.");
        const space = this.getSpace(action.spaceId ?? this.state.activeSpaceId);
        const tab = newTab(
          space.id,
          normalizeUrl(
            action.url === undefined ? "" : cleanText(action.url, 8192),
            this.state.settings.searchEngine,
          ),
        );
        this.state.tabs.push(tab);
        if (!action.background) this.activate(tab);
        if (isWebUrl(tab.url)) this.ensureView(tab);
        break;
      }
      case "tab:open-external": {
        const tab = this.state.tabs.find((item) => item.id === action.id);
        if (tab && tab.id === this.state.activeTabId) {
          const destination = googleSignInFallback(tab.url);
          if (destination) await shell.openExternal(destination);
        }
        break;
      }
      case "tab:activate":
        this.activate(this.getTab(action.id));
        break;
      case "tab:navigate": {
        const tab = this.getTab(action.id);
        tab.url = normalizeUrl(
          cleanText(action.url, 8192),
          this.state.settings.searchEngine,
        );
        tab.title = tab.url === HOME_URL ? "New tab" : tab.url;
        delete tab.favicon;
        delete tab.error;
        if (tab.url === HOME_URL) {
          this.destroyTab(tab.id);
          tab.loading = false;
          tab.canGoBack = false;
          tab.canGoForward = false;
        } else {
          const view = this.views.get(tab.id);
          if (view) this.load(tab, view.webContents);
          else this.ensureView(tab);
        }
        break;
      }
      case "tab:close": {
        const tab = this.getTab(action.id);
        // Closing the last, empty tab of a space you use closes the window,
        // as in other browsers. Agents close their tabs through the API.
        if (
          tab.url === HOME_URL &&
          this.getSpace(tab.spaceId).kind === "personal" &&
          !this.state.tabs.some(
            (item) => item.spaceId === tab.spaceId && item.id !== tab.id,
          )
        ) {
          if (!this.window.isDestroyed()) this.window.close();
          break;
        }
        this.closedTabs.unshift({ ...tab });
        this.closedTabs = this.closedTabs.slice(0, 20);
        const index = this.state.tabs.indexOf(tab);
        const spaceIndex = this.state.tabs
          .filter((item) => item.spaceId === tab.spaceId)
          .indexOf(tab);
        this.state.tabs.splice(index, 1);
        this.destroyTab(tab.id);
        if (this.state.splitTabId === tab.id) this.state.splitTabId = null;
        let candidates = this.state.tabs.filter(
          (item) => item.spaceId === tab.spaceId,
        );
        if (!candidates.length) {
          const replacement = newTab(tab.spaceId);
          this.state.tabs.push(replacement);
          candidates = [replacement];
        }
        if (this.state.activeTabId === tab.id) {
          const next =
            candidates.find((item) => item.id === this.state.splitTabId) ??
            candidates[Math.min(candidates.length - 1, spaceIndex)];
          this.state.splitTabId = null;
          this.activate(next);
        }
        break;
      }
      case "tab:reopen": {
        if (this.closedTabs.length && this.state.tabs.length >= 200)
          throw new Error("The maximum of 200 tabs has been reached.");
        const old = this.closedTabs.shift();
        if (
          old &&
          this.state.spaces.some((space) => space.id === old.spaceId)
        ) {
          const tab = {
            ...newTab(old.spaceId, old.url),
            title: old.title,
            pinned: old.pinned,
          };
          this.state.tabs.push(tab);
          this.activate(tab);
        }
        break;
      }
      case "tab:pin": {
        const tab = this.getTab(action.id);
        tab.pinned = !tab.pinned;
        break;
      }
      case "tab:duplicate": {
        const tab = this.getTab(action.id);
        return this.dispatch({
          type: "tab:create",
          url: tab.url,
          spaceId: tab.spaceId,
        });
      }
      case "tab:back":
      case "tab:forward":
      case "tab:reload":
      case "tab:stop": {
        const tab = this.getTab(action.id);
        const contents = this.getWebContents(tab.id);
        if (contents) {
          if (
            action.type === "tab:back" &&
            contents.navigationHistory.canGoBack()
          )
            contents.navigationHistory.goBack();
          if (
            action.type === "tab:forward" &&
            contents.navigationHistory.canGoForward()
          )
            contents.navigationHistory.goForward();
          if (action.type === "tab:reload") {
            if (tab.error) this.load(tab, contents);
            else contents.reload();
          }
          if (action.type === "tab:stop") {
            contents.stop();
            tab.loading = false;
          }
        }
        break;
      }
      case "tab:split": {
        if (action.id === null) this.state.splitTabId = null;
        else {
          const tab = this.getTab(action.id);
          if (
            tab.spaceId !== this.state.activeSpaceId ||
            tab.id === this.state.activeTabId ||
            !isWebUrl(tab.url) ||
            !isWebUrl(this.getTab(this.state.activeTabId).url)
          )
            throw new Error("Open two web pages in this space for split view.");
          this.state.splitTabId = tab.id;
          this.splitLeadingTabId = this.state.activeTabId;
        }
        break;
      }
      case "space:create": {
        if (
          !["personal", "agent"].includes(action.kind) ||
          !colors.includes(action.color)
        )
          throw new Error("Invalid space options.");
        if (this.state.spaces.length >= 30)
          throw new Error("The maximum of 30 spaces has been reached.");
        if (this.state.tabs.length >= 200)
          throw new Error("The maximum of 200 tabs has been reached.");
        const name = cleanText(action.name, 48) || "Untitled space";
        const signIns = signInsOf(action.signIns);
        let space: Space;
        if (action.kind === "agent") {
          space = this.createAgentSpace(name, {
            color: action.color,
            isolated: signIns === "separate",
          });
          space.owner = "human";
        } else {
          space = {
            id: randomUUID(),
            name,
            color: action.color,
            kind: "personal",
            owner: "human",
            signIns,
            createdAt: Date.now(),
          };
          this.state.spaces.push(space);
          this.state.tabs.push(newTab(space.id));
        }
        this.activate(this.state.tabs.find((tab) => tab.spaceId === space.id)!);
        break;
      }
      case "space:activate": {
        const space = this.getSpace(action.id);
        this.activate(
          openingTab(this.state, space.id, this.lastActive.get(space.id))!,
        );
        break;
      }
      case "space:rename":
        this.getSpace(action.id).name =
          cleanText(action.name, 48) || "Untitled space";
        break;
      case "space:color":
        if (!colors.includes(action.color))
          throw new Error("Invalid space options.");
        this.getSpace(action.id).color = action.color;
        break;
      case "space:sign-ins": {
        const space = this.getSpace(action.id);
        const signIns = signInsOf(action.signIns);
        if (space.kind !== "personal")
          throw new Error("Only personal spaces can change their sign-ins.");
        if (space.signIns === signIns) break;
        // A switch back while the old partition is still being cleared waits.
        await this.discards.get(`persist:space-${space.id}`);
        const previous = this.partitionFor(space);
        space.signIns = signIns;
        // Its pages reload in the new session.
        for (const tab of this.state.tabs.filter(
          (item) => item.spaceId === space.id,
        )) {
          this.destroyTab(tab.id);
          tab.loading = false;
        }
        this.emit();
        if (previous !== SHARED_PARTITION)
          await this.discardPartition(previous);
        break;
      }
      case "space:ownership": {
        const space = this.getSpace(action.id);
        if (
          space.kind !== "agent" ||
          !["human", "agent"].includes(action.owner)
        )
          throw new Error("Only agent spaces can change ownership.");
        space.owner = action.owner;
        this.addActivity(
          space.id,
          action.owner === "human"
            ? "You took control. Agent access is paused."
            : "Control returned to the agent.",
          "info",
        );
        break;
      }
      case "space:delete": {
        const space = this.getSpace(action.id);
        if (
          space.kind === "personal" &&
          this.state.spaces.filter((item) => item.kind === "personal").length <=
            1
        )
          throw new Error("Keep at least one personal space.");
        for (const tab of this.state.tabs.filter(
          (item) => item.spaceId === space.id,
        ))
          this.destroyTab(tab.id);
        this.state.tabs = this.state.tabs.filter(
          (item) => item.spaceId !== space.id,
        );
        this.state.spaces = this.state.spaces.filter(
          (item) => item.id !== space.id,
        );
        this.closedTabs = this.closedTabs.filter(
          (item) => item.spaceId !== space.id,
        );
        this.captures.delete(space.id);
        for (const key of this.grants)
          if (key.startsWith(`${space.id}|`)) this.grants.delete(key);
        this.state.activity = this.state.activity.filter(
          (item) => item.spaceId !== space.id,
        );
        if (this.state.activeSpaceId === space.id)
          this.activate(
            this.state.tabs.find(
              (tab) => tab.spaceId === this.state.spaces[0].id,
            )!,
          );
        const partition = this.partitionFor(space);
        const own = this.ownPartition(space);
        this.emit();
        if (partition !== SHARED_PARTITION)
          await this.discardPartition(partition);
        else if (own) await this.discardPartition(own);
        break;
      }
      case "bookmark:add": {
        const url = normalizeUrl(
          cleanText(action.url, 8192),
          this.state.settings.searchEngine,
        );
        if (!isWebUrl(url))
          throw new Error("Only web pages can be bookmarked.");
        if (!this.state.bookmarks.some((item) => item.url === url))
          this.state.bookmarks.push({
            id: randomUUID(),
            url,
            title: cleanText(action.title) || url,
            createdAt: Date.now(),
          });
        break;
      }
      case "bookmark:remove":
        this.state.bookmarks = this.state.bookmarks.filter(
          (item) => item.id !== action.id,
        );
        break;
      case "bookmark:update": {
        const bookmark = this.state.bookmarks.find(
          (item) => item.id === action.id,
        );
        if (!bookmark) throw new Error("That shortcut no longer exists.");
        const url = normalizeUrl(
          cleanText(action.url, 8192),
          this.state.settings.searchEngine,
        );
        if (!isWebUrl(url)) throw new Error("Only web pages can be bookmarked.");
        if (
          this.state.bookmarks.some(
            (item) => item.url === url && item.id !== bookmark.id,
          )
        )
          throw new Error("That page is already bookmarked.");
        bookmark.url = url;
        bookmark.title = cleanText(action.title) || url;
        break;
      }
      case "history:clear":
        this.state.history = [];
        break;
      case "import:apply": {
        const now = Date.now();
        const bookmarks: ImportedBookmark[] = importedPages(
          action.bookmarks,
          now,
        );
        for (const item of bookmarks) {
          if (this.state.bookmarks.length >= 1000) break;
          if (!this.state.bookmarks.some((entry) => entry.url === item.url))
            this.state.bookmarks.push({
              id: randomUUID(),
              url: item.url,
              title: item.title,
              createdAt: now,
            });
        }
        for (const item of importedPages(action.history, now)) {
          const existing = this.state.history.find(
            (entry) => entry.url === item.url,
          );
          if (!existing) {
            this.state.history.push({ id: randomUUID(), ...item });
            continue;
          }
          existing.visits = (existing.visits ?? 1) + item.visits;
          if (item.visitedAt > existing.visitedAt) {
            existing.visitedAt = item.visitedAt;
            existing.title = item.title;
          }
        }
        this.state.history.sort((a, b) => b.visitedAt - a.visitedAt);
        this.state.history = this.state.history.slice(0, 1000);
        break;
      }
      case "settings:update":
        this.state.settings = validSettings(
          action.settings,
          this.state.settings,
        );
        nativeTheme.themeSource = this.state.settings.theme;
        break;
      case "download:show": {
        const download = this.state.downloads.find(
          (item) => item.id === action.id,
        );
        if (download?.path) shell.showItemInFolder(download.path);
        break;
      }
      case "page:find": {
        const text = cleanText(action.text, 1000);
        const contents = this.getWebContents(this.state.activeTabId);
        if (text) {
          contents?.findInPage(text, {
            forward: action.forward !== false,
            findNext:
              this.lastFind.text === text &&
              this.lastFind.tabId === this.state.activeTabId,
          });
          this.lastFind = { text, tabId: this.state.activeTabId };
        } else contents?.stopFindInPage("clearSelection");
        break;
      }
      case "page:stop-find":
        this.getWebContents(this.state.activeTabId)?.stopFindInPage(
          "clearSelection",
        );
        this.lastFind = { text: "", tabId: "" };
        break;
      case "page:zoom": {
        if (!["in", "out", "reset"].includes(action.direction))
          throw new Error("Invalid zoom direction.");
        const contents = this.getWebContents(this.state.activeTabId);
        if (contents)
          contents.setZoomLevel(
            action.direction === "reset"
              ? 0
              : Math.max(
                  -5,
                  Math.min(
                    7,
                    contents.getZoomLevel() +
                      (action.direction === "in" ? 1 : -1),
                  ),
                ),
          );
        break;
      }
      case "page:devtools":
        this.getWebContents(this.state.activeTabId)?.openDevTools({
          mode: "detach",
        });
        break;
      case "page:screenshot": {
        const contents = this.getWebContents(this.state.activeTabId);
        if (contents) {
          const capture = await contents.capturePage();
          const { canceled, filePath } = await dialog.showSaveDialog(
            this.window,
            {
              title: "Save page screenshot",
              defaultPath: join("Kamapathy-screenshot.png"),
              filters: [{ name: "PNG image", extensions: ["png"] }],
            },
          );
          if (!canceled && filePath) {
            await writeFile(filePath, capture.toPNG());
            this.addActivity(
              this.state.activeSpaceId,
              "Page screenshot saved.",
              "success",
            );
          }
        }
        break;
      }
      default:
        throw new Error("Unknown browser action.");
    }
    return this.emit();
  }

  private bindShortcuts(contents: WebContents): void {
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const key = input.key.toLowerCase();
      const primary =
        process.platform === "darwin" ? input.meta : input.control;
      let shortcut: string | undefined;
      if (primary && !input.alt) {
        if (key === "t") shortcut = input.shift ? "reopen-tab" : "new-tab";
        if (key === "w") shortcut = "close-tab";
        if (key === "l") shortcut = "address";
        if (key === "k") shortcut = "command";
        if (key === "f") shortcut = "find";
        if (key === "d") shortcut = "bookmark";
        if (key === ",") shortcut = "settings";
        if (key === "r") shortcut = "reload";
        if (key === "b" && input.shift) shortcut = "bookmarks";
        if (key === (process.platform === "darwin" ? "y" : "h"))
          shortcut = "history";
        if (key === "j" && input.shift) shortcut = "downloads";
        if (key === "\\") shortcut = "split";
        if (input.shift && key === "]") shortcut = "next-tab";
        if (input.shift && key === "[") shortcut = "previous-tab";
        if (["+", "=", "-", "0"].includes(key)) {
          event.preventDefault();
          void this.dispatch({
            type: "page:zoom",
            direction: key === "0" ? "reset" : key === "-" ? "out" : "in",
          });
          return;
        }
      }
      if (input.control && key === "tab")
        shortcut = input.shift ? "previous-tab" : "next-tab";
      if (key === "f5") shortcut = "reload";
      if (key === "f12") {
        event.preventDefault();
        void this.dispatch({ type: "page:devtools" });
        return;
      }
      if (input.alt && (key === "arrowleft" || key === "arrowright")) {
        event.preventDefault();
        void this.dispatch({
          type: key === "arrowleft" ? "tab:back" : "tab:forward",
          id: this.state.activeTabId,
        });
        return;
      }
      if (primary && !input.shift && (key === "[" || key === "]")) {
        event.preventDefault();
        void this.dispatch({
          type: key === "[" ? "tab:back" : "tab:forward",
          id: this.state.activeTabId,
        });
        return;
      }
      if (shortcut && !this.window.isDestroyed()) {
        event.preventDefault();
        this.window.webContents.focus();
        this.window.webContents.send("kamapathy:shortcut", shortcut);
      }
    });
  }

  dispose(): void {
    if (this.destroyed) return;
    clearTimeout(this.saveTimer);
    this.persist();
    this.destroyed = true;
    for (const id of this.views.keys()) this.destroyTab(id);
    for (const cleanup of this.sessionCleanups.values()) cleanup();
    this.sessionCleanups.clear();
    this.sessions.clear();
    this.listeners.clear();
    this.viewListeners.clear();
  }
}
