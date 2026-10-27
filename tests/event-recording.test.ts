import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthority } from "../electron/agent/authority";
import { createEventRecording } from "../electron/agent/events";
import { createPageScripts } from "../electron/agent/page-scripts";
import type { AutomationController } from "../electron/agent/server";
import {
  EVENT_LIMITS,
  EventBufferPool,
} from "../electron/agent/session/event-buffer";
import { TabSessions } from "../electron/agent/session/tab-sessions";
import { FakeController } from "./fake-automation";
import { attachedTarget, frameTree, type FakeDebugger } from "./fake-cdp";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// Runs the timers due now and every promise callback they lead to.
const settle = () => vi.advanceTimersByTimeAsync(0);
const soon = () => ({ deadline: Date.now() + 10000 });

// The recording controller over the real sessions and buffers of one agent
// space, as startAutomation wires them.
function setup(limits = EVENT_LIMITS) {
  const controller = new FakeController();
  const authority = createAuthority(controller);
  const pageScripts = createPageScripts(controller);
  const sessions = new TabSessions({
    controller: controller as unknown as AutomationController,
    agentDriven: (spaceId) => authority.agentDriven(spaceId),
    managedTab: (tabId) =>
      controller.state.tabs.find((tab) => tab.id === tabId)?.managed === true,
    waitForSpaceIdle: async () => {},
    buffers: new EventBufferPool(limits),
  });
  const events = createEventRecording({
    controller: controller as unknown as AutomationController,
    authority,
    sessions,
    pageScripts,
  });
  sessions.start();
  const space = controller.createAgentSpace("Research");
  authority.managedSpaces.add(space.id);
  const open = async (url = "https://example.com/") => {
    const tab = controller.openAgentTab(space.id, url);
    await settle();
    const cdp = controller.pages.get(tab.id)!.debugger;
    return { tab, cdp };
  };
  return {
    controller,
    authority,
    pageScripts,
    sessions,
    events,
    space,
    open,
    async stop() {
      events.dispose();
      pageScripts.dispose();
      await sessions.close();
    },
  };
}
// A request as Chromium reports one, with a cookie an agent may not read.
const request = (cdp: FakeDebugger, requestId: string, sessionId?: string) => {
  cdp.event(
    "Network.requestWillBeSentExtraInfo",
    {
      requestId,
      headers: { Cookie: "session=secret", accept: "*/*" },
      associatedCookies: [],
    },
    sessionId,
  );
};
// A frame of another site, in its own process and session, with the path
// lookups frames() makes.
async function framed(cdp: FakeDebugger) {
  cdp.reply("Page.getFrameTree", (_params, sessionId) =>
    sessionId === "child-1"
      ? frameTree([
          { id: "ads", parentId: "main", url: "https://ads.example/" },
        ])
      : frameTree([
          { id: "main", url: "https://example.com/", loaderId: "loader-1" },
        ]),
  );
  cdp.reply("DOM.getFrameOwner", () => ({ backendNodeId: 1 }));
  cdp.reply("DOM.resolveNode", () => ({
    object: { type: "object", subtype: "node", objectId: "owner-1" },
  }));
  cdp.reply("Runtime.callFunctionOn", () => ({
    result: { type: "object", value: { ok: true, path: "0" } },
  }));
  cdp.event("Page.frameAttached", { frameId: "ads", parentFrameId: "main" });
  attachedTarget(cdp, {
    sessionId: "child-1",
    targetId: "ads",
    url: "https://ads.example/",
  });
  await settle();
}

