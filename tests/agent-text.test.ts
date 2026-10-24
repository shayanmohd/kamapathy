import { describe, expect, it } from "vitest";
import { AGENT_TEXT_LIMITS, cleanAgentText } from "../shared/agent-text";
import { ApiError } from "../electron/agent/errors";
import { agentTextField } from "../electron/agent/validate";

// Characters by code point, so this file holds none of the invisible ones it
// is about.
const chars = (...codes: number[]) => String.fromCodePoint(...codes);
// Line breaks, tabs, next line, and the line and paragraph separators.
const breaks = [0x0a, 0x0d, 0x09, 0x85, 0x2028, 0x2029];
// C0, C1, DEL and the bidirectional controls.
const removed = [
  0x00, 0x01, 0x1f, 0x7f, 0x80, 0x9f, 0x61c, 0x200e, 0x200f, 0x202a, 0x202b,
  0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
];
// The error an agent text field threw, so its code, status and fields can all
// be read.
function refusal(run: () => unknown): ApiError {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("The field was accepted.");
}

describe("agent text", () => {
  it("cleans controls, bidirectional marks and breaks but keeps emoji joiners", () => {
    for (const code of breaks)
      expect(cleanAgentText(`one${chars(code)}two`)).toBe("one two");
    expect(cleanAgentText(`one${chars(0x0d, 0x0a)}two`)).toBe("one two");
    for (const code of removed)
      expect(cleanAgentText(`Si${chars(code)}gn`)).toBe("Sign");
    expect(cleanAgentText(`Sign${chars(...removed)} in`)).toBe("Sign in");
    // Runs of whitespace collapse and the ends are trimmed.
    expect(cleanAgentText(`  picked${chars(0xa0)}  the   first seat  `)).toBe(
      "picked the first seat",
    );
    // A joined emoji is one glyph, so its joiner stays.
    const joined = chars(0x1f469, 0x200d, 0x1f4bb);
    expect(cleanAgentText(`asked ${joined} to review`)).toBe(
      `asked ${joined} to review`,
    );
  });

  it("limits apply before cleaning; an all-control label is refused, an all-control status clears", () => {
    expect(AGENT_TEXT_LIMITS).toEqual({
      label: 60,
      status: 120,
      message: 300,
      name: 48,
    });
    // 61 characters that clean to 40: the raw length decides.
    const padded = `${"a".repeat(40)}${chars(0x200e).repeat(21)}`;
    expect(padded).toHaveLength(61);
    expect(cleanAgentText(padded)).toHaveLength(40);
    const long = refusal(() =>
      agentTextField({ label: padded }, "label", "label"),
    );
    expect(long.code).toBe("invalid_field");
    expect(long.status).toBe(400);
    expect(long.message).toBe("label must be at most 60 characters.");
    expect(long.fields).toEqual({
      field: "label",
      expected: "at most 60 characters",
    });
    const blank = refusal(() =>
      agentTextField({ label: `${chars(0x202a, 0x200f)}  ` }, "label", "label"),
    );
    expect(blank.code).toBe("invalid_field");
    expect(blank.fields).toEqual({
      field: "label",
      expected: "text that is not empty after cleaning",
    });
    // An empty status clears, so cleaning away to nothing is allowed there.
    expect(
      agentTextField({ text: chars(0x202a, 0x200f) }, "text", "status", {
        allowEmpty: true,
      }),
    ).toBe("");
    expect(
      agentTextField(
        { text: ` Comparing${chars(0x202e)} prices ` },
        "text",
        "status",
        { allowEmpty: true },
      ),
    ).toBe("Comparing prices");
    const missing = refusal(() =>
      agentTextField({ message: 7 }, "message", "message", { index: 2 }),
    );
    expect(missing.code).toBe("invalid_field");
    expect(missing.message).toBe(
      "message must be a string of at most 300 characters.",
    );
    expect(missing.fields).toEqual({
      field: "message",
      expected: "a string of at most 300 characters",
      index: 2,
    });
  });
});
