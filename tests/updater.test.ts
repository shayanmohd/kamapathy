import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installerName,
  updateSource,
  type UpdateSource,
} from "../electron/update-release";
import {
  RedirectRefused,
  UpdateFailure,
  Updater,
  type TransportResponse,
  type UpdateTransport,
  type UpdaterTimers,
} from "../electron/updates";
import { aptInstallCommand } from "../shared/state";
import type {
  BrowserAction,
  InstallKind,
  UpdateRelease,
  UpdateState,
} from "../shared/types";

// The updater's own transport and timers are injected, so the Electron
// modules netTransport() reaches for are never used here.
vi.mock("electron", () => ({
  net: { request: vi.fn() },
  session: { fromPartition: vi.fn() },
}));

const START = Date.parse("2026-10-18T10:00:00.000Z");
const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const MiB = 1048576;
const HELP_SPACE = "space-help";
const RUNNING = "0.2.0";
const NEXT = "0.3.0";
const source = updateSource({ owner: "shayanmohd", repo: "kamapathy" });
const installerData = Buffer.alloc(MiB + 11, 0x61);
const hashOf = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
const nameFor = (version: string, kind: InstallKind = "mac-arm64") =>
  installerName(kind, version)!;
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

// Fake timers the updater drives: every handle fires only while a test
// advances the clock the updater also reads as now().
class Clock implements UpdaterTimers {
  now = START;
  private next = 1;
  private entries = new Map<
    number,
    { at: number; every?: number; fn: () => void }
  >();
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.entries.set(id, { at: this.now + ms, fn });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.entries.delete(handle as number);
  }
  setInterval(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.entries.set(id, { at: this.now + ms, every: ms, fn });
    return id;
  }
  clearInterval(handle: unknown): void {
    this.entries.delete(handle as number);
  }
  async advance(ms: number): Promise<void> {
    const until = this.now + ms;
    await flush();
    for (;;) {
      let due: [number, { at: number; every?: number; fn: () => void }] | null =
        null;
      for (const entry of this.entries)
        if (entry[1].at <= until && (!due || entry[1].at < due[1].at))
          due = entry;
      if (!due) break;
      const [id, entry] = due;
      this.now = entry.at;
      if (entry.every) entry.at = this.now + entry.every;
      else this.entries.delete(id);
      entry.fn();
      await flush();
    }
    this.now = until;
    await flush();
  }
}

type GetOptions = Parameters<UpdateTransport["get"]>[1];
type Reply = (
  options: GetOptions,
) => Promise<TransportResponse> | TransportResponse;

class FakeTransport implements UpdateTransport {
  readonly requests: { url: string; headers: Record<string, string> }[] = [];
  private replies = new Map<string, Reply>();
  on(url: string, reply: Reply): this {
    this.replies.set(url, reply);
    return this;
  }
  async get(url: string, options: GetOptions): Promise<TransportResponse> {
    this.requests.push({ url, headers: options.headers });
    const reply = this.replies.get(url);
    if (!reply) throw new Error(`Unexpected request: ${url}`);
    return reply(options);
  }
  get urls(): string[] {
    return this.requests.map((request) => request.url);
  }
  count(url: string): number {
    return this.urls.filter((seen) => seen === url).length;
  }
}

const iterate = (...chunks: Uint8Array[]): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for (const chunk of chunks) yield chunk;
  },
});
const reply = (
  status: number,
  body: AsyncIterable<Uint8Array>,
  headers: Record<string, string> = {},
): TransportResponse => ({ status, headers, body });
const jsonReply = (value: unknown) =>
  reply(200, iterate(Buffer.from(JSON.stringify(value))));
const textReply = (
  text: string,
  status = 200,
  headers: Record<string, string> = {},
) => reply(status, iterate(Buffer.from(text)), headers);

