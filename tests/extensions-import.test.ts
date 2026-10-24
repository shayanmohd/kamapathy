import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import {
  PDF_VIEWER_EXTENSION_ID,
  type ExtensionCandidate,
  type ExtensionEntry,
  type ExtensionImportProgress,
  type ExtensionsView,
} from "../shared/extensions";
import type { BrowserState } from "../shared/types";
import { initialState } from "../shared/state";
import type { BrowserController } from "../electron/controller";
import type { ImportEnv } from "../electron/import";
import type { ExtensionHost } from "../electron/extensions/host";
import type {
  ExtensionInstaller,
  InstallOutcome,
} from "../electron/extensions/install";
import type { ExtensionBridge } from "../electron/extensions/bridge";
import type { ExtensionUpdates } from "../electron/extensions/updates";
import {
  EXTENSION_IMPORT_CANDIDATES,
  IMPORT_EXTENSIONS,
  parseExtensionImportRequest,
  parseImportSelection,
  registerExtensionIpc,
} from "../electron/extensions/ipc";
import {
  EDGE_UPDATE_HOST,
  OPERA_UPDATE_HOST,
  extensionCandidates,
  importExtensions,
  readExtensionSettings,
  type ExtensionImportContext,
} from "../electron/extensions/import";
import {
  extensionImportCopy,
  extensionRefusalCopy,
  importCopy,
} from "../src/copy";

// The shell IPC lives beside the controller, which loads Electron.
vi.mock("electron", () => ({
  app: {},
  BrowserWindow: vi.fn(),
  WebContentsView: vi.fn(),
  clipboard: {},
  dialog: {},
  nativeImage: {},
  nativeTheme: { themeSource: "system" },
  net: {},
  screen: {},
  session: {},
  shell: {},
  webContents: {},
}));

const fixture = fileURLToPath(
  new URL("./fixtures/import/chrome-extensions", import.meta.url),
);
const STORE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OFF = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EDGE = "cccccccccccccccccccccccccccccccc";
const DEFAULTED = "dddddddddddddddddddddddddddddddd";
const POLICY = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const UNPACKED = "ffffffffffffffffffffffffffffffff";

const directories: string[] = [];
const entries = new Map<string, ExtensionEntry>();
afterEach(() => {
  entries.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// The fixture user data folder, copied so a test may change it, with the
// unpacked extension's placeholder path pointing at the copy.
function chrome(): { home: string; data: string } {
  const home = mkdtempSync(join(tmpdir(), "kamapathy-extension-import-"));
  directories.push(home);
  const data = join(home, "Library/Application Support/Google/Chrome");
  mkdirSync(dirname(data), { recursive: true });
  cpSync(fixture, data, { recursive: true });
  const path = join(data, "Default", "Preferences");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "UNPACKED_PATH",
      JSON.stringify(join(data, "unpacked")).slice(1, -1),
    ),
  );
  return { home, data };
}
interface Extensions {
  settings?: Record<string, Record<string, unknown>>;
  pinned_extensions?: string[];
}
const profileDir = (data: string): string => join(data, "Default");
function patch(
  data: string,
  name: string,
  change: (extensions: Extensions) => void,
): void {
  const path = join(profileDir(data), name);
  const file = JSON.parse(readFileSync(path, "utf8")) as {
    extensions: Extensions;
  };
  change(file.extensions);
  writeFileSync(path, JSON.stringify(file, null, 2), "utf8");
}
function setting(
  data: string,
  name: string,
  id: string,
  change: (value: Record<string, unknown>) => void,
): void {
  patch(data, name, (extensions) => change(extensions.settings![id]));
}
// A local build the way Chrome lays them out: Extensions/<id>/<version>_<n>.
function build(
  data: string,
  id: string,
  version: string,
  manifest: Record<string, unknown>,
): void {
  const folder = join(profileDir(data), "Extensions", id, `${version}_0`);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "manifest.json"), JSON.stringify(manifest));
}

