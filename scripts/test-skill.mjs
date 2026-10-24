import { poll, waitForState } from "./wait.mjs";
import { prepareDesktopRuntime } from "./desktop-runtime.mjs";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { _electron as electron } from "playwright";
import { REPORT_PAGES, startFormSite } from "../tests/fixtures/form-site.mjs";
import { ATTACHMENT, AUTH } from "../tests/fixtures/prompt-pages.mjs";
import { startUpdateFeed } from "../tests/fixtures/update-feed.mjs";
import { API_LEVEL } from "../skills/kamapathy/scripts/schema/index.mjs";

const temporary = await mkdtemp(join(tmpdir(), "kamapathy-skill-e2e-"));
const fixture = await startFormSite();
const skill = resolve(process.env.KAMAPATHY_SKILL_DIR || "skills/kamapathy");
const client = join(skill, "scripts/kamapathy.mjs");
const skillText = await readFile(join(skill, "SKILL.md"), "utf8");
// The skill tells agents how to choose a profile.
assert.ok(skillText.includes("KAMAPATHY_USER_DATA"));
// The client finds the test Kamapathy through its profile and never starts another.
const environment = {
  ...process.env,
  KAMAPATHY_USER_DATA: join(temporary, "profile"),
  KAMAPATHY_NO_LAUNCH: "1",
  KAMAPATHY_TEST_HOOKS: "1",
};
delete environment.ELECTRON_RUN_AS_NODE;
const packaged = Boolean(process.env.KAMAPATHY_EXECUTABLE);
// Agent setup and update checks run against a temporary home and a local
// feed, so no agent folder of this computer and no GitHub release is touched.
const agentHome = join(temporary, "home");
for (const folder of [".claude", ".codex"])
  await mkdir(join(agentHome, folder), { recursive: true });
const feed = await startUpdateFeed();
const appEnvironment = {
  ...environment,
  ...(process.platform === "win32"
    ? { USERPROFILE: agentHome, LOCALAPPDATA: agentHome }
    : { HOME: agentHome }),
  KAMAPATHY_UPDATE_FEED: feed.origin,
  KAMAPATHY_UPDATE_KIND: "linux-appimage",
};
for (const name of [
  "ZDOTDIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
])
  delete appEnvironment[name];
// A packaged build ignores the test feed, so its checks stay off GitHub.
if (packaged) {
  await mkdir(environment.KAMAPATHY_USER_DATA, { recursive: true });
  await writeFile(
    join(environment.KAMAPATHY_USER_DATA, "browser-state.json"),
    JSON.stringify({ settings: { updateChecks: false } }),
  );
}
const checks = [];
const calls = [];
let browser;
let chrome;
const artifacts = resolve("artifacts/review");
await mkdir(artifacts, { recursive: true });
// Opt-in evidence for intermittent CI failures: records where native input and
// navigation stop without changing the automation under test.
const diagnostics = process.env.KAMAPATHY_DIAGNOSTICS_DIR
  ? resolve(process.env.KAMAPATHY_DIAGNOSTICS_DIR)
  : null;
