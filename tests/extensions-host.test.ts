import { EventEmitter } from "node:events";
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
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserWindow,
  IpcMain,
  IpcMainInvokeEvent,
  Session,
  WebContents,
} from "electron";
import {
  PDF_VIEWER_EXTENSION_ID,
  restoreExtensions,
  type ExtensionAnchor,
  type ExtensionEntry,
  type ExtensionsView,
} from "../shared/extensions";
import { initialState } from "../shared/state";
import { BrowserController, SHARED_PARTITION } from "../electron/controller";
import type { CheckedManifest } from "../electron/extensions/manifest";
import { ExtensionHost, type HostEvent } from "../electron/extensions/host";
import type { ConsentDetails } from "../electron/extensions/dialogs";
import { ExtensionInstaller } from "../electron/extensions/install";
import type { ExtensionBridge } from "../electron/extensions/bridge";
import { ExtensionUpdates } from "../electron/extensions/updates";
import { extensionsView } from "../electron/extensions/view";
import {
  EXTENSION_COMMAND,
  EXTENSIONS_CHANGED,
  EXTENSIONS_CHANNEL,
  parseExtensionCommand,
  registerExtensionIpc,
} from "../electron/extensions/ipc";
import { idOf, keyPair } from "./extension-builders";
import {
  EXTENSION_CALL,
  EXTENSION_EVENT,
  EXTENSION_LISTEN,
  EXTENSION_READY,
  PAGE_PRELOAD_ID,
  WORKER_PRELOAD_ID,
} from "../electron/extensions/chrome-api";
import {
  ExtensionChannel,
  type Caller,
  type ChannelDeps,
} from "../electron/extensions/channel";
import {
  extensionBridgeCopy,
  extensionInstallCopy,
  extensionRefusalCopy,
  extensionRemoveCopy,
} from "../src/copy";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  WebContentsView: vi.fn(),
  nativeTheme: { themeSource: "system" },
  session: {
    fromPartition: vi.fn((partition: string) => sessionOf(partition)),
  },
  dialog: {},
  shell: {},
  nativeImage: { createFromPath: (path: string) => fakeImage(path) },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));
vi.mock("../electron/persistence", async (original) => ({
  ...(await original<typeof import("../electron/persistence")>()),
  writeState: vi.fn(),
}));

// Icon files are named after their size, so a mocked image can report it.
function fakeImage(path: string) {
  const side = Number(/icon-(\d+)\.png$/.exec(path)?.[1] ?? 0);
  return {
    isEmpty: () => !existsSync(path),
    getSize: () => ({ width: side, height: side }),
    toDataURL: () => `data:image/png;base64,${basename(path)}`,
  };
}

// A distinct valid id per number: its hex digits as the letters a to p.
function idAt(index: number): string {
  return Array.from(index.toString(16).padStart(32, "0"), (digit) =>
    String.fromCharCode(97 + parseInt(digit, 16)),
  ).join("");
}
const [A, B, C, D, E] = [1, 2, 3, 4, 5].map(idAt);
const CHROME = "152.0.7977.76";

// Folders and the ids Electron gives them.
const folderIds = new Map<string, string>();
function extensionObject(id: string, path: string) {
  return {
    id,
    path,
    name: id,
    version: "1.0.0",
    url: `chrome-extension://${id}/`,
    manifest: {},
  };
}
// A service worker of a session: what the channel wires and talks to.
class FakeWorkerIpc {
  handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  handle = vi.fn(
    (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      this.handlers.set(channel, listener);
    },
  );
  on = vi.fn(
    (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => void,
    ) => {
      this.listeners.set(channel, listener);
      return this;
    },
  );
}
class FakeWorker {
  ipc = new FakeWorkerIpc();
  send = vi.fn();
  destroyed = false;
  constructor(
    readonly scope: string,
    readonly versionId: number,
  ) {}
  isDestroyed() {
    return this.destroyed;
  }
  call(payload: unknown): unknown {
    return this.ipc.handlers.get(EXTENSION_CALL)?.({}, payload);
  }
  listen(names: string[]): void {
    this.ipc.listeners.get(EXTENSION_LISTEN)?.({}, names);
  }
  ready(): void {
    this.ipc.listeners.get(EXTENSION_READY)?.({});
  }
}
class FakeWorkers extends EventEmitter {
  running = new Map<number, FakeWorker>();
  getAllRunning = vi.fn(() =>
    Object.fromEntries([...this.running.keys()].map((id) => [id, {}])),
  );
  getWorkerFromVersionID = vi.fn((versionId: number) =>
    this.running.get(versionId),
  );
  startWorkerForScope = vi.fn(async (_scope: string) => undefined);
  start(worker: FakeWorker): void {
    this.running.set(worker.versionId, worker);
    this.emit("running-status-changed", {
      versionId: worker.versionId,
      runningStatus: "starting",
    });
  }
  stop(worker: FakeWorker): void {
    this.running.delete(worker.versionId);
    this.emit("running-status-changed", {
      versionId: worker.versionId,
      runningStatus: "stopped",
    });
  }
}
class FakeSession extends EventEmitter {
  // What Electron has loaded, by id. Kamapathy's own PDF viewer is there
  // from the start.
  loaded = new Map<string, string>([[PDF_VIEWER_EXTENSION_ID, "pdf"]]);
  extensions = {
    loadExtension: vi.fn(
      async (path: string, _options?: { allowFileAccess: boolean }) => {
        const id = folderIds.get(path) ?? "";
        this.loaded.set(id, path);
        return extensionObject(id, path);
      },
    ),
    removeExtension: vi.fn((id: string) => {
      this.loaded.delete(id);
    }),
    getAllExtensions: vi.fn(() =>
      [...this.loaded].map(([id, path]) => extensionObject(id, path)),
    ),
  };
  registerPreloadScript = vi.fn(
    (_script: Electron.PreloadScriptRegistration) => "preload",
  );
  unregisterPreloadScript = vi.fn((_id: string) => {});
  serviceWorkers = new FakeWorkers();
  clearStorageData = vi.fn(async () => {});
  clearCache = vi.fn(async () => {});
  setPermissionCheckHandler = vi.fn();
  setPermissionRequestHandler = vi.fn();
  webRequest = {
    onBeforeRequest: vi.fn(),
    onBeforeSendHeaders: vi.fn(),
    onSendHeaders: vi.fn(),
    onHeadersReceived: vi.fn(),
    onResponseStarted: vi.fn(),
    onBeforeRedirect: vi.fn(),
    onCompleted: vi.fn(),
    onErrorOccurred: vi.fn(),
  };
}
const fakeSessions = new Map<string, FakeSession>();
function sessionOf(partition: string): FakeSession {
  if (!fakeSessions.has(partition))
    fakeSessions.set(partition, new FakeSession());
  return fakeSessions.get(partition)!;
}
const asSession = (fake: FakeSession) => fake as unknown as Session;

const roots: string[] = [];
function temporary(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  roots.push(folder);
  return folder;
}
function manifestFile(name: string, version: string) {
  return { manifest_version: 3, name, version };
}
function writeFolder(folder: string, manifest: Record<string, unknown>) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));
}
function checked(name: string, version = "1.0.0"): CheckedManifest {
  return {
    manifest: manifestFile(name, version),
    name,
    version,
    permissions: [],
    hosts: [],
    lines: [],
    wontWork: [],
    icons: {},
    actionIcons: {},
  };
}
function storeEntry(
  id: string,
  version = "1.0.0",
  extra: Partial<ExtensionEntry> = {},
): ExtensionEntry {
  return {
    id,
    source: "webstore",
    version,
    path: `Extensions/${id}/${version}`,
    enabled: true,
    pinned: false,
    installedAt: 1,
    grantedPermissions: [],
    grantedHosts: [],
    ...extra,
  };
}
function unpackedEntry(
  id: string,
  path: string,
  extra: Partial<ExtensionEntry> = {},
): ExtensionEntry {
  return { ...storeEntry(id), source: "unpacked", path, ...extra };
}
// A userData folder whose extensions.json lists these entries, each with a
// folder holding its manifest.
function profile(
  entries: ExtensionEntry[],
  removals: string[] = [],
  manifests: Record<string, Record<string, unknown>> = {},
): string {
  const userData = temporary("kamapathy-host-");
  for (const entry of entries) {
    const folder =
      entry.source === "webstore" ? join(userData, entry.path) : entry.path;
    writeFolder(
      folder,
      manifests[entry.id] ??
        manifestFile(`Extension ${entry.id}`, entry.version),
    );
    folderIds.set(folder, entry.id);
  }
  writeFileSync(
    join(userData, "extensions.json"),
    JSON.stringify({ extensions: entries, removals }),
  );
  return userData;
}
async function hostFor(userData: string): Promise<ExtensionHost> {
  const host = new ExtensionHost({
    userData,
    locale: "en-US",
    chromeVersion: CHROME,
  });
  await host.init();
  return host;
}
function recorded(host: ExtensionHost): HostEvent[] {
  const events: HostEvent[] = [];
  host.onEvent((event) => events.push(event));
  return events;
}