// A body the test feeds chunk by chunk. An abort ends it, as a cancelled
// request ends a real one.
function channel(options: GetOptions) {
  const queue: Uint8Array[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const signal = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const end = () => {
    done = true;
    signal();
  };
  options.signal.addEventListener("abort", end, { once: true });
  return {
    push(chunk: Uint8Array) {
      queue.push(chunk);
      signal();
    },
    end,
    body: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length) {
            yield queue.shift()!;
            continue;
          }
          if (done) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    } as AsyncIterable<Uint8Array>,
  };
}

const folderOf = (version: string, base = source.releasesBase) =>
  `${base}/download/v${version}/`;
const installerUrl = (version: string, kind: InstallKind = "mac-arm64") =>
  `${folderOf(version)}${nameFor(version, kind)}`;
const sumsUrl = (version: string) => `${folderOf(version)}SHA256SUMS.txt`;
const sumsFor = (
  version: string,
  data: Buffer,
  kind: InstallKind = "mac-arm64",
) => `${hashOf(data)}  ${nameFor(version, kind)}\n`;

// One release as GitHub lists it.
function listing(
  version: string,
  data: Buffer,
  kind: InstallKind = "mac-arm64",
  digest: string | null = null,
) {
  const name = nameFor(version, kind);
  const folder = folderOf(version);
  return [
    {
      tag_name: `v${version}`,
      draft: false,
      prerelease: true,
      html_url: `${source.releasesBase}/tag/v${version}`,
      published_at: "2026-10-01T12:00:00Z",
      assets: [
        {
          name,
          state: "uploaded",
          size: data.length,
          browser_download_url: folder + name,
          ...(digest === null ? {} : { digest: `sha256:${digest}` }),
        },
        {
          name: "SHA256SUMS.txt",
          state: "uploaded",
          size: 200,
          browser_download_url: `${folder}SHA256SUMS.txt`,
        },
      ],
    },
  ];
}

function savedRelease(
  version: string,
  size: number,
  kind: InstallKind = "mac-arm64",
  options: { sha256?: string; base?: string } = {},
): UpdateRelease {
  const base = options.base ?? source.releasesBase;
  const folder = folderOf(version, base);
  const name = nameFor(version, kind);
  return {
    version,
    publishedAt: START - DAY,
    url: `${base}/tag/v${version}`,
    installer: {
      name,
      size,
      url: folder + name,
      ...(options.sha256 ? { sha256: options.sha256 } : {}),
    },
    sums: `${folder}SHA256SUMS.txt`,
  };
}

const directories: string[] = [];
const updaters: Updater[] = [];

