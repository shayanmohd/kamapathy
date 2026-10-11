import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CdpTimeoutError,
  PageCrashedError,
  SessionLostError,
  TabClosedError,
  TargetRefusedError,
} from "../electron/agent/session/errors";
import { TabSession } from "../electron/agent/session/tab-session";
import type {
  CdpEvent,
  SendStep,
  SessionHost,
} from "../electron/agent/session/types";
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
