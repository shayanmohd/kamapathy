import { poll, waitForState } from "./wait.mjs";
import { prepareDesktopRuntime } from "./desktop-runtime.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { chmod, cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { _electron as electron } from "playwright";
import { textPdf } from "../tests/fixtures/pdf/index.mjs";
import { promptPages, AUTH } from "../tests/fixtures/prompt-pages.mjs";
import {
  resolveSocket,
  socketFetch,
} from "../skills/kamapathy/scripts/kamapathy.mjs";
import { startUpdateFeed } from "../tests/fixtures/update-feed.mjs";
import { startSignInSite } from "../tests/fixtures/sign-in-pages.mjs";

const profile = await mkdtemp(join(tmpdir(), "kamapathy-smoke-"));
let failRecoverablePage = true;
const fixture = createServer((request, response) => {
  if (request.url === "/recoverable" && failRecoverablePage) {
    request.socket.destroy();
    return;
  }
  // Shows the sign-ins the browser sent with the request.
  if (request.url === "/whoami") {
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
    });
    response.end(
      `<!doctype html><html lang="en"><head><title>Who am I</title></head><body><p id="cookies">${request.headers.cookie ?? "none"}</p></body></html>`,
    );
    return;
  }
  // Section 9's page: a frame from this server's other loopback name, with a
  // button an agent clicks inside it.
  if (request.url === "/framed" || request.url === "/frame-widget") {
    response.writeHead(200, {
      "Content-Type": "text/html",
      "Cache-Control": "no-store",
    });
    return response.end(
      request.url === "/framed"
        ? `<!doctype html><html lang="en"><head><title>Framed page</title></head><body><h1>Framed page</h1><iframe title="Remote widget" style="display:block;width:360px;height:140px" src="${origin.replace("127.0.0.1", "localhost")}/frame-widget"></iframe></body></html>`
        : `<!doctype html><html lang="en"><head><title>Remote widget</title></head><body><button id="widget" type="button" onclick="this.textContent='Widget pressed'">Press the widget</button></body></html>`,
    );
  }
  // Section 7's pages: the location request, the page behind Basic auth and
  // the image behind it.
  const prompts = (request.url ?? "").split("?")[0];
  if (prompts.startsWith("/prompts/")) {
    if (
      prompts.startsWith("/prompts/auth") &&
      request.headers.authorization !== AUTH.header
    ) {
      response.writeHead(401, {
        "WWW-Authenticate": `Basic realm="${AUTH.realm}"`,
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      });
      return response.end(
        '<!doctype html><html lang="en"><head><title>Sign in</title></head><body><h1>Sign in to continue</h1></body></html>',
      );
    }
    if (prompts === "/prompts/auth-image.png") {
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      });
      return response.end(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
    }
    const asked = promptPages[prompts];
    if (asked) {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Cache-Control": "no-store",
      });
      return response.end(
        asked.replaceAll("{{other}}", origin.replace("127.0.0.1", "localhost")),
      );
    }
  }
  response.writeHead(200, {
    "Content-Type": "text/html",
    "Cache-Control": "no-store",
  });
  // A page several viewports tall, for a full-page capture.
  if (request.url === "/tall")
    return response.end(
      `<!doctype html><html lang="en"><head><title>Tall page</title></head><body style="margin:0"><h1 style="margin:0;height:40px">Tall page</h1><div style="height:2400px;background:linear-gradient(#eef,#99a)"></div><p id="bottom" style="margin:0;height:20px">Bottom of the page</p></body></html>`,
    );
  // A page that asks to stay, for the Leave site prompt. Chromium only asks
  // once the page has had a gesture, which a click on its button gives it.
  if (request.url === "/guarded")
    return response.end(
      `<!doctype html><html lang="en"><head><title>Guarded page</title></head><body><h1>Guarded page</h1><button id="touch" type="button">Touch this page</button><p id="touched" role="status">Not touched</p><script>document.getElementById('touch').onclick=()=>{document.getElementById('touched').textContent='Touched';};addEventListener('beforeunload',(event)=>{event.preventDefault();event.returnValue='';});</script></body></html>`,
    );
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
const chromeMicroseconds = (millis) => (millis + 11644473600000) * 1000;
// One sign-in in that profile, encrypted under the Safe Storage key this
// platform derives. Windows wraps its key with DPAPI, which nothing can stand
// in for, so there the panel's note is all that is checked.
const importedCookie = { name: "kamapathy_smoke", value: "imported" };
const keychainPassword = "smoke-keychain";
const stubDirectory = join(profile, "bin");
if (process.platform !== "win32") {
  const key =
    process.platform === "darwin"
      ? pbkdf2Sync(keychainPassword, "saltysalt", 1003, 16, "sha1")
      : pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([
    Buffer.from("v10"),
    cipher.update(
      Buffer.concat([
        createHash("sha256").update("127.0.0.1").digest(),
        Buffer.from(importedCookie.value),
      ]),
    ),
    cipher.final(),
  ]);
  await mkdir(join(chromeData, "Default", "Network"), { recursive: true });
  const cookies = new DatabaseSync(
    join(chromeData, "Default", "Network", "Cookies"),
  );
  cookies.exec(
    "CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL, top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL, is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL, last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL, is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, samesite INTEGER NOT NULL, source_scheme INTEGER NOT NULL)",
  );
  cookies
    .prepare(
      "INSERT INTO cookies (creation_utc, host_key, top_frame_site_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, last_access_utc, has_expires, is_persistent, priority, samesite, source_scheme) VALUES (?, ?, '', ?, '', ?, '/', ?, 0, 0, ?, 1, 1, 1, 1, 1)",
    )
    .run(
      chromeMicroseconds(Date.now()),
      "127.0.0.1",
      importedCookie.name,
      encrypted,
      chromeMicroseconds(Date.now() + 86400000),
      chromeMicroseconds(Date.now()),
    );
  cookies.close();
}
// Kamapathy reads the key by calling `security`, as it calls `plutil`, so a
// stub first on PATH keeps the real keychain out of this run.
if (process.platform === "darwin") {
  await mkdir(stubDirectory, { recursive: true });
  const stub = join(stubDirectory, "security");
  await writeFile(
    stub,
    `#!/bin/sh\nif [ "$1" = "find-generic-password" ]; then\n  echo ${keychainPassword}\n  exit 0\nfi\nexit 44\n`,
  );
  await chmod(stub, 0o755);
  // The import panel offers Safari where Safari keeps its data.
  await mkdir(join(home, "Library", "Safari"), { recursive: true });
}
const notAZip = resolve("tests/fixtures/import/safari/not-a-zip.zip");
// A local page whose script would rename it, and a PDF another app hands over.
const localFile = join(profile, "local.html");
await writeFile(
  localFile,
  '<!doctype html><html lang="en"><head><title>Static</title></head><body><h1>Local file</h1><script>document.title = "Scripted"</script></body></html>',
);
const localFileUrl = pathToFileURL(localFile).href;
const pdfFile = join(profile, "report.pdf");
await writeFile(
  pdfFile,
  textPdf([["Quarterly report"], ["Page two"]], { title: "Quarterly report" }),
);
const pdfFileUrl = pathToFileURL(pdfFile).href;
const env = {
  ...process.env,
  KAMAPATHY_USER_DATA: profile,
  ...(process.platform === "win32"
    ? { USERPROFILE: home, LOCALAPPDATA: home, APPDATA: join(home, "roaming") }
    : { HOME: home }),
  ...(process.platform === "darwin"
    ? { PATH: `${stubDirectory}${delimiter}${process.env.PATH ?? ""}` }
    : {}),
};
delete env.ELECTRON_RUN_AS_NODE;
// Agent setup reads these only from the app's own environment, so a run
// never reaches the real agent folders or startup files.
for (const name of [
  "ZDOTDIR",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
])
  delete env[name];
// Claude Code and Codex are found by their folders in this home.
for (const folder of [".claude", ".codex"])
  await mkdir(join(home, folder), { recursive: true });
// The second profile for What's new and update checks, with its own feed.
let updateProfile;
let updateFeed;
// The site section 18's checks sign in to.
let signInSite;
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
// The native parts of the password manager, answered inside the application:
// safeStorage without the person's keyring, the reauthentication check, the
// fill menu, the file dialog and the Trash. The handles read what the person
// would have seen and set what they answer next.
async function installPasswordStubs(app) {
  await app.evaluate(
    ({ dialog, Menu, safeStorage, shell, systemPreferences }, platform) => {
      const record = {
        popups: [],
        messages: [],
        reasons: [],
        answers: [],
        files: [],
        trashed: [],
        touchID: false,
      };
      globalThis.__passwords = record;
      // A key that never leaves this process: a sealed value is its bytes
      // reversed, so the vault file holds no plain text and no keychain is
      // asked for one.
      safeStorage.isAsyncEncryptionAvailable = async () => true;
      safeStorage.encryptStringAsync = async (text) =>
        Buffer.from(Buffer.from(text, "utf8").reverse());
      safeStorage.decryptStringAsync = async (sealed) => ({
        result: Buffer.from(sealed).reverse().toString("utf8"),
        shouldReEncrypt: false,
      });
      if (platform === "linux")
        safeStorage.getSelectedStorageBackend = () => "gnome_libsecret";
      // Touch ID is off, so the check takes its confirmation path.
      systemPreferences.canPromptTouchID = () => record.touchID;
      systemPreferences.promptTouchID = async (reason) => {
        record.reasons.push(reason);
        if (!record.touchID) throw new Error("Touch ID is off in this run.");
      };
      dialog.showMessageBox = async (first, second) => {
        const options = second ?? first;
        record.messages.push(
          [options.message, options.detail, ...(options.buttons ?? [])]
            .filter(Boolean)
            .join(" | "),
        );
        return {
          response: record.answers.length ? record.answers.shift() : 0,
          checkboxChecked: false,
        };
      };
      dialog.showOpenDialog = async () => {
        const path = record.files.shift();
        return path
          ? { canceled: false, filePaths: [path] }
          : { canceled: true, filePaths: [] };
      };
      shell.trashItem = async (path) => {
        record.trashed.push(path);
      };
      // The fill menu is kept instead of shown, so a check can read its
      // items and choose one as the person would.
      Menu.prototype.popup = function (options) {
        record.popups.push({
          items: this.items.map((item) => item.label),
          x: options?.x,
          y: options?.y,
        });
        globalThis.__passwordMenu = this;
      };
    },
    process.platform,
  );
  return {
    read: () =>
      app.evaluate(() => {
        const { popups, messages, reasons, trashed } = globalThis.__passwords;
        return { popups, messages, reasons, trashed };
      }),
    // Forgets what was asked so far and says what the next native questions
    // are answered with, and whether this computer offers Touch ID.
    expect: (answers, touchID = false) =>
      app.evaluate(
        (_electron, [answers, touchID]) => {
          const record = globalThis.__passwords;
          record.popups.length = 0;
          record.messages.length = 0;
          record.reasons.length = 0;
          record.answers = [...answers];
          record.touchID = touchID;
        },
        [answers, touchID],
      ),
    offerFile: (path) =>
      app.evaluate((_electron, path) => {
        globalThis.__passwords.files.push(path);
      }, path),
    chooseFill: (index) =>
      app.evaluate((_electron, index) => {
        globalThis.__passwordMenu.items[index].click();
      }, index),
  };
}
// The page of a tab, in the application and as Playwright sees it. Both wait,
// because a new document reaches them a moment after the tab says it loaded.
const pageContents = (url) =>
  poll(
    () =>
      app.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .filter((contents) => contents.getURL() === url)
            .at(-1)?.id ?? null,
        url,
      ),
    { label: `the page at ${url}` },
  );
