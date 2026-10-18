import { describe, expect, it } from "vitest";
import { initialState, newTab } from "../shared/state";
import type { Activity, Space, Tab } from "../shared/types";
import {
  acknowledgeTask,
  agentStatus,
  RECENT_ACTION_MS,
  spaceButtonState,
  statusLine,
  taskKey,
  type AgentStatus,
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
  it("Failed and Done outrank ownership", () => {
    const failed = withAgent("human");
    failed.space.task = {
      state: "failed",
      status: "The site needs a phone number I do not have",
      changedAt: 900,
    };
    expect(agentStatus(failed.space, failed.state, now, new Set())).toBe("failed");
    // The chip keeps saying Failed after the person has seen the mark.
    expect(
      agentStatus(failed.space, failed.state, now, new Set(["task:900"])),
    ).toBe("failed");
    const done = withAgent("agent");
    done.space.task = { state: "done", changedAt: 900 };
    expect(agentStatus(done.space, done.state, now, new Set())).toBe("done");
    const ended = withAgent("human");
    ended.space.access = "ended";
    ended.space.ended = { by: "agent", reason: "finished", at: now };
    ended.space.task = { state: "done", changedAt: 900 };
    expect(agentStatus(ended.space, ended.state, now, new Set())).toBe("done");
    delete ended.space.task;
    expect(agentStatus(ended.space, ended.state, now, new Set())).toBe("done");
    ended.space.ended = { by: "person", reason: "stopped", at: now };
    expect(agentStatus(ended.space, ended.state, now, new Set())).toBe("stopped");
  });
  it("Needs you follows task state whatever the owner, and on a human-owned space only until seen", () => {
    const working = withAgent("agent");
    working.space.task = { state: "needs-you", changedAt: 900 };
    expect(agentStatus(working.space, working.state, now, new Set())).toBe(
      "needs-you",
    );
    expect(
      agentStatus(working.space, working.state, now, new Set(["task:900"])),
    ).toBe("needs-you");
    const handed = withAgent("human");
    handed.space.task = {
      state: "needs-you",
      reason: "Sign in, then let the agent continue.",
      changedAt: 900,
    };
    expect(taskKey(handed.space)).toBe("task:900");
    expect(agentStatus(handed.space, handed.state, now, new Set())).toBe(
      "needs-you",
    );
    const seen = acknowledgeTask(
      new Set(),
      handed.state.spaces,
      handed.space.id,
    );
    expect([...seen]).toEqual(["task:900"]);
    expect(agentStatus(handed.space, handed.state, now, seen)).toBe("in-control");
    expect(acknowledgeTask(seen, handed.state.spaces, handed.space.id)).toBe(seen);
    expect(acknowledgeTask(seen, handed.state.spaces, "personal")).toBe(seen);
    // A task with no state carries no key, so a status never unmarks a space.
    handed.space.task = { status: "Comparing prices", changedAt: 1000 };
    expect(taskKey(handed.space)).toBeUndefined();
    expect(acknowledgeTask(seen, handed.state.spaces, handed.space.id)).toBe(seen);
    // The handoff's activity entry says nothing about the state.
    const noted = withAgent("human", [
      entry("Agent handed this space to you", 10, "success"),
    ]);
    expect(agentStatus(noted.space, noted.state, now, new Set())).toBe("in-control");
  });
  it("a crashed tab shows Page stopped", () => {
    const { state, space } = withAgent("agent", [
      entry("Agent clicked an element", 10),
    ]);
    const tab: Tab = { ...newTab(space.id), crashed: true };
    state.tabs.push(tab);
    expect(agentStatus(space, state, now, new Set())).toBe("error");
    space.owner = "human";
    expect(agentStatus(space, state, now, new Set())).toBe("in-control");
    space.owner = "agent";
    state.settings.automationEnabled = false;
    expect(agentStatus(space, state, now, new Set())).toBe("paused");
    state.settings.automationEnabled = true;
    delete tab.crashed;
    expect(agentStatus(space, state, now, new Set())).toBe("browsing");
    state.activity = [];
    expect(agentStatus(space, state, now, new Set())).toBe("idle");
  });
  it("stops claiming an agent is working once agent access is off", () => {
    const { state, space } = withAgent(
      "agent",
      [entry("Agent clicked an element", 10)],
      false,
    );
    expect(agentStatus(space, state, now, new Set())).toBe("paused");
  });
  it("a granted personal space gets the agent bar statuses only while the grant lasts", () => {
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
  });
  it("has no status for personal spaces", () => {
    const state = initialState();
    expect(agentStatus(state.spaces[0], state, now, new Set())).toBeUndefined();
  });
  it("the status line prefers a label under 5 s old, then the reason, then the status", () => {
    const { space } = withAgent("agent");
    expect(statusLine(space, now)).toBeUndefined();
    const task = {
      status: "Comparing prices on three sites",
      state: "needs-you" as const,
      reason: "Sign in, then let the agent continue.",
      changedAt: 900,
    };
    space.task = {
      ...task,
      label: { text: "Opening the cart", active: true, at: 0 },
    };
    expect(statusLine(space, now)).toEqual({
      text: "Opening the cart",
      agent: true,
    });
    space.task = {
      ...task,
      label: {
        text: "Opening the cart",
        active: false,
        at: now - RECENT_ACTION_MS + 1,
      },
    };
    expect(statusLine(space, now)).toEqual({
      text: "Opening the cart",
      agent: true,
    });
    space.task = {
      ...task,
      label: {
        text: "Opening the cart",
        active: false,
        at: now - RECENT_ACTION_MS - 1,
      },
    };
    // Kamapathy's own reason is never shown as the agent's words.
    expect(statusLine(space, now)).toEqual({
      text: "Sign in, then let the agent continue.",
      agent: false,
    });
    space.task = { status: task.status, changedAt: 900 };
    expect(statusLine(space, now)).toEqual({
      text: "Comparing prices on three sites",
      agent: true,
    });
    space.task = { changedAt: 900 };
    expect(statusLine(space, now)).toBeUndefined();
  });
  it("every state has a chip and a bar phrase", () => {
    const states: Record<AgentStatus, true> = {
      browsing: true,
      idle: true,
      "needs-you": true,
      "in-control": true,
      paused: true,
      done: true,
      stopped: true,
      failed: true,
      error: true,
    };
    for (const state of Object.keys(states) as AgentStatus[]) {
      expect(statusCopy[state]).toBeTruthy();
      expect(agentBarCopy.status[state]).toBeTruthy();
    }
    expect([statusCopy.done, statusCopy.failed, statusCopy.error]).toEqual([
      "Done",
      "Failed",
      "Page stopped",
    ]);
    expect([
      agentBarCopy.status.done,
      agentBarCopy.status.failed,
      agentBarCopy.status.error,
    ]).toEqual([
      "Agent is done",
      "Agent could not finish",
      "A page stopped working",
    ]);
    expect(agentBarCopy.agentNeedsYou).toBe("Agent needs you");
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
      failed: false,
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
  it("the Spaces button counts error spaces and alerts for unseen failures", () => {
    const { state, space } = withAgent("agent", [
      entry("Agent clicked an element", 10),
    ]);
    const idle: Space = { ...space, id: "reading", name: "Reading" };
    const errored: Space = { ...space, id: "shopping", name: "Shopping" };
    state.spaces.push(idle, errored);
    state.tabs.push({ ...newTab(errored.id), crashed: true });
    expect(spaceButtonState(state, now, new Set())).toEqual({
      color: "green",
      working: 3,
      spinning: true,
      needsYou: false,
      failed: false,
    });
    expect(
      spaceButtonState(state, now + RECENT_ACTION_MS, new Set()),
    ).toMatchObject({ working: 3, spinning: false });
    const research: Space = {
      ...space,
      id: "research",
      name: "Research",
      owner: "human",
      task: { state: "needs-you", changedAt: 900 },
    };
    state.spaces.push(research);
    expect(spaceButtonState(state, now, new Set())).toMatchObject({
      needsYou: true,
      failed: false,
    });
    research.task = {
      state: "failed",
      status: "The site needs a phone number I do not have",
      changedAt: 901,
    };
    expect(spaceButtonState(state, now, new Set())).toMatchObject({
      working: 3,
      needsYou: false,
      failed: true,
    });
    const seen = acknowledgeTask(new Set(), state.spaces, research.id);
    expect(spaceButtonState(state, now, seen)).toMatchObject({
      needsYou: false,
      failed: false,
    });
    state.spaceRequests.push({ id: "request", reason: "Book a table", at: now });
    expect(spaceButtonState(state, now, seen).needsYou).toBe(true);
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
