import type { WebContents } from "electron";
import { bounded, remaining } from "../actions";
import { ApiError, errorBody, fail } from "../errors";
import {
  BODY_LIMIT,
  send,
  UPLOAD_BODY_LIMIT,
  type Route,
  type RouteCall,
  type RouteDeps,
} from "../http";
import {
  parseToolAction,
  stringField,
  uploadFields,
  urlField,
} from "../validate";

export function tabRoutes({
  controller,
  authority,
  actions: { trackContents, readyContents, evaluatePage, executeToolAction },
}: RouteDeps): Route[] {
  const { authorizeTab } = authority;
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
  const tool = (type: string): Route => ({
    method: "POST",
    path: ["tabs", ":id", type],
    lane: "space",
    budgetMs: 30000,
    bodyLimit: BODY_LIMIT,
    handler: async ({ response, body, tab, run }) =>
      send(
        response,
        200,
        await executeToolAction(tab!.id, parseToolAction(type, body!), run),
      ),
  });
  return [
    {
      method: "DELETE",
      path: ["tabs", ":id"],
      lane: "space",
      budgetMs: 10000,
      bodyLimit: BODY_LIMIT,
      handler: async ({ response, tab }) => {
        await controller.dispatch({ type: "tab:close", id: tab!.id });
        controller.addActivity(tab!.spaceId, "Agent closed a tab", "info");
        return send(response, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: ["tabs", ":id", "navigate"],
      lane: "space",
      budgetMs: 10000,
      bodyLimit: BODY_LIMIT,
      handler: async ({ response, body, tab }) => {
        const url = urlField(body!);
        await controller.dispatch({ type: "tab:navigate", id: tab!.id, url });
        const updated = authorizeTab(tab!.id);
        controller.addActivity(
          tab!.spaceId,
          `Agent navigated to ${new URL(url).hostname}`,
          "info",
        );
        return send(response, 200, { tab: updated });
      },
    },
    {
      method: "GET",
      path: ["tabs", ":id", "snapshot"],
      lane: "space",
      budgetMs: 30000,
      bodyLimit: BODY_LIMIT,
      handler: snapshot,
    },
    {
      method: "POST",
      path: ["tabs", ":id", "snapshot"],
      lane: "space",
      budgetMs: 30000,
      bodyLimit: BODY_LIMIT,
      handler: snapshot,
    },
    {
      method: "POST",
      path: ["tabs", ":id", "actions"],
      lane: "space",
      budgetMs: 60000,
      bodyLimit: BODY_LIMIT,
      handler: async ({ response, body, tab, run }) => {
        if (
          !Array.isArray(body!.actions) ||
          body!.actions.length < 1 ||
          body!.actions.length > 20
        )
          return fail(
            400,
            "invalid_actions",
            "actions must contain between 1 and 20 fixed browser actions.",
          );
        // Validate the entire plan before the first side effect.
        const actions = body!.actions.map((value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            return fail(
              400,
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
          try {
            if (response.destroyed) return;
            authorizeTab(tab!.id);
            results.push({
              index,
              type: action.type,
              result: await executeToolAction(tab!.id, action, run),
            });
          } catch (error) {
            const { status, error: failure } = errorBody(
              error,
              "The browser could not complete this step. Inspect the page before retrying any side effect.",
            );
            const withheld = [
              "human_control",
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
    {
      method: "GET",
      path: ["tabs", ":id", "screenshot"],
      lane: "space",
      budgetMs: 30000,
      bodyLimit: BODY_LIMIT,
      handler: async ({ response, tab, run }) => {
        const requireCaptureWindow = () => {
          if (!controller.canCapturePage())
            return fail(
              409,
              "screenshot_unavailable",
              "Restore or show the Kamapathy window to capture a screenshot. Snapshots and page actions remain available while it is minimized or hidden.",
            );
        };
        requireCaptureWindow();
        const contents = await readyContents(tab!.id, remaining(run.deadline));
        requireCaptureWindow();
        const screenshot = await bounded(
          contents.capturePage(undefined, { stayHidden: true }),
          remaining(run.deadline),
        ).catch((error: unknown) => {
          authorizeTab(tab!.id);
          requireCaptureWindow();
          if (error instanceof ApiError) throw error;
          return fail(
            503,
            "screenshot_failed",
            "The page could not render a screenshot. Read a snapshot or try again after the page finishes rendering.",
          );
        });
        authorizeTab(tab!.id);
        if (screenshot.isEmpty())
          return fail(
            409,
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
    ...["click", "fill", "press", "scroll", "drag", "wait"].map(tool),
    {
      method: "POST",
      path: ["tabs", ":id", "upload"],
      lane: "space",
      budgetMs: 30000,
      bodyLimit: UPLOAD_BODY_LIMIT,
      // Only this fixed route accepts a larger body. Reserve one transfer
      // before reading bytes, so concurrent uploads cannot multiply memory.
      beforeBody: ({ tab }) => {
        if (uploading)
          return fail(
            429,
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
              409,
              "no_web_page",
              "Open a web page before uploading files.",
            );
          return {
            prepared: { contents, epoch: trackContents(contents).epoch },
            release,
          };
        } catch (error) {
          release();
          throw error;
        }
      },
      handler: async ({ response, body, tab, run, prepared }) => {
        const { contents, epoch } = prepared as {
          contents: WebContents;
          epoch: number;
        };
        if (
          contents.isDestroyed() ||
          controller.getWebContents(tab!.id) !== contents ||
          trackContents(contents).epoch !== epoch
        )
          return fail(
            409,
            "page_changed",
            "The page changed during the transfer. Take a fresh snapshot.",
          );
        const payload = uploadFields(body!);
        const result = await evaluatePage(
          tab!.id,
          contents,
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
  ];
}
