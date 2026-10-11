import { PAGE_BUDGET } from "../../../shared/state";
import type { Space, Tab } from "../../../shared/types";
import { fail } from "../errors";
import { send, type RouteDeps, type RouteImpl } from "../http";
import type { AutomationController } from "../server";
import { stringField, urlField } from "../validate";
import { pagesOf, spaceView, tabView } from "../views";

// Pages the agent manages count toward its space's budget. Opening and
// adopting stop here before anything changes; popups count but never stop.
export function checkPageBudget(
  controller: AutomationController,
  space: Space,
): void {
  const limit = space.pageBudget ?? PAGE_BUDGET;
  const used = controller.registry.used(space.id);
  if (used >= limit)
    fail(
      "page_budget",
      `Page budget reached (${used} of ${limit}) in "${space.name}". Close a page or reuse one with navigate.`,
      {
        limit,
        used,
        pages: pagesOf(
          controller.state.tabs,
          space.id,
          controller.shownTab(space.id),
        ),
      },
    );
}

export function spaceRoutes({
  controller,
  authority,
}: RouteDeps): Record<string, RouteImpl> {
  const { managedSpaces, authorizeSpace } = authority;
  // The spaces this connection created or was granted, in creation order.
  const listedSpaces = () =>
    controller.state.spaces.filter(
      (space) => managedSpaces.has(space.id) && space.kind === "agent",
    );
  return {
    "GET /spaces": {
      handler: async ({ response }) =>
        send(response, 200, {
          spaces: listedSpaces().map((space) =>
            spaceView(space, controller.state.tabs),
          ),
        }),
    },
    "POST /spaces": {
      handler: async ({ response, body }) => {
        const name = stringField(body!, "name", 48).trim();
        const isolated =
          typeof body!.isolated === "boolean" ? body!.isolated : undefined;
        const pageBudget =
          typeof body!.pageBudget === "number" ? body!.pageBudget : undefined;
        // An id wins over a name, and the first space with a name over later ones.
        const listed = body!.reuse === true ? listedSpaces() : [];
        const found =
          listed.find((space) => space.id === name) ??
          listed.find((space) => space.name === name);
        if (found) {
          if (
            isolated !== undefined &&
            (isolated ? "separate" : "shared") !== found.signIns
          )
            return fail(
              "sign_ins_mismatch",
              `This space uses ${found.signIns === "shared" ? "the person's sign-ins" : "separate sign-ins"}. Open a space with another name to get different sign-ins.`,
              { spaceId: found.id, signIns: found.signIns },
            );
          if (pageBudget !== undefined)
            controller.setPageBudget(found.id, pageBudget);
          return send(response, 200, {
            space: spaceView(found, controller.state.tabs),
            created: false,
          });
        }
        for (const id of managedSpaces)
          if (!controller.state.spaces.some((space) => space.id === id))
            managedSpaces.delete(id);
        if (managedSpaces.size >= 12)
          return fail(
            "space_limit",
            "Close an agent space before creating another. The limit is 12.",
          );
        const space = controller.createAgentSpace(name, {
          isolated: isolated === true,
          pageBudget,
        });
        managedSpaces.add(space.id);
        controller.addActivity(
          space.id,
          "Agent connected to a new space",
          "success",
        );
        const first = controller.state.tabs.find(
          (tab) => tab.spaceId === space.id,
        )!;
        return send(response, 201, {
          space: spaceView(space, controller.state.tabs),
          tab: tabView(first, controller.shownTab(space.id)),
          created: true,
        });
      },
    },
    "GET /spaces/:id": {
      access: { human: "allow" },
      handler: async ({ response, space }) =>
        send(response, 200, {
          space: spaceView(space!, controller.state.tabs),
        }),
    },
    "POST /spaces/:id/resume": {
      access: { human: "resume" },
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
        const personTabs = controller.state.tabs.filter(
          (tab) => tab.spaceId === space!.id && tab.openedBy === "person",
        );
        if (personTabs.length)
          return fail(
            "space_protected",
            "The person opened tabs in this space, so the agent cannot close it. Finish it instead.",
            {
              tabs: personTabs.map(({ id, label, title, url }) => ({
                id,
                label,
                title,
                url,
              })),
            },
          );
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
      handler: async ({ response, space }) => {
        const shown = controller.shownTab(space!.id);
        return send(response, 200, {
          tabs: controller.state.tabs
            .filter((tab) => tab.spaceId === space!.id)
            .map((tab) => tabView(tab, shown)),
          closed: controller.registry
            .closed(space!.id)
            .map(({ label, closedBy, at }) => ({ label, closedBy, at })),
          budget: {
            used: controller.registry.used(space!.id),
            limit: space!.pageBudget ?? PAGE_BUDGET,
          },
        });
      },
    },
    "POST /spaces/:id/tabs": {
      handler: async ({ response, body, space, run }) => {
        const url = body!.url === undefined ? undefined : urlField(body!);
        checkPageBudget(controller, space!);
        if (
          controller.state.tabs.filter((tab) => tab.spaceId === space!.id)
            .length >= 20
        )
          return fail(
            "tab_limit",
            "Close a tab before creating another. The limit is 20 per agent space.",
          );
        run.dispatch.dispatched = true;
        let tab: Tab;
        try {
          tab = controller.openAgentTab(space!.id, url);
        } catch {
          return fail("tab_creation_failed", "Could not create an agent tab.");
        }
        authorizeSpace(space!.id);
        controller.addActivity(
          space!.id,
          url
            ? `Agent opened ${new URL(url).hostname}`
            : "Agent opened a blank page",
          "info",
        );
        return send(response, 201, {
          tab: tabView(tab, controller.shownTab(space!.id)),
        });
      },
    },
  };
}
