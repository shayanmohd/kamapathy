import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { createAuthority } from "../electron/agent/authority";
import { ApiError } from "../electron/agent/errors";
import type { Route } from "../electron/agent/http";
import { createPresence, type AgentPresence } from "../electron/agent/presence";
import {
  agentTextField,
  bodyLabel,
  checkAgentText,
} from "../electron/agent/validate";
import { spaceView } from "../electron/agent/views";
import { BrowserController } from "../electron/controller";
import {
  checkBody,
  ROUTES,
  routeKey,
} from "../skills/kamapathy/scripts/schema/index.mjs";
import { initialState } from "../shared/state";
import type { Space } from "../shared/types";

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  WebContentsView: vi.fn(function () {
    const view = new FakePageView();
    pages.push(view.webContents);
    return view;
  }),
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
// A page and its view, with the frame subscription a reveal waits on.
class FakePage extends EventEmitter {
  focus = vi.fn();
  send = vi.fn();
  setWindowOpenHandler = vi.fn();
  setBackgroundThrottling = vi.fn();
  setZoomLevel = vi.fn();
  reload = vi.fn();
  close = vi.fn();
  loadURL = vi.fn(async () => {});
  capturePage = vi.fn(async () => ({ isEmpty: () => true }));
  navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  isDestroyed = () => false;
  getURL = () => "";
  getZoomLevel = () => 0;
  private drawn?: () => void;
  beginFrameSubscription = vi.fn(
    (_onlyDirty: boolean, callback: () => void) => {
      this.drawn = callback;
    },
  );
  endFrameSubscription = vi.fn(() => {
    this.drawn = undefined;
  });
  frame() {
    this.drawn?.();
  }
}
class FakePageView {
  webContents = new FakePage();
  private shown = false;
  setVisible = (value: boolean) => {
    this.shown = value;
  };
  getVisible = () => this.shown;
  setBounds = vi.fn();
  getBounds = () => ({ x: 0, y: 0, width: 1000, height: 700 });
  setBorderRadius = vi.fn();
}
const pages: FakePage[] = [];

