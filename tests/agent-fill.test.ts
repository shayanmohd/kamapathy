// The five classes a fill result falls into, measured without a page: the
// page reads the field and classifies, and the main process acts on the
// class alone.
import { describe, expect, it } from "vitest";
import { classifyFill, normalizeValue } from "../electron/agent/dom/actions";

const replace = { append: false };
const append = { append: true };

describe("classifyFill", () => {
  it("passes a read that equals the asked value", () => {
    expect(classifyFill("", "Ada", "Ada", replace)).toBe("exact");
    expect(classifyFill("Grace", "Ada", "Ada", replace)).toBe("exact");
    expect(classifyFill("", "", "", replace)).toBe("exact");
    // Appending asks for the old value followed by the new one.
    expect(classifyFill("Ada ", "Lovelace", "Ada Lovelace", append)).toBe(
      "exact",
    );
    expect(classifyFill("Ada", "", "Ada", append)).toBe("exact");
  });

  it("passes a field that reformats numbers", () => {
    expect(classifyFill("", "1234.5", "1,234.50", replace)).toBe("equivalent");
    expect(classifyFill("0.00", "1234.5", "1 234,5", replace)).toBe(
      "transformed",
    );
    expect(classifyFill("", "12", "12.00", replace)).toBe("equivalent");
    expect(classifyFill("", "-3", "-3.0", replace)).toBe("equivalent");
    // An all-digit value compares by digits alone, so a mask passes.
    expect(classifyFill("", "4155550100", "(415) 555-0100", replace)).toBe(
      "equivalent",
    );
    expect(classifyFill("", "4155550100", "415-555-0101", replace)).toBe(
      "transformed",
    );
    // A value that is not a number keeps the strict comparison.
    expect(classifyFill("", "Ada", "ada", replace)).toBe("transformed");
    expect(classifyFill("", "1234.5", "1234.6", replace)).toBe("transformed");
  });

  it("names a field that kept its value or appended to it", () => {
    expect(classifyFill("Grace", "Ada", "Grace", replace)).toBe("unchanged");
    expect(classifyFill("Grace", "", "Grace", replace)).toBe("unchanged");
    expect(classifyFill("Grace", "Ada", "GraceAda", replace)).toBe("appended");
    // Appending to a field that took nothing is unchanged, never appended.
    expect(classifyFill("Grace", "Ada", "Grace", append)).toBe("unchanged");
    expect(classifyFill("", "Ada", "", append)).toBe("unchanged");
  });

  it("normalizes line breaks and zero-width characters on both sides", () => {
    expect(classifyFill("", "a\nb", "a\r\nb", replace)).toBe("exact");
    expect(classifyFill("", "a\r\nb", "a\nb", replace)).toBe("exact");
    expect(classifyFill("", "ab", "a​b﻿", replace)).toBe("exact");
    expect(classifyFill("", "﻿ab", "ab", replace)).toBe("exact");
    expect(classifyFill("a​b", "c", "abc", replace)).toBe("appended");
    expect(normalizeValue("a\r\nb\rc​d﻿")).toBe("a\nb\ncd");
    expect(normalizeValue("plain")).toBe("plain");
  });
});
