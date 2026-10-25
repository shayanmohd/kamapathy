// Runs the page-state reads inside Playwright's Chromium, where layout and the
// navigation timing entry behave as they do in Kamapathy's tabs. These tests
// skip when Playwright's browser is not installed.
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  pageState,
  type PageStateOperation,
} from "../electron/agent/dom/page-state";
import type { WaitState } from "../electron/agent/dom/select";
import { waitMode } from "../electron/agent/resolve";
import { parseSelector } from "../electron/agent/selectors";
import { PAGE_SOURCE } from "../electron/agent/session/operations";

const executable = chromium.executablePath();
const browserAvailable = !!executable && existsSync(executable);
const script = `(${pageState.toString()})`;
// A selector wait reads the page through the operation script, so its counts
// come from the engine the actions resolve through.
const pageScript = `(${PAGE_SOURCE})`;

// Two pages of their own: the navigation fixtures the end-to-end suite serves
// arrive with that suite.
const PAGES: Record<string, string> = {
  "/tall": `<!doctype html><html><head><title>Tall</title></head>
<body style="margin:0"><div style="height:5400px">Tall page</div></body></html>`,
  // Probes itself from a blocking DOMContentLoaded handler and from a load
  // handler, since neither moment can be read from outside the page.
  "/ready": `<!doctype html><html><head><title>Ready</title><script>
window.probes = {};
document.addEventListener("DOMContentLoaded", () => {
  const until = Date.now() + 50;
  while (Date.now() < until);
  window.probes.duringDomContentLoaded = window.probe("loadProbe");
});
addEventListener("load", () => {
  window.probes.duringLoad = window.probe("loadProbe");
});
</script></head><body>Ready page</body></html>`,
  // Three elements one selector matches, of which one is on the screen, plus
  // the matches a selector wait has to judge on their own.
  "/duplicates": `<!doctype html><html><head><title>Duplicates</title><style>
.unseen { visibility: hidden }
.gone { display: none }
</style></head><body>
<p class="pick">Pick me</p>
<p class="pick unseen">Pick me</p>
<p class="pick gone">Pick me</p>
<input class="ghost" type="checkbox" style="opacity:0">
<div aria-hidden="true"><p class="quiet">Quiet words</p></div>
<details><summary>More</summary><p class="folded">Folded words</p></details>
<button id="go">Go</button>
</body></html>`,
};

