import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CookiesSetDetails } from "electron";
import type {
  BrowserAction,
  BrowserState,
  ImportErrorCode,
  ImportOutcome,
  ImportRequest,
  ImportSelection,
  SignInsTarget,
} from "../shared/types";
import { isWebUrl } from "../shared/url";
import {
  defaultRun,
  keyCache,
  readChromiumCookies,
  type ChromiumBrowserId,
  type RunCommand,
  type SafeStorageKeys,
} from "./import-cookies";

export type BrowserId =
  | "chrome"
  | "chromium"
  | "edge"
  | "brave"
  | "arc"
  | "vivaldi"
  | "opera"
  | "firefox"
  | "safari";
export interface ImportProfile {
  id: string;
  name: string;
}
export interface ImportSource {
  id: BrowserId;
  name: string;
  profiles: ImportProfile[];
  default: boolean;
  signInsAvailable: boolean;
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
export interface ImportResult {
  bookmarks: ImportedBookmark[];
  history: ImportedVisit[];
  warnings: string[];
}
// Tests point the module at a fake home and stub the commands that read the
// default browser.
export interface ImportEnv {
  platform: NodeJS.Platform;
  home: string;
  appData?: string;
  localAppData?: string;
  exec?: (command: string, args: string[]) => string;
  // Async commands that may wait for the person, such as the keychain prompt.
  command?: RunCommand;
  // Where macOS apps are installed; "/Applications" unless a test says otherwise.
  applications?: string;
}

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
    readonly fields: { retryable?: true; sources?: string[] } = {},
  ) {
    super(message);
    this.name = "ImportError";
  }
}
// Sign-ins read from one source profile, for the destination to write.
export interface ProfileCookies {
  source: BrowserId;
  browser: string;
  profile: string;
  cookies: CookiesSetDetails[];
}
export interface SelectionResult {
  bookmarks: ImportedBookmark[];
  history: ImportedVisit[];
  profiles: ProfileCookies[];
  warnings: string[];
}
export interface CookieOutcome {
  written: number;
  failed: number;
  spaces: { id: string; name: string }[];
  warnings: string[];
}
// What an import writes into: the browser controller, or a fake in tests.
export interface ImportTarget {
  readonly state: Pick<BrowserState, "bookmarks" | "history">;
  dispatch(action: BrowserAction): Promise<unknown>;
  applyImportedCookies(
    target: "shared" | "separate",
    profiles: readonly ProfileCookies[],
  ): Promise<CookieOutcome>;
}

const LIMIT = 1000;
const TITLE_LENGTH = 300;
const INVALID_REQUEST = "Something was wrong with that import. Try again.";
const REQUEST_LIMIT = 64 * 1024;
const SELECTION_LIMIT = 64;
const PROFILE_LENGTH = 512;
const signInsTargets: readonly SignInsTarget[] = ["none", "shared", "separate"];

interface BrowserInfo {
  name: string;
  engine: "chromium" | "firefox" | "safari";
  // The macOS app, for telling a blocked data folder from an empty one.
  app?: string;
  darwin?: string;
  win32?: string;
  linux?: string;
  // Firefox and Opera keep their profiles in the roaming folder on Windows.
  roaming?: boolean;
}
const browsers: Record<BrowserId, BrowserInfo> = {
  chrome: {
    name: "Google Chrome",
    engine: "chromium",
    app: "Google Chrome",
    darwin: "Library/Application Support/Google/Chrome",
    win32: "Google/Chrome/User Data",
    linux: ".config/google-chrome",
  },
  chromium: {
    name: "Chromium",
    engine: "chromium",
    app: "Chromium",
    darwin: "Library/Application Support/Chromium",
    win32: "Chromium/User Data",
    linux: ".config/chromium",
  },
  edge: {
    name: "Microsoft Edge",
    engine: "chromium",
    app: "Microsoft Edge",
    darwin: "Library/Application Support/Microsoft Edge",
    win32: "Microsoft/Edge/User Data",
    linux: ".config/microsoft-edge",
  },
  brave: {
    name: "Brave",
    engine: "chromium",
    app: "Brave Browser",
    darwin: "Library/Application Support/BraveSoftware/Brave-Browser",
    win32: "BraveSoftware/Brave-Browser/User Data",
    linux: ".config/BraveSoftware/Brave-Browser",
  },
  arc: {
    name: "Arc",
    engine: "chromium",
    app: "Arc",
    darwin: "Library/Application Support/Arc/User Data",
    win32:
      "Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data",
  },
  vivaldi: {
    name: "Vivaldi",
    engine: "chromium",
    app: "Vivaldi",
    darwin: "Library/Application Support/Vivaldi",
    win32: "Vivaldi/User Data",
    linux: ".config/vivaldi",
  },
  opera: {
    name: "Opera",
    engine: "chromium",
    app: "Opera",
    darwin: "Library/Application Support/com.operasoftware.Opera",
    win32: "Opera Software/Opera Stable",
    roaming: true,
    linux: ".config/opera",
  },
  firefox: {
    name: "Firefox",
    engine: "firefox",
    app: "Firefox",
    darwin: "Library/Application Support/Firefox",
    win32: "Mozilla/Firefox",
    roaming: true,
    linux: ".mozilla/firefox",
  },
  safari: { name: "Safari", engine: "safari", darwin: "Library/Safari" },
};
const ids = Object.keys(browsers) as BrowserId[];

