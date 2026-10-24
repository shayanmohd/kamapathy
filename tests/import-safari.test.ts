import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { ImportError, type ImportTarget } from "../electron/import";
import {
  parseBookmarksHtml,
  parseHistoryJson,
  readSafariArchive,
  readZip,
  runSafariImport,
  SAFARI_ARCHIVE_LIMIT,
} from "../electron/import-safari";
import type { BrowserAction } from "../shared/types";

const fixtures = fileURLToPath(
  new URL("./fixtures/import/safari/", import.meta.url),
);
const fixture = (name: string): Buffer => readFileSync(fixtures + name);

const NOT_ZIP = "That is not a .zip file. Choose the file Safari exported.";
const NOT_EXPORT = "That is not the file Safari exported. Choose it again.";

const both = { bookmarks: true, history: true };
const expectedBookmarks = [
  { title: "Kamapathy", url: "https://kamapathy.app/" },
  { title: "Nested", url: "https://example.com/nested" },
  { title: "Deeper page", url: "https://example.com/deeper" },
  {
    title: 'Fish & Chips <fresh> "daily"',
    url: "https://example.com/search?q=fish&chips",
  },
  {
    title: "https://example.com/untitled",
    url: "https://example.com/untitled",
  },
  { title: "Padded", url: "https://example.com/padded" },
  { title: "Menu page", url: "https://example.com/menu" },
  { title: "Saved article", url: "https://example.com/article" },
];
const expectedHistory = [
  {
    title: "Kamapathy",
    url: "https://kamapathy.app/",
    visitedAt: 1748307200250,
    visits: 3,
  },
  {
    title: "Redirect",
    url: "https://example.com/redirect",
    visitedAt: 1728307200000,
    visits: 1,
  },
  {
    title: "http://localhost:3000/",
    url: "http://localhost:3000/",
    visitedAt: 1718307200000,
    visits: 2,
  },
  {
    title: "No count",
    url: "https://example.com/no-count",
    visitedAt: 1708307200000,
    visits: 1,
  },
];

