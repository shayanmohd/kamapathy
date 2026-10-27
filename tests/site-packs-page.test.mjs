// The sample packs' tools and page tools, run against hand written pages in
// Playwright's Chromium so the selectors are tested rather than assumed. A
// fake page records where a tool navigates, serves the fixture at that path
// and runs everything else in the browser. Nothing here reaches the network,
// and these tests skip when Playwright's browser is not installed.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envelope } from "../electron/agent/errors.ts";
import { evaluateScript, scriptFields } from "../electron/agent/evaluate.ts";
import { Page, connect } from "../skills/kamapathy/scripts/api.mjs";
import {
  runPageToolIn,
  runToolIn,
  siteRoots,
} from "../skills/kamapathy/scripts/lib/sites.mjs";
import { KamapathyError } from "../skills/kamapathy/scripts/lib/errors.mjs";
import { Session } from "../skills/kamapathy/scripts/lib/request.mjs";
import {
  sitePackPages,
  sitePackPrefixes,
} from "./fixtures/site-packs/index.mjs";

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
      // Every scroll a tool asked for, and every wait it took between them.
      scrolled: [],
      waited: [],
      // The address the next navigation really ends at, the way a consent or
      // sign-in wall redirects one. A case sets it; one navigation uses it.
      landsAt: null,
      // The status the next navigation reports, the way a site refusing a
      // space answers one. A case sets it; one navigation uses it.
      landsWith: null,
      async goto(url) {
        page.goneTo.push(url);
        const target = new URL(page.landsAt || url);
        page.landsAt = null;
        const refused = page.landsWith;
        page.landsWith = null;
        // Packs that answer the same paths each keep their pages under a
        // prefix of their own.
        const prefix = sitePackPrefixes[target.hostname] ?? "";
        const landed = await tab.goto(
          origin + prefix + target.pathname + target.search,
        );
        page.url = target.href;
        return {
          ok: true,
          tab: { id: "tab-1", url: target.href },
          httpStatus: refused ?? landed?.status(),
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
        page.scrolled.push([direction, pixels]);
        const by = direction === "up" ? -pixels : pixels;
        await tab.evaluate(`window.scrollBy(0, ${by})`);
        return { ok: true, scrolled: true };
      },
      // The wait a tool takes after a scroll is where a page draws what the
      // scroll brought into view, so the fake yields frames rather than
      // seconds and records what was asked for.
      async waitForTimeout(ms) {
        page.waited.push(ms);
        await tab.evaluate(
          () =>
            new Promise((done) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => setTimeout(done, 0)),
              ),
            ),
        );
      },
    };
    return page;
  }

  const thrown = (promise) =>
    promise.then(
      () => null,
      (error) => error,
    );
  // A page tool reaches the page the way Client.runPageTool sends it: as a
  // function whose source is the file's, called with the arguments.
  const pageToolEvaluate = (page) => (source, arg) =>
    page.evaluate(
      Object.assign(() => {}, { toString: () => source }),
      arg,
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
          evaluate: pageToolEvaluate(page),
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

  it("google search skips sponsored results and stops at a consent page", async () => {
    const page = await fakePage();
    const run = (tool, args) =>
      runToolIn(
        {},
        { packId: "google-search", tool, args, page, client: null, roots },
      );

    // The query reaches the URL percent encoded with English results asked
    // for, and only the organic block comes back: the sponsored result, the
    // question card and the related searches stay out. A redirect style
    // address reads as its target and a relative one reads absolute.
    const found = await run("search", { query: "site:example.com a b" });
    expect(page.goneTo).toEqual([
      "https://www.google.com/search?q=site%3Aexample.com%20a%20b&hl=en",
    ]);
    expect(found).toEqual([
      {
        title: "The example guide",
        url: "https://docs.example.com/guide",
        snippet: "How the guide explains itself, in one line.",
      },
      {
        title: "Notes on example",
        url: `${origin}/notes`,
        snippet: null,
      },
      {
        title: "A long answer about example",
        url: "https://long.example.com/",
        snippet: expect.any(String),
      },
    ]);
    expect(found[2].snippet).toHaveLength(300);
    expect(found[2].snippet.startsWith("A long answer")).toBe(true);

    // A limit reads that many, and one outside 1 to 20 is the tool's own
    // refusal before it navigates.
    expect(await run("search", { query: "example", limit: 2 })).toHaveLength(2);
    const sent = page.goneTo.length;
    for (const limit of [0, 21]) {
      const refused = await thrown(run("search", { query: "x", limit }));
      expect(refused?.code, String(limit)).toBe("site_tool_failed");
      expect(refused.packId, String(limit)).toBe("google-search");
      expect(refused.tool, String(limit)).toBe("search");
      expect(refused.cause, String(limit)).toBe(
        "limit must be an integer from 1 to 20.",
      );
      expect(refused.at, String(limit)).toMatch(/^tools\/search\.mjs:\d+:\d+$/);
    }
    expect(page.goneTo).toHaveLength(sent);

    // Both walls hand the space back to the person. Each wall page carries a
    // result of its own, so a tool reading the page instead of reading where
    // it landed would answer with that rather than throw.
    for (const landsAt of [
      "https://consent.google.com/consent?continue=https://www.google.com/search",
      "https://www.google.com/sorry/index?continue=https://www.google.com/search",
    ]) {
      page.landsAt = landsAt;
      const walled = await thrown(run("search", { query: "example" }));
      expect(walled?.code, landsAt).toBe("site_tool_failed");
      expect(walled.cause, landsAt).toBe(
        "Google is asking the person to choose or verify. Hand the space to the person, then run the tool again.",
      );
      expect(page.url, landsAt).toBe(landsAt);
    }
  }, 60000);

  it("x timeline collects posts across scrolls once each and stops at the sign-in flow", async () => {
    const run = (target, tool, args) =>
      runToolIn(
        {},
        { packId: "x", tool, args, page: target, client: null, roots },
      );
    const handoff =
      "X needs the person to sign in. Hand the space to the person, then run the tool again.";

    // The timeline already open, read as it is: the tool navigates nowhere,
    // scrolls 800 pixels between rounds and waits 700 ms for the page to
    // draw, keeps a post once however often it is drawn again, and stops
    // three rounds after the timeline stops growing.
    const home = await fakePage();
    await home.goto("https://x.com/home");
    const posts = await run(home, "timeline_posts", undefined);
    expect(home.goneTo).toHaveLength(1);
    expect(posts.map((post) => post.url)).toEqual([
      `${origin}/kamapathy/status/1001`,
      `${origin}/agentnews/status/1002`,
      `${origin}/pixelpress/status/1003`,
      `${origin}/desksmith/status/1004`,
      `${origin}/owlpost/status/1005`,
      `${origin}/twokeys/status/1006`,
      "https://x.com/slowloop/status/1007",
      `${origin}/deskplant/status/1008`,
      `${origin}/lamplight/status/1009`,
    ]);
    expect(posts[0]).toEqual({
      url: `${origin}/kamapathy/status/1001`,
      author: "Kamapathy",
      handle: "@kamapathy",
      time: "2026-10-20T09:30:00.000Z",
      text: "A calm desktop browser you share with your agents.",
    });
    // A post with no words reads as none, one whose link holds no time reads
    // null, and a long one is cut.
    expect(posts[2].text).toBe("");
    expect(posts[3].time).toBe(null);
    expect(posts[1].text).toHaveLength(300);
    expect(posts[1].text.startsWith("A line that says")).toBe(true);
    expect(home.scrolled).toEqual(
      Array.from({ length: 6 }, () => ["down", 800]),
    );
    expect(home.waited).toEqual([700, 700, 700, 700, 700, 700]);

    // A limit stops the rounds as soon as it is reached, mid scroll.
    const few = await fakePage();
    await few.goto("https://x.com/home");
    expect(await run(few, "timeline_posts", { limit: 6 })).toHaveLength(6);
    expect(few.scrolled).toHaveLength(1);

    // A timeline with no end stops at the thirtieth round, which is twenty
    // nine scrolls, and answers with what those rounds collected.
    const endless = await fakePage();
    await endless.goto("https://x.com/endless");
    expect(await run(endless, "timeline_posts", { limit: 100 })).toHaveLength(
      30,
    );
    expect(endless.scrolled).toHaveLength(29);

    // A limit outside 1 to 100 is the tool's own refusal, and nothing moves.
    const still = await fakePage();
    await still.goto("https://x.com/home");
    for (const limit of [0, 101]) {
      const refused = await thrown(run(still, "timeline_posts", { limit }));
      expect(refused?.code, String(limit)).toBe("site_tool_failed");
      expect(refused.packId, String(limit)).toBe("x");
      expect(refused.tool, String(limit)).toBe("timeline_posts");
      expect(refused.cause, String(limit)).toBe(
        "limit must be an integer from 1 to 100.",
      );
      expect(refused.at, String(limit)).toMatch(
        /^tools\/timeline-posts\.mjs:\d+:\d+$/,
      );
    }
    expect(still.scrolled).toEqual([]);
    expect(still.goneTo).toHaveLength(1);

    // The sign-in flow is read from the page's own address at the start of
    // every round, so the post that page carries is never reported as the
    // timeline and a session that ends mid scroll hands the space over.
    await still.goto("https://x.com/i/flow/login");
    const walled = await thrown(run(still, "timeline_posts", undefined));
    expect(walled?.code).toBe("site_tool_failed");
    expect(walled.cause).toBe(handoff);
    expect(still.scrolled).toEqual([]);

    // Accounts: one navigation to the people tab with the words encoded, and
    // each card read as its name, handle, address and bio.
    const search = await fakePage();
    const two = await run(search, "search_people", { query: "a b", limit: 2 });
    expect(search.goneTo).toEqual(["https://x.com/search?q=a%20b&f=user"]);
    expect(two).toEqual([
      {
        name: "Kamapathy",
        handle: "@kamapathy",
        url: `${origin}/kamapathy`,
        bio: "A calm desktop browser you share with your agents.",
      },
      {
        name: "Agent News",
        handle: "@agentnews",
        url: `${origin}/agentnews`,
        bio: "",
      },
    ]);
    expect(search.scrolled).toEqual([]);

    // The same search with the standing limit: the list keeps answering as
    // it is scrolled, so the tool stops at its tenth round, which is nine
    // scrolls. The card holding both names in one link and a bio longer than
    // an account keeps reads like the rest.
    const more = await fakePage();
    const accounts = await run(more, "search_people", { query: "a b" });
    expect(accounts).toHaveLength(12);
    expect(more.scrolled).toHaveLength(9);
    expect(more.waited).toHaveLength(9);
    expect(accounts[2]).toMatchObject({
      name: "One Link",
      handle: "@onelink",
      url: `${origin}/onelink`,
    });
    expect(accounts[2].bio).toHaveLength(300);
    expect(accounts.at(-1)).toEqual({
      name: "Person 9",
      handle: "@person9",
      url: `${origin}/person9`,
      bio: "Account 9.",
    });

    // A limit outside 1 to 50 is this tool's own refusal, before it moves.
    for (const limit of [0, 51]) {
      const refused = await thrown(
        run(search, "search_people", { query: "x", limit }),
      );
      expect(refused?.code, String(limit)).toBe("site_tool_failed");
      expect(refused.tool, String(limit)).toBe("search_people");
      expect(refused.cause, String(limit)).toBe(
        "limit must be an integer from 1 to 50.",
      );
      expect(refused.at, String(limit)).toMatch(
        /^tools\/search-people\.mjs:\d+:\d+$/,
      );
    }
    expect(search.goneTo).toHaveLength(1);

    // Both walls hand the space back: the sign-in flow a navigation lands
    // on, which carries an account of its own that a tool reading the page
    // would answer with, and the bare refusal x.com answers some spaces.
    const flow = "https://x.com/i/flow/login?redirect_after_login=%2Fsearch";
    search.landsAt = flow;
    const sent = await thrown(run(search, "search_people", { query: "a b" }));
    expect(sent?.code).toBe("site_tool_failed");
    expect(sent.cause).toBe(handoff);
    expect(search.url).toBe(flow);
    search.landsWith = 403;
    const denied = await thrown(run(search, "search_people", { query: "a b" }));
    expect(denied?.code).toBe("site_tool_failed");
    expect(denied.cause).toBe(handoff);
  }, 90000);

  it("page tools read suggestions and the focused post", async () => {
    const page = await fakePage();
    const pageTool = (packId, tool, args) =>
      runPageToolIn(
        {},
        {
          packId,
          tool,
          args,
          evaluate: pageToolEvaluate(page),
          roots,
        },
      );

    // The open list reads in the order it is shown, each option as the
    // suggestion alone: an option's own text adds the description Google
    // puts beside it, and its accessible name does not.
    await page.goto("https://www.google.com/suggest");
    expect(await pageTool("google-search", "suggestions", undefined)).toEqual([
      "kamapathy browser",
      "kamapathy agent api",
      "kamapalli",
      "kamapathy docs",
    ]);

    // A list that is still in the page but closed reads as no list at all.
    await page.goto("https://www.google.com/closed");
    expect(await pageTool("google-search", "suggestions", {})).toEqual([]);

    // A post page: focus wins, so the reply holding it is the answer rather
    // than the post the address names.
    const status = "1900000000000000001";
    await page.goto(`https://x.com/kamapathy/status/${status}`);
    expect(await pageTool("x", "focused_post", undefined)).toEqual({
      url: `${origin}/owlpost/status/1900000000000000002`,
      author: "Owl Post",
      handle: "@owlpost",
      time: "2026-10-20T10:00:00.000Z",
      text: "The reply that holds focus.",
    });

    // With nothing focused, the post the address names is the answer.
    await page.evaluate(() => document.activeElement.blur());
    expect(await pageTool("x", "focused_post", {})).toMatchObject({
      url: `${origin}/kamapathy/status/${status}`,
      author: "Kamapathy",
      handle: "@kamapathy",
    });

    // A page that is neither reads null instead of guessing.
    await page.goto("https://x.com/search?q=a%20b&f=user");
    expect(await pageTool("x", "focused_post", undefined)).toBe(null);
  }, 60000);

  it("an async page tool returns its awaited value through the client and the evaluate route", async () => {
    // A workspace pack of two page tools, written the way the client's file
    // rules want them.
    const home = await mkdtemp(join(tmpdir(), "kamapathy-page-tools-"));
    const dir = join(home, "sites", "lab");
    const files = {
      "pack.json": JSON.stringify({
        format: 1,
        id: "lab",
        name: "Lab",
        domains: ["127.0.0.1"],
        pageTools: {
          slow_total: {
            description: "Read the total once the page has had a turn.",
            file: "page-tools/slow-total.js",
            args: { add: { type: "number", description: "Added to it." } },
            returns: { type: "number", description: "The total." },
          },
          missing_box: {
            description: "Read the size of a box the page lacks.",
            file: "page-tools/missing-box.js",
            returns: { type: "number", description: "Nothing: it throws." },
          },
        },
      }),
      "page-tools/slow-total.js": `async (args) => {
  await new Promise((done) => setTimeout(done, 20));
  return Number(document.querySelector("#total").textContent) + args.add;
}
`,
      "page-tools/missing-box.js": "(args) => args.box.size\n",
    };
    for (const [relative, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, relative)), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(join(dir, relative), text, { mode: 0o600 });
    }
    const tab = await browser.newPage();
    opened.push(tab);
    await tab.setContent(
      '<!doctype html><title>Lab cart</title><p id="total">16.25</p>',
    );
    const cdp = await tab.context().newCDPSession(tab);
    // The evaluate route's own reading of a body and its own evaluation, on
    // this tab: an expression runs in repl mode, a function with its argument
    // does not.
    const sent = [];
    const session = new Session({
      env: { KAMAPATHY_WORKSPACE: home },
      health: { status: "ok", version: "0.2.0", apiLevel: 4 },
      fetch: async (url, init) => {
        const { timeoutMs, ...body } = JSON.parse(init.body);
        sent.push({ path: url.pathname, body });
        try {
          const result = await evaluateScript(
            { send: (method, params) => cdp.send(method, params) },
            scriptFields(body),
            {
              deadline: Date.now() + timeoutMs,
              timeoutMs,
              replMode: true,
              dispatch: { dispatched: false },
            },
          );
          return Response.json({
            ok: true,
            tab: { id: "tab-1", url: tab.url(), title: await tab.title() },
            ...result,
          });
        } catch (failure) {
          const { status, error } = envelope(failure, false);
          return Response.json({ ok: false, error }, { status });
        }
      },
    });
    try {
      const client = await connect({ session });
      const page = new Page(session, {
        id: "tab-1",
        spaceId: "space-1",
        url: tab.url(),
        title: "Lab cart",
      });

      // The tool's promise is awaited, so its value comes back rather than
      // the empty object a promise reads as in repl mode.
      expect(
        await client.runPageTool("lab", "slow_total", { add: 1 }, { page }),
      ).toBe(17.25);
      expect(sent).toEqual([
        {
          path: "/tabs/tab-1/evaluate",
          body: {
            function: `${files["page-tools/slow-total.js"]}\n`,
            arg: { add: 1 },
          },
        },
      ]);

      // A failure on line 1 is placed where the file has it: V8 puts a failed
      // property read at the property's name.
      const failed = await client
        .runPageTool("lab", "missing_box", undefined, { page })
        .catch((error) => error);
      const source = files["page-tools/missing-box.js"];
      expect(failed).toMatchObject({
        code: "script_error",
        packId: "lab",
        tool: "missing_box",
        line: 1,
        column: source.indexOf("size") + 1,
      });
      expect(sent.at(-1).body).toEqual({ function: `${source}\n`, arg: {} });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 60000);
});
