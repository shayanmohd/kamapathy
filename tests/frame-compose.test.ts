// Several frame group reads composed into one snapshot: the order documents
// come out in, a frame's text where its owner sits, the control budget across
// frames, the cursor parts, nested outlines and the frame paths entries carry.
import { describe, expect, it } from "vitest";
import {
  boundGroup,
  countUnread,
  mergeControls,
  nestOutline,
  orderReads,
  prefixPath,
  spliceText,
  OFF_SCREEN_TIER,
  type GroupRead,
  type OwnerPlaceholder,
} from "../electron/agent/frames/compose";

const read = (over: Partial<GroupRead> & { group: string }): GroupRead => ({
  text: [],
  controls: [],
  outline: [],
  placeholders: [],
  chars: 0,
  ...over,
});
const owner = (
  over: Partial<OwnerPlaceholder> & { local: string },
): OwnerPlaceholder => ({
  order: 0,
  tier: 6,
  box: { left: 0, top: 0, right: 200, bottom: 100 },
  readable: true,
  ...over,
});
const textOf = (parts: [number, string][]) =>
  parts.map(([order, value]) => ({ order, value }));
const groupsOf = (paths: string[]) => paths.map((group) => read({ group }));
// The checkout page of section 9: a payment frame in the top document, with a
// frame of its own inside it.
const CHECKOUT = () => [
  read({
    group: "",
    text: textOf([
      [1, "Checkout"],
      [5, "Place order"],
    ]),
    placeholders: [owner({ local: "0", order: 3, tier: 3 })],
    outline: [
      { order: 1, depth: 0, line: 'main "Checkout"' },
      { order: 3, depth: 1, line: 'iframe "Payment" @e1', control: true },
    ],
    controls: [
      {
        order: 3,
        tier: 3,
        local: "",
        entry: {
          index: 0,
          ref: "@e1",
          role: "iframe",
          crossOrigin: true,
          contentFrame: "0",
        },
      },
    ],
    chars: 19,
  }),
  read({
    group: "0",
    owner: owner({ local: "0", order: 3, tier: 3 }),
    text: textOf([[1, "Card number"]]),
    outline: [
      { order: 1, depth: 0, line: 'textbox "Card number" @e2', control: true },
    ],
    controls: [
      {
        order: 1,
        tier: 3,
        local: "",
        entry: { index: 0, ref: "@e2", role: "textbox", label: "Card number" },
      },
    ],
    chars: 11,
  }),
];

