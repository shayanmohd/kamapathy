import { bounded } from "../actions";
import { ApiError, fail } from "../errors";
import { send, type Route, type RouteDeps } from "../http";
import { parseToolAction, stringField, urlField } from "../validate";

export function tabRoutes(deps: RouteDeps): Route[] {
  const { controller } = deps;
  const { authorizeTab } = deps.authority;
  const { readyContents, executeToolAction } = deps.actions;
  return [
    {
      method: "DELETE",
      path: ["tabs", ":id"],
      async handler(call) {
        const { response } = call;
        const tab = call.tab!;
        await controller.dispatch({ type: "tab:close", id: tab.id });
        controller.addActivity(tab.spaceId, "Agent closed a tab", "info");
        return send(response, 200, { ok: true });
      },
    },
    {
      method: "POST",
      path: ["tabs", ":id", "navigate"],
      async handler(call) {
        const { response, body } = call;
        const tab = call.tab!;
        const url = urlField(body!);
        await controller.dispatch({ type: "tab:navigate", id: tab.id, url });
        const updated = authorizeTab(tab.id);
        controller.addActivity(
          tab.spaceId,
          `Agent navigated to ${new URL(url).hostname}`,
          "info",
        );
        return send(response, 200, { tab: updated });
      },
    },
    ...(["GET", "POST"] as const).map(
      (method): Route => ({
        method,
        path: ["tabs", ":id", "snapshot"],
        async handler(call) {
          const { response, body } = call;
          const tab = call.tab!;
          return send(
            response,
            200,
            await executeToolAction(
              tab.id,
              parseToolAction("snapshot", body || {}),
            ),
          );
        },
      }),
    ),
    {
      method: "POST",
      path: ["tabs", ":id", "actions"],
      async handler(call) {
        const { response, body } = call;
        const tab = call.tab!;
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
        const deadline = Date.now() + 60000;
        for (const [index, action] of actions.entries()) {
          try {
            if (response.destroyed) return;
            authorizeTab(tab.id);
            results.push({
              index,
              type: action.type,
              result: await executeToolAction(tab.id, action, deadline),
            });
          } catch (error) {
            const known = error instanceof ApiError;
            const code = known ? error.code : "operation_failed";
            const withheld = [
              "human_control",
              "automation_stopped",
              "tab_not_found",
              "space_not_found",
            ].includes(code);
            return send(response, known ? error.status : 500, {
              ok: false,
              results: withheld
                ? results.map((entry) => ({
                    ...entry,
                    result: { ok: true, withheld: true },
                  }))
                : results,
              failedIndex: index,
              error: {
                code,
                message: known
                  ? error.message
                  : "The browser could not complete this step. Inspect the page before retrying any side effect.",
              },
            });
          }
        }
        authorizeTab(tab.id);
        return send(response, 200, { ok: true, results });
      },
    },
    {
      method: "GET",
      path: ["tabs", ":id", "screenshot"],
      async handler(call) {
        const { response } = call;
        const tab = call.tab!;
        const requireCaptureWindow = () => {
          if (!controller.canCapturePage())
            return fail(
              409,
              "screenshot_unavailable",
              "Restore or show the Kamapathy window to capture a screenshot. Snapshots and page actions remain available while it is minimized or hidden.",
            );
        };
        requireCaptureWindow();
        const contents = await readyContents(tab.id);
        requireCaptureWindow();
        const screenshot = await bounded(
          contents.capturePage(undefined, { stayHidden: true }),
        ).catch((error: unknown) => {
          authorizeTab(tab.id);
          requireCaptureWindow();
          if (error instanceof ApiError) throw error;
          return fail(
            503,
            "screenshot_failed",
            "The page could not render a screenshot. Read a snapshot or try again after the page finishes rendering.",
          );
        });
        authorizeTab(tab.id);
        if (screenshot.isEmpty())
          return fail(
            409,
            "empty_screenshot",
            "The page has not rendered yet. Try again.",
          );
        controller.addActivity(
          tab.spaceId,
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
    ...["click", "fill", "press", "scroll", "drag", "wait"].map(
      (action): Route => ({
        method: "POST",
        path: ["tabs", ":id", action],
        async handler(call) {
          const { response, body } = call;
          const tab = call.tab!;
          return send(
            response,
            200,
            await executeToolAction(tab.id, parseToolAction(action, body!)),
          );
        },
      }),
    ),
  ];
}
