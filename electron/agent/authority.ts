import type { Space, Tab } from "../../shared/types";
import { fail } from "./errors";
import type { AutomationController } from "./server";

export interface Authority {
  readonly managedSpaces: Set<string>;
  readonly stopped: boolean;
  authorizeSpace(id: string, options?: { human?: "allow" | "resume" }): Space;
  authorizeTab(id: string, options?: { unmanaged?: true }): Tab;
  grantSpace(id: string): void;
  stop(): void;
  agentDriven(spaceId: string): boolean;
}

export function createAuthority(controller: AutomationController): Authority {
  const managedSpaces = new Set<string>();
  let stopped = false;
  // While the person has control, only routes that read the space ("allow")
  // and taking control back ("resume") get through.
  const authorizeSpace = (
    id: string,
    options: { human?: "allow" | "resume" } = {},
  ): Space => {
    if (stopped) return fail("automation_stopped", "Automation is disabled.");
    const space = controller.state.spaces.find((item) => item.id === id);
    if (!space || !managedSpaces.has(id) || space.kind !== "agent")
      return fail("space_not_found", "Agent space was not found.");
    if (space.owner !== "agent" && !options.human)
      return fail(
        "human_control",
        `The person is using this space. Wait for them. If they tell you they are done or ask you to continue, take control back with resume ${space.id}.`,
      );
    return space;
  };
  // Page routes need a tab the agent manages; adopt and release are the
  // two routes that reach the others.
  const authorizeTab = (
    id: string,
    options: { unmanaged?: true } = {},
  ): Tab => {
    if (stopped) return fail("automation_stopped", "Automation is disabled.");
    const tab = controller.state.tabs.find((item) => item.id === id);
    if (!tab || !managedSpaces.has(tab.spaceId))
      return fail("tab_not_found", "Agent tab was not found.", { tabId: id });
    authorizeSpace(tab.spaceId);
    if (!tab.managed && !options.unmanaged)
      return fail(
        "tab_unmanaged",
        "Kamapathy has not given this page to the agent. Adopt it first with adopt <tab> or space.adopt(page).",
        { tabId: tab.id, label: tab.label, openedBy: tab.openedBy },
      );
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
    // The agent drives a space it manages while it has control. Only then
    // do the space's tabs hold debugger sessions.
    agentDriven(spaceId: string) {
      const space = controller.state.spaces.find(
        (item) => item.id === spaceId,
      );
      return (
        !stopped &&
        managedSpaces.has(spaceId) &&
        space?.kind === "agent" &&
        space.owner === "agent"
      );
    },
  };
}