// Matched against the lower cased macOS bundle id, Windows ProgId or Linux
// desktop entry of the http(s) handler.
const handlers: [BrowserId, RegExp][] = [
  ["chrome", /google\.chrome|chromehtml|google-chrome/],
  ["chromium", /chromium/],
  ["edge", /edgemac|msedge|microsoft-edge/],
  ["brave", /brave/],
  ["arc", /thebrowser\.browser|^arc/],
  ["vivaldi", /vivaldi/],
  ["opera", /opera/],
  ["firefox", /firefox/],
  ["safari", /safari/],
];

const chromiumHistory =
  "SELECT url, title, visit_count AS visits, CAST(last_visit_time AS REAL) AS time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC";
const firefoxHistory =
  "SELECT url, title, visit_count AS visits, CAST(last_visit_date AS REAL) AS time FROM moz_places WHERE hidden = 0 AND last_visit_date IS NOT NULL ORDER BY last_visit_date DESC";
const firefoxBookmarkRows =
  "SELECT b.id, b.parent, b.type, b.title, b.guid, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.position";

export const chromiumTime = (time: number): number =>
  time / 1000 - 11644473600000;
export const firefoxTime = (time: number): number => time / 1000;

function defaultEnv(): ImportEnv {
  return {
    platform: process.platform,
    home: homedir(),
    appData: process.env.APPDATA,
    localAppData: process.env.LOCALAPPDATA,
  };
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// How macOS refuses a folder it protects.
function permissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
export function decodeXml(text: string): string {
  return text.replace(
    /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/g,
    (_, hex?: string, decimal?: string, name?: string) =>
      name
        ? entities[name]
        : String.fromCodePoint(hex ? parseInt(hex, 16) : Number(decimal)),
  );
}

interface Tag {
  name: string;
  closing: boolean;
  empty: boolean;
  end: number;
}
// plutil refuses to write a plist with a <date> as JSON, and every Safari
// Reading List entry has one, so plists are converted to XML and read here.
export function parsePlistXml(xml: string): unknown {
  const tags = /<(\/?)([a-z]+)[^>]*?(\/?)>|<[^>]*>/g;
  const next = (): Tag | undefined => {
    for (let match = tags.exec(xml); match; match = tags.exec(xml))
      if (match[2])
        return {
          name: match[2],
          closing: match[1] === "/",
          empty: match[3] === "/",
          end: match.index + match[0].length,
        };
    return undefined;
  };
  const open = (): Tag => {
    const tag = next();
    if (!tag || tag.closing) throw new SyntaxError("Malformed plist");
    return tag;
  };
  const text = (tag: Tag): string => {
    if (tag.empty) return "";
    const close = xml.indexOf(`</${tag.name}>`, tag.end);
    if (close < 0) throw new SyntaxError(`Unterminated <${tag.name}>`);
    tags.lastIndex = close + tag.name.length + 3;
    return decodeXml(xml.slice(tag.end, close));
  };
  const children = (tag: Tag, each: (child: Tag) => void) => {
    if (tag.empty) return;
    for (let child = next(); ; child = next()) {
      if (!child || (child.closing && child.name !== tag.name))
        throw new SyntaxError(`Unterminated <${tag.name}>`);
      if (child.closing) return;
      each(child);
    }
  };
  const value = (tag: Tag): unknown => {
    switch (tag.name) {
      case "dict": {
        const dict: Record<string, unknown> = {};
        children(tag, (child) => {
          if (child.name !== "key") throw new SyntaxError("Expected <key>");
          dict[text(child)] = value(open());
        });
        return dict;
      }
      case "array": {
        const list: unknown[] = [];
        children(tag, (child) => list.push(value(child)));
        return list;
      }
      case "string":
        return text(tag);
      case "integer":
      case "real":
        return Number(text(tag));
      case "true":
        return true;
      case "false":
        return false;
      case "date":
        return new Date(text(tag).trim()).toISOString();
      case "data":
        return text(tag).replace(/\s+/g, "");
      default:
        throw new SyntaxError(`Unexpected <${tag.name}>`);
    }
  };
  let root = open();
  if (root.name === "plist") root = open();
  return value(root);
}

function dataDir(id: BrowserId, env: ImportEnv): string | undefined {
  const browser = browsers[id];
  if (env.platform === "win32") {
    const base = browser.roaming ? env.appData : env.localAppData;
    return browser.win32 && base ? join(base, browser.win32) : undefined;
  }
  const relative =
    env.platform === "darwin"
      ? browser.darwin
      : env.platform === "linux"
        ? browser.linux
        : undefined;
  return relative ? join(env.home, relative) : undefined;
}

function chromiumProfiles(dir: string): ImportProfile[] {
  const state = record(record(readJson(join(dir, "Local State"))).profile);
  const cache = record(state.info_cache);
  const found = Object.keys(cache)
    .filter((id) => existsSync(join(dir, id)))
    .sort(
      (a, b) => Number(b === state.last_used) - Number(a === state.last_used),
    )
    .map((id) => {
      const name = record(cache[id]).name;
      return { id, name: typeof name === "string" && name ? name : id };
    });
  if (found.length) return found;
  if (existsSync(join(dir, "Default")))
    return [{ id: "Default", name: "Default" }];
  // Opera keeps its single profile in the data folder itself.
  if (existsSync(join(dir, "Bookmarks")) || existsSync(join(dir, "History")))
    return [{ id: ".", name: "Default" }];
  return [];
}

interface FirefoxProfile extends ImportProfile {
  path: string;
}
function firefoxProfiles(dir: string): FirefoxProfile[] {
  let text: string;
  try {
    text = readFileSync(join(dir, "profiles.ini"), "utf8");
  } catch {
    return [];
  }
  const sections: Record<string, string>[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      sections.push({ "": section[1] });
      continue;
    }
    const pair = /^([^=;#]+)=(.*)$/.exec(line);
    const current = sections[sections.length - 1];
    if (pair && current) current[pair[1].trim()] = pair[2].trim();
  }
  // Each [Install...] section names the profile that install actually opens;
  // the older Default=1 flag often points at an unused profile.
  const defaults = sections
    .filter((section) => section[""].startsWith("Install"))
    .map((section) => section.Default);
  return sections
    .filter((section) => section[""].startsWith("Profile") && section.Path)
    .map((section) => ({
      id: section.Path,
      name: section.Name || section.Path,
      path: section.IsRelative === "1" ? join(dir, section.Path) : section.Path,
    }))
    .filter((profile) => existsSync(profile.path))
    .sort(
      (a, b) => Number(defaults.includes(b.id)) - Number(defaults.includes(a.id)),
    );
}

function profilesOf(id: BrowserId, dir: string): ImportProfile[] {
  const engine = browsers[id].engine;
  if (engine === "safari") return [{ id: "default", name: "Default" }];
  if (engine === "firefox")
    return firefoxProfiles(dir).map(({ id, name }) => ({ id, name }));
  return chromiumProfiles(dir);
}

// A data folder that refuses to be listed, or on macOS an installed browser's
// folder that lists as empty, waits for the person's permission. Safari's
// live files are never probed.
function needsPermission(id: BrowserId, dir: string, env: ImportEnv): boolean {
  const { engine, app } = browsers[id];
  if (engine === "safari") return false;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    return permissionDenied(error);
  }
  return (
    env.platform === "darwin" &&
    entries.length === 0 &&
    app !== undefined &&
    existsSync(join(env.applications ?? "/Applications", `${app}.app`))
  );
}

export function availableBrowsers(env: ImportEnv = defaultEnv()): ImportSource[] {
  const preferred = defaultBrowser(env);
  const found: ImportSource[] = [];
  for (const id of ids) {
    const dir = dataDir(id, env);
    if (!dir || !existsSync(dir)) continue;
    const blocked = needsPermission(id, dir, env);
    found.push({
      id,
      name: browsers[id].name,
      profiles: blocked ? [] : profilesOf(id, dir),
      default: id === preferred,
      signInsAvailable: browsers[id].engine === "chromium",
      status: blocked ? "needs_permission" : "ready",
    });
  }
  return found;
}

export function handlerName(env: ImportEnv): string | undefined {
  const exec = env.exec ?? run;
  if (env.platform === "darwin") {
    const plist = join(
      env.home,
      "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist",
    );
    const parsed = record(
      parsePlistXml(exec("plutil", ["-convert", "xml1", "-o", "-", plist])),
    );
    const entries = Array.isArray(parsed.LSHandlers) ? parsed.LSHandlers : [];
    for (const scheme of ["https", "http"]) {
      const handler = record(
        entries.find((entry) => record(entry).LSHandlerURLScheme === scheme),
      );
      const role = handler.LSHandlerRoleAll ?? handler.LSHandlerRoleViewer;
      if (typeof role === "string") return role;
    }
    // Nothing registered means the system default, Safari.
    return "com.apple.safari";
  }
  if (env.platform === "win32") {
    const output = exec("reg", [
      "query",
      "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
      "/v",
      "ProgId",
    ]);
    return /ProgId\s+REG_SZ\s+(\S+)/.exec(output)?.[1];
  }
  if (env.platform === "linux")
    return exec("xdg-settings", ["get", "default-web-browser"]).trim();
  return undefined;
}

export function defaultBrowser(env: ImportEnv = defaultEnv()): BrowserId | undefined {
  try {
    const handler = handlerName(env)?.toLowerCase();
    if (!handler) return undefined;
    return handlers.find(([, pattern]) => pattern.test(handler))?.[0];
  } catch {
    return undefined;
  }
}

export function entry(title: unknown, url: unknown): ImportedBookmark | undefined {
  if (typeof url !== "string" || !isWebUrl(url)) return undefined;
  const text = typeof title === "string" ? title.trim() : "";
  return { title: (text || url).slice(0, TITLE_LENGTH), url };
}

export function visit(
  title: unknown,
  url: unknown,
  time: number,
  count: unknown,
): ImportedVisit | undefined {
  const base = entry(title, url);
  if (!base || !Number.isFinite(time) || time <= 0) return undefined;
  return {
    ...base,
    visitedAt: Math.min(Math.round(time), Date.now()),
    visits:
      typeof count === "number" && Number.isInteger(count) && count > 0
        ? count
        : 1,
  };
}

export function unique<T extends { url: string }>(items: Iterable<T>): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    kept.push(item);
    if (kept.length === LIMIT) break;
  }
  return kept;
}

