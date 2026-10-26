// The sample packs' tools and page tools, run against hand written pages in
// Playwright's Chromium so the selectors are tested rather than assumed. A
// fake page records where a tool navigates, serves the fixture at that path
// and runs everything else in the browser. Nothing here reaches the network,
// and these tests skip when Playwright's browser is not installed.
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runPageToolIn,
  runToolIn,
  siteRoots,
} from "../skills/kamapathy/scripts/lib/sites.mjs";
import { KamapathyError } from "../skills/kamapathy/scripts/lib/errors.mjs";
import { sitePackPages } from "./fixtures/site-packs/index.mjs";

const executable = chromium.executablePath();
const browserAvailable = !!executable && existsSync(executable);
// The packs the skill ships, and only those: no workspace folder takes part.
const [, bundled] = siteRoots({ KAMAPATHY_WORKSPACE: tmpdir() });
const roots = [bundled];

describe.skipIf(!browserAvailable)("site pack samples in Chromium", () => {
  let site;
  let origin;
  let browser;
  const opened = [];
  beforeAll(async () => {
    site = createServer((request, response) => {
      const path = new URL(request.url || "/", "http://x").pathname;
      const html = sitePackPages[path];
      response.writeHead(html ? 200 : 404, { "Content-Type": "text/html" });
      // A path the fixtures do not hold answers the way the live site does.
      response.end(html || sitePackPages["/missing/repo/issues"]);
    });
    await new Promise((done) => site.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${site.address().port}`;
    browser = await chromium.launch();
  }, 60000);
  afterAll(async () => {
    for (const tab of opened) await tab.close().catch(() => {});
    await browser?.close();
    site?.close();
  });

  /**
   * A page as a tool sees it: `goneTo` records every URL it was sent to, the
   * fixture at that path is served from this file's own server, and the
   * other calls run in Playwright.
   */
  async function fakePage() {
    const tab = await browser.newPage({
      viewport: { width: 1100, height: 800 },
    });
    opened.push(tab);
    const page = {
      url: "about:blank",
      goneTo: [],
      async goto(url) {
        page.goneTo.push(url);
        const target = new URL(url);
        const landed = await tab.goto(origin + target.pathname + target.search);
        page.url = url;
        return {
          ok: true,
          tab: { id: "tab-1", url },
          httpStatus: landed?.status(),
          waitUntil: "load",
        };
      },
      navigate(url) {
        return page.goto(url);
      },
      async waitForSelector(selector, options = {}) {
        // A short wait, so a case that measures a page without the element
        // does not sit out a real timeout.
        const timeout = options.timeout ?? 1500;
        try {
          await tab.waitForSelector(selector, {
            state: options.state ?? "visible",
            timeout,
          });
        } catch {
          throw new KamapathyError(
            "wait_timeout",
            `Nothing matched ${selector} within ${timeout} ms.`,
            { status: 408 },
          );
        }
        return {
          ok: true,
          tab: { id: "tab-1", url: page.url },
          state: "visible",
        };
      },
      // The client sends a function with its argument through the route's own
      // fields and a string as one expression, so the fake does the same.
      evaluate(fnOrString, arg) {
        if (typeof fnOrString !== "function")
          return tab.evaluate(String(fnOrString));
        const json = arg === undefined ? "" : JSON.stringify(arg);
        return tab.evaluate(`(${fnOrString.toString()}\n)(${json})`);
      },
      async scroll(direction, pixels = 600) {
        const by = direction === "up" ? -pixels : pixels;
        await tab.evaluate(`window.scrollBy(0, ${by})`);
        return { ok: true, scrolled: true };
      },
    };
    return page;
  }

  const thrown = (promise) =>
    promise.then(
      () => null,
      (error) => error,
    );

  it("github tools read search, issues and stats with encoded queries", async () => {
    const page = await fakePage();
    const run = (tool, args) =>
      runToolIn(
        {},
        { packId: "github", tool, args, page, client: null, roots },
      );
    const pageTool = (tool, args) =>
      runPageToolIn(
        {},
        {
          packId: "github",
          tool,
          args,
          evaluate: (expression) => page.evaluate(expression),
          roots,
        },
      );

    // The query reaches the URL encoded, and the shown counts, the language
    // and the absolute addresses come back in the order the page lists them.
    const found = await run("search_repositories", {
      query: "a b/c",
      limit: 2,
    });
    expect(page.goneTo).toEqual([
      "https://github.com/search?q=a%20b%2Fc&type=repositories",
    ]);
    expect(found).toEqual([
      {
        fullName: "shayanmohd/kamapathy",
        url: `${origin}/shayanmohd/kamapathy`,
        description: "A calm desktop browser you share with your agents.",
        stars: 12300,
        language: "TypeScript",
      },
      {
        fullName: "second/repo",
        url: `${origin}/second/repo`,
        description: null,
        stars: 948,
        language: "JavaScript",
      },
    ]);

    // Without a limit it reads the whole first page, a result with no stars
    // or language reads null for both, and a long snippet is cut.
    const all = await run("search_repositories", { query: "kamapathy" });
    expect(all).toHaveLength(3);
    expect(all[2]).toMatchObject({
      fullName: "third/repo",
      url: `${origin}/third/repo`,
      stars: null,
      language: null,
    });
    expect(all[2].description).toHaveLength(300);
    expect(all[2].description.startsWith("A long description")).toBe(true);

    // A limit outside 1 to 50 is the tool's own refusal, and nothing moves.
    for (const limit of [0, 51]) {
      const refused = await thrown(
        run("search_repositories", { query: "x", limit }),
      );
      expect(refused?.code, String(limit)).toBe("site_tool_failed");
      expect(refused.packId, String(limit)).toBe("github");
      expect(refused.tool, String(limit)).toBe("search_repositories");
      expect(refused.cause, String(limit)).toBe(
        "limit must be an integer from 1 to 50.",
      );
      expect(refused.at, String(limit)).toMatch(
        /^tools\/search-repositories\.mjs:\d+:\d+$/,
      );
    }
    expect(page.goneTo).toHaveLength(2);

    // The issues page is built from the owner and the repository, and each
    // row gives its number, title, address and labels.
    const issues = await run("open_issues", { owner: "owner", repo: "repo" });
    expect(page.goneTo.at(-1)).toBe(
      "https://github.com/owner/repo/issues?q=is%3Aissue%20state%3Aopen",
    );
    expect(issues).toEqual([
      {
        number: 412,
        title: "Snapshot refs go stale between reads",
        url: "https://github.com/owner/repo/issues/412",
        labels: ["bug", "help wanted"],
      },
      {
        number: 408,
        title: "Wait for the list before reading it",
        url: "https://github.com/owner/repo/issues/408",
        labels: [],
      },
      {
        number: 400,
        title: "A relative link still reads absolute",
        url: `${origin}/owner/repo/issues/400`,
        labels: ["docs"],
      },
    ]);
    expect(
      await run("open_issues", { owner: "owner", repo: "repo", limit: 1 }),
    ).toHaveLength(1);

    // An owner or a repository name outside its pattern is refused before
    // the tool navigates.
    const sent = page.goneTo.length;
    for (const [owner, repo, name] of [
      ["-owner", "repo", "owner"],
      ["own er", "repo", "owner"],
      ["owner", "re po", "repo"],
      ["owner", "", "repo"],
    ]) {
      const refused = await thrown(run("open_issues", { owner, repo }));
      expect(refused?.code, `${owner}/${repo}`).toBe("site_tool_failed");
      expect(refused.cause, `${owner}/${repo}`).toContain(name);
    }
    expect(page.goneTo).toHaveLength(sent);

    // A repository this space cannot see: the page says so although the
    // server answered 200, and the handoff names what the person can do.
    const hidden = await thrown(
      run("open_issues", { owner: "missing", repo: "repo" }),
    );
    expect(hidden?.code).toBe("site_tool_failed");
    expect(hidden.cause).toBe(
      "GitHub shows no repository missing/repo to this space. Check the name, or sign in if it is private.",
    );
    // The same sentence from the status alone, with no list to wait for.
    const gone = await thrown(
      run("open_issues", { owner: "nope", repo: "gone" }),
    );
    expect(gone?.code).toBe("site_tool_failed");
    expect(gone.cause).toBe(
      "GitHub shows no repository nope/gone to this space. Check the name, or sign in if it is private.",
    );

    // The page tool reads the numbers a repository page shows.
    await page.goto("https://github.com/owner/repo");
    expect(await pageTool("repository_stats", undefined)).toEqual({
      fullName: "owner/repo",
      description:
        "Notes and tools for one site, read by an agent before it starts.",
      stars: 12300,
      forks: 481,
      language: "TypeScript",
      topics: ["site-packs", "agents"],
    });

    // Anywhere else it answers null instead of guessing.
    await page.goto("https://github.com/search?q=kamapathy&type=repositories");
    expect(await pageTool("repository_stats", {})).toBe(null);
  }, 60000);
});
