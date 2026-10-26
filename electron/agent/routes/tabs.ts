import type { WebContents } from "electron";
import { envelope, fail } from "../errors";
import {
  send,
  type RouteCall,
  type RouteDeps,
  type RouteImpl,
} from "../http";
import type { TabSession } from "../session/tab-session";
import { parseToolAction, stringField, uploadFields } from "../validate";
import { tabView } from "../views";
import { inputRoutes } from "./input";
import { screenshotRoutes } from "./screenshot";
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

export function tabRoutes(deps: RouteDeps): Record<string, RouteImpl> {
  const {
    controller,
    authority,
    actions: { evaluatePage, executeToolAction },
    sessions,
    navigation,
    receipts,
    presence,
  } = deps;
  const { authorizeTab, authorizeSpace } = authority;
  let uploading = false;
  // One scope per action, so its result names the popups, dialogs, download
  // and refused requests that action caused.
  const runAction = (
    tabId: string,
    action: ReturnType<typeof parseToolAction>,
    run: RouteCall["run"],
  ) =>
    RECEIPT_ACTIONS.includes(action.type)
      ? receipts.with(tabId, () => executeToolAction(tabId, action, run))
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
    ...inputRoutes(deps),
    ...Object.fromEntries(
      ["click", "fill", "press", "scroll", "drag", "wait"].map((type) => [
        `POST /tabs/:id/${type}`,
        tool(type),
      ]),
    ),
    "POST /tabs/:id/upload": {
      // Only this fixed route accepts a larger body. Reserve one transfer
      // before reading bytes, so concurrent uploads cannot multiply memory.
      beforeBody: ({ tab }) => {
        if (uploading)
          return fail(
            "upload_busy",
            "Another file transfer is in progress.",
          );
        uploading = true;
        const release = () => {
          uploading = false;
        };
        try {
          const contents = controller.getWebContents(tab!.id);
          if (!contents || contents.isDestroyed())
            return fail(
              "no_web_page",
              "Open a web page before uploading files.",
            );
          const session = sessions.get(tab!.id);
          if (!session || session.contents !== contents)
            return fail(
              "debugger_busy",
              "Kamapathy lost its connection to this tab. Try again shortly.",
              { reason: "unavailable" },
            );
          return {
            prepared: { contents, session, epoch: session.epoch },
            release,
          };
        } catch (error) {
          release();
          throw error;
        }
      },
      handler: async ({ response, body, tab, run, prepared }) => {
        const { contents, session, epoch } = prepared as {
          contents: WebContents;
          session: TabSession;
          epoch: number;
        };
        if (
          contents.isDestroyed() ||
          controller.getWebContents(tab!.id) !== contents ||
          sessions.get(tab!.id) !== session ||
          session.epoch !== epoch
        )
          return fail(
            "page_changed",
            "The page changed during the transfer. Take a fresh snapshot.",
          );
        const payload = uploadFields(body!);
        const result = await receipts.with(tab!.id, async () => {
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
