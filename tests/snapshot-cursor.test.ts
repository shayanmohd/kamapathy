// A snapshot cursor carries nothing but offsets, an epoch and hashes, and is
// accepted only for the snapshot that made it, on the document that made it.
import { describe, expect, it } from "vitest";
import { ApiError } from "../electron/agent/errors";
import {
  CURSOR_PREFIX,
  MAX_CURSOR,
  checkCursorPage,
  encodeCursor,
  optionsHash,
  readCursor,
  urlHash,
  type CursorState,
} from "../electron/agent/snapshot";

const thrown = (run: () => unknown): ApiError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("The check passed.");
};
const encode = (state: unknown) =>
  CURSOR_PREFIX +
  Buffer.from(JSON.stringify(state), "utf8").toString("base64url");

describe("snapshot cursors", () => {
  it("rejects cursors for another scope or document", () => {
    const h = optionsHash({ scope: "page" });
    const state: CursorState = {
      e: 2,
      u: urlHash("https://example.com/orders"),
      t: 4000,
      c: 40,
      l: 0,
      h,
    };
    const cursor = encodeCursor(state);
    expect(cursor.startsWith(CURSOR_PREFIX)).toBe(true);
    expect(cursor.length).toBeLessThanOrEqual(MAX_CURSOR);
    expect(readCursor(cursor, { h })).toEqual(state);
    // Hashes are short and carry no part of the page or the selector.
    expect(h).toHaveLength(16);
    expect(state.u).toHaveLength(16);
    expect(cursor).not.toContain("example.com");

    for (const [name, text] of [
      ["no prefix", cursor.slice(CURSOR_PREFIX.length)],
      ["another version", `c2.${cursor.slice(CURSOR_PREFIX.length)}`],
      ["empty", CURSOR_PREFIX],
      ["bad base64url", `${CURSOR_PREFIX}not base64!`],
      ["bad JSON", CURSOR_PREFIX + Buffer.from("{nope").toString("base64url")],
      ["a string", encode("c1")],
      ["an array", encode([2, state.u, 0, 0, 0, h])],
      ["over 512 characters", encodeCursor(state) + "A".repeat(MAX_CURSOR)],
    ] as const)
      expect(thrown(() => readCursor(text, { h })).code, name).toBe(
        "invalid_cursor",
      );
    const refusal = thrown(() => readCursor(`${CURSOR_PREFIX}x`, { h }));
    expect(refusal.status).toBe(400);
    expect(refusal.message).toBe(
      "This cursor does not continue this snapshot. Ask for the snapshot again without a cursor.",
    );
    // Every field must be there, of its own kind and inside its bounds.
    for (const field of ["e", "u", "t", "c", "l", "h"] as const) {
      const { [field]: _gone, ...rest } = state;
      expect(thrown(() => readCursor(encode(rest), { h })).code, field).toBe(
        "invalid_cursor",
      );
    }
    for (const [field, value] of [
      ["e", -1],
      ["e", 1.5],
      ["e", "2"],
      ["t", -1],
      ["t", 10_000_001],
      ["t", 1.5],
      ["c", -1],
      ["c", 100_001],
      ["l", -1],
      ["l", 1_000_001],
      ["u", ""],
      ["u", "u".repeat(33)],
      ["u", 1],
      ["h", 1],
    ] as const)
      expect(
        thrown(() => readCursor(encode({ ...state, [field]: value }), { h }))
          .code,
        `${field} ${value}`,
      ).toBe("invalid_cursor");
    // The bounds themselves are accepted.
    expect(
      readCursor(encodeCursor({ ...state, t: 10_000_000, c: 100_000 }), { h })
        .t,
    ).toBe(10_000_000);

    // The options a part may not change.
    for (const other of [
      { scope: "viewport" },
      { scope: "page", selector: "#list" },
      { scope: "page", root: "@e4" },
      { scope: "page", format: "outline" },
    ]) {
      expect(optionsHash(other), JSON.stringify(other)).not.toBe(h);
      expect(
        thrown(() => readCursor(cursor, { h: optionsHash(other) })).code,
        JSON.stringify(other),
      ).toBe("invalid_cursor");
    }
    // The bounds, the mode and the extras may change between parts.
    const changed = {
      scope: "page",
      mode: "full",
      maxChars: 24000,
      maxControls: 100,
      locators: true,
      header: false,
    };
    expect(optionsHash(changed)).toBe(h);
    expect(readCursor(cursor, { h: optionsHash(changed) })).toEqual(state);
    // The written-out default format, and the same options in another order.
    expect(optionsHash({ scope: "page", format: "list" })).toBe(h);
    expect(optionsHash({ scope: "page", selector: "#list" })).toBe(
      optionsHash({ selector: "#list", scope: "page" }),
    );
    // A selector and a root are told apart, never merged.
    expect(optionsHash({ scope: "page", root: "#list" })).not.toBe(
      optionsHash({ scope: "page", selector: "#list" }),
    );

    // The document a cursor was made on, by epoch and by URL.
    const url = "https://example.com/orders";
    expect(checkCursorPage(state, { epoch: 2 })).toBeUndefined();
    expect(checkCursorPage(state, { epoch: 2, url })).toBeUndefined();
    for (const page of [
      { epoch: 3 },
      { epoch: 1 },
      { epoch: 2, url: `${url}#page2` },
      { epoch: 2, url: `${url}?page=2` },
      { epoch: 2, url: "https://example.com/" },
    ]) {
      const refused = thrown(() => checkCursorPage(state, page));
      expect(refused.code, JSON.stringify(page)).toBe("page_changed");
      expect(refused.status).toBe(409);
      expect(refused.message).toBe(
        "The page changed since this cursor's part. Take a snapshot again without a cursor.",
      );
    }
  });
});
