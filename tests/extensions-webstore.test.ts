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
  type ExtensionEntry,
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
  UPDATE_LIMITS,
  crxUrl,
  parseUpdateXml,
  sessionFetcher,
  storeEnv,
  updateCheckUrl,
  type FetchLimits,
  type FetchResult,
  type Fetcher,
} from "../electron/extensions/webstore";
import {
  CHECK_EVERY_MS,
  ExtensionUpdates,
  FIRST_CHECK_MS,
} from "../electron/extensions/updates";
import type { CheckedManifest } from "../electron/extensions/manifest";
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

describe("store updates", () => {
  const second = idOf(other.publicKey);
  const newer = { ...manifest, version: "1.3.0" };
  const raising = { ...newer, host_permissions: ["<all_urls>"] };
  const raised: Grant = {
    permissions: grant.permissions,
    hosts: ["<all_urls>"],
  };
  const codebase = "https://downloads.example.com/marker-1.3.0.crx";
  const env = storeEnv("darwin", "arm64", CHROME);
  const checkLimits: FetchLimits = {
    timeoutMs: UPDATE_LIMITS.timeoutMs,
    maxBytes: UPDATE_LIMITS.maxBytes,
    redirects: DOWNLOAD_LIMITS.redirects,
  };

  // A valid extension id for a fabricated entry.
  function fakeId(index: number): string {
    return index
      .toString(16)
      .padStart(32, "0")
      .replace(/[0-9a-f]/g, (digit) =>
        String.fromCharCode(97 + parseInt(digit, 16)),
      );
  }
  function checkedManifest(name: string): CheckedManifest {
    return {
      manifest: {},
      name,
      version: "1.0.0",
      permissions: [],
      hosts: [],
      lines: [],
      wontWork: [],
      icons: {},
      actionIcons: {},
    };
  }
  function storeEntry(entryId: string): ExtensionEntry {
    return {
      id: entryId,
      source: "webstore",
      version: "1.0.0",
      path: `Extensions/${entryId}/1.0.0`,
      enabled: true,
      pinned: false,
      installedAt: 1,
      grantedPermissions: [],
      grantedHosts: [],
    };
  }

  function gupdate(body: string): string {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">' +
      '<daystart elapsed_seconds="35000"/>' +
      body +
      "</gupdate>"
    );
  }
  const noUpdate = (appid: string) =>
    `<app appid="${appid}" status="ok"><updatecheck status="noupdate"/></app>`;
  function offer(appid: string, version: string, extra = ""): string {
    return (
      `<app appid="${appid}" status="ok">` +
      `<updatecheck status="ok" codebase="${codebase}" version="${version}"${extra}/>` +
      "</app>"
    );
  }

  const answering =
    (status: number, body: Buffer | string) =>
    (url: string): FetchResult => ({
      status,
      body: Buffer.isBuffer(body) ? body : Buffer.from(body),
      url,
    });
  const missing = (what: string) => () => {
    throw new Error(`No ${what} was prepared.`);
  };
  let xml: (url: string) => FetchResult = missing("update answer");
  let crx: (url: string) => FetchResult = missing("download");
  const route: Fetcher = async (url, limits) => {
    asked.push({ url, limits });
    return url.includes("response=updatecheck") ? xml(url) : crx(url);
  };

  const live: ExtensionUpdates[] = [];
  beforeEach(() => {
    xml = missing("update answer");
    crx = missing("download");
  });
  afterEach(() => {
    for (const updates of live.splice(0)) updates.dispose();
  });

  // A store extension at 1.2.0, loaded in both sessions, and the updates it
  // waits for.
  async function withUpdates() {
    const base = await setUp(route);
    crx = answering(200, download);
    await base.installer.installFromStore(id);
    asked.length = 0;
    base.confirm.mockClear();
    const pages = { open: false };
    const updates = new ExtensionUpdates({
      host: base.host,
      installer: base.installer,
      fetcher: route,
      env,
      pagesOpen: (which) => pages.open && which === id,
      confirm: base.confirm,
    });
    live.push(updates);
    return { ...base, updates, pages };
  }

  it("update XML parsing", () => {
    expect(UPDATE_LIMITS).toEqual({
      timeoutMs: 30000,
      batch: 25,
      maxBytes: 1024 * 1024,
    });
    expect(updateCheckUrl([{ id, version: "1.2.0" }], env)).toBe(
      "https://clients2.google.com/service/update2/crx?response=updatecheck" +
        "&acceptformat=crx3&prodversion=152.0.7977.76&os=mac&arch=arm64" +
        `&x=id%3D${id}%26v%3D1.2.0%26uc`,
    );
    expect(
      updateCheckUrl(
        [
          { id, version: "1.2.0" },
          { id: second, version: "0.1" },
        ],
        env,
      ),
    ).toBe(
      `${updateCheckUrl([{ id, version: "1.2.0" }], env)}&x=id%3D${second}%26v%3D0.1%26uc`,
    );

    const hash = "AB".repeat(32);
    expect(
      parseUpdateXml(
        gupdate(
          `<app appid="${id}" status="ok"><updatecheck status="ok" ` +
            'codebase="https://downloads.example.com/a.crx?token=1&amp;v=&#x32;" ' +
            `version="1.3.0" prodversionmin="100.0" hash_sha256="${hash}"/></app>` +
            noUpdate(second) +
            `<app appid="${fakeId(3)}" status="error-unknownApplication"/>` +
            `<app appid="${fakeId(4)}" status="ok"><updatecheck status="error-internal"/></app>` +
            // A codebase that isn't https.
            `<app appid="${fakeId(5)}" status="ok"><updatecheck status="ok" ` +
            'codebase="http://downloads.example.com/a.crx" version="2.0"/></app>' +
            // A hash that isn't a SHA-256.
            `<app appid="${fakeId(6)}" status="ok"><updatecheck status="ok" ` +
            `codebase="${codebase}" version="2.0" hash_sha256="nope"/></app>` +
            // Not an extension id.
            '<app appid="chrome" status="ok"><updatecheck status="ok" ' +
            `codebase="${codebase}" version="2.0"/></app>`,
        ),
      ),
    ).toEqual([
      {
        id,
        status: "update",
        version: "1.3.0",
        codebase: "https://downloads.example.com/a.crx?token=1&v=2",
        hashSha256: hash.toLowerCase(),
      },
      { id: second, status: "noupdate" },
      { id: fakeId(3), status: "error" },
      { id: fakeId(4), status: "error" },
      { id: fakeId(5), status: "error" },
      { id: fakeId(6), status: "error" },
    ]);

    // Malformed answers give no build.
    expect(parseUpdateXml("")).toEqual([]);
    expect(parseUpdateXml("<html><body>Sorry</body></html>")).toEqual([]);
    expect(parseUpdateXml(`<gupdate><app appid="${id}" status="ok">`)).toEqual([
      { id, status: "error" },
    ]);
    expect(
      parseUpdateXml(
        `<gupdate><app appid="${id}" status="ok"><updatecheck status="ok" ` +
          `codebase="${codebase}" version=`,
      ),
    ).toEqual([{ id, status: "error" }]);
  });

  it("an update that raises permissions waits for review", async () => {
    const { userData, host, sessions, confirm, updates } = await withUpdates();
    updates.setEnabled(true);
    const changes: number[] = [];
    updates.onChange(() => changes.push(changes.length));
    xml = answering(200, gupdate(offer(id, "1.3.0")));
    crx = answering(200, crxFor(raising));

    await updates.check();

    expect(host.entry(id)?.version).toBe("1.2.0");
    expect(host.entry(id)?.staged).toEqual({
      version: "1.3.0",
      path: `Extensions/${id}/1.3.0`,
      review: true,
      permissions: grant.permissions,
      hosts: ["<all_urls>"],
    });
    expect(updates.state(id)).toEqual({ state: "review", version: "1.3.0" });
    expect(confirm).not.toHaveBeenCalled();
    expect(changes.length).toBeGreaterThan(0);
    for (const fake of sessions) expect(fake.loaded).toHaveLength(1);
    expect(stagingFiles(userData)).toEqual([]);
    expect(recorded(userData).extensions[0]?.staged?.review).toBe(true);

    // Refusing keeps it waiting.
    confirm.mockResolvedValueOnce(false);
    await expect(updates.review(id)).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledWith({
      name: "Marker",
      lines: permissionLines(raised),
      wontWork: ["Notifications"],
    });
    expect(host.entry(id)?.version).toBe("1.2.0");
    expect(updates.state(id)).toEqual({ state: "review", version: "1.3.0" });

    // Saying yes grants the new hosts and applies the build.
    await expect(updates.review(id)).resolves.toBe(true);
    const entry = host.entry(id);
    expect(entry?.version).toBe("1.3.0");
    expect(entry?.path).toBe(`Extensions/${id}/1.3.0`);
    expect(entry?.staged).toBeUndefined();
    expect(entry?.grantedHosts).toEqual(["<all_urls>"]);
    expect(entry?.grantedPermissions).toEqual(grant.permissions);
    expect(updates.state(id)).toBeUndefined();
    const folder = join(userData, "Extensions", id, "1.3.0");
    for (const fake of sessions) {
      expect(fake.removed).toEqual([id]);
      expect(fake.loaded.at(-1)).toEqual({ id, path: folder });
    }
    expect(existsSync(join(userData, "Extensions", id, "1.2.0"))).toBe(false);
    expect(recorded(userData).extensions[0]?.version).toBe("1.3.0");

    // Nothing waits any more.
    await expect(updates.review(id)).resolves.toBe(false);

    // With one of its pages open, the OK is recorded and the build waits.
    const held = await withUpdates();
    held.updates.setEnabled(true);
    xml = answering(200, gupdate(offer(id, "1.3.0")));
    crx = answering(200, crxFor(raising));
    await held.updates.check();
    held.pages.open = true;
    await expect(held.updates.review(id)).resolves.toBe(true);
    expect(held.host.entry(id)?.version).toBe("1.2.0");
    expect(held.host.entry(id)?.staged).toMatchObject({
      review: false,
      hosts: ["<all_urls>"],
    });
    expect(held.updates.state(id)).toEqual({
      state: "staged",
      version: "1.3.0",
    });
    expect(
      existsSync(
        join(held.userData, "Extensions", id, "1.3.0", "manifest.json"),
      ),
    ).toBe(true);
    for (const fake of held.sessions) expect(fake.loaded).toHaveLength(1);
  });

  it("a newer build must keep its ID, carry the advertised version and match hash_sha256", async () => {
    const { userData, host, sessions, updates } = await withUpdates();
    updates.setEnabled(true);
    const good = crxFor(newer);
    const cases: { answer: string; body: Buffer }[] = [
      // Signed by another developer key, so another id.
      {
        answer: offer(id, "1.3.0"),
        body: crxOf(extensionZip(newer, { "worker.js": "" }), [
          other,
          publisher,
        ]),
      },
      // Not the advertised version.
      {
        answer: offer(id, "1.3.0"),
        body: crxFor({ ...manifest, version: "1.4.0" }),
      },
      // Not the advertised hash.
      {
        answer: offer(id, "1.3.0", ` hash_sha256="${"00".repeat(32)}"`),
        body: good,
      },
    ];
    for (const one of cases) {
      xml = answering(200, gupdate(one.answer));
      crx = answering(200, one.body);
      await updates.check();
      expect(host.entry(id)?.version).toBe("1.2.0");
      expect(host.entry(id)?.staged).toBeUndefined();
      expect(stagingFiles(userData)).toEqual([]);
      expect(existsSync(join(userData, "Extensions", id, "1.3.0"))).toBe(false);
      expect(updates.state(id)).toEqual({
        state: "failed",
        version: "1.3.0",
        message: extensionInstallCopy.failedChecks,
      });
      for (const fake of sessions) expect(fake.loaded).toHaveLength(1);
    }

    // An older or equal build is left alone, and a failed download fails.
    xml = answering(200, gupdate(offer(id, "1.2.0")));
    crx = missing("download");
    await updates.check();
    expect(asked.filter((one) => one.url === codebase)).toHaveLength(3);
    xml = answering(200, gupdate(offer(id, "1.3.0")));
    crx = answering(500, Buffer.alloc(0));
    await updates.check();
    expect(updates.state(id)).toEqual({
      state: "failed",
      version: "1.3.0",
      message: extensionInstallCopy.downloadFailed,
    });

    // The advertised version and hash of a build signed by its own key apply.
    xml = answering(
      200,
      gupdate(
        offer(
          id,
          "1.3.0",
          ` hash_sha256="${createHash("sha256").update(good).digest("hex").toUpperCase()}"`,
        ),
      ),
    );
    crx = answering(200, good);
    await updates.check();
    expect(host.entry(id)?.version).toBe("1.3.0");
    expect(updates.state(id)).toBeUndefined();

    // A build Electron refuses puts the old one back.
    const broken = await withUpdates();
    broken.updates.setEnabled(true);
    xml = answering(200, gupdate(offer(id, "1.3.0")));
    crx = answering(200, good);
    broken.sessions[1].extensions.loadExtension.mockRejectedValueOnce(
      new Error("Electron could not load it."),
    );

    await broken.updates.check();

    expect(broken.host.entry(id)?.version).toBe("1.2.0");
    expect(broken.host.entry(id)?.staged).toBeUndefined();
    expect(existsSync(join(broken.userData, "Extensions", id, "1.3.0"))).toBe(
      false,
    );
    expect(recorded(broken.userData).extensions[0]).toMatchObject({
      version: "1.2.0",
      path: `Extensions/${id}/1.2.0`,
    });
    expect(broken.updates.state(id)).toMatchObject({
      state: "failed",
      version: "1.3.0",
    });
    for (const fake of broken.sessions)
      expect(fake.loaded.at(-1)).toEqual({
        id,
        path: join(broken.userData, "Extensions", id, "1.2.0"),
      });
  });

  it("applies at once when no pages are open and at the next launch otherwise", async () => {
    const applied = await withUpdates();
    applied.updates.setEnabled(true);
    xml = answering(200, gupdate(offer(id, "1.3.0")));
    crx = answering(200, crxFor(newer));

    await applied.updates.check();

    expect(asked.map((one) => one.url)).toEqual([
      updateCheckUrl([{ id, version: "1.2.0" }], env),
      codebase,
    ]);
    expect(asked.map((one) => one.limits)).toEqual([
      checkLimits,
      DOWNLOAD_LIMITS,
    ]);
    const folder = join(applied.userData, "Extensions", id, "1.3.0");
    for (const fake of applied.sessions) {
      expect(fake.removed).toEqual([id]);
      expect(fake.loaded).toEqual([
        { id, path: join(applied.userData, "Extensions", id, "1.2.0") },
        { id, path: folder },
      ]);
    }
    expect(existsSync(join(applied.userData, "Extensions", id, "1.2.0"))).toBe(
      false,
    );
    expect(recorded(applied.userData).extensions[0]).toMatchObject({
      version: "1.3.0",
      path: `Extensions/${id}/1.3.0`,
      grantedPermissions: grant.permissions,
      grantedHosts: grant.hosts,
    });
    expect(applied.updates.state(id)).toBeUndefined();
    expect(stagingFiles(applied.userData)).toEqual([]);

    // With one of its pages open the build waits for the next launch.
    const waiting = await withUpdates();
    waiting.updates.setEnabled(true);
    waiting.pages.open = true;
    xml = answering(200, gupdate(offer(id, "1.3.0")));
    crx = answering(200, crxFor(newer));

    await waiting.updates.check();

    expect(waiting.host.entry(id)?.version).toBe("1.2.0");
    expect(waiting.host.entry(id)?.staged).toEqual({
      version: "1.3.0",
      path: `Extensions/${id}/1.3.0`,
      review: false,
      permissions: grant.permissions,
      hosts: grant.hosts,
    });
    expect(waiting.updates.state(id)).toEqual({
      state: "staged",
      version: "1.3.0",
    });
    for (const fake of waiting.sessions) expect(fake.loaded).toHaveLength(1);
    expect(existsSync(join(waiting.userData, "Extensions", id, "1.2.0"))).toBe(
      true,
    );
    expect(waiting.confirm).not.toHaveBeenCalled();

    // The next launch applies it before anything loads.
    const next = new ExtensionHost({
      userData: waiting.userData,
      locale: "en-US",
      chromeVersion: CHROME,
    });
    await next.init();
    expect(next.entry(id)?.version).toBe("1.3.0");
    expect(next.entry(id)?.staged).toBeUndefined();
    expect(existsSync(join(waiting.userData, "Extensions", id, "1.2.0"))).toBe(
      false,
    );
    const fresh = new FakeSession();
    await next.attach("persist:one", asSession(fresh));
    expect(fresh.loaded).toEqual([
      { id, path: join(waiting.userData, "Extensions", id, "1.3.0") },
    ]);
  });

  it("sends nothing while no store extensions are installed or updates are off, and asks about 25 at a time", async () => {
    const base = await setUp(route);
    const updates = new ExtensionUpdates({
      host: base.host,
      installer: base.installer,
      fetcher: route,
      env,
      pagesOpen: () => false,
      confirm: base.confirm,
    });
    live.push(updates);

    // Off, nothing is sent.
    await updates.check();
    expect(asked).toEqual([]);

    // On, but nothing from the store is installed.
    updates.setEnabled(true);
    await updates.check();
    expect(asked).toEqual([]);

    // An unpacked extension is never sent.
    const unpacked: ExtensionEntry = {
      ...storeEntry(fakeId(1)),
      source: "unpacked",
      path: "/tmp/kamapathy-unpacked",
    };
    await base.host.save(unpacked, checkedManifest("Unpacked"));
    await updates.check();
    expect(asked).toEqual([]);

    // 60 store extensions take 3 requests, in entry order.
    const many = Array.from({ length: 60 }, (_, at) => fakeId(at + 10));
    for (const one of many)
      await base.host.save(storeEntry(one), checkedManifest("Marker"));
    xml = (url) =>
      answering(
        200,
        gupdate(
          many
            .filter((one) => url.includes(one))
            .map(noUpdate)
            .join(""),
        ),
      )(url);

    await updates.check();

    expect(asked.map((one) => one.url.split("&x=").length - 1)).toEqual([
      25, 25, 10,
    ]);
    expect(asked[0].url).toBe(
      updateCheckUrl(
        many.slice(0, 25).map((one) => ({ id: one, version: "1.0.0" })),
        env,
      ),
    );
    expect(asked.map((one) => one.limits)).toEqual([
      checkLimits,
      checkLimits,
      checkLimits,
    ]);
    expect(asked.some((one) => one.url.includes(unpacked.id))).toBe(false);

    // Off again, and nothing is sent.
    asked.length = 0;
    updates.setEnabled(false);
    await updates.check();
    expect(asked).toEqual([]);

    // Turning it off clears the timer.
    const handles: unknown[] = [];
    const set = vi.fn((_callback: () => void, _ms: number) => {
      handles.push(handles.length + 1);
      return handles.length;
    });
    const clear = vi.fn();
    const timed = new ExtensionUpdates({
      host: base.host,
      installer: base.installer,
      fetcher: route,
      env,
      pagesOpen: () => false,
      confirm: base.confirm,
      timers: { set, clear },
    });
    live.push(timed);
    timed.setEnabled(true);
    expect(set).toHaveBeenCalledWith(expect.any(Function), FIRST_CHECK_MS);
    timed.setEnabled(false);
    expect(clear).toHaveBeenCalledWith(1);
  });

  it("checks 5 minutes after launch and every 24 hours", async () => {
    expect(FIRST_CHECK_MS).toBe(300_000);
    expect(CHECK_EVERY_MS).toBe(24 * 60 * 60 * 1000);
    const { updates } = await withUpdates();
    xml = answering(200, gupdate(noUpdate(id)));

    vi.useFakeTimers();
    updates.setEnabled(true);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(asked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(asked).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(asked).toHaveLength(2);

    // Off, nothing is checked.
    updates.setEnabled(false);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(asked).toHaveLength(2);

    // On again, with the next check long overdue.
    updates.setEnabled(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(3);
    expect(asked.at(-1)?.url).toBe(
      updateCheckUrl([{ id, version: "1.2.0" }], env),
    );
  });
});
