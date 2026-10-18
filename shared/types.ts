export type Theme = "system" | "light" | "dark";
export type SpaceColor = "green" | "blue" | "orange" | "purple";
export type SignIns = "shared" | "separate";
export type OpenedBy = "agent" | "page" | "person";
export type ClosedBy = "agent" | "page" | "person";
export type ControlReason =
  | "manual"
  | "handoff"
  | "failed"
  | "approval"
  | "permission"
  | "device"
  | "http_auth"
  | "client_certificate";
// Why the person has control when only they can answer something.
export type HoldReason =
  "approval" | "permission" | "device" | "http_auth" | "client_certificate";
export interface SpaceControl {
  reason: ControlReason;
  prompt?: string;
  since: number;
  hold?: string;
}
export interface SpaceEnd {
  by: "agent" | "person";
  reason: "finished" | "stopped";
  at: number;
}
export interface Space {
  id: string;
  name: string;
  color: SpaceColor;
  kind: "personal" | "agent";
  owner: "human" | "agent";
  // Shared spaces use one session; separate ones keep their own cookies.
  signIns: SignIns;
  createdAt: number;
  // Agent state for this run only; none of it is saved.
  createdBy?: "agent" | "person";
  pageBudget?: number;
  access?: "granted" | "ended";
  ended?: SpaceEnd;
  control?: SpaceControl;
}
export interface Tab {
  id: string;
  spaceId: string;
  title: string;
  url: string;
  favicon?: string;
  pinned: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error?: string;
  // Agent bookkeeping for this run only; none of it is saved.
  label?: string;
  openedBy?: OpenedBy;
  openerId?: string;
  managed?: boolean;
  createdAt?: number;
  unseen?: true;
}
export interface Bookmark {
  id: string;
  title: string;
  url: string;
  createdAt: number;
}
export interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  visitedAt: number;
  visits?: number;
}
export interface Download {
  id: string;
  filename: string;
  receivedBytes: number;
  totalBytes: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted";
  path: string;
}
export interface Activity {
  id: string;
  spaceId?: string;
  message: string;
  time: number;
  kind: "info" | "success" | "warning";
}
export interface Settings {
  theme: Theme;
  searchEngine: "duckduckgo" | "google" | "bing";
  restoreSession: boolean;
  showBookmarksBar: boolean;
  automationEnabled: boolean;
  isolateAgentSpaces: boolean;
  welcomed: boolean;
}
export interface ImportProfile {
  id: string;
  name: string;
}
export interface ImportSource {
  id: string;
  name: string;
  profiles: ImportProfile[];
  default: boolean;
  // Sign-ins come from the Chromium family only.
  signInsAvailable: boolean;
  // macOS keeps the data folder from Kamapathy until the person allows it.
  status: "ready" | "needs_permission";
}
export interface ImportedBookmark {
  title: string;
  url: string;
}
export interface ImportedVisit {
  title: string;
  url: string;
  visitedAt: number;
  visits: number;
}
export interface ImportSelection {
  source: string;
  profile?: string;
}
// Where imported sign-ins go: nowhere, the shared session or a new space per profile.
export type SignInsTarget = "none" | "shared" | "separate";
export interface ImportRequest {
  profiles: ImportSelection[];
  bookmarks: boolean;
  history: boolean;
  signIns: SignInsTarget;
}
export interface ImportOutcome {
  bookmarks: number;
  history: number;
  signIns: number;
  spaces: { id: string; name: string }[];
  warnings: string[];
}
export type ImportErrorCode =
  | "import_invalid_request"
  | "source_not_found"
  | "profile_not_found"
  | "import_busy"
  | "read_blocked"
  | "keychain_denied"
  | "cookies_unavailable"
  | "invalid_archive";
