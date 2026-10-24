import { prepareDesktopRuntime } from "./desktop-runtime.mjs";
import { waitForState } from "./wait.mjs";
import { _electron as electron } from "playwright";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveSocket,
  socketFetch,
} from "../skills/kamapathy/scripts/kamapathy.mjs";

const style = `
  body{margin:0;font:17px/1.7 Georgia,"Times New Roman",serif;color:#1f2328;background:#fbfaf7}
  header{display:flex;align-items:center;gap:28px;padding:18px 48px;border-bottom:1px solid #ece8df;font:500 14px system-ui,sans-serif}
  header b{font:700 18px Georgia,serif;margin-right:auto}
  header a{color:#6b6b6b;text-decoration:none}
  main{max-width:680px;margin:0 auto;padding:56px 24px}
  .kicker{font:600 12px system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#9a6b2f}
  h1{font-size:46px;line-height:1.1;letter-spacing:-.01em;margin:12px 0 16px}
  .byline{font:14px system-ui,sans-serif;color:#6b6b6b;margin-bottom:28px}
  .art{height:240px;border-radius:14px;margin:0 0 32px;background:radial-gradient(180px 90px at 28% 108%,#6f8f5f 60%,transparent 61%),radial-gradient(240px 120px at 72% 112%,#4f6f45 60%,transparent 61%),radial-gradient(34px 34px at 80% 30%,#f4c56b 70%,transparent 72%),linear-gradient(#f3ddc0,#e9c9a8)}
  .art.trail{background:radial-gradient(circle at 30% 45%,#d8e6cf 0 110px,transparent 111px),radial-gradient(circle at 70% 60%,#d8e6cf 0 140px,transparent 141px),#eef1ea}
  p{margin:0 0 20px}
  a{color:#2f6b4f}
  dl{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 32px;font-family:system-ui,sans-serif}
  dl div{padding:14px 16px;border:1px solid #ece8df;border-radius:12px;background:#fff}
  dt{font-size:12px;color:#6b6b6b}dd{margin:2px 0 0;font-size:18px;font-weight:600}`;
