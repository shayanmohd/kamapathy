import type { ControlReason, Space, Tab } from "../../shared/types";
import { fail } from "./errors";
import type { AutomationController } from "./server";

// Only the reasons the agent itself can end; holds and approvals end when
// the person answers.
const RESUMABLE: readonly ControlReason[] = ["manual", "handoff", "failed"];

export function humanControlMessage(
  reason: ControlReason,
  prompt?: string,
): string {
  switch (reason) {
    case "manual":
      return "The person took over this space. Stop, and resume only when they ask you to.";
    case "handoff":
      return "You handed this space to the person. Resume when they say they are done.";
    case "failed":
      return "You reported that this task could not be finished. Resume only when the person asks you to.";
    case "approval":
      return `Kamapathy is asking the person to approve ${prompt}. Wait for control.`;
    default:
      return `The site asked for ${prompt}, and only the person can answer. Wait for control.`;
  }
}

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
  // and taking control back ("resume") get through, and a resume only when
  // the agent may end the person's control.
  const authorizeSpace = (
    id: string,
    options: { human?: "allow" | "resume" } = {},
  ): Space => {
    if (stopped) return fail("automation_stopped", "Automation is disabled.");
    const space = controller.state.spaces.find((item) => item.id === id);
    if (!space || !managedSpaces.has(id) || space.kind !== "agent")
      return fail("space_not_found", "Agent space was not found.");
    if (space.owner === "agent" || options.human === "allow") return space;
    const { reason = "manual", prompt, since } = space.control ?? {};
    if (options.human === "resume" && RESUMABLE.includes(reason)) return space;
    return fail("human_control", humanControlMessage(reason, prompt), {
      spaceId: space.id,
      reason,
      ...(prompt === undefined ? {} : { prompt }),
      ...(since === undefined ? {} : { since }),
    });
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
