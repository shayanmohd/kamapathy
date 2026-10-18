import { net, session } from "electron";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open, rm, type FileHandle } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  INSTALLER_KINDS,
  installerName,
  parseChecksums,
  pickRelease,
  type UpdateSource,
} from "./update-release";
import { aptInstallCommand, updateReminder } from "../shared/state";
import { compareVersions, isVersion } from "../shared/version";
import type {
  BrowserAction,
  InstallKind,
  UpdateRelease,
  UpdateReminder,
  UpdateState,
  UpdateStatus,
} from "../shared/types";

// Kamapathy asks GitHub Releases for a newer version once a day, downloads
// this computer's installer when asked, and checks it twice. Only the person
// installs it: no route, timer or agent action opens, installs or quits.

const FIRST_CHECK = 60000;
const CHECK_EVERY = 3600000;
const CHECK_AGE = 86400000;
const FAILURE_WAIT = 14400000;
const REUSE = 60000;
const FRESH_CHECK = 3600000;
const CHECK_TIMEOUT = 15000;
const LIST_LIMIT = 4194304;
const SUMS_LIMIT = 65536;
const STALL = 60000;
const HEADROOM = 67108864;
const HOPS = 5;

const CHECK_HEADERS: Record<string, string> = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "Kamapathy",
};
// No version, so the request carries no identifier of this copy.
const FILE_HEADERS: Record<string, string> = { "User-Agent": "Kamapathy" };

const CHECK_MESSAGES: Record<string, string> = {
  offline: "Kamapathy is offline, so it couldn't check for updates.",
  network: "Kamapathy couldn't reach GitHub to check for updates.",
  timeout: "GitHub didn't answer the update check in time.",
  rate_limited: "GitHub limits how often Kamapathy can check. Try again later.",
  invalid_response: "Kamapathy couldn't read GitHub's list of releases.",
};
const DOWNLOAD_MESSAGE = "The download stopped. Try again.";
const CANCELLED_MESSAGE = "Download cancelled.";
const VERIFY_MESSAGE =
  "The download didn't match its checksum, so it was deleted.";

export interface TransportResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}
export interface UpdateTransport {
  get(
    url: string,
    options: {
      headers: Record<string, string>;
      signal: AbortSignal;
      redirect(next: string, hop: number): boolean;
    },
  ): Promise<TransportResponse>;
}

export class RedirectRefused extends Error {}
export class UpdateFailure extends Error {
  constructor(
    readonly code: "update_unsupported" | "update_check_failed",
    message: string,
    readonly fields: Record<string, unknown>,
  ) {
    super(message);
    this.name = "UpdateFailure";
  }
}
// Why a request ended, inside this module only.
class Deadline extends Error {}
class TooLarge extends Error {}
class Stop extends Error {
  constructor(
    readonly reason: string,
    readonly httpStatus?: number,
  ) {
    super(reason);
  }
}
class VerifyStop extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function headerOf(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  return headers[name] ?? headers[name.toLowerCase()];
}

// An in-memory session with no cookies, credentials, referrer or cache, which
// follows a redirect only when the updater allows that hop.
export function netTransport(): UpdateTransport {
  return {
    get(url, options) {
      return new Promise<TransportResponse>((resolve, reject) => {
        const request = net.request({
          method: "GET",
          url,
          session: session.fromPartition("kamapathy-updates", { cache: false }),
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          redirect: "manual",
        });
        for (const [name, value] of Object.entries(options.headers))
          request.setHeader(name, value);
        let hop = 0;
        request.on("redirect", (_status, _method, next) => {
          hop += 1;
          if (options.redirect(next, hop)) request.followRedirect();
          else {
            request.abort();
            reject(new RedirectRefused(`Refused a redirect to ${next}.`));
          }
        });
        request.on("response", (response) => {
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers))
            headers[name.toLowerCase()] = Array.isArray(value)
              ? value.join(", ")
              : String(value);
          resolve({
            status: response.statusCode,
            headers,
            body: chunks(response),
          });
        });
        request.on("error", reject);
        options.signal.addEventListener("abort", () => request.abort(), {
          once: true,
        });
        request.end();
      });
    },
  };
}

