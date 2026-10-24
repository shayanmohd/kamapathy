import { describe, expect, it } from "vitest";
import {
  createTabLog,
  TAB_LOG_ENTRIES,
  watchPopups,
  type TabLogEntry,
} from "../electron/agent/tab-log";
import { FakeController } from "./fake-automation";

const denied = (origin: string) => ({ origin, permission: "location" });

describe("agent tab log", () => {
  it("keeps the last 200 entries per tab with rising seq numbers, answers since(seq) and forgets a closed tab", () => {
    let clock = 1000;
    const log = createTabLog({ now: () => clock });
    expect(log.seq("t1")).toBe(0);
    expect(log.since("t1", 0)).toEqual([]);
    for (let index = 1; index <= TAB_LOG_ENTRIES + 50; index += 1) {
      clock = 1000 + index;
      log.append("t1", "permission_denied", denied(`https://${index}.test`));
    }
    const entries = log.since("t1", 0);
    expect(entries).toHaveLength(TAB_LOG_ENTRIES);
    expect(entries[0].seq).toBe(51);
    expect(entries[0].at).toBe(1051);
    expect(entries.at(-1)!.seq).toBe(250);
    expect(log.seq("t1")).toBe(250);
    // Nothing repeats a seq, so a receipt's range stays exact.
    expect(new Set(entries.map((entry) => entry.seq)).size).toBe(
      TAB_LOG_ENTRIES,
    );
    expect(log.since("t1", 248).map((entry) => entry.seq)).toEqual([249, 250]);
    expect(log.since("t1", 250)).toEqual([]);

    // Each tab counts on its own, and kinds narrow a read.
    log.append("t2", "popup", {
      tabId: "t3",
      label: "p2",
      openerId: "t2",
      url: "https://example.com/popup",
    });
    log.append("t2", "permission_denied", denied("https://example.com"));
    expect(log.seq("t2")).toBe(2);
    expect(log.since("t2", 0, ["popup"]).map((entry) => entry.kind)).toEqual([
      "popup",
    ]);
    expect(
      log.since("t1", 0).every((entry) => entry.kind === "permission_denied"),
    ).toBe(true);

    log.forget("t1");
    expect(log.since("t1", 0)).toEqual([]);
    expect(log.seq("t1")).toBe(0);
    expect(log.seq("t2")).toBe(2);
  });

  it("tells listeners about each entry until they unsubscribe", () => {
    const log = createTabLog();
    const seen: { tabId: string; entry: TabLogEntry }[] = [];
    const stop = log.on((tabId, entry) => seen.push({ tabId, entry }));
    const first = log.append("t1", "file_chooser", {
      id: "c1",
      multiple: false,
    });
    expect(seen).toEqual([{ tabId: "t1", entry: first }]);
    stop();
    log.append("t1", "file_chooser", { id: "c2", multiple: true });
    expect(seen).toHaveLength(1);
  });

  it("logs a popup on its opener with its label, never on the popup's own tab, and nothing for a tab the person opened", async () => {
    const controller = new FakeController();
    const log = createTabLog();
    const stop = watchPopups(log, controller.registry, () => controller.state);
    const space = controller.createAgentSpace("Research");
    const opener = controller.state.tabs.find(
      (tab) => tab.spaceId === space.id,
    )!;
    const popup = controller.openPopup(opener.id, "https://example.com/popup");
    // The controller registers a popup before it joins the state, so its URL
    // lands on the entry as soon as the tab is there.
    await Promise.resolve();
    expect(log.since(opener.id, 0)).toEqual([
      {
        seq: 1,
        kind: "popup",
        at: expect.any(Number),
        data: {
          tabId: popup.id,
          label: popup.label,
          openerId: opener.id,
          url: "https://example.com/popup",
        },
      },
    ]);
    expect(popup.label).toBe("p2");
    expect(log.since(popup.id, 0)).toEqual([]);

    // A tab the person opened, and a popup in a personal space, log nothing.
    controller.openPersonTab(space.id, "https://example.com/person");
    const personal = controller.state.tabs.find(
      (tab) => tab.spaceId === "personal",
    )!;
    controller.openPopup(personal.id, "https://example.com/personal-popup");
    await Promise.resolve();
    expect(log.seq(opener.id)).toBe(1);
    expect(log.seq(personal.id)).toBe(0);

    stop();
    controller.openPopup(opener.id, "https://example.com/second");
    await Promise.resolve();
    expect(log.seq(opener.id)).toBe(1);
  });
});
