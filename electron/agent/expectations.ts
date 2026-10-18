import { randomBytes } from "node:crypto";
import type { Tab } from "../../shared/types";
import { humanControlMessage, spaceEnded, type Authority } from "./authority";
import { ApiError, fail } from "./errors";
import type { Run } from "./http";
import type { AutomationController } from "./server";
import type { TabSessions } from "./session/tab-sessions";
import type { DialogData, PopupData, TabLog } from "./tab-log";
import { tabView, type TabView } from "./views";

export const EXPECTATION_EVENTS = [
  "popup",
  "download",
  "filechooser",
  "dialog",
] as const;
export type ExpectationEvent = (typeof EXPECTATION_EVENTS)[number];
export const WAIT_LIMIT = 16;
// How far up the opener chain a download or chooser arm reaches.
const POPUP_HOPS = 8;
const EVENT_WORDS: Record<ExpectationEvent, string> = {
  popup: "popup",
  download: "download",
  filechooser: "file chooser",
  dialog: "dialog",
};

export interface Expectation {
  readonly id: string;
  readonly event: ExpectationEvent;
  readonly tabId: string;
  readonly spaceId: string;
  /** The tab's log seq when the arm was taken; only later entries count. */
  readonly fromSeq: number;
  readonly expiresAt: number;
  readonly timeoutMs: number;
}
// What a download and a chooser wait answer with. The shapes are the ones
// downloads.ts and file-choosers.ts build, kept loose here so those modules
// own their own states.
export interface DownloadWaitView {
  id: string;
  tabId: string;
  url: string;
  suggestedFilename: string;
  mimeType: string;
  state: string;
  receivedBytes: number;
  totalBytes: number;
  failure: string | null;
}
export interface FileChooserWaitView {
  id: string;
  tabId: string;
  multiple: boolean;
  accept: string[];
}
export type ExpectationResult =
  | { popup: TabView }
  | { download: DownloadWaitView }
  | { fileChooser: FileChooserWaitView }
  | { dialog: DialogData };
export type ExpectationEnd =
  | "deleted"
  | "takeover"
  | "tab_closed"
  | "space_ended"
  | "access_off"
  | "expired";
export interface Expectations {
  arm(tab: Tab, event: ExpectationEvent, timeoutMs: number): Expectation;
  get(id: string): Expectation | undefined;
  /** Long-polls until the event arrives, the arm expires or the arm ends.
   *  Answers undefined once the client has gone, which needs no body. */
  wait(
    expectation: Expectation,
    run: Run,
  ): Promise<ExpectationResult | undefined>;
  /** Delivers an event to a live arm; false when nothing was armed. */
  deliver(
    tabId: string,
    event: ExpectationEvent,
    result: ExpectationResult,
  ): boolean;
  /** The arm that covers this tab, counting popups it opened after arming. */
  armFor(tabId: string, event: ExpectationEvent): Expectation | undefined;
  end(id: string, reason: ExpectationEnd): void;
  endTab(tabId: string, reason: ExpectationEnd): void;
  endSpace(spaceId: string, reason: ExpectationEnd): void;
  endAll(reason: ExpectationEnd): void;
  count(): number;
}

// The one answer for an id that names no live arm, which the routes share.
export const expectationNotFound = () =>
  new ApiError(
    "expectation_not_found",
    "This wait is not live: it was answered, cancelled, or its time ran out. Arm another before the action that causes the event.",
  );

// One budget for every long poll the API runs, so the download waits of
// section 7 share these sixteen slots. Undefined means the budget is full.
let waits = 0;
export function takeWaitSlot(): (() => void) | undefined {
  if (waits >= WAIT_LIMIT) return undefined;
  waits += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    waits -= 1;
  };
}

// An arm, the result it has taken, and the wait listening for it.
interface Live {
  expectation: Expectation;
  result?: ExpectationResult;
  waiter?: {
    resolve(result: ExpectationResult): void;
    reject(error: unknown): void;
  };
}

