import type { WebContents } from "electron";
import { envelope, fail, FileChooserOpenedError } from "../errors";
import {
  send,
  type RouteCall,
  type RouteDeps,
  type RouteImpl,
} from "../http";
import type { ReceiptFields, ReceiptScope } from "../receipts";
import type { TabSession } from "../session/tab-session";
import { parseToolAction, stringField, uploadFields } from "../validate";
import { tabView } from "../views";
import { cdpRoutes } from "./cdp";
import { inputRoutes } from "./input";
import { screenshotRoutes } from "./screenshot";
import { scriptRoutes } from "./scripts";
import { checkPageBudget } from "./spaces";

// The actions whose answer carries a receipt: the input routes and their
// batch steps. A wait or a snapshot changes nothing, so neither gets one.
const RECEIPT_ACTIONS = [
  "click",
  "dblclick",
  "hover",
  "fill",
  "select",
  "press",
  "scroll",
  "drag",
  "mouse-click",
];

// One file transfer at a time, so the bytes of two never pile up in memory.
// upload and set-input-files share this slot, which keeps upload_busy
// meaning one thing. Every reservation is released in the router's finally.
let uploading = false;
export function takeTransfer(): (() => void) | undefined {
  if (uploading) return undefined;
  uploading = true;
  return () => {
    uploading = false;
  };
}
// The receipt wrapper every action goes through, with the file chooser
// guard after the page work: an action that opened a chooser nothing was
// waiting for never answers, since the page is left waiting for files.
export function withReceipt<T extends object>(
  deps: Pick<RouteDeps, "receipts" | "choosers">,
  tabId: string,
  work: (scope: ReceiptScope) => Promise<T>,
  options?: { settleMs?: number },
): Promise<T & ReceiptFields> {
  return deps.receipts.with(
    tabId,
    async (scope) => {
      const result = await work(scope);
      if (deps.choosers.openedSince(tabId, scope.fromSeq))
        throw new FileChooserOpenedError();
      return result;
    },
    options,
  );
}
/** The page and session a transfer reserved. */
export interface Transfer {
  contents: WebContents;
  session: TabSession;
  epoch: number;
}
type TransferDeps = Pick<RouteDeps, "controller" | "sessions">;
// Reserves the one transfer and looks up the page it will run on, before any
// bytes are read.
export function beginTransfer(
  deps: TransferDeps,
  tabId: string,
): { prepared: Transfer; release(): void } {
  const release = takeTransfer();
  if (!release)
    return fail("upload_busy", "Another file transfer is in progress.");
  try {
    const contents = deps.controller.getWebContents(tabId);
    if (!contents || contents.isDestroyed())
      return fail("no_web_page", "Open a web page before uploading files.");
    const session = deps.sessions.get(tabId);
    if (!session || session.contents !== contents)
      return fail(
        "debugger_busy",
        "Kamapathy lost its connection to this tab. Try again shortly.",
        { reason: "unavailable" },
      );
    return { prepared: { contents, session, epoch: session.epoch }, release };
  } catch (error) {
    release();
    throw error;
  }
}
/** Whether the page and session the transfer reserved are still the tab's. */
export function sameTransfer(
  deps: TransferDeps,
  tabId: string,
  transfer: Transfer,
): boolean {
  return (
    !transfer.contents.isDestroyed() &&
    deps.controller.getWebContents(tabId) === transfer.contents &&
    deps.sessions.get(tabId) === transfer.session &&
    transfer.session.epoch === transfer.epoch
  );
}

