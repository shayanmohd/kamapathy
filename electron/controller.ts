import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  nativeImage,
  nativeTheme,
  screen,
  session,
  shell,
  webContents,
  WebContentsView,
} from "electron";
import type { NativeImage, Session, WebContents } from "electron";
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_TEXT_LIMITS, cleanAgentText } from "../shared/agent-text";
import { isPermissionKey } from "../shared/permissions";
import {
  agentRules,
  HOME_URL,
  newTab,
  openingTab,
  PAGE_BUDGET,
  patchTask,
} from "../shared/state";
import { extensionIdOf } from "../shared/extensions";
import {
  extensionId,
  fileKind,
  googleSignInFallback,
  isExternalAppUrl,
  isFileUrl,
  isPopupUrl,
  isWebUrl,
  normalizeUrl,
  URL_MESSAGES,
} from "../shared/url";
import type { UrlOptions } from "../shared/url";
import type {
  Activity,
  AgentTask,
  BrowserAction,
  BrowserState,
  ClearSiteDataApproval,
  ClosedBy,
  ContentBounds,
  FrozenFrame,
  HoldReason,
  ImportedBookmark,
  ImportedVisit,
  PasswordPrompt,
  SignIns,
  Space,
  SpaceColor,
  SpaceRequest,
  Tab,
  UpdateState,
} from "../shared/types";
import { inputMarker } from "./agent/input/marker";
import { activeSpace } from "./agent/authority";
import { CursorOverlay, type CursorPoint } from "./agent/cursor";
import { PDF_VIEWER_ID } from "./agent/session/frames";
import { TabRegistry } from "./agent/tab-registry";
import { CaptureHost } from "./capture-host";
import {
  defaultBrowserStatus,
  electronDefaultBrowserEnv,
} from "./default-browser";
import type { CookieOutcome, ProfileCookies } from "./import";
import { validSettings, writeState } from "./persistence";
import { createPromptCenter, type PromptCenter } from "./prompts";

// Local markup files run without scripts; everything else is a web view.
export type ViewKind = "web" | "markup";

const colors: SpaceColor[] = ["green", "blue", "orange", "purple"];
// Spaces that share sign-ins use the first space's partition, so sign-ins
// made before shared sessions carry over.
export const SHARED_PARTITION = "persist:space-personal";

// The person's extensions load into persistent sessions as the controller
// creates them, and unload before a partition is discarded.
export interface ExtensionSessions {
  attach(partition: string, ses: Session): Promise<void>;
  detach(partition: string): void;
  loadedIds(partition: string): ReadonlySet<string>;
  // Undefined when the URL isn't an extension page.
  permissionFor(
    partition: string,
    requestingUrl: string,
    permission: string,
  ): boolean | undefined;
  // The action popup or an extension window.
  isExtensionSurface(contents: WebContents): boolean;
}
export const NO_EXTENSIONS: ExtensionSessions = {
  attach: async () => {},
  detach: () => {},
  loadedIds: () => new Set(),
  permissionFor: () => undefined,
  isExtensionSurface: () => false,
};
// Where openExtensionTab puts a tab: shown unless active is false, at index
// in the space's tab strip, else last.
export interface ExtensionTabOptions {
  active?: boolean;
  index?: number;
  pinned?: boolean;
}
// The sessions restored tabs open in: the shared one and each personal
// space's with separate sign-ins.
export function restoredPartitions(state: BrowserState): string[] {
  return [
    ...new Set([
      SHARED_PARTITION,
      ...state.spaces
        .filter(
          (space) => space.kind === "personal" && space.signIns === "separate",
        )
        .map((space) => `persist:space-${space.id}`),
    ]),
  ];
}
// What a tab may load: a web page, or the blank page agents may open. The
// agent server checks the address it is given before it reaches here.
const isLoadable = (url: string): boolean =>
  isWebUrl(url) || url === "about:blank";
const cleanText = (value: unknown, maximum = 300): string => {
  if (typeof value !== "string" || value.length > maximum)
    throw new Error("Invalid text value.");
  return value.trim();
};
// What a modifier click asks Kamapathy to load, or nothing when its body
// cannot be sent as it came.
function popupLoadOptions({
  referrer,
  postBody,
}: Electron.HandlerDetails): Electron.LoadURLOptions | undefined {
  const options: Electron.LoadURLOptions = { httpReferrer: referrer };
  if (!postBody) return options;
  if (
    !["application/x-www-form-urlencoded", "multipart/form-data"].includes(
      postBody.contentType,
    ) ||
    /[\r\n]/.test(postBody.boundary || "")
  )
    return undefined;
  options.postData = postBody.data;
  options.extraHeaders = `Content-Type: ${postBody.contentType}${postBody.boundary ? `; boundary=${postBody.boundary}` : ""}`;
  return options;
}
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
// How long a reveal waits for the revealed page to draw.
const REVEAL_FRAME_TIMEOUT = 500;
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

export interface ControllerOptions {
  // Absolute path of out/preload/forms.cjs, the password form preload.
  framePreload?: string;
}

export class BrowserController {
  readonly state: BrowserState;
  readonly registry = new TabRegistry(() => this.state);
  /** Every request only the person can answer, and their saved decisions. */
  readonly prompts: PromptCenter;
  private views = new Map<string, WebContentsView>();
  // Sessions and their cleanups are keyed by partition.
  private sessions = new Map<string, Session>();
  private sessionCleanups = new Map<string, () => void>();
  private discards = new Map<string, Promise<void>>();
  private pendingLoads = new Map<string, symbol>();
  private listeners = new Set<(state: BrowserState) => void>();
  private viewListeners = new Set<
    (tabId: string, contents: WebContents) => void
  >();
  private blockedRedirects = new Set<(tabId: string, url: string) => void>();
  private downloadStarts = new Set<(tabId: string) => void>();
  private leaveGuards = new Set<(tabId: string, at: number) => void>();
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
  private updateTimer?: NodeJS.Timeout;
  private updateSentAt = 0;
  private destroyed = false;
  private runId = randomUUID();
  private lastFind = { text: "", tabId: "" };
  private splitLeadingTabId: string | null = null;
  private frozen = false;
  private background = false;
  private captures = new Map<string, string>();
  // The extension ids each session loaded. Section 17 supplies them.
  private extensionLookup: (partition: string) => readonly string[] = () => [];
  private viewKinds = new Map<string, ViewKind>();
  // Pages showing an "Open <App>?" box, by contents id.
  private externalPrompts = new Set<number>();
  // Space ids, most recently active first.
  private recentSpaces: string[];
  private captureHost: CaptureHost;
  private overlay: CursorOverlay;
  // The agent server's download decision, asked before a space that follows
  // agent rules refuses a download.
  private downloadDecider?: (
    contents: WebContents,
    item: Electron.DownloadItem,
  ) => { captured: true; id: string } | { captured: false };

