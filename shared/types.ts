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
  offerToSavePasswords: boolean;
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
// Saved passwords, for the person only. Summaries leave out passwords and
// notes, and file paths stay in main.
export type LoginKind = "form" | "http";
export type Compromised = "leaked" | "phished";
export interface SavedLoginSummary {
  id: string;
  kind: LoginKind;
  origin: string;
  realm?: string;
  username: string;
  compromised?: Compromised;
  createdAt: number;
  changedAt: number;
  usedAt?: number;
}
// An offer to save or update a password after the person signs in.
export interface PasswordPrompt {
  id: string;
  tabId: string;
  kind: "save" | "update";
  host: string;
  username: string;
}
export type VaultState =
  "empty" | "opening" | "ready" | "locked" | "unavailable";
export interface VaultStatus {
  state: VaultState;
  reason?: "no_keyring" | "web";
  count: number;
  compromised: number;
}
export interface NewLogin {
  url: string;
  username: string;
  password: string;
  note?: string;
}
// A note of "" removes the note.
export interface LoginChanges {
  url?: string;
  username?: string;
  password?: string;
  note?: string;
}
export interface NeverSavedOrigin {
  origin: string;
  createdAt: number;
}
export interface PasswordImportSummary {
  added: number;
  unchanged: number;
  kept: number;
  replaced: number;
  skipped: number;
  neverSaved: number;
  warnings: string[];
}
export type PasswordPromptAnswer =
  | { action: "save"; username: string }
  | { action: "update" }
  | { action: "never" }
  | { action: "dismiss" };
export type PasswordErrorCode =
  | "invalid_login"
  | "import_file_invalid"
  | "vault_unavailable"
  | "reauth_failed"
  | "login_not_found"
  | "vault_locked"
  | "vault_full"
  | "login_exists"
  | "vault_write_failed";
export interface PasswordErrorBody {
  code: PasswordErrorCode | "import_busy";
  message: string;
  field?: string;
  limit?: number;
  reason?: string;
  id?: string;
  retryable?: true;
}
export type PasswordResult<T> = T | { error: PasswordErrorBody };
export interface PasswordsBridge {
  status(): Promise<PasswordResult<VaultStatus>>;
  list(): Promise<PasswordResult<SavedLoginSummary[]>>;
  reveal(
    id: string,
  ): Promise<PasswordResult<{ password: string; note?: string }>>;
  copy(
    id: string,
    field: "username" | "password",
  ): Promise<PasswordResult<{ ok: true }>>;
  add(login: NewLogin): Promise<PasswordResult<SavedLoginSummary>>;
  update(
    id: string,
    changes: LoginChanges,
  ): Promise<PasswordResult<SavedLoginSummary>>;
  remove(id: string): Promise<PasswordResult<{ ok: true }>>;
  importFile(options: { replace: boolean }): Promise<
    PasswordResult<
      | { canceled: true }
      | {
          summary: PasswordImportSummary;
          file: { token: string; name: string };
        }
    >
  >;
  trashFile(token: string): Promise<PasswordResult<{ ok: true }>>;
  exportFile(): Promise<
    PasswordResult<{ canceled: true } | { count: number; name: string }>
  >;
  answer(
    promptId: string,
    answer: PasswordPromptAnswer,
  ): Promise<PasswordResult<{ ok: true }>>;
  retry(): Promise<PasswordResult<VaultStatus>>;
  startOver(): Promise<PasswordResult<VaultStatus>>;
  neverSaved(): Promise<PasswordResult<NeverSavedOrigin[]>>;
  removeNeverSaved(origin: string): Promise<PasswordResult<{ ok: true }>>;
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
  // For this run only; never saved.
  passwordPrompts: PasswordPrompt[];
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
  passwords: PasswordsBridge;
  windowControl(action: "minimize" | "maximize" | "close"): void;
  importSources(): Promise<ImportSource[]>;
  importBrowserData(request: ImportRequest): Promise<ImportOutcome>;
}
