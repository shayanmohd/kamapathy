<p align="center">
  <a href="https://kamapathy.app"><img src="public/kamapathy-mark.svg" alt="Kamapathy" width="84" /></a>
</p>

<h1 align="center">Kamapathy</h1>

<p align="center"><strong>A calm browser you share with your agents.</strong></p>

<p align="center">
  Sign in once. Let an agent work in a space of its own, with your sign-ins, where you can see it.<br />
  Take over with one click, and hand it back when you're ready.
</p>

<p align="center">
  <a href="https://kamapathy.app"><strong>Download</strong></a>
  &nbsp;·&nbsp;
  <a href="https://kamapathy.app/#demo"><strong>Try the live demo</strong></a>
  &nbsp;·&nbsp;
  <a href="docs/automation.md">Agent guide</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/shayanmohd/kamapathy/issues">Feedback</a>
</p>

<p align="center">
  <a href="https://github.com/shayanmohd/kamapathy/actions/workflows/build.yml"><img src="https://github.com/shayanmohd/kamapathy/actions/workflows/build.yml/badge.svg" alt="Desktop build" /></a>
  <a href="https://github.com/shayanmohd/kamapathy/releases"><img src="https://img.shields.io/github/v/release/shayanmohd/kamapathy?include_prereleases&label=release&color=2f6b4f" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f6b4f" alt="MIT license" /></a>
  <img src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-desktop-2f6b4f" alt="macOS, Windows and Linux" />
</p>

<p align="center">Works with Claude Code, Codex, Cursor and any agent that can run a command.</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/kamapathy-dark.png" />
  <img src="docs/images/kamapathy-light.png" alt="Kamapathy showing an article, with tabs across the top and one rounded address bar" width="100%" />
</picture>

<p align="center"><sub>Screenshots follow your GitHub theme. Switch between light and dark to see both.</sub></p>

## Why Kamapathy

Browsers were built for one person at a keyboard. Coding and research agents now want to browse too, and the sites they need are the ones you are already signed in to. Kamapathy lets you sign in once. Every space and every agent can use that session, so an agent books the table, files the ticket or reads the dashboard as you, in a space of its own, in plain sight, while you keep browsing next to it. When you would rather it didn't, give that one space separate sign-ins, isolate every agent space with a switch, or turn off agent access and stop everything at once.

It is also simply a good browser: Chromium underneath, a small interface on top, and nothing that competes with the page.

<table>
  <tr>
    <td width="33%" valign="top">
      <h3>Spaces</h3>
      Personal spaces for work, home and side projects, agent spaces for whatever you hand off. One shortcut lays every space out side by side.
    </td>
    <td width="33%" valign="top">
      <h3>Agents in plain sight</h3>
      A green ring, the agent's own cursor and a short status show what an agent is doing. <b>Take over</b> pauses it, <b>Let agent continue</b> hands it back, <b>Stop</b> ends its work in that space.
    </td>
    <td width="33%" valign="top">
      <h3>Your sign-ins, on purpose</h3>
      Sign in once and every space and agent can use it. Give any space <b>Separate sign-ins</b>, or isolate every agent space from Settings.
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <h3>Bring your browser with you</h3>
      On first launch, import bookmarks, history and, if you like, your sign-ins and saved passwords: a checkbox for every profile of Chrome, Chromium, Edge, Brave, Arc, Vivaldi, Opera and Firefox, and Safari from the file it exports. Sign-ins join your shared sign-ins, or a new space for each profile. Passwords come from the Chrome-based browsers, or from a CSV file any browser or password manager exports. Later, from Settings.
    </td>
    <td width="33%" valign="top">
      <h3>Sees the whole page</h3>
      Snapshots read open shadow roots and same-origin frames, nested ones too, and list cross-origin frames so an agent knows they are there.
    </td>
    <td width="33%" valign="top">
      <h3>Quiet by design</h3>
      Tabs across the top, one address bar, one menu. No account, no feed, no telemetry. Light and dark themes with a single accent.
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <h3>Your default browser</h3>
      Make Kamapathy your default browser from Settings. Links and files other apps hand over open in a personal space, and a link out to another app asks you first.
    </td>
    <td width="33%" valign="top">
      <h3>PDFs in the tab</h3>
      PDFs open in Chromium's own viewer in every space. Agents read one with <code>pdf-text</code>, page by page, instead of reaching into the viewer.
    </td>
    <td width="33%" valign="top">
      <h3>Files on this computer</h3>
      Open a local PDF, image, text file or page in a personal space. Local pages run with scripts off, and agents never see those tabs.
    </td>
  </tr>
</table>

