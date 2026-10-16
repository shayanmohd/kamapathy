import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  INSTALLER_KINDS,
  installKind,
  installerName,
  parseChecksums,
  pickRelease,
  repository,
  updateSource,
  type UpdateSource,
} from "../electron/update-release";
import { updateReminder } from "../shared/state";
import type { InstallKind, UpdateState } from "../shared/types";
import { compareVersions, isVersion, parseVersion } from "../shared/version";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const MiB = 1048576;
const hex = "0123456789abcdef".repeat(4);
const github = updateSource({ owner: "shayanmohd", repo: "kamapathy" });

interface Asset {
  name: string;
  state: string;
  size: number;
  digest?: unknown;
  browser_download_url: string;
}
interface Release {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  published_at: string;
  assets: Asset[];
}

// A release as GitHub lists it: this kind's installer, then the sums.
function release(
  version: string,
  kind: InstallKind = "mac-arm64",
  base = github.releasesBase,
): Release {
  const asset = (name: string, size: number): Asset => ({
    name,
    state: "uploaded",
    size,
    digest: `sha256:${hex}`,
    browser_download_url: `${base}/download/v${version}/${name}`,
  });
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: true,
    html_url: `${base}/tag/v${version}`,
    published_at: "2026-10-01T12:00:00Z",
    assets: [
      asset(installerName(kind, version)!, 2 * MiB),
      asset("SHA256SUMS.txt", 885),
    ],
  };
}

function pick(
  json: unknown,
  {
    current = "0.2.0",
    kind = "mac-arm64" as InstallKind,
    source = github,
  } = {},
) {
  return pickRelease(json, { source, current, kind });
}