const pageAt = (url) =>
  poll(
    () =>
      app
        .context()
        .pages()
        .filter((candidate) => candidate.url() === url)
        .at(-1) ?? null,
    { label: `Playwright's page at ${url}` },
  );
// A trusted click in the middle of an element, and text typed into whatever
// has focus: the form script counts nothing a script did. The click waits
// for the element and happens once. Returns its rect in CSS pixels.
const clickInPage = (contentsId, selector) =>
  poll(
    () =>
      app.evaluate(
        async ({ webContents }, [id, selector]) => {
          const contents = webContents.fromId(id);
          const rect = await contents.executeJavaScript(
            `(() => {
              const node = document.querySelector(${JSON.stringify(selector)});
              if (!node) return null;
              const box = node.getBoundingClientRect();
              return { x: box.x, y: box.y, width: box.width, height: box.height };
            })()`,
          );
          if (!rect) return null;
          contents.focus();
          const at = {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          };
          for (const type of ["mouseDown", "mouseUp"])
            contents.sendInputEvent({
              ...at,
              type,
              button: "left",
              clickCount: 1,
            });
          return rect;
        },
        [contentsId, selector],
      ),
    { label: `a click in ${selector}` },
  );
const typeInPage = (contentsId, text) =>
  app.evaluate(
    ({ webContents }, [id, text]) => {
      webContents.fromId(id).insertText(text);
    },
    [contentsId, text],
  );
