import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthority } from "../electron/agent/authority";
import { createDialogs } from "../electron/agent/dialogs";
import type { ApiError } from "../electron/agent/errors";
import { createExpectations } from "../electron/agent/expectations";
import type { Run } from "../electron/agent/http";
import {
  createReceipts,
  REQUEST_WINDOW_MS,
  SETTLE_MS,
  type ReceiptFields,
} from "../electron/agent/receipts";
import type { TabSession } from "../electron/agent/session/tab-session";
import { createTabLog, watchPopups } from "../electron/agent/tab-log";
import { expectationFields } from "../electron/agent/validate";
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

  it("receipts report the first dialog and count the rest", async () => {
    const { controller, tabLog, receipts, tab } = setup();
    // dialogs.ts records what Kamapathy answered; the receipt reads the log.
    const dialogs = createDialogs({
      tabLog,
      controller,
      sessions: { get: () => undefined },
    });
    const url = "https://example.com/";
    const result = await act(receipts, tab.id, () => {
      dialogs.record(tab.id, {
        type: "confirm",
        message: "Delete this file?",
        answer: "accepted",
        url,
      });
      dialogs.record(tab.id, {
        type: "alert",
        message: "Saved",
        answer: "accepted",
        url,
      });
      // Section 6's leave guard counts like any other answered dialog.
      dialogs.record(tab.id, {
        type: "beforeunload",
        message: "",
        answer: "accepted",
        url,
      });
    });
    expect(result.dialog).toEqual({
      type: "confirm",
      message: "Delete this file?",
      answer: "accepted",
      url,
    });
    expect(result.moreDialogs).toBe(2);
    // The same three are the last of page.dialogs(), newest last.
    expect(dialogs.records(tab.id).map((record) => record.type)).toEqual([
      "confirm",
      "alert",
      "beforeunload",
    ]);
    // Nothing is reported twice.
    expect(await act(receipts, tab.id)).toEqual({ ok: true });
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

// A tab's debugger session, whose "closed" event ends a pending wait.
class FakeTabSession {
  private listeners = new Set<() => void>();
  on(name: string, listener: () => void) {
    if (name === "closed") this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close() {
    for (const listener of [...this.listeners]) listener();
  }
}
// The expectation registry over the same fake controller, with the real
// authority, so a takeover ends a wait exactly as it does in the server.
function arming() {
  const base = setup();
  const authority = createAuthority(base.controller);
  authority.managedSpaces.add(base.space.id);
  const sessions = new Map<string, FakeTabSession>();
  return {
    ...base,
    authority,
    expectations: createExpectations({
      tabLog: base.tabLog,
      controller: base.controller,
      authority,
      sessions: {
        get: (tabId) =>
          sessions.get(tabId) as unknown as TabSession | undefined,
      },
    }),
    sessionFor(tabId: string) {
      const session = new FakeTabSession();
      sessions.set(tabId, session);
      return session;
    },
  };
}
const fakeRun = (signal = new AbortController().signal): Run => ({
  deadline: Date.now() + 60000,
  signal,
  dispatch: { dispatched: false },
  park: (wait) => wait(),
});
// What task 5's DownloadView carries, as a wait answers with it.
const DOWNLOAD = {
  id: "d1",
  tabId: "",
  url: "https://example.com/report.pdf",
  suggestedFilename: "report.pdf",
  mimeType: "application/pdf",
  state: "completed",
  receivedBytes: 12,
  totalBytes: 12,
  failure: null,
};
const thrown = (run: () => unknown): ApiError => {
  try {
    run();
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("Nothing was thrown.");
};
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ resolved: value }) as Record<string, unknown>,
    (error: unknown) => {
      const api = error as ApiError;
      return { code: api.code, status: api.status, ...api.fields };
    },
  );

describe("agent event expectations", () => {
  it("a wait resolves with the first popup after arming", async () => {
    const { controller, expectations, tab } = arming();
    const arm = expectations.arm(tab, "popup", 10000);
    expect(arm).toMatchObject({
      event: "popup",
      tabId: tab.id,
      spaceId: tab.spaceId,
      fromSeq: 0,
      timeoutMs: 10000,
    });
    expect(arm.id).toMatch(/^[0-9a-f]{16}$/);
    const waiting = expectations.wait(arm, fakeRun());
    const first = controller.openPopup(tab.id, "https://example.com/first");
    const second = controller.openPopup(tab.id, "https://example.com/second");
    await vi.advanceTimersByTimeAsync(0);
    expect(await waiting).toEqual({
      popup: expect.objectContaining({
        id: first.id,
        label: first.label,
        url: "https://example.com/first",
        openerId: tab.id,
        managed: true,
      }),
    });
    // The result reports the popup, so a run's end never names it again.
    const live = (id: string) =>
      controller.state.tabs.find((item) => item.id === id);
    expect(live(first.id)?.unseen).toBeUndefined();
    expect(live(second.id)?.unseen).toBe(true);
    // One event uses the arm up.
    expect(expectations.get(arm.id)).toBeUndefined();
    expect(expectations.count()).toBe(0);
  });

  it("a wait times out naming awaited, event and timeoutMs", async () => {
    const { expectations, tab } = arming();
    const arm = expectations.arm(tab, "download", 5000);
    let settled = false;
    const waiting = rejection(expectations.wait(arm, fakeRun())).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await waiting).toEqual({
      code: "expectation_timeout",
      status: 504,
      awaited: "event",
      event: "download",
      timeoutMs: 5000,
    });
    // An arm that ran out is gone, so a late wait is not found instead.
    expect(expectations.get(arm.id)).toBeUndefined();
    expect(await rejection(expectations.wait(arm, fakeRun()))).toMatchObject({
      code: "expectation_not_found",
      status: 404,
    });
  });

  it("timeoutMs 0 is rejected with invalid_field", () => {
    expect(expectationFields({ event: "popup" })).toEqual({
      event: "popup",
      timeoutMs: 10000,
    });
    expect(
      expectationFields({ event: "filechooser", timeoutMs: 60000 }),
    ).toEqual({ event: "filechooser", timeoutMs: 60000 });
    for (const timeoutMs of [0, 60001, 1.5, "1000"])
      expect(thrown(() => expectationFields({ event: "popup", timeoutMs })))
        .toMatchObject({
          code: "invalid_field",
          status: 400,
          message: "timeoutMs must be an integer from 1 to 60000.",
        });
    expect(thrown(() => expectationFields({ event: "navigation" }))).toMatchObject({
      code: "invalid_field",
      message: "event must be popup, download, filechooser, or dialog.",
    });
  });

  it("one wait per event", () => {
    const { expectations, tab, other } = arming();
    const first = expectations.arm(tab, "popup", 10000);
    expect(thrown(() => expectations.arm(tab, "popup", 10000))).toMatchObject({
      code: "expectation_pending",
      status: 409,
      fields: { event: "popup", expectationId: first.id },
    });
    // Another event on the same page, and the same event on another page,
    // are armed side by side.
    expectations.arm(tab, "dialog", 10000);
    expectations.arm(other, "popup", 10000);
    expect(expectations.count()).toBe(3);
    // Cancelling frees the event again.
    expectations.end(first.id, "deleted");
    expect(expectations.arm(tab, "popup", 10000).id).not.toBe(first.id);
    expect(expectations.count()).toBe(3);
  });

  it("actions run during a wait", async () => {
    const { controller, expectations, receipts, tab } = arming();
    const arm = expectations.arm(tab, "popup", 10000);
    const waiting = expectations.wait(arm, fakeRun());
    // The wait holds no lane, so the action answers with its own receipt
    // while the wait is still pending, and the popup resolves both.
    const result = await act(receipts, tab.id, () =>
      controller.openPopup(tab.id, "https://example.com/opened"),
    );
    expect(result.popups).toHaveLength(1);
    expect(await waiting).toMatchObject({
      popup: { url: "https://example.com/opened" },
    });
  });

  it("a popup opened before the arm, and one opened by another tab, leave the wait waiting", async () => {
    const { controller, expectations, tab, other } = arming();
    controller.openPopup(tab.id, "https://example.com/early");
    const arm = expectations.arm(tab, "popup", 10000);
    expect(arm.fromSeq).toBe(1);
    let settled = false;
    const waiting = expectations.wait(arm, fakeRun()).then((value) => {
      settled = true;
      return value;
    });
    const theirs = controller.openPopup(other.id, "https://example.com/theirs");
    // A popup of a popup lands on its own opener's log, never higher up.
    controller.openPopup(theirs.id, "https://example.com/nested");
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    const mine = controller.openPopup(tab.id, "https://example.com/mine");
    await vi.advanceTimersByTimeAsync(0);
    expect(await waiting).toMatchObject({ popup: { id: mine.id } });
  });

  it("a takeover ends a pending wait with human_control, a tab close with tab_closed, and DELETE answers ok", async () => {
    const { controller, expectations, space, tab, sessionFor } = arming();
    const taken = expectations.arm(tab, "popup", 10000);
    const waiting = rejection(expectations.wait(taken, fakeRun()));
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    expect(await waiting).toMatchObject({
      code: "human_control",
      status: 409,
      spaceId: space.id,
      reason: "manual",
    });
    expect(expectations.count()).toBe(0);
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "agent",
    });

    // The tab's own session says when the page is gone.
    const session = sessionFor(tab.id);
    const closing = expectations.arm(tab, "popup", 10000);
    const closed = rejection(expectations.wait(closing, fakeRun()));
    session.close();
    expect(await closed).toMatchObject({ code: "tab_closed", status: 409 });

    // A cancelled arm answers the wait that was already running.
    const deleted = expectations.arm(tab, "download", 10000);
    const cancelled = rejection(expectations.wait(deleted, fakeRun()));
    expectations.end(deleted.id, "deleted");
    expect(await cancelled).toMatchObject({
      code: "expectation_not_found",
      status: 404,
    });

    // Agent access off ends every wait; a client that goes away leaves the
    // arm, so it can wait again.
    const stopping = expectations.arm(tab, "dialog", 10000);
    const stopped = rejection(expectations.wait(stopping, fakeRun()));
    expectations.endAll("access_off");
    expect(await stopped).toMatchObject({
      code: "automation_stopped",
      status: 503,
    });
    const abort = new AbortController();
    const dropped = expectations.arm(tab, "filechooser", 10000);
    const gone = expectations.wait(dropped, fakeRun(abort.signal));
    abort.abort();
    expect(await gone).toBeUndefined();
    expect(expectations.get(dropped.id)).toBeDefined();

    // An arm fires for nobody while the person has control, and works
    // again once the agent has it back.
    const held = expectations.arm(tab, "download", 10000);
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    expect(expectations.armFor(tab.id, "download")).toBeUndefined();
    expect(
      expectations.deliver(tab.id, "download", { download: DOWNLOAD }),
    ).toBe(false);
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "agent",
    });
    expect(expectations.armFor(tab.id, "download")?.id).toBe(held.id);
  });

  it("a dialog wait resolves with the next answered dialog and ignores one answered before arming", async () => {
    const { controller, tabLog, expectations, tab } = arming();
    const url = "https://example.com/";
    // What server.ts wires: every answered dialog is offered to a live arm.
    const dialogs = createDialogs({
      tabLog,
      controller,
      sessions: { get: () => undefined },
      onAnswer: (tabId, record) =>
        void expectations.deliver(tabId, "dialog", { dialog: record }),
    });
    dialogs.record(tab.id, {
      type: "confirm",
      message: "Before the arm",
      answer: "dismissed",
      url,
    });
    const arm = expectations.arm(tab, "dialog", 10000);
    expect(arm.fromSeq).toBe(1);
    let settled = false;
    const waiting = expectations.wait(arm, fakeRun()).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    dialogs.record(tab.id, {
      type: "prompt",
      message: "Your name?",
      answer: "accepted",
      promptText: "Ada",
      url,
    });
    expect(await waiting).toEqual({
      dialog: {
        type: "prompt",
        message: "Your name?",
        answer: "accepted",
        promptText: "Ada",
        url,
        at: Date.now(),
      },
    });
    // One event uses the arm up.
    expect(expectations.count()).toBe(0);
  });

  it("an armed download covers a popup the tab opened after arming, and not one it opened before", async () => {
    const { controller, expectations, tab, other } = arming();
    const early = controller.openPopup(tab.id, "https://example.com/early");
    const arm = expectations.arm(tab, "download", 10000);
    const late = controller.openPopup(tab.id, "https://example.com/late");
    const nested = controller.openPopup(late.id, "https://example.com/nested");
    await vi.advanceTimersByTimeAsync(0);
    expect(expectations.armFor(tab.id, "download")?.id).toBe(arm.id);
    expect(expectations.armFor(late.id, "download")?.id).toBe(arm.id);
    expect(expectations.armFor(nested.id, "download")?.id).toBe(arm.id);
    expect(expectations.armFor(early.id, "download")).toBeUndefined();
    expect(expectations.armFor(other.id, "download")).toBeUndefined();
    // A popup wait is never resolved by a popup of a popup.
    expect(expectations.armFor(late.id, "popup")).toBeUndefined();
    // The first download uses the arm up.
    expect(
      expectations.deliver(late.id, "download", { download: DOWNLOAD }),
    ).toBe(true);
    expect(
      expectations.deliver(late.id, "download", { download: DOWNLOAD }),
    ).toBe(false);
    expect(
      expectations.deliver(tab.id, "download", { download: DOWNLOAD }),
    ).toBe(false);
    // The result waits for the wait that collects it.
    expect(await expectations.wait(expectations.get(arm.id)!, fakeRun())).toEqual(
      { download: DOWNLOAD },
    );
    expect(expectations.get(arm.id)).toBeUndefined();
  });
});
