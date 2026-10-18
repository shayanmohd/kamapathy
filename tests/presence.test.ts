import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { createAuthority } from "../electron/agent/authority";
import { ApiError } from "../electron/agent/errors";
import { createPresence, type AgentPresence } from "../electron/agent/presence";
import { agentTextField } from "../electron/agent/validate";
import { spaceView } from "../electron/agent/views";
import { BrowserController } from "../electron/controller";
import { initialState } from "../shared/state";
import type { Space } from "../shared/types";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  WebContentsView: vi.fn(),
  nativeTheme: { themeSource: "system" },
  session: { fromPartition: vi.fn(() => new FakeSession()) },
  dialog: { showMessageBox: vi.fn(), showSaveDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(async () => {}) },
}));
vi.mock("../electron/persistence", async (original) => ({
  ...(await original<typeof import("../electron/persistence")>()),
  writeState: vi.fn(),
}));

class FakeSession extends EventEmitter {
  setPermissionCheckHandler = vi.fn();
  setPermissionRequestHandler = vi.fn();
}

describe("agent presence", () => {
  let controller: BrowserController;
  let authority: ReturnType<typeof createAuthority>;
  let presence: AgentPresence;
  // Characters by code point, so this file holds none of the invisible ones
  // the cleaning is about.
  const chars = (...codes: number[]) => String.fromCodePoint(...codes);
  // The status route's own reading of a body, so presence always gets text
  // that has been through the field's limit and cleaning.
  const statusText = (text: string) =>
    agentTextField({ text }, "text", "status", { allowEmpty: true });
  const failMessage = (message: string) =>
    agentTextField({ message }, "message", "message");
  const taskOf = (spaceId: string) =>
    controller.state.spaces.find((space) => space.id === spaceId)?.task;
  const entries = (spaceId: string) =>
    controller.state.activity
      .filter((entry) => entry.spaceId === spaceId)
      .map(({ message, kind, agentText }) => ({ message, kind, agentText }))
      .reverse();
  const view = (spaceId: string) =>
    spaceView(
      controller.state.spaces.find((space) => space.id === spaceId)!,
      controller.state.tabs,
    );
  // An agent space this server manages, as POST /spaces leaves one.
  const agentSpace = (name = "Research"): Space => {
    const space = controller.createAgentSpace(name);
    authority.managedSpaces.add(space.id);
    return space;
  };
  const refusal = (
    spaceId: string,
    options?: { human?: "allow" | "resume" },
  ) => {
    try {
      authority.authorizeSpace(spaceId, options);
    } catch (error) {
      return error as ApiError;
    }
    return undefined;
  };
  beforeEach(() => {
    vi.clearAllMocks();
    const window = new EventEmitter() as EventEmitter & Record<string, unknown>;
    window.webContents = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      focus: vi.fn(),
      isDestroyed: () => false,
    });
    window.contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    window.isDestroyed = () => false;
    window.getContentSize = () => [1400, 900];
    window.isVisible = () => true;
    window.isMinimized = () => false;
    controller = new BrowserController(
      window as unknown as BrowserWindow,
      initialState(),
      "unused-test-state.json",
    );
    authority = createAuthority(controller);
    presence = createPresence({ controller, authority });
  });
  afterEach(() => {
    presence.close();
    controller.dispose();
  });

  it("status is cleaned, logged once per change and listed", () => {
    const space = agentSpace();
    const text = statusText(
      `Comparing${chars(0x202e)}prices on${chars(0x09)}three sites  `,
    );
    expect(presence.setStatus(space.id, text)).toEqual({
      status: "Comparingprices on three sites",
    });
    expect(taskOf(space.id)).toEqual({
      status: "Comparingprices on three sites",
      changedAt: expect.any(Number),
    });
    expect(entries(space.id).at(-1)).toEqual({
      message: "Agent updated its status",
      kind: "info",
      agentText: "Comparingprices on three sites",
    });
    // The same status again changes nothing and logs nothing.
    const logged = controller.state.activity.length;
    expect(presence.setStatus(space.id, text)).toEqual({
      status: "Comparingprices on three sites",
    });
    expect(controller.state.activity).toHaveLength(logged);
    expect(view(space.id)).toMatchObject({
      status: "Comparingprices on three sites",
    });
    expect(view(space.id)).not.toHaveProperty("state");
    // An empty status clears it, and clearing twice logs once.
    expect(presence.setStatus(space.id, statusText(chars(0x07)))).toEqual({});
    expect(taskOf(space.id)).not.toHaveProperty("status");
    expect(entries(space.id).at(-1)).toEqual({
      message: "Agent cleared its status",
      kind: "info",
      agentText: undefined,
    });
    presence.setStatus(space.id, "");
    expect(
      entries(space.id).filter(
        (entry) => entry.message === "Agent cleared its status",
      ),
    ).toHaveLength(1);
    expect(view(space.id)).not.toHaveProperty("status");
    // A crashed page in a space the agent drives is a state of its own, and
    // the task's own state outranks it.
    controller.state.tabs.find((tab) => tab.spaceId === space.id)!.crashed =
      true;
    expect(view(space.id)).toMatchObject({ state: "error" });
    presence.setState(space.id, "done");
    expect(view(space.id)).toMatchObject({ state: "done" });
  });

  it("fail hands over as failed, refuses what section 2 refuses under human control and lets resume pass", async () => {
    const space = agentSpace();
    const message = failMessage("The site needs a phone number I do not have");
    expect(await presence.fail(space.id, message)).toEqual({
      owner: "human",
      state: "failed",
      status: "The site needs a phone number I do not have",
    });
    const current = controller.state.spaces.find(
      (item) => item.id === space.id,
    )!;
    expect(current.owner).toBe("human");
    expect(current.control).toMatchObject({ reason: "failed" });
    expect(taskOf(space.id)).toEqual({
      state: "failed",
      status: "The site needs a phone number I do not have",
      changedAt: expect.any(Number),
    });
    expect(entries(space.id).at(-1)).toEqual({
      message: "Agent could not finish",
      kind: "warning",
      agentText: "The site needs a phone number I do not have",
    });
    // A failure is not a takeover, so the person is not told they took one.
    expect(
      entries(space.id).some(
        (entry) =>
          entry.message === "You took control. Agent access is paused.",
      ),
    ).toBe(false);
    expect(view(space.id)).toMatchObject({
      owner: "human",
      reason: "failed",
      state: "failed",
      status: "The site needs a phone number I do not have",
    });
    // Everything section 2 refuses under human control is refused with the
    // failure as its reason; reading the space still answers.
    const error = refusal(space.id)!;
    expect(error.status).toBe(409);
    expect(error.code).toBe("human_control");
    expect(error.fields).toMatchObject({ reason: "failed" });
    expect(error.message).toBe(
      "You reported that this task could not be finished. Resume only when the person asks you to.",
    );
    expect(refusal(space.id, { human: "allow" })).toBeUndefined();
    expect(refusal(space.id, { human: "resume" })).toBeUndefined();
  });

  it("resume and an answered hold clear the state, and resume also clears a failure's message but keeps other status", async () => {
    const failed = agentSpace("Booking");
    await presence.fail(failed.id, failMessage("The form wants a passport"));
    await controller.dispatch({
      type: "space:ownership",
      id: failed.id,
      owner: "agent",
    });
    // A resume takes the failure and its message with it.
    expect(taskOf(failed.id)).toEqual({ changedAt: expect.any(Number) });
    const held = agentSpace("Research");
    presence.setStatus(held.id, statusText("Comparing prices"));
    const hold = controller.holdForPerson(held.id, "permission", "camera");
    expect(taskOf(held.id)).toEqual({
      state: "needs-you",
      reason: "camera",
      status: "Comparing prices",
      changedAt: expect.any(Number),
    });
    controller.releaseHold(hold);
    // An answered hold clears the mark but never the agent's own status.
    expect(taskOf(held.id)).toEqual({
      status: "Comparing prices",
      changedAt: expect.any(Number),
    });
  });

  it("a clear-site-data approval hands the space to the person as Needs you, and its end returns control and clears only its own Needs you", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const space = agentSpace();
      // The approval holds the space, which marks it with the hold's prompt.
      const hold = controller.holdForPerson(
        space.id,
        "approval",
        "clearing this space's site data",
      );
      expect(taskOf(space.id)).toEqual({
        state: "needs-you",
        reason: "clearing this space's site data",
        changedAt: 1000,
      });
      // The caller's own mark keeps the key and the reason the hold set.
      const first = presence.setState(
        space.id,
        "needs-you",
        "clearing this space's site data",
      );
      expect(first).toBe(1000);
      expect(taskOf(space.id)).toMatchObject({
        state: "needs-you",
        reason: "clearing this space's site data",
      });
      // The answer gives control back and the mark goes with it, so the
      // approval's own end finds nothing of its own left.
      vi.setSystemTime(2000);
      controller.releaseHold(hold);
      expect(taskOf(space.id)).toEqual({ changedAt: 2000 });
      presence.clearNeedsYou(space.id, first);
      expect(taskOf(space.id)).toEqual({ changedAt: 2000 });
      // A second ask, which the person answers by taking over: a takeover
      // leaves the mark, so only its own end clears it.
      vi.setSystemTime(3000);
      controller.holdForPerson(space.id, "permission", "camera");
      const second = presence.setState(space.id, "needs-you", "camera");
      expect(second).toBe(3000);
      await controller.dispatch({
        type: "space:ownership",
        id: space.id,
        owner: "human",
      });
      expect(taskOf(space.id)).toMatchObject({
        state: "needs-you",
        reason: "camera",
      });
      presence.clearNeedsYou(space.id, first);
      expect(taskOf(space.id)).toMatchObject({ state: "needs-you" });
      presence.clearNeedsYou(space.id, second);
      expect(taskOf(space.id)).not.toHaveProperty("state");
      expect(taskOf(space.id)).not.toHaveProperty("reason");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a grant that ends deletes a personal space's task, and a finished agent space keeps Done", async () => {
    const personal = controller.state.spaces.find(
      (space) => space.kind === "personal",
    )!;
    authority.grantSpace(personal.id);
    presence.setStatus(personal.id, statusText("Reading your tabs"));
    expect(taskOf(personal.id)).toMatchObject({ status: "Reading your tabs" });
    controller.endAccess(personal.id, { by: "agent", reason: "finished" });
    presence.setState(personal.id, "done");
    // The person's space keeps nothing of the agent's once its grant ends.
    expect(
      controller.state.spaces.find((space) => space.id === personal.id),
    ).not.toHaveProperty("task");
    const space = agentSpace();
    presence.setStatus(space.id, statusText("Prices compared"));
    controller.endAccess(space.id, { by: "agent", reason: "finished" });
    presence.setState(space.id, "done");
    expect(taskOf(space.id)).toEqual({
      state: "done",
      status: "Prices compared",
      changedAt: expect.any(Number),
    });
    // The finished entry carries the status the run ended on.
    expect(entries(space.id).at(-1)).toEqual({
      message: "Agent finished",
      kind: "success",
      agentText: "Prices compared",
    });
    expect(view(space.id)).toMatchObject({ state: "done" });
    // A deleted space leaves nothing behind, so later writes neither throw
    // nor bring its task back.
    await controller.dispatch({ type: "space:delete", id: space.id });
    const other = agentSpace("Later");
    presence.setStatus(other.id, statusText("Starting again"));
    expect(taskOf(other.id)).toMatchObject({ status: "Starting again" });
    expect(controller.state.spaces.some((item) => item.id === space.id)).toBe(
      false,
    );
  });
});
