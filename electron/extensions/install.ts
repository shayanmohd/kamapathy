import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_PINNED,
  isComponentExtension,
  isExtensionId,
  raisesPermissions,
  type ExtensionEntry,
  type Grant,
} from "../../shared/extensions";
import {
  extensionInstallCopy,
  extensionRefusalCopy,
  extensionRemoveCopy,
} from "../../src/copy";
import { CrxError, verifyCrx, type VerifiedCrx } from "./crx";
import type { ConsentDetails } from "./dialogs";
import { STAGING_FOLDER, STORE_FOLDER, type ExtensionHost } from "./host";
import {
  ManifestRefusal,
  injectKey,
  readManifest,
  type CheckedManifest,
} from "./manifest";
import {
  DOWNLOAD_LIMITS,
  crxUrl,
  type Fetcher,
  type StoreEnv,
} from "./webstore";
import { ZipError, extractZip } from "./zip";

// Electron's load errors are shown cut to this length.
const MESSAGE_LIMIT = 300;

// Its message is the copy shown to the person.
export class InstallError extends Error {}

export interface InstallOptions {
  importedFrom?: string;
  pinned?: boolean;
  // What the person already agreed to, for a build that asks for no more.
  consented?: Grant;
}
export type InstallOutcome =
  { added: true; id: string; name: string } | { added: false; id: string };
