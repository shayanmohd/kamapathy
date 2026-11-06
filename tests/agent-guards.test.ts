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
import type { ExtensionNames } from "../electron/agent/extension-frames";
import type { TabSession } from "../electron/agent/session/tab-session";
import type { KnownFrame, Step } from "../electron/agent/session/types";

const MAIN = "main-frame";
type FakeNode = {
  nodeName: string;
  attributes?: Record<string, string>;
  // The frame a frame owner holds, as DOM.describeNode reports it.
  frameId?: string;
  // Where a frame owner's content box is drawn in the viewport of the
  // session that hit it, its size in the owner's own pixels and the scale it
  // is drawn at, as DOM.getBoxModel reports them.
  box?: { x: number; y: number; width: number; height: number; scale?: number };
};
type Spot = {
  x: number;
  y: number;
  // The frame the hit belongs to, as DOM.getNodeForLocation reports it.
  frameId?: string;
  // The session of a frame in its own process the hit test ran on.
  session?: string;
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
// the spots given, DOM.getBoxModel from their owners' boxes,
// Page.getLayoutMetrics from the visual viewport given, on the page's own
// session or a frame's, and refuses every other command.
const tab = (
  options: {
    spots?: Spot[];
    frames?: KnownFrame[];
    registry?: { frameId: string; url: string; path: string }[];
    // The frame paths the registry works out, which a refusal names, for a
    // test that has no use for the URLs.
    paths?: Record<string, string>;
    broken?: unknown;
    visual?: Record<string, number>;
    // The visual viewport of each frame session, by its session id.
    views?: Record<string, Record<string, number>>;
  } = {},
) => {
  const sent: {
    method: string;
    params: Record<string, any>;
    sessionId?: string;
  }[] = [];
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
    const on = spot.session ?? "";
    hits.set(`${on}|${spot.x},${spot.y},false`, {
      id: author,
      frameId: spot.frameId,
    });
    hits.set(`${on}|${spot.x},${spot.y},true`, {
      id: shadow,
      frameId: spot.frameId,
    });
  }
  const session = {
    knownFrames: async () => options.frames ?? [known(MAIN)],
    // What the registry answers for section 9's paths: a blocked frame's
    // own path and the URL its document committed.
    frames: async () =>
      [
        ...(options.registry ?? []),
        ...Object.entries(options.paths ?? {}).map(([frameId, path]) => ({
          frameId,
          path,
          url: "",
        })),
      ].map((frame) => ({
        ...frame,
        origin: "",
        loaderId: "loader-1",
        crossOrigin: true,
        ownSession: true,
        lifecycle: "load" as const,
        blocked: true as const,
      })),
    send: async (
      method: string,
      params: Record<string, any> = {},
      sending?: Step & { sessionId?: string },
    ) => {
      sending?.guard?.();
      const on = sending?.sessionId;
      sent.push({
        method,
        params,
        ...(on === undefined ? {} : { sessionId: on }),
      });
      if (options.broken !== undefined) throw options.broken;
      if (method === "DOM.getNodeForLocation") {
        const found = hits.get(
          `${on ?? ""}|${params.x},${params.y},${params.includeUserAgentShadowDOM === true}`,
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
      if (method === "DOM.getBoxModel") {
        const box = nodes.get(params.backendNodeId)?.box;
        if (!box) throw new Error("Could not compute box model.");
        const scale = box.scale ?? 1;
        const right = box.x + box.width * scale;
        const bottom = box.y + box.height * scale;
        const quad = [box.x, box.y, right, box.y, right, bottom, box.x, bottom];
        return {
          model: {
            content: quad,
            border: quad,
            width: box.width,
            height: box.height,
          },
        };
      }
      const view = on === undefined ? options.visual : options.views?.[on];
      if (method === "Page.getLayoutMetrics" && view)
        return { cssVisualViewport: view };
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
    extensions?: ExtensionNames;
  } = {},
) =>
  checkPointerTarget(session, point, step(), {
    button: extra.button ?? "left",
    press: true,
    platform: extra.platform ?? "darwin",
    ...(extra.extensions ? { extensions: extra.extensions } : {}),
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
      // Nothing but the layout read and the hit test went out, so no input
      // reached the page.
      expect(sent.map((command) => command.method)).toEqual([
        "Page.getLayoutMetrics",
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

  it("refuses a fractional point that rounds out of a frame agents may not reach", async () => {
    // A frame in its own process spans x 0 to 150 and y 0 to 100. Chromium
    // sends input to the exact point, while the hit test takes whole ones:
    // a probe saw a press at x 149.6 land in the frame, and the hit test at
    // 150 find the page.
    const spots: Spot[] = [
      {
        x: 149,
        y: 50,
        frameId: MAIN,
        author: { nodeName: "iframe", frameId: "panel" },
      },
      { x: 150, y: 50, frameId: MAIN, author: { nodeName: "body" } },
      {
        x: 75,
        y: 99,
        frameId: MAIN,
        author: { nodeName: "iframe", frameId: "panel" },
      },
      { x: 75, y: 100, frameId: MAIN, author: { nodeName: "body" } },
    ];
    const frames = [known(MAIN), known("panel", { blocked: true })];
    for (const [point, pressing] of [
      [{ x: 149.6, y: 50 }, true],
      [{ x: 75, y: 99.5 }, false],
    ] as const) {
      const { session } = tab({ spots, frames, paths: { panel: "0" } });
      const error = await refusal(
        checkPointerTarget(session, point, step(), {
          button: "left",
          press: pressing,
        }),
      );
      expect([error.code, error.fields.frame]).toEqual([
        "input_target_blocked",
        "0",
      ]);
    }
    // A whole point is the one point hit-tested.
    const whole = tab({ spots, frames });
    await expect(press(whole.session, { x: 150, y: 50 })).resolves.toBe(
      undefined,
    );
    expect(
      whole.sent.filter((command) => command.method === "DOM.getNodeForLocation"),
    ).toHaveLength(1);
  });

  it("checks the point input lands on while the page is zoomed in", async () => {
    // Mobile emulation lets a page zoom in, and a scroll then moves its
    // visual viewport within the layout viewport. A probe of Electron 44
    // saw a press at 275, 175 land at 305, 205 with the visual viewport 30
    // pixels in each way, while the hit test reads the layout viewport.
    const spots: Spot[] = [
      { x: 275, y: 175, frameId: MAIN, author: { nodeName: "button" } },
      {
        x: 305,
        y: 205,
        frameId: MAIN,
        author: { nodeName: "iframe", frameId: "panel" },
      },
      // Half a pixel further in, the press lands between whole points.
      {
        x: 306,
        y: 206,
        frameId: MAIN,
        author: { nodeName: "iframe", frameId: "panel" },
      },
    ];
    const frames = [known(MAIN), known("panel", { blocked: true })];
    for (const offset of [30, 30.5]) {
      // The page itself is not scrolled, so the visual viewport's place in
      // the document is its offset.
      const zoomed = tab({
        spots,
        frames,
        paths: { panel: "0" },
        visual: {
          offsetX: offset,
          offsetY: offset,
          pageX: offset,
          pageY: offset,
          scale: 2,
        },
      });
      const error = await refusal(press(zoomed.session, { x: 275, y: 175 }));
      expect([error.code, error.fields.frame], String(offset)).toEqual([
        "input_target_blocked",
        "0",
      ]);
    }
    // At the page's own scale the same point is the page's, and so it is
    // when the page cannot say.
    for (const visual of [
      { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, scale: 1 },
      undefined,
    ]) {
      const level = tab({ spots, frames, ...(visual ? { visual } : {}) });
      await expect(
        press(level.session, { x: 275, y: 175 }),
      ).resolves.toBeUndefined();
    }
  });

  it("checks a scrolled page's point where the hit test reads the document", async () => {
    // DOM.getNodeForLocation takes document coordinates while input lands in
    // the viewport: a probe of Electron 44 saw a page scrolled 250 pixels
    // down have the hit test name what lies 250 pixels above where a press
    // landed. Scrolled 120 across and 150 down, a press at 180, 200 lands
    // on the document's 300, 350.
    const spots: Spot[] = [
      { x: 180, y: 200, frameId: MAIN, author: { nodeName: "button" } },
      {
        x: 300,
        y: 350,
        frameId: MAIN,
        author: { nodeName: "iframe", frameId: "panel" },
      },
    ];
    const frames = [known(MAIN), known("panel", { blocked: true })];
    const scrolled = tab({
      spots,
      frames,
      paths: { panel: "0" },
      visual: { offsetX: 0, offsetY: 0, pageX: 120, pageY: 150, scale: 1 },
    });
    const error = await refusal(press(scrolled.session, { x: 180, y: 200 }));
    expect([error.code, error.fields.frame]).toEqual([
      "input_target_blocked",
      "0",
    ]);
    // At the top of the page the same point is the page's own button.
    const top = tab({
      spots,
      frames,
      visual: { offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, scale: 1 },
    });
    await expect(
      press(top.session, { x: 180, y: 200 }),
    ).resolves.toBeUndefined();
  });

  it("goes on inside a frame in its own process and refuses a blocked frame there", async () => {
    // A payment frame Chromium runs in its own process, whose content box is
    // drawn at 100, 50 at half size, holds a password manager's frame. The
    // page's hit test stops at the payment frame's owner, so the check goes
    // on inside it, on its own session: 180, 90 is 160, 80 of the payment
    // frame's own pixels, and with that frame scrolled 20 down, 160, 100 of
    // its document.
    const spots: Spot[] = [
      {
        x: 180,
        y: 90,
        frameId: MAIN,
        author: {
          nodeName: "iframe",
          frameId: "pay",
          box: { x: 100, y: 50, width: 400, height: 300, scale: 0.5 },
        },
      },
      {
        x: 160,
        y: 100,
        session: "pay-session",
        frameId: "pay",
        author: { nodeName: "iframe", frameId: "panel" },
      },
    ];
    const frames = [
      known(MAIN),
      known("pay", { ownSession: true, sessionId: "pay-session" }),
      known("panel", { blocked: true, parentFrameId: "pay" }),
    ];
    const views = { "pay-session": { pageX: 0, pageY: 20 } };
    for (const pressing of [true, false]) {
      const { session, sent } = tab({
        spots,
        frames,
        views,
        paths: { panel: "0/0" },
      });
      const error = await refusal(
        checkPointerTarget(session, { x: 180, y: 90 }, step(), {
          button: "left",
          press: pressing,
        }),
      );
      expect([error.code, error.fields.frame]).toEqual([
        "input_target_blocked",
        "0/0",
      ]);
      expect(
        sent
          .filter((command) => command.method === "DOM.getNodeForLocation")
          .map((command) => [
            command.sessionId,
            command.params.x,
            command.params.y,
          ]),
      ).toEqual([
        [undefined, 180, 90],
        ["pay-session", 160, 100],
      ]);
    }
  });

  it("names the frame a point reaches: the one inside every owner's content box, else the document around the owner", async () => {
    // A payment frame in its own process shows its document from 30, 30 to
    // 330, 230, inside a border and padding from 20, 20. It holds a card
    // frame, in a process of its own again, whose content box spans 50, 50
    // to 250, 200 of the payment frame's own pixels.
    const owner: FakeNode = {
      nodeName: "iframe",
      frameId: "pay",
      box: { x: 30, y: 30, width: 300, height: 200 },
    };
    const spots: Spot[] = [
      ...[25, 29, 30, 40, 130, 200].map((x) => ({
        x,
        y: x === 200 ? 200 : x === 40 ? 40 : 100,
        frameId: MAIN,
        author: owner,
      })),
      {
        x: 0,
        y: 70,
        session: "pay-session",
        frameId: "pay",
        author: { nodeName: "body" },
      },
      {
        x: 100,
        y: 70,
        session: "pay-session",
        frameId: "pay",
        author: { nodeName: "button" },
      },
      {
        x: 10,
        y: 10,
        session: "pay-session",
        frameId: "pay",
        author: { nodeName: "select" },
      },
      {
        x: 170,
        y: 170,
        session: "pay-session",
        frameId: "pay",
        author: {
          nodeName: "iframe",
          frameId: "card",
          box: { x: 50, y: 50, width: 200, height: 150 },
        },
      },
      {
        x: 120,
        y: 120,
        session: "card-session",
        frameId: "card",
        author: { nodeName: "input" },
      },
    ];
    const frames = [
      known(MAIN),
      known("pay", { ownSession: true, sessionId: "pay-session" }),
      known("card", {
        ownSession: true,
        sessionId: "card-session",
        parentFrameId: "pay",
      }),
    ];
    const reachedAt = async (point: { x: number; y: number }) => {
      const reached: { frameId?: string } = {};
      await checkPointerTarget(tab({ spots, frames }).session, point, step(), {
        button: "left",
        press: true,
        reached,
      });
      return reached.frameId;
    };
    // Chromium sends a point on the owner's border or padding, or a fraction
    // of a pixel before its content box, to the page around the frame.
    expect(await reachedAt({ x: 25, y: 100 })).toBe(MAIN);
    expect(await reachedAt({ x: 29.6, y: 100 })).toBe(MAIN);
    expect(await reachedAt({ x: 30, y: 100 })).toBe("pay");
    expect(await reachedAt({ x: 130, y: 100 })).toBe("pay");
    expect(await reachedAt({ x: 200, y: 200 })).toBe("card");
    // What a press would open is read where it lands, inside a frame too.
    const picking = tab({ spots, frames });
    expect((await refusal(press(picking.session, { x: 40, y: 40 }))).code).toBe(
      "native_popup_blocked",
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
    expect(
      sent.find((command) => command.method === "DOM.getNodeForLocation")
        ?.params,
    ).toMatchObject({
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
  it("names the extension a refused point or focus belongs to", async () => {
    const ID = "abcdefghijklmnopabcdefghijklmnop";
    const PDF = "mhjfbmdgcfjbbpaeojofohoefgiehjai";
    const extensions = {
      nameOf: (id: string) => (id === ID ? "Price watcher" : undefined),
    };
    const spots: Spot[] = [
      {
        x: 10,
        y: 10,
        frameId: "panel",
        author: { nodeName: "iframe", frameId: "panel" },
      },
      // A frame inside the extension's own frame: the page shows the
      // extension's frame, so that is the one named.
      { x: 20, y: 10, frameId: "inner", author: { nodeName: "div" } },
      {
        x: 30,
        y: 10,
        frameId: "pdf",
        author: { nodeName: "iframe", frameId: "pdf" },
      },
    ];
    const frames = [
      known(MAIN),
      known("panel", { blocked: true }),
      known("inner", { blocked: true, parentFrameId: "panel" }),
      known("pdf", { blocked: true }),
    ];
    const registry = [
      {
        frameId: "panel",
        path: "2",
        url: `chrome-extension://${ID}/frame.html`,
      },
      {
        frameId: "pdf",
        path: "3",
        url: `chrome-extension://${PDF}/index.html`,
      },
    ];
    const message =
      "This is part of the Price watcher extension. Agents can't use extensions; ask the person to continue there.";
    for (const point of [
      { x: 10, y: 10 },
      { x: 20, y: 10 },
    ]) {
      const { session } = tab({ spots, frames, registry });
      const error = await refusal(press(session, point, { extensions }));
      expect([error.code, error.status]).toEqual(["input_target_blocked", 403]);
      expect(error.message).toBe(message);
      expect(error.fields).toEqual({ frame: "2", extension: "Price watcher" });
    }
    // Kamapathy's own PDF viewer, and a point in a frame no extension of the
    // person's holds, keep section 5's own refusal.
    const viewer = tab({ spots, frames, registry });
    const plain = await refusal(
      press(viewer.session, { x: 30, y: 10 }, { extensions }),
    );
    expect(plain.code).toBe("input_target_blocked");
    expect(plain.message).toContain("an extension or an internal page");
    // Section 9 still names the frame, as it does for every blocked one.
    expect(plain.fields).toEqual({ frame: "3" });
    const alone = tab({ spots, frames, registry });
    expect(
      (await refusal(press(alone.session, { x: 10, y: 10 }))).fields,
    ).toEqual({ frame: "2" });
    // The same for the frame holding focus, which section 9 names for the
    // key guards.
    const key = refusalOf(() =>
      checkKeyTarget(
        {
          kind: "other",
          blockedFrame: true,
          frame: "2",
          extension: "Price watcher",
        },
        parseChord("KeyA", "linux"),
        "linux",
      ),
    );
    expect(key.code).toBe("input_target_blocked");
    expect(key.message).toBe(message);
    expect(key.fields).toEqual({ frame: "2", extension: "Price watcher" });
    const other = refusalOf(() =>
      checkKeyTarget(
        { kind: "other", blockedFrame: true },
        parseChord("KeyA", "linux"),
        "linux",
      ),
    );
    expect(other.message).toContain("an extension or an internal page");
    expect(other.fields).toEqual({});
  });
});