const host = {
  entry: (id: string) => entries.get(id),
} as Pick<ExtensionHost, "entry">;
const alreadyAdded = (id: string) => entries.set(id, { id } as ExtensionEntry);
function context(
  home: string,
  extra: Partial<ExtensionImportContext> = {},
): ExtensionImportContext {
  const env: ImportEnv = { platform: "darwin", home };
  return {
    host,
    developerMode: false,
    chromeVersion: "152.0.7977.76",
    locale: "en-US",
    env,
    ...extra,
  };
}
async function candidates(
  home: string,
  extra: Partial<ExtensionImportContext> = {},
): Promise<ExtensionCandidate[]> {
  const { list } = await extensionCandidates(
    "chrome",
    undefined,
    context(home, extra),
  );
  return list.candidates;
}
function find(rows: ExtensionCandidate[], id: string): ExtensionCandidate {
  const found = rows.find((row) => row.id === id);
  if (!found) throw new Error(`No candidate for ${id}`);
  return found;
}
const ids = (rows: ExtensionCandidate[]): string[] => rows.map((row) => row.id);

describe("extensionCandidates", () => {
  it("pre-checks follow the enabled state", async () => {
    const { home, data } = chrome();
    const rows = await candidates(home);
    expect(find(rows, STORE)).toMatchObject({ checked: true, added: false });
    // Turned off in the source, so the person decides again here.
    expect(find(rows, OFF).checked).toBe(false);
    expect(find(rows, DEFAULTED).checked).toBe(false);
    alreadyAdded(STORE);
    expect(find(await candidates(home), STORE)).toMatchObject({
      added: true,
      checked: false,
    });
    entries.clear();
    setting(data, "Secure Preferences", STORE, (value) => {
      value.state = 0;
    });
    expect(find(await candidates(home), STORE).checked).toBe(false);
    setting(data, "Secure Preferences", STORE, (value) => {
      value.state = 1;
      value.disable_reasons = [];
    });
    expect(find(await candidates(home), STORE).checked).toBe(true);
    setting(data, "Secure Preferences", STORE, (value) => {
      value.was_installed_by_oem = true;
    });
    expect(find(await candidates(home), STORE).checked).toBe(false);
  });

  it("component and policy items are hidden", async () => {
    const { home, data } = chrome();
    const hidden: Record<string, number> = {
      gggggggggggggggggggggggggggggggg: 2,
      hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh: 3,
      iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii: 8,
      jjjjjjjjjjjjjjjjjjjjjjjjjjjjjjjj: 9,
      kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk: 10,
      llllllllllllllllllllllllllllllll: 11,
    };
    const external = "mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm";
    patch(data, "Preferences", (extensions) => {
      for (const [id, location] of Object.entries({
        ...hidden,
        // Location 6 is a store download, so it is offered.
        [external]: 6,
        // The PDF viewer's id is Kamapathy's own, whatever the profile says.
        [PDF_VIEWER_EXTENSION_ID]: 1,
      })) {
        extensions.settings![id] = {
          location,
          state: 1,
          from_webstore: true,
        };
        build(data, id, "1.0", {
          manifest_version: 3,
          name: `Build ${location}`,
          version: "1.0",
        });
      }
    });
    const listed = ids(await candidates(home));
    expect(listed).toEqual([STORE, OFF, EDGE, DEFAULTED, UNPACKED, external]);
    for (const id of [...Object.keys(hidden), PDF_VIEWER_EXTENSION_ID, POLICY])
      expect(listed).not.toContain(id);
  });

  it("Edge add-ons show as unavailable", async () => {
    const { home, data } = chrome();
    expect(find(await candidates(home), EDGE)).toMatchObject({
      kind: "unavailable",
      checked: false,
      name: "Edge Add-on",
      note: extensionImportCopy.unavailable,
    });
    for (const updateHost of [
      EDGE_UPDATE_HOST,
      OPERA_UPDATE_HOST,
      "addons.example.com",
    ]) {
      setting(data, "Preferences", EDGE, (value) => {
        (value.manifest as Record<string, unknown>).update_url =
          `https://${updateHost}/update`;
      });
      expect(find(await candidates(home), EDGE)).toMatchObject({
        kind: "unavailable",
        note: extensionImportCopy.unavailable,
      });
    }
    // Only the Chrome Web Store's own update URL makes it a store item.
    setting(data, "Preferences", EDGE, (value) => {
      (value.manifest as Record<string, unknown>).update_url =
        "https://clients2.google.com/service/update2/crx";
    });
    expect(find(await candidates(home), EDGE)).toMatchObject({
      kind: "store",
      checked: true,
    });
  });

  it("unpacked items need Developer mode", async () => {
    const { home, data } = chrome();
    expect(find(await candidates(home), UNPACKED)).toMatchObject({
      kind: "unpacked",
      checked: false,
      name: "Local Build",
      version: "0.1",
      note: extensionImportCopy.needsDeveloperMode,
    });
    const on = find(await candidates(home, { developerMode: true }), UNPACKED);
    expect(on.checked).toBe(true);
    expect(on.note).toBeUndefined();
    // A relative path, or a folder that is gone, is not an unpacked item.
    setting(data, "Preferences", UNPACKED, (value) => {
      value.path = "unpacked";
    });
    expect(ids(await candidates(home, { developerMode: true }))).not.toContain(
      UNPACKED,
    );
    setting(data, "Preferences", UNPACKED, (value) => {
      value.path = join(data, "gone");
    });
    expect(ids(await candidates(home, { developerMode: true }))).not.toContain(
      UNPACKED,
    );
  });

  it("pins carry over", async () => {
    const { home, data } = chrome();
    const rows = await candidates(home);
    expect(find(rows, STORE).pinned).toBe(true);
    expect(find(rows, OFF).pinned).toBe(false);
    // Secure Preferences wins, and only extension ids count.
    patch(data, "Preferences", (extensions) => {
      extensions.pinned_extensions = [OFF];
    });
    const both = await candidates(home);
    expect(find(both, STORE).pinned).toBe(true);
    expect(find(both, OFF).pinned).toBe(false);
    patch(data, "Secure Preferences", (extensions) => {
      delete extensions.pinned_extensions;
    });
    const plain = await candidates(home);
    expect(find(plain, STORE).pinned).toBe(false);
    expect(find(plain, OFF).pinned).toBe(true);
  });

  it("names and permission lines come from the newest local manifest", async () => {
    const { home, data } = chrome();
    expect(find(await candidates(home), STORE)).toMatchObject({
      kind: "store",
      name: "Marker Tools",
      version: "1.2.0",
      lines: [
        "Read and change your data on example.com",
        "Read your browsing history",
      ],
      wontWork: [],
    });
    build(data, STORE, "1.3.0", {
      manifest_version: 3,
      name: "Newest Marker Tools",
      version: "1.3.0",
      permissions: ["clipboardRead", "bookmarks"],
    });
    expect(find(await candidates(home), STORE)).toMatchObject({
      name: "Newest Marker Tools",
      version: "1.3.0",
      lines: ["Read data you copy and paste"],
      wontWork: ["Your bookmarks"],
    });
    // A Manifest V2 build cannot run here.
    const old = "ponmlkjihgfedcbaponmlkjihgfedcba";
    patch(data, "Preferences", (extensions) => {
      extensions.settings![old] = {
        location: 1,
        state: 1,
        from_webstore: true,
        manifest: { name: "Old Add-on" },
      };
    });
    build(data, old, "4.0", {
      manifest_version: 2,
      name: "Old Add-on",
      version: "4.0",
    });
    expect(find(await candidates(home), old)).toMatchObject({
      kind: "unavailable",
      checked: false,
      name: "Old Add-on",
      version: "4.0",
      note: extensionRefusalCopy.version,
    });
    // Without a readable local build there is nothing to describe.
    const nowhere = "pppppppppppppppppppppppppppppppp";
    patch(data, "Preferences", (extensions) => {
      extensions.settings![nowhere] = {
        location: 1,
        state: 1,
        from_webstore: true,
      };
    });
    expect(ids(await candidates(home))).not.toContain(nowhere);
  });

  it("lists nothing for a browser outside the Chromium family", async () => {
    const { home } = chrome();
    const { list, folders, grants } = await extensionCandidates(
      "firefox",
      undefined,
      context(home),
    );
    expect(list).toEqual({
      source: "firefox",
      profile: "",
      browser: "Firefox",
      profileName: "",
      candidates: [],
    });
    expect([folders.size, grants.size]).toEqual([0, 0]);
  });

  it("names the browser and the profile it read", async () => {
    const { home } = chrome();
    const { list } = await extensionCandidates(
      "chrome",
      "Default",
      context(home),
    );
    expect(list).toMatchObject({
      source: "chrome",
      profile: "Default",
      browser: "Google Chrome",
      profileName: "Person 1",
    });
    const missing = await extensionCandidates(
      "chrome",
      "Profile 7",
      context(home),
    );
    expect(missing.list.candidates).toEqual([]);
  });
});

