import type { Session, WebContents } from "electron";
import type { Dirent } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  MAX_PINNED,
  compareVersions,
  extensionIdOf,
  extensionPermission,
  isComponentExtension,
  isExtensionId,
  restoreExtensions,
  type ExtensionEntry,
  type ExtensionsFile,
  type Grant,
} from "../../shared/extensions";
import {
  extensionInstallCopy,
  extensionRefusalCopy,
  extensionRemoveCopy,
} from "../../src/copy";
import {
  ManifestRefusal,
  readManifest,
  type CheckedManifest,
} from "./manifest";

export const EXTENSIONS_FILE = "extensions.json";
export const STORE_FOLDER = "Extensions";
export const STAGING_FOLDER = ".staging";
const SETTINGS_FOLDERS = [
  "Local Extension Settings",
  "Sync Extension Settings",
];
// Electron's load errors are shown cut to this length.
const MESSAGE_LIMIT = 300;
const NONE: ReadonlySet<string> = new Set();

export type HostEvent =
  | { type: "loaded"; id: string; partition: string }
  | { type: "unloaded"; id: string; partition: string }
  | { type: "attached"; partition: string }
  | { type: "detached"; partition: string }
  // Entries, manifests or load errors changed.
  | { type: "changed" };
export interface HostOptions {
  userData: string;
  locale: string;
  chromeVersion: string;
  now?: () => number;
}
// An extension's action popup or one of its windows: pages that aren't tabs.
export interface SurfaceInfo {
  kind: "popup" | "window";
  extensionId: string;
  partition: string;
  spaceId?: string;
  windowId?: number;
}
type SessionSetup = (partition: string, ses: Session) => (() => void) | void;

// A session that runs the person's extensions, what the host loaded there and
// the cleanups of the setup hooks that ran for it.
interface Attached {
  session: Session;
  loaded: Set<string>;
  cleanups: Map<SessionSetup, () => void>;
  ready: Promise<void>;
}

// Electron gave the folder another id than the entry's.
class OtherId extends Error {
  constructor() {
    super(extensionRefusalCopy.loadFailed);
  }
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
function logError(context: string, error: unknown): void {
  console.error(`${context}:`, messageOf(error));
}

// The person's extensions: the one owner of extensions.json and of every load
// into the persistent sessions that run them. Only ids in extensions.json are
// ever unloaded, so component extensions such as the PDF viewer stay loaded.
export class ExtensionHost {
  readonly userData: string;
  private readonly locale: string;
  private readonly chromeVersion: string;
  private readonly now: () => number;
  private developer = false;
  private file: ExtensionsFile = { extensions: [], removals: [] };
  private manifests = new Map<string, CheckedManifest>();
  private errors = new Map<string, string>();
  private attached = new Map<string, Attached>();
  // Bumped when an extension unloads, so loads still running undo themselves.
  private generations = new Map<string, number>();
  // Loads into one session run one at a time, so an undone load never races
  // a newer one.
  private queues = new WeakMap<Session, Promise<unknown>>();
  private hooks = new Set<SessionSetup>();
  private listeners = new Set<(event: HostEvent) => void>();
  private writing: Promise<void> = Promise.resolve();
  private surfaces = new Map<WebContents, SurfaceInfo>();

  constructor(options: HostOptions) {
    this.userData = options.userData;
    this.locale = options.locale;
    this.chromeVersion = options.chromeVersion;
    this.now = options.now ?? Date.now;
  }

  get developerMode(): boolean {
    return this.developer;
  }

