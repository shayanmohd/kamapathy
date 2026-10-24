import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageOperation } from "../electron/automation-dom";
import { ApiError, errorBody, toApiError } from "../electron/agent/errors";
import { createDispatchers } from "../electron/agent/input/dispatch";
import type { AutomationController } from "../electron/agent/server";
import {
  CaptureFailedError,
  CdpTimeoutError,
  ContextLostError,
  DialogOpenError,
  FrameBlockedError,
  FrameGoneError,
  PageCrashedError,
  SessionLostError,
  TabClosedError,
  TargetRefusedError,
} from "../electron/agent/session/errors";
import {
  EVENT_LIMITS,
  EventBufferPool,
} from "../electron/agent/session/event-buffer";
import {
  FrameRegistry,
  PDF_VIEWER_ID,
  isWebFrame,
} from "../electron/agent/session/frames";
import {
  OPERATIONS,
  PAGE_SOURCE,
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
import {
  FakeHost,
  attachedTarget,
  frameNavigated,
  frameTree,
  lifecycleEvent,
  loadingEnded,
  requestWillBeSent,
  type FakeDebugger,
} from "./fake-cdp";

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

// A capture request like the screenshot route's.
const CLIP = { x: 0, y: 0, width: 1280, height: 800, scale: 0.5 };
const shoot = (
  session: TabSession,
  options: { deadline?: number; guard?: () => void } = {},
) =>
  session.captureScreenshot(
    { clip: CLIP, captureBeyondViewport: false },
    {
      deadline: options.deadline ?? Date.now() + 10000,
      ...(options.guard ? { guard: options.guard } : {}),
    },
  );
// How many of a method's commands a session is still waiting on.
const pendingCount = (session: TabSession, method = "Page.captureScreenshot") =>
  [
    ...(session as unknown as { pending: Set<{ method: string }> }).pending,
  ].filter((entry) => entry.method === method).length;

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
  attachedTarget(cdp, {
    parentSessionId: options.parent,
    sessionId,
    targetId: `target-${sessionId}`,
    type: options.type,
    url: "https://frame.example/",
    waitingForDebugger: options.waiting,
  });
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
    buffer: new EventBufferPool().create("tab-1"),
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

  it("sends a setup hook's later commands, after its awaits, while the session sets up, and again after a re-attach", async () => {
    const { session, cdp } = open();
    // A hook may await each command it sends.
    session.onSessionSetup(async (sessionId) => {
      const step = { sessionId, deadline: Date.now() + 5000 };
      await session.send("Runtime.addBinding", { name: "report" }, step);
      await session.send(
        "Page.setInterceptFileChooserDialog",
        { enabled: true },
        step,
      );
    });
    const intercepts = () =>
      cdp
        .methods()
        .filter((method) => method === "Page.setInterceptFileChooserDialog");
    session.attach();
    await settle();
    expect(session.state).toBe("ready");
    expect(intercepts()).toHaveLength(1);
    cdp.lose();
    await settle();
    expect(session.state).toBe("ready");
    expect(intercepts()).toHaveLength(2);
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
    expect(cdp.methods("worker-2")).toEqual(["Runtime.runIfWaitingForDebugger"]);
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

  it("captures on the page session with fromSurface and fails fast with screenshot_failed when the main frame navigates, the renderer goes away or the session detaches, dropping the pending command", async () => {
    const { session, cdp, host } = await ready();
    cdp.reply("Page.captureScreenshot", () => ({
      data: Buffer.from("png-bytes").toString("base64"),
    }));
    await expect(
      session.captureScreenshot(
        { clip: CLIP, captureBeyondViewport: true },
        { deadline: Date.now() + 10000 },
      ),
    ).resolves.toEqual(Buffer.from("png-bytes"));
    expect(cdp.sent.at(-1)).toEqual({
      method: "Page.captureScreenshot",
      params: {
        format: "png",
        clip: CLIP,
        captureBeyondViewport: true,
        fromSurface: true,
      },
    });
    // A new document in the main frame leaves the capture without a reply.
    // Only captures fail with it; other commands keep waiting.
    cdp.holdReplies = true;
    const reading = track(session.send("Runtime.evaluate", {}, soon()));
    const navigated = track(shoot(session));
    await settle();
    host.emit("did-start-navigation", {
      isMainFrame: false,
      isSameDocument: false,
    });
    host.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: true,
    });
    await settle();
    expect(navigated.settled).toBe(false);
    host.navigate("https://example.com/next");
    await settle();
    expect(navigated.error).toBeInstanceOf(CaptureFailedError);
    expect(navigated.error).toMatchObject({ reason: "navigation" });
    expect(reading.settled).toBe(false);
    expect(pendingCount(session)).toBe(0);
    expect(pendingCount(session, "Runtime.evaluate")).toBe(1);
    cdp.holdReplies = false;
    cdp.flush();
    await settle();
    expect(reading.settled).toBe(true);
    // A renderer that goes away answers only after about 11 s; the session
    // fails the capture at once instead.
    cdp.holdReplies = true;
    const crashed = track(shoot(session));
    await settle();
    host.crash();
    await settle();
    expect(crashed.error).toBeInstanceOf(CaptureFailedError);
    expect(crashed.error).toMatchObject({ reason: "crashed" });
    expect(pendingCount(session)).toBe(0);
    cdp.holdReplies = false;
    host.navigate("https://example.com/again");
    await settle();
    expect(session.state).toBe("ready");
    // A lost debugger ends it too.
    cdp.holdReplies = true;
    const detached = track(shoot(session));
    await settle();
    cdp.lose();
    await settle();
    expect(detached.error).toMatchObject({ reason: "detached" });
    expect(pendingCount(session)).toBe(0);
    cdp.holdReplies = false;
    cdp.flush();
    await settle();
    expect(session.state).toBe("ready");
    // A reply that never comes ends at the deadline.
    cdp.holdReplies = true;
    const timing = track(shoot(session, { deadline: Date.now() + 2000 }));
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    expect(timing.error).toMatchObject({ reason: "timeout" });
    expect(pendingCount(session)).toBe(0);
    cdp.holdReplies = false;
    cdp.flush();
    await settle();
    // Chromium's own message never leaves the main process.
    cdp.reply("Page.captureScreenshot", () => {
      throw new Error("UnknownVizError internal details");
    });
    const failed = await rejection(shoot(session));
    expect(failed).toBeInstanceOf(CaptureFailedError);
    expect(failed).toMatchObject({ reason: "failed" });
    expect((failed as Error).message).not.toContain("UnknownVizError");
    // Failures with a meaning of their own keep it.
    for (const error of [
      new TabClosedError(),
      new DialogOpenError({ type: "alert", message: "Wait" }, true),
      new TargetRefusedError("Target.getTargets"),
      new ApiError("human_control", "The person took over this space."),
    ]) {
      cdp.reply("Page.captureScreenshot", () => {
        throw error;
      });
      expect(await rejection(shoot(session)), error.constructor.name).toBe(
        error,
      );
    }
    // A takeover while the capture is in flight reports the person's control.
    let taken = false;
    const guard = () => {
      if (taken)
        throw new ApiError("human_control", "The person took over this space.");
    };
    cdp.reply("Page.captureScreenshot", () => ({ data: "" }));
    cdp.holdReplies = true;
    const cut = track(shoot(session, { guard }));
    await settle();
    taken = true;
    cdp.holdReplies = false;
    cdp.flush();
    await settle();
    expect(cut.error).toBeInstanceOf(ApiError);
    expect(cut.error).toMatchObject({ code: "human_control" });
    // So does a tab that closes under it.
    cdp.holdReplies = true;
    const closing = track(shoot(session));
    await settle();
    host.destroy();
    await settle();
    expect(closing.error).toBeInstanceOf(TabClosedError);
    expect(pendingCount(session)).toBe(0);
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
    buffer: new EventBufferPool().create("tab-1"),
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
function attachPolicy(buffers = new EventBufferPool()) {
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
    buffers,
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
  for (const reason of [
    "navigation",
    "crashed",
    "detached",
    "timeout",
    "failed",
  ] as const)
    expect(mapped(new CaptureFailedError(reason)), reason).toEqual({
      status: 503,
      code: "screenshot_failed",
      message:
        "The page could not render a screenshot. Read a snapshot or try again after the page finishes rendering.",
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
type TreeFrames = Parameters<typeof frameTree>[0];
// A Page.getFrameTree reply's frame tree.
const treeOf = (frames: TreeFrames) =>
  (frameTree(frames) as { frameTree: object }).frameTree;
const frameEvent = (
  method: string,
  params: object,
  sessionId?: string,
): CdpEvent => ({ method, params, sessionId, at: 0 });
// Each session's Page.getFrameTree, keyed by session id, "" for the page.
function frameTrees(cdp: FakeDebugger, trees: Record<string, TreeFrames>) {
  cdp.reply("Page.getFrameTree", (_params, sessionId) =>
    frameTree(trees[sessionId ?? ""]),
  );
}
// Answers path lookups for frames at these indexes in their parents'
// documents. A frame given null is not one frameIndex lists, and a frame
// left out has no owner element.
function framePaths(cdp: FakeDebugger, indexes: Record<string, string | null>) {
  const owners = Object.keys(indexes);
  cdp.reply("DOM.getFrameOwner", (params) => {
    if (!owners.includes(params.frameId))
      throw new Error("Frame with the given id was not found.");
    return { backendNodeId: owners.indexOf(params.frameId) + 1 };
  });
  cdp.reply("DOM.resolveNode", (params) => ({
    object: {
      type: "object",
      subtype: "node",
      objectId: `owner-${params.backendNodeId}`,
    },
  }));
  cdp.reply("Runtime.callFunctionOn", (params) => {
    const path = indexes[owners[Number(params.objectId.slice(6)) - 1]];
    return {
      result: {
        type: "object",
        value:
          path === null
            ? {
                ok: false,
                code: "element_action_failed",
                error: "Not a frame.",
              }
            : { ok: true, path },
      },
    };
  });
}
// A ready session on a page with a same-origin frame, card, and a frame from
// another site, ads, that Chromium moves to its own process and session as
// it does: its target is reported before its URL is known.
async function framedPage() {
  const opened = open();
  frameTrees(opened.cdp, {
    "": [
      { id: "main", url: "https://example.com/" },
      { id: "card", parentId: "main", url: "https://example.com/card" },
    ],
    "ads-session": [
      { id: "ads", parentId: "main", url: "https://ads.example/" },
      { id: "ads-inner", parentId: "ads", url: "https://ads.example/inner" },
    ],
  });
  opened.session.attach();
  await settle();
  opened.cdp.event("Page.frameAttached", {
    frameId: "ads",
    parentFrameId: "main",
  });
  opened.cdp.event("Page.frameStartedNavigating", {
    frameId: "ads",
    url: "https://ads.example/",
    loaderId: "loader-ads",
    navigationType: "differentDocument",
  });
  attachedTarget(opened.cdp, {
    sessionId: "ads-session",
    targetId: "ads",
    url: "",
  });
  await settle();
  return opened;
}
const createdWorlds = (cdp: FakeDebugger) =>
  cdp.sent.filter((command) => command.method === "Page.createIsolatedWorld");

describe("frames", () => {
  it("keeps the frame registry through attach, navigate, same-document navigation, swap, remove and session loss", async () => {
    const { cdp, session } = await framedPage();
    frameTrees(cdp, {
      "": [
        { id: "main", url: "https://example.com/" },
        { id: "card", parentId: "main", url: "https://example.com/card" },
      ],
      "ads-session": [
        { id: "ads", parentId: "main", url: "https://ads.example/" },
        { id: "ads-inner", parentId: "ads", url: "https://ads.example/inner" },
      ],
      "late-session": [
        { id: "late", parentId: "main", url: "https://late.example/" },
      ],
    });
    framePaths(cdp, {
      card: "0",
      ads: "1",
      "ads-inner": "0",
      late: "2",
      "late-inner": "0",
    });
    const changes: unknown[] = [];
    session.on("frame", ({ params }) => {
      changes.push(params);
    });
    const listed = async () =>
      (await session.frames(soon())).map(
        ({ frameId, url, path, sessionId, unavailable }) =>
          [frameId, url, path, sessionId, unavailable] as const,
      );
    expect(await listed()).toEqual([
      ["main", "https://example.com/", "", undefined, undefined],
      ["card", "https://example.com/card", "0", undefined, undefined],
      ["ads", "https://ads.example/", "1", "ads-session", undefined],
      [
        "ads-inner",
        "https://ads.example/inner",
        "1/0",
        "ads-session",
        undefined,
      ],
    ]);
    // A new frame shows about:blank until it navigates. A new document has
    // none of the old one's frames.
    cdp.event("Page.frameAttached", { frameId: "late", parentFrameId: "main" });
    cdp.event("Page.frameAttached", {
      frameId: "late-inner",
      parentFrameId: "late",
    });
    expect((await listed()).slice(4)).toEqual([
      ["late", "about:blank", "2", undefined, undefined],
      ["late-inner", "about:blank", "2/0", undefined, undefined],
    ]);
    cdp.event("Page.frameNavigated", {
      frame: {
        id: "late",
        parentId: "main",
        loaderId: "loader-late-2",
        url: "https://example.com/late",
        securityOrigin: "https://example.com",
        mimeType: "text/html",
      },
      type: "Navigation",
    });
    cdp.event("Page.navigatedWithinDocument", {
      frameId: "late",
      url: "https://example.com/late#part",
    });
    expect((await listed()).slice(4)).toEqual([
      ["late", "https://example.com/late#part", "2", undefined, undefined],
    ]);
    // The frame moves to its own process. Chromium may report the swap
    // after the new session attached, and the swap changes nothing then.
    cdp.event("Page.frameDetached", { frameId: "late", reason: "swap" });
    attachedTarget(cdp, {
      sessionId: "late-session",
      targetId: "late",
      url: "https://late.example/",
    });
    await settle();
    cdp.event("Page.frameDetached", { frameId: "late", reason: "swap" });
    expect((await listed()).slice(4)).toEqual([
      ["late", "https://late.example/", "2", "late-session", undefined],
    ]);
    // Removing a frame removes the frames inside it.
    cdp.event("Page.frameDetached", { frameId: "ads", reason: "remove" });
    // A frame whose session ends stays listed, unavailable.
    cdp.event("Target.detachedFromTarget", { sessionId: "late-session" });
    expect(await listed()).toEqual([
      ["main", "https://example.com/", "", undefined, undefined],
      ["card", "https://example.com/card", "0", undefined, undefined],
      ["late", "https://late.example/", "2", undefined, true],
    ]);
    expect(changes).toEqual([
      { frameId: "late", change: "attached" },
      { frameId: "late-inner", change: "attached" },
      { frameId: "late", change: "navigated" },
      { frameId: "late-inner", change: "detached" },
      { frameId: "ads", change: "detached" },
      { frameId: "ads-inner", change: "detached" },
    ]);
    // A lost debugger takes every frame with it until setup reads the tree
    // again.
    cdp.lose();
    await settle();
    expect(session.state).toBe("ready");
    expect(await listed()).toEqual([
      ["main", "https://example.com/", "", undefined, undefined],
      ["card", "https://example.com/card", "0", undefined, undefined],
    ]);
  });

  it("computes crossOrigin against the parent frame's origin, opaque origins included, and false for the main frame", () => {
    const registry = new FrameRegistry();
    registry.seed(
      treeOf([
        { id: "main", url: "https://example.com/" },
        { id: "same", parentId: "main", url: "https://example.com/same" },
        { id: "site", parentId: "main", url: "https://ads.example/" },
        { id: "port", parentId: "main", url: "https://example.com:8443/" },
        { id: "scheme", parentId: "main", url: "http://example.com/" },
        // Chromium reports the opaque origin of these documents as "://".
        {
          id: "data",
          parentId: "main",
          url: "data:text/html,<p>Hi</p>",
          origin: "://",
        },
        { id: "blank", parentId: "main", url: "about:blank", origin: "://" },
        { id: "srcdoc", parentId: "data", url: "about:srcdoc", origin: "://" },
        {
          id: "sandbox",
          parentId: "same",
          url: "https://example.com/box",
          origin: "null",
        },
      ]),
    );
    expect(
      registry
        .list()
        .map(({ frameId }) => [frameId, registry.crossOrigin(frameId)]),
    ).toEqual([
      ["main", false],
      ["same", false],
      ["sandbox", true],
      ["site", true],
      ["port", true],
      ["scheme", true],
      ["data", true],
      ["srcdoc", true],
      ["blank", true],
    ]);
    expect(registry.crossOrigin("unknown")).toBe(false);
  });

  it("lists extension frames and the PDF viewer as blocked with no world or setup hook, refuses evaluateInFrame and world, and resumes and detaches their targets", async () => {
    const { cdp, session } = open();
    frameTrees(cdp, {
      "": [
        { id: "main", url: "https://example.com/" },
        { id: "doc", parentId: "main", url: "https://example.com/doc.pdf" },
      ],
    });
    const hook = vi.fn(async (_sessionId?: string) => {});
    session.onSessionSetup(hook);
    session.attach();
    await settle();
    // Chromium opens the PDF viewer inside the frame showing the PDF and
    // reports its target before its URL is known.
    const viewer = `chrome-extension://${PDF_VIEWER_ID}/index.html`;
    cdp.event("Page.frameAttached", {
      frameId: "viewer",
      parentFrameId: "doc",
    });
    cdp.event("Page.frameStartedNavigating", {
      frameId: "viewer",
      url: viewer,
      loaderId: "loader-viewer",
      navigationType: "differentDocument",
    });
    attachedTarget(cdp, {
      sessionId: "viewer-session",
      targetId: "viewer",
      url: "",
    });
    // An extension's own page in a frame, whose target waits to start.
    const panel =
      "chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html";
    cdp.event("Page.frameAttached", {
      frameId: "panel",
      parentFrameId: "main",
    });
    attachedTarget(cdp, {
      sessionId: "panel-session",
      targetId: "panel",
      url: panel,
      waitingForDebugger: true,
    });
    await settle();
    expect(cdp.methods("viewer-session")).toEqual([
      "Runtime.runIfWaitingForDebugger",
    ]);
    expect(cdp.methods("panel-session")).toEqual([
      "Runtime.runIfWaitingForDebugger",
    ]);
    expect(
      cdp.sent.filter(
        (command) => command.method === "Target.detachFromTarget",
      ),
    ).toEqual([
      {
        method: "Target.detachFromTarget",
        params: { sessionId: "viewer-session" },
      },
      {
        method: "Target.detachFromTarget",
        params: { sessionId: "panel-session" },
      },
    ]);
    expect(hook.mock.calls).toEqual([[undefined]]);
    framePaths(cdp, { doc: "0", viewer: "0", panel: "1" });
    expect(
      (await session.frames(soon())).map(
        ({ frameId, url, path, sessionId, blocked }) => ({
          frameId,
          url,
          path,
          sessionId,
          blocked,
        }),
      ),
    ).toEqual([
      { frameId: "main", url: "https://example.com/", path: "" },
      { frameId: "doc", url: "https://example.com/doc.pdf", path: "0" },
      { frameId: "viewer", url: viewer, path: "0/0", blocked: true },
      { frameId: "panel", url: panel, path: "1", blocked: true },
    ]);
    for (const frameId of ["viewer", "panel"]) {
      await expect(
        session.evaluateInFrame(frameId, "snapshot", {}, evaluation()),
      ).rejects.toBeInstanceOf(FrameBlockedError);
      await expect(session.world(frameId, soon())).rejects.toBeInstanceOf(
        FrameBlockedError,
      );
    }
    expect(createdWorlds(cdp).map((command) => command.params.frameId)).toEqual(
      ["main", "doc"],
    );
  });

  it("blocks every frame inside a blocked frame", async () => {
    const registry = new FrameRegistry();
    registry.seed(
      treeOf([
        { id: "main", url: "https://example.com/" },
        {
          id: "panel",
          parentId: "main",
          url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html",
          origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        },
        { id: "inside", parentId: "panel", url: "https://example.com/inside" },
        { id: "deeper", parentId: "inside", url: "about:blank", origin: "://" },
        { id: "card", parentId: "main", url: "https://example.com/card" },
        {
          id: "data",
          parentId: "main",
          url: "data:text/html,<p>Hi</p>",
          origin: "://",
        },
      ]),
    );
    registry.apply(
      frameEvent("Page.frameAttached", {
        frameId: "late",
        parentFrameId: "inside",
      }),
    );
    expect(
      registry.list().map(({ frameId, blocked }) => [frameId, blocked]),
    ).toEqual([
      ["main", false],
      ["panel", true],
      ["inside", true],
      ["deeper", true],
      ["late", true],
      ["card", false],
      ["data", false],
    ]);
    // In a tab showing a local file, a web frame inside it gets no session.
    const { cdp, session } = open({ url: "file:///Users/person/page.html" });
    frameTrees(cdp, {
      "": [
        {
          id: "main",
          url: "file:///Users/person/page.html",
          origin: "file://",
        },
        { id: "blank", parentId: "main", url: "about:blank", origin: "://" },
      ],
    });
    const hook = vi.fn(async (_sessionId?: string) => {});
    session.onSessionSetup(hook);
    session.attach();
    await settle();
    cdp.event("Page.frameAttached", { frameId: "web", parentFrameId: "main" });
    attachedTarget(cdp, {
      sessionId: "web-session",
      targetId: "web",
      url: "https://example.com/",
    });
    await settle();
    expect(cdp.methods("web-session")).toEqual([
      "Runtime.runIfWaitingForDebugger",
    ]);
    expect(cdp.sent.at(-1)).toEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "web-session" },
    });
    expect(hook.mock.calls).toEqual([[undefined]]);
    for (const frameId of ["main", "blank", "web"])
      await expect(
        session.evaluateInFrame(frameId, "check", {}, evaluation()),
      ).rejects.toBeInstanceOf(FrameBlockedError);
    expect(createdWorlds(cdp)).toEqual([]);
    // A frame's path is read in its parent's world, so only the main frame
    // is listed here.
    expect(await session.frames(soon())).toEqual([
      {
        frameId: "main",
        url: "file:///Users/person/page.html",
        origin: "file://",
        crossOrigin: false,
        path: "",
        loaderId: "loader-main",
        lifecycle: "unknown",
        blocked: true,
      },
    ]);
  });

  it("drops the world and session of a frame that later commits a blocked URL", async () => {
    const { cdp, session } = await framedPage();
    await session.evaluateInFrame("ads", "check", {}, evaluation());
    await session.evaluateInFrame("card", "check", {}, evaluation());
    expect(createdWorlds(cdp)).toHaveLength(2);
    const changes: unknown[] = [];
    session.on("frame", ({ params }) => {
      changes.push(params);
    });
    // The out-of-process frame loads an extension page: its session is
    // detached on the page session, with the frames inside it.
    const page = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/ad.html";
    cdp.event(
      "Page.frameNavigated",
      {
        frame: {
          id: "ads",
          parentId: "main",
          loaderId: "loader-ads-2",
          url: page,
          securityOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
          mimeType: "text/html",
        },
        type: "Navigation",
      },
      "ads-session",
    );
    await settle();
    expect(cdp.sent.at(-1)).toEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "ads-session" },
    });
    await expect(
      session.send("Page.getFrameTree", {}, soon("ads-session")),
    ).rejects.toBeInstanceOf(TargetRefusedError);
    // A same-process frame showing an error page loses its world.
    cdp.event("Page.frameNavigated", {
      frame: {
        id: "card",
        parentId: "main",
        loaderId: "loader-card-2",
        url: "chrome-error://chromewebdata/",
        securityOrigin: "://",
        mimeType: "text/html",
      },
      type: "Navigation",
    });
    for (const frameId of ["ads", "card"])
      await expect(
        session.evaluateInFrame(frameId, "check", {}, evaluation()),
      ).rejects.toBeInstanceOf(FrameBlockedError);
    await expect(
      session.evaluateInFrame("ads-inner", "check", {}, evaluation()),
    ).rejects.toBeInstanceOf(FrameGoneError);
    expect(createdWorlds(cdp)).toHaveLength(2);
    expect(changes).toEqual([
      { frameId: "ads", change: "navigated" },
      { frameId: "ads-inner", change: "detached" },
      { frameId: "card", change: "navigated" },
    ]);
    framePaths(cdp, { card: "0", ads: "1" });
    expect(
      (await session.frames(soon())).map(
        ({ frameId, sessionId, blocked, unavailable }) => ({
          frameId,
          sessionId,
          blocked,
          unavailable,
        }),
      ),
    ).toEqual([
      { frameId: "main" },
      { frameId: "card", blocked: true },
      { frameId: "ads", blocked: true },
    ]);
  });

  it("treats a main frame showing chrome-error://chromewebdata/ as a web frame", async () => {
    expect(isWebFrame("chrome-error://chromewebdata/", "://", true)).toBe(true);
    expect(isWebFrame("chrome-error://chromewebdata/", "://", false)).toBe(
      false,
    );
    const { cdp, session } = open({ url: "chrome-error://chromewebdata/" });
    frameTrees(cdp, {
      "": [{ id: "main", url: "chrome-error://chromewebdata/", origin: "://" }],
    });
    cdp.reply("Runtime.evaluate", () => ({
      result: { type: "object", value: { ok: true, matched: true } },
    }));
    session.attach();
    await settle();
    expect(
      await session.evaluateInFrame(
        "main",
        "check",
        { text: "This site can't be reached" },
        evaluation(),
      ),
    ).toEqual({ ok: true, matched: true });
    expect(createdWorlds(cdp)).toHaveLength(1);
    expect((await session.frames(soon()))[0]).not.toHaveProperty("blocked");
  });

  it("evaluates in an out-of-process frame on its own session", async () => {
    const { cdp, session } = await framedPage();
    cdp.reply("Runtime.evaluate", (params, sessionId) => ({
      result: {
        type: "object",
        value: {
          ok: true,
          sessionId: sessionId ?? null,
          contextId: params.contextId,
        },
      },
    }));
    expect(
      await session.evaluateInFrame(
        "ads",
        "check",
        { text: "Ad" },
        evaluation(),
      ),
    ).toEqual({ ok: true, sessionId: "ads-session", contextId: 1 });
    expect(
      await session.evaluateInFrame("ads-inner", "check", {}, evaluation()),
    ).toEqual({ ok: true, sessionId: "ads-session", contextId: 2 });
    expect(
      await session.evaluateInFrame("main", "check", {}, evaluation()),
    ).toEqual({ ok: true, sessionId: null, contextId: 3 });
    expect(createdWorlds(cdp)).toEqual([
      {
        method: "Page.createIsolatedWorld",
        params: {
          frameId: "ads",
          worldName: "kamapathy",
          grantUniveralAccess: false,
        },
        sessionId: "ads-session",
      },
      {
        method: "Page.createIsolatedWorld",
        params: {
          frameId: "ads-inner",
          worldName: "kamapathy",
          grantUniveralAccess: false,
        },
        sessionId: "ads-session",
      },
      {
        method: "Page.createIsolatedWorld",
        params: {
          frameId: "main",
          worldName: "kamapathy",
          grantUniveralAccess: false,
        },
      },
    ]);
    expect(
      cdp.sent.find(
        (command) =>
          command.method === "Runtime.evaluate" &&
          command.sessionId === "ads-session",
      )?.params,
    ).toEqual({
      expression: operationExpression("check", { text: "Ad" }, "test"),
      contextId: 1,
      returnByValue: true,
      awaitPromise: true,
      silent: true,
    });
  });

  it("world returns the session and context evaluateInFrame uses and fails with ContextLostError after the frame's next document", async () => {
    const { cdp, session } = await framedPage();
    const handle = await session.world("ads", soon());
    expect(handle).toEqual({ sessionId: "ads-session", contextId: 1 });
    await session.evaluateInFrame("ads", "check", {}, evaluation());
    expect(
      cdp.sent.filter((command) => command.method === "Runtime.evaluate"),
    ).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ contextId: 1 }),
        sessionId: "ads-session",
      }),
    ]);
    expect(createdWorlds(cdp)).toHaveLength(1);
    const resolve = (world: { sessionId?: string; contextId: number }) =>
      session.send(
        "DOM.resolveNode",
        { backendNodeId: 7, executionContextId: world.contextId },
        soon(world.sessionId),
      );
    await expect(resolve(handle)).resolves.toEqual({});
    // Chromium reports a context that is already gone.
    cdp.reply("DOM.resolveNode", () => {
      throw new Error("Cannot find context with specified id");
    });
    const missing = await rejection(resolve(handle));
    expect(missing).toBeInstanceOf(ContextLostError);
    expect(missing).toMatchObject({ started: false });
    cdp.reply("DOM.resolveNode", () => ({}));
    // After the frame's next document the handle is refused before anything
    // is sent, since a new process may give its id to another context.
    cdp.event(
      "Page.frameNavigated",
      {
        frame: {
          id: "ads",
          parentId: "main",
          loaderId: "loader-ads-2",
          url: "https://ads.example/next",
          securityOrigin: "https://ads.example",
          mimeType: "text/html",
        },
        type: "Navigation",
      },
      "ads-session",
    );
    const sent = cdp.sent.length;
    const ended = await rejection(resolve(handle));
    expect(ended).toBeInstanceOf(ContextLostError);
    expect(ended).toMatchObject({ started: false });
    expect(cdp.sent).toHaveLength(sent);
    const next = await session.world("ads", soon());
    expect(next).toEqual({ sessionId: "ads-session", contextId: 2 });
    await expect(resolve(next)).resolves.toEqual({});
    // A world made while its frame moved on is never handed out.
    cdp.holdReplies = true;
    const racing = rejection(session.world("card", soon()));
    await settle();
    cdp.event("Page.frameNavigated", {
      frame: {
        id: "card",
        parentId: "main",
        loaderId: "loader-card-2",
        url: "https://example.com/card/2",
        securityOrigin: "https://example.com",
        mimeType: "text/html",
      },
      type: "Navigation",
    });
    cdp.holdReplies = false;
    cdp.flush();
    expect(await racing).toBeInstanceOf(ContextLostError);
    expect(await session.world("card", soon())).toEqual({ contextId: 4 });
    // The same holds once the frame's session has ended, and after a
    // re-attach.
    const main = await session.world("main", soon());
    cdp.event("Target.detachedFromTarget", { sessionId: "ads-session" });
    await expect(resolve(next)).rejects.toBeInstanceOf(ContextLostError);
    cdp.lose();
    await settle();
    expect(session.state).toBe("ready");
    await expect(resolve(main)).rejects.toBeInstanceOf(ContextLostError);
    expect(await session.world("main", soon())).toEqual({ contextId: 6 });
  });

  it("refuses a world's context id after any number of main-frame navigations, and any context id it did not hand out, except on agent sessions", async () => {
    const { host, session } = await worldSession();
    const world = await session.world("main", soon());
    const evaluate = (contextId: number, sessionId?: string) =>
      session.send(
        "Runtime.evaluate",
        { expression: "1", contextId },
        soon(sessionId),
      );
    for (const url of ["https://example.com/next", "https://example.com/last"])
      host.emit("did-start-navigation", {
        url,
        isMainFrame: true,
        isSameDocument: false,
      });
    const sent = host.debugger.sent.length;
    const ended = await rejection(evaluate(world.contextId));
    expect(ended).toBeInstanceOf(ContextLostError);
    expect(ended).toMatchObject({ started: false });
    // Context ids restart in each renderer process, so an id Kamapathy did
    // not hand out may name any context.
    expect(await rejection(evaluate(world.contextId + 10))).toBeInstanceOf(
      ContextLostError,
    );
    expect(host.debugger.sent).toHaveLength(sent);
    // An agent session's contexts are the agent's own.
    const agent = await session.openAgentSession();
    await expect(evaluate(3, agent)).resolves.toMatchObject({
      result: { value: { ok: true, contextId: 3 } },
    });
  });

  it("computes frame paths through DOM.getFrameOwner, DOM.resolveNode and frameIndex, releases the object group and omits unresolvable frames", async () => {
    const { cdp, session } = await framedPage();
    // gone has no owner element, and frameIndex does not list hidden, so
    // neither has a path, nor has the frame inside hidden.
    cdp.event("Page.frameAttached", {
      frameId: "hidden",
      parentFrameId: "card",
    });
    cdp.event("Page.frameAttached", {
      frameId: "deep",
      parentFrameId: "hidden",
    });
    cdp.event("Page.frameAttached", { frameId: "gone", parentFrameId: "main" });
    framePaths(cdp, {
      card: "0",
      hidden: null,
      deep: "0",
      ads: "1",
      "ads-inner": "0",
    });
    expect(
      (await session.frames(soon())).map(
        ({ frameId, path, sessionId, crossOrigin }) => ({
          frameId,
          path,
          sessionId,
          crossOrigin,
        }),
      ),
    ).toEqual([
      { frameId: "main", path: "", crossOrigin: false },
      { frameId: "card", path: "0", crossOrigin: false },
      {
        frameId: "ads",
        path: "1",
        sessionId: "ads-session",
        crossOrigin: true,
      },
      {
        frameId: "ads-inner",
        path: "1/0",
        sessionId: "ads-session",
        crossOrigin: false,
      },
    ]);
    const lookups = cdp.sent.filter((command) =>
      /^(DOM|Runtime)\./.test(command.method),
    );
    // Each frame's owner is found on the session hosting its parent and
    // resolved into the parent's world: main's is context 1, card's 2 and
    // ads's 3.
    expect(lookups.slice(0, 3)).toEqual([
      { method: "DOM.getFrameOwner", params: { frameId: "card" } },
      {
        method: "DOM.resolveNode",
        params: {
          backendNodeId: 1,
          executionContextId: 1,
          objectGroup: "kamapathy-frames",
        },
      },
      {
        method: "Runtime.callFunctionOn",
        params: {
          objectId: "owner-1",
          functionDeclaration: `function(namespace){return (${PAGE_SOURCE})("frameIndex",{element:this},namespace)}`,
          arguments: [{ value: "internal" }],
          returnByValue: true,
          awaitPromise: true,
        },
      },
    ]);
    expect(
      lookups
        .filter((command) => command.method === "DOM.resolveNode")
        .map(({ params, sessionId }) => [
          params.backendNodeId,
          params.executionContextId,
          sessionId,
        ]),
    ).toEqual([
      [1, 1, undefined],
      [2, 2, undefined],
      [4, 1, undefined],
      [5, 3, "ads-session"],
    ]);
    expect(
      lookups
        .filter((command) => command.method === "DOM.getFrameOwner")
        .map(({ params, sessionId }) => [params.frameId, sessionId]),
    ).toEqual([
      ["card", undefined],
      ["hidden", undefined],
      ["ads", undefined],
      ["ads-inner", "ads-session"],
      ["gone", undefined],
    ]);
    expect(
      lookups.filter(
        (command) => command.method === "Runtime.releaseObjectGroup",
      ),
    ).toEqual([
      {
        method: "Runtime.releaseObjectGroup",
        params: { objectGroup: "kamapathy-frames" },
      },
      {
        method: "Runtime.releaseObjectGroup",
        params: { objectGroup: "kamapathy-frames" },
        sessionId: "ads-session",
      },
    ]);
    const methods = cdp.sent.map((command) => command.method);
    expect(methods).not.toContain("DOM.enable");
    expect(methods).not.toContain("Runtime.enable");
    // A takeover ends the whole read.
    const takeover = new Error("The person is using this space.");
    await expect(
      session.frames({
        ...soon(),
        guard: () => {
          throw takeover;
        },
      }),
    ).rejects.toBe(takeover);
  });

  it("marks the frames of a child whose setup failed unavailable", async () => {
    const { cdp, session } = open();
    frameTrees(cdp, {
      "": [{ id: "main", url: "https://example.com/" }],
      "ads-session": [
        { id: "ads", parentId: "main", url: "https://ads.example/" },
        { id: "ads-inner", parentId: "ads", url: "https://ads.example/inner" },
      ],
    });
    // The frame's session ends before Chromium answers Network.enable.
    cdp.reply("Network.enable", (_params, sessionId) =>
      sessionId === "ads-session"
        ? new Promise((_resolve, reject) =>
            setTimeout(() => reject(new Error("Session closed")), 0),
          )
        : {},
    );
    session.attach();
    await settle();
    cdp.event("Page.frameAttached", { frameId: "ads", parentFrameId: "main" });
    attachedTarget(cdp, {
      sessionId: "ads-session",
      targetId: "ads",
      url: "https://ads.example/",
    });
    await settle();
    expect(cdp.sent.at(-1)).toEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "ads-session" },
    });
    framePaths(cdp, { ads: "0", "ads-inner": "0" });
    expect(
      (await session.frames(soon())).map(
        ({ frameId, path, sessionId, unavailable }) => ({
          frameId,
          path,
          sessionId,
          unavailable,
        }),
      ),
    ).toEqual([
      { frameId: "main", path: "" },
      { frameId: "ads", path: "0", unavailable: true },
    ]);
    for (const frameId of ["ads", "ads-inner"])
      for (const lost of [
        await rejection(session.world(frameId, soon())),
        await rejection(
          session.evaluateInFrame(frameId, "check", {}, evaluation()),
        ),
      ]) {
        expect(lost, frameId).toBeInstanceOf(SessionLostError);
        expect(lost).toMatchObject({ reason: "unavailable" });
      }
    expect(createdWorlds(cdp).map((command) => command.params.frameId)).toEqual(
      ["main"],
    );
  });
});
describe("lifecycle and network", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const step = (ms = 10000) => ({ deadline: Date.now() + ms });
  // A ready session whose sessions each answer Page.getFrameTree with their
  // own frames. heard collects its lifecycle events.
  const tracked = async () => {
    const opened = await ready();
    const trees: Record<string, Parameters<typeof frameTree>[0]> = {
      "": [{ id: "main", url: "https://example.com/", loaderId: "loader-1" }],
    };
    opened.cdp.reply("Page.getFrameTree", (_params, sessionId) =>
      frameTree(trees[sessionId ?? ""]),
    );
    const heard: unknown[][] = [];
    opened.session.on("lifecycle", ({ params, sessionId }) => {
      heard.push([params.frameId, params.loaderId, params.state, sessionId]);
    });
    return { ...opened, trees, heard };
  };
  // A frame of the page that runs in the page's process.
  const localFrame = (
    cdp: FakeDebugger,
    frameId: string,
    loaderId: string,
    parentId = "main",
  ) => {
    cdp.event("Page.frameAttached", { frameId, parentFrameId: parentId });
    frameNavigated(cdp, {
      frameId,
      parentId,
      loaderId,
      url: `https://example.com/${frameId}`,
    });
  };
  // A frame of another site in a process of its own. Auto-attach gives it a
  // session, which answers with the frame's own tree.
  const remoteFrame = async (
    cdp: FakeDebugger,
    trees: Record<string, Parameters<typeof frameTree>[0]>,
    frameId: string,
    loaderId: string,
  ) => {
    const sessionId = `${frameId}-session`;
    const url = `https://${frameId}.example/`;
    trees[sessionId] = [{ id: frameId, parentId: "main", url, loaderId }];
    cdp.event("Page.frameAttached", { frameId, parentFrameId: "main" });
    attachedTarget(cdp, { sessionId, targetId: frameId, url });
    await settle();
    return sessionId;
  };

  it("follows lifecycle per frame and loader from Page.lifecycleEvent and frameNavigated, counting a back-forward cache restore as load", async () => {
    const { session, cdp, trees, heard } = await tracked();
    const main = async () => (await session.frames(step()))[0];
    // No event has described the document the session attached to.
    expect(await main()).toMatchObject({
      frameId: "main",
      loaderId: "loader-1",
      lifecycle: "unknown",
    });
    lifecycleEvent(cdp, { frameId: "main", loaderId: "loader-2", name: "init" });
    frameNavigated(cdp, {
      frameId: "main",
      loaderId: "loader-2",
      url: "https://example.com/next",
    });
    expect(await main()).toMatchObject({
      loaderId: "loader-2",
      lifecycle: "commit",
    });
    // Other names are ignored, and a document's state never moves back.
    for (const name of [
      "DOMContentLoaded",
      "firstPaint",
      "networkAlmostIdle",
      "load",
      "init",
      "DOMContentLoaded",
    ])
      lifecycleEvent(cdp, { frameId: "main", loaderId: "loader-2", name });
    expect(await main()).toMatchObject({ lifecycle: "load" });
    frameNavigated(cdp, {
      frameId: "main",
      loaderId: "loader-0",
      url: "https://example.com/",
      type: "BackForwardCacheRestore",
    });
    expect(await main()).toMatchObject({
      loaderId: "loader-0",
      lifecycle: "load",
    });
    // Each frame and each of its documents is followed on its own.
    lifecycleEvent(cdp, {
      frameId: "main",
      loaderId: "loader-2",
      name: "DOMContentLoaded",
    });
    lifecycleEvent(cdp, {
      frameId: "main",
      loaderId: "loader-1",
      name: "DOMContentLoaded",
    });
    lifecycleEvent(cdp, { frameId: "child", loaderId: "child-1", name: "init" });
    // Turning lifecycle events on in a frame's own session replays its
    // document, naming its commit "commit".
    const remote = await remoteFrame(cdp, trees, "remote", "remote-1");
    for (const name of ["commit", "DOMContentLoaded"])
      lifecycleEvent(cdp, {
        frameId: "remote",
        loaderId: "remote-1",
        name,
        sessionId: remote,
      });
    // A session the tab did not set up never counts.
    lifecycleEvent(cdp, {
      frameId: "main",
      loaderId: "loader-0",
      name: "load",
      sessionId: "agent-session",
    });
    expect(heard).toEqual([
      ["main", "loader-2", "commit", undefined],
      ["main", "loader-2", "domcontentloaded", undefined],
      ["main", "loader-2", "load", undefined],
      ["main", "loader-0", "load", undefined],
      ["main", "loader-1", "domcontentloaded", undefined],
      ["child", "child-1", "commit", undefined],
      ["remote", "remote-1", "commit", remote],
      ["remote", "remote-1", "domcontentloaded", remote],
    ]);
    // A frame keeps its last two documents only, so an event for an older
    // one starts it over.
    lifecycleEvent(cdp, { frameId: "main", loaderId: "loader-2", name: "load" });
    expect(heard.at(-1)).toEqual(["main", "loader-2", "load", undefined]);
  });

  it("settles an unknown lifecycle with one ready probe", async () => {
    const { session, cdp, heard } = await tracked();
    let readyState = "interactive";
    cdp.reply("Runtime.evaluate", () => ({
      result: { type: "object", value: { ok: true, readyState } },
    }));
    const probes = () =>
      cdp.sent
        .filter((command) => command.method === "Runtime.evaluate")
        .map((command) => command.params.expression);
    const loaded = track(session.waitForLifecycle("load", step()));
    const parsed = track(session.waitForLifecycle("domcontentloaded", step()));
    await settle();
    expect(probes()).toEqual([operationExpression("ready", {}, "internal")]);
    expect(parsed).toEqual({ settled: true, value: undefined });
    expect(loaded.settled).toBe(false);
    // Lifecycle events take it from there, with no second probe.
    lifecycleEvent(cdp, { frameId: "main", loaderId: "loader-1", name: "load" });
    await settle();
    expect(loaded).toEqual({ settled: true, value: undefined });
    await session.waitForLifecycle("load", step());
    expect(probes()).toHaveLength(1);
    expect((await session.frames(step()))[0].lifecycle).toBe("load");
    expect(heard).toEqual([
      ["main", "loader-1", "domcontentloaded", undefined],
      ["main", "loader-1", "load", undefined],
    ]);
    // A lost debugger forgets what it knew, so the document is read again.
    readyState = "complete";
    cdp.lose();
    await settle();
    expect(session.state).toBe("ready");
    await session.waitForLifecycle("load", step());
    expect(probes()).toHaveLength(2);
    // A frame that has not committed a document yet is never probed.
    cdp.event("Page.frameAttached", { frameId: "child", parentFrameId: "main" });
    const child = track(
      session.waitForLifecycle("load", { ...step(), frameId: "child" }),
    );
    await settle();
    lifecycleEvent(cdp, { frameId: "child", loaderId: "child-1", name: "init" });
    frameNavigated(cdp, {
      frameId: "child",
      parentId: "main",
      loaderId: "child-1",
      url: "https://example.com/child",
    });
    lifecycleEvent(cdp, { frameId: "child", loaderId: "child-1", name: "load" });
    await settle();
    expect(child).toEqual({ settled: true, value: undefined });
    expect(probes()).toHaveLength(2);
  });

  it("waitForLifecycle resolves at the state and rejects with page_timeout awaited load at the deadline, FrameGoneError when the frame is removed and tab_closed when the tab closes", async () => {
    const { session, cdp } = await tracked();
    lifecycleEvent(cdp, { frameId: "main", loaderId: "loader-1", name: "init" });
    const parsed = track(session.waitForLifecycle("domcontentloaded", step()));
    await settle();
    expect(parsed.settled).toBe(false);
    lifecycleEvent(cdp, {
      frameId: "main",
      loaderId: "loader-1",
      name: "DOMContentLoaded",
    });
    await settle();
    expect(parsed).toEqual({ settled: true, value: undefined });
    // With a loaderId it waits for that document, before it commits too,
    // and fails if the frame commits another first.
    const next = track(
      session.waitForLifecycle("load", { ...step(), loaderId: "loader-2" }),
    );
    await settle();
    lifecycleEvent(cdp, { frameId: "main", loaderId: "loader-2", name: "init" });
    frameNavigated(cdp, {
      frameId: "main",
      loaderId: "loader-2",
      url: "https://example.com/next",
    });
    await settle();
    expect(next.settled).toBe(false);
    lifecycleEvent(cdp, { frameId: "main", loaderId: "loader-2", name: "load" });
    await settle();
    expect(next).toEqual({ settled: true, value: undefined });
    const replaced = track(
      session.waitForLifecycle("load", { ...step(), loaderId: "loader-3" }),
    );
    await settle();
    lifecycleEvent(cdp, { frameId: "main", loaderId: "loader-4", name: "init" });
    await settle();
    expect(replaced.error).toBeInstanceOf(ContextLostError);
    expect(replaced.error).toMatchObject({ started: false });
    frameNavigated(cdp, {
      frameId: "main",
      loaderId: "loader-4",
      url: "https://example.com/last",
    });
    const late = track(session.waitForLifecycle("load", step(3000)));
    await vi.advanceTimersByTimeAsync(2999);
    expect(late.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(late.error).toBeInstanceOf(CdpTimeoutError);
    expect(toApiError(late.error)).toMatchObject({
      status: 504,
      code: "page_timeout",
      fields: { awaited: "load" },
    });
    localFrame(cdp, "child", "child-1");
    const child = track(
      session.waitForLifecycle("load", { ...step(), frameId: "child" }),
    );
    await settle();
    cdp.event("Page.frameDetached", { frameId: "child", reason: "remove" });
    await settle();
    expect(child.error).toBeInstanceOf(FrameGoneError);
    expect(child.error).toMatchObject({ frameId: "child" });
    await expect(
      session.waitForLifecycle("load", { ...step(), frameId: "gone" }),
    ).rejects.toBeInstanceOf(FrameGoneError);
    // Every wake runs the guard first, and the step's signal ends the wait.
    const takeover = new Error("The person is using this space.");
    let owner = "agent";
    const guarded = track(
      session.waitForLifecycle("load", {
        ...step(),
        guard: () => {
          if (owner !== "agent") throw takeover;
        },
      }),
    );
    const controller = new AbortController();
    const aborted = track(
      session.waitForLifecycle("load", {
        ...step(),
        signal: controller.signal,
      }),
    );
    await settle();
    owner = "human";
    lifecycleEvent(cdp, {
      frameId: "main",
      loaderId: "loader-4",
      name: "DOMContentLoaded",
    });
    controller.abort(new Error("The client went away."));
    await settle();
    expect(guarded.error).toBe(takeover);
    expect(aborted.error).toMatchObject({ message: "The client went away." });
    // Release ends a wait as a lost session.
    const releasing = track(session.waitForLifecycle("load", step()));
    await settle();
    expect(releasing.settled).toBe(false);
    await session.release();
    expect(releasing.error).toBeInstanceOf(SessionLostError);
    expect(releasing.error).toMatchObject({ reason: "unavailable" });
    const other = await tracked();
    const closing = track(other.session.waitForLifecycle("load", step()));
    await settle();
    other.host.destroy();
    await settle();
    expect(closing.error).toBeInstanceOf(TabClosedError);
    expect(toApiError(closing.error)).toMatchObject({
      status: 409,
      code: "tab_closed",
    });
  });

  it("tracks requests by requestId across sessions until loadingFinished or loadingFailed on any session", async () => {
    const { session, cdp, trees } = await tracked();
    const remote = await remoteFrame(cdp, trees, "remote", "remote-1");
    const start = Date.now();
    expect(session.network.inFlight()).toBe(0);
    expect(session.network.lastActivityAt()).toBe(0);
    requestWillBeSent(cdp, {
      requestId: "page.1",
      frameId: "main",
      loaderId: "loader-1",
      url: "https://example.com/app.js",
    });
    expect(session.network.inFlight()).toBe(1);
    expect(session.network.lastActivityAt()).toBe(start);
    // A redirect keeps its request.
    await vi.advanceTimersByTimeAsync(100);
    requestWillBeSent(cdp, {
      requestId: "page.1",
      frameId: "main",
      loaderId: "loader-1",
      url: "https://cdn.example.com/app.js",
      redirect: true,
    });
    requestWillBeSent(cdp, {
      requestId: "remote.1",
      frameId: "remote",
      loaderId: "remote-1",
      url: "https://remote.example/data.json",
      sessionId: remote,
    });
    expect(session.network.inFlight()).toBe(2);
    expect(session.network.lastActivityAt()).toBe(start + 100);
    await vi.advanceTimersByTimeAsync(100);
    loadingEnded(cdp, "page.1");
    loadingEnded(cdp, "remote.1", { failed: true, sessionId: remote });
    expect(session.network.inFlight()).toBe(0);
    expect(session.network.lastActivityAt()).toBe(start + 200);
    // A frame's document request starts on its parent's session and ends on
    // the frame's own.
    requestWillBeSent(cdp, {
      requestId: "remote-2",
      frameId: "remote",
      loaderId: "remote-2",
      url: "https://remote.example/next",
    });
    expect(session.network.inFlight()).toBe(1);
    loadingEnded(cdp, "remote-2", { sessionId: remote });
    expect(session.network.inFlight()).toBe(0);
    // Its session can miss that end; the parsed document ends it then.
    requestWillBeSent(cdp, {
      requestId: "remote-3",
      frameId: "remote",
      loaderId: "remote-3",
      url: "https://remote.example/last",
    });
    lifecycleEvent(cdp, {
      frameId: "remote",
      loaderId: "remote-3",
      name: "DOMContentLoaded",
      sessionId: remote,
    });
    expect(session.network.inFlight()).toBe(0);
    // An end Kamapathy never saw start changes nothing.
    await vi.advanceTimersByTimeAsync(100);
    const last = session.network.lastActivityAt();
    loadingEnded(cdp, "before-attach");
    expect(session.network.lastActivityAt()).toBe(last);
  });

  it("ignores /favicon.ico requests and agent sessions", async () => {
    const { session, cdp } = await tracked();
    const sent = (
      requestId: string,
      url: string,
      options: { loaderId?: string; sessionId?: string } = {},
    ) =>
      requestWillBeSent(cdp, {
        requestId,
        frameId: "main",
        loaderId: "loader-1",
        url,
        ...options,
      });
    sent("icon.1", "https://example.com/favicon.ico");
    sent("icon.2", "https://example.com/static/favicon.ico?v=2");
    // A session the tab did not set up, as an agent's own will be.
    sent("agent.1", "https://example.com/data.json", {
      sessionId: "agent-session",
    });
    // A worker's requests carry no loaderId and end only on its own target.
    sent("worker.1", "https://example.com/worker.js", { loaderId: "" });
    expect(session.network.inFlight()).toBe(0);
    expect(session.network.lastActivityAt()).toBe(0);
    // Only the path decides.
    sent("page.1", "https://example.com/favicon.ico.json");
    sent("page.2", "https://example.com/search?q=/favicon.ico");
    expect(session.network.inFlight()).toBe(2);
  });

  it("drops requests of removed frames, of frames that committed another loader and of ended sessions", async () => {
    const { session, cdp, trees } = await tracked();
    const inFlight = () => session.network.inFlight();
    const sent = (
      requestId: string,
      frameId: string,
      loaderId: string,
      sessionId?: string,
    ) =>
      requestWillBeSent(cdp, {
        requestId,
        frameId,
        loaderId,
        url: `https://example.com/${requestId}`,
        sessionId,
      });
    // Chromium removes a frame's frames before the frame itself.
    localFrame(cdp, "outer", "outer-1");
    localFrame(cdp, "inner", "inner-1", "outer");
    sent("outer.1", "outer", "outer-1");
    sent("inner.1", "inner", "inner-1");
    expect(inFlight()).toBe(2);
    cdp.event("Page.frameDetached", { frameId: "inner", reason: "remove" });
    cdp.event("Page.frameDetached", { frameId: "outer", reason: "remove" });
    expect(inFlight()).toBe(0);
    // A frame moving to its own process keeps its document request, which
    // ends on the frame's new session.
    localFrame(cdp, "moving", "moving-1");
    sent("moving-2", "moving", "moving-2");
    cdp.event("Page.frameDetached", { frameId: "moving", reason: "swap" });
    expect(inFlight()).toBe(1);
    loadingEnded(cdp, "moving-2");
    // A frame that commits another document drops its earlier documents'
    // requests, whether init or Page.frameNavigated says so first.
    localFrame(cdp, "child", "child-1");
    sent("child.1", "child", "child-1");
    sent("child-2", "child", "child-2");
    lifecycleEvent(cdp, { frameId: "child", loaderId: "child-2", name: "init" });
    expect(inFlight()).toBe(1);
    sent("child.2", "child", "child-2");
    frameNavigated(cdp, {
      frameId: "child",
      parentId: "main",
      loaderId: "child-3",
      url: "https://example.com/child-3",
    });
    expect(inFlight()).toBe(0);
    // The main frame's next document takes the last one's frames with it,
    // though Chromium reports no Page.frameDetached for them.
    sent("child.3", "child", "child-3");
    sent("main.1", "main", "loader-1");
    sent("loader-2", "main", "loader-2");
    lifecycleEvent(cdp, { frameId: "main", loaderId: "loader-2", name: "init" });
    frameNavigated(cdp, {
      frameId: "main",
      loaderId: "loader-2",
      url: "https://example.com/next",
    });
    expect(inFlight()).toBe(1);
    // A session that ends takes the requests it reported, those of frames
    // inside its own included, and its frame's document request, which
    // began on the page's session.
    const remote = await remoteFrame(cdp, trees, "remote", "remote-1");
    sent("remote-1", "remote", "remote-1");
    sent("remote.1", "remote", "remote-1", remote);
    sent("nested.1", "nested", "nested-1", remote);
    expect(inFlight()).toBe(4);
    cdp.event("Target.detachedFromTarget", {
      sessionId: remote,
      targetId: "remote",
    });
    expect(inFlight()).toBe(1);
    // A lost debugger forgets every request.
    cdp.lose();
    expect(inFlight()).toBe(0);
  });

  it("waitForIdle resolves once nothing has been in flight for idleMs since the last start or finish", async () => {
    const { session, cdp } = await tracked();
    const sent = (requestId: string) =>
      requestWillBeSent(cdp, {
        requestId,
        frameId: "main",
        loaderId: "loader-1",
        url: `https://example.com/${requestId}`,
      });
    // A tab with nothing in flight since attach is idle at once.
    await expect(
      session.network.waitForIdle(500, step()),
    ).resolves.toBeUndefined();
    sent("a");
    const idle = track(session.network.waitForIdle(500, step()));
    await vi.advanceTimersByTimeAsync(1000);
    expect(idle.settled).toBe(false);
    loadingEnded(cdp, "a");
    await vi.advanceTimersByTimeAsync(400);
    // A request that starts and ends meanwhile starts the quiet time again.
    sent("b");
    loadingEnded(cdp, "b");
    await vi.advanceTimersByTimeAsync(499);
    expect(idle.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(idle).toEqual({ settled: true, value: undefined });
    sent("c");
    const busy = track(session.network.waitForIdle(500, step(2000)));
    await vi.advanceTimersByTimeAsync(1999);
    expect(busy.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(busy.error).toBeInstanceOf(CdpTimeoutError);
    expect(toApiError(busy.error)).toMatchObject({
      status: 504,
      code: "page_timeout",
      fields: { awaited: "load" },
    });
    // Every wake runs the guard first, and the step's signal ends the wait.
    const takeover = new Error("The person is using this space.");
    let owner = "agent";
    const guarded = track(
      session.network.waitForIdle(500, {
        ...step(),
        guard: () => {
          if (owner !== "agent") throw takeover;
        },
      }),
    );
    const controller = new AbortController();
    const aborted = track(
      session.network.waitForIdle(500, {
        ...step(),
        signal: controller.signal,
      }),
    );
    owner = "human";
    loadingEnded(cdp, "c");
    controller.abort(new Error("The client went away."));
    await settle();
    expect(guarded.error).toBe(takeover);
    expect(aborted.error).toMatchObject({ message: "The client went away." });
    // Release ends a wait as a lost session, and a closed tab as tab_closed.
    sent("d");
    const releasing = track(session.network.waitForIdle(500, step()));
    await settle();
    expect(releasing.settled).toBe(false);
    await session.release();
    expect(releasing.error).toBeInstanceOf(SessionLostError);
    expect(releasing.error).toMatchObject({ reason: "unavailable" });
    const other = await tracked();
    requestWillBeSent(other.cdp, {
      requestId: "e",
      frameId: "main",
      loaderId: "loader-1",
      url: "https://example.com/e",
    });
    const closing = track(other.session.network.waitForIdle(500, step()));
    other.host.destroy();
    await settle();
    expect(closing.error).toBeInstanceOf(TabClosedError);
    expect(toApiError(closing.error)).toMatchObject({
      status: 409,
      code: "tab_closed",
    });
  });
});
describe("event buffer", () => {
  // An event whose params are exactly bytes long as JSON. Events of one size
  // share one string.
  const fillers = new Map<number, string>();
  const sized = (at: number, bytes: number): CdpEvent => {
    if (!fillers.has(bytes)) fillers.set(bytes, "x".repeat(bytes - 11));
    return {
      method: "Network.dataReceived",
      params: { data: fillers.get(bytes) },
      at,
    };
  };
  const recording = (pool: EventBufferPool, tabId: string) => {
    const buffer = pool.create(tabId);
    buffer.setRecording(true);
    return buffer;
  };

  it("caps each tab at 10,000 events and 4 MiB and all tabs at 64 MiB, trimming the largest log's oldest events first", () => {
    expect(EVENT_LIMITS).toEqual({
      events: 10000,
      tabBytes: 4 * 1024 * 1024,
      totalBytes: 64 * 1024 * 1024,
      eventBytes: 1024 * 1024,
    });
    const pool = new EventBufferPool();
    const many = recording(pool, "many");
    for (let at = 1; at <= 10005; at += 1)
      many.record({ method: "Page.lifecycleEvent", params: {}, at });
    const counted = many.drain(20000);
    expect(counted.events).toHaveLength(10000);
    expect(counted.events[0].at).toBe(6);
    expect(counted.dropped).toBe(5);
    many.dispose();
    expect(pool.totalBytes).toBe(0);
    // Five events of a million bytes pass the tab's 4 MiB.
    const largest = recording(pool, "largest");
    for (let at = 1; at <= 5; at += 1) largest.record(sized(at, 1000000));
    expect(pool.totalBytes).toBe(4000000);
    // Fifteen more tabs bring the pool to 63.4 million bytes.
    const others = Array.from({ length: 15 }, (_, index) =>
      recording(pool, `tab-${index}`),
    );
    for (const buffer of others)
      for (let at = 1; at <= 4; at += 1) buffer.record(sized(at, 990000));
    expect(pool.totalBytes).toBe(63400000);
    const newest = recording(pool, "newest");
    for (let at = 1; at <= 3; at += 1) newest.record(sized(at, 990000));
    expect(pool.totalBytes).toBe(66370000);
    // The next event passes 64 MiB, and the largest log loses its oldest.
    newest.record(sized(4, 990000));
    expect(pool.totalBytes).toBe(66360000);
    const trimmed = largest.drain(10);
    expect(trimmed.events.map((event) => event.at)).toEqual([3, 4, 5]);
    expect(trimmed.dropped).toBe(2);
    for (const buffer of [...others, newest])
      expect(buffer.drain(10)).toMatchObject({ dropped: 0, remaining: 0 });
  });

  it("redacts before sizing and drops events the redactor returns null for", () => {
    const pool = new EventBufferPool();
    const buffer = recording(pool, "tab-1");
    const seen: string[] = [];
    buffer.setRedactor((event) => {
      seen.push(event.method);
      if (event.method === "Network.requestWillBeSentExtraInfo") return null;
      return { ...event, params: { url: event.params.url } };
    });
    buffer.record({
      method: "Network.requestWillBeSent",
      params: {
        url: "https://example.com/",
        postData: "x".repeat(2 * 1024 * 1024),
      },
      at: 1,
    });
    buffer.record({
      method: "Network.requestWillBeSentExtraInfo",
      params: { headers: { cookie: "secret" } },
      at: 2,
    });
    expect(seen).toEqual([
      "Network.requestWillBeSent",
      "Network.requestWillBeSentExtraInfo",
    ]);
    // Sized after redaction, the 2 MiB body is gone, so the event is whole.
    expect(pool.totalBytes).toBe(
      Buffer.byteLength(JSON.stringify({ url: "https://example.com/" })),
    );
    expect(buffer.drain(10)).toEqual({
      events: [
        {
          method: "Network.requestWillBeSent",
          params: { url: "https://example.com/" },
          at: 1,
        },
      ],
      dropped: 0,
      gaps: [],
      remaining: 0,
    });
  });

  it("keeps an event over 1 MiB as a too_large stub", () => {
    const pool = new EventBufferPool();
    const buffer = recording(pool, "tab-1");
    const MiB = 1024 * 1024;
    buffer.record(sized(1, MiB));
    buffer.record({ ...sized(2, MiB + 1), sessionId: "child-1" });
    expect(pool.totalBytes).toBe(MiB);
    expect(buffer.drain(10).events).toEqual([
      sized(1, MiB),
      {
        method: "Network.dataReceived",
        at: 2,
        sessionId: "child-1",
        omitted: "too_large",
        bytes: MiB + 1,
      },
    ]);
  });
});
describe("dialogs, init scripts, agent sessions and events", () => {
  // The page holds an in-process frame and the PDF viewer's extension frame.
  // Session child-1 hosts the out-of-process frame frame-oop, and child-2
  // the frame-deep inside it.
  const TREES: Record<string, object> = {
    "": frameTree([
      { id: "main", url: "https://example.com/", loaderId: "loader-1" },
      { id: "frame-in", parentId: "main", url: "https://example.com/inner" },
      {
        id: "frame-ext",
        parentId: "main",
        url: `chrome-extension://${PDF_VIEWER_ID}/index.html`,
        origin: `chrome-extension://${PDF_VIEWER_ID}`,
      },
    ]),
    "child-1": frameTree([
      { id: "frame-oop", parentId: "main", url: "https://frame.example/" },
    ]),
    "child-2": frameTree([
      { id: "frame-deep", parentId: "frame-oop", url: "https://deep.example/" },
    ]),
  };
  // A ready session on that page, with child-1 attached.
  async function framed() {
    const opened = open();
    opened.cdp.reply(
      "Page.getFrameTree",
      (_params, sessionId) => TREES[sessionId ?? ""],
    );
    opened.session.attach();
    await settle();
    attachedTarget(opened.cdp, {
      sessionId: "child-1",
      targetId: "frame-oop",
      url: "https://frame.example/",
    });
    await settle();
    expect(opened.session.state).toBe("ready");
    return opened;
  }
  it("knownFrames lists the registry's frames with crossOrigin, blocked and unavailable, main frame first", async () => {
    const { session, cdp } = await framed();
    expect(await session.knownFrames(soon())).toEqual([
      {
        frameId: "main",
        origin: "https://example.com",
        crossOrigin: false,
        blocked: false,
        unavailable: false,
      },
      {
        frameId: "frame-in",
        parentFrameId: "main",
        origin: "https://example.com",
        crossOrigin: false,
        blocked: false,
        unavailable: false,
      },
      {
        frameId: "frame-ext",
        parentFrameId: "main",
        origin: `chrome-extension://${PDF_VIEWER_ID}`,
        crossOrigin: true,
        blocked: true,
        unavailable: false,
      },
      {
        frameId: "frame-oop",
        parentFrameId: "main",
        origin: "https://frame.example",
        sessionId: "child-1",
        crossOrigin: true,
        blocked: false,
        unavailable: false,
      },
    ]);
    // A frame whose session ended has no session and is unavailable.
    cdp.event("Target.detachedFromTarget", {
      sessionId: "child-1",
      targetId: "frame-oop",
    });
    await settle();
    expect((await session.knownFrames(soon())).at(-1)).toEqual({
      frameId: "frame-oop",
      parentFrameId: "main",
      origin: "https://frame.example",
      crossOrigin: true,
      blocked: false,
      unavailable: true,
    });
  });

  const opening = (
    type: string,
    message: string,
    frameId = "main",
    defaultPrompt = "",
  ) => ({
    url: "https://example.com/",
    frameId,
    message,
    type,
    hasBrowserHandler: true,
    defaultPrompt,
  });

  it("refuses Input, Runtime, DOM, Accessibility, Page.navigate, Page.reload, Page.captureScreenshot and Page.getLayoutMetrics with started false while a dialog is open, rejects in-flight ones with started true, and always allows handleDialog on the reporting session", async () => {
    const { session, cdp } = await framed();
    cdp.holdReplies = true;
    // An alert opened by a click handler holds that click's reply.
    const click = track(
      session.send(
        "Input.dispatchMouseEvent",
        { type: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 },
        soon(),
      ),
    );
    const read = track(
      session.send("Runtime.evaluate", { expression: "1" }, soon("child-1")),
    );
    const roles = track(session.send("Accessibility.getFullAXTree", {}, soon()));
    const shot = track(session.send("Page.captureScreenshot", {}, soon()));
    const tree = track(session.send("Page.getFrameTree", {}, soon()));
    cdp.event(
      "Page.javascriptDialogOpening",
      opening("confirm", "Leave this page?", "frame-oop"),
      "child-1",
    );
    await settle();
    const dialog = {
      type: "confirm",
      message: "Leave this page?",
      frameId: "frame-oop",
      sessionId: "child-1",
    };
    expect(session.dialog()).toEqual(dialog);
    for (const inFlight of [click, read, roles, shot]) {
      expect(inFlight.error).toBeInstanceOf(DialogOpenError);
      expect(inFlight.error).toMatchObject({ dialog, started: true });
    }
    expect(tree.settled).toBe(false);
    cdp.holdReplies = false;
    cdp.flush();
    await settle();
    expect(tree.settled).toBe(true);
    const sent = cdp.sent.length;
    for (const [method, sessionId] of [
      ["Input.dispatchKeyEvent", undefined],
      ["Input.insertText", undefined],
      ["Runtime.evaluate", "child-1"],
      ["Runtime.callFunctionOn", undefined],
      ["DOM.setFileInputFiles", undefined],
      ["DOM.resolveNode", undefined],
      ["DOM.getFrameOwner", undefined],
      ["Accessibility.getFullAXTree", "child-1"],
      ["Accessibility.enable", undefined],
      ["Accessibility.disable", undefined],
      ["Page.navigate", undefined],
      ["Page.reload", undefined],
      ["Page.captureScreenshot", undefined],
      ["Page.getLayoutMetrics", undefined],
    ] as const) {
      const dispatch = { dispatched: false };
      const refused = session.send(method, {}, { ...soon(sessionId), dispatch });
      await expect(refused, method).rejects.toBeInstanceOf(DialogOpenError);
      await expect(refused, method).rejects.toMatchObject({
        dialog,
        started: false,
      });
      expect(dispatch.dispatched, method).toBe(false);
    }
    await expect(
      session.evaluateInFrame(
        "main",
        "snapshot",
        {},
        { deadline: Date.now() + 5000, namespace: "test" },
      ),
    ).rejects.toMatchObject({ dialog, started: false });
    expect(cdp.sent).toHaveLength(sent);
    // Commands the dialog does not hold still go through.
    await expect(
      session.send("Page.getNavigationHistory", {}, soon()),
    ).resolves.toEqual({});
    await session.handleDialog(false);
    expect(cdp.sent.at(-1)).toEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: false },
      sessionId: "child-1",
    });
    cdp.event(
      "Page.javascriptDialogClosed",
      { result: false, userInput: "" },
      "child-1",
    );
    expect(session.dialog()).toBeUndefined();
    await expect(
      session.send("Runtime.evaluate", {}, soon()),
    ).resolves.toEqual({});
    // A prompt reported on the page session is answered there, with its text.
    cdp.event(
      "Page.javascriptDialogOpening",
      opening("prompt", "Your name?", "main", "Ada"),
    );
    await session.handleDialog(true, "Grace");
    expect(cdp.sent.at(-1)).toEqual({
      method: "Page.handleJavaScriptDialog",
      params: { accept: true, promptText: "Grace" },
    });
  });

  it("strips bidirectional overrides and control characters from dialog text and cuts it to 2000 characters", async () => {
    const { session, cdp } = await framed();
    const unsafe =
      "\u0000\u0007\u000B\r\u001F\u007F\u0085\u009F\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}";
    cdp.event(
      "Page.javascriptDialogOpening",
      opening(
        "prompt",
        `Pay${unsafe} now\tor\nlater ${"a".repeat(2500)}`,
        "main",
        `\u{202E}Amount${unsafe}${"9".repeat(2500)}`,
      ),
    );
    const dialog = session.dialog()!;
    expect(dialog.message).toBe(
      `Pay now\tor\nlater ${"a".repeat(2500)}`.slice(0, 2000),
    );
    expect(dialog.message).toHaveLength(2000);
    expect(dialog.defaultValue).toBe(`Amount${"9".repeat(1994)}`);
    const refused = session.send("Runtime.evaluate", {}, soon());
    await expect(refused).rejects.toMatchObject({ dialog });
    // Only a prompt carries a default value.
    cdp.event("Page.javascriptDialogClosed", { result: true, userInput: "" });
    cdp.event(
      "Page.javascriptDialogOpening",
      opening("alert", "Saved\u{202E}", "main", "ignored"),
    );
    expect(session.dialog()).toEqual({
      type: "alert",
      message: "Saved",
      frameId: "main",
    });
  });

  it("clears the dialog when it closes and ignores dialogs on agent sessions", async () => {
    const { session, cdp, host } = await framed();
    const changes: unknown[] = [];
    session.on("dialog", (event) => {
      changes.push(event.params);
    });
    const saved = { type: "alert", message: "Saved", frameId: "main" };
    cdp.event("Page.javascriptDialogOpening", opening("alert", "Saved"));
    expect(session.dialog()).toEqual(saved);
    cdp.event("Page.javascriptDialogClosed", { result: true, userInput: "" });
    expect(session.dialog()).toBeUndefined();
    const agent = await session.openAgentSession();
    cdp.event("Page.javascriptDialogOpening", opening("alert", "Saved"), agent);
    expect(session.dialog()).toBeUndefined();
    // A crash and a lost debugger each forget the dialog.
    cdp.event(
      "Page.javascriptDialogOpening",
      opening("alert", "Saved"),
      "child-1",
    );
    host.crash();
    expect(session.dialog()).toBeUndefined();
    host.navigate("https://example.com/");
    await settle();
    expect(session.state).toBe("ready");
    cdp.event("Page.javascriptDialogOpening", opening("alert", "Saved"));
    cdp.lose();
    expect(session.dialog()).toBeUndefined();
    expect(changes).toEqual([
      { dialog: saved },
      { dialog: null },
      { dialog: { ...saved, sessionId: "child-1" } },
      { dialog: null },
      { dialog: saved },
      { dialog: null },
    ]);
    await settle();
  });

  it("adds init scripts with runImmediately on the page session and every web child before resume, on later children and after re-attach, and never on blocked frames", async () => {
    const { session, cdp } = await framed();
    session.onSessionSetup(focusHook(session));
    const sent = cdp.sent.length;
    const isolated = await session.addInitScript("window.__isolated = 1;", {
      world: "isolated",
    });
    const main = await session.addInitScript("window.__main = 1;", {
      world: "main",
    });
    expect(isolated).not.toBe(main);
    const add = (text: string, worldName?: string) => ({
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: {
        source: expect.stringContaining(text),
        runImmediately: true,
        ...(worldName ? { worldName } : {}),
      },
    });
    const ISOLATED = add("window.__isolated = 1;", "kamapathy");
    const MAIN = add("window.__main = 1;");
    expect(cdp.sent.slice(sent)).toEqual([
      ISOLATED,
      { ...ISOLATED, sessionId: "child-1" },
      MAIN,
      { ...MAIN, sessionId: "child-1" },
    ]);
    // A later frame gets them after its hooks and before it resumes.
    attachedTarget(cdp, {
      parentSessionId: "child-1",
      sessionId: "child-2",
      targetId: "frame-deep",
      url: "https://deep.example/",
      waitingForDebugger: true,
    });
    expect(
      cdp.sent.filter((command) => command.sessionId === "child-2"),
    ).toEqual(
      [
        ...SETUP,
        FOCUS,
        ISOLATED,
        MAIN,
        { method: "Runtime.runIfWaitingForDebugger", params: {} },
        FRAME_TREE,
      ].map((command) => ({ ...command, sessionId: "child-2" })),
    );
    // A blocked frame's target gets none.
    attachedTarget(cdp, {
      parentSessionId: "child-1",
      sessionId: "blocked-1",
      targetId: "frame-pdf",
      url: `chrome-extension://${PDF_VIEWER_ID}/index.html`,
    });
    await settle();
    expect(cdp.methods("blocked-1")).not.toContain(
      "Page.addScriptToEvaluateOnNewDocument",
    );
    // A re-attach registers them again, after the hooks.
    const before = cdp.sent.length;
    cdp.lose();
    await settle();
    expect(session.state).toBe("ready");
    expect(cdp.sent.slice(before)).toEqual([
      ...SETUP,
      FOCUS,
      ISOLATED,
      MAIN,
      FRAME_TREE,
    ]);
  });

  it("wraps init scripts to return at once outside web frames", async () => {
    const { session, cdp } = await framed();
    await session.addInitScript("ran.push(location.href);", { world: "main" });
    // A source may declare the names the wrapper's own check uses.
    await session.addInitScript("const p = 'p', o = 'o'; ran.push(p + o);", {
      world: "main",
    });
    const [source, declaring] = cdp.sent
      .filter(
        (command) =>
          command.method === "Page.addScriptToEvaluateOnNewDocument" &&
          command.sessionId === undefined,
      )
      .map((command) => command.params.source);
    const run = (href: string, origin: string, script = source) => {
      const ran: string[] = [];
      runInNewContext(script, {
        ran,
        location: { href, protocol: new URL(href).protocol, origin },
      });
      return ran;
    };
    for (const [href, origin] of [
      ["https://example.com/", "https://example.com"],
      ["http://127.0.0.1:3000/form", "http://127.0.0.1:3000"],
      ["about:blank", "null"],
      ["about:srcdoc", "https://example.com"],
      ["data:text/html,hello", "null"],
      ["blob:https://example.com/0f3c", "https://example.com"],
    ])
      expect(run(href, origin), href).toEqual([href]);
    expect(
      run("https://example.com/", "https://example.com", declaring),
    ).toEqual(["po"]);
    for (const [href, origin] of [
      [
        `chrome-extension://${PDF_VIEWER_ID}/index.html`,
        `chrome-extension://${PDF_VIEWER_ID}`,
      ],
      ["chrome://settings/", "chrome://settings"],
      ["devtools://devtools/bundled/inspector.html", "devtools://devtools"],
      ["file:///Users/example/page.html", "file://"],
      ["kamapathy://newtab/", "kamapathy://newtab"],
      ["chrome-error://chromewebdata/", "null"],
      [
        `blob:chrome-extension://${PDF_VIEWER_ID}/0f3c`,
        `chrome-extension://${PDF_VIEWER_ID}`,
      ],
    ])
      expect(run(href, origin), href).toEqual([]);
  });

  it("removes an init script from every session", async () => {
    const { session, cdp } = await framed();
    const first = await session.addInitScript("window.__first = 1;", {
      world: "isolated",
    });
    const second = await session.addInitScript("window.__second = 1;", {
      world: "main",
    });
    // The fake numbers identifiers 1 and 2 for the first script, on the page
    // session and child-1, and 3 and 4 for the second.
    const sent = cdp.sent.length;
    await session.removeInitScript(first);
    expect(cdp.sent.slice(sent)).toEqual([
      {
        method: "Page.removeScriptToEvaluateOnNewDocument",
        params: { identifier: "1" },
      },
      {
        method: "Page.removeScriptToEvaluateOnNewDocument",
        params: { identifier: "2" },
        sessionId: "child-1",
      },
    ]);
    await session.removeInitScript(first);
    expect(cdp.sent).toHaveLength(sent + 2);
    // A re-attach registers only the script left, under a new identifier.
    const before = cdp.sent.length;
    cdp.lose();
    await settle();
    expect(
      cdp.sent
        .slice(before)
        .filter(
          (command) =>
            command.method === "Page.addScriptToEvaluateOnNewDocument",
        )
        .map((command) => command.params.source),
    ).toEqual([expect.stringContaining("window.__second = 1;")]);
    const reattached = cdp.sent.length;
    await session.removeInitScript(second);
    expect(cdp.sent.slice(reattached)).toEqual([
      {
        method: "Page.removeScriptToEvaluateOnNewDocument",
        params: { identifier: "5" },
      },
    ]);
  });

  it("opens agent sessions only for the tab's own target or an out-of-process unblocked frame, refusing another target, a blocked frame and an in-process frame before sending anything", async () => {
    const { session, cdp } = await framed();
    const sent = cdp.sent.length;
    for (const [frameId, refusal] of [
      ["another-tab", TargetRefusedError],
      ["frame-in", TargetRefusedError],
      ["frame-ext", FrameBlockedError],
    ] as const)
      await expect(session.openAgentSession(frameId), frameId).rejects.toBeInstanceOf(
        refusal,
      );
    expect(cdp.sent).toHaveLength(sent);
    const own = await session.openAgentSession();
    const frame = await session.openAgentSession("frame-oop");
    expect([own, frame]).toEqual(["agent-1", "agent-2"]);
    expect(cdp.sent.slice(sent)).toEqual([
      { method: "Target.getTargetInfo", params: {} },
      {
        method: "Target.attachToTarget",
        params: { targetId: "main", flatten: true },
      },
      {
        method: "Target.attachToTarget",
        params: { targetId: "frame-oop", flatten: true },
      },
    ]);
    // Agent sessions get no setup, and are not taken for frames to let go.
    expect(cdp.methods("agent-1")).toEqual([]);
    expect(cdp.methods("agent-2")).toEqual([]);
    // The tab's target is read once per attach.
    await session.openAgentSession();
    expect(
      cdp.methods().filter((method) => method === "Target.getTargetInfo"),
    ).toHaveLength(1);
    // Commands on an agent session go through send and count as dispatched.
    const dispatch = { dispatched: false };
    await session.send(
      "Runtime.evaluate",
      { expression: "1" },
      { ...soon(own), dispatch },
    );
    expect(dispatch.dispatched).toBe(true);
    // Without a page target in the reply, the main frame's id names the tab.
    cdp.lose();
    await settle();
    cdp.reply("Target.getTargetInfo", () => {
      throw new Error("Target.getTargetInfo is not available.");
    });
    const fallback = cdp.sent.length;
    await session.openAgentSession();
    expect(cdp.sent.slice(fallback)).toEqual([
      { method: "Target.getTargetInfo", params: {} },
      {
        method: "Target.attachToTarget",
        params: { targetId: "main", flatten: true },
      },
    ]);
  });

  it("detaches only agent sessions it opened, and closes them on release and on debugger loss", async () => {
    const { session, cdp } = await framed();
    const agent = await session.openAgentSession();
    const sent = cdp.sent.length;
    for (const sessionId of ["child-1", "another-tab"])
      await expect(
        session.closeAgentSession(sessionId),
        sessionId,
      ).rejects.toBeInstanceOf(TargetRefusedError);
    expect(cdp.sent).toHaveLength(sent);
    // Chromium reports the detach on the page session before it answers.
    // The report is the agent's: the tab's own listeners never hear it, and
    // the tab keeps its requests in flight.
    requestWillBeSent(cdp, {
      requestId: "request-1",
      frameId: "main",
      loaderId: "loader-1",
      url: "https://example.com/data",
    });
    const own = vi.fn();
    session.on("Target.detachedFromTarget", own);
    const reported = vi.fn();
    cdp.on("message", reported);
    await session.closeAgentSession(agent);
    expect(cdp.sent.slice(sent)).toEqual([
      { method: "Target.detachFromTarget", params: { sessionId: agent } },
    ]);
    expect(reported).toHaveBeenCalledWith(
      {},
      "Target.detachedFromTarget",
      { sessionId: agent, targetId: "main" },
      "",
    );
    expect(own).not.toHaveBeenCalled();
    expect(session.network.inFlight()).toBe(1);
    await expect(
      session.send("Runtime.evaluate", {}, soon(agent)),
    ).rejects.toBeInstanceOf(TargetRefusedError);
    await expect(session.closeAgentSession(agent)).rejects.toBeInstanceOf(
      TargetRefusedError,
    );
    // A lost debugger takes its agent sessions with it.
    const lost = await session.openAgentSession();
    cdp.lose();
    await settle();
    expect(session.state).toBe("ready");
    await expect(
      session.send("Runtime.evaluate", {}, soon(lost)),
    ).rejects.toBeInstanceOf(TargetRefusedError);
    // Release lets go of the rest before it detaches.
    const kept = await session.openAgentSession();
    let beforeDetach: unknown;
    cdp.once("detach", () => {
      beforeDetach = cdp.sent.at(-1);
    });
    await session.release();
    expect(beforeDetach).toEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: kept },
    });
    expect(
      cdp.sent.filter(
        (command) =>
          command.method === "Target.detachFromTarget" &&
          command.params.sessionId === lost,
      ),
    ).toEqual([]);
    await expect(
      session.send("Runtime.evaluate", {}, soon(kept)),
    ).rejects.toBeInstanceOf(TargetRefusedError);
  });

  it("delivers agent session events to on(agent) and the buffer, never to the registry, trackers or dialog state", async () => {
    const { session, cdp } = await framed();
    const agent = await session.openAgentSession();
    session.events.setRecording(true);
    const heard: CdpEvent[] = [];
    session.on("agent", (event) => {
      heard.push(event);
    });
    const own = vi.fn();
    for (const name of [
      "Page.frameAttached",
      "Page.lifecycleEvent",
      "Network.requestWillBeSent",
      "Page.javascriptDialogOpening",
      "frame",
      "lifecycle",
      "dialog",
    ])
      session.on(name, own);
    const events = [
      [
        "Page.frameAttached",
        { frameId: "agent-frame", parentFrameId: "main" },
      ],
      [
        "Page.lifecycleEvent",
        { frameId: "main", loaderId: "loader-2", name: "init", timestamp: 1 },
      ],
      [
        "Network.requestWillBeSent",
        {
          requestId: "agent-request",
          loaderId: "loader-1",
          documentURL: "https://example.com/",
          request: { url: "https://example.com/data", method: "GET", headers: {} },
          timestamp: 1,
          wallTime: 1,
          initiator: { type: "script" },
          type: "Fetch",
          frameId: "main",
        },
      ],
      ["Page.javascriptDialogOpening", opening("alert", "From the agent")],
    ] as const;
    for (const [method, params] of events) cdp.event(method, params, agent);
    expect(heard).toEqual(
      events.map(([method, params]) => ({
        method,
        params,
        sessionId: agent,
        at: Date.now(),
      })),
    );
    expect(own).not.toHaveBeenCalled();
    expect(session.dialog()).toBeUndefined();
    expect(session.network.inFlight()).toBe(0);
    await expect(
      session.evaluateInFrame(
        "agent-frame",
        "ready",
        {},
        { deadline: Date.now() + 5000, namespace: "internal" },
      ),
    ).rejects.toBeInstanceOf(FrameGoneError);
    expect(session.events.drain(10).events).toEqual(heard);
  });

  it("records nothing until recording is on, then Page and Network events of its own sessions and every agent session event", async () => {
    const { session, cdp } = await framed();
    const agent = await session.openAgentSession();
    const lifecycle = {
      frameId: "main",
      loaderId: "loader-1",
      name: "load",
      timestamp: 1,
    };
    const request = {
      requestId: "request-1",
      loaderId: "loader-oop",
      documentURL: "https://frame.example/",
      request: { url: "https://frame.example/data", method: "GET", headers: {} },
      timestamp: 1,
      wallTime: 1,
      initiator: { type: "script" },
      type: "Fetch",
      frameId: "frame-oop",
    };
    const consoleCall = { type: "log", args: [], executionContextId: 1, timestamp: 1 };
    cdp.event("Page.lifecycleEvent", lifecycle);
    cdp.event("Runtime.consoleAPICalled", consoleCall, agent);
    expect(session.events.recording).toBe(false);
    expect(session.events.drain(10)).toEqual({
      events: [],
      dropped: 0,
      gaps: [],
      remaining: 0,
    });
    session.events.setRecording(true);
    expect(session.events.recording).toBe(true);
    cdp.event("Page.lifecycleEvent", lifecycle);
    cdp.event("Network.requestWillBeSent", request, "child-1");
    cdp.event("Runtime.consoleAPICalled", consoleCall);
    cdp.event("Runtime.consoleAPICalled", consoleCall, agent);
    cdp.event("Page.lifecycleEvent", lifecycle, "another-tab");
    expect(session.events.drain(10)).toEqual({
      events: [
        { method: "Page.lifecycleEvent", params: lifecycle, at: Date.now() },
        {
          method: "Network.requestWillBeSent",
          params: request,
          sessionId: "child-1",
          at: Date.now(),
        },
        {
          method: "Runtime.consoleAPICalled",
          params: consoleCall,
          sessionId: agent,
          at: Date.now(),
        },
      ],
      dropped: 0,
      gaps: [],
      remaining: 0,
    });
  });

  it("reports recording-off and lost-debugger gaps, dropped counts and remaining on drain", async () => {
    // The tab gets its log from TabSessions, which keeps it across sessions.
    const buffers = new EventBufferPool({ ...EVENT_LIMITS, events: 3 });
    const { views, sessions, driven } = attachPolicy(buffers);
    const space = views.addSpace("agent");
    driven.add(space.id);
    const tab = views.addTab(space.id);
    sessions.start();
    const cdp = views.open(tab.id).page.debugger;
    await settle();
    const session = sessions.get(tab.id)!;
    expect(session.state).toBe("ready");
    const mark = (index: number) => {
      const event = {
        method: "Page.lifecycleEvent",
        params: { frameId: "main", loaderId: "loader-1", name: `mark-${index}`, timestamp: index },
        at: Date.now(),
      };
      cdp.event(event.method, event.params);
      return event;
    };
    session.events.setRecording(true);
    const marks = [1, 2, 3, 4, 5].map(mark);
    // The debugger is lost, and back 50 ms later.
    const lost = Date.now();
    cdp.holdReplies = true;
    cdp.lose();
    await vi.advanceTimersByTimeAsync(50);
    cdp.holdReplies = false;
    cdp.flush();
    await settle();
    expect(session.state).toBe("ready");
    const back = Date.now();
    // The person takes the space over for 200 ms, which releases the session.
    session.events.setRecording(false, "human_control");
    driven.delete(space.id);
    views.emit();
    mark(6);
    await vi.advanceTimersByTimeAsync(200);
    expect(session.state).toBe("released");
    // The tab's next session drains what the first one recorded.
    driven.add(space.id);
    views.emit();
    await settle();
    const next = sessions.get(tab.id)!;
    expect(next).not.toBe(session);
    next.events.setRecording(true);
    expect(next.events.drain(2)).toEqual({
      events: [marks[2], marks[3]],
      dropped: 2,
      gaps: [
        { reason: "debugger_detached", from: lost, to: back },
        { reason: "human_control", from: back, to: back + 200 },
      ],
      remaining: 1,
    });
    expect(next.events.drain(10)).toEqual({
      events: [marks[4]],
      dropped: 0,
      gaps: [],
      remaining: 0,
    });
    // The log goes when the tab closes, and the session, still letting go,
    // records nothing more.
    mark(7);
    expect(buffers.totalBytes).toBeGreaterThan(0);
    views.state.tabs = views.state.tabs.filter((item) => item.id !== tab.id);
    views.emit();
    expect(buffers.totalBytes).toBe(0);
    mark(8);
    expect(next.events.drain(10).events).toEqual([]);
  });
});