describe("agent presence", () => {
  let controller: BrowserController;
  let authority: ReturnType<typeof createAuthority>;
  let presence: AgentPresence;
  let window: EventEmitter & Record<string, any>;
  // Characters by code point, so this file holds none of the invisible ones
  // the cleaning is about.
  const chars = (...codes: number[]) => String.fromCodePoint(...codes);
  // The status route's own reading of a body, so presence always gets text
  // that has been through the field's limit and cleaning.
  const statusText = (text: string) =>
    agentTextField({ text }, "text", "status", { allowEmpty: true });
  const failMessage = (message: string) =>
    agentTextField({ message }, "message", "message");
  const labelText = (label: string) =>
    agentTextField({ label }, "label", "label");
  // The router's view of a route: the label hooks and the checks read its
  // schema entry and nothing else.
  const routeFor = (key: string) =>
    ({
      schema: ROUTES.find((item) => routeKey(item) === key)!,
    }) as Route;
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
  // The router's follow hook: the step, then the frame the revealed view
  // draws, as Chromium reports it.
  const follow = (tabId: string) => {
    const done = presence.follow(tabId, { deadline: Date.now() + 5000 });
    for (const page of pages) page.frame();
    return done;
  };
  beforeEach(() => {
    vi.clearAllMocks();
    pages.length = 0;
    window = new EventEmitter() as EventEmitter & Record<string, any>;
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
    window.show = vi.fn();
    window.focus = vi.fn();
    controller = new BrowserController(
      window as unknown as BrowserWindow,
      initialState(),
      "unused-test-state.json",
    );
    controller.setContentBounds({
      x: 248,
      y: 82,
      width: 1000,
      height: 700,
      hidden: false,
    });
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

  it("labels track their action and unlabeled actions clear them", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      const space = agentSpace();
      presence.labelStart(
        space.id,
        labelText(`Open the${chars(0x202b)} first result  `),
      );
      expect(taskOf(space.id)).toEqual({
        label: { text: "Open the first result", active: true, at: 1000 },
        changedAt: 1000,
      });
      // The action ended, and its label now counts its five seconds from
      // there instead of from the start.
      vi.setSystemTime(2500);
      presence.labelEnd(space.id);
      expect(taskOf(space.id)).toEqual({
        label: { text: "Open the first result", active: false, at: 2500 },
        changedAt: 1000,
      });
      // An end with nothing running leaves the label where it was, so a
      // later step cannot extend it.
      vi.setSystemTime(3000);
      presence.labelEnd(space.id);
      expect(taskOf(space.id)?.label).toEqual({
        text: "Open the first result",
        active: false,
        at: 2500,
      });
      // The next action's label replaces it, and an action without one
      // clears it rather than keeping the last.
      presence.labelStart(space.id, labelText("Fill the delivery address"));
      expect(taskOf(space.id)?.label).toEqual({
        text: "Fill the delivery address",
        active: true,
        at: 3000,
      });
      presence.labelStart(space.id, undefined);
      expect(taskOf(space.id)).not.toHaveProperty("label");
      // An unlabeled action in a space with no task writes none.
      const other = agentSpace("Booking");
      presence.labelStart(other.id, undefined);
      presence.labelEnd(other.id);
      expect(
        controller.state.spaces.find((item) => item.id === other.id),
      ).not.toHaveProperty("task");
      // The person taking over hides the label with the rest of the run.
      presence.labelStart(space.id, labelText("Open the basket"));
      await controller.dispatch({
        type: "space:ownership",
        id: space.id,
        owner: "human",
      });
      expect(taskOf(space.id)).not.toHaveProperty("label");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a label on an observation route is unknown_field, and an over-long or blank label anywhere in a batch is invalid_field with field, expected and index before any step runs", () => {
    const space = agentSpace();
    // Section 11's body check refuses a label where no field declares one,
    // naming what the route or the step does take.
    expect(
      checkBody(routeFor("POST /tabs/:id/snapshot").schema, {
        label: "Reading the page",
      }),
    ).toMatchObject({
      code: "unknown_field",
      fields: {
        field: "label",
        allowed: ["mode", "maxChars", "maxControls", "selector"],
      },
    });
    expect(
      checkBody(routeFor("POST /tabs/:id/actions").schema, {
        actions: [{ type: "wait", text: "Done", label: "Waiting" }],
      }),
    ).toMatchObject({
      code: "unknown_field",
      fields: {
        field: "label",
        action: "wait",
        index: 0,
        allowed: ["type", "selector", "text", "timeoutMs"],
      },
    });
    // The cleaning rule is the server's own, and a batch answers for the
    // step it refused before any step has run.
    const refuse = (
      key: string,
      body: Record<string, unknown>,
    ): ApiError | undefined => {
      try {
        checkAgentText(routeFor(key), body);
      } catch (error) {
        return error as ApiError;
      }
      return undefined;
    };
    const batch = (label: string) =>
      refuse("POST /tabs/:id/actions", {
        actions: [
          { type: "click", ref: "@e1", label: "Open the first result" },
          { type: "fill", ref: "@e2", value: "Ada" },
          { type: "click", ref: "@e3", label },
        ],
      });
    const long = batch("x".repeat(61))!;
    expect(long.status).toBe(400);
    expect(long.code).toBe("invalid_field");
    expect(long.fields).toMatchObject({
      field: "label",
      expected: "at most 60 characters",
      index: 2,
    });
    expect(batch(chars(0x200e, 0x07))!.fields).toMatchObject({
      field: "label",
      expected: "text that is not empty after cleaning",
      index: 2,
    });
    expect(batch("Add it to the basket")).toBeUndefined();
    // One route's own label follows the same rule, without an index.
    const click = refuse("POST /tabs/:id/click", {
      ref: "@e1",
      label: chars(0x07),
    })!;
    expect(click.code).toBe("invalid_field");
    expect(click.fields).toEqual({
      field: "label",
      expected: "text that is not empty after cleaning",
    });
    expect(
      bodyLabel(routeFor("POST /tabs/:id/click"), {
        ref: "@e1",
        label: `Open the${chars(0x202e)} first result `,
      }),
    ).toBe("Open the first result");
    expect(
      bodyLabel(routeFor("POST /tabs/:id/click"), { ref: "@e1" }),
    ).toBeUndefined();
    expect(
      bodyLabel(routeFor("POST /tabs/:id/snapshot"), { label: "Reading" }),
    ).toBeUndefined();
    // Nothing was started, shown or written while the checks refused.
    expect(
      controller.state.spaces.find((item) => item.id === space.id),
    ).not.toHaveProperty("task");
    expect(pages).toHaveLength(0);
  });

  it("follow activates its tab only in the active space, keeps the split pane, never changes the active space or focus, and observation routes never follow", async () => {
    const space = agentSpace();
    const first = controller.openAgentTab(space.id, "https://example.com/one");
    const second = controller.openAgentTab(space.id, "https://example.com/two");
    const third = controller.openAgentTab(
      space.id,
      "https://example.com/three",
    );
    await controller.dispatch({ type: "tab:activate", id: first.id });
    await controller.dispatch({ type: "tab:split", id: second.id });
    expect(controller.state.activeSpaceId).toBe(space.id);
    expect(controller.state.splitTabId).toBe(second.id);
    // A background page of the space the person is looking at becomes the
    // one it shows, and the pane beside it stays where the person put it.
    await follow(third.id);
    expect(controller.state.activeTabId).toBe(third.id);
    expect(controller.state.splitTabId).toBe(second.id);
    expect(controller.state.activeSpaceId).toBe(space.id);
    // The page already in the split pane needs no reveal.
    await follow(second.id);
    expect(controller.state.activeTabId).toBe(third.id);
    expect(controller.state.splitTabId).toBe(second.id);
    // Following never brings the window or a page forward.
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
    expect(window.webContents.focus).not.toHaveBeenCalled();
    for (const page of pages) expect(page.focus).not.toHaveBeenCalled();
    // Which routes follow is the schema's to say: the ones that read or act
    // on a page, and no other.
    const follows = Object.fromEntries(
      ROUTES.map((route) => [routeKey(route), route.follow]),
    );
    expect(follows).toMatchObject({
      "POST /spaces/:id/tabs": true,
      "POST /tabs/:id/navigate": true,
      "GET /tabs/:id/snapshot": true,
      "POST /tabs/:id/snapshot": true,
      "GET /tabs/:id/screenshot": true,
      "POST /tabs/:id/click": true,
      "POST /tabs/:id/actions": true,
      "POST /tabs/:id/upload": true,
      "GET /spaces": false,
      "GET /spaces/:id": false,
      "GET /spaces/:id/tabs": false,
      "DELETE /tabs/:id": false,
      "POST /tabs/:id/adopt": false,
      "POST /tabs/:id/release": false,
      "POST /spaces/:id/handoff": false,
      "POST /spaces/:id/resume": false,
      "POST /spaces/:id/status": false,
      "POST /spaces/:id/fail": false,
    });
  });

  it("following another space sets the tab it opens on", async () => {
    const space = agentSpace();
    const first = controller.openAgentTab(space.id, "https://example.com/one");
    const second = controller.openAgentTab(space.id, "https://example.com/two");
    const { activeSpaceId, activeTabId } = controller.state;
    expect(activeSpaceId).not.toBe(space.id);
    // The space opens on its latest page until a follow names another.
    expect(controller.shownTab(space.id)?.id).toBe(second.id);
    await follow(first.id);
    expect(controller.shownTab(space.id)?.id).toBe(first.id);
    expect(controller.state.activeSpaceId).toBe(activeSpaceId);
    expect(controller.state.activeTabId).toBe(activeTabId);
    await follow(second.id);
    expect(controller.shownTab(space.id)?.id).toBe(second.id);
    expect(controller.state.activeTabId).toBe(activeTabId);
  });

  it("follow is skipped for a tab whose space an agent may not use, and never throws", async () => {
    // The person's own space, which nobody granted.
    const own = controller.state.spaces.find(
      (space) => space.kind === "personal" && space.id !== "personal",
    )!;
    const theirs = controller.state.tabs.find((tab) => tab.spaceId === own.id)!;
    const added = await controller.dispatch({
      type: "tab:create",
      spaceId: own.id,
      url: "https://example.org/",
      background: true,
    });
    const other = added.tabs.at(-1)!;
    await expect(follow(other.id)).resolves.toBeUndefined();
    expect(controller.shownTab(own.id)?.id).toBe(theirs.id);
    // A space whose access ended is no longer the agent's to reveal.
    const ended = agentSpace("Booking");
    const page = controller.openAgentTab(ended.id, "https://example.com/one");
    controller.openAgentTab(ended.id, "https://example.com/two");
    controller.endAccess(ended.id, { by: "person", reason: "stopped" });
    await expect(follow(page.id)).resolves.toBeUndefined();
    expect(controller.shownTab(ended.id)?.id).not.toBe(page.id);
    // A page that closed while the request waited leaves nothing to follow.
    const space = agentSpace("Research");
    const closed = controller.openAgentTab(space.id, "https://example.com/");
    controller.closeTab(closed.id, "agent");
    await expect(follow(closed.id)).resolves.toBeUndefined();
  });
});
