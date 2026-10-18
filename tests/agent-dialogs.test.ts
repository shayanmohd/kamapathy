import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDialogs,
  DIALOG_RECORDS,
  MAX_DIALOG_MESSAGE,
  type DialogRecord,
} from "../electron/agent/dialogs";
import {
  MAX_REPORT_BYTES,
  MAX_REPORTS_PER_DOCUMENT,
  dialogHandler,
} from "../electron/agent/dom/dialog-handler";
import { EventBufferPool } from "../electron/agent/session/event-buffer";
import { TabSession } from "../electron/agent/session/tab-session";
import type { SessionHost } from "../electron/agent/session/types";
import { createTabLog } from "../electron/agent/tab-log";
import { FakeController } from "./fake-automation";
import { attachedTarget, FakeHost, type FakeDebugger } from "./fake-cdp";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const settle = () => vi.advanceTimersByTimeAsync(0);
const URL_HERE = "https://example.com/report";

// The dialog handler over a scripted debugger: one agent tab, its session and
// the policy the page's reports answer to.
function setup(options: { queued?: () => string[] } = {}) {
  const controller = new FakeController();
  const space = controller.createAgentSpace("Research");
  const tab = controller.state.tabs.find((item) => item.spaceId === space.id)!;
  const tabLog = createTabLog();
  const host = new FakeHost({
    replies: {
      "Runtime.evaluate": () => ({
        result: { type: "object", value: options.queued?.() ?? [] },
      }),
    },
  });
  const session = new TabSession(host as unknown as SessionHost, {
    tabId: tab.id,
    waitForSpaceIdle: async () => {},
    buffer: new EventBufferPool().create(tab.id),
  });
  const answers: DialogRecord[] = [];
  const dialogs = createDialogs({
    tabLog,
    controller,
    sessions: { get: (id) => (id === tab.id ? session : undefined) },
    onAnswer: (_tabId, record) => answers.push(record),
  });
  const stop = dialogs.attach(session, tab.id);
  session.attach();
  return {
    controller,
    space,
    tab,
    tabLog,
    cdp: host.debugger,
    session,
    dialogs,
    answers,
    stop,
  };
}
const bindingOf = (cdp: FakeDebugger) =>
  cdp.sent.find((command) => command.method === "Runtime.addBinding")!.params
    .name as string;
// Every handler source installed on the page session, oldest first.
const handlers = (cdp: FakeDebugger) =>
  cdp.sent
    .filter(
      (command) =>
        command.method === "Page.addScriptToEvaluateOnNewDocument" &&
        command.sessionId === undefined &&
        String(command.params.source).includes('"mode"'),
    )
    .map((command) => String(command.params.source));
const keyOf = (source: string) => /"key":"([^"]+)"/.exec(source)![1];
// A report as Chromium delivers one through the binding.
const report = (
  cdp: FakeDebugger,
  binding: string,
  payload: unknown,
  sessionId?: string,
) =>
  cdp.event(
    "Runtime.bindingCalled",
    {
      name: binding,
      payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      executionContextId: 1,
    },
    sessionId,
  );
const answered = (
  type: "alert" | "confirm" | "prompt",
  answer: "accepted" | "dismissed" = "accepted",
  extra: Record<string, unknown> = {},
) => ({ type, message: `${type} here`, answer, url: URL_HERE, ...extra });

