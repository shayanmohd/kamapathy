// CI step "Test the packaged app": starts the Kamapathy electron-builder left
// in release/ as a person does, with a profile of its own, and works it
// through its agent socket with the client packaged inside it. The other
// desktop suites run the development runtime on out/, where nothing loads
// from app.asar, and Playwright cannot attach to this build: its fuses turn
// the inspector off.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cjkPdf, textPdf } from "../tests/fixtures/pdf/index.mjs";
import { poll } from "./wait.mjs";

const DEADLINE_MS = 180000;
const QUIT_MS = 20000;
const startedAt = Date.now();
const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

// electron-builder names the folder after the platform, and after the
// architecture too unless it is x64: release/mac-arm64, release/mac,
// release/win-unpacked, release/linux-unpacked, release/linux-arm64-unpacked.
const suffix = process.arch === "x64" ? "" : `-${process.arch}`;
const contents = join(root, "release", `mac${suffix}`, "Kamapathy.app", "Contents");
const unpacked = join(
  root,
  "release",
  `${process.platform === "win32" ? "win" : "linux"}${suffix}-unpacked`,
);
const executable =
  process.platform === "darwin"
    ? join(contents, "MacOS", "Kamapathy")
    : join(unpacked, process.platform === "win32" ? "Kamapathy.exe" : "kamapathy-browser");
const resources =
  process.platform === "darwin" ? join(contents, "Resources") : join(unpacked, "resources");
const client = join(resources, "skills", "kamapathy", "scripts", "kamapathy.mjs");
if (!existsSync(executable) || !existsSync(client)) {
  const found = await readdir(join(root, "release")).catch(() => []);
  console.error(
    `FAIL No packaged Kamapathy for ${process.platform} ${process.arch} at ${relative(root, executable)} with its client at ${relative(root, client)}. release/ holds: ${found.join(", ") || "nothing"}.`,
  );
  process.exit(1);
}
console.log(`Testing ${relative(root, executable)} with its bundled client.`);

