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
  updateChecks: boolean;
  // What's new lists the notes above this version.
  seenVersion: string;
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
export interface ImportRequest {
  source: string;
  profile?: string;
  bookmarks: boolean;
  history: boolean;
}
export interface ImportOutcome {
  bookmarks: number;
  history: number;
  warnings: string[];
}
// An agent's request for one of the person's spaces, waiting for an answer.
export interface SpaceRequest {
  id: string;
  reason: string;
  name?: string;
  at: number;
}
export type InstallKind =
  | "mac-arm64"
  | "mac-x64"
  | "windows-setup"
  | "windows-portable"
  | "linux-appimage"
  | "linux-deb"
  | "source"
  | "other";
export interface UpdateRelease {
  version: string;
  publishedAt: number;
  url: string;
  installer: { name: string; size: number; url: string; sha256?: string };
  // The release's SHA256SUMS.txt.
  sums: string;
}
export interface UpdateError {
  code: string;
  message: string;
  reason?: string;
  retryable?: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
  file?: string;
}
export interface UpdateState {
  kind: InstallKind;
  state:
    | "unchecked"
    | "current"
    | "available"
    | "downloading"
    | "ready"
    | "unsupported";
  checkedAt?: number;
  latest?: UpdateRelease;
  progress?: { receivedBytes: number; totalBytes: number };
  installer?: { path: string; sha256: string };
  error?: UpdateError;
}
export interface UpdateStatus extends UpdateState {
  version: string;
  checks: boolean;
}
export interface UpdateReminder {
  version: string;
  state: "available" | "downloading" | "ready";
}
// What the person's own interface may ask the updater to do.
export type UpdateCommand =
  | {
      command: "check" | "download" | "cancel" | "install" | "show" | "copy-command";
    }
  | { command: "notes"; which: "running" | "latest" };
export interface AgentSetupStatus {
  supported: boolean;
  reason?: "desktop_only" | "test_profile";
  skillFolder: string | null;
  agents: {
    id: string;
    name: string;
    folder: string;
    state: "linked" | "available" | "own_copy" | "error";
    reason?: string;
    backup?: string;
  }[];
  command: {
    state: "on" | "off" | "error";
    path: string;
    onPath: boolean | null;
    profileFile: string | null;
    // Kamapathy's PATH lines are in place, so a later Set up keeps them.
    pathAdded: boolean;
    reason?: string;
  };
  codex: { detected: boolean; allowed: boolean };
  // Null without a shell probe.
  node: { found: boolean; version: string | null } | null;
}
export interface AgentSetupRequest {
  agents: string[];
  replace: string[];
  command: boolean;
  path: boolean;
  codexRule: boolean;
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
  update: UpdateState;
}
export type BrowserAction =
  | { type: "tab:create"; url?: string; spaceId?: string; background?: boolean }
  | { type: "tab:close"; id: string }
  | { type: "tab:activate"; id: string }
  | { type: "tab:navigate"; id: string; url: string }
  | { type: "tab:open-external"; id: string }
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
  importBrowserData(request: ImportRequest): Promise<ImportOutcome>;
  agentSetupStatus(options?: { probe?: boolean }): Promise<AgentSetupStatus>;
  applyAgentSetup(request: AgentSetupRequest): Promise<AgentSetupStatus>;
  removeAgentSetup(): Promise<AgentSetupStatus>;
  copyText(text: string): Promise<void>;
  helpSpaceId(): Promise<string>;
  update(command: UpdateCommand): Promise<UpdateStatus>;
}
