import { describe, expect, it, vi } from "vitest";
import { chromeUserAgent, UA_PLATFORM } from "../electron/identity";

const version = "152.0.7977.76";
const groups = [
  "Macintosh; Intel Mac OS X 10_15_7",
  "Windows NT 10.0; Win64; x64",
  "X11; Linux x86_64",
];
const electronString = (group: string) =>
  `Mozilla/5.0 (${group}) AppleWebKit/537.36 (KHTML, like Gecko) kamapathy/0.2.0 Chrome/${version} Electron/44.2.0 Safari/537.36`;

describe("Chrome-compatible user agent", () => {
  it("reduced strings", () => {
    for (const group of groups) {
      const log = vi.fn();
      const result = chromeUserAgent(electronString(group), version, log);
      expect(result).toBe(
        `Mozilla/5.0 (${group}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`,
      );
      expect(result).not.toMatch(/Electron|kamapathy|7977/i);
      expect(log).not.toHaveBeenCalled();
    }
    expect(UA_PLATFORM.exec(electronString(groups[0]))?.[1]).toBe(groups[0]);
  });

  it("unknown fallback kept", () => {
    for (const fallback of ["Kamapathy/0.2.0", "", "Mozilla/5.0 (a (b))"]) {
      const log = vi.fn();
      expect(chromeUserAgent(fallback, version, log)).toBe(fallback);
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain(JSON.stringify(fallback));
    }
    expect(chromeUserAgent("Kamapathy/0.2.0", version)).toBe("Kamapathy/0.2.0");
  });

  it("idempotent", () => {
    for (const group of groups) {
      const once = chromeUserAgent(electronString(group), version);
      expect(chromeUserAgent(once, version)).toBe(once);
    }
  });
});