beforeEach(() => {
  fakeSessions.clear();
  folderIds.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("extension host", () => {
  it("writes extensions.json through a temporary file with mode 0600", async () => {
    const userData = temporary("kamapathy-host-");
    const file = join(userData, "extensions.json");
    const host = await hostFor(userData);
    expect(host.entries()).toEqual([]);
    expect(existsSync(file)).toBe(false);
    const events = recorded(host);
    const first = storeEntry(A);
    const second = unpackedEntry(B, temporary("kamapathy-unpacked-"), {
      pinned: true,
    });
    // Concurrent writes never interleave.
    await Promise.all([
      host.save(first, checked("First")),
      host.save(second, checked("Second")),
      host.queueRemoval(C),
      host.queueRemoval(C),
      host.queueRemoval("not an id"),
      host.queueRemoval(PDF_VIEWER_EXTENSION_ID),
    ]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain('\n  "extensions": [');
    expect(restoreExtensions(JSON.parse(text))).toEqual({
      extensions: [first, second],
      removals: [C],
    });
    expect(existsSync(`${file}.tmp`)).toBe(false);
    if (process.platform !== "win32")
      expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(host.entry(A)).toEqual(first);
    expect(host.manifestOf(A)?.name).toBe("First");
    expect(host.nameOf(B)).toBe("Second");
    expect(host.nameOf(C)).toBeUndefined();

    await host.save({ ...first, enabled: false }, checked("First"));
    await host.forget(B);
    expect(restoreExtensions(JSON.parse(readFileSync(file, "utf8")))).toEqual({
      extensions: [{ ...first, enabled: false }],
      removals: [C],
    });
    expect(host.entry(B)).toBeUndefined();
    expect(host.manifestOf(B)).toBeUndefined();
    expect(events).toEqual(Array(5).fill({ type: "changed" }));

    // An unreadable file reads as empty, and the next save replaces it.
    writeFileSync(file, "{not json");
    const fresh = await hostFor(userData);
    expect(fresh.entries()).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("{not json");
    await fresh.save(first, checked("First"));
    expect(
      restoreExtensions(JSON.parse(readFileSync(file, "utf8"))).extensions,
    ).toEqual([first]);
  });

  it("loads enabled store extensions into every persistent session and never into other partitions", async () => {
    const userData = profile(
      [
        storeEntry(A),
        storeEntry(B, "2.0"),
        storeEntry(C, "1.0.0", { enabled: false }),
        storeEntry(D),
      ],
      [],
      { [D]: { manifest_version: 2, name: "Old", version: "1.0.0" } },
    );
    const host = await hostFor(userData);
    expect(host.loadError(D)).toBe(extensionRefusalCopy.version);
    expect(host.manifestOf(D)).toBeUndefined();
    expect(host.manifestOf(B)?.version).toBe("2.0");
    const events = recorded(host);
    const personal = sessionOf("persist:space-personal");
    const separate = sessionOf("persist:space-x");
    await host.attach("persist:space-personal", asSession(personal));
    await host.attach("persist:space-x", asSession(separate));
    for (const fake of [personal, separate])
      expect(fake.extensions.loadExtension.mock.calls).toEqual([
        [join(userData, "Extensions", A, "1.0.0"), { allowFileAccess: false }],
        [join(userData, "Extensions", B, "2.0"), { allowFileAccess: false }],
      ]);
    // Attaching again changes nothing.
    await host.attach("persist:space-personal", asSession(personal));
    expect(personal.extensions.loadExtension).toHaveBeenCalledTimes(2);

    for (const partition of ["agent-run-1-x", "kamapathy-extension-store"]) {
      const other = sessionOf(partition);
      await host.attach(partition, asSession(other));
      expect(other.extensions.loadExtension).not.toHaveBeenCalled();
      expect(host.sessionOf(partition)).toBeUndefined();
      expect(host.partitionOf(asSession(other))).toBeUndefined();
      expect(host.loadedIds(partition).size).toBe(0);
    }
    expect(host.partitions()).toEqual([
      "persist:space-personal",
      "persist:space-x",
    ]);
    expect([...host.loadedIds("persist:space-x")]).toEqual([A, B]);
    expect(host.isLoaded("persist:space-personal", B)).toBe(true);
    expect(host.isLoaded("persist:space-personal", C)).toBe(false);
    expect(host.isLoaded("persist:space-personal", D)).toBe(false);
    expect(host.sessionOf("persist:space-x")).toBe(separate);
    expect(host.partitionOf(asSession(separate))).toBe("persist:space-x");
    expect(events).toEqual([
      { type: "loaded", id: A, partition: "persist:space-personal" },
      { type: "loaded", id: B, partition: "persist:space-personal" },
      { type: "attached", partition: "persist:space-personal" },
      { type: "loaded", id: A, partition: "persist:space-x" },
      { type: "loaded", id: B, partition: "persist:space-x" },
      { type: "attached", partition: "persist:space-x" },
    ]);
  });

  it("loads unpacked extensions only in Developer mode", async () => {
    const folder = temporary("kamapathy-unpacked-");
    const off = temporary("kamapathy-unpacked-");
    const host = await hostFor(
      profile([
        storeEntry(A),
        unpackedEntry(B, folder),
        unpackedEntry(C, off, { enabled: false }),
      ]),
    );
    const personal = sessionOf("persist:space-personal");
    const separate = sessionOf("persist:space-x");
    await host.attach("persist:space-personal", asSession(personal));
    await host.attach("persist:space-x", asSession(separate));
    expect(host.developerMode).toBe(false);
    expect([...host.loadedIds("persist:space-personal")]).toEqual([A]);

    await host.setDeveloperMode(true);
    expect(host.developerMode).toBe(true);
    for (const fake of [personal, separate])
      expect(fake.extensions.loadExtension).toHaveBeenLastCalledWith(folder, {
        allowFileAccess: false,
      });
    expect([...host.loadedIds("persist:space-x")]).toEqual([A, B]);
    const later = sessionOf("persist:space-y");
    await host.attach("persist:space-y", asSession(later));
    expect([...host.loadedIds("persist:space-y")]).toEqual([A, B]);
    for (const fake of [personal, separate, later])
      expect(fake.extensions.loadExtension).not.toHaveBeenCalledWith(
        off,
        expect.anything(),
      );

    await host.setDeveloperMode(false);
    expect(host.developerMode).toBe(false);
    for (const fake of [personal, separate, later]) {
      expect(fake.extensions.removeExtension.mock.calls).toEqual([[B]]);
      expect(fake.loaded.has(A)).toBe(true);
    }
    expect([...host.loadedIds("persist:space-y")]).toEqual([A]);
  });

  it("applies queued removals and staged builds before loading", async () => {
    const applied = storeEntry(A, "1.0.0", {
      staged: {
        version: "1.1.0",
        path: `Extensions/${A}/1.1.0`,
        review: false,
        permissions: ["tabs"],
        hosts: ["https://example.com/*"],
      },
    });
    const review = storeEntry(B, "1.0.0", {
      staged: {
        version: "2.0.0",
        path: `Extensions/${B}/2.0.0`,
        review: true,
        permissions: ["tabs"],
        hosts: [],
      },
    });
    // Its staged folder is gone.
    const missing = storeEntry(C, "1.0.0", {
      staged: {
        version: "1.2.0",
        path: `Extensions/${C}/1.2.0`,
        review: false,
        permissions: [],
        hosts: [],
      },
    });
    const userData = profile([applied, review, missing], [D, E]);
    const next = join(userData, "Extensions", A, "1.1.0");
    writeFolder(next, manifestFile("Applied", "1.1.0"));
    folderIds.set(next, A);
    writeFolder(
      join(userData, "Extensions", B, "2.0.0"),
      manifestFile("Review", "2.0.0"),
    );
    const settings = (partition: string, kind: string, id: string) =>
      join(userData, "Partitions", partition, `${kind} Extension Settings`, id);
    const removed = [
      settings("space-personal", "Local", D),
      settings("space-personal", "Sync", D),
      settings("space-x", "Local", E),
      settings("space-x", "Sync", D),
    ];
    const kept = settings("space-x", "Local", A);
    for (const folder of [...removed, kept]) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "000003.log"), "data");
    }
    mkdirSync(join(userData, "Extensions", ".staging", "download"), {
      recursive: true,
    });

    const host = await hostFor(userData);
    for (const folder of removed) expect(existsSync(folder)).toBe(false);
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(join(userData, "Extensions", ".staging"))).toBe(false);
    expect(existsSync(join(userData, "Extensions", A, "1.0.0"))).toBe(false);
    expect(host.entry(A)).toEqual({
      ...storeEntry(A, "1.1.0"),
      grantedPermissions: ["tabs"],
      grantedHosts: ["https://example.com/*"],
    });
    expect(host.manifestOf(A)?.name).toBe("Applied");
    expect(host.entry(B)).toEqual(review);
    expect(existsSync(join(userData, "Extensions", B, "1.0.0"))).toBe(true);
    expect(host.entry(C)).toEqual(storeEntry(C));
    expect(
      restoreExtensions(
        JSON.parse(readFileSync(join(userData, "extensions.json"), "utf8")),
      ),
    ).toEqual({
      extensions: [host.entry(A), host.entry(B), host.entry(C)],
      removals: [],
    });

    const personal = sessionOf("persist:space-personal");
    await host.attach("persist:space-personal", asSession(personal));
    expect(personal.extensions.loadExtension.mock.calls[0]).toEqual([
      next,
      { allowFileAccess: false },
    ]);
    expect([...host.loadedIds("persist:space-personal")]).toEqual([A, B, C]);
  });

  it("detach removes only extensions from extensions.json", async () => {
    const host = await hostFor(profile([storeEntry(A), storeEntry(B)]));
    const personal = sessionOf("persist:space-personal");
    const cleanup = vi.fn();
    const hook = vi.fn(() => cleanup);
    host.onSessionSetup(hook);
    await host.attach("persist:space-personal", asSession(personal));
    expect(hook).toHaveBeenCalledExactlyOnceWith(
      "persist:space-personal",
      personal,
    );
    // Hooks run before anything loads.
    expect(hook.mock.invocationCallOrder[0]).toBeLessThan(
      personal.extensions.loadExtension.mock.invocationCallOrder[0],
    );
    // A hook added later runs for attached sessions at once.
    const late = vi.fn();
    host.onSessionSetup(late);
    expect(late).toHaveBeenCalledExactlyOnceWith(
      "persist:space-personal",
      personal,
    );
    host.unloadEverywhere(PDF_VIEWER_EXTENSION_ID);
    expect(personal.extensions.removeExtension).not.toHaveBeenCalled();

    const events = recorded(host);
    host.detach("persist:space-personal");
    expect(personal.extensions.removeExtension.mock.calls).toEqual([[A], [B]]);
    expect(personal.loaded.has(PDF_VIEWER_EXTENSION_ID)).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(host.partitions()).toEqual([]);
    expect(host.sessionOf("persist:space-personal")).toBeUndefined();
    expect(host.loadedIds("persist:space-personal").size).toBe(0);
    expect(events).toEqual([
      { type: "unloaded", id: A, partition: "persist:space-personal" },
      { type: "unloaded", id: B, partition: "persist:space-personal" },
      { type: "detached", partition: "persist:space-personal" },
    ]);
    host.detach("persist:space-personal");
    expect(personal.extensions.removeExtension).toHaveBeenCalledTimes(2);

    // Attaching again sets the session up and loads again.
    await host.attach("persist:space-personal", asSession(personal));
    expect(hook).toHaveBeenCalledTimes(2);
    expect(late).toHaveBeenCalledTimes(2);
    expect([...host.loadedIds("persist:space-personal")]).toEqual([A, B]);
  });

  it("undoes a load that finishes after its session detaches or the extension unloads", async () => {
    const host = await hostFor(profile([storeEntry(A)]));
    const personal = sessionOf("persist:space-personal");
    const finishes: (() => void)[] = [];
    personal.extensions.loadExtension.mockImplementation(
      (path: string) =>
        new Promise((resolve) => {
          finishes.push(() => {
            personal.loaded.set(A, path);
            resolve(extensionObject(A, path));
          });
        }),
    );
    const attaching = host.attach(
      "persist:space-personal",
      asSession(personal),
    );
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    host.detach("persist:space-personal");
    finishes[0]();
    await attaching;
    expect(personal.extensions.removeExtension.mock.calls).toEqual([[A]]);
    expect(personal.loaded.has(A)).toBe(false);

    const again = host.attach("persist:space-personal", asSession(personal));
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    host.unloadEverywhere(A);
    finishes[1]();
    await again;
    expect(personal.extensions.removeExtension.mock.calls).toEqual([[A], [A]]);
    expect(host.isLoaded("persist:space-personal", A)).toBe(false);
  });

  it("a failed load anywhere unloads the extension everywhere and reports Electron's message cut to 300 characters", async () => {
    const userData = profile([storeEntry(A)]);
    const host = await hostFor(userData);
    const partitions = [
      "persist:space-personal",
      "persist:space-x",
      "persist:space-y",
    ];
    for (const partition of partitions)
      await host.attach(partition, asSession(sessionOf(partition)));
    const added = storeEntry(B);
    writeFolder(join(userData, added.path), manifestFile("Added", "1.0.0"));
    folderIds.set(join(userData, added.path), B);
    await host.save(added, checked("Added"));
    const long = `Failed ${"x".repeat(400)}`;
    sessionOf("persist:space-y").extensions.loadExtension.mockRejectedValueOnce(
      new Error(long),
    );
    const events = recorded(host);
    await expect(host.loadEverywhere(B)).rejects.toThrow(
      new Error(long.slice(0, 300)),
    );
    for (const partition of partitions) {
      expect(host.isLoaded(partition, B)).toBe(false);
      expect(sessionOf(partition).loaded.has(B)).toBe(false);
      expect(host.isLoaded(partition, A)).toBe(true);
    }
    expect(
      sessionOf("persist:space-x").extensions.removeExtension,
    ).toHaveBeenCalledExactlyOnceWith(B);
    expect(events.filter((event) => event.type === "unloaded")).toEqual([
      { type: "unloaded", id: B, partition: "persist:space-personal" },
      { type: "unloaded", id: B, partition: "persist:space-x" },
    ]);
    expect(host.loadError(B)).toBeUndefined();

    await host.loadEverywhere(B);
    for (const partition of partitions)
      expect(host.isLoaded(partition, B)).toBe(true);
    // Loading again does nothing.
    await host.loadEverywhere(B);
    expect(
      sessionOf("persist:space-x").extensions.loadExtension,
    ).toHaveBeenCalledTimes(3);

    // A failed load while attaching marks the entry and doesn't stop the others.
    const later = sessionOf("persist:space-z");
    later.extensions.loadExtension.mockRejectedValueOnce(new Error(long));
    await host.attach("persist:space-z", asSession(later));
    expect(host.loadError(A)).toBe(
      `${extensionRefusalCopy.loadFailed} ${long.slice(0, 300)}`,
    );
    expect([...host.loadedIds("persist:space-z")]).toEqual([B]);
    expect(events.slice(-3)).toEqual([
      { type: "changed" },
      { type: "loaded", id: B, partition: "persist:space-z" },
      { type: "attached", partition: "persist:space-z" },
    ]);
  });

  it("a loaded store extension keeps its store id", async () => {
    // Verify first 5 held: Electron gives a folder whose manifest has the
    // developer key the store id, so another id is a failed load.
    const userData = profile([storeEntry(A), storeEntry(B), storeEntry(C)]);
    folderIds.set(join(userData, "Extensions", B, "1.0.0"), D);
    folderIds.set(
      join(userData, "Extensions", C, "1.0.0"),
      PDF_VIEWER_EXTENSION_ID,
    );
    const host = await hostFor(userData);
    const personal = sessionOf("persist:space-personal");
    await host.attach("persist:space-personal", asSession(personal));
    expect([...host.loadedIds("persist:space-personal")]).toEqual([A]);
    expect(host.loadError(A)).toBeUndefined();
    expect(host.loadError(B)).toBe(extensionRefusalCopy.loadFailed);
    expect(host.loadError(C)).toBe(extensionRefusalCopy.loadFailed);
    expect(personal.extensions.removeExtension.mock.calls).toEqual([[D]]);
    expect(personal.loaded.has(PDF_VIEWER_EXTENSION_ID)).toBe(true);
    await expect(host.loadEverywhere(B)).rejects.toThrow(
      new Error(extensionRefusalCopy.loadFailed),
    );
  });

  it("attachAll waits at most its timeout", async () => {
    const host = await hostFor(profile([storeEntry(A)]));
    vi.useFakeTimers();
    const personal = sessionOf("persist:space-personal");
    let finish!: () => void;
    personal.extensions.loadExtension.mockImplementationOnce(
      (path: string) =>
        new Promise((resolve) => {
          finish = () => {
            personal.loaded.set(A, path);
            resolve(extensionObject(A, path));
          };
        }),
    );
    const sessionFor = vi.fn((partition: string) =>
      asSession(sessionOf(partition)),
    );
    let done = false;
    const waiting = host
      .attachAll(
        ["persist:space-personal", "persist:space-x"],
        5000,
        sessionFor,
      )
      .then(() => {
        done = true;
      });
    expect(sessionFor.mock.calls).toEqual([
      ["persist:space-personal"],
      ["persist:space-x"],
    ]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(done).toBe(false);
    expect(host.isLoaded("persist:space-x", A)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(done).toBe(true);
    // The slow load keeps going.
    expect(host.isLoaded("persist:space-personal", A)).toBe(false);
    finish();
    await vi.waitFor(() =>
      expect(host.isLoaded("persist:space-personal", A)).toBe(true),
    );
    // Loads that settle first end the wait at once.
    await host.attachAll(["persist:space-y"], 5000, sessionFor);
    expect(host.isLoaded("persist:space-y", A)).toBe(true);
  });

  it("adds no webRequest listeners to extension sessions", async () => {
    // Verify first 6: the decision doesn't depend on the probe, since no
    // section adds listeners either way.
    const folder = temporary("kamapathy-unpacked-");
    const userData = profile([storeEntry(A), unpackedEntry(B, folder)]);
    const host = await hostFor(userData);
    await host.setDeveloperMode(true);
    await host.attachAll(
      ["persist:space-personal", "persist:space-x"],
      5000,
      (partition) => asSession(sessionOf(partition)),
    );
    const added = storeEntry(C);
    writeFolder(join(userData, added.path), manifestFile("Added", "1.0.0"));
    folderIds.set(join(userData, added.path), C);
    await host.save(added, checked("Added"));
    await host.loadEverywhere(C);
    host.unloadEverywhere(A);
    await host.setDeveloperMode(false);
    host.detach("persist:space-x");

    const window = Object.assign(new EventEmitter(), {
      webContents: Object.assign(new EventEmitter(), { send: vi.fn() }),
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      isDestroyed: () => false,
      getContentSize: () => [1400, 900],
    });
    const browser = new BrowserController(
      window as unknown as BrowserWindow,
      initialState(),
      join(userData, "browser-state.json"),
      {},
      host,
    );
    const sessionFor = (
      browser as unknown as { sessionFor(partition: string): Session }
    ).sessionFor.bind(browser);
    expect(sessionFor("persist:space-personal")).toBe(
      sessionOf("persist:space-personal"),
    );
    sessionFor("persist:space-y");
    await vi.waitFor(() =>
      expect(host.isLoaded("persist:space-y", C)).toBe(true),
    );
    browser.dispose();
    expect(fakeSessions.size).toBe(3);
    for (const fake of fakeSessions.values())
      for (const method of Object.values(fake.webRequest))
        expect(method).not.toHaveBeenCalled();
  });
});

describe("extension pages", () => {
  it("permissionFor answers only for pages of extensions loaded in that session", async () => {
    const host = await hostFor(
      profile(
        [
          storeEntry(A),
          storeEntry(B),
          storeEntry(C, "1.0.0", { enabled: false }),
        ],
        [],
        {
          [A]: {
            ...manifestFile("Clipper", "1.0.0"),
            permissions: [
              "clipboardRead",
              "clipboardWrite",
              "geolocation",
              "notifications",
              "tabs",
            ],
          },
          [C]: {
            ...manifestFile("Off", "1.0.0"),
            permissions: ["geolocation"],
          },
        },
      ),
    );
    const personal = "persist:space-personal";
    await host.attach(personal, asSession(sessionOf(personal)));
    // Web pages and Kamapathy's own PDF viewer aren't the host's to answer.
    for (const url of [
      "https://example.com/",
      "",
      "kamapathy://newtab",
      `chrome-extension://${PDF_VIEWER_EXTENSION_ID}/index.html`,
      "chrome-extension://bad/",
    ])
      expect(host.permissionFor(personal, url, "geolocation"), url).toBe(
        undefined,
      );
    // Pages, frames and the origin of a loaded extension get what its
    // manifest declares, and nothing else.
    for (const url of [
      `chrome-extension://${A}/popup.html`,
      `chrome-extension://${A}/`,
      `chrome-extension://${A}`,
    ]) {
      for (const permission of [
        "clipboard-read",
        "clipboard-sanitized-write",
        "geolocation",
      ])
        expect(host.permissionFor(personal, url, permission)).toBe(true);
      for (const permission of [
        "notifications",
        "media",
        "fullscreen",
        "openExternal",
        "clipboard-write",
        "midi",
      ])
        expect(host.permissionFor(personal, url, permission)).toBe(false);
    }
    expect(
      host.permissionFor(
        personal,
        `chrome-extension://${B}/popup.html`,
        "geolocation",
      ),
    ).toBe(false);
    // An extension not loaded in that session gets nothing.
    for (const [partition, id] of [
      [personal, C],
      [personal, D],
      ["persist:space-x", A],
      ["agent-run-1-x", A],
    ])
      expect(
        host.permissionFor(
          partition,
          `chrome-extension://${id}/x.html`,
          "geolocation",
        ),
      ).toBe(false);
    host.unloadEverywhere(A);
    expect(
      host.permissionFor(
        personal,
        `chrome-extension://${A}/x.html`,
        "geolocation",
      ),
    ).toBe(false);
  });

  it("forgets popups and extension windows when they close", () => {
    const host = new ExtensionHost({
      userData: temporary("kamapathy-host-"),
      locale: "en-US",
      chromeVersion: CHROME,
    });
    const contents = () =>
      Object.assign(new EventEmitter(), {
        destroyed: false,
        isDestroyed(this: { destroyed: boolean }) {
          return this.destroyed;
        },
      });
    const asContents = (fake: ReturnType<typeof contents>) =>
      fake as unknown as WebContents;
    const [popup, window, page, gone] = [
      contents(),
      contents(),
      contents(),
      contents(),
    ];
    const popupInfo = {
      kind: "popup" as const,
      extensionId: A,
      partition: "persist:space-personal",
      spaceId: "personal",
    };
    host.addSurface(asContents(popup), popupInfo);
    host.addSurface(asContents(window), {
      kind: "window",
      extensionId: A,
      partition: "persist:space-personal",
      windowId: 3,
    });
    gone.destroyed = true;
    host.addSurface(asContents(gone), popupInfo);
    expect(host.isExtensionSurface(asContents(popup))).toBe(true);
    expect(host.isExtensionSurface(asContents(window))).toBe(true);
    expect(host.isExtensionSurface(asContents(page))).toBe(false);
    expect(host.isExtensionSurface(asContents(gone))).toBe(false);
    expect(host.surfaceOf(asContents(popup))).toEqual(popupInfo);
    expect(host.surfaceOf(asContents(page))).toBeUndefined();
    expect(host.surfacesOf(A)).toEqual([popup, window]);
    expect(host.surfacesOf(B)).toEqual([]);
    // Adding again replaces what the host knows about it.
    host.addSurface(asContents(popup), { ...popupInfo, extensionId: B });
    expect(host.surfacesOf(B)).toEqual([popup]);
    expect(popup.listenerCount("destroyed")).toBe(1);
    popup.destroyed = true;
    popup.emit("destroyed");
    expect(host.isExtensionSurface(asContents(popup))).toBe(false);
    expect(host.surfacesOf(B)).toEqual([]);
    expect(host.surfacesOf(A)).toEqual([window]);
  });
});

const PERSONAL = "persist:space-personal";
const SECOND = "persist:space-two";
const PAGE_PRELOAD = "/app/out/preload/extension-page.cjs";
const WORKER_PRELOAD = "/app/out/preload/extension-worker.cjs";
type PageSurface = "tab" | "popup" | "window";

class FakeIpc {
  handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  channels = new Map<
    string,
    Set<(event: unknown, ...args: unknown[]) => void>
  >();
  handle = vi.fn(
    (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      this.handlers.set(channel, listener);
    },
  );
  removeHandler = vi.fn((channel: string) => {
    this.handlers.delete(channel);
  });
  on = vi.fn(
    (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => void,
    ) => {
      const set = this.channels.get(channel) ?? new Set();
      set.add(listener);
      this.channels.set(channel, set);
      return this;
    },
  );
  removeListener = vi.fn(
    (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => void,
    ) => {
      this.channels.get(channel)?.delete(listener);
      return this;
    },
  );
  call(event: unknown, payload: unknown): Promise<unknown> {
    return Promise.resolve(this.handlers.get(EXTENSION_CALL)?.(event, payload));
  }
  listen(event: unknown, names: string[]): void {
    for (const listener of this.channels.get(EXTENSION_LISTEN) ?? [])
      listener(event, names);
  }
}

// A page of a session: the main frame unless it asks for a subframe.
function fakePage(
  url: string,
  partition: string,
  options: { sub?: boolean } = {},
) {
  const emitter = new EventEmitter();
  const mainFrame = { url };
  const contents = Object.assign(emitter, {
    session: asSession(sessionOf(partition)),
    mainFrame,
    isDestroyed: () => false,
    send: vi.fn(),
  });
  const sender = contents as unknown as WebContents;
  return {
    contents: sender,
    send: contents.send,
    emitter,
    event: { sender, senderFrame: options.sub ? { url } : mainFrame },
  };
}

async function channelFor(
  entries: ExtensionEntry[],
  manifests: Record<string, Record<string, unknown>> = {},
) {
  const host = await hostFor(profile(entries, [], manifests));
  const ipc = new FakeIpc();
  const surfaces = new Map<WebContents, PageSurface | undefined>();
  const channel = new ExtensionChannel({
    host,
    preloads: { page: PAGE_PRELOAD, worker: WORKER_PRELOAD },
    surfaceOf: (contents) =>
      surfaces.has(contents) ? surfaces.get(contents) : "tab",
    ipc: ipc as unknown as ChannelDeps["ipc"],
  });
  return { host, ipc, channel, surfaces };
}
const workerManifest = (name: string) => ({
  manifest_version: 3,
  name,
  version: "1.0.0",
  background: { service_worker: "worker.js" },
});

describe("the extension bridge channel", () => {
  it("registers both preloads on each session before its extensions load", async () => {
    const { host, channel } = await channelFor([storeEntry(A)]);
    const ses = sessionOf(PERSONAL);
    await host.attach(PERSONAL, asSession(ses));
    expect(
      ses.registerPreloadScript.mock.calls.map(([script]) => script),
    ).toEqual([
      { id: PAGE_PRELOAD_ID, type: "frame", filePath: PAGE_PRELOAD },
      {
        id: WORKER_PRELOAD_ID,
        type: "service-worker",
        filePath: WORKER_PRELOAD,
      },
    ]);
    expect(ses.registerPreloadScript.mock.invocationCallOrder[1]).toBeLessThan(
      ses.extensions.loadExtension.mock.invocationCallOrder[0],
    );
    channel.dispose();
    expect(ses.unregisterPreloadScript.mock.calls.map(([id]) => id)).toEqual([
      PAGE_PRELOAD_ID,
      WORKER_PRELOAD_ID,
    ]);
  });

  it("counts a call only from a main frame of an extension loaded in the sender's session", async () => {
    const { host, ipc, channel } = await channelFor([storeEntry(A)]);
    const callers: Caller[] = [];
    channel.register("tabs", (caller, method, args) => {
      callers.push(caller);
      return { method, args };
    });
    await host.attach(PERSONAL, asSession(sessionOf(PERSONAL)));
    const second = sessionOf(SECOND);
    second.extensions.loadExtension.mockRejectedValueOnce(
      new Error("Not here"),
    );
    await host.attach(SECOND, asSession(second));
    const query = { api: "tabs", method: "query", args: [{ active: true }] };
    const page = fakePage(`chrome-extension://${A}/popup.html`, PERSONAL);
    await expect(ipc.call(page.event, query)).resolves.toEqual({
      method: "query",
      args: [{ active: true }],
    });
    expect(callers).toEqual([
      {
        extensionId: A,
        partition: PERSONAL,
        surface: "tab",
        contents: page.contents,
      },
    ]);
    expect(channel.callers(PERSONAL, A)).toEqual(callers);
    const refused = [
      fakePage(`chrome-extension://${A}/frame.html`, PERSONAL, { sub: true }),
      fakePage("https://example.com/", PERSONAL),
      fakePage(`chrome-extension://${A}/popup.html`, SECOND),
    ];
    for (const other of refused)
      await expect(ipc.call(other.event, query)).rejects.toThrow(
        extensionBridgeCopy.notSupported,
      );
    host.unloadEverywhere(A);
    await expect(ipc.call(page.event, query)).rejects.toThrow(
      extensionBridgeCopy.notSupported,
    );
    expect(callers.length).toBe(1);
  });

  it("never bridges component extensions or pages that are not tabs, popups or extension windows", async () => {
    const { host, ipc, channel, surfaces } = await channelFor([storeEntry(A)]);
    channel.register("tabs", () => "answered");
    await host.attach(PERSONAL, asSession(sessionOf(PERSONAL)));
    const query = { api: "tabs", method: "query", args: [] };
    const viewer = fakePage(
      `chrome-extension://${PDF_VIEWER_EXTENSION_ID}/index.html`,
      PERSONAL,
    );
    await expect(ipc.call(viewer.event, query)).rejects.toThrow(
      extensionBridgeCopy.notSupported,
    );
    const page = fakePage(`chrome-extension://${A}/popup.html`, PERSONAL);
    surfaces.set(page.contents, undefined);
    await expect(ipc.call(page.event, query)).rejects.toThrow(
      extensionBridgeCopy.notSupported,
    );
    surfaces.set(page.contents, "popup");
    await expect(ipc.call(page.event, query)).resolves.toBe("answered");
    expect(channel.callers(PERSONAL, A)[0].surface).toBe("popup");
  });

  it("refuses unknown APIs and calls over 64 KiB", async () => {
    const { host, ipc, channel } = await channelFor([storeEntry(A)]);
    channel.register("tabs", () => "answered");
    await host.attach(PERSONAL, asSession(sessionOf(PERSONAL)));
    const page = fakePage(`chrome-extension://${A}/popup.html`, PERSONAL);
    await expect(
      ipc.call(page.event, { api: "storage", method: "get", args: [] }),
    ).rejects.toThrow(extensionBridgeCopy.notSupported);
    await expect(ipc.call(page.event, { api: "tabs" })).rejects.toThrow(
      extensionBridgeCopy.notSupported,
    );
    await expect(
      ipc.call(page.event, {
        api: "tabs",
        method: "create",
        args: [{ url: "x".repeat(70000) }],
      }),
    ).rejects.toThrow(extensionBridgeCopy.tooLarge);
  });

  it("wires a worker whose scope is a loaded extension and sends it only events it listens to", async () => {
    const { host, channel } = await channelFor([storeEntry(A), storeEntry(B)], {
      [A]: workerManifest("Marker"),
    });
    const callers: Caller[] = [];
    channel.register("tabs", (caller) => {
      callers.push(caller);
      return "answered";
    });
    await host.attach(PERSONAL, asSession(sessionOf(PERSONAL)));
    const workers = sessionOf(PERSONAL).serviceWorkers;
    const worker = new FakeWorker(`chrome-extension://${A}/`, 11);
    workers.start(worker);
    expect(worker.ipc.handle).toHaveBeenCalledWith(
      EXTENSION_CALL,
      expect.any(Function),
    );
    await expect(
      worker.call({ api: "tabs", method: "query", args: [] }),
    ).resolves.toBe("answered");
    expect(callers).toEqual([
      { extensionId: A, partition: PERSONAL, surface: "worker", worker },
    ]);
    worker.listen(["tabs.onUpdated", "not.an.event"]);
    worker.ready();
    expect(channel.listening(PERSONAL, A, "tabs.onUpdated")).toBe(true);
    expect(channel.listening(PERSONAL, A, "tabs.onRemoved")).toBe(false);
    channel.emit(PERSONAL, A, "tabs.onUpdated", [1]);
    expect(worker.send).toHaveBeenCalledWith(
      EXTENSION_EVENT,
      "tabs.onUpdated",
      [1],
    );
    channel.emit(PERSONAL, A, "tabs.onRemoved", [1]);
    channel.emit(PERSONAL, B, "tabs.onUpdated", [2]);
    expect(worker.send).toHaveBeenCalledTimes(1);
    for (const scope of [
      "https://example.com/",
      `chrome-extension://${PDF_VIEWER_EXTENSION_ID}/`,
      `chrome-extension://${C}/`,
    ]) {
      const other = new FakeWorker(scope, 12 + scope.length);
      workers.start(other);
      expect(other.ipc.handle).not.toHaveBeenCalled();
    }
  });

  it("wakes a stopped worker for events it listened to before, and starts each worker once after loading", async () => {
    const { host, channel } = await channelFor([storeEntry(A)], {
      [A]: workerManifest("Marker"),
    });
    const scope = `chrome-extension://${A}/`;
    await host.attach(PERSONAL, asSession(sessionOf(PERSONAL)));
    await host.attach(SECOND, asSession(sessionOf(SECOND)));
    const workers = sessionOf(PERSONAL).serviceWorkers;
    expect(workers.startWorkerForScope.mock.calls).toEqual([[scope]]);
    expect(
      sessionOf(SECOND).serviceWorkers.startWorkerForScope.mock.calls,
    ).toEqual([[scope]]);
    const worker = new FakeWorker(scope, 21);
    workers.start(worker);
    worker.listen(["tabs.onUpdated"]);
    worker.ready();
    workers.stop(worker);
    channel.emit(PERSONAL, A, "tabs.onUpdated", [5]);
    channel.emit(PERSONAL, A, "tabs.onRemoved", [6]);
    expect(worker.send).not.toHaveBeenCalled();
    expect(workers.startWorkerForScope.mock.calls).toEqual([[scope], [scope]]);
    const woken = new FakeWorker(scope, 22);
    workers.start(woken);
    woken.listen(["tabs.onUpdated"]);
    expect(woken.send).not.toHaveBeenCalled();
    woken.ready();
    expect(woken.send.mock.calls).toEqual([
      [EXTENSION_EVENT, "tabs.onUpdated", [5]],
    ]);
  });

  it("sends events to listening pages and forgets them when they navigate or close", async () => {
    const { host, ipc, channel } = await channelFor([storeEntry(A)]);
    await host.attach(PERSONAL, asSession(sessionOf(PERSONAL)));
    const page = fakePage(`chrome-extension://${A}/popup.html`, PERSONAL);
    ipc.listen(page.event, ["tabs.onUpdated"]);
    expect(channel.listening(PERSONAL, A, "tabs.onUpdated")).toBe(true);
    channel.emit(PERSONAL, A, "tabs.onUpdated", [3]);
    channel.emit(PERSONAL, A, "tabs.onRemoved", [3]);
    expect(page.send.mock.calls).toEqual([
      [EXTENSION_EVENT, "tabs.onUpdated", [3]],
    ]);
    page.emitter.emit("did-navigate");
    expect(channel.listening(PERSONAL, A, "tabs.onUpdated")).toBe(false);
    channel.emit(PERSONAL, A, "tabs.onUpdated", [4]);
    expect(page.send).toHaveBeenCalledTimes(1);
    ipc.listen(page.event, ["tabs.onUpdated"]);
    page.emitter.emit("destroyed");
    expect(channel.callers(PERSONAL, A)).toEqual([]);
  });
});

describe("extension management", () => {
  const OTHER = "persist:space-x";
  // The PDF viewer's public key, from Chromium's pdf/manifest.json.
  const PDF_VIEWER_KEY =
    "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDN6hM0rsDYGbzQPQfOygqlRtQgKUXMfnSjhIBL7LnReAVBEd7ZmKtyN2qmSasMl4HZpMhVe2rPWVVwBDl6iyNE/Kok6E6v6V3vCLGsOpQAuuNVye/3QxzIldzG/jQAdWZiyXReRVapOhZtLjGfywCvlWq7Sl/e3sbc0vWybSDI2QIDAQAB";

  async function attached(
    userData: string,
    developer = false,
  ): Promise<{ host: ExtensionHost; sessions: FakeSession[] }> {
    const host = await hostFor(userData);
    if (developer) await host.setDeveloperMode(true);
    const sessions = [sessionOf(PERSONAL), sessionOf(OTHER)];
    await host.attach(PERSONAL, asSession(sessions[0]));
    await host.attach(OTHER, asSession(sessions[1]));
    return { host, sessions };
  }
  function installerFor(host: ExtensionHost) {
    const confirm = vi.fn(async (_details: ConsentDetails) => true);
    const chooseFolder = vi.fn(
      async (): Promise<string | undefined> => undefined,
    );
    const installer = new ExtensionInstaller({
      host,
      fetcher: async () => {
        throw new Error("no download");
      },
      env: { chromeVersion: CHROME, os: "mac", arch: "arm64" },
      locale: "en-US",
      confirm,
      chooseFolder,
      now: () => 1700,
    });
    return { installer, confirm, chooseFolder };
  }
  const saved = (userData: string) =>
    restoreExtensions(
      JSON.parse(readFileSync(join(userData, "extensions.json"), "utf8")),
    );

  it("turning an extension off unloads it everywhere, keeps its data and emits unloaded", async () => {
    const userData = profile([storeEntry(A), storeEntry(B)]);
    const { host, sessions } = await attached(userData);
    const events = recorded(host);

    await host.setEnabled(A, false);
    expect(host.entry(A)).toEqual(storeEntry(A, "1.0.0", { enabled: false }));
    expect(saved(userData).extensions).toEqual([
      storeEntry(A, "1.0.0", { enabled: false }),
      storeEntry(B),
    ]);
    expect(events.filter((event) => event.type === "unloaded")).toEqual([
      { type: "unloaded", id: A, partition: PERSONAL },
      { type: "unloaded", id: A, partition: OTHER },
    ]);
    for (const fake of sessions) {
      expect(fake.extensions.removeExtension.mock.calls).toEqual([[A]]);
      expect(fake.clearStorageData).not.toHaveBeenCalled();
      expect(fake.loaded.has(B)).toBe(true);
    }
    expect([...host.loadedIds(PERSONAL)]).toEqual([B]);

    await host.setEnabled(A, true);
    expect(host.entry(A)).toEqual(storeEntry(A));
    for (const fake of sessions) expect(fake.loaded.has(A)).toBe(true);
    expect([...host.loadedIds(OTHER)]).toEqual([B, A]);
  });

  it("Remove unloads, deletes the store folder, clears its origin in every session and queues its storage folders", async () => {
    const folder = temporary("kamapathy-unpacked-");
    const userData = profile([storeEntry(A), unpackedEntry(B, folder)]);
    const { host, sessions } = await attached(userData, true);

    await host.remove(A);
    for (const fake of sessions) {
      expect(fake.extensions.removeExtension.mock.calls).toEqual([[A]]);
      expect(fake.clearStorageData.mock.calls).toEqual([
        [{ origin: `chrome-extension://${A}` }],
      ]);
    }
    expect(existsSync(join(userData, "Extensions", A))).toBe(false);
    expect(host.entry(A)).toBeUndefined();
    expect(host.manifestOf(A)).toBeUndefined();
    expect(saved(userData)).toEqual({
      extensions: [unpackedEntry(B, folder)],
      removals: [A],
    });

    await host.remove(B);
    expect(existsSync(join(folder, "manifest.json"))).toBe(true);
    expect(saved(userData)).toEqual({ extensions: [], removals: [A, B] });
  });

  it("queued storage folders are deleted under every partition at the next launch before anything loads", async () => {
    const userData = profile([storeEntry(A), storeEntry(B)]);
    const settings = (partition: string, kind: string, id: string) =>
      join(userData, "Partitions", partition, `${kind} Extension Settings`, id);
    const gone = [
      settings("space-personal", "Local", A),
      settings("space-x", "Local", A),
      settings("space-x", "Sync", A),
    ];
    const kept = settings("space-x", "Local", B);
    for (const folder of [...gone, kept]) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, "000003.log"), "data");
    }
    const { host } = await attached(userData);
    await host.remove(A);
    // The folders are Chromium's to read until nothing is loaded.
    for (const folder of gone) expect(existsSync(folder)).toBe(true);

    const next = await hostFor(userData);
    for (const folder of gone) expect(existsSync(folder)).toBe(false);
    expect(existsSync(kept)).toBe(true);
    expect(saved(userData)).toEqual({
      extensions: [storeEntry(B)],
      removals: [],
    });
    const later = sessionOf("persist:space-y");
    await next.attach("persist:space-y", asSession(later));
    expect([...next.loadedIds("persist:space-y")]).toEqual([B]);
  });

  it("Load unpacked runs the checks and consent without a signature and keeps Electron's id", async () => {
    const userData = profile([]);
    const { host, sessions } = await attached(userData, true);
    const { installer, confirm, chooseFolder } = installerFor(host);

    const empty = temporary("kamapathy-folder-");
    await expect(installer.loadUnpacked(empty)).rejects.toThrow(
      extensionRefusalCopy.noManifest,
    );
    const theme = temporary("kamapathy-folder-");
    writeFolder(theme, { ...manifestFile("Theme", "1.0.0"), theme: {} });
    await expect(installer.loadUnpacked(theme)).rejects.toThrow(
      extensionRefusalCopy.themeOrApp,
    );
    expect(confirm).not.toHaveBeenCalled();
    for (const fake of sessions)
      expect(fake.extensions.loadExtension).not.toHaveBeenCalled();

    // No folder: the chooser, which the person can cancel.
    await expect(installer.loadUnpacked()).resolves.toEqual({
      added: false,
      id: "",
    });
    expect(chooseFolder).toHaveBeenCalledTimes(1);
    const folder = temporary("kamapathy-folder-");
    writeFolder(folder, {
      ...manifestFile("Marker", "2.1.0"),
      permissions: ["tabs"],
    });
    folderIds.set(folder, D);

    // Cancel loads nothing.
    confirm.mockResolvedValueOnce(false);
    chooseFolder.mockResolvedValueOnce(folder);
    await expect(installer.loadUnpacked()).resolves.toEqual({
      added: false,
      id: "",
    });
    expect(host.entries()).toEqual([]);
    for (const fake of sessions) expect(fake.loaded.has(D)).toBe(false);

    await expect(installer.loadUnpacked(folder)).resolves.toEqual({
      added: true,
      id: D,
      name: "Marker",
    });
    expect(confirm.mock.lastCall?.[0]).toEqual({
      name: "Marker",
      lines: ["Read your browsing history"],
      wontWork: [],
    });
    expect(host.entry(D)).toEqual({
      id: D,
      source: "unpacked",
      version: "2.1.0",
      path: folder,
      enabled: true,
      pinned: true,
      installedAt: 1700,
      grantedPermissions: ["tabs"],
      grantedHosts: [],
    });
    expect(saved(userData).extensions).toEqual([host.entry(D)]);
    for (const fake of sessions) {
      expect(fake.loaded.get(D)).toBe(folder);
      expect(host.isLoaded(fake === sessions[0] ? PERSONAL : OTHER, D)).toBe(
        true,
      );
    }

    await expect(installer.loadUnpacked(folder)).rejects.toThrow(
      extensionInstallCopy.alreadyAdded,
    );
    await host.setDeveloperMode(false);
    await expect(installer.loadUnpacked(folder)).rejects.toThrow(
      extensionRemoveCopy.developerModeOff,
    );
  });

  it("Developer mode off unloads unpacked extensions and on loads them again", async () => {
    const folder = temporary("kamapathy-unpacked-");
    const { host, sessions } = await attached(
      profile([storeEntry(A), unpackedEntry(B, folder)]),
      true,
    );
    const events = recorded(host);

    await host.setDeveloperMode(false);
    expect(events).toEqual([
      { type: "unloaded", id: B, partition: PERSONAL },
      { type: "unloaded", id: B, partition: OTHER },
    ]);
    // Its entry and its data stay.
    expect(host.entry(B)).toEqual(unpackedEntry(B, folder));
    for (const fake of sessions) {
      expect(fake.loaded.has(B)).toBe(false);
      expect(fake.loaded.has(A)).toBe(true);
      expect(fake.clearStorageData).not.toHaveBeenCalled();
    }

    events.length = 0;
    await host.setDeveloperMode(true);
    expect(events).toEqual([
      { type: "loaded", id: B, partition: PERSONAL },
      { type: "loaded", id: B, partition: OTHER },
    ]);
    for (const fake of sessions) expect(fake.loaded.get(B)).toBe(folder);
  });

  it("Reload rereads the folder and asks again only for new permissions", async () => {
    const folder = temporary("kamapathy-unpacked-");
    writeFolder(folder, {
      ...manifestFile("Marker", "1.0.0"),
      permissions: ["storage"],
    });
    folderIds.set(folder, D);
    const { host, sessions } = await attached(profile([]), true);
    const { installer, confirm } = installerFor(host);
    await installer.loadUnpacked(folder);
    expect(confirm).toHaveBeenCalledTimes(1);
    for (const fake of sessions) fake.extensions.removeExtension.mockClear();

    // A new version that asks for no more reloads without asking.
    writeFolder(folder, {
      ...manifestFile("Marker", "1.1.0"),
      permissions: ["storage"],
    });
    await installer.reloadUnpacked(D);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(host.entry(D)?.version).toBe("1.1.0");
    expect(host.manifestOf(D)?.version).toBe("1.1.0");
    for (const fake of sessions) {
      expect(fake.extensions.removeExtension.mock.calls).toEqual([[D]]);
      expect(fake.loaded.get(D)).toBe(folder);
    }

    // A new permission asks again, and Cancel keeps the loaded version.
    writeFolder(folder, {
      ...manifestFile("Marker", "1.2.0"),
      permissions: ["storage", "tabs"],
    });
    confirm.mockResolvedValueOnce(false);
    await installer.reloadUnpacked(D);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(host.entry(D)).toMatchObject({
      version: "1.1.0",
      grantedPermissions: ["storage"],
    });
    await installer.reloadUnpacked(D);
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(host.entry(D)).toMatchObject({
      version: "1.2.0",
      grantedPermissions: ["storage", "tabs"],
    });

    // A folder that changed its key is unloaded, with its reason in the row.
    const other = keyPair().publicKey;
    expect(idOf(other)).not.toBe(D);
    writeFolder(folder, {
      ...manifestFile("Marker", "1.3.0"),
      key: other.toString("base64"),
    });
    await expect(installer.reloadUnpacked(D)).rejects.toThrow(
      extensionRemoveCopy.folderChanged,
    );
    expect(host.loadError(D)).toBe(extensionRemoveCopy.folderChanged);
    expect(host.entry(D)?.version).toBe("1.2.0");
    for (const fake of sessions) expect(fake.loaded.has(D)).toBe(false);

    await host.setDeveloperMode(false);
    await expect(installer.reloadUnpacked(D)).rejects.toThrow(
      extensionRemoveCopy.developerModeOff,
    );
  });

  it("no unpacked folder can take a component id", async () => {
    const { host, sessions } = await attached(profile([]), true);
    const { installer, confirm } = installerFor(host);

    const keyed = temporary("kamapathy-folder-");
    writeFolder(keyed, {
      ...manifestFile("Viewer", "1.0.0"),
      key: PDF_VIEWER_KEY,
    });
    await expect(installer.loadUnpacked(keyed)).rejects.toThrow(
      extensionRefusalCopy.component,
    );
    expect(confirm).not.toHaveBeenCalled();
    for (const fake of sessions)
      expect(fake.extensions.loadExtension).not.toHaveBeenCalled();

    // An id Electron hands back that a component owns is unloaded and refused.
    const folder = temporary("kamapathy-folder-");
    writeFolder(folder, manifestFile("Sneak", "1.0.0"));
    folderIds.set(folder, PDF_VIEWER_EXTENSION_ID);
    await expect(installer.loadUnpacked(folder)).rejects.toThrow(
      extensionRefusalCopy.component,
    );
    expect(host.entries()).toEqual([]);
    expect(sessions[0].extensions.removeExtension.mock.calls).toEqual([
      [PDF_VIEWER_EXTENSION_ID],
    ]);
    expect(sessions[0].loaded.has(PDF_VIEWER_EXTENSION_ID)).toBe(false);
  });

  it("pins stop at 8", async () => {
    const ids = Array.from({ length: 10 }, (_, index) => idAt(index + 1));
    const userData = profile(
      ids.map((id, index) => storeEntry(id, "1.0.0", { pinned: index < 7 })),
    );
    const { host } = await attached(userData);

    await host.setPinned(ids[7], true);
    expect(host.entry(ids[7])?.pinned).toBe(true);
    await expect(host.setPinned(ids[8], true)).rejects.toThrow(
      extensionRemoveCopy.pinLimit,
    );
    expect(host.entry(ids[8])?.pinned).toBe(false);
    expect(
      saved(userData).extensions.filter((entry) => entry.pinned),
    ).toHaveLength(8);

    await host.setPinned(ids[0], false);
    await host.setPinned(ids[8], true);
    expect(host.entry(ids[0])?.pinned).toBe(false);
    expect(host.entry(ids[8])?.pinned).toBe(true);
    expect(
      saved(userData).extensions.filter((entry) => entry.pinned),
    ).toHaveLength(8);
  });
});