if (diagnostics) await mkdir(diagnostics, { recursive: true });
const PAGE_RECORDER = `(() => {
  if (window.__kamapathyDiagnostics) return;
  window.__kamapathyDiagnostics = true;
  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "submit", "pagehide"])
    addEventListener(type, (event) => {
      try {
        const entries = JSON.parse(sessionStorage.getItem("__kamapathyDiagnostics") || "[]");
        const target = event.target;
        entries.push({ type, at: Math.round(performance.timeOrigin + event.timeStamp), trusted: event.isTrusted, target: target?.id ? "#" + target.id : target?.nodeName, x: event.clientX, y: event.clientY, path: location.pathname });
        sessionStorage.setItem("__kamapathyDiagnostics", JSON.stringify(entries.slice(-200)));
      } catch {}
    }, { capture: true, passive: true });
})()`;
const PAGE_STATE = `(() => {
  const rectangle = (selector) => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null;
  let received = [];
  try { received = JSON.parse(sessionStorage.getItem("__kamapathyDiagnostics") || "[]"); } catch {}
  return {
    href: location.href, title: document.title, readyState: document.readyState,
    visibility: document.visibilityState, focused: document.hasFocus(),
    devicePixelRatio, viewport: [innerWidth, innerHeight], scroll: [scrollX, scrollY],
    text: (document.body?.innerText || "").slice(0, 600),
    responseForm: rectangle("#response-form"), createButton: rectangle("#create-submit"),
    paints: performance.getEntriesByType("paint").map((entry) => entry.name + ":" + Math.round(entry.startTime)),
    timeOrigin: Math.round(performance.timeOrigin),
    received,
  };
})()`;
function installRecorder({ app, webContents }, pageRecorder) {
  const events = (globalThis.__kamapathyDiagnostics = []);
  const record = (contents, type, detail) => {
    events.push({ at: Date.now(), contents: contents.id, type, ...detail });
    if (events.length > 3000) events.splice(0, events.length - 3000);
  };
  const watch = (contents) => {
    for (const type of ["did-start-loading", "did-stop-loading", "dom-ready", "did-finish-load", "unresponsive", "responsive", "focus", "blur", "destroyed"])
      contents.on(type, () => record(contents, type));
    contents.on("render-process-gone", (_event, details) => record(contents, "render-process-gone", { reason: details.reason }));
    contents.on("did-start-navigation", (details) => record(contents, "did-start-navigation", { url: details.url, mainFrame: details.isMainFrame, sameDocument: details.isSameDocument }));
    contents.on("did-redirect-navigation", (details) => record(contents, "did-redirect-navigation", { url: details.url, mainFrame: details.isMainFrame }));
    contents.on("did-navigate", (_event, url, code) => record(contents, "did-navigate", { url, code }));
    contents.on("did-fail-load", (_event, code, description, url, mainFrame) => record(contents, "did-fail-load", { code, description, url, mainFrame }));
    contents.on("before-mouse-event", (_event, input) => record(contents, "before-mouse-event", { input: input.type, x: input.x, y: input.y }));
    contents.on("input-event", (_event, input) => {
      if (input.type !== "mouseMove") record(contents, "input-event", { input: input.type });
    });
    contents.on("dom-ready", () => {
      if (/^https?:/.test(contents.getURL())) contents.executeJavaScript(pageRecorder).catch(() => {});
    });
  };
  webContents.getAllWebContents().forEach(watch);
  app.on("web-contents-created", (_event, contents) => watch(contents));
}
let diagnosticIndex = 0;
async function captureDiagnostics(error) {
  const report = {
    at: Date.now(),
    error: String(error?.stack || error),
    load: loadavg(),
    calls: calls.slice(-12),
    requests: fixture.requests.slice(-40),
    fixtureEvents: fixture.events,
  };
  if (browser)
    report.browser = await Promise.race([
      browser.evaluate(async ({ BrowserWindow, screen, webContents }, pageState) => {
        const bounded = (promise) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("page state timed out"), 3000))]);
        return {
          windows: BrowserWindow.getAllWindows().map((window) => ({
            bounds: window.getBounds(), visible: window.isVisible(), focused: window.isFocused(), minimized: window.isMinimized(),
            views: window.contentView.children.map((view) => ({ bounds: view.getBounds(), visible: view.getVisible?.(), url: view.webContents?.getURL() })),
          })),
          displays: screen.getAllDisplays().map((display) => ({ scaleFactor: display.scaleFactor, bounds: display.bounds })),
          pages: await Promise.all(webContents.getAllWebContents().filter((contents) => /^https?:/.test(contents.getURL())).map(async (contents) => ({
            contents: contents.id, url: contents.getURL(), loading: contents.isLoading(), loadingMainFrame: contents.isLoadingMainFrame(),
            crashed: contents.isCrashed(), debuggerAttached: contents.debugger.isAttached(),
            history: contents.navigationHistory.getAllEntries().map((entry) => entry.url), activeIndex: contents.navigationHistory.getActiveIndex(),
            page: await bounded(contents.executeJavaScript(pageState)).catch((reason) => String(reason)),
          }))),
          events: globalThis.__kamapathyDiagnostics?.slice(-400) ?? [],
        };
      }, PAGE_STATE),
      new Promise((resolve) => setTimeout(() => resolve("browser state timed out"), 10000)),
    ]).catch((reason) => String(reason));
  if (process.platform === "darwin")
    report.processes = await new Promise((resolve) =>
      execFile("ps", ["-Aco", "pid,pcpu,pmem,comm", "-r"], (failure, output) =>
        resolve(failure ? String(failure) : output.split("\n").slice(0, 16)),
      ),
    );
  const file = join(diagnostics, `failure-${++diagnosticIndex}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.error(`Diagnostics written to ${file}`);
}
function passed(name) {
  checks.push(name);
  console.log(`PASS ${name}`);
}
async function cli(args, input, options = {}) {
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [client, ...args], {
      env: options.env ?? environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      errors = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Client timed out: ${args[0]}`));
    }, 80000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, errors });
    });
    child.stdin.end(
      input === undefined
        ? undefined
        : typeof input === "string"
          ? input
          : JSON.stringify(input),
    );
  });
  calls.push({
    command: args[0],
    code: result.code,
    outputCharacters: result.output.length,
    started,
    milliseconds: Date.now() - started,
  });
  if (!options.failure)
    assert.equal(
      result.code,
      0,
      `${args[0]} failed: ${result.errors || result.output}`,
    );
  else assert.notEqual(result.code, 0, `${args[0]} unexpectedly succeeded`);
  return result;
}
async function json(args, input) {
  return JSON.parse((await cli([...args, "--json"], input)).output);
}
// A program agent setup wrote, run the way a terminal would run it.
async function program(file, args, options = {}) {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env: options.env ?? environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      errors = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${file} timed out`));
    }, 60000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, errors });
    });
  });
  assert.equal(result.code, 0, `${file} failed: ${result.errors}`);
  return result;
}
const noticeLines = (text) =>
  text.split("\n").filter((line) => line.startsWith("notice: "));
// Every file left under a folder, by path, so a deleted download shows.
async function filesUnder(folder) {
  if (!existsSync(folder)) return [];
  const entries = await readdir(folder, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
// The updater reuses a list it read less than 60 seconds ago.
async function pastReuse() {
  const last = feed.lastListRequestAt();
  if (last === null) return;
  const remaining = 61000 - (Date.now() - last);
  if (remaining > 0) await sleep(remaining);
}
const observe = (id) => json(["snapshot", id, "--full"]);
function ref(snapshot, label, tag) {
  const matches = snapshot.interactables.filter(
    (control) => control.label === label && (!tag || control.tag === tag),
  );
  assert.equal(matches.length, 1, `Expected one control labeled ${label}`);
  return matches[0].ref;
}
const fill = (reference, value) => ({ type: "fill", ref: reference, value });
const click = (reference) => ({ type: "click", ref: reference });
const wait = (selector, text) => ({
  type: "wait",
  selector,
  ...(text ? { text } : {}),
  timeoutMs: 5000,
});
// KAMAPATHY_TEST_HOOKS makes the server install this probe in Kamapathy's
// main process. It reports the tab sessions behind the routes.
const probe = (name, ...args) =>
  browser.evaluate(
    (_electron, [name, args]) => globalThis.__kamapathyTest[name](...args),
    [name, args],
  );
// The loopback port changes every run and refs keep counting through a run,
// so captures are compared with both renumbered.
function normalizeCapture(text) {
  const refs = new Map();
  return text
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:3000")
    .replace(/@e\d+/g, (reference) => {
      if (!refs.has(reference)) refs.set(reference, `@e${refs.size + 1}`);
      return refs.get(reference);
    });
}
try {
  browser = await electron.launch({
    executablePath: process.env.KAMAPATHY_EXECUTABLE
      ? resolve(process.env.KAMAPATHY_EXECUTABLE)
      : await prepareDesktopRuntime(),
    args: process.env.KAMAPATHY_EXECUTABLE ? [] : [resolve("out/main/index.js")],
    env: appEnvironment,
  });
  if (diagnostics) await browser.evaluate(installRecorder, PAGE_RECORDER);
  chrome = await browser.firstWindow();
  await chrome.waitForSelector(".home-intro");
  await chrome.evaluate(() =>
    window.kamapathy.dispatch({
      type: "settings:update",
      settings: { automationEnabled: true },
    }),
  );
  await waitForState(chrome, (state) => state.automation.running);
  const packageVersion = JSON.parse(await readFile(resolve("package.json"), "utf8")).version;
  assert.equal((await cli(["health"])).output.trim(), `ok Kamapathy ${packageVersion}`);
  passed("standalone skill client connects automatically with no credentials");
  const original = (await chrome.evaluate(() => window.kamapathy.getState()))
    .activeTabId;
  // Raw requests, for the fields an error carries and the headers a
  // capture answers with.
  const socket = await import(pathToFileURL(client).href);
  const send = socket.socketFetch(await socket.resolveSocket(environment));
  const callApi = (path, method = "GET", body) =>
    send(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const { space } = await json(["space", "create", "Skill form review"]);
  const { tab } = await json(["open", space.id, `${fixture.origin}/forms/new`]);
  const initial = await observe(tab.id);
  assert.match(initial.title, /Create a form/);
  assert.ok(
    initial.interactables.every((control) => control.type !== "hidden"),
  );
  await writeFile(
    join(artifacts, "kamapathy-form.txt"),
    (await cli(["snapshot", tab.id, "--full"])).output,
  );
  passed("compact observation exposes labeled controls and hides CSRF fields");
  const creation = await json(
    ["batch", tab.id],
    [
      fill(ref(initial, "Form title"), "Release feedback"),
      fill(ref(initial, "Description"), "Local end-to-end browser review"),
      fill(ref(initial, "Template"), "feedback"),
      click(ref(initial, "Create form")),
      wait("#response-form"),
      { type: "snapshot", mode: "full" },
    ],
  );
  assert.equal(creation.ok, true);
  assert.equal(fixture.forms.size, 1);
  const created = creation.results.at(-1).result;
  assert.match(created.text, /Form created/);
  await writeFile(
    join(artifacts, "kamapathy-created-form.txt"),
    (await cli(["snapshot", tab.id, "--full"])).output,
  );
  passed(
    "skill batch creates a form through a real POST and follows its redirect",
  );
  assert.equal(await probe("attaches", tab.id), 1);
  const existingTabs = (
    await chrome.evaluate(() => window.kamapathy.getState())
  ).tabs.map((item) => item.id);
  const personal = (
    await chrome.evaluate(
      (url) =>
        window.kamapathy.dispatch({
          type: "tab:create",
          spaceId: "personal",
          url,
          background: true,
        }),
      `${fixture.origin}/lab`,
    )
  ).tabs.find((item) => !existingTabs.includes(item.id));
  await waitForState(
    chrome,
    (state, id) =>
      state.tabs.some(
        (item) =>
          item.id === id && item.title === "Interaction lab" && !item.loading,
      ),
    personal.id,
  );
  assert.equal(await probe("attaches", personal.id), 0);
  assert.equal(await probe("hasSession", personal.id), false);
  await chrome.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:close", id }),
    personal.id,
  );
  passed(
    "one debugger attach per agent tab across snapshot, click and navigate, and none for a personal tab",
  );
  await cli(["click", tab.id, ref(created, "Submit response")]);
  assert.equal(fixture.submissions.length, 0);
  passed("native required-field validation blocks incomplete submission");
  await json(
    ["batch", tab.id],
    [
      fill(ref(created, "Your name"), "Browser Reviewer"),
      fill(ref(created, "Email address"), "reviewer@example.test"),
      fill(ref(created, "Topic"), "automation"),
      click(ref(created, "High")),
      fill(
        ref(created, "Your feedback"),
        "The local form workflow completed through the browser skill.",
      ),
      click(ref(created, "Add project context")),
      wait("#context"),
    ],
  );
  const withContext = await observe(tab.id);
  const submission = await json(
    ["batch", tab.id],
    [
      fill(
        ref(withContext, "Project context"),
        "Cross-platform portfolio review",
      ),
      click(ref(withContext, "I agree to submit this local test response")),
      click(ref(withContext, "Submit response")),
      wait("#confirmation", "Submission received"),
      { type: "snapshot", mode: "full" },
    ],
  );
  assert.equal(submission.ok, true);
  assert.equal(fixture.submissions.length, 1);
  assert.deepEqual(fixture.submissions[0], {
    id: "receipt-1",
    formId: "form-1",
    name: "Browser Reviewer",
    email: "reviewer@example.test",
    topic: "automation",
    notes: "The local form workflow completed through the browser skill.",
    priority: "high",
    context: "Cross-platform portfolio review",
  });
  assert.match(submission.results.at(-1).result.text, /Submission received/);
  await writeFile(
    join(artifacts, "kamapathy-receipt.txt"),
    (await cli(["snapshot", tab.id, "--full"])).output,
  );
  assert.equal(
    (await chrome.evaluate(() => window.kamapathy.getState())).activeTabId,
    original,
  );
  passed(
    "dynamic fields, select, radio, checkbox and textarea submit once without stealing the active tab",
  );
  const stale = await cli(
    ["fill", tab.id, ref(created, "Your name"), "--stdin"],
    "Wrong page",
    { failure: true },
  );
  assert.match(stale.errors, /stale|reference/i);
  passed("refs from the previous document are rejected after a redirect");
  await json(["navigate", tab.id, `${fixture.origin}/lab`]);
  let lab = await observe(tab.id);
  assert.ok(!JSON.stringify(lab).includes("hidden-fixture-value"));
  assert.equal(
    lab.interactables.find((control) => control.label === "Private input")
      .valueHidden,
    true,
  );
  const oldField = ref(lab, "Replaceable field");
  await cli(["click", tab.id, ref(lab, "Replace control")]);
  const detached = await cli(
    ["fill", tab.id, oldField, "--stdin"],
    "Do not retarget",
    { failure: true },
  );
  assert.match(detached.errors, /stale|reference|detached/i);
  passed("detached refs cannot silently target replacement controls");
  lab = await observe(tab.id);
  await cli(
    ["fill", tab.id, ref(lab, "Read only input"), "--stdin"],
    "Should fail",
    { failure: true },
  );
  await cli(["click", tab.id, ref(lab, "Disabled action")], undefined, {
    failure: true,
  });
  passed("disabled and read-only controls fail with actionable errors");
  await cli(
    ["fill", tab.id, ref(lab, "Editable note"), "--stdin"],
    "Edited through the skill",
  );
  const scoped = await json(["snapshot", tab.id, "--selector", "#editable"]);
  assert.equal(scoped.text, "");
  assert.ok(!scoped.text.includes("Interaction lab"));
  assert.equal(scoped.interactables[0].value, "Edited through the skill");
  assert.equal(
    (await json(["snapshot", tab.id, "--selector", "#editable-result"])).text,
    "Edited through the skill",
  );
  passed(
    "contenteditable fill is verified by the page and shown as the field's value, never as page text",
  );
  const partial = await cli(
    ["batch", tab.id, "--json"],
    [
      fill(ref(lab, "Replacement field"), "First action completed"),
      click(ref(lab, "Disabled action")),
      click(ref(lab, "Show delayed result")),
    ],
    { failure: true },
  );
  const partialResult = JSON.parse(partial.output);
  assert.equal(partialResult.ok, false);
  assert.equal(partialResult.failedIndex, 1);
  assert.equal(partialResult.results.length, 1);
  assert.ok(!(await observe(tab.id)).text.includes("Delayed content ready"));
  passed("batch failure returns partial progress and stops subsequent actions");
  await json(
    ["batch", tab.id],
    [
      click(ref(lab, "Show delayed result")),
      wait("#delayed-result", "Delayed content ready"),
    ],
  );
  await cli(
    ["wait", tab.id, "--stdin"],
    { selector: "#does-not-exist", timeoutMs: 100 },
    { failure: true },
  );
  passed(
    "bounded waits observe asynchronous content and time out on missing conditions",
  );
  await cli(["scroll", tab.id, "down", "600"]);
  await cli(["click", tab.id, ref(lab, "Bottom action")]);
  assert.match(
    (await json(["snapshot", tab.id, "--selector", "#bottom-result"])).text,
    /Bottom action completed/,
  );
  passed("scrolling and offscreen control clicks target the correct element");
  await cli(
    ["fill", tab.id, ref(lab, "Search fixture", "input"), "--stdin"],
    "keyboard submission",
  );
  await cli(["press", tab.id, "Enter", ref(lab, "Search fixture", "input")]);
  await cli(["wait", tab.id, "--stdin"], {
    selector: "#enter-result",
    text: "keyboard submission",
    timeoutMs: 5000,
  });
  passed("trusted Enter key submits a native form and follows navigation");
  const png = join(temporary, "viewport.png");
  await cli(["screenshot", tab.id, png]);
  const image = await readFile(png);
  assert.deepEqual(
    [...image.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
  );
  assert.ok(image.readUInt32BE(16) > 0 && image.readUInt32BE(20) > 0);
  await cli(["screenshot", tab.id, png], undefined, { failure: true });
  passed(
    "viewport screenshots contain a real PNG and do not overwrite existing files",
  );
  // Section 4 screenshots in the real app: the sizes a request asks for,
  // measured against what the page and the app report, and captures in
  // every window state. The spike saw a view Chromium does not paint
  // answer slowly, with an old frame or not at all, so every capture of a
  // view the window hides goes through the never-shown capture window.
  const deviceScale = await browser.evaluate(({ BrowserWindow, screen }) =>
    screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds())
      .scaleFactor,
  );
  const viewSizes = (url) =>
    browser.evaluate(
      ({ BrowserWindow }, url) =>
        BrowserWindow.getAllWindows()
          .flatMap((window) => window.contentView.children)
          .filter((view) => view.webContents?.getURL() === url)
          .map((view) => ({
            width: view.getBounds().width,
            height: view.getBounds().height,
          })),
      url,
    );
  const shot = async (id, name, ...args) => {
    const file = join(temporary, name);
    const saved = await json(["screenshot", id, file, ...args]);
    const bytes = await readFile(file);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(
      [saved.width, saved.height],
      [bytes.readUInt32BE(16), bytes.readUInt32BE(20)],
      `${name} is not the size the client printed`,
    );
    return saved;
  };
  const shortPage = `${fixture.origin}/snapshot/links`;
  await json(["navigate", tab.id, shortPage]);
  const shortShot = await shot(tab.id, "short.png");
  // A page that does not scroll fills its view, so its capture is the
  // view's own size in CSS pixels.
  assert.deepEqual(await viewSizes(shortPage), [
    { width: shortShot.width, height: shortShot.height },
  ]);
  assert.deepEqual(
    [shortShot.clip, shortShot.pixelRatio],
    [{ x: 0, y: 0, width: shortShot.width, height: shortShot.height }, 1],
  );
  const bandsPage = `${fixture.origin}/snapshot/capture?tab=agent`;
  await json(["navigate", tab.id, bandsPage]);
  // The page measured its own viewport and document before anything
  // captured it.
  const [viewportWidth, viewportHeight, documentWidth, documentHeight] = /viewport (\d+)x(\d+) document (\d+)x(\d+)/
    .exec((await json(["snapshot", tab.id, "--selector", "#sizes"])).text)
    .slice(1)
    .map(Number);
  const viewportShot = await shot(tab.id, "viewport-css.png");
  assert.deepEqual(
    [viewportShot.width, viewportShot.height],
    [viewportWidth, viewportHeight],
  );
  const fullShot = await shot(tab.id, "full-page.png", "--full-page");
  assert.deepEqual(
    [fullShot.width, fullShot.height],
    [documentWidth, documentHeight],
  );
  assert.ok(
    fullShot.height > viewportHeight * 3,
    `A full page of ${fullShot.height} pixels is no taller than its viewport`,
  );
  const clipShot = await shot(tab.id, "clip.png", "--clip", "10,20,200,100");
  assert.deepEqual(
    [clipShot.width, clipShot.height, clipShot.clip],
    [200, 100, { x: 10, y: 20, width: 200, height: 100 }],
  );
  const deviceShot = await shot(tab.id, "device.png", "--scale", "device");
  assert.deepEqual(
    [deviceShot.width, deviceShot.height, deviceShot.pixelRatio],
    [
      Math.round(viewportWidth * deviceScale),
      Math.round(viewportHeight * deviceScale),
      deviceScale,
    ],
  );
  const offPage = await cli(
    ["screenshot", tab.id, join(temporary, "off-page.png"), "--clip", "9000,9000,10,10"],
    undefined,
    { failure: true },
  );
  assert.match(offPage.errors, /422 clip_outside_page/);
  passed(
    "full-page, clipped and CSS-scaled screenshots have the expected PNG sizes",
  );
  // The page paints 900 pixel bands, so the color in the middle of a
  // capture says where the page was scrolled when the frame was taken.
  const BANDS = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
  ];
  const bandAt = (y, height) => Math.floor((y + height / 2) / 900);
  const middleOf = (png) =>
    browser.evaluate(({ nativeImage }, base64) => {
      const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
      const { width, height } = image.getSize();
      // toBitmap gives blue, green, red and alpha per pixel.
      const [blue, green, red] = image
        .crop({
          x: Math.floor(width / 2),
          y: Math.floor(height / 2),
          width: 1,
          height: 1,
        })
        .toBitmap();
      return { width, height, color: [red, green, blue] };
    }, png.toString("base64"));
  const windowStates = () =>
    browser.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((window) => [
        window.isVisible(),
        window.isFocused(),
        window.isMinimized(),
      ]),
    );
  const captureSpace = (await json(["space", "create", "Capture review"])).space;
  const captureTab = (
    await json([
      "open",
      captureSpace.id,
      `${fixture.origin}/snapshot/capture?tab=other`,
    ])
  ).tab;
  await observe(captureTab.id);
  const scrolledTo = async (id, direction, pixels) =>
    (await (await callApi(`/tabs/${id}/scroll`, "POST", { direction, pixels })).json()).y;
  const bandSeen = async (id, y) => {
    const started = Date.now();
    const response = await callApi(`/tabs/${id}/screenshot`);
    const png = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200, png.toString("utf8").slice(0, 300));
    const frame = await middleOf(png);
    const band = bandAt(y, frame.height);
    assert.ok(
      frame.color.every(
        (channel, index) => Math.abs(channel - BANDS[band][index]) < 60,
      ),
      `A capture at ${y} shows ${frame.color} where band ${band} is ${BANDS[band]}`,
    );
    assert.ok(
      Date.now() - started < 5000,
      `A capture took ${Date.now() - started} ms`,
    );
    return band;
  };
  // Xvfb CI has no window manager to acknowledge native minimization, so
  // Linux checks the hidden window only.
  const windowModes =
    process.platform === "linux" ? ["shown", "hidden"] : ["shown", "hidden", "minimized"];
  for (const mode of windowModes) {
    if (mode !== "shown")
      await browser.evaluate(({ BrowserWindow }, mode) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (mode === "minimized") window.minimize();
        else window.hide();
      }, mode);
    await poll(
      async () => {
        const [[visible, , minimized]] = await windowStates();
        return mode === "minimized"
          ? minimized
          : mode === "hidden"
            ? !visible
            : visible && !minimized;
      },
      { timeoutMs: 5000, label: `the ${mode} window` },
    );
    const windowsBefore = await windowStates();
    const shellBefore = await chrome.evaluate(() => window.kamapathy.getState());
    // Two captures of one tab at different scroll positions: an old or
    // repeated frame would show the band the page has left.
    for (const id of mode === "shown" ? [captureTab.id, tab.id] : [captureTab.id]) {
      await scrolledTo(id, "up", 2000);
      await scrolledTo(id, "up", 2000);
      const bands = [];
      for (const step of [900, 900])
        bands.push(await bandSeen(id, await scrolledTo(id, "down", step)));
      assert.notEqual(
        bands[0],
        bands[1],
        `Both captures with the window ${mode} show band ${bands[0]}`,
      );
    }
    assert.deepEqual(await windowStates(), windowsBefore);
    const shellAfter = await chrome.evaluate(() => window.kamapathy.getState());
    assert.deepEqual(
      [shellAfter.activeSpaceId, shellAfter.activeTabId],
      [shellBefore.activeSpaceId, shellBefore.activeTabId],
    );
    assert.equal(shellAfter.activeTabId, original);
    if (mode !== "shown") {
      await browser.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        if (window.isMinimized()) window.restore();
        window.show();
      });
      await poll(
        async () => {
          const [[visible, , minimized]] = await windowStates();
          return visible && !minimized;
        },
        { timeoutMs: 5000, label: "the restored window" },
      );
    }
  }
  await cli(["space", "close", captureSpace.id]);
  passed(
    "screenshots work with the window hidden or minimized and leave the active space, window visibility and focus unchanged",
  );
  await cli(["handoff", space.id]);
  await cli(["snapshot", tab.id], undefined, { failure: true });
  await cli(["click", tab.id, "#enter-result"], undefined, { failure: true });
  await chrome.evaluate(
    (id) =>
      window.kamapathy.dispatch({ type: "space:ownership", id, owner: "agent" }),
    space.id,
  );
  await observe(tab.id);
  passed(
    "human handoff blocks skill reads and actions until the person returns control in Kamapathy",
  );
  // The agent takes control back with the client after its own handoff and
  // after the person took over in Kamapathy, and page actions work again.
  // human_control says why the person has control, and resume reports
  // what changed meanwhile.
  for (const [takeOver, message] of [
    [() => cli(["handoff", space.id]), /409 human_control: You handed this space to the person\./],
    [
      () =>
        chrome.evaluate(
          (id) =>
            window.kamapathy.dispatch({ type: "space:ownership", id, owner: "human" }),
          space.id,
        ),
      /409 human_control: The person took over this space\./,
    ],
  ]) {
    await takeOver();
    const refused = await cli(["click", tab.id, "#delayed"], undefined, {
      failure: true,
    });
    assert.match(refused.errors, message);
    const resumedOutput = (await cli(["resume", space.id])).output;
    assert.match(resumedOutput, /^ok: agent control resumed\nactive p\d+ /);
    await json(["navigate", tab.id, `${fixture.origin}/lab`]);
    const resumed = await observe(tab.id);
    await json(
      ["batch", tab.id],
      [
        click(ref(resumed, "Show delayed result")),
        wait("#delayed-result", "Delayed content ready"),
      ],
    );
  }
  await cli(["resume", space.id]);
  const { activity } = await chrome.evaluate(() => window.kamapathy.getState());
  assert.equal(
    activity.filter(
      (item) =>
        item.spaceId === space.id &&
        item.message === "Agent took back control of this space",
    ).length,
    2,
  );
  passed(
    "skill resume takes control back after a handoff or a takeover in Kamapathy, and page actions work again",
  );
  // Section 4 selectors in the real app. The fixture reports the id of the
  // control each click reached, through composedPath, so a form that
  // matched the wrong element says so.
  const formsPage = `${fixture.origin}/selectors/forms`;
  await json(["navigate", tab.id, formsPage]);
  const FORMS = [
    ["#plain", "plain"],
    ["css=.boxed", "prefixed"],
    ["text=keep the draft", "worded"],
    ['text="Publish"', "exact"],
    ['role=button[name="Retry now"]', "roleExact"],
    ['role=button[name*="invoice"]', "rolePart"],
    ["href=/plans?tier=pro#faq", "addressed"],
    ["xpath=//table//tr[2]//button", "rowTwo"],
    ['li:has-text("Invoice 12")', "invoice12"],
    ['button:text-is("Save")', "save"],
    [".pick >> nth=-1", "pickLast"],
    ["#shadowItem", "shadowItem"],
    ["#frameItem", "frameItem"],
  ];
  const reached = async (selector) =>
    (await json(["snapshot", tab.id, "--selector", selector])).text;
  for (const [selector, id] of FORMS) {
    const clicked = await callApi(`/tabs/${tab.id}/click`, "POST", { selector });
    assert.equal(clicked.status, 200, `${selector}: ${await clicked.text()}`);
    assert.equal(
      await reached(id === "frameItem" ? "#frameStatus" : "#status"),
      `clicked ${id}`,
      selector,
    );
  }
  // The same forms through the CLI, each click followed by a wait for the
  // id it must have reached.
  await json(["navigate", tab.id, formsPage]);
  for (const group of [FORMS.slice(0, 6), FORMS.slice(6, 12)]) {
    const batched = await json(
      ["batch", tab.id],
      group.flatMap(([selector, id]) => [
        { type: "click", selector },
        {
          type: "wait",
          selector: "#status",
          text: `clicked ${id}`,
          timeoutMs: 5000,
        },
      ]),
    );
    assert.equal(batched.ok, true, JSON.stringify(batched));
  }
  await cli(["click", tab.id, "#frameItem"]);
  await cli(["wait", tab.id, "--stdin"], {
    selector: "#frameStatus",
    text: "clicked frameItem",
    timeoutMs: 5000,
  });
  const feedBefore = (await chrome.evaluate(() => window.kamapathy.getState()))
    .activity.length;
  const malformed = await cli(
    ["click", tab.id, "button:has-text(Save)"],
    undefined,
    { failure: true },
  );
  assert.match(malformed.errors, /400 invalid_selector/);
  // A selector the main process rejects never reaches the page, so the
  // person's feed says nothing happened.
  assert.equal(
    (await chrome.evaluate(() => window.kamapathy.getState())).activity.length,
    feedBefore,
  );
  const unmatched = await (
    await callApi(`/tabs/${tab.id}/click`, "POST", { selector: "#no-such-control" })
  ).json();
  assert.equal(unmatched.error.code, "no_match");
  assert.equal(unmatched.error.selector, "#no-such-control");
  assert.ok(
    Number.isInteger(unmatched.error.waitedMs),
    JSON.stringify(unmatched.error),
  );
  const several = await callApi(`/tabs/${tab.id}/click`, "POST", {
    selector: ".pick",
  });
  const ambiguous = (await several.json()).error;
  assert.equal(several.status, 422);
  assert.deepEqual(
    [
      ambiguous.code,
      ambiguous.selector,
      ambiguous.count,
      ambiguous.visible,
      ambiguous.hidden,
      ambiguous.actionable,
      ambiguous.candidates.length,
    ],
    ["ambiguous_match", ".pick", 4, 3, 1, 3, 3],
  );
  // A candidate's ref is the way out of an ambiguous selector.
  const candidate = ambiguous.candidates[0];
  assert.equal(candidate.role, "button");
  assert.equal(
    (await callApi(`/tabs/${tab.id}/click`, "POST", { ref: candidate.ref })).status,
    200,
  );
  assert.equal(await reached("#status"), "clicked pickOne");
  const named = await cli(["click", tab.id, ".pick"], undefined, {
    failure: true,
  });
  assert.match(named.errors, /422 ambiguous_match/);
  assert.equal(
    named.errors.split("\n").filter((line) => line.includes("candidate ")).length,
    3,
  );
  for (const [selector, reason, hint] of [
    ["@21", "ref_form", "Refs look like @e21. Take one from a snapshot."],
    ["#1abc", "css", 'Write ids that start with a digit as [id="1abc"].'],
  ]) {
    const refused = await callApi(`/tabs/${tab.id}/click`, "POST", { selector });
    const problem = (await refused.json()).error;
    assert.equal(refused.status, 400);
    assert.deepEqual(
      [problem.code, problem.selector, problem.reason, problem.hint],
      ["invalid_selector", selector, reason, hint],
    );
    assert.ok(problem.forms.includes('role=button[name="Save"]'), problem.forms);
    assert.ok(
      (await cli(["click", tab.id, selector], undefined, { failure: true })).errors.includes(
        `hint: ${hint}`,
      ),
    );
  }
  const never = await callApi(`/tabs/${tab.id}/click`, "POST", { ref: "@e99999" });
  assert.equal(never.status, 404);
  assert.deepEqual(
    (({ code, ref: reference }) => [code, reference])((await never.json()).error),
    ["unknown_ref", "@e99999"],
  );
  passed("selector forms act through the API and CLI");
  // Snapshot scopes: the viewport after a scroll, a control ref and a
  // frame ref as roots.
  await json(["navigate", tab.id, `${fixture.origin}/snapshot/sections`]);
  await observe(tab.id);
  assert.equal((await json(["scroll", tab.id, "down", "2000"])).y, 2000);
  const inView = await json(["snapshot", tab.id, "--viewport", "--full"]);
  assert.match(inView.text, /Middle section text/);
  assert.match(inView.text, /Frame near text/);
  for (const away of [
    "Top section text",
    "Bottom section text",
    "Card bottom text",
    "Frame far text",
  ])
    assert.ok(!inView.text.includes(away), `${away} is outside the viewport`);
  const structure = await json(["snapshot", tab.id, "--outline", "--full"]);
  const innerFrame = structure.interactables.find(
    (item) => item.label === "Inner notes",
  );
  assert.equal(innerFrame.role, "iframe");
  const inFrame = await json(["snapshot", tab.id, "--root", innerFrame.ref, "--full"]);
  assert.equal(
    inFrame.text,
    "Frame near text\nFrame button\nFrame far text\nFrame far button",
  );
  const cardButton = ref(await observe(tab.id), "Card button");
  const inCard = await json(["snapshot", tab.id, "--root", cardButton, "--full"]);
  assert.equal(inCard.text, "Card button");
  assert.deepEqual(
    inCard.interactables.map((item) => item.ref),
    [cardButton],
  );
  // An outline: landmarks, headings, tables, link addresses and an open
  // dialog first.
  await json(["navigate", tab.id, `${fixture.origin}/snapshot/outline`]);
  const outline = (await json(["snapshot", tab.id, "--outline", "--full"])).outline;
  for (const printed of [
    'dialog "Confirm"',
    "banner",
    'navigation "Sections"',
    'heading "Plans" level=2',
    "listitem",
    'table "Prices"',
    'columnheader "Plan"',
    "search",
    "contentinfo",
  ])
    assert.ok(outline.includes(printed), `${printed} is missing from the outline`);
  assert.match(outline, /link "Plans" @e\d+ href=\/plans\?tier=pro#faq/);
  assert.ok(
    outline.indexOf('dialog "Confirm"') < outline.indexOf("banner"),
    "an open dialog prints first",
  );
  // Continuation: the parts cover the page once, in text and in outlines.
  await json(["navigate", tab.id, `${fixture.origin}/snapshot/parts`]);
  const whole = await json([
    "snapshot",
    tab.id,
    "--max-chars",
    "24000",
    "--max-controls",
    "100",
  ]);
  const bounded = ["--max-chars", "900", "--max-controls", "4"];
  let piece = await json(["snapshot", tab.id, ...bounded]);
  const pieces = [];
  const labels = [];
  for (let round = 0; ; round++) {
    pieces.push(piece.text);
    labels.push(...piece.interactables.map((item) => item.label));
    assert.ok(round < 40, "the parts of one page must end");
    if (!piece.next) break;
    piece = await json(["snapshot", tab.id, ...bounded, "--cursor", piece.next]);
  }
  assert.ok(pieces.length > 1, "the page takes more than one part");
  assert.equal(pieces.join(""), whole.text);
  // One read of the whole page needs no ranking, so the parts hold the
  // same controls in another order, each of them once.
  assert.deepEqual(
    [...labels].sort(),
    whole.interactables.map((item) => item.label).sort(),
  );
  assert.match(
    (await cli(["snapshot", tab.id, ...bounded])).output,
    /\nNext part: cursor c1\./,
  );
  const outlineRefs = [];
  let outlinePiece = await json(["snapshot", tab.id, "--outline", "--max-chars", "600"]);
  for (let round = 0; ; round++) {
    outlineRefs.push(...(outlinePiece.outline.match(/@e\d+/g) ?? []));
    assert.ok(round < 40, "the outline parts of one page must end");
    if (!outlinePiece.next) break;
    outlinePiece = await json([
      "snapshot",
      tab.id,
      "--outline",
      "--max-chars",
      "600",
      "--cursor",
      outlinePiece.next,
    ]);
  }
  const wholeOutline = await json([
    "snapshot",
    tab.id,
    "--outline",
    "--max-chars",
    "24000",
    "--max-controls",
    "100",
  ]);
  assert.equal(
    outlineRefs.length,
    new Set(outlineRefs).size,
    "no control line is printed twice",
  );
  assert.equal(
    outlineRefs.length,
    (wholeOutline.outline.match(/@e\d+/g) ?? []).length,
  );
  assert.match(
    (await cli(["snapshot", tab.id, "--cursor", "c1.not-a-cursor"], undefined, {
      failure: true,
    })).errors,
    /400 invalid_cursor/,
  );
  // The header names the page, the space and the space's tabs, including
  // one the person opened while they had control.
  await cli(["handoff", space.id]);
  const knownTabs = (
    await chrome.evaluate(() => window.kamapathy.getState())
  ).tabs.map((item) => item.id);
  const personPage = (
    await chrome.evaluate(
      (input) =>
        window.kamapathy.dispatch({
          type: "tab:create",
          spaceId: input.spaceId,
          url: input.url,
          background: true,
        }),
      { spaceId: space.id, url: `${fixture.origin}/` },
    )
  ).tabs.find((item) => !knownTabs.includes(item.id));
  await waitForState(
    chrome,
    (state, id) =>
      state.tabs.some((item) => item.id === id && !item.loading),
    personPage.id,
  );
  await cli(["resume", space.id]);
  const headed = await json(["snapshot", tab.id]);
  assert.deepEqual(
    [headed.header.page.id, headed.header.space.id, headed.header.space.name],
    [tab.id, space.id, "Skill form review"],
  );
  assert.equal(
    headed.header.tabs.find((item) => item.id === tab.id).current,
    true,
  );
  const personEntry = headed.header.tabs.find(
    (item) => item.id === personPage.id,
  );
  assert.deepEqual(
    [personEntry.openedBy, personEntry.managed, personEntry.title],
    ["person", false, "Kamapathy form lab"],
  );
  const headerLine = (await cli(["snapshot", tab.id])).output.split("\n")[0];
  assert.ok(
    headerLine.startsWith(`page ${headed.header.page.label} `),
    headerLine,
  );
  assert.ok(headerLine.includes(`space "Skill form review" ${space.id}`), headerLine);
  assert.ok(
    headerLine.includes(
      `${personEntry.label} "Kamapathy form lab" (person) (unmanaged)`,
    ),
    headerLine,
  );
  // Without a header the first line is the page title again.
  assert.ok(
    (await cli(["snapshot", tab.id, "--no-header"])).output.startsWith(
      `${headed.title}\n`,
    ),
  );
  await chrome.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:close", id }),
    personPage.id,
  );
  passed("snapshot scopes, outline, header and continuation");
  // Locators name one control each, and go on naming it after the page is
  // loaded again and in a later run.
  const locatorPage = `${fixture.origin}/snapshot/locators`;
  await json(["navigate", tab.id, locatorPage]);
  const located = await json(["snapshot", tab.id, "--locators", "--full"]);
  const locators = located.interactables
    .filter((item) => item.locator)
    .map((item) => item.locator);
  assert.deepEqual(locators.slice(0, 4), [
    'css=[data-testid="save-button"]',
    "css=#checkout-form",
    'role=button[name="Ship it"]',
    'role=button[name="Archive"]',
  ]);
  assert.ok(
    locators.includes('css=input[placeholder="First note"]') &&
      locators.includes("href=/one"),
    JSON.stringify(locators),
  );
  // Two links share an address, so no locator names either one alone.
  assert.equal(
    located.interactables.filter(
      (item) => item.label === "Shared" && item.locator,
    ).length,
    0,
  );
  assert.ok(
    (await cli(["snapshot", tab.id, "--locators", "--full"])).output.includes(
      ' locator: css=[data-testid="save-button"]',
    ),
  );
  await json(["navigate", tab.id, locatorPage]);
  for (const locator of locators) {
    await cli(["click", tab.id, locator]);
    // A link's locator takes the page with it.
    if (locator.startsWith("href=")) await json(["navigate", tab.id, locatorPage]);
  }
  const locatorScript = join(temporary, "locators.mjs");
  await writeFile(
    locatorScript,
    [
      `const page = (await (await space(${JSON.stringify(space.id)})).tabs()).find((item) => item.id === ${JSON.stringify(tab.id)});`,
      `for (const locator of ${JSON.stringify(locators)}) {`,
      `  await page.navigate(${JSON.stringify(locatorPage)});`,
      "  await page.click(locator);",
      "}",
      `console.log("clicked ${locators.length} locators");`,
      "",
    ].join("\n"),
  );
  assert.equal(
    (await cli(["run", locatorScript])).output,
    `clicked ${locators.length} locators\n`,
  );
  passed("locators from one snapshot work after a reload and in a later run");
  // The snapshot waits for every frame of the page to finish loading.
  await json(["navigate", tab.id, `${fixture.origin}/frames/outer`]);
  await observe(tab.id);
  const crossSite = await poll(
    async () =>
      (await probe("frames", tab.id)).find(
        (frame) => frame.crossOrigin && frame.sessionId,
      ),
    { timeoutMs: 10000, label: "the cross-site frame's own session" },
  );
  assert.equal(await probe("ready", tab.id, crossSite.frameId), "complete");
  passed(
    "the cross-site frame of /frames/outer has its own session and an isolated read succeeds",
  );
  await json(["navigate", tab.id, `${fixture.origin}/driver/slow`]);
  await cli(["wait", tab.id, "--stdin"], {
    text: "Slow image page",
    timeoutMs: 5000,
  });
  const idleAt = await probe("networkIdle", tab.id, 500, 10000);
  const served = await poll(
    () => fixture.events.find((event) => event.type === "slow-image-served"),
    { timeoutMs: 5000, label: "the slow image response" },
  );
  // 50 ms of slack covers timer granularity across the two processes.
  assert.ok(
    idleAt >= served.at + 500 - 50,
    `Network idle at ${idleAt} came less than 500 ms after the image finished at ${served.at}`,
  );
  passed("network idle settles only after the slow image");
  await json(["navigate", tab.id, `${fixture.origin}/driver/worker`]);
  await cli(["wait", tab.id, "--stdin"], {
    selector: "#worker-result",
    text: "worker-ready",
    timeoutMs: 3000,
  });
  passed("a blob worker runs in an agent tab");
  const { space: parallel } = await json(["space", "create", "Parallel review"]);
  const { tab: parallelTab } = await json([
    "open",
    parallel.id,
    `${fixture.origin}/lab`,
  ]);
  await observe(parallelTab.id);
  const missing = cli(
    ["wait", tab.id, "--stdin"],
    { text: "Never shown on this page", timeoutMs: 5000 },
    { failure: true },
  );
  // Lets the wait reach Kamapathy before the other space asks.
  await sleep(1000);
  const snapshotStarted = Date.now();
  await observe(parallelTab.id);
  const snapshotTime = Date.now() - snapshotStarted;
  // The run check near the end expects exactly two spaces.
  await cli(["space", "close", parallel.id]);
  assert.match((await missing).errors, /408 wait_timeout/);
  assert.ok(
    snapshotTime < 1500,
    `The snapshot in the other space took ${snapshotTime} ms`,
  );
  passed(
    "a 5 second wait in one space leaves a snapshot in another under 1.5 seconds",
  );
  await json(["navigate", tab.id, `${fixture.origin}/lab`]);
  await observe(tab.id);
  await Promise.all([
    cli(["wait", tab.id, "--stdin"], {
      selector: "#delayed-result",
      text: "Delayed content ready",
      timeoutMs: 5000,
    }),
    sleep(200).then(() => cli(["click", tab.id, "#delayed"])),
  ]);
  passed("a wait and a click in one space both succeed together");
  await json(["navigate", tab.id, `${fixture.origin}/benchmark`]);
  const reference = await observe(tab.id);
  assert.equal(reference.truncated, false);
  assert.match(reference.text, /Research note 18/);
  assert.ok(
    reference.interactables.some((control) => control.label === "Read note 18"),
  );
  // The header line carries the space's id, which is new every run, and
  // has its own check, so the benchmark compares the page itself.
  const referenceCapture = (
    await cli(["snapshot", tab.id, "--full", "--no-header"])
  ).output;
  await writeFile(join(artifacts, "kamapathy-reference.txt"), referenceCapture);
  passed(
    "full-content observation retains every reference page note and control",
  );
  assert.equal(
    normalizeCapture(referenceCapture),
    normalizeCapture(
      await readFile(
        resolve("tests/fixtures/benchmarks/kamapathy-reference.txt"),
        "utf8",
      ),
    ),
  );
  passed(
    "the full snapshot of /benchmark matches the reference with the port and refs normalized",
  );
  await json(["navigate", tab.id, `${fixture.origin}/edges`]);
  const edges = await observe(tab.id);
  for (const secret of ["Hidden", "Inert", "Transparent", "Skipped", "Mirror"])
    assert.ok(!JSON.stringify(edges).includes(`${secret} secret`));
  // aria-hidden hides content from assistive technology, not from the screen.
  // Component libraries put visible labels and questions there, so page text
  // includes what a person sees.
  assert.match(edges.text, /Aria secret/);
  // Current field values are shown on their controls, never as page text.
  for (const [label, value] of [
    ["Private draft", "Draft secret"],
    ["Rich editor", "Rich secret"],
    ["Plain editor", "Plain secret"],
  ]) {
    assert.equal(
      edges.interactables.find((control) => control.label === label).value,
      value,
    );
    assert.ok(!edges.text.includes(value));
  }
  assert.ok(
    !edges.interactables.some(
      (control) => control.label === "Invisible button",
    ),
  );
  assert.ok(!edges.text.includes("Disclosure revealed"));
  assert.match(edges.text, /Visible start\s+Visible end/);
  ref(edges, "Save caption");
  ref(edges, "Action caption");
  const choice = edges.interactables.find(
    (control) => control.label === "Option choice",
  );
  assert.ok(
    choice.options.some(
      (option) => option.value === "blocked" && option.disabled,
    ),
  );
  assert.ok(
    (await cli(["snapshot", tab.id, "--selector", "#choice"])).output.includes(
      '"last": "Last"',
    ),
  );
  passed(
    "snapshots exclude hidden content, show aria-hidden text and field values, retain line breaks and label input buttons",
  );
  const chip = edges.interactables.find(
    (control) => control.label === "Filter: Active",
  );
  assert.equal(chip.tag, "div");
  for (const label of ["Linked row", "Card action", "Wrapped menu"])
    ref(edges, label);
  assert.ok(!edges.interactables.some((control) => control.tag === "x-card"));
  await cli(["click", tab.id, chip.ref]);
  await cli(["wait", tab.id, "--stdin"], {
    selector: "#custom-result",
    text: "Chip chosen",
    timeoutMs: 2000,
  });
  passed(
    "clickable elements without control semantics are listed and clickable, and wrappers defer to the controls inside them",
  );
  await cli(["click", tab.id, ref(edges, "Open details")]);
  await cli(["wait", tab.id, "--stdin"], {
    text: "Disclosure revealed",
    timeoutMs: 1000,
  });
  passed("summary disclosures are discoverable and clickable through refs");
  // Material-style controls hide the native input at opacity 0 over a drawn box.
  await cli(["click", tab.id, ref(edges, "Material agreement", "input")]);
  await cli(["wait", tab.id, "--stdin"], {
    selector: "#material-result",
    text: "Material checked",
    timeoutMs: 2000,
  });
  passed("transparent native checkboxes styled by component libraries are listed and clickable");
  for (const label of ["Rich editor", "Plain editor"]) {
    await cli(
      ["fill", tab.id, ref(edges, label), "--stdin"],
      "Unicode café 🌱\nsecond line",
    );
    const echoed = await json([
      "snapshot",
      tab.id,
      "--selector",
      "#field-result",
    ]);
    assert.match(echoed.text, /Unicode café 🌱\s+second line/);
  }
  passed(
    "empty and plaintext-only contenteditable fields accept Unicode and multiline text",
  );
  for (const [label, value] of [
    ["Numeric input", "not a number"],
    ["Date input", "2026-02-30"],
    ["Range input", "42"],
    ["Color input", "#ffffff"],
    ["Option choice", "blocked"],
    ["Option choice", "duplicate"],
    ["Multiple choices", "a"],
    ["Becomes read only", "changed"],
    ["Replaced on focus", "changed"],
  ]) {
    await cli(["fill", tab.id, ref(edges, label), "--stdin"], value, {
      failure: true,
    });
    assert.ok(
      !(
        await json(["snapshot", tab.id, "--selector", "#field-result"])
      ).text.includes("=changed"),
    );
  }
  passed(
    "invalid values, unsupported fields, disabled option groups, duplicate options and focus mutations fail safely",
  );
  for (const [label, value, expected] of [
    ["Numeric input", "42", "numeric=42"],
    ["Date input", "2026-09-12", "date=2026-09-12"],
    ["Option choice", "last", "choice=last"],
  ]) {
    await cli(["fill", tab.id, ref(edges, label), "--stdin"], value);
    assert.equal(
      (await json(["snapshot", tab.id, "--selector", "#field-result"])).text,
      expected,
    );
  }
  passed("valid numeric, date and single select fills update the actual page");
  for (const [field, button, type] of [
    ["Popup message", "Submit popup", "application/x-www-form-urlencoded"],
    ["Multipart message", "Submit multipart", "multipart/form-data"],
  ]) {
    const message = `${field}: café 🌱 & = +`;
    const before = (await json(["tabs", space.id])).tabs.map((item) => item.id);
    await json(
      ["batch", tab.id],
      [fill(ref(edges, field), message), click(ref(edges, button))],
    );
    const popup = (await json(["tabs", space.id])).tabs.find(
      (item) => !before.includes(item.id),
    );
    assert.ok(popup, "Submission opens one new agent tab");
    assert.equal(popup.openedBy, "page");
    assert.match(popup.label, /^p\d+$/);
    await cli(["wait", popup.id, "--stdin"], {
      selector: "#popup-confirmation",
      timeoutMs: 5000,
    });
    assert.ok((await observe(popup.id)).text.includes(message));
    const receipt = fixture.events
      .filter((event) => event.type === "popup-submitted")
      .at(-1);
    assert.equal(receipt.method, "POST");
    assert.deepEqual(receipt.fields, { message });
    assert.ok(receipt.contentType.startsWith(type));
    assert.equal(receipt.referer, `${fixture.origin}/edges`);
    assert.equal(
      (await chrome.evaluate(() => window.kamapathy.getState())).activeTabId,
      original,
    );
    await cli(["close", popup.id]);
  }
  assert.equal(
    fixture.events.filter((event) => event.type === "popup-submitted").length,
    2,
  );
  passed(
    "new-tab forms preserve encoded and multipart POST bodies, referrers and background ownership exactly once",
  );
  await json(["navigate", tab.id, `${fixture.origin}/uploads`]);
  let uploads = await observe(tab.id);
  assert.ok(!uploads.interactables.some((item) => item.label === "Closed upload"));
  const bundleRef = ref(uploads, "App bundle");
  const artworkRef = ref(uploads, "Artwork files");
  assert.equal(uploads.interactables.find((item) => item.ref === artworkRef).hidden, true);
  const bundleBytes = Buffer.from(Array.from({ length: 131073 }, (_, index) => index % 256));
  const bundlePath = join(temporary, "release-café.aab");
  const artworkPaths = [join(temporary, "icon.png"), join(temporary, "screenshot.png")];
  const artworkBytes = Buffer.from([137, 80, 78, 71, 0, 255, 42]);
  await writeFile(bundlePath, bundleBytes);
  for (const path of artworkPaths) await writeFile(path, artworkBytes);
  await cli(["upload", tab.id, artworkRef, bundlePath], undefined, { failure: true });
  await cli(["upload", tab.id, ref(uploads, "Disabled upload"), bundlePath], undefined, { failure: true });
  await cli(["upload", tab.id, bundleRef, ...artworkPaths], undefined, { failure: true });
  passed("upload rejects disabled inputs, incompatible file types and multiple files in a single input");
  await cli(["click", tab.id, ref(uploads, "Replace bundle input")]);
  // No action moves a file-input ref to the input drawn in its place, so a
  // later upload cannot reach an input the agent never observed.
  for (const args of [
    ["click", tab.id, bundleRef],
    ["press", tab.id, "Tab", bundleRef],
    ["scroll", tab.id, "down", bundleRef],
    ["upload", tab.id, bundleRef, bundlePath],
  ])
    assert.match((await cli(args, undefined, { failure: true })).errors, /stale_ref/);
  uploads = await observe(tab.id);
  await cli(["upload", tab.id, ref(uploads, "App bundle"), bundlePath]);
  await cli(["upload", tab.id, ref(uploads, "Artwork files"), ...artworkPaths]);
  await cli(["wait", tab.id, "--stdin"], { selector: "#selected-status", text: "Selected 3 files", timeoutMs: 5000 });
  const selected = await observe(tab.id);
  assert.ok(!JSON.stringify(selected).includes("release-café.aab"));
  passed("skill selects binary and multiple files, resolves hidden upload inputs, rejects stale refs and omits selected filenames");
  await json(["batch", tab.id], [click(ref(selected, "Submit files")), wait("#upload-confirmation"), { type: "snapshot" }]);
  const fileReceipts = fixture.events.filter((event) => event.type === "files-submitted");
  assert.equal(fileReceipts.length, 1);
  assert.deepEqual(fileReceipts[0].files.map((file) => ({ field: file.field, name: file.name, type: file.type, bytes: file.bytes })), [
    { field: "bundle", name: "release-café.aab", type: "application/octet-stream", bytes: bundleBytes },
    { field: "artwork", name: "icon.png", type: "image/png", bytes: artworkBytes },
    { field: "artwork", name: "screenshot.png", type: "image/png", bytes: artworkBytes },
  ]);
  passed("multipart form submission delivers exact binary bytes, Unicode names and all files to one server receipt");
  // Play Console is built with Google's Angular components (ACX). These pages
  // reproduce their DOM: custom elements with ARIA roles, icon font glyphs,
  // labels inside aria-hidden, and popups in an overlay after the page.
  const control = (snapshot, label, role) => {
    const matches = snapshot.interactables.filter(
      (item) => item.label === label && (!role || item.role === role),
    );
    assert.equal(matches.length, 1, `Expected one control labeled ${label}`);
    return matches[0];
  };
  await json(["navigate", tab.id, `${fixture.origin}/components/acx-budget`]);
  const budget = await json(["snapshot", tab.id]);
  assert.equal(budget.interactables.length, 40);
  assert.ok(budget.omittedControls > 100);
  assert.equal(budget.truncated, true);
  for (const label of ["Section 1", "Setting 1", "Discard changes", "Save", "Send for review"])
    control(budget, label);
  assert.match(
    (await cli(["snapshot", tab.id])).output,
    /\n\d+ more controls not listed\. Scope with --selector to list them\.\n/,
  );
  await cli(["click", tab.id, control(budget, "Save").ref]);
  await cli(["wait", tab.id, "--stdin"], { selector: "#budget-result", text: "Saved", timeoutMs: 2000 });
  await cli(["click", tab.id, control(budget, "Send for review").ref]);
  const review = await observe(tab.id);
  assert.equal(review.interactables.length, 100);
  await cli(["click", tab.id, control(review, "Send changes for review").ref]);
  await cli(["wait", tab.id, "--stdin"], { selector: "#budget-result", text: "Sent for review", timeoutMs: 2000 });
  passed("snapshots over the control budget list open dialogs and sticky action bars before a long sidebar and count what they omit");
  // A tall pinned sidebar and table of contents come after the page controls
  // beside them, while a pinned header and banner stay first.
  await json(["navigate", tab.id, `${fixture.origin}/components/docs-layout`]);
  const pageControls = ["Search", "Toggle dark mode", "GitHub", "Wi-Fi", "Bluetooth", "Location", "Airplane mode", "View as Markdown", "Feedback", "Source", "Allow all", "Essential only"];
  assert.deepEqual(
    (await json(["snapshot", tab.id, "--max-controls", "12"])).interactables.map((item) => item.label),
    pageControls,
  );
  const docs = await json(["snapshot", tab.id]);
  assert.equal(docs.interactables.length, 40);
  for (const label of [...pageControls, "Component 1"]) control(docs, label);
  assert.equal(control(docs, "Wi-Fi", "switch").checked, true);
  await cli(["click", tab.id, control(docs, "Location", "switch").ref]);
  await cli(["wait", tab.id, "--stdin"], { selector: "#docs-result", text: "Location on", timeoutMs: 2000 });
  passed("tall pinned navigation and contents columns come after the page controls beside them in the control budget");
  await json(["navigate", tab.id, `${fixture.origin}/components/acx-dropdown`]);
  let dropdown = await observe(tab.id);
  const publishing = control(dropdown, "Managed publishing off", "listbox");
  assert.equal(publishing.expanded, false);
  assert.equal(control(dropdown, "2 countries", "button").expanded, false);
  assert.ok(!/arrow_drop_down|sync_disabled/.test(JSON.stringify(dropdown)));
  await cli(["click", tab.id, publishing.ref]);
  dropdown = await observe(tab.id);
  assert.equal(control(dropdown, "Managed publishing off", "listbox").expanded, true);
  assert.equal(control(dropdown, "Managed publishing off", "option").selected, true);
  const managed = control(dropdown, "Managed publishing on", "option");
  assert.equal(managed.selected, false);
  await cli(["click", tab.id, managed.ref]);
  await cli(["wait", tab.id, "--stdin"], { selector: "#dropdown-result", text: "publishing=Managed publishing on", timeoutMs: 2000 });
  await cli(["click", tab.id, control(dropdown, "2 countries").ref]);
  dropdown = await observe(tab.id);
  const germany = control(dropdown, "Germany", "option");
  assert.deepEqual([germany.selected, germany.checked], [true, true]);
  // With a tight budget, the open popup's trigger stays listed beside its options.
  const tight = (await json(["snapshot", tab.id, "--max-controls", "3"])).interactables;
  assert.ok(tight.some((item) => item.label === "2 countries" && item.expanded === true));
  assert.ok(tight.some((item) => item.role === "option"));
  assert.equal(control(dropdown, "Italy (unavailable)", "option").disabled, true);
  // The checkbox an option draws is part of that option.
  assert.ok(!dropdown.interactables.some((item) => item.role === "checkbox"));
  await cli(["click", tab.id, germany.ref]);
  await cli(["wait", tab.id, "--stdin"], { selector: "#dropdown-result", text: "countries=France", timeoutMs: 2000 });
  dropdown = await observe(tab.id);
  assert.deepEqual(
    [control(dropdown, "Germany", "option").selected, control(dropdown, "Germany", "option").checked],
    [false, false],
  );
  passed("custom dropdown triggers and their options are listed with selection state and without icon names, and choosing options works");
  await json(["navigate", tab.id, `${fixture.origin}/components/acx-questionnaire`]);
  let questions = await observe(tab.id);
  const radios = questions.interactables.filter((item) => item.role === "radio");
  assert.equal(radios.length, 18);
  assert.ok(radios.every((item) => ["Yes", "No"].includes(item.label)));
  const choices = (snapshot, group) =>
    snapshot.interactables
      .filter((item) => item.group === group)
      .map((item) => [item.label, item.checked]);
  assert.deepEqual(choices(questions, "Does the app contain violence?"), [["Yes", false], ["No", true]]);
  assert.deepEqual(choices(questions, "Can users interact with each other?"), [["Yes", false], ["No", false]]);
  assert.equal(control(questions, "Select all countries", "checkbox").checked, "mixed");
  assert.equal(control(questions, "Pre-registration", "button").pressed, true);
  assert.equal(control(questions, "Data safety", "button").expanded, false);
  assert.equal(control(questions, "Main store listing", "tab").selected, true);
  assert.equal(control(questions, "Custom store listings", "tab").selected, false);
  assert.match(questions.text, /Data safety\s+Tell us how your app collects user data\s+Not started/);
  await cli(["wait", tab.id, "--stdin"], { selector: "#panel-desc", text: "Not started", timeoutMs: 0 });
  assert.ok(!/radio_button|check_box|expand_more/.test(JSON.stringify(questions)));
  const blood = questions.interactables.find(
    (item) => item.group === "Does the app contain blood?" && item.label === "Yes",
  );
  await cli(["click", tab.id, blood.ref]);
  await cli(["wait", tab.id, "--stdin"], { selector: "#answers", text: "2 answered", timeoutMs: 2000 });
  questions = await observe(tab.id);
  assert.deepEqual(choices(questions, "Does the app contain blood?"), [["Yes", true], ["No", false]]);
  assert.ok(
    (await cli(["snapshot", tab.id])).output.includes(
      `${blood.ref} radio "Yes" [checked] group "Does the app contain blood?"`,
    ),
  );
  passed("component radio buttons show their question and state, and toggles, panels, tabs and aria-hidden text are visible");
  await json(["navigate", tab.id, `${fixture.origin}/components/acx-fields`]);
  let fields = await observe(tab.id);
  for (const [label, value] of [
    ["App name", "ClickTrack"],
    ["Short description", "Count taps quickly"],
    ["Support email", "help@example.test"],
    ["Full description", "Tap anywhere to count."],
    ["Release notes", "Bug fixes"],
    ["App category", "Productivity"],
  ])
    assert.equal(control(fields, label).value, value);
  assert.equal(control(fields, "Search apps").value, undefined);
  assert.deepEqual(
    control(fields, "Tags").options.filter((option) => option.selected).map((option) => option.value),
    ["Timer", "Clicker"],
  );
  assert.equal(control(fields, "Contains ads").checked, true);
  assert.equal(control(fields, "Some countries").checked, "mixed");
  assert.equal(control(fields, "App").group, "Is your app a game?");
  assert.deepEqual(
    ["Yes", "No"].map((label) => [control(fields, label).group, control(fields, label).checked]),
    [["Does your app target children?", false], ["Does your app target children?", true]],
  );
  assert.equal(control(fields, "Notify me", "switch").checked, false);
  assert.equal(control(fields, "Advanced", "summary").expanded, true);
  control(fields, "Upload", "button");
  control(fields, "more_vert", "button");
  assert.match(fields.text, /App name/);
  assert.match(fields.text, /Support email/);
  const fieldsOutput = (await cli(["snapshot", tab.id, "--full"])).output;
  for (const label of ["Password", "Current password (text field)", "New password", "Code", "Card number", "Security code"]) {
    assert.equal(control(fields, label).valueHidden, true);
    assert.ok(fieldsOutput.includes(`"${label}" (value hidden)`));
  }
  for (const secret of ["pw-secret", "cur-secret", "new-secret", "otp-secret", "card-secret", "csc-secret", "shown-secret", "pin-secret"]) {
    assert.ok(!JSON.stringify(fields).includes(secret));
    assert.ok(!fieldsOutput.includes(secret));
  }
  assert.equal(control(fields, "Transfer code").valueHidden, true);
  assert.equal(control(fields, "Tester notes", "textbox").value, "custom-note-value");
  // A "show password" toggle turns the field into plain text; it stays hidden.
  await cli(["click", tab.id, control(fields, "Show password", "button").ref]);
  fields = await observe(tab.id);
  assert.equal(control(fields, "Account password").type, "text");
  assert.equal(control(fields, "Account password").valueHidden, true);
  assert.ok(!JSON.stringify(fields).includes("shown-secret"));
  assert.ok(fieldsOutput.includes('"Productivity": "Productivity" [selected]'));
  await cli(["fill", tab.id, control(fields, "Short description").ref, "--stdin"], "Counts every tap");
  fields = await observe(tab.id);
  assert.equal(control(fields, "Short description").value, "Counts every tap");
  passed("fields show labels drawn beside them, their current values and states, and never passwords, codes or card numbers");
  await json(["navigate", tab.id, `${fixture.origin}/components/mui-select`]);
  let menu = await observe(tab.id);
  const age = control(menu, "Age", "combobox");
  assert.deepEqual([age.value, age.expanded], ["Twenty", false]);
  await cli(["click", tab.id, age.ref]);
  menu = await observe(tab.id);
  // The open menu hides the rest of the page with aria-hidden: a person still
  // sees it, but only the menu takes clicks.
  assert.match(menu.text, /Checkout/);
  assert.deepEqual(menu.interactables.map((item) => item.label), ["Ten", "Twenty", "Thirty"]);
  await cli(["click", tab.id, control(menu, "Thirty", "option").ref]);
  await cli(["wait", tab.id, "--stdin"], { selector: "#mui-result", text: "Age 30", timeoutMs: 2000 });
  passed("an open menu lists only its options while the page it hides stays in the text");
  const pageText = async (selector) =>
    (await json(["snapshot", tab.id, "--selector", selector])).text;
  const waitFor = (selector, text) =>
    cli(["wait", tab.id, "--stdin"], { selector, text, timeoutMs: 2000 });
  await json(["navigate", tab.id, `${fixture.origin}/components/mat-select`]);
  let food = await observe(tab.id);
  const favorite = control(food, "Favorite food", "combobox");
  assert.deepEqual([favorite.value, favorite.expanded], ["Tacos", false]);
  await cli(["click", tab.id, favorite.ref]);
  // Angular Material opens the options inside the select. They are listed,
  // and their text is not the select's value.
  food = await observe(tab.id);
  assert.deepEqual(
    [control(food, "Favorite food", "combobox").value, control(food, "Favorite food", "combobox").expanded],
    ["Tacos", true],
  );
  assert.equal(control(food, "Tacos", "option").selected, true);
  assert.ok(
    (await cli(["snapshot", tab.id])).output.includes(
      `${favorite.ref} combobox "Favorite food" [expanded] value="Tacos"\n`,
    ),
  );
  await cli(["click", tab.id, control(food, "Steak", "option").ref]);
  await waitFor("#food-result", "Chose Steak");
  food = await observe(tab.id);
  assert.deepEqual(
    [control(food, "Favorite food", "combobox").value, control(food, "Favorite food", "combobox").expanded],
    ["Steak", false],
  );
  passed("a select that opens its options inside itself shows only its choice as its value");
  await json(["navigate", tab.id, `${fixture.origin}/components/acx-tree`]);
  let tree = await observe(tab.id);
  const treeItems = (snapshot) =>
    snapshot.interactables.filter((item) => item.role === "treeitem").map((item) => item.label);
  // Each tree row is a button around its tree item, listed once through the
  // item. The expand button inside the item and a tab's close button stay.
  assert.deepEqual(treeItems(tree), ["Europe", "Asia"]);
  assert.ok(
    !tree.interactables.some(
      (item) => item.role === "checkbox" || (item.role === "button" && /Europe|Asia/.test(item.label)),
    ),
  );
  const [expandEurope] = tree.interactables.filter((item) => item.role === "button" && item.label === "expand_more");
  await cli(["click", tab.id, expandEurope.ref]);
  await waitFor("#tree-result", "Expanded Europe");
  tree = await observe(tab.id);
  assert.deepEqual(treeItems(tree), ["Europe", "France", "Germany", "Asia"]);
  assert.equal(control(tree, "France", "treeitem").selected, true);
  assert.ok(!tree.interactables.some((item) => item.role === "button" && /Europe|France/.test(item.label)));
  await cli(["click", tab.id, control(tree, "Germany", "treeitem").ref]);
  await waitFor("#tree-result", "Selected France, Germany");
  await cli(["click", tab.id, control(tree, "Close Custom store listing", "button").ref]);
  await waitFor("#tree-result", "Closed Custom store listing");
  passed("tree rows drawn as buttons are listed through their tree items, and buttons inside tree items and tabs stay listed");
  await json(["navigate", tab.id, `${fixture.origin}/actions/drag`]);
  let dragging = await observe(tab.id);
  // The ACX reorder list drags with HTML5 events and reorders on dragend.
  const reordered = await json([
    "drag",
    tab.id,
    control(dragging, "Screenshot 1", "listitem").ref,
    control(dragging, "Screenshot 3", "listitem").ref,
  ]);
  assert.equal(reordered.drag, "html5");
  await waitFor("#drag-result", "Order: Screenshot 2, Screenshot 3, Screenshot 1, Screenshot 4");
  dragging = await observe(tab.id);
  // A drop zone receives the data the dragged item set.
  assert.equal(
    (
      await cli(
        ["batch", tab.id],
        [
          {
            type: "drag",
            source: { ref: control(dragging, "Screenshot 2", "listitem").ref },
            target: { selector: "#featured" },
          },
          wait("#featured", "Featured Screenshot 2"),
        ],
      )
    ).output,
    "1. drag ok: dragged with HTML drag and drop\n2. wait ok\n",
  );
  // Angular CDK drag-drop follows the pressed mouse.
  const sorted = await json([
    "drag",
    tab.id,
    control(dragging, "Production", "div").ref,
    control(dragging, "Internal testing", "div").ref,
  ]);
  assert.equal(sorted.drag, "mouse");
  await waitFor("#drag-result", "Tracks: Production, Internal testing, Closed testing, Open testing");
  // Neither kind of drag leaves the mouse held.
  await cli(["click", tab.id, control(dragging, "Confirm order").ref]);
  await waitFor("#drag-result", "Confirmed Screenshot 2, Screenshot 3, Screenshot 1, Screenshot 4");
  assert.match(
    (await cli(["drag", tab.id, "#featured", "#featured"], undefined, { failure: true })).errors,
    /invalid_target/,
  );
  passed("drag reorders HTML5 lists, drops onto zones and moves mouse-driven sortable lists, and the page takes clicks afterwards");
  await json(["navigate", tab.id, `${fixture.origin}/actions/zero-size`]);
  const zeroSize = await observe(tab.id);
  const internalTrack = control(zeroSize, "Internal testing", "radio");
  assert.equal(
    (await cli(["click", tab.id, internalTrack.ref])).output,
    "ok: clicked in the page because the control has no size\n",
  );
  await waitFor("#zero-result", "Chose Internal testing");
  assert.equal(control(await observe(tab.id), "Internal testing", "radio").checked, true);
  const openTrack = await json(["click", tab.id, control(zeroSize, "Open testing", "input").ref]);
  assert.equal(openTrack.fallback, "dom_click");
  await waitFor("#zero-result", "Chose Open testing");
  // A covered or off-screen control is never clicked in the page.
  assert.match(
    (await cli(["click", tab.id, control(zeroSize, "Production", "radio").ref], undefined, { failure: true })).errors,
    /element_obscured/,
  );
  assert.match(
    (await cli(["click", tab.id, control(zeroSize, "Archived track", "radio").ref], undefined, { failure: true })).errors,
    /outside the viewport/,
  );
  assert.equal(await pageText("#zero-result"), "Chose Open testing");
  passed("controls drawn with no size are clicked in the page and say so, but never when covered or off screen");
  await json(["navigate", tab.id, `${fixture.origin}/actions/inner-scroll`]);
  const panels = await json(["snapshot", tab.id]);
  // The page never scrolls, so scrolling moves the panel in the middle.
  const content = await json(["scroll", tab.id, "down", "2000"]);
  assert.deepEqual(
    [content.scrolled, content.selector, content.moved],
    ["element", "#content", true],
  );
  await waitFor("#scroll-result", "Loaded older releases");
  assert.equal(
    (await cli(["scroll", tab.id, "right", "300", "#country-row"])).output,
    "ok: scrolled panel #countries to 300,0\n",
  );
  const languages = await json(["scroll", tab.id, "down", control(panels, "Language 1", "option").ref]);
  assert.deepEqual([languages.scrolled, languages.selector, languages.moved], ["element", "#languages", true]);
  // With nothing left to scroll, the result says nothing moved.
  const stuck = await json(["scroll", tab.id, "up", "100", control(panels, "Page 1", "a").ref]);
  assert.deepEqual([stuck.scrolled, stuck.moved], ["page", false]);
  // A class selector names the panel to scroll.
  assert.equal(
    (await cli(["scroll", tab.id, "up", ".popup"])).output,
    "ok: scrolled panel #languages to 0,0\n",
  );
  // The page behind a modal that locks scrolling stays where a person left
  // it, even when the modal's panel has nothing left to scroll.
  await json(["navigate", tab.id, `${fixture.origin}/actions/scroll-lock`]);
  assert.equal(
    (await cli(["scroll", tab.id, "down", ".MuiDialogContent-root"])).output,
    "ok: scrolled panel #terms to 0,600\n",
  );
  await cli(["scroll", tab.id, "down", "2000", "#terms"]);
  for (const args of [["down", "600", "#terms"], ["down"]]) {
    const locked = await json(["scroll", tab.id, ...args]);
    assert.deepEqual([locked.scrolled, locked.y, locked.moved], ["page", 0, false]);
  }
  passed("scroll moves the panel holding a control, or the panel in the middle when the page cannot scroll, reports what moved, and never moves a locked page");
  await json(["navigate", tab.id, `${fixture.origin}/actions/rerender`]);
  let redrawn = await observe(tab.id);
  const save = control(redrawn, "Save", "button");
  assert.equal(save.disabled, true);
  const [internalRemove, closedRemove] = redrawn.interactables.filter(
    (item) => item.label === "Remove",
  );
  const apply = control(redrawn, "Apply", "button");
  // Typing enables Save by drawing the bar again, as Play Console does.
  assert.ok(
    (
      await cli(
        ["batch", tab.id],
        [
          fill(control(redrawn, "App title").ref, "ClickTrack Pro"),
          click(save.ref),
          wait("#rerender-result", "Saved ClickTrack Pro"),
        ],
      )
    ).output.includes(`\n2. click ok: ${save.ref} now points to the redrawn control\n`),
  );
  redrawn = await observe(tab.id);
  assert.deepEqual(
    [control(redrawn, "Save", "button").ref, control(redrawn, "Save", "button").disabled],
    [save.ref, false],
  );
  // Imported rows move the old ones. One row's name now appears twice.
  await cli(["click", tab.id, control(redrawn, "Import tester lists").ref]);
  assert.match(
    (await cli(["click", tab.id, internalRemove.ref], undefined, { failure: true })).errors,
    /stale_ref/,
  );
  assert.deepEqual((await json(["click", tab.id, closedRemove.ref])).rebound, [closedRemove.ref]);
  await waitFor("#rerender-result", "Removed Closed testers");
  // Two rows looked the same when they were listed, so the ref of a removed
  // one stays stale instead of moving to the other and removing it too.
  const twins = (await observe(tab.id)).interactables.filter((item) => item.label === "Remove");
  assert.equal(twins.length, 3);
  await cli(["click", tab.id, twins[2].ref]);
  await waitFor("#rerender-result", "Removed Internal testers, 2 left");
  assert.match(
    (await cli(["click", tab.id, twins[2].ref], undefined, { failure: true })).errors,
    /stale_ref/,
  );
  assert.equal(await pageText("#rerender-result"), "Removed Internal testers, 2 left");
  // Past 2,000 other elements, a second Apply button still counts as a match.
  await cli(["click", tab.id, control(redrawn, "Show all settings").ref]);
  assert.match(
    (await cli(["click", tab.id, apply.ref], undefined, { failure: true })).errors,
    /stale_ref/,
  );
  assert.equal(await pageText("#rerender-result"), "Removed Internal testers, 2 left");
  // A new URL ends re-binding, even without loading a new document.
  await cli(["click", tab.id, control(redrawn, "Next step").ref]);
  await waitFor("#rerender-result", "Step 2");
  assert.match(
    (await cli(["click", tab.id, save.ref], undefined, { failure: true })).errors,
    /stale_ref/,
  );
  passed("a ref follows its control when the page draws it again, and stays stale when the control had a lookalike, the match is ambiguous or the URL changed");
  if (process.env.KAMAPATHY_TEST_PUBLIC === "1") {
    for (const [url, expected] of [
      ["https://example.com", /Example Domain/],
      ["https://developer.mozilla.org/en-US/", /MDN|Mozilla/],
      ["https://www.wikipedia.org", /Wikipedia/],
    ]) {
      await json(["navigate", tab.id, url]);
      const snapshot = await observe(tab.id);
      assert.match(snapshot.title + snapshot.text, expected);
      passed(
        `public website reads through the skill: ${new URL(url).hostname}`,
      );
    }
  }
  // A whole task in one script: the runner connects over the same socket,
  // sets the globals, and reaches the fixture only through the API.
  const scriptPath = join(temporary, "scripted-form.mjs");
  await writeFile(
    scriptPath,
    [
      'const review = await createSpace("Scripted form review");',
      `const page = await review.open(${JSON.stringify(`${fixture.origin}/forms/new`)});`,
      'const before = await page.snapshot({ mode: "full" });',
      "const ref = (label) => before.interactables.find((control) => control.label === label).ref;",
      "const created = await page.batch([",
      '  { type: "fill", ref: ref("Form title"), value: "Scripted feedback" },',
      '  { type: "fill", ref: ref("Template"), value: "research" },',
      '  { type: "click", ref: ref("Create form") },',
      '  { type: "wait", selector: "#form-created", text: "Form created", timeoutMs: 5000 },',
      "]);",
      "await review.handoff();",
      "await review.resume();",
      "console.log(JSON.stringify({ space: review.id, tab: page.id, owner: review.owner, steps: created.results.length, text: await page.text() }));",
      "",
    ].join("\n"),
  );
  const scripted = JSON.parse((await cli(["run", scriptPath])).output);
  assert.equal(scripted.steps, 4);
  assert.equal(scripted.owner, "agent");
  assert.equal(fixture.forms.size, 2);
  assert.match(scripted.text, /Form created/);
  assert.equal(`${scripted.text}\n`, (await cli(["snapshot", scripted.tab])).output);
  assert.equal((await json(["spaces"])).spaces.length, 2);
  const listed = await cli(
    ["run", "-"],
    'console.log((await spaces()).map((space) => space.name).sort().join(", "))',
  );
  assert.equal(listed.output, "Scripted form review, Skill form review\n");
  const refused = await cli(["run", "-e", `await (await space(${JSON.stringify(scripted.space)})).open("not a url")`], undefined, { failure: true });
  assert.match(refused.errors, /^error: invalid_url: /);
  await cli(["run", "-e", `await (await space(${JSON.stringify(scripted.space)})).close()`]);
  passed("run executes a whole task script over the socket, text() matches the CLI snapshot, and errors carry their code");
  // Section 2 in the real app: real popups, finish, Stop, grants and requests.
  const tabsOf = (spaceId) => json(["tabs", spaceId]);
  const popupSpace = (await json(["space", "create", "Popup review"])).space;
  const opener = (await json(["open", popupSpace.id, `${fixture.origin}/popups/opener`])).tab;
  const press = async (button) =>
    json(["click", opener.id, ref(await observe(opener.id), button)]);
  await press("Sign in with popup");
  const signIn = await poll(
    async () => (await tabsOf(popupSpace.id)).tabs.find((item) => item.url.endsWith("/popups/oauth")),
    { timeoutMs: 10000, label: "the sign-in popup" },
  );
  assert.equal(signIn.openedBy, "page");
  assert.equal(signIn.openerId, opener.id);
  assert.match(signIn.label, /^p\d+$/);
  await cli(["wait", opener.id, "--stdin"], { text: "Token: token-123", timeoutMs: 10000 });
  await poll(
    async () =>
      (await tabsOf(popupSpace.id)).closed.find(
        (item) => item.label === signIn.label && item.closedBy === "page",
      ),
    { timeoutMs: 10000, label: "the sign-in popup closing itself" },
  );
  passed("an OAuth-style popup posts to its opener and closes itself");
  const beforeBlank = (await tabsOf(popupSpace.id)).tabs.map((item) => item.id);
  await press("Open blank popup");
  const landing = await poll(
    async () => (await tabsOf(popupSpace.id)).tabs.find((item) => item.url.endsWith("/popups/landing")),
    { timeoutMs: 10000, label: "the blank popup's landing page" },
  );
  const afterBlank = (await tabsOf(popupSpace.id)).tabs.filter((item) => !beforeBlank.includes(item.id));
  assert.deepEqual(afterBlank.map((item) => item.id), [landing.id]);
  assert.equal(landing.label, `p${Number(signIn.label.slice(1)) + 1}`);
  assert.equal(landing.openerId, opener.id);
  passed("an about:blank popup written by its opener and navigated keeps its label");
  await press("Open blob popup");
  await poll(
    async () =>
      (await tabsOf(popupSpace.id)).tabs.find(
        (item) => item.url.startsWith("blob:") && item.title === "Blob popup",
      ),
    { timeoutMs: 10000, label: "the blob popup's document" },
  );
  const beforeData = (await tabsOf(popupSpace.id)).tabs.length;
  await press("Open data popup");
  await cli(["wait", opener.id, "--stdin"], { text: "Data popup refused", timeoutMs: 5000 });
  assert.equal((await tabsOf(popupSpace.id)).tabs.length, beforeData);
  passed("blob: popups open and data: popups are refused");
  for (const [button, type, body] of [
    ["Echo urlencoded", "application/x-www-form-urlencoded", "message=Hello+popup"],
    ["Echo multipart", "multipart/form-data", 'name="message"\r\n\r\nHello popup\r\n'],
    ["Echo text", "text/plain", "message=Hello popup\r\n"],
  ]) {
    const before = fixture.events.filter((event) => event.type === "popup-echo").length;
    await press(button);
    const echo = await poll(
      () => fixture.events.filter((event) => event.type === "popup-echo")[before],
      { timeoutMs: 10000, label: `the ${type} echo` },
    );
    assert.ok(echo.contentType.startsWith(type), echo.contentType);
    assert.ok(echo.body.includes(body), `${type} body: ${JSON.stringify(echo.body)}`);
    assert.equal(echo.origin, fixture.origin);
  }
  await cli(["space", "close", popupSpace.id]);
  passed("target=_blank forms keep urlencoded, multipart and text/plain bodies");
  // Section 16 in the real app: PDFs read by page, a form's PDF never sent
  // again, a blob PDF read from the page, and Chromium's viewer out of reach.
  const pdfSpace = (await json(["space", "create", "PDF review"])).space;
  const pageTwo = REPORT_PAGES[1].join("\n");
  const linking = (await json(["open", pdfSpace.id, `${fixture.origin}/pdf/links`])).tab;
  await json(["click", linking.id, ref(await observe(linking.id), "Open the report")]);
  const report = await poll(
    async () =>
      (await tabsOf(pdfSpace.id)).tabs.find((item) => item.url.endsWith("/pdf/report.pdf")),
    { timeoutMs: 15000, label: "the PDF popup" },
  );
  assert.equal(report.openedBy, "page");
  const reportText = (await cli(["pdf-text", `${pdfSpace.id}:${report.label}`])).output;
  assert.match(reportText, /^Quarterly report, 3 pages, http/);
  assert.ok(reportText.includes(pageTwo), reportText);
  const paged = (await cli([
    "pdf-text",
    `${pdfSpace.id}:${report.label}`,
    "--from",
    "2",
    "--max-chars",
    String(pageTwo.length),
  ])).output;
  assert.match(paged, /\[page 2\]/);
  assert.match(paged, /More pages: rerun with --from 3\./);
  const scriptedPdf = await cli([
    "run",
    "-e",
    `const page = (await (await space(${JSON.stringify(pdfSpace.id)})).tabs()).find((item) => item.id === ${JSON.stringify(report.id)}); const text = await page.pdfText(); console.log(text.pageCount + " " + text.pages.length);`,
  ]);
  assert.equal(scriptedPdf.output, "3 3\n");
  passed("a target=_blank link to a PDF opens a popup the agent reads by page with pdf-text and page.pdfText");
  const posting = (await json(["open", pdfSpace.id, `${fixture.origin}/pdf/form`])).tab;
  await json(["click", posting.id, ref(await observe(posting.id), "Post for the report")]);
  await poll(
    async () =>
      (await tabsOf(pdfSpace.id)).tabs.find(
        (item) => item.id === posting.id && item.url.endsWith("/pdf/posted.pdf"),
      ),
    { timeoutMs: 15000, label: "the posted PDF" },
  );
  const refusedPdf = await cli(["pdf-text", posting.id], undefined, { failure: true });
  assert.match(
    refusedPdf.errors,
    /409 pdf_not_refetchable: This PDF came from a form submission/,
  );
  const reasonPdf = await cli([
    "run",
    "-e",
    `const page = (await (await space(${JSON.stringify(pdfSpace.id)})).tabs()).find((item) => item.id === ${JSON.stringify(posting.id)}); try { await page.pdfText(); console.log("read"); } catch (error) { console.log(error.status + " " + error.code + " " + error.reason); }`,
  ]);
  assert.equal(reasonPdf.output, "409 pdf_not_refetchable post\n");
  assert.deepEqual(
    fixture.requests.filter((item) => item.path === "/pdf/posted.pdf").map((item) => item.method),
    ["POST"],
  );
  passed("a PDF that came back from a form post is refused and never asked for again");
  const building = (await json(["open", pdfSpace.id, `${fixture.origin}/pdf/blob`])).tab;
  await json(["click", building.id, ref(await observe(building.id), "Open the blob report")]);
  const blob = await poll(
    async () => (await tabsOf(pdfSpace.id)).tabs.find((item) => item.url.startsWith("blob:")),
    { timeoutMs: 15000, label: "the blob PDF popup" },
  );
  const blobText = await json(["pdf-text", `${pdfSpace.id}:${blob.label}`]);
  assert.equal(blobText.pageCount, 3);
  assert.equal(blobText.pages[1].text, pageTwo);
  passed("a PDF built as a blob and opened in a popup is read from the page itself");
  const viewed = await observe(report.id);
  assert.deepEqual(viewed.interactables, []);
  assert.doesNotMatch(viewed.text, /Download|Print|Rotate/i);
  // Chromium draws the PDF in its own viewer, which it hangs under the frame
  // showing the document. The one frame an agent reaches is that document;
  // today Chromium reports no frame of the viewer at all, and wherever it
  // reports one it stays blocked.
  const pdfFrames = await probe("frames", report.id);
  assert.deepEqual(
    pdfFrames.filter((frame) => !frame.blocked).map((frame) => frame.url),
    [report.url],
    JSON.stringify(pdfFrames),
  );
  assert.deepEqual(
    pdfFrames.filter(
      (frame) => frame.url.includes("mhjfbmdgcfjbbpaeojofohoefgiehjai") && !frame.blocked,
    ),
    [],
  );
  await cli(["space", "close", pdfSpace.id]);
  passed("a PDF snapshot lists no viewer controls and the viewer's own frames stay blocked");
  const finishing = (await json(["space", "create", "Finish review"])).space;
  await json(["open", finishing.id, `${fixture.origin}/lab`]);
  await chrome.evaluate(
    ({ spaceId, url }) => window.kamapathy.dispatch({ type: "tab:create", spaceId, url, background: true }),
    { spaceId: finishing.id, url: `${fixture.origin}/` },
  );
  const finished = await json(["space", "finish", finishing.id, "--keep", "p2"]);
  assert.deepEqual(
    [finished.closedSpace, finished.closed, finished.kept, finished.protected],
    [false, ["p1"], ["p2"], ["p3"]],
  );
  assert.ok(!(await json(["spaces"])).spaces.some((item) => item.id === finishing.id));
  assert.match(
    (await cli(["tabs", finishing.id], undefined, { failure: true })).errors,
    /409 space_ended: The agent finished this space/,
  );
  passed("finish keeps p2 and a person tab and leaves the space");
  const ownSpace = (await chrome.evaluate(() => window.kamapathy.getState())).spaces.find(
    (item) => item.kind === "personal",
  );
  await chrome.evaluate((id) => window.kamapathy.dispatch({ type: "space:activate", id }), ownSpace.id);
  const shown = (await chrome.evaluate(() => window.kamapathy.getState())).activeTabId;
  await chrome.evaluate(
    ({ id, url }) => window.kamapathy.dispatch({ type: "tab:navigate", id, url }),
    { id: shown, url: `${fixture.origin}/lab` },
  );
  const asking = cli(["space", "request", "--reason", "Check the lab page", "--name", ownSpace.name, "--json"]);
  const requested = await poll(
    async () => (await chrome.evaluate(() => window.kamapathy.getState())).spaceRequests[0],
    { timeoutMs: 10000, label: "the space request" },
  );
  assert.equal(requested.reason, "Check the lab page");
  await chrome.evaluate(
    ({ id, spaceId }) => window.kamapathy.dispatch({ type: "space-request:answer", id, allow: true, spaceId }),
    { id: requested.id, spaceId: ownSpace.id },
  );
  const granted = JSON.parse((await asking).output);
  assert.equal(granted.space.id, ownSpace.id);
  assert.equal(granted.active.id, shown);
  assert.equal(granted.active.managed, false);
  assert.equal(await probe("attaches", shown), 0);
  await json(["adopt", `${ownSpace.id}:${granted.active.label}`]);
  assert.match((await observe(shown)).title, /Interaction lab/);
  assert.ok((await probe("attaches", shown)) >= 1);
  await chrome.evaluate((id) => window.kamapathy.dispatch({ type: "space:stop", id }), ownSpace.id);
  await poll(async () => !(await probe("hasSession", shown)), { timeoutMs: 5000, label: "the stopped tab's session ending" });
  passed("an approved request lets the agent adopt the person's active tab");
  const first = (await json(["space", "create", "Stopped review"])).space;
  const second = (await json(["space", "create", "Working review"])).space;
  const firstTab = (await json(["open", first.id, `${fixture.origin}/lab`])).tab;
  const secondTab = (await json(["open", second.id, `${fixture.origin}/lab`])).tab;
  await chrome.evaluate((id) => window.kamapathy.dispatch({ type: "space:stop", id }), first.id);
  assert.match(
    (await cli(["snapshot", firstTab.id], undefined, { failure: true })).errors,
    /409 space_ended: The person stopped the agent in this space/,
  );
  await observe(secondTab.id);
  await cli(["space", "close", second.id]);
  passed("Stop in one space leaves another working");
  // Runs: a takeover stops the run for good; TypeScript; the deadline.
  const runSpace = (await json(["space", "create", "Run review"])).space;
  const runTab = (await json(["open", runSpace.id, `${fixture.origin}/lab`])).tab;
  const ready = join(temporary, "run-ready");
  const go = join(temporary, "run-go");
  const takeoverScript = join(temporary, "takeover.mjs");
  await writeFile(
    takeoverScript,
    [
      'import { existsSync, writeFileSync } from "node:fs";',
      `const page = (await (await space(${JSON.stringify(runSpace.id)})).tabs()).find((item) => item.id === ${JSON.stringify(runTab.id)});`,
      'console.log("before the takeover");',
      `writeFileSync(${JSON.stringify(ready)}, "");`,
      `while (!existsSync(${JSON.stringify(go)})) await new Promise((done) => setTimeout(done, 50));`,
      'await page.click("#bottom-button").catch(() => {});',
      'console.log("after the takeover");',
      "",
    ].join("\n"),
  );
  const takenOver = cli(["run", takeoverScript], undefined, { failure: true });
  await poll(async () => (await readFile(ready).then(() => true, () => false)), { timeoutMs: 20000, label: "the run reaching its wait" });
  await chrome.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:ownership", id, owner: "human" }),
    runSpace.id,
  );
  await writeFile(go, "");
  const stoppedRun = await takenOver;
  assert.deepEqual([stoppedRun.code, stoppedRun.output, stoppedRun.errors], [
    3,
    "",
    "Kamapathy stopped this run: the person has control of the space.\nThe person took over this space. Stop, and resume only when they ask you to.\nOutput from this run was withheld. Stop here, do not retry or work around it, and continue only when the person asks.\n",
  ]);
  await cli(["resume", runSpace.id]);
  assert.ok(!(await observe(runTab.id)).text.includes("Bottom action completed"));
  passed("a run the person takes over prints only the guidance and exits 3");
  const typed = join(temporary, "task.mts");
  await writeFile(typed, `const label: string = "typed"; const found = await space(${JSON.stringify(runSpace.id)}); console.log(\`\${label} \${found.name}\`);\n`);
  assert.equal((await cli(["run", typed])).output, "typed Run review\n");
  assert.equal(
    (await cli(["run", "--ts", "-"], "const count: number = 2;\nconsole.log(`count ${count}`);\n")).output,
    "count 2\n",
  );
  passed("TypeScript runs through run task.mts and run --ts -");
  const held = await cli(
    [
      "run",
      "--timeout",
      "3000",
      "-e",
      `console.log("waiting for the page"); const page = (await (await space(${JSON.stringify(runSpace.id)})).tabs()).find((item) => item.id === ${JSON.stringify(runTab.id)}); await page.navigate(${JSON.stringify(`${fixture.origin}/hold`)}); await page.snapshot();`,
    ],
    undefined,
    { failure: true },
  );
  assert.equal(held.code, 1);
  assert.equal(held.output, "waiting for the page\n");
  assert.match(held.errors, /^error: run_timeout: The script did not finish within 3000 ms\./);
  await cli(["space", "close", runSpace.id]);
  passed("run --timeout 3000 ends a script waiting on /hold with run_timeout after its earlier output");
  // Section 7 in the real app: what an action caused, dialogs answered
  // without a box, armed downloads, file inputs and choosers, and the
  // requests only the person can answer.
  const { resolveSocket: findSocket, socketFetch: openSocket } = await import(
    pathToFileURL(client).href,
  );
  const promptSocket = openSocket(await findSocket(environment));
  const otherOrigin = fixture.origin.replace("127.0.0.1", "localhost");
  // The request a site is waiting on, as the person's window shows it.
  const promptFor = (spaceId) =>
    poll(
      async () =>
        (await chrome.evaluate(() => window.kamapathy.getState())).prompts.find(
          (item) => item.spaceId === spaceId,
        ),
      { timeoutMs: 15000, label: "the site's request for the person" },
    );
  const delayedSpace = (await json(["space", "create", "Delayed popups"])).space;
  const delayedTab = (await json(["open", delayedSpace.id, `${fixture.origin}/prompts/delayed`])).tab;
  // A page opened 400 ms later is outside the click's own window.
  const unreportedClick = await cli(["click", delayedTab.id, "#open-later"]);
  assert.equal(unreportedClick.output, "ok\n");
  const latePopup = await poll(
    async () =>
      (await tabsOf(delayedSpace.id)).tabs.find((item) => item.openerId === delayedTab.id),
    { timeoutMs: 10000, label: "the page opened after the click" },
  );
  // Armed before the click, the same page resolves the wait.
  const popupArm = (await json(["expect", delayedTab.id, "popup"])).expectation;
  assert.deepEqual([popupArm.event, popupArm.tabId], ["popup", delayedTab.id]);
  await cli(["click", delayedTab.id, "#open-later"]);
  const popupArrived = (await cli(["wait-expectation", popupArm.id])).output;
  const reportedPopup = /^popup (p\d+) (\S+) (\S+)\n$/.exec(popupArrived);
  assert.ok(reportedPopup, popupArrived);
  assert.match(reportedPopup[3], /\/prompts\/landing$/);
  const popupLines = (await cli(["tabs", delayedSpace.id])).output.trim().split("\n");
  assert.match(
    popupLines.find((line) => line.includes(reportedPopup[2])),
    new RegExp(`^${reportedPopup[1]} ${reportedPopup[2]} page from ${delayedTab.label} http`),
  );
  // The page nothing reported is still new to the agent.
  assert.match(
    popupLines.find((line) => line.includes(latePopup.id)),
    new RegExp(` page from ${delayedTab.label} new http`),
  );
  await cli(["space", "close", delayedSpace.id]);
  passed("receipt and delayed popups");
  const dialogSpace = (await json(["space", "create", "Dialog review"])).space;
  const dialogTab = (await json(["open", dialogSpace.id, `${fixture.origin}/prompts/dialogs`])).tab;
  const dismissedConfirm = await cli(["click", dialogTab.id, "#ask-confirm"]);
  assert.equal(dismissedConfirm.output, 'ok\nconfirm "Delete the draft?" dismissed\n');
  assert.match((await observe(dialogTab.id)).text, /confirm false/);
  const dialogArm = await cli(
    ["dialog-policy", dialogTab.id, "accept", "--times", "2", "--prompt-stdin"],
    "Quarterly plan",
  );
  assert.equal(dialogArm.output, "policy accept 2 left\n");
  const acceptedPrompt = await cli(["click", dialogTab.id, "#ask-prompt"]);
  assert.equal(acceptedPrompt.output, 'ok\nprompt "What is the title?" accepted\n');
  assert.match((await observe(dialogTab.id)).text, /prompt Quarterly plan/);
  // An alert is answered at once and keeps the arm.
  const alerted = await cli(["click", dialogTab.id, "#ask-alert"]);
  assert.equal(alerted.output, 'ok\nalert "A note for you" accepted\n');
  assert.deepEqual((await cli(["dialogs", dialogTab.id])).output.trim().split("\n"), [
    "policy accept 1 left",
    'confirm "Delete the draft?" dismissed',
    'prompt "What is the title?" accepted',
    'alert "A note for you" accepted',
  ]);
  // No box was ever raised: nothing holds the page, and every read above
  // would have failed with dialog_open while one did.
  const dialogInfo = await (await promptSocket(`/tabs/${dialogTab.id}/info`)).json();
  assert.equal(dialogInfo.dialog, undefined, JSON.stringify(dialogInfo));
  assert.equal(dialogInfo.readyState, "complete");
  passed("dialogs dismissed by default, answered when armed, no native box");
  const filesTab = (await json(["open", dialogSpace.id, `${fixture.origin}/prompts/files`])).tab;
  const notesFile = join(temporary, "notes.txt");
  await writeFile(notesFile, "Field notes\n");
  await cli(["dialog-policy", filesTab.id, "accept"]);
  // The label names the hidden input, and the page's change handler asks
  // before it accepts what arrived.
  const chosenFiles = await cli(["set-input-files", filesTab.id, "#notes-label", notesFile]);
  assert.equal(chosenFiles.output, 'ok: selected 1\nconfirm "Upload these?" accepted\n');
  assert.match((await observe(filesTab.id)).text, /Chose notes\.txt 12/);
  await cli(["space", "close", dialogSpace.id]);
  passed("a change-handler confirm during setInputFiles");
  const downloadSpace = (await json(["space", "create", "Download review"])).space;
  const downloadTab = (await json(["open", downloadSpace.id, `${fixture.origin}/prompts/download`])).tab;
  // Nothing armed: the file never arrives, and the click says so.
  const blockedClick = await cli(["click", downloadTab.id, "#attachment-link"]);
  assert.equal(blockedClick.output, `ok\ndownload blocked ${ATTACHMENT.name}\n`);
  assert.equal((await cli(["downloads", downloadSpace.id])).output, "No downloads.\n");
  const downloadBytes = Buffer.byteLength(ATTACHMENT.body);
  const savedPath = join(temporary, "downloads", ATTACHMENT.name);
  const savedLine = await cli(["download", downloadTab.id, "#attachment-link", savedPath]);
  assert.equal(savedLine.output, `saved ${savedPath} (${downloadBytes} bytes)\n`);
  assert.equal(await readFile(savedPath, "utf8"), ATTACHMENT.body);
  const heldDownloads = (await json(["downloads", downloadSpace.id])).downloads;
  assert.equal(heldDownloads.length, 1, JSON.stringify(heldDownloads));
  assert.deepEqual(
    [
      heldDownloads[0].state,
      heldDownloads[0].suggestedFilename,
      heldDownloads[0].receivedBytes,
      heldDownloads[0].failure,
    ],
    ["completed", ATTACHMENT.name, downloadBytes, null],
  );
  assert.equal(
    (await cli(["downloads", downloadSpace.id])).output,
    `${heldDownloads[0].id} completed ${downloadBytes}/${downloadBytes} ${ATTACHMENT.name}\n`,
  );
  // The same path again writes nothing.
  const secondSave = await cli(["save-download", heldDownloads[0].id, savedPath], undefined, {
    failure: true,
  });
  assert.match(secondSave.errors, /already exists, so nothing was written/);
  assert.equal(await readFile(savedPath, "utf8"), ATTACHMENT.body);
  assert.equal((await cli(["delete-download", heldDownloads[0].id])).output, "ok\n");
  assert.equal((await cli(["downloads", downloadSpace.id])).output, "No downloads.\n");
  await cli(["space", "close", downloadSpace.id]);
  passed("unarmed downloads blocked, armed ones saved without overwriting");
  const chooserSpace = (await json(["space", "create", "Chooser review"])).space;
  const chooserTab = (await json(["open", chooserSpace.id, `${fixture.origin}/prompts/chooser`])).tab;
  const guardedClick = await cli(["click", chooserTab.id, "#pick"], undefined, { failure: true });
  assert.match(
    guardedClick.errors,
    /422 file_chooser_opened: This action opened a file chooser, which Kamapathy closed\./,
  );
  // The input was cancelled, as a person's own cancel does, and nothing
  // was selected.
  const chooserEvents = await poll(
    async () => {
      const page = (await observe(chooserTab.id)).text;
      return page.includes("pick:cancel") ? page : null;
    },
    { timeoutMs: 5000, label: "the input's own cancel event" },
  );
  assert.doesNotMatch(chooserEvents, /pick:input|pick:change/);
  const chooserArm = (await json(["expect", chooserTab.id, "filechooser"])).expectation;
  await cli(["click", chooserTab.id, "#create"]);
  const chooserArrived = (await cli(["wait-expectation", chooserArm.id])).output;
  const reportedChooser = /^file-chooser (\S+) single\n$/.exec(chooserArrived);
  assert.ok(reportedChooser, chooserArrived);
  // The page took its own input away again, and the bytes still land on it.
  assert.equal((await cli(["set-files", reportedChooser[1], notesFile])).output, "ok: selected 1\n");
  assert.match((await observe(chooserTab.id)).text, /Chose notes\.txt 12/);
  await cli(["space", "close", chooserSpace.id]);
  passed("file input clicks fail with file_chooser_opened, armed choosers take files");
  const holdSpace = (await json(["space", "create", "Location review"])).space;
  const holdTab = (await json(["open", holdSpace.id, `${fixture.origin}/prompts/location`])).tab;
  // The site asks inside the window the click left open.
  assert.equal((await cli(["click", holdTab.id, "#ask-location"])).output, "ok\n");
  const locationPrompt = await promptFor(holdSpace.id);
  assert.deepEqual(
    [locationPrompt.kind, locationPrompt.agent, locationPrompt.tabId, locationPrompt.origin],
    ["location", true, holdTab.id, fixture.origin],
  );
  const refusedCall = await cli(["snapshot", holdTab.id], undefined, { failure: true });
  assert.match(
    refusedCall.errors,
    /409 human_control: The site asked for location, and only the person can answer\. Wait for control\./,
  );
  const heldError = await (await promptSocket(`/tabs/${holdTab.id}/snapshot`)).json();
  assert.deepEqual(
    (({ code, reason, prompt }) => ({ code, reason, prompt }))(heldError.error),
    { code: "human_control", reason: "permission", prompt: "location" },
  );
  const returningControl = cli(["wait-for-control", holdSpace.id]);
  await chrome.evaluate(
    (id) => window.kamapathy.answerPrompt({ id, allow: true }),
    locationPrompt.id,
  );
  assert.match((await returningControl).output, /^ok: agent has control/);
  assert.doesNotMatch((await observe(holdTab.id)).text, /error 1/);
  // The browser's other name is another origin, so the site is asked again,
  // and a Block reaches the page as its own refusal.
  await json(["navigate", holdTab.id, `${otherOrigin}/prompts/location`]);
  await cli(["click", holdTab.id, "#ask-location"]);
  const blockingPrompt = await promptFor(holdSpace.id);
  assert.equal(blockingPrompt.kind, "location");
  await chrome.evaluate(
    (id) => window.kamapathy.answerPrompt({ id, allow: false }),
    blockingPrompt.id,
  );
  await poll(async () => (await observe(holdTab.id)).text.includes("error 1"), {
    timeoutMs: 10000,
    label: "the page's own refusal",
  });
  await cli(["space", "close", holdSpace.id]);
  passed("a location request hands over, agent resumes after Allow");
  const attempts = () => fixture.events.filter((item) => item.type === "auth-attempt");
  const authSpace = (await json(["space", "create", "Sign-in review"])).space;
  const authTab = (await json(["open", authSpace.id, `${fixture.origin}/prompts/landing`])).tab;
  assert.equal(
    (
      await cli(["http-credentials", authSpace.id, fixture.origin, "--stdin"], {
        username: AUTH.username,
        password: AUTH.password,
      })
    ).output,
    `ok: ${fixture.origin}\n`,
  );
  await json(["navigate", authTab.id, `${fixture.origin}/prompts/auth`]);
  assert.match((await observe(authTab.id)).text, /Signed in/);
  assert.equal(
    attempts().filter(
      (item) => item.path === "/prompts/auth" && item.authorization === AUTH.header,
    ).length,
    1,
    JSON.stringify(attempts()),
  );
  const attemptsBefore = attempts().length;
  // Nothing is stored for the browser's other name, so the person signs in.
  const navigatingAuth = cli(["navigate", authTab.id, `${otherOrigin}/prompts/auth`]).then(
    (result) => result,
    (error) => error,
  );
  const signInPrompt = await promptFor(authSpace.id);
  assert.deepEqual(
    [
      signInPrompt.kind,
      signInPrompt.agent,
      signInPrompt.signIn.host,
      signInPrompt.signIn.realm,
      signInPrompt.signIn.proxy,
      signInPrompt.signIn.retry,
    ],
    ["http_sign_in", true, "localhost", AUTH.realm, false, false],
  );
  const stoppedCall = await cli(["snapshot", authTab.id], undefined, { failure: true });
  assert.match(
    stoppedCall.errors,
    /409 human_control: The site asked for http_sign_in, and only the person can answer\./,
  );
  await chrome.evaluate(
    ({ id, credentials }) => window.kamapathy.answerPrompt({ id, allow: true, credentials }),
    { id: signInPrompt.id, credentials: { username: AUTH.username, password: AUTH.password } },
  );
  await navigatingAuth;
  await poll(async () => (await observe(authTab.id)).text.includes("Signed in"), {
    timeoutMs: 15000,
    label: "the page the person signed in to",
  });
  assert.ok(
    attempts().length > attemptsBefore,
    `${attempts().length} sign-in attempts, ${attemptsBefore} before the person answered`,
  );
  await cli(["space", "close", authSpace.id]);
  passed("Basic auth with agent credentials, then the person");
  const noticeSpace = (await json(["space", "create", "Notice review"])).space;
  const noticeTab = (await json(["open", noticeSpace.id, `${fixture.origin}/prompts/delayed`])).tab;
  const noticeScript = join(temporary, "unseen-popup.mjs");
  await writeFile(
    noticeScript,
    [
      `const found = await space(${JSON.stringify(noticeSpace.id)});`,
      `const page = (await found.tabs()).find((item) => item.id === ${JSON.stringify(noticeTab.id)});`,
      'await page.click("#open-later");',
      'await page.wait({ selector: "#opened", text: "one page opened", timeoutMs: 5000 });',
      "await new Promise((done) => setTimeout(done, 300));",
      "",
    ].join("\n"),
  );
  const noticeRun = await cli(["run", noticeScript]);
  assert.equal(noticeLines(noticeRun.errors).length, 1, noticeRun.errors);
  assert.match(
    noticeLines(noticeRun.errors)[0],
    new RegExp(
      `^notice: unused page p\\d+ opened by ${noticeTab.label}: ${fixture.origin}/prompts/landing$`,
    ),
  );
  await cli(["space", "close", noticeSpace.id]);
  passed("run notes unseen popups");
  // Section 11 in the real app: versions, help, diagnostics and field checks.
  // The level comes from the one schema, so a new level needs no edit here.
  const { API_LEVEL } = await import(pathToFileURL(join(skill, "scripts/schema/index.mjs")).href);
  const versions = (await cli(["--version"])).output;
  assert.match(versions, /API level 4/);
  assert.match(versions, new RegExp(`API level ${API_LEVEL}`));
  assert.match(versions, /Electron 44\./);
  assert.match(versions, /Chromium 152\./);
  passed("--version shows API level, Electron 44. and Chromium 152.");
  const emptyProfile = join(temporary, "empty-profile");
  const helped = await cli(["help", "snapshot"], undefined, {
    env: { ...environment, KAMAPATHY_USER_DATA: emptyProfile, KAMAPATHY_NO_LAUNCH: "" },
  });
  assert.match(helped.output, /snapshot <tab-id>/);
  assert.equal(await readFile(emptyProfile).then(() => true, () => false), false);
  passed("help snapshot on an empty KAMAPATHY_USER_DATA profile exits 0 and starts nothing");
  const broken = await cli(["run", "-e", "const a = 1;\nconst b = {,};\n"], undefined, { failure: true });
  assert.match(broken.errors, /^error: SyntaxError: .+ \(-e:2:\d+\)\n  2 \| const b = \{,\};\n    \| +\^/);
  passed("run -e with a broken second line prints (-e:2: and a caret");
  const hinted = await cli(["run", "-e", "document.title"], undefined, { failure: true });
  assert.match(
    hinted.errors,
    /hint: Scripts run in Node\.js on this computer, not in the page, so document does not exist here\./,
  );
  passed("run -e 'document.title' prints the page hint");
  const waited = await cli(
    ["run", "-e", `const page = (await (await space(${JSON.stringify(space.id)})).tabs())[0]; await page.wait({ state: "hidden" });`],
    undefined,
    { failure: true },
  );
  assert.match(waited.errors, /^error: invalid_option: page\.wait got unknown option "state"/);
  passed('page.wait({ state: "hidden" }) fails with invalid_option');
  const { resolveSocket, socketFetch } = await import(pathToFileURL(client).href);
  const raw = await socketFetch(await resolveSocket(environment))("/spaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Extra field", zz: 1 }),
  });
  assert.equal(raw.status, 400);
  assert.deepEqual(
    (({ code, field }) => ({ code, field }))((await raw.json()).error),
    { code: "unknown_field", field: "zz" },
  );
  passed("a raw socket POST with an extra field gets 400 unknown_field");
  // Section 12: setup gives agents the skill and a working command.
  const setUp = await chrome.evaluate(() =>
    window.kamapathy.applyAgentSetup({
      agents: ["claude-code"],
      replace: [],
      command: true,
      path: false,
      codexRule: false,
    }),
  );
  assert.equal(setUp.command.state, "on");
  const claudeCode = setUp.agents.find((agent) => agent.id === "claude-code");
  assert.equal(claudeCode?.state, "linked", JSON.stringify(setUp.agents));
  const commandPath = setUp.command.path;
  const throughCommand = await program(
    ...(process.platform === "win32"
      ? ["cmd.exe", ["/d", "/c", commandPath, "health"]]
      : ["/bin/sh", [commandPath, "health"]]),
  );
  assert.equal(throughCommand.output.trim(), `ok Kamapathy ${packageVersion}`);
  const entry = join(claudeCode.folder, "kamapathy");
  const throughEntry = await program(process.execPath, [
    join(entry, "scripts", "kamapathy.mjs"),
    "health",
  ]);
  assert.equal(throughEntry.output.trim(), `ok Kamapathy ${packageVersion}`);
  const takenBack = await chrome.evaluate(() =>
    window.kamapathy.removeAgentSetup(),
  );
  assert.equal(takenBack.command.state, "off");
  assert.notEqual(
    takenBack.agents.find((agent) => agent.id === "claude-code")?.state,
    "linked",
  );
  assert.equal(existsSync(commandPath), false);
  assert.equal(existsSync(entry), false);
  passed(
    "setup gives agents a working command through the launcher and their skills folder",
  );
  // Section 13 last, so its notices reach no earlier check's stderr.
  if (packaged)
    console.log("SKIP update check: a packaged run ignores the test feed");
  else {
    const downloads = join(environment.KAMAPATHY_USER_DATA, "updates");
    await pastReuse();
    feed.setMode("bad-sum");
    const refused = await cli(["upgrade"], undefined, { failure: true });
    assert.equal(refused.code, 1);
    assert.match(
      refused.errors,
      /^Kamapathy: update_verify_failed: The download didn't match its checksum, so it was deleted\.$/m,
    );
    assert.deepEqual(await filesUnder(downloads), []);
    // The same release, now with the checksum it publishes.
    feed.setMode("available");
    const available = await cli(["upgrade", "--check"]);
    assert.equal(
      available.output.trim(),
      `Kamapathy 9.9.9 is available (this is ${packageVersion}). Run kamapathy upgrade, with the person's approval, to download it.`,
    );
    assert.deepEqual(await filesUnder(downloads), []);
    const notified = await cli(["health"]);
    assert.equal(notified.output.trim(), `ok Kamapathy ${packageVersion}`);
    assert.deepEqual(noticeLines(notified.errors), [
      `notice: update_available: Kamapathy 9.9.9 is out (this is ${packageVersion}). Finish this task first, then ask the person before you run kamapathy upgrade. Read the Kamapathy skill again after the update.`,
    ]);
    // A run that reaches Kamapathy announces the update once, then exits 0.
    const announced = await cli(["run", "-e", "await spaces();"]);
    assert.equal(announced.code, 0);
    assert.equal(noticeLines(announced.errors).length, 1, announced.errors);
    const upgraded = await cli(["upgrade"]);
    assert.ok(
      upgraded.errors.includes(
        `Downloading ${feed.installer.name} (2 MB)...\n`,
      ),
      upgraded.errors,
    );
    const lines = upgraded.output.trimEnd().split("\n");
    assert.equal(
      lines[0],
      `Kamapathy 9.9.9 is downloaded and checked (this is ${packageVersion}).`,
    );
    const installer = join(downloads, "9.9.9", feed.installer.name);
    assert.equal(lines[1], `Installer: ${installer}`);
    assert.match(lines[2], /^Next: /);
    const file = statSync(installer);
    assert.equal(file.size, feed.installer.size);
    if (process.platform !== "win32")
      assert.equal(file.mode & 0o777, 0o755);
    assert.equal(
      createHash("sha256").update(await readFile(installer)).digest("hex"),
      feed.installer.sha256,
    );
    const ready = await cli(["health"]);
    assert.deepEqual(noticeLines(ready.errors), [
      `notice: update_ready: Kamapathy 9.9.9 is downloaded (this is ${packageVersion}). Finish this task first, then tell the person they can install it from Settings, under Updates. Read the Kamapathy skill again after the update.`,
    ]);
    const install = await socketFetch(await resolveSocket(environment))(
      "/update/install",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    assert.equal(install.status, 404);
    assert.equal((await install.json()).error.code, "route_not_found");
    passed(
      "an agent sees the notice, downloads a verified installer and cannot install it",
    );
  }
  // Section 10 in the real app: the agent's own account of its work, the
  // page it works in coming forward, and agents at work with no window.
  const spaceLine = async () =>
    (await cli(["spaces"])).output
      .split("\n")
      .find((line) => line.startsWith(space.id)) ?? "";
  const entriesOf = async (message) =>
    (await chrome.evaluate(() => window.kamapathy.getState())).activity.filter(
      (item) => item.spaceId === space.id && item.message === message,
    );
  // A status is cleaned on the way in: the tab and the bell never reach the
  // person's screen.
  assert.equal(
    (await cli(["status", space.id, "Comparing\tprices on three\u0007 sites"])).output,
    'ok: status "Comparing prices on three sites"\n',
  );
  assert.match(await spaceLine(), / status "Comparing prices on three sites"$/);
  const written = await entriesOf("Agent updated its status");
  assert.equal(written.length, 1);
  assert.equal(written[0].agentText, "Comparing prices on three sites");
  // The same status again is not news.
  await cli(["status", space.id, "Comparing prices on three sites"]);
  assert.equal((await entriesOf("Agent updated its status")).length, 1);
  assert.equal(
    (await cli(["status", space.id, "--clear"])).output,
    "ok: status cleared\n",
  );
  assert.doesNotMatch(await spaceLine(), /status/);
  assert.equal((await entriesOf("Agent cleared its status")).length, 1);
  // A label names the action while it runs and for five seconds after.
  await json(["navigate", tab.id, `${fixture.origin}/lab`]);
  const labelled = await observe(tab.id);
  await cli([
    "click",
    tab.id,
    ref(labelled, "Show delayed result"),
    "--label",
    "Open the\u0007 details",
  ]);
  const task = (await chrome.evaluate(() => window.kamapathy.getState())).spaces.find(
    (item) => item.id === space.id,
  ).task;
  assert.deepEqual(
    [task.label.text, task.label.active],
    ["Open the details", false],
  );
  // A reported failure hands the space over with the message as its status.
  assert.equal(
    (await cli(["fail", space.id, "The site needs a phone number I do not\u0007 have"]))
      .output,
    "ok: failure reported, the person has control\n",
  );
  assert.match(
    await spaceLine(),
    / human .*failed status "The site needs a phone number I do not have"$/,
  );
  const reported = await entriesOf("Agent could not finish");
  assert.equal(reported.length, 1);
  assert.equal(
    reported[0].agentText,
    "The site needs a phone number I do not have",
  );
  const blocked = await cli(
    ["click", tab.id, ref(labelled, "Show delayed result")],
    undefined,
    { failure: true },
  );
  assert.match(
    blocked.errors,
    /409 human_control: You reported that this task could not be finished\./,
  );
  // The refusal says the agent's own report is why the person has control.
  const underFailure = await socketFetch(await resolveSocket(environment))(
    `/tabs/${tab.id}/snapshot`,
  );
  assert.equal(underFailure.status, 409);
  assert.deepEqual(
    (({ code, reason }) => ({ code, reason }))((await underFailure.json()).error),
    { code: "human_control", reason: "failed" },
  );
  assert.match((await cli(["resume", space.id])).output, /^ok: agent control resumed/);
  assert.doesNotMatch(await spaceLine(), /failed|status/);
  await observe(tab.id);
  passed(
    "status, labels and a reported failure are cleaned, listed and logged, and resume clears the failure",
  );
  // Following the agent: inside its own space the page it acts in comes
  // forward, and nothing of the person's moves.
  const details = (await json(["open", space.id, `${fixture.origin}/lab`])).tab;
  await chrome.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:activate", id }),
    space.id,
  );
  await waitForState(chrome, (state, id) => state.activeSpaceId === id, space.id);
  // The agent's own snapshot brings the first page back to the front.
  await observe(tab.id);
  const before = await chrome.evaluate(() => window.kamapathy.getState());
  assert.equal(before.activeTabId, tab.id);
  // The person is reading the shell, which keeps the keyboard throughout.
  const windowState = () =>
    browser.evaluate(({ BrowserWindow, webContents }) => ({
      visible: BrowserWindow.getAllWindows()[0].isVisible(),
      focused: BrowserWindow.getAllWindows()[0].isFocused(),
      view: webContents.getFocusedWebContents()?.id ?? null,
    }));
  await browser.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.focus(),
  );
  const windowBefore = await windowState();
  assert.equal(
    (await json(["tabs", space.id])).tabs.find((item) => item.id === tab.id).active,
    true,
  );
  await cli(["click", details.id, "#delayed", "--label", "Open the details"]);
  await waitForState(chrome, (state, id) => state.activeTabId === id, details.id);
  const after = await chrome.evaluate(() => window.kamapathy.getState());
  assert.equal(after.activeSpaceId, space.id);
  assert.equal(after.splitTabId, before.splitTabId);
  assert.deepEqual(
    (await json(["tabs", space.id])).tabs
      .filter((item) => item.active)
      .map((item) => item.id),
    [details.id],
  );
  assert.deepEqual(await windowState(), windowBefore);
  // A listing is an observation: it leaves the shown page where it is.
  await json(["tabs", space.id]);
  assert.equal(
    (await chrome.evaluate(() => window.kamapathy.getState())).activeTabId,
    details.id,
  );
  passed(
    "a labeled click brings its tab forward in the shown agent space without changing the active space",
  );
  // Closing the window keeps the agents working on the same Kamapathy.
  const endpoint = () => readFile(join(temporary, "profile", "agent", "endpoint"), "utf8");
  const windowPages = () =>
    browser.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return window
        ? {
            visible: window.isVisible(),
            pages: window.contentView.children.map(
              (view) => view.webContents?.getURL() ?? "",
            ),
          }
        : null;
    });
  // The person is looking at a page of their own when the window closes.
  const personalPage = `${fixture.origin}/forms/new`;
  await chrome.evaluate(() =>
    window.kamapathy.dispatch({ type: "space:activate", id: "personal" }),
  );
  await chrome.evaluate(
    (url) => window.kamapathy.dispatch({ type: "tab:create", url }),
    personalPage,
  );
  await waitForState(
    chrome,
    (state, url) =>
      state.tabs.some(
        (tab) => tab.url === url && tab.id === state.activeTabId && !tab.loading,
      ),
    personalPage,
  );
  await poll(async () => (await windowPages()).pages.includes(personalPage), {
    timeoutMs: 10000,
    label: "the person's own page",
  });
  const instance = await endpoint();
  const spacesBefore = (await json(["spaces"])).spaces;
  await browser.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].close(),
  );
  const away = await poll(
    async () => {
      const found = await windowPages();
      return found && !found.visible ? found : null;
    },
    { timeoutMs: 10000, label: "the window closing into the background" },
  );
  // Nothing of the person's runs unseen; the agent's pages stay.
  assert.deepEqual(
    away.pages.filter((url) => url === personalPage),
    [],
  );
  assert.ok(away.pages.includes(`${fixture.origin}/lab`), JSON.stringify(away.pages));
  assert.equal(await endpoint(), instance);
  assert.equal((await cli(["health"])).output.trim(), `ok Kamapathy ${packageVersion}`);
  await json(["navigate", details.id, `${fixture.origin}/lab`]);
  const hidden = await observe(details.id);
  await cli([
    "click",
    details.id,
    ref(hidden, "Show delayed result"),
    "--label",
    "Open the details",
  ]);
  await cli(["wait", details.id, "--stdin"], {
    selector: "#delayed-result",
    text: "Delayed content ready",
    timeoutMs: 5000,
  });
  assert.deepEqual((await json(["spaces"])).spaces, spacesBefore);
  await browser.evaluate(({ app }) => app.emit("activate"));
  await poll(async () => (await windowPages())?.visible === true, {
    timeoutMs: 10000,
    label: "the window coming back",
  });
  // The page the person was looking at is laid out again; their other pages
  // are made as they open them.
  await poll(async () => (await windowPages()).pages.includes(personalPage), {
    timeoutMs: 10000,
    label: "the person's page laid out again",
  });
  await cli(["close", details.id]);
  passed("agents keep working with the window closed on the same instance");
  await cli(["space", "close", space.id]);
  assert.equal((await json(["spaces"])).spaces.length, 0);
  passed("skill cleanup closes only its own agent space");
  const summary = {
    date: new Date().toISOString(),
    platform: process.platform,
    skill: "kamapathy",
    checks,
    commandCalls: calls.length,
    formPosts: fixture.forms.size,
    responsePosts: fixture.submissions.length,
    publicWebsites: process.env.KAMAPATHY_TEST_PUBLIC === "1",
  };
  await writeFile(
    join(artifacts, "skill-results.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    `Skill end-to-end passed: ${checks.length} checks, ${calls.length} client commands, two forms and one response created.`,
  );
} catch (error) {
  if (diagnostics)
    await captureDiagnostics(error).catch((reason) => console.error(reason));
  throw error;
} finally {
  if (diagnostics) {
    await writeFile(join(diagnostics, "calls.json"), JSON.stringify(calls, null, 2)).catch(() => {});
    const events = browser
      ? await browser.evaluate(() => globalThis.__kamapathyDiagnostics ?? []).catch(() => [])
      : [];
    await writeFile(join(diagnostics, "events.json"), JSON.stringify(events, null, 2)).catch(() => {});
  }
  if (browser) {
    // A quit while agents are at work asks the person first, and no one is
    // here to answer it, so this run answers its own question.
    await browser
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
      })
      .catch(() => {});
    await browser.close().catch(() => {});
  }
  await fixture.close();
  await feed.close();
  await rm(temporary, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 150,
  });
}