describe("update releases", () => {
  it("compares versions numerically", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("0.9.9", "0.10.0")).toBe(-1);
    expect(compareVersions("1.2.10", "1.2.9")).toBe(1);
    expect(compareVersions("2.0.0", "1.999999.999999")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(parseVersion("0.10.0")).toEqual([0, 10, 0]);
    expect(parseVersion("999999.0.1")).toEqual([999999, 0, 1]);
    expect(isVersion("0.2.0")).toBe(true);
    for (const value of [
      "1.2",
      "v1.2.3",
      "1.2.3-beta",
      "1.2.3.4",
      "1234567.0.0",
      " 1.2.3",
      "1.2.3\n",
      "",
      undefined,
      null,
      123,
      [1, 2, 3],
    ]) {
      expect(parseVersion(value)).toBeNull();
      expect(isVersion(value)).toBe(false);
    }
    expect(() => compareVersions("1.2", "1.2.3")).toThrow(RangeError);
    expect(() => compareVersions("1.2", "1.2.3")).toThrow(
      "Invalid version: 1.2",
    );
    expect(() => compareVersions("1.2.3", "v1.2.3")).toThrow(
      "Invalid version: v1.2.3",
    );
  });

  it("picks the newest usable release", () => {
    const usable = release("0.3.0");
    expect(pick([usable])).toStrictEqual({
      version: "0.3.0",
      publishedAt: Date.parse("2026-10-01T12:00:00Z"),
      url: "https://github.com/shayanmohd/kamapathy/releases/tag/v0.3.0",
      installer: {
        name: "Kamapathy-0.3.0-mac-arm64.dmg",
        size: 2 * MiB,
        url: "https://github.com/shayanmohd/kamapathy/releases/download/v0.3.0/Kamapathy-0.3.0-mac-arm64.dmg",
        sha256: hex,
      },
      sums: "https://github.com/shayanmohd/kamapathy/releases/download/v0.3.0/SHA256SUMS.txt",
    });

    // Each of these is newer than the usable one and fails one rule.
    const relink =
      (index: number, change: (url: string) => string) => (item: Release) =>
        (item.assets[index].browser_download_url = change(
          item.assets[index].browser_download_url,
        ));
    const defects: [string, (item: Release) => unknown][] = [
      ["a draft", (item) => (item.draft = true)],
      [
        "a tag without v",
        (item) => (item.tag_name = `V${item.tag_name.slice(1)}`),
      ],
      ["a tag with a suffix", (item) => (item.tag_name += "-beta")],
      [
        "a foreign html_url",
        (item) =>
          (item.html_url = item.html_url.replace("shayanmohd", "someone")),
      ],
      [
        "a look-alike letter in html_url",
        (item) =>
          (item.html_url = item.html_url.replace(
            "kamapathy",
            "\u212Aamapathy",
          )),
      ],
      ["an unreadable published_at", (item) => (item.published_at = "soon")],
      ["an unfinished installer", (item) => (item.assets[0].state = "open")],
      ["unfinished sums", (item) => (item.assets[1].state = "open")],
      ["missing sums", (item) => item.assets.pop()],
      ["a missing installer", (item) => item.assets.shift()],
      ["an installer under 1 MiB", (item) => (item.assets[0].size = MiB - 1)],
      [
        "an installer over 1 GiB",
        (item) => (item.assets[0].size = 1024 * MiB + 1),
      ],
      ["a fractional size", (item) => (item.assets[0].size = 2.5 * MiB + 0.5)],
      ["a query", relink(0, (url) => `${url}?raw=1`)],
      ["a hash", relink(1, (url) => `${url}#sums`)],
      ["a .. segment", relink(0, (url) => url.replace(/[^/]+$/, "x/../$&"))],
      [
        "an encoded .. segment",
        relink(1, (url) => url.replace(/[^/]+$/, "x/%2e%2e/$&")),
      ],
      [
        "an http URL from the GitHub source",
        relink(1, (url) => url.replace(/^https:/, "http:")),
      ],
      [
        "another host",
        relink(0, (url) => url.replace("github.com", "github.com.example")),
      ],
      [
        "another release's folder",
        relink(1, (url) => url.replace("/v0.", "/v1.")),
      ],
      [
        "the file name in another case",
        relink(0, (url) => url.replace(/Kamapathy-(?=[^/]+$)/, "kamapathy-")),
      ],
    ];
    const list: Release[] = [];
    for (const [index, [defect, spoil]] of defects.entries()) {
      const item = release(`0.${index + 4}.0`);
      expect(pick([item]), defect).not.toBeNull();
      spoil(item);
      expect(pick([item]), defect).toBeNull();
      list.push(item);
    }
    expect(pick([release("0.2.0"), release("0.1.0")])).toBeNull();
    expect(pick([...list, release("0.2.0"), usable])?.version).toBe("0.3.0");

    // The highest wins in any order, and a release need not be a prerelease.
    const stable = { ...release("0.10.0"), prerelease: false };
    expect(pick([release("0.3.0"), stable, release("0.9.0")])?.version).toBe(
      "0.10.0",
    );
    expect(pick([release("0.9.0"), release("0.3.0"), stable])?.version).toBe(
      "0.10.0",
    );
    // Another kind's installer does not count.
    expect(pick([release("0.4.0", "mac-x64"), usable])?.version).toBe("0.3.0");

    // Exact sizes at the limits are allowed.
    const smallest = release("0.3.0");
    smallest.assets[0].size = MiB;
    expect(pick([smallest])?.installer.size).toBe(MiB);
    const largest = release("0.3.0");
    largest.assets[0].size = 1024 * MiB;
    expect(pick([largest])?.installer.size).toBe(1024 * MiB);

    // Only a SHA-256 digest in GitHub's form becomes the installer's hash.
    for (const digest of [
      undefined,
      null,
      hex,
      `sha256:${hex.slice(1)}`,
      `sha256:${hex.toUpperCase()}`,
      `sha512:${hex}${hex}`,
    ]) {
      const item = release("0.3.0");
      item.assets[0].digest = digest;
      expect(pick([item])?.installer).not.toHaveProperty("sha256");
    }

    // A repository spelled differently in homepage still matches.
    const spelled = updateSource({ owner: "ShayanMohd", repo: "Kamapathy" });
    expect(pick([usable], { source: spelled })?.version).toBe("0.3.0");

    // The test feed serves http under its own base and nowhere else.
    const feed = updateSource(
      { owner: "shayanmohd", repo: "kamapathy" },
      "http://127.0.0.1:4567",
    );
    const local = (base = feed.releasesBase) => {
      const item = release("0.3.0", "linux-appimage", feed.releasesBase);
      for (const asset of item.assets)
        asset.browser_download_url = `${base}/download/v0.3.0/${asset.name}`;
      return item;
    };
    const appImage = { kind: "linux-appimage" as InstallKind, source: feed };
    expect(pick([local()], appImage)?.installer.url).toBe(
      "http://127.0.0.1:4567/releases/download/v0.3.0/Kamapathy-0.3.0-linux-x86_64.AppImage",
    );
    expect(
      pick([local("http://127.0.0.1:4568/releases")], appImage),
    ).toBeNull();
    expect(
      pick([local("http://localhost:4567/releases")], appImage),
    ).toBeNull();
    expect(pick([local(github.releasesBase)], appImage)).toBeNull();
    expect(pick([local()], { kind: "linux-appimage" })).toBeNull();

    // Kinds without an installer never pick one, and a non-array is an error.
    expect(pick([usable], { kind: "source" })).toBeNull();
    expect(pick([usable], { kind: "other" })).toBeNull();
    expect(
      pick([
        null,
        7,
        "v0.9.0",
        { tag_name: "v0.9.0" },
        { ...release("0.9.0"), tag_name: 9 },
        { ...release("0.9.0"), assets: {} },
        usable,
      ])?.version,
    ).toBe("0.3.0");
    for (const json of [null, {}, "[]", { releases: [usable] }])
      expect(() => pick(json)).toThrow(TypeError);
  });

  it("names installers as releases publish them", () => {
    expect(
      Object.fromEntries(
        INSTALLER_KINDS.map((kind) => [kind, installerName(kind, "9.9.9")]),
      ),
    ).toEqual({
      "mac-arm64": "Kamapathy-9.9.9-mac-arm64.dmg",
      "mac-x64": "Kamapathy-9.9.9-mac-x64.dmg",
      "windows-setup": "Kamapathy-9.9.9-windows-x64-setup.exe",
      "windows-portable": "Kamapathy-9.9.9-windows-x64-portable.exe",
      "linux-appimage": "Kamapathy-9.9.9-linux-x86_64.AppImage",
      "linux-deb": "Kamapathy-9.9.9-linux-amd64.deb",
    });
    const publish = read("scripts/publish-release.mjs");
    for (const kind of INSTALLER_KINDS)
      expect(publish).toContain(
        installerName(kind, "9.9.9")!.replace("9.9.9", "${version}"),
      );
    expect(installerName("source", "9.9.9")).toBeNull();
    expect(installerName("other", "9.9.9")).toBeNull();
  });

  it("detects the install kind", () => {
    const kind = (input: Partial<Parameters<typeof installKind>[0]>) =>
      installKind({
        platform: "darwin",
        arch: "arm64",
        translated: false,
        packaged: true,
        env: {},
        execPath: "/Applications/Kamapathy.app/Contents/MacOS/Kamapathy",
        ...input,
      });
    expect(kind({})).toBe("mac-arm64");
    expect(kind({ arch: "x64", translated: true })).toBe("mac-arm64");
    expect(kind({ arch: "x64" })).toBe("mac-x64");
    expect(kind({ arch: "ia32" })).toBe("other");

    const portable = {
      platform: "win32" as const,
      arch: "x64",
      execPath: "C:\\Users\\me\\AppData\\Local\\Temp\\2x\\Kamapathy.exe",
    };
    expect(
      kind({
        ...portable,
        env: {
          PORTABLE_EXECUTABLE_FILE: "C:\\Tools\\Kamapathy.exe",
          PORTABLE_EXECUTABLE_APP_FILENAME: "Kamapathy",
        },
      }),
    ).toBe("windows-portable");
    const setup = {
      platform: "win32" as const,
      arch: "x64",
      execPath:
        "C:\\Users\\me\\AppData\\Local\\Programs\\Kamapathy\\Kamapathy.exe",
    };
    expect(
      kind({
        ...setup,
        env: {
          PORTABLE_EXECUTABLE_FILE: "C:\\Tools\\Other.exe",
          PORTABLE_EXECUTABLE_APP_FILENAME: "Other",
        },
      }),
    ).toBe("windows-setup");
    expect(kind(setup)).toBe("windows-setup");
    // Windows 11 on Arm runs the x64 setup.
    expect(kind({ ...setup, arch: "arm64" })).toBe("windows-setup");

    const linux = { platform: "linux" as const, arch: "x64" };
    expect(
      kind({
        ...linux,
        env: {
          APPIMAGE: "/home/me/Applications/Kamapathy.AppImage",
          APPDIR: "/tmp/.mount_KamapaAbC123",
        },
        execPath: "/tmp/.mount_KamapaAbC123/kamapathy-browser",
      }),
    ).toBe("linux-appimage");
    const deb = { ...linux, execPath: "/opt/Kamapathy/kamapathy-browser" };
    expect(kind({ ...deb, env: { APPIMAGE: "/home/me/Other.AppImage" } })).toBe(
      "linux-deb",
    );
    expect(
      kind({
        ...deb,
        env: {
          APPIMAGE: "/home/me/Other.AppImage",
          APPDIR: "/tmp/.mount_OtherXyZ",
        },
      }),
    ).toBe("linux-deb");
    expect(kind(deb)).toBe("linux-deb");

    expect(kind({ packaged: false })).toBe("source");
    expect(kind({ ...deb, packaged: false })).toBe("source");
    expect(kind({ platform: "linux", arch: "arm64" })).toBe("other");
    expect(kind({ platform: "freebsd", arch: "x64" })).toBe("other");
  });

  it("reads SHA256SUMS.txt strictly", () => {
    const other = "f".repeat(64);
    expect(
      parseChecksums(
        `${hex}  Kamapathy-1.0.0-mac-arm64.dmg\n${other}  Kamapathy-skill-1.0.0.zip\n`,
      ),
    ).toEqual(
      new Map([
        ["Kamapathy-1.0.0-mac-arm64.dmg", hex],
        ["Kamapathy-skill-1.0.0.zip", other],
      ]),
    );
    expect(parseChecksums(`${hex}  SHA256SUMS.txt`)).toEqual(
      new Map([["SHA256SUMS.txt", hex]]),
    );
    for (const text of [
      `${hex.toUpperCase()}  a.dmg\n`,
      `${hex} a.dmg\n`,
      `${hex}   a.dmg\n`,
      `${hex}  a.dmg\r\n`,
      `${hex}  folder/a.dmg\n`,
      `${hex}  folder\\a.dmg\n`,
      `${hex}  \n`,
      `${hex}  a.dmg\n${other}  a.dmg\n`,
      `${hex.slice(1)}  a.dmg\n`,
      `${hex}  a.dmg\n\n`,
      "",
    ])
      expect(parseChecksums(text), JSON.stringify(text)).toBeNull();
  });

  it("parses the repository from homepage", () => {
    expect(repository(JSON.parse(read("package.json")).homepage)).toEqual({
      owner: "shayanmohd",
      repo: "kamapathy",
    });
    expect(repository("HTTPS://GITHUB.COM/ShayanMohd/Kamapathy")).toEqual({
      owner: "ShayanMohd",
      repo: "Kamapathy",
    });
    for (const homepage of [
      "https://github.com/shayanmohd/kamapathy/",
      "https://github.com/shayanmohd/kamapathy.git",
      "https://gitlab.com/shayanmohd/kamapathy",
      "http://github.com/shayanmohd/kamapathy",
      "https://github.com/shayanmohd/kamapathy/releases",
      "https://github.com/shayanmohd",
      "https://kamapathy.app",
      undefined,
      null,
      42,
      { owner: "shayanmohd", repo: "kamapathy" },
    ])
      expect(repository(homepage), String(homepage)).toBeNull();
  });

  it("reads releases from GitHub unless a loopback feed is given", () => {
    const repo = { owner: "shayanmohd", repo: "kamapathy" };
    const defaults: UpdateSource = {
      listUrl:
        "https://api.github.com/repos/shayanmohd/kamapathy/releases?per_page=20",
      releasesBase: "https://github.com/shayanmohd/kamapathy/releases",
      loopback: false,
    };
    expect(updateSource(repo)).toEqual(defaults);
    expect(updateSource(repo, "http://127.0.0.1:4567")).toEqual({
      listUrl: "http://127.0.0.1:4567/api/releases?per_page=20",
      releasesBase: "http://127.0.0.1:4567/releases",
      loopback: true,
    });
    for (const feed of [
      "http://localhost:4567",
      "https://127.0.0.1:4567",
      "http://127.0.0.1:4567/",
      "http://127.0.0.1",
      "http://127.0.0.1:123456",
      "",
    ])
      expect(updateSource(repo, feed), feed).toEqual(defaults);
  });

  it("a reminder applies to ready, and to available or downloading only while checks are on", () => {
    const latest = pick([release("0.3.0")])!;
    const reminder = (
      state: UpdateState["state"],
      checks: boolean,
      known = true,
    ) =>
      updateReminder(
        { kind: "mac-arm64", state, ...(known ? { latest } : {}) },
        checks,
      );
    for (const checks of [true, false])
      expect(reminder("ready", checks)).toEqual({
        version: "0.3.0",
        state: "ready",
      });
    expect(reminder("available", true)).toEqual({
      version: "0.3.0",
      state: "available",
    });
    expect(reminder("downloading", true)).toEqual({
      version: "0.3.0",
      state: "downloading",
    });
    expect(reminder("available", false)).toBeNull();
    expect(reminder("downloading", false)).toBeNull();
    for (const state of ["current", "unchecked", "unsupported"] as const)
      for (const checks of [true, false])
        expect(reminder(state, checks), `${state} ${checks}`).toBeNull();
    for (const state of ["available", "downloading", "ready"] as const)
      expect(reminder(state, true, false), state).toBeNull();
  });
});