describe("the Extensions view and commands", () => {
  const anchor = { x: 12, y: 40, width: 28, height: 28 };

  function updatesFor(host: ExtensionHost): ExtensionUpdates {
    return new ExtensionUpdates({
      host,
      installer: new ExtensionInstaller({
        host,
        fetcher: async () => {
          throw new Error("no download");
        },
        env: { chromeVersion: CHROME, os: "mac", arch: "arm64" },
        locale: "en-US",
        confirm: async () => true,
      }),
      fetcher: async () => {
        throw new Error("no download");
      },
      env: { chromeVersion: CHROME, os: "mac", arch: "arm64" },
      pagesOpen: () => false,
      confirm: async () => true,
      timers: { set: () => 0, clear: () => {} },
    });
  }

  it("builds the Extensions view with sources, update states and the shown space's toolbar", async () => {
    const folder = join(temporary("kamapathy-folder-"), "tool");
    const entries = [
      storeEntry(A, "1.0.0", { pinned: true }),
      storeEntry(B, "2.0.0", {
        importedFrom: "Google Chrome",
        staged: {
          version: "2.1.0",
          path: `Extensions/${B}/2.1.0`,
          review: true,
          permissions: [],
          hosts: [],
        },
      }),
      unpackedEntry(C, folder),
    ];
    const userData = profile(entries, [], {
      [A]: {
        ...manifestFile("Reader", "1.0.0"),
        permissions: ["tabs"],
        options_page: "options.html",
        icons: { 16: "icon-16.png", 32: "icon-32.png", 128: "icon-128.png" },
      },
      [B]: {
        ...manifestFile("Blocker", "2.0.0"),
        permissions: ["notifications"],
      },
      [C]: manifestFile("Tool", "1.0.0"),
    });
    for (const size of [16, 32, 128])
      writeFileSync(join(userData, entries[0].path, `icon-${size}.png`), "png");
    const host = await hostFor(userData);
    host.setLoadError(C, extensionRefusalCopy.loadFailed);
    const installer = new ExtensionInstaller({
      host,
      // A download that never answers keeps its id in the queue.
      fetcher: () => new Promise(() => {}),
      env: { chromeVersion: CHROME, os: "mac", arch: "arm64" },
      locale: "en-US",
      confirm: async () => true,
    });
    void installer.installFromStore(D).catch(() => {});
    const imports = [{ id: E, name: "Imported", status: "adding" as const }];
    const actions = [
      {
        id: A,
        name: "Reader",
        title: "Reader",
        badge: "",
        badgeColor: "#d32f2f",
        enabled: true,
        pinned: true,
      },
    ];

    const view = extensionsView({
      host,
      installer,
      updates: updatesFor(host),
      toolbar: { actions, disabled: "agent" },
      imports,
    });

    expect(view.rows).toEqual([
      {
        id: A,
        name: "Reader",
        version: "1.0.0",
        source: "webstore",
        enabled: true,
        pinned: true,
        icon: "data:image/png;base64,icon-32.png",
        lines: ["Read your browsing history"],
        wontWork: [],
        hasOptions: true,
      },
      {
        id: B,
        name: "Blocker",
        version: "2.0.0",
        source: "webstore",
        importedFrom: "Google Chrome",
        enabled: true,
        pinned: false,
        lines: [],
        wontWork: ["Notifications"],
        hasOptions: false,
        update: { state: "review", version: "2.1.0" },
      },
      {
        id: C,
        name: "Tool",
        version: "1.0.0",
        source: "unpacked",
        enabled: true,
        pinned: false,
        lines: [],
        wontWork: [],
        hasOptions: false,
        error: extensionRefusalCopy.loadFailed,
        needsDeveloperMode: true,
      },
    ]);
    expect(view.actions).toEqual(actions);
    expect(view.disabled).toBe("agent");
    expect(view.installing).toEqual([D]);
    expect(view.imports).toEqual(imports);

    await host.setDeveloperMode(true);
    expect(
      extensionsView({
        host,
        installer,
        updates: updatesFor(host),
        toolbar: { actions: [] },
        imports: [],
      }).rows.map((row) => row.needsDeveloperMode),
    ).toEqual([undefined, undefined, undefined]);
  });

  it("parses only well-formed extension commands", () => {
    expect(parseExtensionCommand({ type: "load-unpacked" })).toEqual({
      type: "load-unpacked",
    });
    expect(
      parseExtensionCommand({ type: "install", input: " https://store/x " }),
    ).toEqual({ type: "install", input: " https://store/x " });
    expect(
      parseExtensionCommand({ type: "enable", id: A, enabled: false }),
    ).toEqual({ type: "enable", id: A, enabled: false });
    expect(parseExtensionCommand({ type: "pin", id: A, pinned: true })).toEqual(
      {
        type: "pin",
        id: A,
        pinned: true,
      },
    );
    for (const type of ["reload", "remove", "options", "review"] as const)
      expect(parseExtensionCommand({ type, id: B })).toEqual({ type, id: B });
    expect(parseExtensionCommand({ type: "click", id: A, anchor })).toEqual({
      type: "click",
      id: A,
      anchor,
    });
    expect(
      parseExtensionCommand({
        type: "anchors",
        buttons: { [A]: anchor },
        puzzle: { x: -9999, y: 0, width: 32, height: 32 },
      }),
    ).toEqual({
      type: "anchors",
      buttons: { [A]: anchor },
      puzzle: { x: -9999, y: 0, width: 32, height: 32 },
    });
    expect(
      parseExtensionCommand({ type: "anchors", buttons: {}, puzzle: null }),
    ).toEqual({ type: "anchors", buttons: {}, puzzle: null });

    for (const value of [
      undefined,
      null,
      "enable",
      [{ type: "enable", id: A, enabled: true }],
      { type: "nonsense" },
      { type: "enable", id: "not-an-id", enabled: true },
      { type: "enable", id: PDF_VIEWER_EXTENSION_ID, enabled: true },
      { type: "enable", id: A, enabled: "yes" },
      { type: "enable", id: A },
      { type: "pin", id: A, pinned: true, extra: 1 },
      { type: "load-unpacked", id: A },
      { type: "install", input: 5 },
      { type: "install", input: "x".repeat(2049) },
      { type: "install" },
      { type: "click", id: A },
      { type: "click", id: A, anchor: { x: 0, y: 0, width: 28 } },
      { type: "click", id: A, anchor: { ...anchor, height: 100001 } },
      { type: "click", id: A, anchor: { ...anchor, x: -10001 } },
      { type: "click", id: A, anchor: { ...anchor, y: Number.NaN } },
      { type: "click", id: A, anchor: { ...anchor, width: Infinity } },
      { type: "click", id: A, anchor: { ...anchor, extra: 1 } },
      { type: "anchors", buttons: { bad: anchor }, puzzle: null },
      { type: "anchors", buttons: { [A]: { x: 0 } }, puzzle: null },
      { type: "anchors", buttons: [], puzzle: null },
      { type: "anchors", buttons: {} },
    ])
      expect(() => parseExtensionCommand(value)).toThrow(
        "Invalid extension command.",
      );
  });

  it("runs the shell's commands behind the sender check and pushes one view per tick", async () => {
    const userData = profile([storeEntry(A), storeEntry(B)], [], {
      [A]: { ...manifestFile("Reader", "1.0.0"), options_page: "options.html" },
      [B]: manifestFile("Blocker", "1.0.0"),
    });
    const host = await hostFor(userData);
    await host.attach(SHARED_PARTITION, asSession(sessionOf(SHARED_PARTITION)));
    await host.attach(
      "persist:space-work",
      asSession(sessionOf("persist:space-work")),
    );
    const state = initialState("darwin");
    state.activeSpaceId = "work";
    state.spaces = state.spaces.map((space) =>
      space.id === "work" ? { ...space, signIns: "separate" as const } : space,
    );
    const controller = {
      state,
      partitionOf(spaceId: string): string {
        const space = state.spaces.find((item) => item.id === spaceId);
        if (!space) throw new Error("Space was not found.");
        return space.signIns === "shared"
          ? SHARED_PARTITION
          : `persist:space-${space.id}`;
      },
    } as unknown as BrowserController;
    const sent: ExtensionsView[] = [];
    let live = true;
    const window = {
      isDestroyed: () => false,
      webContents: {
        send: (channel: string, view: ExtensionsView) => {
          expect(channel).toBe(EXTENSIONS_CHANGED);
          sent.push(view);
        },
      },
    } as unknown as BrowserWindow;
    let trusted = true;
    let removes = true;
    const calls = {
      installFromStore: vi.fn(async (id: string) => ({
        added: true as const,
        id,
        name: "Reader",
      })),
      loadUnpacked: vi.fn(async () => ({
        added: true as const,
        id: C,
        name: "Tool",
      })),
      reloadUnpacked: vi.fn(async (_id: string) => {}),
      review: vi.fn(async (_id: string) => true),
      click: vi.fn(async (_id: string, _anchor: ExtensionAnchor) => {}),
      setAnchors: vi.fn(),
      openOptionsPage: vi.fn(),
      confirmRemove: vi.fn(async (_name: string) => removes),
    };
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, value?: unknown) => unknown
    >();
    const ipc = registerExtensionIpc({
      ipc: {
        handle: (channel, listener) =>
          handlers.set(
            channel,
            listener as (event: IpcMainInvokeEvent, value?: unknown) => unknown,
          ),
      } as Pick<IpcMain, "handle">,
      validateSender: () => {
        if (!trusted)
          throw new Error(
            "This operation is available only to the browser interface.",
          );
        return controller;
      },
      window: () => (live ? window : null),
      controller: () => controller,
      host,
      installer: {
        installing: () => [],
        installFromStore: calls.installFromStore,
        loadUnpacked: calls.loadUnpacked,
        reloadUnpacked: calls.reloadUnpacked,
      } as unknown as ExtensionInstaller,
      updates: {
        state: () => undefined,
        review: calls.review,
      } as unknown as ExtensionUpdates,
      bridge: {
        toolbar: () => ({ actions: [] }),
        click: calls.click,
        setAnchors: calls.setAnchors,
        openOptionsPage: calls.openOptionsPage,
      } as unknown as ExtensionBridge,
      confirmRemove: calls.confirmRemove,
    });
    const call = (channel: string, value?: unknown) =>
      handlers.get(channel)!({} as IpcMainInvokeEvent, value);
    const command = (value: unknown) => call(EXTENSION_COMMAND, value);

    const view = (await call(EXTENSIONS_CHANNEL)) as ExtensionsView;
    expect(view.rows.map((row) => row.name)).toEqual(["Reader", "Blocker"]);

    // Nothing runs for a sender that isn't the browser interface.
    trusted = false;
    expect(() => call(EXTENSIONS_CHANNEL)).toThrow(
      "This operation is available only to the browser interface.",
    );
    await expect(command({ type: "pin", id: A, pinned: true })).rejects.toThrow(
      "This operation is available only to the browser interface.",
    );
    expect(host.entry(A)?.pinned).toBe(false);
    trusted = true;

    await expect(
      command({ type: "install", input: "nonsense" }),
    ).rejects.toThrow(extensionInstallCopy.invalidInput);
    expect(calls.installFromStore).not.toHaveBeenCalled();
    expect(
      await command({
        type: "install",
        input: `https://chromewebstore.google.com/detail/reader/${A}?hl=en`,
      }),
    ).toEqual({ ok: true, id: A, added: true });
    expect(calls.installFromStore).toHaveBeenCalledWith(A);

    // Load unpacked waits for the person's developer mode.
    await expect(command({ type: "load-unpacked" })).rejects.toThrow(
      extensionRemoveCopy.developerModeOff,
    );
    expect(calls.loadUnpacked).not.toHaveBeenCalled();
    state.settings.extensionDeveloperMode = true;
    expect(await command({ type: "load-unpacked" })).toEqual({
      ok: true,
      id: C,
      added: true,
    });

    expect(await command({ type: "pin", id: A, pinned: true })).toEqual({
      ok: true,
      id: A,
    });
    expect(host.entry(A)?.pinned).toBe(true);
    expect(await command({ type: "enable", id: A, enabled: false })).toEqual({
      ok: true,
      id: A,
    });
    expect(host.entry(A)?.enabled).toBe(false);
    expect(await command({ type: "reload", id: A })).toEqual({
      ok: true,
      id: A,
    });
    expect(calls.reloadUnpacked).toHaveBeenCalledWith(A);
    expect(await command({ type: "review", id: A })).toEqual({
      ok: true,
      id: A,
    });
    expect(calls.review).toHaveBeenCalledWith(A);
    const anchor = { x: 10, y: 44, width: 28, height: 28 };
    expect(await command({ type: "click", id: A, anchor })).toEqual({
      ok: true,
      id: A,
    });
    expect(calls.click).toHaveBeenCalledWith(A, anchor);
    expect(
      await command({
        type: "anchors",
        buttons: { [A]: anchor },
        puzzle: null,
      }),
    ).toEqual({ ok: true });
    expect(calls.setAnchors).toHaveBeenCalledWith({ [A]: anchor }, null);

    // The options page opens in the space the person is looking at, and in
    // the shared session when that space runs no extensions.
    await command({ type: "options", id: A });
    expect(calls.openOptionsPage).toHaveBeenLastCalledWith(
      A,
      "persist:space-work",
      true,
    );
    host.detach("persist:space-work");
    await command({ type: "options", id: A });
    expect(calls.openOptionsPage).toHaveBeenLastCalledWith(
      A,
      SHARED_PARTITION,
      true,
    );

    // Cancelling Remove changes nothing.
    removes = false;
    expect(await command({ type: "remove", id: B })).toEqual({ ok: true });
    expect(calls.confirmRemove).toHaveBeenCalledWith("Blocker");
    expect(host.entry(B)).toBeTruthy();
    removes = true;
    expect(await command({ type: "remove", id: B })).toEqual({
      ok: true,
      id: B,
    });
    expect(host.entry(B)).toBeUndefined();

    // Every change in a tick reaches the shell as one view.
    sent.length = 0;
    ipc.push();
    ipc.push();
    ipc.setImports([{ id: E, name: "Imported", status: "adding" }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
    expect(sent[0].imports).toEqual([
      { id: E, name: "Imported", status: "adding" },
    ]);
    expect(sent[0].rows.map((row) => row.id)).toEqual([A]);

    // A closed window and a disposed push send nothing.
    live = false;
    ipc.push();
    await new Promise((resolve) => setTimeout(resolve, 0));
    live = true;
    ipc.push();
    ipc.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toHaveLength(1);
  });
});
