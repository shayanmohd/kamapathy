import type { AutomationController } from "./server";
import type { DialogData, TabLog } from "./tab-log";

export const SETTLE_MS = 50;
export const REQUEST_WINDOW_MS = 5000;

export interface ReceiptFields {
  popups?: { id: string; label?: string; url: string }[];
  dialog?: DialogData;
  moreDialogs?: number;
  download?:
    | { id: string; suggestedFilename: string; url: string }
    | { blocked: true; suggestedFilename: string; url: string };
  deniedRequests?: { origin: string; permission: string }[];
}
export interface ReceiptScope {
  readonly tabId: string;
  readonly fromSeq: number;
  /** Records a page step, so the 50 ms settle counts from the last one. */
  step(): void;
  fields(): Promise<ReceiptFields>;
  /** Ends the request window REQUEST_WINDOW_MS later. Safe to call twice. */
  close(): void;
}
export interface Receipts {
  begin(tabId: string, options?: { settleMs?: number }): ReceiptScope;
  /** The wrapper routes use: runs the work, then merges the receipt into its result. */
  with<T extends object>(
    tabId: string,
    work: (scope: ReceiptScope) => Promise<T>,
    options?: { settleMs?: number },
  ): Promise<T & ReceiptFields>;
  /** A refusal outside the window; false when the same pair is already pending. */
  reportDenied(
    tabId: string,
    denied: { origin: string; permission: string },
  ): boolean;
  inWindow(tabId: string): boolean;
  forget(tabId: string): void;
}

// A tab's request window: how many routes are running on it, when its tail
// ends, and the timer that drops it.
interface RequestWindow {
  open: number;
  until: number;
  timer?: ReturnType<typeof setTimeout>;
}

// What each route that presses, navigates or sets files answers with, from
// the tab log's entries between the route's entry and its settle. The same
// scope opens and closes the tab's request window, which the prompt center
// holds its permission requests on.
export function createReceipts(deps: {
  tabLog: TabLog;
  controller: Pick<AutomationController, "state" | "markSeen">;
  prompts?: {
    routeStarted(tabId: string): void;
    routeEnded(tabId: string): void;
  };
  now?(): number;
  sleep?(ms: number): Promise<void>;
}): Receipts {
  const { tabLog, controller, prompts } = deps;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const windows = new Map<string, RequestWindow>();
  // Refusals waiting for the tab's next receipt, as "origin|permission".
  const pending = new Map<string, Set<string>>();
  // How far each tab's refusals have been reported. Unlike the popups and
  // dialogs of one route, they are reported since the tab's last receipt.
  const deniedSeq = new Map<string, number>();
  const liveTab = (tabId: string) =>
    controller.state.tabs.find((tab) => tab.id === tabId);

  const receipts: Receipts = {
    begin(tabId, options = {}) {
      const settleMs = options.settleMs ?? SETTLE_MS;
      const fromSeq = tabLog.seq(tabId);
      let opened = windows.get(tabId);
      if (!opened) {
        opened = { open: 0, until: 0 };
        windows.set(tabId, opened);
      }
      const current = opened;
      current.open += 1;
      if (current.timer) {
        clearTimeout(current.timer);
        delete current.timer;
      }
      prompts?.routeStarted(tabId);
      // Set by the route around its own page steps; without one the receipt
      // settles from the moment the work ended.
      let lastStep: number | undefined;
      let closed = false;
      return {
        tabId,
        fromSeq,
        step() {
          lastStep = now();
        },
        async fields() {
          // A page can open a popup or a dialog just after the step that
          // caused it, so the receipt waits out the settle first.
          const wait = Math.max(0, settleMs - (now() - (lastStep ?? now())));
          if (wait > 0) await sleep(wait);
          const fields: ReceiptFields = {};
          const popups = tabLog.since(tabId, fromSeq, ["popup"]);
          if (popups.length)
            fields.popups = popups.map(({ data }) => {
              const live = liveTab(data.tabId);
              if (live) controller.markSeen(data.tabId);
              const label = live?.label ?? data.label;
              return {
                id: data.tabId,
                ...(label === undefined ? {} : { label }),
                url: live?.url ?? data.url,
              };
            });
          const dialogs = tabLog.since(tabId, fromSeq, ["dialog"]);
          if (dialogs.length) {
            fields.dialog = dialogs[0].data;
            if (dialogs.length > 1) fields.moreDialogs = dialogs.length - 1;
          }
          const download = tabLog.since(tabId, fromSeq, ["download"])[0]?.data;
          if (download) {
            const { url, suggestedFilename, id } = download;
            fields.download =
              id === undefined
                ? { blocked: true, suggestedFilename, url }
                : { id, suggestedFilename, url };
          }
          const denied = tabLog.since(tabId, deniedSeq.get(tabId) ?? 0, [
            "permission_denied",
          ]);
          deniedSeq.set(tabId, tabLog.seq(tabId));
          if (denied.length) {
            pending.delete(tabId);
            fields.deniedRequests = denied.map(({ data }) => ({
              origin: data.origin,
              permission: data.permission,
            }));
          }
          return fields;
        },
        close() {
          if (closed) return;
          closed = true;
          current.open -= 1;
          prompts?.routeEnded(tabId);
          if (current.open > 0 || windows.get(tabId) !== current) return;
          current.until = now() + REQUEST_WINDOW_MS;
          current.timer = setTimeout(() => {
            delete current.timer;
            if (current.open === 0 && windows.get(tabId) === current)
              windows.delete(tabId);
          }, REQUEST_WINDOW_MS);
        },
      };
    },
    async with(tabId, work, options) {
      const scope = receipts.begin(tabId, options);
      try {
        const result = await work(scope);
        return { ...result, ...(await scope.fields()) };
      } finally {
        scope.close();
      }
    },
    reportDenied(tabId, denied) {
      const key = `${denied.origin}|${denied.permission}`;
      let waiting = pending.get(tabId);
      if (!waiting) {
        waiting = new Set();
        pending.set(tabId, waiting);
      }
      if (waiting.has(key)) return false;
      waiting.add(key);
      tabLog.append(tabId, "permission_denied", denied);
      return true;
    },
    inWindow(tabId) {
      const record = windows.get(tabId);
      return record ? record.open > 0 || record.until > now() : false;
    },
    forget(tabId) {
      const record = windows.get(tabId);
      if (record?.timer) clearTimeout(record.timer);
      windows.delete(tabId);
      pending.delete(tabId);
      deniedSeq.delete(tabId);
    },
  };
  return receipts;
}