  // Reads extensions.json and applies what waited for a launch: Remove's
  // last step and staged builds. Nothing is loaded yet.
  async init(): Promise<void> {
    let changed = false;
    try {
      this.file = restoreExtensions(
        JSON.parse(
          await readFile(join(this.userData, EXTENSIONS_FILE), "utf8"),
        ),
      );
    } catch (error) {
      // Missing or unreadable reads as empty; the next save replaces it.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        logError("Extensions could not be read", error);
    }
    try {
      await rm(join(this.userData, STORE_FOLDER, STAGING_FOLDER), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      logError("Extension downloads could not be removed", error);
    }
    if (this.file.removals.length)
      try {
        await this.deleteSettings(this.file.removals);
        this.file.removals = [];
        changed = true;
      } catch (error) {
        logError("Removed extensions' data could not be deleted", error);
      }
    const entries: ExtensionEntry[] = [];
    for (const entry of this.file.extensions)
      if (entry.staged && !entry.staged.review) {
        entries.push(await this.applyStaged(entry));
        changed = true;
      } else entries.push(entry);
    this.file.extensions = entries;
    for (const entry of entries) await this.check(entry);
    if (changed)
      await this.write().catch((error) =>
        logError("Extensions could not be saved", error),
      );
    this.emit({ type: "changed" });
  }

  async setDeveloperMode(on: boolean): Promise<void> {
    if (on === this.developer) return;
    this.developer = on;
    const unpacked = this.file.extensions.filter(
      (entry) => entry.source === "unpacked",
    );
    if (!on) {
      for (const entry of unpacked) this.unloadEverywhere(entry.id);
      return;
    }
    for (const { id } of unpacked)
      for (const [partition, record] of [...this.attached]) {
        const entry = this.entry(id);
        if (!entry || !this.runs(entry)) break;
        try {
          await this.load(partition, record, id);
        } catch (error) {
          this.failed(id, error);
        }
      }
  }

  // Loads the enabled extensions into a persistent session. Electron can't
  // load extensions into in-memory sessions, so others are never recorded.
  attach(partition: string, ses: Session): Promise<void> {
    if (!partition.startsWith("persist:")) return Promise.resolve();
    const existing = this.attached.get(partition);
    if (existing) return existing.ready;
    const record: Attached = {
      session: ses,
      loaded: new Set(),
      cleanups: new Map(),
      ready: Promise.resolve(),
    };
    this.attached.set(partition, record);
    for (const hook of this.hooks) this.setUp(hook, partition, record);
    record.ready = this.loadAll(partition, record);
    return record.ready;
  }

  // Resolves when every session settles or after timeoutMs; loads still
  // running keep going.
  async attachAll(
    partitions: readonly string[],
    timeoutMs: number,
    sessionFor: (partition: string) => Session,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attaching = Promise.allSettled(
      partitions.map(async (partition) =>
        this.attach(partition, sessionFor(partition)),
      ),
    );
    await Promise.race([
      attaching,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
  }

  detach(partition: string): void {
    const record = this.attached.get(partition);
    if (!record) return;
    this.attached.delete(partition);
    const unloaded = [...record.loaded].filter((id) => this.entry(id));
    record.loaded.clear();
    for (const id of unloaded) this.removeFrom(record.session, id);
    for (const cleanup of record.cleanups.values())
      this.safely("An extension session could not be cleaned up", cleanup);
    record.cleanups.clear();
    for (const id of unloaded) this.emit({ type: "unloaded", id, partition });
    this.emit({ type: "detached", partition });
  }

  partitions(): string[] {
    return [...this.attached.keys()];
  }

  sessionOf(partition: string): Session | undefined {
    return this.attached.get(partition)?.session;
  }

  partitionOf(ses: Session): string | undefined {
    for (const [partition, record] of this.attached)
      if (record.session === ses) return partition;
    return undefined;
  }

  entries(): readonly ExtensionEntry[] {
    return this.file.extensions;
  }

  entry(id: string): ExtensionEntry | undefined {
    return this.file.extensions.find((entry) => entry.id === id);
  }

  manifestOf(id: string): CheckedManifest | undefined {
    return this.manifests.get(id);
  }

  loadError(id: string): string | undefined {
    return this.errors.get(id);
  }

  nameOf(id: string): string | undefined {
    return this.entry(id) ? this.manifests.get(id)?.name : undefined;
  }

  loadedIds(partition: string): ReadonlySet<string> {
    return this.attached.get(partition)?.loaded ?? NONE;
  }

  isLoaded(partition: string, id: string): boolean {
    return this.attached.get(partition)?.loaded.has(id) ?? false;
  }

  // A page of an extension loaded in that session gets the clipboard and
  // location only when its manifest declares them, and nothing else. Other
  // pages, the PDF viewer's included, aren't the host's to answer.
  permissionFor(
    partition: string,
    requestingUrl: string,
    permission: string,
  ): boolean | undefined {
    const id = extensionIdOf(requestingUrl);
    if (!id || isComponentExtension(id)) return undefined;
    const manifest = this.manifests.get(id);
    return (
      !!manifest &&
      this.isLoaded(partition, id) &&
      extensionPermission(manifest.permissions, permission)
    );
  }

  // The host forgets a popup or window when its page is destroyed.
  addSurface(contents: WebContents, info: SurfaceInfo): void {
    if (contents.isDestroyed()) return;
    if (!this.surfaces.has(contents))
      contents.once("destroyed", () => this.surfaces.delete(contents));
    this.surfaces.set(contents, info);
  }

  surfaceOf(contents: WebContents): SurfaceInfo | undefined {
    return this.surfaces.get(contents);
  }

  surfacesOf(extensionId: string): WebContents[] {
    return [...this.surfaces]
      .filter(([, info]) => info.extensionId === extensionId)
      .map(([contents]) => contents);
  }

  isExtensionSurface(contents: WebContents): boolean {
    return this.surfaces.has(contents);
  }

  folderOf(entry: ExtensionEntry): string {
    return entry.source === "webstore"
      ? join(this.userData, entry.path)
      : entry.path;
  }

  async save(entry: ExtensionEntry, manifest: CheckedManifest): Promise<void> {
    this.manifests.set(entry.id, manifest);
    await this.store(entry);
  }

  // The reason the shell shows in an extension's row, for a folder the host
  // can no longer load.
  setLoadError(id: string, message: string): void {
    if (!this.entry(id) || this.errors.get(id) === message) return;
    this.errors.set(id, message);
    this.emit({ type: "changed" });
  }

  // Off unloads it everywhere and keeps its data. On loads it again, unless
  // it is unpacked and Developer mode is off.
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const entry = this.entry(id);
    if (!entry || entry.enabled === enabled) return;
    const next = { ...entry, enabled };
    await this.store(next);
    if (!enabled) {
      this.unloadEverywhere(id);
      return;
    }
    if (!this.wanted(next)) return;
    try {
      await this.loadEverywhere(id);
    } catch (error) {
      await this.store({ ...next, enabled: false });
      throw new Error(
        extensionInstallCopy.couldNotAdd(
          this.manifests.get(id)?.name ?? id,
          messageOf(error),
        ),
      );
    }
  }

  async setPinned(id: string, pinned: boolean): Promise<void> {
    const entry = this.entry(id);
    if (!entry || entry.pinned === pinned) return;
    if (
      pinned &&
      this.file.extensions.filter((item) => item.pinned).length >= MAX_PINNED
    )
      throw new Error(extensionRemoveCopy.pinLimit);
    await this.store({ ...entry, pinned });
  }

  // Remove's four steps: unload it, so its pages close with the unloaded
  // events; delete a store build's folder, never an unpacked one; clear its
  // origin in every session; and queue its chrome.storage folders, which
  // removeExtension keeps, for the next launch.
  async remove(id: string): Promise<void> {
    const entry = this.entry(id);
    if (!entry) return;
    this.unloadEverywhere(id);
    if (entry.source === "webstore")
      await rm(join(this.userData, STORE_FOLDER, id), {
        recursive: true,
        force: true,
      });
    for (const record of [...this.attached.values()])
      try {
        await record.session.clearStorageData({
          origin: `chrome-extension://${id}`,
        });
      } catch (error) {
        logError(`Extension ${id}'s storage could not be cleared`, error);
      }
    await this.queueRemoval(id);
    await this.forget(id);
  }

  // The id Electron gives an unpacked folder. It loads the folder into one
  // attached session and unloads it again, so that the entry the installer
  // then records loads everywhere with its manifest in place.
  async loadFolder(folder: string): Promise<string> {
    const [record] = [...this.attached.values()];
    if (!record) throw new Error(extensionRefusalCopy.loadFailed);
    const { id } = await record.session.extensions.loadExtension(folder, {
      allowFileAccess: false,
    });
    this.removeFrom(record.session, id);
    // Electron loaded the folder in place of an extension the host runs.
    if (record.loaded.has(id)) {
      this.unloadEverywhere(id);
      void this.loadEverywhere(id).catch((error) => this.failed(id, error));
    }
    return id;
  }

  // A newer build of a store extension replaces the running one: unload, swap
  // the folders, record and load. A load that fails puts the old build back.
  async replaceBuild(
    id: string,
    build: {
      version: string;
      folder: string;
      manifest: CheckedManifest;
      grant: Grant;
    },
  ): Promise<void> {
    const entry = this.replaceable(id, build.version);
    const path = `${STORE_FOLDER}/${id}/${build.version}`;
    const folder = join(this.userData, path);
    const manifest = this.manifests.get(id);
    const { staged: _staged, ...rest } = entry;
    this.unloadEverywhere(id);
    try {
      await this.moveInto(build.folder, folder);
      await this.save(
        {
          ...rest,
          version: build.version,
          path,
          grantedPermissions: build.grant.permissions,
          grantedHosts: build.grant.hosts,
        },
        build.manifest,
      );
      await this.loadEverywhere(id);
    } catch (error) {
      await rm(folder, { recursive: true, force: true });
      await this.save(rest, manifest ?? build.manifest);
      await this.loadEverywhere(id).catch((failure) =>
        this.failed(id, failure),
      );
      throw error;
    }
    await rm(join(this.userData, entry.path), { recursive: true, force: true });
  }

  // A build that waits: for the person's OK, or for a launch with none of the
  // extension's pages open. The running build keeps its manifest.
  async stage(
    id: string,
    build: {
      version: string;
      folder: string;
      manifest: CheckedManifest;
      review: boolean;
    },
  ): Promise<void> {
    const entry = this.replaceable(id, build.version);
    const path = `${STORE_FOLDER}/${id}/${build.version}`;
    await this.moveInto(build.folder, join(this.userData, path));
    await this.save(
      {
        ...entry,
        staged: {
          version: build.version,
          path,
          review: build.review,
          permissions: build.manifest.permissions,
          hosts: build.manifest.hosts,
        },
      },
      this.manifests.get(id) ?? build.manifest,
    );
  }

  async stagedManifest(id: string): Promise<CheckedManifest | undefined> {
    const staged = this.entry(id)?.staged;
    if (!staged) return undefined;
    try {
      return await readManifest(join(this.userData, staged.path), {
        chromeVersion: this.chromeVersion,
        locale: this.locale,
        installed: 0,
        replacing: true,
      });
    } catch (error) {
      logError(`Extension ${id}'s update could not be read`, error);
      return undefined;
    }
  }

  async forget(id: string): Promise<void> {
    if (!this.entry(id)) return;
    this.unloadEverywhere(id);
    this.file.extensions = this.file.extensions.filter(
      (entry) => entry.id !== id,
    );
    this.manifests.delete(id);
    this.errors.delete(id);
    this.emit({ type: "changed" });
    await this.write();
  }

  // Its chrome.storage folders are deleted at the next launch, before
  // anything loads.
  async queueRemoval(id: string): Promise<void> {
    if (
      !isExtensionId(id) ||
      isComponentExtension(id) ||
      this.file.removals.includes(id)
    )
      return;
    this.file.removals = [...this.file.removals, id];
    this.emit({ type: "changed" });
    await this.write();
  }

  // Loads it into every attached session that lacks it. A failed load
  // anywhere unloads it everywhere and rejects with Electron's message.
  async loadEverywhere(id: string): Promise<void> {
    if (!this.entry(id) || !this.manifests.has(id))
      throw new Error(this.errors.get(id) ?? extensionRefusalCopy.loadFailed);
    try {
      for (const [partition, record] of [...this.attached])
        await this.load(partition, record, id);
    } catch (error) {
      this.unloadEverywhere(id);
      throw new Error(messageOf(error).slice(0, MESSAGE_LIMIT));
    }
    if (this.errors.delete(id)) this.emit({ type: "changed" });
  }

  unloadEverywhere(id: string): void {
    if (!this.entry(id)) return;
    this.generations.set(id, this.generation(id) + 1);
    for (const [partition, record] of [...this.attached])
      if (record.loaded.delete(id)) {
        this.removeFrom(record.session, id);
        this.emit({ type: "unloaded", id, partition });
      }
  }

  // Runs before anything loads into each session, now for those already
  // attached. The returned cleanup runs when the session detaches.
  onSessionSetup(hook: SessionSetup): () => void {
    this.hooks.add(hook);
    for (const [partition, record] of this.attached)
      this.setUp(hook, partition, record);
    return () => {
      if (!this.hooks.delete(hook)) return;
      for (const record of this.attached.values()) {
        const cleanup = record.cleanups.get(hook);
        record.cleanups.delete(hook);
        if (cleanup)
          this.safely("An extension session could not be cleaned up", cleanup);
      }
    };
  }

  onEvent(listener: (event: HostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HostEvent): void {
    for (const listener of [...this.listeners])
      this.safely("An extension listener failed", () => listener(event));
  }

  private safely(context: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      logError(context, error);
    }
  }

  private setUp(hook: SessionSetup, partition: string, record: Attached): void {
    try {
      const cleanup = hook(partition, record.session);
      if (cleanup) record.cleanups.set(hook, cleanup);
    } catch (error) {
      logError("An extension session could not be set up", error);
    }
  }

  private generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }

  // Store extensions run while enabled, unpacked ones only in Developer mode.
  private wanted(entry: ExtensionEntry): boolean {
    return entry.enabled && (entry.source === "webstore" || this.developer);
  }

  private runs(entry: ExtensionEntry): boolean {
    return this.wanted(entry) && !this.errors.has(entry.id);
  }

  private async loadAll(partition: string, record: Attached): Promise<void> {
    for (const { id } of this.file.extensions) {
      if (this.attached.get(partition) !== record) return;
      const entry = this.entry(id);
      if (!entry || !this.runs(entry)) continue;
      try {
        await this.load(partition, record, id);
      } catch (error) {
        this.failed(id, error);
      }
    }
    if (this.attached.get(partition) === record)
      this.emit({ type: "attached", partition });
  }

  // Loads one entry into one session after the session's earlier loads. A
  // load that the session's detach, an unload or a change of the entry made
  // stale is undone.
  private load(partition: string, record: Attached, id: string): Promise<void> {
    const generation = this.generation(id);
    const current = () => {
      const entry = this.entry(id);
      return this.attached.get(partition) === record &&
        this.generation(id) === generation &&
        entry &&
        this.wanted(entry)
        ? entry
        : undefined;
    };
    const run = async () => {
      const entry = current();
      if (!entry || record.loaded.has(id)) return;
      const extension = await record.session.extensions.loadExtension(
        this.folderOf(entry),
        { allowFileAccess: false },
      );
      if (extension.id !== id) {
        if (
          !isComponentExtension(extension.id) &&
          !record.loaded.has(extension.id)
        )
          this.removeFrom(record.session, extension.id);
        throw new OtherId();
      }
      if (!current()) {
        this.removeFrom(record.session, id);
        return;
      }
      record.loaded.add(id);
      this.emit({ type: "loaded", id, partition });
    };
    const queued = (this.queues.get(record.session) ?? Promise.resolve()).then(
      run,
    );
    this.queues.set(
      record.session,
      queued.catch(() => undefined),
    );
    return queued;
  }

  private failed(id: string, error: unknown): void {
    logError(`Extension ${id} could not be loaded`, error);
    const message =
      error instanceof OtherId
        ? extensionRefusalCopy.loadFailed
        : `${extensionRefusalCopy.loadFailed} ${messageOf(error).slice(0, MESSAGE_LIMIT)}`;
    if (this.errors.get(id) === message) return;
    this.errors.set(id, message);
    this.emit({ type: "changed" });
  }

  private removeFrom(ses: Session, id: string): void {
    try {
      ses.extensions.removeExtension(id);
    } catch (error) {
      logError(`Extension ${id} could not be unloaded`, error);
    }
  }

  private async store(entry: ExtensionEntry): Promise<void> {
    this.file.extensions = this.entry(entry.id)
      ? this.file.extensions.map((item) =>
          item.id === entry.id ? entry : item,
        )
      : [...this.file.extensions, entry];
    this.emit({ type: "changed" });
    await this.write();
  }

  private async check(entry: ExtensionEntry): Promise<void> {
    try {
      this.manifests.set(
        entry.id,
        await readManifest(this.folderOf(entry), {
          chromeVersion: this.chromeVersion,
          locale: this.locale,
          installed: 0,
          replacing: true,
        }),
      );
    } catch (error) {
      if (!(error instanceof ManifestRefusal))
        logError(`Extension ${entry.id} could not be read`, error);
      this.errors.set(
        entry.id,
        error instanceof ManifestRefusal
          ? error.message
          : extensionRefusalCopy.loadFailed,
      );
    }
  }

  // Only a newer build of a store extension the host knows.
  private replaceable(id: string, version: string): ExtensionEntry {
    const entry = this.entry(id);
    if (
      !entry ||
      entry.source !== "webstore" ||
      compareVersions(version, entry.version) <= 0
    )
      throw new Error(extensionRefusalCopy.loadFailed);
    return entry;
  }

  // Moves a build into its version folder, or leaves one already there.
  private async moveInto(from: string, to: string): Promise<void> {
    await mkdir(dirname(to), { recursive: true });
    if (resolve(from) === resolve(to)) return;
    await rm(to, { recursive: true, force: true });
    await rename(from, to);
  }

  // A staged build that needs no review replaces the current one, unless its
  // folder is gone.
  private async applyStaged(entry: ExtensionEntry): Promise<ExtensionEntry> {
    const { staged, ...current } = entry;
    if (
      !staged ||
      !(await stat(join(this.userData, staged.path, "manifest.json")).then(
        (info) => info.isFile(),
        () => false,
      ))
    )
      return current;
    try {
      await rm(join(this.userData, entry.path), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      logError(
        `Extension ${entry.id}'s old version could not be removed`,
        error,
      );
    }
    return {
      ...current,
      version: staged.version,
      path: staged.path,
      grantedPermissions: staged.permissions,
      grantedHosts: staged.hosts,
    };
  }

  // Remove's last step: the chrome.storage folders of each id in every
  // persistent session.
  private async deleteSettings(ids: readonly string[]): Promise<void> {
    const partitions = join(this.userData, "Partitions");
    let folders: Dirent[];
    try {
      folders = await readdir(partitions, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const folder of folders)
      if (folder.isDirectory())
        for (const id of ids)
          for (const settings of SETTINGS_FOLDERS)
            await rm(join(partitions, folder.name, settings, id), {
              recursive: true,
              force: true,
            });
  }

  // Writes run one after another, each with the latest content.
  private write(): Promise<void> {
    const path = join(this.userData, EXTENSIONS_FILE);
    const written = this.writing.then(async () => {
      await mkdir(this.userData, { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify(this.file, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(`${path}.tmp`, path);
    });
    this.writing = written.catch(() => undefined);
    return written;
  }
}
