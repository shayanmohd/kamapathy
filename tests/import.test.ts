import { execFileSync } from "node:child_process";
import { createCipheriv } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  availableBrowsers,
  chromiumTime,
  defaultBrowser,
  exclusive,
  firefoxTime,
  ImportError,
  importFrom,
  importSelections,
  parseChromiumBookmarks,
  parseImportRequest,
  parsePlistXml,
  runImport,
  type BrowserId,
  type ImportEnv,
  type ImportTarget,
  type MergeImportedPasswords,
} from "../electron/import";
import { deriveKey } from "../electron/import-cookies";
import type { BrowserAction } from "../shared/types";

// One test makes the removal of the temporary copy fail, and one follows
// the copies an import makes, since other files' imports share the folder.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm), mkdtemp: vi.fn(actual.mkdtemp) };
});

const fixtures = fileURLToPath(new URL("./fixtures/import/", import.meta.url));
const directories: string[] = [];
function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "kamapathy-browser-test-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function write(path: string, text = "") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function place(fixture: string, destination: string) {
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(fixtures, fixture), destination);
}
const fixtureJson = (fixture: string): unknown =>
  JSON.parse(readFileSync(join(fixtures, fixture), "utf8"));
const silent: ImportEnv["exec"] = () => "";
const failing: ImportEnv["exec"] = () => {
  throw new Error("command failed");
};
// The applications folder is the fake home's own, so browsers installed on
// this computer never change what a test sees.
const mac = (home: string, exec: ImportEnv["exec"] = silent): ImportEnv => ({
  platform: "darwin",
  home,
  exec,
  applications: join(home, "Applications"),
});
const support = (home: string) => join(home, "Library", "Application Support");
const both = { bookmarks: true, history: true };

const plistDict = (entries: Record<string, unknown>) =>
  `<dict>${Object.entries(entries)
    .map(([key, value]) => `<key>${key}</key><string>${value}</string>`)
    .join("")}</dict>`;
const launchServices = (handler?: Record<string, unknown>) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>LSHandlers</key><array>${plistDict(
    { LSHandlerContentType: "public.html", LSHandlerRoleAll: "com.apple.safari" },
  )}${handler ? plistDict(handler) : ""}</array></dict></plist>\n`;
const registry = (progId: string) =>
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice\r\n    ProgId    REG_SZ    ${progId}\r\n\r\n`;

function chromiumHistory(
  path: string,
  rows: [string, string | null, number, number, number][],
): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)",
  );
  const insert = db.prepare(
    "INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?)",
  );
  // One transaction: a thousand separate commits take seconds on Windows.
  db.exec("BEGIN");
  for (const row of rows) insert.run(...row);
  db.exec("COMMIT");
  return db;
}

function firefoxPlaces(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, rev_host LONGVARCHAR, visit_count INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0 NOT NULL, typed INTEGER DEFAULT 0 NOT NULL, frecency INTEGER DEFAULT -1 NOT NULL, last_visit_date INTEGER, guid TEXT, foreign_count INTEGER DEFAULT 0 NOT NULL, url_hash INTEGER DEFAULT 0 NOT NULL, description TEXT, preview_image_url TEXT, site_name TEXT, origin_id INTEGER, recalc_frecency INTEGER NOT NULL DEFAULT 0, alt_frecency INTEGER, recalc_alt_frecency INTEGER NOT NULL DEFAULT 0)",
  );
  db.exec(
    "CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER, position INTEGER, title LONGVARCHAR, keyword_id INTEGER, folder_type TEXT, dateAdded INTEGER, lastModified INTEGER, guid TEXT, syncStatus INTEGER NOT NULL DEFAULT 0, syncChangeCounter INTEGER NOT NULL DEFAULT 1)",
  );
  const placeRow = db.prepare(
    "INSERT INTO moz_places (id, url, title, visit_count, hidden, last_visit_date) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const places: [number, string, string | null, number, number, number | null][] = [
    [1, "https://kamapathy.app/", "Kamapathy", 4, 0, 1750000000000000],
    [2, "https://example.com/docs", "Docs", 2, 0, 1740000000000000],
    [3, "https://example.com/hidden", "Hidden", 1, 1, 1760000000000000],
    [4, "place:sort=8&maxResults=10", "Recent", 0, 0, null],
    [5, "https://example.com/never", "Never visited", 0, 0, null],
    [6, "https://example.com/menu", "Menu", 1, 0, 1730000000000000],
    [7, "https://example.com/unfiled", "Unfiled", 1, 0, 1720000000000000],
    [8, "https://example.com/mobile", "Mobile", 1, 0, 1710000000000000],
  ];
  for (const row of places) placeRow.run(...row);
  const bookmarkRow = db.prepare(
    "INSERT INTO moz_bookmarks (id, type, fk, parent, position, title, guid) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const bookmarks: [number, number, number | null, number, number, string | null, string][] = [
    [1, 2, null, 0, 0, "", "root________"],
    [2, 2, null, 1, 0, "menu", "menu________"],
    [3, 2, null, 1, 1, "toolbar", "toolbar_____"],
    [4, 2, null, 1, 2, "tags", "tags________"],
    [5, 2, null, 1, 3, "unfiled", "unfiled_____"],
    [6, 2, null, 1, 4, "mobile", "mobile______"],
    [7, 1, 1, 3, 1, "Kamapathy", "b0000000007_"],
    [8, 2, null, 3, 0, "Folder", "b0000000008_"],
    [9, 1, 2, 8, 0, "Docs", "b0000000009_"],
    [10, 1, 4, 3, 2, "Recent tags", "b0000000010_"],
    [11, 1, 5, 3, 3, "Never visited", "b0000000011_"],
    [12, 1, 6, 2, 0, "Menu", "b0000000012_"],
    [13, 2, null, 4, 0, "tagname", "b0000000013_"],
    [14, 1, 1, 13, 0, null, "b0000000014_"],
    [15, 1, 7, 5, 0, "Unfiled", "b0000000015_"],
    [16, 1, 8, 6, 0, "Mobile", "b0000000016_"],
    [17, 3, null, 3, 4, null, "b0000000017_"],
  ];
  for (const row of bookmarks) bookmarkRow.run(...row);
  db.close();
}

describe("timestamps", () => {
  it("converts each browser's clock to milliseconds since the epoch", () => {
    expect(chromiumTime(13400000000000000)).toBe(1755526400000);
    expect(firefoxTime(1750000000000000)).toBe(1750000000000);
    expect(chromiumTime(NaN)).toBeNaN();
  });
});