describe.skipIf(!browserAvailable)("page state in Chromium", () => {
  let site: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    site = createServer((request, response) => {
      const html = PAGES[new URL(request.url || "/", "http://x").pathname];
      response.writeHead(html ? 200 : 404, { "Content-Type": "text/html" });
      response.end(html || "");
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60000);
  afterEach(async () => {
    await page?.close();
  });
  afterAll(async () => {
    await browser?.close();
    site?.close();
  });
  const open = async (path: string) => {
    page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    // The page's own handlers read the same function the session sends.
    await page.addInitScript({
      content: `window.probe = (0, eval)(${JSON.stringify(script)});`,
    });
    await page.goto(origin + path);
    await page.waitForLoadState("networkidle");
  };
  const operate = (operation: PageStateOperation): Promise<any> =>
    page.evaluate(([script, operation]) => (0, eval)(script)(operation), [
      script,
      operation,
    ] as const);
  // One check of a selector wait, as the route sends it: the parsed selector
  // beside the state, with the mode and level the state asks for.
  const check = (payload: Record<string, unknown>): Promise<any> =>
    page.evaluate(
      ([script, payload]) => (0, eval)(script)("check", payload, "waits"),
      [pageScript, payload] as const,
    );
  const forSelector = (selector: string, state: WaitState) => {
    const parsed = parseSelector(selector);
    if (!parsed.ok) throw new Error(parsed.problem.message);
    if (parsed.ast.kind === "ref") throw new Error(`${selector} is a ref.`);
    const mode = waitMode(parsed.ast, state);
    return {
      selector,
      query: {
        ast: parsed.ast,
        state,
        ...mode,
        ...(mode.mode === "strict" ? { firstRef: 900000 } : {}),
      },
    };
  };
  const counts = async (selector: string, state: WaitState = "visible") => {
    const result = await check(forSelector(selector, state));
    expect(result.ok, `${selector} ${state}`).toBe(true);
    return result.counts;
  };
  const met = async (selector: string, state: WaitState) => {
    const result = await check(forSelector(selector, state));
    expect(result.ok, `${selector} ${state}`).toBe(true);
    return result.matched;
  };
  const listing = (): Promise<any> =>
    page.evaluate(
      ([script, options]) => (0, eval)(script)("snapshot", options, "waits"),
      [
        pageScript,
        { mode: "full", maxChars: 24000, maxControls: 100, firstRef: 1 },
      ] as const,
    );

  it("info reports the viewport, scroll offsets and document size in CSS pixels", async () => {
    await open("/tall");
    await page.evaluate(() => scrollTo(0, 640));
    const size = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    expect(size.height).toBeGreaterThanOrEqual(5400);
    expect(await operate("info")).toEqual({
      ok: true,
      viewport: { width: 900, height: 700 },
      scroll: { x: 0, y: 640 },
      document: size,
      readyState: "complete",
    });
  }, 20000);

  it("loadProbe tells interactive apart from DOMContentLoaded finished", async () => {
    await open("/ready");
    const probes = await page.evaluate(() => (window as any).probes);
    expect(probes.duringDomContentLoaded).toEqual({
      ok: true,
      readyState: "interactive",
      domContentLoaded: false,
      load: false,
    });
    // The load event has started but not ended inside its own handler.
    expect(probes.duringLoad).toEqual({
      ok: true,
      readyState: "complete",
      domContentLoaded: true,
      load: false,
    });
    expect(await operate("loadProbe")).toEqual({
      ok: true,
      readyState: "complete",
      domContentLoaded: true,
      load: true,
    });
  }, 20000);

  it("selector counts tell a hidden duplicate from a visible match", async () => {
    await open("/duplicates");
    // Three matches, of which the hidden and the undrawn one are not on the
    // screen, so a wait for a visible match has one.
    expect(await counts(".pick")).toEqual({ matched: 3, visible: 1 });
    // A control a page draws its own box for stays on top at opacity 0,
    // where it still takes the click, so it counts as visible.
    expect(await counts(".ghost")).toEqual({ matched: 1, visible: 1 });
    // aria-hidden takes text from assistive technology, not from the screen,
    // so a wait and an action agree that it is visible.
    expect(await counts(".quiet")).toEqual({ matched: 1, visible: 1 });
    // A closed details element shows nothing but its summary.
    expect(await counts(".folded")).toEqual({ matched: 1, visible: 0 });
    expect(await counts(".missing")).toEqual({ matched: 0, visible: 0 });
  }, 20000);

  it("a state check follows its state", async () => {
    await open("/duplicates");
    // attached takes any match, visible only one the page draws.
    expect(await met(".unseen", "attached")).toBe(true);
    expect(await met(".unseen", "visible")).toBe(false);
    expect(await met(".pick", "visible")).toBe(true);
    // A hidden duplicate never blocks a visible match of raw CSS.
    expect(await met(".pick", "attached")).toBe(true);
    // hidden and detached cover every match.
    expect(await met(".pick", "hidden")).toBe(false);
    expect(await met(".unseen", "hidden")).toBe(true);
    expect(await met(".folded", "hidden")).toBe(true);
    expect(await met(".pick", "detached")).toBe(false);
    expect(await met(".unseen", "detached")).toBe(false);
    expect(await met(".missing", "detached")).toBe(true);
    expect(await met(".missing", "attached")).toBe(false);
    expect(await met(".missing", "hidden")).toBe(true);
  }, 20000);

  it("a ref whose element is gone is hidden and detached", async () => {
    await open("/duplicates");
    const control = (await listing()).interactables.find(
      (item: any) => item.label === "Go",
    );
    expect(control.ref).toBeDefined();
    const ref = control.ref as string;
    expect(await check({ ref, state: "visible" })).toEqual({
      ok: true,
      matched: true,
      counts: { matched: 1, visible: 1 },
    });
    await page.evaluate(() => document.getElementById("go")!.remove());
    for (const state of ["hidden", "detached"] as const)
      expect(await check({ ref, state }), state).toEqual({
        ok: true,
        matched: true,
        counts: { matched: 0, visible: 0 },
      });
    for (const state of ["attached", "visible"] as const)
      expect(await check({ ref, state }), state).toMatchObject({
        ok: false,
        code: "stale_ref",
      });
  }, 20000);
});
