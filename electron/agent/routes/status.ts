import { send, type RouteDeps, type RouteImpl } from "../http";
import { agentTextField } from "../validate";

// The agent's own account of its work. Neither route declares access, so
// both are refused while the person has control, and neither touches a page.
export function statusRoutes({
  presence,
}: RouteDeps): Record<string, RouteImpl> {
  return {
    "POST /spaces/:id/status": {
      handler: async ({ response, body, space }) => {
        // An empty status clears it, so a status of only control characters
        // clears instead of failing.
        const text = agentTextField(body!, "text", "status", {
          allowEmpty: true,
        });
        const { status } = presence.setStatus(space!.id, text);
        return send(response, 200, {
          ok: true,
          ...(status === undefined ? {} : { status }),
        });
      },
    },
    "POST /spaces/:id/fail": {
      handler: async ({ response, body, space }) => {
        const message = agentTextField(body!, "message", "message");
        return send(response, 200, {
          ok: true,
          ...(await presence.fail(space!.id, message)),
        });
      },
    },
  };
}
