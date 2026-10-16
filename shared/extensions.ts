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
export const SUPPORTED_PERMISSIONS: ReadonlySet<string> = new Set([
  "activeTab",
  "clipboardRead",
  "clipboardWrite",
  "geolocation",
  "scripting",
  "storage",
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
  alarms: "Scheduled tasks",
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
  idle: "Knowing when you're away",
  management: "Managing other extensions",
  nativeMessaging: "Talking to apps on your computer",
  notifications: "Notifications",
  offscreen: "Background documents",
  pageCapture: "Saving pages",
  power: "Keeping the computer awake",
  printerProvider: "Printers",
  privacy: "Privacy settings",
  proxy: "Proxy settings",
  readingList: "Reading list",
  search: "Search",
  sessions: "Recently closed tabs",
  sidePanel: "The side panel",
  "system.cpu": "System information",
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