Kamapathy also runs your extensions. Add one from the Chrome Web Store with the **Add to Kamapathy** button in the address bar or from the Extensions dialog, after Kamapathy checks the store's signatures and asks you, or bring the ones you already have over from Chrome, Chromium, Edge, Brave, Arc, Vivaldi and Opera, whose data stays behind. Manifest V3 only, and only part of the extension API works, so the dialog that asks you lists what won't. They run in your spaces and in agent spaces that share your sign-ins, never in isolated ones. If you add extensions, Kamapathy asks the Chrome Web Store once a day whether they have updates, sending their IDs and versions. Turn this off in Settings, under Extensions.

## Take the tour

Each section opens to a screenshot. Want to click around instead? The [live demo](https://kamapathy.app/#demo) runs a working copy of the interface in your browser, agent included.

<details open>
<summary><strong>An agent at work</strong>: a ring around its page and a bar to stop it</summary>
<br />
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/kamapathy-agents-dark.png" />
  <img src="docs/images/kamapathy-agents-light.png" alt="An agent's page framed by a green ring, with a bar underneath offering Take over and Stop all agents" width="100%" />
</picture>
</details>

<details>
<summary><strong>First launch: six steps</strong>: spaces, your data, import, your agent, signing in once and your default browser</summary>
<br />
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/kamapathy-welcome-dark.png" />
  <img src="docs/images/kamapathy-welcome-light.png" alt="The first welcome step, introducing your spaces and agent spaces, with a Get started button" width="100%" />
</picture>
</details>

<details>
<summary><strong>All your spaces at once</strong>: Option+S on macOS, Alt+S elsewhere</summary>
<br />
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/kamapathy-spaces-dark.png" />
  <img src="docs/images/kamapathy-spaces-light.png" alt="A grid of spaces with a live capture of each one, including an agent's space" width="100%" />
</picture>
</details>

<details>
<summary><strong>Split view</strong>: two live pages in one window</summary>
<br />
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/kamapathy-split-dark.png" />
  <img src="docs/images/kamapathy-split-light.png" alt="Two pages side by side in one window" width="100%" />
</picture>
</details>

<details>
<summary><strong>The command menu</strong>: jump to any tab or action from the keyboard</summary>
<br />
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/kamapathy-command-dark.png" />
  <img src="docs/images/kamapathy-command-light.png" alt="The command menu listing open tabs across spaces and browser actions" width="100%" />
</picture>
</details>

<details>
<summary><strong>A quiet new tab</strong>: a search box and your shortcuts</summary>
<br />
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/kamapathy-newtab-dark.png" />
  <img src="docs/images/kamapathy-newtab-light.png" alt="The new tab page with a centered search box and a row of shortcut tiles" width="100%" />
</picture>
</details>

## How it compares

Two kinds of tools already let software browse. Kamapathy is neither: it is your own browser, and the agent is whichever one you already use.

| | Kamapathy | Automation libraries <sup>1</sup> | AI browsers with a built in assistant <sup>2</sup> |
| --- | :---: | :---: | :---: |
| Your own daily browser | ✓ | No | ✓ |
| Any agent you already use | ✓ | ✓ | No |
| Several agents at once, each in its own space | ✓ | Some | Some |
| Uses your sign-ins, with a switch to isolate | ✓ | Some | Some |
| Take over and hand back at any time | ✓ | No | Some |
| Sees shadow roots and same-origin frames | ✓ | ✓ | Some |
| Free and open source | ✓ | Some | Some |
| macOS, Windows and Linux | ✓ | ✓ | Some |
| No account, no telemetry | ✓ | Some | No |

<sup>1</sup> Browser automation libraries you drive from code, such as Playwright based tools: they launch a browser of their own, usually headless, and an agent uses them by writing a program rather than by using yours.<br />
<sup>2</sup> Browsers that ship with an assistant of their own: the assistant is part of the product, so it comes with that vendor's model, account and terms.<br />
Some means it depends on the product. Every row in the Kamapathy column describes what ships today.

## Get Kamapathy

Download the latest build from **[kamapathy.app](https://kamapathy.app)**, which picks the right file for your computer, or from [GitHub Releases](https://github.com/shayanmohd/kamapathy/releases).

| Your computer | Download |
| --- | --- |
| Mac with Apple silicon or Intel | DMG or ZIP |
| Windows 10 or 11, x64 | Installer or portable EXE |
| Linux, x64 | AppImage or Debian package |

Every release also carries the agent skill as a ZIP and a `SHA256SUMS.txt` file for checking downloads.

One command installs it instead. It takes the newest release, checks the download against that release's `SHA256SUMS.txt` and opens Kamapathy, without sudo on macOS. On macOS and Linux:

```sh
curl -fsSL https://kamapathy.app/install.sh | sh
```

On Windows:

```powershell
powershell -NoProfile -Command "irm https://kamapathy.app/install.ps1 | iex"
```

The macOS and Linux script takes `--dir <folder>`, `--no-open` and, on Linux, `--deb` for the Debian package. The Windows script takes `-NoRun` to verify the installer without running it.

<details>
<summary><strong>Opening it the first time</strong>: this preview isn't signed with a paid certificate yet</summary>
<br />

**macOS.** Drag Kamapathy into Applications and open it. When macOS says it can't verify the app, click **Done**, then open **System Settings > Privacy & Security** and click **Open Anyway**. You only do this once.

**Windows.** If SmartScreen says it protected your PC, click **More info**, then **Run anyway**.

**Linux.** Make the AppImage executable with `chmod +x Kamapathy-*.AppImage` and run it, or install the Debian package with `sudo apt install ./Kamapathy-*.deb`.

</details>

On first launch Kamapathy walks you through six steps: what your spaces and agent spaces are, where your data stays, importing from another browser, connecting your agent, your top sites so you can sign in once, and making Kamapathy your default browser. Import and agent setup can be skipped, sign-ins and saved passwords can come along with your bookmarks and history, and the import is always there later under **Settings > Browsing**.

Once a day Kamapathy asks GitHub Releases for a newer version, sending no ID or usage data, and can download its installer for you to open. Turn this off in Settings, under Updates.

## Bring your own agent

Kamapathy doesn't ship an AI model. It is the browser your agent uses, through a small Node.js client and a ready-made skill for Claude Code, Codex, Cursor and anything else that can run a command.

```mermaid
sequenceDiagram
    autonumber
    participant A as Your agent
    participant K as Kamapathy
    participant Y as You
    A->>K: space create "Dinner booking"
    K-->>Y: Dinner booking started with your sign-ins
    A->>K: open, snapshot, fill the form
    K-->>Y: the ring, the cursor and the agent's status show every step
    A->>K: handoff, because the site asks for a card
    K-->>Y: You're in control
    Y->>K: pay, then Let agent continue
    A->>K: resume, snapshot, confirm the booking
    A->>K: finish, keeping the confirmation page for you
    Note over Y,K: Take over or Stop at any time
```

The quickest way is **Set up agents**, in Settings under Agents, in the ⋯ menu or in the Help menu. It finds the agents on this computer, gives the ones you tick Kamapathy's own copy of the skill, which every start keeps in step with the browser, and can add a `kamapathy` command to your PATH so `kamapathy health` works in any terminal. Nothing changes until you choose **Set up**, and **Remove setup** takes it all back.

Or install the skill yourself:

```sh
npx skills add shayanmohd/kamapathy
```

Or download `Kamapathy-skill-<version>.zip` from the [latest release](https://github.com/shayanmohd/kamapathy/releases/latest) and unzip it into your agent's skills folder, such as `~/.claude/skills` or `~/.codex/skills`. Or install it from a source checkout:

```sh
npm ci
npm run skill:install                                          # Codex
npm run skill:install -- --destination ~/.claude/skills/kamapathy   # Claude Code
```

In Claude Code it is also a plugin:

```text
/plugin marketplace add shayanmohd/kamapathy
/plugin install kamapathy@kamapathy
```

Then ask your agent to use Kamapathy. It connects on its own, with no token to copy, and starts Kamapathy if it isn't running. For a task with many steps, the agent writes one script instead of one command per step:

```js
// book.mjs
const dinner = await createSpace("Dinner booking");
const page = await dinner.open("https://table.example/reserve");
const view = await page.snapshot();
const ref = (label) =>
  view.interactables.find((control) => control.label === label).ref;
await page.batch([
  { type: "fill", ref: ref("Name"), value: "Avery Quinn" },
  { type: "fill", ref: ref("Party size"), value: "2" },
  { type: "click", ref: ref("Reserve") },
  { type: "wait", text: "Reserved", timeoutMs: 8000 },
]);
console.log(await page.text());
await dinner.finish({ keep: [page] });
```

```sh
node kamapathy.mjs run book.mjs
```

The script runs on your computer, in JavaScript or TypeScript, with `createSpace`, `openSpace`, `requestSpace`, `space` and `spaces` as globals. `openSpace` finds a space again by name in a later run, and `requestSpace` asks you to let the agent use one of your own spaces. Pages have labels such as `p2` that are never reused in their space, so a later script picks up with `space.page("p2")`. A space has `open`, `newPage`, `page`, `tabs`, `adopt`, `handoff`, `resume`, `downloads` and `finish`, which closes the agent's other pages and leaves the space to you; a page has `snapshot`, `text`, `click`, `fill`, `press`, `scroll`, `drag`, `wait`, `batch`, `upload`, `setInputFiles`, `waitForEvent`, `setDialogPolicy`, `screenshot`, `pdfText` and `navigate`, plus `goto`, `reload`, `info` and the five waits, `waitForURL`, `waitForLoadState`, `waitForSelector`, `waitForFunction` and `waitForTimeout`. Each call sends one documented request over the local socket, so no JavaScript from the script ever reaches a web page. If you take over or stop the agent, its run stops and the agent sees only a short note saying so. `node kamapathy.mjs help <command>` explains a command, `node kamapathy.mjs --version` shows client, app and engine versions, and `help()` in a script lists the whole API. The same work, one command at a time:

```console
$ node kamapathy.mjs space create "Dinner booking"
space 8c1f2e04 "Dinner booking" agent shared
$ node kamapathy.mjs open 8c1f2e04 https://table.example/reserve
tab 51a9d7c3 https://table.example/reserve
$ node kamapathy.mjs snapshot 8c1f2e04:p2
Reserve a table
https://table.example/reserve

Controls:
@e1 textbox "Name"
@e2 combobox "Party size"
@e3 button "Reserve"
```

<details>
<summary><strong>What agents can and can't do</strong></summary>
<br />

- Agents reach only the spaces they create and the ones you let them use: choose **Let an agent use this space** in a space's options, or allow an agent's request for one. Tabs in your other spaces stay out of reach, and in a space you let an agent use, each tab you had there stays yours until the agent adopts it.
- Agent spaces use your sign-ins unless you isolate them. **Isolate agent spaces** in Settings > Agents gives every new agent space a temporary session of its own, and an agent can ask for one isolated space with `space create "Name" --isolated`. Either way, an agent space holds a site's permission prompt for you to answer and keeps only a download an agent asked for, and they disappear when you quit unless you keep one as a personal space after its agent is done.
- Snapshots are compact: visible text plus controls with short refs such as `@e12`, their state and current values. Password, one-time code and card fields read as `(value hidden)`. Snapshots read open shadow roots and same-origin frames, nested ones included, and list cross-origin frames without reading them. A snapshot can print the page's structure as an outline instead of its text, keep only what is on screen, read one control's subtree, continue in parts, and give each control a locator that still names it in a later run.
- Agents name a control by its ref or by a selector: CSS, `text=`, `role=`, `href=`, `xpath=`, an ending `:has-text("...")` or `:text-is("...")`, and an ending `>> nth=N`. A selector that matches nothing, or several controls an action could take, is answered with counts and candidates instead of a guess.
- Agents can click, fill, select files, press keys, drag, scroll, wait for a URL, a load state, an element or a page condition, and run several steps in one batch or one script. They open web pages and a blank page, never a file on this computer, and a page that asks a person to stay never leaves an agent stuck: it goes, and the agent is told it did.
- Agents show a short status, label their clicks, say when they cannot finish, and keep working after you close the window until you quit. A cursor glides to the point an agent acts on, the status and the latest label sit under the space's name, and a quit while an agent is working asks you first.
- Cross-origin frames and canvas editors still need a handoff: the agent asks you to continue there.
- Agents can download an update with `upgrade`; only you install it.
- The connection is a Unix socket or Windows named pipe that only your account can open, with no token. Any program running as you can drive agent spaces while access is on, now including the sites you are signed in to, which is why the isolation switches exist. **Stop** in the agent bar ends the agent's access to that one space, and turning off **Agent access** in Settings is the hard stop: it refuses every agent at once, including `resume`.
- Agents never get your saved passwords: Kamapathy doesn't offer or fill them while an agent has control, and no API reaches them. In a space you let an agent use, filling asks you first, because the agent can read that page. Nothing an agent types or fills is ever saved.

The [agent guide](docs/automation.md) covers every command and its limits, and the [security model](docs/SECURITY.md) explains the trust boundary.

</details>

## What changed for scripts and agents

Since Kamapathy 0.2.0, a script or agent written for it can notice these changes. The [agent guide](docs/automation.md) has the details.

<details>
<summary><strong>The full list</strong></summary>
<br />

- Every command except `help` and `--version` needs Node.js 22.13 or later.
- Tabs carry labels such as `p2`, never reused in their space, with `openedBy`, `openerId`, `managed` and `active`; spaces carry `kind`, `createdBy` and `pageBudget`. `tabs` prints one tab per line as its label, ID, origin and flags, then its URL and title.
- Page commands refuse a tab the agent did not open or adopt with `409 tab_unmanaged`. A space lets the agent manage 20 pages by default, the old tab limit, and `open` past its page budget answers `409 page_budget`.
- Links, forms and `window.open` that target a new window open real popups in the opener's space, and `window.open` returns a handle. `data:` popups are refused, and a page that closes itself closes its tab.
- `human_control` carries `spaceId`, `reason`, `since` and one fixed message per reason, which no longer names `resume <id>`. `resume` also returns the page the person left and the pages opened and closed meanwhile.
- The person can stop the agent in one space, and an agent can finish a space; requests there then answer `409 space_ended`. `space close` refuses a space where the person opened tabs with `409 space_protected`.
- `stale_ref` and `element_obscured` answer 409 instead of 422, and `invalid_target` and `invalid_files` answer 400 instead of 422. A request authorized again after agent access was turned off answers `503 automation_stopped` instead of 404, and an unknown route answers `404 route_not_found` naming the route.
- Errors carry `retryable: true` when the same call can be sent again and `dispatched: true` when the action reached the page, and single commands print a line saying which after their error. `busy` can carry `retryAfterMs`, and `/health` adds `apiLevel` and the engine `versions`.
- The server refuses body and batch fields a route does not define with `400 unknown_field`. The client refuses unknown or invalid options and arguments before sending, and calls the running Kamapathy is too old for with `app_outdated`.
- `run` holds a script's output until it ends, up to 4 MiB, and connects only at the script's first call. After a takeover, a handoff, your Stop or agent access going off, it prints only a short note and exits with status 3.
- A run stops after 300000 ms unless `--timeout` or `KAMAPATHY_RUN_TIMEOUT_MS` allows longer, and exits with 128 plus the signal number after a signal. Standard input for `run -`, `fill`, `wait` and `batch` must end within 30 seconds.
- A failed run prints where in the script it failed, a caret under a syntax error, whether the call can be retried and up to two hints.
- `run` and `repl` load the workspace's `.env` and each `--env-file`, never changing a variable that is already set.
- `<command> --help` and `-h` print that command's help and run nothing, and `--` ends option parsing.
- Running the client through a linked skill folder now runs the command. Links made by `npx skills add` or by Set up agents used to exit 0 without doing anything.
- Linux packages name the browser executable `kamapathy-browser`, so the `kamapathy` name belongs to the agent command. The client's Linux start runs `kamapathy-browser` from PATH, then `~/Applications/Kamapathy.AppImage`.
- `/health` adds `skill: { path }` for the skill folder the app ships and, while an update waits, `update: { version, state }`. The API level is 4.
- `health`, `run` and the REPL can print one `notice: update_available: ...` or `notice: update_ready: ...` line on stderr. Output and exit statuses are unchanged.
- `upgrade` checks for a newer Kamapathy and downloads its installer, with `--check`, `--timeout <ms>` and `--json`. It never installs: only the person does that.
- Kamapathy makes one new outbound request: once a day it asks GitHub Releases for a newer version, with no ID or usage data. It is on by default and switchable in Settings, under Updates.
- Help usage and examples say `kamapathy` when you run the command Set up agents adds, and `node scripts/kamapathy.mjs` otherwise.
- The ⋯ menu gains **Set up agents** and **Help** after Settings, and **Update Kamapathy** at the top while an update waits. The command menu gains Set up agents, Help, Privacy and Report an issue, and every platform now has a Help menu.
- A packaged macOS build started from a disk image offers to move itself to Applications before the window opens.
- Every page and request now sees Chrome's reduced user agent, `Mozilla/5.0 (<platform>) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`, with no Electron or Kamapathy token and the minor, build and patch numbers zeroed. Client hints are unchanged.
- `pdf-text <tab-id>` and `page.pdfText()` read a PDF's text by page, up to 500 pages and 20000 characters a call, with the codes `not_pdf`, `pdf_not_refetchable`, `pdf_too_large`, `pdf_locked`, `pdf_unreadable`, `pdf_fetch_failed`, `page_out_of_range` and `pdf_timeout`. `/health` answers API level 4.
- Tabs showing files on this computer are never listed to an agent and answer `404 tab_not_found`. The address bar's refusal now reads `Kamapathy opens web addresses and files only.`, and a link from a local page opens a web page in a new tab.
- Links and files other apps hand over open in a personal space no agent can reach, not the space you are in.
- Packaged builds register as a web browser and viewer and turn off Electron's run-as-Node, `NODE_OPTIONS` and inspector fuses, so a `KAMAPATHY_EXECUTABLE` skill test can no longer attach to a packaged app.
- `invalid_selector` answers 400 instead of 422 and carries the `selector`, a `reason`, the `forms` and often a `hint`; CSS a page rejects is 400 too.
- A selector matching nothing answers `422 no_match` with `selector` and `waitedMs`, in place of the old message about 0 elements.
- A selector matching several elements an action can take answers `422 ambiguous_match` with counts and up to three candidates with refs; hidden and disabled duplicates no longer make an action's selector ambiguous, while a snapshot `selector` still counts hidden matches.
- CSS selectors search open shadow roots, one tree at a time, so they no longer stop at a shadow boundary or have to match uniquely across a whole document.
- A well-formed ref no snapshot of that page issued answers `404 unknown_ref` before any page work, where the page used to answer `stale_ref`; `stale_ref` now names the `ref`.
- `selector: "@e12"` acts as that ref, and `@21`, `ref=21` and `21` answer `invalid_selector` with a hint naming the one form.
- Snapshots carry a `header` by default, so the first line of `snapshot` and `page.text()` names the page, its space and the space's tabs instead of the title; `header: false` or `--no-header` restores the title line.
- Screenshots no longer need a shown, unminimized window, and `screenshot_unavailable` is retired.
- Screenshots are CSS pixels by default, so on a 2x display `GET /tabs/:id/screenshot`, `screenshot <tab-id> <file.png>` and `page.screenshot(path)` give half the pixel width and height they gave before; `scale: "device"` or `--scale device` keeps device pixels.
- A full-page capture, or a clip outside the viewport, fires one `resize`, one visual viewport resize and matchMedia changes in the page, may give it a 1 by 1 pixel viewport for an instant, leaves unloaded lazy content unloaded and paints fixed elements at the current scroll; the first capture of an agent tab in a hidden window turns its `visibilityState` to visible for good.
- `GET /tabs/:id/screenshot` allows 15000 ms, not 30000, for the load wait and the capture together.
- `screenshot` prints `saved <path> (<width>x<height>)`, and `--json` adds `width`, `height`, `clip` and `pixelRatio`.
- With a JavaScript dialog open, `role=` selectors, snapshot locators and screenshots fail at once with `409 dialog_open` instead of waiting out their timeout.
- Agents can say what they are doing with `status SPACE_ID "<text>"` and give up with `fail SPACE_ID "<message>"` (`space.setStatus(text)` and `space.fail(message)`), and `spaces` lines and a `Space` carry the space's `state` and `status`. A reported failure hands the space to you with its message as the status, and the agent's later requests there answer `409 human_control` with `reason: "failed"` until you let it continue.
- `click`, `fill`, `press`, `scroll` and `drag` take `--label "<a few words>"` anywhere in their arguments, and those batch steps take a `label` field. Every input method now ends with an options object: `page.click(target, options?)`, `page.fill(target, value, options?)`, `page.press(key, target?, options?)`, `page.scroll(direction, pixels?, target?, options?)` and `page.drag(source, target, options?)`. A bad option is refused before anything is sent, naming the new shape, as in `page.click got unknown option "labl". Expected page.click(target, { label? }).`
- An agent space whose agent finished reads **Done** instead of **Agent finished**, and **Needs you** follows the agent's own task state, so it also shows while the agent still holds the space. The activity entry still says Agent finished and now carries the agent's last status.
- A route that reads or acts on a page makes its tab the one its space shows: in the space you are looking at that tab becomes active, and in another space it becomes the tab that space opens on. Your space, the window and keyboard focus never change, and the routes that only list or read state move nothing.
- Agent pages are created at the size of Kamapathy's content area instead of 1200 by 800, so a page you have not looked at yet reports the viewport it will have when you do.
- Closing the window keeps Kamapathy running while agents can work, so a script keeps the same instance, screenshots included. A quit while an agent is working or waiting for you asks first, and for ten minutes after it the client refuses to start Kamapathy, failing with `not_connected` and reason `quit_by_person`.
- A space's activity carries the agent's own words: the label of each action, a line for every status change, and how the task ended.
- The person's extensions run in agent spaces that share their sign-ins, so their content scripts can change agent pages. Isolated agent spaces never run them.
- A frame of one of the person's extensions is a blocked `iframe` entry with `extension` and the label `Extension: <name>`, and input there returns `403 input_target_blocked` with `frame` and `extension`.
- CDP commands aimed at an extension's frame or content-script world return `403 cdp_method_blocked` with `reason: "scope"`.
- Kamapathy saves passwords now: it offers after you sign in, fills from a native menu under the field, and keeps them in an encrypted vault in your profile. **View > Passwords** opens the list, after Downloads, and the ⋯ menu and the command menu list it too; **Settings > Passwords**, after Browsing, holds **Offer to save passwords** and **Manage...**.
- The import panel gains a **Passwords** checkbox, on by default for Chrome, Chromium, Edge, Brave, Arc, Vivaldi and Opera, so an import from one of those now also brings its saved passwords, reading that browser's key when it has rows to decrypt. Safari's exported file brings them too, Firefox's come from a CSV file you import under Passwords, and the line at the end counts passwords only when it saved some, so an import without them reads as before.
- A site's own sign-in box, the one that asks for a name and password, lists your saved sign-ins for it as `Sign in as <username>` and offers a **Save password** box, ticked, which saves what you typed once the sign-in works.
- Nothing about saved passwords is on the agent API: no route, method, command, field, option or error code changes, and a path such as `GET /passwords` answers `404 route_not_found` like any other unknown route. A script that calls a password, credential or autofill method it imagined now gets one hint first, `Saved passwords are for the person only. Hand the space to them with handoff() and say what to sign in to.`
- Actions report what they caused. `click`, `fill`, `press`, `scroll`, `drag`, `upload` and `setInputFiles`, as commands and as batch steps, add `popups`, `dialog`, `moreDialogs`, `download` and `deniedRequests` to their answer when they apply, so scripts no longer poll `tabs` to find a popup, and a run prints `notice: unused page p3 opened by p1: <url>` for the popups nothing reported.
- `page.waitForEvent(event, { timeout })` waits for the tab's next `popup`, `download`, `filechooser` or `dialog`, and resolves with a page, a download, a file chooser or the dialog record. Its arm goes out as the method is called and every later call on that page waits for the arm, so an action cannot outrun it; `timeout: 0` is refused with `invalid_option`. From a shell it is `expect <tab-id> <event>` then `wait-expectation <id>`, and `page.popups()` lists the tabs a tab opened.
- JavaScript dialogs in agent tabs are answered by a fixed handler instead of a native box: `confirm` returns false and `prompt` returns null unless `page.setDialogPolicy({ accept, promptText?, times?, lifetime? })` armed an accept first. Each answer appears in the action's result, in `page.dialogs()` and in a `dialog` wait, and there is no `acceptDialog`, because no dialog is ever left waiting.
- An agent space no longer refuses every download. One an agent armed with `waitForEvent("download")` is kept in a private folder under the profile, read with `download.saveAs(path)` or `download.path()` and deleted when the run ends; every other download is still cancelled and is now reported as `download: { blocked: true, ... }`. `space.downloads()` lists what a space holds, and the commands are `download`, `downloads`, `save-download`, `cancel-download` and `delete-download`.
- `page.setInputFiles(target, files, { timeout })` is a new route that takes any selector or ref, hidden inputs included, retargets from a label or from the one file input inside the match, and clears the input when the list is empty. `upload` keeps its body and its result and gains the receipt fields.
- An action that opens a file chooser no longer opens a native panel: the chooser closes, the input gets a `cancel` event and the action fails `422 file_chooser_opened`. Arm `waitForEvent("filechooser")` instead, and the file chooser takes the files with `setFiles`, even on an input the page has removed.
- Permission requests in agent tabs are no longer denied outright. A location, notification, camera or microphone request inside a route's own 5000 ms window, and every USB or HID chooser, hands the space to the person with `human_control` carrying reason `permission` or `device` and a `prompt` naming the request; the rest are denied and reported in the next receipt's `deniedRequests`.
- Server and proxy sign-ins and client certificate requests reach the person the same way, with reason `http_auth` or `client_certificate`. `space.setHTTPCredentials({ origin, username, password })` lets an agent answer the first challenge from one origin of its own space, in memory only, while a repeat, any proxy challenge and every certificate request go to the person.
- The native "Website permission" box is gone. Every space asks in Kamapathy's own bar above the page, a personal space's Allow or Block is now saved per space, origin and permission across restarts, and Settings > Site permissions removes one or all of them.
- Agent access off and a space's Stop now also cancel arms, waits and file choosers, reset dialog policies, delete held downloads and clear stored credentials.
- New error codes: `expectation_pending`, `expectation_not_found`, `expectation_timeout`, `download_not_found`, `download_limit`, `download_not_finished`, `download_failed`, `download_timeout`, `multiple_file_inputs`, `file_chooser_opened` and `file_chooser_not_found`, plus the client's own `file_exists` and `download_interrupted`.
- `navigate(url)`, the `navigate` command and the `navigate` batch step now wait for the new document instead of returning as soon as the load was dispatched, and throw `navigation_failed`, `navigation_download`, `navigation_interrupted` or `navigation_timeout`. The call and the command return once the document commits, a batch step waits for its `waitUntil`, `load` by default, and `page.goto(url)` waits for the load event; all of them take `waitUntil`, `timeout` and `referer`.
- `POST /tabs/:id/navigate` answers `{ ok: true, tab, httpStatus?, waitUntil, dialog? }` in place of `{ tab }`, the CLI prints the HTTP status after the URL, and navigate's HTTP timeout is its own `timeout` plus 5000 ms, 20000 ms by default, instead of a flat 45000 ms.
- Agents can open `about:blank`, through `navigate`, `open` and `new-page`; `file:`, `data:`, `blob:`, `view-source:` and credential URLs still answer `400 invalid_url`, now carrying the `url` and a `hint` for what to do instead.
- A page's leave guard no longer keeps an agent on a page: under agent control the page leaves and the answer carries `dialog: { type: "beforeunload", answer: "accepted" }`. While you have control of the space you get the Leave site question instead, where the page used to stay with nothing said.
- A server redirect to an address agents may not open is still cancelled, and is now reported as `navigation_failed` with `blockedUrl`, instead of leaving the tab on its old page with no error.
- New commands `reload`, `info`, `wait-for-url`, `wait-for-load-state`, `wait-for-selector` and `wait-for-function`, with the matching methods and batch steps. `reload --ignore-cache` refetches past the cache, runs no page script and is not gated by Page scripts; `wait-for-function` is the one agent code a page runs, under a Page scripts setting that is on by default and whose switch arrives with page scripts in a later version, answering `403 agent_scripts_off` while it is off and `422 script_error` for code that throws.
- A URL wait takes a glob in every surface, and a RegExp or a predicate in a script only; a match in a popup this page opened ends it with `409 url_opened_in_popup`, so continue in that page rather than repeating the action. `page.waitForTimeout(ms)` sleeps in the script and sends nothing.
- `POST /tabs/:id/wait` is unchanged: the same body, a 5000 ms default, a 15000 ms cap and `408 wait_timeout`. A tab accepts four navigations and waits at once, and a fifth answers `429 busy` with `scope: "tab"`.
- `page.url` and `page.title` refresh after every navigation and wait, not only after `navigate` and `snapshot`.

</details>

## Keyboard shortcuts

<details>
<summary><strong>The full list</strong></summary>
<br />

| Action | macOS | Windows and Linux |
| --- | --- | --- |
| Search tabs and commands | ⌘K | Ctrl+K |
| New tab | ⌘T | Ctrl+T |
| Reopen closed tab | ⇧⌘T | Ctrl+Shift+T |
| Close tab | ⌘W | Ctrl+W |
| Next or previous tab | Ctrl+Tab, Ctrl+Shift+Tab | Ctrl+Tab, Ctrl+Shift+Tab |
| All spaces | ⌥S | Alt+S |
| Focus the address bar | ⌘L | Ctrl+L |
| Find in page | ⌘F | Ctrl+F |
| Bookmark this page | ⌘D | Ctrl+D |
| Bookmarks | ⇧⌘B | Ctrl+Shift+B |
| History | ⌘Y | Ctrl+H |
| Downloads | ⇧⌘J | Ctrl+Shift+J |
| Reload | ⌘R | Ctrl+R |
| Zoom in, out, reset | ⌘+, ⌘-, ⌘0 | Ctrl+Plus, Ctrl+-, Ctrl+0 |
| Settings | ⌘, | Ctrl+, |
| Developer tools | F12 | F12 |

</details>

## Build it yourself

Kamapathy is Electron, React and TypeScript. Web pages run in native Chromium views, while the interface and the agent connection live in separate layers. The [architecture notes](docs/architecture.md) explain how they fit together.

```sh
git clone https://github.com/shayanmohd/kamapathy.git
cd kamapathy
npm ci
npm run dev
```

You need Node.js 22.13 or newer. The first run prepares a desktop runtime with Kamapathy's own name and icon, and later runs reuse it.

<details>
<summary><strong>Test and package</strong></summary>
<br />

```sh
npm run check          # types, unit tests and the copy check
npm run build          # compile the desktop app
npm run test:desktop   # drive the real app through every surface
npm run test:skill     # run the agent skill end to end against a local site
npm run test:native    # launch the app the way a person would
```

On Linux without a desktop session, prefix the desktop and skill tests with `xvfb-run -a`. Build installers on their own operating system with `npm run package:mac`, `npm run package:win` or `npm run package:linux`; they land in `release/`.

Every push to `main` and every pull request runs the **Build desktop apps** workflow, which tests and packages Apple silicon and Intel Macs, Windows x64 and Linux x64. Publishing is a separate, manual step described in the [release guide](docs/releases.md).

</details>

<details>
<summary><strong>Where things live</strong></summary>
<br />

| Folder | What it holds |
| --- | --- |
| `electron/` | The main process: tabs and spaces, sessions, the agent API and its socket, browser import, menus, saved state |
| `src/` | The interface: tab strip, toolbar, spaces, welcome and import, dialogs, command menu, styles |
| `shared/` | State, types, URL rules and the top sites ranking used on both sides |
| `skills/kamapathy/` | The agent skill, its standalone Node.js client and the scripting API |
| `scripts/` | Development runtime, end-to-end tests, screenshots and release tools |
| `site/` | The kamapathy.app website, including the live demo |
| `tests/` | Unit and integration tests |
| `docs/` | The agent guide, architecture, security model and release guide |

</details>

## Security

Kamapathy's trust boundary is your operating system account. Web pages run sandboxed in Chromium views with no access to the interface or the agent API. The agent API listens only on a local socket that other accounts cannot open, so any program running as you can drive agent spaces while agent access is on, and since agent spaces share your sign-ins by default, that program acts as you on the sites you are signed in to. Separate sign-ins per space and the Isolate agent spaces switch exist for that reason, and turning agent access off is the hard stop. The [security model](docs/SECURITY.md) describes these boundaries and their limits in detail, and how to report a vulnerability.

## What's not here yet

Kamapathy is an early preview. Sync, an ad blocker and DRM playback are not part of it yet. The installers aren't signed yet, so Kamapathy can download updates but never installs them itself, and Kamapathy hasn't had an independent security audit. Kamapathy presents itself to sites as Chromium. If Google rejects a sign-in, Kamapathy offers to continue in your default browser, or to sign in there and import the sign-in.

## Contributing

Bug reports and focused pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), or [open an issue](https://github.com/shayanmohd/kamapathy/issues) with your operating system, the steps to reproduce and what you expected.

## License

[MIT](LICENSE)
