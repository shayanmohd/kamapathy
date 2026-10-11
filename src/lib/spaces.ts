import type { Activity, BrowserState, Space, SpaceColor } from "../../shared/types";

export const RECENT_ACTION_MS = 5000;
// electron/agent/routes/spaces.ts records this when an agent hands a space over.
export const HANDOFF_MESSAGE = "Agent handed this space to you";

export type AgentStatus =
  | "browsing"
  | "idle"
  | "needs-you"
  | "in-control"
  | "paused"
  | "finished"
  | "stopped";

export function isAgentAction(item: Activity): boolean {
  return !!item.spaceId && item.message.startsWith("Agent ");
}

export function spaceActivity(
  activity: Activity[],
  spaceId: string,
): Activity[] {
  return activity.filter((item) => item.spaceId === spaceId);
}

export function latestHandoffId(
  activity: Activity[],
  spaceId: string,
): string | undefined {
  const latest = activity.find((item) => item.spaceId === spaceId);
  return latest?.message === HANDOFF_MESSAGE ? latest.id : undefined;
}

export function agentStatus(
  space: Space,
  state: Pick<BrowserState, "activity" | "settings">,
  now: number,
  seen: ReadonlySet<string>,
): AgentStatus | undefined {
  // A personal space has a status only while an agent may use it.
  if (space.kind !== "agent" && space.access !== "granted") return undefined;
  if (space.access === "ended")
    return space.ended?.by === "agent" ? "finished" : "stopped";
  if (space.owner === "human") {
    const handoff = latestHandoffId(state.activity, space.id);
    return handoff && !seen.has(handoff) ? "needs-you" : "in-control";
  }
  if (!state.settings.automationEnabled) return "paused";
  const recent = state.activity.find(
    (item) => item.spaceId === space.id && isAgentAction(item),
  );
  return recent && now - recent.time < RECENT_ACTION_MS ? "browsing" : "idle";
}

export const spaceColors: SpaceColor[] = ["green", "blue", "orange", "purple"];

export function acknowledgeHandoff(
  seen: ReadonlySet<string>,
  activity: Activity[],
  spaceId: string,
): ReadonlySet<string> {
  const id = latestHandoffId(activity, spaceId);
  return id && !seen.has(id) ? new Set([...seen, id]) : seen;
}

export interface SpaceButtonState {
  color: SpaceColor;
  working: number;
  spinning: boolean;
  needsYou: boolean;
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
      (status) => status === "browsing" || status === "idle",
    ).length,
    spinning: statuses.includes("browsing"),
    needsYou:
      statuses.includes("needs-you") || state.spaceRequests.length > 0,
  };
}

export function activityTime(time: number): string {
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