describe("readExtensionSettings", () => {
  it("reads Secure Preferences merged over Preferences and retries once on a parse error", async () => {
    const { data } = chrome();
    const directory = profileDir(data);
    const plain = readFileSync(join(directory, "Preferences"), "utf8");
    const secure = readFileSync(join(directory, "Secure Preferences"), "utf8");
    const merged = await readExtensionSettings(directory);
    // Only Secure Preferences calls this one a store item.
    expect(
      (
        JSON.parse(plain) as {
          extensions: { settings: Record<string, Record<string, unknown>> };
        }
      ).extensions.settings[STORE].from_webstore,
    ).toBeUndefined();
    expect(merged.settings[STORE].from_webstore).toBe(true);
    expect(merged.settings[OFF].location).toBe(1);
    expect(merged.pinned).toEqual([STORE]);

    const reads: string[] = [];
    const flaky = vi.fn(async (path: string) => {
      reads.push(path);
      const text = path.endsWith("Secure Preferences") ? secure : plain;
      // The first read of each file catches it half written.
      return reads.filter((seen) => seen === path).length === 1
        ? text.slice(0, 20)
        : text;
    });
    const retried = await readExtensionSettings(directory, flaky);
    expect(flaky).toHaveBeenCalledTimes(4);
    expect(retried.settings[STORE].from_webstore).toBe(true);
    expect(retried.pinned).toEqual([STORE]);

    const broken = vi.fn(async () => plain.slice(0, 20));
    expect(await readExtensionSettings(directory, broken)).toEqual({
      settings: {},
      pinned: [],
    });
    expect(broken).toHaveBeenCalledTimes(4);

    const missing = vi.fn(async () => {
      throw Object.assign(new Error("no such file"), { code: "ENOENT" });
    });
    expect(await readExtensionSettings(directory, missing)).toEqual({
      settings: {},
      pinned: [],
    });
    expect(missing).toHaveBeenCalledTimes(2);
  });
});

