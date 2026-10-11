import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageOperation } from "../electron/automation-dom";
import { errorBody, toApiError } from "../electron/agent/errors";
import type { AutomationController } from "../electron/agent/server";
import {
  CdpTimeoutError,
  ContextLostError,
  FrameBlockedError,
  FrameGoneError,
  PageCrashedError,
  SessionLostError,
  TabClosedError,
  TargetRefusedError,
} from "../electron/agent/session/errors";
import {
  OPERATIONS,
  WORLD_NAME,
  operationExpression,
} from "../electron/agent/session/operations";
import { TabSession } from "../electron/agent/session/tab-session";
import { TabSessions } from "../electron/agent/session/tab-sessions";
import type {
  CdpEvent,
  SendStep,
  SessionHost,
} from "../electron/agent/session/types";
import { initialState, newTab } from "../shared/state";
import type { BrowserState, Space } from "../shared/types";
import { FakeHost, frameTree, type FakeDebugger } from "./fake-cdp";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// What every session of a tab is sent first, in order.
const SETUP = [
  { method: "Page.enable", params: {} },
  { method: "Page.setLifecycleEventsEnabled", params: { enabled: true } },
  {
    method: "Network.enable",
    params: { maxTotalBufferSize: 10000000, maxResourceBufferSize: 5000000 },
  },
  {
    method: "Target.setAutoAttach",
    params: {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }, { exclude: true }],
    },
  },
];
const FOCUS = {
  method: "Emulation.setFocusEmulationEnabled",
  params: { enabled: true },
};
const FRAME_TREE = { method: "Page.getFrameTree", params: {} };

