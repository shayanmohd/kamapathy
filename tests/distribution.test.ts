import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compareSkillFolders } from "../scripts/check-bundled-skill.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
// The lines under a top-level key of a YAML file.
const yamlSection = (text: string, key: string) => {
  const lines = text.split("\n");
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return "";
  const end = lines.findIndex(
    (line, index) => index > start && /^\S/.test(line),
  );
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
};

describe("distribution files", () => {
  it("marketplace version equals the package's", () => {
    const { version } = JSON.parse(read("package.json"));
    expect(JSON.parse(read(".claude-plugin/marketplace.json"))).toEqual({
      $schema: "https://json.schemastore.org/claude-code-marketplace.json",
      name: "kamapathy",
      owner: {
        name: "Kamapathy contributors",
        url: "https://github.com/shayanmohd/kamapathy",
      },
      plugins: [
        {
          name: "kamapathy",
          version,
          source: "./",
          strict: false,
          skills: ["./skills/kamapathy"],
          category: "automation",
          homepage: "https://kamapathy.app",
          license: "MIT",
        },
      ],
    });
  });

  // Read from the index, so checkouts without core.symlinks pass too.
  it("links are mode 120000 to ../../skills/kamapathy", () => {
    const links = git(
      "ls-files",
      "-s",
      ".claude/skills/kamapathy",
      ".agents/skills/kamapathy",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [, mode, object, path] =
          line.match(/^(\d+) ([0-9a-f]+) \d\t(.+)$/) ?? [];
        return { path, mode, target: git("cat-file", "-p", object) };
      });
    expect(links).toEqual([
      {
        path: ".agents/skills/kamapathy",
        mode: "120000",
        target: "../../skills/kamapathy",
      },
      {
        path: ".claude/skills/kamapathy",
        mode: "120000",
        target: "../../skills/kamapathy",
      },
    ]);
  });

  it("extraResources has the skill", () => {
    expect(
      yamlSection(read("electron-builder.yml"), "extraResources"),
    ).toContain(
      [
        "  - from: skills/kamapathy",
        "    to: skills/kamapathy",
        "    filter:",
        '      - "**/*"',
        '      - "!**/.DS_Store"',
      ].join("\n"),
    );
  });

  it("the base mac.extendInfo has the camera and microphone strings", () => {
    expect(yamlSection(read("electron-builder.yml"), "mac")).toContain(
      [
        "  extendInfo:",
        "    NSCameraUsageDescription: Websites you allow can use the camera.",
        "    NSMicrophoneUsageDescription: Websites you allow can use the microphone.",
      ].join("\n"),
    );
  });

  it("the signed overlay extends the base", () => {
    const overlay = read("electron-builder.signed.yml");
    expect(overlay).toMatch(/^extends: \.\/electron-builder\.yml$/m);
    const mac = yamlSection(overlay, "mac").split("\n");
    expect(mac).toEqual(
      expect.arrayContaining([
        "  hardenedRuntime: true",
        "  notarize: true",
        "  entitlements: build/entitlements.mac.plist",
        "  entitlementsInherit: build/entitlements.mac.plist",
      ]),
    );
    expect(mac.some((line) => /^ {2}identity: \S/.test(line))).toBe(true);
    const win = yamlSection(overlay, "win");
    expect(win).toMatch(/^ {2}azureSignOptions:$/m);
    expect(
      [...win.matchAll(/^ {4}(\w+): \S/gm)].map((match) => match[1]).sort(),
    ).toEqual([
      "certificateProfileName",
      "codeSigningAccountName",
      "endpoint",
      "publisherName",
    ]);
    const plist = read("build/entitlements.mac.plist");
    expect(
      [...plist.matchAll(/<key>([^<]*)<\/key>\s*<true\/>/g)].map(
        (match) => match[1],
      ),
    ).toEqual([
      "com.apple.security.cs.allow-jit",
      "com.apple.security.device.camera",
      "com.apple.security.device.audio-input",
    ]);
    expect(plist.match(/<key>/g)).toHaveLength(3);
  });

  it("check-bundled-skill finds a changed, missing or extra file", async () => {
    const folder = mkdtempSync(join(tmpdir(), "kamapathy-bundled-"));
    try {
      const [expected, actual] = ["expected", "actual"].map((name) =>
        join(folder, name),
      );
      for (const copy of [expected, actual])
        cpSync(join(root, "skills", "kamapathy"), copy, { recursive: true });
      // Packaging leaves out .DS_Store files, so the check does too.
      writeFileSync(join(expected, ".DS_Store"), "");
      writeFileSync(join(actual, "references", ".DS_Store"), "");
      expect(await compareSkillFolders(expected, actual)).toEqual([]);
      const edited = readFileSync(join(actual, "SKILL.md"));
      edited[0] ^= 1;
      writeFileSync(join(actual, "SKILL.md"), edited);
      rmSync(join(actual, "references", "connection.md"));
      writeFileSync(join(actual, "scripts", "extra.mjs"), "");
      symlinkSync(
        join(expected, "references"),
        join(actual, "scripts", "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(await compareSkillFolders(expected, actual)).toEqual([
        "SKILL.md: differs",
        "references/connection.md: missing",
        "scripts/extra.mjs: extra",
        "scripts/linked: link",
      ]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
