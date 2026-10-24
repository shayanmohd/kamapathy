import type { Activity, BrowserState, Space, SpaceColor } from "../../shared/types";

// How long an agent action counts as recent, and how long a label stays.
export const RECENT_ACTION_MS = 5000;

export type AgentStatus =
  | "browsing"
  | "idle"
  | "needs-you"
  | "in-control"
  | "paused"
  | "done"
  | "stopped"
  | "failed"
  | "error";

export function isAgentAction(item: Activity): boolean {
  return !!item.spaceId && item.message.startsWith("Agent ");
}

export function spaceActivity(
  activity: Activity[],
  spaceId: string,
): Activity[] {
  return activity.filter((item) => item.spaceId === spaceId);
}

// The key the person marks by opening a space. Only a state asks for them,
// and changedAt moves on state changes alone, so a status or a label never
// unmarks what they have already seen.
export function taskKey(space: Space): string | undefined {
  const task = space.task;
  return task?.state ? `${space.id}:${task.changedAt}` : undefined;
}

function isSeen(space: Space, seen: ReadonlySet<string>): boolean {
  const key = taskKey(space);
  return key !== undefined && seen.has(key);
}

export function acknowledgeTask(
  seen: ReadonlySet<string>,
  spaces: readonly Space[],
  spaceId: string,
): ReadonlySet<string> {
  const space = spaces.find((item) => item.id === spaceId);
  const key = space && taskKey(space);
  return key && !seen.has(key) ? new Set([...seen, key]) : seen;
}

export function agentStatus(
  space: Space,
  state: Pick<BrowserState, "activity" | "settings" | "tabs">,
  now: number,
  seen: ReadonlySet<string>,
): AgentStatus | undefined {
  // A personal space has a status only while an agent may use it.
  if (space.kind !== "agent" && space.access !== "granted") return undefined;
  const task = space.task;
  // How the task ended comes before who holds the space.
  if (task?.state === "failed") return "failed";
  if (
    task?.state === "done" ||
    (space.access === "ended" && space.ended?.by === "agent")
  )
    return "done";
  if (space.access === "ended") return "stopped";
  // The agent asks for the person whoever has control; a space they already
  // hold asks only until they open it.
  if (
    task?.state === "needs-you" &&
    !(space.owner === "human" && isSeen(space, seen))
  )
    return "needs-you";
  if (space.owner === "human") return "in-control";
  if (!state.settings.automationEnabled) return "paused";
  if (state.tabs.some((tab) => tab.spaceId === space.id && tab.crashed))
    return "error";
  const recent = state.activity.find(
    (item) => item.spaceId === space.id && isAgentAction(item),
  );
  return recent && now - recent.time < RECENT_ACTION_MS ? "browsing" : "idle";
}

export const spaceColors: SpaceColor[] = ["green", "blue", "orange", "purple"];

// The line under a space's name: a label while it is fresh, then Kamapathy's
// own reason, then whatever the agent last said. `agent` marks the agent's
// own words, which the shell styles as theirs.
export function statusLine(
  space: Space,
  now: number,
): { text: string; agent: boolean } | undefined {
  const task = space.task;
  if (!task) return undefined;
  const label = task.label;
  if (label && (label.active || now - label.at < RECENT_ACTION_MS))
    return { text: label.text, agent: true };
  if (task.state === "needs-you" && task.reason)
    return { text: task.reason, agent: false };
  if (task.status) return { text: task.status, agent: true };
  return undefined;
}

export interface SpaceButtonState {
  color: SpaceColor;
  working: number;
  spinning: boolean;
  needsYou: boolean;
  failed: boolean;
}

export function spaceButtonState(
  state: BrowserState,
  now: number,
  seen: ReadonlySet<string>,
): SpaceButtonState {
  const statuses = state.spaces.map((space) =>
    agentStatus(space, state, now, seen),
  );
  const current =
    state.spaces.find((space) => space.id === state.activeSpaceId) ??
    state.spaces[0];
  return {
    color: current.color,
    working: statuses.filter(
      (status) =>
        status === "browsing" || status === "idle" || status === "error",
    ).length,
    spinning: statuses.includes("browsing"),
    needsYou:
      statuses.includes("needs-you") || state.spaceRequests.length > 0,
    failed: state.spaces.some(
      (space, index) => statuses[index] === "failed" && !isSeen(space, seen),
    ),
  };
}

export function activityTime(time: number): string {
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
