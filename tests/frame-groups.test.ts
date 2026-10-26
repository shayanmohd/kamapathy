import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../electron/agent/errors";
import {
  READ_LIMITS,
  READY_PROBE_MS,
  SILENT_FOR_MS,
  createFrameGroups,
  type FrameGroups,
  type GroupInfo,
} from "../electron/agent/frames/groups";
import { RefBook } from "../electron/agent/refs";
import { EventBufferPool } from "../electron/agent/session/event-buffer";
import { PDF_VIEWER_ID } from "../electron/agent/session/frames";
import { TabSession } from "../electron/agent/session/tab-session";
import type { SessionHost } from "../electron/agent/session/types";
import {
  FakeHost,
  attachedTarget,
  frameOwners,
  frameTree,
  type FakeDebugger,
} from "./fake-cdp";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(0);
const step = () => ({ deadline: Date.now() + 10000 });
const reading = () => ({ ...step(), budgetMs: 10000 });

type TreeFrames = Parameters<typeof frameTree>[0];
type Owners = Record<string, { local: string; readable?: boolean }>;
// What a page operation answers, by the operation and the frame whose world
// ran it. HOLD leaves the command unanswered, as a frame that went silent
// does, so only its own bound ends it.
const HOLD = Symbol("never answered");
type Operations = (call: {
  op: string;
  frameId: string;
  payload: string;
}) => unknown;

// A ready session over the frame trees each session reports, the owner
// bindings its pages answer and the frames Chromium moved to their own
// process.
async function open(options: {
  trees: Record<string, TreeFrames>;
  owners?: Owners;
  targets?: { sessionId: string; frameId: string; url: string }[];
  operations?: Operations;
}) {
  const host = new FakeHost({ url: "https://shop.example/" });
  const cdp = host.debugger;
  cdp.reply("Page.getFrameTree", (_params, sessionId) =>
    frameTree(options.trees[sessionId ?? ""]),
  );
  if (options.owners) frameOwners(cdp, options.owners);
  // Which frame each world belongs to, so a page operation is answered for
  // the document that ran it.
  const worlds = new Map<number, string>();
  cdp.reply("Page.createIsolatedWorld", (params) => {
    const executionContextId = worlds.size + 1;
    worlds.set(executionContextId, params.frameId);
    return { executionContextId };
  });
  cdp.reply("Runtime.evaluate", (params) => {
    const expression = params.expression as string;
    const op = [...expression.matchAll(/\)\("(\w+)"[,)]/g)].pop()?.[1] ?? "";
    const value = options.operations?.({
      op,
      frameId: worlds.get(params.contextId) ?? "",
      payload: expression,
    });
    if (value === HOLD) return new Promise(() => {});
    return { result: { type: "object", value } };
  });
  const session = new TabSession(host as unknown as SessionHost, {
    tabId: "tab-1",
    waitForSpaceIdle: async () => {},
    buffer: new EventBufferPool().create("tab-1"),
  });
  session.attach();
  await settle();
  // A frame in its own process is reported by the page session first, then
  // announced as a target.
  for (const target of options.targets ?? []) {
    cdp.event("Page.frameAttached", {
      frameId: target.frameId,
      parentFrameId: "main",
    });
    attachedTarget(cdp, {
      sessionId: target.sessionId,
      targetId: target.frameId,
      url: target.url,
    });
  }
  await settle();
  const refs = new RefBook();
  const frames = createFrameGroups(session, { refs, tabId: "tab-1" });
  return { host, cdp, session, refs, frames, worlds };
}

const sentTo = (cdp: FakeDebugger, method: string) =>
  cdp.sent.filter((command) => command.method === method);
// The world a frame's isolated world was given, as the fake numbers them.
const worldOf = (cdp: FakeDebugger, frameId: string) =>
  sentTo(cdp, "Page.createIsolatedWorld").findIndex(
    (command) => command.params.frameId === frameId,
  ) + 1;
