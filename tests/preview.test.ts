import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { KamapathyBridge, PasswordsBridge } from "../shared/types";

// What the desktop preload hands to the shell and sends to main.
const electron = vi.hoisted(() => ({
  exposed: undefined as KamapathyBridge | undefined,
  invoked: [] as unknown[][],
}));
vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_key: string, value: KamapathyBridge) => {
      electron.exposed = value;
    },
  },
  ipcRenderer: {
    invoke: async (...args: unknown[]) => {
      electron.invoked.push(args);
      return { ok: true };
    },
  },
}));

let storage: Map<string, string>;
let create: () => KamapathyBridge;
beforeEach(async () => {
  vi.resetModules();
  storage = new Map();
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  create = (await import("../src/lib/bridge")).createPreviewBridge;
});
afterEach(() => vi.unstubAllGlobals());

async function split(bridge: KamapathyBridge) {
  const first = await bridge.dispatch({
    type: "tab:create",
    url: "https://example.com/first",
  });
  const firstId = first.activeTabId;
  const second = await bridge.dispatch({
    type: "tab:create",
    url: "https://example.com/second",
    background: true,
  });
  const secondId = second.tabs.find((tab) => tab.url.endsWith("/second"))!.id;
  await bridge.dispatch({ type: "tab:split", id: secondId });
  return { firstId, secondId };
}
describe("interactive preview state invariants", () => {
  it("the web preview lists no extensions and refuses extension commands", async () => {
    const bridge = create();
    expect(await bridge.extensions()).toEqual({
      rows: [],
      actions: [],
      installing: [],
      imports: [],
    });
    expect(bridge.onExtensions(() => {})()).toBeUndefined();
    await expect(
      bridge.extensionCommand({ type: "install", input: "abc" }),
    ).rejects.toThrow("This feature is available in the desktop app.");
  });

  it("recovers from corrupt storage without trusting saved runtime state", async () => {
    const saved = await create().getState();
    storage.set(
      "kamapathy-preview-v1",
      JSON.stringify({
        ...saved,
        bookmarks: {},
        history: null,
        activity: [null],
        settings: {
          theme: "broken",
          searchEngine: "broken",
          automationEnabled: true,
        },
        automation: { running: true, port: 9999 },
        platform: "win32",
        version: "untrusted",
        tabs: [
          null,
          {
            id: "bad",
            spaceId: saved.spaces[0].id,
            url: "javascript:alert(1)",
          },
        ],
      }),
    );
    const bridge = create();
    const restored = await bridge.getState();
    expect(restored.platform).toBe("web");
    expect(restored.settings.theme).not.toBe("broken");
    expect(restored.settings.automationEnabled).toBe(false);
    expect(restored.automation.running).toBe(false);
    expect(restored.activity).toEqual([]);
    expect(Array.isArray(restored.bookmarks)).toBe(true);
    expect(Array.isArray(restored.history)).toBe(true);
    expect(restored.tabs.every((tab) => tab.url === "kamapathy://newtab")).toBe(
      true,
    );
    await expect(
      bridge.dispatch({ type: "tab:create", url: "hello world" }),
    ).resolves.toBeDefined();
    storage.set("kamapathy-preview-v1", "{broken");
    expect((await create().getState()).tabs.length).toBeGreaterThan(0);
  });
  it("removes duplicate saved identities and unsafe bookmark URLs", async () => {
    const saved = await create().getState();
    storage.set(
      "kamapathy-preview-v1",
      JSON.stringify({
        ...saved,
        spaces: [...saved.spaces, saved.spaces[0]],
        tabs: [
          ...saved.tabs,
          { ...saved.tabs[0], spaceId: saved.spaces[1].id },
        ],
        bookmarks: [{ id: "unsafe", title: "Bad", url: "file:///etc/passwd" }],
      }),
    );
    const restored = await create().getState();
    expect(new Set(restored.spaces.map((space) => space.id)).size).toBe(
      restored.spaces.length,
    );
    expect(new Set(restored.tabs.map((tab) => tab.id)).size).toBe(
      restored.tabs.length,
    );
    expect(restored.bookmarks).toEqual([]);
  });
  it("does not expose a previous workspace split after a command palette tab switch", async () => {
    const bridge = create();
    await split(bridge);
    const work = (await bridge.getState()).tabs.find(
      (tab) => tab.spaceId === "work",
    )!;
    const state = await bridge.dispatch({ type: "tab:activate", id: work.id });
    expect(state.activeSpaceId).toBe("work");
    expect(state.splitTabId).toBeNull();
  });
  it("opens duplicate tabs with an honest empty navigation history", async () => {
    const bridge = create();
    let state = await bridge.getState();
    const original = state.activeTabId;
    await bridge.dispatch({
      type: "tab:navigate",
      id: original,
      url: "https://example.com",
    });
    state = await bridge.dispatch({ type: "tab:duplicate", id: original });
    const copy = state.tabs.find((tab) => tab.id === state.activeTabId)!;
    expect(copy.id).not.toBe(original);
    expect(copy.canGoBack).toBe(false);
    expect(copy.canGoForward).toBe(false);
  });
  it("removes split view when opening a fresh new tab or navigating home", async () => {
    const bridge = create();
    await split(bridge);
    expect(
      (await bridge.dispatch({ type: "tab:create" })).splitTabId,
    ).toBeNull();
    const { firstId } = await split(bridge);
    expect(
      (
        await bridge.dispatch({
          type: "tab:navigate",
          id: firstId,
          url: "kamapathy://newtab",
        })
      ).splitTabId,
    ).toBeNull();
  });
  it("promotes the surviving pane when the primary split tab is closed", async () => {
    const bridge = create();
    const { firstId, secondId } = await split(bridge);
    const state = await bridge.dispatch({ type: "tab:close", id: firstId });
    expect(state.activeTabId).toBe(secondId);
    expect(state.splitTabId).toBeNull();
  });
  it("clears split when back reaches Home or the secondary pane navigates Home", async () => {
    const bridge = create();
    const original = (await bridge.getState()).activeTabId;
    await bridge.dispatch({
      type: "tab:navigate",
      id: original,
      url: "https://example.com",
    });
    const other = await bridge.dispatch({
      type: "tab:create",
      url: "https://example.com/other",
      background: true,
    });
    const second = other.tabs.find((tab) => tab.url.endsWith("/other"))!.id;
    await bridge.dispatch({ type: "tab:split", id: second });
    expect(
      (await bridge.dispatch({ type: "tab:back", id: original })).splitTabId,
    ).toBeNull();
    const { secondId } = await split(bridge);
    expect(
      (
        await bridge.dispatch({
          type: "tab:navigate",
          id: secondId,
          url: "kamapathy://newtab",
        })
      ).splitTabId,
    ).toBeNull();
  });
  it("does not persist agent spaces or fake restored history controls", async () => {
    const bridge = create();
    const original = (await bridge.getState()).activeTabId;
    await bridge.dispatch({
      type: "tab:navigate",
      id: original,
      url: "https://example.com",
    });
    await bridge.dispatch({
      type: "space:create",
      name: "Private task",
      color: "purple",
      kind: "agent",
    });
    const saved = JSON.parse(storage.get("kamapathy-preview-v1")!);
    expect(
      saved.spaces.every(
        (space: { kind: string }) => space.kind === "personal",
      ),
    ).toBe(true);
    const state = await create().getState();
    expect(state.spaces.some((space) => space.kind === "agent")).toBe(false);
    expect(state.tabs.every((tab) => !tab.canGoBack && !tab.canGoForward)).toBe(
      true,
    );
  });
  it("respects a disabled session restore preference", async () => {
    const bridge = create();
    await bridge.dispatch({ type: "tab:create", url: "https://example.com" });
    await bridge.dispatch({
      type: "settings:update",
      settings: { restoreSession: false },
    });
    expect(
      (await create().getState()).tabs.every(
        (tab) => tab.url === "kamapathy://newtab",
      ),
    ).toBe(true);
  });
  it("has nothing to freeze in the web preview", async () => {
    const bridge = create();
    expect(await bridge.freeze()).toEqual([]);
    expect(() => bridge.hidePages()).not.toThrow();
    await expect(bridge.unfreeze()).resolves.toBeUndefined();
  });
  it("ignores grants, stops, keeps and request answers in the web preview", async () => {
    const bridge = create();
    const before = structuredClone(await bridge.getState());
    for (const action of [
      { type: "space:grant", id: "work" },
      { type: "space:stop", id: "work" },
      { type: "space:keep", id: "work" },
      { type: "space-request:answer", id: "request", allow: true, spaceId: "work" },
    ] as const)
      expect((await bridge.dispatch(action)).spaces, action.type).toEqual(
        before.spaces,
      );
  });
  it("has no thumbnails in the web preview", async () => {
    expect(await create().thumbnails()).toEqual({});
  });
  it("agent setup is desktop only in the web preview", async () => {
    const bridge = create();
    expect(await bridge.agentSetupStatus()).toEqual({
      supported: false,
      reason: "desktop_only",
      skillFolder: null,
      agents: [],
      command: {
        state: "off",
        path: "",
        onPath: null,
        profileFile: null,
        pathAdded: false,
      },
      codex: { detected: false, allowed: false },
      node: null,
    });
    for (const call of [
      () =>
        bridge.applyAgentSetup({
          agents: ["claude-code"],
          replace: [],
          command: true,
          path: false,
          codexRule: false,
        }),
      () => bridge.removeAgentSetup(),
    ])
      await expect(call()).rejects.toThrow(
        "Agent setup is available in the desktop app.",
      );
  });
  it("opens help in the active space in the web preview", async () => {
    const bridge = create();
    expect(await bridge.helpSpaceId()).toBe("personal");
    await bridge.dispatch({ type: "space:activate", id: "work" });
    expect(await bridge.helpSpaceId()).toBe("work");
  });
  it("recolours a space in the web preview", async () => {
    const bridge = create();
    const state = await bridge.dispatch({
      type: "space:color",
      id: "work",
      color: "orange",
    });
    expect(state.spaces.find((space) => space.id === "work")?.color).toBe("orange");
  });
  it("edits a shortcut in the web preview", async () => {
    const bridge = create();
    const state = await bridge.dispatch({
      type: "bookmark:update",
      id: "github",
      title: "Code",
      url: "github.com/shayanmohd",
    });
    expect(state.bookmarks.find((item) => item.id === "github")).toMatchObject({
      title: "Code",
      url: "https://github.com/shayanmohd",
    });
    await expect(
      bridge.dispatch({
        type: "bookmark:update",
        id: "figma",
        title: "Figma",
        url: "https://github.com/shayanmohd",
      }),
    ).rejects.toThrow("already bookmarked");
  });
});