// Runs the timers due now and every promise callback they lead to.
const settle = () => vi.advanceTimersByTimeAsync(0);
const soon = (sessionId?: string) => ({
  deadline: Date.now() + 10000,
  sessionId,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
// Records how a promise settles, without leaving a rejection unhandled.
function track<T>(promise: Promise<T>) {
  const outcome: { settled: boolean; value?: T; error?: unknown } = {
    settled: false,
  };
  promise.then(
    (value) => Object.assign(outcome, { settled: true, value }),
    (error: unknown) => Object.assign(outcome, { settled: true, error }),
  );
  return outcome;
}
// Chromium reports a new target on the session that hosts its parent frame.
function attachTarget(
  cdp: FakeDebugger,
  sessionId: string,
  options: { parent?: string; type?: string; waiting?: boolean } = {},
) {
  cdp.event(
    "Target.attachedToTarget",
    {
      sessionId,
      targetInfo: {
        targetId: `target-${sessionId}`,
        type: options.type ?? "iframe",
        url: "https://frame.example/",
        attached: true,
      },
      waitingForDebugger: options.waiting ?? false,
    },
    options.parent,
  );
}
// A setup hook like section 5's, which sends before its first await.
const focusHook = (session: TabSession) => async (sessionId?: string) => {
  await session.send(FOCUS.method, FOCUS.params, {
    sessionId,
    deadline: Date.now() + 5000,
  });
};
// Every session in these tests is built here.
function open(
  options: {
    url?: string;
    idle?: (timeoutMs: number) => Promise<void>;
  } = {},
) {
  const host = new FakeHost({ url: options.url });
  const waitForSpaceIdle = vi.fn<(timeoutMs: number) => Promise<void>>(
    options.idle ?? (async () => {}),
  );
  const session = new TabSession(host as unknown as SessionHost, {
    tabId: "tab-1",
    waitForSpaceIdle,
  });
  return { host, cdp: host.debugger, session, waitForSpaceIdle };
}
async function ready(options: Parameters<typeof open>[0] = {}) {
  const opened = open(options);
  opened.session.attach();
  await settle();
  expect(opened.session.state).toBe("ready");
  return opened;
}

describe("TabSession", () => {
  it("sends Page.enable, lifecycle events, Network.enable, auto-attach without pausing children, the setup hooks and Page.getFrameTree in order inside attach(), awaiting no reply", () => {
    const { session, cdp } = open({ url: "" });
    cdp.holdReplies = true;
    const attach = vi.spyOn(cdp, "attach");
    const sendCommand = vi.spyOn(cdp, "sendCommand");
    session.onSessionSetup(focusHook(session));
    session.attach();
    expect(attach).toHaveBeenCalledWith("1.3");
    expect(cdp.sent).toEqual([...SETUP, FOCUS, FRAME_TREE]);
    // Electron refuses an empty session id, so page commands carry none.
    expect(sendCommand.mock.calls.every((call) => call.length === 2)).toBe(
      true,
    );
    expect(session.state).toBe("attaching");
    expect(session.attachCount).toBe(1);
  });

  it("stays attaching until the first document commits and every reply and hook arrives, then becomes ready", async () => {
    const { session, cdp, host } = open({ url: "" });
    cdp.holdReplies = true;
    const hook = deferred<void>();
    session.onSessionSetup(() => hook.promise);
    const attached = vi.fn();
    session.on("attached", attached);
    session.attach();
    const read = track(
      session.send(
        "Runtime.evaluate",
        { expression: "document.title" },
        { deadline: Date.now() + 30000 },
      ),
    );
    // However long the first response takes, the session keeps waiting.
    await vi.advanceTimersByTimeAsync(20000);
    expect(session.state).toBe("attaching");
    host.navigate("https://example.com/");
    cdp.holdReplies = false;
    cdp.flush();
    await settle();
    expect(session.state).toBe("attaching");
    expect(cdp.methods()).not.toContain("Runtime.evaluate");
    hook.resolve();
    await settle();
    expect(session.state).toBe("ready");
    expect(attached).toHaveBeenCalledTimes(1);
    expect(read).toEqual({ settled: true, value: {} });
    expect(cdp.methods().at(-1)).toBe("Runtime.evaluate");
    expect(await session.mainFrameId(soon())).toBe("main");
  });

  it("marks the session unavailable when setup takes more than 5000 ms after the first commit", async () => {
    const { session, cdp, host } = open({ url: "" });
    cdp.holdReplies = true;
    const detached = vi.fn();
    session.on("detached", detached);
    session.attach();
    await vi.advanceTimersByTimeAsync(10000);
    host.emit(
      "did-fail-load",
      {},
      -2,
      "net::ERR_FAILED",
      "https://frame.example/",
      false,
      1,
      2,
    );
    await vi.advanceTimersByTimeAsync(10000);
    expect(session.state).toBe("attaching");
    host.navigate("https://example.com/");
    await vi.advanceTimersByTimeAsync(4999);
    expect(session.state).toBe("attaching");
    await vi.advanceTimersByTimeAsync(1);
    expect(session.state).toBe("unavailable");
    expect(cdp.detachCount).toBe(1);
    expect(detached.mock.calls.map(([event]) => event.params)).toEqual([
      { reason: "setup_timeout" },
    ]);
    // A failed main-frame load also counts as the first commit, and a page
    // that already shows a document starts the clock at attach.
    const failed = open({ url: "" });
    failed.cdp.holdReplies = true;
    failed.session.attach();
    failed.host.emit(
      "did-fail-load",
      {},
      -105,
      "net::ERR_NAME_NOT_RESOLVED",
      "https://missing.example/",
      true,
      1,
      1,
    );
    const shown = open();
    shown.cdp.holdReplies = true;
    shown.session.attach();
    await vi.advanceTimersByTimeAsync(5000);
    expect([failed.session.state, shown.session.state]).toEqual([
      "unavailable",
      "unavailable",
    ]);
    // The next operation attaches again.
    cdp.holdReplies = false;
    await expect(
      session.send("Runtime.evaluate", { expression: "1" }, soon()),
    ).resolves.toEqual({});
    expect(session.state).toBe("ready");
    expect(session.attachCount).toBe(2);
  });

  it("runs setup hooks on the page session and each child, registered early or late, and again after a re-attach", async () => {
    const { session, cdp } = open();
    const early = vi.fn(async (_sessionId?: string) => {});
    session.onSessionSetup(early);
    session.attach();
    await settle();
    attachTarget(cdp, "child-1");
    expect(early.mock.calls).toEqual([[undefined], ["child-1"]]);
    const late = vi.fn(async (_sessionId?: string) => {});
    const removeLate = session.onSessionSetup(late);
    expect(late.mock.calls).toEqual([[undefined], ["child-1"]]);
    cdp.lose();
    await settle();
    expect(session.state).toBe("ready");
    expect(early.mock.calls.slice(2)).toEqual([[undefined]]);
    expect(late.mock.calls.slice(2)).toEqual([[undefined]]);
    removeLate();
    cdp.lose();
    await settle();
    expect(early).toHaveBeenCalledTimes(4);
    expect(late).toHaveBeenCalledTimes(3);
  });

  it("routes events by sessionId, treating an empty sessionId as the page session, and ignores unknown sessions", async () => {
    const { session, cdp } = await ready();
    attachTarget(cdp, "child-1");
    attachTarget(cdp, "child-2", { parent: "child-1" });
    await settle();
    const heard: CdpEvent[] = [];
    session.on("Page.lifecycleEvent", (event) => {
      heard.push(event);
    });
    const load = (frameId: string, sessionId?: string) =>
      cdp.event("Page.lifecycleEvent", { frameId, name: "load" }, sessionId);
    load("main");
    load("frame-1", "child-1");
    load("frame-2", "child-2");
    load("other", "another-tab");
    expect(heard).toEqual([
      {
        method: "Page.lifecycleEvent",
        params: { frameId: "main", name: "load" },
        at: Date.now(),
      },
      {
        method: "Page.lifecycleEvent",
        params: { frameId: "frame-1", name: "load" },
        sessionId: "child-1",
        at: Date.now(),
      },
      {
        method: "Page.lifecycleEvent",
        params: { frameId: "frame-2", name: "load" },
        sessionId: "child-2",
        at: Date.now(),
      },
    ]);
    expect("sessionId" in heard[0]).toBe(false);
    // Targets reported by a session this tab does not own are never touched.
    attachTarget(cdp, "stranger", { parent: "another-tab" });
    expect(cdp.methods("stranger")).toEqual([]);
    // A child that detaches takes its own children with it.
    cdp.event("Target.detachedFromTarget", { sessionId: "child-1" });
    load("frame-2", "child-2");
    expect(heard).toHaveLength(3);
    await expect(
      session.send("Page.getFrameTree", {}, soon("child-2")),
    ).rejects.toBeInstanceOf(TargetRefusedError);
    // Only the page session's root frame moves the main frame.
    cdp.event("Page.frameNavigated", {
      frame: {
        id: "frame-9",
        parentId: "main",
        loaderId: "loader-9",
        url: "https://frame.example/",
      },
      type: "Navigation",
    });
    expect(await session.mainFrameId(soon())).toBe("main");
    cdp.event("Page.frameNavigated", {
      frame: {
        id: "main-2",
        loaderId: "loader-2",
        url: "https://example.com/next",
      },
      type: "Navigation",
    });
    expect(await session.mainFrameId(soon())).toBe("main-2");
  });

  it("sets up an attached iframe target with the same commands, resumes it when waiting before any reply is awaited, and reads its frame tree", async () => {
    const { session, cdp } = await ready();
    session.onSessionSetup(focusHook(session));
    const pageCommands = cdp.methods().length;
    cdp.holdReplies = true;
    attachTarget(cdp, "child-1", { waiting: true });
    const resume = { method: "Runtime.runIfWaitingForDebugger", params: {} };
    expect(
      cdp.sent.filter((command) => command.sessionId === "child-1"),
    ).toEqual(
      [...SETUP, FOCUS, resume, FRAME_TREE].map((command) => ({
        ...command,
        sessionId: "child-1",
      })),
    );
    expect(cdp.methods()).toHaveLength(pageCommands);
    cdp.holdReplies = false;
    cdp.flush();
    await settle();
    // A frame that is not waiting is not resumed. One whose setup fails is
    // detached on the session that reported it.
    cdp.reply("Page.enable", (_params, sessionId) => {
      if (sessionId === "child-2") throw new Error("Session closed");
      return {};
    });
    attachTarget(cdp, "child-2", { parent: "child-1" });
    await settle();
    expect(cdp.methods("child-2")).not.toContain(resume.method);
    expect(cdp.sent.at(-1)).toEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "child-2" },
      sessionId: "child-1",
    });
    await expect(
      session.send("Page.getFrameTree", {}, soon("child-2")),
    ).rejects.toBeInstanceOf(TargetRefusedError);
    await expect(
      session.send("Page.getFrameTree", {}, soon("child-1")),
    ).resolves.toHaveProperty("frameTree");
  });

  it("resumes and detaches an attached target that is not an iframe", async () => {
    const { session, cdp } = await ready();
    const heard = vi.fn();
    session.on("Runtime.consoleAPICalled", heard);
    attachTarget(cdp, "worker-1", { type: "worker", waiting: true });
    await settle();
    expect(cdp.sent.slice(-2)).toEqual([
      {
        method: "Runtime.runIfWaitingForDebugger",
        params: {},
        sessionId: "worker-1",
      },
      { method: "Target.detachFromTarget", params: { sessionId: "worker-1" } },
    ]);
    expect(cdp.methods("worker-1")).toEqual([
      "Runtime.runIfWaitingForDebugger",
    ]);
    cdp.event("Runtime.consoleAPICalled", { type: "log" }, "worker-1");
    expect(heard).not.toHaveBeenCalled();
    await expect(
      session.send("Runtime.evaluate", {}, soon("worker-1")),
    ).rejects.toBeInstanceOf(TargetRefusedError);
    attachTarget(cdp, "child-1");
    attachTarget(cdp, "worker-2", {
      parent: "child-1",
      type: "service_worker",
    });
    await settle();
    expect(cdp.methods("worker-2")).toEqual([]);
    expect(cdp.sent.at(-1)).toEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "worker-2" },
      sessionId: "child-1",
    });
  });

  it("refuses Target and Browser methods on every session and refuses foreign session ids", async () => {
    const { session, cdp, host } = await ready();
    attachTarget(cdp, "child-1");
    await settle();
    const sent = cdp.sent.length;
    for (const sessionId of [undefined, "child-1"])
      for (const method of [
        "Target.getTargets",
        "Target.attachToTarget",
        "Target.setAutoAttach",
        "Target.detachFromTarget",
        "Browser.close",
        "Browser.getVersion",
      ]) {
        const refused = session.send(method, {}, soon(sessionId));
        await expect(refused).rejects.toBeInstanceOf(TargetRefusedError);
        await expect(refused).rejects.toMatchObject({ method });
      }
    await expect(
      session.send(
        "Runtime.evaluate",
        { expression: "document.title" },
        soon("another-tab"),
      ),
    ).rejects.toMatchObject({ method: "Runtime.evaluate" });
    expect(cdp.sent).toHaveLength(sent);
    // The refusal comes first, before the guard and in every state.
    const guard = vi.fn();
    host.crash();
    await expect(
      session.send("Target.getTargets", {}, { ...soon(), guard }),
    ).rejects.toBeInstanceOf(TargetRefusedError);
    await session.release();
    await expect(
      session.send("Browser.close", {}, { ...soon(), guard }),
    ).rejects.toBeInstanceOf(TargetRefusedError);
    expect(guard).not.toHaveBeenCalled();
  });

  it("runs guard before sending and after the reply, and times out at timeoutMs or the deadline with page_timeout", async () => {
    const { session, cdp } = await ready();
    const order: string[] = [];
    cdp.reply("Runtime.evaluate", () => {
      order.push("reply");
      return { result: { value: 2 } };
    });
    await expect(
      session.send(
        "Runtime.evaluate",
        { expression: "1 + 1" },
        { ...soon(), guard: () => order.push("guard") },
      ),
    ).resolves.toEqual({ result: { value: 2 } });
    expect(order).toEqual(["guard", "reply", "guard"]);
    const takeover = new Error("The person is using this space.");
    const sent = cdp.sent.length;
    await expect(
      session.send(
        "Input.dispatchMouseEvent",
        { type: "mouseMoved", x: 1, y: 1 },
        {
          ...soon(),
          guard: () => {
            throw takeover;
          },
        },
      ),
    ).rejects.toBe(takeover);
    expect(cdp.sent).toHaveLength(sent);
    let checks = 0;
    await expect(
      session.send(
        "Runtime.evaluate",
        { expression: "1 + 1" },
        {
          ...soon(),
          guard: () => {
            if (++checks === 2) throw takeover;
          },
        },
      ),
    ).rejects.toBe(takeover);
    cdp.reply("Runtime.evaluate", () => new Promise(() => {}));
    const hung = (step: SendStep) =>
      track(session.send("Runtime.evaluate", { expression: "1" }, step));
    const start = Date.now();
    const byDeadline = hung({ deadline: start + 200, timeoutMs: 5000 });
    const byTimeout = hung({ deadline: start + 60000, timeoutMs: 300 });
    const byDefault = hung({ deadline: start + 60000 });
    await vi.advanceTimersByTimeAsync(199);
    expect(byDeadline.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(byDeadline.error).toBeInstanceOf(CdpTimeoutError);
    expect(byDeadline.error).toMatchObject({ awaited: "page" });
    await vi.advanceTimersByTimeAsync(99);
    expect(byTimeout.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(byTimeout.error).toMatchObject({ awaited: "page" });
    await vi.advanceTimersByTimeAsync(14699);
    expect(byDefault.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(byDefault.error).toMatchObject({ awaited: "page" });
    // Nothing is sent once the deadline has passed.
    const late = cdp.sent.length;
    await expect(
      session.send(
        "Input.dispatchKeyEvent",
        { type: "keyDown" },
        { deadline: Date.now() },
      ),
    ).rejects.toBeInstanceOf(CdpTimeoutError);
    expect(cdp.sent).toHaveLength(late);
  });

  it("marks dispatch for Input, Page.navigate, Page.reload, Page.navigateToHistoryEntry, DOM.setFileInputFiles and mutates commands, never for reads, separately per step", async () => {
    const { session, host } = await ready();
    const dispatchedBy = async (method: string, mutates?: true) => {
      const dispatch = { dispatched: false };
      await session.send(method, {}, { ...soon(), dispatch, mutates });
      return dispatch.dispatched;
    };
    for (const method of [
      "Input.dispatchMouseEvent",
      "Input.dispatchKeyEvent",
      "Input.insertText",
      "Page.navigate",
      "Page.reload",
      "Page.navigateToHistoryEntry",
      "DOM.setFileInputFiles",
    ])
      expect(await dispatchedBy(method), method).toBe(true);
    for (const method of [
      "Runtime.evaluate",
      "Runtime.callFunctionOn",
      "Page.getFrameTree",
      "Page.getNavigationHistory",
      "Page.captureScreenshot",
      "DOM.getFrameOwner",
      "DOM.resolveNode",
    ])
      expect(await dispatchedBy(method), method).toBe(false);
    expect(await dispatchedBy("Runtime.callFunctionOn", true)).toBe(true);
    // Each request and batch step brings its own record.
    const first = { dispatched: false };
    const second = { dispatched: false };
    await session.send(
      "Input.dispatchKeyEvent",
      { type: "keyDown" },
      { ...soon(), dispatch: first },
    );
    await session.send("Runtime.evaluate", {}, { ...soon(), dispatch: second });
    expect([first.dispatched, second.dispatched]).toEqual([true, false]);
    // A command that is refused dispatches nothing.
    host.crash();
    const refused = { dispatched: false };
    await expect(
      session.send(
        "Input.dispatchMouseEvent",
        {},
        { ...soon(), dispatch: refused },
      ),
    ).rejects.toBeInstanceOf(PageCrashedError);
    expect(refused.dispatched).toBe(false);
  });

  it("counts main-frame cross-document navigations in epoch", async () => {
    const { session, host } = open();
    expect(session.epoch).toBe(0);
    host.navigate("https://example.com/a");
    expect(session.epoch).toBe(1);
    host.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: true,
      url: "https://example.com/a#more",
    });
    host.emit("did-start-navigation", {
      isMainFrame: false,
      isSameDocument: false,
      url: "https://frame.example/",
    });
    expect(session.epoch).toBe(1);
    session.attach();
    await settle();
    host.navigate("https://example.com/b");
    expect(session.epoch).toBe(2);
  });

  it("re-attaches at once after an unexpected detach, then at 250, 1000 and 4000 ms, then on the next operation", async () => {
    const { session, cdp } = await ready();
    const detached = vi.fn();
    session.on("detached", detached);
    attachTarget(cdp, "child-1");
    await settle();
    const attempts = vi.spyOn(cdp, "attach");
    cdp.attachError = new Error("Target is not available");
    cdp.lose("target closed");
    expect(session.state).toBe("unavailable");
    expect(detached.mock.calls.map(([event]) => event.params)).toEqual([
      { reason: "target closed" },
    ]);
    await expect(
      session.send("Page.getFrameTree", {}, soon("child-1")),
    ).rejects.toBeInstanceOf(TargetRefusedError);
    await settle();
    expect(attempts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(attempts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(750);
    expect(attempts).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(attempts).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60000);
    expect(attempts).toHaveBeenCalledTimes(4);
    expect(session.state).toBe("unavailable");
    // Each operation then makes one attempt of its own.
    const refused = session.send("Runtime.evaluate", {}, soon());
    await expect(refused).rejects.toBeInstanceOf(SessionLostError);
    await expect(refused).rejects.toMatchObject({ reason: "unavailable" });
    expect(attempts).toHaveBeenCalledTimes(5);
    cdp.attachError = undefined;
    await expect(
      session.send("Runtime.evaluate", {}, soon()),
    ).resolves.toEqual({});
    expect(session.attachCount).toBe(2);
    // An attempt that succeeds ends the schedule.
    cdp.lose();
    await settle();
    expect(session.state).toBe("ready");
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempts).toHaveBeenCalledTimes(7);
    // Operations wait at most 2000 ms for a re-attach in progress.
    cdp.holdReplies = true;
    cdp.lose();
    await settle();
    expect(session.state).toBe("attaching");
    const waiting = track(
      session.send("Runtime.evaluate", {}, { deadline: Date.now() + 30000 }),
    );
    await vi.advanceTimersByTimeAsync(1999);
    expect(waiting.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(waiting.error).toBeInstanceOf(CdpTimeoutError);
  });

  it("ignores the detach event that its own detach causes", async () => {
    const { session, cdp } = await ready();
    const detached = vi.fn();
    session.on("detached", detached);
    const attempts = vi.spyOn(cdp, "attach");
    await session.release();
    expect(cdp.detachCount).toBe(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(attempts).not.toHaveBeenCalled();
    expect(detached).not.toHaveBeenCalled();
    expect(session.state).toBe("released");
    // Detaching after a setup timeout is no loss either: no second detached
    // event and no re-attach.
    const stalled = open();
    stalled.cdp.holdReplies = true;
    const lost = vi.fn();
    stalled.session.on("detached", lost);
    stalled.session.attach();
    await vi.advanceTimersByTimeAsync(5000);
    expect(stalled.cdp.detachCount).toBe(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(lost.mock.calls.map(([event]) => event.params)).toEqual([
      { reason: "setup_timeout" },
    ]);
    expect(stalled.cdp.attachCount).toBe(1);
  });

  it("reports devtools while attaching fails with developer tools open and re-attaches on devtools-closed", async () => {
    const { session, cdp, host } = open();
    host.devtools = true;
    cdp.attachError = new Error("Another debugger is already attached");
    session.attach();
    expect(session.state).toBe("devtools");
    const refused = session.send("Runtime.evaluate", {}, soon());
    await expect(refused).rejects.toBeInstanceOf(SessionLostError);
    await expect(refused).rejects.toMatchObject({ reason: "devtools" });
    expect(cdp.attachCount).toBe(0);
    host.devtools = false;
    cdp.attachError = undefined;
    host.emit("devtools-closed");
    expect(cdp.attachCount).toBe(1);
    await settle();
    expect(session.state).toBe("ready");
    // A loss while they are open waits for them to close, without retrying.
    const attempts = vi.spyOn(cdp, "attach");
    host.devtools = true;
    cdp.attachError = new Error("Another debugger is already attached");
    cdp.lose("target closed");
    await settle();
    expect(session.state).toBe("devtools");
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempts).toHaveBeenCalledTimes(1);
    host.devtools = false;
    cdp.attachError = undefined;
    host.emit("devtools-closed");
    await settle();
    expect(session.state).toBe("ready");
    expect(session.attachCount).toBe(2);
  });

  it("fails page commands with page_crashed after render-process-gone until the next did-navigate", async () => {
    const { session, cdp, host } = await ready();
    cdp.holdReplies = true;
    const inFlight = track(session.send("Runtime.evaluate", {}, soon()));
    host.crash();
    await settle();
    expect(inFlight.error).toBeInstanceOf(PageCrashedError);
    expect(session.state).toBe("crashed");
    const sent = cdp.sent.length;
    await expect(
      session.send("Input.dispatchMouseEvent", { type: "mouseMoved" }, soon()),
    ).rejects.toBeInstanceOf(PageCrashedError);
    expect(cdp.sent).toHaveLength(sent);
    // The debugger outlives the renderer.
    expect(cdp.attachCount).toBe(1);
    expect(cdp.detachCount).toBe(0);
    host.navigate("https://example.com/again");
    expect(cdp.sent.at(-1)).toEqual(FRAME_TREE);
    expect(session.state).toBe("crashed");
    cdp.reply("Page.getFrameTree", () =>
      frameTree([
        {
          id: "main-2",
          url: "https://example.com/again",
          loaderId: "loader-2",
        },
      ]),
    );
    cdp.holdReplies = false;
    cdp.flush();
    await settle();
    expect(session.state).toBe("ready");
    expect(await session.mainFrameId(soon())).toBe("main-2");
    await expect(
      session.send("Runtime.evaluate", {}, soon()),
    ).resolves.toEqual({});
  });

  it("lets only key releases and drag cleanup through while releasing, waits for the space's running request, then detaches", async () => {
    const idle = deferred<void>();
    const { session, cdp, waitForSpaceIdle } = await ready({
      idle: () => idle.promise,
    });
    const releasing = vi.fn();
    session.on("releasing", releasing);
    const released = track(session.release());
    await settle();
    expect(releasing).toHaveBeenCalledTimes(1);
    expect(waitForSpaceIdle).toHaveBeenCalledWith(2000);
    const sent = cdp.sent.length;
    await session.send(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "Shift", code: "ShiftLeft" },
      soon(),
    );
    await session.send(
      "Input.dispatchDragEvent",
      {
        type: "dragCancel",
        x: 10,
        y: 20,
        data: { items: [], dragOperationsMask: 1 },
      },
      soon(),
    );
    await session.send("Input.setInterceptDrags", { enabled: false }, soon());
    for (const [method, params] of [
      ["Input.dispatchKeyEvent", { type: "keyDown", key: "a" }],
      ["Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 20 }],
      ["Input.dispatchDragEvent", { type: "drop", x: 10, y: 20 }],
      ["Input.setInterceptDrags", { enabled: true }],
      ["Runtime.evaluate", { expression: "1" }],
    ] as const) {
      const refused = session.send(method, params, soon());
      await expect(refused).rejects.toBeInstanceOf(SessionLostError);
      await expect(refused).rejects.toMatchObject({ reason: "unavailable" });
    }
    expect(cdp.sent.slice(sent).map((command) => command.method)).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchDragEvent",
      "Input.setInterceptDrags",
    ]);
    // A frame that attaches meanwhile is resumed and let go, never set up.
    attachTarget(cdp, "child-1", { waiting: true });
    await settle();
    expect(cdp.sent.slice(sent + 3)).toEqual([
      {
        method: "Runtime.runIfWaitingForDebugger",
        params: {},
        sessionId: "child-1",
      },
      { method: "Target.detachFromTarget", params: { sessionId: "child-1" } },
    ]);
    expect(cdp.detachCount).toBe(0);
    expect(released.settled).toBe(false);
    idle.resolve();
    await settle();
    expect(released.settled).toBe(true);
    expect(cdp.detachCount).toBe(1);
    expect(cdp.attached).toBe(false);
    expect(session.state).toBe("released");
  });

  it("gives releasing listeners up to 500 ms", async () => {
    const { session, waitForSpaceIdle } = await ready();
    const quick = deferred<void>();
    session.on("releasing", () => quick.promise);
    session.on("releasing", () => new Promise(() => {}));
    const released = session.release();
    expect(session.release()).toBe(released);
    await vi.advanceTimersByTimeAsync(100);
    quick.resolve();
    await vi.advanceTimersByTimeAsync(399);
    expect(waitForSpaceIdle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(waitForSpaceIdle).toHaveBeenCalledWith(2000);
    await released;
    // Listeners that finish sooner end the wait sooner.
    const next = await ready();
    next.session.on("releasing", async () => {});
    const done = next.session.release();
    await settle();
    expect(next.waitForSpaceIdle).toHaveBeenCalledTimes(1);
    await done;
  });

  it("reports human_control rather than a lost session for a command cut off by release", async () => {
    // The space's running request never finishes, so waiting for it gives up
    // after 2000 ms.
    const { session, cdp } = await ready({
      idle: (timeoutMs) =>
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    });
    let owner = "agent";
    const takeover = new Error("The person is using this space.");
    const guard = () => {
      if (owner !== "agent") throw takeover;
    };
    cdp.holdReplies = true;
    const press = track(
      session.send(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 },
        { deadline: Date.now() + 30000, guard },
      ),
    );
    const read = track(
      session.send(
        "Runtime.evaluate",
        { expression: "1" },
        { deadline: Date.now() + 30000 },
      ),
    );
    // A command still waiting for its session to become ready reports the
    // takeover too.
    const loading = open({ url: "" });
    loading.cdp.holdReplies = true;
    loading.session.attach();
    const queued = track(
      loading.session.send(
        "Runtime.evaluate",
        { expression: "1" },
        { deadline: Date.now() + 30000, guard },
      ),
    );
    owner = "human";
    const released = session.release();
    await loading.session.release();
    expect(queued.error).toBe(takeover);
    await vi.advanceTimersByTimeAsync(1999);
    expect(press.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await released;
    expect(press.error).toBe(takeover);
    expect(read.error).toBeInstanceOf(SessionLostError);
    expect(read.error).toMatchObject({ reason: "unavailable" });
    expect(cdp.detachCount).toBe(1);
  });

  it("fails pending sends with tab_closed when the page is destroyed", async () => {
    const { session, cdp, host } = await ready();
    cdp.holdReplies = true;
    const closed = vi.fn();
    session.on("closed", closed);
    const inFlight = track(session.send("Runtime.evaluate", {}, soon()));
    const loading = open({ url: "" });
    loading.cdp.holdReplies = true;
    loading.session.attach();
    const waiting = track(loading.session.send("Runtime.evaluate", {}, soon()));
    host.destroy();
    loading.host.destroy();
    await settle();
    expect(inFlight.error).toBeInstanceOf(TabClosedError);
    expect(waiting.error).toBeInstanceOf(TabClosedError);
    expect(session.state).toBe("released");
    expect(closed).toHaveBeenCalledTimes(1);
    await expect(
      session.send("Input.dispatchKeyEvent", { type: "keyUp" }, soon()),
    ).rejects.toBeInstanceOf(TabClosedError);
    for (const name of [
      "did-start-navigation",
      "did-navigate",
      "did-fail-load",
      "render-process-gone",
      "devtools-closed",
      "destroyed",
    ])
      expect(host.listenerCount(name), name).toBe(0);
    expect(cdp.listenerCount("message")).toBe(0);
    expect(cdp.listenerCount("detach")).toBe(0);
    await session.release();
    expect(cdp.detachCount).toBe(0);
  });
});
// A ready session on a loaded page. Its worlds get ids 1, 2 and so on, and
// each evaluation answers with the context it ran in.
async function worldSession() {
  const host = new FakeHost({ url: "https://example.com/" });
  let contexts = 0;
  host.debugger.reply("Page.createIsolatedWorld", () => ({
    executionContextId: ++contexts,
  }));
  host.debugger.reply("Runtime.evaluate", (params) => ({
    result: { type: "object", value: { ok: true, contextId: params.contextId } },
  }));
  const session = new TabSession(host as unknown as SessionHost, {
    tabId: "tab-1",
    waitForSpaceIdle: async () => {},
  });
  session.attach();
  await vi.advanceTimersByTimeAsync(0);
  expect(session.state).toBe("ready");
  const sent = (method: string) =>
    host.debugger.sent.filter((command) => command.method === method);
  return { host, session, sent };
}
const evaluation = () => ({ deadline: Date.now() + 5000, namespace: "test" });
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("evaluateInFrame", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates one isolated world per document with Page.createIsolatedWorld and reuses it", async () => {
    const { host, session, sent } = await worldSession();
    expect(
      await session.evaluateInFrame(
        "main",
        "snapshot",
        { mode: "compact" },
        evaluation(),
      ),
    ).toEqual({ ok: true, contextId: 1 });
    await session.evaluateInFrame(
      "main",
      "check",
      { text: "Ready" },
      evaluation(),
    );
    expect(WORLD_NAME).toBe("kamapathy");
    expect(
      sent("Page.createIsolatedWorld").map((command) => command.params),
    ).toEqual([
      { frameId: "main", worldName: "kamapathy", grantUniveralAccess: false },
    ]);
    expect(sent("Runtime.evaluate")[0].params).toEqual({
      expression: operationExpression("snapshot", { mode: "compact" }, "test"),
      contextId: 1,
      returnByValue: true,
      awaitPromise: true,
      silent: true,
    });
    host.debugger.event("Page.frameNavigated", {
      frame: {
        id: "main",
        loaderId: "loader-2",
        url: "https://example.com/next",
        securityOrigin: "https://example.com",
        mimeType: "text/html",
      },
      type: "Navigation",
    });
    expect(
      await session.evaluateInFrame("main", "check", {}, evaluation()),
    ).toEqual({ ok: true, contextId: 2 });
    expect(
      await session.evaluateInFrame("main", "check", {}, evaluation()),
    ).toEqual({ ok: true, contextId: 2 });
    expect(sent("Page.createIsolatedWorld")).toHaveLength(2);
    const methods = host.debugger.sent.map((command) => command.method);
    expect(methods).not.toContain("Runtime.enable");
    expect(methods).not.toContain("DOM.enable");
  });

  it("recreates a missing world and retries once", async () => {
    const { host, session, sent } = await worldSession();
    let missing = 1;
    host.debugger.reply("Runtime.evaluate", (params) => {
      if (missing-- > 0)
        throw new Error("Cannot find context with specified id");
      return {
        result: {
          type: "object",
          value: { ok: true, contextId: params.contextId },
        },
      };
    });
    expect(
      await session.evaluateInFrame("main", "check", {}, evaluation()),
    ).toEqual({ ok: true, contextId: 2 });
    expect(sent("Page.createIsolatedWorld")).toHaveLength(2);
    expect(
      sent("Runtime.evaluate").map((command) => command.params.contextId),
    ).toEqual([1, 2]);
    // A context still missing after one new world means the page moved on
    // before the call ran.
    missing = 2;
    const error = await rejection(
      session.evaluateInFrame("main", "check", {}, evaluation()),
    );
    expect(error).toBeInstanceOf(ContextLostError);
    expect((error as ContextLostError).started).toBe(false);
    expect(sent("Page.createIsolatedWorld")).toHaveLength(3);
  });

  it("reports a context destroyed mid-call as ContextLostError with started true", async () => {
    const { host, session, sent } = await worldSession();
    for (const message of [
      "Execution context was destroyed.",
      "Inspected target navigated or closed",
    ]) {
      host.debugger.reply("Runtime.evaluate", () => {
        throw new Error(message);
      });
      const error = await rejection(
        session.evaluateInFrame(
          "main",
          "fill",
          { selector: "#name", value: "Ada" },
          evaluation(),
        ),
      );
      expect(error, message).toBeInstanceOf(ContextLostError);
      expect((error as ContextLostError).started).toBe(true);
    }
    expect(sent("Runtime.evaluate")).toHaveLength(2);
  });

  it("never reuses the main frame's world after a cross-document navigation starts, even before frameNavigated arrives", async () => {
    const { host, session, sent } = await worldSession();
    await session.evaluateInFrame("main", "check", {}, evaluation());
    host.emit("did-start-navigation", {
      url: "https://example.com/next",
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(
      await session.evaluateInFrame("main", "check", {}, evaluation()),
    ).toEqual({ ok: true, contextId: 2 });
    host.emit("did-start-navigation", {
      url: "https://example.com/next#part",
      isMainFrame: true,
      isSameDocument: true,
    });
    host.emit("did-start-navigation", {
      url: "https://frame.example/",
      isMainFrame: false,
      isSameDocument: false,
    });
    expect(
      await session.evaluateInFrame("main", "check", {}, evaluation()),
    ).toEqual({ ok: true, contextId: 2 });
    expect(sent("Page.createIsolatedWorld")).toHaveLength(2);
  });

  it("marks dispatch for mutating operations and never for reads", async () => {
    const { session } = await worldSession();
    const marked: string[] = [];
    for (const op of Object.keys(OPERATIONS) as PageOperation[]) {
      const dispatch = { dispatched: false };
      await session.evaluateInFrame("main", op, {}, {
        ...evaluation(),
        dispatch,
      });
      if (dispatch.dispatched) marked.push(op);
    }
    expect(marked.sort()).toEqual([
      "click",
      "fill",
      "focus",
      "scroll",
      "upload",
    ]);
  });
});
// Pages that open like BrowserController's views: the view-created listeners
// run before the first load.
class FakeViews {
  state: BrowserState = initialState("linux");
  pages = new Map<string, FakeHost>();
  peeked: string[] = [];
  private subscribers = new Set<(state: BrowserState) => void>();
  private created = new Set<(tabId: string, contents: WebContents) => void>();
  subscribe(listener: (state: BrowserState) => void) {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
  onViewCreated(listener: (tabId: string, contents: WebContents) => void) {
    this.created.add(listener);
    return () => {
      this.created.delete(listener);
    };
  }
  peekWebContents(tabId: string) {
    this.peeked.push(tabId);
    return this.pages.get(tabId) as unknown as WebContents | undefined;
  }
  emit() {
    for (const listener of this.subscribers) listener(this.state);
  }
  addSpace(id: string): Space {
    const space: Space = {
      id,
      name: id,
      color: "purple",
      kind: "agent",
      owner: "agent",
      signIns: "shared",
      createdAt: 0,
    };
    this.state.spaces.push(space);
    return space;
  }
  addTab(spaceId: string) {
    const tab = newTab(spaceId, "https://example.com/");
    this.state.tabs.push(tab);
    return tab;
  }
  // Returns the page and the methods its debugger had received when its
  // first load began.
  open(tabId: string) {
    const page = new FakeHost({ url: "" });
    this.pages.set(tabId, page);
    for (const listener of this.created)
      listener(tabId, page as unknown as WebContents);
    const beforeLoad = page.debugger.sent.map((command) => command.method);
    page.navigate("https://example.com/");
    return { page, beforeLoad };
  }
}

// The attach policy over FakeViews, with the space's running request
// finishing at once unless a test holds it.
function attachPolicy() {
  const views = new FakeViews();
  const driven = new Set<string>();
  const unmanaged = new Set<string>();
  const idle = {
    wait: (_spaceId: string, _timeoutMs: number) => Promise.resolve(),
  };
  const sessions = new TabSessions({
    controller: views as unknown as AutomationController,
    agentDriven: (spaceId) => driven.has(spaceId),
    managedTab: (tabId) => !unmanaged.has(tabId),
    waitForSpaceIdle: (spaceId, timeoutMs) => idle.wait(spaceId, timeoutMs),
  });
  return { views, sessions, driven, unmanaged, idle };
}

describe("TabSessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches only to tabs with a view in an agent-driven space that the registry predicate marks managed", async () => {
    const { views, sessions, driven, unmanaged } = attachPolicy();
    const personal = views.state.tabs[0];
    const space = views.addSpace("agent");
    const handedOver = views.addSpace("handed-over");
    driven.add(space.id);
    const page = views.addTab(space.id);
    const blank = views.addTab(space.id);
    const person = views.addTab(space.id);
    const elsewhere = views.addTab(handedOver.id);
    unmanaged.add(person.id);
    for (const tab of [personal, page, person, elsewhere]) views.open(tab.id);
    sessions.start();
    expect(sessions.get(page.id)?.contents).toBe(views.pages.get(page.id));
    for (const tab of [personal, blank, person, elsewhere])
      expect(sessions.get(tab.id)).toBeUndefined();
    expect(
      [...views.pages]
        .filter(([, host]) => host.debugger.attachCount > 0)
        .map(([id]) => id),
    ).toEqual([page.id]);
    for (const tab of [personal, person, elsewhere])
      expect(views.peeked).not.toContain(tab.id);
    // A tab without a page gets its session when the page opens.
    views.open(blank.id);
    expect(sessions.get(blank.id)?.contents).toBe(views.pages.get(blank.id));
    expect(sessions.attaches(page.id)).toBe(1);
    expect(sessions.attaches(blank.id)).toBe(1);
  });