// Electron's response is an event emitter, not a stream.
function chunks(response: Electron.IncomingMessage): AsyncIterable<Uint8Array> {
  const queue: Uint8Array[] = [];
  let ended = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const signal = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  response.on("data", (chunk) => {
    queue.push(chunk);
    signal();
  });
  response.on("end", () => {
    ended = true;
    signal();
  });
  response.on("aborted", () => {
    ended = true;
    signal();
  });
  response.on("error", (error: Error) => {
    failure = error;
    signal();
  });
  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) {
          yield queue.shift()!;
          continue;
        }
        if (failure) throw failure;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

export interface UpdaterTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export function realTimers(): UpdaterTimers {
  // Update timers never hold the process open.
  const loose = (handle: NodeJS.Timeout) => {
    handle.unref?.();
    return handle;
  };
  return {
    setTimeout: (fn, ms) => loose(setTimeout(fn, ms)),
    clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    setInterval: (fn, ms) => loose(setInterval(fn, ms)),
    clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  };
}

export interface UpdaterDeps {
  version: string;
  kind: InstallKind;
  source: UpdateSource | null;
  directory: string;
  transport: UpdateTransport;
  online(): boolean;
  now(): number;
  timers: UpdaterTimers;
  statfs(
    path: string,
  ): Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  settings(): { updateChecks: boolean };
  saved(): { checkedAt?: number; latest?: UpdateRelease };
  publish(next: UpdateState): void;
  dispatch(action: BrowserAction): Promise<unknown>;
  helpSpaceId(): string;
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
  writeClipboard(text: string): void;
  quit(): void;
}

interface Download {
  stop: Stop | VerifyStop | null;
  controller: AbortController;
  done: Promise<void>;
}

// A check failure the person can retry, and one the server answers as 502.
function checkTransient(fields: {
  reason: string;
  httpStatus?: number;
}): boolean {
  if (["offline", "network", "timeout", "rate_limited"].includes(fields.reason))
    return true;
  return (
    fields.reason === "http_status" &&
    fields.httpStatus !== undefined &&
    fields.httpStatus >= 500 &&
    fields.httpStatus <= 599
  );
}

function downloadTransient(reason: string, httpStatus?: number): boolean {
  if (reason === "network" || reason === "stalled") return true;
  return (
    reason === "http_status" &&
    httpStatus !== undefined &&
    httpStatus >= 500 &&
    httpStatus <= 599
  );
}

// The download folder is checked like the agent folder.
function privateFolder(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.uid !== process.getuid!())
    throw new Error(`${path} must be a directory owned by this account.`);
  if (metadata.mode & 0o077) chmodSync(path, 0o700);
}