export interface PreparedBuild {
  id: string;
  folder: string;
  manifest: CheckedManifest;
  publicKey: Buffer;
  version: string;
}
export interface InstallerDeps {
  host: ExtensionHost;
  fetcher: Fetcher;
  env: StoreEnv;
  // app.getLocale(), for _locales.
  locale: string;
  confirm(details: ConsentDetails): Promise<boolean>;
  // Load unpacked's folder chooser.
  chooseFolder?: () => Promise<string | undefined>;
  publisherKeyHash?: string;
  now?: () => number;
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Adds extensions the person asked for, one at a time: download, verify,
// stage, check, consent, move, record and load, undoing each step that a
// later one makes moot.
export class ExtensionInstaller {
  private readonly now: () => number;
  private pending: string[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();

  constructor(private readonly deps: InstallerDeps) {
    this.now = deps.now ?? Date.now;
  }

  // Queued behind any running install, so two stores never write at once.
  installFromStore(
    id: string,
    options: InstallOptions = {},
  ): Promise<InstallOutcome> {
    this.pending.push(id);
    this.changed();
    const queued = this.queue.then(() => this.install(id, options));
    this.queue = queued.catch(() => undefined);
    return queued.finally(() => {
      const at = this.pending.indexOf(id);
      if (at !== -1) this.pending.splice(at, 1);
      this.changed();
    });
  }

  // Developer mode's Load unpacked, queued behind any running install.
  loadUnpacked(
    folder?: string,
    options: InstallOptions = {},
  ): Promise<InstallOutcome> {
    const queued = this.queue.then(() => this.unpacked(folder, options));
    this.queue = queued.catch(() => undefined);
    return queued;
  }

  // Rereads an unpacked folder and loads it again.
  async reloadUnpacked(id: string): Promise<void> {
    const { host } = this.deps;
    if (!host.developerMode)
      throw new InstallError(extensionRemoveCopy.developerModeOff);
    const entry = host.entry(id);
    if (!entry || entry.source !== "unpacked")
      throw new InstallError(extensionRefusalCopy.loadFailed);
    const manifest = await this.read(entry.path, true);
    // The folder belongs to another id now, so Electron would refuse it.
    if (manifest.keyId !== undefined && manifest.keyId !== id) {
      host.unloadEverywhere(id);
      host.setLoadError(id, extensionRemoveCopy.folderChanged);
      throw new InstallError(extensionRemoveCopy.folderChanged);
    }
    if (
      raisesPermissions(
        { permissions: entry.grantedPermissions, hosts: entry.grantedHosts },
        manifest,
      ) &&
      !(await this.agreed(manifest))
    )
      return;
    host.unloadEverywhere(id);
    await host.save(
      {
        ...entry,
        version: manifest.version,
        grantedPermissions: manifest.permissions,
        grantedHosts: manifest.hosts,
      },
      manifest,
    );
    try {
      await host.loadEverywhere(id);
    } catch (error) {
      throw new InstallError(this.failure(manifest.name, error));
    }
  }

  // Verifies a downloaded CRX and leaves it in staging, checked and with the
  // verified developer key written in. Any failure leaves nothing behind.
  async prepareStoreBuild(
    id: string,
    bytes: Buffer,
    expected: {
      version?: string;
      hashSha256?: string;
      replacing?: boolean;
    } = {},
  ): Promise<PreparedBuild> {
    if (
      expected.hashSha256 &&
      createHash("sha256").update(bytes).digest("hex") !==
        expected.hashSha256.toLowerCase()
    )
      throw new InstallError(extensionInstallCopy.failedChecks);
    let verified: VerifiedCrx;
    try {
      verified = verifyCrx(bytes, id, this.deps.publisherKeyHash);
    } catch (error) {
      if (error instanceof CrxError)
        throw new InstallError(extensionInstallCopy.failedChecks);
      throw error;
    }
    const folder = join(
      this.deps.host.userData,
      STORE_FOLDER,
      STAGING_FOLDER,
      randomUUID(),
    );
    try {
      await extractZip(verified.archive, folder);
      const manifest = await readManifest(folder, {
        chromeVersion: this.deps.env.chromeVersion,
        locale: this.deps.locale,
        installed: this.deps.host.entries().length,
        replacing: expected.replacing ?? false,
      });
      if (
        (manifest.keyId !== undefined && manifest.keyId !== id) ||
        (expected.version !== undefined &&
          expected.version !== manifest.version)
      )
        throw new InstallError(extensionInstallCopy.failedChecks);
      await injectKey(folder, verified.publicKey);
      return {
        id,
        folder,
        manifest,
        publicKey: verified.publicKey,
        version: manifest.version,
      };
    } catch (error) {
      await this.delete(folder);
      if (error instanceof ZipError)
        throw new InstallError(extensionInstallCopy.failedChecks);
      if (error instanceof ManifestRefusal)
        throw new InstallError(error.message);
      throw error;
    }
  }

  async discard(build: PreparedBuild): Promise<void> {
    await this.delete(build.folder);
  }

  installing(): string[] {
    return [...this.pending];
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async install(
    id: string,
    options: InstallOptions,
  ): Promise<InstallOutcome> {
    if (!isExtensionId(id) || isComponentExtension(id))
      throw new InstallError(extensionInstallCopy.invalidInput);
    if (this.deps.host.entry(id))
      throw new InstallError(extensionInstallCopy.alreadyAdded);
    const build = await this.prepareStoreBuild(id, await this.download(id));
    try {
      if (
        !options.consented ||
        raisesPermissions(options.consented, build.manifest)
      ) {
        const allowed = await this.deps.confirm({
          name: build.manifest.name,
          lines: build.manifest.lines,
          wontWork: build.manifest.wontWork,
        });
        if (!allowed) {
          await this.discard(build);
          return { added: false, id };
        }
      }
      return await this.add(id, build, options);
    } catch (error) {
      await this.discard(build);
      throw error;
    }
  }

  // The same checks and consent as a store install, minus the signature: the
  // folder loads where it is and keeps the id Electron gives it.
  private async unpacked(
    folder: string | undefined,
    options: InstallOptions,
  ): Promise<InstallOutcome> {
    const { host } = this.deps;
    if (!host.developerMode)
      throw new InstallError(extensionRemoveCopy.developerModeOff);
    const chosen = folder ?? (await this.deps.chooseFolder?.());
    if (!chosen) return { added: false, id: "" };
    const manifest = await this.read(chosen, false);
    if (
      (!options.consented || raisesPermissions(options.consented, manifest)) &&
      !(await this.agreed(manifest))
    )
      return { added: false, id: "" };
    let id: string;
    try {
      id = await host.loadFolder(chosen);
    } catch (error) {
      throw new InstallError(this.failure(manifest.name, error));
    }
    if (isComponentExtension(id))
      throw new InstallError(extensionRefusalCopy.component);
    if (host.entry(id))
      throw new InstallError(extensionInstallCopy.alreadyAdded);
    await host.save(
      {
        id,
        source: "unpacked",
        version: manifest.version,
        path: chosen,
        enabled: true,
        pinned:
          options.pinned ??
          host.entries().filter((item) => item.pinned).length < MAX_PINNED,
        installedAt: this.now(),
        ...(options.importedFrom ? { importedFrom: options.importedFrom } : {}),
        grantedPermissions: manifest.permissions,
        grantedHosts: manifest.hosts,
      },
      manifest,
    );
    await this.load(id, manifest.name);
    return { added: true, id, name: manifest.name };
  }

  private async read(
    folder: string,
    replacing: boolean,
  ): Promise<CheckedManifest> {
    try {
      return await readManifest(folder, {
        chromeVersion: this.deps.env.chromeVersion,
        locale: this.deps.locale,
        installed: this.deps.host.entries().length,
        replacing,
      });
    } catch (error) {
      if (error instanceof ManifestRefusal)
        throw new InstallError(error.message);
      throw error;
    }
  }

  private agreed(manifest: CheckedManifest): Promise<boolean> {
    return this.deps.confirm({
      name: manifest.name,
      lines: manifest.lines,
      wontWork: manifest.wontWork,
    });
  }

  // A recorded extension that fails to load is forgotten again.
  private async load(id: string, name: string): Promise<void> {
    try {
      await this.deps.host.loadEverywhere(id);
    } catch (error) {
      await this.deps.host.forget(id);
      throw new InstallError(this.failure(name, error));
    }
  }

  private failure(name: string, error: unknown): string {
    return extensionInstallCopy.couldNotAdd(
      name,
      messageOf(error).slice(0, MESSAGE_LIMIT),
    );
  }

  private async download(id: string): Promise<Buffer> {
    let answer;
    try {
      answer = await this.deps.fetcher(
        crxUrl(id, this.deps.env),
        DOWNLOAD_LIMITS,
      );
    } catch {
      throw new InstallError(extensionInstallCopy.downloadFailed);
    }
    if (answer.status === 204 || answer.status === 404)
      throw new InstallError(extensionInstallCopy.notInStore);
    if (answer.status !== 200)
      throw new InstallError(extensionInstallCopy.downloadFailed);
    return answer.body;
  }

  // The last steps: the files, the record and the load, each undone if the
  // load fails.
  private async add(
    id: string,
    build: PreparedBuild,
    options: InstallOptions,
  ): Promise<InstallOutcome> {
    const { host } = this.deps;
    const folder = join(host.userData, STORE_FOLDER, id, build.version);
    await mkdir(join(host.userData, STORE_FOLDER, id), { recursive: true });
    await this.delete(folder);
    await rename(build.folder, folder);
    const entry: ExtensionEntry = {
      id,
      source: "webstore",
      version: build.version,
      path: `${STORE_FOLDER}/${id}/${build.version}`,
      enabled: true,
      pinned:
        options.pinned ??
        host.entries().filter((item) => item.pinned).length < MAX_PINNED,
      installedAt: this.now(),
      ...(options.importedFrom ? { importedFrom: options.importedFrom } : {}),
      grantedPermissions: build.manifest.permissions,
      grantedHosts: build.manifest.hosts,
    };
    await host.save(entry, build.manifest);
    try {
      await host.loadEverywhere(id);
    } catch (error) {
      await host.forget(id);
      await this.delete(folder);
      throw new InstallError(
        extensionInstallCopy.couldNotAdd(
          build.manifest.name,
          messageOf(error).slice(0, MESSAGE_LIMIT),
        ),
      );
    }
    return { added: true, id, name: build.manifest.name };
  }

  private async delete(folder: string): Promise<void> {
    await rm(folder, { recursive: true, force: true });
  }

  private changed(): void {
    for (const listener of [...this.listeners])
      try {
        listener();
      } catch (error) {
        console.error(
          "An extension install listener failed:",
          messageOf(error),
        );
      }
  }
}
