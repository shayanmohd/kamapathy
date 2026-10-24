# Contributing to Kamapathy

Kamapathy is a small desktop browser with a shared React interface and an Electron engine. Changes should preserve the distinction between human browsing, agent browsing, and the web preview.

## Get started

1. Install Node.js 22.13 or newer.
2. Run `npm ci` in the repository.
3. Run `npm run dev` for the desktop application or `npm run dev:web` for interface work.
4. Read the [architecture](docs/architecture.md) before changing IPC, sessions, persistence, or automation.

The native app uses a local browser profile. Use test accounts while changing session or storage behavior. Desktop smoke tests use their own temporary profile.

## Make a focused change

Keep TypeScript strict. Shared data shapes and actions live in `shared/`. Electron capabilities should enter the interface through the existing preload bridge. Remote pages must not receive that bridge or Node.js access.

Add behavior tests when a change affects address parsing, state persistence, automation authorization, ownership, or other browser behavior. For a visual adjustment, verify the result in the interface. Check dark and light themes and a compact laptop window. For a native change, test the Electron application and document which operating system you used.

Use plain punctuation throughout authored code and documentation. The copy check rejects Unicode code points `U+2013` and `U+2014`. Hyphens, commas, colons, and full stops are welcome.

## Validate

```sh
npm run check
npm run build
npm run test:desktop
npm run test:skill
```

Linux smoke testing requires a display. For a headless machine, use `xvfb-run -a npm run test:desktop`. CI also packages the app on native operating system runners.

Packaged builds turn off Electron's run-as-Node and inspector fuses, so check a packaged app with `npm run package:<platform>` and then `node scripts/test-branding.mjs --packaged`; a `KAMAPATHY_EXECUTABLE` skill test cannot attach to a packaged app, because its main process no longer takes an inspector.

The skill test drives the bundled client against a temporary Electron profile and a local form server. It verifies real creation and submission, partial failures, stale refs, screenshots, keyboard input, takeover, taking control back with `resume`, and a whole task run as one script. Public website reads are opt-in with `KAMAPATHY_TEST_PUBLIC=1`. For a skill change, validate its `SKILL.md` and test the installed copy using `KAMAPATHY_SKILL_DIR` as well.

A pull request should explain the user facing behavior, the reason for the change, and the checks you ran. Include screenshots for visible changes and mention any operating system coverage that is still pending.

## Security reports

Please read [SECURITY.md](docs/SECURITY.md) before reporting a vulnerability. Avoid including browser profiles, session cookies, or personal browsing history in issues and logs.
