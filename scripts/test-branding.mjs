import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { desktopLaunch, prepareDesktopRuntime, projectDirectory } from "./desktop-runtime.mjs";

const run = promisify(execFile);
const executable = await prepareDesktopRuntime();
assert.equal(await prepareDesktopRuntime(), executable);
assert.equal(basename(executable), process.platform === "win32" ? "Kamapathy.exe" : process.platform === "darwin" ? "Kamapathy" : "kamapathy");
console.log("PASS branded runtime is reusable and has a native Kamapathy executable");

if (process.platform === "darwin") {
  const contents = dirname(dirname(executable));
  const { stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(contents, "Info.plist")]);
  const info = JSON.parse(stdout);
  assert.equal(info.CFBundleName, "Kamapathy");
  assert.equal(info.CFBundleDisplayName, "Kamapathy");
  assert.equal(info.CFBundleExecutable, "Kamapathy");
  assert.equal(info.CFBundleIdentifier, "app.kamapathy.browser");
  const expectedIcon = await readFile(join(projectDirectory, "build", "icon.icns"));
  const actualIcon = await readFile(join(contents, "Resources", info.CFBundleIconFile));
  assert.deepEqual(actualIcon, expectedIcon);
  console.log("PASS macOS bundle name, identifier, executable and app icon");
} else if (process.platform === "win32") {
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Item -LiteralPath $env:KAMAPATHY_BRANDING_EXECUTABLE).VersionInfo | Select-Object ProductName,FileDescription | ConvertTo-Json -Compress"], {
    env: { ...process.env, KAMAPATHY_BRANDING_EXECUTABLE: executable },
  });
  const info = JSON.parse(stdout.trim());
  assert.equal(info.ProductName, "Kamapathy");
  assert.equal(info.FileDescription, "Kamapathy");
  console.log("PASS Windows executable product name and description");
}

const profile = await mkdtemp(join(tmpdir(), "kamapathy-branding-"));
let app;
try {
  const launch = desktopLaunch("start", executable, { ...process.env, KAMAPATHY_USER_DATA: profile, ELECTRON_RUN_AS_NODE: "1" });
  app = await electron.launch({ executablePath: launch.executable, args: launch.args, cwd: profile, env: launch.options.env, timeout: 30000 });
  const page = await app.firstWindow();
  await page.waitForSelector(".home-page, .web-page");
  const identity = await app.evaluate(({ app, Menu }) => ({
    name: app.getName(),
    externalApplication: process.defaultApp,
    executable: process.execPath,
    profile: app.getPath("userData"),
    menu: Menu.getApplicationMenu()?.items.map((item) => item.label),
  }));
  assert.equal(identity.name, "Kamapathy");
  assert.equal(identity.externalApplication, true);
  assert.equal(resolve(identity.executable), resolve(executable));
  assert.equal(resolve(identity.profile), resolve(profile));
  if (process.platform === "darwin") assert.equal(identity.menu?.[0], "Kamapathy");
  console.log("PASS Kamapathy starts from another working directory with its own identity and isolated profile");
  const development = desktopLaunch("dev", executable, { ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(development.options.env.ELECTRON_EXEC_PATH, executable);
  assert.equal(development.options.env.ELECTRON_RUN_AS_NODE, undefined);
  console.log("PASS development launches use the same Kamapathy runtime");
} finally {
  await app?.close();
  await rm(profile, { recursive: true, force: true });
}

function childIsRunning(child) {
  return Boolean(child?.pid && child.exitCode === null && child.signalCode === null);
}

function waitForChildExit(child, timeoutMs) {
  if (!childIsRunning(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

async function stopChild(child, timeoutMs = 3000) {
  if (!childIsRunning(child)) return;
  child.kill();
  if (await waitForChildExit(child, timeoutMs)) return;
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, timeoutMs)))
    throw new Error("Normal Kamapathy startup did not stop after forced termination");
}

// Authentication compatibility must also exercise ordinary source startup.
// Playwright adds a debugging flag that changes navigator.webdriver in pages.
const normalProfile = await mkdtemp(join(tmpdir(), "kamapathy-normal-launch-"));
let report;
let rejectReport;
let timer;
let child;
const observed = new Promise((resolve, reject) => {
  report = resolve;
  rejectReport = reject;
});
const fixture = createServer(async (request, response) => {
  if (request.url === "/report") {
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096) throw new Error("Oversized diagnostic report");
        chunks.push(chunk);
      }
      report(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.end("ok");
    } catch (error) {
      rejectReport(error);
      response.writeHead(400).end();
    }
    return;
  }
  response.setHeader("Content-Type", "text/html");
  response.end('<h1>Kamapathy startup check</h1><script>fetch("/report",{method:"POST",body:JSON.stringify({webdriver:navigator.webdriver,userAgent:navigator.userAgent,cookies:navigator.cookieEnabled})});</script>');
});
try {
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  await writeFile(join(normalProfile, "browser-state.json"), JSON.stringify({
    spaces: [{ id: "probe", name: "Startup check", kind: "personal", color: "green", createdAt: Date.now() }],
    tabs: [{ id: "probe-tab", spaceId: "probe", title: "Startup check", url }],
    activeSpaceId: "probe", activeTabId: "probe-tab", settings: { restoreSession: true },
  }));
  const launch = desktopLaunch("start", executable, { ...process.env, KAMAPATHY_USER_DATA: normalProfile });
  child = spawn(launch.executable, launch.args, { ...launch.options, stdio: "ignore" });
  child.once("error", rejectReport);
  child.once("exit", (code, signal) => rejectReport(new Error(
    `Normal Kamapathy startup exited before reporting browser capabilities (${signal ? `signal ${signal}` : `code ${code}`})`,
  )));
  timer = setTimeout(() => rejectReport(new Error("Normal startup did not report its browser capabilities")), 20000);
  const capabilities = await observed;
  assert.equal(capabilities.webdriver, false);
  assert.equal(capabilities.cookies, true);
  assert.doesNotMatch(capabilities.userAgent, /Kamapathy|Electron/i);
  assert.match(capabilities.userAgent, /Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/);
  console.log("PASS normal Kamapathy source startup presents a Chrome-compatible user agent and does not enable WebDriver");
} finally {
  clearTimeout(timer);
  fixture.close();
  fixture.closeAllConnections();
  try {
    await stopChild(child);
  } finally {
    await rm(normalProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
