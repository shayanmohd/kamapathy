// The main process side of a page operation with targets: the accessibility
// filter, picking role nodes into Kamapathy's world, ref blocks and the
// fields a failure carries, over the scripted debugger of tests/fake-cdp.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  axSources,
  matchRole,
  readAx,
  type AxSource,
} from "../electron/agent/accessibility";
import { toApiError } from "../electron/agent/errors";
import { CANDIDATE_REFS, REF_BLOCK, RefBook } from "../electron/agent/refs";
import {
  LEVELS,
  createResolver,
  waitMode,
  type Resolver,
} from "../electron/agent/resolve";
import { EventBufferPool } from "../electron/agent/session/event-buffer";
import { TabSession } from "../electron/agent/session/tab-session";
import type {
  KnownFrame,
  SessionHost,
  Step,
} from "../electron/agent/session/types";
import { parseSelector } from "../electron/agent/selectors";
import { FakeHost, type FakeDebugger } from "./fake-cdp";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(0);
const step = (): Step => ({ deadline: Date.now() + 10000 });

// An Accessibility.getFullAXTree node as Chromium reports it.
const axNode = (input: {
  nodeId: string;
  role?: string;
  name?: string;
  backend?: number;
  parentId?: string;
  ignored?: boolean;
  editable?: boolean;
}) => ({
  nodeId: input.nodeId,
  ignored: input.ignored ?? false,
  ...(input.role === undefined
    ? {}
    : { role: { type: "role", value: input.role } }),
  ...(input.name === undefined
    ? {}
    : { name: { type: "computedString", value: input.name } }),
  ...(input.backend === undefined ? {} : { backendDOMNodeId: input.backend }),
  ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
  ...(input.editable
    ? {
        properties: [
          { name: "editable", value: { type: "token", value: "richtext" } },
        ],
      }
    : {}),
});
const frame = (
  input: Partial<KnownFrame> & { frameId: string },
): KnownFrame => ({
  origin: "https://example.com",
  loaderId: "loader-1",
  crossOrigin: false,
  ownSession: false,
  blocked: false,
  unavailable: false,
  ...input,
});
// A target the way validation will send one: the selector as written with
// the parsed query beside it, which the resolver completes.
const ask = (
  selector: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => {
  const parsed = parseSelector(selector);
  if (!parsed.ok) throw new Error(`${selector}: ${parsed.problem.message}`);
  if (parsed.ast.kind === "ref") throw new Error(`${selector} is a ref`);
  return { selector, query: { ast: parsed.ast, ...extra } };
};

function open() {
  const host = new FakeHost();
  const session = new TabSession(host as unknown as SessionHost, {
    tabId: "tab-1",
    waitForSpaceIdle: async () => {},
    buffer: new EventBufferPool().create("tab-1"),
  });
  return { host, cdp: host.debugger, session };
}
async function ready() {
  const opened = open();
  opened.session.attach();
  await settle();
  expect(opened.session.state).toBe("ready");
  const refs = new RefBook();
  const resolver = createResolver({ refs });
  return { ...opened, refs, resolver };
}
// What a page operation answers, so a run can be driven to its end.
const pageReply = (value: unknown) => ({ result: { value } });
// The tree, resolve and pick replies a role resolution needs.
function roleReplies(
  cdp: FakeDebugger,
  nodes: object[],
  options: { resolve?: (backendNodeId: number) => unknown } = {},
) {
  cdp.reply("Accessibility.getFullAXTree", () => ({ nodes }));
  cdp.reply("DOM.resolveNode", (params) => {
    const answer = options.resolve?.(params.backendNodeId);
    if (answer !== undefined) return answer;
    return { object: { objectId: `object-${params.backendNodeId}` } };
  });
  cdp.reply("Runtime.callFunctionOn", () => pageReply(0));
}
// Everything a run sent, so the order of a resolution can be read.
const after = (cdp: FakeDebugger, from: number) => cdp.sent.slice(from);
const methodsAfter = (cdp: FakeDebugger, from: number) =>
  after(cdp, from).map((command) => command.method);
const runOptions = (extra: Record<string, unknown> = {}) => ({
  deadline: Date.now() + 10000,
  namespace: "test:tab-1:0",
  ...extra,
});

describe("accessibility filtering", () => {
  const NODES = [
    axNode({ nodeId: "1", role: "RootWebArea", name: "Roles", backend: 1 }),
    axNode({
      nodeId: "2",
      role: "button",
      name: "Match Alpha",
      backend: 2,
      parentId: "1",
    }),
    axNode({
      nodeId: "3",
      role: "StaticText",
      name: "Match Alpha",
      backend: 3,
      parentId: "2",
    }),
    axNode({
      nodeId: "4",
      role: "InlineTextBox",
      name: "Match Alpha",
      parentId: "3",
    }),
    axNode({ nodeId: "5", role: "ListMarker", parentId: "1" }),
    axNode({
      nodeId: "6",
      role: "StaticText",
      name: "Ghost",
      backend: 6,
      parentId: "1",
      ignored: true,
    }),
    axNode({
      nodeId: "7",
      role: "DisclosureTriangle",
      name: "More",
      backend: 7,
      parentId: "1",
    }),
    axNode({
      nodeId: "8",
      role: "LayoutTableCell",
      name: "",
      backend: 8,
      parentId: "1",
    }),
    axNode({ nodeId: "9", role: "generic", backend: 9, parentId: "1" }),
    axNode({
      nodeId: "10",
      role: "generic",
      name: "Notes",
      backend: 10,
      parentId: "9",
      editable: true,
    }),
    axNode({
      nodeId: "11",
      role: "generic",
      name: "Inner",
      backend: 11,
      parentId: "10",
      editable: true,
    }),
    axNode({
      nodeId: "12",
      role: "button",
      name: "Match Alpha",
      backend: 12,
      parentId: "1",
    }),
    axNode({
      nodeId: "13",
      role: "image",
      name: "Logo",
      backend: 13,
      parentId: "1",
    }),
    axNode({
      nodeId: "14",
      role: "textbox",
      name: "Field",
      backend: 14,
      parentId: "1",
    }),
  ];
  const backends = (
    found: { entry: { backendNodeId: number }; editable: boolean }[],
  ) => found.map(({ entry }) => entry.backendNodeId);

  it("filters the accessibility tree by role, alias and name", async () => {
    const { session, cdp } = await ready();
    cdp.reply("Accessibility.getFullAXTree", () => ({ nodes: NODES }));
    const source: AxSource = {};
    const entries = await readAx(session, [source], step());
    // Ignored nodes and nodes without a DOM node of their own are gone.
    expect(entries.map((entry) => entry.backendNodeId)).toEqual([
      1, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14,
    ]);
    expect(entries.every((entry) => entry.source === source)).toBe(true);
    expect(entries.map((entry) => entry.role)).toEqual([
      "rootwebarea",
      "button",
      "statictext",
      "disclosuretriangle",
      "layouttablecell",
      "generic",
      "generic",
      "generic",
      "button",
      "image",
      "textbox",
    ]);
    // Only the outermost editing host counts as one.
    expect(
      entries
        .filter((entry) => entry.editableRoot)
        .map((entry) => entry.backendNodeId),
    ).toEqual([10]);
    expect(backends(matchRole(entries, "button"))).toEqual([2, 7, 12]);
    expect(backends(matchRole(entries, "cell"))).toEqual([8]);
    expect(backends(matchRole(entries, "img"))).toEqual([13]);
    // An exact name is Chromium's computed name, character for character.
    expect(
      backends(
        matchRole(entries, "button", { value: "Match Alpha", match: "exact" }),
      ),
    ).toEqual([2]);
    expect(
      backends(
        matchRole(entries, "button", {
          value: "Match Alpha",
          match: "exact",
        }),
      ),
    ).toEqual([12]);
    expect(
      backends(
        matchRole(entries, "button", { value: "MATCH ALPHA", match: "exact" }),
      ),
    ).toEqual([]);
    // A part is normalized and compared without case on both sides.
    expect(
      backends(
        matchRole(entries, "button", {
          value: " match  alpha ",
          match: "contains",
        }),
      ),
    ).toEqual([2, 12]);
    // An editing host stands in for a textbox, and says so.
    expect(matchRole(entries, "textbox")).toMatchObject([
      { entry: { backendNodeId: 10 }, editable: true },
      { entry: { backendNodeId: 14 }, editable: false },
    ]);
    expect(
      backends(
        matchRole(entries, "textbox", { value: "Notes", match: "exact" }),
      ),
    ).toEqual([10]);
  });

  it("queries the top document with {} and same-origin frames with {frameId}, never cross-origin, blocked, unavailable or out-of-process frames", () => {
    const frames = [
      frame({ frameId: "main" }),
      frame({ frameId: "same", parentFrameId: "main" }),
      frame({ frameId: "deep", parentFrameId: "same" }),
      frame({
        frameId: "other",
        parentFrameId: "main",
        origin: "https://frame.example",
        crossOrigin: true,
      }),
      // Same origin as its parent, but that parent is another site's.
      frame({
        frameId: "inOther",
        parentFrameId: "other",
        origin: "https://frame.example",
      }),
      frame({
        frameId: "oop",
        parentFrameId: "main",
        origin: "https://oop.example",
        sessionId: "child-1",
        crossOrigin: true,
      }),
      frame({
        frameId: "extension",
        parentFrameId: "main",
        origin: "chrome-extension://id",
        crossOrigin: true,
        blocked: true,
      }),
      frame({ frameId: "gone", parentFrameId: "main", unavailable: true }),
      frame({ frameId: "orphan", parentFrameId: "missing" }),
    ];
    expect(axSources(frames, "main")).toEqual([
      {},
      { frameId: "same" },
      { frameId: "deep" },
    ]);
  });
});

describe("resolving targets", () => {
  it("picks role nodes on the page session into the main frame's world, then sends Accessibility.enable then Accessibility.disable and releases the object group, also when the operation fails", async () => {
    const { session, cdp, resolver } = await ready();
    roleReplies(cdp, [
      axNode({ nodeId: "1", role: "button", name: "Save", backend: 11 }),
      axNode({
        nodeId: "2",
        role: "generic",
        name: "Save",
        backend: 12,
        parentId: "1",
        editable: true,
      }),
    ]);
    const TAIL = [
      "Runtime.evaluate",
      "Runtime.releaseObjectGroup",
      "Accessibility.enable",
      "Accessibility.disable",
    ];
    cdp.reply("Runtime.evaluate", () => pageReply({ ok: true, x: 4, y: 6 }));
    let from = cdp.sent.length;
    const payload = ask('role=textbox[name="Save"]');
    expect(
      await resolver.run("tab-1", session, "target", payload, runOptions()),
    ).toEqual({ ok: true, x: 4, y: 6 });
    expect(methodsAfter(cdp, from)).toEqual([
      "Page.createIsolatedWorld",
      "Accessibility.getFullAXTree",
      "DOM.resolveNode",
      "Runtime.callFunctionOn",
      ...TAIL,
    ]);
    const sent = after(cdp, from);
    const group = sent[2].params.objectGroup as string;
    expect(group).toMatch(/^kamapathy-pick-\d+$/);
    // The owning frame's world, on the session that reported the node.
    expect(sent[2]).toEqual({
      method: "DOM.resolveNode",
      params: { backendNodeId: 12, executionContextId: 1, objectGroup: group },
    });
    const pick = sent[3].params;
    const key = `${group}-0`;
    expect(pick.executionContextId).toBe(1);
    expect(pick.functionDeclaration).toContain("__kamapathyPicked");
    expect(pick.arguments).toEqual([
      { value: key },
      { value: [1] },
      { objectId: "object-12" },
    ]);
    expect(pick).toMatchObject({ returnByValue: true, silent: true });
    // The page is told which entries to take, and the group is released.
    expect(sent[4].params.expression).toContain(key);
    expect(sent[5].params).toEqual({ objectGroup: group });
    expect((payload.query as { picked?: string }).picked).toBe(key);

    // A page failure and a thrown error tidy up the same way.
    cdp.reply("Runtime.evaluate", () =>
      pageReply({ ok: false, code: "no_match", error: "Nothing matches." }),
    );
    from = cdp.sent.length;
    expect(
      await resolver.run(
        "tab-1",
        session,
        "target",
        ask("role=button"),
        runOptions(),
      ),
    ).toMatchObject({ ok: false, code: "no_match" });
    expect(methodsAfter(cdp, from).slice(-TAIL.length)).toEqual(TAIL);
    cdp.reply("Runtime.evaluate", () => {
      throw new Error("boom");
    });
    from = cdp.sent.length;
    await expect(
      resolver.run(
        "tab-1",
        session,
        "target",
        ask("role=button"),
        runOptions(),
      ),
    ).rejects.toThrow("boom");
    expect(methodsAfter(cdp, from).slice(-TAIL.length)).toEqual(TAIL);
  });

  it("maps a node from another document to page_changed and drops nodes whose resolveNode finds none", async () => {
    const { session, cdp, resolver } = await ready();
    const nodes = [
      axNode({ nodeId: "1", role: "button", name: "Save", backend: 11 }),
      axNode({ nodeId: "2", role: "button", name: "Save", backend: 12 }),
    ];
    roleReplies(cdp, nodes, {
      resolve: (backendNodeId) => {
        if (backendNodeId === 11)
          throw new Error("No node with given id found");
        return undefined;
      },
    });
    cdp.reply("Runtime.evaluate", () => pageReply({ ok: true, x: 1, y: 2 }));
    const from = cdp.sent.length;
    expect(
      await resolver.run(
        "tab-1",
        session,
        "target",
        ask("role=button"),
        runOptions(),
      ),
    ).toMatchObject({ ok: true });
    const pick = after(cdp, from).find(
      (command) => command.method === "Runtime.callFunctionOn",
    )!;
    expect(pick.params.arguments.slice(1)).toEqual([
      { value: [0] },
      { objectId: "object-12" },
    ]);
    roleReplies(cdp, nodes, {
      resolve: () => {
        throw new Error("Node with given id does not belong to the document");
      },
    });
    const failure = await resolver
      .run("tab-1", session, "target", ask("role=button"), runOptions())
      .catch((error: unknown) => error);
    expect(toApiError(failure)?.code).toBe("page_changed");
  });

  it("fails at once with dialog_open while a dialog is open, before any Accessibility command is sent", async () => {
    const { session, cdp, resolver } = await ready();
    roleReplies(cdp, [
      axNode({ nodeId: "1", role: "button", name: "Save", backend: 11 }),
    ]);
    cdp.reply("Runtime.evaluate", () => pageReply({ ok: true }));
    cdp.event("Page.javascriptDialogOpening", {
      url: "https://example.com/",
      frameId: "main",
      message: "Saved",
      type: "alert",
      hasBrowserHandler: true,
      defaultPrompt: "",
    });
    const from = cdp.sent.length;
    const failure = await resolver
      .run("tab-1", session, "target", ask("role=button"), runOptions())
      .catch((error: unknown) => error);
    expect(toApiError(failure)?.code).toBe("dialog_open");
    expect(methodsAfter(cdp, from)).not.toContain(
      "Accessibility.getFullAXTree",
    );
    expect(methodsAfter(cdp, from)).not.toContain("Accessibility.enable");
  });

  it("classifies refs and reserves blocks before page work, and records only issued numbers inside this call's blocks", async () => {
    const { session, cdp, refs, resolver } = await ready();
    let from = cdp.sent.length;
    // A ref the tab was never issued never reaches the page.
    await expect(
      resolver.run("tab-1", session, "focus", { ref: "@e7" }, runOptions()),
    ).rejects.toMatchObject({ code: "unknown_ref", fields: { ref: "@e7" } });
    expect(methodsAfter(cdp, from)).toEqual([]);

    const payload: Record<string, unknown> = {
      ...ask("#save"),
      maxChars: 100,
      maxControls: 10,
    };
    // The page reports refs once the blocks are reserved and sent to it.
    const firstRefs = () => ({
      candidates: (payload.query as { firstRef: number }).firstRef,
      block: payload.firstRef as number,
    });
    cdp.reply("Runtime.evaluate", () => {
      const { candidates, block } = firstRefs();
      return pageReply({
        ok: true,
        interactables: [],
        issued: [candidates, block, block + REF_BLOCK, 9999],
      });
    });
    const listing = await resolver.run(
      "tab-1",
      session,
      "snapshot",
      payload,
      runOptions(),
    );
    const { candidates, block } = firstRefs();
    // The candidate refs of the strict query, then the snapshot's block.
    expect(block).toBe(candidates + CANDIDATE_REFS);
    expect(payload.query).toMatchObject({ mode: "strict", level: "none" });
    expect(LEVELS.snapshot).toBe("none");
    expect(listing).toEqual({ ok: true, interactables: [] });
    expect(refs.classify("tab-1", `@e${candidates}`)).toBe("live");
    expect(refs.classify("tab-1", `@e${block}`)).toBe("live");
    // Numbers outside the blocks this call reserved are not this tab's.
    expect(refs.classify("tab-1", `@e${block + REF_BLOCK}`)).toBe("unknown");
    expect(refs.classify("tab-1", "@e9999")).toBe("unknown");
  });

  it("gives an invalid_selector failure the forms and a no_match failure how long it waited", async () => {
    const { session, cdp, resolver } = await ready();
    cdp.reply("Runtime.evaluate", () =>
      pageReply({
        ok: false,
        code: "invalid_selector",
        error: "The page rejected this CSS selector.",
        fields: { selector: "div[", reason: "css" },
      }),
    );
    const invalid = await resolver.run(
      "tab-1",
      session,
      "focus",
      ask("div["),
      runOptions(),
    );
    expect(invalid.fields).toMatchObject({
      selector: "div[",
      reason: "css",
      forms: expect.arrayContaining(['role=button[name="Save"]']),
    });
    cdp.reply("Runtime.evaluate", () =>
      pageReply({
        ok: false,
        code: "no_match",
        error: "Nothing on the page matches this selector.",
        fields: { selector: "#gone" },
      }),
    );
    const none = await resolver.run(
      "tab-1",
      session,
      "focus",
      ask("#gone"),
      runOptions(),
    );
    expect(none.fields).toMatchObject({ selector: "#gone" });
    expect(
      (none.fields as { waitedMs: number }).waitedMs,
    ).toBeGreaterThanOrEqual(0);
  });

  it("picks each wait's mode and level from its form and state", () => {
    const astOf = (selector: string) => {
      const parsed = parseSelector(selector);
      if (!parsed.ok || parsed.ast.kind === "ref")
        throw new Error(`${selector} is not a search`);
      return parsed.ast;
    };
    const raw = astOf("#save");
    const filtered = astOf('#save:has-text("Save")');
    const role = astOf("role=button");
    const xpath = astOf("//button");
    expect(waitMode(raw, "attached")).toEqual({ mode: "first", level: "none" });
    expect(waitMode(raw, "visible")).toEqual({
      mode: "first",
      level: "visible",
    });
    expect(waitMode(xpath, "visible")).toEqual({
      mode: "first",
      level: "visible",
    });
    expect(waitMode(filtered, "visible")).toEqual({
      mode: "strict",
      level: "visible",
    });
    expect(waitMode(role, "attached")).toEqual({
      mode: "strict",
      level: "none",
    });
    expect(waitMode(role, "hidden")).toEqual({
      mode: "count",
      level: "visible",
    });
    expect(waitMode(role, "detached")).toEqual({
      mode: "count",
      level: "none",
    });
  });
});