describe("importExtensions", () => {
  function installer(
    store: (id: string) => Promise<InstallOutcome> = async (id) => ({
      added: true,
      id,
      name: id,
    }),
  ) {
    const calls: string[] = [];
    return {
      calls,
      installFromStore: vi.fn((id: string): Promise<InstallOutcome> => {
        calls.push(`store ${id}`);
        return store(id);
      }),
      loadUnpacked: vi.fn(async (folder?: string): Promise<InstallOutcome> => {
        calls.push(`unpacked ${folder}`);
        return { added: true, id: UNPACKED, name: "Local Build" };
      }),
    };
  }

  it("Add N extensions asks once, installs store items one at a time and loads unpacked items in place", async () => {
    const { home, data } = chrome();
    alreadyAdded(DEFAULTED);
    const fake = installer(async (id) =>
      id === OFF ? { added: false, id } : { added: true, id, name: id },
    );
    const confirm = vi.fn(async () => true);
    const seen: ExtensionImportProgress[][] = [];
    const result = await importExtensions(
      { source: "chrome", ids: [STORE, OFF, EDGE, DEFAULTED, UNPACKED] },
      {
        ...context(home, { developerMode: true }),
        installer: fake,
        confirm,
        progress: (rows) => seen.push(rows),
      },
    );
    // The Edge add-on cannot be added and the defaulted one is already here.
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("Google Chrome", 3);
    expect(fake.calls).toEqual([
      `store ${STORE}`,
      `store ${OFF}`,
      `unpacked ${join(data, "unpacked")}`,
    ]);
    expect(fake.installFromStore).toHaveBeenCalledWith(STORE, {
      importedFrom: "Google Chrome",
      pinned: true,
      consented: {
        permissions: ["storage", "tabs"],
        hosts: ["https://example.com/*"],
      },
    });
    expect(fake.loadUnpacked).toHaveBeenCalledWith(join(data, "unpacked"), {
      importedFrom: "Google Chrome",
      pinned: false,
      consented: { permissions: ["storage"], hosts: [] },
    });
    // A Cancel in a raised permissions dialog adds nothing and says nothing.
    expect(result.results).toEqual([
      { id: STORE, name: "Marker Tools", status: "added" },
      { id: OFF, name: "Turned Off", status: "failed" },
      { id: UNPACKED, name: "Local Build", status: "added" },
    ]);
    expect(seen.map((rows) => rows.map((row) => row.status))).toEqual([
      ["adding"],
      ["added"],
      ["added", "adding"],
      ["added", "failed"],
      ["added", "failed", "adding"],
      ["added", "failed", "added"],
    ]);
  });

  it("reports a failed install with its message", async () => {
    const { home } = chrome();
    const fake = installer(() => {
      throw new Error("Couldn't add it.");
    });
    const result = await importExtensions(
      { source: "chrome", ids: [STORE] },
      {
        ...context(home),
        installer: fake,
        confirm: async () => true,
        progress: () => {},
      },
    );
    expect(result.results).toEqual([
      {
        id: STORE,
        name: "Marker Tools",
        status: "failed",
        message: "Couldn't add it.",
      },
    ]);
  });

  it("installs nothing on Cancel or with nothing left to add", async () => {
    const { home } = chrome();
    const fake = installer();
    const cancelled = vi.fn(async () => false);
    expect(
      await importExtensions(
        { source: "chrome", ids: [STORE, UNPACKED] },
        {
          ...context(home),
          installer: fake,
          confirm: cancelled,
          progress: () => {},
        },
      ),
    ).toEqual({ results: [] });
    expect(cancelled).toHaveBeenCalledWith("Google Chrome", 1);
    expect(fake.calls).toEqual([]);

    const confirm = vi.fn(async () => true);
    expect(
      await importExtensions(
        { source: "chrome", ids: [UNPACKED, EDGE, POLICY] },
        { ...context(home), installer: fake, confirm, progress: () => {} },
      ),
    ).toEqual({ results: [] });
    expect(confirm).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });
});

