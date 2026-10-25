// Section 5's own element routes. Each one parses its body into the same
// tool action a batch step carries and runs the one path in actions.ts, so
// the route and the batch can never drift apart. A route with no batch step
// of its own runs the same element action directly.
import { send, type RouteDeps, type RouteImpl } from "../http";
import { fieldFields, parseToolAction } from "../validate";

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
  return {
    ...Object.fromEntries(
      ["dblclick", "hover", "select"].map((type) => [
        `POST /tabs/:id/${type}`,
        tool(type),
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
