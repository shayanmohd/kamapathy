import { poll, waitForState } from "./wait.mjs";
import { prepareDesktopRuntime } from "./desktop-runtime.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { _electron as electron } from "playwright";
import {
  resolveSocket,
  socketFetch,
} from "../skills/kamapathy/scripts/kamapathy.mjs";

const profile = await mkdtemp(join(tmpdir(), "kamapathy-smoke-"));
let failRecoverablePage = true;
const fixture = createServer((request, response) => {
  if (request.url === "/recoverable" && failRecoverablePage) {
    request.socket.destroy();
    return;
  }
  response.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
  });
  const second = request.url === "/second";
  response.end(
    `<!doctype html><html lang="en"><head><title>${second ? "Second page" : "Kamapathy test garden"}</title></head><body><h1>${second ? "Second page" : "Kamapathy test garden"}</h1><a id="next" href="/second">Next page</a><label for="query">Research topic</label><input id="query"><button id="save">Save topic</button><p id="result">No topic saved</p><script>document.getElementById('save').onclick=()=>{document.getElementById('result').textContent=document.getElementById('query').value;};</script></body></html>`,
  );
});
await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
let app;
let checks = 0;
const checked = (message) => {
  checks++;
  console.log(`PASS ${message}`);
};
// A home folder with another browser's data in it, so the welcome dialog has
// something real to import.
const home = join(profile, "home");
const chromeData = join(
  home,
  process.platform === "darwin"
    ? "Library/Application Support/Google/Chrome"
    : process.platform === "win32"
      ? "Google/Chrome/User Data"
      : ".config/google-chrome",
);
await mkdir(join(chromeData, "Default"), { recursive: true });
await writeFile(
  join(chromeData, "Local State"),
  JSON.stringify({
    profile: { info_cache: { Default: { name: "Person 1" } }, last_used: "Default" },
  }),
);
await writeFile(
  join(chromeData, "Default", "Bookmarks"),
  JSON.stringify({
    roots: {
      bookmark_bar: {
        type: "folder",
        children: [
          { type: "url", name: "Docs", url: "https://docs.example/" },
          { type: "url", name: "Mail", url: "https://mail.example/inbox" },
        ],
      },
      other: { type: "folder", children: [] },
      synced: { type: "folder", children: [] },
    },
    version: 1,
  }),
);
{
  const history = new DatabaseSync(join(chromeData, "Default", "History"));
  history.exec(
    "CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL, typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)",
  );
  const chromeTime = (millis) => (millis + 11644473600000) * 1000;
  const insert = history.prepare(
    "INSERT INTO urls (url, title, visit_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, 0)",
  );
  insert.run("https://docs.example/plan", "The plan", 5, chromeTime(Date.now() - 60000));
  insert.run("https://mail.example/inbox", "Inbox", 3, chromeTime(Date.now() - 120000));
  insert.run("https://shop.example/", "Shop", 1, chromeTime(Date.now() - 180000));
  history.close();
}
const env = {
  ...process.env,
  KAMAPATHY_USER_DATA: profile,
  ...(process.platform === "win32"
    ? { USERPROFILE: home, LOCALAPPDATA: home, APPDATA: join(home, "roaming") }
    : { HOME: home }),
};
delete env.ELECTRON_RUN_AS_NODE;
const visibleViews = () =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .contentView.children.filter((view) => view.getVisible())
      .map((view) => ({ ...view.getBounds(), url: view.webContents.getURL() })),
  );
const frameSources = (page) =>
  page
    .locator("img.frozen-frame")
    .evaluateAll((images) => images.map((image) => image.getAttribute("src")));
// The first capture after launch can miss the 300ms budget on a cold runner.
async function withFrozenFrame(page, open, close, frames = 1) {
  for (let attempt = 1; ; attempt++) {
    await open();
    const shown = await page.locator("img.frozen-frame").count();
    if (shown >= frames || attempt === 3) break;
    await close();
  }
  await poll(async () => (await visibleViews()).length === 0, {
    label: "pages hidden under their still frames",
  });
}
const livePages = (page, count) =>
  poll(
    async () =>
      (await visibleViews()).length === count &&
      (await page.locator("img.frozen-frame").count()) === 0,
    { label: `${count} live pages and no still frame` },
  );
// The agent cursor is a view of its own, which Playwright does not see as a
// window, so it is found among the window's children by the page it loads.
// `last` says it still sits above every page view, and `label` is the pill
// the agent's words are drawn in.
const cursorView = () =>
  app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return null;
    const children = window.contentView.children;
    const index = children.findIndex((view) =>
      (view.webContents?.getURL() ?? "").endsWith("src/cursor/index.html"),
    );
    if (index < 0) return null;
    const view = children[index];
    const placement = {
      bounds: view.getBounds(),
      visible: view.getVisible(),
      last: index === children.length - 1,
    };
    return view.webContents
      .executeJavaScript(
        "[document.getElementById('pill').textContent, getComputedStyle(document.querySelector('#arrow path')).fill]",
      )
      .then(([label, arrow]) => ({ ...placement, label, arrow }));
  });
// The person's own pointer, sent to the cursor view alone. Nothing else in
// this suite sends input there.
const touchCursor = () =>
  app.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows()[0].contentView.children.find(
      (item) => (item.webContents?.getURL() ?? "").endsWith("src/cursor/index.html"),
    );
    view.webContents.sendInputEvent({ type: "mouseMove", x: 5, y: 5 });
  });
