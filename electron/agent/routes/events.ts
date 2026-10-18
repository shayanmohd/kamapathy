import type { IncomingMessage } from "node:http";
import { fail } from "../errors";
import { expectationNotFound, takeWaitSlot, WAIT_LIMIT } from "../expectations";
import { send, type RouteDeps, type RouteImpl } from "../http";
import { dialogPolicyFields, expectationFields } from "../validate";

// The id segment of /expectations/:id and /expectations/:id/wait. Paths
// carry no query strings or encoded segments, so this is the raw id.
const idOf = (request: IncomingMessage) =>
  (request.url ?? "").split("/").filter(Boolean)[1] ?? "";

// Arming a wait, the long poll that answers it, the list of the pages a page
// opened, and the dialog policy and log of a page.
export function eventRoutes({
  controller,
  dialogs,
  expectations,
}: RouteDeps): Record<string, RouteImpl> {
  const notLive = (): never => {
    throw expectationNotFound();
  };
  // Both /expectations/:id routes are authorized through the arm's tab, so
  // a takeover or a closed tab ends the wait like any other page route.
  const resolve = (parts: string[]) => {
    const expectation = expectations.get(parts[1]);
    if (!expectation) return notLive();
    return { tabId: expectation.tabId };
  };
  return {
    "POST /tabs/:id/expectations": {
      handler: async ({ response, body, tab }) => {
        const { event, timeoutMs } = expectationFields(body!);
        const { id, expiresAt } = expectations.arm(tab!, event, timeoutMs);
        return send(response, 201, {
          expectation: { id, event, tabId: tab!.id, expiresAt },
        });
      },
    },
    "POST /expectations/:id/wait": {
      resolve,
      // Waits run outside every queue, so they share one budget of slots
      // with the other long polls instead.
      beforeBody: () => {
        const release = takeWaitSlot();
        if (!release)
          return fail(
            "busy",
            `Kamapathy is already running ${WAIT_LIMIT} waits. Wait for one to answer, then try again.`,
            { scope: "server" },
          );
        return { release };
      },
      handler: async ({ request, response, run }) => {
        const expectation = expectations.get(idOf(request));
        if (!expectation) return notLive();
        const result = await expectations.wait(expectation, run);
        // The client went away, so there is nothing to answer.
        if (!result) return;
        return send(response, 200, result);
      },
    },
    "DELETE /expectations/:id": {
      resolve,
      handler: async ({ request, response }) => {
        expectations.end(idOf(request), "deleted");
        return send(response, 200, { ok: true });
      },
    },
    "POST /tabs/:id/dialog-policy": {
      handler: async ({ response, body, tab }) =>
        send(response, 200, {
          policy: dialogs.setPolicy(tab!.id, dialogPolicyFields(body!)),
        }),
    },
    "DELETE /tabs/:id/dialog-policy": {
      handler: async ({ response, tab }) =>
        send(response, 200, { policy: dialogs.setPolicy(tab!.id, null) }),
    },
    "GET /tabs/:id/dialogs": {
      handler: async ({ response, tab, run }) => {
        // What a frame without the binding queued is collected first, so
        // the log answers with every dialog the page has seen.
        await dialogs.drain(tab!.id, {
          deadline: run.deadline,
          signal: run.signal,
        });
        return send(response, 200, {
          policy: dialogs.policy(tab!.id),
          dialogs: dialogs.records(tab!.id),
        });
      },
    },
    "GET /tabs/:id/popups": {
      handler: async ({ response, tab }) =>
        send(response, 200, {
          // Listing never clears unseen: only a receipt, a wait's result or
          // a route that addresses the popup does.
          popups: controller.state.tabs
            .filter((item) => item.openerId === tab!.id)
            .map((item) => ({
              id: item.id,
              ...(item.label === undefined ? {} : { label: item.label }),
              url: item.url,
              openedAt: item.createdAt ?? 0,
              ...(item.unseen ? { unseen: true as const } : {}),
            })),
        }),
    },
  };
}