const PAGE_TEXT = "Packaged Kamapathy";
const PDF_TITLE = "Packaged check";
const PDF_PAGES = [["Read by the packaged PDF worker", "Line two"], ["Page two"]];
const CJK_TEXT = "你好世界";
// The page reports the viewport it was given, which the screenshot of an
// unwatched tab matches in CSS pixels.
const PAGE = `<!doctype html><html><head><title>Packaged check</title></head><body style="margin:20px"><h1>${PAGE_TEXT}</h1><button>Ready</button><p id="sizes">sizes</p><script>document.getElementById('sizes').textContent='viewport '+Math.floor(visualViewport.width)+'x'+Math.floor(visualViewport.height);</script></body></html>`;
const FILES = new Map([
  ["/", ["text/html", PAGE]],
  ["/text.pdf", ["application/pdf", textPdf(PDF_PAGES, { title: PDF_TITLE })]],
  ["/cjk.pdf", ["application/pdf", cjkPdf(CJK_TEXT)]],
]);
const site = createServer((request, response) => {
  const file = FILES.get(new URL(request.url, "http://x").pathname);
  response.writeHead(file ? 200 : 404, { "Content-Type": file?.[0] ?? "text/plain" });
  response.end(file?.[1]);
});
await new Promise((done) => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${site.address().port}`;

const work = await mkdtemp(join(tmpdir(), "kamapathy-packaged-"));
const profile = join(work, "profile");
await mkdir(profile);
// A packaged build checks GitHub for updates and ignores the test feed, so
// this run turns its checks off.
await writeFile(
  join(profile, "browser-state.json"),
  JSON.stringify({ settings: { updateChecks: false } }),
);
const env = { ...process.env, KAMAPATHY_USER_DATA: profile, KAMAPATHY_NO_LAUNCH: "1" };
delete env.ELECTRON_RUN_AS_NODE;
// No arguments, and a working directory and a session of its own, as a
// launch from the desktop has. Its output is kept for the failure report.
const kamapathy = spawn(executable, [], {
  cwd: work,
  env,
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
let output = "";
for (const stream of [kamapathy.stdout, kamapathy.stderr])
  stream.on("data", (chunk) => {
    output = (output + chunk).slice(-65536);
  });
let launchError;
const exited = new Promise((done) => {
  kamapathy.once("exit", done);
  kamapathy.on("error", (error) => {
    launchError ??= error;
    done();
  });
});
const ended = () =>
  Boolean(launchError) || kamapathy.exitCode !== null || kamapathy.signalCode !== null;
const endedWithin = (ms) =>
  Promise.race([exited, sleep(ms, undefined, { ref: false })]);
const ending = () =>
  launchError
    ? `a launch error: ${launchError.message}`
    : kamapathy.exitCode !== null
      ? `exit code ${kamapathy.exitCode}`
      : `signal ${kamapathy.signalCode}`;

let step = "starting the packaged app";
const checks = [];
const passed = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
function report(error) {
  console.error(`FAIL ${step}: ${error?.message ?? error}`);
  console.error(
    `Kamapathy (pid ${kamapathy.pid}) ${ended() ? `ended with ${ending()}` : "was still running"}.`,
  );
  const lines = output.trim().split(/\r?\n/).filter(Boolean).slice(-40);
  if (lines.length)
    console.error(`Its last output:\n${lines.map((line) => `  ${line}`).join("\n")}`);
}
// Only what this run started, by its PID: the process tree on Windows, and
// elsewhere the process group the app leads, so that no helper process of
// its writes to the profile after it is gone.
function forceStop() {
  if (ended() || !kamapathy.pid) return;
  try {
    if (process.platform === "win32")
      execFileSync("taskkill", ["/PID", String(kamapathy.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-kamapathy.pid, "SIGKILL");
  } catch {}
}
const watchdog = setTimeout(() => {
  report(new Error(`the run did not finish within ${DEADLINE_MS / 1000} s.`));
  forceStop();
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
  process.exit(1);
}, DEADLINE_MS - (Date.now() - startedAt));

// One command of the packaged client, run as an agent runs it, and its JSON.
async function cli(...args) {
  const command = `kamapathy ${args.join(" ")}`;
  let stdout;
  try {
    ({ stdout } = await run(process.execPath, [client, ...args, "--json"], {
      env,
      timeout: 60000,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(
      `${command} ${error.killed ? "did not answer within 60 s" : `failed with exit code ${error.code}`}: ${String(error.stderr || error.message).trim()}`,
    );
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`${command} printed no JSON: ${stdout.trim()}`);
  }
}

try {
  step = "waiting for the packaged app to accept agents";
  let refusal = "";
  const health = await poll(
    async () => {
      if (ended()) throw new Error(`Kamapathy ended with ${ending()} before it accepted agents.`);
      return cli("health").catch((error) => {
        refusal = error.message;
        return null;
      });
    },
    { timeoutMs: 60000, intervalMs: 250, label: "the packaged Kamapathy to accept agents" },
  ).catch((error) => {
    throw new Error(`${error.message} The client last said: ${refusal}`);
  });
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.deepEqual([health.status, health.version], ["ok", version]);
  // A packaged Kamapathy hands agents the skill in its own resources.
  assert.equal(
    relative(join(resources, "skills", "kamapathy"), health.skill?.path ?? ""),
    "",
    `Kamapathy names ${health.skill?.path} as its skill, not the packaged one`,
  );
  passed(
    `the packaged Kamapathy ${health.version} accepts agents and names its packaged skill (Electron ${health.versions?.electron}, Chromium ${health.versions?.chromium})`,
  );

  step = "opening an agent space and a page served on 127.0.0.1";
  const { space } = await cli("space", "open", "Packaged app check");
  const { tab } = await cli("open", space.id, `${origin}/`);
  const loaded = await cli("wait-for-load-state", tab.id, "load");
  assert.deepEqual([loaded.ok, loaded.tab?.url], [true, `${origin}/`], JSON.stringify(loaded));
  const snapshot = await cli("snapshot", tab.id);
  assert.ok(snapshot.text?.includes(PAGE_TEXT), JSON.stringify(snapshot));
  assert.ok(
    snapshot.interactables?.some((control) => control.label === "Ready"),
    JSON.stringify(snapshot),
  );
  const viewport = /viewport (\d+)x(\d+)/.exec(snapshot.text)?.slice(1).map(Number);
  assert.ok(viewport, `The page did not report its viewport: ${snapshot.text}`);
  passed("an agent space opens a page served on 127.0.0.1 and a snapshot reads it");

  step = "taking a screenshot of the unwatched agent tab";
  const shotFile = join(work, "tab.png");
  const shot = await cli("screenshot", tab.id, shotFile);
  const png = await readFile(shotFile);
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    "The screenshot is not a PNG",
  );
  assert.equal(png.toString("latin1", 12, 16), "IHDR", "The PNG does not start with its header");
  const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.deepEqual(size, viewport, `A ${size.join("x")} screenshot of a ${viewport.join("x")} viewport`);
  assert.deepEqual([shot.width, shot.height], size, JSON.stringify(shot));
  passed(`a screenshot of the unwatched agent tab is a ${size.join("x")} PNG, the page's own viewport`);

  step = "reading a PDF the unit tests read, in the packaged PDF worker";
  await cli("navigate", tab.id, `${origin}/text.pdf`, "--wait-until", "load");
  const read = await cli("pdf-text", tab.id);
  assert.deepEqual(
    [read.title, read.pageCount, read.pages],
    [
      PDF_TITLE,
      PDF_PAGES.length,
      PDF_PAGES.map((lines, index) => ({ number: index + 1, text: lines.join("\n") })),
    ],
    JSON.stringify(read),
  );
  passed("pdf-text reads a PDF in the PDF worker, which loads pdf.js from app.asar");

  step = "reading the unit tests' CJK PDF, which needs the packaged CMaps";
  await cli("navigate", tab.id, `${origin}/cjk.pdf`, "--wait-until", "load");
  const cjk = await cli("pdf-text", tab.id);
  assert.deepEqual(cjk.pages, [{ number: 1, text: CJK_TEXT }], JSON.stringify(cjk));
  passed("pdf-text reads a CJK PDF with the CMaps in the packaged resources");

  // A quit over an agent at work asks the person first, and no one is here
  // to answer.
  step = "closing the agent space";
  await cli("space", "close", space.id);
  step = "quitting Kamapathy";
  // SIGTERM takes Electron through app.quit, as the Quit menu item does.
  // Windows has no SIGTERM: taskkill without /F closes the window, as its
  // close button does, and with no agent space left Kamapathy quits.
  if (process.platform === "win32") await run("taskkill", ["/PID", String(kamapathy.pid)]);
  else kamapathy.kill("SIGTERM");
  await endedWithin(QUIT_MS);
  assert.ok(ended(), `Kamapathy was still running ${QUIT_MS / 1000} s after it was asked to quit`);
  assert.equal(kamapathy.exitCode, 0, `Kamapathy ended with ${ending()}`);
  assert.ok(
    !existsSync(join(profile, "agent", "endpoint")),
    "Kamapathy ended without withdrawing its agent endpoint, so its quit did not run",
  );
  passed("Kamapathy quits when asked, with exit code 0, and withdraws its agent endpoint");
  console.log(
    `Packaged app passed: ${checks.length} checks in ${Math.round((Date.now() - startedAt) / 1000)} s.`,
  );
} catch (error) {
  process.exitCode = 1;
  report(error);
} finally {
  clearTimeout(watchdog);
  forceStop();
  await endedWithin(5000);
  site.close();
  site.closeAllConnections();
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
// The watchdog is gone, so nothing Kamapathy leaves behind, such as a helper
// process holding its output pipes, may keep this run past its deadline.
process.exit();