describe("bookmark parsers", () => {
  it("flattens Chromium roots in order and keeps web URLs only", () => {
    expect(parseChromiumBookmarks(fixtureJson("chromium/Bookmarks"))).toEqual([
      { title: "Kamapathy", url: "https://kamapathy.app/" },
      { title: "Docs", url: "https://kamapathy.app/docs/" },
      { title: "Nested", url: "https://example.com/nested" },
      { title: "https://example.com/untitled", url: "https://example.com/untitled" },
      { title: "Padded", url: "https://example.com/padded" },
      { title: "Other page", url: "https://example.com/other" },
      { title: "Phone", url: "https://example.com/phone" },
    ]);
  });
  it("trims titles, drops duplicates and stops at 1000 Chromium bookmarks", () => {
    const children = Array.from({ length: 1200 }, (_, index) => ({
      type: "url",
      name: index === 0 ? "x".repeat(400) : `Page ${index}`,
      url: `https://example.com/${index % 1100}`,
    }));
    const parsed = parseChromiumBookmarks({ roots: { bookmark_bar: { children } } });
    expect(parsed).toHaveLength(1000);
    expect(parsed[0].title).toHaveLength(300);
    expect(new Set(parsed.map((item) => item.url)).size).toBe(1000);
    expect(parseChromiumBookmarks(null)).toEqual([]);
    expect(parseChromiumBookmarks("text")).toEqual([]);
  });
});