  constructor(
    readonly window: BrowserWindow,
    state: BrowserState,
    private statePath: string,
    private options: ControllerOptions = {},
    private extensions: ExtensionSessions = NO_EXTENSIONS,
  ) {
    this.captureHost = new CaptureHost(window);
    this.state = state;
    this.recentSpaces = [state.activeSpaceId];
    this.prompts = createPromptCenter({
      state: this.state,
      spaceOf: (contents) => this.spaceOf(contents),
      tabOf: (contents) => this.tabOf(contents),
      agentControlled: (tabId) => this.agentControlled(tabId),
      contentsForFrame: (frame) => {
        try {
          return frame ? (webContents.fromFrame(frame) ?? null) : null;
        } catch {
          return null;
        }
      },
      holdForPerson: (spaceId, reason, prompt) =>
        this.holdForPerson(spaceId, reason, prompt),
      releaseHold: (holdId) => this.releaseHold(holdId),
      addActivity: (spaceId, message, kind) =>
        this.addActivity(spaceId, message, kind),
      emit: () => {
        this.emit();
      },
    });
    // Restored tabs are the person's.
    for (const tab of state.tabs)
      this.registry.register(tab, { openedBy: "person", managed: false });
    // A restored page of an extension that didn't load in its space's
    // session, such as one removed since, comes back as a new tab.
    for (const tab of state.tabs) {
      const id = extensionIdOf(tab.url);
      const space = state.spaces.find((item) => item.id === tab.spaceId);
      if (id && !(space && this.extensionIds(space)?.has(id))) {
        tab.url = HOME_URL;
        tab.title = "New tab";
      }
    }
    nativeTheme.themeSource = state.settings.theme;
    this.overlay = new CursorOverlay({
      window,
      view: (tabId) => this.views.get(tabId),
      shows: (tabId) => this.cursorShows(tabId),
    });
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

  /** Section 17 reports which extension ids each session loaded; none until then. */
  setExtensionLookup(lookup: (partition: string) => readonly string[]): void {
    this.extensionLookup = lookup;
  }

  // The profile directory, which the agent server keeps armed downloads
  // under. The state file lives in it.
  userDataPath(): string {
    return dirname(this.statePath);
  }

  onDownload(
    decide: (
      contents: WebContents,
      item: Electron.DownloadItem,
    ) => { captured: true; id: string } | { captured: false },
  ): () => void {
    this.downloadDecider = decide;
    return () => {
      if (this.downloadDecider === decide) delete this.downloadDecider;
    };
  }

  private emit(options: { save?: boolean } = {}): BrowserState {
    if (this.destroyed) return this.state;
    this.layout();
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed())
      this.window.webContents.send("kamapathy:state-changed", this.state);
    for (const listener of this.listeners) listener(this.state);
    if (options.save === false) return this.state;
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

  // A space's task, or nothing when no agent is at work in it.
  private taskOf(spaceId: string | undefined): AgentTask | undefined {
    if (!spaceId) return undefined;
    return this.state.spaces.find((space) => space.id === spaceId)?.task;
  }

  // The only writer of a space's task.
  setTask(
    spaceId: string,
    patch: Partial<AgentTask> | null,
  ): AgentTask | undefined {
    const space = this.getSpace(spaceId);
    if (patchTask(space, patch)) this.emit();
    return space.task;
  }

  addActivity(
    spaceId: string | undefined,
    message: string,
    kind: Activity["kind"] = "info",
    agentText?: string,
  ): void {
    // An entry about the agent carries what the agent said it was doing: the
    // label of the action it logs, or the status its run ended on. Kamapathy's
    // own notices and the person's entries carry none.
    const task = this.taskOf(spaceId);
    const text =
      agentText ??
      (message === "Agent finished"
        ? task?.status
        : message.startsWith("Agent ") && task?.label?.active
          ? task.label.text
          : undefined);
    this.state.activity.unshift({
      id: randomUUID(),
      spaceId,
      message: message.slice(0, 500),
      kind,
      time: Date.now(),
      ...(text ? { agentText: text.slice(0, AGENT_TEXT_LIMITS.message) } : {}),
    });
    this.state.activity = this.state.activity.slice(0, 100);
    this.emit();
  }

  // A download's progress would send hundreds of states a second, so only
  // the first in each second goes now and the last one follows it. Only a new
  // check result is worth saving.
  setUpdate(next: UpdateState): void {
    const previous = this.state.update;
    const save =
      previous.checkedAt !== next.checkedAt ||
      JSON.stringify(previous.latest) !== JSON.stringify(next.latest);
    const rest = (value: UpdateState) =>
      JSON.stringify({ ...value, progress: undefined });
    const onlyProgress = !save && rest(previous) === rest(next);
    this.state.update = next;
    const since = Date.now() - this.updateSentAt;
    if (onlyProgress && since < 1000) {
      if (!this.updateTimer)
        this.updateTimer = setTimeout(() => {
          this.updateTimer = undefined;
          this.updateSentAt = Date.now();
          this.emit({ save: false });
        }, 1000 - since);
      return;
    }
    clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.updateSentAt = Date.now();
    this.emit({ save });
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

  // The area the shell left for the pages, clamped to the window.
  private contentArea(): ContentBounds {
    const [windowWidth, windowHeight] = this.window.getContentSize();
    return {
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
    const area = this.contentArea();
    // While the window is hidden the person's pages stay closed; agents make
    // the pages they work in themselves.
    if (!this.background)
      for (const id of ids) {
        const tab = this.state.tabs.find((item) => item.id === id);
        if (tab && this.loadable(tab)) this.ensureView(tab);
      }
    for (const [id, view] of this.views) {
      // A view lent for a capture is the capture window's until it is back.
      if (this.captureHost.lends(view)) continue;
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
    this.overlay.refresh();
  }

  // Where the agent's cursor may show: over the page the person is looking
  // at, in a space an agent is working in, with the window in front of them.
  // A view lent to the capture window is not on this window's screen, so it
  // shows no cursor either.
  private cursorShows(tabId: string): boolean {
    // The window test a capture needs is this one: it exists, it is on
    // screen and it is not minimized.
    if (this.destroyed || !this.canCapturePage() || this.frozen) return false;
    if (!this.state.settings.automationEnabled) return false;
    const area = this.contentArea();
    if (area.hidden || area.width <= 0 || area.height <= 0) return false;
    const tab = this.state.tabs.find((item) => item.id === tabId);
    const space =
      tab && this.state.spaces.find((item) => item.id === tab.spaceId);
    if (
      !space ||
      space.id !== this.state.activeSpaceId ||
      !agentRules(space) ||
      space.access === "ended" ||
      space.owner !== "agent"
    )
      return false;
    const view = this.views.get(tabId);
    if (!view || this.captureHost.lends(view)) return false;
    return view.getVisible() === true;
  }

  /** The agent dispatched input at this point. Never throws. */
  reportPointer(tabId: string, point: CursorPoint, label?: string): void {
    this.overlay.point(tabId, point, label);
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

  // The extensions a space's session runs: those loaded in it and any a
  // lookup reports.
  private loadedExtensionIds(space: Space): ReadonlySet<string> {
    const partition = this.partitionFor(space);
    return new Set([
      ...this.extensions.loadedIds(partition),
      ...this.extensionLookup(partition),
    ]);
  }

  // The extensions whose pages a space shows: those its session runs, and
  // none for a space an agent can reach, whoever asks.
  private extensionIds(space: Space): ReadonlySet<string> | undefined {
    if (space.kind !== "personal" || agentRules(space)) return undefined;
    return this.loadedExtensionIds(space);
  }

  // What a space opens besides web pages. A space an agent can reach opens
  // neither files nor extension pages, whoever asks.
  private urlOptions(space: Space): UrlOptions {
    const ids = this.extensionIds(space);
    return ids ? { allowFile: true, extensionIds: [...ids] } : {};
  }

  private viewKind(url: string): ViewKind {
    return fileKind(url) === "markup" ? "markup" : "web";
  }

  // Web pages, the blank page agents may open, files, and pages of the
  // extensions the space runs.
  private acceptsUrl(space: Space, url: string): boolean {
    if (isLoadable(url)) return true;
    const options = this.urlOptions(space);
    if (isFileUrl(url)) return !!options.allowFile && !!fileKind(url);
    const id = extensionId(url);
    return !!id && !!options.extensionIds?.includes(id);
  }

  private loadable(tab: Tab): boolean {
    return this.acceptsUrl(this.getSpace(tab.spaceId), tab.url);
  }

  // The address the person asked the space to open, and for a file, one
  // that is there.
  private openTarget(space: Space, input: string): string {
    const url = normalizeUrl(
      input,
      this.state.settings.searchEngine,
      this.urlOptions(space),
    );
    if (isFileUrl(url)) {
      let found = false;
      try {
        found = statSync(fileURLToPath(url)).isFile();
      } catch {
        /* Missing or unreadable. */
      }
      if (!found) throw new Error(URL_MESSAGES.fileMissing);
    }
    return url;
  }

  // Whether url needs a view other than the tab's: scripts on or off, or a
  // file where the view shows other pages and the other way round. A tab's
  // history never mixes files with other pages, so an agent that gains its
  // space later has no way back into a file.
  private changesView(tab: Tab, url: string): boolean {
    return (
      this.viewKinds.get(tab.id) !== this.viewKind(url) ||
      isFileUrl(url) !== isFileUrl(tab.url)
    );
  }

  // Section 16.4 for navigations a page starts. A subframe cannot move to a
  // new tab, so there that counts as a refusal.
  private pageNavigation(
    tab: Tab,
    url: string,
    mainFrame: boolean,
  ): "allow" | "new-tab" | "external" | "refuse" {
    const space = this.getSpace(tab.spaceId);
    const inView = (allowed: boolean) =>
      !allowed
        ? "refuse"
        : !this.changesView(tab, url)
          ? "allow"
          : mainFrame
            ? "new-tab"
            : "refuse";
    // Popups may also show about:blank and web-origin blob: documents.
    if (tab.openedBy === "page" && !isWebUrl(url) && isPopupUrl(url))
      return "allow";
    if (isWebUrl(url)) return mainFrame ? inView(true) : "allow";
    if (isFileUrl(url))
      return inView(
        !!this.urlOptions(space).allowFile &&
          isFileUrl(tab.url) &&
          !!fileKind(url),
      );
    const id = extensionId(url);
    if (id) {
      // Chromium's PDF viewer loads the document in a frame of its own.
      if (!mainFrame && id === PDF_VIEWER_ID) return "allow";
      // An extension's frame stays in any page whose session runs it, an
      // agent's included, where agents never reach it (section 17). Its
      // pages open only where extensionIds allows them.
      return inView(
        mainFrame
          ? !!this.urlOptions(space).extensionIds?.includes(id)
          : this.loadedExtensionIds(space).has(id),
      );
    }
    // Chromium asks the permission handler before another app opens.
    if (isExternalAppUrl(url)) return agentRules(space) ? "refuse" : "external";
    // Pages embed about:, blob: and data: documents, which Chromium governs,
    // and a page may navigate itself to the blank page agents also open.
    if (!mainFrame && /^(about|blob|data):/i.test(url)) return "allow";
    return url === "about:blank" ? inView(true) : "refuse";
  }

  // The tab a page belongs to. Session handlers need it because spaces that
  // share sign-ins share the session.
  private tabOf(contents: WebContents | null): Tab | undefined {
    if (!contents) return undefined;
    for (const [id, view] of this.views)
      if (view.webContents === contents)
        return this.state.tabs.find((item) => item.id === id);
    return undefined;
  }

  // The space a page belongs to.
  private spaceOf(contents: WebContents | null): Space | undefined {
    const tab = this.tabOf(contents);
    return tab
      ? this.state.spaces.find((space) => space.id === tab.spaceId)
      : undefined;
  }

  private tabIdOf(contents: WebContents | null): string | undefined {
    if (!contents) return undefined;
    for (const [id, view] of this.views)
      if (view.webContents === contents) return id;
    return undefined;
  }

  // A listener the agent server set. One that throws must not stop the page.
  private notify<Arguments extends unknown[]>(
    listeners: Set<(...args: Arguments) => void>,
    ...args: Arguments
  ): void {
    for (const listener of listeners)
      try {
        listener(...args);
      } catch (error) {
        console.error(
          "Navigation listener failed:",
          error instanceof Error ? error.message : "Unknown error",
        );
      }
  }

  private sessionFor(partition: string): Session {
    const existing = this.sessions.get(partition);
    if (existing) return existing;
    const browsingSession = session.fromPartition(partition);
    this.sessions.set(partition, browsingSession);
    const isCurrentSession = () =>
      !this.destroyed && this.sessions.get(partition) === browsingSession;
    // Extension pages have no space, so the extensions answer first. The
    // page is the requesting URL, else the security or requesting origin,
    // else the contents' own URL.
    const extensionVerdict = (
      contents: WebContents | null,
      permission: string,
      urls: (string | undefined)[],
    ) =>
      this.extensions.permissionFor(
        partition,
        urls.find((url) => !!url) ??
          (contents && !contents.isDestroyed() ? contents.getURL() : ""),
        permission,
      );
    // Every permission request and check in this session goes to the
    // prompt center, which asks the person or holds the space for them.
    // The extensions still answer for their own pages, and a link to
    // another app is still the person's own box.
    const detachPrompts = this.prompts.attachSession(browsingSession, {
      verdict: extensionVerdict,
      openExternal: (contents, details, callback) => {
        const space = this.spaceOf(contents);
        if (
          !space ||
          agentRules(space) ||
          !isCurrentSession() ||
          !contents ||
          contents.isDestroyed() ||
          this.window.isDestroyed()
        ) {
          callback(false);
          return;
        }
        this.confirmOpenExternal(
          space,
          contents,
          details,
          callback,
          isCurrentSession,
        );
      },
    });
    const onDownload = (
      event: Electron.Event,
      item: Electron.DownloadItem,
      contents: WebContents,
    ) => {
      const downloaded = this.tabIdOf(contents);
      if (downloaded) this.notify(this.downloadStarts, downloaded);
      const space = this.spaceOf(contents);
      // An extension's popup and windows download like personal pages.
      // Anything else without a tab, such as a service worker, can't.
      const surface = !space && this.extensions.isExtensionSurface(contents);
      if (!surface && (!space || agentRules(space))) {
        // An agent that armed this download keeps it in its own folder; the
        // space refuses every other one, as it always has.
        const captured = (() => {
          if (!space || !this.downloadDecider) return false;
          try {
            return this.downloadDecider(contents, item).captured;
          } catch {
            // A decision that fails blocks the download, so no save dialog
            // ever reaches the person from an agent space.
            return false;
          }
        })();
        if (captured) return;
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
          space?.id,
          `${download.filename}: ${status}.`,
          status === "completed" ? "success" : "warning",
        );
      });
      this.emit();
    };
    browsingSession.on("will-download", onDownload);
    // The form preload stays for the session's life. Another window's
    // controller gets the same session, and Electron refuses an id twice.
    const { framePreload } = this.options;
    if (
      framePreload &&
      !browsingSession
        .getPreloadScripts()
        .some((script) => script.id === "kamapathy-forms")
    )
      browsingSession.registerPreloadScript({
        type: "frame",
        id: "kamapathy-forms",
        filePath: framePreload,
      });
    this.sessionCleanups.set(partition, () => {
      browsingSession.removeListener("will-download", onDownload);
      detachPrompts();
    });
    if (partition.startsWith("persist:"))
      void this.extensions
        .attach(partition, browsingSession)
        .catch(() => undefined);
    return browsingSession;
  }

  // A personal page's link to another app opens it only once the person
  // says so, every time, one box per page. Nothing is remembered.
  private confirmOpenExternal(
    space: Space,
    contents: WebContents,
    details: Electron.OpenExternalPermissionRequest,
    callback: (granted: boolean) => void,
    isCurrentSession: () => boolean,
  ): void {
    const url = details.externalURL ?? "";
    const requestingUrl = details.requestingUrl || contents.getURL();
    const name = isExternalAppUrl(url)
      ? app.getApplicationNameForProtocol(url)
      : "";
    const id = contents.id;
    // The box names the site that asks, so files and other pages never ask.
    if (!name || !isWebUrl(requestingUrl) || this.externalPrompts.has(id)) {
      callback(false);
      return;
    }
    this.externalPrompts.add(id);
    const requestedPageUrl = contents.getURL();
    let navigated = false;
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) navigated = true;
    };
    contents.on("did-start-navigation", onNavigation);
    void dialog
      .showMessageBox(this.window, {
        type: "question",
        title: "Open another app",
        message: `Open ${name}?`,
        detail: `${new URL(requestingUrl).origin} wants to open a link in ${name}.`,
        buttons: ["Cancel", "Open"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then(({ response }) =>
        callback(
          response === 1 &&
            !navigated &&
            isCurrentSession() &&
            this.state.spaces.includes(space) &&
            !agentRules(space) &&
            !contents.isDestroyed() &&
            !this.window.isDestroyed() &&
            contents.getURL() === requestedPageUrl,
        ),
      )
      .catch(() => callback(false))
      .finally(() => {
        this.externalPrompts.delete(id);
        contents.removeListener("did-start-navigation", onNavigation);
      });
  }

  // Removes everything sites stored in a partition only one space used. The
  // handlers come off first, so a space that reuses the partition meanwhile
  // gets its own.
  private discardPartition(partition: string): Promise<void> {
    const pending = this.discards.get(partition);
    if (pending) return pending;
    const oldSession = this.sessionFor(partition);
    // Extensions unload first, also when the session was only made here.
    this.extensions.detach(partition);
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

  // Offers to save or update a password, shown by the shell.
  setPasswordPrompts(prompts: PasswordPrompt[]): void {
    this.state.passwordPrompts = prompts;
    this.emit();
  }

  // Where a tab's page sits in the window, if it has a live view.
  viewPlacement(
    tabId: string,
  ): { bounds: Electron.Rectangle; visible: boolean } | undefined {
    const view = this.views.get(tabId);
    if (!view || view.webContents.isDestroyed()) return undefined;
    return { bounds: view.getBounds(), visible: view.getVisible() };
  }

  canCapturePage(): boolean {
    return (
      !this.window.isDestroyed() &&
      this.window.isVisible() &&
      !this.window.isMinimized()
    );
  }

  // Runs an agent's capture with Chromium painting the tab's view, in any
  // window state: the shown view of a window on screen where it is, every
  // other view lent to the capture window, since a hidden or minimized
  // window draws nothing. Nothing is shown or focused, and the active space
  // and the window keep their own state.
  async withVisibleView<T>(
    tabId: string,
    capture: () => Promise<T>,
  ): Promise<T> {
    const view = this.views.get(tabId);
    if (!view) return capture();
    if (view.getVisible() && this.canCapturePage()) return capture();
    try {
      return await this.captureHost.present(
        view,
        capture,
        () => this.views.get(tabId) === view && !this.destroyed,
      );
    } finally {
      this.layout();
    }
  }

  // The scale factor of the display the window is on.
  deviceScale(): number {
    return screen.getDisplayMatching(this.window.getBounds()).scaleFactor;
  }

  // Cuts a capture down to the size that was planned, from its top left.
  // Chromium rounds a clip's size down, so captures are asked for rounded
  // up and cropped here, never resized.
  cropPng(
    png: Buffer,
    width: number,
    height: number,
  ): { png: Buffer; width: number; height: number } | null {
    const image = nativeImage.createFromBuffer(png);
    if (image.isEmpty()) return null;
    const size = image.getSize();
    if (size.width === width && size.height === height)
      return { png, width, height };
    const cropped = {
      width: Math.min(width, size.width),
      height: Math.min(height, size.height),
    };
    return { png: image.crop({ x: 0, y: 0, ...cropped }).toPNG(), ...cropped };
  }

  // The pages keep showing until the renderer has drawn these captures in
  // their place and calls hidePages().
  async freeze(): Promise<FrozenFrame[]> {
    const { activeSpaceId, activeTabId } = this.state;
    const capturable = this.canCapturePage();
    const shown = [...this.views].filter(
      ([, view]) => view.getVisible() && !this.captureHost.lends(view),
    );
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

  // Closing the window keeps agents working, so the person's own pages close
  // as a real close would: nothing of theirs runs unseen, and each of their
  // spaces keeps what the next start would give it. Spaces an agent may use
  // keep their tabs and their pages.
  enterBackground(): void {
    if (this.destroyed) return;
    this.background = true;
    for (const space of this.state.spaces) {
      if (agentRules(space)) continue;
      const tabs = this.state.tabs.filter((tab) => tab.spaceId === space.id);
      for (const tab of tabs) {
        this.destroyTab(tab.id);
        // A page closed mid-load reports no end of its own.
        tab.loading = false;
      }
      if (this.state.settings.restoreSession) continue;
      for (const tab of tabs) this.registry.retire(tab, "person");
      const replacement = newTab(space.id);
      this.registry.register(replacement, {
        openedBy: "person",
        managed: false,
      });
      this.state.tabs = this.state.tabs.filter(
        (tab) => tab.spaceId !== space.id,
      );
      this.state.tabs.push(replacement);
      this.lastActive.delete(space.id);
      if (this.state.activeSpaceId === space.id)
        this.state.activeTabId = replacement.id;
    }
    this.emit();
  }

  // The window is visible again. The pages it shows are laid out, and the
  // person's others are made again as they open them.
  leaveBackground(): void {
    if (this.destroyed) return;
    this.background = false;
    this.layout();
  }

  async thumbnails(): Promise<Record<string, string>> {
    if (this.canCapturePage())
      await Promise.all(
        this.state.spaces
          .filter(agentRules)
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

  shownTab(spaceId: string): Tab | undefined {
    if (spaceId === this.state.activeSpaceId)
      return this.state.tabs.find((tab) => tab.id === this.state.activeTabId);
    return openingTab(this.state, spaceId, this.lastActive.get(spaceId));
  }

  // Makes the tab's own space show it, then waits for its next rendered
  // frame. The active space, the window and keyboard focus never change, so
  // this is not activate(): a space the person is not looking at only
  // changes the tab it opens on.
  async showAgentTab(tabId: string): Promise<void> {
    const tab = this.state.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const space = this.state.spaces.find((item) => item.id === tab.spaceId);
    // A space no agent may use now is never revealed.
    if (!space || !agentRules(space) || space.access === "ended") return;
    if (tab.spaceId !== this.state.activeSpaceId) {
      if (this.lastActive.get(tab.spaceId) === tab.id) return;
      this.lastActive.set(tab.spaceId, tab.id);
      this.emit();
      return;
    }
    if (tab.id === this.state.activeTabId || tab.id === this.state.splitTabId)
      return;
    // As in activate(), the leading pane follows the tab that was active;
    // the other pane stays where the person put it.
    if (this.splitLeadingTabId === this.state.activeTabId)
      this.splitLeadingTabId = tab.id;
    this.state.activeTabId = tab.id;
    this.lastActive.set(tab.spaceId, tab.id);
    this.emit();
    await this.nextFrame(tab.id);
  }

  // The page the person now looks at gets to draw before the agent's next
  // step. A window that cannot composite reports no frames at all, as a
  // probe confirmed, so a hidden window and a page that is not showing wait
  // for nothing.
  private nextFrame(tabId: string): Promise<void> {
    const view = this.views.get(tabId);
    const contents = view?.webContents;
    if (
      !view ||
      !contents ||
      contents.isDestroyed() ||
      !view.getVisible() ||
      !this.canCapturePage()
    )
      return Promise.resolve();
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          contents.endFrameSubscription();
        } catch {
          // A page that went away needs no unsubscribing.
        }
        resolve();
      };
      const timer = setTimeout(finish, REVEAL_FRAME_TIMEOUT);
      try {
        contents.beginFrameSubscription(false, () => finish());
      } catch {
        finish();
      }
    });
  }

  // Tabs and the popups their pages open share these. A popup's session is
  // its opener's, so the session is given apart from them.
  private pageWebPreferences(
    space: Space,
    kind: ViewKind = "web",
  ): Electron.WebPreferences {
    return {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Runs the session's form preload in subframes too, still sandboxed.
      nodeIntegrationInSubFrames: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      focusOnNavigation: false,
      spellcheck: true,
      backgroundThrottling: !agentRules(space),
      // Pages from files may read other local files, so local markup runs
      // no scripts. Saying so for web views keeps a popup from copying its
      // opener's setting.
      javascript: kind === "web",
    };
  }

  private ensureView(
    tab: Tab,
    loadOptions?: Electron.LoadURLOptions,
  ): WebContentsView {
    const existing = this.views.get(tab.id);
    if (existing) return existing;
    const view = this.createView(tab);
    this.load(tab, view.webContents, loadOptions);
    return view;
  }

  // A hidden view for the tab, wired before anything loads in it. A popup
  // brings the contents Chromium made for it. A view made around contents
  // replaces their preferences with its own, so it is given the page ones
  // again.
  private createView(tab: Tab, webContents?: WebContents): WebContentsView {
    const space = this.getSpace(tab.spaceId);
    const kind = webContents ? "web" : this.viewKind(tab.url);
    const view = webContents
      ? new WebContentsView({
          webContents,
          webPreferences: this.pageWebPreferences(space),
        })
      : new WebContentsView({
          webPreferences: {
            session: this.sessionFor(this.partitionFor(space)),
            ...this.pageWebPreferences(space, kind),
          },
        });
    this.views.set(tab.id, view);
    this.viewKinds.set(tab.id, kind);
    this.window.contentView.addChildView(view);
    // A page view joins the window on top, so the cursor goes back above it.
    this.overlay.raise();
    // An agent page is made at the size the content area has now, so a page
    // the person is not looking at reports the viewport it will have when
    // they are, and a first reveal does not reflow it. Without an area to
    // copy, pages keep the size they have always had.
    const { x, y, width, height, hidden } = this.contentArea();
    view.setBounds(
      agentRules(space) && !hidden && width > 0 && height > 0
        ? { x, y, width, height }
        : { x: 0, y: 0, width: 1200, height: 800 },
    );
    view.setVisible(false);
    view.setBorderRadius(10);
    this.wireView(tab, view);
    return view;
  }

  // A page opened a popup. Chromium makes its contents, except for modifier
  // clicks, which Kamapathy loads itself. Either way it joins the opener's
  // space as a tab.
  private adoptPopup(
    opener: Tab,
    details: Electron.HandlerDetails,
    guest: WebContents | undefined,
  ): WebContents {
    const space = this.getSpace(opener.spaceId);
    const opened = newTab(space.id, details.url);
    this.registry.register(opened, {
      openedBy: "page",
      openerId: opener.id,
      managed:
        !!opener.managed &&
        space.owner === "agent" &&
        agentRules(space) &&
        space.access !== "ended",
    });
    this.state.tabs.push(opened);
    if (!agentRules(space)) this.activate(opened);
    const view = this.createView(opened, guest);
    if (!guest) {
      const options = isWebUrl(details.url)
        ? popupLoadOptions(details)
        : undefined;
      if (options) this.load(opened, view.webContents, options);
      // Loaded by Kamapathy, other URLs would run outside their opener.
      else
        setTimeout(() => {
          if (this.views.get(opened.id) !== view) return;
          this.removeTab(opened, "page");
          this.emit();
        });
    }
    this.emit();
    return view.webContents;
  }

  private wireView(tab: Tab, view: WebContentsView): void {
    const space = this.getSpace(tab.spaceId);
    const contents = view.webContents;
    // Popups may also show about:blank and web-origin blob: documents.
    const allowed = (url: string) =>
      tab.openedBy === "page" ? isPopupUrl(url) : this.acceptsUrl(space, url);
    // Chromium reports a navigation before will-navigate can refuse it or
    // move it to a new tab, so the tab follows only those this view keeps.
    const follows = (url: string) =>
      allowed(url) && !this.changesView(tab, url);
    // Chromium paints nothing for a page that was never shown, so an agent
    // page nobody is watching would run no animations, accept no native
    // input and have nothing to capture. Each new document starts hidden,
    // and agent rules can start or end while the page is open.
    const keepPainting = () => {
      if (agentRules(space) && !contents.isDestroyed())
        contents.setBackgroundThrottling(false);
    };
    keepPainting();
    contents.on("did-navigate", keepPainting);
    const isCurrentView = () =>
      !this.destroyed &&
      !contents.isDestroyed() &&
      this.views.get(tab.id) === view &&
      this.state.tabs.includes(tab);
    this.bindShortcuts(contents);
    // The Bluetooth chooser is the page's own event, not the session's.
    this.prompts.attachBluetooth(contents);
    // A server or proxy asked for a name and password. Electron's default
    // cancels every challenge the prompt center does not take.
    contents.on("login", (event, details, authInfo, callback) => {
      if (this.prompts.tabLogin(contents, details, authInfo, callback))
        event.preventDefault();
    });
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
      // split pane. A physical click must still update the browser controls,
      // while a click an agent sent changes no pane.
      if (inputMarker.busy(contents)) return;
      inputMarker.humanInput(contents);
      if (input.type === "mouseDown" && space.owner === "human")
        activateFocusedPane();
    });
    contents.setWindowOpenHandler((details) => {
      if (
        !isCurrentView() ||
        !isPopupUrl(details.url) ||
        this.state.tabs.length >= 200
      )
        return { action: "deny" };
      if (
        agentRules(space) &&
        this.state.tabs.filter((item) => item.spaceId === space.id).length >= 20
      ) {
        this.addActivity(
          space.id,
          "A popup was blocked. This space has 20 tabs.",
          "warning",
        );
        return { action: "deny" };
      }
      return {
        action: "allow",
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          show: false,
          webPreferences: this.pageWebPreferences(space),
        },
        createWindow: (options) =>
          this.adoptPopup(
            tab,
            details,
            (options as { webContents?: WebContents }).webContents,
          ),
      };
    });
    contents.on("will-navigate", (event, url) => {
      const decision = isCurrentView()
        ? this.pageNavigation(tab, url, true)
        : "refuse";
      if (decision === "allow" || decision === "external") return;
      event.preventDefault();
      if (decision === "new-tab") {
        void this.dispatch({
          type: "tab:create",
          url,
          spaceId: tab.spaceId,
        }).catch(() => undefined);
        return;
      }
      // A popup refused its first document would stay an empty tab.
      if (tab.openedBy === "page" && contents.getURL() === "")
        setTimeout(() => {
          if (!isCurrentView() || contents.getURL() !== "") return;
          this.removeTab(tab, "page");
          this.emit();
        });
    });
    // Main frames are will-navigate's.
    contents.on("will-frame-navigate", (event) => {
      if (event.isMainFrame) return;
      const decision = isCurrentView()
        ? this.pageNavigation(tab, event.url, false)
        : "refuse";
      if (decision !== "allow" && decision !== "external")
        event.preventDefault();
    });
    // No redirect reaches a file or an extension page.
    contents.on("will-redirect", (event, url) => {
      if (isLoadable(url) || (isExternalAppUrl(url) && !agentRules(space)))
        return;
      event.preventDefault();
      this.notify(this.blockedRedirects, tab.id, url);
    });
    // A page asking to stay. Under agent control the page leaves and the
    // running operation reports the override; the person is asked instead,
    // unless they are looking at another tab or window.
    contents.on("will-prevent-unload", (event) => {
      if (!isCurrentView()) return;
      if (activeSpace(space) && space.owner === "agent") {
        event.preventDefault();
        this.notify(this.leaveGuards, tab.id, Date.now());
        this.addActivity(
          tab.spaceId,
          "Agent left a page that asked it to stay",
          "info",
        );
        return;
      }
      // The window test a capture uses: nothing is shown over a hidden or
      // minimized window, and a background tab keeps its page.
      if (
        !this.canCapturePage() ||
        this.shownTab(this.state.activeSpaceId)?.id !== tab.id
      )
        return;
      const answer = dialog.showMessageBoxSync(this.window, {
        type: "question",
        message: "Leave site?",
        detail: "Changes you made may not be saved.",
        buttons: ["Leave", "Stay"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (answer === 0) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("did-start-navigation", (details) => {
      if (!isCurrentView() || !details.isMainFrame || !follows(details.url))
        return;
      tab.url = details.url;
      delete tab.error;
      delete tab.crashed;
      if (!details.isSameDocument) {
        tab.title = details.url;
        delete tab.favicon;
      }
      this.emit();
    });
    contents.on("did-redirect-navigation", (details) => {
      if (!isCurrentView() || !details.isMainFrame || !follows(details.url))
        return;
      tab.url = details.url;
      this.emit();
    });
    const updateNavigation = () => {
      if (!isCurrentView()) return;
      const url = contents.getURL();
      if (allowed(url) && !tab.error) tab.url = url;
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
      if (latest && !agentRules(space)) latest.title = tab.title;
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
          (allowed(url) && url !== tab.url)
        )
          return;
        tab.loading = false;
        tab.error = description || "This page could not be loaded.";
        this.emit();
      },
    );
    contents.on("render-process-gone", (_event, details) => {
      if (!isCurrentView()) return;
      // One entry per crash, for a space an agent is working in; the flag
      // itself keeps a second crash of the same page quiet.
      const log = !tab.crashed && agentRules(space) && space.owner === "agent";
      tab.loading = false;
      tab.crashed = true;
      tab.error = `The page process stopped (${details.reason}). Reload to try again.`;
      if (log)
        this.addActivity(
          space.id,
          "A page stopped working in this space",
          "warning",
        );
      else this.emit();
    });
    contents.on("context-menu", (_event, params) => {
      // No native menu follows a right click an agent sent, until the
      // person's own input arrives.
      if (inputMarker.pointerRecent(contents)) return;
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
    // A page that closes itself leaves its view in the window without
    // contents, so the view goes and so does its tab. Kamapathy's own
    // closes take the view out of the map first.
    contents.once("destroyed", () => {
      if (
        this.destroyed ||
        this.views.get(tab.id) !== view ||
        !this.state.tabs.includes(tab)
      )
        return;
      this.views.delete(tab.id);
      this.viewKinds.delete(tab.id);
      this.pendingLoads.delete(tab.id);
      if (!this.window.isDestroyed())
        this.window.contentView.removeChildView(view);
      this.removeTab(tab, "page");
      this.emit();
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
  }

  private load(
    tab: Tab,
    contents: WebContents,
    options?: Electron.LoadURLOptions,
  ): void {
    if (!this.loadable(tab)) return;
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
    if (agentRules(this.getSpace(tab.spaceId)) || !isWebUrl(tab.url)) return;
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
    this.recentSpaces = [
      tab.spaceId,
      ...this.recentSpaces.filter((id) => id !== tab.spaceId),
    ].slice(0, 30);
  }

  private destroyTab(id: string): void {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    this.viewKinds.delete(id);
    this.pendingLoads.delete(id);
    // A view lent for a capture leaves the capture window with its tab.
    this.captureHost.remove(view);
    if (!this.window.isDestroyed())
      this.window.contentView.removeChildView(view);
    // A page that closed itself leaves its view without contents.
    const contents = view.webContents as WebContents | undefined;
    if (contents && !contents.isDestroyed())
      contents.close({ waitForBeforeUnload: false });
  }

  createAgentSpace(
    name: string,
    {
      color = "purple",
      isolated = false,
      pageBudget,
      createdBy = "agent",
    }: {
      color?: SpaceColor;
      isolated?: boolean;
      pageBudget?: number;
      createdBy?: "agent" | "person";
    } = {},
  ): Space {
    if (this.destroyed) throw new Error("Browser is closing.");
    if (this.state.spaces.length >= 30)
      throw new Error("The maximum of 30 spaces has been reached.");
    if (this.state.tabs.length >= 200)
      throw new Error("The maximum of 200 tabs has been reached.");
    const space: Space = {
      id: randomUUID(),
      name: cleanAgentText(cleanText(name, 48)) || "Agent space",
      color: colors.includes(color) ? color : "purple",
      kind: "agent",
      owner: "agent",
      signIns:
        isolated || this.state.settings.isolateAgentSpaces
          ? "separate"
          : "shared",
      createdAt: Date.now(),
      createdBy,
      pageBudget: pageBudget ?? PAGE_BUDGET,
    };
    // A space an agent creates is granted to it from the start.
    if (createdBy === "agent") space.access = "granted";
    this.state.spaces.push(space);
    const tab = newTab(space.id);
    this.registry.register(tab, {
      openedBy: createdBy,
      managed: createdBy === "agent",
    });
    this.state.tabs.push(tab);
    this.addActivity(
      space.id,
      space.signIns === "shared"
        ? `${space.name} started with your sign-ins.`
        : `${space.name} started in an isolated session.`,
      "info",
    );
    return space;
  }

  // A tab the agent manages, opened in the background. Routes check the page
  // budget and the limit per space; only the overall limit is checked here.
  openAgentTab(spaceId: string, url?: string): Tab {
    if (this.destroyed) throw new Error("Browser is closing.");
    if (this.state.tabs.length >= 200)
      throw new Error("The maximum of 200 tabs has been reached.");
    const space = this.getSpace(spaceId);
    const requested = url === undefined ? "" : cleanText(url, 8192);
    const tab = newTab(
      space.id,
      requested === "about:blank"
        ? requested
        : normalizeUrl(requested, this.state.settings.searchEngine),
    );
    this.registry.register(tab, { openedBy: "agent", managed: true });
    this.state.tabs.push(tab);
    if (isLoadable(tab.url)) this.ensureView(tab);
    this.emit();
    return tab;
  }

  /** The personal space no agent can reach, where help links and links from
   *  other apps open. */
  incomingSpace(): Space {
    const reachable = (space: Space | undefined): space is Space =>
      space?.kind === "personal" && space.access !== "granted";
    // The active space, else the one used last, else any the person has
    // not used since Kamapathy started.
    const known =
      [this.state.activeSpaceId, ...this.recentSpaces]
        .map((id) => this.state.spaces.find((space) => space.id === id))
        .find(reachable) ?? this.state.spaces.find(reachable);
    if (known) return known;
    if (this.state.spaces.length >= 30)
      throw new Error("The maximum of 30 spaces has been reached.");
    if (this.state.tabs.length >= 200)
      throw new Error("The maximum of 200 tabs has been reached.");
    const space: Space = {
      id: randomUUID(),
      name: "Personal",
      color: "green",
      kind: "personal",
      owner: "human",
      signIns: "shared",
      createdAt: Date.now(),
      createdBy: "person",
    };
    this.state.spaces.push(space);
    const tab = newTab(space.id);
    this.registry.register(tab, { openedBy: "person", managed: false });
    this.state.tabs.push(tab);
    this.emit();
    return space;
  }

  // Not a BrowserAction: only the agent server navigates an agent tab. The
  // tab is updated as tab:navigate updates it, except that the address is
  // loaded as given, so about:blank never reaches the search engine.
  navigateAgentTab(
    tabId: string,
    url: string,
    options: { referer?: string } = {},
  ): void {
    const tab = this.getTab(tabId);
    if (!isLoadable(url)) throw new Error("This address cannot be opened.");
    tab.url = url;
    tab.title = url;
    delete tab.favicon;
    delete tab.error;
    const loadOptions: Electron.LoadURLOptions | undefined = options.referer
      ? { httpReferrer: { url: options.referer, policy: "unsafe-url" } }
      : undefined;
    const view = this.views.get(tab.id);
    if (view) this.load(tab, view.webContents, loadOptions);
    else this.ensureView(tab, loadOptions);
    this.emit();
  }

  // The tab:reload path, past the cache with ignoreCache. Not a
  // BrowserAction either.
  reloadAgentTab(tabId: string, options: { ignoreCache?: boolean } = {}): void {
    const tab = this.getTab(tabId);
    const contents = this.getWebContents(tab.id);
    if (contents) this.reloadTab(tab, contents, options.ignoreCache === true);
  }

  // A server redirect the agent URL rule cancelled.
  onBlockedRedirect(
    listener: (tabId: string, url: string) => void,
  ): () => void {
    this.blockedRedirects.add(listener);
    return () => this.blockedRedirects.delete(listener);
  }

  // A download the session started for a tab, before any refusal.
  onDownloadStarted(listener: (tabId: string) => void): () => void {
    this.downloadStarts.add(listener);
    return () => this.downloadStarts.delete(listener);
  }

  // A leave guard this agent overrode, with the moment it happened.
  onLeaveGuard(listener: (tabId: string, at: number) => void): () => void {
    this.leaveGuards.add(listener);
    return () => this.leaveGuards.delete(listener);
  }

  // A failed load is retried by loading its URL again, as before.
  private reloadTab(
    tab: Tab,
    contents: WebContents,
    ignoreCache = false,
  ): void {
    if (tab.error) this.load(tab, contents);
    else if (ignoreCache) contents.reloadIgnoringCache();
    else contents.reload();
  }

  /** Opens each URL as the person's tab in incomingSpace(), the last one active,
   *  then restores, shows and focuses the window. */
  openIncoming(urls: readonly string[]): void {
    if (this.destroyed) throw new Error("Browser is closing.");
    const space = this.incomingSpace();
    let last: Tab | undefined;
    for (const input of urls) {
      if (this.state.tabs.length >= 200) break;
      // Other apps hand over web pages and files, nothing else.
      if (!isWebUrl(input) && !isFileUrl(input)) continue;
      let url: string;
      try {
        url = this.openTarget(space, input);
      } catch {
        // Such as a file removed since it was handed over.
        continue;
      }
      const tab = newTab(space.id, url);
      this.registry.register(tab, { openedBy: "person", managed: false });
      this.state.tabs.push(tab);
      if (this.loadable(tab)) this.ensureView(tab);
      last = tab;
    }
    if (last) this.activate(last);
    this.emit();
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  /** Writes imported sign-ins into the shared session, or into one new
   *  personal space per profile with sign-ins of its own. */
  async applyImportedCookies(
    target: "shared" | "separate",
    profiles: readonly ProfileCookies[],
  ): Promise<CookieOutcome> {
    const outcome: CookieOutcome = {
      written: 0,
      failed: 0,
      spaces: [],
      warnings: [],
    };
    const saved = (store: Session, details: Electron.CookiesSetDetails) =>
      store.cookies.set(details).then(
        () => true,
        () => false,
      );
    const write = async (store: Session, cookies: ProfileCookies["cookies"]) => {
      for (const details of cookies) {
        // A refused cookie is tried once more without its SameSite value.
        const { sameSite, ...rest } = details;
        if (
          (await saved(store, details)) ||
          (sameSite !== undefined && (await saved(store, rest)))
        )
          outcome.written++;
        else outcome.failed++;
      }
      await store.cookies.flushStore();
    };
    if (target === "shared")
      await write(
        this.sessionFor(SHARED_PARTITION),
        profiles.flatMap((profile) => profile.cookies),
      );
    else {
      const activeTabId = this.state.activeTabId;
      const spaceColors: SpaceColor[] = ["blue", "orange", "purple", "green"];
      try {
        for (const [index, profile] of profiles
          .filter((item) => item.cookies.length)
          .entries()) {
          if (this.state.spaces.length >= 30) {
            outcome.warnings.push(
              "Kamapathy holds at most 30 spaces, so some profiles were left out.",
            );
            break;
          }
          await this.dispatch({
            type: "space:create",
            name: `${profile.profile} from ${profile.browser}`.slice(0, 48),
            color: spaceColors[index % spaceColors.length],
            kind: "personal",
            signIns: "separate",
          });
          const space = this.state.spaces[this.state.spaces.length - 1];
          outcome.spaces.push({ id: space.id, name: space.name });
          await write(
            this.sessionFor(`persist:space-${space.id}`),
            profile.cookies,
          );
        }
      } finally {
        // The new spaces wait in the sidebar; the person stays where they were.
        const previous = this.state.tabs.find((tab) => tab.id === activeTabId);
        if (previous) this.activate(previous);
        this.emit();
      }
    }
    if (outcome.failed)
      outcome.warnings.push(
        outcome.failed === 1
          ? "1 sign-in could not be saved."
          : `${outcome.failed} sign-ins could not be saved.`,
      );
    return outcome;
  }

  closeTab(
    tabId: string,
    by: ClosedBy,
  ): { closed?: string; replacement?: Tab } {
    if (this.destroyed) throw new Error("Browser is closing.");
    const result = this.removeTab(this.getTab(tabId), by);
    this.emit();
    return result;
  }

  partitionOf(spaceId: string): string {
    return this.partitionFor(this.getSpace(spaceId));
  }

  tabOfContents(contents: WebContents): Tab | undefined {
    for (const [id, view] of this.views)
      if (view.webContents === contents)
        return this.state.tabs.find((tab) => tab.id === id);
    return undefined;
  }

  extensionPageTabs(extensionId: string): Tab[] {
    return this.state.tabs.filter(
      (tab) => extensionIdOf(tab.url) === extensionId,
    );
  }

  // When an extension stops running, its pages close.
  closeExtensionPages(extensionId: string): void {
    if (this.destroyed) return;
    const tabs = this.extensionPageTabs(extensionId);
    if (!tabs.length) return;
    for (const tab of tabs) this.removeTab(tab, "person");
    this.emit();
  }

  // A tab an extension opens for the person, only in a personal space no
  // agent can reach. It may show a web page, the new tab page for "" and
  // about:blank, or a page of an extension the space runs.
  openExtensionTab(
    spaceId: string,
    url: string,
    options: ExtensionTabOptions = {},
  ): Tab {
    if (this.destroyed) throw new Error("Browser is closing.");
    const space = this.getSpace(spaceId);
    const ids = this.extensionIds(space);
    if (!ids)
      throw new Error("Extensions open tabs only in your personal spaces.");
    if (this.state.tabs.length >= 200)
      throw new Error("The maximum of 200 tabs has been reached.");
    let target = HOME_URL;
    if (url !== "" && url !== HOME_URL && url !== "about:blank") {
      const id = extensionIdOf(url);
      if (!isWebUrl(url) && !(id && ids.has(id)))
        throw new Error("Extensions can't open this URL.");
      target = new URL(url).href;
    }
    const tab = { ...newTab(space.id, target), pinned: !!options.pinned };
    this.registry.register(tab, { openedBy: "person", managed: false });
    this.placeTab(tab, options.index);
    if (options.active !== false) this.activate(tab);
    if (this.loadable(tab)) this.ensureView(tab);
    this.emit();
    return tab;
  }

  moveTab(tabId: string, index: number): Tab {
    if (this.destroyed) throw new Error("Browser is closing.");
    const tab = this.getTab(tabId);
    this.placeTab(tab, index);
    this.emit();
    return tab;
  }

  // Puts a tab at index in its space's tab strip, where pinned tabs come
  // first, kept within its own pin group. No index, or -1, means last.
  private placeTab(tab: Tab, index?: number): void {
    const current = this.state.tabs.indexOf(tab);
    if (current >= 0) this.state.tabs.splice(current, 1);
    const others = this.state.tabs.filter(
      (item) => item.spaceId === tab.spaceId,
    );
    const group = others.filter((item) => item.pinned === tab.pinned);
    const before = tab.pinned ? 0 : others.length - group.length;
    const rank =
      index === undefined || !(index >= 0)
        ? group.length
        : Math.min(group.length, Math.max(0, Math.floor(index) - before));
    if (rank < group.length)
      this.state.tabs.splice(this.state.tabs.indexOf(group[rank]), 0, tab);
    else if (group.length)
      this.state.tabs.splice(
        this.state.tabs.indexOf(group.at(-1)!) + 1,
        0,
        tab,
      );
    else this.state.tabs.push(tab);
  }

  setManaged(tabId: string, managed: boolean): Tab {
    const tab = this.getTab(tabId);
    this.registry.setManaged(tab, managed);
    this.emit();
    return tab;
  }

  setPageBudget(spaceId: string, pageBudget: number): void {
    this.getSpace(spaceId).pageBudget = pageBudget;
    this.emit();
  }

  markSeen(tabId: string): void {
    const tab = this.getTab(tabId);
    if (!tab.unseen) return;
    delete tab.unseen;
    this.emit();
  }

  // The tab is the agent's now: it manages the page, and its space follows
  // agent rules, is the agent's to drive and has not ended.
  agentControlled(tabId: string): boolean {
    const tab = this.state.tabs.find((item) => item.id === tabId);
    if (!tab?.managed) return false;
    const space = this.state.spaces.find((item) => item.id === tab.spaceId);
    return (
      !!space &&
      space.owner === "agent" &&
      space.access !== "ended" &&
      agentRules(space)
    );
  }

  // Gives the person control until they answer a site's prompt or an
  // approval the agent asked for. Returns the id that releaseHold takes.
  holdForPerson(spaceId: string, reason: HoldReason, prompt: string): string {
    if (this.getSpace(spaceId).owner !== "agent")
      throw new Error("The agent does not have control of this space.");
    const hold = randomUUID();
    this.registry.handOver(spaceId, {
      reason,
      prompt: prompt.slice(0, 120),
      hold,
    });
    this.emit();
    return hold;
  }

  // An answered hold gives control back, unless the person took over since.
  releaseHold(holdId: string): void {
    const space = this.state.spaces.find(
      (item) => item.control?.hold === holdId,
    );
    if (!space) return;
    this.registry.takeBack(space.id, this.shownTab(space.id) ?? null);
    this.emit();
  }

  // The person lets an agent use a space, from the app or an approved
  // request. Its pages keep painting while nobody watches them.
  grantAccess(spaceId: string): void {
    this.getSpace(spaceId);
    this.registry.grant(spaceId);
    this.setThrottling(spaceId, false);
    this.emit();
  }

  // Finish or the person's Stop. A personal space throttles its background
  // pages again.
  endAccess(
    spaceId: string,
    ended: { by: "agent" | "person"; reason: "finished" | "stopped" },
  ): void {
    const space = this.getSpace(spaceId);
    this.registry.end(spaceId, ended);
    if (space.kind === "personal") this.setThrottling(spaceId, true);
    this.addActivity(
      spaceId,
      ended.by === "agent" ? "Agent finished" : "You stopped the agent",
      ended.by === "agent" ? "success" : "info",
    );
  }

  // Agent access went off: every grant ends and no request waits.
  resetAgentAccess(): void {
    const granted = this.state.spaces.filter(
      (space) => space.kind === "personal" && space.access,
    );
    this.registry.reset();
    this.state.spaceRequests = [];
    for (const space of granted) this.setThrottling(space.id, true);
    this.emit();
  }

  // Shown to the person until they answer or the request ends.
  addSpaceRequest(request: { reason: string; name?: string }): SpaceRequest {
    const added: SpaceRequest = {
      id: randomUUID(),
      reason: request.reason,
      ...(request.name === undefined ? {} : { name: request.name }),
      at: Date.now(),
    };
    this.state.spaceRequests.push(added);
    this.emit();
    return added;
  }

  removeSpaceRequest(id: string): void {
    this.state.spaceRequests = this.state.spaceRequests.filter(
      (request) => request.id !== id,
    );
    this.emit();
  }

  // An agent's request to clear a site's data, shown above its tab until it
  // ends. The list lives for this run only, so neither change is saved.
  addApproval(approval: ClearSiteDataApproval): void {
    this.state.approvals.push(approval);
    this.emit({ save: false });
  }

  removeApproval(id: string): void {
    const kept = this.state.approvals.filter((item) => item.id !== id);
    if (kept.length === this.state.approvals.length) return;
    this.state.approvals = kept;
    this.emit({ save: false });
  }

  async keepAsPersonal(spaceId: string): Promise<void> {
    const space = this.getSpace(spaceId);
    if (space.kind !== "agent" || space.access !== "ended")
      throw new Error(
        "Only a space whose agent has finished or stopped can be kept.",
      );
    const previous = this.partitionFor(space);
    space.kind = "personal";
    delete space.access;
    delete space.ended;
    if (space.signIns === "separate") {
      // Its temporary sign-ins end, and its pages reload in its own
      // persistent session.
      for (const tab of this.state.tabs.filter(
        (item) => item.spaceId === space.id,
      )) {
        this.destroyTab(tab.id);
        tab.loading = false;
      }
    } else this.setThrottling(space.id, true);
    this.emit();
    if (previous !== SHARED_PARTITION) await this.discardPartition(previous);
  }

  private setThrottling(spaceId: string, throttled: boolean): void {
    for (const tab of this.state.tabs) {
      if (tab.spaceId !== spaceId) continue;
      const contents = this.views.get(tab.id)?.webContents;
      if (contents && !contents.isDestroyed())
        contents.setBackgroundThrottling(throttled);
    }
  }

  // Closes one tab for whoever asked: its label retires, its space keeps at
  // least one tab, and a shown tab passes the selection to a neighbor.
  private removeTab(
    tab: Tab,
    by: ClosedBy,
  ): { closed?: string; replacement?: Tab } {
    this.closedTabs.unshift({ ...tab });
    this.closedTabs = this.closedTabs.slice(0, 20);
    const index = this.state.tabs.indexOf(tab);
    const spaceIndex = this.state.tabs
      .filter((item) => item.spaceId === tab.spaceId)
      .indexOf(tab);
    this.registry.retire(tab, by);
    this.state.tabs.splice(index, 1);
    this.destroyTab(tab.id);
    if (this.state.splitTabId === tab.id) this.state.splitTabId = null;
    let candidates = this.state.tabs.filter(
      (item) => item.spaceId === tab.spaceId,
    );
    let replacement: Tab | undefined;
    if (!candidates.length) {
      // The blank tab that replaces a last tab takes the closer's origin.
      replacement = newTab(tab.spaceId);
      this.registry.register(
        replacement,
        by === "agent"
          ? { openedBy: "agent", managed: true }
          : by === "person"
            ? { openedBy: "person", managed: false }
            : { openedBy: tab.openedBy ?? "person", managed: !!tab.managed },
      );
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
    return {
      ...(tab.label ? { closed: tab.label } : {}),
      ...(replacement ? { replacement } : {}),
    };
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
          this.openTarget(
            space,
            action.url === undefined ? "" : cleanText(action.url, 8192),
          ),
        );
        // Tabs made through the app are the person's, in any space.
        this.registry.register(tab, { openedBy: "person", managed: false });
        this.state.tabs.push(tab);
        if (!action.background) this.activate(tab);
        if (this.loadable(tab)) this.ensureView(tab);
        break;
      }
      case "tab:open-external": {
        const tab = this.state.tabs.find((item) => item.id === action.id);
        if (tab && tab.id === this.state.activeTabId) {
          const destination = googleSignInFallback(tab.url);
          // While Kamapathy is the default browser the link comes straight back.
          const status = await defaultBrowserStatus(
            electronDefaultBrowserEnv(),
          );
          if (destination && status.state !== "default")
            await shell.openExternal(destination);
        }
        break;
      }
      // The person's own button, so agents never reach the clipboard.
      case "tab:copy-external": {
        const tab = this.state.tabs.find((item) => item.id === action.id);
        if (tab && tab.id === this.state.activeTabId) {
          const destination = googleSignInFallback(tab.url);
          if (destination) clipboard.writeText(destination);
        }
        break;
      }
      case "tab:activate":
        this.activate(this.getTab(action.id));
        break;
      case "tab:navigate": {
        const tab = this.getTab(action.id);
        const space = this.getSpace(tab.spaceId);
        const url = this.openTarget(space, cleanText(action.url, 8192));
        // A page that needs another kind of view gets a new one, without
        // its back history.
        const rebuild = this.views.has(tab.id) && this.changesView(tab, url);
        const wasFile = isFileUrl(tab.url);
        tab.url = url;
        tab.title = tab.url === HOME_URL ? "New tab" : tab.url;
        delete tab.favicon;
        delete tab.error;
        if (tab.url === HOME_URL || rebuild) {
          this.destroyTab(tab.id);
          tab.loading = false;
          tab.canGoBack = false;
          tab.canGoForward = false;
        }
        if (tab.url !== HOME_URL) {
          const view = this.views.get(tab.id);
          if (view) this.load(tab, view.webContents);
          else this.ensureView(tab);
        }
        // A file tab in a space an agent can reach becomes one of its pages.
        if (wasFile && !isFileUrl(tab.url) && agentRules(space))
          this.registry.labelSpace(space.id);
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
        this.removeTab(tab, "person");
        break;
      }
      case "tab:reopen": {
        if (this.closedTabs.length && this.state.tabs.length >= 200)
          throw new Error("The maximum of 200 tabs has been reached.");
        const old = this.closedTabs.shift();
        const space =
          old && this.state.spaces.find((item) => item.id === old.spaceId);
        if (old && space) {
          let url = old.url;
          // A file comes back only where files open, and only while it is
          // there; otherwise it is skipped.
          if (isFileUrl(url))
            try {
              url = this.openTarget(space, url);
            } catch {
              break;
            }
          const tab = {
            ...newTab(old.spaceId, url),
            title: old.title,
            pinned: old.pinned,
          };
          this.registry.register(tab, { openedBy: "person", managed: false });
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
          if (action.type === "tab:reload") this.reloadTab(tab, contents);
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
        const name =
          cleanAgentText(cleanText(action.name, 48)) || "Untitled space";
        const signIns = signInsOf(action.signIns);
        let space: Space;
        if (action.kind === "agent") {
          space = this.createAgentSpace(name, {
            color: action.color,
            isolated: signIns === "separate",
            createdBy: "person",
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
            createdBy: "person",
          };
          this.state.spaces.push(space);
          const tab = newTab(space.id);
          this.registry.register(tab, { openedBy: "person", managed: false });
          this.state.tabs.push(tab);
        }
        this.activate(this.state.tabs.find((tab) => tab.spaceId === space.id)!);
        break;
      }
      case "space:activate": {
        const space = this.getSpace(action.id);
        // The person sees the tab whose site is waiting for them first.
        const waiting = this.prompts.oldestPromptTab(space.id);
        this.activate(
          this.state.tabs.find((tab) => tab.id === waiting) ??
            openingTab(this.state, space.id, this.lastActive.get(space.id))!,
        );
        break;
      }
      case "space:rename":
        this.getSpace(action.id).name =
          cleanAgentText(cleanText(action.name, 48)) || "Untitled space";
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
        if (space.access === "granted")
          throw new Error(
            "Stop agent access to this space before changing its sign-ins.",
          );
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
          !agentRules(space) ||
          !["human", "agent"].includes(action.owner) ||
          ![undefined, "handoff", "failed"].includes(action.reason)
        )
          throw new Error("Only agent spaces can change ownership.");
        if (action.owner === "human")
          this.registry.handOver(space.id, {
            reason: action.reason ?? "manual",
          });
        else this.registry.takeBack(space.id, this.shownTab(space.id) ?? null);
        // A reported failure has its own entry, so this one would repeat it.
        if (action.reason !== "failed")
          this.addActivity(
            space.id,
            action.owner === "human"
              ? "You took control. Agent access is paused."
              : "Control returned to the agent.",
            "info",
          );
        break;
      }
      case "space:grant":
        // main.ts grants through the agent service while it runs.
        throw new Error("Turn on agent access first.");
      case "space:stop": {
        const space = this.getSpace(action.id);
        // A second Stop, or a Stop on a space no agent may use, changes
        // nothing.
        if (space.access !== "ended" && agentRules(space))
          this.endAccess(space.id, { by: "person", reason: "stopped" });
        break;
      }
      case "space:keep":
        await this.keepAsPersonal(action.id);
        break;
      case "space-request:answer":
        // main.ts answers through the agent service while it runs.
        throw new Error("Turn on agent access first.");
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
        this.registry.forget(space.id);
        this.prompts.clearSpace(space.id);
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
      case "site-permission:remove": {
        if (!isPermissionKey(action.permission))
          throw new Error("Invalid site permission.");
        this.prompts.removeSitePermission({
          spaceId: action.spaceId,
          origin: action.origin,
          permission: action.permission,
        });
        break;
      }
      case "site-permission:clear":
        this.prompts.clearSitePermissions();
        break;
      case "bookmark:add": {
        // A file reaches the check below instead of the address bar's
        // message about spaces.
        const url = normalizeUrl(
          cleanText(action.url, 8192),
          this.state.settings.searchEngine,
          { allowFile: true },
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
          { allowFile: true },
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
      // A key an agent sent reaches the page and nothing else: no shortcut
      // of the person's, and no menu role.
      if (inputMarker.keyInFlight(contents, input)) return;
      inputMarker.humanInput(contents);
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
    clearTimeout(this.updateTimer);
    this.persist();
    this.destroyed = true;
    // Every request waiting for the person is answered no as Kamapathy goes.
    this.prompts.clearAll();
    this.overlay.dispose();
    for (const id of this.views.keys()) this.destroyTab(id);
    this.captureHost.dispose();
    for (const cleanup of this.sessionCleanups.values()) cleanup();
    this.sessionCleanups.clear();
    this.sessions.clear();
    this.listeners.clear();
    this.viewListeners.clear();
  }
}
