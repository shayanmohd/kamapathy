import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { KamapathyBridge } from "../shared/types";

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