async function hashFile(path: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export class Updater {
  private current: UpdateState;
  private readonly supported: boolean;
  private checking: Promise<UpdateStatus> | null = null;
  private starting: Promise<{ status: UpdateStatus; started: boolean }> | null =
    null;
  private running: Download | null = null;
  private lastAttempt = 0;
  private lastFailure: UpdateFailure | null = null;
  private failedAt = 0;
  private retryAfter = 0;
  private soon: unknown;
  private hourly: unknown;
  private lastChecks: boolean;

  constructor(private deps: UpdaterDeps) {
    this.supported =
      Boolean(deps.source) && INSTALLER_KINDS.includes(deps.kind);
    this.current = {
      kind: deps.kind,
      state: this.supported ? "unchecked" : "unsupported",
    };
    this.lastChecks = deps.settings().updateChecks;
  }

  get state(): UpdateState {
    return this.current;
  }

  status(): UpdateStatus {
    return {
      ...this.current,
      version: this.deps.version,
      checks: this.deps.settings().updateChecks,
    };
  }

  reminder(): UpdateReminder | null {
    return updateReminder(this.current, this.deps.settings().updateChecks);
  }

  async start(): Promise<void> {
    if (!this.supported) {
      this.publish({ kind: this.deps.kind, state: "unsupported" });
      return;
    }
    const saved = this.deps.saved();
    const latest = this.savedLatest(saved.latest);
    this.clean();
    const checkedAt =
      typeof saved.checkedAt === "number" ? saved.checkedAt : undefined;
    const finished = latest ? this.finished(latest) : null;
    this.publish({
      kind: this.deps.kind,
      state: finished
        ? "ready"
        : latest
          ? "available"
          : checkedAt !== undefined
            ? "current"
            : "unchecked",
      ...(checkedAt !== undefined ? { checkedAt } : {}),
      ...(latest ? { latest } : {}),
      ...(finished ? { installer: finished } : {}),
    });
    this.lastChecks = this.deps.settings().updateChecks;
    this.soon = this.deps.timers.setTimeout(() => this.tick(), FIRST_CHECK);
    this.hourly = this.deps.timers.setInterval(() => this.tick(), CHECK_EVERY);
  }

  settingsChanged(): void {
    const checks = this.deps.settings().updateChecks;
    if (checks === this.lastChecks) return;
    this.lastChecks = checks;
    this.deps.timers.clearTimeout(this.soon);
    this.soon = undefined;
    if (checks && this.supported)
      this.soon = this.deps.timers.setTimeout(() => this.tick(), FIRST_CHECK);
  }

  async check(): Promise<UpdateStatus> {
    this.requireSupported();
    if (this.checking) return this.checking;
    const now = this.deps.now();
    if (this.lastAttempt && now - this.lastAttempt < REUSE) {
      if (this.lastFailure) throw this.lastFailure;
      return this.status();
    }
    if (!this.deps.online()) throw this.checkFailed(this.failure("offline"));
    this.checking = this.runCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  async download(): Promise<{ status: UpdateStatus; started: boolean }> {
    this.requireSupported();
    if (!this.starting)
      this.starting = this.begin().finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async cancel(): Promise<void> {
    const download = this.running;
    if (!download) return;
    download.stop ??= new Stop("cancelled");
    download.controller.abort();
    await download.done.catch(() => {});
  }

  async install(): Promise<void> {
    const installer = this.current.installer;
    if (this.current.state !== "ready" || !installer) return;
    const { kind } = this.deps;
    if (
      kind === "mac-arm64" ||
      kind === "mac-x64" ||
      kind === "windows-setup"
    ) {
      // The file is hashed again, because it was written minutes or days ago.
      if ((await hashFile(installer.path)) !== installer.sha256) {
        this.publish({
          ...this.current,
          state: "available",
          installer: undefined,
          progress: undefined,
          error: {
            code: "update_verify_failed",
            message: VERIFY_MESSAGE,
            reason: "sums_mismatch",
            file: basename(installer.path),
            retryable: false,
          },
        });
        return;
      }
      await this.deps.openPath(installer.path);
      // Section 10's quit question counts this quit as the person's own.
      this.deps.quit();
      return;
    }
    this.deps.showItemInFolder(installer.path);
  }

  showFile(): void {
    const installer = this.current.installer;
    if (installer) this.deps.showItemInFolder(installer.path);
  }

  copyCommand(): void {
    const installer = this.current.installer;
    if (installer) this.deps.writeClipboard(aptInstallCommand(installer.path));
  }

  async openNotes(which: "running" | "latest"): Promise<void> {
    const { source, version } = this.deps;
    if (!source) return;
    const url =
      which === "running"
        ? `${source.releasesBase}/tag/v${version}`
        : this.current.latest?.url;
    if (!url) return;
    await this.deps.dispatch({
      type: "tab:create",
      url,
      spaceId: this.deps.helpSpaceId(),
    });
  }

  async stop(): Promise<void> {
    this.deps.timers.clearTimeout(this.soon);
    this.deps.timers.clearInterval(this.hourly);
    this.soon = undefined;
    this.hourly = undefined;
    await this.cancel();
  }

  private publish(next: UpdateState): void {
    this.current = next;
    this.deps.publish(next);
  }

  private requireSupported(): void {
    if (this.supported) return;
    const fromSource = this.deps.kind === "source";
    throw new UpdateFailure(
      "update_unsupported",
      fromSource
        ? "This copy runs from source. Pull the latest code to update it."
        : "No installer is published for this computer yet.",
      {
        reason: fromSource ? "source" : "platform",
        platform: process.platform,
        arch: process.arch,
      },
    );
  }

  private tick(): void {
    const now = this.deps.now();
    const { checkedAt } = this.current;
    if (
      !this.supported ||
      !this.deps.settings().updateChecks ||
      this.checking ||
      this.starting ||
      this.running ||
      !this.deps.online() ||
      (checkedAt !== undefined &&
        checkedAt <= now &&
        now - checkedAt < CHECK_AGE) ||
      (this.failedAt !== 0 && now - this.failedAt < FAILURE_WAIT) ||
      now < this.retryAfter
    )
      return;
    void this.check().catch(() => {});
  }

  private async runCheck(): Promise<UpdateStatus> {
    this.lastAttempt = this.deps.now();
    const source = this.deps.source!;
    try {
      const answer = await this.fetchText(
        source.listUrl,
        LIST_LIMIT,
        CHECK_TIMEOUT,
        CHECK_HEADERS,
      );
      if (answer.status !== 200)
        throw this.rateLimited(answer.status, answer.headers);
      let listed: unknown;
      try {
        listed = JSON.parse(answer.text);
      } catch {
        throw this.failure("invalid_response");
      }
      let latest: UpdateRelease | null;
      try {
        latest = pickRelease(listed, {
          source,
          current: this.deps.version,
          kind: this.deps.kind,
        });
      } catch {
        throw this.failure("invalid_response");
      }
      this.lastFailure = null;
      this.failedAt = 0;
      this.retryAfter = 0;
      const finished = latest ? this.finished(latest) : null;
      // A download started before this check keeps its state.
      const downloading = this.running !== null;
      this.publish({
        kind: this.deps.kind,
        state: downloading
          ? "downloading"
          : finished
            ? "ready"
            : latest
              ? "available"
              : "current",
        checkedAt: this.lastAttempt,
        ...(latest ? { latest } : {}),
        ...(finished ? { installer: finished } : {}),
        ...(downloading && this.current.progress
          ? { progress: this.current.progress }
          : {}),
      });
      return this.status();
    } catch (error) {
      throw this.checkFailed(
        error instanceof UpdateFailure
          ? error
          : error instanceof Deadline
            ? this.failure("timeout")
            : error instanceof TooLarge
              ? this.failure("invalid_response")
              : this.failure("network"),
      );
    }
  }

  private failure(
    reason: string,
    extra: { httpStatus?: number; retryAfterMs?: number } = {},
  ): UpdateFailure {
    const message =
      reason === "http_status"
        ? `GitHub answered the update check with HTTP ${extra.httpStatus}.`
        : CHECK_MESSAGES[reason];
    return new UpdateFailure("update_check_failed", message, {
      reason,
      ...extra,
    });
  }

  private rateLimited(
    status: number,
    headers: Record<string, string>,
  ): UpdateFailure {
    const after = headerOf(headers, "Retry-After");
    const remaining = headerOf(headers, "X-RateLimit-Remaining");
    const reset = Number(headerOf(headers, "X-RateLimit-Reset"));
    if (
      (status === 403 || status === 429) &&
      (remaining === "0" || after !== undefined)
    ) {
      const ms =
        after !== undefined
          ? Number(after) * 1000
          : reset * 1000 - this.deps.now();
      // A wrong or hostile reset must not stop checks for good.
      const wait = Number.isFinite(ms)
        ? Math.min(Math.max(ms, 0), CHECK_AGE)
        : 0;
      return this.failure("rate_limited", { retryAfterMs: wait });
    }
    return this.failure("http_status", { httpStatus: status });
  }

  private checkFailed(failure: UpdateFailure): UpdateFailure {
    const now = this.deps.now();
    const fields = failure.fields as {
      reason: string;
      httpStatus?: number;
      retryAfterMs?: number;
    };
    this.lastFailure = failure;
    this.failedAt = now;
    this.retryAfter =
      fields.retryAfterMs !== undefined ? now + fields.retryAfterMs : 0;
    this.publish({
      ...this.current,
      error: {
        code: failure.code,
        message: failure.message,
        reason: fields.reason,
        ...(fields.httpStatus !== undefined
          ? { httpStatus: fields.httpStatus }
          : {}),
        ...(fields.retryAfterMs !== undefined
          ? { retryAfterMs: fields.retryAfterMs }
          : {}),
        ...(checkTransient(fields) ? { retryable: true } : {}),
      },
    });
    return failure;
  }

  private allowHop(next: string, hop: number): boolean {
    if (hop > HOPS) return false;
    if (next.startsWith("https://")) return true;
    return (
      this.deps.source?.loopback === true &&
      next.startsWith("http://127.0.0.1:")
    );
  }

  private async fetchText(
    url: string,
    limit: number,
    timeout: number,
    headers: Record<string, string>,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
  }> {
    const controller = new AbortController();
    const work = (async () => {
      const response = await this.deps.transport.get(url, {
        headers,
        signal: controller.signal,
        redirect: (next, hop) => this.allowHop(next, hop),
      });
      if (response.status !== 200) {
        controller.abort();
        return { status: response.status, headers: response.headers, text: "" };
      }
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > limit) {
          controller.abort();
          throw new TooLarge();
        }
        parts.push(chunk);
      }
      return {
        status: response.status,
        headers: response.headers,
        text: Buffer.concat(parts).toString("utf8"),
      };
    })();
    return this.deadline(work, timeout, controller);
  }

  private deadline<T>(
    work: Promise<T>,
    ms: number,
    controller: AbortController,
  ): Promise<T> {
    let handle: unknown;
    const limit = new Promise<never>((_resolve, reject) => {
      handle = this.deps.timers.setTimeout(() => {
        controller.abort();
        reject(new Deadline());
      }, ms);
    });
    return Promise.race([work, limit]).finally(() =>
      this.deps.timers.clearTimeout(handle),
    );
  }

  private async begin(): Promise<{ status: UpdateStatus; started: boolean }> {
    if (this.running) return { status: this.status(), started: false };
    const { checkedAt } = this.current;
    if (checkedAt === undefined || this.deps.now() - checkedAt > FRESH_CHECK)
      await this.check();
    const latest = this.current.latest;
    const name = latest ? installerName(this.deps.kind, latest.version) : null;
    if (
      !latest ||
      !name ||
      name !== latest.installer.name ||
      this.current.state === "ready" ||
      this.current.state === "current"
    )
      return { status: this.status(), started: false };
    const folder = join(this.deps.directory, latest.version);
    const part = join(folder, `${name}.part`);
    this.publish({
      ...this.current,
      state: "downloading",
      error: undefined,
      progress: undefined,
    });
    let handle: FileHandle;
    try {
      privateFolder(folder);
      const room = await this.deps.statfs(this.deps.directory);
      if (
        Number(room.bavail) * Number(room.bsize) <
        latest.installer.size + HEADROOM
      )
        throw new Stop("disk_full");
      await rm(part, { force: true });
      handle = await open(part, "wx", 0o600);
    } catch (error) {
      this.downloadFailed(error, name, part);
      return { status: this.status(), started: false };
    }
    const download: Download = {
      stop: null,
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.running = download;
    download.done = this.pump(
      download,
      latest,
      name,
      folder,
      part,
      handle,
    ).finally(() => {
      if (this.running === download) this.running = null;
    });
    return { status: this.status(), started: true };
  }

  private async pump(
    download: Download,
    latest: UpdateRelease,
    name: string,
    folder: string,
    part: string,
    handle: FileHandle,
  ): Promise<void> {
    const { size, url } = latest.installer;
    const hash = createHash("sha256");
    let received = 0;
    let stall: unknown;
    const arm = () => {
      this.deps.timers.clearTimeout(stall);
      stall = this.deps.timers.setTimeout(() => {
        download.stop ??= new Stop("stalled");
        download.controller.abort();
      }, STALL);
    };
    try {
      const response = await this.deps.transport.get(url, {
        headers: FILE_HEADERS,
        signal: download.controller.signal,
        redirect: (next, hop) => this.allowHop(next, hop),
      });
      if (response.status !== 200) {
        download.controller.abort();
        throw new Stop("http_status", response.status);
      }
      arm();
      for await (const chunk of response.body) {
        if (download.stop) break;
        received += chunk.byteLength;
        if (received > size) {
          download.stop = new Stop("size_mismatch");
          download.controller.abort();
          break;
        }
        hash.update(chunk);
        await handle.write(chunk);
        arm();
        this.publish({
          ...this.current,
          progress: { receivedBytes: received, totalBytes: size },
        });
      }
      this.deps.timers.clearTimeout(stall);
      if (download.stop) throw download.stop;
      if (received !== size) throw new Stop("size_mismatch");
      const digest = hash.digest("hex");
      let sums: { status: number; text: string };
      try {
        sums = await this.fetchText(
          latest.sums,
          SUMS_LIMIT,
          CHECK_TIMEOUT,
          FILE_HEADERS,
        );
      } catch (error) {
        if (error instanceof TooLarge) throw new VerifyStop("sums_invalid");
        throw error;
      }
      if (sums.status !== 200) throw new Stop("http_status", sums.status);
      const expected = parseChecksums(sums.text)?.get(name);
      if (!expected) throw new VerifyStop("sums_invalid");
      if (expected !== digest) throw new VerifyStop("sums_mismatch");
      if (latest.installer.sha256 && latest.installer.sha256 !== digest)
        throw new VerifyStop("digest_mismatch");
      await handle.close();
      const file = join(folder, name);
      renameSync(part, file);
      chmodSync(file, this.deps.kind === "linux-appimage" ? 0o755 : 0o644);
      // The hash is kept beside the file, so a later start marks it ready
      // without reading a gigabyte again.
      writeFileSync(`${file}.sha256`, digest, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.pruneOther(latest.version);
      this.publish({
        ...this.current,
        state: "ready",
        installer: { path: file, sha256: digest },
        progress: undefined,
        error: undefined,
      });
    } catch (error) {
      await handle.close().catch(() => {});
      this.downloadFailed(error, name, part);
    } finally {
      this.deps.timers.clearTimeout(stall);
    }
  }

  private downloadFailed(error: unknown, name: string, part: string): void {
    try {
      rmSync(part, { force: true });
    } catch {
      /* The next start deletes it. */
    }
    if (error instanceof VerifyStop) {
      this.publish({
        ...this.current,
        state: "available",
        installer: undefined,
        progress: undefined,
        error: {
          code: "update_verify_failed",
          message: VERIFY_MESSAGE,
          reason: error.reason,
          file: name,
          retryable: false,
        },
      });
      return;
    }
    const reason = this.stopReason(error);
    const httpStatus = error instanceof Stop ? error.httpStatus : undefined;
    this.publish({
      ...this.current,
      state: "available",
      installer: undefined,
      progress: undefined,
      error: {
        code: "update_download_failed",
        message: reason === "cancelled" ? CANCELLED_MESSAGE : DOWNLOAD_MESSAGE,
        reason,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(downloadTransient(reason, httpStatus) ? { retryable: true } : {}),
      },
    });
  }

  private stopReason(error: unknown): string {
    if (error instanceof Stop) return error.reason;
    if (error instanceof RedirectRefused) return "insecure_redirect";
    if (error instanceof Deadline) return "stalled";
    if ((error as { code?: string } | null)?.code === "ENOSPC")
      return "disk_full";
    return "network";
  }

  // A saved release is trusted only when it still names this kind's installer
  // at the configured repository's own release URLs.
  private savedLatest(latest?: UpdateRelease): UpdateRelease | undefined {
    const { source, kind, version } = this.deps;
    if (
      !source ||
      !latest ||
      !isVersion(latest.version) ||
      compareVersions(latest.version, version) <= 0
    )
      return undefined;
    const name = installerName(kind, latest.version);
    const folder = `${source.releasesBase}/download/v${latest.version}/`;
    const same = (value: string, expected: string) =>
      value.toLowerCase() === expected.toLowerCase();
    const under = (value: string, prefix: string) =>
      value.toLowerCase().startsWith(prefix.toLowerCase());
    if (
      !name ||
      latest.installer.name !== name ||
      !same(latest.url, `${source.releasesBase}/tag/v${latest.version}`) ||
      !under(latest.installer.url, folder) ||
      !under(latest.sums, folder)
    )
      return undefined;
    return latest;
  }

  // The file name never comes from the saved record or the network.
  private finished(
    latest: UpdateRelease,
  ): { path: string; sha256: string } | null {
    const name = installerName(this.deps.kind, latest.version);
    if (!name) return null;
    const path = join(this.deps.directory, latest.version, name);
    try {
      if (statSync(path).size !== latest.installer.size) return null;
      const sha256 = readFileSync(`${path}.sha256`, "utf8").trim();
      if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
      if (latest.installer.sha256 && latest.installer.sha256 !== sha256)
        return null;
      return { path, sha256 };
    } catch {
      return null;
    }
  }

  private clean(): void {
    try {
      for (const entry of readdirSync(this.deps.directory, {
        withFileTypes: true,
      })) {
        const path = join(this.deps.directory, entry.name);
        if (!entry.isDirectory()) {
          if (entry.name.endsWith(".part")) rmSync(path, { force: true });
          continue;
        }
        if (
          isVersion(entry.name) &&
          compareVersions(entry.name, this.deps.version) <= 0
        ) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
        for (const file of readdirSync(path))
          if (file.endsWith(".part")) rmSync(join(path, file), { force: true });
      }
    } catch {
      /* A failed cleanup waits for the next start. */
    }
  }

  private pruneOther(keep: string): void {
    try {
      for (const entry of readdirSync(this.deps.directory, {
        withFileTypes: true,
      }))
        if (entry.isDirectory() && entry.name !== keep)
          rmSync(join(this.deps.directory, entry.name), {
            recursive: true,
            force: true,
          });
    } catch {
      /* A failed cleanup waits for the next start. */
    }
  }
}
