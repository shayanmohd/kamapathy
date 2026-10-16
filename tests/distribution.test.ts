import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" });

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
});
