import { send, type RouteDeps, type RouteImpl } from "../http";
import { cdpFields, eventFields, spaceCdpFields } from "../validate";

// POST /tabs/:id/events: the protocol events recorded for this tab,
// POST /tabs/:id/cdp: one protocol command on the agent's own session, and
// POST /spaces/:id/cdp: the two methods Kamapathy answers about itself.

/** The Fetch commands that release a request a pending call may be waiting
 *  on, so they take no lane. Every check still applies to them. */
export const CONTINUATIONS: readonly string[] = [
  "Fetch.continueRequest",
  "Fetch.continueResponse",
  "Fetch.failRequest",
  "Fetch.fulfillRequest",
];

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
    "POST /spaces/:id/cdp": {
      // It touches no page, so it waits for none.
      handler: async ({ response, body, space }) => {
        const { method, params } = spaceCdpFields(body!);
        return send(response, 200, {
          ok: true,
          ...cdp.space(space!.id, method, params),
        });
      },
    },
    "POST /tabs/:id/cdp": {
      // Every command waits its turn in its own space, except the four that
      // let a request through: a call already in the lane may be waiting for
      // one of them.
      laneFor: (body) =>
        CONTINUATIONS.includes(String(body?.method)) ? "none" : "space",
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
