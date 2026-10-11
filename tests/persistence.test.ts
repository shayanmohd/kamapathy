import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOME_URL, initialState, newTab } from "../shared/state";
import { readState, writeState } from "../electron/persistence";

const directories: string[] = [];
function statePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "kamapathy-state-test-"));
  directories.push(directory);
  return join(directory, "state.json");
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("desktop session persistence", () => {
  it("loads an older save and drops its sidebar setting", () => {
    const path = statePath();
    const original = initialState();
    writeFileSync(
      path,
      JSON.stringify({
        ...original,
        settings: {
          ...original.settings,
          sidebarCollapsed: true,
          showBookmarksBar: true,
        },
      }),
    );
    const restored = readState(path, "darwin", "0.2.0");
    expect(restored.settings).toEqual({
      ...original.settings,
      showBookmarksBar: true,
    });
    expect(initialState().settings.showBookmarksBar).toBe(false);
  });
  it("shares sign-ins by default and keeps a space's separate sign-ins", () => {
    const path = statePath();
    const original = initialState();
    original.spaces[1].signIns = "separate";
    writeFileSync(
      path,
      JSON.stringify({
        ...original,
        spaces: [
          { ...original.spaces[0], signIns: undefined },
          original.spaces[1],
          { ...original.spaces[1], id: "odd", name: "Odd", signIns: "private" },
        ],
      }),
    );
    const restored = readState(path, "darwin", "0.2.0");
    expect(restored.spaces.map((space) => space.signIns)).toEqual([
      "shared",
      "separate",
      "shared",
    ]);
    expect(restored.settings.isolateAgentSpaces).toBe(false);
    expect(restored.settings.welcomed).toBe(false);
  });
  it("keeps visit counts from imported history and drops invalid ones", () => {
    const path = statePath();
    const original = initialState();
    original.history.push(
      { id: "a", title: "A", url: "https://a.example/", visitedAt: 5, visits: 3 },
      { id: "b", title: "B", url: "https://b.example/", visitedAt: 4, visits: 0 },
      { id: "c", title: "C", url: "https://c.example/", visitedAt: 3 },
    );
    writeFileSync(path, JSON.stringify(original));
    const restored = readState(path, "darwin", "0.2.0");
    expect(restored.history.map((entry) => entry.visits)).toEqual([
      3,
      undefined,
      undefined,
    ]);
    expect(restored.history[1]).not.toHaveProperty("visits");
  });
  it("rejects duplicate space and tab identifiers across restored spaces", () => {
    const path = statePath();
    const original = initialState();
    original.spaces.push({ ...original.spaces[0], name: "Duplicate" });
    original.tabs[0].url = "https://personal.example/";
    original.tabs[1].id = original.tabs[0].id;
    original.tabs[1].url = "https://work.example/";
    writeFileSync(path, JSON.stringify(original));
    const restored = readState(path, "linux", "0.1.0");
    expect(restored.spaces).toHaveLength(2);
    expect(new Set(restored.tabs.map((tab) => tab.id)).size).toBe(
      restored.tabs.length,
    );
    expect(restored.tabs.find((tab) => tab.spaceId === "work")?.url).toBe(
      "kamapathy://newtab",
    );
  });

  it("keeps one tab per space without exceeding the restoration limit", () => {
    const path = statePath();
    const original = initialState();
    original.tabs = Array.from({ length: 200 }, () =>
      newTab("personal", "https://example.com/"),
    );
    writeFileSync(path, JSON.stringify(original));
    const restored = readState(path, "linux", "0.1.0");
    expect(restored.tabs).toHaveLength(200);
    expect(
      restored.spaces.every((space) =>
        restored.tabs.some((tab) => tab.spaceId === space.id),
      ),
    ).toBe(true);
  });

  it("restores personal tabs, bookmarks, settings and history with runtime fields reset", () => {
    const path = statePath();
    const original = initialState("darwin");
    const tab = original.tabs[0];
    Object.assign(tab, {
      url: "https://example.com/",
      title: "Example",
      pinned: true,
      loading: true,
      error: "Old network failure",
      canGoBack: true,
    });
    original.history.push({
      id: "visit",
      url: tab.url,
      title: "Example",
      visitedAt: Date.now(),
    });
    original.settings.theme = "dark";
    writeState(path, original);
    const restored = readState(path, "win32", "1.2.3");
    expect(restored.tabs[0]).toMatchObject({
      id: tab.id,
      url: tab.url,
      title: "Example",
      pinned: true,
      loading: false,
      canGoBack: false,
    });
    expect(restored.tabs[0].error).toBeUndefined();
    expect(restored.history).toEqual(original.history);
    expect(restored.bookmarks).toEqual(original.bookmarks);
    expect(restored.settings.theme).toBe("dark");
    expect(restored.platform).toBe("win32");
    expect(restored.version).toBe("1.2.3");
  });

  it("excludes agent tabs, spaces, activity, downloads and runtime agent state from disk", () => {
    const path = statePath();
    const original = initialState("darwin");
    original.spaces.push({
      id: "agent-private",
      name: "Private task",
      kind: "agent",
      owner: "agent",
      signIns: "shared",
      color: "purple",
      createdAt: Date.now(),
    });
    const agentTab = newTab("agent-private", "https://private-task.example/");
    original.tabs.push(agentTab);
    original.activeSpaceId = "agent-private";
    original.activeTabId = agentTab.id;
    original.activity.push({
      id: "event",
      spaceId: "agent-private",
      message: "Private task detail",
      kind: "info",
      time: Date.now(),
    });
    original.downloads.push({
      id: "download",
      filename: "secret.txt",
      path: "/tmp/secret.txt",
      receivedBytes: 5,
      totalBytes: 5,
      state: "completed",
    });
    original.automation = { running: true };
    writeState(path, original);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("agent-private");
    expect(raw).not.toContain("private-task");
    expect(raw).not.toContain("Private task");
    expect(raw).not.toContain("secret.txt");
    const restored = readState(path, "linux", "0.1.0");
    expect(restored.activeSpaceId).toBe("personal");
    expect(
      restored.spaces.some((space) => space.id === restored.activeSpaceId),
    ).toBe(true);
    expect(
      restored.tabs.some(
        (tab) =>
          tab.id === restored.activeTabId &&
          tab.spaceId === restored.activeSpaceId,
      ),
    ).toBe(true);
    expect(restored.automation).toEqual({ running: false });
  });

  it("never saves labels, origins, managed flags, budgets, grants, control or ended state", () => {
    const path = statePath();
    const original = initialState("darwin");
    const [personal, work] = original.spaces;
    // A granted personal space, as a grant leaves it.
    Object.assign(personal, {
      owner: "agent",
      createdBy: "person",
      pageBudget: 7,
      access: "granted",
      control: {
        reason: "approval",
        prompt: "clearing site data",
        since: 1,
        hold: "hold-1",
      },
    });
    Object.assign(work, {
      access: "ended",
      ended: { by: "person", reason: "stopped", at: 2 },
    });
    for (const [index, tab] of original.tabs.entries())
      Object.assign(tab, {
        url: `https://example.com/${index}`,
        label: `p${index + 1}`,
        openedBy: "page",
        openerId: "opener",
        managed: true,
        createdAt: 3,
        unseen: true,
      });
    writeState(path, original);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    for (const space of saved.spaces)
      expect(Object.keys(space).sort()).toEqual([
        "color",
        "createdAt",
        "id",
        "kind",
        "name",
        "owner",
        "signIns",
      ]);
    for (const tab of saved.tabs)
      expect(Object.keys(tab).sort()).toEqual([
        "id",
        "pinned",
        "spaceId",
        "title",
        "url",
      ]);
    // A file that holds them anyway restores none of them.
    writeFileSync(path, JSON.stringify(original));
    const restored = readState(path, "darwin", "0.2.0");
    expect(restored.spaces).toEqual([
      {
        id: "personal",
        name: "Personal",
        color: "green",
        kind: "personal",
        owner: "human",
        signIns: "shared",
        createdAt: personal.createdAt,
      },
      {
        id: "work",
        name: "Work",
        color: "blue",
        kind: "personal",
        owner: "human",
        signIns: "shared",
        createdAt: work.createdAt,
      },
    ]);
    expect(restored.tabs.map((tab) => tab.url)).toEqual([
      "https://example.com/0",
      "https://example.com/1",
    ]);
    const runtime = [
      "label",
      "openedBy",
      "openerId",
      "managed",
      "createdAt",
      "unseen",
    ];
    for (const tab of restored.tabs)
      for (const field of runtime) expect(tab).not.toHaveProperty(field);
    // An invalid creation time becomes the time of the restore.
    writeFileSync(
      path,
      JSON.stringify({
        ...original,
        spaces: [{ ...personal, createdAt: "soon" }],
      }),
    );
    expect(readState(path, "darwin", "0.2.0").spaces[0].createdAt).toEqual(
      expect.any(Number),
    );
  });

  it("saves a kept space as a personal one without what the agent left on it", () => {
    const path = statePath();
    const original = initialState("darwin");
    original.spaces.push({
      id: "kept",
      name: "Kept task",
      color: "purple",
      kind: "personal",
      owner: "human",
      signIns: "separate",
      createdAt: 7,
      createdBy: "agent",
      pageBudget: 5,
    });
    const keptTab = {
      ...newTab("kept", "https://kept.example/"),
      label: "p2",
      openedBy: "agent" as const,
      managed: false,
    };
    original.tabs.push(keptTab);
    writeState(path, original);
    const restored = readState(path, "darwin", "0.2.0");
    expect(restored.spaces.find((space) => space.id === "kept")).toEqual({
      id: "kept",
      name: "Kept task",
      color: "purple",
      kind: "personal",
      owner: "human",
      signIns: "separate",
      createdAt: 7,
    });
    const tab = restored.tabs.find((item) => item.id === keptTab.id)!;
    expect(tab).toMatchObject({ spaceId: "kept", url: "https://kept.example/" });
    for (const field of ["label", "openedBy", "managed"])
      expect(tab).not.toHaveProperty(field);
  });

  it("never saves requests for a space", () => {
    const path = statePath();
    const original = initialState("darwin");
    original.spaceRequests.push({
      id: "request",
      reason: "Book a table",
      name: "Work",
      at: 5,
    });
    writeState(path, original);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("spaceRequests");
    expect(raw).not.toContain("Book a table");
    expect(readState(path, "darwin", "0.2.0").spaceRequests).toEqual([]);
  });

  it("starts one blank tab per personal space when session restoration is disabled", () => {
    const path = statePath();
    const original = initialState();
    original.settings.restoreSession = false;
    original.tabs[0].url = "https://example.com/";
    writeState(path, original);
    const restored = readState(path, "linux", "0.1.0");
    expect(restored.tabs).toHaveLength(restored.spaces.length);
    expect(restored.tabs.every((tab) => tab.url === "kamapathy://newtab")).toBe(
      true,
    );
    expect(restored.bookmarks).toEqual(original.bookmarks);
  });

  it("recovers from a missing or incomplete state file", () => {
    const path = statePath();
    expect(readState(path, "linux", "0.1.0").spaces).toHaveLength(2);
    writeFileSync(path, '{"tabs": [');
    const restored = readState(path, "linux", "0.1.0");
    expect(restored.tabs).toHaveLength(2);
    expect(restored.tabs.some((tab) => tab.id === restored.activeTabId)).toBe(
      true,
    );
  });

  it("rejects unsafe restored URLs and invalid settings", () => {
    const path = statePath();
    const original = initialState();
    original.tabs[0].url = "file:///etc/passwd";
    original.tabs[1].url = "https://user:secret@example.com/";
    writeFileSync(
      path,
      JSON.stringify({
        ...original,
        settings: { theme: "invalid", automationEnabled: "yes" },
      }),
    );
    const restored = readState(path, "linux", "0.1.0");
    expect(restored.tabs.every((tab) => tab.url === "kamapathy://newtab")).toBe(
      true,
    );
    expect(restored.settings.theme).toBe("system");
    expect(restored.settings.automationEnabled).toBe(true);
  });

  it("keeps agent access off for a person who turned it off", () => {
    const path = statePath();
    const original = initialState();
    original.settings.automationEnabled = false;
    writeState(path, original);
    expect(readState(path, "linux", "0.1.0").settings.automationEnabled).toBe(
      false,
    );
  });
});
