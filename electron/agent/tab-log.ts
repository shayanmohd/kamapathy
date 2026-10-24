import { agentRules } from "../../shared/state";
import type { BrowserState } from "../../shared/types";
import type { TabRegistry } from "./tab-registry";

export const TAB_LOG_ENTRIES = 200;

export type TabLogKind =
  "popup" | "dialog" | "download" | "file_chooser" | "permission_denied";
export interface PopupData {
  tabId: string;
  label?: string;
  openerId: string;
  url: string;
}
export interface DialogData {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
  answer: "accepted" | "dismissed";
  promptText?: string;
  url: string;
}
export interface DownloadData {
  id?: string;
  blocked?: true;
  url: string;
  suggestedFilename: string;
}
export interface FileChooserData {
  id: string;
  multiple: boolean;
}
export interface DeniedData {
  origin: string;
  permission: string;
}
export interface TabLogData {
  popup: PopupData;
  dialog: DialogData;
  download: DownloadData;
  file_chooser: FileChooserData;
  permission_denied: DeniedData;
}
export interface TabLogEntry<K extends TabLogKind = TabLogKind> {
  seq: number;
  kind: K;
  data: TabLogData[K];
  at: number;
}
export interface TabLog {
  append<K extends TabLogKind>(
    tabId: string,
    kind: K,
    data: TabLogData[K],
  ): TabLogEntry<K>;
  /** The tab's newest seq, 0 when it has logged nothing. Seqs never repeat. */
  seq(tabId: string): number;
  since<K extends TabLogKind>(
    tabId: string,
    seq: number,
    kinds?: readonly K[],
  ): TabLogEntry<K>[];
  on(listener: (tabId: string, entry: TabLogEntry) => void): () => void;
  forget(tabId: string): void;
}

interface Ring {
  next: number;
  entries: TabLogEntry[];
}

// What happened in each agent tab: the popups it opened, the dialogs answered
// in it, its downloads, its file choosers and the requests Kamapathy refused.
// Receipts and waits read it by seq range, so nothing here depends on Electron.
export function createTabLog(options: { now?(): number } = {}): TabLog {
  const now = options.now ?? Date.now;
  const rings = new Map<string, Ring>();
  const listeners = new Set<(tabId: string, entry: TabLogEntry) => void>();
  return {
    append(tabId, kind, data) {
      let ring = rings.get(tabId);
      if (!ring) {
        ring = { next: 1, entries: [] };
        rings.set(tabId, ring);
      }
      const entry = { seq: ring.next++, kind, data, at: now() };
      ring.entries.push(entry);
      if (ring.entries.length > TAB_LOG_ENTRIES) ring.entries.shift();
      for (const listener of listeners) listener(tabId, entry);
      return entry;
    },
    seq(tabId) {
      const ring = rings.get(tabId);
      return ring ? ring.next - 1 : 0;
    },
    since(tabId, seq, kinds) {
      const wanted = kinds as readonly string[] | undefined;
      const entries = (rings.get(tabId)?.entries ?? []).filter(
        (entry) => entry.seq > seq && (!wanted || wanted.includes(entry.kind)),
      );
      return entries as TabLogEntry<never>[];
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forget(tabId) {
      rings.delete(tabId);
    },
  };
}

/** Appends a popup entry to its opener's log for every page-opened tab. */
export function watchPopups(
  log: TabLog,
  registry: TabRegistry,
  state: () => BrowserState,
): () => void {
  const tabUrl = (tabId: string) =>
    state().tabs.find((tab) => tab.id === tabId)?.url;
  return registry.on((event) => {
    if (event.type !== "opened" || event.openedBy !== "page") return;
    const openerId = event.openerId;
    if (!openerId) return;
    const space = state().spaces.find((item) => item.id === event.spaceId);
    if (!space || !agentRules(space)) return;
    const entry = log.append(openerId, "popup", {
      tabId: event.tabId,
      ...(event.label === undefined ? {} : { label: event.label }),
      openerId,
      url: tabUrl(event.tabId) ?? "",
    });
    // A popup is registered before it joins the state, so its URL arrives
    // with the tab.
    if (!entry.data.url)
      queueMicrotask(() => {
        entry.data.url = tabUrl(event.tabId) ?? "";
      });
  });
}
