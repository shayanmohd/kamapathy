import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
// The end-to-end runners are started by npm scripts, so nothing else in
// npm run check ever parses them: a syntax error in one of them only shows
// up when the suite refuses to start.
const RUNNERS = readdirSync("scripts")
  .filter((name) => name.endsWith(".mjs"))
  .map((name) => join("scripts", name));

describe("the scripts npm runs", () => {
  it.each(RUNNERS)("%s parses", async (path) => {
    await expect(
      run(process.execPath, ["--check", path]),
    ).resolves.toBeTruthy();
  });
});
