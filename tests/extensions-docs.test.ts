import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The sentences every surface has to say the same way.
const UPDATES =
  "If you add extensions, Kamapathy asks the Chrome Web Store once a day whether they have updates, sending their IDs and versions. Turn this off in Settings, under Extensions.";
const LABEL = "Extension: <name>";
const WHERE = "extensions run in agent spaces that share";
const AGENT_DOCS = [
  "docs/automation.md",
  "skills/kamapathy/SKILL.md",
  "skills/kamapathy/references/actions.md",
];

describe("what the docs say about extensions", () => {
  it("README offers them and announces what changed for agents", () => {
    const readme = read("README.md");
    expect(readme).toContain("Chrome Web Store");
    expect(readme).toContain("Manifest V3 only");
    expect(readme).toContain(UPDATES);
    expect(readme).toContain(
      "The person's extensions run in agent spaces that share their sign-ins, so their content scripts can change agent pages. Isolated agent spaces never run them.",
    );
    expect(readme).toContain(
      "A frame of one of the person's extensions is a blocked `iframe` entry with `extension` and the label `Extension: <name>`, and input there returns `403 input_target_blocked` with `frame` and `extension`.",
    );
    expect(readme).toContain(
      'CDP commands aimed at an extension\'s frame or content-script world return `403 cdp_method_blocked` with `reason: "scope"`.',
    );
    // Neither they nor the password manager are missing any more.
    expect(readme).toContain(
      "Sync, an ad blocker and DRM playback are not part of it yet.",
    );
    expect(readme).not.toContain("Browser extensions, a password manager");
    expect(readme).not.toContain("A password manager, sync");
  });

  it("the security model has an Extensions section and keeps section 18's words", () => {
    const security = read("docs/SECURITY.md");
    expect(security).toContain("\n## Extensions\n");
    expect(security).toContain("Chrome Web Store");
    expect(security).toContain("agent socket");
    expect(security).not.toContain("an extension permission model");
    // Section 18 shipped, so the page names the vault extensions cannot reach
    // rather than listing a credential manager among what Kamapathy lacks.
    expect(security).toContain("password vault");
  });

  it("the architecture names the host, its files and its folder", () => {
    const architecture = read("docs/architecture.md");
    expect(architecture).toContain("extensions.json");
    expect(architecture).toContain("`electron/extensions/`");
    expect(architecture).toContain("`shared/extensions.ts`");
    expect(architecture).toContain("Extensions/");
    expect(architecture).not.toContain("extension marketplace");
  });

  it("the agent guide, the skill and the actions reference describe a frame", () => {
    for (const path of AGENT_DOCS) {
      const text = read(path);
      expect(text, path).toContain(LABEL);
      expect(text, path).toContain("input_target_blocked");
      expect(text, path).toContain(WHERE);
    }
  });

  it("the site offers them and discloses the update check", () => {
    const html = read("site/index.html");
    expect(html).toContain("Chrome Web Store extensions come over");
    // Two phases each rewrote the import paragraph and the import answer, so
    // the page carried both versions, and each denied what the other offered.
    // One sentence each now, and neither denial can come back.
    expect(html).toContain("saved passwords from the Chrome-based browsers");
    expect(html).toContain(
      "Your Chrome Web Store extensions come over without their data",
    );
    expect(html).toContain(UPDATES);
    expect(html).not.toContain("Not there yet: browser extensions");
    expect(html).not.toContain("Browser extensions, sync, a password manager");
    expect(html).not.toContain("passwords and extensions do not come over");
    expect(html).not.toContain("passwords do not come over yet");
    expect(html).not.toContain("Extensions do not come over yet");
  });
});