export function parseChromiumBookmarks(json: unknown): ImportedBookmark[] {
  const found: ImportedBookmark[] = [];
  const walk = (node: unknown) => {
    const { type, name, url, children } = record(node);
    if (type === "url") {
      const item = entry(name, url);
      if (item) found.push(item);
    } else if (Array.isArray(children)) children.forEach(walk);
  };
  const roots = record(record(json).roots);
  for (const root of ["bookmark_bar", "other", "synced"]) walk(roots[root]);
  return unique(found);
}

function firefoxBookmarks(db: DatabaseSync): ImportedBookmark[] {
  interface Row {
    id: number;
    parent: number;
    type: number;
    title: string | null;
    guid: string | null;
    url: string | null;
  }
  const rows = db.prepare(firefoxBookmarkRows).all() as unknown as Row[];
  const children = new Map<number, Row[]>();
  for (const row of rows) {
    const siblings = children.get(row.parent) ?? [];
    siblings.push(row);
    children.set(row.parent, siblings);
  }
  const found: ImportedBookmark[] = [];
  const walk = (parent: number) => {
    for (const row of children.get(parent) ?? []) {
      if (row.type === 1) {
        const item = entry(row.title, row.url);
        if (item) found.push(item);
      } else if (row.type === 2) walk(row.id);
    }
  };
  // Walking from the visible roots leaves the tag folders out.
  for (const guid of ["toolbar_____", "menu________", "unfiled_____", "mobile______"]) {
    const root = rows.find((row) => row.guid === guid);
    if (root) walk(root.id);
  }
  return unique(found);
}

