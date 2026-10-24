import { describe, expect, it } from "vitest";
import { ApiError } from "../electron/agent/errors";
import {
  CANDIDATE_REFS,
  MAX_RANGES,
  REF_BLOCK,
  RefBook,
  processRefs,
  refNumber,
} from "../electron/agent/refs";

const thrown = (run: () => void): ApiError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("The check passed.");
};

describe("issued refs", () => {
  it("classifies issued, never-issued, retired and other-tab refs", () => {
    expect([REF_BLOCK, CANDIDATE_REFS, MAX_RANGES]).toEqual([100, 3, 2000]);
    expect(processRefs).toBeInstanceOf(RefBook);
    expect(refNumber("@e12")).toBe(12);
    for (const ref of ["@e0", "@e01", "@e", "@eone", "e1", "@E1", "@e1.5"])
      expect(refNumber(ref), ref).toBeUndefined();

    const refs = new RefBook();
    const first = refs.reserve(REF_BLOCK);
    expect(first).toBeGreaterThan(0);
    // Only the numbers the page assigned are issued.
    refs.record("t1", [first + 3, first, first + 1, first]);
    for (const number of [first, first + 1, first + 3])
      expect(refs.classify("t1", `@e${number}`), `@e${number}`).toBe("live");
    // Reserved with the block, never assigned.
    expect(refs.classify("t1", `@e${first + 2}`)).toBe("unknown");
    expect(refs.classify("t1", `@e${first + REF_BLOCK}`)).toBe("unknown");
    // Numbers issued for one tab are unknown on another.
    expect(refs.classify("t2", `@e${first}`)).toBe("unknown");
    for (const ref of ["@e0", "@e01", "@eone", "21", "ref=21"])
      expect(refs.classify("t1", ref), ref).toBe("unknown");

    expect(refs.generation("t1")).toBe(0);
    refs.expireTab("t1");
    expect(refs.generation("t1")).toBe(1);
    for (const number of [first, first + 1, first + 3])
      expect(refs.classify("t1", `@e${number}`), `@e${number}`).toBe("retired");
    // Refs the tab is issued after the retirement are live again.
    const next = refs.reserve(REF_BLOCK);
    refs.record("t1", [next]);
    expect(refs.classify("t1", `@e${next}`)).toBe("live");
    // The other tab kept its own generation and refs.
    refs.record("t2", [next + 1]);
    expect(refs.generation("t2")).toBe(0);
    expect(refs.classify("t2", `@e${next + 1}`)).toBe("live");
    expect(refs.classify("t2", `@e${next}`)).toBe("unknown");

    const unknown = thrown(() => refs.check("t1", `@e${first + 2}`));
    expect(unknown.code).toBe("unknown_ref");
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe(
      "Kamapathy never issued this ref for this page. Take a snapshot and use a ref from it.",
    );
    expect(unknown.fields).toEqual({ ref: `@e${first + 2}` });
    const stale = thrown(() => refs.check("t1", `@e${first}`));
    expect(stale.code).toBe("stale_ref");
    expect(stale.status).toBe(409);
    expect(stale.message).toBe(
      "Element reference is stale. Take a new snapshot.",
    );
    expect(stale.fields).toEqual({ ref: `@e${first}` });
    expect(refs.check("t1", `@e${next}`)).toBeUndefined();
  });

  it("merges the oldest ranges past the cap, extends contiguous records, forgets closed tabs and never reserves a number twice", () => {
    const refs = new RefBook();
    const start = refs.reserve(2 * MAX_RANGES + 8);
    // Every other number, so each record is a range of its own.
    for (let index = 0; index <= MAX_RANGES; index += 1)
      refs.record("t1", [start + index * 2]);
    // The two oldest merged, so the gap between them reads as issued.
    expect(refs.classify("t1", `@e${start + 1}`)).toBe("live");
    // A gap past the merged pair stays unknown, and no issued number was lost.
    expect(refs.classify("t1", `@e${start + 3}`)).toBe("unknown");
    for (let index = 0; index <= MAX_RANGES; index += 1)
      expect(refs.classify("t1", `@e${start + index * 2}`), `${index}`).toBe(
        "live",
      );

    // Contiguous records extend the last range instead of filling the cap, so
    // the gap before them is never merged over.
    const book = new RefBook();
    const base = book.reserve(MAX_RANGES + 8);
    book.record("t1", [base]);
    for (let index = 0; index < MAX_RANGES + 4; index += 1)
      book.record("t1", [base + 2 + index]);
    expect(book.classify("t1", `@e${base + 1}`)).toBe("unknown");
    expect(book.classify("t1", `@e${base + 2}`)).toBe("live");
    expect(book.classify("t1", `@e${base + MAX_RANGES + 5}`)).toBe("live");

    // A tab that is gone takes its ranges and generation with it.
    book.record("t2", [base + MAX_RANGES + 7]);
    book.expireTab("t1");
    book.retain(new Set(["t2"]));
    expect(book.classify("t1", `@e${base + 2}`)).toBe("unknown");
    expect(book.generation("t1")).toBe(0);
    expect(book.classify("t2", `@e${base + MAX_RANGES + 7}`)).toBe("live");

    // The counter is process-wide, so no two books hand out one number.
    const one = new RefBook();
    const two = new RefBook();
    const mine = one.reserve(REF_BLOCK);
    const yours = two.reserve(REF_BLOCK);
    expect(yours).toBeGreaterThanOrEqual(mine + REF_BLOCK);
    expect(one.reserve(1)).toBeGreaterThanOrEqual(yours + REF_BLOCK);
  });
});
