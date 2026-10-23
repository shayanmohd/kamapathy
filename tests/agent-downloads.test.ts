import { existsSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthority } from "../electron/agent/authority";
import {
  createDownloads,
  DOWNLOAD_TTL_MS,
  MAX_DOWNLOAD_BYTES,
  SPACE_DOWNLOAD_LIMIT,
  type Downloads,
} from "../electron/agent/downloads";
import type { ApiError } from "../electron/agent/errors";
import { createExpectations } from "../electron/agent/expectations";
import type { TabSession } from "../electron/agent/session/tab-session";
import { createTabLog, watchPopups } from "../electron/agent/tab-log";
import type { Tab } from "../shared/types";
import { FakeController, FakeDownloadItem } from "./fake-automation";

// Downloads over a fake DownloadItem: the decision the controller's
// will-download handler asks for, the private folder and the limits.
function setup() {
  const controller = new FakeController();
  const tabLog = createTabLog();
  watchPopups(tabLog, controller.registry, () => controller.state);
  const authority = createAuthority(controller);
  const space = controller.createAgentSpace("Research");
  authority.managedSpaces.add(space.id);
  const expectations = createExpectations({
    tabLog,
    controller,
    authority,
    sessions: { get: () => undefined as unknown as TabSession | undefined },
  });
  // Each tab's own page, as will-download reports the page a download
  // started in.
  const pages = new Map<string, object>();
  const pageOf = (tabId: string) => {
    let page = pages.get(tabId);
    if (!page) {
      page = { tabId };
      pages.set(tabId, page);
    }
    return page as unknown as WebContents;
  };
  const downloads = createDownloads({
    tabLog,
    arms: () => expectations,
    controller,
    tabOf: (contents) =>
      controller.state.tabs.find(
        (tab) => pages.get(tab.id) === (contents as unknown as object),
      ),
  });
  const tab = controller.state.tabs.find((item) => item.spaceId === space.id)!;
  return {
    controller,
    tabLog,
    expectations,
    downloads,
    space,
    tab,
    pageOf,
    root: join(controller.userDataPath(), "agent-downloads"),
    // A download starting in a tab, as the controller's handler delivers it.
    start(target: Tab, item: FakeDownloadItem) {
      return downloads.decide(pageOf(target.id), item as never);
    },
    entries: () =>
      tabLog.since(tab.id, 0, ["download"]).map((entry) => entry.data),
  };
}
const held = (downloads: Downloads, id: string) => {
  const record = downloads.get(id);
  if (!record) throw new Error(`Download ${id} is not held.`);
  return record;
};
const thrown = (run: () => unknown): ApiError => {
  try {
    run();
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("Nothing was thrown.");
};

afterEach(() => {
  vi.useRealTimers();
  FakeController.cleanup();
});

describe("armed agent downloads", () => {
  it("cancels unarmed downloads", () => {
    const { downloads, tab, start, entries, root } = setup();
    const item = new FakeDownloadItem({
      filename: "report.pdf",
      url: "https://example.com/report.pdf",
    });
    expect(start(tab, item)).toEqual({ captured: false });
    // Nothing is saved, and the agent learns the download was blocked.
    expect(item.savePath).toBe("");
    expect(item.dialogOptions).toBeUndefined();
    expect(entries()).toEqual([
      {
        blocked: true,
        url: "https://example.com/report.pdf",
        suggestedFilename: "report.pdf",
      },
    ]);
    expect(downloads.lastDecision(tab.id)).toEqual({ armed: false });
    expect(downloads.listSpace(tab.spaceId)).toEqual([]);
    expect(existsSync(root)).toBe(false);
  });

  it("saves armed ones privately without a dialog", async () => {
    vi.useFakeTimers();
    const { controller, downloads, expectations, tab, start, entries, root } =
      setup();
    const arm = expectations.arm(tab, "download", 10000);
    const item = new FakeDownloadItem({
      filename: "../../report final.pdf",
      url: "https://example.com/report.pdf",
      mimeType: "application/pdf",
      totalBytes: 12,
    });
    const decision = start(tab, item);
    expect(decision.captured).toBe(true);
    const id = (decision as { id: string }).id;
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    // The file goes in its own folder under the profile, never the person's
    // Downloads folder, and no save dialog is offered.
    const folder = join(root, id);
    expect(item.savePath).toBe(join(folder, "report final.pdf"));
    expect(item.dialogOptions).toBeUndefined();
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(folder)).mode & 0o777).toBe(0o700);
    // The name the agent sees is the one on disk: a base name, cleaned once.
    expect(entries()).toEqual([
      {
        id,
        url: "https://example.com/report.pdf",
        suggestedFilename: "report final.pdf",
      },
    ]);
    expect(downloads.lastDecision(tab.id)).toEqual({
      armed: true,
      downloadId: id,
    });
    // The arm it consumed answers with the record, and no path of the
    // browser's machine is in it.
    expect(
      await expectations.wait(arm, {
        deadline: Date.now() + 1000,
        signal: new AbortController().signal,
        dispatch: { dispatched: false },
        park: (wait) => wait(),
      }),
    ).toEqual({
      download: {
        id,
        tabId: tab.id,
        url: "https://example.com/report.pdf",
        suggestedFilename: "report final.pdf",
        mimeType: "application/pdf",
        state: "progressing",
        receivedBytes: 0,
        totalBytes: 12,
        failure: null,
      },
    });
    item.progress(6);
    expect(held(downloads, id).receivedBytes).toBe(6);
    // Electron writes the file itself, so the mode is set once it is there.
    writeFileSync(item.savePath, "hello agent!");
    item.finish("completed", 12);
    expect(held(downloads, id)).toMatchObject({
      state: "completed",
      receivedBytes: 12,
      totalBytes: 12,
      failure: null,
      finishedAt: expect.any(Number),
    });
    expect(statSync(item.savePath).mode & 0o777).toBe(0o600);
    expect(controller.activity).toEqual([
      {
        spaceId: tab.spaceId,
        message: "Agent downloaded report final.pdf.",
        kind: "success",
      },
    ]);
    expect(downloads.count(tab.spaceId)).toBe(1);
    // An hour after it finished, the file and the record are gone.
    await vi.advanceTimersByTimeAsync(DOWNLOAD_TTL_MS);
    expect(downloads.get(id)).toBeUndefined();
    expect(existsSync(folder)).toBe(false);
  });

  it("captures a popup's download", () => {
    const { controller, downloads, expectations, tab, start } = setup();
    const before = controller.openPopup(tab.id, "https://example.com/before");
    expectations.arm(tab, "download", 10000);
    const after = controller.openPopup(tab.id, "https://example.com/after");
    // A popup opened before arming carries no arm of its opener.
    expect(
      start(before, new FakeDownloadItem({ filename: "early.pdf" })),
    ).toEqual({ captured: false });
    const decision = start(
      after,
      new FakeDownloadItem({ filename: "late.pdf" }),
    );
    expect(decision.captured).toBe(true);
    const id = (decision as { id: string }).id;
    expect(held(downloads, id)).toMatchObject({
      tabId: after.id,
      spaceId: tab.spaceId,
      suggestedFilename: "late.pdf",
    });
    // The arm is the opener's, so the popup's download answers it.
    expect(expectations.armFor(tab.id, "download")).toBeUndefined();
  });

  it("armDownload keeps one download of its URL and counts toward the limit", () => {
    const { downloads, tab, start } = setup();
    const arm = downloads.armDownload(tab.id, {
      url: "https://example.com/doc.pdf",
      source: "pdf",
    });
    expect(arm).toMatchObject({
      tabId: tab.id,
      url: "https://example.com/doc.pdf",
      source: "pdf",
    });
    expect(arm.expiresAt).toBeGreaterThan(Date.now());
    // Another URL on the same tab is not what the agent armed.
    expect(
      start(
        tab,
        new FakeDownloadItem({
          filename: "other.pdf",
          url: "https://example.com/other.pdf",
        }),
      ),
    ).toEqual({ captured: false });
    const decision = start(
      tab,
      new FakeDownloadItem({
        filename: "doc.pdf",
        url: "https://example.com/doc.pdf",
      }),
    );
    expect(decision.captured).toBe(true);
    expect(downloads.count(tab.spaceId)).toBe(1);
    // One download only: the arm is spent.
    expect(
      start(
        tab,
        new FakeDownloadItem({
          filename: "doc.pdf",
          url: "https://example.com/doc.pdf",
        }),
      ),
    ).toEqual({ captured: false });
    expect(downloads.count(tab.spaceId)).toBe(1);
  });

  it("cancels past 1 GiB", () => {
    const { controller, downloads, expectations, tab, start } = setup();
    expectations.arm(tab, "download", 10000);
    // A size the server declares up front is refused as soon as it is known.
    const huge = new FakeDownloadItem({
      filename: "huge.bin",
      totalBytes: MAX_DOWNLOAD_BYTES + 1,
    });
    const first = start(tab, huge);
    expect(first.captured).toBe(true);
    expect(huge.cancelled).toBe(true);
    const id = (first as { id: string }).id;
    expect(held(downloads, id).failure).toBe("too_large");
    huge.finish("cancelled", 1024);
    expect(held(downloads, id)).toMatchObject({
      state: "cancelled",
      failure: "too_large",
    });
    expect(controller.activity).toEqual([]);

    // A stream that does not declare its size is cut off once it passes it.
    expectations.arm(tab, "download", 10000);
    const creeping = new FakeDownloadItem({ filename: "creep.bin" });
    const second = start(tab, creeping);
    expect(creeping.cancelled).toBe(false);
    creeping.progress(MAX_DOWNLOAD_BYTES - 1);
    expect(creeping.cancelled).toBe(false);
    creeping.progress(MAX_DOWNLOAD_BYTES + 1);
    expect(creeping.cancelled).toBe(true);
    creeping.finish("cancelled");
    expect(held(downloads, (second as { id: string }).id).failure).toBe(
      "too_large",
    );
  });

  it("a ninth arm in a space answers 409 download_limit and changes nothing", () => {
    const { controller, downloads, expectations, tab, space, start, root } =
      setup();
    const ids: string[] = [];
    for (let index = 0; index < SPACE_DOWNLOAD_LIMIT; index += 1) {
      expectations.arm(tab, "download", 10000);
      const decision = start(
        tab,
        new FakeDownloadItem({ filename: `file-${index}.bin` }),
      );
      expect(decision.captured).toBe(true);
      ids.push((decision as { id: string }).id);
    }
    expect(downloads.count(space.id)).toBe(SPACE_DOWNLOAD_LIMIT);
    const error = thrown(() =>
      downloads.armDownload(tab.id, { source: "pdf" }),
    );
    expect(error.code).toBe("download_limit");
    expect(error.status).toBe(409);
    expect(error.fields).toEqual({ limit: SPACE_DOWNLOAD_LIMIT });
    // The refused arm captures nothing, and no ninth download is held.
    expect(start(tab, new FakeDownloadItem({ filename: "ninth.bin" }))).toEqual(
      { captured: false },
    );
    expect(downloads.count(space.id)).toBe(SPACE_DOWNLOAD_LIMIT);
    // Newest first, and one that is deleted frees a slot.
    expect(downloads.listSpace(space.id).map((item) => item.id)).toEqual(
      [...ids].reverse(),
    );
    downloads.remove(ids[0]);
    expect(existsSync(join(root, ids[0]))).toBe(false);
    expect(downloads.count(space.id)).toBe(SPACE_DOWNLOAD_LIMIT - 1);
    expect(downloads.armDownload(tab.id, { source: "agent" }).id).toMatch(
      /^[0-9a-f]{16}$/,
    );
    // The space leaving the agent takes its held downloads with it.
    controller.endAccess(space.id, { by: "person", reason: "stopped" });
    expect(downloads.count(space.id)).toBe(0);
    for (const id of ids) expect(existsSync(join(root, id))).toBe(false);
  });
});
