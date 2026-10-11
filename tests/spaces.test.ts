import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { initialState } from "../shared/state";
import type { Activity, Space } from "../shared/types";
import {
  acknowledgeHandoff,
  agentStatus,
  HANDOFF_MESSAGE,
  RECENT_ACTION_MS,
  spaceButtonState,
} from "../src/lib/spaces";
import { agentBarCopy, spacesCopy, statusCopy } from "../src/copy";

const now = 1_000_000;
const entry = (
  message: string,
  age: number,
  kind: Activity["kind"] = "info",
) => ({ message, time: now - age, kind });
function withAgent(
  owner: Space["owner"],
  entries: ReturnType<typeof entry>[] = [],
  automationEnabled = true,
) {
  const state = initialState();
  const space: Space = {
    id: "task",
    name: "Research",
    color: "purple",
    kind: "agent",
    owner,
    signIns: "shared",
    createdAt: 0,
  };
  state.spaces.push(space);
  state.settings.automationEnabled = automationEnabled;
  state.activity = entries.map((item, index) => ({
    id: `a${index}`,
    spaceId: space.id,
    ...item,
  }));
  return { state, space };
}

describe("agent status", () => {
  it("is browsing only while the agent acted in the last five seconds", () => {
    const recent = withAgent("agent", [
      entry("Agent clicked an element", RECENT_ACTION_MS - 1),
    ]);
    expect(agentStatus(recent.space, recent.state, now, new Set())).toBe("browsing");
    const old = withAgent("agent", [
      entry("Agent clicked an element", RECENT_ACTION_MS),
    ]);
    expect(agentStatus(old.space, old.state, now, new Set())).toBe("idle");
  });
  it("does not count the person's own control changes as agent actions", () => {
    const { state, space } = withAgent("agent", [
      entry("Control returned to the agent.", 10),
    ]);
    expect(agentStatus(space, state, now, new Set())).toBe("idle");
  });
  it("tells a handoff apart from the person taking over", () => {
    const handed = withAgent("human", [
      entry(HANDOFF_MESSAGE, 10, "success"),
      entry("You took control. Agent access is paused.", 11),
    ]);
    expect(agentStatus(handed.space, handed.state, now, new Set())).toBe("needs-you");
    expect(agentStatus(handed.space, handed.state, now, new Set(["a0"]))).toBe(
      "in-control",
    );
    const taken = withAgent("human", [
      entry("You took control. Agent access is paused.", 10),
    ]);
    expect(agentStatus(taken.space, taken.state, now, new Set())).toBe("in-control");
  });
  it("stops claiming an agent is working once agent access is off", () => {
    const { state, space } = withAgent(
      "agent",
      [entry("Agent clicked an element", 10)],
      false,
    );
    expect(agentStatus(space, state, now, new Set())).toBe("paused");
  });
  it("a granted personal space gets the agent bar statuses, and a finished or stopped agent space says so", () => {
    const state = initialState();
    const work = state.spaces.find((space) => space.id === "work")!;
    work.access = "granted";
    work.owner = "agent";
    expect(agentStatus(work, state, now, new Set())).toBe("idle");
    work.owner = "human";
    expect(agentStatus(work, state, now, new Set())).toBe("in-control");
    work.access = "ended";
    work.ended = { by: "person", reason: "stopped", at: now };
    expect(agentStatus(work, state, now, new Set())).toBeUndefined();
    const { state: agentState, space } = withAgent("human");
    space.access = "ended";
    space.ended = { by: "agent", reason: "finished", at: now };
    expect(agentStatus(space, agentState, now, new Set())).toBe("finished");
    space.ended = { by: "person", reason: "stopped", at: now };
    expect(agentStatus(space, agentState, now, new Set())).toBe("stopped");
    expect([statusCopy.finished, agentBarCopy.status.finished]).toEqual([
      "Agent finished",
      "Agent finished",
    ]);
    expect([statusCopy.stopped, agentBarCopy.status.stopped]).toEqual([
      "You stopped the agent",
      "You stopped the agent",
    ]);
  });
  it("has no status for personal spaces", () => {
    const state = initialState();
    expect(agentStatus(state.spaces[0], state, now, new Set())).toBeUndefined();
  });
  it("matches the message the automation server records on handoff", () => {
    const source = readFileSync(
      new URL("../electron/agent/routes/spaces.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(`"${HANDOFF_MESSAGE}"`);
  });
});

describe("space button", () => {
  it("counts agent-controlled spaces and spins while one is browsing", () => {
    const { state } = withAgent("agent", [entry("Agent clicked an element", 10)]);
    expect(spaceButtonState(state, now, new Set())).toEqual({
      color: "green",
      working: 1,
      spinning: true,
      needsYou: false,
    });
    expect(
      spaceButtonState(state, now + RECENT_ACTION_MS, new Set()),
    ).toMatchObject({ working: 1, spinning: false });
  });
  it("shows nothing working once agent access is off", () => {
    const { state } = withAgent(
      "agent",
      [entry("Agent clicked an element", 10)],
      false,
    );
    expect(spaceButtonState(state, now, new Set())).toMatchObject({
      working: 0,
      spinning: false,
    });
  });
  it("marks a handoff until the person opens that space", () => {
    const { state, space } = withAgent("human", [
      entry(HANDOFF_MESSAGE, 10, "success"),
    ]);
    expect(spaceButtonState(state, now, new Set()).needsYou).toBe(true);
    const seen = acknowledgeHandoff(new Set(), state.activity, space.id);
    expect(spaceButtonState(state, now, seen).needsYou).toBe(false);
    expect(acknowledgeHandoff(seen, state.activity, space.id)).toBe(seen);
    expect(acknowledgeHandoff(seen, state.activity, "personal")).toBe(seen);
  });
  it("a waiting request raises the alert dot", () => {
    const state = initialState();
    expect(spaceButtonState(state, now, new Set()).needsYou).toBe(false);
    state.spaceRequests.push({ id: "request", reason: "Book a table", at: now });
    expect(spaceButtonState(state, now, new Set()).needsYou).toBe(true);
  });
  it("names the button after the current space and what agents need", () => {
    expect(spacesCopy.button("Personal", 0, false)).toBe("Spaces: Personal");
    expect(spacesCopy.button("Personal", 2, true)).toBe(
      "Spaces: Personal, 2 agents working, an agent needs you",
    );
  });
});
