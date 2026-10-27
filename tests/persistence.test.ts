import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOME_URL, initialState, newTab } from "../shared/state";
import type { UpdateRelease } from "../shared/types";
import { readState, validSettings, writeState } from "../electron/persistence";

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
  it("agentPageScripts defaults to true and restores", () => {
    const path = statePath();
    const original = initialState();
    expect(original.settings.agentPageScripts).toBe(true);
    const stored = (agentPageScripts: unknown) =>
      JSON.stringify({
        ...original,
        settings: { ...original.settings, agentPageScripts },
      });
    writeFileSync(path, stored(false));
    expect(readState(path, "darwin", "0.2.0").settings.agentPageScripts).toBe(
      false,
    );
    for (const value of ["off", 0, null, undefined]) {
      writeFileSync(path, stored(value));
      expect(
        readState(path, "darwin", "0.2.0").settings.agentPageScripts,
        JSON.stringify(value ?? null),
      ).toBe(true);
    }
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

  it("writes no file tabs", () => {
    const path = statePath();
    const original = initialState("darwin");
    const [blank, workTab] = original.tabs;
    const report = newTab(
      "personal",
      "file:///Users/someone/private/report.pdf",
    );
    original.tabs.push(report);
    original.activeTabId = report.id;
    // A space showing only a file has no tab left to save.
    workTab.url = "file:///Users/someone/private/notes.html";
    workTab.title = "notes.html";
    writeState(path, original);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("file:");
    expect(raw).not.toContain("report.pdf");
    expect(raw).not.toContain("notes.html");
    const saved = JSON.parse(raw);
    expect(saved.tabs.map((tab: { id: string }) => tab.id)).toEqual([blank.id]);
    expect(saved.activeTabId).toBe(blank.id);
    const restored = readState(path, "darwin", "0.2.0");
    expect(restored.activeTabId).toBe(blank.id);
    expect(restored.tabs.filter((tab) => tab.spaceId === "work")).toMatchObject(
      [{ url: HOME_URL }],
    );
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

  it("approvals are never saved or restored", () => {
    const path = statePath();
    const original = initialState("darwin");
    expect(original.approvals).toEqual([]);
    original.approvals.push({
      id: "approval",
      spaceId: "personal",
      tabId: original.tabs[0].id,
      origin: "https://approval-shop.example",
      cookies: { count: 2, domains: ["approval-shop.example"] },
      storage: ["localStorage"],
      cache: true,
    });
    writeState(path, original);
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw)).not.toHaveProperty("approvals");
    expect(raw).not.toContain("approval-shop.example");
    expect(readState(path, "darwin", "0.2.0").approvals).toEqual([]);
    // A file that holds them anyway restores none.
    writeFileSync(path, JSON.stringify(original));
    expect(readState(path, "darwin", "0.2.0").approvals).toEqual([]);
  });

  it("the setting defaults on and prompts are never written", () => {
    const path = statePath();
    expect(initialState().settings.offerToSavePasswords).toBe(true);
    // A file saved before the setting existed.
    const original = initialState("darwin");
    const { offerToSavePasswords: _, ...older } = original.settings;
    writeFileSync(path, JSON.stringify({ ...original, settings: older }));
    expect(
      readState(path, "darwin", "0.2.0").settings.offerToSavePasswords,
    ).toBe(true);
    original.settings.offerToSavePasswords = false;
    writeState(path, original);
    expect(
      readState(path, "darwin", "0.2.0").settings.offerToSavePasswords,
    ).toBe(false);
    writeFileSync(
      path,
      JSON.stringify({
        ...original,
        settings: { ...original.settings, offerToSavePasswords: "no" },
      }),
    );
    expect(
      readState(path, "darwin", "0.2.0").settings.offerToSavePasswords,
    ).toBe(true);
    original.passwordPrompts = [
      {
        id: "save-prompt",
        tabId: original.tabs[0].id,
        kind: "save",
        host: "prompt-host.example",
        username: "prompt-user@example.com",
      },
      {
        id: "update-prompt",
        tabId: original.tabs[1].id,
        kind: "update",
        host: "prompt-host.example",
        username: "prompt-user@example.com",
      },
    ];
    writeState(path, original);
    const raw = readFileSync(path, "utf8");
    expect(JSON.parse(raw)).not.toHaveProperty("passwordPrompts");
    expect(raw).not.toContain("prompt-user");
    expect(readState(path, "darwin", "0.2.0").passwordPrompts).toEqual([]);
    // A file that holds them anyway restores none.
    writeFileSync(path, JSON.stringify(original));
    expect(readState(path, "darwin", "0.2.0").passwordPrompts).toEqual([]);
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

  it("restores extension pages in personal spaces", () => {
    const path = statePath();
    const original = initialState();
    const id = "abcdefghijklmnopabcdefghijklmnop";
    const kept = [
      `chrome-extension://${id}/x.html`,
      `chrome-extension://${id}/options/index.html?tab=general#top`,
      `chrome-extension://${id}/`,
    ];
    const dropped = [
      "chrome-extension://bad/",
      `chrome-extension://${id.replace("a", "q")}/x.html`,
      `chrome-extension://${id}`,
      `chrome-extension://user:secret@${id}/x.html`,
      `CHROME-EXTENSION://${id}/x.html`,
      "chrome://extensions/",
      "chrome-untrusted://print/",
      "javascript:alert(1)",
    ];
    original.tabs = [...kept, ...dropped].map((url, index) => ({
      ...newTab(index % 2 ? "work" : "personal", url),
      title: `Page ${index}`,
    }));
    writeState(path, original);
    const restored = readState(path, "darwin", "0.2.0");
    expect(restored.tabs.map((tab) => [tab.url, tab.title])).toEqual(
      kept.map((url, index) => [url, `Page ${index}`]),
    );
  });

  it("restores valid site permissions only", () => {
    const path = statePath();
    const valid = [
      {
        spaceId: "personal",
        origin: "https://maps.example",
        permission: "geolocation",
        allow: true,
        at: 10,
      },
      {
        spaceId: "work",
        origin: "http://localhost:8080",
        permission: "notifications",
        allow: false,
        at: 11,
      },
    ];
    const invalid = [
      // A space that is not restored, an origin with a path, a scheme the
      // browser never asks for, an unknown key, and bad types.
      {
        spaceId: "gone",
        origin: "https://a.example",
        permission: "camera",
        allow: true,
        at: 12,
      },
      {
        spaceId: "personal",
        origin: "https://a.example/maps",
        permission: "camera",
        allow: true,
        at: 13,
      },
      {
        spaceId: "personal",
        origin: "file:///etc",
        permission: "camera",
        allow: true,
        at: 14,
      },
      {
        spaceId: "personal",
        origin: "https://b.example",
        permission: "pet-door",
        allow: true,
        at: 15,
      },
      {
        spaceId: "personal",
        origin: "https://c.example",
        permission: "camera",
        allow: "yes",
        at: 16,
      },
      {
        spaceId: "personal",
        origin: "https://d.example",
        permission: "camera",
        allow: true,
        at: "soon",
      },
      null,
    ];
    writeFileSync(
      path,
      JSON.stringify({
        ...initialState("darwin"),
        sitePermissions: [...valid, ...invalid],
      }),
    );
    expect(readState(path, "darwin", "0.2.0").sitePermissions).toEqual(valid);
    writeFileSync(
      path,
      JSON.stringify({ ...initialState("darwin"), sitePermissions: "all" }),
    );
    expect(readState(path, "darwin", "0.2.0").sitePermissions).toEqual([]);
  });

  it("saves site permissions, never prompts, and keeps the newest 1000", () => {
    const path = statePath();
    const original = initialState("darwin");
    original.spaces.push({
      id: "agent-task",
      name: "Agent task",
      color: "purple",
      kind: "agent",
      owner: "agent",
      signIns: "shared",
      createdAt: 1,
    });
    original.sitePermissions = [
      ...Array.from({ length: 1001 }, (_, index) => ({
        spaceId: "personal",
        origin: `https://site-${index}.example`,
        permission: "notifications" as const,
        allow: true,
        at: index,
      })),
      {
        spaceId: "agent-task",
        origin: "https://agent.example",
        permission: "geolocation",
        allow: true,
        at: 2000,
      },
    ];
    original.prompts.push({
      id: "prompt",
      spaceId: "personal",
      tabId: original.tabs[0].id,
      kind: "location",
      origin: "https://asking.example",
      at: 3,
      agent: false,
    });
    writeState(path, original);
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain("asking.example");
    expect(raw).not.toContain("agent.example");
    const saved = JSON.parse(raw);
    expect(saved.sitePermissions).toHaveLength(1000);
    expect(saved.sitePermissions[0].origin).toBe("https://site-1.example");
    const restored = readState(path, "darwin", "0.2.0");
    expect(restored.sitePermissions).toHaveLength(1000);
    expect(restored.prompts).toEqual([]);
  });

  it("never saves task, crashed or agent text, and restores the background notice", () => {
    const path = statePath();
    const original = initialState("darwin");
    const [personal, work] = original.spaces;
    Object.assign(personal, {
      owner: "agent",
      access: "granted",
      task: {
        status: "Comparing prices",
        state: "done",
        label: { text: "Open the cart", active: true, at: 4 },
        changedAt: 5,
      },
    });
    work.name = "\u200e\u202a";
    Object.assign(original.tabs[0], {
      url: "https://example.com/0",
      crashed: true,
    });
    original.activity.push({
      id: "entry",
      spaceId: personal.id,
      message: "Agent finished",
      time: 6,
      kind: "success",
      agentText: "Comparing prices",
    });
    original.settings.backgroundNoticeShown = true;
    writeState(path, original);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    for (const space of saved.spaces) expect(space).not.toHaveProperty("task");
    for (const tab of saved.tabs) expect(tab).not.toHaveProperty("crashed");
    expect(saved).not.toHaveProperty("activity");
    expect(saved.settings.backgroundNoticeShown).toBe(true);
    // A file that holds them anyway restores none of them.
    writeFileSync(path, JSON.stringify(original));
    const restored = readState(path, "darwin", "0.2.0");
    for (const space of restored.spaces)
      expect(space).not.toHaveProperty("task");
    for (const tab of restored.tabs) expect(tab).not.toHaveProperty("crashed");
    expect(restored.activity).toEqual([]);
    // A saved name of nothing but bidirectional marks keeps its space.
    expect(restored.spaces.map((space) => space.name)).toEqual([
      "Personal",
      "Untitled space",
    ]);
    expect(restored.settings.backgroundNoticeShown).toBe(true);
    writeFileSync(
      path,
      JSON.stringify({
        ...original,
        settings: { ...original.settings, backgroundNoticeShown: "yes" },
      }),
    );
    expect(
      readState(path, "darwin", "0.2.0").settings.backgroundNoticeShown,
    ).toBe(false);
    expect(initialState().settings.backgroundNoticeShown).toBe(false);
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

  it("keeps update checks on unless saved off", () => {
    const path = statePath();
    expect(initialState().settings.updateChecks).toBe(true);
    expect(readState(path, "darwin", "0.2.0").settings.updateChecks).toBe(true);
    const original = initialState();
    const { updateChecks: _checks, ...older } = original.settings;
    writeFileSync(path, JSON.stringify({ ...original, settings: older }));
    expect(readState(path, "darwin", "0.2.0").settings.updateChecks).toBe(true);
    original.settings.updateChecks = false;
    writeState(path, original);
    expect(JSON.parse(readFileSync(path, "utf8")).settings.updateChecks).toBe(
      false,
    );
    expect(readState(path, "darwin", "0.2.0").settings.updateChecks).toBe(
      false,
    );
    for (const value of ["false", 0, null, {}]) {
      writeFileSync(
        path,
        JSON.stringify({
          ...original,
          settings: { ...original.settings, updateChecks: value },
        }),
      );
      expect(
        readState(path, "darwin", "0.2.0").settings.updateChecks,
        JSON.stringify(value),
      ).toBe(true);
    }
  });

  it("sets seenVersion for fresh and older profiles", () => {
    const path = statePath();
    // A fresh profile has seen this version, so it shows only Welcome.
    expect(readState(path, "darwin", "1.4.0").settings.seenVersion).toBe(
      "1.4.0",
    );
    const original = initialState();
    const { seenVersion: _seen, ...older } = original.settings;
    const seen = (settings: object) => {
      writeFileSync(path, JSON.stringify({ ...original, settings }));
      return readState(path, "darwin", "1.4.0").settings.seenVersion;
    };
    // A profile from before What's new has seen none of it.
    expect(seen({ ...older, welcomed: true })).toBe("0.0.0");
    expect(seen({ ...older, welcomed: false })).toBe("1.4.0");
    expect(seen(older)).toBe("1.4.0");
    expect(seen({ ...older, welcomed: true, seenVersion: "1.2.10" })).toBe(
      "1.2.10",
    );
    expect(seen({ ...older, welcomed: false, seenVersion: "0.9.0" })).toBe(
      "0.9.0",
    );
    expect(seen({ ...older, welcomed: true, seenVersion: "1.4.0" })).toBe(
      "1.4.0",
    );
    // A downgrade resets silently, comparing numbers rather than text.
    expect(seen({ ...older, welcomed: true, seenVersion: "1.10.0" })).toBe(
      "1.4.0",
    );
    for (const invalid of ["v1.2.0", "1.2", "1.2.3-beta", "", 120, null]) {
      const label = JSON.stringify(invalid);
      expect(
        seen({ ...older, welcomed: true, seenVersion: invalid }),
        label,
      ).toBe("0.0.0");
      expect(
        seen({ ...older, welcomed: false, seenVersion: invalid }),
        label,
      ).toBe("1.4.0");
    }
    // Closing Welcome sends only welcomed, which leaves seenVersion alone.
    const settings = { ...original.settings, seenVersion: "1.4.0" };
    expect(validSettings({ welcomed: true }, settings)).toEqual({
      ...settings,
      welcomed: true,
    });
  });

  it("drops a malformed update record", () => {
    const path = statePath();
    const folder = "https://github.com/shayanmohd/kamapathy/releases";
    const latest: UpdateRelease = {
      version: "0.3.0",
      publishedAt: Date.parse("2026-10-01T12:00:00Z"),
      url: `${folder}/tag/v0.3.0`,
      installer: {
        name: "Kamapathy-0.3.0-mac-arm64.dmg",
        size: 2 * 1048576,
        url: `${folder}/download/v0.3.0/Kamapathy-0.3.0-mac-arm64.dmg`,
        sha256: "0123456789abcdef".repeat(4),
      },
      sums: `${folder}/download/v0.3.0/SHA256SUMS.txt`,
    };
    const checkedAt = Date.parse("2026-10-15T08:00:00Z");
    const none = { kind: "other", state: "unsupported" };
    const original = initialState("darwin");
    expect(original.update).toEqual(none);
    original.update = {
      kind: "mac-arm64",
      state: "ready",
      checkedAt,
      latest,
      progress: { receivedBytes: 5, totalBytes: 5 },
      installer: { path: "/tmp/kamapathy-update.dmg", sha256: "f".repeat(64) },
      error: { code: "update_check_failed", message: "Offline." },
    };
    writeState(path, original);
    // Only the last check's result is saved, and only it comes back.
    expect(JSON.parse(readFileSync(path, "utf8")).update).toEqual({
      checkedAt,
      latest,
    });
    expect(readState(path, "darwin", "0.2.0").update).toEqual({
      ...none,
      checkedAt,
      latest,
    });
    const restore = (update: unknown) => {
      writeFileSync(path, JSON.stringify({ ...original, update }));
      return readState(path, "darwin", "0.2.0").update;
    };
    expect(
      restore({
        ...original.update,
        latest: {
          ...latest,
          notes: "Release text",
          installer: { ...latest.installer, path: "/tmp/elsewhere" },
        },
      }),
    ).toEqual({ ...none, checkedAt, latest });
    // A release without a digest still counts.
    const { sha256: _digest, ...plain } = latest.installer;
    expect(restore({ latest: { ...latest, installer: plain } })).toEqual({
      ...none,
      latest: { ...latest, installer: plain },
    });
    for (const update of [undefined, null, "ready", 5, true, [latest]])
      expect(restore(update), JSON.stringify(update)).toEqual(none);
    for (const time of [String(checkedAt), 0, -1, null, {}])
      expect(
        restore({ checkedAt: time, latest }),
        JSON.stringify(time),
      ).toEqual({ ...none, latest });
    const http = (url: string) => url.replace("https:", "http:");
    const installer = (fields: object) => ({
      ...latest,
      installer: { ...latest.installer, ...fields },
    });
    for (const release of [
      "0.3.0",
      null,
      { ...latest, version: "v0.3.0" },
      { ...latest, version: "0.3" },
      { ...latest, version: undefined },
      { ...latest, publishedAt: "2026-10-01T12:00:00Z" },
      { ...latest, url: http(latest.url) },
      { ...latest, url: "https://" },
      { ...latest, url: `${folder}/tag/v0.3.0?${"a".repeat(2048)}` },
      { ...latest, sums: http(latest.sums) },
      { ...latest, sums: undefined },
      { ...latest, installer: undefined },
      { ...latest, installer: "Kamapathy-0.3.0-mac-arm64.dmg" },
      installer({ url: http(latest.installer.url) }),
      installer({ sha256: "0123456789abcdef".repeat(4).slice(1) }),
      installer({ sha256: "0123456789ABCDEF".repeat(4) }),
      installer({ sha256: null }),
      installer({ size: 1048575 }),
      installer({ size: 1073741825 }),
      installer({ size: 1048576.5 }),
      installer({ size: "2097152" }),
      installer({ name: "updates/Kamapathy-0.3.0-mac-arm64.dmg" }),
      installer({ name: "Kamapathy 0.3.0.dmg" }),
      installer({ name: "" }),
      installer({ name: "a".repeat(256) }),
    ])
      expect(
        restore({ checkedAt, latest: release }),
        JSON.stringify(release)?.slice(0, 200),
      ).toEqual({ ...none, checkedAt });
  });

  it("both new extension settings validate", () => {
    const path = statePath();
    const original = initialState();
    expect(original.settings.extensionUpdates).toBe(true);
    expect(original.settings.extensionDeveloperMode).toBe(false);
    const { extensionUpdates, extensionDeveloperMode, ...older } =
      original.settings;
    writeFileSync(path, JSON.stringify({ ...original, settings: older }));
    // readState records the running version it was given as seenVersion.
    expect(readState(path, "linux", "0.1.0").settings).toEqual({
      ...original.settings,
      seenVersion: "0.1.0",
    });
    writeFileSync(
      path,
      JSON.stringify({
        ...original,
        settings: {
          ...original.settings,
          extensionUpdates: "no",
          extensionDeveloperMode: 1,
        },
      }),
    );
    expect(readState(path, "linux", "0.1.0").settings).toMatchObject({
      extensionUpdates: true,
      extensionDeveloperMode: false,
    });
    original.settings.extensionUpdates = false;
    original.settings.extensionDeveloperMode = true;
    writeState(path, original);
    expect(readState(path, "linux", "0.1.0").settings).toMatchObject({
      extensionUpdates: false,
      extensionDeveloperMode: true,
    });
  });
});