  it("attaches inside onViewCreated before the page loads", async () => {
    const { views, sessions, driven } = attachPolicy();
    const space = views.addSpace("agent");
    driven.add(space.id);
    const tab = views.addTab(space.id);
    sessions.start();
    const { page, beforeLoad } = views.open(tab.id);
    expect(beforeLoad).toEqual(
      expect.arrayContaining([
        "Page.enable",
        "Page.setLifecycleEventsEnabled",
        "Network.enable",
        "Page.getFrameTree",
      ]),
    );
    expect(sessions.get(tab.id)?.contents).toBe(page);
    expect(page.debugger.attachCount).toBe(1);
    views.emit();
    expect(page.debugger.attachCount).toBe(1);
    expect(sessions.attaches(tab.id)).toBe(1);
  });

  it("gives a person tab in an agent space no session until adopted and releases it on release", async () => {
    const { views, sessions, driven, unmanaged } = attachPolicy();
    const space = views.addSpace("agent");
    driven.add(space.id);
    const tab = views.addTab(space.id);
    unmanaged.add(tab.id);
    sessions.start();
    const { page } = views.open(tab.id);
    views.emit();
    expect(sessions.get(tab.id)).toBeUndefined();
    expect(page.debugger.attachCount).toBe(0);
    unmanaged.delete(tab.id);
    sessions.sync();
    expect(sessions.get(tab.id)).toBeDefined();
    expect(page.debugger.attached).toBe(true);
    unmanaged.add(tab.id);
    sessions.sync();
    expect(sessions.get(tab.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600);
    expect(page.debugger.attached).toBe(false);
    expect(sessions.attaches(tab.id)).toBe(1);
  });

  it("releases on takeover and attaches a new session after the previous release when control returns", async () => {
    const { views, sessions, driven, idle } = attachPolicy();
    const space = views.addSpace("agent");
    driven.add(space.id);
    const tab = views.addTab(space.id);
    sessions.start();
    const { page } = views.open(tab.id);
    const first = sessions.get(tab.id)!;
    // The space's running request has not finished yet.
    let finish!: () => void;
    idle.wait = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    driven.delete(space.id);
    views.emit();
    expect(sessions.get(tab.id)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(600);
    expect(page.debugger.attached).toBe(true);
    driven.add(space.id);
    views.emit();
    const second = sessions.get(tab.id)!;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(page.debugger.attachCount).toBe(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.state).toBe("released");
    expect(page.debugger.attachCount).toBe(2);
    expect(page.debugger.attached).toBe(true);
    expect(sessions.get(tab.id)).toBe(second);
    expect(sessions.attaches(tab.id)).toBe(2);
  });

  it("releases every session on close", async () => {
    const { views, sessions, driven, idle } = attachPolicy();
    const spaces = [views.addSpace("one"), views.addSpace("two")];
    for (const space of spaces) driven.add(space.id);
    const tabs = [
      views.addTab(spaces[0].id),
      views.addTab(spaces[0].id),
      views.addTab(spaces[1].id),
    ];
    sessions.start();
    const pages = tabs.map((tab) => views.open(tab.id).page);
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    idle.wait = (spaceId) =>
      spaceId === spaces[0].id ? running : Promise.resolve();
    let closed = false;
    const closing = sessions.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(600);
    expect(closed).toBe(false);
    expect(pages.map((page) => page.debugger.attached)).toEqual([
      true,
      true,
      false,
    ]);
    finish();
    await closing;
    expect(pages.map((page) => page.debugger.attached)).toEqual([
      false,
      false,
      false,
    ]);
    expect(tabs.map((tab) => sessions.get(tab.id))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    // Nothing attaches once closed.
    const late = views.addTab(spaces[1].id);
    expect(views.open(late.id).page.debugger.attachCount).toBe(0);
    views.emit();
    expect(pages.map((page) => page.debugger.attachCount)).toEqual([1, 1, 1]);
  });
});
it("uses webContents.debugger only in tab-session.ts and never calls isAttached", () => {
  const root = fileURLToPath(new URL("../electron/", import.meta.url));
  const sources = readdirSync(root, { encoding: "utf8", recursive: true })
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({
      file: file.split(sep).join("/"),
      // Comments may name either; only code counts.
      code: readFileSync(join(root, file), "utf8").replace(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
        "",
      ),
    }));
  expect(
    sources
      .filter(({ code }) => /\.debugger\b/.test(code))
      .map(({ file }) => file),
  ).toEqual(["agent/session/tab-session.ts"]);
  expect(
    sources
      .filter(({ code }) => /\bisAttached\s*\(/.test(code))
      .map(({ file }) => file),
  ).toEqual([]);
});

it("maps session errors to API errors", () => {
  const mapped = (error: unknown) => {
    const known = toApiError(error);
    return (
      known && {
        status: known.status,
        code: known.code,
        message: known.message,
        fields: known.fields,
      }
    );
  };
  for (const error of [
    new ContextLostError(true),
    new FrameGoneError("child"),
    new FrameBlockedError("child"),
  ])
    expect(mapped(error), error.constructor.name).toEqual({
      status: 409,
      code: "page_changed",
      message:
        "The page navigated during this operation. Inspect the new page before continuing.",
      fields: {},
    });
  expect(mapped(new PageCrashedError())).toEqual({
    status: 409,
    code: "page_crashed",
    message:
      "The page process stopped. Navigate the tab to load it again before continuing.",
    fields: {},
  });
  expect(mapped(new SessionLostError("devtools"))).toEqual({
    status: 409,
    code: "debugger_busy",
    message:
      "Developer tools on this tab block agent access. Ask the person to close them.",
    fields: { reason: "devtools" },
  });
  expect(mapped(new SessionLostError("unavailable"))).toEqual({
    status: 409,
    code: "debugger_busy",
    message: "Kamapathy lost its connection to this tab. Try again shortly.",
    fields: { reason: "unavailable" },
  });
  expect(mapped(new TargetRefusedError("Target.getTargets"))).toEqual({
    status: 403,
    code: "cdp_method_blocked",
    message:
      "This protocol command is limited to this tab's own page and frames.",
    fields: { method: "Target.getTargets", reason: "scope" },
  });
  expect(mapped(new CdpTimeoutError("page"))).toEqual({
    status: 504,
    code: "page_timeout",
    message: "The page did not respond in time.",
    fields: { awaited: "page" },
  });
  expect(mapped(new TabClosedError())).toEqual({
    status: 409,
    code: "tab_closed",
    message: "The tab was closed.",
    fields: {},
  });
  expect(toApiError(new Error("Protocol error"))).toBeUndefined();
  // The envelope spreads a mapped error's fields and hides anything else.
  expect(errorBody(new SessionLostError("devtools"), "Fallback.")).toEqual({
    status: 409,
    error: {
      code: "debugger_busy",
      message:
        "Developer tools on this tab block agent access. Ask the person to close them.",
      reason: "devtools",
    },
  });
  expect(errorBody(new Error("Protocol error"), "Fallback.")).toEqual({
    status: 500,
    error: { code: "operation_failed", message: "Fallback." },
  });
});