function harness(
  options: {
    kind?: InstallKind;
    version?: string;
    source?: UpdateSource | null;
    saved?: { checkedAt?: number; latest?: UpdateRelease };
    checks?: boolean;
    online?: boolean;
    free?: number;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "kamapathy-updates-"));
  directories.push(directory);
  const clock = new Clock();
  const transport = new FakeTransport();
  const flags = {
    checks: options.checks !== false,
    online: options.online !== false,
    free: options.free ?? 8192 * MiB,
    saved: options.saved ?? {},
  };
  const published: UpdateState[] = [];
  const dispatched: BrowserAction[] = [];
  const opened: string[] = [];
  const shown: string[] = [];
  const copied: string[] = [];
  let quits = 0;
  const updater = new Updater({
    version: options.version ?? RUNNING,
    kind: options.kind ?? "mac-arm64",
    source: options.source === undefined ? source : options.source,
    directory,
    transport,
    online: () => flags.online,
    now: () => clock.now,
    timers: clock,
    statfs: async () => ({ bavail: flags.free, bsize: 1 }),
    settings: () => ({ updateChecks: flags.checks }),
    saved: () => flags.saved,
    publish: (next) => {
      published.push(structuredClone(next));
    },
    dispatch: async (action) => {
      dispatched.push(action);
    },
    helpSpaceId: () => HELP_SPACE,
    openPath: async (path) => {
      opened.push(path);
      return "";
    },
    showItemInFolder: (path) => {
      shown.push(path);
    },
    writeClipboard: (text) => {
      copied.push(text);
    },
    quit: () => {
      quits += 1;
    },
  });
  updaters.push(updater);
  return {
    updater,
    clock,
    transport,
    directory,
    published,
    dispatched,
    opened,
    shown,
    copied,
    flags,
    quits: () => quits,
    file: (version: string, kind: InstallKind = options.kind ?? "mac-arm64") =>
      join(directory, version, nameFor(version, kind)),
    // Downloads finish on real file writes, so a test waits for them.
    async settled() {
      for (let step = 0; step < 500; step++) {
        if (updater.state.state !== "downloading") return;
        await flush();
      }
      throw new Error("The download never finished.");
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<UpdateFailure> {
  try {
    await promise;
  } catch (error) {
    return error as UpdateFailure;
  }
  throw new Error("The call did not fail.");
}

afterEach(async () => {
  for (const updater of updaters.splice(0)) await updater.stop();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("the updater", () => {
  it("checks 60 s after start, then after 24 h, never while off or offline", async () => {
    const h = harness();
    h.transport.on(source.listUrl, () =>
      jsonReply(listing(NEXT, installerData)),
    );
    await h.updater.start();
    await h.clock.advance(MINUTE - 1000);
    expect(h.transport.requests).toHaveLength(0);
    await h.clock.advance(1000);
    expect(h.transport.requests).toHaveLength(1);
    expect(h.transport.requests[0].headers).toMatchObject({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Kamapathy",
    });
    expect(h.updater.state).toMatchObject({
      kind: "mac-arm64",
      state: "available",
      checkedAt: START + MINUTE,
      latest: { version: NEXT },
    });
    // Hourly ticks send nothing until the last success is a day old.
    await h.clock.advance(DAY);
    expect(h.transport.requests).toHaveLength(1);
    await h.clock.advance(HOUR);
    expect(h.transport.requests).toHaveLength(2);

    const future = harness({ saved: { checkedAt: START + 10 * DAY } });
    future.transport.on(source.listUrl, () => jsonReply([]));
    await future.updater.start();
    await future.clock.advance(MINUTE);
    expect(future.transport.requests).toHaveLength(1);
    expect(future.updater.state.state).toBe("current");

    const off = harness({ checks: false });
    off.transport.on(source.listUrl, () => jsonReply([]));
    await off.updater.start();
    await off.clock.advance(DAY + MINUTE);
    expect(off.transport.requests).toHaveLength(0);
    off.flags.online = false;
    off.flags.checks = true;
    off.updater.settingsChanged();
    await off.clock.advance(DAY);
    expect(off.transport.requests).toHaveLength(0);
    // Turning the switch on checks 60 s later.
    off.flags.online = true;
    off.flags.checks = false;
    off.updater.settingsChanged();
    off.flags.checks = true;
    off.updater.settingsChanged();
    await off.clock.advance(MINUTE);
    expect(off.transport.requests).toHaveLength(1);

    for (const kind of ["source", "other"] as InstallKind[]) {
      const plain = harness({ kind });
      await plain.updater.start();
      expect(plain.updater.state).toEqual({ kind, state: "unsupported" });
      await plain.clock.advance(2 * DAY);
      const failure = await rejection(plain.updater.check());
      expect(failure.code).toBe("update_unsupported");
      expect(failure.fields.reason).toBe(
        kind === "source" ? "source" : "platform",
      );
      expect(failure.message).toBe(
        kind === "source"
          ? "This copy runs from source. Pull the latest code to update it."
          : "No installer is published for this computer yet.",
      );
      await rejection(plain.updater.download());
      expect(plain.transport.requests).toHaveLength(0);
    }
  });

  it("waits 4 h after a failure and past a rate-limit reset", async () => {
    const h = harness();
    let answer: Reply = () => textReply("boom", 500);
    h.transport.on(source.listUrl, (options) => answer(options));
    await h.updater.start();
    await h.clock.advance(MINUTE);
    expect(h.transport.requests).toHaveLength(1);
    expect(h.updater.state.error).toEqual({
      code: "update_check_failed",
      message: "GitHub answered the update check with HTTP 500.",
      reason: "http_status",
      httpStatus: 500,
      retryable: true,
    });
    expect(h.updater.state.checkedAt).toBeUndefined();
    // No tick checks for four hours after a failure.
    await h.clock.advance(4 * HOUR - MINUTE);
    expect(h.transport.requests).toHaveLength(1);
    await h.clock.advance(HOUR);
    expect(h.transport.requests).toHaveLength(2);

    // A rate limit holds ticks until its reset, even past four hours.
    const reset = Math.floor((h.clock.now + 9 * HOUR) / 1000);
    answer = () =>
      textReply("limited", 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(reset),
      });
    await h.clock.advance(4 * HOUR + HOUR);
    const limited = h.transport.requests.length;
    expect(h.updater.state.error).toMatchObject({
      reason: "rate_limited",
      message: "GitHub limits how often Kamapathy can check. Try again later.",
      retryable: true,
    });
    expect(h.updater.state.error?.retryAfterMs).toBeGreaterThan(0);
    // Four hours pass without a check, because the reset is still ahead.
    await h.clock.advance(3 * HOUR);
    expect(h.transport.requests).toHaveLength(limited);
    await h.clock.advance(2 * HOUR);
    expect(h.transport.requests.length).toBeGreaterThan(limited);

    const cases: {
      answer: Reply;
      reason: string;
      message: string;
      retryable?: true;
    }[] = [
      {
        answer: () => textReply("nope", 404),
        reason: "http_status",
        message: "GitHub answered the update check with HTTP 404.",
      },
      {
        answer: () => textReply("{nope"),
        reason: "invalid_response",
        message: "Kamapathy couldn't read GitHub's list of releases.",
      },
      {
        answer: () => jsonReply({ releases: [] }),
        reason: "invalid_response",
        message: "Kamapathy couldn't read GitHub's list of releases.",
      },
      {
        answer: () =>
          reply(
            200,
            iterate(
              Buffer.alloc(2 * MiB),
              Buffer.alloc(2 * MiB),
              Buffer.alloc(32),
            ),
          ),
        reason: "invalid_response",
        message: "Kamapathy couldn't read GitHub's list of releases.",
      },
      {
        answer: () => {
          throw new Error("socket closed");
        },
        reason: "network",
        message: "Kamapathy couldn't reach GitHub to check for updates.",
        retryable: true,
      },
    ];
    for (const entry of cases) {
      answer = entry.answer;
      await h.clock.advance(MINUTE + 1000);
      const failure = await rejection(h.updater.check());
      expect(failure.fields.reason).toBe(entry.reason);
      expect(failure.message).toBe(entry.message);
      expect(h.updater.state.error?.reason).toBe(entry.reason);
      expect(h.updater.state.error?.retryable).toBe(entry.retryable);
    }

    answer = () => new Promise<TransportResponse>(() => {});
    await h.clock.advance(MINUTE + 1000);
    const pending = h.updater.check();
    const failure = rejection(pending);
    await h.clock.advance(15000);
    const timeout = await failure;
    expect(timeout.fields).toEqual({ reason: "timeout" });
    expect(timeout.message).toBe(
      "GitHub didn't answer the update check in time.",
    );
    expect(h.updater.state.error?.retryable).toBe(true);

    const offline = harness({ online: false });
    const refused = await rejection(offline.updater.check());
    expect(refused.fields).toEqual({ reason: "offline" });
    expect(refused.message).toBe(
      "Kamapathy is offline, so it couldn't check for updates.",
    );
    expect(offline.transport.requests).toHaveLength(0);
  });

  it("joins checks and reuses a result under 60 s old", async () => {
    const h = harness();
    let release!: (response: TransportResponse) => void;
    h.transport.on(
      source.listUrl,
      () => new Promise<TransportResponse>((resolve) => (release = resolve)),
    );
    const first = h.updater.check();
    const second = h.updater.check();
    await flush();
    expect(h.transport.requests).toHaveLength(1);
    release(jsonReply(listing(NEXT, installerData)));
    expect(await first).toMatchObject({
      state: "available",
      version: RUNNING,
      checks: true,
      checkedAt: START,
      latest: { version: NEXT, installer: { name: nameFor(NEXT) } },
    });
    expect(await second).toEqual(await first);
    expect(h.published.at(-1)).toMatchObject({
      state: "available",
      checkedAt: START,
      latest: { version: NEXT },
    });
    expect(h.published.at(-1)?.error).toBeUndefined();

    // Within a minute of the last attempt nothing is sent again.
    await h.clock.advance(30000);
    expect(await h.updater.check()).toMatchObject({ state: "available" });
    expect(h.transport.requests).toHaveLength(1);

    await h.clock.advance(31000);
    h.transport.on(source.listUrl, () => textReply("gone", 502));
    const failure = await rejection(h.updater.check());
    expect(failure.fields).toEqual({ reason: "http_status", httpStatus: 502 });
    const stored = await rejection(h.updater.check());
    expect(stored).toBe(failure);
    expect(h.transport.requests).toHaveLength(2);
  });

  it("renames the part file only when both hashes match", async () => {
    const h = harness();
    mkdirSync(join(h.directory, "0.4.0"), { recursive: true });
    writeFileSync(join(h.directory, "0.4.0", "stale"), "old");
    h.transport.on(source.listUrl, () =>
      jsonReply(
        listing(NEXT, installerData, "mac-arm64", hashOf(installerData)),
      ),
    );
    let stream!: ReturnType<typeof channel>;
    h.transport.on(installerUrl(NEXT), (options) => {
      stream = channel(options);
      return reply(200, stream.body);
    });
    h.transport.on(sumsUrl(NEXT), () =>
      textReply(sumsFor(NEXT, installerData)),
    );
    await h.updater.start();
    const started = await h.updater.download();
    expect(started.started).toBe(true);
    expect(started.status.state).toBe("downloading");
    const file = h.file(NEXT);
    expect((statSync(join(h.directory, NEXT)).mode & 0o777).toString(8)).toBe(
      "700",
    );
    expect((statSync(`${file}.part`).mode & 0o777).toString(8)).toBe("600");

    stream.push(installerData.subarray(0, 600));
    for (let step = 0; step < 50 && !h.updater.state.progress; step++)
      await flush();
    expect(h.updater.state.progress).toEqual({
      receivedBytes: 600,
      totalBytes: installerData.length,
    });
    stream.push(installerData.subarray(600));
    stream.end();
    await h.settled();

    expect(readFileSync(file).equals(installerData)).toBe(true);
    expect((statSync(file).mode & 0o777).toString(8)).toBe("644");
    expect(readFileSync(`${file}.sha256`, "utf8")).toBe(hashOf(installerData));
    expect((statSync(`${file}.sha256`).mode & 0o777).toString(8)).toBe("600");
    expect(existsSync(`${file}.part`)).toBe(false);
    expect(existsSync(join(h.directory, "0.4.0"))).toBe(false);
    expect(h.updater.state).toMatchObject({
      state: "ready",
      installer: { path: file, sha256: hashOf(installerData) },
    });
    expect(h.updater.reminder()).toEqual({ version: NEXT, state: "ready" });
    // A download that is already finished starts nothing.
    const again = await h.updater.download();
    expect(again.started).toBe(false);
    expect(h.transport.count(installerUrl(NEXT))).toBe(1);

    const appImage = harness({ kind: "linux-appimage" });
    appImage.transport
      .on(source.listUrl, () =>
        jsonReply(listing(NEXT, installerData, "linux-appimage")),
      )
      .on(installerUrl(NEXT, "linux-appimage"), () =>
        reply(200, iterate(installerData)),
      )
      .on(sumsUrl(NEXT), () =>
        textReply(sumsFor(NEXT, installerData, "linux-appimage")),
      );
    await appImage.updater.start();
    await appImage.updater.download();
    await appImage.settled();
    expect(appImage.updater.state.state).toBe("ready");
    expect(
      (statSync(appImage.file(NEXT, "linux-appimage")).mode & 0o777).toString(
        8,
      ),
    ).toBe("755");
  });

  it("deletes a mismatched download with update_verify_failed", async () => {
    const other = Buffer.alloc(installerData.length, 0x62);
    const cases: {
      sums: string;
      digest: string | null;
      reason: string;
    }[] = [
      { sums: sumsFor(NEXT, other), digest: null, reason: "sums_mismatch" },
      {
        sums: sumsFor(NEXT, installerData),
        digest: hashOf(other),
        reason: "digest_mismatch",
      },
      {
        sums: `${hashOf(installerData)}  OTHER.txt\n`,
        digest: null,
        reason: "sums_invalid",
      },
      { sums: "not a checksum list\n", digest: null, reason: "sums_invalid" },
    ];
    for (const entry of cases) {
      const h = harness();
      h.transport
        .on(source.listUrl, () =>
          jsonReply(listing(NEXT, installerData, "mac-arm64", entry.digest)),
        )
        .on(installerUrl(NEXT), () => reply(200, iterate(installerData)))
        .on(sumsUrl(NEXT), () => textReply(entry.sums));
      await h.updater.start();
      await h.updater.download();
      await h.settled();
      expect(h.updater.state.state).toBe("available");
      expect(h.updater.state.error).toEqual({
        code: "update_verify_failed",
        message: "The download didn't match its checksum, so it was deleted.",
        reason: entry.reason,
        file: nameFor(NEXT),
        retryable: false,
      });
      expect(existsSync(`${h.file(NEXT)}.part`)).toBe(false);
      expect(existsSync(h.file(NEXT))).toBe(false);
      expect(h.updater.state.installer).toBeUndefined();
    }
  });

  it("stops on extra bytes, a stall, a non-HTTPS hop and short space", async () => {
    const list = () =>
      jsonReply(
        listing(NEXT, installerData, "mac-arm64", hashOf(installerData)),
      );

    const extra = harness();
    extra.transport
      .on(source.listUrl, list)
      .on(installerUrl(NEXT), () =>
        reply(200, iterate(installerData, Buffer.from("!"))),
      );
    await extra.updater.download();
    await extra.settled();
    expect(extra.updater.state.error).toEqual({
      code: "update_download_failed",
      message: "The download stopped. Try again.",
      reason: "size_mismatch",
    });
    expect(extra.updater.state.state).toBe("available");
    expect(existsSync(`${extra.file(NEXT)}.part`)).toBe(false);

    const short = harness();
    short.transport
      .on(source.listUrl, list)
      .on(installerUrl(NEXT), () =>
        reply(200, iterate(installerData.subarray(0, 4096))),
      );
    await short.updater.download();
    await short.settled();
    expect(short.updater.state.error?.reason).toBe("size_mismatch");

    const stalling = harness();
    let stream!: ReturnType<typeof channel>;
    stalling.transport
      .on(source.listUrl, list)
      .on(installerUrl(NEXT), (options) => {
        stream = channel(options);
        return reply(200, stream.body);
      });
    await stalling.updater.download();
    stream.push(installerData.subarray(0, 32));
    // The stall timer restarts once the chunk is on disk, so the clock
    // moves only after that.
    for (let step = 0; step < 50 && !stalling.updater.state.progress; step++)
      await flush();
    expect(stalling.updater.state.progress?.receivedBytes).toBe(32);
    await stalling.clock.advance(59000);
    expect(stalling.updater.state.state).toBe("downloading");
    await stalling.clock.advance(1000);
    await stalling.settled();
    expect(stalling.updater.state.error).toEqual({
      code: "update_download_failed",
      message: "The download stopped. Try again.",
      reason: "stalled",
      retryable: true,
    });
    expect(existsSync(`${stalling.file(NEXT)}.part`)).toBe(false);

    for (const hops of [
      ["http://127.0.0.1:9/next"],
      [1, 2, 3, 4, 5, 6].map((hop) => `https://objects.github.com/${hop}`),
    ]) {
      const redirected = harness();
      redirected.transport
        .on(source.listUrl, list)
        .on(installerUrl(NEXT), (options) => {
          for (const [index, next] of hops.entries())
            if (!options.redirect(next, index + 1))
              throw new RedirectRefused(`Refused a redirect to ${next}.`);
          return reply(200, iterate(installerData));
        });
      await redirected.updater.download();
      await redirected.settled();
      expect(redirected.updater.state.error).toEqual({
        code: "update_download_failed",
        message: "The download stopped. Try again.",
        reason: "insecure_redirect",
      });
      expect(existsSync(`${redirected.file(NEXT)}.part`)).toBe(false);
    }

    const full = harness({ free: installerData.length + 64 * MiB - 1 });
    full.transport.on(source.listUrl, list);
    await full.updater.download();
    await full.settled();
    expect(full.updater.state.error?.reason).toBe("disk_full");
    expect(full.transport.count(installerUrl(NEXT))).toBe(0);
    expect(existsSync(`${full.file(NEXT)}.part`)).toBe(false);

    const refused = harness();
    refused.transport
      .on(source.listUrl, list)
      .on(installerUrl(NEXT), () => textReply("later", 503));
    await refused.updater.download();
    await refused.settled();
    expect(refused.updater.state.error).toEqual({
      code: "update_download_failed",
      message: "The download stopped. Try again.",
      reason: "http_status",
      httpStatus: 503,
      retryable: true,
    });
    expect(existsSync(`${refused.file(NEXT)}.part`)).toBe(false);
  });

  it("finds a finished installer at start and hashes it before opening", async () => {
    const sha256 = hashOf(installerData);
    const h = harness({
      saved: {
        checkedAt: START - HOUR,
        latest: savedRelease(NEXT, installerData.length, "mac-arm64", {
          sha256,
        }),
      },
    });
    const file = h.file(NEXT);
    mkdirSync(join(h.directory, NEXT), { recursive: true });
    writeFileSync(file, installerData);
    writeFileSync(`${file}.sha256`, sha256);
    writeFileSync(join(h.directory, NEXT, "half.part"), "half");
    mkdirSync(join(h.directory, "0.1.0"), { recursive: true });
    writeFileSync(join(h.directory, "0.1.0", "old.part"), "old");
    mkdirSync(join(h.directory, RUNNING), { recursive: true });
    await h.updater.start();
    expect(h.updater.state).toMatchObject({
      state: "ready",
      checkedAt: START - HOUR,
      latest: { version: NEXT },
      installer: { path: file, sha256 },
    });
    expect(existsSync(join(h.directory, "0.1.0"))).toBe(false);
    expect(existsSync(join(h.directory, RUNNING))).toBe(false);
    expect(existsSync(join(h.directory, NEXT, "half.part"))).toBe(false);
    expect(existsSync(file)).toBe(true);

    await h.updater.install();
    expect(h.opened).toEqual([file]);
    expect(h.quits()).toBe(1);

    writeFileSync(file, Buffer.alloc(installerData.length, 0x62));
    await h.updater.install();
    expect(h.opened).toHaveLength(1);
    expect(h.quits()).toBe(1);
    expect(h.updater.state.state).toBe("available");
    expect(h.updater.state.error).toEqual({
      code: "update_verify_failed",
      message: "The download didn't match its checksum, so it was deleted.",
      reason: "sums_mismatch",
      file: nameFor(NEXT),
      retryable: false,
    });

    const dropped: {
      what: string;
      latest: UpdateRelease;
      kind?: InstallKind;
    }[] = [
      { what: "the running version", latest: savedRelease(RUNNING, MiB * 2) },
      {
        what: "another kind's installer",
        latest: savedRelease(NEXT, MiB * 2, "linux-deb"),
      },
      {
        what: "another base",
        latest: savedRelease(NEXT, MiB * 2, "mac-arm64", {
          base: "https://github.com/someone/else/releases",
        }),
      },
    ];
    for (const entry of dropped) {
      const other = harness({
        saved: { checkedAt: START - HOUR, latest: entry.latest },
      });
      await other.updater.start();
      expect(other.updater.state.latest, entry.what).toBeUndefined();
      expect(other.updater.state).toEqual({
        kind: "mac-arm64",
        state: "current",
        checkedAt: START - HOUR,
      });
    }

    const appImage = harness({
      kind: "linux-appimage",
      saved: {
        checkedAt: START - HOUR,
        latest: savedRelease(NEXT, installerData.length, "linux-appimage", {
          sha256,
        }),
      },
    });
    const image = appImage.file(NEXT, "linux-appimage");
    mkdirSync(join(appImage.directory, NEXT), { recursive: true });
    writeFileSync(image, installerData);
    writeFileSync(`${image}.sha256`, sha256);
    await appImage.updater.start();
    expect(appImage.updater.state.state).toBe("ready");
    await appImage.updater.install();
    expect(appImage.shown).toEqual([image]);
    expect(appImage.opened).toHaveLength(0);
    expect(appImage.quits()).toBe(0);

    const deb = harness({
      kind: "linux-deb",
      saved: {
        checkedAt: START - HOUR,
        latest: savedRelease(NEXT, installerData.length, "linux-deb", {
          sha256,
        }),
      },
    });
    const packaged = deb.file(NEXT, "linux-deb");
    mkdirSync(join(deb.directory, NEXT), { recursive: true });
    writeFileSync(packaged, installerData);
    writeFileSync(`${packaged}.sha256`, sha256);
    await deb.updater.start();
    deb.updater.showFile();
    deb.updater.copyCommand();
    expect(deb.shown).toEqual([packaged]);
    expect(deb.copied).toEqual([`sudo apt install '${packaged}'`]);
    expect(aptInstallCommand("/home/a b/it's.deb")).toBe(
      "sudo apt install '/home/a b/it'\\''s.deb'",
    );
  });

  it("cancel deletes the part file with reason cancelled", async () => {
    const h = harness();
    let stream!: ReturnType<typeof channel>;
    h.transport
      .on(source.listUrl, () => jsonReply(listing(NEXT, installerData)))
      .on(installerUrl(NEXT), (options) => {
        stream = channel(options);
        return reply(200, stream.body);
      });
    await h.updater.download();
    stream.push(installerData.subarray(0, 128));
    await flush();
    expect(existsSync(`${h.file(NEXT)}.part`)).toBe(true);
    await h.updater.cancel();
    expect(existsSync(`${h.file(NEXT)}.part`)).toBe(false);
    expect(h.updater.state.state).toBe("available");
    expect(h.updater.state.error).toEqual({
      code: "update_download_failed",
      message: "Download cancelled.",
      reason: "cancelled",
    });
    expect(h.updater.state.progress).toBeUndefined();

    const stopped = harness();
    let second!: ReturnType<typeof channel>;
    stopped.transport
      .on(source.listUrl, () => jsonReply(listing(NEXT, installerData)))
      .on(installerUrl(NEXT), (options) => {
        second = channel(options);
        return reply(200, second.body);
      });
    await stopped.updater.download();
    second.push(installerData.subarray(0, 128));
    await flush();
    await stopped.updater.stop();
    expect(existsSync(`${stopped.file(NEXT)}.part`)).toBe(false);
    await stopped.clock.advance(2 * DAY);
    expect(stopped.transport.count(source.listUrl)).toBe(1);
  });

  it("opens release notes in the space helpSpaceId picks", async () => {
    const h = harness();
    h.transport.on(source.listUrl, () =>
      jsonReply(listing(NEXT, installerData)),
    );
    await h.updater.check();
    await h.updater.openNotes("running");
    expect(h.dispatched).toStrictEqual([
      {
        type: "tab:create",
        url: `${source.releasesBase}/tag/v${RUNNING}`,
        spaceId: HELP_SPACE,
      },
    ]);
    await h.updater.openNotes("latest");
    expect(h.dispatched.at(-1)).toStrictEqual({
      type: "tab:create",
      url: `${source.releasesBase}/tag/v${NEXT}`,
      spaceId: HELP_SPACE,
    });

    const sourceless = harness({ source: null });
    await sourceless.updater.start();
    await sourceless.updater.openNotes("running");
    await sourceless.updater.openNotes("latest");
    expect(sourceless.dispatched).toHaveLength(0);
  });
});
