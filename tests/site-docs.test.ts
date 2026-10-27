import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The public page against the spec's Docs and copy lists. Editing index.html
// changes no asset, so the hashes tests/site.test.ts checks stay current; a
// change to site/styles.css or site/app.js must change the hash in its link.
const html = readFileSync(
  new URL("../site/index.html", import.meta.url),
  "utf8",
);

const SITE_PACKS =
  '<li><svg><use href="#i-globe" /></svg><div><b>Site packs.</b> Notes and tools for the sites you use, so an agent knows its way around. GitHub, Google Search and X are included.</div></li>';

describe("what the site says", () => {
  it("reads and acts in frames from any site, and says what stays out of reach", () => {
    expect(html).toContain(
      "Agent snapshots read open shadow roots and frames from any site, so an agent can fill an embedded checkout or sign-in form.",
    );
    expect(html).toContain(
      "Snapshots read open shadow roots and frames, including ones from other sites.",
    );
    expect(html).toContain("Sees shadow roots and frames from any site");
    expect(html).toContain(
      "Canvas interfaces and frames from other sites now take an agent's mouse and keyboard, while your extensions' frames and Kamapathy's own pages stay out of its reach.",
    );
    expect(html).not.toContain("same-origin frames");
    expect(html).not.toContain("frames from other origins");
    expect(html).not.toContain("cannot be read or clicked");
    expect(html).not.toContain("frames from another origin still need you");
  });

  it("says agents can run their own scripts, and which switch stops it", () => {
    expect(html).toContain(
      "In agent spaces they can also run their own scripts. Turn off <b>Page scripts</b> in Settings to keep agents to reading and clicking.",
    );
  });

  it("lists site packs after the scripting item", () => {
    expect(html).toContain(SITE_PACKS);
    expect(html.indexOf(SITE_PACKS)).toBeGreaterThan(
      html.indexOf("<b>One script, or one command at a time.</b>"),
    );
  });

  it("brings sign-ins over only from the Chrome-based browsers", () => {
    expect(html).toContain(
      "Import bookmarks and history from Chrome, Edge, Brave, Arc, Vivaldi, Opera or Firefox, and Safari from the file it exports, plus your sign-ins from the Chrome-based ones if you like.",
    );
    expect(html).not.toContain(
      "your sign-ins from Chrome, Edge, Brave, Arc, Vivaldi, Opera or Firefox",
    );
  });

  it("defines every icon it uses in the sprite", () => {
    for (const [, id] of html.matchAll(/<use href="#([\w-]+)"/g))
      expect(html, id).toContain(`<symbol id="${id}"`);
  });

  it("keeps what the earlier phases put there", () => {
    for (const sentence of [
      "Every agent works in a space you can watch, and never sees your tabs unless you let it use a space.",
      "An agent never sees your tabs unless you let it use a space.",
      '<button type="button" data-action="stop">Stop</button>',
      "carries a whole task in JavaScript or TypeScript",
      "waits for you in Kamapathy's own bar, which no agent can answer, and an agent keeps only a download it asked for.",
      "The first launch walks you through spaces, privacy, import, agent setup and your default browser.",
      "curl -fsSL https://kamapathy.app/install.sh | sh",
      "In Kamapathy, open <b>Set up agents</b> from Settings or the menu.",
      "<summary>What does Set up agents change on my computer?</summary>",
      "signed installers, self-installing updates and an independent security audit",
      "Once a day it asks GitHub whether a newer version exists, which you can turn off in Settings.",
      "They never get your saved passwords.",
    ])
      expect(html).toContain(sentence);
    for (const id of [
      "features",
      "setup",
      "agents",
      "compare",
      "tour",
      "download",
      "privacy",
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain("Agents never see your tabs.");
    expect(html).not.toContain("automatic updates");
    expect(html).not.toContain("a password manager");
  });
});
