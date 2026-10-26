// Section 5's guards over a tab session that answers the two DOM commands
// they send. Nothing here reaches a real page: each spot says what the hit
// test finds at a point, at the author level and inside the user agent's
// shadow DOM.
import { describe, expect, it } from "vitest";
import { ApiError } from "../electron/agent/errors";
import {
  PICKER_ALT_KEYS,
  PICKER_KEY_NAMES,
  PICKER_MAC_KEYS,
  blockedFrames,
  checkKeyTarget,
  checkPointerTarget,
  hitNodeAt,
  pickerKindOf,
  pickerUse,
} from "../electron/agent/input/guards";
import { parseChord } from "../electron/agent/input/keys";
import type { TabSession } from "../electron/agent/session/tab-session";
import type { KnownFrame, Step } from "../electron/agent/session/types";

const MAIN = "main-frame";
type FakeNode = {
  nodeName: string;
  attributes?: Record<string, string>;
  // The frame a frame owner holds, as DOM.describeNode reports it.
  frameId?: string;
};
type Spot = {
  x: number;
  y: number;
  // The frame the hit belongs to, as DOM.getNodeForLocation reports it.
  frameId?: string;
  author: FakeNode;
  shadow?: FakeNode;
};
const known = (
  frameId: string,
  extra: Partial<KnownFrame> = {},
): KnownFrame => ({
  frameId,
  origin: "http://example.com",
  loaderId: "loader-1",
  crossOrigin: false,
  ownSession: false,
  blocked: false,
  unavailable: false,
  ...extra,
});
const flat = (attributes: Record<string, string> = {}) =>
  Object.entries(attributes).flat();
const step = (): Step => ({ deadline: Date.now() + 5000 });

// A tab whose page answers DOM.getNodeForLocation and DOM.describeNode from
// the spots given, and refuses every other command.
const tab = (
  options: {
    spots?: Spot[];
    frames?: KnownFrame[];
    // The frame paths the registry works out, which a refusal names.
    paths?: Record<string, string>;
    broken?: unknown;
  } = {},
) => {
  const sent: { method: string; params: Record<string, any> }[] = [];
  const nodes = new Map<number, FakeNode>();
  const hits = new Map<string, { id: number; frameId?: string }>();
  let next = 1;
  const record = (node: FakeNode) => {
    const id = next++;
    nodes.set(id, node);
    return id;
  };
  for (const spot of options.spots ?? []) {
    const author = record(spot.author);
    const shadow = spot.shadow ? record(spot.shadow) : author;
    hits.set(`${spot.x},${spot.y},false`, {
      id: author,
      frameId: spot.frameId,
    });
    hits.set(`${spot.x},${spot.y},true`, { id: shadow, frameId: spot.frameId });
  }
  const session = {
    knownFrames: async () => options.frames ?? [known(MAIN)],
    frames: async () =>
      Object.entries(options.paths ?? {}).map(([frameId, path]) => ({
        frameId,
        path,
      })),
    send: async (
      method: string,
      params: Record<string, any> = {},
      sending?: Step,
    ) => {
      sending?.guard?.();
      sent.push({ method, params });
      if (options.broken !== undefined) throw options.broken;
      if (method === "DOM.getNodeForLocation") {
        const found = hits.get(
          `${params.x},${params.y},${params.includeUserAgentShadowDOM === true}`,
        );
        if (!found) throw new Error("No node found at given location");
        return {
          backendNodeId: found.id,
          ...(found.frameId === undefined ? {} : { frameId: found.frameId }),
        };
      }
      if (method === "DOM.describeNode") {
        const node = nodes.get(params.backendNodeId);
        if (!node) throw new Error("Could not find node with given id");
        return {
          node: {
            nodeType: 1,
            nodeName: node.nodeName.toUpperCase(),
            attributes: flat(node.attributes),
            ...(node.frameId === undefined ? {} : { frameId: node.frameId }),
          },
        };
      }
      throw new Error(`No reply for ${method}`);
    },
  } as unknown as TabSession;
  return { session, sent };
};
// What a check refused, or a failure when it let the input through.
const refusal = async (running: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof running === "function" ? running() : running);
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("The guard let the input through.");
};
// What a synchronous check refused.
function refusalOf(run: () => void): ApiError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("The guard let the key through.");
}
const press = (
  session: TabSession,
  point: { x: number; y: number },
  extra: {
    button?: "left" | "middle" | "right";
    platform?: NodeJS.Platform;
  } = {},
) =>
  checkPointerTarget(session, point, step(), {
    button: extra.button ?? "left",
    press: true,
    platform: extra.platform ?? "darwin",
  });

