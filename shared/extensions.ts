import { cleanAgentText } from "./agent-text";
import type { Space } from "./types";

// The person's Chrome extensions: what extensions.json holds, which APIs
// work in Kamapathy and how permissions read. The shell bundles this file, so
// it uses no Node modules.
export const PDF_VIEWER_EXTENSION_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";
// Extensions that are part of Kamapathy and never the person's.
export const COMPONENT_EXTENSION_IDS: readonly string[] = [
  PDF_VIEWER_EXTENSION_ID,
];
export const MAX_EXTENSIONS = 100;
export const MAX_PINNED = 8;
export const NAME_LIMIT = 75;
export const TITLE_LIMIT = 200;
export const BADGE_LIMIT = 4;
export const STORE_UPDATE_URL =
  "https://clients2.google.com/service/update2/crx";

export type ExtensionSource = "webstore" | "unpacked";
export interface Grant {
  permissions: string[];
  hosts: string[];
}
export interface StagedBuild extends Grant {
  version: string;
  path: string;
  review: boolean;
}
export interface ExtensionEntry {
  id: string;
  source: ExtensionSource;
  version: string;
  // Store builds: "Extensions/<id>/<version>" under userData. Unpacked: the
  // absolute folder.
  path: string;
  enabled: boolean;
  pinned: boolean;
  installedAt: number;
  // The browser it came from, such as "Google Chrome".
  importedFrom?: string;
  grantedPermissions: string[];
  grantedHosts: string[];
  staged?: StagedBuild;
}
export interface ExtensionsFile {
  extensions: ExtensionEntry[];
  removals: string[];
}

const ID = /^[a-p]{32}$/;

export function isExtensionId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
export function isComponentExtension(id: string): boolean {
  return COMPONENT_EXTENSION_IDS.includes(id);
}
export function isVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d+(\.\d+){0,3}$/.test(value) &&
    value.split(".").every((part) => Number(part) <= 65535)
  );
}
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function storePath(id: string, version: string): string {
  return `Extensions/${id}/${version}`;
}
// POSIX, drive letter or UNC.
function isAbsoluteFolder(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 4096 &&
    !value.includes("\0") &&
    /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)
  );
}
function savedStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === "string" && item.length <= 2048,
        )
        .slice(0, 256)
    : [];
}
function restoreStaged(
  id: string,
  current: string,
  value: unknown,
): StagedBuild | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { version, path, review, permissions, hosts } = value as Record<
    string,
    unknown
  >;
  if (
    !isVersion(version) ||
    compareVersions(version, current) <= 0 ||
    path !== storePath(id, version) ||
    typeof review !== "boolean"
  )
    return undefined;
  return {
    version,
    path,
    review,
    permissions: savedStrings(permissions),
    hosts: savedStrings(hosts),
  };
}
function restoreEntry(value: unknown): ExtensionEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const entry = value as Record<string, unknown>;
  const { id, source, version, path, enabled, pinned, installedAt } = entry;
  if (
    !isExtensionId(id) ||
    isComponentExtension(id) ||
    !isVersion(version) ||
    !(source === "webstore"
      ? path === storePath(id, version)
      : source === "unpacked" && isAbsoluteFolder(path)) ||
    typeof enabled !== "boolean" ||
    typeof pinned !== "boolean" ||
    typeof installedAt !== "number" ||
    !Number.isFinite(installedAt) ||
    installedAt < 0
  )
    return undefined;
  const importedFrom = cleanExtensionText(entry.importedFrom, 48);
  // Staged builds are store updates.
  const staged =
    source === "webstore"
      ? restoreStaged(id, version, entry.staged)
      : undefined;
  return {
    id,
    source: source as ExtensionSource,
    version,
    path: path as string,
    enabled,
    pinned,
    installedAt,
    ...(importedFrom ? { importedFrom } : {}),
    grantedPermissions: savedStrings(entry.grantedPermissions),
    grantedHosts: savedStrings(entry.grantedHosts),
    ...(staged ? { staged } : {}),
  };
}
export function restoreExtensions(value: unknown): ExtensionsFile {
  const file = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const extensions: ExtensionEntry[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(file.extensions) ? file.extensions : []) {
    if (extensions.length === MAX_EXTENSIONS) break;
    const entry = restoreEntry(item);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    extensions.push(entry);
  }
  const removals = [
    ...new Set<unknown>(Array.isArray(file.removals) ? file.removals : []),
  ]
    .filter(
      (id): id is string => isExtensionId(id) && !isComponentExtension(id),
    )
    .slice(0, 1000);
  return { extensions, removals };
}

