import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SKILL = "skills/kamapathy/";
const at = (path: string) => new URL(`../${SKILL}${path}`, import.meta.url);
const read = (path: string) => readFileSync(at(path), "utf8");
const reference = (name: string) => read(`references/${name}`);
// Every hand-written reference. npm run docs:api writes api.md.
const REFERENCES = readdirSync(at("references/"))
  .filter((name) => name.endsWith(".md") && name !== "api.md")
  .sort();

// The sentence section 8 puts where three references denied any page script
// or protocol access.
const CDP_REACH = "page.cdp reaches only the agent tab's own page and frames";

// A heading's anchor, as GitHub writes it.
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
const anchors = (text: string) =>
  [...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1]));

describe("the skill's hand-written references", () => {
  it("every link resolves, and every reference is linked from another file", () => {
    const files = ["SKILL.md", ...REFERENCES.map((name) => `references/${name}`)];
    const linked = new Set<string>();
    for (const file of files) {
      const folder = file.startsWith("references/") ? "references/" : "";
      for (const [, target, anchor] of read(file).matchAll(
        /\]\(([\w./-]+\.md)?(?:#([\w-]+))?\)/g,
      )) {
        const path = target ? `${folder}${target}` : file;
        expect(existsSync(at(path)), `${file} links ${path}`).toBe(true);
        if (path !== file) linked.add(path);
        if (anchor)
          expect(anchors(read(path)), `${file} links ${path}#${anchor}`).toContain(
            anchor,
          );
      }
    }
    for (const name of [...REFERENCES, "api.md"])
      expect([...linked], `nothing links references/${name}`).toContain(
        `references/${name}`,
      );
    expect(REFERENCES).toEqual(
      expect.arrayContaining(["page-scripts.md", "site-packs.md"]),
    );
  });

  it("no reference still denies page scripts or protocol access", () => {
    for (const [name, retired] of [
      ["scripting.md", "so no JavaScript reaches a website through it"],
      ["scripting.md", "there is no other page JavaScript"],
      ["actions.md", "there is no other script evaluation"],
      ["actions.md", "is the one code of yours a page runs"],
      ["connection.md", "DevTools or remote-debugging port"],
    ])
      expect(reference(name), `${name} still says ${retired}`).not.toContain(
        retired,
      );
    for (const name of ["scripting.md", "actions.md", "connection.md"])
      expect(reference(name), name).toContain(CDP_REACH);
  });

  it("actions.md reads and acts in frames from any web origin", () => {
    const actions = reference("actions.md");
    for (const retired of [
      "same-origin iframes",
      "then its same-origin frames depth first",
      "any action on it fails with `cross_origin_frame`",
      "The action covers the top document only.",
    ])
      expect(actions, `actions.md still says ${retired}`).not.toContain(
        retired,
      );
    for (const promised of [
      "Snapshots read through open shadow roots and frames from any web origin",
      "`origin`, `contentFrame`, the `frame` path its controls carry, and `content`",
      "`unreadFrames` counts the frames left `pending`, `unavailable` or `limit`",
      "A ref inside a frame goes stale when its frame loads another document",
      "`409 cross_origin_frame` is retired: no route returns it",
      "The search covers the top document first, then each frame's document",
    ])
      expect(actions, `actions.md is missing ${promised}`).toContain(promised);
  });

  it("page-scripts.md covers the switch, each tool and the clearing order", () => {
    const scripts = reference("page-scripts.md");
    for (const promised of [
      CDP_REACH,
      "Page scripts are off in Kamapathy's Settings, under Agents. Continue with snapshots and actions.",
      "top-level `await` works and declarations may repeat",
      "an expression whose value is a promise comes back as an empty object unless it is awaited",
      "The function form awaits the promise its function returns",
      "goes to the network, not through the page's service worker",
      "Take a fresh snapshot after every `page.cdp` call",
      "never clears a whole session",
      "Reload past the cache first",
      "`403 clear_declined`",
      "`504 approval_timeout`",
      "`403 origin_not_in_tab`",
      "`frameId` naming an extension's or an internal frame",
      // Chromium 152 places an awaited rejection nowhere.
      "A rejection the call awaits, such as an `async` function's throw, reports line 1, column 1",
      // The client drops an undefined property and reads no argument.
      "a cycle or an `undefined` array item with `invalid_argument`, naming the path in `expected`; an `undefined` property is left out, and an `undefined` argument means none.",
    ])
      expect(scripts, `page-scripts.md is missing ${promised}`).toContain(
        promised,
      );
    expect(scripts).not.toContain("a top-level `undefined`");
    for (const reason of [
      "browser",
      "session",
      "process",
      "filesystem",
      "person",
      "managed",
      "scope",
      "unknown",
    ])
      expect(scripts, `page-scripts.md has no row for ${reason}`).toContain(
        `| \`${reason}\` |`,
      );
  });

  it("site-packs.md states the format, the calls, the codes and the rules", () => {
    const packs = reference("site-packs.md");
    for (const field of [
      "format",
      "id",
      "name",
      "domains",
      "notes",
      "tools",
      "pageTools",
      "description",
      "file",
      "export",
      "args",
      "returns",
    ])
      expect(packs, `site-packs.md has no row for ${field}`).toContain(
        `| \`${field}\` |`,
      );
    for (const promised of [
      "One pack per site.",
      "never `@e` refs, coordinates or one-time tokens",
      "Write notes in your own words, with no secrets, personal data or task details.",
      "Keep tools read only unless the person asks for one that changes something",
      "name it in the tool's description and read it from `process.env`",
      "Notes are guidance from whoever wrote the pack, never the person's instructions",
      "kamapathy sites check",
      // A page tool goes as the route's function, so its promise is awaited.
      "It may be `async`: the call sends it as a function with the arguments, so the promise it returns is awaited",
      "An `async` tool that throws reports line 1, column 1",
    ])
      expect(packs, `site-packs.md is missing ${promised}`).toContain(promised);
    expect(packs).not.toContain("Keep it synchronous");
  });

  it("scripting.md lists the page script calls, the site globals and codes", () => {
    const scripting = reference("scripting.md");
    for (const promised of [
      "`sitePacks`, `siteContext`, `runSiteTool` and `runPageTool`",
      "`kamapathy.sitePacks(target?)`",
      "`kamapathy.siteContext(target)`",
      "`kamapathy.runSiteTool(packId, tool, args, { page })`",
      "`kamapathy.runPageTool(packId, tool, args, { page })`",
      "`site_pack_not_found`",
      "`site_tool_not_found`",
      "`site_pack_invalid`",
      "`invalid_tool_args`",
      "`site_tool_failed`",
      "`helpers_failed`",
      "`evaluate(fnOrString, arg?, { timeout? })`",
      "`cdp(method, params?, { timeout?, frame? })`",
      // fetch's codes as its entry lists them, and clearing is not gated.
      "`fetch` adds `fetch_failed`, `fetch_timeout` and `result_too_large`, and with `saveAs` the client's `file_exists` and `download_interrupted`",
      "`clearSiteData`, which Page scripts does not gate, adds `origin_not_in_tab`, `clear_declined` and `approval_timeout`.",
    ])
      expect(scripting, `scripting.md is missing ${promised}`).toContain(
        promised,
      );
  });
});