function visits(
  db: DatabaseSync,
  sql: string,
  convert: (time: number) => number,
): ImportedVisit[] {
  const statement = db.prepare(sql);
  function* found() {
    for (const row of statement.iterate()) {
      const time = typeof row.time === "number" ? convert(row.time) : NaN;
      const item = visit(row.title, row.url, time, row.visits);
      if (item) yield item;
    }
  }
  return unique(found());
}

// Browsers keep their SQLite files locked while they run, so every read works
// on a private copy (with the journal siblings) that is removed afterwards.
async function withCopy<T>(
  file: string,
  read: (copy: string) => T,
): Promise<T> {
  const temporary = await mkdtemp(join(tmpdir(), "kamapathy-import-"));
  try {
    const copy = join(temporary, basename(file));
    await copyFile(file, copy);
    for (const suffix of ["-wal", "-journal"])
      if (existsSync(file + suffix)) await copyFile(file + suffix, copy + suffix);
    return read(copy);
  } finally {
    // A scanner may still hold the fresh copy (EBUSY on Windows); a failed
    // cleanup must not turn a successful read into an error.
    await rm(temporary, { recursive: true, force: true, maxRetries: 3 }).catch(
      () => undefined,
    );
  }
}

export function withDatabase<T>(
  file: string,
  read: (db: DatabaseSync) => T,
): Promise<T> {
  return withCopy(file, (copy) => {
    const db = new DatabaseSync(copy, { readOnly: true });
    try {
      return read(db);
    } finally {
      db.close();
    }
  });
}

