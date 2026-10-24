import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  NAME_LIMIT,
  STORE_UPDATE_URL,
  cleanExtensionText,
  compareVersions,
  isComponentExtension,
  isExtensionId,
  isVersion,
  type ExtensionCandidate,
  type ExtensionImportList,
  type ExtensionImportProgress,
  type ExtensionImportRequest,
  type ExtensionImportResult,
  type Grant,
} from "../../shared/extensions";
import { extensionImportCopy } from "../../src/copy";
import {
  browserName,
  chromiumProfiles,
  dataDir,
  isChromiumFamily,
  type BrowserId,
  type ImportEnv,
} from "../import";
import type { ExtensionHost } from "./host";
import type { ExtensionInstaller } from "./install";
import { ManifestRefusal, localize, readManifest } from "./manifest";

// The other stores a Chrome-family profile points at. Their items are listed,
// so the person sees why they are not coming over.
export const EDGE_UPDATE_HOST = "edge.microsoft.com";
export const OPERA_UPDATE_HOST = "extension-updates.opera.com";

// Where a profile's extensions were installed from. Only these three are
// offered: everything else belongs to the browser or its administrator.
const STORE_LOCATIONS = [1, 6];
const UNPACKED_LOCATION = 4;
// Chrome rewrites its preference files while it runs, so one parse failure is
// read again.
const RETRY_MS = 200;
// How long a failure the person reads may be.
const MESSAGE_LIMIT = 300;

export interface ExtensionImportContext {
  host: Pick<ExtensionHost, "entry">;
  developerMode: boolean;
  chromeVersion: string;
  locale: string;
  env?: ImportEnv;
}
export interface SourceExtensions {
  list: ExtensionImportList;
  // id to its newest local build, or an unpacked item's folder. Main only:
  // the shell never sees a path.
  folders: Map<string, string>;
  // id to what the local build asks for, which the person agrees to once.
  grants: Map<string, Grant>;
}

type Settings = Record<string, Record<string, unknown>>;
type Reader = (path: string) => Promise<string>;

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function defaultEnv(): ImportEnv {
  return {
    platform: process.platform,
    home: homedir(),
    appData: process.env.APPDATA,
    localAppData: process.env.LOCALAPPDATA,
  };
}

// One preference file, read-only. A missing file is empty; a half written one
// is read again before being given up on.
async function readPreferences(
  path: string,
  read: Reader,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    let text: string;
    try {
      text = await read(path);
    } catch {
      return {};
    }
    try {
      return objectOf(JSON.parse(text));
    } catch {
      if (attempt > 0) return {};
      await wait(RETRY_MS);
    }
  }
}

export async function readExtensionSettings(
  profileDir: string,
  read: Reader = (path) => readFile(path, "utf8"),
): Promise<{ settings: Settings; pinned: string[] }> {
  const plain = await readPreferences(join(profileDir, "Preferences"), read);
  const secure = await readPreferences(
    join(profileDir, "Secure Preferences"),
    read,
  );
  const settingsOf = (file: Record<string, unknown>): Settings => {
    const found: Settings = {};
    for (const [id, value] of Object.entries(
      objectOf(objectOf(file.extensions).settings),
    ))
      found[id] = objectOf(value);
    return found;
  };
  const pinnedOf = (file: Record<string, unknown>): string[] | undefined => {
    const pinned = objectOf(file.extensions).pinned_extensions;
    return Array.isArray(pinned) ? pinned.filter(isExtensionId) : undefined;
  };
  return {
    // The protected copy wins for an id both files know.
    settings: { ...settingsOf(plain), ...settingsOf(secure) },
    pinned: pinnedOf(secure) ?? pinnedOf(plain) ?? [],
  };
}

interface LocalBuild {
  folder: string;
  version: string;
}
// The newest build of a store item: folders are named <version>_<n>.
async function newestBuild(
  profileDir: string,
  id: string,
): Promise<LocalBuild | undefined> {
  const root = join(profileDir, "Extensions", id);
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return undefined;
  }
  let best: LocalBuild | undefined;
  for (const name of names) {
    const version = name.split("_")[0];
    if (!isVersion(version)) continue;
    if (!best || compareVersions(version, best.version) > 0)
      best = { folder: join(root, name), version };
  }
  return best;
}
// An unpacked item still loads from where the other browser left it.
async function unpackedBuild(
  path: unknown,
  hint: Record<string, unknown>,
): Promise<LocalBuild | undefined> {
  const folder = stringOf(path);
  if (!folder || !isAbsolute(folder)) return undefined;
  try {
    await readFile(join(folder, "manifest.json"));
  } catch {
    return undefined;
  }
  const version = hint.version;
  return { folder, version: isVersion(version) ? version : "" };
}

// No disable_reasons, or none left, and not turned off.
function isEnabled(setting: Record<string, unknown>): boolean {
  const reasons = setting.disable_reasons;
  const disabled = Array.isArray(reasons)
    ? reasons.length > 0
    : typeof reasons === "number"
      ? reasons !== 0
      : reasons !== undefined && reasons !== null;
  return !disabled && setting.state !== 0;
}
// Store items keep their store id, so Kamapathy can install them again. Edge
// and Opera add-ons, and anything with another update URL, cannot come over.
function isStoreItem(
  setting: Record<string, unknown>,
  manifest: Record<string, unknown>,
): boolean {
  if (setting.from_webstore === true) return true;
  const updateUrl =
    stringOf(objectOf(setting.manifest).update_url) ??
    stringOf(manifest.update_url);
  return updateUrl === STORE_UPDATE_URL;
}

