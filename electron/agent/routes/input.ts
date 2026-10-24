// Section 5's own element routes. Each one parses its body into the same
// tool action a batch step carries and runs the one path in actions.ts, so
// the route and the batch can never drift apart.
import { send, type RouteDeps, type RouteImpl } from "../http";
import { parseToolAction } from "../validate";

export function inputRoutes(deps: RouteDeps): Record<string, RouteImpl> {
  const {
    actions: { executeToolAction },
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
  return Object.fromEntries(
    ["dblclick", "hover"].map((type) => [`POST /tabs/:id/${type}`, tool(type)]),
  );
}
