import { describe, expect, it } from "vitest";
import { HOME_URL } from "../shared/state";
import {
  BLOCKED_EXTERNAL_SCHEMES,
  extensionId,
  fileKind,
  googleSignInFallback,
  hostname,
  isExternalAppUrl,
  isFileUrl,
  isGoogleSignInRejectedUrl,
  isPopupUrl,
  isWebUrl,
  normalizeUrl,
  displayUrl,
  URL_MESSAGES,
} from "../shared/url";

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
    "ftp://example.com/file",
    "mailto:someone@example.com",
    "chrome://settings",
    "kamapathy://settings",
  ])("rejects unsupported navigation scheme %s", (input) => {
    expect(() => normalizeUrl(input)).toThrow(
      "Kamapathy opens web addresses and files only.",
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

describe("files, extension pages and other apps", () => {
  const allowFile = { allowFile: true };

  it("file needs allowFile", () => {
    for (const options of [undefined, {}, { allowFile: false }]) {
      expect(() =>
        normalizeUrl("file:///Users/me/report.pdf", "duckduckgo", options),
      ).toThrow(URL_MESSAGES.fileSpace);
      expect(() =>
        normalizeUrl("file:///etc/passwd", "duckduckgo", options),
      ).toThrow(URL_MESSAGES.fileSpace);
    }
    expect(
      normalizeUrl(" file:///Users/me/report.pdf ", "duckduckgo", allowFile),
    ).toBe("file:///Users/me/report.pdf");
    expect(
      normalizeUrl("file://localhost/tmp/a.PDF", "duckduckgo", allowFile),
    ).toBe("file:///tmp/a.PDF");
    expect(normalizeUrl("FILE:///tmp/a.pdf", "google", allowFile)).toBe(
      "file:///tmp/a.pdf",
    );
    expect(
      normalizeUrl("file:///tmp/a.pdf#page=2", "duckduckgo", allowFile),
    ).toBe("file:///tmp/a.pdf#page=2");
    // Only files on this computer: another host, a Windows share reached
    // through an empty host, or credentials are not.
    for (const url of [
      "file://server/share/a.pdf",
      "file:////server/share/a.pdf",
      "file://127.0.0.1/tmp/a.pdf",
      "file://user@localhost/tmp/a.pdf",
    ])
      expect(() => normalizeUrl(url, "duckduckgo", allowFile), url).toThrow(
        URL_MESSAGES.unsupported,
      );
    for (const url of [
      "file:///tmp/tool.exe",
      "file:///tmp/notes",
      "file:///tmp/",
      "file:///etc/passwd",
      "file:///tmp/a?x.pdf",
    ])
      expect(() => normalizeUrl(url, "duckduckgo", allowFile), url).toThrow(
        URL_MESSAGES.fileType,
      );
    // Web addresses and searches work as before.
    expect(normalizeUrl("example.com", "duckduckgo", allowFile)).toBe(
      "https://example.com/",
    );
    expect(() =>
      normalizeUrl("mailto:a@example.com", "duckduckgo", allowFile),
    ).toThrow(URL_MESSAGES.unsupported);
  });

  it("isFileUrl accepts only files on this computer", () => {
    for (const url of [
      "file:///tmp/a.pdf",
      "file://localhost/tmp/a.pdf",
      "FILE:///tmp/a.pdf",
      "file:///C:/Users/me/a.pdf",
      "file:///tmp/notes",
    ])
      expect(isFileUrl(url), url).toBe(true);
    for (const url of [
      "file://server/share/a.pdf",
      "file:////server/share/a.pdf",
      "https://example.com/a.pdf",
      "blob:file:///tmp/a.pdf",
      "not a url",
      "",
    ])
      expect(isFileUrl(url), url).toBe(false);
  });

  it("extension pages", () => {
    const id = "abcdefghijklmnopabcdefghijklmnop";
    const other = "ponmlkjihgfedcbaponmlkjihgfedcba";
    const page = `chrome-extension://${id}/popup.html`;
    expect(extensionId(page)).toBe(id);
    expect(normalizeUrl(page, "duckduckgo", { extensionIds: [other, id] })).toBe(
      page,
    );
    expect(
      normalizeUrl(`CHROME-EXTENSION://${id}/options.html#a`, "duckduckgo", {
        extensionIds: [id],
      }),
    ).toBe(`chrome-extension://${id}/options.html#a`);
    for (const options of [undefined, {}, allowFile])
      expect(() => normalizeUrl(page, "duckduckgo", options)).toThrow(
        URL_MESSAGES.extensionSpace,
      );
    for (const extensionIds of [[other], []])
      expect(() =>
        normalizeUrl(page, "duckduckgo", { extensionIds }),
      ).toThrow(URL_MESSAGES.extensionMissing);
    // An id that is not 32 letters a to p is refused even when listed.
    const malformed = [
      "abcdefghijklmnopabcdefghijklmnoq",
      "abcdefghijklmnop",
      id.toUpperCase(),
    ];
    for (const url of [
      ...malformed.map((bad) => `chrome-extension://${bad}/popup.html`),
      `chrome-extension://${id}:80/popup.html`,
      `chrome-extension://user@${id}/popup.html`,
    ]) {
      expect(extensionId(url), url).toBeUndefined();
      expect(
        () =>
          normalizeUrl(url, "duckduckgo", {
            extensionIds: [id, ...malformed],
          }),
        url,
      ).toThrow(URL_MESSAGES.extensionMissing);
    }
    expect(extensionId("https://example.com/")).toBeUndefined();
    expect(extensionId(`chrome://${id}/`)).toBeUndefined();
  });

  it("external blocklist", () => {
    expect(BLOCKED_EXTERNAL_SCHEMES).toEqual([
      "about",
      "afp",
      "blob",
      "chrome",
      "chrome-extension",
      "chrome-untrusted",
      "data",
      "devtools",
      "disk",
      "disks",
      "file",
      "filesystem",
      "hcp",
      "ie.http",
      "javascript",
      "kamapathy",
      "ms-help",
      "ms-msdt",
      "ms-officecmd",
      "nntp",
      "res",
      "search",
      "search-ms",
      "shell",
      "vbscript",
      "view-source",
      "vnd.ms.radio",
    ]);
    for (const scheme of BLOCKED_EXTERNAL_SCHEMES)
      expect(isExternalAppUrl(`${scheme}:x`), scheme).toBe(false);
    for (const url of [
      "about:blank",
      "javascript:alert(1)",
      "ms-msdt:x",
      "search-ms:query=x",
      "vnd.ms.radio:x",
      "ie.http://x",
      "view-source:https://a.example/",
      "kamapathy://newtab",
      "JavaScript:alert(1)",
    ])
      expect(isExternalAppUrl(url), url).toBe(false);
    for (const url of [
      "mailto:a@example.com",
      "zoommtg://zoom.us/join?confno=1",
      "slack://open",
      "MAILTO:a@example.com",
      `mailto:${"a".repeat(2041)}`,
      `${"a".repeat(32)}:x`,
    ])
      expect(isExternalAppUrl(url), url.slice(0, 40)).toBe(true);
    for (const url of [
      "https://example.com/",
      "http://example.com/",
      "file:///tmp/a.pdf",
      `mailto:${"a".repeat(2042)}`,
      `${"a".repeat(33)}:x`,
      "c:\\Windows\\system32",
      "not a url",
      "",
    ])
      expect(isExternalAppUrl(url), url.slice(0, 40)).toBe(false);
  });

  it("fileKind", () => {
    for (const type of [
      "pdf",
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "avif",
      "txt",
      "webm",
    ])
      expect(fileKind(`file:///tmp/a.${type}`), type).toBe("inert");
    for (const type of ["html", "htm", "xhtml", "svg"])
      expect(fileKind(`file:///tmp/a.${type}`), type).toBe("markup");
    expect(fileKind("file:///tmp/REPORT.PDF")).toBe("inert");
    expect(fileKind("file:///tmp/page.Html")).toBe("markup");
    expect(fileKind("file:///tmp/a.pdf?x=1#page=2")).toBe("inert");
    expect(fileKind("file://localhost/tmp/b.svg")).toBe("markup");
    for (const url of [
      "file:///tmp/tool.exe",
      "file:///tmp/notes",
      "file:///tmp/archive.pdf/",
      "https://example.com/a.pdf",
      "file:///tmp/a?x.pdf",
      "file:///tmp/a#x.pdf",
      "not a url",
    ])
      expect(fileKind(url), url).toBeUndefined();
  });
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
