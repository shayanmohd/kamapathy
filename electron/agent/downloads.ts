import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { WebContents } from "electron";
import type { Tab } from "../../shared/types";
import { activeSpace } from "./authority";
import { fail } from "./errors";
import type { Expectations } from "./expectations";
import type { AutomationController } from "./server";
import type { TabLog } from "./tab-log";

export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
export const SPACE_DOWNLOAD_LIMIT = 8;
export const DOWNLOAD_TTL_MS = 3_600_000;
/** How long an arm from armDownload holds without a deadline of its own. */
export const ARM_LIFETIME_MS = 60_000;
/** The folder under the profile that every held download lives in. */
export const DOWNLOAD_FOLDER = "agent-downloads";
const MAX_FILENAME = 200;

export type DownloadState =
  "progressing" | "completed" | "cancelled" | "interrupted";
export type DownloadFailure = null | "cancelled" | "interrupted" | "too_large";
export interface AgentDownload {
  id: string;
  tabId: string;
  spaceId: string;
  url: string;
  suggestedFilename: string;
  mimeType: string;
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number;
  failure: DownloadFailure;
  /** Absolute path under <userData>/agent-downloads/<id>/. Never serialized. */
  path: string;
  startedAt: number;
  finishedAt?: number;
}
export interface DownloadView {
  id: string;
  tabId: string;
  url: string;
  suggestedFilename: string;
  mimeType: string;
  state: DownloadState;
  receivedBytes: number;
  totalBytes: number;
  failure: DownloadFailure;
}
export function downloadView(download: AgentDownload): DownloadView {
  const {
    id,
    tabId,
    url,
    suggestedFilename,
    mimeType,
    state,
    receivedBytes,
    totalBytes,
    failure,
  } = download;
  return {
    id,
    tabId,
    url,
    suggestedFilename,
    mimeType,
    state,
    receivedBytes,
    totalBytes,
    failure,
  };
}
export interface DownloadArm {
  id: string;
  tabId: string;
  url?: string;
  source: "agent" | "pdf";
  expiresAt: number;
}
export interface Downloads {
  /** The first thing the controller's will-download handler calls for an
   *  agent-controlled tab. Cancels and logs when nothing is armed. */
  decide(
    contents: WebContents,
    item: Electron.DownloadItem,
  ): { captured: true; id: string } | { captured: false };
  /** Section 16's PDF viewer arm, and any one-shot arm for one URL. */
  armDownload(
    tabId: string,
    options: { url?: string; source: "agent" | "pdf"; expiresAt?: number },
  ): DownloadArm;
  get(id: string): AgentDownload | undefined;
  listSpace(spaceId: string): AgentDownload[];
  cancel(id: string): AgentDownload;
  remove(id: string): void;
  clearSpace(spaceId: string): void;
  clearAll(): void;
  count(spaceId: string): number;
  /** The last capture decision for a tab, for phase 5's abort classification. */
  lastDecision(
    tabId: string,
  ): { armed: boolean; downloadId?: string } | undefined;
}

// A held download: its record, the Electron item while it runs, whether the
// size cap stopped it, and the timer that deletes it.
interface Held {
  record: AgentDownload;
  item?: Electron.DownloadItem;
  folder: string;
  tooLarge?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** The name a download is saved under: a base name, without control
 *  characters or leading dots, short enough for any file system. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, MAX_FILENAME)
    .trim();
  return cleaned || "download";
}

/** Removes the whole download folder, which app start does before the
 *  server listens so a crash leaves nothing behind. */
export function clearDownloadFolder(userDataPath: string): void {
  try {
    rmSync(join(userDataPath, DOWNLOAD_FOLDER), {
      recursive: true,
      force: true,
    });
  } catch {
    /* A folder Kamapathy cannot remove is left for the next start. */
  }
}

