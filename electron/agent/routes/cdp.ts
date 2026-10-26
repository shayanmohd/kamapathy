import { send, type RouteDeps, type RouteImpl } from "../http";
import { cdpFields, eventFields } from "../validate";

// POST /tabs/:id/events: the protocol events recorded for this tab, and
// POST /tabs/:id/cdp: one protocol command on the agent's own session.
// Section 12 adds the space route here.
export function cdpRoutes(deps: RouteDeps): Record<string, RouteImpl> {
  const { events, pageScripts, cdp } = deps;
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
    "POST /tabs/:id/cdp": {
      // Every command waits its turn in its own space.
      laneFor: () => "space",
      handler: async ({ response, body, tab, run }) => {
        const answered = await cdp.page(
          { tabId: tab!.id, ...cdpFields(body!) },
          run,
        );
        return send(response, 200, { ok: true, ...answered });
      },
    },
  };
}
