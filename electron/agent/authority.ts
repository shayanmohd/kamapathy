import { agentRules } from "../../shared/state";
import type { ControlReason, Space, Tab } from "../../shared/types";
import { ApiError, fail } from "./errors";
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
  grantSpace(id: string): Space;
  activeCount(): number;
  stop(): void;
  agentDriven(spaceId: string): boolean;
}

// A space an agent may use now: an agent space or a granted one, until
// finish or Stop ends its access. A kept space is neither.
export function activeSpace(space: Space): boolean {
  return space.access !== "ended" && agentRules(space);
}

// Every request on a space after finish or Stop answers this until the
// person grants it again.
export function spaceEnded(space: Space): ApiError | undefined {
  if (!space.ended) return undefined;
  return new ApiError(
    "space_ended",
    space.ended.by === "agent"
      ? "The agent finished this space. Open or create another space to continue."
      : "The person stopped the agent in this space. Stop here and tell them; only they can let an agent use it again.",
    {
      spaceId: space.id,
      endedBy: space.ended.by,
      reason: space.ended.reason,
    },
  );
}

export function createAuthority(controller: AutomationController): Authority {
  const managedSpaces = new Set<string>();
  let stopped = false;
  // Only active spaces count toward the limit of 12. Deleted ones are
  // forgotten here.
  const activeCount = () => {
    let count = 0;
    for (const id of managedSpaces) {
      const space = controller.state.spaces.find((item) => item.id === id);
      if (!space) managedSpaces.delete(id);
      else if (activeSpace(space)) count += 1;
    }
    return count;
  };
  // While the person has control, only routes that read the space ("allow")
  // and taking control back ("resume") get through, and a resume only when
  // the agent may end the person's control.
  const authorizeSpace = (
    id: string,
    options: { human?: "allow" | "resume" } = {},
  ): Space => {
    if (stopped) return fail("automation_stopped", "Automation is disabled.");
    const space = controller.state.spaces.find((item) => item.id === id);
    if (!space || !managedSpaces.has(id))
      return fail("space_not_found", "Agent space was not found.");
    // Only a space this server managed says it ended; others stay unknown.
    const ended = spaceEnded(space);
    if (ended) throw ended;
    if (!activeSpace(space))
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
    // The person's grant from the app: a personal space, an agent space
    // without access, or one whose access ended. Nothing changes when it
    // throws.
    grantSpace(id: string) {
      if (stopped) throw new Error("Turn on agent access first.");
      const space = controller.state.spaces.find((item) => item.id === id);
      if (!space) throw new Error("Space was not found.");
      // A grant in force stays as it is, so pages the agent adopted stay
      // its own.
      if (managedSpaces.has(id) && activeSpace(space)) return space;
      if (activeCount() >= 12)
        throw new Error(
          "Close an agent space before granting another. The limit is 12.",
        );
      managedSpaces.add(id);
      controller.grantAccess(id);
      return space;
    },
    activeCount,
    stop() {
      stopped = true;
      managedSpaces.clear();
    },
    // The agent drives a space it manages and may use while it has control.
    // Only then do the space's tabs hold debugger sessions.
    agentDriven(spaceId: string) {
      const space = controller.state.spaces.find(
        (item) => item.id === spaceId,
      );
      return (
        !stopped &&
        managedSpaces.has(spaceId) &&
        !!space &&
        activeSpace(space) &&
        space.owner === "agent"
      );
    },
  };
}
