import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  incomingItem,
  incomingItems,
  incomingLimiter,
} from "../electron/incoming";

const exe = "/Applications/Kamapathy.app/Contents/MacOS/Kamapathy";
const packaged = { defaultApp: false };
const windows = process.platform === "win32";
let folder: string;
const path = (name: string) => join(folder, name);
const href = (name: string) => pathToFileURL(path(name)).href;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), "kamapathy-incoming-"));
  for (const name of ["doc.pdf", "Page.HTML", "setup.exe", "archive.zip"])
    writeFileSync(path(name), "file");
  mkdirSync(path("folder.pdf"));
  mkdirSync(path("sub"));
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

describe("links and files from other apps", () => {
  it("single argument", () => {
    expect(
      incomingItems(
        [exe, "--single-argument", "https://a.example/x"],
        folder,
        packaged,
      ),
    ).toEqual(["https://a.example/x"]);
    expect(
      incomingItems(
        [exe, "--single-argument", "https://a.example/", "https://b.example/"],
        folder,
        packaged,
      ),
    ).toEqual([]);
    // Switches before it, and switches Chromium adds after it, are ignored.
    expect(
      incomingItems(
        [
          exe,
          "--allow-file-access-from-files",
          "--single-argument",
          "--original-process-start-time=1",
          path("doc.pdf"),
        ],
        folder,
        packaged,
      ),
    ).toEqual([href("doc.pdf")]);
    // A link that smuggles a second argument opens nothing.
    expect(
      incomingItems(
        [exe, "--single-argument", 'https://a.example/"', path("doc.pdf")],
        folder,
        packaged,
      ),
    ).toEqual([]);
    expect(incomingItems([exe, "--single-argument"], folder, packaged)).toEqual(
      [],
    );
    expect(
      incomingItems(
        [exe, "--single-argument", "mailto:a@b.example"],
        folder,
        packaged,
      ),
    ).toEqual([]);
  });

  it("drops the rest", () => {
    const dropped = [
      "--inspect=0",
      "-psn_0_1",
      "--remote-debugging-port=0",
      "https://u:p@a.example/",
      "https://u@a.example/",
      "mailto:a@b.example",
      `chrome-extension://${"a".repeat(32)}/page.html`,
      "javascript:alert(1)",
      "data:text/html,hi",
      "ftp://a.example/doc.pdf",
      path("sub"),
      path("folder.pdf"),
      pathToFileURL(path("folder.pdf")).href,
      path("setup.exe"),
      path("archive.zip"),
      href("setup.exe"),
      path("missing.pdf"),
      href("missing.pdf"),
      "file://host/share/doc.pdf",
      // file:// before a POSIX folder makes its first segment the host.
      ...(windows ? [] : [`file://${folder.replace(/^\//, "")}/doc.pdf`]),
      "",
    ];
    for (const value of dropped)
      expect(incomingItem(value, folder), value).toBeUndefined();
    // A Windows folder starts with its drive, which a file: URL reads as the
    // start of the path, so there the same spelling names the file.
    if (windows) {
      const item = incomingItem(`file://${folder}/doc.pdf`, folder);
      expect(item && fileURLToPath(item)).toBe(path("doc.pdf"));
    }
    expect(
      incomingItems(
        [exe, ...dropped, path("doc.pdf"), href("doc.pdf")],
        folder,
        packaged,
      ),
    ).toEqual([href("doc.pdf"), href("doc.pdf")]);
    // Web addresses come back as their canonical form, files as file: URLs.
    expect(incomingItem("HTTPS://A.example", folder)).toBe(
      "https://a.example/",
    );
    expect(incomingItem(path("Page.HTML"), folder)).toBe(href("Page.HTML"));
    expect(
      incomingItem(
        href("doc.pdf").replace("file:///", "file://localhost/"),
        folder,
      ),
    ).toBe(href("doc.pdf"));
  });

  it("relative paths", () => {
    const cwd = vi.spyOn(process, "cwd");
    expect(incomingItem("doc.pdf", folder)).toBe(href("doc.pdf"));
    expect(incomingItem("./sub/../doc.pdf", folder)).toBe(href("doc.pdf"));
    expect(incomingItems([exe, "doc.pdf"], folder, packaged)).toEqual([
      href("doc.pdf"),
    ]);
    // The second instance's directory, which isFile sees resolved. Windows
    // passes it with a drive, which resolve would otherwise read from cwd.
    const elsewhere = windows ? "C:\\elsewhere" : "/elsewhere";
    const file = join(elsewhere, "doc.pdf");
    const url = windows
      ? "file:///C:/elsewhere/doc.pdf"
      : "file:///elsewhere/doc.pdf";
    const isFile = vi.fn((value: string) => value === file);
    expect(incomingItem("doc.pdf", elsewhere, isFile)).toBe(url);
    expect(
      incomingItems([exe, "doc.pdf"], elsewhere, { ...packaged, isFile }),
    ).toEqual([url]);
    expect(isFile).toHaveBeenCalledWith(file);
    expect(cwd).not.toHaveBeenCalled();
  });

  it("cap of 20", () => {
    const urls = Array.from(
      { length: 25 },
      (_, index) => `https://a.example/${index}`,
    );
    expect(incomingItems([exe, ...urls], folder, packaged)).toEqual(
      urls.slice(0, 20),
    );
    // Switches never count.
    expect(
      incomingItems(
        [exe, ...urls.flatMap((url) => ["--flag", url])],
        folder,
        packaged,
      ),
    ).toEqual(urls.slice(0, 20));
    // In development argv[1] is the app path; packaged, it is an item.
    const app = "/work/kamapathy/out/main/index.js";
    expect(
      incomingItems([exe, app, ...urls], folder, { defaultApp: true }),
    ).toEqual(urls.slice(0, 20));
    expect(
      incomingItems([exe, urls[0], urls[1]], folder, { defaultApp: true }),
    ).toEqual([urls[1]]);
    // Electron takes the first argument that is no switch as the app, as
    // when a test runner puts its switches first.
    expect(
      incomingItems(
        [exe, "--inspect=0", "--remote-debugging-port=0", app, ...urls],
        folder,
        { defaultApp: true },
      ),
    ).toEqual(urls.slice(0, 20));
    expect(
      incomingItems(
        [exe, "--remote-debugging-port=0", app, "--single-argument", urls[0]],
        folder,
        { defaultApp: true },
      ),
    ).toEqual([urls[0]]);
    expect(incomingItems([exe, urls[0], urls[1]], folder, packaged)).toEqual([
      urls[0],
      urls[1],
    ]);
    expect(incomingItems([exe], folder, packaged)).toEqual([]);
  });

  it("limiter passes 20 events in any 2 s", () => {
    let time = 10_000;
    const allow = incomingLimiter(() => time);
    for (let index = 0; index < 20; index += 1) {
      expect(allow(), `event ${index + 1}`).toBe(true);
      time += 50;
    }
    expect(allow()).toBe(false);
    time = 11_999;
    expect(allow()).toBe(false);
    // The first event leaves the window, so one more passes.
    time = 12_000;
    expect(allow()).toBe(true);
    expect(allow()).toBe(false);
    time = 20_000;
    for (let index = 0; index < 20; index += 1) expect(allow()).toBe(true);
    expect(allow()).toBe(false);
  });
});