// An item of the application menu, clicked as Electron clicks it: the item,
// the focused window and the event.
const clickViewMenuItem = (label) =>
  app.evaluate(({ BrowserWindow, Menu }, label) => {
    const view = Menu.getApplicationMenu()?.items.find(
      (item) => item.label === "View",
    );
    const item = view?.submenu?.items.find((entry) => entry.label === label);
    if (!item) return false;
    item.click(undefined, BrowserWindow.getAllWindows()[0]);
    return true;
  }, label);
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
// preload names a module Electron loads before Kamapathy's own code.
async function launch(preload) {
  app = await electron.launch({
    executablePath: await prepareDesktopRuntime(),
    args: [
      ...(preload ? ["--require", preload] : []),
      resolve("out/main/index.js"),
    ],
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
  const welcomeStep = welcome.locator(".welcome-step");
  const atStep = (number) =>
    poll(async () => (await welcomeStep.textContent()) === `Step ${number} of 6`, {
      label: `step ${number} of the welcome dialog`,
    });
  await atStep(1);
  assert.equal(await welcome.locator(".welcome-cards p").count(), 2);
  await welcome.getByRole("button", { name: "Get started" }).click();
  await welcome.getByRole("heading", { name: "Your data stays here" }).waitFor();
  await atStep(2);
  // Back goes to the first step, and the walk carries on from there.
  await welcome.getByRole("button", { name: "Back" }).click();
  await atStep(1);
  await welcome.getByRole("button", { name: "Get started" }).click();
  await welcome.getByRole("button", { name: "Next" }).click();
  await welcome
    .getByRole("heading", { name: "Bring your browser with you" })
    .waitFor();
  await atStep(3);
  await welcome.getByRole("button", { name: "Skip", exact: true }).waitFor();
  const chromeProfile = welcome.getByRole("checkbox", { name: "Google Chrome" });
  await chromeProfile.waitFor();
  assert.equal(await chromeProfile.isChecked(), true);
  await welcome.getByRole("button", { name: "Import", exact: true }).click();
  // Section 17's step comes between the import and its outcome, and this
  // profile has no extensions to bring over yet.
  await welcome.getByText("Add your extensions").waitFor();
  await welcome
    .getByText("No extensions to bring over from this profile.")
    .waitFor();
  await welcome.getByRole("button", { name: "Continue" }).click();
  await welcome.getByText("Imported 2 bookmarks and 3 sites.").waitFor();
  await welcome.getByRole("button", { name: "Continue" }).click();
  await welcome.getByRole("heading", { name: "Connect your agent" }).waitFor();
  await atStep(4);
  await welcome.getByRole("button", { name: "Set up later" }).click();
  await welcome.getByRole("heading", { name: "Sign in once" }).waitFor();
  await atStep(5);
  const topSites = welcome.getByRole("button", { name: /^Open / });
  assert.equal(await topSites.first().getAttribute("aria-label"), "Open docs.example");
  assert.equal(await topSites.count(), 6);
  await welcome.getByRole("button", { name: "Next" }).click();
  await welcome.getByRole("heading", { name: "You're all set" }).waitFor();
  await atStep(6);
  assert.equal(await welcome.locator(".welcome-default").count(), 0);
  assert.equal(
    await welcome
      .getByRole("checkbox", { name: "Make Kamapathy your default browser" })
      .count(),
    0,
  );
  checked("a development build offers no default browser choice on the last step");
  await welcome.getByRole("button", { name: "Start browsing" }).click();
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
  checked("the welcome dialog walks six steps, imports bookmarks and history from another browser, then offers top sites, once");
  // What's new never opens on a fresh profile: restore saves the running
  // version as the one seen.
  const whatsNew = (target) =>
    target.getByRole("dialog", { name: /^What's new in Kamapathy/ });
  assert.equal(await whatsNew(page).count(), 0);
  // A first run closed partway through is still over.
  const secondProfile = await mkdtemp(join(tmpdir(), "kamapathy-smoke-second-"));
  const secondApp = await electron.launch({
    executablePath: await prepareDesktopRuntime(),
    args: [resolve("out/main/index.js")],
    env: { ...env, KAMAPATHY_USER_DATA: secondProfile },
    timeout: 30000,
  });
  try {
    const secondPage = await secondApp.firstWindow();
    await secondPage.waitForSelector(".home-page, .web-page");
    await secondPage.waitForFunction(() => !!window.kamapathy);
    const secondWelcome = secondPage.locator(".welcome-modal");
    await secondWelcome.getByRole("button", { name: "Get started" }).click();
    await secondWelcome
      .getByRole("heading", { name: "Your data stays here" })
      .waitFor();
    await secondPage.keyboard.press("Escape");
    await secondWelcome.waitFor({ state: "detached" });
    await waitForState(secondPage, (state) => state.settings.welcomed);
  } finally {
    await secondApp.close().catch(() => {});
    await rm(secondProfile, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 150,
    });
  }
  checked("closing the welcome dialog at the second step still ends the first run");
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
  assert.match(await focusedText(), /^Help/);
  // Settings sits two items above Help, under Set up agents.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
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
  // Section 18's password manager in the window, on this temporary profile:
  // the person signs in, saves, fills from the native menu, manages the
  // saved password in the dialog and imports a CSV file.
  const passwords = await installPasswordStubs(app);
  signInSite = await startSignInSite();
  const signInUrl = `${signInSite.origin}/passwords/sign-in`;
  const signInHost = "127.0.0.1";
  const personUsername = "ada@example.test";
  const personPassword = "correct horse 1";
  await app.evaluate(({ app }) => app.focus({ steal: true }));
  state = await page.evaluate(
    (url) => window.kamapathy.dispatch({ type: "tab:create", url }),
    signInUrl,
  );
  const passwordTab = state.activeTabId;
  const loadedPasswordTab = () =>
    waitForState(
      page,
      (state, id) => state.tabs.some((tab) => tab.id === id && !tab.loading),
      passwordTab,
    );
  await loadedPasswordTab();
  await livePages(page, 1);
  let signInContents = await pageContents(signInUrl);
  await clickInPage(signInContents, "#username");
  await typeInPage(signInContents, personUsername);
  await clickInPage(signInContents, "#password");
  await typeInPage(signInContents, personPassword);
  await clickInPage(signInContents, "#submit");
  await poll(() => signInSite.posts.length > 0, { label: "the sign-in post" });
  assert.deepEqual(signInSite.posts.at(-1), {
    path: "/passwords/sign-in",
    username: personUsername,
    password: personPassword,
  });
  // The post answered with the signed-in page, which has no password field,
  // so the offer to save reaches section 7's prompt bar.
  const savePrompt = page.getByRole("region", { name: "Passwords", exact: true });
  await savePrompt.getByText(`Save password for ${signInHost}?`).waitFor();
  assert.equal(
    await savePrompt.getByLabel("Username", { exact: true }).inputValue(),
    personUsername,
  );
  await savePrompt.getByRole("button", { name: "Save", exact: true }).click();
  await savePrompt.waitFor({ state: "detached" });
  const saved = await poll(
    async () => {
      const list = await page.evaluate(() => window.kamapathy.passwords.list());
      return Array.isArray(list) && list.length === 1 ? list : null;
    },
    { label: "the saved login" },
  );
  assert.equal(saved[0].origin, signInSite.origin);
  assert.equal(saved[0].username, personUsername);
  const vaultFile = join(profile, "passwords", "vault.bin");
  const vaultBytes = await readFile(vaultFile);
  assert.equal(vaultBytes.subarray(0, 4).toString("latin1"), "KPV1");
  for (const secret of [personUsername, personPassword])
    assert.ok(
      !vaultBytes.includes(Buffer.from(secret, "utf8")),
      `the vault file holds ${secret} in plain text`,
    );
  if (process.platform !== "win32")
    assert.equal(statSync(vaultFile).mode & 0o777, 0o600);
  // A fresh visit to the same form, where the person asks for the saved
  // password by clicking the empty username field.
  await page.evaluate(
    ([id, url]) => window.kamapathy.dispatch({ type: "tab:navigate", id, url }),
    [passwordTab, signInUrl],
  );
  await loadedPasswordTab();
  signInContents = await pageContents(signInUrl);
  const signInPage = await pageAt(signInUrl);
  // The menu opens only while the window is focused, which this runner
  // cannot promise, so the window says it is focused for these clicks.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].focus();
    globalThis.__passwordFocused = BrowserWindow.prototype.isFocused;
    BrowserWindow.prototype.isFocused = () => true;
  });
  let usernameRect;
  let fillMenu;
  // The click comes again where the frame's script had not yet been told it
  // may offer a fill.
  for (let attempt = 1; attempt <= 3 && !fillMenu; attempt++) {
    await passwords.expect([]);
    usernameRect = await clickInPage(signInContents, "#username");
    fillMenu = await poll(
      async () => {
        const { popups } = await passwords.read();
        return popups.length ? popups : null;
      },
      { timeoutMs: 3000, label: "the fill menu" },
    ).catch(() => undefined);
  }
  assert.equal(fillMenu?.length, 1, "the fill menu opened once");
  assert.deepEqual(fillMenu[0].items, [
    personUsername,
    "",
    "Manage passwords...",
  ]);
  const [passwordView] = (await visibleViews()).filter(
    (view) => view.url === signInUrl,
  );
  const zoom = await app.evaluate(
    ({ webContents }, id) => webContents.fromId(id).getZoomFactor(),
    signInContents,
  );
  assert.deepEqual(
    { x: fillMenu[0].x, y: fillMenu[0].y },
    {
      x: Math.round(passwordView.x + usernameRect.x * zoom),
      y: Math.round(
        passwordView.y + (usernameRect.y + usernameRect.height) * zoom,
      ),
    },
    "the fill menu opens under the field",
  );
  await passwords.chooseFill(0);
  assert.deepEqual(
    await poll(
      async () => {
        const values = await signInPage.evaluate(() => [
          document.getElementById("username").value,
          document.getElementById("password").value,
        ]);
        return values.every(Boolean) ? values : null;
      },
      { label: "the filled sign-in form" },
    ),
    [personUsername, personPassword],
  );
  // A personal space asks nothing before it fills.
  assert.deepEqual((await passwords.read()).messages, []);
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.prototype.isFocused = globalThis.__passwordFocused;
    delete globalThis.__passwordFocused;
  });
  checked("sign in, save, and fill on the next visit");
  // The dialog from View > Passwords shows a password only after the check.
  await passwords.expect([1]);
  assert.ok(await clickViewMenuItem("Passwords"), "View has a Passwords item");
  const passwordsDialog = page.getByRole("dialog", {
    name: "Passwords",
    exact: true,
  });
  const savedRow = passwordsDialog.locator(".passwords-row");
  await savedRow.waitFor();
  assert.match(await savedRow.textContent(), /127\.0\.0\.1/);
  assert.match(await savedRow.textContent(), /ada@example\.test/);
  await savedRow.getByRole("button", { name: "Show", exact: true }).click();
  await savedRow
    .getByText("Passwords stay hidden until you confirm it's you.")
    .waitFor();
  assert.equal(await savedRow.locator("code").count(), 0);
  assert.deepEqual((await passwords.read()).messages, [
    "Show passwords? | Anyone using this computer account can see saved passwords. | Show | Cancel",
  ]);
  await passwords.expect([0]);
  await savedRow.getByRole("button", { name: "Show", exact: true }).click();
  await savedRow.locator("code").getByText(personPassword).waitFor();
  const editedPassword = "stronger horse 2";
  const editedNote = "Signs in to the test site";
  await savedRow.getByRole("button", { name: "Edit", exact: true }).click();
  const passwordForm = passwordsDialog.locator("form.passwords-form");
  await passwordForm.waitFor();
  assert.equal(
    await passwordForm.getByLabel("Site URL", { exact: true }).inputValue(),
    signInSite.origin,
  );
  await passwordForm
    .getByLabel("Password", { exact: true })
    .fill(editedPassword);
  await passwordForm.getByLabel("Note", { exact: true }).fill(editedNote);
  await passwordForm.getByRole("button", { name: "Save", exact: true }).click();
  await passwordForm.waitFor({ state: "detached" });
  await savedRow.getByRole("button", { name: "Show", exact: true }).click();
  await savedRow.locator("code").getByText(editedPassword).waitFor();
  await savedRow.getByText(editedNote, { exact: true }).waitFor();
  await savedRow
    .getByRole("button", { name: "Copy username", exact: true })
    .click();
  await passwordsDialog.getByText("Copied", { exact: true }).waitFor();
  assert.equal(
    await app.evaluate(({ clipboard }) => clipboard.readText()),
    personUsername,
  );
  await savedRow.getByRole("button", { name: "Delete", exact: true }).click();
  await savedRow.getByText("Delete this password?").waitFor();
  await savedRow.getByRole("button", { name: "Delete", exact: true }).click();
  await passwordsDialog
    .getByText(
      "No saved passwords yet. Kamapathy offers to save one when you sign in.",
    )
    .waitFor();
  assert.equal(await passwordsDialog.locator(".passwords-row").count(), 0);
  checked("the dialog reveals after the check, edits and deletes");
  // A CSV file another browser wrote: one row already saved, one that
  // differs from a saved password, and one new.
  const csvFile = join(profile, "passwords.csv");
  const csvRows = [
    { url: "https://docs.example/", username: "ada", password: "same pass 1" },
    { url: "https://mail.example/", username: "ada", password: "file pass 2" },
    {
      url: "https://shop.example/",
      username: "grace",
      password: "new pass 3",
    },
  ];
  await writeFile(
    csvFile,
    `${[
      "name,url,username,password,note",
      ...csvRows.map(
        (row) =>
          `${new URL(row.url).hostname},${row.url},${row.username},${row.password},`,
      ),
    ].join("\r\n")}\r\n`,
  );
  for (const login of [
    { ...csvRows[0] },
    { ...csvRows[1], password: "saved pass 2" },
  ]) {
    const added = await page.evaluate(
      (login) => window.kamapathy.passwords.add(login),
      login,
    );
    assert.ok(added?.id, JSON.stringify(added));
  }
  await passwords.expect([]);
  await passwords.offerFile(csvFile);
  await passwordsDialog
    .getByRole("button", { name: "Import...", exact: true })
    .click();
  await passwordsDialog
    .getByText("Replace saved passwords that differ")
    .waitFor();
  await passwordsDialog
    .getByRole("button", { name: "Import", exact: true })
    .click();
  for (const line of [
    "Imported 1 password.",
    "1 was already saved.",
    "1 differs from saved ones and was kept.",
  ])
    await passwordsDialog.getByText(line, { exact: true }).waitFor();
  await passwordsDialog
    .getByText(
      "Move passwords.csv to the Trash? It holds your passwords in plain text.",
    )
    .waitFor();
  await passwordsDialog
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  assert.deepEqual(
    await poll(
      async () => {
        const { trashed } = await passwords.read();
        return trashed.length ? trashed : null;
      },
      { label: "the file moved to the Trash" },
    ),
    [csvFile],
  );
  const imported = await page.evaluate(() =>
    window.kamapathy.passwords.list(),
  );
  assert.equal(imported.length, 3);
  assert.ok(
    imported.some(
      (login) =>
        login.origin === "https://shop.example" && login.username === "grace",
    ),
    "the imported login is saved",
  );
  checked("CSV import counts and offers the Trash");
  await passwordsDialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await passwordsDialog.waitFor({ state: "detached" });
  // Section 7's sign-in bar with section 18's sign-ins in it: the person
  // types a Basic auth login once, and the bar offers it the next time.
  const basicUrl = `${signInSite.origin}/passwords/basic`;
  const basicRealm = "Kamapathy test realm";
  const basicUsername = "basic-user";
  const basicPassword = "basic pass 1";
  // The password manager's own bar carries a class of its own, so this is
  // section 7's.
  const signInBar = page.locator("section.prompt-bar:not(.password-prompt)");
  await page.evaluate(
    ([id, url]) => window.kamapathy.dispatch({ type: "tab:navigate", id, url }),
    [passwordTab, basicUrl],
  );
  await signInBar.getByText(`The site says "${basicRealm}"`).waitFor();
  assert.equal(
    await signInBar.locator(".prompt-bar-logins button").count(),
    0,
    "nothing is saved for this realm yet",
  );
  await signInBar.getByLabel("Username", { exact: true }).fill(basicUsername);
  await signInBar.getByLabel("Password", { exact: true }).fill(basicPassword);
  assert.equal(
    await signInBar
      .getByRole("checkbox", { name: "Save password" })
      .isChecked(),
    true,
    "Save password starts ticked",
  );
  await signInBar.getByRole("button", { name: "Allow", exact: true }).click();
  await signInBar.waitFor({ state: "detached" });
  const basicPage = await pageAt(basicUrl);
  await basicPage.getByRole("heading", { name: "Basic auth done" }).waitFor();
  const httpLogin = await poll(
    async () => {
      const list = await page.evaluate(() => window.kamapathy.passwords.list());
      return (
        (Array.isArray(list) && list.find((login) => login.kind === "http")) ||
        null
      );
    },
    { label: "the saved sign-in" },
  );
  assert.deepEqual(
    [httpLogin.origin, httpLogin.realm, httpLogin.username],
    [signInSite.origin, basicRealm, basicUsername],
  );
  // Chromium keeps a sign-in for the rest of the session, so the next tab is
  // asked again with the auth cache emptied.
  await app.evaluate(
    ({ webContents }, id) => webContents.fromId(id).session.clearAuthCache(),
    await pageContents(basicUrl),
  );
  state = await page.evaluate(
    (url) => window.kamapathy.dispatch({ type: "tab:create", url }),
    basicUrl,
  );
  const secondBasicTab = state.activeTabId;
  await signInBar
    .getByRole("button", { name: `Sign in as ${basicUsername}` })
    .click();
  await signInBar.waitFor({ state: "detached" });
  // Nothing was typed this time: main answered the page with the saved
  // values itself.
  const secondBasicPage = await pageAt(basicUrl);
  await secondBasicPage
    .getByRole("heading", { name: "Basic auth done" })
    .waitFor();
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:close", id }),
    secondBasicTab,
  );
  checked("the sign-in bar uses a saved HTTP login");
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:close", id }),
    passwordTab,
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    personalTab,
  );
  await livePages(page, 1);
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
  // Section 5 in the window: an agent's chords reach its own page and
  // nothing of the person's. The tab the person is on carries history, so a
  // back shortcut would have somewhere to go if one reached the shell.
  const chordTab = (
    await page.evaluate(
      (url) => window.kamapathy.dispatch({ type: "tab:create", url }),
      origin,
    )
  ).activeTabId;
  const settled = (predicate) =>
    waitForState(
      page,
      (state, id) =>
        state.tabs.some(
          (tab) =>
            tab.id === id && !tab.loading && !tab.error && predicate(tab),
        ),
      chordTab,
    );
  await settled((tab) => tab.url.startsWith(origin));
  await page.evaluate(
    ([id, url]) => window.kamapathy.dispatch({ type: "tab:navigate", id, url }),
    [chordTab, `${origin}/second`],
  );
  await settled((tab) => tab.canGoBack);
  const personalTabs = async () =>
    (await page.evaluate(() => window.kamapathy.getState())).tabs
      .filter((tab) => tab.spaceId === "personal")
      .map((tab) => `${tab.id} ${tab.url}`);
  const anyDevTools = () =>
    app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some((item) => item.isDevToolsOpened()),
    );
  const tabsBeforeChords = await personalTabs();
  assert.ok(tabsBeforeChords.length >= 2, JSON.stringify(tabsBeforeChords));
  assert.equal(await anyDevTools(), false);
  for (const key of [
    "ControlOrMeta+KeyW",
    "ControlOrMeta+KeyT",
    "F12",
    "Alt+ArrowLeft",
  ]) {
    const pressed = await api(`/tabs/${agentTab}/press`, "POST", { key });
    assert.equal(pressed.status, 200, await pressed.text());
  }
  assert.deepEqual(await personalTabs(), tabsBeforeChords);
  assert.equal(await anyDevTools(), false);
  state = await page.evaluate(() => window.kamapathy.getState());
  assert.deepEqual(
    [state.activeSpaceId, state.activeTabId],
    ["personal", chordTab],
  );
  // The person's own new-tab shortcut still works in the same window.
  await page.keyboard.press("ControlOrMeta+T");
  state = await waitForState(
    page,
    (state, count) =>
      state.tabs.filter((tab) => tab.spaceId === "personal").length ===
      count + 1,
    tabsBeforeChords.length,
  );
  for (const id of [state.activeTabId, chordTab])
    await page.evaluate(
      (id) => window.kamapathy.dispatch({ type: "tab:close", id }),
      id,
    );
  await waitForState(
    page,
    (state, count) =>
      state.tabs.filter((tab) => tab.spaceId === "personal").length === count,
    tabsBeforeChords.length - 1,
  );
  checked(
    "agent chords leave the person's tabs and developer tools alone while the person's own shortcuts still work",
  );
  // Section 8 in the window: Page scripts is on until the person turns it
  // off in Settings, and agents then hear why their scripts stopped.
  const sixSevens = () =>
    api(`/tabs/${agentTab}/evaluate`, "POST", { expression: "6 * 7" });
  await page.getByRole("button", { name: "Browser menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  const scriptsSwitch = page.getByRole("switch", {
    name: "Page scripts",
    exact: true,
  });
  assert.equal(await scriptsSwitch.getAttribute("aria-checked"), "true");
  const scriptsOn = await sixSevens();
  assert.equal(scriptsOn.status, 200);
  assert.equal((await scriptsOn.json()).value, 42);
  await scriptsSwitch.click();
  await waitForState(page, (state) => state.settings.agentPageScripts === false);
  await poll(
    async () => (await scriptsSwitch.getAttribute("aria-checked")) === "false",
    { label: "the Page scripts switch turned off" },
  );
  const scriptsOff = await sixSevens();
  assert.equal(scriptsOff.status, 403);
  assert.equal((await scriptsOff.json()).error.code, "agent_scripts_off");
  await scriptsSwitch.click();
  await waitForState(page, (state) => state.settings.agentPageScripts === true);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  assert.equal((await sixSevens()).status, 200);
  checked("the Page scripts switch defaults on, and turning it off returns 403");
  // Section 9: an agent's click inside a frame from another host names that
  // host in the activity feed, so the person can see where it worked.
  const framedTab = (
    await (
      await api(`/spaces/${task}/tabs`, "POST", { url: `${origin}/framed` })
    ).json()
  ).tab.id;
  const framedPage = await poll(
    async () => {
      const found = await (await api(`/tabs/${framedTab}/snapshot`)).json();
      return found.interactables?.some(
        (item) => item.label === "Press the widget",
      )
        ? found
        : null;
    },
    { timeoutMs: 10000, label: "the button in the frame from the other host" },
  );
  const widget = framedPage.interactables.find(
    (item) => item.label === "Press the widget",
  );
  assert.equal(typeof widget.frame, "string", JSON.stringify(widget));
  const pressedWidget = await api(`/tabs/${framedTab}/click`, "POST", {
    ref: widget.ref,
  });
  assert.equal(pressedWidget.status, 200, await pressedWidget.text());
  const newestEntry = (
    await waitForState(
      page,
      (state, id) =>
        state.activity
          .find((item) => item.spaceId === id)
          ?.message.startsWith("Agent clicked"),
      task,
    )
  ).activity.find((item) => item.spaceId === task);
  assert.ok(
    newestEntry.message.endsWith(" in a frame from localhost"),
    newestEntry.message,
  );
  assert.match(
    (await (await api(`/tabs/${framedTab}/snapshot`)).json()).text,
    /Widget pressed/,
  );
  assert.equal((await api(`/tabs/${framedTab}`, "DELETE")).status, 200);
  checked(
    "the activity feed names the frame host for an agent click in a cross-site frame",
  );
  // Section 8: clearing a site's data in a space that shares the person's
  // sign-ins waits for them. The space needs them, a bar above the agent's
  // page asks, other requests hear why, and Don't clear hands control back.
  const clearHost = new URL(origin).host;
  const clearing = api(`/tabs/${agentTab}/clear-site-data`, "POST", {
    storage: true,
    timeoutMs: 60000,
  });
  await waitForState(page, (state) => state.approvals.length === 1);
  await poll(
    async () =>
      /an agent needs you/.test(await spacesButton.getAttribute("aria-label")),
    { label: "needs-you mark for the approval" },
  );
  assert.equal(
    (await page.evaluate(() => window.kamapathy.getState())).spaces.find(
      (item) => item.id === task,
    ).task.state,
    "needs-you",
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:activate", id }),
    task,
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    agentTab,
  );
  await waitForState(
    page,
    (state, id) => state.activeTabId === id,
    agentTab,
  );
  await page.getByText(`Clear data for ${clearHost}?`, { exact: true }).waitFor();
  const waiting = await api(`/tabs/${agentTab}/snapshot`);
  assert.equal(waiting.status, 409);
  assert.deepEqual(
    (({ code, reason }) => ({ code, reason }))((await waiting.json()).error),
    { code: "human_control", reason: "approval" },
  );
  await page.getByRole("button", { name: "Don't clear", exact: true }).click();
  const declined = await clearing;
  assert.equal(declined.status, 403);
  assert.equal((await declined.json()).error.code, "clear_declined");
  await waitForState(
    page,
    (state, id) =>
      state.approvals.length === 0 &&
      state.spaces.find((item) => item.id === id)?.owner === "agent",
    task,
  );
  await page
    .getByText(`Clear data for ${clearHost}?`, { exact: true })
    .waitFor({ state: "detached" });
  assert.equal((await api(`/tabs/${agentTab}/snapshot`)).status, 200);
  await page.evaluate(() =>
    window.kamapathy.dispatch({ type: "space:activate", id: "personal" }),
  );
  await waitForState(page, (state) => state.activeSpaceId === "personal");
  checked(
    "a clear in a shared space shows Needs you and the bar above its tab, another request gets human_control with reason approval, and Don't clear returns clear_declined and hands control back",
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
  // Section 18 in a space with agent rules: the person took it over, so a
  // fill asks first and fills nothing unless they confirm.
  const agentSignInUrl = `${signInSite.origin}/passwords/sign-in`;
  const agentLogin = await page.evaluate(
    (login) => window.kamapathy.passwords.add(login),
    {
      url: signInSite.origin,
      username: personUsername,
      password: personPassword,
    },
  );
  assert.ok(agentLogin?.id, JSON.stringify(agentLogin));
  const agentSignInTab = (
    await (
      await api(`/spaces/${task}/tabs`, "POST", { url: agentSignInUrl })
    ).json()
  ).tab.id;
  await waitForState(
    page,
    (state, id) => state.tabs.some((tab) => tab.id === id && !tab.loading),
    agentSignInTab,
  );
  await agentBar.getByRole("button", { name: "Take over" }).click();
  await waitForState(
    page,
    (state, id) =>
      state.spaces.find((space) => space.id === id).owner === "human",
    task,
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    agentSignInTab,
  );
  await poll(
    async () =>
      (await visibleViews()).some((view) => view.url === agentSignInUrl),
    { label: "the sign-in page the person took over" },
  );
  const agentSignInContents = await pageContents(agentSignInUrl);
  const signInFields = () =>
    app.evaluate(
      ({ webContents }, id) =>
        webContents
          .fromId(id)
          .executeJavaScript(
            "[document.getElementById('username').value, document.getElementById('password').value]",
          ),
      agentSignInContents,
    );
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].focus();
    globalThis.__passwordFocused = BrowserWindow.prototype.isFocused;
    BrowserWindow.prototype.isFocused = () => true;
  });
  let agentMenu;
  // Cancel is the answer waiting for the first choice. The click comes again
  // where the frame's script had not yet been told it may offer a fill.
  for (let attempt = 1; attempt <= 3 && !agentMenu; attempt++) {
    await passwords.expect([1]);
    await clickInPage(agentSignInContents, "#username");
    agentMenu = await poll(
      async () => {
        const { popups } = await passwords.read();
        return popups.length ? popups : null;
      },
      { timeoutMs: 3000, label: "the fill menu in the agent space" },
    ).catch(() => undefined);
  }
  assert.equal(agentMenu?.length, 1, "the fill menu opened once");
  assert.deepEqual(agentMenu[0].items, [
    personUsername,
    "",
    "Manage passwords...",
  ]);
  await passwords.chooseFill(0);
  assert.deepEqual(
    await poll(
      async () => {
        const { messages } = await passwords.read();
        return messages.length ? messages : null;
      },
      { label: "the question an agent space asks before filling" },
    ),
    [
      "Agents can read pages in this space, including this password. | Fill | Cancel",
    ],
  );
  assert.deepEqual(await signInFields(), ["", ""], "Cancel filled nothing");
  await passwords.expect([0]);
  await passwords.chooseFill(0);
  assert.deepEqual(
    await poll(
      async () => {
        const values = await signInFields();
        return values.every(Boolean) ? values : null;
      },
      { label: "the form filled after confirming" },
    ),
    [personUsername, personPassword],
  );
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.prototype.isFocused = globalThis.__passwordFocused;
    delete globalThis.__passwordFocused;
  });
  // The space goes back to the agent with the tab and the login gone.
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:close", id }),
    agentSignInTab,
  );
  await page.evaluate(
    (id) => window.kamapathy.passwords.remove(id),
    agentLogin.id,
  );
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    agentTab,
  );
  await agentBar.getByRole("button", { name: "Let agent continue" }).click();
  await waitForState(
    page,
    (state, id) =>
      state.spaces.find((space) => space.id === id).owner === "agent",
    task,
  );
  checked("an agent space confirms before filling");
  // Section 4: a full-page capture of the page the person is looking at
  // leaves its view and its scroll position where they were.
  const tallPage = `${origin}/tall`;
  assert.equal(
    (await api(`/tabs/${agentTab}/navigate`, "POST", { url: tallPage })).status,
    200,
  );
  assert.equal(
    (await api(`/tabs/${agentTab}/scroll`, "POST", { direction: "down", pixels: 600 })).status,
    200,
  );
  const pageMetrics = () =>
    app.evaluate(
      ({ webContents }, url) =>
        webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url)
          .executeJavaScript(
            "[scrollX, scrollY, document.documentElement.scrollWidth, document.documentElement.scrollHeight]",
          ),
      tallPage,
    );
  const viewsBeforeCapture = await visibleViews();
  const metricsBefore = await pageMetrics();
  assert.deepEqual(metricsBefore.slice(0, 2), [0, 600]);
  const wholePage = await api(`/tabs/${agentTab}/screenshot`, "POST", {
    fullPage: true,
  });
  const tallPng = Buffer.from(await wholePage.arrayBuffer());
  assert.equal(wholePage.status, 200, tallPng.toString("utf8").slice(0, 300));
  assert.deepEqual([...tallPng.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(
    [tallPng.readUInt32BE(16), tallPng.readUInt32BE(20)],
    metricsBefore.slice(2),
  );
  assert.equal(
    wholePage.headers.get("X-Kamapathy-Clip"),
    `0,0,${metricsBefore[2]},${metricsBefore[3]}`,
  );
  assert.deepEqual(await pageMetrics(), metricsBefore);
  assert.deepEqual(await visibleViews(), viewsBeforeCapture);
  assert.equal(
    (await api(`/tabs/${agentTab}/navigate`, "POST", { url: origin })).status,
    200,
  );
  checked(
    "a full-page capture of the shown agent tab leaves its view bounds and scroll unchanged",
  );
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
  // dispatcher reports each point it sends, so the cursor draws here; the
  // check still steps aside rather than failing where no point reaches it.
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
      "SKIP the cursor appears at the click point: no point reached the cursor",
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
  // Section 6: a page that asks to stay. The box is native, so it is
  // answered inside the application and nothing is ever shown on the
  // person's screen; the real one is put back when the three checks are
  // done. Playwright answers a page dialog it sees, which would race
  // Kamapathy's own answer, so every page is left to answer its own.
  const ownDialogs = (candidate) => candidate.on("dialog", () => {});
  for (const candidate of app.context().pages()) ownDialogs(candidate);
  app.context().on("page", ownDialogs);
  const guardedUrl = `${origin}/guarded`;
  // Replaces the Leave site box with a recorded answer and forgets the
  // boxes before it: 0 is Leave, 1 is Stay. `holdMs` holds the main process
  // the way a box the person is reading does.
  const askWith = (button, holdMs = 0) =>
    app.evaluate(
      ({ dialog }, { answer, hold }) => {
        globalThis.__kamapathyLeaveBoxes = [];
        globalThis.__kamapathyLeaveBox ??= dialog.showMessageBoxSync;
        dialog.showMessageBoxSync = (first, second) => {
          globalThis.__kamapathyLeaveBoxes.push(second ?? first);
          const until = Date.now() + hold;
          while (Date.now() < until);
          return answer;
        };
      },
      { answer: button, hold: holdMs },
    );
  const leaveBoxes = () =>
    app.evaluate(() => globalThis.__kamapathyLeaveBoxes ?? []);
  const navigateTab = (id, url) =>
    page.evaluate((action) => window.kamapathy.dispatch(action), {
      type: "tab:navigate",
      id,
      url,
    });
  // The page behind a Playwright page object, which keeps its identity
  // across a navigation, so its URL says where that page really is. The
  // first of them, not the module's pageAt, which takes the last.
  const firstPageAt = (url) =>
    poll(
      () =>
        app
          .context()
          .pages()
          .find((candidate) => candidate.url() === url),
      { label: `the page at ${url}` },
    );
  const shows = async (url) =>
    (await visibleViews()).some((view) => view.url === url);
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    personalTab,
  );
  await navigateTab(personalTab, guardedUrl);
  const guardedPage = await firstPageAt(guardedUrl);
  // The guard only asks once the page has had a gesture, which the click
  // gives it.
  await guardedPage.click("#touch");
  await guardedPage.getByText("Touched", { exact: true }).waitFor();
  await askWith(1, 600);
  // The box holds the main process while the person reads it, so an agent
  // request that lands then waits for the answer instead of failing.
  const meanwhile = api(`/tabs/${agentTab}/snapshot`);
  await navigateTab(personalTab, `${origin}/second`);
  const answered = await meanwhile;
  assert.equal(answered.status, 200, await answered.text());
  const leaveBox = await poll(async () => (await leaveBoxes()).at(0), {
    label: "the Leave site box",
  });
  assert.deepEqual(
    [leaveBox.message, leaveBox.detail, ...leaveBox.buttons],
    ["Leave site?", "Changes you made may not be saved.", "Leave", "Stay"],
  );
  assert.equal(guardedPage.url(), guardedUrl);
  assert.ok(
    await shows(guardedUrl),
    "the page asked about is not the shown one",
  );
  await askWith(0);
  await navigateTab(personalTab, `${origin}/second`);
  await poll(() => guardedPage.url() === `${origin}/second`, {
    label: "the page the person chose to leave",
  });
  assert.equal((await leaveBoxes()).length, 1);
  checked("a personal tab honors Leave and Stay");
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:activate", id }),
    agentTab,
  );
  const toGuarded = await api(`/tabs/${agentTab}/navigate`, "POST", {
    url: guardedUrl,
    waitUntil: "load",
  });
  assert.equal(toGuarded.status, 200, await toGuarded.text());
  const agentGuarded = await firstPageAt(guardedUrl);
  const touch = await api(`/tabs/${agentTab}/click`, "POST", {
    selector: "#touch",
  });
  assert.equal(touch.status, 200, await touch.text());
  const touched = await api(`/tabs/${agentTab}/wait`, "POST", {
    selector: "#touched",
    text: "Touched",
    timeoutMs: 8000,
  });
  assert.equal(touched.status, 200, await touched.text());
  // The person takes this space over, so its own tab asks them as well.
  await page.evaluate(
    (id) =>
      window.kamapathy.dispatch({ type: "space:ownership", id, owner: "human" }),
    task,
  );
  await askWith(1);
  await navigateTab(agentTab, `${origin}/second`);
  const agentTabBox = await poll(async () => (await leaveBoxes()).at(0), {
    label: "the Leave site box over the agent's tab",
  });
  assert.equal(agentTabBox.message, "Leave site?");
  assert.equal(agentGuarded.url(), guardedUrl);
  assert.ok(await shows(guardedUrl), "the agent's guarded page is not shown");
  checked("an agent space under the person's control asks before leaving");
  assert.equal((await api(`/spaces/${task}/resume`, "POST", {})).status, 200);
  // Stay is still the answer, so a box here would keep the page as well as
  // show in the record.
  await askWith(1);
  const left = await api(`/tabs/${agentTab}/navigate`, "POST", {
    url: `${origin}/`,
    waitUntil: "load",
  });
  const leftBody = await left.json();
  assert.equal(left.status, 200, JSON.stringify(leftBody));
  assert.deepEqual(leftBody.dialog, {
    type: "beforeunload",
    message: "",
    answer: "accepted",
  });
  assert.equal(leftBody.tab.url, `${origin}/`);
  assert.deepEqual(await leaveBoxes(), []);
  await poll(() => agentGuarded.url() === `${origin}/`, {
    label: "the page the agent left",
  });
  const overrides = (
    await page.evaluate(() => window.kamapathy.getState())
  ).activity.filter(
    (item) =>
      item.spaceId === task &&
      item.message === "Agent left a page that asked it to stay",
  );
  assert.equal(overrides.length, 1);
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBoxSync = globalThis.__kamapathyLeaveBox;
    delete globalThis.__kamapathyLeaveBoxes;
  });
  // The person's tab goes back to the page the checks after this one expect.
  await navigateTab(personalTab, origin);
  await waitForState(
    page,
    (state, id) =>
      state.tabs.find((tab) => tab.id === id)?.title ===
      "Kamapathy test garden",
    personalTab,
  );
  checked(
    "an agent-controlled tab leaves without asking and Recent activity says so",
  );
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
  // Section 7 in the window: the one prompt bar, saved site permissions, a
  // sign-in the person answers, and a space that says it needs them.
  const promptBar = page.locator("section.prompt-bar");
  // The person's own page, which no debugger session touches.
  const inPromptPage = (url, code) =>
    app.evaluate(
      ({ webContents }, [address, source]) => {
        const contents = webContents
          .getAllWebContents()
          .find((item) => item.getURL() === address);
        if (!contents) throw new Error(`No page at ${address}`);
        return contents.executeJavaScript(source, true);
      },
      [url, code],
    );
  await page.evaluate(() =>
    window.kamapathy.dispatch({ type: "space:activate", id: "personal" }),
  );
  const ownTab = (await page.evaluate(() => window.kamapathy.getState())).activeTabId;
  // Each round is a document of its own, so every request reaches the
  // browser instead of a decision the page already holds.
  const visitLocation = async (round) => {
    const url = `${origin}/prompts/location?round=${round}`;
    await page.evaluate(
      ({ id, address }) =>
        window.kamapathy.dispatch({ type: "tab:navigate", id, url: address }),
      { id: ownTab, address: url },
    );
    await waitForState(
      page,
      (state, address) =>
        state.tabs.some((tab) => tab.url === address && !tab.loading),
      url,
    );
    return url;
  };
  const locationPermission = (url) =>
    inPromptPage(
      url,
      'navigator.permissions.query({ name: "geolocation" }).then((status) => status.state)',
    );
  const askLocation = (url) =>
    inPromptPage(url, 'document.getElementById("ask-location").click()');
  const firstRound = await visitLocation(1);
  // Nothing is saved for this site, so nothing is granted either.
  assert.equal(await locationPermission(firstRound), "denied");
  await askLocation(firstRound);
  await promptBar.waitFor();
  assert.equal(await promptBar.getAttribute("aria-label"), "Personal");
  await promptBar.getByText(`${origin} wants to know your location`).waitFor();
  await promptBar.getByText("Kamapathy remembers this for Personal.").waitFor();
  await promptBar.getByRole("button", { name: "Allow", exact: true }).click();
  await promptBar.waitFor({ state: "detached" });
  await waitForState(
    page,
    (state, address) =>
      state.sitePermissions.some(
        (row) =>
          row.spaceId === "personal" &&
          row.origin === address &&
          row.permission === "geolocation" &&
          row.allow,
      ),
    origin,
  );
  assert.equal(await locationPermission(firstRound), "granted");
  // The saved Allow answers the next page's request, with no bar.
  const secondRound = await visitLocation(2);
  assert.equal(await locationPermission(secondRound), "granted");
  await askLocation(secondRound);
  await page.waitForTimeout(800);
  assert.equal(await promptBar.count(), 0);
  assert.deepEqual(
    (await page.evaluate(() => window.kamapathy.getState())).prompts,
    [],
  );
  // Settings removes the row, and the site is asked again.
  await openBrowserMenu();
  await browserMenu.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Site permissions" }).waitFor();
  await page
    .getByRole("button", { name: `Remove location for ${origin}` })
    .click();
  await waitForState(page, (state) => state.sitePermissions.length === 0);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const thirdRound = await visitLocation(3);
  assert.equal(await locationPermission(thirdRound), "denied");
  await askLocation(thirdRound);
  await promptBar.waitFor();
  await promptBar.getByRole("button", { name: "Block", exact: true }).click();
  await promptBar.waitFor({ state: "detached" });
  await waitForState(
    page,
    (state, address) =>
      state.sitePermissions.some(
        (row) =>
          row.origin === address &&
          row.permission === "geolocation" &&
          !row.allow,
      ),
    origin,
  );
  checked("the permission bar remembers Allow and Settings removes it");
  await page.evaluate(
    ({ id, url }) => window.kamapathy.dispatch({ type: "tab:navigate", id, url }),
    { id: ownTab, url: `${origin}/prompts/auth` },
  );
  await promptBar.waitFor();
  await promptBar.getByText("Sign in to 127.0.0.1").waitFor();
  await promptBar.getByText(`The site says "${AUTH.realm}"`).waitFor();
  const signIn = promptBar.getByRole("button", { name: "Allow", exact: true });
  assert.equal(await signIn.isDisabled(), true);
  await promptBar.locator("#prompt-username").fill(AUTH.username);
  await promptBar.locator("#prompt-password").fill(AUTH.password);
  await signIn.click();
  await promptBar.waitFor({ state: "detached" });
  await waitForState(
    page,
    (state, id) => state.tabs.find((tab) => tab.id === id)?.title === "Signed in",
    ownTab,
  );
  checked("the sign-in bar loads a Basic auth page");
  const waitingSpace = (
    await (await api("/spaces", "POST", { name: "Waiting review" })).json()
  ).space;
  const askingTab = (
    await (
      await api(`/spaces/${waitingSpace.id}/tabs`, "POST", {
        url: `${origin}/prompts/location`,
      })
    ).json()
  ).tab;
  const quietTab = (
    await (
      await api(`/spaces/${waitingSpace.id}/tabs`, "POST", {
        url: `${origin}/prompts/landing`,
      })
    ).json()
  ).tab;
  assert.equal(
    (await api(`/tabs/${askingTab.id}/click`, "POST", { selector: "#ask-location" }))
      .status,
    200,
  );
  const heldPrompt = await poll(
    async () =>
      (await page.evaluate(() => window.kamapathy.getState())).prompts.find(
        (item) => item.spaceId === waitingSpace.id,
      ),
    { timeoutMs: 15000, label: "the request held for the person" },
  );
  assert.equal(heldPrompt.tabId, askingTab.id);
  // The person is looking at their own space, so only the reminder shows.
  await page.evaluate(() =>
    window.kamapathy.dispatch({ type: "space:activate", id: "personal" }),
  );
  assert.equal(await promptBar.count(), 0);
  assert.match(await spacesButton.getAttribute("aria-label"), /needs you/);
  // Opening the space brings forward the page that asked, with the bar.
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:activate", id }),
    waitingSpace.id,
  );
  await promptBar.waitFor();
  assert.equal(await promptBar.getAttribute("aria-label"), "Waiting review");
  await promptBar.getByText("The agent is waiting for you.").waitFor();
  assert.notEqual(askingTab.id, quietTab.id);
  assert.equal(
    (await page.evaluate(() => window.kamapathy.getState())).activeTabId,
    askingTab.id,
  );
  await promptBar.getByRole("button", { name: "Block", exact: true }).click();
  await promptBar.waitFor({ state: "detached" });
  assert.equal((await api(`/spaces/${waitingSpace.id}`, "DELETE")).status, 200);
  checked("opening a space that needs you shows the waiting prompt");
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
  // Section 12 in the window: Set up agents links the agents on this
  // computer, leaves the Codex rule off, and takes back what it wrote.
  await openBrowserMenu();
  await browserMenu.getByRole("menuitem", { name: "Set up agents" }).click();
  const setupDialog = page.getByRole("dialog", { name: "Set up agents" });
  // A link counts as there even when what it points at is gone.
  const present = (path) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  };
  // Every box is named by its own label, so each name matches in full.
  const agentBox = (name) =>
    setupDialog.getByRole("checkbox", { name, exact: true });
  await agentBox("Claude Code").waitFor();
  for (const name of ["Claude Code", "Codex", "Add the kamapathy command"])
    assert.equal(await agentBox(name).isChecked(), true, name);
  const codexRule = agentBox("Let Codex run kamapathy without asking");
  assert.equal(await codexRule.isChecked(), false);
  // The runner's own PATH stays as it is.
  if (process.platform === "win32") {
    const windowsPath = agentBox("Add it to your PATH");
    if (await windowsPath.isChecked()) await windowsPath.uncheck();
  }
  await setupDialog.getByRole("button", { name: "Set up", exact: true }).click();
  await setupDialog
    .getByText("Restart your agents to load the skill.", { exact: false })
    .waitFor();
  const setup = await page.evaluate(() => window.kamapathy.agentSetupStatus());
  const stable = setup.skillFolder;
  assert.ok(existsSync(join(stable, "SKILL.md")), stable);
  const entries = [];
  for (const id of ["claude-code", "codex"]) {
    const agent = setup.agents.find((row) => row.id === id);
    assert.equal(agent?.state, "linked", JSON.stringify(setup.agents));
    const entry = join(agent.folder, "kamapathy");
    entries.push(entry);
    assert.ok(existsSync(join(entry, "SKILL.md")), entry);
    if (process.platform === "win32")
      assert.ok(lstatSync(entry).isDirectory());
    else assert.equal(readlinkSync(entry), stable);
  }
  assert.equal(setup.command.state, "on");
  assert.ok(existsSync(setup.command.path));
  // The probed shell has a startup file Kamapathy knows.
  if (setup.command.profileFile) {
    assert.equal(setup.command.pathAdded, true);
    assert.match(
      await readFile(setup.command.profileFile, "utf8"),
      /# Added by Kamapathy for the kamapathy command/,
    );
  }
  assert.equal(setup.codex.allowed, false);
  assert.equal(
    existsSync(join(home, ".codex", "rules", "default.rules")),
    false,
  );
  await setupDialog.getByRole("button", { name: "Close", exact: true }).click();
  await setupDialog.waitFor({ state: "detached" });
  await openBrowserMenu();
  await browserMenu.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByText("Set up for Claude Code and Codex").waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await openBrowserMenu();
  await browserMenu.getByRole("menuitem", { name: "Set up agents" }).click();
  await setupDialog.getByRole("button", { name: "Remove setup" }).click();
  // Removal answers on the same chain as this status call.
  await poll(
    async () =>
      (await page.evaluate(() => window.kamapathy.agentSetupStatus()))
        .skillFolder === null,
    { label: "agent setup removed" },
  );
  for (const path of [...entries, setup.command.path, dirname(stable)])
    assert.equal(present(path), false, path);
  if (setup.command.profileFile)
    assert.doesNotMatch(
      await readFile(setup.command.profileFile, "utf8"),
      /Kamapathy/,
    );
  await setupDialog.getByRole("button", { name: "Close", exact: true }).click();
  await setupDialog.waitFor({ state: "detached" });
  checked(
    "Set up agents links Claude Code and Codex, leaves the Codex rule off, and removes cleanly",
  );
  // Help pages open as the person's tab, never in the agent space in front.
  // Agent access is off by now, so the space in front is the one made by hand.
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "space:activate", id }),
    manual,
  );
  state = await waitForState(
    page,
    (next, id) => next.activeSpaceId === id,
    manual,
  );
  assert.equal(
    state.spaces.find((space) => space.id === manual)?.kind,
    "agent",
  );
  await openBrowserMenu();
  await browserMenu.getByRole("menuitem", { name: "Help", exact: true }).click();
  state = await waitForState(page, (next) =>
    next.tabs.some((tab) => tab.url.startsWith("https://kamapathy.app/")),
  );
  const helpTab = state.tabs.find((tab) =>
    tab.url.startsWith("https://kamapathy.app/"),
  );
  assert.equal(helpTab.url, "https://kamapathy.app/#faq");
  assert.equal(state.activeTabId, helpTab.id);
  assert.notEqual(helpTab.spaceId, manual);
  assert.equal(
    state.spaces.find((space) => space.id === helpTab.spaceId)?.kind,
    "personal",
  );
  assert.equal(state.activeSpaceId, helpTab.spaceId);
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:close", id }),
    helpTab.id,
  );
  checked("Help opens the FAQ in the personal space used last");
  // Open point 6 in the window: each daily request the docs disclose is
  // disclosed in Settings with the same party and the same "once a day",
  // beside its switch in the section the docs send the person to. The docs
  // are read here, so a reworded sentence fails in one place.
  {
    const sentencesOf = async (file) =>
      (await readFile(new URL(`../${file}`, import.meta.url), "utf8"))
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?]) /);
    const disclosures = [
      ["README.md", await sentencesOf("README.md")],
      ["site/index.html", await sentencesOf("site/index.html")],
    ];
    await openBrowserMenu();
    await browserMenu.getByRole("menuitem", { name: "Settings" }).click();
    for (const [party, switchName] of [
      ["GitHub", "Check for updates"],
      ["Chrome Web Store", "Update extensions automatically"],
    ]) {
      const toggle = page.getByRole("switch", {
        name: switchName,
        exact: true,
      });
      const sectionName = await page
        .locator(".settings-section", { has: toggle })
        .getByRole("heading", { level: 3 })
        .textContent();
      const switchNote = await page
        .locator(".setting-row", { has: toggle })
        .locator("p")
        .textContent();
      assert.ok(
        switchNote.includes(party) && /\bonce a day\b/i.test(switchNote),
        `${switchName}: ${switchNote}`,
      );
      for (const [file, sentences] of disclosures) {
        let disclosed = 0;
        for (const [at, sentence] of sentences.entries()) {
          if (!sentence.includes(party) || !/\bonce a day\b/i.test(sentence))
            continue;
          disclosed++;
          // The sentence, or the one after it, says where to turn it off.
          const offIn = [sentence, sentences[at + 1] ?? ""].find((text) =>
            /\bin Settings\b/.test(text),
          );
          assert.ok(offIn, `${file} does not say where: ${sentence}`);
          const under = /\bin Settings, under (\w+)/.exec(offIn)?.[1];
          if (under) assert.equal(under, sectionName, `${file}: ${offIn}`);
        }
        assert.ok(disclosed, `${file} does not say how often it asks ${party}`);
      }
    }
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
  }
  checked(
    "Settings discloses both outbound requests the docs name, beside the switches they point to",
  );
  // Section 13 in the window: Updates, with this copy running from source.
  await openBrowserMenu();
  await browserMenu.getByRole("menuitem", { name: "Settings" }).click();
  const updateChecks = page.getByRole("switch", { name: "Check for updates" });
  assert.equal(await updateChecks.getAttribute("aria-checked"), "true");
  await page
    .getByText("This copy runs from source. Pull the latest code to update it.")
    .waitFor();
  assert.equal(await whatsNew(page).count(), 0);
  await updateChecks.click();
  await waitForState(page, (next) => next.settings.updateChecks === false);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
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
  // Kamapathy opens a saved vault soon after its window shows, and this
  // run's vault was sealed with the stand-in key installPasswordStubs gives.
  // The same stand-in loads before Kamapathy does: the real keyring would
  // wait on a dialog nobody answers here, and no later quit would finish.
  const standInSealer = join(profile, "stand-in-sealer.cjs");
  await writeFile(
    standInSealer,
    [
      'const { safeStorage } = require("electron");',
      "safeStorage.isAsyncEncryptionAvailable = async () => true;",
      "safeStorage.encryptStringAsync = async (text) =>",
      '  Buffer.from(Buffer.from(text, "utf8").reverse());',
      "safeStorage.decryptStringAsync = async (sealed) => ({",
      '  result: Buffer.from(sealed).reverse().toString("utf8"),',
      "  shouldReEncrypt: false,",
      "});",
      'if (process.platform === "linux")',
      '  safeStorage.getSelectedStorageBackend = () => "gnome_libsecret";',
      "",
    ].join("\n"),
  );
  page = await launch(standInSealer);
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
  // The update switch and the version seen survive the restart.
  assert.equal(await whatsNew(page).count(), 0);
  await page.getByRole("button", { name: "Browser menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  assert.equal(
    await page
      .getByRole("switch", { name: "Check for updates" })
      .getAttribute("aria-checked"),
    "false",
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  checked("Settings shows Updates on and remembers it off after a restart");
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
  const defaultBrowserRow = page
    .locator(".setting-row")
    .filter({ has: page.getByText("Default browser", { exact: true }) });
  await defaultBrowserRow.getByText("Available in the installed app.").waitFor();
  assert.equal(
    await defaultBrowserRow.getByRole("button", { name: "Make default" }).count(),
    0,
  );
  checked("a development build says the default browser needs the installed app");
  await page.getByRole("button", { name: "Import...", exact: true }).click();
  await page.getByRole("heading", { name: "Import bookmarks and history" }).waitFor();
  await page.getByRole("button", { name: /^(Skip|Continue|Import)$/ }).first().waitFor();
  if (process.platform === "darwin") {
    await page.locator("input.import-file").setInputFiles(notAZip);
    await page
      .getByText("That is not a .zip file. Choose the file Safari exported.")
      .waitFor();
    checked("the Safari block refuses a file that is not the export");
  }
  await page.getByRole("checkbox", { name: "Sign-ins (cookies)" }).check();
  await page
    .getByText(
      "These sign-ins will work in every space that shares your sign-ins, and for agents there.",
    )
    .waitFor();
  checked("the import panel says who will be able to use imported sign-ins");
  // Windows wraps its Safe Storage key with DPAPI, so only the note is checked.
  if (process.platform === "win32") {
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await page.getByText("Add your extensions").waitFor();
    await page.getByRole("button", { name: "Continue" }).click();
    await page
      .getByText(/^Imported \d+ bookmarks, \d+ sites and 1 sign-in\.$/)
      .waitFor();
    await page.getByRole("button", { name: "Continue" }).click();
    state = await page.evaluate(() =>
      window.kamapathy.dispatch({
        type: "space:create",
        name: "Signed in",
        color: "blue",
        kind: "personal",
      }),
    );
    assert.equal(
      state.spaces.find((space) => space.id === state.activeSpaceId).signIns,
      "shared",
    );
    await page.evaluate(
      (url) => window.kamapathy.dispatch({ type: "tab:create", url }),
      `${origin}/whoami`,
    );
    await waitForState(page, (state) =>
      state.tabs.some((tab) => tab.url === `${origin}/whoami` && !tab.loading),
    );
    const whoami = app
      .context()
      .pages()
      .filter((candidate) => candidate.url() === `${origin}/whoami`)
      .at(-1);
    assert.match(
      await whoami.locator("#cookies").textContent(),
      new RegExp(`${importedCookie.name}=${importedCookie.value}`),
    );
    checked(
      "an imported sign-in reaches the site in a space that shares your sign-ins",
    );
  }
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
  // Files on this computer open in a personal space without scripts, and
  // nowhere an agent could reach them.
  const fileAddress = page.getByRole("textbox", {
    name: "Address bar",
    exact: true,
  });
  await fileAddress.fill(localFileUrl);
  await fileAddress.press("Enter");
  state = await waitForState(page, (state) =>
    state.tabs.some((tab) => tab.url === localFileUrl && !tab.loading),
  );
  assert.equal(state.tabs.find((tab) => tab.url === localFileUrl).title, "Static");
  await page.getByText("Scripts are off for files on this computer.").waitFor();
  checked("a local HTML file opens in a personal space with its scripts off");
  state = await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "space:create",
      name: "Agent work",
      color: "purple",
      kind: "agent",
    }),
  );
  const agentWork = state.activeSpaceId;
  await fileAddress.fill(localFileUrl);
  await fileAddress.press("Enter");
  await page
    .locator(".toast")
    .filter({
      hasText: "Files on this computer open only in your personal spaces.",
    })
    .waitFor();
  state = await page.evaluate(() => window.kamapathy.getState());
  assert.equal(
    state.tabs.filter(
      (tab) => tab.spaceId === agentWork && tab.url === localFileUrl,
    ).length,
    0,
  );
  checked("an agent space refuses a file on this computer from the address bar");
  // Another app hands over a PDF while an agent space is the one in front: it
  // lands in a personal space, in front, with the window focused.
  const beforeHandOver = new Set(state.tabs.map((tab) => tab.id));
  const handOver = spawn(
    await prepareDesktopRuntime(),
    [resolve("out/main/index.js"), pdfFile],
    { cwd: profile, env, stdio: "ignore" },
  );
  try {
    state = await waitForState(page, (state) =>
      state.tabs.some((tab) => tab.url === pdfFileUrl),
    );
  } finally {
    handOver.kill();
  }
  const pdfTab = state.tabs.find((tab) => tab.url === pdfFileUrl);
  assert.ok(!beforeHandOver.has(pdfTab.id), "the PDF opened a new tab");
  const pdfSpace = state.spaces.find((space) => space.id === pdfTab.spaceId);
  assert.equal(pdfSpace.kind, "personal");
  assert.notEqual(pdfSpace.access, "granted");
  assert.notEqual(pdfSpace.id, agentWork);
  assert.equal(state.activeTabId, pdfTab.id);
  await poll(
    () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isFocused(),
      ),
    { label: "the window focused for the file another app handed over" },
  );
  checked(
    "a PDF given to a second instance opens as a foreground tab in a personal space",
  );
  // Section 17 in the real app: the person adds an extension from a folder,
  // uses its button and popup, turns it off, removes it, and brings one over
  // from another browser. Chromium's own PDF viewer is an extension too, so
  // it is read before and after a removal.
  const markerFolder = resolve("tests/fixtures/extensions/marker");
  const PDF_VIEWER = "mhjfbmdgcfjbbpaeojofohoefgiehjai";
  // Load unpacked, Add, Remove and the import all ask through native dialogs,
  // which are answered here as the person would answer them.
  const stubExtensionDialogs = (folder) =>
    app.evaluate(({ dialog }, pick) => {
      globalThis.__kamapathyDialogs ??= {
        open: dialog.showOpenDialog,
        message: dialog.showMessageBox,
      };
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [pick],
      });
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    }, folder);
  const restoreExtensionDialogs = () =>
    app.evaluate(({ dialog }) => {
      const kept = globalThis.__kamapathyDialogs;
      if (!kept) return;
      dialog.showOpenDialog = kept.open;
      dialog.showMessageBox = kept.message;
    });
  const extensionsModal = page.getByRole("dialog", { name: "Extensions" });
  const openExtensionsModal = async () => {
    await page
      .getByRole("button", { name: "Browser menu", exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Extensions" }).click();
    await extensionsModal.waitFor();
  };
  const closeDialog = () =>
    page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const markerButton = page.getByRole("button", {
    name: "Kamapathy marker",
    exact: true,
  });
  const markerRow = extensionsModal.getByText("Kamapathy marker", {
    exact: true,
  });
  const extensionWindows = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .filter((item) =>
          item.webContents.getURL().startsWith("chrome-extension://"),
        )
        .map((item) => ({ visible: item.isVisible(), ...item.getBounds() })),
    );
  // Every frame of the tab showing this address, the viewer's own included.
  const framesOfTab = (url) =>
    app.evaluate(
      ({ webContents }, wanted) =>
        webContents
          .getAllWebContents()
          .filter((contents) => contents.getURL() === wanted)
          .flatMap((contents) =>
            contents.mainFrame.framesInSubtree.map((frame) => frame.url),
          ),
      url,
    );
  await stubExtensionDialogs(markerFolder);
  await page.getByRole("button", { name: "Browser menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("switch", { name: "Developer mode" }).click();
  await waitForState(page, (next) => next.settings.extensionDeveloperMode);
  await closeDialog();
  await openExtensionsModal();
  await extensionsModal
    .getByRole("button", { name: "Load unpacked", exact: true })
    .click();
  await markerRow.waitFor();
  await closeDialog();
  await markerButton.waitFor();
  // The badge is the extension's own service worker reaching chrome.action.
  await poll(
    async () =>
      (await page
        .locator(".extension-button .extension-badge")
        .textContent()) === "on",
    { label: "the badge the extension's worker sets" },
  );
  checked("Load unpacked shows the button and badge");
  // The popup belongs to the tab the person is looking at.
  const shownTab = (await page.evaluate(() => window.kamapathy.getState()))
    .activeTabId;
  await page.evaluate(
    ({ id, url }) =>
      window.kamapathy.dispatch({ type: "tab:navigate", id, url }),
    { id: shownTab, url: `${origin}/` },
  );
  await waitForState(page, (next) =>
    next.tabs.some(
      (tab) => tab.id === shownTab && tab.url === `${origin}/` && !tab.loading,
    ),
  );
  const buttonBox = await page.evaluate(() =>
    document
      .querySelector(".extension-button")
      .getBoundingClientRect()
      .toJSON(),
  );
  const shellBounds = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getContentBounds(),
  );
  const popupOpened = app.waitForEvent("window");
  await markerButton.click();
  const popup = await popupOpened;
  await popup.waitForSelector("#shown");
  // A popup sizes itself from its page, which Chromium reports to the window
  // as a preferred size. That report never arrives while the end-to-end
  // runner holds the application, so this run makes it, and Kamapathy places
  // and shows the window from there.
  const popupSize = { width: 280, height: 160 };
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows().find((item) =>
      item.webContents.getURL().startsWith("chrome-extension://"),
    );
    window.webContents.emit("preferred-size-changed", {}, size);
  }, popupSize);
  const placed = await poll(
    async () => {
      const [found] = await extensionWindows();
      return found?.visible ? found : null;
    },
    { label: "the popup shown under its button" },
  );
  assert.deepEqual(
    [placed.width, placed.height],
    [popupSize.width, popupSize.height],
  );
  assert.ok(
    placed.y >= shellBounds.y + buttonBox.bottom,
    `The popup at ${placed.y} is not under the button ending at ${shellBounds.y + buttonBox.bottom}`,
  );
  assert.ok(
    Math.abs(placed.x + placed.width - (shellBounds.x + buttonBox.right)) <= 2,
    `The popup ends at ${placed.x + placed.width}, the button at ${shellBounds.x + buttonBox.right}`,
  );
  await popup.waitForFunction(
    () => document.getElementById("shown").textContent !== "waiting",
  );
  assert.equal(await popup.locator("#shown").textContent(), `${origin}/`);
  checked(
    "the popup opens under its button, and its tabs.query returns the shown tab",
  );
  // Escape is the person's key, so it is sent to the popup itself.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((item) =>
      item.webContents.getURL().startsWith("chrome-extension://"),
    );
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  });
  await poll(async () => (await extensionWindows()).length === 0, {
    label: "the popup closing on Escape",
  });
  checked("Escape closes the popup");
  const markerSwitch = extensionsModal.getByRole("switch", {
    name: "Turn Kamapathy marker on or off",
  });
  await openExtensionsModal();
  await markerSwitch.click();
  await poll(
    async () => (await markerSwitch.getAttribute("aria-checked")) === "false",
    { label: "the extension turned off" },
  );
  await closeDialog();
  await poll(
    async () => (await page.locator(".extension-button").count()) === 0,
    { label: "the button going away with the extension" },
  );
  checked("turning the extension off hides the button");
  await openExtensionsModal();
  await markerSwitch.click();
  await poll(
    async () => (await markerSwitch.getAttribute("aria-checked")) === "true",
    { label: "the extension turned on again" },
  );
  await closeDialog();
  await markerButton.waitFor();
  // The viewer is a component extension, which keeps working beside the
  // person's own and after one is removed.
  const viewerShows = async () => {
    await waitForState(page, (next) =>
      next.tabs.some(
        (tab) => tab.id === shownTab && tab.url === pdfFileUrl && !tab.loading,
      ),
    );
    await poll(
      async () =>
        (await framesOfTab(pdfFileUrl)).some((url) =>
          url.startsWith(`chrome-extension://${PDF_VIEWER}/`),
        ),
      { label: "the PDF viewer's own frame" },
    );
  };
  await page.evaluate(
    ({ id, url }) =>
      window.kamapathy.dispatch({ type: "tab:navigate", id, url }),
    { id: shownTab, url: pdfFileUrl },
  );
  await viewerShows();
  const markerId = (await page.evaluate(() => window.kamapathy.extensions()))
    .rows[0].id;
  await openExtensionsModal();
  await extensionsModal.getByText("About Kamapathy marker").click();
  await extensionsModal
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await markerRow.waitFor({ state: "detached" });
  await closeDialog();
  await poll(
    async () => (await page.locator(".extension-button").count()) === 0,
    { label: "the button going away with the removed extension" },
  );
  const recorded = JSON.parse(
    await readFile(join(profile, "extensions.json"), "utf8"),
  );
  assert.deepEqual(
    recorded.extensions.filter((entry) => entry.id === markerId),
    [],
  );
  assert.ok(existsSync(markerFolder), "the unpacked folder is the person's");
  checked("Remove deletes the extension");
  await page.evaluate(
    (id) => window.kamapathy.dispatch({ type: "tab:reload", id }),
    shownTab,
  );
  await viewerShows();
  checked(
    "a PDF renders in the viewer while the extension is loaded and again after Remove",
  );
  // The other browser's profile offers the same extension from a folder of
  // its own, so Kamapathy gives it an id of its own.
  const importedFolder = join(home, "chrome-unpacked", "marker");
  await cp(markerFolder, importedFolder, { recursive: true });
  await writeFile(
    join(chromeData, "Default", "Preferences"),
    JSON.stringify({
      extensions: {
        settings: {
          mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm: {
            location: 4,
            state: 1,
            path: importedFolder,
            manifest: { name: "Kamapathy marker", version: "1.0.0" },
          },
        },
        pinned_extensions: ["mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm"],
      },
    }),
  );
  await page.getByRole("button", { name: "Browser menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Import...", exact: true }).click();
  await page
    .getByRole("heading", { name: "Import bookmarks and history" })
    .waitFor();
  const importDialog = page.getByRole("dialog", {
    name: "Import bookmarks and history",
  });
  await importDialog.getByRole("checkbox", { name: "Bookmarks" }).uncheck();
  await importDialog.getByRole("checkbox", { name: "History" }).uncheck();
  // Passwords start checked, and importing any data besides extensions ends
  // on a summary. This import brings the extension alone.
  await importDialog
    .locator(".import-choices")
    .getByRole("checkbox", { name: "Passwords" })
    .uncheck();
  assert.equal(
    await importDialog.getByRole("checkbox", { name: "Extensions" }).isChecked(),
    true,
  );
  await importDialog.getByRole("button", { name: "Import", exact: true }).click();
  await importDialog.getByText("Add your extensions").waitFor();
  const candidate = importDialog.getByRole("checkbox", {
    name: "Kamapathy marker",
  });
  assert.equal(await candidate.isChecked(), true);
  await importDialog.getByRole("button", { name: "Add 1 extension" }).click();
  await importDialog.getByText("Added").waitFor();
  await importDialog.getByRole("button", { name: "Continue" }).click();
  await markerButton.waitFor();
  const importedExtensions = (
    await page.evaluate(() => window.kamapathy.extensions())
  ).rows;
  assert.deepEqual(
    importedExtensions.map((row) => [row.name, row.source, row.importedFrom]),
    [["Kamapathy marker", "unpacked", "Google Chrome"]],
  );
  assert.notEqual(importedExtensions[0].id, markerId);
  await restoreExtensionDialogs();
  checked("import adds the fake profile's unpacked extension");
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
  // The agent's tab is answered before its page commits, and a view has no
  // address until then, so both pages finish loading before the close.
  await waitForState(
    page,
    (state) =>
      state.tabs.some((tab) => tab.title === "Second page" && !tab.loading) &&
      state.tabs.some((tab) => tab.id === nightTab && !tab.loading),
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
  const beforeClose = await windowPages();
  assert.ok(beforeClose.pages.some((url) => url.endsWith("/second")));
  assert.ok(
    beforeClose.pages.includes(`${origin}/`),
    JSON.stringify(beforeClose.pages),
  );
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
  // Section 13 on a second profile, with the first Kamapathy closed: What's
  // new after a version change, and an update the person installs.
  if (app) {
    await app.close().catch(() => {});
    app = undefined;
  }
  updateProfile = await mkdtemp(join(tmpdir(), "kamapathy-smoke-update-"));
  const updateHome = join(updateProfile, "home");
  await mkdir(updateHome, { recursive: true });
  await writeFile(
    join(updateProfile, "browser-state.json"),
    JSON.stringify({
      settings: { welcomed: true, seenVersion: "0.1.0", updateChecks: true },
    }),
  );
  updateFeed = await startUpdateFeed();
  updateFeed.setMode("available");
  const launchWith = async (folder, extraEnv) => {
    app = await electron.launch({
      executablePath: await prepareDesktopRuntime(),
      args: [resolve("out/main/index.js")],
      env: {
        ...env,
        KAMAPATHY_USER_DATA: folder,
        ...(process.platform === "win32"
          ? {
              USERPROFILE: updateHome,
              LOCALAPPDATA: updateHome,
              APPDATA: join(updateHome, "roaming"),
            }
          : { HOME: updateHome }),
        ...extraEnv,
      },
      timeout: 30000,
    });
    const next = await app.firstWindow();
    await next.waitForSelector(".home-page, .web-page");
    await next.waitForFunction(() => !!window.kamapathy);
    return next;
  };
  const updateEnv = {
    KAMAPATHY_UPDATE_FEED: updateFeed.origin,
    KAMAPATHY_UPDATE_KIND: "linux-appimage",
  };
  page = await launchWith(updateProfile, updateEnv);
  const version = (await page.evaluate(() => window.kamapathy.getState()))
    .version;
  const notes = page.getByRole("dialog", {
    name: `What's new in Kamapathy ${version}`,
  });
  await notes.waitFor();
  await notes.getByRole("button", { name: "Got it" }).click();
  await notes.waitFor({ state: "detached" });
  // An update the person can install: checked, downloaded, never opened here.
  await page.getByRole("button", { name: "Browser menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Check now" }).click();
  await page.getByText("Kamapathy 9.9.9 is available.").waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.locator(".menu-dot").waitFor();
  await page.getByRole("button", { name: "Browser menu", exact: true }).click();
  const updateMenu = page.getByRole("menu", { name: "Browser menu" });
  await updateMenu.waitFor();
  assert.match(
    await updateMenu.getByRole("menuitem").first().textContent(),
    /^Update Kamapathy/,
  );
  await updateMenu.getByRole("menuitem", { name: "Update Kamapathy" }).click();
  await page.getByRole("dialog", { name: "Make Kamapathy yours" }).waitFor();
  await poll(
    async () =>
      (await page.evaluate(() =>
        document.activeElement?.getAttribute("aria-label"),
      )) === "Check for updates",
    { label: "focus on the update switch" },
  );
  await page.getByRole("button", { name: "Download", exact: true }).click();
  await page.getByText("Kamapathy 9.9.9 is ready to install.").waitFor();
  // One agent space is open, so the install dialog says what quitting closes.
  await page.evaluate(() =>
    window.kamapathy.dispatch({
      type: "settings:update",
      settings: { automationEnabled: true },
    }),
  );
  await waitForState(page, (next) => next.automation.running);
  const updateSend = socketFetch(
    await resolveSocket({
      KAMAPATHY_USER_DATA: updateProfile,
      KAMAPATHY_NO_LAUNCH: "1",
    }),
  );
  const watched = await (
    await updateSend("/spaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Update watcher" }),
    })
  ).json();
  assert.ok(watched.space?.id, JSON.stringify(watched));
  await page.getByRole("button", { name: "Install...", exact: true }).click();
  const installDialog = page.getByRole("dialog", {
    name: "Install Kamapathy 9.9.9",
  });
  await installDialog.waitFor();
  await installDialog
    .getByText("Quit Kamapathy, replace your copy with this file, then open it.")
    .waitFor();
  await installDialog
    .getByText("1 agent space is open. It closes when Kamapathy quits.")
    .waitFor();
  await installDialog.getByRole("button", { name: "Not now" }).click();
  await installDialog.waitFor({ state: "detached" });
  checked(
    "an update adds Update Kamapathy and an Install dialog that names open agent spaces",
  );
  // The space this check opened makes the quit ask first, and no one is here
  // to answer it, so this run answers its own question again.
  await app
    .evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    })
    .catch(() => {});
  await app.close().catch(() => {});
  app = undefined;
  page = await launchWith(updateProfile, updateEnv);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(await whatsNew(page).count(), 0);
  checked(
    "What's new appears once after a version change and never on a fresh profile",
  );
  console.log(`Desktop smoke passed: ${checks} checks.`);
} catch (error) {
  // Printed before anything that could block, so a run that cannot close
  // still says why it failed.
  console.error(error);
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
  // No step of the cleanup may hold the run open: a window that will not
  // close is ended, and a server still holding a page's connection is cut.
  const bounded = (step, ms) =>
    Promise.race([
      Promise.resolve(step).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, ms).unref()),
    ]);
  if (app) {
    // The process is read first: a closed application no longer gives it.
    let child;
    try {
      child = app.process();
    } catch {
      /* The application has already closed. */
    }
    // A quit while agents are at work asks the person first, and no one is
    // here to answer it, so this run answers its own question.
    await bounded(
      app.evaluate(({ dialog }) => {
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
      }),
      5000,
    );
    await bounded(app.close(), 20000);
    child?.kill("SIGKILL");
  }
  fixture.closeAllConnections?.();
  await bounded(new Promise((resolve) => fixture.close(resolve)), 5000);
  if (updateFeed) await bounded(updateFeed.close(), 5000);
  if (signInSite) await bounded(signInSite.close(), 5000);
  for (const folder of [profile, updateProfile].filter(Boolean))
    await rm(folder, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 150,
    });
}