describe("agent event recording", () => {
  it("the drain returns the oldest events and what is left", async () => {
    const harness = setup();
    const { tab, cdp } = await harness.open();
    for (let index = 1; index <= 5; index += 1)
      cdp.event("Network.loadingFinished", {
        requestId: String(index),
        encodedDataLength: index,
      });
    const first = await harness.events.drain(tab.id, 3, soon());
    expect(first.events).toEqual([
      {
        time: Date.now(),
        method: "Network.loadingFinished",
        params: { requestId: "1", encodedDataLength: 1 },
      },
      {
        time: Date.now(),
        method: "Network.loadingFinished",
        params: { requestId: "2", encodedDataLength: 2 },
      },
      {
        time: Date.now(),
        method: "Network.loadingFinished",
        params: { requestId: "3", encodedDataLength: 3 },
      },
    ]);
    expect(first).toMatchObject({ dropped: 0, gaps: [], remaining: 2 });
    // A second drain starts where the first ended, and a third has nothing.
    const second = await harness.events.drain(tab.id, 10, soon());
    expect(
      second.events.map((event) => (event as { params: any }).params.requestId),
    ).toEqual(["4", "5"]);
    expect(second.remaining).toBe(0);
    expect(await harness.events.drain(tab.id, 10, soon())).toEqual({
      events: [],
      dropped: 0,
      gaps: [],
      remaining: 0,
    });
    // Only Page and Network events of Kamapathy's own session are recorded.
    cdp.event("Runtime.consoleAPICalled", { type: "log", args: [] });
    cdp.event("Page.loadEventFired", { timestamp: 1 });
    expect(
      (await harness.events.drain(tab.id, 10, soon())).events.map(
        (event) => (event as { method: string }).method,
      ),
    ).toEqual(["Page.loadEventFired"]);
    // A tab that never held a session has no log and no events.
    expect(await harness.events.drain("tab-none", 10, soon())).toEqual({
      events: [],
      dropped: 0,
      gaps: [],
      remaining: 0,
    });
    await harness.stop();
  });

  it("the caps hold", async () => {
    // The numbers are the event buffer's own, pinned in its test; these are
    // the same caps over one tab's recording, in miniature.
    expect(EVENT_LIMITS.events).toBe(10000);
    const harness = setup({ ...EVENT_LIMITS, events: 4, tabBytes: 400 });
    const { tab, cdp } = await harness.open();
    for (let index = 1; index <= 6; index += 1)
      cdp.event("Network.loadingFinished", { requestId: String(index) });
    const trimmed = await harness.events.drain(tab.id, 10, soon());
    expect(
      trimmed.events.map(
        (event) => (event as { params: any }).params.requestId,
      ),
    ).toEqual(["3", "4", "5", "6"]);
    expect(trimmed.dropped).toBe(2);
    // Past the tab's byte cap the oldest events go, and dropped counts them.
    cdp.event("Network.dataReceived", {
      requestId: "7",
      data: "x".repeat(300),
    });
    cdp.event("Network.dataReceived", {
      requestId: "8",
      data: "x".repeat(300),
    });
    const bytes = await harness.events.drain(tab.id, 10, soon());
    expect(
      bytes.events.map((event) => (event as { params: any }).params.requestId),
    ).toEqual(["8"]);
    expect(bytes.dropped).toBe(1);
    await harness.stop();
  });

  it("an event over 1 MiB is kept as a marker", async () => {
    const harness = setup();
    const { tab, cdp } = await harness.open();
    const params = {
      requestId: "1",
      data: "x".repeat(EVENT_LIMITS.eventBytes),
    };
    cdp.event("Network.dataReceived", params);
    const drained = await harness.events.drain(tab.id, 10, soon());
    expect(drained.events).toEqual([
      {
        time: Date.now(),
        method: "Network.dataReceived",
        omitted: "too_large",
        bytes: Buffer.byteLength(JSON.stringify(params)),
      },
    ]);
    // The marker itself counts for nothing, so the log is empty again.
    cdp.event("Network.loadingFinished", { requestId: "1" });
    expect(
      (await harness.events.drain(tab.id, 10, soon())).events,
    ).toHaveLength(1);
    await harness.stop();
  });

  it("gaps name their reason", async () => {
    const harness = setup();
    const { controller, pageScripts } = harness;
    const { tab, cdp } = await harness.open();
    cdp.event("Page.loadEventFired", { timestamp: 1 });
    // The person takes over: nothing they do is recorded.
    const from = Date.now();
    controller.registry.handOver(harness.space.id, { reason: "manual" });
    controller.emit();
    vi.advanceTimersByTime(50);
    cdp.event("Page.loadEventFired", { timestamp: 2 });
    controller.registry.takeBack(harness.space.id, null);
    controller.emit();
    await settle();
    cdp.event("Page.loadEventFired", { timestamp: 3 });
    const resumed = await harness.events.drain(tab.id, 10, soon());
    expect(
      resumed.events.map(
        (event) => (event as { params: any }).params.timestamp,
      ),
    ).toEqual([1, 3]);
    expect(resumed.gaps).toEqual([
      { reason: "human_control", from, to: from + 50 },
    ]);
    // The same drain reports a gap once.
    expect((await harness.events.drain(tab.id, 10, soon())).gaps).toEqual([]);
    // The switch goes off: recording stops and the log is emptied.
    cdp.event("Page.loadEventFired", { timestamp: 4 });
    const off = Date.now();
    controller.state.settings.agentPageScripts = false;
    controller.emit();
    expect(pageScripts.on).toBe(false);
    cdp.event("Page.loadEventFired", { timestamp: 5 });
    expect(await harness.events.drain(tab.id, 10, soon())).toMatchObject({
      events: [],
      remaining: 0,
    });
    vi.advanceTimersByTime(20);
    controller.state.settings.agentPageScripts = true;
    controller.emit();
    cdp.event("Page.loadEventFired", { timestamp: 6 });
    const back = await harness.events.drain(tab.id, 10, soon());
    expect(
      back.events.map((event) => (event as { params: any }).params.timestamp),
    ).toEqual([6]);
    expect(back.gaps).toEqual([
      { reason: "page_scripts_off", from: off, to: off + 20 },
    ]);
    // A lost debugger leaves a gap of its own until a setup ends again.
    const lost = Date.now();
    cdp.lose();
    await settle();
    vi.advanceTimersByTime(10);
    cdp.attached = true;
    cdp.emit("message", {}, "Page.loadEventFired", { timestamp: 7 }, "");
    const gaps = (await harness.events.drain(tab.id, 10, soon())).gaps;
    expect(gaps).toMatchObject([{ reason: "debugger_detached", from: lost }]);
    await harness.stop();
  });

  it("nothing appears twice after the agent enables a domain", async () => {
    const harness = setup();
    const { tab, cdp } = await harness.open();
    const owned = new Set<string>();
    harness.events.setAgentDomains({
      owns: (tabId, domain) => tabId === tab.id && owned.has(domain),
      delivered: () => true,
    });
    const agent = await (async () => {
      const session = harness.sessions.get(tab.id)!;
      const sessionId = await session.openAgentSession();
      await settle();
      return sessionId;
    })();
    cdp.event("Network.loadingFinished", { requestId: "1" }, agent);
    owned.add("Network");
    // Kamapathy's own copy stops being recorded, and the agent's is kept.
    cdp.event("Network.loadingFinished", { requestId: "2" });
    cdp.event("Network.loadingFinished", { requestId: "3" }, agent);
    cdp.event("Page.loadEventFired", { timestamp: 1 });
    const drained = await harness.events.drain(tab.id, 10, soon());
    expect(
      drained.events.map(
        (event) => (event as { params: any }).params.requestId ?? "page",
      ),
    ).toEqual(["1", "3", "page"]);
    await harness.stop();
  });

  it("frame paths are worked out at the drain", async () => {
    const harness = setup();
    const { tab, cdp } = await harness.open();
    await framed(cdp);
    // The frame's own attach is recorded too; this drain starts after it.
    await harness.events.drain(tab.id, 100, soon());
    cdp.event("Page.loadEventFired", { timestamp: 1 });
    request(cdp, "1", "child-1");
    const drained = await harness.events.drain(tab.id, 10, soon());
    expect(drained.events).toEqual([
      {
        time: Date.now(),
        method: "Page.loadEventFired",
        params: { timestamp: 1 },
      },
      {
        time: Date.now(),
        method: "Network.requestWillBeSentExtraInfo",
        params: {
          requestId: "1",
          headers: { Cookie: "(hidden)", accept: "*/*" },
          associatedCookies: [],
        },
        frame: "0",
      },
    ]);
    // A frame that has gone by the drain has no path.
    request(cdp, "2", "child-1");
    cdp.event("Target.detachedFromTarget", {
      sessionId: "child-1",
      targetId: "ads",
    });
    await settle();
    const after = await harness.events.drain(tab.id, 10, soon());
    expect(after.events).toMatchObject([
      { method: "Network.requestWillBeSentExtraInfo", frame: null },
    ]);
    await harness.stop();
  });

  it("an agent's own sessions name no frame for the page and the path for a frame", async () => {
    const harness = setup();
    const { tab, cdp } = await harness.open();
    await framed(cdp);
    await harness.events.drain(tab.id, 100, soon());
    const session = harness.sessions.get(tab.id)!;
    const onPage = await session.openAgentSession();
    const inFrame = await session.openAgentSession("ads");
    await settle();
    request(cdp, "1", onPage);
    request(cdp, "2", inFrame);
    const frameOf = async () =>
      (await harness.events.drain(tab.id, 10, soon())).events.map((event) => [
        (event as { params: { requestId: string } }).params.requestId,
        "frame" in event ? event.frame : "page",
      ]);
    expect(await frameOf()).toEqual([
      ["1", "page"],
      ["2", "0"],
    ]);
    // Events an agent session recorded before it closed still say where
    // they came from.
    request(cdp, "3", onPage);
    await session.closeAgentSession(onPage);
    await settle();
    expect(await frameOf()).toEqual([["3", "page"]]);
    await harness.stop();
  });
});