export function tabRoutes(deps: RouteDeps): Record<string, RouteImpl> {
  const {
    controller,
    authority,
    actions: { evaluatePage, executeToolAction },
    navigation,
    presence,
  } = deps;
  const { authorizeTab, authorizeSpace } = authority;
  // One scope per action, so its result names the popups, dialogs, download
  // and refused requests that action caused.
  const runAction = (
    tabId: string,
    action: ReturnType<typeof parseToolAction>,
    run: RouteCall["run"],
  ) =>
    RECEIPT_ACTIONS.includes(action.type)
      ? withReceipt(deps, tabId, () => executeToolAction(tabId, action, run))
      : executeToolAction(tabId, action, run);
  const snapshot = async ({ response, body, tab, run }: RouteCall) =>
    send(
      response,
      200,
      await executeToolAction(
        tab!.id,
        parseToolAction("snapshot", body || {}),
        run,
      ),
    );
  const tool = (type: string): RouteImpl => ({
    handler: async ({ response, body, tab, run }) => {
      const action = parseToolAction(type, body!);
      return send(response, 200, await runAction(tab!.id, action, run));
    },
  });
  return {
    "DELETE /tabs/:id": {
      handler: async ({ response, tab, run }) => {
        run.dispatch.dispatched = true;
        const { closed, replacement } = controller.closeTab(tab!.id, "agent");
        controller.addActivity(tab!.spaceId, "Agent closed a tab", "info");
        return send(response, 200, {
          ok: true,
          ...(closed === undefined ? {} : { closed }),
          ...(replacement
            ? {
                replacement: tabView(
                  replacement,
                  controller.shownTab(tab!.spaceId),
                ),
              }
            : {}),
        });
      },
    },
    "POST /tabs/:id/adopt": {
      access: { unmanaged: true },
      handler: async ({ response, tab }) => {
        const space = authorizeSpace(tab!.spaceId);
        let adopted = tab!;
        if (!adopted.managed) {
          checkPageBudget(controller, space);
          adopted = controller.setManaged(adopted.id, true);
          controller.addActivity(space.id, "Agent adopted a page", "info");
        }
        return send(response, 200, {
          tab: tabView(adopted, controller.shownTab(space.id)),
        });
      },
    },
    "POST /tabs/:id/release": {
      access: { unmanaged: true },
      handler: async ({ response, tab }) => {
        if (tab!.openedBy === "agent")
          return fail(
            "release_refused",
            "The agent opened this page. Close it instead of releasing it.",
            { tabId: tab!.id, label: tab!.label },
          );
        const released = controller.setManaged(tab!.id, false);
        controller.addActivity(tab!.spaceId, "Agent released a page", "info");
        return send(response, 200, {
          tab: tabView(released, controller.shownTab(tab!.spaceId)),
        });
      },
    },
    "GET /tabs/:id/snapshot": {
      handler: snapshot,
    },
    "POST /tabs/:id/snapshot": {
      handler: snapshot,
    },
    "POST /tabs/:id/actions": {
      handler: async ({ response, body, tab, run }) => {
        if (
          !Array.isArray(body!.actions) ||
          body!.actions.length < 1 ||
          body!.actions.length > 20
        )
          return fail(
            "invalid_actions",
            "actions must contain between 1 and 20 fixed browser actions.",
          );
        // Validate the entire plan before the first side effect.
        const actions = body!.actions.map((value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            return fail(
              "invalid_action",
              "Each action must be an object with a type.",
            );
          const action = value as Record<string, unknown>;
          return parseToolAction(stringField(action, "type", 20), action, {
            controller,
          });
        });
        const results: {
          index: number;
          type: string;
          result: Record<string, unknown>;
        }[] = [];
        for (const [index, action] of actions.entries()) {
          // Each step has its own dispatch record, so a failed step's flags
          // describe that step only.
          const step = { ...run, dispatch: { dispatched: false } };
          try {
            if (response.destroyed) return;
            authorizeTab(tab!.id);
            // Each step shows its own label, which replaces the step
            // before it and stays for five seconds after this one.
            presence.labelStart(tab!.spaceId, action.label);
            results.push({
              index,
              type: action.type,
              result: navigation.stepTypes.includes(action.type)
                ? await navigation.step(tab!.id, action, step)
                : await runAction(tab!.id, action, step),
            });
          } catch (error) {
            const { status, error: failure } = envelope(
              error,
              step.dispatch.dispatched,
              {
                route: "POST /tabs/:id/actions",
                action: action.type,
                fallback:
                  "The browser could not complete this step. Inspect the page before retrying any side effect.",
              },
            );
            const withheld = [
              "human_control",
              "space_ended",
              "automation_stopped",
              "tab_not_found",
              "space_not_found",
            ].includes(failure.code);
            return send(response, status, {
              ok: false,
              results: withheld
                ? results.map((entry) => ({
                    ...entry,
                    result: { ok: true, withheld: true },
                  }))
                : results,
              failedIndex: index,
              error: failure,
            });
          } finally {
            presence.labelEnd(tab!.spaceId);
          }
        }
        authorizeTab(tab!.id);
        return send(response, 200, { ok: true, results });
      },
    },
    ...screenshotRoutes(deps),
    ...scriptRoutes(deps),
    ...cdpRoutes(deps),
    ...inputRoutes(deps),
    ...Object.fromEntries(
      ["click", "fill", "press", "scroll", "drag", "wait"].map((type) => [
        `POST /tabs/:id/${type}`,
        tool(type),
      ]),
    ),
    "POST /tabs/:id/upload": {
      // Only the file routes accept a larger body. Reserve the one transfer
      // before reading bytes, so concurrent uploads cannot multiply memory.
      beforeBody: ({ tab }) => beginTransfer(deps, tab!.id),
      handler: async ({ response, body, tab, run, prepared }) => {
        const transfer = prepared as Transfer;
        if (!sameTransfer(deps, tab!.id, transfer))
          return fail(
            "page_changed",
            "The page changed during the transfer. Take a fresh snapshot.",
          );
        const { session } = transfer;
        const payload = uploadFields(body!);
        const result = await withReceipt(deps, tab!.id, async () => {
          const selected = await evaluatePage(
            tab!.id,
            session,
            "upload",
            payload,
            run.deadline,
          );
          authorizeTab(tab!.id);
          return selected;
        });
        controller.addActivity(
          tab!.spaceId,
          `Agent selected ${payload.files.length} file(s) for upload`,
          "info",
        );
        return send(response, 200, result);
      },
    },
  };
}
