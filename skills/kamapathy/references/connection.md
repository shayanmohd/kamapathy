# Connection

Kamapathy connects automatically. There is no token, copied file, or setup step. Every command finds Kamapathy on this computer through the profile's agent folder. If Kamapathy is not running and agent access was left on, the client starts Kamapathy and waits up to 30 seconds for it. On Linux it starts `kamapathy-browser` from PATH, then `~/Applications/Kamapathy.AppImage`, because packaged Linux builds renamed the browser's executable and left the `kamapathy` name to the command Kamapathy's Set up agents adds. The web preview has no automation service.

A script run with `run` connects on its first call, not when it starts, so a script that never calls Kamapathy never starts it. A client starts Kamapathy at most once: when the connection drops during a call, that call fails, and the next call finds Kamapathy again without starting it. Every command except `help` and `--version` needs Node.js 22.13 or later, and an older Node.js gets `Kamapathy's client needs Node.js 22.13 or later. This is Node.js <version>.`

## How the client finds Kamapathy

Each Kamapathy profile keeps a private agent folder: `Kamapathy/agent` inside the operating system's application data folder (`~/Library/Application Support` on macOS, `%APPDATA%` on Windows, `$XDG_CONFIG_HOME` or `~/.config` on Linux). While agent access is on, Kamapathy listens on a local socket there, or in a new private temporary folder when the profile path is too long for a socket. On Windows it uses a named pipe with a new random name each start. Set `KAMAPATHY_USER_DATA` to reach a different profile, such as a test instance.

Each start also records a random instance value that only your account can read, and Kamapathy returns it on every response. The client checks it before sending a command, so a program that took over an old socket or pipe name receives nothing. On macOS and Linux, the client refuses an agent folder or file that another account could read or replace, a symbolic link in place of a file, and a socket outside a private folder. Windows relies on the per-user permissions of `%APPDATA%`, which portable Node.js cannot inspect.

## When it does not connect

Every failure is a `not_connected` error whose `reason` names the case. Only `busy` is retryable. Commands print the message as `Kamapathy: <message>`, and scripts get it as a thrown error.

- **Agent access is turned off in Kamapathy** (`access_off`). The person switched it off in Settings, under Agents. Ask them to turn it on. The client never starts Kamapathy while access is off.
- **Kamapathy is not running** (`not_running`). Automatic starting is disabled by `KAMAPATHY_NO_LAUNCH=1`. Ask the person to open Kamapathy.
- **Kamapathy has not started with this profile yet** (`not_running`). A profile named by `KAMAPATHY_USER_DATA` is started only from its own launch record, which Kamapathy writes the first time it runs with that profile. The client also skips a recorded program that another account could have replaced (`untrusted_files`).
- **Kamapathy is not installed** (`not_installed`). The client found no installed app or start command, or the app could not open. Ask the person to install or open Kamapathy; [install.md](install.md) is the guide for installing it with their approval.
- **Kamapathy did not accept agents within 30 seconds** (`start_timeout`). Kamapathy may be showing an error. If Recent activity in Settings says the agent service could not start, turning agent access off and on retries it.
- **The person quit Kamapathy while an agent was working** (`quit_by_person`). The client does not start it again for ten minutes after such a quit. Ask the person before starting it.
- **Permission denied** (`permission_denied`). An agent sandbox can block local sockets. Run the command with local socket access or outside the sandbox.
- **Kamapathy is busy** (`busy`). Something accepted the connection and dropped it, as Kamapathy does at its connection limit. Retry shortly.
- **Untrusted agent files** (`untrusted_files`). The agent folder, a file in it or the socket is not private to your account. Ask the person to check that folder.
- **The connection was lost during a call** (`lost`). Kamapathy quit or restarted while the call ran, and the call may still have taken effect. Inspect the page before retrying.

## Versions

`node scripts/kamapathy.mjs --version` prints this client's version and API level with its Node.js, this skill's folder, and the running Kamapathy's version, API level and Electron, Chromium and Node versions, or why it did not answer. It never starts Kamapathy, and `--json` prints the same as JSON.

When a call, option or command needs a newer Kamapathy than the one running, the client refuses it before sending anything with `app_outdated`, as in `<call> needs Kamapathy API level <n>, and Kamapathy <version> has level <m>. Ask the person to update Kamapathy, then read the skill again.` Ask the person to update Kamapathy, and never work around it. When Kamapathy is newer than this skill copy, everything still runs, and commands and runs print a skill notice once on stderr, such as `notice: Update this skill copy, then read its SKILL.md again.` Read the SKILL.md it names before going on.

## Updates

`kamapathy upgrade` (`node scripts/kamapathy.mjs upgrade`) asks Kamapathy to check GitHub Releases and then download this computer's installer. It never installs: only the person does that, from Settings, under Updates. `--check` stops after the check, `--timeout <ms>` bounds the wait for the download (0 to 1800000, 600000 by default; 0 returns once it starts) and `--json` prints the status. `Downloading <name> (<n> MB)...` goes to stderr, and a finished download prints the installer's path and what the person does next.

Its errors: `update_unsupported` says this copy has no published installer, with `reason` `source` for a run from a checkout or `platform` for a computer no release covers. `update_check_failed` says GitHub gave no usable answer, with a `reason` and sometimes `retryAfterMs`; it can be retried when the reason is `offline`, `network`, `timeout` or `rate_limited`. `update_download_failed` and `update_verify_failed` have no status of their own and arrive in the update status, so `upgrade` prints them with the same `Kamapathy: <code>: <message>` line and exits 1. A `timeout` error means the download is still running in Kamapathy: run `upgrade` again to wait for it.

While a newer version waits, `health`, `run` and the REPL print one notice on stderr, `notice: update_available: ...` or `notice: update_ready: ...`, and nothing else changes. Finish the task first, then tell the person, ask before running `upgrade`, and read the skill again after an update.

## What agents can reach

Any program running under the person's account can use Kamapathy's agent spaces while agent access is on, the same boundary as other local developer tools. The API controls only agent spaces created during its current session or explicitly granted to it through Kamapathy's interface, until the agent finishes them or the person stops it. A personal space is reachable only after the person lets an agent use it, with Let an agent use this space or by allowing a `space request`, and its tabs stay the person's until the agent adopts them. Agent spaces share the person's sign-ins, so sites they use are usually signed in already; `space create NAME --isolated` asks for a temporary session without them, and the person can make every agent space isolated in Settings. If a website still needs authentication, hand the agent space to the person to log in. When they say they have signed in, take it back with `resume SPACE_ID`, or wait for them to return control with `wait-for-control SPACE_ID`.

For human authentication, launch the installed Kamapathy app or use `npm start` from a built source checkout. Review harnesses such as Playwright can add automation flags: the initial Google sign-in test exposed WebDriver, while a normal desktop launch did not. Do not use a review harness to judge normal sign-in compatibility.

There is no MCP connection, DevTools or remote-debugging port, Playwright endpoint, or browser-wide JavaScript execution command, and automatic starts never open one. Use this helper or Kamapathy's documented HTTP API over the local socket. Never try to recover access to a paused space by creating a new session or substituting the person's personal browser.
