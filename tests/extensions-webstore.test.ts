import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createServer, get, type Server } from "node:http";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import type { BrowserWindow, Session } from "electron";
import { dialog } from "electron";
import {
  permissionLines,
  type ExtensionsFile,
  type Grant,
} from "../shared/extensions";
import { ExtensionHost } from "../electron/extensions/host";
import {
  confirmAdd,
  type ConsentDetails,
} from "../electron/extensions/dialogs";
import {
  ExtensionInstaller,
  InstallError,
} from "../electron/extensions/install";
import {
  DOWNLOAD_LIMITS,
  DownloadError,
  crxUrl,
  sessionFetcher,
  storeEnv,
  type FetchLimits,
  type FetchResult,
  type Fetcher,
} from "../electron/extensions/webstore";
import { extensionInstallCopy, extensionRefusalCopy } from "../src/copy";
import {
  crxOf,
  extensionZip,
  hashOf,
  idOf,
  keyPair,
  zipOf,
} from "./extension-builders";

vi.mock("electron", () => ({
  net: { request: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
}));

const CHROME = "152.0.7977.76";
const developer = { kind: "rsa" as const, ...keyPair("rsa") };
const publisher = { kind: "ec" as const, ...keyPair("ec") };
const other = { kind: "rsa" as const, ...keyPair("rsa") };
const id = idOf(developer.publicKey);
const publisherHash = hashOf(publisher.publicKey);
const manifest = {
  manifest_version: 3,
  name: "Marker",
  version: "1.2.0",
  permissions: ["tabs", "notifications"],
  host_permissions: ["https://example.com/*"],
};
const grant: Grant = {
  permissions: ["tabs", "notifications"],
  hosts: ["https://example.com/*"],
};
function crxFor(
  content: Record<string, unknown> = manifest,
  proofs = [developer, publisher],
): Buffer {
  return crxOf(extensionZip(content, { "worker.js": "" }), proofs);
}
const download = crxFor();

// What Electron does with a folder: the id comes from the manifest's key, so
// a wrong injected key gives another id.
class FakeSession {
  loaded: { id: string; path: string }[] = [];
  removed: string[] = [];
  failure: Error | null = null;
  extensions = {
    loadExtension: vi.fn(async (path: string) => {
      if (this.failure) throw this.failure;
      const content = JSON.parse(
        readFileSync(join(path, "manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      const key =
        typeof content.key === "string"
          ? idOf(Buffer.from(content.key, "base64"))
          : "";
      this.loaded.push({ id: key, path });
      return {
        id: key,
        path,
        name: String(content.name),
        version: String(content.version),
        url: `chrome-extension://${key}/`,
        manifest: content,
      };
    }),
    removeExtension: vi.fn((extensionId: string) => {
      this.removed.push(extensionId);
    }),
  };
}
const asSession = (fake: FakeSession) => fake as unknown as Session;

const roots: string[] = [];
function temporary(): string {
  const folder = mkdtempSync(join(tmpdir(), "kamapathy-store-"));
  roots.push(folder);
  return folder;
}
function stagingFiles(userData: string): string[] {
  const folder = join(userData, "Extensions", ".staging");
  return existsSync(folder) ? readdirSync(folder) : [];
}
function recorded(userData: string): ExtensionsFile {
  const path = join(userData, "extensions.json");
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as ExtensionsFile)
    : { extensions: [], removals: [] };
}

// A loopback server standing in for the store's redirect target.
let server: Server;
let origin = "";
let serving: { status: number; body: Buffer } = { status: 200, body: download };
const served: string[] = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    served.push(request.url ?? "");
    response.writeHead(serving.status, {
      "content-type": "application/x-chrome-extension",
    });
    response.end(serving.status === 204 ? undefined : serving.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/crx`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const asked: { url: string; limits: FetchLimits }[] = [];
function loopback(): Fetcher {
  return async (url: string, limits: FetchLimits) => {
    asked.push({ url, limits });
    return new Promise<FetchResult>((resolve, reject) => {
      const request = get(origin, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks),
            url: origin,
          }),
        );
      });
      request.on("error", reject);
    });
  };
}

async function setUp(fetcher: Fetcher = loopback()) {
  const userData = temporary();
  const host = new ExtensionHost({
    userData,
    locale: "en-US",
    chromeVersion: CHROME,
  });
  await host.init();
  const sessions = [new FakeSession(), new FakeSession()];
  await host.attach("persist:one", asSession(sessions[0]));
  await host.attach("persist:two", asSession(sessions[1]));
  const confirm = vi.fn(async (_details: ConsentDetails) => true);
  const installer = new ExtensionInstaller({
    host,
    fetcher,
    env: storeEnv("darwin", "arm64", CHROME),
    locale: "en-US",
    confirm,
    publisherKeyHash: publisherHash,
    now: () => 1700,
  });
  return { userData, host, sessions, confirm, installer };
}

beforeEach(() => {
  serving = { status: 200, body: download };
  served.length = 0;
  asked.length = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

class FakeRequest extends EventEmitter {
  followRedirect = vi.fn();
  abort = vi.fn();
  end = vi.fn();
}
class FakeResponse extends EventEmitter {
  constructor(readonly statusCode: number) {
    super();
  }
}

describe("store installs", () => {
  it("a full install from a local HTTP server, with an injected publisher hash", async () => {
    const { userData, host, sessions, confirm, installer } = await setUp();

    const outcome = await installer.installFromStore(id);

    expect(outcome).toEqual({ added: true, id, name: "Marker" });
    expect(asked).toEqual([
      {
        url: crxUrl(id, storeEnv("darwin", "arm64", CHROME)),
        limits: DOWNLOAD_LIMITS,
      },
    ]);
    expect(confirm).toHaveBeenCalledWith({
      name: "Marker",
      lines: permissionLines(grant),
      wontWork: ["Notifications"],
    });
    const folder = join(userData, "Extensions", id, "1.2.0");
    const written = JSON.parse(
      readFileSync(join(folder, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(written.key).toBe(developer.publicKey.toString("base64"));
    expect(written.name).toBe("Marker");
    expect(recorded(userData).extensions).toEqual([
      {
        id,
        source: "webstore",
        version: "1.2.0",
        path: `Extensions/${id}/1.2.0`,
        enabled: true,
        pinned: true,
        installedAt: 1700,
        grantedPermissions: grant.permissions,
        grantedHosts: grant.hosts,
      },
    ]);
    expect(host.entry(id)?.version).toBe("1.2.0");
    for (const fake of sessions)
      expect(fake.loaded).toEqual([{ id, path: folder }]);
    expect(stagingFiles(userData)).toEqual([]);
    expect(installer.installing()).toEqual([]);
  });

  it("store URLs carry the Chromium version, OS and architecture", () => {
    expect(crxUrl(id, storeEnv("darwin", "arm64", CHROME))).toBe(
      "https://clients2.google.com/service/update2/crx?response=redirect" +
        "&acceptformat=crx3&prodversion=152.0.7977.76&os=mac&arch=arm64" +
        `&x=id%3D${id}%26installsource%3Dondemand%26uc`,
    );
    expect(crxUrl(id, storeEnv("win32", "x64", CHROME))).toBe(
      "https://clients2.google.com/service/update2/crx?response=redirect" +
        "&acceptformat=crx3&prodversion=152.0.7977.76&os=win&arch=x64" +
        `&x=id%3D${id}%26installsource%3Dondemand%26uc`,
    );
    expect(crxUrl(id, storeEnv("linux", "x64", CHROME))).toBe(
      "https://clients2.google.com/service/update2/crx?response=redirect" +
        "&acceptformat=crx3&prodversion=152.0.7977.76&os=linux&arch=x64" +
        `&x=id%3D${id}%26installsource%3Dondemand%26uc`,
    );
    expect(storeEnv("freebsd", "arm", "1.2.3")).toEqual({
      chromeVersion: "1.2.3",
      os: "linux",
      arch: "arm",
    });
    expect(storeEnv()).toEqual({
      chromeVersion: process.versions.chrome,
      os:
        process.platform === "darwin"
          ? "mac"
          : process.platform === "win32"
            ? "win"
            : "linux",
      arch: process.arch,
    });
  });

  it("204 and 404 answer It isn't in the Chrome Web Store.", async () => {
    const { userData, installer } = await setUp();
    for (const status of [204, 404]) {
      serving = { status, body: Buffer.alloc(0) };
      await expect(installer.installFromStore(id)).rejects.toThrow(
        extensionInstallCopy.notInStore,
      );
    }
    serving = { status: 500, body: Buffer.alloc(0) };
    await expect(installer.installFromStore(id)).rejects.toThrow(
      extensionInstallCopy.downloadFailed,
    );
    await expect(installer.installFromStore(id, {})).rejects.toBeInstanceOf(
      InstallError,
    );
    expect(recorded(userData).extensions).toEqual([]);
    expect(existsSync(join(userData, "Extensions", id))).toBe(false);
  });

  it("a download that fails its checks never leaves staging", async () => {
    const { userData, host, sessions, installer } = await setUp();
    const cases: { body: Buffer; copy: string }[] = [
      // Signed for another extension.
      {
        body: crxFor(manifest, [other, publisher]),
        copy: extensionInstallCopy.failedChecks,
      },
      // No proof from the pinned publisher key.
      {
        body: crxFor(manifest, [developer]),
        copy: extensionInstallCopy.failedChecks,
      },
      {
        body: crxOf(
          zipOf([
            { path: "manifest.json", data: JSON.stringify(manifest) },
            { path: "../escape.js", data: "" },
          ]),
          [developer, publisher],
        ),
        copy: extensionInstallCopy.failedChecks,
      },
      {
        body: crxFor({ ...manifest, manifest_version: 2 }),
        copy: extensionRefusalCopy.version,
      },
    ];
    for (const { body, copy } of cases) {
      serving = { status: 200, body };
      await expect(installer.installFromStore(id)).rejects.toThrow(copy);
      expect(stagingFiles(userData)).toEqual([]);
      expect(existsSync(join(userData, "Extensions", id))).toBe(false);
      expect(recorded(userData).extensions).toEqual([]);
      expect(host.entry(id)).toBeUndefined();
      for (const fake of sessions) expect(fake.loaded).toEqual([]);
    }

    // A build that doesn't match what an update promised.
    await expect(
      installer.prepareStoreBuild(id, download, { hashSha256: "00" }),
    ).rejects.toThrow(extensionInstallCopy.failedChecks);
    await expect(
      installer.prepareStoreBuild(id, download, { version: "2.0.0" }),
    ).rejects.toThrow(extensionInstallCopy.failedChecks);
    expect(stagingFiles(userData)).toEqual([]);

    const build = await installer.prepareStoreBuild(id, download, {
      hashSha256: createHash("sha256").update(download).digest("hex"),
      version: "1.2.0",
    });
    expect(build.version).toBe("1.2.0");
    expect(build.manifest.name).toBe("Marker");
    expect(build.publicKey.equals(developer.publicKey)).toBe(true);
    expect(stagingFiles(userData)).toHaveLength(1);
    await installer.discard(build);
    expect(stagingFiles(userData)).toEqual([]);
  });

  it("Cancel adds nothing, and a failed load undoes every step", async () => {
    const cancelled = await setUp();
    cancelled.confirm.mockResolvedValue(false);
    await expect(cancelled.installer.installFromStore(id)).resolves.toEqual({
      added: false,
      id,
    });
    expect(recorded(cancelled.userData).extensions).toEqual([]);
    expect(existsSync(join(cancelled.userData, "Extensions", id))).toBe(false);
    expect(stagingFiles(cancelled.userData)).toEqual([]);
    for (const fake of cancelled.sessions) expect(fake.loaded).toEqual([]);

    const { userData, host, sessions, installer } = await setUp();
    sessions[1].failure = new Error("Electron could not load it.");
    await expect(installer.installFromStore(id)).rejects.toThrow(
      extensionInstallCopy.couldNotAdd("Marker", "Electron could not load it."),
    );
    expect(host.entry(id)).toBeUndefined();
    expect(recorded(userData).extensions).toEqual([]);
    expect(existsSync(join(userData, "Extensions", id, "1.2.0"))).toBe(false);
    expect(sessions[0].removed).toEqual([id]);
    expect(stagingFiles(userData)).toEqual([]);
  });

  it("the store fetcher refuses plain HTTP hops, more than 5 redirects, 256 MiB and 120000 ms", async () => {
    expect(DOWNLOAD_LIMITS).toEqual({
      redirects: 5,
      timeoutMs: 120000,
      maxBytes: 256 * 1024 ** 2,
    });
    const limits: FetchLimits = { ...DOWNLOAD_LIMITS };
    const ses = {} as Session;
    const started: {
      options: Record<string, unknown>;
      request: FakeRequest;
    }[] = [];
    const request = ((options: Record<string, unknown>) => {
      const made = new FakeRequest();
      started.push({ options, request: made });
      return made;
    }) as unknown as NonNullable<Parameters<typeof sessionFetcher>[1]>;
    const fetch = sessionFetcher(ses, request);

    await expect(fetch("http://example.com/crx", limits)).rejects.toMatchObject(
      { reason: "insecure" },
    );
    expect(started).toHaveLength(0);

    const answered = fetch("https://example.com/crx", limits);
    expect(started[0].options).toEqual({
      url: "https://example.com/crx",
      session: ses,
      redirect: "manual",
      useSessionCookies: false,
      cache: "no-store",
    });
    expect(started[0].request.end).toHaveBeenCalledOnce();
    started[0].request.emit(
      "redirect",
      302,
      "GET",
      "https://cdn.example.com/a",
    );
    expect(started[0].request.followRedirect).toHaveBeenCalledOnce();
    const response = new FakeResponse(200);
    started[0].request.emit("response", response);
    response.emit("data", Buffer.from("crx"));
    response.emit("end");
    await expect(answered).resolves.toEqual({
      status: 200,
      body: Buffer.from("crx"),
      url: "https://cdn.example.com/a",
    });

    const downgraded = fetch("https://example.com/crx", limits);
    started[1].request.emit("redirect", 302, "GET", "http://cdn.example.com/a");
    await expect(downgraded).rejects.toMatchObject({ reason: "insecure" });
    expect(started[1].request.followRedirect).not.toHaveBeenCalled();
    expect(started[1].request.abort).toHaveBeenCalledOnce();

    const looping = fetch("https://example.com/crx", limits);
    for (let hop = 0; hop <= DOWNLOAD_LIMITS.redirects; hop++)
      started[2].request.emit(
        "redirect",
        302,
        "GET",
        `https://example.com/${hop}`,
      );
    await expect(looping).rejects.toMatchObject({ reason: "redirects" });
    expect(started[2].request.followRedirect).toHaveBeenCalledTimes(
      DOWNLOAD_LIMITS.redirects,
    );

    const large = fetch("https://example.com/crx", limits);
    const big = new FakeResponse(200);
    started[3].request.emit("response", big);
    // Counted, never kept: the limit is checked before the chunk is held.
    big.emit("data", {
      length: DOWNLOAD_LIMITS.maxBytes + 1,
    } as unknown as Buffer);
    await expect(large).rejects.toMatchObject({ reason: "too_large" });
    expect(started[3].request.abort).toHaveBeenCalledOnce();

    const broken = fetch("https://example.com/crx", limits);
    started[4].request.emit("error", new Error("offline"));
    await expect(broken).rejects.toBeInstanceOf(DownloadError);

    vi.useFakeTimers();
    const slow = expect(
      fetch("https://example.com/crx", limits),
    ).rejects.toMatchObject({ reason: "timeout" });
    await vi.advanceTimersByTimeAsync(DOWNLOAD_LIMITS.timeoutMs);
    await slow;
    expect(started[5].request.abort).toHaveBeenCalledOnce();
  });

  it("installs run one at a time", async () => {
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const serve = loopback();
    const second = idOf(other.publicKey);
    const { userData, installer } = await setUp(async (url, limits) => {
      if (url.includes(id)) await waiting;
      return serve(url, limits);
    });
    const changes: string[][] = [];
    installer.onChange(() => changes.push(installer.installing()));

    const first = installer.installFromStore(id);
    const next = installer.installFromStore(second);
    expect(installer.installing()).toEqual([id, second]);
    expect(served).toHaveLength(0);

    release();
    await expect(first).resolves.toEqual({ added: true, id, name: "Marker" });
    // The second asks the store only after the first finished.
    await expect(next).rejects.toThrow(extensionInstallCopy.failedChecks);
    expect(served).toHaveLength(2);
    expect(installer.installing()).toEqual([]);
    expect(changes[0]).toEqual([id]);
    expect(changes.at(-1)).toEqual([]);
    expect(recorded(userData).extensions).toHaveLength(1);
  });

  it("the consent dialog lists permission lines, the agent spaces line and won't work names, with Cancel as the default", async () => {
    const window = { id: 1 } as unknown as BrowserWindow;
    const asking = dialog.showMessageBox as unknown as Mock<
      (...args: unknown[]) => Promise<{
        response: number;
        checkboxChecked: boolean;
      }>
    >;
    asking.mockResolvedValue({ response: 1, checkboxChecked: false });
    const confirm = confirmAdd(() => window);

    await expect(
      confirm({
        name: "Marker",
        lines: permissionLines(grant),
        wontWork: ["Notifications", "Keyboard shortcuts"],
      }),
    ).resolves.toBe(true);
    expect(asking).toHaveBeenCalledWith(window, {
      type: "question",
      message: 'Add "Marker"?',
      detail: [
        "Read and change your data on example.com",
        "Read your browsing history",
        extensionInstallCopy.agentSpaces,
        "Won't work in Kamapathy: Notifications, Keyboard shortcuts.",
      ].join("\n"),
      buttons: [extensionInstallCopy.cancel, extensionInstallCopy.add],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });

    asking.mockResolvedValue({ response: 0, checkboxChecked: false });
    await expect(
      confirm({ name: "Marker", lines: [], wontWork: [] }),
    ).resolves.toBe(false);
    expect(asking.mock.calls[1][1]).toMatchObject({
      detail: extensionInstallCopy.agentSpaces,
    });

    // Without a window the box stands on its own.
    await confirmAdd(() => null)({ name: "Marker", lines: [], wontWork: [] });
    expect(asking.mock.calls[2]).toHaveLength(1);
  });
});