// A zip written by hand, so a test can bend one field at a time.
interface EntrySpec {
  name: string;
  data?: Buffer;
  method?: number;
  flags?: number;
  crc?: number;
  stored?: Buffer;
  size?: number;
}
function zip(
  specs: EntrySpec[],
  bend: (eocd: Buffer) => void = () => {},
): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const spec of specs) {
    const data = spec.data ?? Buffer.alloc(0);
    const method = spec.method ?? 0;
    const body = spec.stored ?? (method === 8 ? deflateRawSync(data) : data);
    const name = Buffer.from(spec.name, "utf8");
    const crc = spec.crc ?? crc32(data);
    const size = spec.size ?? data.length;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(spec.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const header = Buffer.alloc(46 + name.length);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(spec.flags ?? 0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(size, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(offset, 42);
    name.copy(header, 46);
    parts.push(local, body);
    central.push(header);
    offset += local.length + body.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(specs.length, 8);
  eocd.writeUInt16LE(specs.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  bend(eocd);
  return Buffer.concat([...parts, directory, eocd]);
}

const text = (name: string, body: string, method = 0): EntrySpec => ({
  name,
  data: Buffer.from(body, "utf8"),
  method,
});
const anchor = (url: string, title: string) =>
  `<DT><A HREF="${url}">${title}</A>`;
const codeOf = (run: () => unknown): [string, string] => {
  try {
    run();
  } catch (error) {
    return error instanceof ImportError
      ? [error.code, error.message]
      : ["not an ImportError", String(error)];
  }
  return ["no error", ""];
};

describe("import-safari", () => {
  it("reads bookmarks html and history json from a zip", () => {
    const read = readSafariArchive(fixture("export-deflate.zip"), both);

    expect(read.bookmarks).toEqual(expectedBookmarks);
    expect(read.history).toEqual(expectedHistory);
    expect(read.warnings).toEqual([]);
    expect(
      codeOf(() => readSafariArchive(fixture("not-a-zip.zip"), both)),
    ).toEqual(["invalid_archive", NOT_ZIP]);
    const stored = readSafariArchive(fixture("export-store.zip"), both);
    expect(stored.bookmarks).toEqual(read.bookmarks);
    expect(stored.history).toEqual(read.history);
  });

  it("reads only the kinds the person asked for", () => {
    const archive = fixture("export-store.zip");
    expect(
      readSafariArchive(archive, { bookmarks: true, history: false }),
    ).toEqual({
      bookmarks: expectedBookmarks,
      history: [],
      warnings: [],
    });
    expect(
      readSafariArchive(archive, { bookmarks: false, history: true }),
    ).toEqual({
      bookmarks: [],
      history: expectedHistory,
      warnings: [],
    });
    const onlyHistory = zip([text("History.json", '{"history": []}')]);
    expect(readSafariArchive(onlyHistory, both).warnings).toEqual([
      "That file had no bookmarks in it.",
    ]);
    const onlyBookmarks = zip([text("Bookmarks.html", "<DL></DL>")]);
    expect(readSafariArchive(onlyBookmarks, both).warnings).toEqual([
      "That file had no history in it.",
    ]);
    expect(
      readSafariArchive(onlyBookmarks, { bookmarks: true, history: false })
        .warnings,
    ).toEqual([]);
  });

  it("bounds what it unpacks", () => {
    const page = (index: number) =>
      text(
        "Bookmarks.html",
        anchor(`https://example.com/${index}`, `Page ${index}`),
      );
    const many = Array.from({ length: 513 }, (_, index) => page(index));
    expect(codeOf(() => readZip(zip(many)))).toEqual([
      "invalid_archive",
      NOT_EXPORT,
    ]);
    expect(readZip(zip(many.slice(0, 512)))).toHaveLength(512);

    const bomb = zip([
      {
        name: "Bookmarks.html",
        data: Buffer.alloc(64 * 1024 * 1024 + 1),
        method: 8,
      },
    ]);
    expect(codeOf(() => readZip(bomb))).toEqual([
      "invalid_archive",
      NOT_EXPORT,
    ]);
    expect(readZip(bomb, { bytes: 64 * 1024 * 1024 + 1 })).toHaveLength(1);

    // A central directory that lies about the unpacked size is caught before
    // anything is inflated.
    const liar = zip([{ ...page(1), size: 100 * 1024 * 1024 }]);
    expect(codeOf(() => readZip(liar))).toEqual([
      "invalid_archive",
      NOT_EXPORT,
    ]);

    for (const bend of [
      (eocd: Buffer) => eocd.writeUInt16LE(0xffff, 10),
      (eocd: Buffer) => eocd.writeUInt32LE(0xffffffff, 12),
      (eocd: Buffer) => eocd.writeUInt32LE(0xffffffff, 16),
    ])
      expect(codeOf(() => readZip(zip([page(1)], bend)))).toEqual([
        "invalid_archive",
        NOT_EXPORT,
      ]);
    expect(codeOf(() => readZip(zip([{ ...page(1), crc: 7 }])))).toEqual([
      "invalid_archive",
      NOT_EXPORT,
    ]);
    expect(
      codeOf(() => readZip(Buffer.from("PK\u0003\u0004 and nothing else"))),
    ).toEqual(["invalid_archive", NOT_ZIP]);
    expect(codeOf(() => readZip(Buffer.alloc(0)))).toEqual([
      "invalid_archive",
      NOT_ZIP,
    ]);

    // A directory, an encrypted entry and an entry compressed some other way
    // are left out; the rest of the archive still reads.
    const mixed = zip([
      { name: "Export/" },
      {
        ...text(
          "Export/secret.html",
          anchor("https://example.com/secret", "Secret"),
        ),
        flags: 1,
      },
      { ...page(2), name: "Export/zipped.html", method: 14 },
      { ...page(3), name: "Export/Bookmarks.html", method: 8 },
    ]);
    expect(readZip(mixed).map((entry) => entry.name)).toEqual([
      "Export/Bookmarks.html",
    ]);
    expect(readSafariArchive(mixed, both).bookmarks).toEqual([
      { title: "Page 3", url: "https://example.com/3" },
    ]);

    const wrong = zip([text("Passwords.csv", "url,username,password\n")]);
    expect(codeOf(() => readSafariArchive(wrong, both))).toEqual([
      "invalid_archive",
      NOT_EXPORT,
    ]);
  });

  it("merges every bookmark and history file in the archive", () => {
    const archive = zip([
      text("one.htm", anchor("https://example.com/one", "One")),
      text("notes.json", '{"note": "not history"}'),
      text("two.HTML", anchor("https://example.com/two", "Two")),
      text(
        "old.json",
        JSON.stringify([
          {
            url: "https://example.com/old",
            title: "Old",
            time_usec: 1600000000000000,
          },
        ]),
      ),
      text(
        "new.json",
        JSON.stringify({
          history: [
            {
              url: "https://example.com/new",
              title: "New",
              time_usec: 1700000000000000,
            },
          ],
        }),
      ),
    ]);
    const read = readSafariArchive(archive, both);
    expect(read.bookmarks).toEqual([
      { title: "One", url: "https://example.com/one" },
      { title: "Two", url: "https://example.com/two" },
    ]);
    expect(read.history.map((visit) => visit.url)).toEqual([
      "https://example.com/new",
      "https://example.com/old",
    ]);
  });

  it("keeps the flat 1000-item caps", () => {
    const anchors = Array.from({ length: 1200 }, (_, index) =>
      anchor(`https://example.com/${index % 1100}`, `Page ${index}`),
    ).join("\n");
    const visits = Array.from({ length: 1200 }, (_, index) => ({
      url: `https://example.com/${index % 1100}`,
      title: `Page ${index}`,
      time_usec: (1600000000000 + index) * 1000,
    }));
    const read = readSafariArchive(
      zip([
        text("Bookmarks.html", anchors, 8),
        text("History.json", JSON.stringify({ history: visits }), 8),
      ]),
      both,
    );
    expect(read.bookmarks).toHaveLength(1000);
    expect(read.history).toHaveLength(1000);
    expect(new Set(read.history.map((visit) => visit.url)).size).toBe(1000);
  });

  it("parses anchors and history items", () => {
    expect(
      parseBookmarksHtml(
        '<a href=\'https://example.com/a\'>A</a><A\n HREF="https://example.com/b" ADD_DATE="1">B</A >',
      ),
    ).toEqual([
      { title: "A", url: "https://example.com/a" },
      { title: "B", url: "https://example.com/b" },
    ]);
    expect(parseBookmarksHtml("<a>no href</a><a href=''></a>")).toEqual([]);
    expect(parseHistoryJson({})).toEqual([]);
    expect(parseHistoryJson("text")).toEqual([]);
    expect(
      parseHistoryJson({
        history: [
          "text",
          { url: "https://example.com/a", time_usec: "1700000000000000" },
          {
            url: "https://example.com/b",
            time_usec: 1700000000000000,
            visit_count: 0,
          },
        ],
      }),
    ).toEqual([
      {
        title: "https://example.com/b",
        url: "https://example.com/b",
        visitedAt: 1700000000000,
        visits: 1,
      },
    ]);
  });
});

describe("Safari import", () => {
  function fakeTarget() {
    const state = {
      bookmarks: [] as {
        id: string;
        title: string;
        url: string;
        createdAt: number;
      }[],
      history: [] as {
        id: string;
        title: string;
        url: string;
        visitedAt: number;
      }[],
    };
    return {
      state,
      dispatch: vi.fn(async (action: BrowserAction) => {
        if (action.type !== "import:apply") return;
        for (const item of action.bookmarks)
          state.bookmarks.push({ id: item.url, createdAt: 0, ...item });
        for (const item of action.history)
          state.history.push({ id: item.url, ...item });
      }),
      applyImportedCookies: vi.fn(async () => ({
        written: 0,
        failed: 0,
        spaces: [] as { id: string; name: string }[],
        warnings: [] as string[],
      })),
    };
  }
  const refused = async (bytes: unknown, options: unknown) => {
    const target = fakeTarget();
    await expect(
      runSafariImport(target as unknown as ImportTarget, bytes, options),
    ).rejects.toMatchObject({
      code: "import_invalid_request",
      message: "Something was wrong with that import. Try again.",
    });
    expect(target.dispatch).not.toHaveBeenCalled();
  };

  it("applies the archive once and never reads sign-ins", async () => {
    const target = fakeTarget();

    const outcome = await runSafariImport(
      target as unknown as ImportTarget,
      fixture("export-deflate.zip"),
      both,
    );

    expect(outcome).toEqual({
      bookmarks: 8,
      history: 4,
      signIns: 0,
      spaces: [],
      warnings: [],
    });
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(target.dispatch.mock.calls[0][0]).toMatchObject({
      type: "import:apply",
    });
    expect(target.applyImportedCookies).not.toHaveBeenCalled();
  });

  it("refuses bytes and options it cannot use", async () => {
    expect(SAFARI_ARCHIVE_LIMIT).toBe(16 * 1024 * 1024);
    const archive = fixture("export-store.zip");
    await refused(archive.toString("latin1"), both);
    await refused([...archive], both);
    await refused(archive.buffer, both);
    await refused(Buffer.alloc(21), both);
    await refused(Buffer.alloc(SAFARI_ARCHIVE_LIMIT + 1), both);
    await refused(archive, undefined);
    await refused(archive, { bookmarks: false, history: false });
    await refused(archive, { bookmarks: true });
    await refused(archive, { bookmarks: "yes", history: true });
    const target = fakeTarget();
    await expect(
      runSafariImport(
        target as unknown as ImportTarget,
        fixture("not-a-zip.zip"),
        both,
      ),
    ).rejects.toMatchObject({ code: "invalid_archive", message: NOT_ZIP });
  });
});
