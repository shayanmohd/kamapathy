import type { Space, Tab } from "../../shared/types";
import { fail } from "./errors";
import type { AutomationController } from "./server";

export interface Authority {
  readonly managedSpaces: Set<string>;
  readonly stopped: boolean;
  authorizeSpace(id: string, resuming?: boolean): Space;
  authorizeTab(id: string): Tab;
  grantSpace(id: string): void;
  stop(): void;
}

export function createAuthority(controller: AutomationController): Authority {
  const managedSpaces = new Set<string>();
  let stopped = false;
  // Taking control back is the one request allowed while the person has it.
  const authorizeSpace = (id: string, resuming = false): Space => {
    const space = controller.state.spaces.find((item) => item.id === id);
    if (!space || !managedSpaces.has(id) || space.kind !== "agent")
      return fail(404, "space_not_found", "Agent space was not found.");
    if (space.owner !== "agent" && !resuming)
      return fail(
        409,
        "human_control",
        `The person is using this space. Wait for them. If they tell you they are done or ask you to continue, take control back with resume ${space.id}.`,
      );
    if (stopped)
      return fail(503, "automation_stopped", "Automation is disabled.");
    return space;
  };
  const authorizeTab = (id: string) => {
    const tab = controller.state.tabs.find((item) => item.id === id);
    if (!tab || !managedSpaces.has(tab.spaceId))
      return fail(404, "tab_not_found", "Agent tab was not found.");
    authorizeSpace(tab.spaceId);
    return tab;
  };
  return {
    managedSpaces,
    get stopped() {
      return stopped;
    },
    authorizeSpace,
    authorizeTab,
    grantSpace(id: string) {
      const space = controller.state.spaces.find((item) => item.id === id);
      if (stopped || space?.kind !== "agent" || space.owner !== "agent")
        throw new Error("Only an active agent space can be connected.");
      for (const managedId of managedSpaces)
        if (!controller.state.spaces.some((item) => item.id === managedId))
          managedSpaces.delete(managedId);
      if (!managedSpaces.has(id) && managedSpaces.size >= 12)
        throw new Error(
          "Close an agent space before granting another. The limit is 12.",
        );
      managedSpaces.add(id);
    },
    stop() {
      stopped = true;
      managedSpaces.clear();
    },
  };
}