function pick<T extends ImportProfile>(
  profiles: T[],
  requested: string | undefined,
  name: string,
): T {
  const chosen =
    requested === undefined
      ? profiles[0]
      : profiles.find((profile) => profile.id === requested);
  if (!chosen) throw new Error(`${name} profile was not found.`);
  return chosen;
}

// Reads one profile's bookmarks and history. A missing file means there is
// nothing to import; anything else is reported and the rest goes on. A read
// the system refused also marks the profile blocked.
async function readProfile(
  id: BrowserId,
  profileDir: string,
  options: { bookmarks: boolean; history: boolean },
): Promise<{ result: ImportResult; blocked: boolean }> {
  const browser = browsers[id];
  const result: ImportResult = { bookmarks: [], history: [], warnings: [] };
  let blocked = false;
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (permissionDenied(error)) blocked = true;
      const warning = `Could not read ${browser.name} ${what}.`;
      if (!result.warnings.includes(warning)) result.warnings.push(warning);
    }
  };
  if (browser.engine === "firefox") {
    const wanted = [
      options.bookmarks && "bookmarks",
      options.history && "history",
    ].filter(Boolean);
    if (wanted.length)
      await attempt(wanted.join(" and "), async () => {
        await withDatabase(join(profileDir, "places.sqlite"), (db) => {
          if (options.bookmarks) result.bookmarks = firefoxBookmarks(db);
          if (options.history)
            result.history = visits(db, firefoxHistory, firefoxTime);
        });
      });
  } else {
    if (options.bookmarks)
      await attempt("bookmarks", async () => {
        const text = await readFile(join(profileDir, "Bookmarks"), "utf8");
        result.bookmarks = parseChromiumBookmarks(JSON.parse(text));
      });
    if (options.history)
      await attempt("history", async () => {
        result.history = await withDatabase(join(profileDir, "History"), (db) =>
          visits(db, chromiumHistory, chromiumTime),
        );
      });
  }
  return { result, blocked };
}