const STORE_DETAIL =
  /^https:\/\/chromewebstore\.google\.com\/detail\/(?:[^/?#]+\/)?([a-p]{32})(?:[/?#]|$)/;

// A store detail link or a bare id, as typed in the Extensions modal.
export function storeItemId(input: string): string | undefined {
  const value = input.trim();
  return storeDetailId(value) ?? (ID.test(value) ? value : undefined);
}
// A store detail page in the address bar.
export function storeDetailId(url: string): string | undefined {
  return STORE_DETAIL.exec(url)?.[1];
}
export function extensionIdOf(url: string): string | undefined {
  return /^chrome-extension:\/\/([a-p]{32})(?:[/?#]|$)/.exec(url)?.[1];
}
// Names, titles and badges come from extensions, so they are shown like
// agent text.
export function cleanExtensionText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return Array.from(cleanAgentText(value)).slice(0, limit).join("").trimEnd();
}
export function extensionLabel(name: string): string {
  return `Extension: ${name}`;
}
// Agent spaces the agent controls, and personal spaces granted to an agent.
export function agentHeld(
  space: Pick<Space, "kind" | "owner" | "access">,
): boolean {
  return (
    (space.kind === "agent" && space.owner === "agent") ||
    (space.kind === "personal" && space.access === "granted")
  );
}
// Isolated agent spaces live in memory, where Electron can't load extensions.
export function runsExtensions(
  space: Pick<Space, "kind" | "signIns">,
): boolean {
  return space.kind !== "agent" || space.signIns !== "separate";
}

// Permissions that work natively in Electron or through Kamapathy's bridges.
// The native ones are what Chromium 152's extension bindings answer in an
// extension page and in a service worker.
export const SUPPORTED_PERMISSIONS: ReadonlySet<string> = new Set([
  "activeTab",
  "alarms",
  "clipboardRead",
  "clipboardWrite",
  "geolocation",
  "idle",
  "offscreen",
  "power",
  "scripting",
  "storage",
  "system.cpu",
  "tabs",
  "unlimitedStorage",
  "webRequest",
]);
// Shown in this order after the host line.
export const PERMISSION_LINES: Readonly<Record<string, string>> = {
  tabs: "Read your browsing history",
  clipboardRead: "Read data you copy and paste",
  clipboardWrite: "Change data you copy and paste",
  geolocation: "Know your physical location",
};
export const WONT_WORK_PERMISSIONS: Readonly<Record<string, string>> = {
  bookmarks: "Your bookmarks",
  browsingData: "Clearing browsing data",
  contentSettings: "Site settings",
  // Calls are accepted and show nothing.
  contextMenus: "Right-click menu items",
  cookies: "Reading and changing cookies",
  debugger: "The page debugger",
  declarativeContent: "Showing the button on some pages",
  declarativeNetRequest: "Blocking content with rules",
  declarativeNetRequestWithHostAccess: "Blocking content with rules",
  declarativeNetRequestFeedback: "Blocking content with rules",
  desktopCapture: "Screen capture",
  downloads: "Managing downloads",
  "downloads.open": "Managing downloads",
  "downloads.ui": "Managing downloads",
  favicon: "Site icons",
  fontSettings: "Font settings",
  gcm: "Push messages",
  history: "Your browsing history",
  identity: "Signing in with Google",
  "identity.email": "Signing in with Google",
  management: "Managing other extensions",
  nativeMessaging: "Talking to apps on your computer",
  notifications: "Notifications",
  pageCapture: "Saving pages",
  printerProvider: "Printers",
  privacy: "Privacy settings",
  proxy: "Proxy settings",
  readingList: "Reading list",
  search: "Search",
  sessions: "Recently closed tabs",
  sidePanel: "The side panel",
  "system.display": "System information",
  "system.memory": "System information",
  "system.storage": "System information",
  tabCapture: "Tab capture",
  tabGroups: "Tab groups",
  topSites: "Your most visited sites",
  tts: "Reading text aloud",
  ttsEngine: "Speech engines",
  userScripts: "User scripts",
  webNavigation: "Following page loads",
};
// Manifest keys for features Kamapathy doesn't have.
export const WONT_WORK_KEYS: Readonly<Record<string, string>> = {
  commands: "Keyboard shortcuts",
  side_panel: "The side panel",
  chrome_url_overrides: "Replacing Chrome pages",
  omnibox: "Address bar keywords",
  declarative_net_request: "Blocking content with rules",
  tts_engine: "Speech engines",
  file_browser_handlers: "Opening files",
  file_handlers: "Opening files",
  input_components: "Input methods",
};

function lookup(
  table: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// "fileBrowserHandler" reads "File browser handler".
export function plainName(api: string): string {
  const words = api
    .replace(/\./g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
// Host patterns in "permissions" are ignored, as in Manifest V3.
export function permissionsOf(manifest: Record<string, unknown>): string[] {
  return unique(
    stringsOf(manifest.permissions).filter(
      (permission) =>
        permission !== "<all_urls>" && !permission.includes("://"),
    ),
  );
}
export function hostsOf(manifest: Record<string, unknown>): string[] {
  const scripts = Array.isArray(manifest.content_scripts)
    ? manifest.content_scripts
    : [];
  return unique([
    ...stringsOf(manifest.host_permissions),
    ...scripts.flatMap((script: unknown) =>
      script && typeof script === "object"
        ? stringsOf((script as { matches?: unknown }).matches)
        : [],
    ),
  ]);
}
function hostList(hosts: string[]): string {
  const others = hosts.length - 3;
  if (others > 0)
    return `${hosts.slice(0, 3).join(", ")} and ${others} other ${others === 1 ? "site" : "sites"}`;
  return hosts.length > 1
    ? `${hosts.slice(0, -1).join(", ")} and ${hosts.at(-1)}`
    : hosts[0];
}
// File patterns show nothing: extensions load without file access.
export function permissionLines(grant: Grant): string[] {
  const lines: string[] = [];
  const hosts = unique(
    grant.hosts
      .map(patternHost)
      .filter((host): host is string => host !== undefined),
  );
  if (grant.hosts.some(coversAllHosts))
    lines.push("Read and change all your data on all websites");
  else if (hosts.length)
    lines.push(`Read and change your data on ${hostList(hosts)}`);
  for (const [permission, line] of Object.entries(PERMISSION_LINES))
    if (grant.permissions.includes(permission)) lines.push(line);
  return lines;
}
// Permissions in manifest order, then keys in manifest order.
export function wontWorkNames(manifest: Record<string, unknown>): string[] {
  const permissions = permissionsOf(manifest)
    .filter((permission) => !SUPPORTED_PERMISSIONS.has(permission))
    .map(
      (permission) =>
        lookup(WONT_WORK_PERMISSIONS, permission) ??
        cleanExtensionText(plainName(cleanAgentText(permission)), NAME_LIMIT),
    );
  const keys = Object.keys(manifest).map((key) => lookup(WONT_WORK_KEYS, key));
  return unique(
    [...permissions, ...keys].filter((name): name is string => !!name),
  );
}
// Whether a new build needs the person's OK: a permission with a line they
// haven't seen, or a host their grant doesn't cover.
export function raisesPermissions(granted: Grant, next: Grant): boolean {
  if (
    next.permissions.some(
      (permission) =>
        Object.hasOwn(PERMISSION_LINES, permission) &&
        !granted.permissions.includes(permission),
    )
  )
    return true;
  if (granted.hosts.some(coversAllHosts)) return false;
  const allowed = granted.hosts
    .map(parsePattern)
    .filter((pattern) => pattern !== undefined);
  return next.hosts.some((pattern) => {
    if (granted.hosts.includes(pattern)) return false;
    const host = patternHost(pattern);
    return (
      host === undefined ||
      !allowed.some(
        (known) =>
          known.host === host ||
          (known.subdomains && host.endsWith(`.${known.host}`)),
      )
    );
  });
}
// Electron's permission names for what a manifest may declare.
const WEB_PERMISSIONS: Readonly<Record<string, string>> = {
  "clipboard-read": "clipboardRead",
  "clipboard-sanitized-write": "clipboardWrite",
  geolocation: "geolocation",
};
export function extensionPermission(
  declared: readonly string[],
  permission: string,
): boolean {
  const needed = lookup(WEB_PERMISSIONS, permission);
  return needed !== undefined && declared.includes(needed);
}

interface MatchPattern {
  scheme: string;
  // "" matches every host.
  host: string;
  subdomains: boolean;
  port: string;
  path: string;
}
function canonicalHost(host: string): string | undefined {
  try {
    const url = new URL(`http://${host}/`);
    return url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.hostname
      : undefined;
  } catch {
    return undefined;
  }
}
// Chrome's match pattern syntax, for http and https only.
function parsePattern(pattern: string): MatchPattern | undefined {
  if (pattern === "<all_urls>")
    return { scheme: "*", host: "", subdomains: true, port: "*", path: "/*" };
  const match = /^(\*|https?):\/\/([^/]*)(\/.*)$/s.exec(pattern);
  const authority = match
    ? /^(\[[^\]]*\]|[^:]*)(?::(\*|\d{1,5}))?$/.exec(match[2])
    : null;
  if (!match || !authority) return undefined;
  const [, scheme, , path] = match;
  const [, host, port = "*"] = authority;
  if (port !== "*" && Number(port) > 65535) return undefined;
  if (host === "*") return { scheme, host: "", subdomains: true, port, path };
  const subdomains = host.startsWith("*.");
  const name = subdomains ? host.slice(2) : host;
  const canonical = name && !name.includes("*") ? canonicalHost(name) : "";
  return canonical
    ? { scheme, host: canonical, subdomains, port, path }
    : undefined;
}
export function matchesPattern(pattern: string, url: string): boolean {
  const parsed = parsePattern(pattern);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const scheme = target.protocol.slice(0, -1);
  if (!parsed || (scheme !== "http" && scheme !== "https")) return false;
  const host = target.hostname;
  const port = target.port || (scheme === "https" ? "443" : "80");
  return (
    (parsed.scheme === "*" || parsed.scheme === scheme) &&
    (!parsed.host ||
      host === parsed.host ||
      (parsed.subdomains && host.endsWith(`.${parsed.host}`))) &&
    (parsed.port === "*" || Number(parsed.port) === Number(port)) &&
    wildcard(parsed.path, target.pathname + target.search, false)
  );
}
export function coversAllHosts(pattern: string): boolean {
  return parsePattern(pattern)?.host === "";
}
// The host a pattern shows as: "*.example.com" shows as "example.com".
export function patternHost(pattern: string): string | undefined {
  return parsePattern(pattern)?.host || undefined;
}
// A tabs.query title: "*" and "?" wildcards, case-sensitive.
export function globMatch(glob: string, text: string): boolean {
  return wildcard(glob, text, true);
}
// Backtracks only to the last "*", so patterns from extensions take at most
// pattern length times text length steps.
function wildcard(pattern: string, text: string, single: boolean): boolean {
  const wanted = Array.from(pattern);
  const given = Array.from(text);
  let at = 0;
  let star = -1;
  let resume = 0;
  for (let index = 0; index < given.length;) {
    if (wanted[at] === "*") {
      star = at++;
      resume = index;
    } else if (wanted[at] === given[index] || (single && wanted[at] === "?")) {
      at++;
      index++;
    } else if (star >= 0) {
      at = star + 1;
      index = ++resume;
    } else return false;
  }
  while (wanted[at] === "*") at++;
  return at === wanted.length;
}

// What the shell shows and sends.
export interface ExtensionAnchor {
  // Shell CSS pixels.
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ExtensionAction {
  id: string;
  name: string;
  title: string;
  // A data:image/png URL, at most 128 pixels a side.
  icon?: string;
  badge: string;
  badgeColor: string;
  badgeTextColor?: string;
  enabled: boolean;
  pinned: boolean;
}
export interface ExtensionUpdateState {
  state: "staged" | "review" | "failed";
  version?: string;
  message?: string;
}
export interface ExtensionRow {
  id: string;
  name: string;
  version: string;
  source: ExtensionSource;
  importedFrom?: string;
  enabled: boolean;
  pinned: boolean;
  icon?: string;
  lines: string[];
  wontWork: string[];
  hasOptions: boolean;
  update?: ExtensionUpdateState;
  error?: string;
  needsDeveloperMode?: true;
}
export interface ExtensionImportProgress {
  id: string;
  name: string;
  status: "adding" | "added" | "failed";
  message?: string;
}
export interface ExtensionsView {
  rows: ExtensionRow[];
  // Extensions the shown space's session runs, pinned first in pin order.
  actions: ExtensionAction[];
  // Why the shown space's buttons are off.
  disabled?: "isolated" | "agent";
  // Ids being added, in queue order.
  installing: string[];
  imports: ExtensionImportProgress[];
}
export type ExtensionCommand =
  | { type: "install"; input: string }
  | { type: "load-unpacked" }
  | { type: "reload"; id: string }
  | { type: "enable"; id: string; enabled: boolean }
  | { type: "pin"; id: string; pinned: boolean }
  | { type: "remove"; id: string }
  | { type: "options"; id: string }
  | { type: "review"; id: string }
  | { type: "click"; id: string; anchor: ExtensionAnchor }
  | {
      type: "anchors";
      buttons: Record<string, ExtensionAnchor>;
      puzzle: ExtensionAnchor | null;
    };
export interface ExtensionCommandResult {
  ok: true;
  id?: string;
  added?: boolean;
}
export interface ExtensionCandidate {
  id: string;
  name: string;
  version: string;
  kind: "store" | "unpacked" | "unavailable";
  checked: boolean;
  added: boolean;
  pinned: boolean;
  lines: string[];
  wontWork: string[];
  // "Not available here", "Turn on developer mode to add this." or a
  // refusal's copy.
  note?: string;
}
export interface ExtensionImportList {
  source: string;
  profile: string;
  browser: string;
  profileName: string;
  candidates: ExtensionCandidate[];
}
export interface ExtensionImportRequest {
  source: string;
  profile?: string;
  ids: string[];
}
export interface ExtensionImportResult {
  results: ExtensionImportProgress[];
}

// What an extension in a session sees: its spaces as windows and their tabs
// as tabs. The mappers below turn Kamapathy's model into Chrome's objects,
// hiding what the extension may not read.
export const PLACEHOLDER_BASE = 2 ** 30;
export const NEW_TAB_URL = "chrome://newtab/";
export const WINDOW_ID_NONE = -1;
export const WINDOW_ID_CURRENT = -2;

export interface TabModel {
  // webContents.id, or a placeholder for a tab without a view.
  id: number;
  tabId: string;
  windowId: number;
  index: number;
  url: string;
  title: string;
  favIconUrl?: string;
  status: "loading" | "complete" | "unloaded";
  active: boolean;
  pinned: boolean;
  discarded: boolean;
  audible: boolean;
  muted: boolean;
  zoomFactor: number;
  agentHeld: boolean;
  file: boolean;
  newTab: boolean;
}
export interface WindowModel {
  id: number;
  spaceId: string;
  focused: boolean;
  agentHeld: boolean;
  personal: boolean;
  state: "normal" | "minimized" | "maximized" | "fullscreen";
  bounds: { left: number; top: number; width: number; height: number };
  tabs: TabModel[];
}
export interface SessionModel {
  partition: string;
  windows: WindowModel[];
}
// What one extension may read in one session.
export interface Access {
  tabs: boolean;
  hosts: readonly string[];
  activeTabs: ReadonlySet<number>;
}
export interface BridgeTab {
  id: number;
  index: number;
  windowId: number;
  active: boolean;
  highlighted: boolean;
  selected: boolean;
  pinned: boolean;
  audible: boolean;
  discarded: boolean;
  autoDiscardable: true;
  frozen: false;
  mutedInfo: { muted: boolean };
  status: "loading" | "complete" | "unloaded";
  incognito: false;
  groupId: -1;
  url?: string;
  pendingUrl?: string;
  title?: string;
  favIconUrl?: string;
  width?: number;
  height?: number;
}
export interface BridgeWindow {
  id: number;
  focused: boolean;
  top: number;
  left: number;
  width: number;
  height: number;
  incognito: false;
  type: "normal" | "popup";
  state: WindowModel["state"];
  alwaysOnTop: false;
  tabs?: BridgeTab[];
}
export interface TabQuery {
  active?: boolean;
  pinned?: boolean;
  audible?: boolean;
  muted?: boolean;
  highlighted?: boolean;
  discarded?: boolean;
  autoDiscardable?: boolean;
  currentWindow?: boolean;
  lastFocusedWindow?: boolean;
  status?: string;
  title?: string;
  url?: string | string[];
  windowId?: number;
  windowType?: string;
  index?: number;
  groupId?: number;
  frozen?: boolean;
}
export type TabField =
  | "url"
  | "title"
  | "favIconUrl"
  | "status"
  | "pinned"
  | "discarded"
  | "audible"
  | "muted";
export type ModelChange =
  | { type: "tab-created"; tab: TabModel }
  | { type: "tab-updated"; tab: TabModel; changed: TabField[] }
  | { type: "tab-activated"; tabId: number; windowId: number }
  | {
      type: "tab-removed";
      tabId: number;
      windowId: number;
      windowClosing: boolean;
    }
  | { type: "tab-replaced"; added: number; removed: number }
  | {
      type: "tab-moved";
      tabId: number;
      windowId: number;
      from: number;
      to: number;
    }
  | { type: "tab-attached"; tabId: number; windowId: number; position: number }
  | { type: "tab-detached"; tabId: number; windowId: number; position: number }
  | { type: "tab-zoomed"; tabId: number; from: number; to: number }
  | { type: "window-created"; window: WindowModel }
  | { type: "window-removed"; windowId: number }
  | { type: "focus-changed"; windowId: number }
  | { type: "bounds-changed"; window: WindowModel };

// Files on this computer stay invisible, whatever an extension holds.
export function canSeeTab(tab: TabModel, access: Access): boolean {
  if (tab.file) return false;
  return (
    access.tabs ||
    access.activeTabs.has(tab.id) ||
    access.hosts.some((pattern) => matchesPattern(pattern, tab.url))
  );
}
export function tabObject(tab: TabModel, access: Access): BridgeTab {
  const seen = canSeeTab(tab, access);
  return {
    id: tab.id,
    index: tab.index,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.active,
    selected: tab.active,
    pinned: tab.pinned,
    audible: tab.audible,
    discarded: tab.discarded,
    autoDiscardable: true,
    frozen: false,
    mutedInfo: { muted: tab.muted },
    status: tab.status,
    incognito: false,
    groupId: -1,
    ...(seen
      ? {
          url: tab.url,
          title: tab.title,
          ...(tab.status === "loading" ? { pendingUrl: tab.url } : {}),
          ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
        }
      : {}),
  };
}
export function windowObject(
  window: WindowModel,
  access: Access,
  populate: boolean,
): BridgeWindow {
  return {
    id: window.id,
    focused: window.focused,
    top: window.bounds.top,
    left: window.bounds.left,
    width: window.bounds.width,
    height: window.bounds.height,
    incognito: false,
    type: "normal",
    state: window.state,
    alwaysOnTop: false,
    tabs: populate
      ? window.tabs.map((tab) => tabObject(tab, access))
      : undefined,
  };
}
export function queryTabs(
  model: SessionModel,
  query: TabQuery,
  context: { currentWindowId: number; lastFocusedWindowId: number },
  access: Access,
): TabModel[] {
  const wanted =
    query.windowId === WINDOW_ID_CURRENT
      ? context.currentWindowId
      : query.windowId;
  const patterns =
    query.url === undefined
      ? undefined
      : Array.isArray(query.url)
        ? query.url
        : [query.url];
  return model.windows.flatMap((window) =>
    window.tabs.filter((tab) => {
      const seen = canSeeTab(tab, access);
      return (
        (wanted === undefined || window.id === wanted) &&
        (query.currentWindow === undefined ||
          (window.id === context.currentWindowId) === query.currentWindow) &&
        (query.lastFocusedWindow === undefined ||
          (window.id === context.lastFocusedWindowId) ===
            query.lastFocusedWindow) &&
        (query.windowType === undefined || query.windowType === "normal") &&
        (query.active === undefined || tab.active === query.active) &&
        (query.highlighted === undefined || tab.active === query.highlighted) &&
        (query.pinned === undefined || tab.pinned === query.pinned) &&
        (query.audible === undefined || tab.audible === query.audible) &&
        (query.muted === undefined || tab.muted === query.muted) &&
        (query.discarded === undefined || tab.discarded === query.discarded) &&
        (query.autoDiscardable === undefined || query.autoDiscardable) &&
        (query.frozen === undefined || !query.frozen) &&
        (query.groupId === undefined || query.groupId === -1) &&
        (query.index === undefined || tab.index === query.index) &&
        (query.status === undefined || tab.status === query.status) &&
        // Tabs whose fields are hidden match no URL and no title.
        (query.title === undefined ||
          (seen && globMatch(query.title, tab.title))) &&
        (patterns === undefined ||
          (seen &&
            patterns.some((pattern) => matchesPattern(pattern, tab.url))))
      );
    }),
  );
}

const FIELDS: TabField[] = [
  "url",
  "title",
  "favIconUrl",
  "status",
  "pinned",
  "discarded",
  "audible",
  "muted",
];
function changedFields(before: TabModel, after: TabModel): TabField[] {
  return FIELDS.filter((field) => before[field] !== after[field]);
}
// The tabs that have to move for the strip to read as it does now, each with
// the places it moved between, as Chrome reports them one at a time.
function moves(
  before: readonly TabModel[],
  after: readonly TabModel[],
): { tab: TabModel; from: number; to: number }[] {
  const kept = after.filter((tab) =>
    before.some((item) => item.tabId === tab.tabId),
  );
  const order = before
    .filter((tab) => kept.some((item) => item.tabId === tab.tabId))
    .map((tab) => tab.tabId);
  const changes: { tab: TabModel; from: number; to: number }[] = [];
  for (const [to, tab] of kept.entries()) {
    if (order[to] === tab.tabId) continue;
    const from = order.indexOf(tab.tabId);
    order.splice(from, 1);
    order.splice(to, 0, tab.tabId);
    changes.push({ tab, from, to });
  }
  return changes;
}
interface Placed {
  window: WindowModel;
  tab: TabModel;
  index: number;
}
function placedTabs(windows: readonly WindowModel[]): Map<string, Placed> {
  const placed = new Map<string, Placed>();
  for (const window of windows)
    for (const [index, tab] of window.tabs.entries())
      placed.set(tab.tabId, { window, tab, index });
  return placed;
}
const sameBounds = (a: WindowModel["bounds"], b: WindowModel["bounds"]) =>
  a.left === b.left &&
  a.top === b.top &&
  a.width === b.width &&
  a.height === b.height;

// What changed between two takes of one session.
export function diffModels(
  previous: SessionModel | undefined,
  next: SessionModel,
): ModelChange[] {
  const before = previous?.windows ?? [];
  const was = new Map(before.map((window) => [window.id, window]));
  const now = new Map(next.windows.map((window) => [window.id, window]));
  const oldTabs = placedTabs(before);
  const newTabs = placedTabs(next.windows);
  const changes: ModelChange[] = [];
  // A window that closed takes its remaining tabs with it.
  for (const window of before)
    if (!now.has(window.id)) {
      for (const tab of window.tabs)
        if (!newTabs.has(tab.tabId))
          changes.push({
            type: "tab-removed",
            tabId: tab.id,
            windowId: window.id,
            windowClosing: true,
          });
      changes.push({ type: "window-removed", windowId: window.id });
    }
  for (const window of next.windows)
    if (!was.has(window.id)) {
      changes.push({ type: "window-created", window });
      for (const tab of window.tabs)
        if (!oldTabs.has(tab.tabId)) changes.push({ type: "tab-created", tab });
    }
  for (const window of next.windows) {
    const fresh = !was.has(window.id);
    for (const tab of window.tabs) {
      const old = oldTabs.get(tab.tabId);
      if (!old) {
        if (!fresh) changes.push({ type: "tab-created", tab });
        continue;
      }
      if (old.window.id !== window.id) {
        changes.push({
          type: "tab-detached",
          tabId: tab.id,
          windowId: old.window.id,
          position: old.index,
        });
        changes.push({
          type: "tab-attached",
          tabId: tab.id,
          windowId: window.id,
          position: tab.index,
        });
      }
      // The view appeared or went away, so the tab answers to another id.
      if (old.tab.id !== tab.id)
        changes.push({
          type: "tab-replaced",
          added: tab.id,
          removed: old.tab.id,
        });
      const changed = changedFields(old.tab, tab);
      if (changed.length) changes.push({ type: "tab-updated", tab, changed });
      if (old.tab.zoomFactor !== tab.zoomFactor)
        changes.push({
          type: "tab-zoomed",
          tabId: tab.id,
          from: old.tab.zoomFactor,
          to: tab.zoomFactor,
        });
    }
  }
  for (const [tabId, old] of oldTabs)
    if (!newTabs.has(tabId) && now.has(old.window.id))
      changes.push({
        type: "tab-removed",
        tabId: old.tab.id,
        windowId: old.window.id,
        windowClosing: false,
      });
  for (const window of next.windows) {
    const old = was.get(window.id);
    if (!old) continue;
    for (const move of moves(old.tabs, window.tabs))
      changes.push({
        type: "tab-moved",
        tabId: move.tab.id,
        windowId: window.id,
        from: move.from,
        to: move.to,
      });
  }
  for (const window of next.windows) {
    const active = window.tabs.find((tab) => tab.active);
    const old = was.get(window.id);
    const before = old?.tabs.find((tab) => tab.active);
    if (active && before?.tabId !== active.tabId)
      changes.push({
        type: "tab-activated",
        tabId: active.id,
        windowId: window.id,
      });
  }
  for (const window of next.windows) {
    const old = was.get(window.id);
    if (
      old &&
      (old.state !== window.state || !sameBounds(old.bounds, window.bounds))
    )
      changes.push({ type: "bounds-changed", window });
  }
  const focused = next.windows.find((window) => window.focused)?.id;
  const focusedBefore = before.find((window) => window.focused)?.id;
  if ((focused ?? WINDOW_ID_NONE) !== (focusedBefore ?? WINDOW_ID_NONE))
    changes.push({
      type: "focus-changed",
      windowId: focused ?? WINDOW_ID_NONE,
    });
  return changes;
}

const ZOOM_SETTINGS = { mode: "automatic", scope: "per-origin" } as const;

// The Chrome events a change comes out as, with the fields this extension
// may read. Nothing comes out when nothing visible is left to send.
export function eventFor(
  change: ModelChange,
  access: Access,
): { event: string; args: unknown[] }[] {
  switch (change.type) {
    case "tab-created":
      return [
        { event: "tabs.onCreated", args: [tabObject(change.tab, access)] },
      ];
    case "tab-updated": {
      const tab = change.tab;
      const seen = canSeeTab(tab, access);
      const info: Record<string, unknown> = {};
      for (const field of change.changed) {
        if (field === "muted") info.mutedInfo = { muted: tab.muted };
        else if (
          field === "url" ||
          field === "title" ||
          field === "favIconUrl"
        ) {
          if (seen) info[field] = tab[field];
        } else info[field] = tab[field];
      }
      return Object.keys(info).length
        ? [
            {
              event: "tabs.onUpdated",
              args: [tab.id, info, tabObject(tab, access)],
            },
          ]
        : [];
    }
    case "tab-activated":
      return [
        {
          event: "tabs.onActivated",
          args: [{ tabId: change.tabId, windowId: change.windowId }],
        },
        {
          event: "tabs.onHighlighted",
          args: [{ windowId: change.windowId, tabIds: [change.tabId] }],
        },
      ];
    case "tab-removed":
      return [
        {
          event: "tabs.onRemoved",
          args: [
            change.tabId,
            {
              windowId: change.windowId,
              isWindowClosing: change.windowClosing,
            },
          ],
        },
      ];
    case "tab-replaced":
      return [
        { event: "tabs.onReplaced", args: [change.added, change.removed] },
      ];
    case "tab-moved":
      return [
        {
          event: "tabs.onMoved",
          args: [
            change.tabId,
            {
              windowId: change.windowId,
              fromIndex: change.from,
              toIndex: change.to,
            },
          ],
        },
      ];
    case "tab-attached":
      return [
        {
          event: "tabs.onAttached",
          args: [
            change.tabId,
            { newWindowId: change.windowId, newPosition: change.position },
          ],
        },
      ];
    case "tab-detached":
      return [
        {
          event: "tabs.onDetached",
          args: [
            change.tabId,
            { oldWindowId: change.windowId, oldPosition: change.position },
          ],
        },
      ];
    case "tab-zoomed":
      return [
        {
          event: "tabs.onZoomChange",
          args: [
            {
              tabId: change.tabId,
              oldZoomFactor: change.from,
              newZoomFactor: change.to,
              zoomSettings: { ...ZOOM_SETTINGS },
            },
          ],
        },
      ];
    case "window-created":
      return [
        {
          event: "windows.onCreated",
          args: [windowObject(change.window, access, false)],
        },
      ];
    case "window-removed":
      return [{ event: "windows.onRemoved", args: [change.windowId] }];
    case "focus-changed":
      return [{ event: "windows.onFocusChanged", args: [change.windowId] }];
    case "bounds-changed":
      return [
        {
          event: "windows.onBoundsChanged",
          args: [windowObject(change.window, access, false)],
        },
      ];
  }
}