describe("the extension import channels", () => {
  interface Registered {
    call(channel: string, value?: unknown): Promise<unknown>;
    views: ExtensionsView[];
    confirm: ReturnType<typeof vi.fn>;
    installer: { installFromStore: ReturnType<typeof vi.fn> };
    state: BrowserState;
  }
  function register(home: string, trusted = () => true): Registered {
    const handlers = new Map<
      string,
      (event: IpcMainInvokeEvent, value?: unknown) => unknown
    >();
    const state = initialState("darwin");
    const controller = { state } as unknown as BrowserController;
    const views: ExtensionsView[] = [];
    const window = {
      isDestroyed: () => false,
      webContents: {
        send: (_: string, view: ExtensionsView) => views.push(view),
      },
    };
    const confirm = vi.fn(async () => true);
    const installer = {
      installing: () => [],
      installFromStore: vi.fn(async (id: string): Promise<InstallOutcome> => {
        // A real install waits for the store, so the view is pushed meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { added: true, id, name: id };
      }),
      loadUnpacked: vi.fn(async (): Promise<InstallOutcome> => ({
        added: true,
        id: UNPACKED,
        name: "Local Build",
      })),
    };
    registerExtensionIpc({
      ipc: {
        handle: (channel, listener) =>
          handlers.set(
            channel,
            listener as (event: IpcMainInvokeEvent, value?: unknown) => unknown,
          ),
      } as Pick<IpcMain, "handle">,
      validateSender: () => {
        if (!trusted()) throw new Error("not the browser interface");
        return controller;
      },
      window: () => window as never,
      controller: () => controller,
      host: {
        entry: () => undefined,
        entries: () => [],
      } as unknown as ExtensionHost,
      installer: installer as unknown as ExtensionInstaller,
      updates: { state: () => undefined } as unknown as ExtensionUpdates,
      bridge: {
        toolbar: () => ({ actions: [] }),
      } as unknown as ExtensionBridge,
      confirmRemove: async () => true,
      confirmImport: confirm,
      locale: "en-US",
      chromeVersion: "152.0.7977.76",
      env: { platform: "darwin", home },
    });
    return {
      call: async (channel, value) =>
        handlers.get(channel)!({} as IpcMainInvokeEvent, value),
      views,
      confirm,
      installer,
      state,
    };
  }

  it("takes only a known source, a short profile and extension ids", () => {
    expect(parseImportSelection({ source: "chrome" })).toEqual({
      source: "chrome",
    });
    expect(
      parseImportSelection({ source: "edge", profile: "Profile 2" }),
    ).toEqual({ source: "edge", profile: "Profile 2" });
    for (const value of [
      null,
      "chrome",
      [],
      {},
      { source: "firefox" },
      { source: "safari" },
      { source: "nothing" },
      { source: "chrome", profile: "x".repeat(256) },
      { source: "chrome", profile: 7 },
      { source: "chrome", extra: true },
    ])
      expect(() => parseImportSelection(value)).toThrow(
        importCopy.errors.import_invalid_request,
      );
    expect(
      parseExtensionImportRequest({ source: "chrome", ids: [STORE] }),
    ).toEqual({ source: "chrome", ids: [STORE] });
    for (const value of [
      { source: "chrome" },
      { source: "chrome", ids: STORE },
      { source: "chrome", ids: ["nope"] },
      { source: "chrome", ids: [PDF_VIEWER_EXTENSION_ID] },
      { source: "chrome", ids: new Array(101).fill(STORE) },
    ])
      expect(() => parseExtensionImportRequest(value)).toThrow(
        importCopy.errors.import_invalid_request,
      );
  });

  it("lists a profile's candidates and runs one import at a time", async () => {
    const { home } = chrome();
    const ipc = register(home);
    const list = (await ipc.call(EXTENSION_IMPORT_CANDIDATES, {
      source: "chrome",
      profile: "Default",
    })) as Awaited<ReturnType<typeof extensionCandidates>>["list"];
    expect(list.browser).toBe("Google Chrome");
    expect(ids(list.candidates)).toEqual([
      STORE,
      OFF,
      EDGE,
      DEFAULTED,
      UNPACKED,
    ]);
    // Developer mode is the person's setting, so the unpacked item waits.
    expect(find(list.candidates, UNPACKED).note).toBe(
      extensionImportCopy.needsDeveloperMode,
    );

    // The dialog waits, so a second import arrives while the first runs.
    let release = () => {};
    const asked = new Promise<void>((answered) => {
      ipc.confirm.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            release = () => resolve(true);
            answered();
          }),
      );
    });
    const first = ipc.call(IMPORT_EXTENSIONS, {
      source: "chrome",
      ids: [STORE, UNPACKED],
    });
    await asked;
    await expect(
      ipc.call(IMPORT_EXTENSIONS, { source: "chrome", ids: [STORE] }),
    ).rejects.toThrow(importCopy.errors.import_busy);
    release();
    expect(await first).toEqual({
      results: [{ id: STORE, name: "Marker Tools", status: "added" }],
    });
    expect(ipc.installer.installFromStore).toHaveBeenCalledTimes(1);
    // The panel sees the rows while they run, and an empty list after.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ipc.views.at(-1)?.imports).toEqual([]);
    expect(
      ipc.views.some((view) =>
        view.imports.some((row) => row.status === "adding"),
      ),
    ).toBe(true);

    // An untrusted sender reaches neither channel.
    const closed = register(home, () => false);
    await expect(
      closed.call(EXTENSION_IMPORT_CANDIDATES, { source: "chrome" }),
    ).rejects.toThrow("not the browser interface");
    await expect(
      closed.call(IMPORT_EXTENSIONS, { source: "chrome", ids: [STORE] }),
    ).rejects.toThrow("not the browser interface");
  });

  it("loads unpacked items only while the person's developer mode is on", async () => {
    const { home, data } = chrome();
    const ipc = register(home);
    ipc.state.settings.extensionDeveloperMode = true;
    const list = (await ipc.call(EXTENSION_IMPORT_CANDIDATES, {
      source: "chrome",
    })) as Awaited<ReturnType<typeof extensionCandidates>>["list"];
    expect(find(list.candidates, UNPACKED).checked).toBe(true);
    expect(
      await ipc.call(IMPORT_EXTENSIONS, { source: "chrome", ids: [UNPACKED] }),
    ).toEqual({
      results: [{ id: UNPACKED, name: "Local Build", status: "added" }],
    });
    expect(ipc.confirm).toHaveBeenCalledWith("Google Chrome", 1);
    expect(join(data, "unpacked")).toBeTruthy();
  });
});
