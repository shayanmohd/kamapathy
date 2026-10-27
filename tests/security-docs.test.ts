import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const security = readFileSync(
  new URL("../docs/SECURITY.md", import.meta.url),
  "utf8",
);

// The sections a reader checks the boundary in, in the page's order.
const HEADINGS = [
  "Remote pages and browser controls",
  "Spaces and local data",
  "Saved passwords",
  "Local automation",
  "Extensions",
  "Agent setup",
  "Updates",
  "Privacy",
  "Release work",
  "Reporting a vulnerability",
];

const says = (sentences: string[]) => {
  for (const sentence of sentences)
    expect(security, `SECURITY.md is missing: ${sentence}`).toContain(
      sentence,
    );
};

describe("what the security model says", () => {
  it("keeps every section, in order", () => {
    const at = HEADINGS.map((heading) => security.indexOf(`\n## ${heading}\n`));
    expect(at).not.toContain(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("states the isolation rules every section relies on", () => {
    says([
      "A personal space becomes reachable only through the person's own click in Kamapathy",
      "with no debugger session and no agent input, until the agent adopts it",
      "the server refuses every request, including `resume`",
      "Agent text is bounded and cannot pass for Kamapathy's own words.",
      "Agents open HTTP, HTTPS and `about:blank` only",
      "it is released when you take over or stop the agent",
    ]);
  });

  it("says what page scripts and protocol commands reach", () => {
    says([
      "Agents can now also run their own scripts in the tabs they manage, while **Page scripts**",
      "values snapshots hide, cookies without HttpOnly and stored tokens",
      "`403 agent_scripts_off`",
      "never through a request path that skips CORS",
      "agents never see a session id",
      "`403 cdp_method_blocked`",
      "listing only that space's tabs",
      "No input command an agent may send reaches the system clipboard",
      "a page's own script, an agent's included, can still write to it",
      "an event log shows each cookie value as `(hidden)`",
      "until that limit stops it",
      "and the agent can run its own scripts in the tabs it manages there while Page scripts is on",
    ]);
  });

  it("says frames from any web origin are read and worked in", () => {
    says([
      "frames from any web origin, including embedded payment and sign-in forms",
      "an embedded frame can show an account you are signed in to elsewhere",
      "report only that a value is hidden, in every frame",
      "Protocol commands into an extension's frame or content-script world are refused as out of scope",
    ]);
  });

  it("says clearing a site's data needs the person outside an isolated space", () => {
    says([
      "An agent can clear one site's cookies, storage or cache, and nothing clears a whole session.",
      "Only the person's **Clear** clears anything",
    ]);
  });

  it("says where site pack code runs and what the client refuses", () => {
    says([
      "A pack's Node tools and `helpers.mjs` run in the agent's own Node.js",
      "Kamapathy's app never reads the workspace or loads a pack",
      "a pack from elsewhere deserves review before it goes into the workspace",
    ]);
  });

  it("drops the sentences a shipped phase made false", () => {
    for (const sentence of [
      // Phase 7: agents run their own scripts and read frames from any origin.
      "the only code of an agent's own that a page runs is the expression or function a wait tests",
      "a frame from another origin is listed by its title, name, or host and refuses every action",
      "cross_origin_frame",
      // Section 7: a granted space holds prompts and keeps armed downloads.
      "and downloads and permission prompts are denied",
      // Section 18: the vault and its section replaced these.
      "does not add an encrypted vault",
      "credential manager",
    ])
      expect(security, `SECURITY.md still says: ${sentence}`).not.toContain(
        sentence,
      );
  });
});
