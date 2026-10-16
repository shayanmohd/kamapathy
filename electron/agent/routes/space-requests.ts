import { cleanAgentText } from "../../../shared/agent-text";
import type { Space } from "../../../shared/types";
import { fail } from "../errors";
import { send, type RouteDeps, type RouteImpl } from "../http";
import { agentVisible, spaceView, tabView } from "../views";

const WAITING = 3;
const COOLDOWN_MS = 60000;
const EMPTY = "text that is not empty after cleaning";

type Outcome = { space: Space } | "declined" | "timeout" | "closed";

// An agent asks for one of the person's spaces and waits for their answer.
// Until the person allows it, no answer says which spaces exist.
export function spaceRequestRoutes({
  controller,
  grantSpace,
}: RouteDeps & { grantSpace(id: string): Space }) {
  const waiting = new Map<string, (outcome: Outcome) => void>();
  let reserved = 0;
  let declinedAt = -Infinity;
  const routes: Record<string, RouteImpl> = {
    "POST /space-requests": {
      beforeBody: () => {
        if (reserved >= WAITING)
          return fail(
            "busy",
            "Three requests for a space are already waiting. Try again later.",
            { scope: "server" },
          );
        const retryAfterMs = declinedAt + COOLDOWN_MS - Date.now();
        if (retryAfterMs > 0)
          return fail(
            "busy",
            "The person declined a request just now. Try again later.",
            { scope: "server", retryAfterMs },
          );
        reserved += 1;
        return { release: () => void (reserved -= 1) };
      },
      handler: async ({ response, body, run }) => {
        const reason = cleanAgentText(body!.reason as string);
        if (!reason)
          return fail("invalid_field", `reason must be ${EMPTY}.`, {
            field: "reason",
            expected: EMPTY,
          });
        const name =
          typeof body!.name === "string"
            ? cleanAgentText(body!.name)
            : undefined;
        if (name === "")
          return fail("invalid_field", `name must be ${EMPTY}.`, {
            field: "name",
            expected: EMPTY,
          });
        const timeoutMs =
          typeof body!.timeoutMs === "number" ? body!.timeoutMs : 600000;
        const request = controller.addSpaceRequest({
          reason,
          ...(name === undefined ? {} : { name }),
        });
        let outcome: Outcome;
        try {
          outcome = await new Promise<Outcome>((resolve) => {
            const settle = (value: Outcome) => {
              clearTimeout(timer);
              run.signal.removeEventListener("abort", closed);
              waiting.delete(request.id);
              resolve(value);
            };
            const closed = () => settle("closed");
            const timer = setTimeout(() => settle("timeout"), timeoutMs);
            waiting.set(request.id, settle);
            run.signal.addEventListener("abort", closed);
            if (run.signal.aborted) closed();
          });
        } finally {
          controller.removeSpaceRequest(request.id);
        }
        if (outcome === "closed") return;
        if (outcome === "timeout")
          return fail(
            "request_timeout",
            `The person did not answer within ${timeoutMs} ms.`,
            { awaited: "approval", timeoutMs },
          );
        if (outcome === "declined")
          return fail(
            "request_declined",
            "The person did not let an agent use a space.",
          );
        const { space } = outcome;
        const shown = controller.shownTab(space.id);
        // A file shown in the space leaves no active tab.
        return send(response, 200, {
          space: spaceView(space, controller.state.tabs),
          tabs: controller.state.tabs
            .filter((tab) => tab.spaceId === space.id && agentVisible(tab))
            .map((tab) => tabView(tab, shown)),
          active: shown && agentVisible(shown) ? tabView(shown, shown) : null,
        });
      },
    },
  };
  return {
    routes,
    // The person's answer in the app. A grant that fails throws back to the
    // app, and the request keeps waiting.
    answer(id: string, answer: { allow: boolean; spaceId?: string }): void {
      const settle = waiting.get(id);
      if (!settle) throw new Error("That request is no longer waiting.");
      if (!answer.allow) {
        declinedAt = Date.now();
        return settle("declined");
      }
      const chosen = controller.state.spaces.find(
        (space) => space.id === answer.spaceId,
      );
      if (!chosen || (chosen.kind === "agent" && chosen.access === "granted"))
        throw new Error(
          "Choose one of your spaces or an agent space without access.",
        );
      settle({ space: grantSpace(chosen.id) });
    },
    // Closing the server withdraws every request.
    close(): void {
      for (const settle of [...waiting.values()]) settle("closed");
    },
  };
}