describe("frame composition", () => {
  it("orders documents top first, then depth first by path", () => {
    const reads = groupsOf(["1", "0/2", "", "10", "0", "0/1", "0/1/0"]);
    expect(orderReads(reads).map((row) => row.group)).toEqual([
      "",
      "0",
      "0/1",
      "0/1/0",
      "0/2",
      "1",
      "10",
    ]);
    // The reads themselves are untouched, and the input order does not show.
    expect(orderReads([...reads].reverse()).map((row) => row.group)).toEqual([
      "",
      "0",
      "0/1",
      "0/1/0",
      "0/2",
      "1",
      "10",
    ]);
    expect(orderReads(reads)[0]).toBe(reads[2]);
    expect(orderReads([])).toEqual([]);
  });

  it("splices frame text at its owner", () => {
    const reads = CHECKOUT();
    const whole = spliceText(reads, { maxChars: 1000 });
    // The frame's text sits where its owner does, on a line of its own.
    expect(whole.text).toBe("Checkout\nCard number\nPlace order");
    expect(whole.chars).toBe(whole.text.length);
    expect(whole.next).toBeUndefined();
    // A frame inside the frame nests in the same way.
    const deeper = spliceText(
      [
        ...reads,
        read({
          group: "0/1",
          owner: owner({ local: "1", order: 2 }),
          text: textOf([[1, "Expiry"]]),
        }),
      ],
      { maxChars: 1000 },
    );
    expect(deeper.text).toBe("Checkout\nCard number\nExpiry\nPlace order");
    // Reads in any order compose the same text.
    expect(spliceText([...reads].reverse(), { maxChars: 1000 }).text).toBe(
      whole.text,
    );
    // The budget is shared: the top document's text comes first and the
    // frame's text is cut with it.
    const part = spliceText(reads, { maxChars: 12 });
    expect(part.text).toBe("Checkout\nCar");
    expect(part.text.length).toBeLessThanOrEqual(12);
    expect(part.chars).toBe(whole.text.length);
    expect(part.next).toBe(12);
  });

  it("ranks frame controls at the owner's tier, or last off screen", () => {
    const inside = {
      order: 1,
      tier: 6,
      local: "",
      entry: { index: 0, ref: "@e2", role: "textbox" },
    };
    const top = {
      order: 1,
      tier: 4,
      local: "",
      entry: { index: 0, ref: "@e0", role: "button" },
    };
    const reads = (tier: number) => [
      read({
        group: "",
        placeholders: [owner({ local: "0", order: 3, tier })],
        controls: [
          top,
          {
            order: 3,
            tier,
            local: "",
            entry: { index: 1, ref: "@e1", role: "iframe", contentFrame: "0" },
          },
        ],
      }),
      read({
        group: "0",
        owner: owner({ local: "0", order: 3, tier }),
        controls: [inside],
      }),
    ];
    // An owner in an open dialog is tier 0, so its frame's control is more
    // urgent than the plain button of the top document.
    const urgent = mergeControls(reads(0), { maxControls: 2 });
    expect(urgent.controls.map((entry) => entry.ref)).toEqual(["@e1", "@e2"]);
    expect(urgent.omitted).toBe(1);
    // An off screen owner pushes its controls last, however urgent they are.
    const away = mergeControls(
      [
        read({
          group: "",
          placeholders: [
            owner({ local: "0", order: 3, tier: OFF_SCREEN_TIER }),
          ],
          controls: [
            top,
            {
              order: 3,
              tier: OFF_SCREEN_TIER,
              local: "",
              entry: { index: 1, ref: "@e1", role: "iframe" },
            },
          ],
        }),
        read({
          group: "0",
          owner: owner({ local: "0", order: 3, tier: OFF_SCREEN_TIER }),
          controls: [{ ...inside, tier: 0 }],
        }),
      ],
      { maxControls: 1 },
    );
    expect(away.controls.map((entry) => entry.ref)).toEqual(["@e0"]);
    expect(away.omitted).toBe(2);
    // With room for every control, they come back in page order: the frame's
    // control follows its owner's entry.
    const all = mergeControls(reads(4), { maxControls: 10 });
    expect(all.controls.map((entry) => entry.ref)).toEqual([
      "@e0",
      "@e1",
      "@e2",
    ]);
    expect(all.controls.map((entry) => entry.index)).toEqual([0, 1, 2]);
    expect(all.omitted).toBe(0);
    // A part takes ranked positions, as a single document's parts do.
    const second = mergeControls(reads(0), { maxControls: 2, from: 2 });
    expect(second.controls.map((entry) => entry.ref)).toEqual(["@e0"]);
    expect(second.omitted).toBe(0);
  });

  it("slices cursor parts without repeats or gaps", () => {
    const reads = CHECKOUT();
    const whole = spliceText(reads, { maxChars: 1000 }).text;
    let from = 0;
    const parts: string[] = [];
    for (let guard = 0; guard < 10; guard += 1) {
      const part = spliceText(reads, { maxChars: 12, from });
      parts.push(part.text);
      if (part.next === undefined) break;
      expect(part.next).toBe(from + part.text.length);
      from = part.next;
    }
    expect(parts.join("")).toBe(whole);
    expect(parts.length).toBe(3);
    expect(spliceText(reads, { maxChars: 12, from: whole.length })).toEqual({
      text: "",
      chars: whole.length,
    });
    // A group bounded at the cursor offset keeps the characters of its own
    // slice, so one frame cannot spend the whole budget.
    const long = read({
      group: "0",
      owner: owner({ local: "0", order: 3, tier: 3 }),
      text: textOf([[1, "Card number 4242 4242 4242 4242, expiry 03/30"]]),
      chars: 44,
    });
    const unbounded = [reads[0], long];
    for (const window of [
      { from: 0, maxChars: 12 },
      { from: 12, maxChars: 12 },
      { from: 24, maxChars: 30 },
    ]) {
      const bounded = unbounded.map((row) =>
        boundGroup(row, window.from, window.maxChars),
      );
      expect(spliceText(bounded, window).text).toBe(
        spliceText(unbounded, window).text,
      );
    }
    const cut = boundGroup(long, 0, 12);
    expect(cut.text).toEqual(textOf([[1, "Card number "]]));
    expect(cut.chars).toBe(12);
    expect(cut.truncated).toBe(true);
    expect(boundGroup(long, 100, 100)).toBe(long);
  });

  it("nests frame outlines under their iframe line", () => {
    const reads = [
      ...CHECKOUT(),
      read({
        group: "0/1",
        owner: owner({ local: "1", order: 2 }),
        outline: [
          { order: 1, depth: 0, line: 'group "Expiry"' },
          { order: 2, depth: 1, line: 'textbox "MM / YY" @e3', control: true },
        ],
      }),
    ];
    reads[1].outline = [
      ...reads[1].outline,
      { order: 2, depth: 0, line: 'iframe "Expiry" @e4', control: true },
    ];
    reads[1].placeholders = [owner({ local: "1", order: 2 })];
    expect(nestOutline(reads, { maxChars: 1000, maxControls: 10 })).toEqual({
      outline: [
        'main "Checkout"',
        '  iframe "Payment" @e1',
        '    textbox "Card number" @e2',
        '    iframe "Expiry" @e4',
        '      group "Expiry"',
        '        textbox "MM / YY" @e3',
      ],
      omitted: 0,
    });
    // Lines continue from the cursor's line, and a part always prints one.
    const part = nestOutline(reads, { maxChars: 20, maxControls: 10 });
    expect(part.outline).toEqual(['main "Checkout"']);
    expect(part.next).toBe(1);
    // A continued part first repeats the lines around its first line, up
    // through the iframe lines of every frame it sits in.
    const rest = nestOutline(reads, { maxChars: 1000, maxControls: 10, from: 4 });
    expect(rest.outline).toEqual([
      'main "Checkout"',
      '  iframe "Payment" @e1',
      '    iframe "Expiry" @e4',
      '      group "Expiry"',
      '        textbox "MM / YY" @e3',
    ]);
    expect(rest.next).toBeUndefined();
    // Those lines cost characters, so with them the part holds only its
    // first line, which it always prints.
    expect(nestOutline(reads, { maxChars: 60, maxControls: 10, from: 4 })).toEqual(
      {
        outline: rest.outline.slice(0, 4),
        omitted: 1,
        next: 5,
      },
    );
    // They are not progress, so their refs do not count toward maxControls.
    expect(
      nestOutline(reads, { maxChars: 1000, maxControls: 1, from: 5 }).outline,
    ).toEqual(rest.outline);
    // Control and frame lines count toward maxControls, across frames, and
    // the ones a part leaves out are counted.
    const bounded = nestOutline(reads, { maxChars: 1000, maxControls: 2 });
    expect(bounded.outline).toEqual([
      'main "Checkout"',
      '  iframe "Payment" @e1',
      '    textbox "Card number" @e2',
    ]);
    expect(bounded).toMatchObject({ next: 3, omitted: 2 });
  });

  it("prefixes local paths with the group's path", () => {
    expect(prefixPath("", "1")).toBe("1");
    expect(prefixPath("0", "1")).toBe("0/1");
    expect(prefixPath("0", "")).toBe("0");
    expect(prefixPath("", "")).toBe("");
    const { controls } = mergeControls(
      [
        read({
          group: "",
          placeholders: [owner({ local: "0", order: 1 })],
          controls: [
            {
              order: 1,
              tier: 3,
              local: "",
              entry: {
                index: 0,
                ref: "@e1",
                role: "iframe",
                contentFrame: "0",
              },
            },
          ],
        }),
        read({
          group: "0",
          owner: owner({ local: "0", order: 1 }),
          placeholders: [owner({ local: "1", order: 1 })],
          controls: [
            {
              order: 1,
              tier: 3,
              local: "",
              entry: {
                index: 0,
                ref: "@e2",
                role: "iframe",
                contentFrame: "1",
              },
            },
          ],
        }),
        read({
          group: "0/1",
          owner: owner({ local: "1", order: 1 }),
          controls: [
            {
              order: 1,
              tier: 3,
              local: "",
              entry: { index: 0, ref: "@e3", role: "textbox" },
            },
            {
              order: 2,
              tier: 3,
              local: "2",
              entry: { index: 1, ref: "@e4", role: "button" },
            },
          ],
        }),
      ],
      { maxControls: 10 },
    );
    const paths = new Map(
      controls.map((entry) => [entry.ref as string, entry.frame]),
    );
    expect(paths.get("@e1")).toBeUndefined();
    expect(paths.get("@e2")).toBe("0");
    // A control two frames deep carries the joined path, and its owner's
    // entry names the same frame.
    expect(paths.get("@e3")).toBe("0/1");
    expect(controls[1].contentFrame).toBe("0/1");
    // A same-origin frame inside that group keeps counting from the group.
    expect(paths.get("@e4")).toBe("0/1/2");
  });

  it("counts the frames a read left unread", () => {
    const states: Record<string, string> = {
      "0": "read",
      "0/1": "pending",
      "1": "unavailable",
      "2": "limit",
      "3": "blocked",
    };
    const reads = [
      read({
        group: "",
        placeholders: [
          owner({ local: "0", order: 1 }),
          owner({ local: "1", order: 2 }),
          owner({ local: "2", order: 3 }),
          owner({ local: "3", order: 4, readable: false }),
        ],
      }),
      read({
        group: "0",
        owner: owner({ local: "0", order: 1 }),
        placeholders: [owner({ local: "1", order: 1 })],
      }),
    ];
    expect(countUnread(reads, (frame) => states[frame] ?? "unavailable")).toBe(
      3,
    );
    expect(countUnread([], () => "pending")).toBe(0);
  });
});