const pages = {
  "/": {
    title: "The quiet web · Field Notes",
    body: `<div class="kicker">Essay</div><h1>The quiet web</h1><div class="byline">By Ana Ortiz · 6 min read</div><div class="art"></div><p>Some of the best corners of the internet are the slow ones: a long read, a trail report, a recipe someone has cooked for twenty years and finally wrote down.</p><p>They ask for a little patience and give back a garden of small discoveries. The trick is making room for them in a day that is mostly tabs, alerts and things to do.</p><p><a href="/second">Read next: the ridge loop</a></p>`,
  },
  "/second": {
    title: "Ridge loop trail · Field Notes",
    body: `<div class="kicker">Trail guide</div><h1>Ridge loop</h1><div class="byline">Updated this week · Moderate</div><dl><div><dt>Distance</dt><dd>7.4 km</dd></div><div><dt>Time</dt><dd>3 hours</dd></div><div><dt>Climb</dt><dd>420 m</dd></div></dl><div class="art trail"></div><p>Start at the north lot and follow the creek for the first kilometre before the path turns up through the pines.</p>`,
  },
};
const html = (path) => {
  const page = pages[path] ?? pages["/"];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${page.title}</title><style>${style}</style></head><body><header><b>Field Notes</b><a href="/">Essays</a><a href="/second">Trails</a><a href="/">About</a></header><main>${page.body}</main></body></html>`;
};

export async function startFixture() {
  const server = createServer((request, response) => {
    if (request.url === "/broken") {
      request.socket.destroy();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html(request.url));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise((done) => server.close(done)),
  };
}

export async function setupReview({ shell, dispatch, api, origin }) {
  const { activeTabId: page } = await shell.evaluate(() =>
    window.kamapathy.getState(),
  );
  await dispatch({ type: "tab:navigate", id: page, url: origin });
  const open = async (url, spaceId) =>
    (await dispatch({ type: "tab:create", url, spaceId, background: true })).tabs.at(-1)
      .id;
  const page2 = await open(`${origin}/second`);
  // Error pages wait in the Work space, out of the Personal tab strip.
  const broken = await open(`${origin}/broken`, "work");
  const home = (await dispatch({ type: "tab:create", background: true })).tabs.at(
    -1,
  ).id;
  const signIn = await open(
    "https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fexample.com%2F",
    "work",
  );
  const { space } = await api("/spaces", "POST", { name: "Review agent" });
  const { tab } = await api(`/spaces/${space.id}/tabs`, "POST", { url: origin });
  await waitForState(
    shell,
    (state) => state.tabs.every((item) => !item.loading),
    undefined,
    { timeoutMs: 20000 },
  );
  return {
    page,
    page2,
    broken,
    home,
    signIn,
    agentSpace: space.id,
    agentTab: tab.id,
  };
}

// Native pages are not part of the shell's own screenshot, so their captures
// are drawn into the shell for the moment of each shot.
async function shoot(app, shell, path, radius) {
  const frames = await app.evaluate(async ({ BrowserWindow }) =>
    Promise.all(
      BrowserWindow.getAllWindows()[0]
        .contentView.children.filter((view) => view.getVisible())
        .map(async (view) => ({
          ...view.getBounds(),
          image: (await view.webContents.capturePage()).toDataURL(),
        })),
    ),
  );
  await shell.evaluate(
    ({ frames, radius }) => {
      for (const frame of frames) {
        const image = document.createElement("img");
        image.className = "review-frame";
        image.src = frame.image;
        Object.assign(image.style, {
          position: "fixed",
          left: `${frame.x}px`,
          top: `${frame.y}px`,
          width: `${frame.width}px`,
          height: `${frame.height}px`,
          borderRadius: `${radius}px`,
          zIndex: "5",
        });
        document.body.append(image);
      }
    },
    { frames, radius },
  );
  await shell.waitForFunction(() =>
    [...document.querySelectorAll(".review-frame")].every(
      (image) => image.complete,
    ),
  );
  await shell.screenshot({ path });
  await shell.evaluate(() =>
    document.querySelectorAll(".review-frame").forEach((image) => image.remove()),
  );
}

export async function captureSurfaces({
  main = resolve("out/main/index.js"),
  outDir,
  surfaces,
  frameRadius = 10,
  welcome = false,
}) {
  const profile = await mkdtemp(join(tmpdir(), "kamapathy-screens-"));
  const fixture = await startFixture();
  const env = { ...process.env, KAMAPATHY_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  let app;
  try {
    app = await electron.launch({
      executablePath: await prepareDesktopRuntime(),
      // Pages show a readable address instead of a local port.
      args: [
        `--host-resolver-rules=MAP fieldnotes.example:80 127.0.0.1:${fixture.port}`,
        main,
      ],
      env,
      timeout: 30000,
    });
    const shell = await app.firstWindow();
    await shell.waitForSelector(".home-page, .web-page");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );
    await waitForState(shell, (state) => state.automation.running);
    const setTheme = async (theme) => {
      await shell.evaluate(
        (theme) => window.kamapathy.dispatch({ type: "settings:update", settings: { theme } }),
        theme,
      );
      await shell.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
    };
    // The welcome dialog opens once per profile, before anything else, and
    // walks through its six steps.
    const welcomeDialog = shell.locator(".welcome-modal");
    const heading = (name) => welcomeDialog.getByRole("heading", { name }).waitFor();
    const press = (name) => welcomeDialog.getByRole("button", { name }).click();
    await heading("Welcome to Kamapathy");
    if (welcome) {
      await mkdir(outDir, { recursive: true });
      for (const theme of ["light", "dark"]) {
        await setTheme(theme);
        await shell.waitForTimeout(300);
        await shoot(app, shell, join(outDir, `welcome-${theme}.png`), frameRadius);
      }
    }
    await press("Get started");
    await heading("Your data stays here");
    await press("Next");
    await heading("Bring your browser with you");
    // The import panel offers Continue when it finds no other browser.
    await press(/^(Skip|Continue)$/);
    await heading("Connect your agent");
    await press("Set up later");
    await heading("Sign in once");
    if (welcome)
      for (const theme of ["light", "dark"]) {
        await setTheme(theme);
        await shell.waitForTimeout(300);
        await shoot(app, shell, join(outDir, `welcome-sites-${theme}.png`), frameRadius);
      }
    await press("Next");
    await heading("You're all set");
    await press("Start browsing");
    await welcomeDialog.waitFor({ state: "detached" });
    await setTheme("light");
    // Serves Google's rejected sign-in page locally, so its notice shows offline.
    await app.evaluate(({ session }) =>
      session
        .fromPartition("persist:space-personal")
        .protocol.handle(
          "https",
          () =>
            new Response(
              "<!doctype html><title>Couldn't sign you in</title><h1>Couldn't sign you in</h1>",
              { headers: { "Content-Type": "text/html" } },
            ),
        ),
    );
    const agentEnv = { KAMAPATHY_USER_DATA: profile, KAMAPATHY_NO_LAUNCH: "1" };
    // Resolved per call: turning agent access off and on starts a new service.
    const api = async (path, method = "GET", body) =>
      (
        await socketFetch(await resolveSocket(agentEnv))(path, {
          method,
          headers:
            body === undefined ? {} : { "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
      ).json();
    const dispatch = (action) =>
      shell.evaluate((action) => window.kamapathy.dispatch(action), action);
    const context = { app, shell, api, dispatch, origin: "http://fieldnotes.example" };
    context.ids = await setupReview(context);
    await mkdir(outDir, { recursive: true });
    // Each surface is shot in both themes before the next one opens, so the
    // surfaces that turn agent access off can come last.
    for (const [name, surface] of Object.entries(surfaces))
      for (const theme of ["light", "dark"]) {
        await setTheme(theme);
        await surface.open(context);
        await shell.waitForTimeout(400);
        await shoot(app, shell, join(outDir, `${name}-${theme}.png`), frameRadius);
        await surface.close?.(context);
        await shell.waitForTimeout(150);
      }
  } finally {
    await app?.close().catch(() => {});
    await fixture.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
}

export async function writeIndex(root) {
  const column = async (folder) =>
    (await readdir(join(root, folder)).catch(() => []))
      .filter((name) => name.endsWith(".png"))
      .sort()
      .map(
        (name) =>
          `<figure><img src="${folder}/${name}" loading="lazy" alt=""><figcaption>${name}</figcaption></figure>`,
      )
      .join("\n");
  await writeFile(
    join(root, "index.html"),
    `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Kamapathy before and after</title>
<style>body{font:14px system-ui;margin:24px;display:grid;grid-template-columns:1fr 1fr;gap:24px}img{width:100%;border:1px solid #ccc}figure{margin:0 0 24px}</style>
<section><h1>Before</h1>${await column("before")}</section>
<section><h1>After</h1>${await column("after")}</section></html>`,
  );
}

const escape = ({ shell }) => shell.keyboard.press("Escape");
const closeDialog = ({ shell }) =>
  shell.getByRole("button", { name: "Close dialog", exact: true }).click();
const activate =
  (key) =>
  ({ dispatch, ids }) =>
    dispatch({ type: "tab:activate", id: ids[key] });
export const surfaceHelpers = { escape, closeDialog, activate };

async function fromMenu(shell, name) {
  await shell.getByRole("button", { name: "Browser menu", exact: true }).click();
  await shell.getByRole("menuitem", { name }).click();
}
async function shortcutMenu(context) {
  await activate("home")(context);
  await context.shell
    .getByRole("navigation", { name: "Shortcuts" })
    .getByRole("button")
    .first()
    .click({ button: "right" });
  await context.shell.getByRole("menu", { name: / shortcut$/ }).waitFor();
}
const agentBar = (shell) => shell.getByRole("region", { name: "Review agent" });

export const afterSurfaces = {
  "new-tab": { open: activate("home") },
  "web-page": { open: activate("page") },
  "tab-search": {
    open: async (context) => {
      await activate("page")(context);
      await context.shell.locator(".strip-search").click();
      await context.shell.getByRole("menu", { name: "Search tabs" }).waitFor();
    },
    close: escape,
  },
  "browser-menu": {
    open: async ({ shell }) => {
      await shell.getByRole("button", { name: "Browser menu", exact: true }).click();
      await shell.getByRole("menu", { name: "Browser menu" }).waitFor();
    },
    close: escape,
  },
  "space-popover": {
    open: async ({ shell }) => {
      await shell.getByRole("button", { name: /^Spaces: / }).click();
      await shell.getByRole("menu", { name: "Spaces" }).waitFor();
    },
    close: escape,
  },
  "spaces-grid": {
    open: async ({ shell }) => {
      await shell.keyboard.press("Alt+KeyS");
      await shell.getByRole("dialog", { name: "All spaces" }).waitFor();
    },
    close: escape,
  },
  "agent-browsing": {
    open: async ({ dispatch, api, ids }) => {
      await dispatch({ type: "tab:activate", id: ids.agentTab });
      await api(`/tabs/${ids.agentTab}/snapshot`);
    },
  },
  "agent-handed-over": {
    open: async ({ dispatch, api, ids }) => {
      await api(`/spaces/${ids.agentSpace}/handoff`, "POST", {});
      await dispatch({ type: "tab:activate", id: ids.agentTab });
    },
    close: ({ api, ids }) => api(`/spaces/${ids.agentSpace}/resume`, "POST", {}),
  },
  "needs-you": {
    open: async ({ shell, dispatch, api, ids }) => {
      await dispatch({ type: "tab:activate", id: ids.page });
      await api(`/spaces/${ids.agentSpace}/handoff`, "POST", {});
      await shell.getByRole("button", { name: /an agent needs you/ }).click();
      await shell.getByRole("menu", { name: "Spaces" }).waitFor();
    },
    close: async ({ shell, api, ids }) => {
      await shell.keyboard.press("Escape");
      await api(`/spaces/${ids.agentSpace}/resume`, "POST", {});
    },
  },
  activity: {
    open: async ({ shell }) => {
      await shell.getByRole("button", { name: /^Spaces: / }).click();
      await shell.getByRole("menuitem", { name: "Details for Review agent" }).click();
      await shell.getByRole("menuitem", { name: "View all" }).click();
      await shell.getByRole("heading", { name: "Review agent activity" }).waitFor();
    },
    close: closeDialog,
  },
  find: {
    open: async ({ shell, dispatch, ids }) => {
      await dispatch({ type: "tab:activate", id: ids.page });
      await shell.keyboard.press("ControlOrMeta+F");
      await shell.getByRole("textbox", { name: "Find in page" }).fill("garden");
    },
    close: escape,
  },
  "command-palette": {
    open: async ({ shell }) => {
      await shell.keyboard.press("ControlOrMeta+K");
      await shell.getByRole("combobox").waitFor();
    },
    close: escape,
  },
  settings: { open: ({ shell }) => fromMenu(shell, "Settings"), close: closeDialog },
  "settings-agents": {
    open: async ({ shell }) => {
      await fromMenu(shell, "Settings");
      await shell
        .getByRole("switch", { name: "Enable agent connection" })
        .scrollIntoViewIfNeeded();
    },
    close: closeDialog,
  },
  bookmarks: {
    open: ({ shell }) => shell.keyboard.press("ControlOrMeta+Shift+B"),
    close: closeDialog,
  },
  history: {
    open: ({ shell }) =>
      shell.keyboard.press(process.platform === "darwin" ? "Meta+Y" : "Control+H"),
    close: closeDialog,
  },
  downloads: {
    open: ({ shell }) => shell.keyboard.press("ControlOrMeta+Shift+J"),
    close: closeDialog,
  },
  "new-space": { open: ({ shell }) => fromMenu(shell, "New space"), close: closeDialog },
  "space-options": {
    open: async ({ shell }) => {
      await shell.getByRole("button", { name: /^Spaces: / }).click();
      await shell.getByRole("menuitem", { name: "Options for Work" }).click();
      await shell
        .getByRole("menuitemcheckbox", { name: "Separate sign-ins" })
        .waitFor();
    },
    close: escape,
  },
  import: {
    open: async ({ shell }) => {
      await fromMenu(shell, "Settings");
      await shell.getByRole("button", { name: "Import...", exact: true }).click();
      await shell
        .getByRole("button", { name: /^(Skip|Continue|Import)$/ })
        .first()
        .waitFor();
    },
    close: closeDialog,
  },
  "tab-menu": {
    open: ({ shell }) =>
      shell
        .locator('[role="tab"][aria-selected="true"]')
        .click({ button: "right" }),
    close: closeDialog,
  },
  "split-view": {
    open: async ({ dispatch, ids }) => {
      await dispatch({ type: "tab:activate", id: ids.page });
      await dispatch({ type: "tab:split", id: ids.page2 });
    },
    close: ({ dispatch }) => dispatch({ type: "tab:split", id: null }),
  },
  "bookmarks-bar": {
    open: ({ dispatch }) =>
      dispatch({ type: "settings:update", settings: { showBookmarksBar: true } }),
    close: ({ dispatch }) =>
      dispatch({ type: "settings:update", settings: { showBookmarksBar: false } }),
  },
  "page-error": { open: activate("broken") },
  "sign-in-rejected": { open: activate("signIn") },
  "split-picker": {
    open: async (context) => {
      await activate("page")(context);
      await fromMenu(context.shell, "Split view");
      await context.shell
        .getByRole("heading", { name: "A wider perspective" })
        .waitFor();
    },
    close: closeDialog,
  },
  "bookmark-dialog": {
    open: async (context) => {
      await activate("page")(context);
      await context.shell.keyboard.press("ControlOrMeta+D");
      await context.shell
        .getByRole("heading", { name: "Keep something good" })
        .waitFor();
    },
    close: closeDialog,
  },
  notification: {
    open: async (context) => {
      await activate("page")(context);
      await context.shell.keyboard.press("ControlOrMeta+D");
      await context.shell.getByRole("button", { name: "Save bookmark" }).click();
      await context.shell.locator(".toast").waitFor();
    },
    close: ({ shell }) =>
      shell.getByRole("button", { name: "Dismiss notification" }).click(),
  },
  "shortcut-menu": { open: shortcutMenu, close: escape },
  "edit-shortcut": {
    open: async (context) => {
      await shortcutMenu(context);
      await context.shell.getByRole("menuitem", { name: "Edit" }).click();
      await context.shell.getByRole("heading", { name: "Edit shortcut" }).waitFor();
    },
    close: closeDialog,
  },
  "stop-all-confirm": {
    open: async ({ shell, dispatch, ids }) => {
      await dispatch({ type: "tab:activate", id: ids.agentTab });
      await agentBar(shell)
        .getByRole("button", { name: "Stop", exact: true })
        .click();
      await agentBar(shell).getByText("Stop the agent in this space?").waitFor();
    },
    close: ({ shell }) =>
      agentBar(shell).getByRole("button", { name: "Cancel" }).click(),
  },
  // The last two turn agent access off, so every surface that calls the agent
  // API comes before them.
  "agent-paused": {
    open: async ({ shell, dispatch, ids }) => {
      await dispatch({
        type: "settings:update",
        settings: { automationEnabled: false },
      });
      await dispatch({ type: "tab:activate", id: ids.agentTab });
      await agentBar(shell).getByText("Review agent · Agent access is off").waitFor();
    },
  },
  "access-off-line": {
    open: async ({ shell, dispatch }) => {
      await dispatch({
        type: "settings:update",
        settings: { automationEnabled: false },
      });
      await shell.getByRole("button", { name: /^Spaces: / }).click();
      await shell
        .getByRole("menuitem", { name: "Agent access is off · Turn on" })
        .waitFor();
    },
    close: async ({ shell, dispatch }) => {
      await shell.keyboard.press("Escape");
      await dispatch({
        type: "settings:update",
        settings: { automationEnabled: true },
      });
      await waitForState(shell, (state) => state.automation.running);
    },
  },
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = resolve("artifacts/screens");
  if (!process.argv.includes("--index")) {
    await captureSurfaces({
      outDir: join(root, "after"),
      surfaces: afterSurfaces,
      welcome: true,
    });
    await mkdir("docs/images", { recursive: true });
    for (const [from, to] of [
      ["welcome-light", "kamapathy-welcome-light"],
      ["welcome-dark", "kamapathy-welcome-dark"],
      ["web-page-light", "kamapathy-light"],
      ["web-page-dark", "kamapathy-dark"],
      ["agent-browsing-light", "kamapathy-agents-light"],
      ["agent-browsing-dark", "kamapathy-agents-dark"],
      ["command-palette-light", "kamapathy-command-light"],
      ["command-palette-dark", "kamapathy-command-dark"],
      ["spaces-grid-light", "kamapathy-spaces-light"],
      ["spaces-grid-dark", "kamapathy-spaces-dark"],
      ["split-view-light", "kamapathy-split-light"],
      ["split-view-dark", "kamapathy-split-dark"],
      ["new-tab-light", "kamapathy-newtab-light"],
      ["new-tab-dark", "kamapathy-newtab-dark"],
    ])
      await copyFile(
        join(root, "after", `${from}.png`),
        join("docs/images", `${to}.png`),
      );
  }
  await writeIndex(root);
  console.log(`Open ${join(root, "index.html")} to compare before and after.`);
}
