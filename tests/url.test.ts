import { describe, expect, it } from "vitest";
import { HOME_URL } from "../shared/state";
import { googleSignInFallback, hostname, isGoogleSignInRejectedUrl, isPopupUrl, isWebUrl, normalizeUrl, displayUrl } from "../shared/url";

describe("Google sign-in fallback", () => {
  it("recognizes the rejection page and discards authentication query parameters", () => {
    const url = "https://accounts.google.com/v3/signin/rejected?continue=" + encodeURIComponent("https://play.google.com/console/u/0/developers/private?token=secret");
    expect(isGoogleSignInRejectedUrl(url)).toBe(true);
    expect(googleSignInFallback(url)).toBe("https://play.google.com/console/");
    expect(googleSignInFallback("https://accounts.google.com/signin/rejected?continue=custom%3A%2F%2Fpayload")).toBe("https://accounts.google.com/");
  });
  it("does not trust lookalike hosts, credentials, ports, schemes or unrelated pages", () => {
    for (const url of [
      "https://accounts.google.com.example.org/v3/signin/rejected",
      "https://secret@accounts.google.com/v3/signin/rejected",
      "http://accounts.google.com/v3/signin/rejected",
      "https://accounts.google.com:444/v3/signin/rejected",
      "https://accounts.google.com/v3/signin/identifier",
      "javascript:alert(1)",
    ]) {
      expect(isGoogleSignInRejectedUrl(url)).toBe(false);
      expect(googleSignInFallback(url)).toBeUndefined();
    }
  });
});

describe("address bar normalization", () => {
  it.each(["", "   ", HOME_URL])(
    "returns the internal new tab page for %j",
    (input) => {
      expect(normalizeUrl(input)).toBe(HOME_URL);
    },
  );

  it.each([
    [" example.com ", "https://example.com/"],
    ["example.com:8443/docs", "https://example.com:8443/docs"],
    [
      "https://EXAMPLE.com/docs?q=one#two",
      "https://example.com/docs?q=one#two",
    ],
    ["http://example.com", "http://example.com/"],
    ["localhost", "http://localhost/"],
    ["localhost:5173/docs", "http://localhost:5173/docs"],
    ["127.0.0.1:3000", "http://127.0.0.1:3000/"],
    ["[::1]:8080/test", "http://[::1]:8080/test"],
    ["localhost:5173?debug=1", "http://localhost:5173/?debug=1"],
    ["localhost#section", "http://localhost/#section"],
    ["127.0.0.1:3000?debug=1", "http://127.0.0.1:3000/?debug=1"],
    ["[::1]:8080#section", "http://[::1]:8080/#section"],
    ["example.com:8443?debug=1", "https://example.com:8443/?debug=1"],
  ])("normalizes %s without losing the destination", (input, expected) => {
    expect(normalizeUrl(input)).toBe(expected);
  });

  it.each([
    ["duckduckgo", "https://duckduckgo.com/?q="],
    ["google", "https://www.google.com/search?q="],
    ["bing", "https://www.bing.com/search?q="],
  ] as const)("encodes a complete search query for %s", (engine, base) => {
    expect(normalizeUrl("  trees & trails / nearby?  ", engine)).toBe(
      `${base}trees%20%26%20trails%20%2F%20nearby%3F`,
    );
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.com/file",
    "mailto:someone@example.com",
    "chrome://settings",
    "kamapathy://settings",
  ])("rejects unsupported navigation scheme %s", (input) => {
    expect(() => normalizeUrl(input)).toThrow(
      "Only HTTP and HTTPS addresses are supported.",
    );
  });

  it.each([
    "https://user:secret@example.com",
    "http://user@example.com",
    "https://trusted.example@other.example",
    "trusted.example@other.example",
    "user@example.com",
  ])("rejects credentials and ambiguous authority in %s", (input) => {
    expect(() => normalizeUrl(input)).toThrow(
      "URLs containing credentials are not supported.",
    );
  });

  it.each(["https://", "http://[invalid]", "https://example.com:99999"])(
    "rejects malformed URL %s",
    (input) => {
      expect(() => normalizeUrl(input)).toThrow();
    },
  );
});

describe("remote page URL validation", () => {
  it.each([
    "https://example.com/",
    "http://localhost:8080",
    "http://[::1]:3000",
  ])("permits HTTP browsing at %s", (url) => {
    expect(isWebUrl(url)).toBe(true);
  });

  it.each([
    HOME_URL,
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///tmp/index.html",
    "https://user:secret@example.com",
    "https://user@example.com",
    "example.com",
    "http://",
  ])("does not treat %s as a permitted remote page", (url) => {
    expect(isWebUrl(url)).toBe(false);
  });
});

describe("popup URL validation", () => {
  it("isPopupUrl allows only about:blank, credential-free web URLs and web-origin blob URLs", () => {
    for (const url of [
      "about:blank",
      "about:blank#results",
      "https://example.com/login?next=%2F",
      "http://127.0.0.1:8080/popup",
      "blob:https://example.com/550e8400-e29b-41d4-a716-446655440000",
      "blob:http://localhost:5173/7d6e2a1c",
    ])
      expect(isPopupUrl(url), url).toBe(true);
    for (const url of [
      "data:text/html,<script>opener.postMessage('hi', '*')</script>",
      "about:srcdoc",
      "about:blank?query=1",
      "javascript:alert(1)",
      "file:///etc/passwd",
      HOME_URL,
      "chrome://settings",
      "https://user:secret@example.com/",
      "blob:null/550e8400-e29b-41d4-a716-446655440000",
      "blob:file:///tmp/page",
      "blob:https://user:secret@example.com/550e8400",
      "blob:data:text/html,hello",
      "example.com",
      "",
    ])
      expect(isPopupUrl(url), url).toBe(false);
  });
});

describe("hostname labels", () => {
  it("strips only a leading www label and preserves meaningful subdomains", () => {
    expect(hostname("https://www.example.com/a?q=b")).toBe("example.com");
    expect(hostname("https://docs.example.com")).toBe("docs.example.com");
  });

  it("keeps an unparseable label readable", () => {
    expect(hostname("New tab")).toBe("New tab");
  });
});

describe("address display", () => {
  it("shows host and path without the scheme", () => {
    expect(displayUrl("https://github.com/shayanmohd/kamapathy")).toBe(
      "github.com/shayanmohd/kamapathy",
    );
    expect(displayUrl("https://www.example.com/")).toBe("example.com");
    expect(displayUrl("http://127.0.0.1:8080/a?b=1#c")).toBe(
      "127.0.0.1:8080/a?b=1#c",
    );
  });
  it("leaves anything that is not a web address as it is", () => {
    expect(displayUrl("kamapathy://newtab")).toBe("kamapathy://newtab");
    expect(displayUrl("not a url")).toBe("not a url");
  });
});