export async function importFrom(
  id: BrowserId,
  profile: string | undefined,
  options: { bookmarks: boolean; history: boolean },
  env: ImportEnv = defaultEnv(),
): Promise<ImportResult> {
  const browser = browsers[id];
  if (!browser) throw new Error("Unknown browser.");
  const dir = dataDir(id, env);
  if (!dir || !existsSync(dir))
    throw new Error(`${browser.name} was not found on this computer.`);
  const profileDir =
    browser.engine === "firefox"
      ? pick(firefoxProfiles(dir), profile, browser.name).path
      : join(dir, pick(chromiumProfiles(dir), profile, browser.name).id);
  return (await readProfile(id, profileDir, options)).result;
}

export function parseImportRequest(value: unknown): ImportRequest {
  const invalid = () =>
    new ImportError("import_invalid_request", INVALID_REQUEST);
  if (!isObject(value)) throw invalid();
  let size: number;
  try {
    size = JSON.stringify(value).length;
  } catch {
    throw invalid();
  }
  const { profiles, bookmarks, history, signIns } = value;
  if (
    size > REQUEST_LIMIT ||
    !Array.isArray(profiles) ||
    profiles.length < 1 ||
    profiles.length > SELECTION_LIMIT ||
    typeof bookmarks !== "boolean" ||
    typeof history !== "boolean" ||
    !signInsTargets.includes(signIns as SignInsTarget) ||
    (!bookmarks && !history && signIns === "none")
  )
    throw invalid();
  const selections: ImportSelection[] = [];
  const seen = new Set<string>();
  for (const item of profiles) {
    if (!isObject(item)) throw invalid();
    const { source, profile } = item;
    if (
      typeof source !== "string" ||
      !ids.includes(source as BrowserId) ||
      source === "safari" ||
      (profile !== undefined &&
        (typeof profile !== "string" || profile.length > PROFILE_LENGTH))
    )
      throw invalid();
    const key = JSON.stringify([source, profile ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    selections.push(profile === undefined ? { source } : { source, profile });
  }
  return {
    profiles: selections,
    bookmarks,
    history,
    signIns: signIns as SignInsTarget,
  };
}

interface ResolvedSelection {
  id: BrowserId;
  engine: "chromium" | "firefox" | "safari";
  browser: string;
  profile: string;
  dataDir: string;
  profileDir: string;
}

/** Where one selection's files are and what it is called; ImportError source_not_found or profile_not_found. Section 18 reads Login Data from the same profileDir. */
export function resolveSelection(
  selection: ImportSelection,
  sources: readonly ImportSource[],
  env: ImportEnv = defaultEnv(),
): ResolvedSelection {
  const source = sources.find((item) => item.id === selection.source);
  const dir = source && dataDir(source.id, env);
  if (!source || !dir || !existsSync(dir))
    throw new ImportError(
      "source_not_found",
      "That browser was not found on this computer.",
    );
  const { name, engine } = browsers[source.id];
  const profile =
    selection.profile === undefined
      ? source.profiles[0]
      : source.profiles.find((item) => item.id === selection.profile);
  // Firefox profiles can live outside the data folder.
  const profileDir = !profile
    ? undefined
    : engine === "safari"
      ? dir
      : engine === "firefox"
        ? firefoxProfiles(dir).find((item) => item.id === profile.id)?.path
        : join(dir, profile.id);
  if (!profile || !profileDir)
    throw new ImportError("profile_not_found", "That profile was not found.");
  return {
    id: source.id,
    engine,
    browser: name,
    profile: profile.name,
    dataDir: dir,
    profileDir,
  };
}

export async function importSelections(
  selections: readonly ImportSelection[],
  options: { bookmarks: boolean; history: boolean; signIns: boolean },
  env: ImportEnv = defaultEnv(),
): Promise<SelectionResult> {
  const sources = availableBrowsers(env);
  // Browsers the system would not let Kamapathy read, by name.
  const blocked = new Set<string>();
  // Every selection is found before anything is read or any key is asked
  // for, so a browser or profile that went away fails the whole request.
  const places: ResolvedSelection[] = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    const source = sources.find((item) => item.id === selection.source);
    if (source?.status === "needs_permission") {
      blocked.add(source.name);
      continue;
    }
    const place = resolveSelection(selection, sources, env);
    const key = `${place.id}\n${place.profileDir}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(place);
  }
  const keys = keyCache({
    platform: env.platform,
    run: env.command ?? defaultRun(),
  });
  const bookmarks: ImportedBookmark[] = [];
  const history: ImportedVisit[] = [];
  const profiles: ProfileCookies[] = [];
  const warnings: string[] = [];
  const warn = (warning: string) => {
    if (!warnings.includes(warning)) warnings.push(warning);
  };
  let readable = 0;
  let skipped = 0;
  for (const place of places) {
    const read = await readProfile(place.id, place.profileDir, options);
    bookmarks.push(...read.result.bookmarks);
    history.push(...read.result.history);
    if (read.blocked) {
      blocked.add(place.browser);
      continue;
    }
    readable++;
    read.result.warnings.forEach(warn);
    if (!options.signIns || place.engine !== "chromium") continue;
    let keyring: SafeStorageKeys;
    try {
      keyring = await keys(place.id as ChromiumBrowserId, place.dataDir);
    } catch {
      warn(
        `Kamapathy could not get the sign-in key for ${place.browser} from your keychain.`,
      );
      continue;
    }
    try {
      const found = await readChromiumCookies(
        place.profileDir,
        keyring,
        env.platform,
      );
      skipped += found.skipped;
      if (found.cookies.length)
        profiles.push({
          source: place.id,
          browser: place.browser,
          profile: place.profile,
          cookies: found.cookies,
        });
      else if (found.skipped)
        warn(
          `Sign-ins from ${place.browser} could not be imported on this system.`,
        );
    } catch (error) {
      if (permissionDenied(error)) blocked.add(place.browser);
      else warn(`Could not read ${place.browser} sign-ins.`);
    }
  }
  if (blocked.size && !readable)
    throw new ImportError(
      "read_blocked",
      "Kamapathy needs permission to read this browser's data.",
      { sources: [...blocked] },
    );
  for (const name of blocked)
    warn(`Kamapathy needs permission to read ${name}'s data.`);
  if (skipped)
    warn(
      skipped === 1
        ? "1 sign-in could not be read and was left out."
        : `${skipped} sign-ins could not be read and were left out.`,
    );
  return {
    bookmarks: unique(bookmarks),
    history: unique(history),
    profiles,
    warnings,
  };
}

/** import:apply once, returning the net new counts; Safari's archive uses it too. */
export async function applyImported(
  target: ImportTarget,
  data: { bookmarks: ImportedBookmark[]; history: ImportedVisit[] },
): Promise<{ bookmarks: number; history: number }> {
  if (!data.bookmarks.length && !data.history.length)
    return { bookmarks: 0, history: 0 };
  const bookmarksBefore = target.state.bookmarks.length;
  const known = new Set(target.state.history.map((entry) => entry.url));
  await target.dispatch({
    type: "import:apply",
    bookmarks: data.bookmarks,
    history: data.history,
  });
  return {
    bookmarks: target.state.bookmarks.length - bookmarksBefore,
    history: target.state.history.filter((entry) => !known.has(entry.url))
      .length,
  };
}

export async function runImport(
  target: ImportTarget,
  request: ImportRequest,
  env: ImportEnv = defaultEnv(),
): Promise<ImportOutcome> {
  const { signIns } = request;
  const data = await importSelections(
    request.profiles,
    {
      bookmarks: request.bookmarks,
      history: request.history,
      signIns: signIns !== "none",
    },
    env,
  );
  const counts = await applyImported(target, data);
  const cookies =
    signIns !== "none" && data.profiles.some((item) => item.cookies.length)
      ? await target.applyImportedCookies(signIns, data.profiles)
      : { written: 0, spaces: [], warnings: [] };
  return {
    bookmarks: counts.bookmarks,
    history: counts.history,
    signIns: cookies.written,
    spaces: cookies.spaces,
    warnings: [...data.warnings, ...cookies.warnings],
  };
}

let importing = false;
/** One import at a time across kamapathy:import and kamapathy:import-safari. */
export async function exclusive<T>(run: () => Promise<T>): Promise<T> {
  if (importing)
    throw new ImportError("import_busy", "An import is already running.", {
      retryable: true,
    });
  importing = true;
  try {
    return await run();
  } finally {
    importing = false;
  }
}
