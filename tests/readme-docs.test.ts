import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
// One "## " section, up to the next heading of that level.
const section = (heading: string) =>
  readme.split("\n## ").find((part) => part.startsWith(`${heading}\n`)) ?? "";
const changed = section("What changed for scripts and agents");

// Each change of existing behavior the spec's open points name, as the list
// announces it.
const ANNOUNCED = [
  "Closing the window keeps Kamapathy running while agents can work",
  "now wait for the new document instead of returning as soon as the load was dispatched",
  "there is no `acceptDialog`, because no dialog is ever left waiting",
  "A space lets the agent manage 20 pages by default, the old tab limit",
  "Kamapathy makes two new outbound requests.",
  "Once you add extensions, it also asks the Chrome Web Store once a day whether they have updates",
  "turn off Electron's run-as-Node, `NODE_OPTIONS` and inspector fuses",
  "Tabs showing files on this computer are never listed to an agent",
];

// What page scripts, frames from any site and site packs changed, which no
// other page of the README announces.
const PHASE_7 = [
  "**Page scripts**, a new switch in Settings > Agents that is on by default, lets agents run their own scripts and protocol commands in agent tabs",
  "While it is off, `page.evaluate`, `page.fetch`, `page.cdp`, `page.events`, `space.cdp`, `page.waitForFunction` and site packs' page tools answer `403 agent_scripts_off`.",
  "`page.evaluate(fn, arg?)` calls a function in the page's main frame with `arg` as its one JSON argument and waits for any promise it returns.",
  "A string runs as an expression with `replMode`, so top-level `await` works and declarations may repeat, but an expression whose value is a promise comes back as an empty object unless it is awaited.",
  "which is `scope` for a `frame` or `frameId` naming a frame agents never reach.",
  "Every command that reached Chromium expires the tab's refs, so take a new snapshot after one.",
  "end the agent's protocol sessions, in-page fetches and event recording",
  "A call still running then fails with the error a new call would get, and its result is withheld.",
  "the space's other requests answer `409 human_control` with `reason: \"approval\"` meanwhile, and **Don't clear** answers `403 clear_declined`.",
  "Snapshots read frames from any web origin, nested ones included.",
  "`crossOrigin: true` now means the frame's origin differs from the document around it",
  "No route answers `409 cross_origin_frame` any more",
  "A ref inside a frame goes stale when that frame loads another document or is removed, and `stale_ref` then carries `frame`",
  "A frame from another origin smaller than 4 CSS pixels either way is left out of snapshots entirely.",
  "Activity entries for an action inside a frame from another host end with `in a frame from <host>`.",
  "New commands `evaluate`, `fetch`, `cdp`, `space cdp`, `events` and `clear-site-data` mirror the new routes.",
];
const SITE_PACKS = [
  "`run` and `repl` define four more globals, `sitePacks`, `siteContext`, `runSiteTool` and `runPageTool`, which stay writable.",
  "The skill now carries site packs for GitHub, Google Search and X.",
  "`run` and `repl` load `helpers.mjs` from the workspace when it exists, after `.env` and the globals, and make its exports globals.",
  "with `error: helpers_failed: ...` and exit status 1",
  "Single commands and `connect()` programs never load it.",
];

// Sentences a shipped phase made false.
const RETIRED = [
  "same-origin frames",
  "list cross-origin frames",
  "Cross-origin frames still need a handoff",
  "no JavaScript from the script ever reaches a web page",
  "is the one agent code a page runs",
  "arrives with page scripts in a later version",
  "makes one new outbound request",
];

describe("what the README says", () => {
  it("reads and acts in frames from any site", () => {
    expect(readme).toContain(
      "Snapshots read open shadow roots and frames from any site, nested ones too, so an agent can work inside embedded forms.",
    );
    expect(readme).toContain(
      "| Sees shadow roots and frames from any site | ✓ | ✓ | Some |",
    );
    expect(readme).toContain(
      "Snapshots read open shadow roots and frames, nested and cross-origin ones included.",
    );
    expect(readme).toContain(
      "Frames from other sites and canvases need no handoff: an agent reads and acts inside a frame from any site",
    );
    expect(readme).toContain(
      "Frames of your extensions, the PDF viewer and internal pages stay out of its reach.",
    );
  });

  it("names the page script methods and what an agent may run", () => {
    expect(readme).toContain(
      "`resume`, `downloads`, `cdp` and `finish`, which closes the agent's other pages",
    );
    expect(readme).toContain(
      "A page also has `evaluate`, `fetch`, `cdp`, `events` and `clearSiteData`.",
    );
    expect(readme).toContain(
      "Agents can run their own scripts and developer commands in agent tabs while **Page scripts** is on. Scripts see what the page sees; developer commands never leave that tab.",
    );
    expect(readme).toContain(
      "An agent can clear one site's cookies, storage or cache. In an isolated agent space that happens at once; anywhere else the data is yours too, so Kamapathy asks you above the tab and clears nothing unless you choose **Clear**.",
    );
  });

  it("offers site packs under Bring your own agent", () => {
    expect(section("Bring your own agent")).toContain(
      "Site packs give an agent notes and ready tools for a site. GitHub, Google Search and X come with the skill, and you can add your own in Kamapathy's workspace folder.",
    );
  });

  it("announces every change of existing behavior", () => {
    for (const sentence of [...ANNOUNCED, ...PHASE_7, ...SITE_PACKS])
      expect(changed, sentence).toContain(sentence);
  });

  it("keeps what is still true and drops what no longer is", () => {
    // Nothing about saved passwords is on the agent API, so the path answers
    // like any unknown route.
    expect(readme).toContain(
      "a path such as `GET /passwords` answers `404 route_not_found` like any other unknown route",
    );
    for (const sentence of RETIRED)
      expect(readme, sentence).not.toContain(sentence);
  });

  it("says where Set up agents is and what Remove setup leaves", () => {
    expect(section("Bring your own agent")).toContain(
      "The quickest way is **Set up agents**, in Settings under Agents, in the ⋯ menu or, on macOS, in the Help menu.",
    );
    expect(readme).toContain(
      "**Remove setup** removes what it added. It does not put back an agent's own copy of the skill that you chose to replace: that copy stays in the agent's skills folder under a name that starts with `.kamapathy-backup-`, and renaming it to `kamapathy` restores it.",
    );
    expect(readme).not.toContain("takes it all back");
  });

  it("names the menu bar only for macOS", () => {
    // Off macOS the window has no frame, so it shows no menu bar.
    expect(changed).toContain(
      "The command menu gains Set up agents, Help, Privacy and Report an issue, and the macOS menu bar gains a Help menu.",
    );
    expect(changed).toContain("**View > Passwords** opens the list on macOS");
    expect(readme).not.toContain("every platform now has a Help menu");
  });

  it("says USB and HID requests are still refused", () => {
    expect(changed).toContain(
      "USB and HID requests are still refused, before any chooser opens and without a report.",
    );
    expect(readme).not.toContain("every USB or HID chooser");
  });

  it("brings sign-ins over only from the Chrome-based browsers", () => {
    expect(readme).toContain(
      "From the Chrome-based browsers your sign-ins can come too, into your shared sign-ins or a new space for each profile.",
    );
    expect(readme).toContain("from Safari's exported file");
    expect(readme).not.toContain(
      "if you like, your sign-ins and saved passwords: a checkbox for every profile",
    );
  });
});