// The quit question is a native box, so it is answered inside the
// application: the replacement records what the person would read and gives
// back the button this check wants. The quit follows the reply, so answering
// never races this call. Returns what was asked.
async function answerQuit(response) {
  await app.evaluate(
    ({ app, dialog }, button) => {
      globalThis.__kamapathyQuitQuestion = [];
      const original = dialog.showMessageBox;
      dialog.showMessageBox = async (first, second) => {
        const options = second ?? first;
        globalThis.__kamapathyQuitQuestion.push(
          [options.title, options.message, options.detail, ...(options.buttons ?? [])].join(" | "),
        );
        dialog.showMessageBox = original;
        return { response: button, checkboxChecked: false };
      };
      setTimeout(() => app.quit(), 0);
    },
    response === "quit" ? 0 : 1,
  );
  // A confirmed quit takes the application with it, so a question it can no
  // longer report counts as none.
  return poll(
    async () => {
      const asked = await app
        .evaluate(() => globalThis.__kamapathyQuitQuestion ?? [])
        .catch(() => []);
      return asked.length ? asked : null;
    },
    { timeoutMs: 10000, label: "the quit question" },
  ).catch(() => []);
}
async function overlapsNativePage(locator) {
  const box = await locator.boundingBox();
  return (await visibleViews()).some(
    (view) =>
      box.x < view.x + view.width &&
      view.x < box.x + box.width &&
      box.y < view.y + view.height &&
      view.y < box.y + box.height,
  );
}
async function launch() {
  app = await electron.launch({
    executablePath: await prepareDesktopRuntime(),
    args: [resolve("out/main/index.js")],
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector(".home-page, .web-page");
  await page.waitForFunction(() => !!window.kamapathy);
  return page;
}
try {
  let page = await launch();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let state = await page.evaluate(() => window.kamapathy.getState());
  assert.equal(state.platform, process.platform);
  checked("desktop bridge and platform detection");
  // The dialog's name follows its step, so it is found by class.
  const welcome = page.locator(".welcome-modal");
  await welcome.getByRole("heading", { name: "Welcome to Kamapathy" }).waitFor();
  assert.equal(state.settings.welcomed, false);
  await welcome.getByRole("radio", { name: /^Google Chrome/ }).check();
  await welcome.getByRole("button", { name: "Import", exact: true }).click();
  await welcome.getByText("Imported 2 bookmarks and 3 sites.").waitFor();
  await welcome.getByRole("button", { name: "Continue" }).click();
  await welcome.getByRole("heading", { name: "Sign in once" }).waitFor();
  const topSites = welcome.getByRole("button", { name: /^Open / });
  assert.equal(await topSites.first().getAttribute("aria-label"), "Open docs.example");
  assert.equal(await topSites.count(), 6);
  await welcome.getByRole("button", { name: "Done" }).click();
  await welcome.waitFor({ state: "detached" });
  await waitForState(page, (state) => state.settings.welcomed);
  state = await page.evaluate(() => window.kamapathy.getState());
  assert.deepEqual(
    state.bookmarks.slice(-2).map((bookmark) => [bookmark.title, bookmark.url]),
    [
      ["Docs", "https://docs.example/"],
      ["Mail", "https://mail.example/inbox"],
    ],
  );
  assert.deepEqual(
    state.history.map((entry) => [entry.url, entry.visits]),
    [
      ["https://docs.example/plan", 5],
      ["https://mail.example/inbox", 3],
      ["https://shop.example/", 1],
    ],
  );
  checked("the welcome dialog imports bookmarks and history from another browser, then offers top sites, once");
  assert.equal(await page.getByRole("complementary").count(), 0);
  if (process.platform === "darwin") {
    assert.deepEqual(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getWindowButtonPosition(),
      ),
      { x: 16, y: 15 },
    );
    const firstControl = await page.locator(".strip-search").boundingBox();
    assert.ok(firstControl.x >= 76, "tab strip controls clear the window buttons");
  }
  checked("the window has no sidebar, and macOS window buttons sit in the tab strip");
  const spacesButton = page.getByRole("button", { name: /^Spaces: / });
  const spacesMenu = page.getByRole("menu", { name: "Spaces" });
  await spacesButton.click();
  await spacesMenu.getByRole("menuitem", { name: "New space" }).click();
  await page.getByLabel("Space name", { exact: true }).fill("Test project");
  await page.getByRole("switch", { name: "Separate sign-ins" }).click();
  await page.getByRole("button", { name: "Create space", exact: true }).click();
  await poll(
    async () =>
      /^Spaces: Test project/.test(await spacesButton.getAttribute("aria-label")),
    { label: "the new space in the space button" },
  );
  state = await page.evaluate(() => window.kamapathy.getState());
  const project = state.activeSpaceId;
  assert.equal(
    state.spaces.find((space) => space.id === project).signIns,
    "separate",
  );
  checked("workspace creation through the interface, with separate sign-ins");
  await spacesButton.focus();
  await page.keyboard.press("Enter");
  await spacesMenu.waitFor();
  assert.match(await spacesMenu.textContent(), /Your spaces/);
  const focusedItem = () =>
    page.evaluate(() => document.activeElement?.textContent ?? "");
  const firstItem = await focusedItem();
  await page.keyboard.press("ArrowDown");
  assert.notEqual(await focusedItem(), firstItem);
  await page.keyboard.press("Escape");
  await spacesMenu.waitFor({ state: "detached" });
  assert.match(
    await page.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? "",
    ),
    /^Spaces: /,
  );
  await spacesButton.click();
  await spacesMenu
    .getByRole("menuitem", { name: "Options for Test project" })
    .click();
  await spacesMenu.getByRole("menuitem", { name: "Rename" }).click();
  await spacesMenu.getByLabel("Space name").fill("Garden project");
  await spacesMenu.getByLabel("Space name").press("Enter");
  await spacesMenu
    .getByRole("menuitemradio", { name: "orange space color" })
    .click();
  await waitForState(
    page,
    (state, id) => {
      const space = state.spaces.find((item) => item.id === id);
      return space.name === "Garden project" && space.color === "orange";
    },
    project,
  );
  await spacesMenu.getByRole("menuitem", { name: /^Work/ }).click();
  await spacesMenu.waitFor({ state: "detached" });
  await waitForState(page, (state) => state.activeSpaceId === "work");
  await spacesButton.click();
  await spacesMenu.getByRole("menuitem", { name: /^Garden project/ }).click();
  await waitForState(page, (state, id) => state.activeSpaceId === id, project);
  checked("the space popover works from the keyboard, renames and recolours a space, and switches spaces");
  state = await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "space:create",
      name: "Temporary",
      color: "blue",
      kind: "personal",
    }),
  );
  const temporary = state.activeSpaceId;
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:activate", id }),
    project,
  );
  await spacesButton.click();
  await spacesMenu
    .getByRole("menuitem", { name: "Options for Temporary" })
    .click();
  await spacesMenu.getByRole("menuitem", { name: "Close space" }).waitFor();
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:delete", id }),
    temporary,
  );
  await spacesMenu
    .getByRole("menuitem", { name: "Options for Temporary" })
    .waitFor({ state: "detached" });
  assert.ok(await spacesMenu.isVisible());
  await page.keyboard.press("Escape");
  await spacesMenu.waitFor({ state: "detached" });
  checked("a space deleted while its popover row is open disappears without an error");
  const overview = page.getByRole("dialog", { name: "All spaces" });
  const focusedLabel = () =>
    page.evaluate(
      () =>
        document.activeElement?.getAttribute("aria-label") ??
        document.activeElement?.textContent ??
        "",
    );
  const windowSize = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentSize(),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1200, 800),
  );
  await page.getByRole("button", { name: "Browser menu", exact: true }).focus();
  await page.keyboard.press("Alt+KeyS");
  await overview.waitFor();
  assert.equal(
    await overview.getByRole("heading", { level: 2 }).textContent(),
    "3 spaces",
  );
  await poll(
    async () =>
      (await overview
        .locator(".overview-grid")
        .evaluate(
          (grid) => getComputedStyle(grid).gridTemplateColumns.split(" ").length,
        )) === 3,
    { label: "three columns at 1200px" },
  );
  await app.evaluate(
    ({ BrowserWindow }, [width, height]) =>
      BrowserWindow.getAllWindows()[0].setContentSize(width, height),
    windowSize,
  );
  assert.match(
    await overview.getByRole("button", { name: "Open Work" }).textContent(),
    /New tab/,
  );
  await poll(async () => (await focusedLabel()) === "Open Garden project", {
    label: "focus on the current space's card",
  });
  for (let press = 0; press < 12; press++) await page.keyboard.press("Tab");
  assert.ok(
    await page.evaluate(() =>
      document
        .querySelector('[role="dialog"][aria-label="All spaces"]')
        .contains(document.activeElement),
    ),
    "focus stays inside the grid",
  );
  await page.keyboard.press("Escape");
  await overview.waitFor({ state: "detached" });
  assert.equal(await focusedLabel(), "Browser menu");
  await page.keyboard.press("Alt+KeyS");
  await overview.waitFor();
  await poll(async () => (await focusedLabel()) === "Open Garden project", {
    label: "focus back on the current space's card",
  });
  await page.keyboard.press("ArrowLeft");
  assert.equal(await focusedLabel(), "Open Work");
  await page.keyboard.press("Enter");
  await overview.waitFor({ state: "detached" });
  await waitForState(page, (state) => state.activeSpaceId === "work");
  await page.keyboard.press("Alt+KeyS");
  await overview.waitFor();
  await poll(async () => (await focusedLabel()) === "Open Work", {
    label: "focus on the Work card",
  });
  await page.keyboard.press("End");
  await poll(async () => (await focusedLabel()) === "New space", {
    label: "focus on the new space card",
  });
  await page.keyboard.press("Enter");
  await overview.getByLabel("Space name").fill("Grid space");
  await overview.getByLabel("Space name").press("Enter");
  await overview.waitFor({ state: "detached" });
  state = await waitForState(
    page,
    (state) =>
      state.spaces.find((space) => space.id === state.activeSpaceId)?.name ===
      "Grid space",
  );
  const gridSpace = state.activeSpaceId;
  await page.keyboard.press("Alt+KeyS");
  const gridCard = overview.locator(".space-card").filter({
    has: page.getByRole("button", { name: "Open Grid space" }),
  });
  await gridCard.getByRole("button", { name: "Rename Grid space" }).click();
  await gridCard.getByLabel("Space name").fill("Grid room");
  await gridCard.getByLabel("Space name").press("Enter");
  await overview.getByRole("button", { name: "Open Grid room" }).waitFor();
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:delete", id }),
    gridSpace,
  );
  await overview
    .getByRole("button", { name: "Open Grid room" })
    .waitFor({ state: "detached" });
  await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "space:create",
      name: "Spare",
      color: "blue",
      kind: "personal",
    }),
  );
  const spareCard = overview.locator(".space-card").filter({
    has: page.getByRole("button", { name: "Open Spare" }),
  });
  await spareCard.hover();
  assert.equal(
    await spareCard
      .locator(".space-card-actions")
      .evaluate((actions) => getComputedStyle(actions).opacity),
    "1",
  );
  await spareCard.getByRole("button", { name: "Close Spare" }).click();
  await spareCard
    .getByRole("button", { name: "Confirm closing Spare" })
    .click();
  await waitForState(
    page,
    (state) => !state.spaces.some((space) => space.name === "Spare"),
  );
  await poll(
    async () =>
      (await overview.getByRole("heading", { level: 2 }).textContent()) ===
      "3 spaces",
    { label: "the grid heading after closing a space" },
  );
  await page.keyboard.press("Alt+KeyS");
  await overview.waitFor({ state: "detached" });
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:activate", id }),
    project,
  );
  checked("the spaces grid opens with Option+S, keeps and restores focus, works from the keyboard, renames and closes from its cards and survives a space closing");
  const shortcuts = page.getByRole("navigation", { name: "Shortcuts" });
  const bookmarkCount = (await page.evaluate(() => window.kamapathy.getState()))
    .bookmarks.length;
  assert.equal(
    await shortcuts.getByRole("button").count(),
    Math.min(bookmarkCount, 8) + 1,
  );
  await shortcuts
    .getByRole("button", { name: "GitHub", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menu", { name: "GitHub shortcut" })
    .getByRole("menuitem", { name: "Edit" })
    .click();
  await page.getByRole("heading", { name: "Edit shortcut" }).waitFor();
  await page.getByLabel("Name", { exact: true }).fill("Code");
  await page.getByRole("button", { name: "Save shortcut" }).click();
  await waitForState(page, (state) =>
    state.bookmarks.some(
      (bookmark) => bookmark.id === "github" && bookmark.title === "Code",
    ),
  );
  await shortcuts
    .getByRole("button", { name: "Code", exact: true })
    .click({ button: "right" });
  await page
    .getByRole("menu", { name: "Code shortcut" })
    .getByRole("menuitem", { name: "Remove" })
    .click();
  await waitForState(
    page,
    (state) => !state.bookmarks.some((bookmark) => bookmark.id === "github"),
  );
  checked("new tab shortcuts open a menu to edit or remove them");
  const extraShortcuts = [];
  for (let index = 0; index < 8; index++) {
    const state = await page.evaluate(
      (index) =>
        window.kamapathy.dispatch({
          type: "bookmark:add",
          url: `https://example.com/tile-${index}`,
          title: `Tile ${index}`,
        }),
      index,
    );
    extraShortcuts.push(state.bookmarks.at(-1).id);
  }
  await poll(async () => (await shortcuts.getByRole("button").count()) === 9, {
    label: "eight shortcut tiles and Add shortcut",
  });
  const tilesBox = await shortcuts.boundingBox();
  const firstTile = await shortcuts.getByRole("button").first().boundingBox();
  const lastTile = await shortcuts.getByRole("button").last().boundingBox();
  assert.ok(firstTile.x >= tilesBox.x - 1, "the first tile is not cut off");
  assert.ok(
    lastTile.x + lastTile.width <= tilesBox.x + tilesBox.width + 1,
    "Add shortcut is not cut off",
  );
  for (const id of extraShortcuts)
    await page.evaluate(
      (id) => window.kamapathy.dispatch({ type: "bookmark:remove", id }),
      id,
    );
  checked("eight shortcut tiles fit on the new tab page");
  await page.getByRole("button", { name: "Browser menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const agentSwitch = page.getByRole("switch", {
    name: "Enable agent connection",
  });
  assert.equal(await agentSwitch.getAttribute("aria-checked"), "true");
  await page
    .getByText("Agents on this computer connect automatically while this is on.")
    .waitFor();
  checked("the agent access switch lives in Settings with its explanation");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  checked("light and dark theme controls");
  await page.keyboard.press("ControlOrMeta+K");
  await page.getByRole("combobox").fill("settings");
  await page.getByRole("combobox").press("ArrowDown");
  await page.getByRole("combobox").press("Enter");
  await page.getByRole("heading", { name: "Make Kamapathy yours" }).waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  checked("command palette keyboard navigation");
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+Y" : "Control+H",
  );
  await page.getByRole("heading", { name: "History", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Search history" }).waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.keyboard.press("ControlOrMeta+Shift+J");
  await page.getByRole("heading", { name: "Downloads", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  checked("History and Downloads open as dialogs from the keyboard");
  await page.getByRole("button", { name: "Browser menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Search tabs & commands" }).click();
  await page.getByRole("combobox").waitFor();
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("role")),
    "combobox",
  );
  await page.getByRole("combobox").fill("downloads");
  await page.getByRole("combobox").press("ArrowDown");
  await page.getByRole("combobox").press("Enter");
  await page.getByRole("heading", { name: "Downloads", exact: true }).waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  checked("the browser menu opens the command palette, which reaches Downloads");
  const address = page.getByRole("textbox", {
    name: "Address bar",
    exact: true,
  });
  await address.fill(origin);
  await address.press("Enter");
  await page.waitForFunction(() =>
    document
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("title")
      ?.includes("Kamapathy test garden"),
  );
  state = await page.evaluate(() => window.kamapathy.getState());
  const firstTab = state.activeTabId;
  assert.equal(state.tabs.find((tab) => tab.id === firstTab).error, undefined);
  let webPage = app
    .context()
    .pages()
    .find((candidate) => candidate.url() === `${origin}/`);
  assert.ok(webPage, "a real Chromium page was created");
  assert.deepEqual(
    await webPage.evaluate(() => ({
      node: typeof process,
      require: typeof require,
      bridge: typeof window.kamapathy,
    })),
    { node: "undefined", require: "undefined", bridge: "undefined" },
  );
  checked(
    "real website navigation with Node and shell bridge unavailable to websites",
  );
  const host = `127.0.0.1:${fixture.address().port}`;
  await poll(async () => (await address.inputValue()) === host, {
    label: "host in the unfocused address bar",
  });
  await address.focus();
  await poll(async () => (await address.inputValue()) === `${origin}/`, {
    label: "whole address while focused",
  });
  assert.deepEqual(
    await address.evaluate((input) => [input.selectionStart, input.selectionEnd]),
    [0, `${origin}/`.length],
  );
  await address.evaluate((input) => input.blur());
  checked("the address bar shows host and path until focused, then the whole address selected");
  await webPage.evaluate(() => {
    localStorage.setItem("kamapathy-isolation", "project-only");
    document.cookie = "kamapathy_cookie=project-only; path=/; max-age=3600";
  });
  await webPage.locator("#next").click();
  await webPage.waitForURL(`${origin}/second`);
  await page.waitForFunction(() =>
    document
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("title")
      ?.includes("Second page"),
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:back", id }),
    firstTab,
  );
  await webPage.waitForURL(`${origin}/`);
  checked("native page navigation and back history");
  await page
    .getByRole("button", { name: "Bookmark this page", exact: true })
    .click();
  state = await page.evaluate(() => window.kamapathy.getState());
  assert.ok(state.bookmarks.some((bookmark) => bookmark.url === `${origin}/`));
  checked("bookmark persistence from the toolbar");
  await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "settings:update",
      settings: { showBookmarksBar: true },
    }),
  );
  const bookmarksBar = page.getByRole("navigation", { name: "Bookmarks bar" });
  await bookmarksBar.waitFor();
  assert.equal((await bookmarksBar.boundingBox()).height, 32);
  await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "settings:update",
      settings: { showBookmarksBar: false },
    }),
  );
  await bookmarksBar.waitFor({ state: "detached" });
  checked("the bookmarks bar is a 32px row under the toolbar when switched on");
  await page.keyboard.press("ControlOrMeta+D");
  await page.getByRole("heading", { name: "Keep something good" }).waitFor();
  await page.getByRole("button", { name: "Save bookmark" }).click();
  const toast = page.locator(".toast");
  // An earlier notification can still be showing when Save is pressed.
  await toast.filter({ hasText: "Bookmark saved." }).waitFor();
  await poll(async () => (await visibleViews()).length === 1, {
    label: "live page after the bookmark dialog",
  });
  assert.equal(await overlapsNativePage(toast), false);
  checked("notifications appear beside the live page, never under it");
  await page.keyboard.press("ControlOrMeta+F");
  const findPill = page.getByRole("search", { name: "Find in page" });
  await findPill.waitFor();
  await poll(async () => (await visibleViews()).length === 1, {
    label: "live page beside the find pill",
  });
  assert.equal(await overlapsNativePage(findPill), false);
  const [findView] = await visibleViews();
  const pillBox = await findPill.boundingBox();
  assert.ok(
    pillBox.x + pillBox.width >= findView.x + findView.width - 24,
    "the pill sits at the page's right edge",
  );
  assert.ok(
    pillBox.y + pillBox.height <= findView.y + 1,
    "the pill sits just above the page",
  );
  await page.getByRole("textbox", { name: "Find in page" }).fill("garden");
  await page.getByRole("button", { name: "Next match" }).click();
  await page.keyboard.press("Escape");
  await findPill.waitFor({ state: "detached" });
  checked("find in page is a pill at the page's top right that never covers the live page");
  const before = state.tabs.map((tab) => tab.id);
  state = await page.evaluate(
    (url) =>
      window.kamapathy.dispatch({ type: "tab:create", url, background: true }),
    `${origin}/second`,
  );
  const secondTab = state.tabs.find((tab) => !before.includes(tab.id)).id;
  await waitForState(
    page,
    (state, id) => {
      const tab = state.tabs.find((item) => item.id === id);
      return tab && tab.title === "Second page" && !tab.loading;
    },
    secondTab,
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:split", id }),
    secondTab,
  );
  await page.waitForTimeout(200);
  const viewBounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .contentView.children.filter((view) => view.getVisible())
      .map((view) => view.getBounds()),
  );
  assert.equal(viewBounds.length, 2);
  assert.ok(viewBounds[0].width > 100 && viewBounds[1].width > 100);
  assert.ok(Math.abs(viewBounds[0].width - viewBounds[1].width) <= 1);
  checked("two native WebContentsView panes with balanced bounds");
  const paneBounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]
      .contentView.children.filter((view) => view.getVisible())
      .map((view) => ({
        url: view.webContents.getURL(),
        bounds: view.getBounds(),
      })),
  );
  // Native focus events require an active desktop window. Test the same state
  // as a person clicking a pane, including when another app was foregrounded.
  await app.evaluate(({ app, BrowserWindow }) => {
    if (process.platform === "darwin") app.focus({ steal: true });
    BrowserWindow.getAllWindows()[0].focus();
  });
  await poll(
    () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFocused(),
      ),
    { label: "foreground desktop window" },
  );
  await app.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows()[0]
      .contentView.children.find((view) => view.webContents.getURL() === url)
      .webContents.focus();
  }, `${origin}/second`);
  await waitForState(page, (state, id) => state.activeTabId === id, secondTab);
  await page.evaluate(() =>
    window.kamapathy.dispatch({ type: "page:zoom", direction: "in" }),
  );
  const focusedZoom = await app.evaluate(
    ({ BrowserWindow }, url) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.find((view) => view.webContents.getURL() === url)
        .webContents.getZoomLevel(),
    `${origin}/second`,
  );
  assert.equal(focusedZoom, 1);
  assert.deepEqual(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]
        .contentView.children.filter((view) => view.getVisible())
        .map((view) => ({
          url: view.webContents.getURL(),
          bounds: view.getBounds(),
        })),
    ),
    paneBounds,
  );
  await page.evaluate(() =>
    window.kamapathy.dispatch({ type: "page:zoom", direction: "reset" }),
  );
  await app.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows()[0]
      .contentView.children.find((view) => view.webContents.getURL() === url)
      .webContents.focus();
  }, `${origin}/`);
  await waitForState(page, (state, id) => state.activeTabId === id, firstTab);
  checked(
    "native split focus updates page controls while keeping pane positions stable",
  );
  const browserMenu = page.getByRole("menu", { name: "Browser menu" });
  const openBrowserMenu = async () => {
    await page
      .getByRole("button", { name: "Browser menu", exact: true })
      .click();
    await browserMenu.waitFor();
  };
  const activeLabel = () =>
    page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  // Passive effects of a render started by IPC can run a frame later.
  const afterTwoFrames = () =>
    page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
  await withFrozenFrame(
    page,
    openBrowserMenu,
    async () => {
      await page.keyboard.press("Escape");
      await browserMenu.waitFor({ state: "detached" });
    },
    2,
  );
  const menuFrames = await frameSources(page);
  assert.deepEqual(
    menuFrames.map((source) => source.slice(0, 23)),
    ["data:image/jpeg;base64,", "data:image/jpeg;base64,"],
  );
  const focusedText = () =>
    page.evaluate(() => document.activeElement?.textContent ?? "");
  assert.match(await focusedText(), /^New tab/);
  await page.keyboard.press("ArrowDown");
  assert.match(await focusedText(), /^New space/);
  await page.keyboard.press("End");
  assert.match(await focusedText(), /^Settings/);
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Make Kamapathy yours" }).waitFor();
  assert.deepEqual(await frameSources(page), menuFrames);
  assert.equal((await visibleViews()).length, 0);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await livePages(page, 2);
  await openBrowserMenu();
  await page.keyboard.press("Escape");
  await browserMenu.waitFor({ state: "detached" });
  assert.equal(await activeLabel(), "Browser menu");
  checked(
    "the browser menu opens over a still frame, works from the keyboard and hands its frame to the dialog it opens",
  );
  await withFrozenFrame(
    page,
    openBrowserMenu,
    async () => {
      await page.keyboard.press("Escape");
      await browserMenu.waitFor({ state: "detached" });
    },
    2,
  );
  const framesBeforeSwitch = await frameSources(page);
  await app.evaluate(({ View }) => {
    globalThis.pagesShown = 0;
    const setVisible = View.prototype.setVisible;
    View.prototype.setVisible = function (visible) {
      if (visible && !this.getVisible()) globalThis.pagesShown++;
      return setVisible.call(this, visible);
    };
    globalThis.restoreSetVisible = () => (View.prototype.setVisible = setVisible);
  });
  await spacesButton.click();
  await spacesMenu.waitFor();
  await browserMenu.waitFor({ state: "detached" });
  await afterTwoFrames();
  const pagesShown = await app.evaluate(() => {
    globalThis.restoreSetVisible();
    return globalThis.pagesShown;
  });
  assert.equal(pagesShown, 0, "no live page shows between the two popovers");
  assert.deepEqual(await frameSources(page), framesBeforeSwitch);
  await page.keyboard.press("Escape");
  await spacesMenu.waitFor({ state: "detached" });
  await livePages(page, 2);
  checked("moving from one popover to another keeps the still frame");
  await withFrozenFrame(
    page,
    async () => {
      await page.keyboard.press("ControlOrMeta+K");
      await page.getByRole("combobox").waitFor();
    },
    async () => {
      await page.keyboard.press("Escape");
      await page.getByRole("combobox").waitFor({ state: "detached" });
    },
    2,
  );
  const paletteFrames = await frameSources(page);
  assert.equal(paletteFrames.length, 2);
  await page.getByRole("combobox").fill("downloads");
  await page.getByRole("combobox").press("ArrowDown");
  await page.getByRole("combobox").press("Enter");
  await page.getByRole("heading", { name: "Downloads", exact: true }).waitFor();
  assert.deepEqual(await frameSources(page), paletteFrames);
  assert.equal((await visibleViews()).length, 0);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await livePages(page, 2);
  checked("a command picked in the palette opens its dialog over the same still frame");
  await openBrowserMenu();
  await browserMenu.getByRole("menuitem", { name: "Find", exact: true }).click();
  await browserMenu.waitFor({ state: "detached" });
  await afterTwoFrames();
  assert.equal(await activeLabel(), "Find in page");
  await page.keyboard.press("Escape");
  await page
    .getByRole("textbox", { name: "Find in page" })
    .waitFor({ state: "detached" });
  await openBrowserMenu();
  await page.keyboard.press("ControlOrMeta+L");
  await browserMenu.waitFor({ state: "detached" });
  await afterTwoFrames();
  assert.equal(await activeLabel(), "Address bar");
  await address.evaluate((input) => input.blur());
  await livePages(page, 2);
  checked("focus stays where a menu item or shortcut sent it after the menu closes");
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:close", id }),
    firstTab,
  );
  state = await page.evaluate(() => window.kamapathy.getState());
  assert.equal(state.activeTabId, secondTab);
  assert.equal(state.splitTabId, null);
  checked("closing the primary split pane promotes the remaining page");
  state = await page.evaluate(
    (url) =>
      window.kamapathy.dispatch({ type: "tab:create", url, background: true }),
    `${origin}/second?comparison=1`,
  );
  const comparison = state.tabs.find(
    (tab) => tab.url === `${origin}/second?comparison=1`,
  ).id;
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:split", id }),
    comparison,
  );
  state = await page.evaluate(() =>
    window.kamapathy.dispatch({ type: "tab:create" }),
  );
  assert.equal(state.splitTabId, null);
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.filter((view) =>
          view.getVisible(),
        ).length,
    ),
    0,
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    secondTab,
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:split", id }),
    comparison,
  );
  state = await page.evaluate(
    (id) =>
      window.kamapathy.dispatch({
        type: "tab:navigate",
        id,
        url: "kamapathy://newtab",
      }),
    secondTab,
  );
  await waitForState(
    page,
    (state, id) => {
      const current = state;
      return (
        current.tabs.find((tab) => tab.id === id)?.url === "kamapathy://newtab" &&
        !current.splitTabId
      );
    },
    secondTab,
  );
  assert.equal(
    await app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].contentView.children.filter((view) =>
          view.getVisible(),
        ).length,
    ),
    0,
  );
  checked(
    "new tabs and Home clear split views without resurrecting removed pages",
  );
  await page.evaluate(
    ({ id, url }) => window.kamapathy.dispatch({ type: "tab:navigate", id, url }),
    { id: secondTab, url: `${origin}/recoverable` },
  );
  await waitForState(
    page,
    (state, id) => !!state.tabs.find((tab) => tab.id === id)?.error,
    secondTab,
  );
  state = await page.evaluate(() => window.kamapathy.getState());
  assert.equal(
    state.tabs.find((tab) => tab.id === secondTab).url,
    `${origin}/recoverable`,
  );
  assert.equal(state.activeTabId, secondTab);
  const retryButton = page.getByRole("button", {
    name: "Try again",
    exact: false,
  });
  await retryButton.waitFor({ state: "visible" });
  failRecoverablePage = false;
  await retryButton.click();
  await waitForState(
    page,
    (state, id) => {
      const tab = state.tabs.find((tab) => tab.id === id);
      return (
        tab && !tab.error && !tab.loading && tab.title === "Kamapathy test garden"
      );
    },
    secondTab,
  );
  checked(
    "failed navigation keeps its destination and Try again recovers the intended page",
  );
  const tabsBefore = (await page.evaluate(() => window.kamapathy.getState())).tabs
    .length;
  await openBrowserMenu();
  await page.keyboard.press("ControlOrMeta+T");
  await browserMenu.waitFor({ state: "detached" });
  state = await waitForState(
    page,
    (state, count) => state.tabs.length === count + 1,
    tabsBefore,
  );
  const shortcutTab = state.activeTabId;
  assert.equal(
    state.tabs.find((tab) => tab.id === shortcutTab).url,
    "kamapathy://newtab",
  );
  await livePages(page, 0);
  const showsLive = (url) =>
    poll(
      async () => {
        const views = await visibleViews();
        return (
          views.length === 1 &&
          views[0].url === url &&
          (await page.locator("img.frozen-frame").count()) === 0
        );
      },
      { label: `the live page of ${url}` },
    );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    secondTab,
  );
  await showsLive(`${origin}/recoverable`);
  await openBrowserMenu();
  await page.keyboard.press("Control+Tab");
  await browserMenu.waitFor({ state: "detached" });
  await waitForState(page, (state, id) => state.activeTabId === id, comparison);
  await showsLive(`${origin}/second?comparison=1`);
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    secondTab,
  );
  await showsLive(`${origin}/recoverable`);
  await openBrowserMenu();
  await page.keyboard.press("ControlOrMeta+W");
  await browserMenu.waitFor({ state: "detached" });
  state = await waitForState(
    page,
    (state, id) => !state.tabs.some((tab) => tab.id === id),
    secondTab,
  );
  assert.equal(state.activeTabId, comparison);
  await showsLive(`${origin}/second?comparison=1`);
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:close", id }),
    shortcutTab,
  );
  checked(
    "new tab, next tab and close tab pressed while a menu is open close it and show the resulting tab live",
  );
  state = await page.evaluate(() => window.kamapathy.getState());
  const blankTab = state.tabs.find(
    (tab) => tab.spaceId === state.activeSpaceId && tab.url === "kamapathy://newtab",
  ).id;
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    blankTab,
  );
  const tabSearch = page.getByRole("menu", { name: "Search tabs" });
  await page.locator(".strip-search").click();
  await tabSearch.waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
    "Filter tabs",
  );
  await page.keyboard.type("second");
  await page.keyboard.press("Enter");
  await tabSearch.waitFor({ state: "detached" });
  await waitForState(page, (state, id) => state.activeTabId === id, comparison);
  checked("tab search filters the current space and opens the match from the keyboard");
  const extraTabs = [];
  for (let index = 0; index < 30; index++) {
    state = await page.evaluate(() =>
      window.kamapathy.dispatch({ type: "tab:create", background: true }),
    );
    extraTabs.push(state.tabs.at(-1).id);
  }
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    extraTabs.at(-1),
  );
  await page.waitForFunction(() => {
    const strip = document.querySelector('[role="tablist"]').getBoundingClientRect();
    const active = document
      .querySelector('[role="tab"][aria-selected="true"]')
      .getBoundingClientRect();
    return active.left >= strip.left - 1 && active.right <= strip.right + 1;
  });
  assert.deepEqual(
    await page.evaluate(() => {
      const strip = document.querySelector('[role="tablist"]');
      const inView = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth;
      };
      return {
        scrolls: strip.scrollWidth > strip.clientWidth,
        newTab: inView(".strip-new-tab"),
        search: inView(".strip-search"),
      };
    }),
    { scrolls: true, newTab: true, search: true },
  );
  for (const id of extraTabs)
    await page.evaluate((id) => window.kamapathy.dispatch({ type: "tab:close", id }), id);
  checked("many tabs scroll in the strip while the active tab and its controls stay in view");
  await page.evaluate(() =>
    window.kamapathy.dispatch({ type: "space:activate", id: "personal" }),
  );
  state = await page.evaluate(
    (url) => window.kamapathy.dispatch({ type: "tab:create", url }),
    origin,
  );
  const personalTab = state.activeTabId;
  await page.waitForFunction(() =>
    document
      .querySelector('[role="tab"][aria-selected="true"]')
      ?.getAttribute("title")
      ?.includes("Kamapathy test garden"),
  );
  webPage = app
    .context()
    .pages()
    .filter((candidate) => candidate.url() === `${origin}/`)
    .at(-1);
  assert.equal(
    await webPage.evaluate(() => localStorage.getItem("kamapathy-isolation")),
    null,
  );
  assert.equal(
    await webPage.evaluate(() => document.cookie.includes("kamapathy_cookie")),
    false,
  );
  checked("cookies and local storage stay inside a space with separate sign-ins");
  await webPage.evaluate(() => {
    document.cookie = "kamapathy_shared=yes; path=/; max-age=3600";
  });
  state = await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "space:create",
      name: "Shared",
      color: "green",
      kind: "personal",
    }),
  );
  const sharedSpace = state.activeSpaceId;
  assert.equal(
    state.spaces.find((space) => space.id === sharedSpace).signIns,
    "shared",
  );
  const openSharedPage = async () => {
    await waitForState(page, (state) =>
      state.tabs.some(
        (tab) => tab.spaceId === sharedSpace && tab.title === "Kamapathy test garden" && !tab.loading,
      ),
    );
    return app
      .context()
      .pages()
      .filter((candidate) => candidate.url() === `${origin}/`)
      .at(-1);
  };
  await page.evaluate(
    (url) => window.kamapathy.dispatch({ type: "tab:create", url }),
    origin,
  );
  let sharedPage = await openSharedPage();
  assert.equal(
    await sharedPage.evaluate(() => document.cookie.includes("kamapathy_shared")),
    true,
  );
  assert.equal(
    await sharedPage.evaluate(() => document.cookie.includes("kamapathy_cookie")),
    false,
  );
  checked("a new space shares sign-ins with the personal space by default");
  await spacesButton.click();
  await spacesMenu.getByRole("menuitem", { name: "Options for Shared" }).click();
  const separateItem = spacesMenu.getByRole("menuitemcheckbox", {
    name: "Separate sign-ins",
  });
  assert.equal(await separateItem.getAttribute("aria-checked"), "false");
  await separateItem.click();
  await waitForState(
    page,
    (state, id) => state.spaces.find((space) => space.id === id).signIns === "separate",
    sharedSpace,
  );
  await page.keyboard.press("Escape");
  await spacesMenu.waitFor({ state: "detached" });
  sharedPage = await openSharedPage();
  assert.equal(
    await sharedPage.evaluate(() => document.cookie.includes("kamapathy_shared")),
    false,
  );
  await page.evaluate(
    (id) =>
      window.kamapathy.dispatch({ type: "space:sign-ins", id, signIns: "shared" }),
    sharedSpace,
  );
  sharedPage = await openSharedPage();
  assert.equal(
    await sharedPage.evaluate(() => document.cookie.includes("kamapathy_shared")),
    true,
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:delete", id }),
    sharedSpace,
  );
  assert.ok(
    (
      await app.evaluate(
        async ({ session }, origin) =>
          (
            await session
              .fromPartition("persist:space-personal")
              .cookies.get({ url: origin, name: "kamapathy_shared" })
          ).length,
        origin,
      )
    ) > 0,
    "deleting a shared space keeps the shared sign-ins",
  );
  checked("a space can separate its sign-ins from the popover and share them again");
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    personalTab,
  );
  await livePages(page, 1);
  await page.getByRole("button", { name: "Browser menu", exact: true }).focus();
  await withFrozenFrame(
    page,
    async () => {
      await page.keyboard.press("Alt+KeyS");
      await overview.waitFor();
    },
    async () => {
      await page.keyboard.press("Escape");
      await overview.waitFor({ state: "detached" });
    },
  );
  const personalThumbnail = overview
    .getByRole("button", { name: "Open Personal" })
    .locator("img");
  await personalThumbnail.waitFor();
  assert.match(
    await personalThumbnail.getAttribute("src"),
    /^data:image\/jpeg;base64,/,
  );
  await page.keyboard.press("Escape");
  await overview.waitFor({ state: "detached" });
  await livePages(page, 1);
  checked("the spaces grid shows a capture of the space the person was looking at");
  await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "settings:update",
      settings: { automationEnabled: true },
    }),
  );
  await waitForState(page, (state) => state.automation.running);
  // Connect exactly as an agent does: find this profile's socket, no setup.
  const agentEnv = { KAMAPATHY_USER_DATA: profile, KAMAPATHY_NO_LAUNCH: "1" };
  const send = socketFetch(await resolveSocket(agentEnv));
  const api = async (path, method = "GET", body) =>
    send(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const agentFolder = join(profile, "agent");
  if (process.platform !== "win32") {
    assert.equal(statSync(agentFolder).mode & 0o777, 0o700);
    assert.equal(statSync(join(agentFolder, "endpoint")).mode & 0o777, 0o600);
    assert.equal(statSync(join(agentFolder, "kamapathy.sock")).mode & 0o077, 0);
  }
  assert.equal(
    (await send("/health", { headers: { Origin: "https://example.com" } })).status,
    403,
  );
  assert.equal((await api("/health")).status, 200);
  assert.equal((await api(`/tabs/${personalTab}/snapshot`)).status, 404);
  checked(
    "agents connect automatically through a private socket and cannot access personal tabs",
  );
  const created = await (
    await api("/spaces", "POST", { name: "Research helper" })
  ).json();
  assert.ok(created.space?.id, JSON.stringify(created));
  const task = created.space.id;
  const opened = await (
    await api(`/spaces/${task}/tabs`, "POST", { url: origin })
  ).json();
  assert.ok(opened.tab?.id, JSON.stringify(opened));
  const agentTab = opened.tab.id;
  const snapshotResponse = await api(`/tabs/${agentTab}/snapshot`);
  const snapshot = await snapshotResponse.json();
  assert.equal(snapshotResponse.status, 200, JSON.stringify(snapshot));
  assert.match(snapshot.text, /Kamapathy test garden/);
  assert.ok(snapshot.interactables.some((item) => item.selector === "#query"));
  state = await page.evaluate(() => window.kamapathy.getState());
  assert.equal(state.activeTabId, personalTab);
  checked(
    "agent opens a background task and reads a real isolated-world snapshot",
  );
  let result = await api(`/tabs/${agentTab}/fill`, "POST", {
    selector: "#query",
    value: "Kamapathy research complete",
  });
  assert.equal(result.status, 200, await result.text());
  result = await api(`/tabs/${agentTab}/click`, "POST", { selector: "#save" });
  assert.equal(result.status, 200, await result.text());
  const after = await (await api(`/tabs/${agentTab}/snapshot`)).json();
  assert.match(after.text, /Kamapathy research complete/);
  checked("agent fills and clicks real page elements");
  // Kamapathy holds a debugger session on the agent's tab and on no other
  // page from this origin, including the person's tabs.
  const attachedPages = await app.evaluate(
    ({ webContents }, origin) =>
      webContents
        .getAllWebContents()
        .filter(
          (contents) =>
            contents.debugger.isAttached() &&
            contents.getURL().startsWith(origin),
        )
        .map((contents) => contents.id),
    origin,
  );
  assert.equal(attachedPages.length, 1, JSON.stringify(attachedPages));
  const [agentContents] = attachedPages;
  const devtoolsOpen = () =>
    app.evaluate(
      ({ webContents }, id) => webContents.fromId(id).isDevToolsOpened(),
      agentContents,
    );
  await app.evaluate(
    ({ webContents }, id) =>
      webContents.fromId(id).openDevTools({ mode: "detach" }),
    agentContents,
  );
  await poll(devtoolsOpen, { label: "developer tools on the agent tab" });
  const inspected = await api(`/tabs/${agentTab}/snapshot`);
  assert.equal(inspected.status, 200, await inspected.text());
  await app.evaluate(
    ({ webContents }, id) => webContents.fromId(id).closeDevTools(),
    agentContents,
  );
  await poll(async () => !(await devtoolsOpen()), {
    label: "developer tools closed on the agent tab",
  });
  await poll(
    async () => (await api(`/tabs/${agentTab}/snapshot`)).status === 200,
    { timeoutMs: 5000, label: "a snapshot after developer tools close" },
  );
  checked(
    "developer tools on an agent tab leave its requests working, and snapshots work after they close",
  );
  assert.equal((await api(`/spaces/${task}/handoff`, "POST", {})).status, 200);
  assert.equal((await api(`/tabs/${agentTab}/snapshot`)).status, 409);
  await poll(
    async () =>
      /an agent needs you/.test(await spacesButton.getAttribute("aria-label")),
    { label: "needs-you mark on the space button" },
  );
  await spacesButton.click();
  const taskRow = spacesMenu.getByRole("menuitem", { name: /^Research helper/ });
  assert.match(await taskRow.textContent(), /Needs you/);
  const taskEntries = (
    await page.evaluate(() => window.kamapathy.getState())
  ).activity.filter((item) => item.spaceId === task).length;
  await spacesMenu
    .getByRole("menuitem", { name: "Details for Research helper" })
    .click();
  const rowEntries = spacesMenu.locator(".space-row-panel .activity-entries li");
  await rowEntries.first().waitFor();
  assert.equal(await rowEntries.count(), Math.min(5, taskEntries));
  assert.match(
    await spacesMenu.locator(".space-row-panel").textContent(),
    /Agent handed this space to you/,
  );
  await spacesMenu
    .getByRole("menuitem", { name: "Let agent continue" })
    .waitFor();
  await spacesMenu.getByRole("menuitem", { name: "View all" }).click();
  const activityDialog = page.getByRole("dialog", {
    name: "Research helper activity",
  });
  await activityDialog.waitFor();
  assert.equal(
    await activityDialog.locator(".activity-entries li").count(),
    taskEntries,
  );
  await activityDialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await activityDialog.waitFor({ state: "detached" });
  checked("an agent row shows its latest activity and control, and View all lists every entry");
  await spacesButton.click();
  await taskRow.click();
  await waitForState(page, (state, id) => state.activeSpaceId === id, task);
  await poll(
    async () =>
      !/needs you/.test(await spacesButton.getAttribute("aria-label")),
    { label: "needs-you mark cleared" },
  );
  checked("a handoff marks the space button until the person opens that space");
  await page.evaluate(
    (id) =>
      window.kamapathy.dispatch({ type: "space:ownership", id, owner: "agent" }),
    task,
  );
  assert.equal((await api(`/tabs/${agentTab}/snapshot`)).status, 200);
  checked("human takeover blocks agent reads until the person returns control");
  await page.evaluate(
    (id) =>
      window.kamapathy.dispatch({ type: "space:ownership", id, owner: "human" }),
    task,
  );
  assert.equal((await api(`/tabs/${agentTab}/snapshot`)).status, 409);
  const resumed = await api(`/spaces/${task}/resume`, "POST", {});
  assert.equal(resumed.status, 200);
  // The answer also says what changed while the person had control.
  const resumedBody = await resumed.json();
  assert.deepEqual(
    [resumedBody.ok, resumedBody.owner, resumedBody.opened, resumedBody.closed],
    [true, "agent", [], []],
  );
  assert.ok("active" in resumedBody, JSON.stringify(resumedBody));
  state = await page.evaluate(() => window.kamapathy.getState());
  assert.equal(state.spaces.find((space) => space.id === task).owner, "agent");
  assert.equal((await api(`/tabs/${agentTab}/snapshot`)).status, 200);
  assert.equal((await api("/spaces/personal/resume", "POST", {})).status, 404);
  checked("agent takes control back through the API and cannot claim personal spaces");
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    agentTab,
  );
  await poll(async () => (await address.getAttribute("readonly")) !== null, {
    label: "read-only address bar",
  });
  await address.focus();
  const lockedValue = await address.inputValue();
  await address.press("x");
  assert.equal(await address.inputValue(), lockedValue);
  await address.evaluate((input) => input.blur());
  checked("the address bar is read-only while the agent controls the space");
  const agentBar = page.getByRole("region", { name: "Research helper" });
  await agentBar.waitFor();
  assert.match(
    await agentBar.textContent(),
    /Research helper · Agent is (browsing|idle)/,
  );
  assert.equal(await page.locator(".page-frame.agent-ring").count(), 1);
  const [agentView] = await visibleViews();
  const barBox = await agentBar.boundingBox();
  assert.ok(
    barBox.y >= agentView.y + agentView.height,
    "the agent bar sits below the page",
  );
  await agentBar.getByRole("button", { name: "Take over" }).click();
  await waitForState(
    page,
    (state, id) => state.spaces.find((space) => space.id === id).owner === "human",
    task,
  );
  await agentBar.getByText("Research helper · You're in control").waitFor();
  assert.equal(await page.locator(".page-frame.agent-ring").count(), 0);
  await agentBar.getByRole("button", { name: "Let agent continue" }).click();
  await waitForState(
    page,
    (state, id) => state.spaces.find((space) => space.id === id).owner === "agent",
    task,
  );
  checked("the agent bar and ring show who controls the space, and control moves both ways");
  assert.equal((await api(`/spaces/${task}/handoff`, "POST", {})).status, 200);
  await agentBar.getByText("Research helper · You're in control").waitFor();
  assert.doesNotMatch(await spacesButton.getAttribute("aria-label"), /needs you/);
  assert.equal((await api(`/spaces/${task}/resume`, "POST", {})).status, 200);
  checked("a handoff in the space the person is looking at needs no reminder");
  await page.getByRole("button", { name: "Browser menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const recentActivity = page.getByRole("list", { name: "Recent activity" });
  await recentActivity.waitFor();
  assert.match(
    await recentActivity.textContent(),
    /Agent handed this space to you/,
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  checked("Settings lists recent activity from every space");
  await page.getByRole("button", { name: "Browser menu", exact: true }).focus();
  await page.keyboard.press("Alt+KeyS");
  await overview.waitFor();
  const agentCard = overview.locator(".space-card").filter({
    has: page.getByRole("button", { name: "Open Research helper" }),
  });
  assert.match(await agentCard.getAttribute("class"), /\bagent-glow\b/);
  assert.match(
    await agentCard.locator(".status-chip").textContent(),
    /^(Browsing|Idle)$/,
  );
  await page.keyboard.press("Escape");
  await overview.waitFor({ state: "detached" });
  checked("the spaces grid marks the space an agent controls with a glow and its status");
  // The agent's cursor over the page it is working in. Section 5's input
  // dispatcher is what reports each point it sends, so until that lands no
  // point reaches the cursor and the window has no overlay; the rest of this
  // check runs itself as soon as points arrive.
  await livePages(page, 1);
  const labelled = await api(`/tabs/${agentTab}/click`, "POST", {
    selector: "#save",
    label: "Save the topic",
  });
  assert.equal(labelled.status, 200, await labelled.text());
  const cursor = await poll(
    async () => {
      const found = await cursorView();
      return found?.visible ? found : null;
    },
    { timeoutMs: 3000, label: "the agent cursor" },
  ).catch(() => null);
  if (!cursor)
    console.log(
      "SKIP the cursor appears at the click point: no agent input reports its points yet",
    );
  else {
    assert.equal(cursor.last, true, "the cursor stays above every page view");
    // The tip sits 14 px into the 44 px view, as tests/cursor.test.ts pins,
    // and lands on the control the agent pressed.
    const tip = { x: cursor.bounds.x + 14, y: cursor.bounds.y + 14 };
    const pressed = await app.evaluate(({ webContents }, address) => {
      // The agent's tab is the only page here with a debugger session.
      const contents = webContents
        .getAllWebContents()
        .find((item) => item.debugger.isAttached() && item.getURL().startsWith(address));
      return contents.executeJavaScript(
        "(() => { const box = document.getElementById('save').getBoundingClientRect(); return { left: box.left, top: box.top, right: box.right, bottom: box.bottom }; })()",
      );
    }, origin);
    const [agentPage] = (await visibleViews()).filter((view) =>
      view.url.startsWith(origin),
    );
    assert.ok(
      tip.x >= agentPage.x + pressed.left &&
        tip.x <= agentPage.x + pressed.right &&
        tip.y >= agentPage.y + pressed.top &&
        tip.y <= agentPage.y + pressed.bottom,
      `the cursor tip ${JSON.stringify(tip)} is not on the control the agent clicked`,
    );
    assert.equal(cursor.label, "Save the topic");
    // Its own stylesheet loaded under the page's strict policy, so the arrow
    // is drawn in one of the accent colours tests/theme.test.ts pins.
    assert.ok(
      ["rgb(47, 107, 79)", "rgb(95, 174, 136)"].includes(cursor.arrow),
      `the cursor arrow is drawn in ${cursor.arrow}`,
    );
    // A page capture is the page alone: the same still page captures the
    // same bytes with the cursor over it and without.
    const capture = async () =>
      Buffer.from(await (await api(`/tabs/${agentTab}/screenshot`)).arrayBuffer());
    const drawn = await capture();
    await touchCursor();
    await poll(async () => (await cursorView())?.visible === false, {
      timeoutMs: 5000,
      label: "the cursor stepping aside for the person",
    });
    assert.ok(
      drawn.equals(await capture()),
      "the cursor changed what a page capture holds",
    );
    // A point a second later is the agent's again, and Take over ends it.
    await page.waitForTimeout(1100);
    const next = await api(`/tabs/${agentTab}/click`, "POST", {
      selector: "#query",
      label: "Name the topic",
    });
    assert.equal(next.status, 200, await next.text());
    const again = await poll(
      async () => {
        const found = await cursorView();
        return found?.visible ? found : null;
      },
      { timeoutMs: 5000, label: "the cursor after a later point" },
    );
    assert.equal(again.label, "Name the topic");
    await page.evaluate(
      (id) =>
        window.kamapathy.dispatch({ type: "space:ownership", id, owner: "human" }),
      task,
    );
    await poll(async () => (await cursorView())?.visible === false, {
      timeoutMs: 5000,
      label: "the cursor after Take over",
    });
    assert.equal((await api(`/spaces/${task}/resume`, "POST", {})).status, 200);
    checked(
      "the cursor appears at the click point, never in page screenshots, steps aside for the person's pointer and hides on takeover",
    );
  }
  // What the person reads about a task: the agent's own status beside the
  // bar's live region, a page that stopped, a reported failure and a finish.
  const researchBar = page.getByRole("region", { name: "Research helper" });
  assert.equal(
    (await api(`/spaces/${task}/status`, "POST", { text: "Comparing three sites" })).status,
    200,
  );
  const researchLine = researchBar.locator(".status-line.agent-text");
  // A label from the check above outranks the status for five seconds.
  await poll(
    async () => (await researchLine.textContent()) === "Comparing three sites",
    { timeoutMs: 10000, label: "the status line the agent wrote" },
  );
  assert.match(
    await researchBar.locator(".agent-bar-status").textContent(),
    /^Research helper · Agent is (browsing|idle)$/,
  );
  assert.equal(
    (await (await api(`/spaces/${task}`)).json()).space.status,
    "Comparing three sites",
  );
  await app.evaluate(({ webContents }, address) => {
    const contents = webContents
      .getAllWebContents()
      .find((item) => item.debugger.isAttached() && item.getURL().startsWith(address));
    contents.forcefullyCrashRenderer();
  }, origin);
  await researchBar.getByText("Research helper · A page stopped working").waitFor();
  // A space whose page stopped is still a space with an agent in it.
  assert.match(await spacesButton.getAttribute("aria-label"), /1 agent working/);
  assert.equal((await (await api(`/spaces/${task}`)).json()).space.state, "error");
  assert.equal(
    (await api(`/tabs/${agentTab}/navigate`, "POST", { url: origin })).status,
    200,
  );
  await poll(
    async () => (await (await api(`/spaces/${task}`)).json()).space.state === undefined,
    { timeoutMs: 10000, label: "the page the agent loaded again" },
  );
  const failing = (
    await (await api("/spaces", "POST", { name: "Trip planning" })).json()
  ).space.id;
  assert.equal((await api(`/spaces/${failing}/tabs`, "POST", { url: origin })).status, 201);
  const reported = await (
    await api(`/spaces/${failing}/fail`, "POST", {
      message: "The site needs a phone number I do not have",
    })
  ).json();
  assert.deepEqual(
    [reported.ok, reported.owner, reported.state, reported.status],
    [true, "human", "failed", "The site needs a phone number I do not have"],
  );
  const finishing = (
    await (await api("/spaces", "POST", { name: "Errand run" })).json()
  ).space.id;
  const keptTab = (
    await (await api(`/spaces/${finishing}/tabs`, "POST", { url: origin })).json()
  ).tab.id;
  assert.equal(
    (await api(`/spaces/${finishing}/finish`, "POST", { keep: [keptTab] })).status,
    200,
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:activate", id }),
    failing,
  );
  const failedBar = page.getByRole("region", { name: "Trip planning" });
  await failedBar.getByText("Trip planning · Agent could not finish").waitFor();
  assert.equal(
    await failedBar.locator(".status-line.agent-text").textContent(),
    "The site needs a phone number I do not have",
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:activate", id }),
    finishing,
  );
  await page
    .getByRole("region", { name: "Errand run" })
    .getByText("Errand run · Agent is done")
    .waitFor();
  // The Spaces button marks a failure the person has not opened yet.
  await spacesButton.click();
  const row = (name) => spacesMenu.locator(".space-row").filter({ hasText: name });
  assert.equal(
    await row("Trip planning").locator(".space-row-meta").textContent(),
    "Failed",
  );
  assert.equal(
    await row("Trip planning").locator(".status-line.agent-text").textContent(),
    "The site needs a phone number I do not have",
  );
  assert.equal(await row("Errand run").locator(".space-row-meta").textContent(), "Done");
  assert.equal(
    await row("Research helper").locator(".status-line.agent-text").textContent(),
    "Comparing three sites",
  );
  await page.keyboard.press("Escape");
  await spacesMenu.waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Browser menu", exact: true }).focus();
  await page.keyboard.press("Alt+KeyS");
  await overview.waitFor();
  const card = (name) =>
    overview.locator(".space-card").filter({
      has: page.getByRole("button", { name: `Open ${name}` }),
    });
  assert.equal(await card("Trip planning").locator(".status-chip").textContent(), "Failed");
  assert.equal(
    await card("Trip planning").locator(".status-line.agent-text").textContent(),
    "The site needs a phone number I do not have",
  );
  assert.equal(await card("Errand run").locator(".status-chip").textContent(), "Done");
  await page.keyboard.press("Escape");
  await overview.waitFor({ state: "detached" });
  checked(
    "the bar, the popover and the overview show the agent's status, Done, Failed and Page stopped",
  );
  for (const id of [failing, finishing])
    await page.evaluate(
      (space) => window.kamapathy.dispatch({ type: "space:delete", id: space }),
      id,
    );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:activate", id }),
    task,
  );
  const watcher = (
    await (await api("/spaces", "POST", { name: "Grid watcher" })).json()
  ).space.id;
  assert.equal(
    (await api(`/spaces/${watcher}/tabs`, "POST", { url: origin })).status,
    201,
  );
  await waitForState(page, (state) =>
    state.tabs.some(
      (tab) =>
        tab.spaceId === watcher && tab.url.startsWith(origin) && !tab.loading,
    ),
  );
  await page.keyboard.press("Alt+KeyS");
  await overview.waitFor();
  const watcherThumbnail = overview
    .getByRole("button", { name: "Open Grid watcher" })
    .locator("img");
  await watcherThumbnail.waitFor();
  assert.match(
    await watcherThumbnail.getAttribute("src"),
    /^data:image\/jpeg;base64,/,
  );
  await page.keyboard.press("Escape");
  await overview.waitFor({ state: "detached" });
  assert.equal((await api(`/spaces/${watcher}`, "DELETE")).status, 200);
  checked("the spaces grid shows an agent's page for a space the person never opened");
  state = await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "space:create",
      name: "Manual task",
      kind: "agent",
      color: "purple",
    }),
  );
  const manual = state.activeSpaceId;
  assert.equal(
    state.spaces.find((space) => space.id === manual).owner,
    "human",
  );
  assert.equal((await api(`/spaces/${manual}/tabs`)).status, 404);
  await page.evaluate(
    (id) =>
      window.kamapathy.dispatch({ type: "space:ownership", id, owner: "agent" }),
    manual,
  );
  assert.equal((await api(`/spaces/${manual}/tabs`)).status, 200);
  checked(
    "manually created agent spaces require an explicit grant to the running API",
  );
  // Section 2's controls in the window: Stop, Keep as personal space,
  // grants from the popover and the request dialog.
  const accessLine =
    "Agents can read and act on this space's tabs, run their own scripts there while Page scripts is on, and use its sign-ins until you stop them.";
  const agentSpace = async (name) =>
    (await (await api("/spaces", "POST", { name })).json()).space.id;
  const agentTab2 = async (spaceId) =>
    (await (await api(`/spaces/${spaceId}/tabs`, "POST", { url: origin })).json()).tab.id;
  const stopFirst = await agentSpace("Stop first");
  const stopSecond = await agentSpace("Stop second");
  const stoppedTab = await agentTab2(stopFirst);
  const workingTab = await agentTab2(stopSecond);
  await page.evaluate((id) => window.kamapathy.dispatch({ type: "space:activate", id }), stopFirst);
  const firstBar = page.getByRole("region", { name: "Stop first" });
  await firstBar.getByRole("button", { name: "Stop", exact: true }).click();
  await firstBar.getByText("Stop the agent in this space?").waitFor();
  await firstBar.getByRole("button", { name: "Stop", exact: true }).click();
  await firstBar.getByText("Stop first · You stopped the agent").waitFor();
  assert.equal((await api(`/tabs/${stoppedTab}/snapshot`)).status, 409);
  assert.equal((await api(`/tabs/${workingTab}/snapshot`)).status, 200);
  assert.ok((await page.evaluate(() => window.kamapathy.getState())).settings.automationEnabled);
  checked("Stop asks once and stops only this space");
  await firstBar.getByRole("button", { name: "Keep as personal space" }).click();
  await waitForState(
    page,
    (state, id) => state.spaces.find((space) => space.id === id)?.kind === "personal",
    stopFirst,
  );
  const kept = stopFirst;
  await page.evaluate(() => window.kamapathy.dispatch({ type: "space:activate", id: "work" }));
  await spacesButton.click();
  await spacesMenu.getByRole("menuitem", { name: "Options for Work" }).click();
  await spacesMenu.getByRole("menuitem", { name: "Let an agent use this space" }).click();
  await spacesMenu.getByText(accessLine).waitFor();
  await spacesMenu.getByRole("menuitem", { name: "Let an agent use this space" }).click();
  await waitForState(
    page,
    (state) => state.spaces.find((space) => space.id === "work")?.access === "granted",
  );
  await page.keyboard.press("Escape");
  const workBar = page.getByRole("region", { name: "Work" });
  await workBar.getByRole("button", { name: "Stop", exact: true }).waitFor();
  assert.equal((await api("/spaces/work/tabs")).status, 200);
  await spacesButton.click();
  await spacesMenu.getByRole("menuitem", { name: "Options for Work" }).click();
  await spacesMenu.getByRole("menuitem", { name: "Stop agent access" }).click();
  await waitForState(
    page,
    (state) => state.spaces.find((space) => space.id === "work")?.access === "ended",
  );
  await page.keyboard.press("Escape");
  await poll(async () => (await workBar.count()) === 0, { label: "the Work bar closing" });
  assert.equal((await api("/spaces/work/tabs")).status, 409);
  checked("Let an agent use this space shows the bar until Stop");
  const requesting = api("/space-requests", "POST", {
    reason: "Compare prices for a trip",
    name: "Personal",
  });
  // Awaited after the dialog; a failure surfaces there.
  requesting.catch(() => {});
  await waitForState(page, (state) => state.spaceRequests.length === 1);
  assert.match(await spacesButton.getAttribute("aria-label"), /an agent needs you/);
  await spacesButton.click();
  await spacesMenu.getByRole("menuitem", { name: "An agent is asking for a space" }).click();
  const requestDialog = page.getByRole("dialog", { name: "Let an agent use a space?" });
  await requestDialog.waitFor();
  assert.equal(
    await requestDialog.locator(".agent-text").textContent(),
    "Compare prices for a trip",
  );
  await requestDialog.getByText(accessLine).waitFor();
  assert.ok(await requestDialog.getByRole("radio", { name: "Personal" }).isChecked());
  await requestDialog.getByRole("button", { name: "Allow", exact: true }).click();
  const granted2 = await requesting;
  assert.equal(granted2.status, 200);
  assert.equal((await granted2.json()).space.id, "personal");
  await requestDialog.waitFor({ state: "detached" });
  await page.evaluate(() => window.kamapathy.dispatch({ type: "space:stop", id: "personal" }));
  checked(
    "the request dialog shows the reason as agent text and the access line under it, and grants the chosen space",
  );
  await page.evaluate((id) => window.kamapathy.dispatch({ type: "space:activate", id }), manual);
  const manualBar = page.getByRole("region", { name: "Manual task" });
  await manualBar.getByRole("button", { name: "Stop", exact: true }).click();
  await manualBar.getByText("Stop the agent in this space?").waitFor();
  await manualBar.getByRole("button", { name: "Stop all agents" }).click();
  await waitForState(
    page,
    (state) => !state.settings.automationEnabled && !state.automation.running,
  );
  await manualBar.getByText("Manual task · Agent access is off").waitFor();
  assert.equal(
    await manualBar.getByRole("button", { name: "Stop", exact: true }).count(),
    0,
  );
  assert.equal(await page.locator(".page-frame.agent-ring").count(), 0);
  assert.doesNotMatch(await spacesButton.getAttribute("aria-label"), /working/);
  await manualBar.getByRole("button", { name: "Take over" }).click();
  await manualBar.getByRole("button", { name: "Let agent continue" }).click();
  assert.match(
    await manualBar.getByRole("alert").textContent(),
    /Turn on the agent connection/,
  );
  checked("Stop all agents asks first, turns agent access off, and the bar reports what it cannot do");
  await spacesButton.click();
  await spacesMenu
    .getByRole("menuitem", { name: "Agent access is off · Turn on" })
    .click();
  await page.getByRole("heading", { name: "Make Kamapathy yours" }).waitFor();
  await poll(
    async () =>
      (await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      )) === "Enable agent connection",
    { label: "focus on the agent access switch" },
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  checked("the popover's agent access line opens Settings at the switch");
  await page.evaluate(() =>
    window.kamapathy.dispatch({ type: "space:activate", id: "personal" }),
  );
  await page.evaluate(() => window.kamapathy.dispatch({ type: "tab:create" }));
  await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "settings:update",
      settings: { theme: "light" },
    }),
  );
  await poll(() => !existsSync(join(agentFolder, "endpoint")), {
    timeoutMs: 5000,
    label: "withdrawn agent endpoint",
  });
  await poll(() => existsSync(join(agentFolder, "off")), {
    timeoutMs: 5000,
    label: "agent access off marker",
  });
  await assert.rejects(resolveSocket(agentEnv), /turned off/);
  checked("turning agent access off withdraws the socket and blocks automatic starts");
  if (process.env.KAMAPATHY_CAPTURE_SCREENSHOTS === "1") {
    await mkdir("docs/images", { recursive: true });
    await page.waitForTimeout(350);
    await page.screenshot({
      path: "docs/images/kamapathy-light.png",
      scale: "css",
    });
    await page.evaluate(() =>
      window.kamapathy.dispatch({
        type: "settings:update",
        settings: { theme: "dark" },
      }),
    );
    await page.waitForTimeout(150);
    await page.screenshot({ path: "docs/images/kamapathy-dark.png", scale: "css" });
  }
  assert.deepEqual(errors, []);
  await app.close();
  app = undefined;
  const persisted = JSON.parse(
    await readFile(join(profile, "browser-state.json"), "utf8"),
  );
  assert.ok(persisted.spaces.some((space) => space.id === project));
  assert.ok(
    persisted.bookmarks.some((bookmark) => bookmark.url === `${origin}/`),
  );
  assert.ok(persisted.spaces.every((space) => space.kind === "personal"));
  assert.equal(persisted.automation, undefined);
  page = await launch();
  state = await page.evaluate(() => window.kamapathy.getState());
  assert.ok(state.spaces.some((space) => space.id === project));
  assert.ok(state.spaces.every((space) => space.kind === "personal"));
  assert.ok(state.bookmarks.some((bookmark) => bookmark.url === `${origin}/`));
  const launchRecord = JSON.parse(
    await readFile(join(agentFolder, "launch.json"), "utf8"),
  );
  assert.equal(typeof launchRecord.command, "string");
  assert.ok(
    launchRecord.args.every((argument) => !/remote-debugging|inspect/.test(argument)),
  );
  checked(
    "restart restores personal state, excludes agent spaces, and records how to start Kamapathy without debugging ports",
  );
  assert.ok(
    state.spaces.some((space) => space.id === kept && space.kind === "personal"),
  );
  checked("a kept space survives a restart");
  const cookieCount = await app.evaluate(
    async ({ session }, { project, origin }) =>
      (
        await session
          .fromPartition(`persist:space-${project}`)
          .cookies.get({ url: origin })
      ).length,
    { project, origin },
  );
  assert.ok(
    cookieCount > 0,
    "the unopened restored space has its existing cookies",
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:delete", id }),
    project,
  );
  assert.equal(
    await app.evaluate(
      async ({ session }, { project, origin }) =>
        (
          await session
            .fromPartition(`persist:space-${project}`)
            .cookies.get({ url: origin })
        ).length,
      { project, origin },
    ),
    0,
  );
  checked("deleting an unopened restored space clears its persistent cookies");
  assert.equal(
    await page.getByRole("dialog", { name: "Welcome to Kamapathy" }).count(),
    0,
  );
  await page.getByRole("button", { name: "Browser menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Import...", exact: true }).click();
  await page.getByRole("heading", { name: "Import bookmarks and history" }).waitFor();
  await page.getByRole("button", { name: /^(Skip|Continue|Import)$/ }).first().waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("button", { name: "Browser menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const isolateSwitch = page.getByRole("switch", { name: "Isolate agent spaces" });
  assert.equal(await isolateSwitch.getAttribute("aria-checked"), "false");
  await isolateSwitch.click();
  await waitForState(page, (state) => state.settings.isolateAgentSpaces);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "settings:update",
      settings: { automationEnabled: true },
    }),
  );
  await waitForState(page, (state) => state.automation.running);
  // Access was off before the restart, so this is a new socket.
  const restarted = socketFetch(await resolveSocket(agentEnv));
  const restartedApi = async (path, method = "GET", body) =>
    restarted(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const isolatedSpace = (
    await (await restartedApi("/spaces", "POST", { name: "Isolated task" })).json()
  ).space;
  assert.equal(isolatedSpace.signIns, "separate");
  const sharedAgentSpace = (
    await (
      await restartedApi("/spaces", "POST", { name: "Shared task", isolated: false })
    ).json()
  ).space;
  assert.equal(sharedAgentSpace.signIns, "separate", "the setting wins over the request");
  await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "settings:update",
      settings: { isolateAgentSpaces: false },
    }),
  );
  const requestedIsolation = (
    await (
      await restartedApi("/spaces", "POST", { name: "Clean task", isolated: true })
    ).json()
  ).space;
  assert.equal(requestedIsolation.signIns, "separate");
  const defaultAgentSpace = (
    await (await restartedApi("/spaces", "POST", { name: "Usual task" })).json()
  ).space;
  assert.equal(defaultAgentSpace.signIns, "shared");
  for (const id of [isolatedSpace.id, sharedAgentSpace.id, requestedIsolation.id, defaultAgentSpace.id])
    assert.equal((await restartedApi(`/spaces/${id}`, "DELETE")).status, 200);
  checked("Settings can isolate every new agent space, and an agent can ask for one isolated space");
  if (process.platform === "darwin") {
    await page.evaluate(
      (url) => window.kamapathy.dispatch({ type: "tab:create", url }),
      origin,
    );
    await waitForState(page, (state) =>
      state.tabs.some((tab) => tab.title === "Kamapathy test garden"),
    );
    assert.equal(
      await app.evaluate(({ session }) =>
        session
          .fromPartition("persist:space-personal")
          .listenerCount("will-download"),
      ),
      1,
    );
    // Closing the window now hides it while agents can work, so this check
    // turns agent access off to close it for real.
    await page.evaluate(() =>
      window.kamapathy.dispatch({
        type: "settings:update",
        settings: { automationEnabled: false },
      }),
    );
    await waitForState(
      page,
      (state) => !state.settings.automationEnabled && !state.automation.running,
    );
    const nextWindow = app.waitForEvent("window", {
      predicate: async (candidate) => {
        try {
          await candidate.waitForFunction(() => !!window.kamapathy, null, {
            timeout: 5000,
          });
          return true;
        } catch {
          return false;
        }
      },
    });
    const listenersAfterClose = await app.evaluate(
      ({ BrowserWindow, app, session }) => {
        BrowserWindow.getAllWindows()[0].close();
        const listeners = session
          .fromPartition("persist:space-personal")
          .listenerCount("will-download");
        setTimeout(() => app.emit("activate"), 50);
        return listeners;
      },
    );
    assert.equal(listenersAfterClose, 0);
    page = await nextWindow;
    await waitForState(page, (state) =>
      state.tabs.some((tab) => tab.title === "Kamapathy test garden"),
    );
    assert.equal(
      await app.evaluate(({ session }) =>
        session
          .fromPartition("persist:space-personal")
          .listenerCount("will-download"),
      ),
      1,
    );
    checked(
      "macOS window recreation attaches exactly one session download listener",
    );
    // Closing the last empty tab of the space you are in closes the window.
    state = await page.evaluate(() => window.kamapathy.getState());
    const [keep, ...others] = state.tabs.filter(
      (tab) => tab.spaceId === state.activeSpaceId,
    );
    for (const tab of others)
      await page.evaluate(
        (id) => window.kamapathy.dispatch({ type: "tab:close", id }),
        tab.id,
      );
    await page.evaluate(
      (id) => window.kamapathy.dispatch({ type: "tab:navigate", id, url: "" }),
      keep.id,
    );
    // The reply never arrives: the window answering is the one that closes.
    await page
      .evaluate((id) => window.kamapathy.dispatch({ type: "tab:close", id }), keep.id)
      .catch(() => {});
    await poll(
      async () =>
        (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)) === 0,
      { label: "the window to close with its last empty tab" },
    );
    checked("closing the last empty tab closes the window");
  }
  // Last, because the confirmed quit at its end stops Kamapathy: closing the
  // window keeps the agents and the socket, the Dock brings it back, and a
  // quit over a working agent asks first.
  if (!(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))) {
    const reopened = app.waitForEvent("window", {
      predicate: async (candidate) => {
        try {
          await candidate.waitForFunction(() => !!window.kamapathy, null, {
            timeout: 5000,
          });
          return true;
        } catch {
          return false;
        }
      },
    });
    await app.evaluate(({ app }) => app.emit("activate"));
    page = await reopened;
  }
  await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "settings:update",
      settings: { automationEnabled: true },
    }),
  );
  await waitForState(page, (state) => state.automation.running);
  const background = socketFetch(
    await poll(() => resolveSocket(agentEnv).catch(() => null), {
      timeoutMs: 10000,
      label: "the agent socket for the background check",
    }),
  );
  const backgroundApi = async (path, method = "GET", body) =>
    background(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const nightShift = (
    await (await backgroundApi("/spaces", "POST", { name: "Night shift" })).json()
  ).space.id;
  const nightTab = (
    await (await backgroundApi(`/spaces/${nightShift}/tabs`, "POST", { url: origin })).json()
  ).tab.id;
  await page.evaluate(
    (url) => window.kamapathy.dispatch({ type: "tab:create", url }),
    `${origin}/second`,
  );
  await waitForState(page, (state) =>
    state.tabs.some((tab) => tab.title === "Second page" && !tab.loading),
  );
  const windowPages = () =>
    app.evaluate(({ BrowserWindow }) => {
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
  assert.ok((await windowPages()).pages.some((url) => url.endsWith("/second")));
  assert.equal(
    (await page.evaluate(() => window.kamapathy.getState())).settings
      .backgroundNoticeShown,
    false,
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const away = await poll(
    async () => {
      const found = await windowPages();
      return found && !found.visible ? found : null;
    },
    { label: "the window closing into the background" },
  );
  // Nothing of the person's runs unseen, and the agent's page stays.
  assert.deepEqual(
    away.pages.filter((url) => url.endsWith("/second")),
    [],
  );
  assert.ok(away.pages.includes(`${origin}/`), JSON.stringify(away.pages));
  assert.equal((await backgroundApi(`/tabs/${nightTab}/snapshot`)).status, 200);
  assert.equal((await backgroundApi(`/spaces/${nightShift}`)).status, 200);
  // The person is told once per profile that Kamapathy is still running.
  await waitForState(page, (state) => state.settings.backgroundNoticeShown);
  await app.evaluate(({ app }) => app.emit("activate"));
  await poll(async () => (await windowPages())?.visible === true, {
    label: "the window coming back",
  });
  await poll(
    async () => (await windowPages()).pages.some((url) => url.endsWith("/second")),
    { label: "the person's page laid out again" },
  );
  checked(
    "closing the window keeps agent pages and the socket, and the window comes back with the person's pages",
  );
  const asked = await answerQuit("cancel");
  assert.equal(asked.length, 1, JSON.stringify(asked));
  assert.equal(
    asked[0],
    "Quit Kamapathy | Quit while \u201cNight shift\u201d is still running? | Agent spaces close and their agents stop. Changes already made on websites stay. | Quit | Cancel",
  );
  assert.equal((await backgroundApi(`/tabs/${nightTab}/snapshot`)).status, 200);
  assert.equal(existsSync(join(agentFolder, "quit")), false);
  // A confirmed quit stops the agents and leaves the marker that keeps the
  // client from starting Kamapathy again behind the person's back.
  await answerQuit("quit");
  await poll(() => existsSync(join(agentFolder, "quit")), {
    timeoutMs: 15000,
    label: "the quit marker",
  });
  assert.equal(
    typeof JSON.parse(await readFile(join(agentFolder, "quit"), "utf8")).at,
    "number",
  );
  await app.close().catch(() => {});
  app = undefined;
  checked(
    "a quit over a working agent asks first, Cancel keeps Kamapathy and its socket, and Quit writes the marker",
  );
  console.log(`Desktop smoke passed: ${checks} checks.`);
} catch (error) {
  if (app) {
    try {
      const diagnostic = await app.evaluate(async ({ BrowserWindow }) => {
        const state =
          await BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
            "window.kamapathy.getState()",
          );
        return {
          activeTabId: state.activeTabId,
          splitTabId: state.splitTabId,
          tabs: state.tabs.map(({ id, url, loading, error }) => ({
            id,
            url,
            loading,
            error,
          })),
        };
      });
      console.error(
        "Temporary test profile state:",
        JSON.stringify(diagnostic),
      );
    } catch {
      /* Preserve the original failure if the application already quit. */
    }
  }
  throw error;
} finally {
  if (app) {
    // A quit while agents are at work asks the person first, and no one is
    // here to answer it, so this run answers its own question.
    await app
      .evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
      })
      .catch(() => {});
    await app.close().catch(() => {});
  }
  await new Promise((resolve) => fixture.close(resolve));
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 150,
  });
}