// Failures arrive as values: the bridge would keep only an Error's message.
export interface ImportFailure {
  error: {
    code: ImportErrorCode;
    message: string;
    retryable?: true;
    sources?: string[];
  };
}
export type ImportReply = ImportOutcome | ImportFailure;
// An agent's request for one of the person's spaces, waiting for an answer.
export interface SpaceRequest {
  id: string;
  reason: string;
  name?: string;
  at: number;
}
export interface BrowserState {
  spaces: Space[];
  tabs: Tab[];
  activeSpaceId: string;
  activeTabId: string;
  splitTabId: string | null;
  bookmarks: Bookmark[];
  history: HistoryEntry[];
  downloads: Download[];
  activity: Activity[];
  spaceRequests: SpaceRequest[];
  settings: Settings;
  platform: "darwin" | "win32" | "linux" | "web";
  version: string;
  automation: { running: boolean };
}
export type BrowserAction =
  | { type: "tab:create"; url?: string; spaceId?: string; background?: boolean }
  | { type: "tab:close"; id: string }
  | { type: "tab:activate"; id: string }
  | { type: "tab:navigate"; id: string; url: string }
  | { type: "tab:open-external"; id: string }
  | { type: "tab:copy-external"; id: string }
  | {
      type:
        | "tab:back"
        | "tab:forward"
        | "tab:reload"
        | "tab:stop"
        | "tab:pin"
        | "tab:duplicate";
      id: string;
    }
  | { type: "tab:reopen" }
  | { type: "tab:split"; id: string | null }
  | {
      type: "space:create";
      name: string;
      color: SpaceColor;
      kind: "personal" | "agent";
      signIns?: SignIns;
    }
  | { type: "space:sign-ins"; id: string; signIns: SignIns }
  | { type: "space:activate"; id: string }
  | { type: "space:rename"; id: string; name: string }
  | { type: "space:color"; id: string; color: SpaceColor }
  | { type: "space:delete"; id: string }
  | {
      type: "space:ownership";
      id: string;
      owner: "human" | "agent";
      reason?: "handoff";
    }
  | { type: "space:grant"; id: string }
  | { type: "space:stop"; id: string }
  | { type: "space:keep"; id: string }
  | {
      type: "space-request:answer";
      id: string;
      allow: boolean;
      spaceId?: string;
    }
  | { type: "bookmark:add"; url: string; title: string }
  | { type: "bookmark:remove"; id: string }
  | { type: "bookmark:update"; id: string; url: string; title: string }
  | { type: "history:clear" }
  | {
      type: "import:apply";
      bookmarks: ImportedBookmark[];
      history: ImportedVisit[];
    }
  | { type: "settings:update"; settings: Partial<Settings> }
  | { type: "download:show"; id: string }
  | { type: "page:find"; text: string; forward?: boolean }
  | { type: "page:stop-find" }
  | { type: "page:zoom"; direction: "in" | "out" | "reset" }
  | { type: "page:devtools" }
  | { type: "page:screenshot" };
export interface ContentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  hidden: boolean;
}
export interface FrozenFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  image: string;
}
export type DefaultBrowserStatus =
  | { state: "default" | "available" }
  | {
      state: "unavailable";
      reason: "development" | "disk-image" | "portable" | "not-installed" | "web";
    };
export interface KamapathyBridge {
  getState(): Promise<BrowserState>;
  dispatch(action: BrowserAction): Promise<BrowserState>;
  subscribe(callback: (state: BrowserState) => void): () => void;
  onShortcut(callback: (shortcut: string) => void): () => void;
  setContentBounds(bounds: ContentBounds): void;
  freeze(): Promise<FrozenFrame[]>;
  hidePages(): void;
  unfreeze(): Promise<void>;
  thumbnails(): Promise<Record<string, string>>;
  windowControl(action: "minimize" | "maximize" | "close"): void;
  importSources(): Promise<ImportSource[]>;
  importBrowserData(request: ImportRequest): Promise<ImportReply>;
  // Safari comes in through the file its own export writes.
  importSafariArchive(
    bytes: Uint8Array,
    request: Omit<ImportRequest, "profiles" | "signIns">,
  ): Promise<ImportReply>;
  openImportPermissions(pane: "full-disk" | "files-folders"): void;
  defaultBrowser(): Promise<DefaultBrowserStatus>;
  makeDefaultBrowser(): Promise<void>;
}
