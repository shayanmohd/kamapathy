import { useEffect, useState } from "react";
import type { Activity, Space } from "../../shared/types";
import { isAgentAction, RECENT_ACTION_MS } from "./spaces";

// Re-renders when the latest agent action, or the newest label that has
// stopped counting, no longer counts as recent. A label still running needs
// no timer, since its end writes the task again.
export function useAgentClock(
  activity: Activity[],
  spaces: readonly Space[],
): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const current = Date.now();
    setNow(current);
    const action = activity.find(isAgentAction);
    let label: number | undefined;
    for (const space of spaces) {
      const stopped = space.task?.label;
      if (!stopped || stopped.active) continue;
      if (label === undefined || stopped.at > label) label = stopped.at;
    }
    const expiries: number[] = [];
    if (action) expiries.push(action.time + RECENT_ACTION_MS);
    if (label !== undefined) expiries.push(label + RECENT_ACTION_MS);
    const next = expiries.filter((at) => at > current);
    if (next.length === 0) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(...next) - current + 20,
    );
    return () => clearTimeout(timer);
  }, [activity, spaces]);
  return now;
}
