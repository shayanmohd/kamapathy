import { describe, expect, it } from "vitest";
import { ApiError } from "../electron/agent/errors";
import {
  MAX_GLOB,
  compileUrlGlob,
} from "../electron/agent/navigation/url-glob";

const matches = (glob: string, url: string) =>
  compileUrlGlob(glob).matches(url);
const refusal = (glob: string, field?: string) => {
  try {
    compileUrlGlob(glob, field);
  } catch (error) {
    return error;
  }
  return undefined;
};
const LENGTH = `must be a URL glob of 1 to ${MAX_GLOB} characters.`;
const BRACES =
  "Braces in a URL glob hold one level of alternatives, such as {a,b}.";

describe("URL globs", () => {
  it("* stops at a slash and ** crosses it", () => {
    expect(matches("https://a.test/*", "https://a.test/one")).toBe(true);
    expect(matches("https://a.test/*", "https://a.test/one/two")).toBe(false);
    expect(matches("https://a.test/**", "https://a.test/one")).toBe(true);
    expect(matches("https://a.test/**", "https://a.test/one/two")).toBe(true);
    expect(matches("https://a.test/*/two", "https://a.test/one/two")).toBe(
      true,
    );
    expect(matches("https://a.test/*", "https://b.test/one")).toBe(false);
  });

  it("a /**/ segment may match nothing", () => {
    expect(matches("https://a.test/**/done", "https://a.test/done")).toBe(true);
    expect(matches("https://a.test/**/done", "https://a.test/x/y/done")).toBe(
      true,
    );
    expect(matches("https://a.test/**/done", "https://a.test/done/late")).toBe(
      false,
    );
  });

  it("braces take one alternative and may hold stars", () => {
    const glob = "https://a.test/{plans,pricing/*}";
    expect(matches(glob, "https://a.test/plans")).toBe(true);
    expect(matches(glob, "https://a.test/pricing/pro")).toBe(true);
    expect(matches(glob, "https://a.test/plans/pro")).toBe(false);
    expect(matches(glob, "https://a.test/pricing")).toBe(false);
  });

  it("a backslash makes the next character literal and ? is literal", () => {
    expect(matches("https://a.test/a\\*b", "https://a.test/a*b")).toBe(true);
    expect(matches("https://a.test/a\\*b", "https://a.test/axb")).toBe(false);
    expect(matches("https://a.test/q?x=1", "https://a.test/q?x=1")).toBe(true);
    expect(matches("https://a.test/q?x=1", "https://a.test/qyx=1")).toBe(false);
    expect(matches("https://a.test/q?x=*", "https://a.test/q?x=1")).toBe(true);
    expect(matches("https://a.test/\\{a\\}", "https://a.test/{a}")).toBe(true);
  });

  it("the whole URL is matched, fragment included", () => {
    expect(matches("https://a.test/p#f", "https://a.test/p#f")).toBe(true);
    expect(matches("https://a.test/p#f", "https://a.test/p")).toBe(false);
    expect(matches("https://a.test/p", "https://a.test/p#f")).toBe(false);
    expect(matches("https://a.test/p#*", "https://a.test/p#f")).toBe(true);
    expect(matches("https://a.test/p#*", "https://a.test/p")).toBe(false);
  });

  it("a plain URL glob compares normalized", () => {
    expect(matches("https://example.com", "https://example.com/")).toBe(true);
    expect(matches("https://A.test/p", "https://a.test/p")).toBe(true);
    expect(compileUrlGlob("https://example.com").plain).toBe(true);
    expect(compileUrlGlob("https://example.com/*").plain).toBe(false);
    expect(compileUrlGlob("https://example.com/{a,b}").plain).toBe(false);
    expect(compileUrlGlob("https://example.com/a\\,b").plain).toBe(false);
    expect(matches("https://example.com", "not a url")).toBe(false);
    expect(compileUrlGlob("/plans").plain).toBe(false);
    expect(matches("/plans", "/plans")).toBe(true);
  });

  it("malformed globs are rejected", () => {
    expect(refusal("")).toBeInstanceOf(ApiError);
    expect(refusal("")).toMatchObject({
      status: 400,
      code: "invalid_field",
      message: `url ${LENGTH}`,
      fields: { field: "url" },
    });
    expect(refusal("a".repeat(MAX_GLOB + 1))).toMatchObject({
      code: "invalid_field",
      message: `url ${LENGTH}`,
      fields: { field: "url" },
    });
    expect(refusal("", "expected")).toMatchObject({
      message: `expected ${LENGTH}`,
      fields: { field: "expected" },
    });
    for (const glob of [
      "https://a.test/{a,{b,c}}",
      "https://a.test/{a,b",
      "https://a.test/a}",
    ])
      expect(refusal(glob)).toMatchObject({
        status: 400,
        code: "invalid_field",
        message: BRACES,
        fields: { field: "url" },
      });
    expect(refusal("https://a.test/a\\")).toMatchObject({
      status: 400,
      code: "invalid_field",
      message: "A URL glob cannot end with a backslash.",
      fields: { field: "url" },
    });
    expect(compileUrlGlob("a".repeat(MAX_GLOB)).source).toHaveLength(MAX_GLOB);
    expect(compileUrlGlob(" https://a.test/p ").source).toBe(
      " https://a.test/p ",
    );
  });

  it("a star glob of 2048 characters against a URL of 8192 finishes under 50 ms", () => {
    const glob = `https://a.test/${"*/".repeat(1016)}*`;
    const url = `https://a.test/${"abcdefg/".repeat(1016)}${"z".repeat(49)}`;
    expect(glob).toHaveLength(MAX_GLOB);
    expect(url).toHaveLength(8192);
    const compiled = compileUrlGlob(glob);
    const started = Date.now();
    const matched = compiled.matches(url);
    const elapsed = Date.now() - started;
    expect(matched).toBe(true);
    expect(elapsed).toBeLessThan(50);
  });

  // A backtracking matcher never finishes these, while the state-set walk
  // takes at most the URL length times the state count.
  it("a hostile glob cannot make the matcher backtrack", () => {
    const compiled = compileUrlGlob("*a".repeat(MAX_GLOB / 2));
    expect(compiled.matches("a".repeat(2048))).toBe(true);
    expect(compiled.matches(`${"a".repeat(2047)}b`)).toBe(false);
  });
});