// One call of every password method, with arguments in bridge order.
const passwordCalls = {
  status: [],
  list: [],
  reveal: ["login-1"],
  copy: ["login-1", "password"],
  add: [{ url: "https://example.com", username: "ada", password: "secret" }],
  update: ["login-1", { password: "newer", note: "" }],
  remove: ["login-1"],
  importFile: [{ replace: true }],
  trashFile: ["file-token"],
  exportFile: [],
  answer: ["prompt-1", { action: "save", username: "ada" }],
  retry: [],
  startOver: [],
  neverSaved: [],
  removeNeverSaved: ["https://example.com"],
} satisfies { [K in keyof PasswordsBridge]: Parameters<PasswordsBridge[K]> };
type PasswordCall = (...values: unknown[]) => Promise<unknown>;
const callPassword = (
  passwords: PasswordsBridge,
  name: string,
  args: unknown[],
) => (passwords[name as keyof PasswordsBridge] as PasswordCall)(...args);

describe("password bridges", () => {
  it("the web preview answers vault_unavailable for every password call", async () => {
    const bridge = create();
    expect(Object.keys(bridge.passwords).sort()).toEqual(
      Object.keys(passwordCalls).sort(),
    );
    for (const [name, args] of Object.entries(passwordCalls))
      expect(await callPassword(bridge.passwords, name, args), name).toEqual({
        error: {
          code: "vault_unavailable",
          reason: "web",
          message: expect.stringMatching(/\S/),
        },
      });
    const state = await bridge.getState();
    expect(state.passwordPrompts).toEqual([]);
    // Prompts are runtime state, so a saved preview never brings one back.
    storage.set(
      "kamapathy-preview-v1",
      JSON.stringify({
        ...state,
        passwordPrompts: [
          {
            id: "prompt-1",
            tabId: state.activeTabId,
            kind: "save",
            host: "example.com",
            username: "ada",
          },
        ],
      }),
    );
    expect((await create().getState()).passwordPrompts).toEqual([]);
  });

  it("the desktop preload sends each password call on its channel with its arguments in order", async () => {
    electron.invoked = [];
    await import("../electron/preload");
    const passwords = electron.exposed!.passwords;
    expect(Object.keys(passwords).sort()).toEqual(
      Object.keys(passwordCalls).sort(),
    );
    for (const [name, args] of Object.entries(passwordCalls))
      await callPassword(passwords, name, args);
    const channels: Record<keyof PasswordsBridge, string> = {
      status: "kamapathy:passwords:status",
      list: "kamapathy:passwords:list",
      reveal: "kamapathy:passwords:reveal",
      copy: "kamapathy:passwords:copy",
      add: "kamapathy:passwords:add",
      update: "kamapathy:passwords:update",
      remove: "kamapathy:passwords:remove",
      importFile: "kamapathy:passwords:import-file",
      trashFile: "kamapathy:passwords:trash-file",
      exportFile: "kamapathy:passwords:export-file",
      answer: "kamapathy:passwords:answer",
      retry: "kamapathy:passwords:retry",
      startOver: "kamapathy:passwords:start-over",
      neverSaved: "kamapathy:passwords:never-saved",
      removeNeverSaved: "kamapathy:passwords:remove-never-saved",
    };
    expect(electron.invoked).toEqual(
      Object.entries(passwordCalls).map(([name, args]) => [
        channels[name as keyof PasswordsBridge],
        ...args,
      ]),
    );
  });
});
