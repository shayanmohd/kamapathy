import { describe, expect, it } from "vitest";
import {
  TabRegistry,
  type RegistryEvent,
  type TabOrigin,
} from "../electron/agent/tab-registry";
import { initialState, newTab } from "../shared/state";
import type { ClosedBy, Space, Tab } from "../shared/types";

const agent: TabOrigin = { openedBy: "agent", managed: true };
const person: TabOrigin = { openedBy: "person", managed: false };

// The default personal spaces plus two agent spaces, "one" and "two", and a
// clock the test sets.
function setup() {
  const state = initialState();
  for (const id of ["one", "two"])
    state.spaces.push({
      id,
      name: id,
      color: "purple",
      kind: "agent",
      owner: "agent",
      signIns: "shared",
      createdAt: 0,
    });
  const clock = { now: 1000 };
  const registry = new TabRegistry(() => state, () => clock.now);
  // As the controller does: registered first, then part of the state.
  const open = (spaceId: string, origin: TabOrigin = agent, url?: string) => {
    const tab = newTab(spaceId, url);
    registry.register(tab, origin);
    state.tabs.push(tab);
    return tab;
  };
  const close = (tab: Tab, closedBy: ClosedBy = "agent") => {
    registry.retire(tab, closedBy);
    state.tabs.splice(state.tabs.indexOf(tab), 1);
  };
  return { state, clock, registry, open, close };
}