describe("the dialog handler in agent tabs", () => {
  it("re-adds the script and updates contexts", async () => {
    const { cdp, dialogs, tab } = setup();
    await settle();
    const first = handlers(cdp);
    expect(first).toHaveLength(1);
    expect(first[0]).toContain('"mode":"agent"');
    expect(first[0]).toContain('"policy":null');
    const armed = dialogs.setPolicy(tab.id, {
      accept: true,
      promptText: "Ada",
      times: 2,
      lifetimeMs: 60000,
    });
    expect(armed).toEqual({
      accept: true,
      promptText: "Ada",
      remaining: 2,
      expiresAt: Date.now() + 60000,
    });
    await settle();
    const scripts = cdp.sent
      .filter(
        (command) =>
          command.method.startsWith("Page.") &&
          command.method.includes("ScriptToEvaluateOnNewDocument"),
      )
      .map((command) => command.method);
    // The new handler is added before the old one goes, so no document
    // loads without one.
    expect(scripts.at(-2)).toBe("Page.addScriptToEvaluateOnNewDocument");
    expect(scripts.at(-1)).toBe("Page.removeScriptToEvaluateOnNewDocument");
    const latest = handlers(cdp).at(-1)!;
    expect(latest).toContain('"policy":{"accept":true,"promptText":"Ada"}');
    // The same updater key, run again in documents that already exist, is
    // how the new policy reaches their contexts.
    expect(keyOf(latest)).toBe(keyOf(first[0]));
    expect(
      cdp.sent
        .filter(
          (command) =>
            command.method === "Page.addScriptToEvaluateOnNewDocument",
        )
        .at(-1)!.params.runImmediately,
    ).toBe(true);
    expect(dialogs.policy(tab.id)).toEqual(armed);
  });

  it("reverts after times or lifetime", async () => {
    const { cdp, dialogs, tab, answers } = setup();
    await settle();
    const binding = bindingOf(cdp);
    dialogs.setPolicy(tab.id, {
      accept: true,
      promptText: "Ada",
      times: 2,
      lifetimeMs: 60000,
    });
    await settle();
    // An alert returns at once and keeps the arm.
    report(cdp, binding, answered("alert"));
    expect(dialogs.policy(tab.id)?.remaining).toBe(2);
    // So does a dialog Kamapathy answered itself, such as a leave guard.
    dialogs.record(tab.id, {
      type: "beforeunload",
      message: "",
      answer: "accepted",
      url: URL_HERE,
    });
    expect(dialogs.policy(tab.id)?.remaining).toBe(2);
    // A dismissed confirm never came from an arm.
    report(cdp, binding, answered("confirm", "dismissed"));
    expect(dialogs.policy(tab.id)?.remaining).toBe(2);
    report(cdp, binding, answered("confirm"));
    expect(dialogs.policy(tab.id)?.remaining).toBe(1);
    report(cdp, binding, answered("prompt", "accepted", { promptText: "Ada" }));
    expect(dialogs.policy(tab.id)).toBeNull();
    await settle();
    expect(handlers(cdp).at(-1)).toContain('"policy":null');
    expect(answers.map((record) => record.type)).toEqual([
      "alert",
      "beforeunload",
      "confirm",
      "confirm",
      "prompt",
    ]);

    // A lifetime that runs out reverts the handler the same way.
    const installs = handlers(cdp).length;
    dialogs.setPolicy(tab.id, { accept: true, times: 5, lifetimeMs: 1000 });
    await settle();
    expect(dialogs.policy(tab.id)?.remaining).toBe(5);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dialogs.policy(tab.id)).toBeNull();
    expect(handlers(cdp).length).toBe(installs + 2);
    expect(handlers(cdp).at(-1)).toContain('"policy":null');
  });

  it("goes native under human control", async () => {
    const { controller, cdp, dialogs, tab, space } = setup();
    await settle();
    dialogs.setPolicy(tab.id, { accept: true, times: 1, lifetimeMs: 60000 });
    await settle();
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    await settle();
    // Taking over resets the policy and hands the page its own functions.
    expect(dialogs.policy(tab.id)).toBeNull();
    expect(handlers(cdp).at(-1)).toContain('"mode":"person"');
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "agent",
    });
    await settle();
    expect(handlers(cdp).at(-1)).toContain('"mode":"agent"');
    expect(dialogs.policy(tab.id)).toBeNull();
  });

  it("hands the page back as the person takes over, before its session releases", async () => {
    const { controller, cdp, dialogs, tab, space } = setup();
    await settle();
    dialogs.setPolicy(tab.id, { accept: true, times: 1, lifetimeMs: 60000 });
    await settle();
    const installs = handlers(cdp).length;
    // The state change every listener hears: the restoring handler goes out
    // in this tick, before the session starts releasing.
    controller.registry.handOver(space.id, { reason: "manual" });
    controller.emit();
    expect(handlers(cdp)).toHaveLength(installs + 1);
    expect(handlers(cdp).at(-1)).toContain('"mode":"person"');
    expect(handlers(cdp).at(-1)).toContain('"policy":null');
    expect(dialogs.policy(tab.id)).toBeNull();
  });

  it("drops malformed reports", async () => {
    const { cdp, dialogs, tab, answers, tabLog } = setup();
    await settle();
    const binding = bindingOf(cdp);
    dialogs.setPolicy(tab.id, { accept: true, times: 3, lifetimeMs: 60000 });
    await settle();
    const bad: unknown[] = [
      "not json at all",
      42,
      JSON.stringify([answered("confirm")]),
      JSON.stringify({ ...answered("confirm"), answer: "maybe" }),
      JSON.stringify({ ...answered("confirm"), type: "toast" }),
      JSON.stringify({ ...answered("confirm"), message: 7 }),
      JSON.stringify({ ...answered("confirm"), url: undefined }),
      JSON.stringify({ ...answered("prompt"), defaultValue: 3 }),
      JSON.stringify({ ...answered("prompt"), promptText: false }),
      `"${"a".repeat(MAX_REPORT_BYTES)}"`,
    ];
    for (const payload of bad) report(cdp, binding, payload);
    // A report under another name belongs to nothing Kamapathy installed.
    report(cdp, "__other", answered("confirm"));
    expect(dialogs.records(tab.id)).toEqual([]);
    expect(dialogs.policy(tab.id)?.remaining).toBe(3);
    expect(answers).toEqual([]);
    expect(tabLog.since(tab.id, 0, ["dialog"])).toEqual([]);

    report(cdp, binding, answered("confirm"));
    expect(dialogs.records(tab.id)).toEqual([
      {
        type: "confirm",
        message: "confirm here",
        answer: "accepted",
        url: URL_HERE,
        at: Date.now(),
      },
    ]);
    expect(dialogs.policy(tab.id)?.remaining).toBe(2);
  });

  it("the log keeps the last 20 records with text cut at 2000 characters", async () => {
    const { cdp, dialogs, tab, tabLog } = setup();
    await settle();
    const binding = bindingOf(cdp);
    for (let index = 0; index < DIALOG_RECORDS + 5; index += 1)
      report(cdp, binding, {
        type: "confirm",
        message: `${index}\u0007 ${"m".repeat(5000)}`,
        answer: "dismissed",
        url: URL_HERE,
      });
    const records = dialogs.records(tab.id);
    expect(records).toHaveLength(DIALOG_RECORDS);
    expect(records[0].message.startsWith("5 ")).toBe(true);
    expect(records[0].message).toHaveLength(MAX_DIALOG_MESSAGE);
    expect(records[0].message).not.toContain("\u0007");
    expect(records.at(-1)!.message.startsWith("24 ")).toBe(true);
    // Receipts read the tab log, which keeps every entry of the action.
    expect(tabLog.since(tab.id, 0, ["dialog"])).toHaveLength(
      DIALOG_RECORDS + 5,
    );
    // A closed tab leaves nothing behind.
    dialogs.forget(tab.id);
    expect(dialogs.records(tab.id)).toEqual([]);
  });

  it("drains the queue of a frame whose context had no binding", async () => {
    let queued: string[] = [];
    const { cdp, dialogs, tab } = setup({ queued: () => queued.splice(0) });
    await settle();
    // The isolated world keeps the reports the binding could not carry.
    const isolated = cdp.sent.filter(
      (command) =>
        command.method === "Page.addScriptToEvaluateOnNewDocument" &&
        command.params.worldName !== undefined,
    );
    expect(isolated).toHaveLength(1);
    queued = [JSON.stringify(answered("confirm", "dismissed"))];
    await dialogs.drain(tab.id, { deadline: Date.now() + 5000 });
    expect(dialogs.records(tab.id)).toEqual([
      {
        type: "confirm",
        message: "confirm here",
        answer: "dismissed",
        url: URL_HERE,
        at: Date.now(),
      },
    ]);
    // Nothing is read twice.
    await dialogs.drain(tab.id, { deadline: Date.now() + 5000 });
    expect(dialogs.records(tab.id)).toHaveLength(1);
  });

  it("the binding is added before the init scripts on the page session and on every frame session, and again after a re-attach", async () => {
    const { cdp } = setup();
    await settle();
    const inOrder = (sessionId?: string) => {
      const methods = cdp.methods(sessionId);
      expect(methods).toContain("Runtime.addBinding");
      expect(methods.indexOf("Runtime.addBinding")).toBeLessThan(
        methods.indexOf("Page.addScriptToEvaluateOnNewDocument"),
      );
    };
    inOrder();
    attachedTarget(cdp, {
      sessionId: "frame-1",
      targetId: "target-frame-1",
      url: "https://frame.example/",
    });
    await settle();
    inOrder("frame-1");
    // Reports from a frame session count like the page's own.
    const pageBindings = () =>
      cdp.sent.filter(
        (command) =>
          command.method === "Runtime.addBinding" &&
          command.sessionId === undefined,
      );
    expect(pageBindings()).toHaveLength(1);
    cdp.lose();
    await settle();
    expect(pageBindings()).toHaveLength(2);
    // Nothing in this path enables the Runtime domain.
    expect(cdp.methods()).not.toContain("Runtime.enable");
    expect(cdp.methods("frame-1")).not.toContain("Runtime.enable");
  });

  it("keeps the report limits the handler and the server share", () => {
    const source = dialogHandler.toString();
    expect(source).toContain(String(MAX_REPORT_BYTES));
    expect(source).toContain(String(MAX_REPORTS_PER_DOCUMENT));
    // Self-contained: the source names nothing outside its argument.
    expect(source).not.toContain("require(");
    expect(source).not.toContain("import ");
  });
});