// Section 5's focus emulation, which the tab's input dispatcher registers.
describe("the input dispatcher's setup hook", () => {
  it("sends focus emulation at attach, on each child before it resumes and again after a re-attach", async () => {
    const { session, cdp } = open();
    const dispatchers = createDispatchers({ guard: () => {} });
    dispatchers.for(session);
    session.attach();
    expect(cdp.sent).toEqual([...SETUP, FOCUS, FRAME_TREE]);
    await settle();
    expect(session.state).toBe("ready");
    const script = await session.addInitScript("window.__probe = 1;", {
      world: "main",
    });
    expect(script).toBeTruthy();
    const SCRIPT = {
      method: "Page.addScriptToEvaluateOnNewDocument",
      params: {
        source: expect.stringContaining("window.__probe = 1;"),
        runImmediately: true,
      },
    };
    // A later frame gets the hook before its init scripts and its resume.
    attachedTarget(cdp, {
      sessionId: "child-1",
      targetId: "frame-oop",
      url: "https://frame.example/",
      waitingForDebugger: true,
    });
    await settle();
    expect(
      cdp.sent.filter((command) => command.sessionId === "child-1"),
    ).toEqual(
      [
        ...SETUP,
        FOCUS,
        SCRIPT,
        { method: "Runtime.runIfWaitingForDebugger", params: {} },
        FRAME_TREE,
      ].map((command) => ({ ...command, sessionId: "child-1" })),
    );
    // A re-attach runs the hook again, in the same place.
    const sent = cdp.sent.length;
    cdp.lose();
    await settle();
    expect(session.state).toBe("ready");
    expect(cdp.sent.slice(sent)).toEqual([...SETUP, FOCUS, SCRIPT, FRAME_TREE]);
    dispatchers.dispose();
  });
});
