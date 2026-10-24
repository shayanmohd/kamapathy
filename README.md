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
      A green ring and a small bar show when an agent is working. <b>Take over</b> pauses it, <b>Let agent continue</b> hands it back, <b>Stop</b> ends its work in that space.
    </td>
    <td width="33%" valign="top">
      <h3>Your sign-ins, on purpose</h3>
      Sign in once and every space and agent can use it. Give any space <b>Separate sign-ins</b>, or isolate every agent space from Settings.
    </td>
  </tr>
  <tr>
    <td width="33%" valign="top">
      <h3>Bring your browser with you</h3>
      On first launch, import bookmarks and history from Chrome, Chromium, Edge, Brave, Arc, Vivaldi, Opera, Firefox or Safari. Later, from Settings.
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
</table>

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
<summary><strong>First launch: import and sign in once</strong>: bring your bookmarks and history, then open your top sites</summary>
<br />
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/kamapathy-welcome-dark.png" />
  <img src="docs/images/kamapathy-welcome-light.png" alt="The welcome dialog listing the browsers found on this computer, with Bookmarks and History checked and an Import button" width="100%" />
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

<details>
<summary><strong>Opening it the first time</strong>: this preview isn't signed with a paid certificate yet</summary>
<br />

**macOS.** Drag Kamapathy into Applications and open it. When macOS says it can't verify the app, click **Done**, then open **System Settings > Privacy & Security** and click **Open Anyway**. You only do this once.

**Windows.** If SmartScreen says it protected your PC, click **More info**, then **Run anyway**.

**Linux.** Make the AppImage executable with `chmod +x Kamapathy-*.AppImage` and run it, or install the Debian package with `sudo apt install ./Kamapathy-*.deb`.

</details>

On first launch Kamapathy offers to bring over your bookmarks and history from another browser on this computer, then shows your top sites so you can sign in once. Both are optional, and the import is always there later under **Settings > Browsing**.

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
    K-->>Y: the ring and the agent bar show every step
    A->>K: handoff, because the site asks for a card
    K-->>Y: You're in control
    Y->>K: pay, then Let agent continue
    A->>K: resume, snapshot, confirm the booking
    A->>K: finish, keeping the confirmation page for you
    Note over Y,K: Take over or Stop at any time
```

Install the skill in whichever way suits you:

```sh
npx skills add shayanmohd/kamapathy
```

Or download `Kamapathy-skill-<version>.zip` from the [latest release](https://github.com/shayanmohd/kamapathy/releases/latest) and unzip it into your agent's skills folder, such as `~/.claude/skills` or `~/.codex/skills`. Or install it from a source checkout:

```sh
npm ci
npm run skill:install                                          # Codex
npm run skill:install -- --destination ~/.claude/skills/kamapathy   # Claude Code
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

The script runs on your computer, in JavaScript or TypeScript, with `createSpace`, `openSpace`, `requestSpace`, `space` and `spaces` as globals. `openSpace` finds a space again by name in a later run, and `requestSpace` asks you to let the agent use one of your own spaces. Pages have labels such as `p2` that are never reused in their space, so a later script picks up with `space.page("p2")`. A space has `open`, `newPage`, `page`, `tabs`, `adopt`, `handoff`, `resume` and `finish`, which closes the agent's other pages and leaves the space to you; a page has `snapshot`, `text`, `click`, `fill`, `press`, `scroll`, `drag`, `wait`, `batch`, `upload`, `screenshot` and `navigate`. Each call sends one documented request over the local socket, so no JavaScript from the script ever reaches a web page. If you take over or stop the agent, its run stops and the agent sees only a short note saying so. `node kamapathy.mjs help <command>` explains a command, `node kamapathy.mjs --version` shows client, app and engine versions, and `help()` in a script lists the whole API. The same work, one command at a time:

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
- Agent spaces use your sign-ins unless you isolate them. **Isolate agent spaces** in Settings > Agents gives every new agent space a temporary session of its own, and an agent can ask for one isolated space with `space create "Name" --isolated`. Either way, agent spaces deny downloads and never see a permission prompt, and they disappear when you quit unless you keep one as a personal space after its agent is done.
- Snapshots are compact: visible text plus controls with short refs such as `@e12`, their state and current values. Password, one-time code and card fields read as `(value hidden)`. Snapshots read open shadow roots and same-origin frames, nested ones included, and list cross-origin frames without reading them. A snapshot can print the page's structure as an outline instead of its text, keep only what is on screen, read one control's subtree, continue in parts, and give each control a locator that still names it in a later run.
- Agents name a control by its ref or by a selector: CSS, `text=`, `role=`, `href=`, `xpath=`, an ending `:has-text("...")` or `:text-is("...")`, and an ending `>> nth=N`. A selector that matches nothing, or several controls an action could take, is answered with counts and candidates instead of a guess.
- Agents can click, fill, select files, press keys, drag, scroll, wait for changes and run several steps in one batch or one script.
- Cross-origin frames, canvas editors and JavaScript dialogs still need a handoff: the agent asks you to continue there.
- The connection is a Unix socket or Windows named pipe that only your account can open, with no token. Any program running as you can drive agent spaces while access is on, now including the sites you are signed in to, which is why the isolation switches exist. **Stop** in the agent bar ends the agent's access to that one space, and turning off **Agent access** in Settings is the hard stop: it refuses every agent at once, including `resume`.

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
- `/health` answers `apiLevel: 3`, and `--version` prints API level 3.
- With a JavaScript dialog open, `role=` selectors, snapshot locators and screenshots fail at once with `409 dialog_open` instead of waiting out their timeout.

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

Kamapathy is an early preview. Browser extensions, a password manager, sync, an ad blocker and DRM playback are not part of it yet. The installers aren't signed and don't update themselves, and Kamapathy hasn't had an independent security audit. If Google rejects a sign-in, Kamapathy offers to continue in your default browser instead.

## Contributing

Bug reports and focused pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), or [open an issue](https://github.com/shayanmohd/kamapathy/issues) with your operating system, the steps to reproduce and what you expected.

## License

[MIT](LICENSE)
