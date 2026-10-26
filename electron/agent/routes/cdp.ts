import { send, type RouteDeps, type RouteImpl } from "../http";
import { eventFields } from "../validate";

// POST /tabs/:id/events: the protocol events recorded for this tab. Sections
// 11 and 12 add the two cdp routes here.
export function cdpRoutes(deps: RouteDeps): Record<string, RouteImpl> {
  const { events, pageScripts } = deps;
  return {
    // Outside every queue, so a script can read what a pending evaluate is
    // waiting on. It still authorizes on arrival.
    "POST /tabs/:id/events": {
      handler: async ({ response, body, tab, run }) => {
        pageScripts.require();
        const { max } = eventFields(body!);
        return send(response, 200, {
          ok: true,
          ...(await events.drain(tab!.id, max, {
            deadline: run.deadline,
            signal: run.signal,
          })),
        });
      },
    },
  };
}