// A page with one control of each kind the guards care about.
const CONTROLS: Spot[] = [
  {
    x: 10,
    y: 10,
    frameId: MAIN,
    author: { nodeName: "select", attributes: { id: "city" } },
    shadow: {
      nodeName: "div",
      attributes: { pseudo: "-internal-select-inner-element" },
    },
  },
  {
    x: 20,
    y: 10,
    frameId: MAIN,
    author: { nodeName: "select", attributes: { id: "several", multiple: "" } },
    shadow: {
      nodeName: "span",
      attributes: { pseudo: "-internal-option-label-container" },
    },
  },
  {
    x: 30,
    y: 10,
    frameId: MAIN,
    author: { nodeName: "select", attributes: { id: "sized", size: "3" } },
  },
  {
    x: 40,
    y: 10,
    frameId: MAIN,
    author: { nodeName: "input", attributes: { id: "tint", type: "color" } },
    shadow: { nodeName: "div", attributes: { pseudo: "-webkit-color-swatch" } },
  },
  // A date input: the picker only opens from its indicator, never from the
  // fields that take typing.
  {
    x: 50,
    y: 10,
    frameId: MAIN,
    author: { nodeName: "input", attributes: { id: "day", type: "date" } },
    shadow: {
      nodeName: "div",
      attributes: { pseudo: "-webkit-calendar-picker-indicator", id: "picker" },
    },
  },
  {
    x: 60,
    y: 10,
    frameId: MAIN,
    author: { nodeName: "input", attributes: { id: "day", type: "date" } },
    shadow: {
      nodeName: "span",
      attributes: { pseudo: "-webkit-datetime-edit-day-field" },
    },
  },
  {
    x: 70,
    y: 10,
    frameId: MAIN,
    author: { nodeName: "input", attributes: { id: "name", type: "text" } },
    shadow: { nodeName: "div" },
  },
  {
    x: 80,
    y: 10,
    frameId: MAIN,
    author: { nodeName: "textarea", attributes: { id: "area" } },
    shadow: { nodeName: "div" },
  },
  {
    x: 90,
    y: 10,
    frameId: MAIN,
    author: {
      nodeName: "div",
      attributes: { id: "notes", contenteditable: "true" },
    },
  },
  {
    x: 100,
    y: 10,
    frameId: MAIN,
    author: { nodeName: "button", attributes: { id: "save" } },
  },
];

