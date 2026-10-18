import type { AgentTask, Space } from "../../shared/types";
import type { Authority } from "./authority";
import type { AutomationController } from "./server";

// What the person sees of an agent's work in a space: its status, how its
// task ended, and the marks that ask for them. This is the only writer of a
// space's task.
export interface AgentPresence {
  /** Sets or, with "", clears the space's status. The text is already cleaned. */
  setStatus(spaceId: string, text: string): { status?: string };
  /** Hands the space to the person as Failed. The message is already cleaned. */
  fail(
    spaceId: string,
    message: string,
  ): Promise<{ owner: "human"; state: "failed"; status: string }>;
  /** Marks the space, returning the task's new changedAt. */
  setState(
    spaceId: string,
    state: "needs-you" | "done",
    reason?: string,
  ): number;
  /** Clears needs-you only while changedAt still matches. */
  clearNeedsYou(spaceId: string, changedAt: number): void;
  /** Reveals the route's page before its first page step. Never throws. */
  follow(
    tabId: string,
    step: { deadline: number; signal?: AbortSignal },
  ): Promise<void>;
  close(): void;
}
// The controller's own cap for a reveal, so a step with more time left than
// this waits no longer than the reveal does.
const FRAME_WAIT = 500;

export function createPresence({
  controller,
  authority,
  now = Date.now,
}: {
  controller: AutomationController;
  authority: Authority;
  now?: () => number;
}): AgentPresence {
  const spaceOf = (spaceId: string): Space | undefined =>
    controller.state.spaces.find((space) => space.id === spaceId);
  const write = (spaceId: string, patch: Partial<AgentTask> | null) =>
    controller.setTask(spaceId, patch);
  // Writing a task emits, and this listener must not answer its own write.
  let reconciling = false;
  // Needs you, Failed and a grant that ended follow ownership, so no route
  // can forget to clear a mark. Spaces an agent may use, and any space still
  // holding a task, are checked.
  const reconcile = () => {
    if (reconciling) return;
    reconciling = true;
    try {
      const ids = new Set(authority.managedSpaces);
      for (const space of controller.state.spaces)
        if (space.task) ids.add(space.id);
      for (const id of ids) {
        const space = spaceOf(id);
        // A deleted space takes its task with it.
        if (!space) continue;
        // The person's space keeps nothing of the agent's once the grant ends.
        if (
          space.kind === "personal" &&
          !(authority.managedSpaces.has(id) && space.access === "granted")
        ) {
          if (space.task) write(id, null);
          continue;
        }
        if (space.owner === "agent") {
          // Control is back with the agent: the mark the person answered
          // goes, and a resume also clears the failure it reported.
          const { state } = space.task ?? {};
          if (state === "needs-you")
            write(id, { state: undefined, reason: undefined });
          else if (state === "failed")
            write(id, {
              state: undefined,
              reason: undefined,
              status: undefined,
            });
          continue;
        }
        const { reason = "manual", prompt } = space.control ?? {};
        // A takeover leaves the state as it was, and a reported failure
        // keeps the state fail() writes.
        if (reason === "manual" || reason === "failed") {
          if (space.task?.label) write(id, { label: undefined });
          continue;
        }
        write(id, { state: "needs-you", reason: prompt, label: undefined });
      }
    } finally {
      reconciling = false;
    }
  };
  const unsubscribe = controller.subscribe(reconcile);
  return {
    setStatus(spaceId, text) {
      const current = spaceOf(spaceId)?.task?.status;
      // Repeating the status, or clearing a status nothing set, does nothing.
      if ((current ?? "") !== text) {
        write(spaceId, { status: text || undefined });
        controller.addActivity(
          spaceId,
          text ? "Agent updated its status" : "Agent cleared its status",
          "info",
          text || undefined,
        );
      }
      const status = spaceOf(spaceId)?.task?.status;
      return status === undefined ? {} : { status };
    },
    async fail(spaceId, message) {
      await controller.dispatch({
        type: "space:ownership",
        id: spaceId,
        owner: "human",
        reason: "failed",
      });
      write(spaceId, {
        state: "failed",
        status: message,
        reason: undefined,
        label: undefined,
      });
      controller.addActivity(
        spaceId,
        "Agent could not finish",
        "warning",
        message,
      );
      return { owner: "human", state: "failed", status: message };
    },
    setState(spaceId, state, reason) {
      const task = write(spaceId, { state, reason, label: undefined });
      return task?.changedAt ?? now();
    },
    clearNeedsYou(spaceId, changedAt) {
      const task = spaceOf(spaceId)?.task;
      if (task?.state !== "needs-you" || task.changedAt !== changedAt) return;
      write(spaceId, { state: undefined, reason: undefined });
    },
    async follow(tabId, step) {
      // A request whose client is gone reveals nothing.
      if (step.signal?.aborted) return;
      let timer: NodeJS.Timeout | undefined;
      try {
        // Following the agent never costs an action its result, so neither
        // a reveal that fails nor one that runs long reaches the route.
        const revealed = controller.showAgentTab(tabId).catch(() => {});
        const left = Math.min(FRAME_WAIT, step.deadline - now());
        await Promise.race([
          revealed,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, left));
          }),
        ]);
      } catch {
        // A browser that is closing shows nothing.
      } finally {
        clearTimeout(timer);
      }
    },
    close: unsubscribe,
  };
}