const thrown = (run: () => unknown): ApiError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("The call did not throw.");
};
// A read that answers at once with each group's path.
const readPaths = async (frames: FrameGroups) => {
  const done = await frames.read(reading(), async (group) => group.path);
  return {
    paths: done.results.map((result) => result.value),
    unread: done.unread,
  };
};

describe("frame groups", () => {
  it("starts groups at origin changes and opaque origins, corrected by the walk", async () => {
    const { frames } = await open({
      trees: {
        "": [
          { id: "main", url: "https://shop.example/" },
          { id: "card", parentId: "main", url: "https://shop.example/card" },
          { id: "blank", parentId: "main", url: "about:blank", origin: "" },
          { id: "box", parentId: "main", url: "https://shop.example/box" },
        ],
        "ads-session": [
          { id: "ads", parentId: "main", url: "https://ads.example/" },
        ],
      },
      owners: {
        card: { local: "0", readable: true },
        ads: { local: "1" },
        blank: { local: "2", readable: true },
        box: { local: "3" },
      },
      targets: [
        {
          sessionId: "ads-session",
          frameId: "ads",
          url: "https://ads.example/",
        },
      ],
    });
    expect(await frames.groups(step())).toEqual([
      { root: "main", path: "", origin: "https://shop.example", level: 0 },
      {
        root: "ads",
        path: "1",
        origin: "https://ads.example",
        level: 1,
        sessionId: "ads-session",
        owner: {
          frameId: "ads",
          group: "",
          local: "1",
          key: "ads",
          readable: false,
        },
      },
      // Same origin as the page around it, and still a group of its own,
      // because the walk could not read it.
      {
        root: "box",
        path: "3",
        origin: "https://shop.example",
        level: 1,
        owner: {
          frameId: "box",
          group: "",
          local: "3",
          key: "box",
          readable: false,
        },
      },
    ]);
    // A same-origin child, and an opaque frame its world can read, stay in
    // the group around them.
    expect(frames.groupOf("card")?.root).toBe("main");
    expect(frames.groupOf("blank")?.root).toBe("main");
    expect(frames.pathOf("blank")).toBe("2");
    expect(frames.frameAt("3")).toEqual({ frameId: "box", ownSession: false });
    expect(frames.frameAt("1")).toEqual({
      frameId: "ads",
      sessionId: "ads-session",
      ownSession: true,
    });
    expect(frames.frameAt("9")).toBeUndefined();
  });

  it("binds each child once per root document, on the root's session and world", async () => {
    const { cdp, frames } = await open({
      trees: {
        "": [
          { id: "main", url: "https://shop.example/" },
          { id: "card", parentId: "main", url: "https://shop.example/card" },
        ],
        "ads-session": [
          { id: "ads", parentId: "main", url: "https://ads.example/" },
          {
            id: "ads-inner",
            parentId: "ads",
            url: "https://ads.example/inner",
          },
        ],
      },
      owners: {
        card: { local: "0", readable: true },
        ads: { local: "1" },
        "ads-inner": { local: "0", readable: true },
      },
      targets: [
        {
          sessionId: "ads-session",
          frameId: "ads",
          url: "https://ads.example/",
        },
      ],
    });
    await frames.bind(step());
    expect(
      sentTo(cdp, "DOM.getFrameOwner").map((command) => [
        command.params.frameId,
        command.sessionId,
      ]),
    ).toEqual([
      ["card", undefined],
      ["ads", undefined],
      ["ads-inner", "ads-session"],
    ]);
    // Each owner is resolved into the world of its group's root, on the
    // session that hosts it.
    expect(
      sentTo(cdp, "DOM.resolveNode").map((command) => [
        command.params.executionContextId,
        command.params.objectGroup,
        command.sessionId,
      ]),
    ).toEqual([
      [worldOf(cdp, "main"), "kamapathy-frames", undefined],
      [worldOf(cdp, "main"), "kamapathy-frames", undefined],
      [worldOf(cdp, "ads"), "kamapathy-frames", "ads-session"],
    ]);
    const calls = sentTo(cdp, "Runtime.callFunctionOn");
    expect(
      calls.map((command) => [
        command.params.arguments,
        command.params.returnByValue,
        command.params.silent,
        command.sessionId,
      ]),
    ).toEqual([
      [[{ value: "card" }], true, true, undefined],
      [[{ value: "ads" }], true, true, undefined],
      [[{ value: "ads-inner" }], true, true, "ads-session"],
    ]);
    for (const call of calls)
      expect(call.params.functionDeclaration).toContain("__kamapathyFrames");
    // No owner object outlives the pass.
    expect(
      sentTo(cdp, "Runtime.releaseObjectGroup").map((command) => [
        command.params.objectGroup,
        command.sessionId,
      ]),
    ).toEqual([
      ["kamapathy-frames", undefined],
      ["kamapathy-frames", "ads-session"],
    ]);
    expect(frames.pathOf("ads-inner")).toBe("1/0");
    // The group's own path, so the frames inside it carry the page's
    // numbering.
    expect(frames.groupOf("ads-inner")?.path).toBe("1");
    const sent = cdp.sent.length;
    await frames.bind(step());
    expect(cdp.sent).toHaveLength(sent);
  });

  it("rebinds after a root loads another document and drops detached children", async () => {
    const { cdp, frames } = await open({
      trees: {
        "": [
          { id: "main", url: "https://shop.example/" },
          { id: "card", parentId: "main", url: "https://shop.example/card" },
        ],
        "ads-session": [
          { id: "ads", parentId: "main", url: "https://ads.example/" },
          {
            id: "ads-inner",
            parentId: "ads",
            url: "https://ads.example/inner",
          },
        ],
      },
      owners: {
        card: { local: "0", readable: true },
        ads: { local: "1" },
        "ads-inner": { local: "0", readable: true },
      },
      targets: [
        {
          sessionId: "ads-session",
          frameId: "ads",
          url: "https://ads.example/",
        },
      ],
    });
    await frames.bind(step());
    const bound = () =>
      sentTo(cdp, "DOM.getFrameOwner").map((command) => command.params.frameId);
    expect(bound()).toEqual(["card", "ads", "ads-inner"]);
    // The group root loads another document: its world, and every binding
    // made in it, are gone.
    cdp.event(
      "Page.frameNavigated",
      {
        frame: {
          id: "ads",
          parentId: "main",
          loaderId: "loader-ads-2",
          url: "https://ads.example/two",
          securityOrigin: "https://ads.example",
          mimeType: "text/html",
        },
      },
      "ads-session",
    );
    cdp.event(
      "Page.frameAttached",
      { frameId: "ads-inner", parentFrameId: "ads" },
      "ads-session",
    );
    cdp.event(
      "Page.frameNavigated",
      {
        frame: {
          id: "ads-inner",
          parentId: "ads",
          loaderId: "loader-inner-2",
          url: "https://ads.example/inner",
          securityOrigin: "https://ads.example",
          mimeType: "text/html",
        },
      },
      "ads-session",
    );
    await settle();
    await frames.bind(step());
    expect(bound()).toEqual(["card", "ads", "ads-inner", "ads", "ads-inner"]);
    // A frame that went takes its binding with it.
    cdp.event("Page.frameDetached", { frameId: "card", reason: "remove" });
    await settle();
    await frames.bind(step());
    expect(bound()).toEqual(["card", "ads", "ads-inner", "ads", "ads-inner"]);
    expect(frames.pathOf("card")).toBeUndefined();
  });

  it("answers stale_ref with frame after a ref's frame navigates or detaches", async () => {
    const { cdp, refs, frames } = await open({
      trees: {
        "": [
          { id: "main", url: "https://shop.example/" },
          { id: "card", parentId: "main", url: "https://shop.example/card" },
          { id: "ads", parentId: "main", url: "https://ads.example/" },
        ],
      },
      owners: {
        card: { local: "0", readable: true },
        ads: { local: "1" },
      },
    });
    await frames.bind(step());
    frames.setHome("@e1", "card");
    frames.setHome("@e2", "ads");
    expect(refs.home("tab-1", "@e1")).toEqual({
      frameId: "card",
      loaderId: "loader-card",
      group: "",
    });
    // The path the ref carries now, and the group it was issued in.
    expect(frames.homeFrame("@e1")).toEqual({
      frameId: "card",
      path: "0",
      group: "",
    });
    expect(frames.homeFrame("@e9")).toBeUndefined();
    // A navigation inside the same document keeps the frame's refs.
    cdp.event("Page.navigatedWithinDocument", {
      frameId: "card",
      url: "https://shop.example/card#paid",
    });
    await settle();
    expect(frames.homeFrame("@e1")).toEqual({
      frameId: "card",
      path: "0",
      group: "",
    });
    cdp.event("Page.frameNavigated", {
      frame: {
        id: "card",
        parentId: "main",
        loaderId: "loader-card-2",
        url: "https://shop.example/card",
        securityOrigin: "https://shop.example",
        mimeType: "text/html",
      },
    });
    await settle();
    const stale = thrown(() => frames.homeFrame("@e1"));
    expect([stale.code, stale.status, stale.message]).toEqual([
      "stale_ref",
      409,
      "This element's frame changed. Take a new snapshot.",
    ]);
    expect(stale.fields).toEqual({ ref: "@e1", frame: "0" });
    cdp.event("Page.frameDetached", { frameId: "ads", reason: "remove" });
    await settle();
    expect(thrown(() => frames.homeFrame("@e2")).fields).toEqual({
      ref: "@e2",
      frame: "1",
    });
  });

  it("blocks extension, PDF viewer, internal and file frames with their subtrees", async () => {
    const { cdp, frames } = await open({
      trees: {
        "": [
          { id: "main", url: "https://shop.example/" },
          {
            id: "ext",
            parentId: "main",
            url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html",
          },
          {
            id: "ext-inner",
            parentId: "ext",
            url: "https://shop.example/inside",
          },
          {
            id: "pdf",
            parentId: "main",
            url: `chrome-extension://${PDF_VIEWER_ID}/index.html`,
          },
          { id: "internal", parentId: "main", url: "chrome://settings/" },
          {
            id: "file",
            parentId: "main",
            url: "file:///Users/person/page.html",
            origin: "file://",
          },
        ],
      },
      owners: { ext: { local: "0" } },
    });
    expect((await frames.groups(step())).map((group) => group.path)).toEqual([
      "",
    ]);
    expect(sentTo(cdp, "DOM.getFrameOwner")).toEqual([]);
    for (const frameId of ["ext", "ext-inner", "pdf", "internal", "file"])
      expect(frames.contentOf(frameId), frameId).toBe("blocked");
    const { paths, unread } = await readPaths(frames);
    expect(paths).toEqual([""]);
    expect(unread).toEqual([]);
    expect(frames.contentOf("main")).toBe("read");
  });

  it("marks frames past 32 groups or 8 levels as limit and counts them", async () => {
    const siblings = Array.from(
      { length: READ_LIMITS.groups + 1 },
      (_, at) => ({
        id: `f${at}`,
        parentId: "main",
        url: `https://s${at}.example/`,
      }),
    );
    const flat = await open({
      trees: {
        "": [{ id: "main", url: "https://shop.example/" }, ...siblings],
      },
      owners: Object.fromEntries(
        siblings.map((frame, at) => [frame.id, { local: String(at) }]),
      ),
    });
    const wide = await readPaths(flat.frames);
    expect(wide.paths).toHaveLength(READ_LIMITS.groups + 1);
    expect(wide.unread).toEqual([
      {
        frameId: `f${READ_LIMITS.groups}`,
        local: String(READ_LIMITS.groups),
        content: "limit",
      },
    ]);
    expect(flat.frames.contentOf(`f${READ_LIMITS.groups}`)).toBe("limit");

    // Nine levels of frames from other origins, counted from the scope.
    const nested = Array.from({ length: READ_LIMITS.levels + 1 }, (_, at) => ({
      id: `n${at + 1}`,
      parentId: at === 0 ? "main" : `n${at}`,
      url: `https://n${at + 1}.example/`,
    }));
    const deep = await open({
      trees: { "": [{ id: "main", url: "https://shop.example/" }, ...nested] },
      owners: Object.fromEntries(
        nested.map((frame) => [frame.id, { local: "0" }]),
      ),
    });
    const tall = await readPaths(deep.frames);
    expect(tall.paths).toHaveLength(READ_LIMITS.levels + 1);
    expect(tall.unread).toEqual([
      {
        frameId: `n${READ_LIMITS.levels + 1}`,
        local: "0",
        content: "limit",
      },
    ]);
  });

  it("lists a frame silent for 2000 ms as unavailable and keeps it so for 10 s unless a ready probe answers", async () => {
    let answers = false;
    const { cdp, frames } = await open({
      trees: {
        "": [
          { id: "main", url: "https://shop.example/" },
          { id: "slow", parentId: "main", url: "https://slow.example/" },
          { id: "fast", parentId: "main", url: "https://fast.example/" },
        ],
      },
      owners: { slow: { local: "0" }, fast: { local: "1" } },
      // A silent frame answers no probe at all, so the probe's own bound is
      // what ends it.
      operations: ({ op }) =>
        op !== "ready" ? undefined : answers ? { ok: true } : HOLD,
    });
    const probes = () =>
      sentTo(cdp, "Runtime.evaluate").filter((command) =>
        String(command.params.expression).includes('"ready"'),
      ).length;
    const started: string[] = [];
    const finished: [string, number][] = [];
    const read = (hang: boolean) =>
      frames.read(reading(), async (group) => {
        started.push(group.root);
        if (hang && group.root === "slow") await new Promise(() => {});
        finished.push([group.root, Date.now()]);
        return group.path;
      });

    const at = Date.now();
    const first = read(true);
    // Each read reaches its own page work before the clock moves on, and a
    // timer made during an advance fires in the next one.
    await settle();
    await vi.advanceTimersByTimeAsync(READ_LIMITS.perGroupMs - 1);
    await vi.advanceTimersByTimeAsync(1);
    const done = await first;
    expect(done.results.map((result) => result.group.root)).toEqual([
      "main",
      "fast",
    ]);
    expect(done.unread).toEqual([
      { frameId: "slow", local: "0", content: "unavailable" },
    ]);
    // The silent frame held nothing else up.
    expect(finished).toEqual([
      ["main", at],
      ["fast", at],
    ]);
    expect(frames.contentOf("slow")).toBe("unavailable");

    // A probe that does not answer leaves it unavailable, without a read.
    started.length = 0;
    const second = read(false);
    await settle();
    await vi.advanceTimersByTimeAsync(READY_PROBE_MS - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await second).unread).toEqual([
      { frameId: "slow", local: "0", content: "unavailable" },
    ]);
    expect(started).toEqual(["main", "fast"]);
    expect(probes()).toBe(1);

    // A probe that answers clears the silence early.
    answers = true;
    started.length = 0;
    expect((await read(false)).unread).toEqual([]);
    expect([...started].sort()).toEqual(["fast", "main", "slow"]);
    expect(probes()).toBe(2);
    expect(frames.contentOf("slow")).toBe("read");

    // Past the silence, a group is read again without a probe.
    const third = read(true);
    await settle();
    await vi.advanceTimersByTimeAsync(READ_LIMITS.perGroupMs - 1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await third).unread).toEqual([
      { frameId: "slow", local: "0", content: "unavailable" },
    ]);
    await vi.advanceTimersByTimeAsync(SILENT_FOR_MS);
    started.length = 0;
    expect((await read(false)).unread).toEqual([]);
    expect([...started].sort()).toEqual(["fast", "main", "slow"]);
    expect(probes()).toBe(2);
  });

  it("keeps at most 4 reads in flight", async () => {
    const siblings = Array.from({ length: 12 }, (_, at) => ({
      id: `f${at}`,
      parentId: "main",
      url: `https://s${at}.example/`,
    }));
    const { frames } = await open({
      trees: {
        "": [{ id: "main", url: "https://shop.example/" }, ...siblings],
      },
      owners: Object.fromEntries(
        siblings.map((frame, at) => [frame.id, { local: String(at) }]),
      ),
    });
    const pending: (() => void)[] = [];
    let live = 0;
    let peak = 0;
    const done = frames.read(
      reading(),
      (group) =>
        new Promise<string>((resolve) => {
          live += 1;
          peak = Math.max(peak, live);
          pending.push(() => {
            live -= 1;
            resolve(group.path);
          });
        }),
    );
    for (let round = 0; round < 40; round += 1) {
      await settle();
      for (const finish of pending.splice(0)) finish();
    }
    expect((await done).results).toHaveLength(13);
    expect(peak).toBe(READ_LIMITS.inFlight);
  });

  it("follows focus through two owners", async () => {
    const focus: Record<string, unknown> = {
      main: { ok: true, path: "1", key: "outer", editable: false },
      outer: { ok: true, path: "0", key: "inner", editable: false },
      inner: { ok: true, path: "", editable: true },
    };
    const { frames } = await open({
      trees: {
        "": [{ id: "main", url: "https://shop.example/" }],
        "outer-session": [
          { id: "outer", parentId: "main", url: "https://outer.example/" },
          { id: "inner", parentId: "outer", url: "https://inner.example/" },
        ],
      },
      owners: {
        outer: { local: "1" },
        inner: { local: "0" },
      },
      targets: [
        {
          sessionId: "outer-session",
          frameId: "outer",
          url: "https://outer.example/",
        },
      ],
      operations: ({ op, frameId }) =>
        op === "activeFrame" ? focus[frameId] : undefined,
    });
    expect(await frames.focusedFrame(step())).toEqual({
      frameId: "inner",
      path: "1/0",
      blocked: false,
      editable: true,
    });
    // A frame agents never enter ends the walk where it stands.
    focus.inner = {
      ok: true,
      path: "2",
      editable: false,
      blocked: true,
    };
    expect(await frames.focusedFrame(step())).toEqual({
      frameId: "inner",
      path: "1/0/2",
      blocked: true,
      editable: false,
    });
  });

  it("ownerChain gives the owner boxes outermost first", async () => {
    const { frames } = await open({
      trees: {
        "": [{ id: "main", url: "https://shop.example/" }],
        "outer-session": [
          { id: "outer", parentId: "main", url: "https://outer.example/" },
          { id: "inner", parentId: "outer", url: "https://inner.example/" },
          { id: "leaf", parentId: "inner", url: "https://inner.example/leaf" },
        ],
      },
      owners: {
        outer: { local: "1" },
        inner: { local: "0" },
        leaf: { local: "0", readable: true },
      },
      targets: [
        {
          sessionId: "outer-session",
          frameId: "outer",
          url: "https://outer.example/",
        },
      ],
    });
    await frames.bind(step());
    const chain = (frameId: string) =>
      frames.ownerChain(frameId).map((owner) => [owner.key, owner.local]);
    // One binding per boundary: the frames inside a group are the page's own
    // work, so only its root's owner is on the chain.
    expect(chain("leaf")).toEqual([
      ["outer", "1"],
      ["inner", "0"],
    ]);
    expect(chain("inner")).toEqual([
      ["outer", "1"],
      ["inner", "0"],
    ]);
    expect(chain("outer")).toEqual([["outer", "1"]]);
    expect(chain("main")).toEqual([]);
    const outer: GroupInfo | undefined = frames.groupOf("inner");
    expect(outer?.path).toBe("1/0");
  });
});
