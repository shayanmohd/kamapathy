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

const executable = chromium.executablePath();
const browserAvailable = !!executable && existsSync(executable);
const script = `(${pageState.toString()})`;

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
});
