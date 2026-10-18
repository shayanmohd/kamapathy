import { join } from "node:path";
import {
  compareVersions,
  isComponentExtension,
  isExtensionId,
  raisesPermissions,
  type ExtensionUpdateState,
} from "../../shared/extensions";
import { extensionInstallCopy } from "../../src/copy";
import type { ConsentDetails } from "./dialogs";
import type { ExtensionHost } from "./host";
import {
  InstallError,
  type ExtensionInstaller,
  type PreparedBuild,
} from "./install";
import {
  DOWNLOAD_LIMITS,
  UPDATE_LIMITS,
  parseUpdateXml,
  updateCheckUrl,
  type FetchLimits,
  type Fetcher,
  type StoreEnv,
  type UpdateAnswer,
} from "./webstore";

export const FIRST_CHECK_MS = 300_000;
export const CHECK_EVERY_MS = 86_400_000;

// The answer is small; the build itself comes with the download limits.
const CHECK_LIMITS: FetchLimits = {
  timeoutMs: UPDATE_LIMITS.timeoutMs,
  maxBytes: UPDATE_LIMITS.maxBytes,
  redirects: DOWNLOAD_LIMITS.redirects,
};

export interface UpdatesDeps {
  host: ExtensionHost;
  installer: ExtensionInstaller;
  fetcher: Fetcher;
  env: StoreEnv;
  pagesOpen(id: string): boolean;
  confirm(details: ConsentDetails): Promise<boolean>;
  timers?: {
    set(callback: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

type Timers = NonNullable<UpdatesDeps["timers"]>;
const REAL_TIMERS: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// Keeps store extensions current while the person leaves updates on: one
// check 5 minutes after launch, then one a day. A build that asks for more
// than they granted waits for their OK; any other waits only for a moment
// with none of the extension's pages open.
export class ExtensionUpdates {
  private readonly timers: Timers;
  private enabled = false;
  private handle: unknown;
  private dueAt: number | undefined;
  private pass: Promise<void> | undefined;
  private failures = new Map<string, { version: string; message?: string }>();
  private listeners = new Set<() => void>();

  constructor(private readonly deps: UpdatesDeps) {
    this.timers = deps.timers ?? REAL_TIMERS;
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (!on) {
      this.stop();
      return;
    }
    this.at(
      this.dueAt === undefined
        ? FIRST_CHECK_MS
        : Math.max(0, this.dueAt - Date.now()),
    );
  }

  // One pass over the store extensions. It never throws, and a pass already
  // running is shared.
  check(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    this.at(CHECK_EVERY_MS);
    this.pass ??= this.run()
      .catch((error) => this.log("The extension update check failed", error))
      .finally(() => {
        this.pass = undefined;
      });
    return this.pass;
  }

  // The person's answer to a build that asks for more than they granted.
  async review(id: string): Promise<boolean> {
    const entry = this.deps.host.entry(id);
    if (!entry?.staged?.review) return false;
    const { version, path } = entry.staged;
    const manifest = await this.deps.host.stagedManifest(id);
    if (!manifest) {
      this.fail(
        id,
        version,
        new InstallError(extensionInstallCopy.failedChecks),
      );
      return false;
    }
    const allowed = await this.deps.confirm({
      name: manifest.name,
      lines: manifest.lines,
      wontWork: manifest.wontWork,
    });
    if (!allowed) return false;
    const folder = join(this.deps.host.userData, path);
    try {
      if (this.deps.pagesOpen(id))
        await this.deps.host.stage(id, {
          version,
          folder,
          manifest,
          review: false,
        });
      else
        await this.deps.host.replaceBuild(id, {
          version,
          folder,
          manifest,
          grant: { permissions: manifest.permissions, hosts: manifest.hosts },
        });
    } catch (error) {
      this.fail(id, version, error);
      return false;
    }
    this.failures.delete(id);
    this.changed();
    return true;
  }

  state(id: string): ExtensionUpdateState | undefined {
    const entry = this.deps.host.entry(id);
    if (!entry) return undefined;
    if (entry.staged)
      return {
        state: entry.staged.review ? "review" : "staged",
        version: entry.staged.version,
      };
    const failure = this.failures.get(id);
    return failure ? { state: "failed", ...failure } : undefined;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.enabled = false;
    this.stop();
    this.listeners.clear();
  }

  // Arms the next check and records when it is due, so a run that turns
  // updates off and on again keeps the day's schedule.
  private at(ms: number): void {
    this.stop();
    this.dueAt = Date.now() + ms;
    if (!this.enabled) return;
    this.handle = this.timers.set(() => {
      this.handle = undefined;
      void this.check();
    }, ms);
  }

  private stop(): void {
    if (this.handle === undefined) return;
    this.timers.clear(this.handle);
    this.handle = undefined;
  }

  private async run(): Promise<void> {
    const items = this.deps.host
      .entries()
      .filter(
        (entry) =>
          entry.source === "webstore" &&
          isExtensionId(entry.id) &&
          !isComponentExtension(entry.id),
      )
      .map((entry) => ({ id: entry.id, version: entry.version }));
    for (let at = 0; at < items.length; at += UPDATE_LIMITS.batch) {
      const batch = items.slice(at, at + UPDATE_LIMITS.batch);
      let answers: UpdateAnswer[];
      try {
        const answer = await this.deps.fetcher(
          updateCheckUrl(batch, this.deps.env),
          CHECK_LIMITS,
        );
        answers =
          answer.status === 200
            ? parseUpdateXml(answer.body.toString("utf8"))
            : [];
      } catch (error) {
        // A failed request skips its batch only.
        this.log("An extension update check failed", error);
        continue;
      }
      for (const answer of answers) await this.apply(answer);
    }
  }

  // Downloads and checks one newer build, then applies, stages or drops it.
  private async apply(answer: UpdateAnswer): Promise<void> {
    const entry = this.deps.host.entry(answer.id);
    if (!entry || entry.source !== "webstore") return;
    const { version, codebase } = answer;
    if (answer.status !== "update" || !version || !codebase) {
      if (this.failures.delete(answer.id)) this.changed();
      return;
    }
    if (
      compareVersions(version, entry.version) <= 0 ||
      (entry.staged && compareVersions(version, entry.staged.version) <= 0)
    )
      return;
    this.failures.delete(answer.id);
    let build: PreparedBuild | undefined;
    try {
      const downloaded = await this.deps.fetcher(codebase, DOWNLOAD_LIMITS);
      if (downloaded.status !== 200)
        throw new InstallError(extensionInstallCopy.downloadFailed);
      build = await this.deps.installer.prepareStoreBuild(
        entry.id,
        downloaded.body,
        { version, hashSha256: answer.hashSha256, replacing: true },
      );
      const grant = {
        permissions: build.manifest.permissions,
        hosts: build.manifest.hosts,
      };
      const waiting = raisesPermissions(
        { permissions: entry.grantedPermissions, hosts: entry.grantedHosts },
        grant,
      );
      if (waiting || this.deps.pagesOpen(entry.id))
        await this.deps.host.stage(entry.id, {
          version,
          folder: build.folder,
          manifest: build.manifest,
          review: waiting,
        });
      else
        await this.deps.host.replaceBuild(entry.id, {
          version,
          folder: build.folder,
          manifest: build.manifest,
          grant,
        });
      this.changed();
    } catch (error) {
      if (build)
        await this.deps.installer
          .discard(build)
          .catch((failure) =>
            this.log("An extension update could not be removed", failure),
          );
      this.fail(entry.id, version, error);
    }
  }

  private fail(id: string, version: string, error: unknown): void {
    this.log(`Extension ${id} could not be updated`, error);
    this.failures.set(id, {
      version,
      ...(error instanceof InstallError ? { message: error.message } : {}),
    });
    this.changed();
  }

  private log(context: string, error: unknown): void {
    console.error(`${context}:`, messageOf(error));
  }

  private changed(): void {
    for (const listener of [...this.listeners])
      try {
        listener();
      } catch (error) {
        this.log("An extension update listener failed", error);
      }
  }
}