describe("plist reader", () => {
  it("reads every value type plutil writes as XML", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Blob</key>
\t<data>
\taGVs
\tbG8=
\t</data>
\t<key>Count</key>
\t<integer>-3</integer>
\t<key>Empty</key>
\t<string></string>
\t<key>List</key>
\t<array>
\t\t<string>x</string>
\t\t<real>1.5</real>
\t\t<true/>
\t\t<false/>
\t\t<array/>
\t\t<dict/>
\t</array>
\t<key>Seen</key>
\t<date>2025-01-01T00:00:00Z</date>
\t<key>Tom &amp; Jerry</key>
\t<string>A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65;&#x42;</string>
</dict>
</plist>
`;
    expect(parsePlistXml(xml)).toEqual({
      Blob: "aGVsbG8=",
      Count: -3,
      Empty: "",
      List: ["x", 1.5, true, false, [], {}],
      Seen: "2025-01-01T00:00:00.000Z",
      "Tom & Jerry": "A & B <c> \"d\" 'e' AB",
    });
    expect(parsePlistXml("<plist version=\"1.0\"><string>alone</string></plist>")).toBe("alone");
  });
  it("rejects text that is not a plist", () => {
    expect(() => parsePlistXml("not a plist")).toThrow();
    expect(() => parsePlistXml("<plist version=\"1.0\"><dict><key>a</key></dict></plist>")).toThrow();
    expect(() => parsePlistXml("<plist version=\"1.0\"><dict><string>a</string></dict></plist>")).toThrow();
    expect(() => parsePlistXml("<plist version=\"1.0\"><array><string>open</plist>")).toThrow();
    expect(() => parsePlistXml("<plist version=\"1.0\"><array><string>a</string>")).toThrow();
    expect(() => parsePlistXml("<plist version=\"1.0\"><dict><key>a</key><thing/></dict></plist>")).toThrow();
  });
  it.skipIf(process.platform !== "darwin")("reads what plutil writes for a binary plist", () => {
    const binary = join(folder(), "Bookmarks.plist");
    execFileSync("plutil", ["-convert", "binary1", "-o", binary, join(fixtures, "safari/Bookmarks.plist")]);
    const xml = execFileSync("plutil", ["-convert", "xml1", "-o", "-", binary], { encoding: "utf8" });
    expect(parsePlistXml(xml)).toEqual(parsePlistXml(readFileSync(join(fixtures, "safari/Bookmarks.plist"), "utf8")));
    // The dates in the Reading List are what made the JSON conversion fail.
    expect(() => execFileSync("plutil", ["-convert", "json", "-o", "-", binary], { stdio: "pipe" })).toThrow();
  });
  it("reads Safari's bookmark file with its Reading List dates", () => {
    const plist = parsePlistXml(readFileSync(join(fixtures, "safari/Bookmarks.plist"), "utf8")) as {
      Children: { Title: string; Children?: Record<string, unknown>[] }[];
      Sync: Record<string, unknown>;
      WebBookmarkFileVersion: number;
    };
    expect(plist.WebBookmarkFileVersion).toBe(1);
    expect(plist.Sync).toEqual({ CloudKitMigrationState: 2, ServerData: "AAECAwQF" });
    const readingList = plist.Children.find((list) => list.Title === "com.apple.ReadingList");
    expect(readingList?.Children?.[0].ReadingList).toEqual({
      DateAdded: "2025-01-01T00:00:00.000Z",
      DateLastViewed: "2025-01-02T10:30:00.000Z",
      PreviewText: "The first lines of the article.",
    });
    expect(readingList?.Children?.[0].ReadingListNonSync).toEqual({
      AddedLocally: true,
      FetchResult: 1,
      neverFetchMetadata: false,
      siteName: "Example",
    });
  });
});

describe("browser detection", () => {
  it("lists installed browsers and their profiles on macOS", () => {
    const home = folder();
    const chrome = join(support(home), "Google", "Chrome");
    place("chromium/Local State", join(chrome, "Local State"));
    mkdirSync(join(chrome, "Default"));
    mkdirSync(join(chrome, "Profile 1"));
    mkdirSync(join(support(home), "Microsoft Edge", "Default"), { recursive: true });
    write(join(support(home), "com.operasoftware.Opera", "Bookmarks"), "{}");
    mkdirSync(join(support(home), "BraveSoftware", "Brave-Browser"), { recursive: true });
    const firefox = join(support(home), "Firefox");
    place("firefox/profiles.ini", join(firefox, "profiles.ini"));
    mkdirSync(join(firefox, "Profiles", "a1b2c3d4.default"), { recursive: true });
    mkdirSync(join(firefox, "Profiles", "k3p9x1zq.default-release"), { recursive: true });
    mkdirSync(join(home, "Library", "Safari"), { recursive: true });
    const exec: ImportEnv["exec"] = (command) =>
      command === "plutil"
        ? launchServices({ LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.google.Chrome" })
        : "";

    expect(availableBrowsers(mac(home, exec))).toEqual([
      {
        id: "chrome",
        name: "Google Chrome",
        default: true,
        profiles: [
          { id: "Profile 1", name: "Work" },
          { id: "Default", name: "Person 1" },
        ],
        signInsAvailable: true,
        passwordsAvailable: true,
        status: "ready",
      },
      {
        id: "edge",
        name: "Microsoft Edge",
        default: false,
        profiles: [{ id: "Default", name: "Default" }],
        signInsAvailable: true,
        passwordsAvailable: true,
        status: "ready",
      },
      {
        id: "brave",
        name: "Brave",
        default: false,
        profiles: [],
        signInsAvailable: true,
        passwordsAvailable: true,
        status: "ready",
      },
      {
        id: "opera",
        name: "Opera",
        default: false,
        profiles: [{ id: ".", name: "Default" }],
        signInsAvailable: true,
        passwordsAvailable: true,
        status: "ready",
      },
      {
        id: "firefox",
        name: "Firefox",
        default: false,
        profiles: [
          { id: "Profiles/k3p9x1zq.default-release", name: "default-release" },
          { id: "Profiles/a1b2c3d4.default", name: "default" },
        ],
        signInsAvailable: false,
        passwordsAvailable: false,
        status: "ready",
      },
      {
        id: "safari",
        name: "Safari",
        default: false,
        profiles: [{ id: "default", name: "Default" }],
        signInsAvailable: false,
        passwordsAvailable: false,
        status: "ready",
      },
    ]);
  });
  it("uses the local and roaming application data folders on Windows", () => {
    const home = folder();
    const local = join(home, "AppData", "Local");
    const roaming = join(home, "AppData", "Roaming");
    mkdirSync(join(local, "Google", "Chrome", "User Data", "Default"), { recursive: true });
    mkdirSync(join(local, "Microsoft", "Edge", "User Data", "Default"), { recursive: true });
    write(join(roaming, "Opera Software", "Opera Stable", "History"));
    write(join(roaming, "Mozilla", "Firefox", "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/abc.default\n");
    mkdirSync(join(roaming, "Mozilla", "Firefox", "Profiles", "abc.default"), { recursive: true });
    mkdirSync(join(home, "Library", "Safari"), { recursive: true });
    const env: ImportEnv = {
      platform: "win32",
      home,
      appData: roaming,
      localAppData: local,
      exec: (command) => (command === "reg" ? registry("FirefoxURL-308046B0AF4A39CB") : ""),
    };
    expect(availableBrowsers(env).map((source) => [source.id, source.default])).toEqual([
      ["chrome", false],
      ["edge", false],
      ["opera", false],
      ["firefox", true],
    ]);
    expect(availableBrowsers({ ...env, localAppData: undefined }).map((source) => source.id)).toEqual([
      "opera",
      "firefox",
    ]);
  });
  it("looks under the home folder on Linux", () => {
    const home = folder();
    mkdirSync(join(home, ".config", "google-chrome", "Default"), { recursive: true });
    mkdirSync(join(home, ".config", "BraveSoftware", "Brave-Browser", "Default"), { recursive: true });
    write(join(home, ".mozilla", "firefox", "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=abc.default\n");
    mkdirSync(join(home, ".mozilla", "firefox", "abc.default"), { recursive: true });
    mkdirSync(join(home, "Library", "Safari"), { recursive: true });
    const env: ImportEnv = {
      platform: "linux",
      home,
      exec: (command) => (command === "xdg-settings" ? "brave-browser.desktop\n" : ""),
    };
    const ready = { status: "ready" };
    expect(availableBrowsers(env)).toEqual([
      { id: "chrome", name: "Google Chrome", default: false, profiles: [{ id: "Default", name: "Default" }], signInsAvailable: true, passwordsAvailable: true, ...ready },
      { id: "brave", name: "Brave", default: true, profiles: [{ id: "Default", name: "Default" }], signInsAvailable: true, passwordsAvailable: true, ...ready },
      { id: "firefox", name: "Firefox", default: false, profiles: [{ id: "abc.default", name: "default" }], signInsAvailable: false, passwordsAvailable: false, ...ready },
    ]);
  });
  it("sources report passwordsAvailable for the Chromium family only", () => {
    const home = folder();
    for (const dir of [
      "Google/Chrome",
      "Chromium",
      "Microsoft Edge",
      "BraveSoftware/Brave-Browser",
      "Arc/User Data",
      "Vivaldi",
      "com.operasoftware.Opera",
    ])
      mkdirSync(join(support(home), dir, "Default"), { recursive: true });
    write(join(support(home), "Firefox", "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=abc\n");
    mkdirSync(join(support(home), "Firefox", "abc"), { recursive: true });
    mkdirSync(join(home, "Library", "Safari"), { recursive: true });

    expect(
      availableBrowsers(mac(home)).map((source) => [source.id, source.passwordsAvailable]),
    ).toEqual([
      ["chrome", true],
      ["chromium", true],
      ["edge", true],
      ["brave", true],
      ["arc", true],
      ["vivaldi", true],
      ["opera", true],
      ["firefox", false],
      ["safari", false],
    ]);
  });

  it("finds nothing in an empty home", () => {
    expect(availableBrowsers(mac(folder()))).toEqual([]);
  });
});

describe("default browser", () => {
  it("reads the LaunchServices handler on macOS", () => {
    const home = folder();
    const calls: [string, string[]][] = [];
    const lookup = (json: string) =>
      defaultBrowser(
        mac(home, (command, args) => {
          calls.push([command, args]);
          return json;
        }),
      );
    expect(lookup(launchServices({ LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.google.chrome" }))).toBe("chrome");
    expect(calls[0]).toEqual([
      "plutil",
      [
        "-convert",
        "xml1",
        "-o",
        "-",
        join(home, "Library", "Preferences", "com.apple.LaunchServices", "com.apple.launchservices.secure.plist"),
      ],
    ]);
    expect(lookup(launchServices({ LSHandlerURLScheme: "http", LSHandlerRoleViewer: "org.mozilla.firefox" }))).toBe("firefox");
    expect(lookup(launchServices({ LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.microsoft.edgemac" }))).toBe("edge");
    expect(lookup(launchServices({ LSHandlerURLScheme: "https", LSHandlerRoleAll: "company.thebrowser.Browser" }))).toBe("arc");
    expect(lookup(launchServices({ LSHandlerURLScheme: "https", LSHandlerRoleAll: "com.kagi.kagimacos" }))).toBeUndefined();
    expect(lookup(launchServices())).toBe("safari");
    expect(lookup("not a plist")).toBeUndefined();
    expect(defaultBrowser(mac(home, failing))).toBeUndefined();
  });
  it("reads the UserChoice ProgId on Windows", () => {
    const lookup = (output: string, exec?: ImportEnv["exec"]) =>
      defaultBrowser({
        platform: "win32",
        home: "C:\\Users\\me",
        exec:
          exec ??
          ((command, args) => {
            expect(command).toBe("reg");
            expect(args).toEqual([
              "query",
              "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice",
              "/v",
              "ProgId",
            ]);
            return output;
          }),
      });
    expect(lookup(registry("MSEdgeHTM"))).toBe("edge");
    expect(lookup(registry("ChromeHTML"))).toBe("chrome");
    expect(lookup(registry("BraveHTML"))).toBe("brave");
    expect(lookup(registry("OperaStable"))).toBe("opera");
    expect(lookup(registry("IE.HTTPS"))).toBeUndefined();
    expect(lookup("")).toBeUndefined();
    expect(lookup("", failing)).toBeUndefined();
  });
  it("asks xdg-settings on Linux", () => {
    const lookup = (output: string) =>
      defaultBrowser({
        platform: "linux",
        home: "/home/me",
        exec: (command, args) => {
          expect([command, args]).toEqual(["xdg-settings", ["get", "default-web-browser"]]);
          return output;
        },
      });
    expect(lookup("firefox.desktop\n")).toBe("firefox");
    expect(lookup("google-chrome.desktop\n")).toBe("chrome");
    expect(lookup("chromium.desktop\n")).toBe("chromium");
    expect(lookup("vivaldi-stable.desktop\n")).toBe("vivaldi");
    expect(lookup("org.gnome.Epiphany.desktop\n")).toBeUndefined();
    expect(lookup("\n")).toBeUndefined();
    expect(defaultBrowser({ platform: "linux", home: "/home/me", exec: failing })).toBeUndefined();
  });
  it("knows nothing about other platforms", () => {
    expect(defaultBrowser({ platform: "freebsd", home: "/home/me", exec: failing })).toBeUndefined();
  });
});

describe("Chromium import", () => {
  const rows: [string, string | null, number, number, number][] = [
    ["https://kamapathy.app/", "Kamapathy", 5, 13400000000000000, 0],
    ["https://example.com/docs", null, 2, 13390000000000000, 0],
    ["https://example.com/hidden", "Hidden", 1, 13395000000000000, 1],
    ["chrome://newtab/", "New Tab", 9, 13399000000000000, 0],
    ["file:///Users/me/a.html", "File", 1, 13398000000000000, 0],
    ["https://example.com/future", "Future", 0, 20000000000000000, 0],
    ["https://example.com/never", "Never", 0, 0, 0],
  ];
  function chromeProfile(home: string): string {
    const chrome = join(support(home), "Google", "Chrome");
    place("chromium/Local State", join(chrome, "Local State"));
    mkdirSync(join(chrome, "Default"));
    mkdirSync(join(chrome, "Profile 1"));
    return join(chrome, "Profile 1");
  }
  it("reads a copy of the history while the browser holds the file locked", async () => {
    const home = folder();
    const profile = chromeProfile(home);
    place("chromium/Bookmarks", join(profile, "Bookmarks"));
    const source = chromiumHistory(join(profile, "History"), rows);
    source.exec("BEGIN EXCLUSIVE");
    const direct = new DatabaseSync(join(profile, "History"), { readOnly: true });
    expect(() => direct.prepare("SELECT url FROM urls").all()).toThrow(/locked/);
    direct.close();
    const earlier = vi.mocked(mkdtemp).mock.results.length;
    const started = Date.now();

    const result = await importFrom("chrome", undefined, both, mac(home));

    source.exec("COMMIT");
    source.close();
    expect(result.warnings).toEqual([]);
    expect(result.bookmarks).toHaveLength(7);
    expect(result.bookmarks[0]).toEqual({ title: "Kamapathy", url: "https://kamapathy.app/" });
    expect(result.history.map((visit) => visit.url)).toEqual([
      "https://example.com/future",
      "https://kamapathy.app/",
      "https://example.com/docs",
    ]);
    expect(result.history[0].visits).toBe(1);
    expect(result.history[0].visitedAt).toBeGreaterThanOrEqual(started);
    expect(result.history[0].visitedAt).toBeLessThanOrEqual(Date.now());
    expect(result.history[1]).toEqual({
      title: "Kamapathy",
      url: "https://kamapathy.app/",
      visitedAt: 1755526400000,
      visits: 5,
    });
    expect(result.history[2].title).toBe("https://example.com/docs");
    const copies = await Promise.all(
      vi.mocked(mkdtemp).mock.results.slice(earlier).map((call) => call.value),
    );
    expect(copies.length).toBeGreaterThan(0);
    expect(copies.filter((copy) => existsSync(copy))).toEqual([]);
  });
  it("keeps what it read when the temporary copy cannot be removed", async () => {
    const home = folder();
    const profile = chromeProfile(home);
    chromiumHistory(join(profile, "History"), rows).close();
    const busy = Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
    vi.mocked(rm).mockRejectedValueOnce(busy);

    const result = await importFrom("chrome", undefined, { bookmarks: false, history: true }, mac(home));

    expect(result.warnings).toEqual([]);
    expect(result.history).toHaveLength(3);
    const [copy, options] = vi.mocked(rm).mock.lastCall ?? [];
    expect(options).toEqual({ recursive: true, force: true, maxRetries: 3 });
    rmSync(copy as string, { recursive: true, force: true });
  });
  it("keeps the 1000 most recent visits", async () => {
    const home = folder();
    const profile = chromeProfile(home);
    const many: [string, string | null, number, number, number][] = Array.from(
      { length: 1200 },
      (_, index) => [`https://example.com/${index}`, `Page ${index}`, 1, 13300000000000000 + index * 1000000, 0],
    );
    chromiumHistory(join(profile, "History"), many).close();
    const result = await importFrom("chrome", "Profile 1", { bookmarks: true, history: true }, mac(home));
    expect(result.history).toHaveLength(1000);
    expect(result.history[0].url).toBe("https://example.com/1199");
    expect(result.history[999].url).toBe("https://example.com/200");
    expect(result.bookmarks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
  it("honours the requested profile and the option switches", async () => {
    const home = folder();
    const chrome = join(support(home), "Google", "Chrome");
    chromeProfile(home);
    place("chromium/Bookmarks", join(chrome, "Default", "Bookmarks"));
    chromiumHistory(join(chrome, "Default", "History"), rows).close();
    const onlyBookmarks = await importFrom("chrome", "Default", { bookmarks: true, history: false }, mac(home));
    expect(onlyBookmarks.bookmarks).toHaveLength(7);
    expect(onlyBookmarks.history).toEqual([]);
    const onlyHistory = await importFrom("chrome", "Default", { bookmarks: false, history: true }, mac(home));
    expect(onlyHistory.bookmarks).toEqual([]);
    expect(onlyHistory.history).toHaveLength(3);
  });
  it("reads a single profile kept in the data folder itself", async () => {
    const home = folder();
    const opera = join(support(home), "com.operasoftware.Opera");
    place("chromium/Bookmarks", join(opera, "Bookmarks"));
    chromiumHistory(join(opera, "History"), rows).close();
    const result = await importFrom("opera", undefined, both, mac(home));
    expect(result.bookmarks).toHaveLength(7);
    expect(result.history).toHaveLength(3);
  });
  it("turns unreadable files into warnings and carries on", async () => {
    const home = folder();
    const profile = chromeProfile(home);
    write(join(profile, "Bookmarks"), "{ not json");
    write(join(profile, "History"), "not a database");
    const result = await importFrom("chrome", undefined, both, mac(home));
    expect(result).toEqual({
      bookmarks: [],
      history: [],
      warnings: ["Could not read Google Chrome bookmarks.", "Could not read Google Chrome history."],
    });
    rmSync(join(profile, "Bookmarks"));
    rmSync(join(profile, "History"));
    expect(await importFrom("chrome", undefined, both, mac(home))).toEqual({
      bookmarks: [],
      history: [],
      warnings: [],
    });
  });
  it("rejects unknown browsers and profiles", async () => {
    const home = folder();
    await expect(importFrom("nope" as BrowserId, undefined, both, mac(home))).rejects.toThrow("Unknown browser.");
    await expect(importFrom("chrome", undefined, both, mac(home))).rejects.toThrow(
      "Google Chrome was not found on this computer.",
    );
    chromeProfile(home);
    await expect(importFrom("chrome", "Profile 9", both, mac(home))).rejects.toThrow(
      "Google Chrome profile was not found.",
    );
    await expect(importFrom("safari", undefined, both, { platform: "linux", home, exec: silent })).rejects.toThrow(
      "Safari was not found on this computer.",
    );
  });
});

describe("Firefox import", () => {
  it("walks the bookmark roots in order and lists visited places", async () => {
    const home = folder();
    const firefox = join(support(home), "Firefox");
    place("firefox/profiles.ini", join(firefox, "profiles.ini"));
    const release = join(firefox, "Profiles", "k3p9x1zq.default-release");
    firefoxPlaces(join(release, "places.sqlite"));
    const other = join(firefox, "Profiles", "a1b2c3d4.default");
    mkdirSync(other, { recursive: true });

    const result = await importFrom("firefox", undefined, both, mac(home));

    expect(result.warnings).toEqual([]);
    expect(result.bookmarks).toEqual([
      { title: "Docs", url: "https://example.com/docs" },
      { title: "Kamapathy", url: "https://kamapathy.app/" },
      { title: "Never visited", url: "https://example.com/never" },
      { title: "Menu", url: "https://example.com/menu" },
      { title: "Unfiled", url: "https://example.com/unfiled" },
      { title: "Mobile", url: "https://example.com/mobile" },
    ]);
    expect(result.history).toEqual([
      { title: "Kamapathy", url: "https://kamapathy.app/", visitedAt: 1750000000000, visits: 4 },
      { title: "Docs", url: "https://example.com/docs", visitedAt: 1740000000000, visits: 2 },
      { title: "Menu", url: "https://example.com/menu", visitedAt: 1730000000000, visits: 1 },
      { title: "Unfiled", url: "https://example.com/unfiled", visitedAt: 1720000000000, visits: 1 },
      { title: "Mobile", url: "https://example.com/mobile", visitedAt: 1710000000000, visits: 1 },
    ]);
    const empty = await importFrom("firefox", "Profiles/a1b2c3d4.default", both, mac(home));
    expect(empty).toEqual({ bookmarks: [], history: [], warnings: [] });
    await expect(importFrom("firefox", "Profiles/none", both, mac(home))).rejects.toThrow(
      "Firefox profile was not found.",
    );
  });
  it("follows absolute profile paths", async () => {
    const home = folder();
    const elsewhere = folder();
    firefoxPlaces(join(elsewhere, "places.sqlite"));
    write(
      join(support(home), "Firefox", "profiles.ini"),
      `[Profile0]\nName=elsewhere\nIsRelative=0\nPath=${elsewhere}\n`,
    );
    expect(availableBrowsers(mac(home))).toEqual([
      {
        id: "firefox",
        name: "Firefox",
        default: false,
        profiles: [{ id: elsewhere, name: "elsewhere" }],
        signInsAvailable: false,
        passwordsAvailable: false,
        status: "ready",
      },
    ]);
    const result = await importFrom("firefox", elsewhere, { bookmarks: false, history: true }, mac(home));
    expect(result.history).toHaveLength(5);
    expect(result.bookmarks).toEqual([]);
  });
  it("warns once when places.sqlite cannot be read", async () => {
    const home = folder();
    write(join(support(home), "Firefox", "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=abc\n");
    write(join(support(home), "Firefox", "abc", "places.sqlite"), "broken");
    const result = await importFrom("firefox", undefined, both, mac(home));
    expect(result.warnings).toEqual(["Could not read Firefox bookmarks and history."]);
    const historyOnly = await importFrom("firefox", undefined, { bookmarks: false, history: true }, mac(home));
    expect(historyOnly.warnings).toEqual(["Could not read Firefox history."]);
  });
});

describe("Safari", () => {
  it("is offered on macOS without reading its folder, and never elsewhere", () => {
    const home = folder();
    const safari = join(home, "Library", "Safari");
    mkdirSync(safari, { recursive: true });
    write(join(safari, "Bookmarks.plist"), "bplist00");
    chmodSync(safari, 0o000);
    try {
      expect(availableBrowsers(mac(home))).toEqual([
        {
          id: "safari",
          name: "Safari",
          default: false,
          profiles: [{ id: "default", name: "Default" }],
          signInsAvailable: false,
          passwordsAvailable: false,
          status: "ready",
        },
      ]);
    } finally {
      chmodSync(safari, 0o700);
    }
    expect(availableBrowsers({ platform: "linux", home, exec: silent })).toEqual([]);
    expect(availableBrowsers({ platform: "win32", home, exec: silent })).toEqual([]);
  });
  it("cannot be asked for as a selection", () => {
    const request = { bookmarks: true, history: true, signIns: "none" };
    const refused = (profiles: unknown[]) => {
      let code = "no error";
      try {
        parseImportRequest({ ...request, profiles });
      } catch (error) {
        code = error instanceof ImportError ? error.code : "not an ImportError";
      }
      return code;
    };
    expect(refused([{ source: "safari" }])).toBe("import_invalid_request");
    expect(refused([{ source: "chrome" }, { source: "safari" }])).toBe("import_invalid_request");
    expect(refused([{ source: "chrome" }])).toBe("no error");
  });
});

describe("several profiles, sign-ins and permissions", () => {
  // The fixture's Local State names Default "Person 1" and Profile 1 "Work".
  function chromeHome(): { home: string; chrome: string } {
    const home = folder();
    const chrome = join(support(home), "Google", "Chrome");
    place("chromium/Local State", join(chrome, "Local State"));
    mkdirSync(join(chrome, "Default"));
    mkdirSync(join(chrome, "Profile 1"));
    return { home, chrome };
  }
  const bookmarkFile = (path: string, items: [string, string][]) =>
    write(
      path,
      JSON.stringify({
        roots: {
          bookmark_bar: {
            type: "folder",
            children: items.map(([name, url]) => ({ type: "url", name, url })),
          },
        },
      }),
    );
  const at = (millis: number) => (millis + 11644473600000) * 1000;
  const numbered = (prefix: string, count: number): [string, string][] =>
    Array.from({ length: count }, (_, index) => [
      `${prefix} ${index}`,
      `https://${prefix.toLowerCase()}.example/${index}`,
    ]);
  const encrypt = (password: string, value: string) => {
    const cipher = createCipheriv("aes-128-cbc", deriveKey(password, 1003), Buffer.alloc(16, 0x20));
    return Buffer.concat([Buffer.from("v10"), cipher.update(value), cipher.final()]);
  };
  const garbage = (length: number) => Buffer.concat([Buffer.from("v10"), Buffer.alloc(length)]);
  function cookieFile(path: string, rows: [string, string, Uint8Array][]) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, is_persistent INTEGER, top_frame_site_key TEXT)",
    );
    const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, '', ?, '/', 0, 1, 1, 1, 0, '')");
    for (const row of rows) insert.run(...row);
    db.close();
  }
  function loginFile(path: string, rows: [string, string, Uint8Array, number][]) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(
      "CREATE TABLE logins(id INTEGER PRIMARY KEY AUTOINCREMENT, origin_url TEXT, signon_realm TEXT, username_value TEXT, password_value BLOB, scheme INTEGER, blacklisted_by_user INTEGER, federation_url TEXT, date_created INTEGER, date_last_used INTEGER, date_password_modified INTEGER)",
    );
    db.exec("CREATE TABLE password_notes(parent_id INTEGER, key TEXT, value BLOB)");
    db.exec(
      "CREATE TABLE insecure_credentials(parent_id INTEGER, insecurity_type INTEGER, is_muted INTEGER)",
    );
    const insert = db.prepare(
      "INSERT INTO logins (origin_url, signon_realm, username_value, password_value, scheme, blacklisted_by_user, federation_url, date_created, date_last_used, date_password_modified) VALUES (?, ?, ?, ?, 0, ?, '', 0, 0, 0)",
    );
    for (const [origin, username, password, blacklisted] of rows)
      insert.run(origin, origin, username, password, blacklisted);
    db.close();
  }
  function fakeTarget(state: ImportTarget["state"]) {
    return {
      state,
      dispatch: vi.fn(async (action: BrowserAction) => {
        if (action.type !== "import:apply") return;
        for (const item of action.bookmarks)
          if (!state.bookmarks.some((entry) => entry.url === item.url))
            state.bookmarks.push({ id: item.url, createdAt: 0, ...item });
        for (const item of action.history)
          if (!state.history.some((entry) => entry.url === item.url))
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
  const codeOf = (run: () => unknown): string | undefined => {
    try {
      run();
    } catch (error) {
      return error instanceof ImportError ? error.code : "not an ImportError";
    }
    return undefined;
  };
  const both = { bookmarks: true, history: true, signIns: false };
  const blockable = process.platform !== "win32" && process.getuid?.() !== 0;

  it("import: multiple profiles merge once", async () => {
    const { home, chrome } = chromeHome();
    const now = Date.now();
    bookmarkFile(join(chrome, "Profile 1", "Bookmarks"), [
      ["Work shared", "https://shared.example/"],
      ...numbered("Work", 600),
    ]);
    bookmarkFile(join(chrome, "Default", "Bookmarks"), [
      ["Person shared", "https://shared.example/"],
      ...numbered("Person", 600),
    ]);
    chromiumHistory(join(chrome, "Profile 1", "History"), [
      ["https://shared.example/", "Work shared", 2, at(now - 2000), 0],
      ["https://work.example/page", "Work page", 1, at(now - 3000), 0],
    ]).close();
    chromiumHistory(join(chrome, "Default", "History"), [
      ["https://shared.example/", "Person shared", 9, at(now - 1000), 0],
      ["https://person.example/page", "Person page", 1, at(now - 4000), 0],
    ]).close();
    const selections = [
      { source: "chrome", profile: "Profile 1" },
      { source: "chrome", profile: "Default" },
    ];

    const data = await importSelections(selections, both, mac(home));

    expect(data.bookmarks).toHaveLength(1000);
    expect(data.bookmarks[0]).toEqual({ title: "Work shared", url: "https://shared.example/" });
    expect(data.bookmarks.filter((item) => item.url === "https://shared.example/")).toHaveLength(1);
    expect(data.bookmarks[600]).toEqual({ title: "Work 599", url: "https://work.example/599" });
    expect(data.bookmarks[601]).toEqual({ title: "Person 0", url: "https://person.example/0" });
    expect(data.bookmarks[999].url).toBe("https://person.example/398");
    expect(data.history.map((visit) => [visit.url, visit.title, visit.visits])).toEqual([
      ["https://shared.example/", "Work shared", 2],
      ["https://work.example/page", "Work page", 1],
      ["https://person.example/page", "Person page", 1],
    ]);
    expect(data.profiles).toEqual([]);
    expect(data.warnings).toEqual([]);

    const target = fakeTarget({
      bookmarks: [{ id: "known", title: "Known", url: "https://shared.example/", createdAt: 1 }],
      history: [{ id: "seen", title: "Seen", url: "https://work.example/page", visitedAt: 1 }],
    });
    const outcome = await runImport(
      target,
      { profiles: selections, bookmarks: true, history: true, signIns: "none" },
      mac(home),
    );
    expect(target.dispatch).toHaveBeenCalledTimes(1);
    expect(target.dispatch.mock.calls[0][0]).toMatchObject({ type: "import:apply" });
    expect(target.applyImportedCookies).not.toHaveBeenCalled();
    expect(outcome).toEqual({ bookmarks: 999, history: 2, signIns: 0, spaces: [], warnings: [] });
  });

  it.skipIf(!blockable)("import-sources: installed-but-unreadable source is needs_permission", () => {
    const { home, chrome } = chromeHome();
    mkdirSync(join(support(home), "Microsoft Edge", "Default"), { recursive: true });
    write(join(support(home), "Firefox", "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=abc\n");
    mkdirSync(join(support(home), "Firefox", "abc"));
    mkdirSync(join(home, "Library", "Safari"), { recursive: true });
    chmodSync(chrome, 0o000);
    try {
      expect(
        availableBrowsers(mac(home)).map((source) => [
          source.id,
          source.status,
          source.profiles,
          source.signInsAvailable,
        ]),
      ).toEqual([
        ["chrome", "needs_permission", [], true],
        ["edge", "ready", [{ id: "Default", name: "Default" }], true],
        ["firefox", "ready", [{ id: "abc", name: "default" }], false],
        ["safari", "ready", [{ id: "default", name: "Default" }], false],
      ]);
    } finally {
      chmodSync(chrome, 0o700);
    }
  });

  it("treats an installed browser whose data folder reads empty as blocked on macOS", () => {
    const home = folder();
    mkdirSync(join(support(home), "BraveSoftware", "Brave-Browser"), { recursive: true });
    mkdirSync(join(support(home), "Vivaldi"), { recursive: true });
    mkdirSync(join(home, "Applications", "Brave Browser.app"), { recursive: true });
    mkdirSync(join(home, ".config", "BraveSoftware", "Brave-Browser"), { recursive: true });
    const statuses = (env: ImportEnv) => availableBrowsers(env).map((source) => [source.id, source.status]);
    expect(statuses(mac(home))).toEqual([
      ["brave", "needs_permission"],
      ["vivaldi", "ready"],
    ]);
    expect(statuses({ ...mac(home), platform: "linux" })).toEqual([["brave", "ready"]]);
  });

  it("rejects malformed requests", () => {
    const valid = {
      profiles: [{ source: "chrome", profile: "Default" }],
      bookmarks: true,
      history: false,
      signIns: "none",
    };
    expect(parseImportRequest({ ...valid, extra: true })).toEqual(valid);
    expect(
      parseImportRequest({ ...valid, profiles: [{ source: "firefox" }], bookmarks: false, signIns: "separate" }),
    ).toEqual({ profiles: [{ source: "firefox" }], bookmarks: false, history: false, signIns: "separate" });
    expect(
      parseImportRequest({
        ...valid,
        profiles: [
          { source: "chrome", profile: "Default" },
          { source: "firefox" },
          { source: "chrome", profile: "Default", note: 1 },
          { source: "firefox" },
          { source: "chrome" },
        ],
      }).profiles,
    ).toEqual([{ source: "chrome", profile: "Default" }, { source: "firefox" }, { source: "chrome" }]);
    const many = Array.from({ length: 64 }, (_, index) => ({ source: "edge", profile: `Profile ${index}` }));
    expect(parseImportRequest({ ...valid, profiles: many }).profiles).toHaveLength(64);
    expect(parseImportRequest({ ...valid, profiles: [{ source: "edge", profile: "p".repeat(512) }] })).toBeTruthy();
    const cyclic: Record<string, unknown> = { ...valid };
    cyclic.self = cyclic;
    const invalid: unknown[] = [
      undefined,
      null,
      "chrome",
      [valid],
      cyclic,
      { ...valid, padding: "x".repeat(65536) },
      { ...valid, profiles: [] },
      { ...valid, profiles: undefined },
      { ...valid, profiles: { source: "chrome" } },
      { ...valid, profiles: [...many, { source: "edge" }] },
      { ...valid, profiles: [{ source: "netscape" }] },
      { ...valid, profiles: [{ source: "toString" }] },
      { ...valid, profiles: [{ profile: "Default" }] },
      { ...valid, profiles: ["chrome"] },
      { ...valid, profiles: [null] },
      { ...valid, profiles: [{ source: "chrome", profile: 1 }] },
      { ...valid, profiles: [{ source: "chrome", profile: null }] },
      { ...valid, profiles: [{ source: "chrome", profile: "p".repeat(513) }] },
      { ...valid, bookmarks: "yes" },
      { ...valid, history: undefined },
      { ...valid, signIns: "everywhere" },
      { ...valid, signIns: undefined },
      { ...valid, bookmarks: false, history: false, signIns: "none" },
    ];
    for (const value of invalid) {
      expect(codeOf(() => parseImportRequest(value))).toBe("import_invalid_request");
      expect(() => parseImportRequest(value)).toThrow("Something was wrong with that import. Try again.");
    }
    expect(
      parseImportRequest({ ...valid, bookmarks: false, history: false, signIns: "shared" }).signIns,
    ).toBe("shared");
  });

  it("runs one import at a time", async () => {
    let finish!: (value: string) => void;
    const first = exclusive(() => new Promise<string>((resolve) => (finish = resolve)));
    const busy = exclusive(async () => "second");
    await expect(busy).rejects.toBeInstanceOf(ImportError);
    await expect(busy).rejects.toMatchObject({
      code: "import_busy",
      message: "An import is already running.",
      fields: { retryable: true },
    });
    finish("first");
    expect(await first).toBe("first");
    expect(await exclusive(async () => "third")).toBe("third");
    await expect(
      exclusive(async () => {
        throw new Error("broken");
      }),
    ).rejects.toThrow("broken");
    await expect(
      exclusive(() => {
        throw new Error("thrown before a promise");
      }),
    ).rejects.toThrow("thrown before a promise");
    expect(await exclusive(async () => "fourth")).toBe("fourth");
  });

  it("reads sign-ins from a Chrome profile", async () => {
    const { home, chrome } = chromeHome();
    place("chromium/Bookmarks", join(chrome, "Default", "Bookmarks"));
    chromiumHistory(join(chrome, "Default", "History"), [
      ["https://kamapathy.app/", "Kamapathy", 1, at(Date.now() - 1000), 0],
    ]).close();
    cookieFile(join(chrome, "Default", "Network", "Cookies"), [
      [".example.com", "sid", encrypt("chrome-password", "secret-1")],
      ["mail.example.com", "token", encrypt("chrome-password", "secret-2")],
      ["broken.example", "bad", garbage(5)],
    ]);
    cookieFile(join(chrome, "Profile 1", "Network", "Cookies"), [["work.example", "lost", garbage(7)]]);
    const command = vi.fn(async (name: string, args: string[]) => {
      if (name === "security") return "chrome-password\n";
      throw new Error(`unexpected ${name} ${args.join(" ")}`);
    });
    const selections = [
      { source: "chrome", profile: "Default" },
      { source: "chrome", profile: "Profile 1" },
    ];
    const options = { bookmarks: true, history: true, signIns: true };

    const data = await importSelections(selections, options, { ...mac(home), command });

    expect(command).toHaveBeenCalledTimes(1);
    expect(command.mock.calls[0][1]).toEqual([
      "find-generic-password",
      "-w",
      "-s",
      "Chrome Safe Storage",
      "-a",
      "Chrome",
    ]);
    expect(data.bookmarks).toHaveLength(7);
    expect(data.history.map((visit) => visit.url)).toEqual(["https://kamapathy.app/"]);
    expect(data.profiles).toEqual([
      {
        source: "chrome",
        browser: "Google Chrome",
        profile: "Person 1",
        cookies: [
          expect.objectContaining({
            url: "https://example.com/",
            domain: ".example.com",
            name: "sid",
            value: "secret-1",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
          }),
          expect.objectContaining({ url: "https://mail.example.com/", name: "token", value: "secret-2" }),
        ],
      },
    ]);
    expect(data.profiles[0].cookies[1].domain).toBeUndefined();
    expect(data.warnings).toEqual([
      "Sign-ins from Google Chrome could not be imported on this system.",
      "2 sign-ins could not be read and were left out.",
    ]);

    const denied = vi.fn(async () => {
      throw new Error("User canceled the operation.");
    });
    const withoutKey = await importSelections(selections, options, { ...mac(home), command: denied });
    expect(denied).toHaveBeenCalledTimes(1);
    expect(withoutKey.bookmarks).toHaveLength(7);
    expect(withoutKey.history).toHaveLength(1);
    expect(withoutKey.profiles).toEqual([]);
    expect(withoutKey.warnings).toEqual([
      "Kamapathy could not get the sign-in key for Google Chrome from your keychain.",
    ]);

    // Sign-ins left off never reach the keychain.
    const untouched = vi.fn(async () => "chrome-password");
    const plain = await importSelections(selections, both, { ...mac(home), command: untouched });
    expect(untouched).not.toHaveBeenCalled();
    expect(plain.profiles).toEqual([]);
    expect(plain.warnings).toEqual([]);
  });

  it("import: passwords and sign-ins share one key read per browser", async () => {
    const { home, chrome } = chromeHome();
    const chromePassword = (value: string) => encrypt("chrome-password", value);
    loginFile(join(chrome, "Default", "Login Data"), [
      ["https://docs.example/", "ada", chromePassword("secret-docs"), 0],
      ["https://never.example/", "", new Uint8Array(), 1],
      ["https://broken.example/", "bob", garbage(9), 0],
    ]);
    loginFile(join(chrome, "Profile 1", "Login Data"), [
      ["https://work.example/", "wes", chromePassword("secret-work"), 0],
      ["https://lost.example/", "lou", garbage(11), 0],
    ]);
    cookieFile(join(chrome, "Default", "Network", "Cookies"), [
      ["mail.example.com", "sid", encrypt("chrome-password", "cookie-1")],
    ]);
    const command = vi.fn(async (name: string) => {
      if (name === "security") return "chrome-password\n";
      throw new Error(`unexpected ${name}`);
    });
    const selections = [
      { source: "chrome", profile: "Default" },
      { source: "chrome", profile: "Profile 1" },
    ];

    const data = await importSelections(
      selections,
      { bookmarks: false, history: false, signIns: true, passwords: true },
      { ...mac(home), command },
    );

    // One keychain prompt serves both profiles and both kinds of secret.
    expect(command).toHaveBeenCalledTimes(1);
    expect(data.logins).toEqual([
      expect.objectContaining({
        kind: "form",
        origin: "https://docs.example",
        username: "ada",
        password: "secret-docs",
      }),
      expect.objectContaining({
        origin: "https://work.example",
        username: "wes",
        password: "secret-work",
      }),
    ]);
    expect(data.neverSaved).toEqual(["https://never.example"]);
    expect(data.profiles[0].cookies[0].value).toBe("cookie-1");
    expect(data.warnings).toEqual([
      "2 Google Chrome passwords couldn't be read. Export them from Google Chrome as a CSV file and import that file.",
    ]);

    const target = fakeTarget({ bookmarks: [], history: [] });
    const merge = vi.fn<MergeImportedPasswords>(async () => ({
      added: 2,
      warnings: ["the vault was full"],
    }));
    const outcome = await runImport(
      target,
      { profiles: selections, bookmarks: false, history: false, signIns: "none", passwords: true },
      { ...mac(home), command },
      merge,
    );
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge.mock.calls[0][0].map((login) => login.username)).toEqual(["ada", "wes"]);
    expect(merge.mock.calls[0][1]).toEqual(["https://never.example"]);
    expect(outcome.passwords).toBe(2);
    expect(outcome.warnings).toEqual([
      "2 Google Chrome passwords couldn't be read. Export them from Google Chrome as a CSV file and import that file.",
      "the vault was full",
    ]);

    // Passwords left off ask for no key and report no count.
    const untouched = vi.fn(async () => "chrome-password");
    const plain = await runImport(
      target,
      { profiles: selections, bookmarks: true, history: false, signIns: "none" },
      { ...mac(home), command: untouched },
      merge,
    );
    expect(untouched).not.toHaveBeenCalled();
    expect(merge).toHaveBeenCalledTimes(1);
    expect(plain.passwords).toBeUndefined();
  });

  it("hands the sign-ins to their destination and reports what was written", async () => {
    const { home, chrome } = chromeHome();
    cookieFile(join(chrome, "Default", "Network", "Cookies"), [
      ["example.com", "sid", encrypt("chrome-password", "secret")],
      ["broken.example", "bad", garbage(5)],
    ]);
    const env = { ...mac(home), command: vi.fn(async () => "chrome-password") };
    const target = fakeTarget({ bookmarks: [], history: [] });
    target.applyImportedCookies.mockResolvedValueOnce({
      written: 1,
      failed: 1,
      spaces: [{ id: "space-1", name: "Person 1 from Google Chrome" }],
      warnings: ["1 sign-in could not be saved."],
    });

    const outcome = await runImport(
      target,
      { profiles: [{ source: "chrome", profile: "Default" }], bookmarks: false, history: false, signIns: "separate" },
      env,
    );

    expect(target.dispatch).not.toHaveBeenCalled();
    expect(target.applyImportedCookies).toHaveBeenCalledExactlyOnceWith("separate", [
      expect.objectContaining({ source: "chrome", profile: "Person 1", cookies: [expect.objectContaining({ name: "sid" })] }),
    ]);
    expect(outcome).toEqual({
      bookmarks: 0,
      history: 0,
      signIns: 1,
      spaces: [{ id: "space-1", name: "Person 1 from Google Chrome" }],
      warnings: ["1 sign-in could not be read and was left out.", "1 sign-in could not be saved."],
    });

    // Without any sign-in to write, the destination is never asked.
    const empty = fakeTarget({ bookmarks: [], history: [] });
    const nothing = await runImport(
      empty,
      { profiles: [{ source: "chrome", profile: "Profile 1" }], bookmarks: false, history: false, signIns: "shared" },
      env,
    );
    expect(empty.applyImportedCookies).not.toHaveBeenCalled();
    expect(nothing).toEqual({ bookmarks: 0, history: 0, signIns: 0, spaces: [], warnings: [] });
  });

  it("fails a selection whose browser or profile is gone before reading anything", async () => {
    const { home, chrome } = chromeHome();
    place("chromium/Bookmarks", join(chrome, "Default", "Bookmarks"));
    const command = vi.fn(async () => "chrome-password");
    const env = { ...mac(home), command };
    const signIns = { ...both, signIns: true };
    await expect(
      importSelections([{ source: "chrome", profile: "Default" }, { source: "chrome", profile: "Profile 9" }], signIns, env),
    ).rejects.toMatchObject({ code: "profile_not_found", message: "That profile was not found." });
    expect(command).not.toHaveBeenCalled();
    await expect(importSelections([{ source: "edge" }], both, env)).rejects.toMatchObject({
      code: "source_not_found",
      message: "That browser was not found on this computer.",
    });
    rmSync(chrome, { recursive: true });
    const gone = importSelections([{ source: "chrome", profile: "Default" }], both, env);
    await expect(gone).rejects.toBeInstanceOf(ImportError);
    await expect(gone).rejects.toMatchObject({ code: "source_not_found" });
  });

  it.skipIf(!blockable)("goes on past a browser it may not read and fails when every one is blocked", async () => {
    const { home, chrome } = chromeHome();
    const bookmarks = join(chrome, "Default", "Bookmarks");
    place("chromium/Bookmarks", bookmarks);
    place("chromium/Bookmarks", join(support(home), "Microsoft Edge", "Default", "Bookmarks"));
    const chromeDefault = { source: "chrome", profile: "Default" };
    chmodSync(bookmarks, 0o000);
    try {
      const some = await importSelections([chromeDefault, { source: "edge" }], both, mac(home));
      expect(some.bookmarks).toHaveLength(7);
      expect(some.warnings).toEqual(["Kamapathy needs permission to read Google Chrome's data."]);
      await expect(importSelections([chromeDefault], both, mac(home))).rejects.toMatchObject({
        code: "read_blocked",
        message: "Kamapathy needs permission to read this browser's data.",
        fields: { sources: ["Google Chrome"] },
      });
      // A data folder that cannot be listed blocks its selections up front.
      chmodSync(bookmarks, 0o600);
      chmodSync(chrome, 0o000);
      await expect(
        importSelections([{ source: "chrome" }, chromeDefault], both, mac(home)),
      ).rejects.toMatchObject({ code: "read_blocked", fields: { sources: ["Google Chrome"] } });
      const edgeToo = await importSelections([chromeDefault, { source: "edge" }], both, mac(home));
      expect(edgeToo.bookmarks).toHaveLength(7);
      expect(edgeToo.warnings).toEqual(["Kamapathy needs permission to read Google Chrome's data."]);
    } finally {
      chmodSync(chrome, 0o700);
      chmodSync(bookmarks, 0o600);
    }
  });
});
