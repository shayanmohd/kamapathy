import type { WebContents } from "electron";
import { bounded, remaining } from "../actions";
import { ApiError, envelope, fail } from "../errors";
import {
  send,
  type RouteCall,
  type RouteDeps,
  type RouteImpl,
} from "../http";
import type { TabSession } from "../session/tab-session";
import { parseToolAction, stringField, uploadFields } from "../validate";
import { tabView } from "../views";
import { checkPageBudget } from "./spaces";

export function tabRoutes({
  controller,
  authority,
  actions: { readyContents, evaluatePage, executeToolAction },
  sessions,
  navigation,
}: RouteDeps): Record<string, RouteImpl> {
  const { authorizeTab, authorizeSpace } = authority;
  let uploading = false;
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
    handler: async ({ response, body, tab, run }) =>
      send(
        response,
        200,
        await executeToolAction(tab!.id, parseToolAction(type, body!), run),
      ),
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
          return parseToolAction(stringField(action, "type", 20), action);
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
            results.push({
              index,
              type: action.type,
              result: navigation.stepTypes.includes(action.type)
                ? await navigation.step(tab!.id, action, step)
                : await executeToolAction(tab!.id, action, step),
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
          }
        }
        authorizeTab(tab!.id);
        return send(response, 200, { ok: true, results });
      },
    },
    "GET /tabs/:id/screenshot": {
      handler: async ({ response, tab, run }) => {
        const requireCaptureWindow = () => {
          if (!controller.canCapturePage())
            return fail(
              "screenshot_unavailable",
              "Restore or show the Kamapathy window to capture a screenshot. Snapshots and page actions remain available while it is minimized or hidden.",
            );
        };
        requireCaptureWindow();
        const { contents } = await readyContents(tab!.id, remaining(run.deadline));
        requireCaptureWindow();
        const screenshot = await bounded(
          contents.capturePage(undefined, { stayHidden: true }),
          remaining(run.deadline),
        ).catch((error: unknown) => {
          authorizeTab(tab!.id);
          requireCaptureWindow();
          if (error instanceof ApiError) throw error;
          return fail(
            "screenshot_failed",
            "The page could not render a screenshot. Read a snapshot or try again after the page finishes rendering.",
          );
        });
        authorizeTab(tab!.id);
        if (screenshot.isEmpty())
          return fail(
            "empty_screenshot",
            "The page has not rendered yet. Try again.",
          );
        controller.addActivity(
          tab!.spaceId,
          "Agent captured a page screenshot",
          "info",
        );
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return response.end(screenshot.toPNG());
      },
    },
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
        const result = await evaluatePage(
          tab!.id,
          session,
          "upload",
          payload,
          run.deadline,
        );
        authorizeTab(tab!.id);
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
