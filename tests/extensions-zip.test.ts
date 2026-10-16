import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_ZIP_BYTES,
  MAX_ZIP_ENTRIES,
  ZipError,
  extractZip,
  readZip,
} from "../electron/extensions/zip";
import { zipOf } from "./extension-builders";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "kamapathy-zip-test-"));
  directories.push(directory);
  return directory;
}
function filesUnder(folder: string): string[] {
  return readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(folder.length + 1)
        .replaceAll("\\", "/"),
    )
    .sort();
}
// Rewrites the uncompressed size the central directory declares for an
// entry. zipOf writes no archive comment.
function declaring(zip: Buffer, index: number, size: number): Buffer {
  const copy = Buffer.from(zip);
  let at = copy.readUInt32LE(copy.length - 22 + 16);
  for (let skipped = 0; skipped < index; skipped++)
    at +=
      46 +
      copy.readUInt16LE(at + 28) +
      copy.readUInt16LE(at + 30) +
      copy.readUInt16LE(at + 32);
  copy.writeUInt32LE(size, at + 24);
  return copy;
}

const manifest = { path: "manifest.json", data: '{"manifest_version":3}' };

describe("zip archives", () => {
  it("unsafe entries are refused", () => {
    expect(readZip(zipOf([manifest, { path: "js/a.js", data: "a" }]))).toEqual([
      { path: "manifest.json", data: Buffer.from(manifest.data) },
      { path: "js/a.js", data: Buffer.from("a") },
    ]);
    for (const path of [
      "/etc/passwd",
      "C:/evil.js",
      "c:evil.js",
      "js\\evil.js",
      "..\\evil.js",
      "../evil.js",
      "js/../../evil.js",
      "js/..",
      // Variants Windows reads as "..".
      ".. /evil.js",
      "js/...",
      "evil\0.js",
      "",
      "js//evil.js",
      "./evil.js",
      "js/./evil.js",
    ])
      expect(
        () => readZip(zipOf([manifest, { path, data: "x" }])),
        path,
      ).toThrow(ZipError);

    // Duplicates, also by case or Unicode normalization, and a file where a
    // folder must be.
    for (const pair of [
      ["a.js", "a.js"],
      ["a.js", "A.JS"],
      ["js/", "JS/"],
      ["\u00e9.js", "e\u0301.js"],
      ["js", "js/a.js"],
      ["js/a.js", "JS"],
      ["js/", "js"],
    ])
      expect(
        () => readZip(zipOf(pair.map((path) => ({ path, data: "x" })))),
        pair.join(" and "),
      ).toThrow(ZipError);

    expect(() =>
      readZip(
        zipOf([manifest, { path: "link", data: "/etc", unixMode: 0o120777 }]),
      ),
    ).toThrow(ZipError);
    expect(
      readZip(
        zipOf([manifest, { path: "run.sh", data: "x", unixMode: 0o100755 }]),
      ),
    ).toHaveLength(2);
    expect(() =>
      readZip(zipOf([manifest, { path: "a.js", data: "x", method: 12 }])),
    ).toThrow(ZipError);
    for (const method of [0, 8])
      expect(() =>
        readZip(zipOf([manifest, { path: "a.js", data: "x", method, crc: 1 }])),
      ).toThrow(ZipError);
    expect(() =>
      readZip(zipOf([manifest, { path: "a.js", data: "x", flags: 1 }])),
    ).toThrow(ZipError);
  });

  it("archives that aren't plain single-disk zips are refused", () => {
    const zip = zipOf([manifest, { path: "a.js", data: "a" }]);
    const end = zip.length - 22;
    const directory = zip.readUInt32LE(end + 16);
    // Each change is [offset, value, byte length].
    const patched = (...changes: [number, number, 2 | 4][]) => {
      const copy = Buffer.from(zip);
      for (const [offset, value, bytes] of changes)
        if (bytes === 2) copy.writeUInt16LE(value, offset);
        else copy.writeUInt32LE(value, offset);
      return copy;
    };
    for (const [name, damaged] of [
      ["no end record", zip.subarray(0, end)],
      ["too short", zip.subarray(0, 10)],
      ["ZIP64 counts", patched([end + 8, 0xffff, 2], [end + 10, 0xffff, 2])],
      ["ZIP64 directory offset", patched([end + 16, 0xffffffff, 4])],
      ["ZIP64 entry size", patched([directory + 24, 0xffffffff, 4])],
      ["another disk", patched([end + 4, 1, 2])],
      ["an entry on another disk", patched([directory + 34, 1, 2])],
      ["counts differ", patched([end + 8, 1, 2])],
      ["more entries declared", patched([end + 8, 3, 2], [end + 10, 3, 2])],
      ["fewer entries declared", patched([end + 8, 1, 2], [end + 10, 1, 2])],
      ["directory past its end", patched([end + 12, zip.length, 4])],
      ["local header moved", patched([directory + 42, 1, 4])],
    ] as const)
      expect(() => readZip(damaged), name).toThrow(ZipError);
    // An archive comment is fine.
    const commented = Buffer.concat([
      patched([end + 20, 7, 2]),
      Buffer.from("comment"),
    ]);
    expect(readZip(commented)).toHaveLength(2);
  });

  it("the size and count caps hold", () => {
    const many = (count: number) =>
      zipOf(
        Array.from({ length: count }, (_, index) => ({
          path: `f${index}`,
          method: 0,
        })),
      );
    expect(readZip(many(MAX_ZIP_ENTRIES))).toHaveLength(MAX_ZIP_ENTRIES);
    expect(() => readZip(many(MAX_ZIP_ENTRIES + 1))).toThrow(ZipError);
    // A larger cap can't raise the limit.
    expect(() =>
      readZip(many(MAX_ZIP_ENTRIES + 1), { entries: MAX_ZIP_ENTRIES * 2 }),
    ).toThrow(ZipError);

    // Declared totals over 1 GiB are refused before anything inflates, even
    // when each entry is under it.
    const two = zipOf([
      { path: "a.bin", data: "a" },
      { path: "b.bin", data: "b" },
    ]);
    expect(MAX_ZIP_BYTES).toBe(1024 ** 3);
    expect(() =>
      readZip(
        declaring(declaring(two, 0, 600 * 1024 ** 2), 1, 600 * 1024 ** 2),
      ),
    ).toThrow(/too large/);
    expect(() => readZip(declaring(two, 0, MAX_ZIP_BYTES + 1))).toThrow(
      /too large/,
    );
    // An entry that inflates past its declared size is refused.
    const bomb = zipOf([{ path: "bomb.bin", data: Buffer.alloc(1024 ** 2) }]);
    expect(() => readZip(declaring(bomb, 0, 10))).toThrow(ZipError);
    expect(() => readZip(declaring(bomb, 0, 1024 ** 2 + 1))).toThrow(ZipError);
    expect(readZip(bomb)[0].data.length).toBe(1024 ** 2);
    const stored = zipOf([{ path: "a.bin", data: "abc", method: 0 }]);
    expect(() => readZip(declaring(stored, 0, 2))).toThrow(ZipError);

    // Smaller caps passed as an argument.
    const three = zipOf([
      { path: "a.txt", data: "aa" },
      { path: "b.txt", data: "bb" },
      { path: "c.txt", data: "cc" },
    ]);
    expect(readZip(three, { entries: 3, bytes: 6 })).toHaveLength(3);
    expect(() => readZip(three, { entries: 2 })).toThrow(ZipError);
    expect(() => readZip(three, { bytes: 5 })).toThrow(/too large/);
    expect(() => readZip(bomb, { bytes: 1024 ** 2 - 1 })).toThrow(/too large/);
  });

  it("extraction is byte-exact", async () => {
    const binary = randomBytes(300_000);
    const script = "console.log('Kamapathy');\n".repeat(2000);
    const zip = zipOf([
      manifest,
      { path: "icons/" },
      { path: "icons/16.png", data: binary, method: 0 },
      { path: "data.bin", data: binary, method: 8 },
      { path: "js/lib/deep/app.js", data: script },
      { path: "empty.txt", data: "" },
      { path: "\u00e9t\u00e9.txt", data: "summer" },
    ]);
    expect(readZip(zip).map((file) => file.path)).toEqual([
      "manifest.json",
      "icons/16.png",
      "data.bin",
      "js/lib/deep/app.js",
      "empty.txt",
      "\u00e9t\u00e9.txt",
    ]);

    const parent = temporary();
    const folder = join(parent, "staging", "build");
    expect(await extractZip(zip, folder)).toBe(6);
    expect(filesUnder(folder)).toEqual(
      [
        "data.bin",
        "empty.txt",
        "icons/16.png",
        "js/lib/deep/app.js",
        "manifest.json",
        "\u00e9t\u00e9.txt",
      ].sort(),
    );
    expect(readFileSync(join(folder, "icons/16.png")).equals(binary)).toBe(
      true,
    );
    expect(readFileSync(join(folder, "data.bin")).equals(binary)).toBe(true);
    expect(readFileSync(join(folder, "js/lib/deep/app.js"), "utf8")).toBe(
      script,
    );
    expect(readFileSync(join(folder, "empty.txt")).length).toBe(0);
    expect(readFileSync(join(folder, "\u00e9t\u00e9.txt"), "utf8")).toBe(
      "summer",
    );
    expect(readFileSync(join(folder, "manifest.json"), "utf8")).toBe(
      manifest.data,
    );
    // Nothing lands beside the folder.
    expect(readdirSync(parent)).toEqual(["staging"]);
    expect(readdirSync(join(parent, "staging"))).toEqual(["build"]);

    // An empty folder that already exists is fine; one with files isn't.
    const empty = join(parent, "empty");
    mkdirSync(empty);
    expect(await extractZip(zip, empty)).toBe(6);
    const used = join(parent, "used");
    mkdirSync(used);
    writeFileSync(join(used, "old.txt"), "old");
    await expect(extractZip(zip, used)).rejects.toThrow();
    expect(readdirSync(used)).toEqual(["old.txt"]);

    // A refused archive writes nothing, not even the folder.
    const refused = join(parent, "refused");
    await expect(
      extractZip(
        zipOf([manifest, { path: "../outside.js", data: "x" }]),
        refused,
      ),
    ).rejects.toBeInstanceOf(ZipError);
    await expect(
      extractZip(
        zipOf([manifest, { path: "late.js", data: "x", crc: 1 }]),
        refused,
      ),
    ).rejects.toBeInstanceOf(ZipError);
    expect(existsSync(refused)).toBe(false);
    expect(existsSync(join(parent, "outside.js"))).toBe(false);
  });
});
