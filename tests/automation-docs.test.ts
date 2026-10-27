import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The agent guide's hand-written prose. npm run docs:api owns the tables
// between the generated markers, so no claim here may lean on them.
const guide = readFileSync(
  new URL("../docs/automation.md", import.meta.url),
  "utf8",
);
const prose = guide.replace(
  /<!-- generated:(\w+) -->[\s\S]*?<!-- \/generated:\1 -->/g,
  "",
);
const section = (heading: string) => {
  const start = prose.indexOf(`\n## ${heading}\n`);
  const end = prose.indexOf("\n## ", start + 1);
  return prose.slice(start, end === -1 ? undefined : end);
};

describe("the agent guide", () => {
  it("keeps its sections in order, with page scripts and site packs after Scripts", () => {
    const headings = guide
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3));
    expect(headings).toEqual([
      "Connect",
      "Spaces, pages and labels",
      "Asking for one of your spaces",
      "Interact with a page",
      "Selectors",
      "Select files for upload",
      "Popups, dialogs and downloads",
      "Requests for the person",
      "Read a PDF",
      "Batch a short interaction",
      "Navigate and wait",
      "Scripts",
      "Page scripts and developer commands",
      "Site packs",
      "Human handoff",
      "Updates",
      "Status, labels and the agent cursor",
      "HTTP routes",
      "Errors",
      "Versions and API levels",
      "Isolation and limitations",
    ]);
  });

  it("documents page scripts, protocol commands and clearing a site's data", () => {
    const scripts = section("Page scripts and developer commands");
    for (const sentence of [
      "Page scripts are off in Kamapathy's Settings, under Agents. Continue with snapshots and actions.",
      "but an expression whose value is a promise comes back as an empty object unless it is awaited",
      "and the function form awaits a promise it returns",
      "A rejection the call awaits, such as an `async` function's throw, reports line 1, column 1",
      "It goes to the network, never through the page's service worker.",
      "The policy denies by default, and a refusal answers `403 cdp_method_blocked`",
      "Every command that reached Chromium expires the tab's refs, so take a new snapshot after one.",
      "No Input command an agent sends reaches the system clipboard, in either direction.",
      "Recording runs only while Page scripts is on and the agent has control",
      "Only **Clear** clears anything.",
      "No route clears a whole session.",
      // As the client and the bar do it.
      "a cycle or an `undefined` array item anywhere in `arg`, naming its path. An `undefined` property is left out, and an `undefined` `arg` means none.",
      "`evaluate`, `fetch`, `cdp` and `clear-site-data` wait for their answer their own timeout plus 5,000 ms, and `events` and `space cdp` 45,000 ms.",
      "otherwise it says sites may forget the person's settings for that origin.",
    ])
      expect(scripts).toContain(sentence);
  });

  it("reads and acts in frames from any web origin", () => {
    for (const sentence of [
      "read through open shadow roots and frames from any web origin",
      "Text and controls inside an iframe from any web origin appear where the frame sits in the page",
      "A frame from another origin is also listed as an `iframe` entry with `crossOrigin: true`, `origin`, `contentFrame` (the path its controls carry) and `content`: `read`, `pending`, `unavailable`, `limit` or `blocked` (extension and internal frames, which agents never reach). Refs inside a frame go stale once it loads another page.",
      "A snapshot that left frames `pending`, `unavailable` or `limit` carries `unreadFrames`",
      "`409 cross_origin_frame` is never returned",
    ])
      expect(prose).toContain(sentence);
    expect(section("Selectors")).toContain(
      "then the documents of its frames from any web origin, depth first by frame path",
    );
  });

  it("documents site packs, their globals and helpers.mjs", () => {
    expect(section("Scripts")).toContain(
      "`requestSpace`, `sitePacks`, `siteContext`, `runSiteTool`, `runPageTool` and `help`",
    );
    const packs = section("Site packs");
    for (const sentence of [
      "A workspace folder hides the bundled pack with its id, even when the workspace copy breaks a rule",
      "`runPageTool(packId, tool, args, { page })` runs a page tool",
      "`sites check` checks every pack, or the ones named",
      "GitHub, Google Search and X come with the skill",
      "ends the run before the script with `helpers_failed`",
    ])
      expect(packs).toContain(sentence);
  });

  it("says one thing per subject under Isolation and limitations", () => {
    const isolation = section("Isolation and limitations");
    for (const sentence of [
      "Agent scripts and protocol commands run only through the routes [Page scripts and developer commands](#page-scripts-and-developer-commands) describes, only in agent tabs and only while Page scripts is on; there is no browser-level protocol access, debugging port, Node.js, shell or filesystem interface.",
      "Its Chrome DevTools Protocol support is a protocol passthrough scoped to one tab",
      "They read through open shadow roots and frames from any web origin, and do not enter closed shadow roots or the frames of extensions and internal pages.",
      'Protocol commands aimed at an extension\'s frame or content-script world answer `403 cdp_method_blocked` with `reason: "scope"`.',
      "Site packs and helpers.mjs run in the agent's Node.js as your account, and page tools run in the agent's page through page scripts. Kamapathy's app never reads them, and the client loads workspace files only when your account owns them and no other account can change them.",
      "Activity records describe operations without recording filled values, script data or cookie values.",
      "Text inside frames from other sites, advertising included, is page content too.",
    ])
      expect(isolation).toContain(sentence);
  });

  it("drops what the shipped phases made false", () => {
    for (const retired of [
      // Section 8: agents run their own scripts and protocol commands now.
      "This is the one place where an agent's own code runs in a page",
      "today it gates this wait alone",
      "there is no other JavaScript, and no CDP",
      "It does not implement Chrome DevTools Protocol compatibility",
      // Section 9: frames from other origins are read and actionable.
      "same-origin iframe",
      "same-origin frames",
      "Any action on it fails with `409 cross_origin_frame`",
      "so an agent knows content exists that Kamapathy cannot read",
      "list a frame from another origin without reading it",
      // Section 16: the PDF clause says how PDFs are read instead.
      "closed shadow roots or PDF documents",
      // Sections 17 and 18 shipped: neither is missing.
      "Browser extensions, a password manager",
      "A password manager, sync",
      // Section 8 as it shipped: an undefined arg is no argument, events
      // has no timeout of its own, and the bar counts cookies only.
      "a top-level `undefined`",
      "Each call's HTTP timeout is its own timeout plus 5,000 ms.",
      "naming the cookies, site storage and cached files at stake",
    ])
      expect(guide, retired).not.toContain(retired);
  });
});
