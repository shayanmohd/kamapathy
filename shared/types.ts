import type { PermissionKey, PromptKind } from "./permissions";

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
// A request only the person can answer, waiting in the prompt bar. It never
// carries a secret: no password, and no more of a site's words than the bar
// shows.
export interface PendingPrompt {
  id: string;
  spaceId: string;
  tabId?: string;
  kind: PromptKind;
  origin?: string;
  host?: string;
  at: number;
  agent: boolean;
  devices?: { id: string; name: string }[];
  certificates?: {
    id: string;
    subject: string;
    issuer: string;
    expires: number;
  }[];
  signIn?: { host: string; realm?: string; proxy: boolean; retry: boolean };
}
// The person's Allow or Block, kept per space, origin and permission.
export interface SitePermission {
  spaceId: string;
  origin: string;
  permission: PermissionKey;
  allow: boolean;
  at: number;
}
export interface PromptAnswer {
  id: string;
  allow: boolean;
  deviceId?: string;
  certificateId?: string;
  credentials?: { username: string; password: string };
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
  prompts: PendingPrompt[];
  sitePermissions: SitePermission[];
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
  | {
      type: "site-permission:remove";
      spaceId: string;
      origin: string;
      permission: PermissionKey;
    }
  | { type: "site-permission:clear" }
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
  // Answers go their own way, so a password never joins an action or state.
  answerPrompt(answer: PromptAnswer): Promise<void>;
}