// What each agent tab waits for. An arm records the tab's log position, so
// only later events count, and the popup source turns the tab log's popup
// entries into results. Nothing here touches Electron.
export function createExpectations(deps: {
  tabLog: TabLog;
  controller: Pick<
    AutomationController,
    "state" | "markSeen" | "shownTab" | "subscribe"
  >;
  authority: Pick<Authority, "authorizeTab">;
  sessions: Pick<TabSessions, "get">;
  now?(): number;
}): Expectations {
  const { tabLog, controller, authority, sessions } = deps;
  const now = deps.now ?? Date.now;
  const arms = new Map<string, Live>();
  const tabOf = (tabId: string) =>
    controller.state.tabs.find((tab) => tab.id === tabId);
  const timedOut = ({ event, timeoutMs }: Expectation) =>
    new ApiError(
      "expectation_timeout",
      `No ${EVENT_WORDS[event]} arrived within ${timeoutMs} ms. Arm another wait before the action that causes it.`,
      { awaited: "event", event, timeoutMs },
    );
  const endError = (
    reason: ExpectationEnd,
    expectation: Expectation,
  ): ApiError => {
    const { spaceId } = expectation;
    switch (reason) {
      case "takeover":
        return new ApiError("human_control", humanControlMessage("manual"), {
          spaceId,
          reason: "manual",
        });
      case "tab_closed":
        return new ApiError(
          "tab_closed",
          "The tab was closed while this wait was running.",
        );
      case "space_ended": {
        const space = controller.state.spaces.find(
          (item) => item.id === spaceId,
        );
        return (
          (space && spaceEnded(space)) ??
          new ApiError(
            "space_ended",
            "The agent's access to this space ended while this wait was running.",
            { spaceId },
          )
        );
      }
      case "access_off":
        return new ApiError("automation_stopped", "Automation is disabled.");
      case "expired":
        return timedOut(expectation);
      default:
        return expectationNotFound();
    }
  };
  // An arm whose time ran out before any wait collected it is forgotten, so
  // the next request is told the arm is gone rather than that it timed out.
  // An arm that already holds a result keeps it for the wait that collects
  // it, and goes when that wait, the tab or agent access ends.
  const sweep = () => {
    const at = now();
    for (const [id, live] of arms)
      if (!live.result && !live.waiter && live.expectation.expiresAt <= at)
        arms.delete(id);
  };
  // The tab's own arm for this event, while it still waits for one.
  const armOf = (tabId: string, event: ExpectationEvent) => {
    for (const live of arms.values())
      if (
        live.expectation.tabId === tabId &&
        live.expectation.event === event &&
        !live.result
      )
        return live;
    return undefined;
  };
  // Whether the opener's log holds this popup after the given seq.
  const openedAfter = (openerId: string, tabId: string, fromSeq: number) =>
    tabLog
      .since(openerId, fromSeq, ["popup"])
      .some((entry) => entry.data.tabId === tabId);
  // An arm fires only while its own tab is still the agent's: a release, a
  // takeover, a hold, Stop and agent access off all make it inert, without
  // throwing the arm away, so the agent can use it again once it has
  // control back.
  const usable = (live: Live) => {
    try {
      return authority.authorizeTab(live.expectation.tabId).managed === true;
    } catch {
      return false;
    }
  };
  // The arm an event on this tab belongs to: the tab's own, or one on a tab
  // above it that opened this popup after arming. Popups never climb, so a
  // popup of a popup leaves the grandparent's wait alone.
  const findArm = (tabId: string, event: ExpectationEvent) => {
    sweep();
    const direct = armOf(tabId, event);
    if (direct) return usable(direct) ? direct : undefined;
    if (event === "popup") return undefined;
    let tab = tabOf(tabId);
    for (let hop = 0; hop < POPUP_HOPS && tab?.openerId; hop += 1) {
      const openerId = tab.openerId;
      const arm = armOf(openerId, event);
      if (
        arm &&
        usable(arm) &&
        openedAfter(openerId, tab.id, arm.expectation.fromSeq)
      )
        return arm;
      // Only a chain of popups carries an arm further up.
      if (!openedAfter(openerId, tab.id, 0)) return undefined;
      tab = tabOf(openerId);
    }
    return undefined;
  };

  const expectations: Expectations = {
    arm(tab, event, timeoutMs) {
      sweep();
      const pending = armOf(tab.id, event);
      if (pending)
        return fail(
          "expectation_pending",
          `This page is already waiting for a ${EVENT_WORDS[event]}. Wait for it, or cancel that wait before arming another.`,
          { event, expectationId: pending.expectation.id },
        );
      const expectation: Expectation = {
        id: randomBytes(8).toString("hex"),
        event,
        tabId: tab.id,
        spaceId: tab.spaceId,
        fromSeq: tabLog.seq(tab.id),
        expiresAt: now() + timeoutMs,
        timeoutMs,
      };
      arms.set(expectation.id, { expectation });
      return expectation;
    },
    get(id) {
      sweep();
      return arms.get(id)?.expectation;
    },
    wait(expectation, run) {
      return new Promise<ExpectationResult | undefined>((resolve, reject) => {
        const live = arms.get(expectation.id);
        if (!live) return reject(expectationNotFound());
        // An event that arrived before the wait did is answered at once.
        if (live.result) {
          arms.delete(expectation.id);
          return resolve(live.result);
        }
        if (live.waiter)
          return reject(
            new ApiError(
              "expectation_pending",
              `This page is already waiting for a ${EVENT_WORDS[expectation.event]}.`,
              {
                event: expectation.event,
                expectationId: expectation.id,
              },
            ),
          );
        if (run.signal.aborted) return resolve(undefined);
        const stop = () => {
          clearTimeout(timer);
          unsubscribe();
          stopClosed?.();
          run.signal.removeEventListener("abort", dropped);
          if (live.waiter === waiter) delete live.waiter;
        };
        const waiter = {
          resolve: (result: ExpectationResult) => {
            stop();
            arms.delete(expectation.id);
            resolve(result);
          },
          reject: (error: unknown) => {
            stop();
            arms.delete(expectation.id);
            reject(error);
          },
        };
        // The client went away: the arm stays, so it can wait again.
        const dropped = () => {
          stop();
          resolve(undefined);
        };
        const timer = setTimeout(
          () => waiter.reject(timedOut(expectation)),
          Math.max(0, expectation.expiresAt - now()),
        );
        // The person can take over, and the space or the tab can leave the
        // agent, while the wait runs.
        const unsubscribe = controller.subscribe(() => {
          try {
            authority.authorizeTab(expectation.tabId);
          } catch (error) {
            waiter.reject(error);
          }
        });
        const stopClosed = sessions
          .get(expectation.tabId)
          ?.on("closed", () =>
            waiter.reject(endError("tab_closed", expectation)),
          );
        run.signal.addEventListener("abort", dropped);
        live.waiter = waiter;
      });
    },
    deliver(tabId, event, result) {
      const live = findArm(tabId, event);
      if (!live) return false;
      live.result = result;
      // A reported popup is seen, so the run's end never names it again.
      if ("popup" in result) controller.markSeen(result.popup.id);
      live.waiter?.resolve(result);
      return true;
    },
    armFor: (tabId, event) => findArm(tabId, event)?.expectation,
    end(id, reason) {
      const live = arms.get(id);
      if (!live) return;
      arms.delete(id);
      live.waiter?.reject(endError(reason, live.expectation));
    },
    endTab(tabId, reason) {
      for (const live of [...arms.values()])
        if (live.expectation.tabId === tabId)
          expectations.end(live.expectation.id, reason);
    },
    endSpace(spaceId, reason) {
      for (const live of [...arms.values()])
        if (live.expectation.spaceId === spaceId)
          expectations.end(live.expectation.id, reason);
    },
    endAll(reason) {
      for (const live of [...arms.values()])
        expectations.end(live.expectation.id, reason);
    },
    count() {
      sweep();
      return arms.size;
    },
  };

  // The popup source: a popup entry on an opener's log resolves that
  // opener's popup wait. The tab joins the state right after it is logged,
  // so its view is read on the next tick.
  tabLog.on((openerId, entry) => {
    if (entry.kind !== "popup") return;
    const { tabId } = entry.data as PopupData;
    const live = findArm(openerId, "popup");
    if (!live || live.expectation.fromSeq >= entry.seq) return;
    queueMicrotask(() => {
      const tab = tabOf(tabId);
      if (!tab) return;
      expectations.deliver(openerId, "popup", {
        popup: tabView(tab, controller.shownTab(tab.spaceId)),
      });
    });
  });
  return expectations;
}