export async function extensionCandidates(
  source: BrowserId,
  profile: string | undefined,
  context: ExtensionImportContext,
): Promise<SourceExtensions> {
  const browser = browserName(source);
  const empty = (profileName = ""): SourceExtensions => ({
    list: {
      source,
      profile: profile ?? "",
      browser,
      profileName,
      candidates: [],
    },
    folders: new Map(),
    grants: new Map(),
  });
  if (!isChromiumFamily(source)) return empty();
  const dir = dataDir(source, context.env ?? defaultEnv());
  if (!dir) return empty();
  const profiles = chromiumProfiles(dir);
  const chosen = profile
    ? profiles.find((item) => item.id === profile)
    : profiles[0];
  if (!chosen) return empty();
  // Opera keeps its one profile in the data folder itself, as ".".
  const profileDir = join(dir, chosen.id);
  const { settings, pinned } = await readExtensionSettings(profileDir);
  const candidates: ExtensionCandidate[] = [];
  const folders = new Map<string, string>();
  const grants = new Map<string, Grant>();
  for (const [id, setting] of Object.entries(settings)) {
    if (!isExtensionId(id) || isComponentExtension(id)) continue;
    const location = setting.location;
    const unpacked = location === UNPACKED_LOCATION;
    if (
      !unpacked &&
      (typeof location !== "number" || !STORE_LOCATIONS.includes(location))
    )
      continue;
    const hint = objectOf(setting.manifest);
    const build = unpacked
      ? await unpackedBuild(setting.path, hint)
      : await newestBuild(profileDir, id);
    if (!build) continue;
    const added = context.host.entry(id) !== undefined;
    const shared = { id, added, pinned: pinned.includes(id) };
    let manifest;
    try {
      manifest = await readManifest(build.folder, {
        chromeVersion: context.chromeVersion,
        locale: context.locale,
        installed: 0,
        replacing: true,
      });
    } catch (error) {
      // A build Kamapathy refuses is listed with the reason, never checked.
      if (!(error instanceof ManifestRefusal)) continue;
      candidates.push({
        ...shared,
        name: cleanExtensionText(
          localize(stringOf(hint.name) ?? id, undefined) || id,
          NAME_LIMIT,
        ),
        version: build.version,
        kind: "unavailable",
        checked: false,
        lines: [],
        wontWork: [],
        note: error.message,
      });
      continue;
    }
    const kind = unpacked
      ? "unpacked"
      : isStoreItem(setting, manifest.manifest)
        ? "store"
        : "unavailable";
    const addable =
      kind === "store" || (kind === "unpacked" && context.developerMode);
    const note =
      kind === "unavailable"
        ? extensionImportCopy.unavailable
        : kind === "unpacked" && !context.developerMode
          ? extensionImportCopy.needsDeveloperMode
          : undefined;
    candidates.push({
      ...shared,
      name: manifest.name,
      version: manifest.version,
      kind,
      checked:
        addable &&
        !added &&
        isEnabled(setting) &&
        setting.was_installed_by_default !== true &&
        setting.was_installed_by_oem !== true,
      lines: manifest.lines,
      wontWork: manifest.wontWork,
      ...(note ? { note } : {}),
    });
    folders.set(id, build.folder);
    grants.set(id, {
      permissions: manifest.permissions,
      hosts: manifest.hosts,
    });
  }
  return {
    list: {
      source,
      profile: chosen.id,
      browser,
      profileName: chosen.name,
      candidates,
    },
    folders,
    grants,
  };
}

// The person's "Add N extensions": one dialog, then one install at a time, in
// the order the step listed them. The candidates are read from disk again, so
// nothing the shell sent decides what is installed or from where.
export async function importExtensions(
  request: ExtensionImportRequest,
  context: ExtensionImportContext & {
    installer: Pick<ExtensionInstaller, "installFromStore" | "loadUnpacked">;
    confirm(browser: string, count: number): Promise<boolean>;
    progress(rows: ExtensionImportProgress[]): void;
  },
): Promise<ExtensionImportResult> {
  const { list, folders, grants } = await extensionCandidates(
    request.source as BrowserId,
    request.profile,
    context,
  );
  const wanted = new Set(request.ids);
  const chosen = list.candidates.filter(
    (candidate) =>
      wanted.has(candidate.id) &&
      !candidate.added &&
      (candidate.kind === "store" ||
        (candidate.kind === "unpacked" && context.developerMode)),
  );
  if (!chosen.length) return { results: [] };
  if (!(await context.confirm(list.browser, chosen.length)))
    return { results: [] };
  const rows: ExtensionImportProgress[] = [];
  const report = () => context.progress(rows.map((row) => ({ ...row })));
  for (const candidate of chosen) {
    const row: ExtensionImportProgress = {
      id: candidate.id,
      name: candidate.name,
      status: "adding",
    };
    rows.push(row);
    report();
    const options = {
      importedFrom: list.browser,
      pinned: candidate.pinned,
      consented: grants.get(candidate.id),
    };
    try {
      const folder = folders.get(candidate.id);
      const outcome =
        candidate.kind === "unpacked"
          ? await context.installer.loadUnpacked(folder, options)
          : await context.installer.installFromStore(candidate.id, options);
      // A Cancel in a build's own dialog adds nothing and says nothing.
      row.status = outcome.added ? "added" : "failed";
    } catch (error) {
      row.status = "failed";
      row.message = messageOf(error).slice(0, MESSAGE_LIMIT);
    }
    report();
  }
  return { results: rows };
}