describe("the input guards", () => {
  it("refuses a point whose hit belongs to a frame agents may not reach, and allows the readable ones", async () => {
    const spots: Spot[] = [
      // An extension frame's own node, and the owner element of a frame in
      // its own process, which answers the frame it holds.
      {
        x: 10,
        y: 10,
        frameId: "panel",
        author: { nodeName: "div", attributes: { id: "inside" } },
      },
      {
        x: 20,
        y: 10,
        frameId: MAIN,
        author: {
          nodeName: "iframe",
          attributes: { id: "viewer" },
          frameId: "pdf",
        },
      },
      { x: 30, y: 10, frameId: "gone", author: { nodeName: "div" } },
      { x: 40, y: 10, frameId: "stranger", author: { nodeName: "div" } },
      { x: 50, y: 10, frameId: "card", author: { nodeName: "button" } },
      { x: 60, y: 10, author: { nodeName: "button" } },
    ];
    const frames = [
      known(MAIN),
      known("panel", { blocked: true }),
      known("pdf", { blocked: true }),
      known("gone", { unavailable: true }),
      known("card"),
    ];
    // The path each frame carries, which the refusal names.
    const paths = { panel: "0", pdf: "1" };
    for (const point of [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 30, y: 10 },
      { x: 40, y: 10 },
    ]) {
      const { session, sent } = tab({ spots, frames, paths });
      const error = await refusal(press(session, point));
      expect([error.code, error.status]).toEqual(["input_target_blocked", 403]);
      // Section 9 names the frame when the registry can place it.
      expect(error.fields.frame).toBe(
        point.x === 10 ? "0" : point.x === 20 ? "1" : undefined,
      );
      // Nothing but the hit test went out, so no input reached the page.
      expect(sent.map((command) => command.method)).toEqual([
        "DOM.getNodeForLocation",
        "DOM.describeNode",
      ]);
    }
    // A readable frame, and a hit with no frame of its own, are allowed.
    const open = tab({ spots, frames });
    await expect(
      press(open.session, { x: 50, y: 10 }),
    ).resolves.toBeUndefined();
    await expect(
      press(open.session, { x: 60, y: 10 }),
    ).resolves.toBeUndefined();
    // A move is checked too, since hover reaches the frame as well.
    const moving = tab({ spots, frames });
    expect(
      (
        await refusal(
          checkPointerTarget(moving.session, { x: 10, y: 10 }, step(), {
            button: "left",
            press: false,
          }),
        )
      ).code,
    ).toBe("input_target_blocked");
    expect(await blockedFrames(open.session, step())).toEqual(
      new Set(["panel", "pdf", "gone"]),
    );
  });

  it("refuses a press that would open a native select, color or date picker", async () => {
    const use = async (point: { x: number; y: number }) => {
      const { session } = tab({ spots: CONTROLS });
      const error = await refusal(press(session, point));
      expect([error.code, error.status]).toEqual(["native_popup_blocked", 403]);
      return error.fields.use;
    };
    expect(await use({ x: 10, y: 10 })).toBe("selectOption");
    expect(await use({ x: 40, y: 10 })).toBe("fill");
    expect(await use({ x: 50, y: 10 })).toBe("fill");
    // A list box opens nothing, and neither do the date input's own fields.
    const { session } = tab({ spots: CONTROLS });
    for (const point of [
      { x: 20, y: 10 },
      { x: 30, y: 10 },
      { x: 60, y: 10 },
      { x: 70, y: 10 },
      { x: 100, y: 10 },
    ])
      await expect(press(session, point)).resolves.toBeUndefined();
    // A move over a dropdown is fine: nothing opens without a press.
    const hovering = tab({ spots: CONTROLS });
    await expect(
      checkPointerTarget(hovering.session, { x: 10, y: 10 }, step(), {
        button: "left",
        press: false,
      }),
    ).resolves.toBeUndefined();
    expect(
      hovering.sent.filter(
        (command) => command.method === "DOM.getNodeForLocation",
      ).length,
    ).toBe(1);
    // The date input is the one kind that needs the second, deeper hit.
    const dated = tab({ spots: CONTROLS });
    await refusal(press(dated.session, { x: 50, y: 10 }));
    expect(
      dated.sent
        .filter((command) => command.method === "DOM.getNodeForLocation")
        .map((command) => command.params.includeUserAgentShadowDOM),
    ).toEqual([false, true]);
    expect(pickerUse("select")).toBe("selectOption");
    expect(pickerUse("color")).toBe("fill");
    expect(pickerUse("date")).toBe("fill");
  });

  it("refuses a middle press over an editable on Linux only", async () => {
    const editables = [
      { x: 70, y: 10 },
      { x: 80, y: 10 },
      { x: 90, y: 10 },
    ];
    for (const point of editables) {
      const { session } = tab({ spots: CONTROLS });
      const error = await refusal(
        press(session, point, { button: "middle", platform: "linux" }),
      );
      expect([error.code, error.status]).toEqual(["clipboard_blocked", 403]);
    }
    const { session } = tab({ spots: CONTROLS });
    // A button takes a middle press, and so does an editable on the other
    // platforms, where no primary selection is pasted.
    await expect(
      press(
        session,
        { x: 100, y: 10 },
        { button: "middle", platform: "linux" },
      ),
    ).resolves.toBeUndefined();
    for (const platform of ["darwin", "win32"] as const)
      for (const point of editables)
        await expect(
          press(session, point, { button: "middle", platform }),
        ).resolves.toBeUndefined();
    // A left press on an editable is never a clipboard matter.
    await expect(
      press(session, { x: 70, y: 10 }, { button: "left", platform: "linux" }),
    ).resolves.toBeUndefined();
  });

  it("refuses key input in a blocked frame and the key forms that open a picker", () => {
    const chord = (key: string, platform: NodeJS.Platform = "linux") =>
      parseChord(key, platform);
    const blocked = { kind: "other" as const, blockedFrame: true as const };
    const away = refusalOf(() =>
      checkKeyTarget(blocked, chord("KeyA"), "linux"),
    );
    expect([away.code, away.status]).toEqual(["input_target_blocked", 403]);
    // Every focused kind in a blocked frame is refused, picker key or not.
    for (const key of ["Enter", "Tab", "Space"])
      expect(
        refusalOf(() => checkKeyTarget(blocked, chord(key), "linux")).code,
      ).toBe("input_target_blocked");
    const opens = (
      kind: string,
      key: string,
      platform: NodeJS.Platform = "linux",
    ) => {
      try {
        checkKeyTarget({ kind }, chord(key, platform), platform);
        return undefined;
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        const refused = error as ApiError;
        expect([refused.code, refused.status]).toEqual([
          "native_popup_blocked",
          403,
        ]);
        return refused.fields.use;
      }
    };
    for (const key of ["Space", "Enter", "F4", "Alt+ArrowUp", "Alt+ArrowDown"])
      expect([key, opens("select", key)]).toEqual([key, "selectOption"]);
    expect(opens("color", "Space")).toBe("fill");
    expect(opens("date", "F4")).toBe("fill");
    // The bare arrows open a popup on macOS only.
    for (const key of ["ArrowUp", "ArrowDown"]) {
      expect(opens("select", key, "darwin")).toBe("selectOption");
      expect(opens("select", key, "linux")).toBeUndefined();
      expect(opens("select", key, "win32")).toBeUndefined();
    }
    // Keys that open nothing, and kinds with no popup behind them.
    for (const key of ["Tab", "KeyA", "Control+Space", "Shift+Enter", "Escape"])
      expect([key, opens("select", key, "darwin")]).toEqual([key, undefined]);
    for (const kind of ["editable", "other", "none"])
      expect([kind, opens(kind, "Space")]).toEqual([kind, undefined]);
    expect([PICKER_KEY_NAMES, PICKER_ALT_KEYS, PICKER_MAC_KEYS]).toEqual([
      ["Space", "Enter", "F4"],
      ["ArrowUp", "ArrowDown"],
      ["ArrowUp", "ArrowDown"],
    ]);
  });

  it("reads whole coordinates, tells nothing from a failed hit test and passes a refusal on", async () => {
    // The protocol takes whole numbers only, so a point is rounded first.
    const { session, sent } = tab({ spots: CONTROLS });
    await refusal(press(session, { x: 10.4, y: 9.6 }));
    expect(sent[0].params).toMatchObject({
      x: 10,
      y: 10,
      includeUserAgentShadowDOM: false,
    });
    expect(await hitNodeAt(session, { x: 100.2, y: 10 }, step())).toEqual({
      backendNodeId: expect.any(Number),
      frameId: MAIN,
      nodeName: "button",
      attributes: { id: "save" },
      editable: false,
    });
    // A hit test that fails says nothing about the point, so the press goes
    // on. A page the agent may no longer touch still stops it.
    const broken = tab({
      spots: CONTROLS,
      broken: new Error("Invalid parameters"),
    });
    expect(
      await hitNodeAt(broken.session, { x: 10, y: 10 }, step()),
    ).toBeUndefined();
    await expect(
      press(broken.session, { x: 10, y: 10 }),
    ).resolves.toBeUndefined();
    const taken = tab({
      spots: CONTROLS,
      broken: new ApiError("human_control", "The person took over.", {
        reason: "takeover",
      }),
    });
    expect((await refusal(press(taken.session, { x: 10, y: 10 }))).code).toBe(
      "human_control",
    );
    expect(
      pickerKindOf({
        backendNodeId: 1,
        nodeName: "select",
        attributes: { size: "1" },
        editable: false,
      }),
    ).toBe("select");
    expect(
      pickerKindOf({
        backendNodeId: 1,
        nodeName: "div",
        attributes: {},
        editable: false,
      }),
    ).toBeUndefined();
  });
});