describe("tab registry", () => {
  it("labels tabs p1, p2 per space in creation order under agent rules and never reuses a label", () => {
    const { registry, open, close } = setup();
    const first = open("one");
    const other = open("two");
    const popup = open("one", {
      openedBy: "page",
      openerId: first.id,
      managed: true,
    });
    expect([first.label, popup.label, other.label]).toEqual(["p1", "p2", "p1"]);
    expect(first).toMatchObject({
      openedBy: "agent",
      managed: true,
      createdAt: 1000,
    });
    expect(first).not.toHaveProperty("openerId");
    expect(popup).toMatchObject({ openedBy: "page", openerId: first.id });
    close(popup);
    close(first);
    expect(open("one").label).toBe("p3");
    // A personal space follows no agent rules, so its tabs get no label.
    const own = open("personal", person);
    expect(own).toMatchObject({ openedBy: "person", managed: false });
    expect(own).not.toHaveProperty("label");
    // A creation time already set is kept.
    const dated = { ...newTab("one"), createdAt: 5 };
    registry.register(dated, agent);
    expect(dated).toMatchObject({ createdAt: 5, label: "p4" });
    // A deleted space's retired labels go with it.
    expect(registry.closed("one")).toHaveLength(2);
    registry.forget("one");
    expect(registry.closed("one")).toEqual([]);
  });

  it("a grant labels unlabeled tabs in tab-strip order, pinned first", () => {
    const { state, registry, open } = setup();
    const work = state.spaces.find((space) => space.id === "work")!;
    const blank = state.tabs.find((tab) => tab.spaceId === "work")!;
    const pinned = open("work", person, "https://a.example/");
    pinned.pinned = true;
    const plain = open("work", person, "https://b.example/");
    const later = open("work", person, "https://c.example/");
    later.pinned = true;
    const strip = [pinned, later, blank, plain];
    expect(strip.map((tab) => tab.label)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    // What a grant does to the space's labels.
    work.access = "granted";
    registry.labelSpace("work");
    expect(strip.map((tab) => tab.label)).toEqual(["p1", "p2", "p3", "p4"]);
    // Labels stay put, and tabs opened during the grant count on.
    registry.labelSpace("work");
    expect(open("work", person).label).toBe("p5");
    expect(strip.map((tab) => tab.label)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(
      state.tabs.find((tab) => tab.spaceId === "personal"),
    ).not.toHaveProperty("label");
  });

  it("file tabs get no label", () => {
    const { state, registry, open } = setup();
    // Under agent rules, as a defense: agent spaces never open files.
    expect(open("one").label).toBe("p1");
    const file = open("one", person, "file:///tmp/notes.pdf");
    expect(file).not.toHaveProperty("label");
    expect(file).toMatchObject({ openedBy: "person", managed: false });
    expect(open("one").label).toBe("p2");
    // A grant labels the web tabs around a file the person opened before.
    const work = state.spaces.find((space) => space.id === "work")!;
    const blank = state.tabs.find((tab) => tab.spaceId === "work")!;
    const local = open("work", person, "file:///Users/me/report.pdf");
    const page = open("work", person, "https://example.com/");
    work.access = "granted";
    registry.labelSpace("work");
    expect([blank.label, page.label]).toEqual(["p1", "p2"]);
    expect(local).not.toHaveProperty("label");
    expect(open("work", person, "https://example.org/").label).toBe("p3");
    expect(open("work", person, "file://localhost/tmp/a.png")).not.toHaveProperty(
      "label",
    );
  });

  it("keeps the last 100 retired labels per space with who closed them", () => {
    const { clock, registry, open, close } = setup();
    const closers: ClosedBy[] = ["agent", "page", "person"];
    for (let index = 0; index < 105; index++) {
      clock.now = 2000 + index;
      close(open("one"), closers[index % 3]);
    }
    close(open("two"), "page");
    const closed = registry.closed("one");
    expect(closed).toHaveLength(100);
    expect(closed.slice(0, 3)).toEqual([
      { label: "p6", closedBy: "person", at: 2005 },
      { label: "p7", closedBy: "agent", at: 2006 },
      { label: "p8", closedBy: "page", at: 2007 },
    ]);
    expect(closed.at(-1)).toEqual({
      label: "p105",
      closedBy: "person",
      at: 2104,
    });
    expect(registry.closed("two")).toEqual([
      { label: "p1", closedBy: "page", at: 2104 },
    ]);
    // A tab without a label leaves nothing to list.
    close(open("personal", person), "person");
    expect(registry.closed("personal")).toEqual([]);
  });

  it("counts managed tabs toward the page budget", () => {
    const { registry, open, close } = setup();
    const first = open("one");
    open("one", { openedBy: "page", openerId: first.id, managed: true });
    const theirs = open("one", person);
    open("one", { openedBy: "page", openerId: theirs.id, managed: false });
    open("two");
    expect(registry.used("one")).toBe(2);
    registry.setManaged(theirs, true);
    expect(theirs.managed).toBe(true);
    expect(registry.used("one")).toBe(3);
    registry.setManaged(first, false);
    expect(registry.used("one")).toBe(2);
    close(theirs);
    expect(registry.used("one")).toBe(1);
    expect(registry.used("two")).toBe(1);
    expect(registry.used("personal")).toBe(0);
  });

  it("emits opened and closed with labels, origins and opener ids, and marks popups under agent rules unseen", () => {
    const { state, registry, open, close } = setup();
    const events: RegistryEvent[] = [];
    const stop = registry.on((event) => events.push(event));
    const opener = open("one");
    const popup = open("one", {
      openedBy: "page",
      openerId: opener.id,
      managed: true,
    });
    const personal = state.tabs.find((tab) => tab.spaceId === "personal")!;
    const personalPopup = open("personal", {
      openedBy: "page",
      openerId: personal.id,
      managed: false,
    });
    close(popup, "page");
    close(personalPopup, "person");
    expect(events).toStrictEqual([
      {
        type: "opened",
        spaceId: "one",
        tabId: opener.id,
        label: "p1",
        openedBy: "agent",
      },
      {
        type: "opened",
        spaceId: "one",
        tabId: popup.id,
        label: "p2",
        openedBy: "page",
        openerId: opener.id,
      },
      {
        type: "opened",
        spaceId: "personal",
        tabId: personalPopup.id,
        openedBy: "page",
        openerId: personal.id,
      },
      {
        type: "closed",
        spaceId: "one",
        tabId: popup.id,
        label: "p2",
        closedBy: "page",
      },
      {
        type: "closed",
        spaceId: "personal",
        tabId: personalPopup.id,
        closedBy: "person",
      },
    ]);
    expect(popup.unseen).toBe(true);
    expect(opener).not.toHaveProperty("unseen");
    expect(personalPopup).not.toHaveProperty("unseen");
    stop();
    open("one");
    expect(events).toHaveLength(5);
  });

  it("a boundary lists tabs opened and labels retired since control left, and the last one is kept until control leaves again", () => {
    const { state, clock, registry, open, close } = setup();
    const space = state.spaces.find((item) => item.id === "one")!;
    const first = open("one");
    close(open("one"));
    expect(registry.lastBoundary("one", first)).toEqual({
      active: first,
      opened: [],
      closed: [],
    });
    clock.now = 2000;
    registry.handOver("one", { reason: "handoff" });
    expect(space.owner).toBe("human");
    expect(space.control).toEqual({ reason: "handoff", since: 2000 });
    const third = open("one", person);
    const fourth = open("one", person);
    close(first, "person");
    close(fourth, "person");
    open("two", person);
    // Taking over while the person has control changes the reason only.
    clock.now = 3000;
    registry.handOver("one", { reason: "manual" });
    expect(space.control).toEqual({ reason: "manual", since: 3000 });
    const fifth = open("one", person);
    expect(registry.takeBack("one", third)).toEqual({
      active: third,
      opened: [third, fifth],
      closed: ["p1", "p4"],
    });
    expect(space.owner).toBe("agent");
    expect(space).not.toHaveProperty("control");
    // The last boundary keeps its labels and lists only tabs still open,
    // with the space's active tab now.
    close(fifth);
    expect(registry.lastBoundary("one", null)).toEqual({
      active: null,
      opened: [third],
      closed: ["p1", "p4"],
    });
    // Taking back control the agent already has changes nothing.
    expect(registry.takeBack("one", third)).toEqual({
      active: third,
      opened: [third],
      closed: ["p1", "p4"],
    });
    registry.handOver("one", { reason: "manual" });
    expect(registry.lastBoundary("one", third)).toEqual({
      active: third,
      opened: [],
      closed: [],
    });
    expect(registry.takeBack("one", third)).toEqual({
      active: third,
      opened: [],
      closed: [],
    });
  });
});

describe("access", () => {
  it("grant marks every tab person and unmanaged and labels them; end unmanages and records who ended it; reset ends every grant", () => {
    const state = initialState();
    let now = 1000;
    const registry = new TabRegistry(
      () => state,
      () => now,
    );
    const person: TabOrigin = { openedBy: "person", managed: false };
    const agent: TabOrigin = { openedBy: "agent", managed: true };
    // Registered before it joins the state, as the controller does.
    const add = (
      spaceId: string,
      url: string,
      origin: TabOrigin,
      pinned = false,
    ) => {
      const tab = { ...newTab(spaceId, url), pinned };
      registry.register(tab, origin);
      state.tabs.push(tab);
      return tab;
    };
    const work = state.spaces.find((space) => space.id === "work")!;
    const first = state.tabs.find((tab) => tab.spaceId === "work")!;
    registry.register(first, person);
    const pinned = add("work", "https://example.com/pinned", person, true);
    // A personal space follows the person's rules until it is granted.
    expect([first.label, pinned.label]).toEqual([undefined, undefined]);
    // Whatever control the space had ends with the grant.
    work.control = { reason: "manual", since: 1 };
    registry.grant("work");
    expect(work).toMatchObject({
      kind: "personal",
      owner: "agent",
      access: "granted",
    });
    expect(work.control).toBeUndefined();
    // Labels follow the tab strip: pinned tabs first.
    expect(pinned).toMatchObject({
      label: "p1",
      openedBy: "person",
      managed: false,
    });
    expect(first).toMatchObject({
      label: "p2",
      openedBy: "person",
      managed: false,
    });
    const page = add("work", "https://example.com/page", agent);
    expect(page).toMatchObject({ label: "p3", openedBy: "agent", managed: true });
    expect(registry.used("work")).toBe(1);

    now = 2000;
    registry.end("work", { by: "agent", reason: "finished" });
    expect(work).toMatchObject({
      owner: "human",
      access: "ended",
      ended: { by: "agent", reason: "finished", at: 2000 },
    });
    expect(page).toMatchObject({
      label: "p3",
      openedBy: "agent",
      managed: false,
    });
    expect(registry.used("work")).toBe(0);
    // A new grant makes every tab present the person's, keeps labels and
    // forgets the end.
    registry.grant("work");
    expect(work.ended).toBeUndefined();
    expect(page).toMatchObject({
      label: "p3",
      openedBy: "person",
      managed: false,
    });

    const task: Space = {
      id: "task",
      name: "Task",
      color: "purple",
      kind: "agent",
      owner: "agent",
      signIns: "shared",
      createdAt: 0,
      createdBy: "agent",
      access: "granted",
    };
    state.spaces.push(task);
    const own = add("task", "https://example.com/own", agent);
    registry.handOver("task", { reason: "manual" });
    const meanwhile = add("task", "https://example.com/meanwhile", person);
    expect(registry.takeBack("task", own).opened).toEqual([meanwhile]);
    registry.handOver("task", {
      reason: "approval",
      prompt: "clearing site data",
    });
    now = 3000;
    registry.end("task", { by: "person", reason: "stopped" });
    expect(task).toMatchObject({
      owner: "human",
      access: "ended",
      ended: { by: "person", reason: "stopped", at: 3000 },
    });
    expect(task.control).toBeUndefined();
    expect(own.managed).toBe(false);
    // A grant starts a new boundary: nothing opened or closed since.
    registry.grant("task");
    expect(task).toMatchObject({ owner: "agent", access: "granted" });
    expect(own).toMatchObject({
      label: "p1",
      openedBy: "person",
      managed: false,
    });
    expect(registry.lastBoundary("task", own)).toEqual({
      active: own,
      opened: [],
      closed: [],
    });

    // Agent access off ends every grant, ended ones included.
    registry.end("work", { by: "person", reason: "stopped" });
    registry.setManaged(own, true);
    registry.reset();
    expect(work).toMatchObject({ kind: "personal", owner: "human" });
    expect(task).toMatchObject({ kind: "agent", owner: "agent" });
    for (const space of [work, task]) {
      expect(space.access).toBeUndefined();
      expect(space.ended).toBeUndefined();
      expect(space.control).toBeUndefined();
    }
    expect(state.tabs.some((tab) => tab.managed)).toBe(false);
  });
});
