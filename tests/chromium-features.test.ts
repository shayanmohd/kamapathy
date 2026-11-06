import { describe, expect, it } from "vitest";
import { withFeature } from "../electron/chromium-features";

const FEATURE = "CDPScreenshotNewSurface";

describe("withFeature", () => {
  it("makes the list when there is none", () => {
    expect(withFeature("", FEATURE)).toBe(FEATURE);
    expect(withFeature(" , ", FEATURE)).toBe(FEATURE);
  });

  it("keeps every feature already on the command line", () => {
    expect(withFeature("WaylandWindowDecorations", FEATURE)).toBe(
      `WaylandWindowDecorations,${FEATURE}`,
    );
    expect(withFeature(" A , B,", FEATURE)).toBe(`A,B,${FEATURE}`);
    expect(withFeature("A<Study.Group:x/1,B", FEATURE)).toBe(
      `A<Study.Group:x/1,B,${FEATURE}`,
    );
  });

  it("leaves the feature as the command line already names it", () => {
    for (const entry of [
      FEATURE,
      ` ${FEATURE} `,
      `*${FEATURE}`,
      `${FEATURE}<Study`,
      `${FEATURE}<Study.Group`,
      `${FEATURE}:x/1`,
    ])
      expect(withFeature(`A,${entry}`, FEATURE)).toBe(`A,${entry.trim()}`);
  });

  it("tells the feature from another whose name begins the same", () => {
    expect(withFeature(`${FEATURE}Later`, FEATURE)).toBe(
      `${FEATURE}Later,${FEATURE}`,
    );
    expect(withFeature(`X${FEATURE}`, FEATURE)).toBe(`X${FEATURE},${FEATURE}`);
  });
});
