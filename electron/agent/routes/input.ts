// Section 5's own element routes. Each one parses its body into the same
// tool action a batch step carries and runs the one path in actions.ts, so
// the route and the batch can never drift apart. A route with no batch step
// of its own runs the same element action directly.
import { send, type RouteDeps, type RouteImpl } from "../http";
import type { KeyboardKind, MouseKind } from "../input/actions";
import {
  fieldFields,
  keyboardFields,
  mouseFields,
  parseToolAction,
} from "../validate";

// How often a stroke of raw input names itself in the space's activity, so a
// run of key or mouse requests on one tab is one line.
const RAW_ACTIVITY_MS = 5000;

export function inputRoutes(deps: RouteDeps): Record<string, RouteImpl> {
  const {
    controller,
    authority,
    actions: { executeToolAction, input },
    receipts,
  } = deps;
  // Every route here presses, so each answer carries the receipt of what its
  // input caused.
  const tool = (type: string): RouteImpl => ({
    handler: async ({ response, body, tab, run }) =>
      send(
        response,
        200,
        await receipts.with(tab!.id, () =>
          executeToolAction(tab!.id, parseToolAction(type, body!), run),
        ),
      ),
  });
  // When each tab's raw input last named itself.
  const named = new Map<string, number>();
  const nameRawInput = (tabId: string, what: "keyboard" | "mouse") => {
    const at = Date.now();
    const key = `${tabId}:${what}`;
    if (at - (named.get(key) ?? 0) < RAW_ACTIVITY_MS) return;
    named.set(key, at);
    controller.addActivity(
      authority.authorizeTab(tabId).spaceId,
      `Agent used the ${what}`,
      "info",
    );
  };
  // The raw keyboard routes: no settle, no load wait and no receipt tail, as
  // sections 5 and 7 say.
  const keyboard = (kind: KeyboardKind): RouteImpl => ({
    handler: async ({ response, body, tab, run }) => {
      const result = await receipts.with(
        tab!.id,
        () => input.keyboard(tab!.id, keyboardFields(body!, kind), run),
        { settleMs: 0 },
      );
      nameRawInput(tab!.id, "keyboard");
      send(response, 200, result);
    },
  });
  // The raw mouse routes: like the keyboard's, they add no settle, no load
  // wait and no receipt tail.
  const mouse = (kind: MouseKind): RouteImpl => ({
    handler: async ({ response, body, tab, run }) => {
      const result = await receipts.with(
        tab!.id,
        () => input.mouse(tab!.id, mouseFields(body!, kind), run),
        { settleMs: 0 },
      );
      nameRawInput(tab!.id, "mouse");
      send(response, 200, result);
    },
  });
  return {
    ...Object.fromEntries(
      ["dblclick", "hover", "select"].map((type) => [
        `POST /tabs/:id/${type}`,
        tool(type),
      ]),
    ),
    ...Object.fromEntries(
      (["down", "up", "type", "insert-text"] as const).map((kind) => [
        `POST /tabs/:id/keyboard/${kind}`,
        keyboard(kind),
      ]),
    ),
    ...Object.fromEntries(
      (["move", "down", "up", "wheel"] as const).map((kind) => [
        `POST /tabs/:id/mouse/${kind}`,
        mouse(kind),
      ]),
    ),
    // Focus is no batch step: a plan that focuses a field fills or presses
    // it next, and both focus it themselves.
    "POST /tabs/:id/focus": {
      handler: async ({ response, body, tab, run }) => {
        const action = fieldFields(body!, "focus");
        const result = await receipts.with(tab!.id, () =>
          input.field(tab!.id, action, run),
        );
        const current = authority.authorizeTab(tab!.id);
        controller.addActivity(
          current.spaceId,
          "Agent focused an element",
          "info",
        );
        send(response, 200, result);
      },
    },
  };
}
