import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);
const architecture = readFileSync(
  new URL("docs/architecture.md", root),
  "utf8",
);
// The project map, as [path, responsibility] in file order.
const rows = [...architecture.matchAll(/^\| `([^`]+)` +\| (.+?) +\|$/gm)].map(
  ([, path, responsibility]) => [path, responsibility] as const,
);
const paths = rows.map(([path]) => path);

describe("what the architecture says", () => {
  it("keeps what each section's docs list put on the page", () => {
    for (const text of [
      "Main --> Sessions[Debugger session per managed agent tab]",
      "The agent server lives in `electron/agent/`.",
      "Popups are adopted rather than reloaded.",
      "so a grant never outlives the run",
      "becomes a personal space and is saved and restored like any other",
      "HTTP, HTTPS and `about:blank`, its one extra destination, which an agent may open as a blank page to work in",
      "holds its permission prompts for the person and keeps only downloads an agent armed",
      "The agent cursor is one more native view per window, kept above the page views.",
      "The window's lifecycle follows the agents.",
      "`extraResources` copies `skills/kamapathy` into the packaged app",
      "Linux packages name the browser executable `kamapathy-browser`",
      "`electron-builder.signed.yml` extends the base configuration",
      "It has no sync service, built in model, or self-installing updater.",
      "Sign-ins are optional and read by `electron/import-cookies.ts`",
      "The controller writes the decrypted cookies into a session partition",
      "`electron/identity.ts` builds Chrome's reduced user agent around Electron's platform group",
      "`electronFuses` turns off `runAsNode`",
      "Saved passwords live in `electron/passwords/`, outside `browser-state.json`.",
      "Every page session registers the frame preload `kamapathy-forms`",
    ])
      expect(architecture).toContain(text);
  });

  it("runs an agent's own scripts and protocol commands behind the policy", () => {
    for (const text of [
      "only in tabs an agent manages and only while the Page scripts setting is on",
      "An expression runs with `replMode`, so top-level `await` works and declarations may repeat, but an expression whose value is a promise comes back as an empty object unless it is awaited; the function form awaits.",
      "Protocol commands go over debugger sessions of the agent's own, behind a deny-by-default policy.",
      "`space-cdp.ts` is the only path they take",
      "A command aimed at a blocked frame or at a world of the person's extensions is refused with `403 cdp_method_blocked` and reason `scope`.",
      "Input commands never go out on those sessions",
    ])
      expect(architecture).toContain(text);
  });

  it("reads frames from any site and keeps the rest blocked", () => {
    expect(architecture).toContain(
      "Snapshots, selectors and actions reach frames from any web origin.",
    );
    expect(architecture).toContain(
      "names the extension when it is one of the person's, and input there returns `403 input_target_blocked`",
    );
  });

  it("clears one site's data at once only where the partition is the agent's", () => {
    for (const text of [
      "clears one origin's cookies, storage or cache for an agent and never a whole session",
      "In an isolated agent space the partition is the agent's alone, so the clear runs at once.",
      "only the person's Clear clears anything",
      "requests for a space and requests to clear a site's data are runtime fields",
    ])
      expect(architecture).toContain(text);
  });

  it("maps every folder the sections name, each path once", () => {
    expect(Object.fromEntries(rows)).toMatchObject({
      "electron/agent/":
        "Agent socket server, per-space lanes, routes, tab sessions, events",
      "electron/agent/frames/":
        "Frame groups, owner bindings, frame content and point translation",
      "skills/kamapathy/": "Agent skill: CLI, scripting client, run and repl",
      "skills/kamapathy/sites/":
        "Bundled site packs: notes and tools for GitHub, Google Search and X",
      "skills/kamapathy/scripts/schema/":
        "One schema for client checks, server checks, help and the API reference",
      "electron/import.ts":
        "Reads bookmarks and history, carries sign-ins and passwords across",
    });
    for (const path of [
      "electron/agent/selectors.ts",
      "electron/agent/dom/",
      "electron/agent/input/",
      "electron/agent/navigation/",
      "electron/agent/setup/",
      "electron/agent/presence.ts",
      "electron/agent/cursor.ts",
      "electron/background.ts",
      "src/cursor/",
      "scripts/generate-api-reference.mjs",
      "electron/updates.ts",
      "electron/update-release.ts",
      "src/whats-new.ts",
      "electron/import-cookies.ts",
      "electron/import-safari.ts",
      "electron/identity.ts",
      "electron/default-browser.ts",
      "electron/incoming.ts",
      "build/installer.nsh",
    ])
      expect(paths).toContain(path);
    // Section 18 asked for an electron/passwords/ row. Each file has its own
    // row instead, which says more, so every file there needs one.
    for (const file of readdirSync(new URL("electron/passwords/", root)))
      expect(paths).toContain(`electron/passwords/${file}`);
    // The electron/import.ts row was once kept twice, each saying another thing.
    expect(
      paths.filter((path, index) => paths.indexOf(path) !== index),
    ).toEqual([]);
    expect(paths.filter((path) => !existsSync(new URL(path, root)))).toEqual(
      [],
    );
  });

  it("no longer says what a shipped section made false", () => {
    for (const text of [
      "a maintained update mechanism",
      "automatic updater",
      "extension marketplace",
      "sync service, password vault",
      "Reads bookmarks and history from other browsers, without Electron",
      "Reads bookmarks, history and sign-ins from other browsers",
    ])
      expect(architecture).not.toContain(text);
  });
});
