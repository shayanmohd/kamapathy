import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReceipts,
  REQUEST_WINDOW_MS,
  SETTLE_MS,
  type ReceiptFields,
} from "../electron/agent/receipts";
import { createTabLog, watchPopups } from "../electron/agent/tab-log";
import type { Tab } from "../shared/types";
import { FakeController } from "./fake-automation";

// Receipts over the fake controller, without the socket: the log, the
// settle and the request window as a route sees them.
function setup() {
  const controller = new FakeController();
  const tabLog = createTabLog();
  const stopPopups = watchPopups(
    tabLog,
    controller.registry,
    () => controller.state,
  );
  const signals: string[] = [];
  const receipts = createReceipts({
    tabLog,
    controller,
    prompts: {
      routeStarted: (tabId) => signals.push(`start ${tabId}`),
      routeEnded: (tabId) => signals.push(`end ${tabId}`),
    },
  });
  const space = controller.createAgentSpace("Research");
  const tab = controller.state.tabs.find((item) => item.spaceId === space.id)!;
  return {
    controller,
    tabLog,
    receipts,
    signals,
    space,
    tab,
    other: controller.openAgentTab(space.id, "https://example.com/other"),
    stop: stopPopups,
    popupOf: (openerId: string) =>
      controller.state.tabs.filter((item) => item.openerId === openerId),
  };
}
// A route with nothing to settle for, as the input routes run it.
const act = async (
  receipts: ReturnType<typeof createReceipts>,
  tabId: string,
  work: () => void = () => {},
) => {
  const done = receipts.with(tabId, async () => {
    work();
    return { ok: true as const };
  });
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  return (await done) as { ok: true } & ReceiptFields;
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("agent action receipts", () => {
  it("receipts list only this tab's popups, labeled", async () => {
    const { receipts, controller, tab, other, popupOf } = setup();
    const result = await act(receipts, tab.id, () => {
      controller.openPopup(tab.id, "https://example.com/mine");
      controller.openPopup(other.id, "https://example.com/theirs");
    });
    const mine = popupOf(tab.id)[0];
    expect(result).toEqual({
      ok: true,
      popups: [
        { id: mine.id, label: mine.label, url: "https://example.com/mine" },
      ],
    });

    // A popup this tab opens on a timer inside the window still counts.
    const done = receipts.with(tab.id, async () => {
      setTimeout(
        () => controller.openPopup(tab.id, "https://example.com/later"),
        20,
      );
      return { ok: true as const };
    });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    const later = popupOf(tab.id).at(-1)!;
    expect(((await done) as ReceiptFields).popups).toEqual([
      { id: later.id, label: later.label, url: "https://example.com/later" },
    ]);
    // Nothing is reported twice.
    expect(await act(receipts, tab.id)).toEqual({ ok: true });
  });

  it("names a closed popup from the log and reports the live URL of an open one", async () => {
    const { receipts, controller, tab } = setup();
    const done = receipts.with(tab.id, async () => {
      const gone = controller.openPopup(tab.id, "https://example.com/gone");
      const open = controller.openPopup(tab.id, "https://example.com/open");
      await Promise.resolve();
      controller.closeTab(gone.id, "page");
      // The page that stayed open has moved on since it was logged.
      controller.state.tabs.find((item) => item.id === open.id)!.url =
        "https://example.com/moved";
      return { ok: true as const, gone: gone.id, open: open.id };
    });
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    const result = await done;
    expect(result.popups).toEqual([
      { id: result.gone, label: "p3", url: "https://example.com/gone" },
      { id: result.open, label: "p4", url: "https://example.com/moved" },
    ]);
  });

  it("a receipt waits 50 ms after the last page step, nothing when the route already waited, and nothing at all for raw input", async () => {
    const { receipts, tab } = setup();
    let settled = false;
    const plain = receipts
      .with(tab.id, async () => ({ ok: true as const }))
      .then((value) => {
        settled = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(await plain).toEqual({ ok: true });

    // A route that waited after its own page step settles at once.
    let waited = false;
    const waiting = receipts
      .with(tab.id, async (scope) => {
        scope.step();
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS + 10));
        return { ok: true as const };
      })
      .then((value) => {
        waited = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 10);
    expect(waited).toBe(true);
    expect(await waiting).toEqual({ ok: true });

    // Raw input adds no wait at all.
    let raw = false;
    const rawInput = receipts
      .with(tab.id, async () => ({ ok: true as const }), { settleMs: 0 })
      .then((value) => {
        raw = true;
        return value;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(raw).toBe(true);
    expect(await rawInput).toEqual({ ok: true });
  });

  it("deniedRequests reports each origin and permission once between receipts", async () => {
    const { receipts, tabLog, tab, other } = setup();
    const denied = (origin: string, permission: string) =>
      receipts.reportDenied(tab.id, { origin, permission });
    expect(denied("https://a.test", "location")).toBe(true);
    expect(denied("https://a.test", "location")).toBe(false);
    expect(denied("https://a.test", "camera")).toBe(true);
    expect(denied("https://b.test", "location")).toBe(true);
    expect(
      receipts.reportDenied(other.id, {
        origin: "https://a.test",
        permission: "location",
      }),
    ).toBe(true);
    expect(tabLog.since(tab.id, 0, ["permission_denied"])).toHaveLength(3);

    expect((await act(receipts, tab.id)).deniedRequests).toEqual([
      { origin: "https://a.test", permission: "location" },
      { origin: "https://a.test", permission: "camera" },
      { origin: "https://b.test", permission: "location" },
    ]);
    // Reported pairs leave the set, so the next refusal is reported again.
    expect(await act(receipts, tab.id)).toEqual({ ok: true });
    expect(denied("https://a.test", "location")).toBe(true);
    expect((await act(receipts, tab.id)).deniedRequests).toEqual([
      { origin: "https://a.test", permission: "location" },
    ]);
    // Another tab's refusals stay on that tab.
    expect((await act(receipts, other.id)).deniedRequests).toEqual([
      { origin: "https://a.test", permission: "location" },
    ]);
  });

  it("reports the first logged dialog, counts the rest and names the download the action started", async () => {
    const { receipts, tabLog, tab } = setup();
    const dialog = (message: string) =>
      tabLog.append(tab.id, "dialog", {
        type: "confirm" as const,
        message,
        answer: "dismissed" as const,
        url: "https://example.com/",
      });
    const result = await act(receipts, tab.id, () => {
      dialog("Leave this page?");
      dialog("Really?");
      dialog("Last chance");
      tabLog.append(tab.id, "download", {
        id: "d1",
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
      });
      tabLog.append(tab.id, "download", {
        blocked: true as const,
        url: "https://example.com/other.pdf",
        suggestedFilename: "other.pdf",
      });
    });
    expect(result).toEqual({
      ok: true,
      dialog: {
        type: "confirm",
        message: "Leave this page?",
        answer: "dismissed",
        url: "https://example.com/",
      },
      moreDialogs: 2,
      download: {
        id: "d1",
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
      },
    });
    // One dialog alone carries no count.
    const single = await act(receipts, tab.id, () => dialog("Only one"));
    expect(single.moreDialogs).toBeUndefined();
    expect(single.dialog?.message).toBe("Only one");
    const blocked = await act(receipts, tab.id, () =>
      tabLog.append(tab.id, "download", {
        blocked: true as const,
        url: "https://example.com/blocked.zip",
        suggestedFilename: "blocked.zip",
      }),
    );
    expect(blocked.download).toEqual({
      blocked: true,
      url: "https://example.com/blocked.zip",
      suggestedFilename: "blocked.zip",
    });
  });

  it("reporting a popup clears its unseen flag and reading the log leaves it set", async () => {
    const { receipts, controller, tab, popupOf } = setup();
    const unseen = (id: string) =>
      controller.state.tabs.find((item) => item.id === id)?.unseen;
    let popup!: Tab;
    const done = receipts.with(tab.id, async () => {
      popup = controller.openPopup(tab.id, "https://example.com/popup");
      return { ok: true as const };
    });
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
    // Listing the tab, or the log, leaves the flag for the receipt.
    expect(popupOf(tab.id).map((item) => item.unseen)).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await done) as ReceiptFields).popups).toHaveLength(1);
    expect(unseen(popup.id)).toBeUndefined();
  });

  it("opens the tab's request window at route entry and closes it 5000 ms after the route ends, failures included", async () => {
    const { receipts, signals, tabLog, tab, other } = setup();
    expect(receipts.inWindow(tab.id)).toBe(false);
    let finish!: () => void;
    const done = receipts.with(
      tab.id,
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finish = () => resolve({ ok: true });
        }),
    );
    expect(receipts.inWindow(tab.id)).toBe(true);
    expect(receipts.inWindow(other.id)).toBe(false);
    expect(signals).toEqual([`start ${tab.id}`]);
    finish();
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(await done).toEqual({ ok: true });
    expect(signals).toEqual([`start ${tab.id}`, `end ${tab.id}`]);

    // The window outlives the route by five seconds.
    await vi.advanceTimersByTimeAsync(REQUEST_WINDOW_MS - 1);
    expect(receipts.inWindow(tab.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(receipts.inWindow(tab.id)).toBe(false);

    // A route that fails opens and closes the window the same way.
    const failed = receipts.with(tab.id, async () => {
      throw new Error("page gone");
    });
    expect(receipts.inWindow(tab.id)).toBe(true);
    await expect(failed).rejects.toThrow("page gone");
    expect(signals.at(-1)).toBe(`end ${tab.id}`);
    expect(receipts.inWindow(tab.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(REQUEST_WINDOW_MS);
    expect(receipts.inWindow(tab.id)).toBe(false);

    // A second route extends the window instead of opening another.
    await act(receipts, tab.id);
    await vi.advanceTimersByTimeAsync(REQUEST_WINDOW_MS - 10);
    await act(receipts, tab.id);
    await vi.advanceTimersByTimeAsync(REQUEST_WINDOW_MS - 10);
    expect(receipts.inWindow(tab.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(10);
    expect(receipts.inWindow(tab.id)).toBe(false);

    // A closed tab leaves nothing behind, as the server forgets both.
    receipts.reportDenied(tab.id, {
      origin: "https://a.test",
      permission: "midi",
    });
    tabLog.forget(tab.id);
    receipts.forget(tab.id);
    expect((await act(receipts, tab.id)).deniedRequests).toBeUndefined();
  });
});
