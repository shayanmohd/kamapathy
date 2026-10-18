import { PAGE_BUDGET } from "../../../shared/state";
import type { Space, Tab } from "../../../shared/types";
import { activeSpace } from "../authority";
import { fail } from "../errors";
import { send, type RouteDeps, type RouteImpl } from "../http";
import type { AutomationController } from "../server";
import { stringField, urlField } from "../validate";
import { boundaryView, pagesOf, spaceView, tabView } from "../views";

const CONTROL_WAITS = 8;

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
  presence,
}: RouteDeps): Record<string, RouteImpl> {
  const { managedSpaces, authorizeSpace } = authority;
  // What this connection sees, in creation order: spaces it manages and may
  // still use, the person's own spaces only while granted.
  const listedSpaces = () =>
    controller.state.spaces.filter(
      (space) => managedSpaces.has(space.id) && activeSpace(space),
    );
  // What changed the last time control came back to the agent.
  const boundaryOf = (spaceId: string) => {
    const shown = controller.shownTab(spaceId);
    return boundaryView(
      controller.registry.lastBoundary(spaceId, shown ?? null),
      shown,
    );
  };
  let controlWaits = 0;
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
        if (authority.activeCount() >= 12)
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
        return send(response, 200, {
          ok: true,
          owner: "agent",
          ...boundaryOf(space!.id),
        });
      },
    },
    // Answers once the agent has control, at once if it already has. It
    // runs beside the space's queue and never takes control itself.
    "POST /spaces/:id/wait-for-control": {
      access: { human: "allow" },
      beforeBody: () => {
        if (controlWaits >= CONTROL_WAITS)
          return fail(
            "busy",
            `Kamapathy has ${CONTROL_WAITS} waits for control running. Try again shortly.`,
            { scope: "server" },
          );
        controlWaits += 1;
        return { release: () => void (controlWaits -= 1) };
      },
      handler: async ({ response, body, space, run }) => {
        const id = space!.id;
        const timeoutMs =
          typeof body!.timeoutMs === "number" ? body!.timeoutMs : 600000;
        const outcome = await new Promise<"agent" | "timeout" | "closed">(
          (resolve, reject) => {
            if (run.signal.aborted) return resolve("closed");
            const stop = () => {
              clearTimeout(timer);
              unsubscribe();
              run.signal.removeEventListener("abort", closed);
            };
            const settle = (outcome: "agent" | "timeout" | "closed") => {
              stop();
              resolve(outcome);
            };
            const closed = () => settle("closed");
            // The space can stop being the agent's while it waits.
            const check = () => {
              try {
                if (authorizeSpace(id, { human: "allow" }).owner === "agent")
                  settle("agent");
              } catch (error) {
                stop();
                reject(error);
              }
            };
            const timer = setTimeout(() => settle("timeout"), timeoutMs);
            const unsubscribe = controller.subscribe(check);
            run.signal.addEventListener("abort", closed);
            check();
          },
        );
        if (outcome === "closed") return;
        if (outcome === "timeout")
          return fail(
            "control_timeout",
            `Control did not return within ${timeoutMs} ms.`,
            {
              awaited: "control",
              timeoutMs,
              reason:
                controller.state.spaces.find((item) => item.id === id)?.control
                  ?.reason ?? "manual",
            },
          );
        return send(response, 200, {
          ok: true,
          owner: "agent",
          ...boundaryOf(id),
        });
      },
    },
    "POST /spaces/:id/finish": {
      handler: async ({ response, body, space, run }) => {
        const id = space!.id;
        const keep = body!.keep;
        if (
          keep !== "all" &&
          !(
            Array.isArray(keep) &&
            keep.length <= 20 &&
            keep.every((item) => typeof item === "string") &&
            new Set(keep).size === keep.length
          )
        )
          return fail(
            "invalid_field",
            'keep must be "all" or up to 20 unique tab ids.',
            { field: "keep", expected: '"all" or up to 20 unique tab ids' },
          );
        const ids = keep === "all" ? undefined : (keep as string[]);
        const tabs = controller.state.tabs.filter((tab) => tab.spaceId === id);
        // Every id is checked before anything closes.
        for (const tabId of ids ?? [])
          if (!tabs.some((tab) => tab.id === tabId))
            return fail("tab_not_found", "Agent tab was not found.", {
              tabId,
            });
        // The person's tabs, and tabs the agent never adopted, stay open.
        const isProtected = (tab: Tab) =>
          tab.openedBy === "person" || !tab.managed;
        const protectedTabs = tabs.filter(isProtected);
        const kept = tabs.filter(
          (tab) => !isProtected(tab) && (!ids || ids.includes(tab.id)),
        );
        const closing = tabs.filter(
          (tab) => !isProtected(tab) && !kept.includes(tab),
        );
        const labels = (list: Tab[]) =>
          list.flatMap((tab) => (tab.label ? [tab.label] : []));
        run.dispatch.dispatched = true;
        if (space!.kind === "agent" && !kept.length && !protectedTabs.length) {
          await controller.dispatch({ type: "space:delete", id });
          authority.managedSpaces.delete(id);
          return send(response, 200, {
            ok: true,
            spaceId: id,
            closedSpace: true,
            closed: labels(closing),
            kept: [],
            protected: [],
          });
        }
        const closed: string[] = [];
        for (const tab of closing) {
          const result = controller.closeTab(tab.id, "agent");
          if (result.closed) closed.push(result.closed);
        }
        // A granted personal space is never deleted. closeTab gives it a
        // blank tab if the last one closed.
        controller.endAccess(id, { by: "agent", reason: "finished" });
        presence.setState(id, "done");
        return send(response, 200, {
          ok: true,
          spaceId: id,
          closedSpace: false,
          closed,
          kept: labels(kept),
          protected: labels(protectedTabs),
        });
      },
    },
    "DELETE /spaces/:id": {
      handler: async ({ response, space }) => {
        if (space!.kind === "personal")
          return fail(
            "space_protected",
            "This space belongs to the person, so the agent cannot close it. Finish it instead.",
            {
              tabs: controller.state.tabs
                .filter(
                  (tab) =>
                    tab.spaceId === space!.id && tab.openedBy === "person",
                )
                .map(({ id, label, title, url }) => ({
                  id,
                  label,
                  title,
                  url,
                })),
            },
          );
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
          reason: "handoff",
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
