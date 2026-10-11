import { fail } from "../errors";
import { send, type RouteDeps, type RouteImpl } from "../http";
import { stringField, urlField } from "../validate";

export function spaceRoutes({
  controller,
  authority,
}: RouteDeps): Record<string, RouteImpl> {
  const { managedSpaces, authorizeSpace } = authority;
  return {
    "GET /spaces": {
      handler: async ({ response }) =>
        send(response, 200, {
          spaces: controller.state.spaces.filter(
            (space) => managedSpaces.has(space.id) && space.kind === "agent",
          ),
        }),
    },
    "POST /spaces": {
      handler: async ({ response, body }) => {
        const name = stringField(body!, "name", 48).trim();
        for (const id of managedSpaces)
          if (!controller.state.spaces.some((space) => space.id === id))
            managedSpaces.delete(id);
        if (managedSpaces.size >= 12)
          return fail(
            "space_limit",
            "Close an agent space before creating another. The limit is 12.",
          );
        const isolated = body!.isolated === undefined ? false : body!.isolated;
        if (typeof isolated !== "boolean")
          return fail("invalid_field", "isolated must be true or false.");
        const space = controller.createAgentSpace(name, { isolated });
        managedSpaces.add(space.id);
        controller.addActivity(
          space.id,
          "Agent connected to a new space",
          "success",
        );
        return send(response, 201, { space });
      },
    },
    "POST /spaces/:id/resume": {
      handler: async ({ response, space }) => {
        if (space!.owner !== "agent") {
          await controller.dispatch({
            type: "space:ownership",
            id: space!.id,
            owner: "agent",
          });
          controller.addActivity(
            space!.id,
            "Agent took back control of this space",
            "info",
          );
        }
        return send(response, 200, { ok: true, owner: "agent" });
      },
    },
    "DELETE /spaces/:id": {
      handler: async ({ response, space }) => {
        await controller.dispatch({ type: "space:delete", id: space!.id });
        managedSpaces.delete(space!.id);
        return send(response, 200, { ok: true });
      },
    },
    "POST /spaces/:id/handoff": {
      handler: async ({ response, space }) => {
        await controller.dispatch({
          type: "space:ownership",
          id: space!.id,
          owner: "human",
        });
        controller.addActivity(
          space!.id,
          "Agent handed this space to you",
          "success",
        );
        return send(response, 200, { ok: true, owner: "human" });
      },
    },
    "GET /spaces/:id/tabs": {
      handler: async ({ response, space }) =>
        send(response, 200, {
          tabs: controller.state.tabs.filter(
            (tab) => tab.spaceId === space!.id,
          ),
        }),
    },
    "POST /spaces/:id/tabs": {
      handler: async ({ response, body, space, run }) => {
        const url = urlField(body!);
        const before = new Set(controller.state.tabs.map((tab) => tab.id));
        if (
          controller.state.tabs.filter((tab) => tab.spaceId === space!.id)
            .length >= 20
        )
          return fail(
            "tab_limit",
            "Close a tab before creating another. The limit is 20 per agent space.",
          );
        run.dispatch.dispatched = true;
        await controller.dispatch({
          type: "tab:create",
          spaceId: space!.id,
          url,
          background: true,
        });
        authorizeSpace(space!.id);
        const tab = controller.state.tabs.find(
          (item) => item.spaceId === space!.id && !before.has(item.id),
        );
        if (!tab)
          return fail(
            "tab_creation_failed",
            "Could not create an agent tab.",
          );
        controller.addActivity(
          space!.id,
          `Agent opened ${new URL(url).hostname}`,
          "info",
        );
        return send(response, 201, { tab });
      },
    },
  };
}
