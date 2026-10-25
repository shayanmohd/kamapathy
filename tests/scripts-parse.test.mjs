import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
// The end-to-end runners are started by npm scripts and the client's modules
// are loaded by a spawned CLI, so nothing in npm run check parses either set
// directly. Two phases adding a module-scope const of the same name merge
// into a file that cannot parse, and without this the first sign of it is a
// suite that refuses to start.
const mjsUnder = (dir) =>
  readdirSync(dir, { recursive: true })
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => join(dir, name));
const FILES = [...mjsUnder("scripts"), ...mjsUnder("skills/kamapathy/scripts")];

describe("the scripts npm runs and the client's own modules", () => {
  it.each(FILES)("%s parses", async (path) => {
    await expect(
      run(process.execPath, ["--check", path]),
    ).resolves.toBeTruthy();
  });
});
