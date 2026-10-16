import { describe, expect, it } from "vitest";
import {
  MAX_EXTENSIONS,
  PDF_VIEWER_EXTENSION_ID,
  restoreExtensions,
} from "../shared/extensions";

// A distinct valid id per number: its hex digits as the letters a to p.
function idAt(index: number): string {
  return Array.from(index.toString(16).padStart(32, "0"), (digit) =>
    String.fromCharCode(97 + parseInt(digit, 16)),
  ).join("");
}
function store(id: string, version = "1.0.0", extra = {}) {
  return {
    id,
    source: "webstore",
    version,
    path: `Extensions/${id}/${version}`,
    enabled: true,
    pinned: false,
    installedAt: 5,
    grantedPermissions: ["tabs"],
    grantedHosts: ["https://example.com/*"],
    ...extra,
  };
}
function unpacked(id: string, path: unknown) {
  return { ...store(id), source: "unpacked", path };
}
const ids = (value: unknown) =>
  restoreExtensions(value).extensions.map((entry) => entry.id);

describe("extensions.json restore", () => {
  it("invalid, duplicate and component extension entries are dropped", () => {
    const [a, b, c, d, e, f] = [1, 2, 3, 4, 5, 6].map(idAt);
    const file = {
      extensions: [
        store(a),
        store(a.toUpperCase()),
        store("q".repeat(32)),
        store(a.slice(1)),
        store(PDF_VIEWER_EXTENSION_ID),
        store(b, "1.0.0.0.0"),
        store(b, "1.x"),
        store(b, "65536"),
        store(c, "1.0", { enabled: "yes" }),
        store(d, "1.0", { pinned: 1 }),
        store(e, "1.0", { source: "edge" }),
        store(e, "1.0", { installedAt: -1 }),
        store(e, "1.0", { installedAt: "soon" }),
        null,
        "entry",
        7,
        [store(e)],
        store(a, "2.0.0"),
        store(f, "2.1"),
      ],
      removals: [a, b, a, "nope", PDF_VIEWER_EXTENSION_ID, 5, null, c],
    };
    const restored = restoreExtensions(file);
    expect(restored.extensions.map((entry) => entry.id)).toEqual([a, f]);
    expect(restored.extensions[0].version).toBe("1.0.0");
    expect(restored.removals).toEqual([a, b, c]);
    for (const value of [null, "file", 3, [], { extensions: "x" }])
      expect(restoreExtensions(value)).toEqual({
        extensions: [],
        removals: [],
      });
  });

  it("the 100-entry cap holds", () => {
    const entries = Array.from({ length: MAX_EXTENSIONS + 1 }, (_, index) =>
      store(idAt(index)),
    );
    expect(ids({ extensions: entries })).toEqual(
      entries.slice(0, MAX_EXTENSIONS).map((entry) => entry.id),
    );
  });

  it("keeps store paths inside Extensions and unpacked paths absolute", () => {
    const [a, b, c, d, e, f, g, h, i, j, k] = Array.from(
      { length: 11 },
      (_, index) => idAt(index + 1),
    );
    const restored = restoreExtensions({
      extensions: [
        store(a, "1.0.0", { path: "../x" }),
        store(b, "1.0.0", { path: `/Users/me/Extensions/${b}/1.0.0` }),
        store(c, "1.0.0", { path: `Extensions/${c}/2.0.0` }),
        store(d, "1.0.0", { path: `Extensions\\${d}\\1.0.0` }),
        unpacked(e, "relative/folder"),
        unpacked(f, "/a/b\0c"),
        unpacked(g, `/${"x".repeat(4096)}`),
        unpacked(h, "/a/b"),
        unpacked(i, "C:\\a"),
        unpacked(j, "C:/a"),
        unpacked(k, "\\\\host\\share"),
        store(a),
      ],
    });
    expect(
      restored.extensions.map((entry) => [entry.id, entry.source, entry.path]),
    ).toEqual([
      [h, "unpacked", "/a/b"],
      [i, "unpacked", "C:\\a"],
      [j, "unpacked", "C:/a"],
      [k, "unpacked", "\\\\host\\share"],
      [a, "webstore", `Extensions/${a}/1.0.0`],
    ]);
  });

  it("keeps a staged build only when its version is newer and its path is valid", () => {
    const [a, b, c, d, e, f, g, h] = [1, 2, 3, 4, 5, 6, 7, 8].map(idAt);
    const staged = (id: string, version: string, extra = {}) => ({
      version,
      path: `Extensions/${id}/${version}`,
      review: true,
      permissions: ["tabs", "notifications"],
      hosts: ["<all_urls>"],
      ...extra,
    });
    const restored = restoreExtensions({
      extensions: [
        store(a, "1.0.0", { staged: staged(a, "1.0.1") }),
        store(b, "1.0.0", { staged: staged(b, "0.9") }),
        store(c, "1.0.0", { staged: staged(c, "1.0") }),
        store(d, "1.0.0", { staged: staged(d, "2.0", { path: "../2.0" }) }),
        store(e, "1.0.0", {
          staged: staged(e, "2.0", { path: `Extensions/${e}/3.0` }),
        }),
        store(f, "1.0.0", { staged: staged(f, "2.0", { review: "no" }) }),
        store(g, "1.0.0", { staged: staged(g, "1.x") }),
        // Staged builds are store updates; an unpacked folder has none.
        { ...unpacked(h, "/a/b"), staged: staged(h, "2.0") },
      ],
    });
    expect(restored.extensions).toHaveLength(8);
    expect(restored.extensions[0].staged).toEqual({
      version: "1.0.1",
      path: `Extensions/${a}/1.0.1`,
      review: true,
      permissions: ["tabs", "notifications"],
      hosts: ["<all_urls>"],
    });
    for (const entry of restored.extensions.slice(1))
      expect(entry).not.toHaveProperty("staged");
  });

  it("keeps only the saved fields, cleans importedFrom and caps grants and removals", () => {
    const a = idAt(1);
    const long = "h".repeat(2049);
    const [entry] = restoreExtensions({
      extensions: [
        store(a, "1.0.0", {
          importedFrom: `Google\u202E Chrome\n${"x".repeat(60)}`,
          grantedPermissions: ["tabs", 5, long, null, "storage"],
          grantedHosts: Array.from({ length: 300 }, (_, index) => `h${index}`),
          stray: "field",
        }),
      ],
    }).extensions;
    expect(Object.keys(entry)).toEqual([
      "id",
      "source",
      "version",
      "path",
      "enabled",
      "pinned",
      "installedAt",
      "importedFrom",
      "grantedPermissions",
      "grantedHosts",
    ]);
    expect(entry.importedFrom).toBe(`Google Chrome ${"x".repeat(34)}`);
    expect(entry.grantedPermissions).toEqual(["tabs", "storage"]);
    expect(entry.grantedHosts).toHaveLength(256);
    const plain = restoreExtensions({
      extensions: [
        store(a, "1.0.0", {
          importedFrom: 7,
          grantedPermissions: "tabs",
          grantedHosts: undefined,
        }),
      ],
    }).extensions[0];
    expect(plain).not.toHaveProperty("importedFrom");
    expect(plain.grantedPermissions).toEqual([]);
    expect(plain.grantedHosts).toEqual([]);
    const removals = Array.from({ length: 1001 }, (_, index) => idAt(index));
    expect(restoreExtensions({ removals }).removals).toEqual(
      removals.slice(0, 1000),
    );
  });
});
