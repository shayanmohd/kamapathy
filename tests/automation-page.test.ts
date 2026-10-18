// Runs the page script inside Playwright's Chromium, where shadow roots,
// frames and layout behave as they do in Kamapathy's tabs. These tests skip
// when Playwright's browser is not installed.
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Level, Mode } from "../electron/agent/dom/select";
import { parseSelector } from "../electron/agent/selectors";
import { PAGE_SOURCE } from "../electron/agent/session/operations";
import type { PageOperation } from "../electron/automation-dom";
import { framePages } from "./fixtures/frame-pages.mjs";

const executable = chromium.executablePath();
const browserAvailable = !!executable && existsSync(executable);
const script = `(${PAGE_SOURCE})`;

// A target as the main process sends it: the selector as data beside the
// query the resolver built from it.
const selectorTarget = (
  selector: string,
  level: Level,
  mode: Mode = "strict",
  firstRef = 900000,
) => {
  const parsed = parseSelector(selector);
  if (!parsed.ok) throw new Error(parsed.problem.message);
  if (parsed.ast.kind === "ref") throw new Error(`${selector} is a ref.`);
  return { selector, query: { ast: parsed.ast, level, mode, firstRef } };
};

describe.skipIf(!browserAvailable)("page script in Chromium", () => {
  let site: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    site = createServer((request, response) => {
      const html = framePages[new URL(request.url || "/", "http://x").pathname];
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
    await page.goto(origin + path);
    await page.waitForLoadState("networkidle");
  };
  const operate = (
    operation: PageOperation,
    payload: Record<string, unknown> = {},
    namespace = "test",
  ): Promise<any> =>
    page.evaluate(
      ([script, operation, payload, namespace]) =>
        (0, eval)(script)(operation, payload, namespace),
      [script, operation, payload, namespace] as const,
    );
  // frameIndex takes the frame element itself, which cannot travel as JSON.
  const frameIndex = async (
    find: () => Element | null | undefined,
    namespace = "test",
  ): Promise<any> =>
    page.evaluate(
      ([script, element, namespace]) =>
        (0, eval)(script)("frameIndex", { element }, namespace),
      [script, await page.evaluateHandle(find), namespace] as const,
    );
  // The frame /frames/shadow-frame hosts in a shadow root.
  const shadowFrame = () =>
    document.getElementById("widget")!.shadowRoot!.getElementById("embedded");
  const snapshot = () =>
    operate("snapshot", {
      mode: "full",
      maxChars: 24000,
      maxControls: 100,
      firstRef: 1,
    });
  const byLabel = (listing: any, label: string) =>
    listing.interactables.find((control: any) => control.label === label);
  const frameAt = (path: string) =>
    page.frames().find((frame) => frame.url().endsWith(path))!;

  it("counts native input inside a frame hosted by a shadow root", async () => {
    await open("/frames/shadow-frame");
    const listing = await snapshot();
    const count = byLabel(listing, "Count clicks");
    expect(count.frame).toBe("0");
    const armed = await operate("input");
    const point = await operate("target", { ref: count.ref });
    expect(point.ok).toBe(true);
    await page.mouse.click(point.x, point.y);
    const received = await operate("input");
    expect(received.mouse).toBe(armed.mouse + 1);
    expect(await frameAt("/frames/embedded").evaluate(() => (window as any).clicks)).toBe(1);
    const word = byLabel(listing, "Embedded word");
    expect((await operate("focus", { ref: word.ref })).ok).toBe(true);
    await page.keyboard.press("Enter");
    expect((await operate("input")).key).toBe(received.key + 1);
    expect((await snapshot()).text).toMatch(/Entered/);
  }, 20000);

  it("scrolls the frame around a target instead of the page", async () => {
    await open("/frames/scroller");
    const first = byLabel(await snapshot(), "First item");
    expect(first.frame).toBe("0");
    const result = await operate("scroll", {
      direction: "down",
      pixels: 600,
      ref: first.ref,
    });
    expect(result).toMatchObject({
      ok: true,
      scrolled: "page",
      x: 0,
      y: 600,
      moved: true,
    });
    expect(await frameAt("/frames/tall").evaluate(() => scrollY)).toBe(600);
    expect(await page.evaluate(() => scrollY)).toBe(0);
  }, 20000);

  it("lands clicks inside frames drawn at another scale", async () => {
    await open("/frames/scaled");
    const listing = await snapshot();
    for (const [frame, title] of [
      ["0", "Scaled grid"],
      ["1", "Zoomed grid"],
    ]) {
      const control = listing.interactables.find(
        (control: any) => control.label === "Target" && control.frame === frame,
      );
      const point = await operate("target", { ref: control.ref });
      expect(point.ok).toBe(true);
      await page.mouse.click(point.x, point.y);
      const text = (await snapshot()).text;
      expect(text).toContain(`${title} hit Target`);
      expect(text).not.toContain("hit Decoy");
    }
  }, 20000);

  it("resolves a selector in the top document before the frames", async () => {
    await open("/frames/twins");
    const saves = (await snapshot()).interactables.filter(
      (control: any) => control.label === "Save",
    );
    expect(saves.map((control: any) => control.frame)).toEqual([undefined, "0"]);
    expect(saves[0].selector).toBe("#save");
    expect(saves[1].selector).not.toBe("#save");
    const pick = (selector: string) =>
      operate("target", selectorTarget(selector, "pointer-enabled"));
    const outer = await pick("#save");
    expect(outer.ok).toBe(true);
    await page.mouse.click(outer.x, outer.y);
    expect(
      await page.evaluate(() => document.getElementById("twin-result")!.textContent),
    ).toBe("Outer saved");
    // One match in the top document wins over two inside the frame.
    expect(await pick("button")).toMatchObject({
      ok: true,
      x: outer.x,
      y: outer.y,
    });
    const inner = await pick("#other");
    expect(inner.ok).toBe(true);
    await page.mouse.click(inner.x, inner.y);
    expect(
      await frameAt("/frames/twin").evaluate(
        () => document.getElementById("other")!.textContent,
      ),
    ).toBe("Other saved");
    const ambiguous = await pick(".twin");
    expect(ambiguous).toMatchObject({
      ok: false,
      code: "ambiguous_match",
    });
    expect(ambiguous.fields.count).toBe(2);
    expect(ambiguous.fields.candidates).toHaveLength(2);
  }, 20000);

  it("leaves out frames and shadow trees hidden by CSS visibility", async () => {
    await open("/frames/hidden");
    const before = await snapshot();
    expect(before.text).toContain("Shown around the frames");
    expect(before.text).not.toContain("Twin text");
    expect(before.text).not.toContain("Veiled text");
    expect(before.interactables).toEqual([]);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll<HTMLElement>(
        "#hidden,#collapsed,#veiled",
      ))
        element.style.visibility = "visible";
    });
    const after = await snapshot();
    expect(after.text).toContain("Twin text");
    expect(after.text).toContain("Veiled text");
    expect(after.interactables.map((control: any) => control.label)).toEqual([
      "Save",
      "Other",
      "Save",
      "Other",
      "Veiled button",
    ]);
  }, 20000);

  it("ready returns the document's readyState", async () => {
    await open("/frames/outer");
    expect(await operate("ready", {}, "internal")).toEqual({
      ok: true,
      readyState: "complete",
    });
  }, 20000);

  it("frameIndex returns the index snapshots print for a frame inside a shadow root", async () => {
    await open("/frames/shadow-frame");
    const count = byLabel(await snapshot(), "Count clicks");
    expect(count.frame).toBe("0");
    expect(await frameIndex(shadowFrame)).toEqual({ ok: true, path: "0" });
    // A frame inside a frame is counted from this world's document.
    await page.goto(origin + "/frames/outer");
    await page.waitForLoadState("networkidle");
    expect(byLabel(await snapshot(), "Deep button").frame).toBe("0/0");
    expect(
      await frameIndex(() =>
        document
          .querySelector<HTMLIFrameElement>("#inner")!
          .contentDocument!.getElementById("nested"),
      ),
    ).toEqual({ ok: true, path: "0/0" });
    expect(await frameIndex(() => document.body)).toMatchObject({ ok: false });
  }, 20000);

  it("ready and frameIndex leave refs from a snapshot under another namespace valid", async () => {
    await open("/frames/shadow-frame");
    const count = byLabel(await snapshot(), "Count clicks");
    expect(await operate("ready", {}, "internal")).toMatchObject({ ok: true });
    expect(await frameIndex(shadowFrame, "internal")).toEqual({
      ok: true,
      path: "0",
    });
    expect(await operate("target", { ref: count.ref })).toMatchObject({
      ok: true,
    });
  }, 20000);
});