// Downloads an agent armed: the decision the controller's will-download
// handler asks for, the private folder each one is saved in, the size,
// count and time limits, and the deletion every trigger routes through.
// Nothing here is reported to the person's Downloads list.
export function createDownloads(deps: {
  tabLog: TabLog;
  arms: () => Pick<Expectations, "armFor" | "deliver">;
  controller: Pick<
    AutomationController,
    "state" | "addActivity" | "agentControlled" | "userDataPath" | "subscribe"
  >;
  tabOf(contents: WebContents): Tab | undefined;
  now?(): number;
}): Downloads {
  const { tabLog, arms, controller, tabOf } = deps;
  const now = deps.now ?? Date.now;
  const held = new Map<string, Held>();
  const oneShot = new Map<string, DownloadArm>();
  const decisions = new Map<string, { armed: boolean; downloadId?: string }>();
  const root = () => join(controller.userDataPath(), DOWNLOAD_FOLDER);
  const spaceOf = (tabId: string) =>
    controller.state.tabs.find((tab) => tab.id === tabId)?.spaceId;
  const count = (spaceId: string) => {
    let total = 0;
    for (const entry of held.values())
      if (entry.record.spaceId === spaceId) total += 1;
    return total;
  };
  const limitReached = (spaceId: string) =>
    count(spaceId) >= SPACE_DOWNLOAD_LIMIT;
  // The one-shot arm this download belongs to: the same tab, the same URL
  // when the arm names one, while the agent still has the tab.
  const oneShotFor = (tabId: string, url: string) => {
    for (const [id, arm] of oneShot) {
      if (arm.expiresAt <= now() || !controller.agentControlled(arm.tabId)) {
        oneShot.delete(id);
        continue;
      }
      if (arm.tabId === tabId && (arm.url === undefined || arm.url === url))
        return arm;
    }
    return undefined;
  };
  const blocked = (
    tab: Tab,
    url: string,
    suggestedFilename: string,
  ): { captured: false } => {
    tabLog.append(tab.id, "download", {
      blocked: true,
      url,
      suggestedFilename,
    });
    decisions.set(tab.id, { armed: false });
    return { captured: false };
  };
  const drop = (id: string) => {
    const entry = held.get(id);
    if (!entry) return;
    held.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.record.state === "progressing")
      try {
        entry.item?.cancel();
      } catch {
        /* An item Chromium has let go needs no cancel. */
      }
    try {
      rmSync(entry.folder, { recursive: true, force: true });
    } catch {
      /* The folder goes with the profile if it cannot be removed now. */
    }
  };
  // Over the size cap, the download stops and keeps too_large as its
  // failure, so the final state never hides why it ended.
  const enforceCap = (entry: Held) => {
    const { record } = entry;
    if (entry.tooLarge || record.state !== "progressing") return;
    if (
      record.receivedBytes <= MAX_DOWNLOAD_BYTES &&
      record.totalBytes <= MAX_DOWNLOAD_BYTES
    )
      return;
    entry.tooLarge = true;
    record.failure = "too_large";
    try {
      entry.item?.cancel();
    } catch {
      /* A cancel Chromium refuses leaves done to report the end. */
    }
  };

  const downloads: Downloads = {
    decide(contents, item) {
      const host = (() => {
        try {
          return (contents as WebContents | undefined)?.hostWebContents;
        } catch {
          return undefined;
        }
      })();
      // Chromium's PDF viewer runs in the tab's own page; a guest view
      // would report the tab as its host instead.
      const tab = tabOf(contents) ?? (host ? tabOf(host) : undefined);
      if (!tab || !controller.agentControlled(tab.id))
        return { captured: false };
      const url = item.getURL();
      const suggestedFilename = safeFileName(item.getFilename());
      const arm = arms().armFor(tab.id, "download");
      const shot = arm ? undefined : oneShotFor(tab.id, url);
      if (!arm && !shot) return blocked(tab, url, suggestedFilename);
      if (limitReached(tab.spaceId))
        return blocked(tab, url, suggestedFilename);
      const id = randomBytes(8).toString("hex");
      const folder = join(root(), id);
      let path: string;
      try {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        path = join(folder, suggestedFilename);
        item.setSavePath(path);
      } catch {
        try {
          rmSync(folder, { recursive: true, force: true });
        } catch {
          /* Nothing was saved in it. */
        }
        return blocked(tab, url, suggestedFilename);
      }
      const record: AgentDownload = {
        id,
        tabId: tab.id,
        spaceId: tab.spaceId,
        url,
        suggestedFilename,
        mimeType: item.getMimeType(),
        state: "progressing",
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        failure: null,
        path,
        startedAt: now(),
      };
      const entry: Held = { record, item, folder };
      held.set(id, entry);
      if (shot) oneShot.delete(shot.id);
      tabLog.append(tab.id, "download", { id, url, suggestedFilename });
      item.on("updated", (_event, state) => {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        if (state === "interrupted") record.state = "interrupted";
        enforceCap(entry);
      });
      item.once("done", (_event, state) => {
        // A download deleted while it ran keeps nothing: its own cancel
        // brings the end here.
        if (held.get(id) !== entry) return;
        record.state = state;
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        if (state === "completed") {
          if (!record.totalBytes) record.totalBytes = record.receivedBytes;
          record.failure = null;
        } else if (!entry.tooLarge)
          record.failure = state === "cancelled" ? "cancelled" : "interrupted";
        record.finishedAt = now();
        delete entry.item;
        // Electron writes the file itself, so its mode is set once it is
        // there; the 0700 folder is the real boundary.
        try {
          chmodSync(record.path, 0o600);
        } catch {
          /* A file the download never wrote needs no mode. */
        }
        if (state === "completed")
          controller.addActivity(
            record.spaceId,
            `Agent downloaded ${record.suggestedFilename}.`,
            "success",
          );
        entry.timer = setTimeout(() => downloads.remove(id), DOWNLOAD_TTL_MS);
      });
      enforceCap(entry);
      decisions.set(tab.id, { armed: true, downloadId: id });
      // The arm the agent set answers with the download as it begins.
      if (arm)
        arms().deliver(arm.tabId, "download", {
          download: downloadView(record),
        });
      return { captured: true, id };
    },
    armDownload(tabId, options) {
      const spaceId = spaceOf(tabId);
      if (spaceId !== undefined && limitReached(spaceId))
        fail(
          "download_limit",
          `This space already holds ${SPACE_DOWNLOAD_LIMIT} downloads. Delete one before arming another.`,
          { limit: SPACE_DOWNLOAD_LIMIT },
        );
      const arm: DownloadArm = {
        id: randomBytes(8).toString("hex"),
        tabId,
        ...(options.url === undefined ? {} : { url: options.url }),
        source: options.source,
        expiresAt: options.expiresAt ?? now() + ARM_LIFETIME_MS,
      };
      oneShot.set(arm.id, arm);
      return arm;
    },
    get: (id) => held.get(id)?.record,
    // Newest first: the map holds them in the order they started, and two
    // in the same millisecond keep that order reversed.
    listSpace: (spaceId) =>
      [...held.values()]
        .reverse()
        .filter((entry) => entry.record.spaceId === spaceId)
        .map((entry) => entry.record)
        .sort((first, second) => second.startedAt - first.startedAt),
    cancel(id) {
      const entry = held.get(id);
      if (!entry)
        return fail("download_not_found", "No held download has this ID.");
      // Once it has finished there is nothing to stop.
      if (entry.record.state === "progressing")
        try {
          entry.item?.cancel();
        } catch {
          /* An item Chromium has let go needs no cancel. */
        }
      return entry.record;
    },
    remove: drop,
    clearSpace(spaceId) {
      for (const [id, entry] of [...held])
        if (entry.record.spaceId === spaceId) drop(id);
      for (const [id, arm] of [...oneShot])
        if (spaceOf(arm.tabId) === spaceId) oneShot.delete(id);
    },
    clearAll() {
      for (const id of [...held.keys()]) drop(id);
      oneShot.clear();
      decisions.clear();
      try {
        rmSync(root(), { recursive: true, force: true });
      } catch {
        /* App start removes whatever is left behind. */
      }
    },
    count,
    lastDecision: (tabId) => decisions.get(tabId),
  };

  // A space that closes, or whose access ends, keeps nothing: its files go
  // with it, as do the arms of its tabs.
  controller.subscribe(() => {
    const spaces = new Set<string>();
    for (const entry of held.values()) spaces.add(entry.record.spaceId);
    for (const { tabId } of oneShot.values()) {
      const spaceId = spaceOf(tabId);
      if (spaceId === undefined) continue;
      spaces.add(spaceId);
    }
    for (const spaceId of spaces) {
      const space = controller.state.spaces.find((item) => item.id === spaceId);
      if (!space || !activeSpace(space)) downloads.clearSpace(spaceId);
    }
  });
  return downloads;
}
