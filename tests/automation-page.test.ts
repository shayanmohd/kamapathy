// Runs the page script inside Playwright's Chromium, where shadow roots,
// frames and layout behave as they do in Kamapathy's tabs. These tests skip
// when Playwright's browser is not installed.
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DIALOG_DRAIN_SOURCE,
  dialogHandlerSource,
  dialogQueueSource,
} from "../electron/agent/dom/dialog-handler";
import { FILES_SOURCE } from "../electron/agent/dom/files";
import { pdfDocument, readBlobPdf } from "../electron/agent/dom/pdf";
import type { Level, Mode } from "../electron/agent/dom/select";
import { COUNTER_SOURCE } from "../electron/agent/input/counters";
import { parseSelector } from "../electron/agent/selectors";
import {
  FRAME_OWNER_SOURCE,
  PAGE_SOURCE,
} from "../electron/agent/session/operations";
import type { PageOperation } from "../electron/automation-dom";
import { framePages } from "./fixtures/frame-pages.mjs";

const executable = chromium.executablePath();
const browserAvailable = !!executable && existsSync(executable);
const script = `(${PAGE_SOURCE})`;
const documentScript = `(${pdfDocument.toString()})`;
const blobScript = `(${readBlobPdf.toString()})`;

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
  let sibling: Server;
  let origin: string;
  let siblingOrigin: string;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    const serve = (request: any, response: any) => {
      const path = new URL(request.url || "/", "http://x").pathname;
      if (path === "/plain") {
        response.writeHead(200, { "Content-Type": "text/plain" });
        return response.end("Plain words, not markup.");
      }
      const html = framePages[path];
      response.writeHead(html ? 200 : 404, { "Content-Type": "text/html" });
      response.end(html || "");
    };
    site = createServer(serve);
    // The same pages on a second port: a frame from there is cross-origin but
    // same-site, which Chromium keeps in the page's own process.
    sibling = createServer(serve);
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    await new Promise<void>((done) => sibling.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    siblingOrigin = `http://127.0.0.1:${(sibling.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60000);
  afterEach(async () => {
    await page?.close();
  });
  afterAll(async () => {
    await browser?.close();
    site?.close();
    sibling?.close();
  }, 60000);
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
  const snapshot = (extra: Record<string, unknown> = {}) =>
    operate("snapshot", {
      mode: "full",
      maxChars: 24000,
      maxControls: 100,
      firstRef: 1,
      ...extra,
    });
  // bindFrameOwner runs with the owner element as `this`, as the main process
  // calls it through Runtime.callFunctionOn.
  const bindOwner = async (
    key: string,
    find: () => Element | null | undefined,
  ): Promise<any> =>
    page.evaluate(
      ([source, element, key]) =>
        (0, eval)(source).call(element as Element, key),
      [FRAME_OWNER_SOURCE, await page.evaluateHandle(find), key] as const,
    );
  const byLabel = (listing: any, label: string) =>
    listing.interactables.find((control: any) => control.label === label);
  // A read given a frame context reports this document's own parts, which
  // the main process composes with the frames inside it.
  const entries = (listing: any) =>
    listing.controls.map((control: any) => control.entry);
  const partText = (listing: any) =>
    listing.text.map((part: any) => part.value).join("");
  const partOutline = (listing: any) =>
    listing.outline.map((item: any) => item.line).join("\n");
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

  // Chromium fires no mousedown for a press on a control that cancels its
  // pointerdown or is disabled, and no pointerdown for a press while
  // another button is held. Section 1's init script and the input
  // operation's own listeners, for a document the script missed, count
  // each press once all the same.
  const PRESS_PAGE = `<style>button{position:absolute;left:20px;width:100px;height:40px}</style>
<button type="button" id="cancel" style="top:20px">Cancel</button>
<button type="button" id="plain" style="top:80px">Plain</button>
<button type="button" id="off" style="top:140px" disabled>Off</button>
<script>
document.getElementById("cancel").addEventListener("pointerdown", (event) => event.preventDefault());
</script>`;
  const centreOf = (id: string) =>
    page.evaluate((key) => {
      const box = document.getElementById(key)!.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }, id);

  it("counts each press once, whatever the page cancels", async () => {
    for (const installed of [true, false]) {
      await page?.close();
      page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      await page.setContent(PRESS_PAGE);
      if (installed) await page.evaluate(`(() => {${COUNTER_SOURCE}})()`);
      const counted = async (gesture: () => Promise<void>) => {
        const before = (await operate("input")).mouse;
        await gesture();
        return (await operate("input")).mouse - before;
      };
      for (const id of ["plain", "cancel", "off"]) {
        const { x, y } = await centreOf(id);
        expect(
          await counted(() => page.mouse.click(x, y)),
          `${id}, counters installed: ${installed}`,
        ).toBe(1);
      }
      // A right press while the left is held, after a left press the page
      // let through and after one it cancelled.
      for (const id of ["plain", "cancel"]) {
        const { x, y } = await centreOf(id);
        await page.mouse.move(x, y);
        expect(
          await counted(async () => {
            await page.mouse.down();
            await page.mouse.down({ button: "right" });
            await page.mouse.up({ button: "right" });
            await page.mouse.up();
          }),
          `${id} chord, counters installed: ${installed}`,
        ).toBe(2);
      }
    }
  }, 20000);

  it("counts no input the page dispatches itself", async () => {
    for (const installed of [true, false]) {
      await page?.close();
      page = await browser.newPage({ viewport: { width: 900, height: 700 } });
      await page.setContent(PRESS_PAGE);
      if (installed) await page.evaluate(`(() => {${COUNTER_SOURCE}})()`);
      const { x, y } = await centreOf("plain");
      await operate("input");
      await page.mouse.move(x, y);
      const before = await operate("input");
      expect(before.landing, `counters installed: ${installed}`).toBeDefined();
      // A page can raise every event the counters listen to, a press and a
      // move at a point of its own choosing among them.
      await page.evaluate(() => {
        for (const event of [
          new PointerEvent("pointerdown", { button: 0, buttons: 1 }),
          new PointerEvent("pointermove", {
            clientX: 300,
            clientY: 200,
            button: 2,
            buttons: 3,
          }),
          new KeyboardEvent("keydown", { key: "a" }),
          new DragEvent("dragstart"),
        ])
          dispatchEvent(event);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        await operate("input"),
        `counters installed: ${installed}`,
      ).toEqual(before);
    }
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

  it("frameBox and activeFrame leave refs from a snapshot under another namespace valid", async () => {
    await open("/frames/outer");
    const file = byLabel(await snapshot(), "Frame file");
    expect(file.frame).toBe("0");
    await bindOwner("f-other", () => document.getElementById("other"));
    // A click inside a frame measures its owner, and a key press looks for
    // the frame holding the focus, both as Kamapathy's own reads.
    expect(
      await operate("frameBox", { key: "f-other" }, "internal"),
    ).toMatchObject({ ok: true });
    expect(await operate("activeFrame", {}, "internal")).toMatchObject({
      ok: true,
    });
    // A file input is never re-bound, so only the ref the snapshot gave out
    // can take the files.
    expect(
      await operate("upload", {
        ref: file.ref,
        files: [{ name: "note.txt", type: "text/plain", data: "aGk=" }],
      }),
    ).toEqual({ ok: true, selected: 1 });
  }, 20000);

  // Section 9 (verify first item 2): the boundary the groups rest on. A world
  // made without universal access reads no frame from another origin, whether
  // Chromium runs it in this process or its own.
  it("reads no frame from another origin in a world without universal access", async () => {
    await open("/frames/outer");
    await page.evaluate(
      (src) =>
        new Promise<void>((done) => {
          const frame = document.createElement("iframe");
          frame.id = "same-site";
          frame.title = "Same site";
          frame.style.cssText = "display:block;width:300px;height:100px";
          frame.onload = () => done();
          frame.src = src;
          document.body.append(frame);
        }),
      `${siblingOrigin}/frames/other`,
    );
    const session = await page.context().newCDPSession(page);
    const { frameTree } = await session.send("Page.getFrameTree");
    const world = await session.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "kamapathy",
      grantUniveralAccess: false,
    });
    const opaque = async (id: string) => {
      const got = await session.send("Runtime.evaluate", {
        expression: `document.getElementById(${JSON.stringify(id)}).contentDocument === null`,
        contextId: world.executionContextId,
        returnByValue: true,
      });
      return got.result.value;
    };
    // Another site, and the same site on another port.
    expect(await opaque("other")).toBe(true);
    expect(await opaque("same-site")).toBe(true);
    // This origin's own frame stays readable in that world.
    expect(await opaque("inner")).toBe(false);
  }, 20000);

  it("leaves a bound placeholder at a cross-origin owner and reads nothing inside", async () => {
    await open("/frames/outer");
    expect(
      await bindOwner("f-other", () => document.getElementById("other")),
    ).toEqual({ local: "1", readable: false });
    const listing = await snapshot({ frameContext: { group: "", tier: 0 } });
    expect(listing.group).toBe("");
    const entry = entries(listing).find(
      (control: any) => control.label === "Card details",
    );
    expect(entry).toMatchObject({
      role: "iframe",
      crossOrigin: true,
      key: "f-other",
      contentFrame: "1",
    });
    // The entry sits in the top document, so it carries no frame path.
    expect(entry.frame).toBeUndefined();
    // Nothing of the frame's own document is read in this world.
    expect(partText(listing)).not.toContain("Card number");
    expect(
      entries(listing).some((control: any) => control.label === "Card number"),
    ).toBe(false);
    // One placeholder, where the walk met the owner, with the frame's own path.
    expect(listing.placeholders).toHaveLength(1);
    expect(listing.placeholders[0]).toMatchObject({
      key: "f-other",
      local: "1",
      readable: false,
    });
    // The walk met the heading, the text and the first frame before it.
    expect(listing.placeholders[0].order).toBeGreaterThan(0);
    // The border box of a frame 420 wide and 80 tall with 6 of padding and a
    // 4 border, at the body's margin.
    expect(listing.placeholders[0].box).toEqual({
      left: 16,
      top: expect.any(Number),
      right: 456,
      bottom: expect.any(Number),
    });
    expect(
      listing.placeholders[0].box.bottom - listing.placeholders[0].box.top,
    ).toBe(100);
    expect(typeof listing.placeholders[0].tier).toBe("number");
  }, 20000);

  it("frameBox gives the origin, scale and area of a padded, scaled owner", async () => {
    await open("/frames/scaled");
    await bindOwner("f-scaled", () => document.getElementById("scaled"));
    const got = await operate("frameBox", { key: "f-scaled" });
    expect(got.ok).toBe(true);
    // A 400 by 200 frame with 6 of padding and a 4 border, drawn at half size:
    // the content box starts 10 in, halved, and shows 400 by 200 of document.
    expect(got.box).toEqual({
      x: 5,
      y: 5,
      scaleX: 0.5,
      scaleY: 0.5,
      width: 400,
      height: 200,
    });
    expect(got.area).toEqual({ left: 5, top: 5, right: 205, bottom: 105 });
    // The middle of the Target button in the frame's own pixels, in the page's.
    const point = await operate("frameBox", {
      key: "f-scaled",
      point: { x: 150, y: 60 },
    });
    expect(point.point).toEqual({ x: 80, y: 35 });
    expect(point.covered).toBeUndefined();
    await page.mouse.click(point.point.x, point.point.y);
    expect((await snapshot()).text).toContain("Scaled grid hit Target");
    expect(await operate("frameBox", { key: "gone" })).toMatchObject({
      ok: false,
      code: "page_changed",
    });
  }, 20000);

  it("frameBox translates a point and names an overlay over the owner", async () => {
    await open("/frames/covered");
    await bindOwner("f-pay", () => document.getElementById("pay"));
    const under = await operate("frameBox", {
      key: "f-pay",
      point: { x: 100, y: 10 },
    });
    // The frame sits 60 down, so its own point 10 is 70 in the page, under the
    // overlay the page draws over its top.
    expect(under).toMatchObject({
      ok: true,
      point: { x: 100, y: 70 },
      covered: true,
    });
    expect(under.interceptor).toMatchObject({ tag: "div", role: "div" });
    const below = await operate("frameBox", {
      key: "f-pay",
      point: { x: 100, y: 200 },
    });
    expect(below).toMatchObject({ ok: true, point: { x: 100, y: 260 } });
    expect(below.covered).toBeUndefined();
    expect(below.interceptor).toBeUndefined();
  }, 20000);

  it("the frame hit test runs again before every press", async () => {
    await open("/frames/covered");
    await bindOwner("f-pay", () => document.getElementById("pay"));
    const inner = { x: 100, y: 200 };
    const first = await operate("frameBox", { key: "f-pay", point: inner });
    expect(first).toMatchObject({ ok: true, point: { x: 100, y: 260 } });
    // The page moves the frame between the checks. The same point of the
    // frame's own document now sits somewhere else, so a press at the point
    // measured before would land beside the control: the owner is measured
    // and hit-tested again for every press, never once per action.
    await page.evaluate(() => {
      (document.getElementById("pay") as HTMLElement).style.top = "180px";
    });
    const second = await operate("frameBox", { key: "f-pay", point: inner });
    expect(second).toMatchObject({ ok: true, point: { x: 100, y: 380 } });
    expect(second.box).toMatchObject({ x: 0, y: 180 });
    // The point the first check gave is now the overlay the page draws over
    // the top of the viewport, which the second hit test names.
    const above = await operate("frameBox", {
      key: "f-pay",
      point: { x: 100, y: -120 },
    });
    expect(above).toMatchObject({ ok: true, point: { x: 100, y: 60 } });
    expect(above.covered).toBe(true);
    expect(above.interceptor).toMatchObject({ tag: "div" });
  }, 20000);

  it("leaves out a 1 by 1 cross-origin frame", async () => {
    await open("/frames/tracker");
    const context = { frameContext: { group: "", tier: 0 } };
    const listing = await snapshot(context);
    expect(
      entries(listing).find((control: any) => control.label === "Tracker"),
    ).toBeUndefined();
    expect(partText(listing)).not.toContain("Tracker");
    // The placeholders are what carries a frame's content into the page's
    // text, and a tracking pixel leaves none.
    expect(listing.placeholders.map((item: any) => item.local)).toEqual(["0"]);
    expect(
      partOutline(await snapshot({ ...context, format: "outline" })),
    ).not.toContain("Tracker");
    // The same frame at 8 by 8 is listed.
    await page.evaluate(() => {
      const pixel = document.getElementById("pixel") as HTMLElement;
      pixel.style.width = "8px";
      pixel.style.height = "8px";
    });
    const grown = await snapshot(context);
    expect(
      entries(grown).find((control: any) => control.label === "Tracker"),
    ).toMatchObject({
      role: "iframe",
      crossOrigin: true,
    });
    expect(grown.placeholders.map((item: any) => item.local)).toEqual([
      "0",
      "1",
    ]);
    expect(
      partOutline(await snapshot({ ...context, format: "outline" })),
    ).toContain("Tracker");
  }, 20000);

  it("bindFrameOwner records the owner and says whether this world can read it", async () => {
    await open("/frames/outer");
    expect(
      await bindOwner("f-inner", () => document.getElementById("inner")),
    ).toEqual({ local: "0", readable: true });
    expect(
      await bindOwner("f-other", () => document.getElementById("other")),
    ).toEqual({ local: "1", readable: false });
    // A frame inside a frame of this origin is part of the same group.
    expect(
      await bindOwner("f-nested", () =>
        document
          .querySelector<HTMLIFrameElement>("#inner")!
          .contentDocument!.getElementById("nested"),
      ),
    ).toEqual({ local: "0/0", readable: true });
    // Binding again keeps one entry per owner.
    expect(
      await bindOwner("f-inner", () => document.getElementById("inner")),
    ).toEqual({ local: "0", readable: true });
    expect(
      await page.evaluate(() => {
        const table = (globalThis as any).__kamapathyFrames;
        return [
          table.byKey.size,
          table.keyOf.get(document.getElementById("inner")),
          table.byKey.get("f-other") === document.getElementById("other"),
        ];
      }),
    ).toEqual([3, "f-inner", true]);
    // The numbering counts frames a shadow root hosts, as the walk does.
    await open("/frames/shadow-frame");
    expect(await bindOwner("f-shadow", shadowFrame)).toEqual({
      local: "0",
      readable: true,
    });
  }, 20000);

  it("activeFrame follows focus through two owners", async () => {
    await open("/frames/focus");
    expect(await operate("activeFrame")).toEqual({
      ok: true,
      path: "",
      editable: false,
    });
    await page.focus("#top-field");
    expect(await operate("activeFrame")).toEqual({
      ok: true,
      path: "",
      editable: true,
    });
    // A field inside a frame of this origin answers that document's path.
    await frameAt("/frames/embedded").locator("#word").focus();
    expect(await operate("activeFrame")).toEqual({
      ok: true,
      path: "0",
      editable: true,
    });
    // A field inside an opaque owner answers the owner by key and path.
    await bindOwner("f-cross", () => document.getElementById("cross"));
    await frameAt("/frames/checkout").locator("#card").click();
    expect(await operate("activeFrame")).toEqual({
      ok: true,
      path: "1",
      key: "f-cross",
      editable: false,
    });
    // A frame agents never enter answers blocked, whatever it ended up showing.
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.id = "local";
      frame.title = "Local file";
      frame.src = "file:///etc/hosts";
      document.body.append(frame);
    });
    await page.evaluate(() => document.getElementById("local")!.focus());
    expect(await operate("activeFrame")).toEqual({
      ok: true,
      path: "2",
      editable: false,
      blocked: true,
    });
  }, 20000);

  it("target accepts a bound owner key", async () => {
    await open("/frames/outer");
    await bindOwner("f-other", () => document.getElementById("other"));
    const point = await operate("target", { owner: "f-other" });
    expect(point.ok).toBe(true);
    // The middle of the owner, which lands inside the frame it shows.
    expect(point.x).toBeGreaterThan(16);
    expect(point.x).toBeLessThan(456);
    expect(await operate("target", { owner: "f-gone" })).toMatchObject({
      ok: false,
      code: "page_changed",
    });
  }, 20000);

  it("pdfDocument reports the document's content type", async () => {
    await open("/frames/outer");
    expect(
      await page.evaluate((source) => (0, eval)(source)(), documentScript),
    ).toEqual({ contentType: "text/html" });
    await open("/plain");
    expect(
      await page.evaluate((source) => (0, eval)(source)(), documentScript),
    ).toEqual({ contentType: "text/plain" });
  }, 20000);

  it("readBlobPdf returns a blob in chunks, refuses one past maxBytes and reports a revoked URL", async () => {
    await open("/frames/outer");
    const url = await page.evaluate(() =>
      URL.createObjectURL(
        new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])]),
      ),
    );
    const read = (request: Record<string, unknown>): Promise<any> =>
      page.evaluate(
        ([source, request]) => (0, eval)(source as string)(request),
        [blobScript, request] as const,
      );
    const parts = [];
    for (const offset of [0, 4, 8]) {
      const chunk = await read({ url, offset, chunkBytes: 4, maxBytes: 1024 });
      expect(chunk).toMatchObject({ ok: true, total: 10, offset });
      parts.push(Buffer.from(chunk.data, "base64"));
    }
    expect([...Buffer.concat(parts)]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await read({ url, offset: 0, chunkBytes: 4, maxBytes: 8 })).toEqual({
      ok: false,
      reason: "too_large",
      total: 10,
    });
    await page.evaluate((url) => URL.revokeObjectURL(url), url);
    expect(
      await read({ url, offset: 0, chunkBytes: 4, maxBytes: 1024 }),
    ).toEqual({ ok: false, reason: "fetch_failed" });
  }, 20000);

  // Section 7's dialog handler, installed in the page the way an init script
  // installs it, with a stand-in for the CDP binding it reports through.
  const BINDING = "__kamapathyReports";
  const EVENT = "kamapathy-dialog-test";
  const installDialogs = async (
    options: {
      mode?: "agent" | "person";
      policy?: { accept: boolean; promptText?: string } | null;
      key?: string;
      binding?: string;
      event?: string;
    } = {},
  ) => {
    await page.evaluate((binding) => {
      const scope = globalThis as unknown as Record<string, unknown>;
      scope.__reports = scope.__reports ?? [];
      scope[binding] = (text: string) => {
        (scope.__reports as string[]).push(text);
      };
    }, BINDING);
    await page.evaluate(
      dialogHandlerSource({
        binding: options.binding ?? BINDING,
        key: options.key ?? "__kamapathyUpdate",
        mode: options.mode ?? "agent",
        policy: options.policy ?? null,
        ...(options.event === undefined ? {} : { event: options.event }),
      }),
    );
  };
  const dialogReports = () =>
    page.evaluate(() =>
      ((globalThis as unknown as { __reports: string[] }).__reports ?? []).map(
        (text) => JSON.parse(text) as Record<string, unknown>,
      ),
    );

  it("handler answers from the policy and reports", async () => {
    await open("/frames/other");
    await installDialogs();
    // Dismissing is the default: confirm is false and prompt is null.
    expect(
      await page.evaluate(() => [
        window.confirm("Delete this file?"),
        window.prompt("Your name?", "preset"),
      ]),
    ).toEqual([false, null]);
    // A second install finds the updater and changes the policy in place.
    await installDialogs({ policy: { accept: true, promptText: "Ada" } });
    expect(
      await page.evaluate(() => [
        window.confirm("Delete this file?"),
        window.prompt("Your name?", "preset"),
      ]),
    ).toEqual([true, "Ada"]);
    // An accepted prompt without text returns the default value.
    await installDialogs({ policy: { accept: true } });
    expect(
      await page.evaluate(() => [
        window.prompt("Your name?", "preset"),
        window.prompt("Your name?"),
      ]),
    ).toEqual(["preset", ""]);
    const seen = await dialogReports();
    expect(seen).toEqual([
      {
        type: "confirm",
        message: "Delete this file?",
        answer: "dismissed",
        url: page.url(),
      },
      {
        type: "prompt",
        message: "Your name?",
        defaultValue: "preset",
        answer: "dismissed",
        url: page.url(),
      },
      {
        type: "confirm",
        message: "Delete this file?",
        answer: "accepted",
        url: page.url(),
      },
      {
        type: "prompt",
        message: "Your name?",
        defaultValue: "preset",
        answer: "accepted",
        promptText: "Ada",
        url: page.url(),
      },
      {
        type: "prompt",
        message: "Your name?",
        defaultValue: "preset",
        answer: "accepted",
        promptText: "preset",
        url: page.url(),
      },
      {
        type: "prompt",
        message: "Your name?",
        answer: "accepted",
        promptText: "",
        url: page.url(),
      },
    ]);
  }, 20000);

  it("alerts keep the arm", async () => {
    await open("/frames/other");
    await installDialogs({ policy: { accept: true } });
    expect(
      await page.evaluate(() => [
        window.alert("Saved"),
        window.confirm("Delete this file?"),
        window.confirm("And this one?"),
      ]),
    ).toEqual([undefined, true, true]);
    expect(
      (await dialogReports()).map((report) => [report.type, report.answer]),
    ).toEqual([
      ["alert", "accepted"],
      ["confirm", "accepted"],
      ["confirm", "accepted"],
    ]);
  }, 20000);

  it("native mode shows real dialogs", async () => {
    await open("/frames/other");
    const native: string[] = [];
    page.on("dialog", async (dialog) => {
      native.push(`${dialog.type()} ${dialog.message()}`);
      await dialog.dismiss();
    });
    await installDialogs();
    expect(await page.evaluate(() => window.confirm("Agent answers"))).toBe(
      false,
    );
    expect(native).toEqual([]);
    // The person takes over, so the page gets its own functions back.
    await installDialogs({ mode: "person" });
    expect(await page.evaluate(() => window.confirm("You answer"))).toBe(false);
    expect(native).toEqual(["confirm You answer"]);
    expect(await dialogReports()).toHaveLength(1);
    // Handing the page back puts the handler in charge again.
    await installDialogs({ mode: "agent", policy: { accept: true } });
    expect(await page.evaluate(() => window.confirm("Agent again"))).toBe(true);
    expect(native).toHaveLength(1);
    expect(await dialogReports()).toHaveLength(2);
  }, 20000);

  it("reports through its event in a context without the binding", async () => {
    await open("/frames/other");
    // The queue a frame's isolated world keeps, installed twice as a
    // re-attach installs it.
    await page.evaluate(dialogQueueSource(EVENT));
    await page.evaluate(dialogQueueSource(EVENT));
    await installDialogs({ binding: "__absent", event: EVENT });
    expect(await page.evaluate(() => window.confirm("No binding here"))).toBe(
      false,
    );
    const drained = (await page.evaluate(DIALOG_DRAIN_SOURCE)) as string[];
    expect(drained.map((text) => JSON.parse(text))).toEqual([
      {
        type: "confirm",
        message: "No binding here",
        answer: "dismissed",
        url: page.url(),
      },
    ]);
    // Draining clears the queue, so nothing is reported twice.
    expect(await page.evaluate(DIALOG_DRAIN_SOURCE)).toEqual([]);
    expect(await dialogReports()).toEqual([]);
  }, 20000);
  // Section 7's file inputs: a page with the shapes an upload form takes,
  // from a label beside a hidden input to a panel whose input sits in a
  // shadow root.
  const FILE_PAGE = `<!doctype html>
<main>
  <label id="listing-label" for="listing-file">Choose a listing</label>
  <input id="listing-file" type="file" accept=".png,image/jpeg" style="display:none">
  <label id="note-label"><span id="note-text">Attach a note</span><input id="note-file" type="file" multiple></label>
  <div id="panel"><p>Drop files here</p><upload-widget id="widget"></upload-widget></div>
  <div id="two"><input type="file"><input type="file"></div>
  <div id="empty"><button type="button">Upload</button></div>
  <div id="off"><input type="file" disabled></div>
  <div id="folder"><input type="file" webkitdirectory></div>
  <div id="inert" inert><input type="file"></div>
  <fieldset id="locked" disabled><input type="file"></fieldset>
</main>
<script>
  document.getElementById("widget").attachShadow({ mode: "open" }).innerHTML =
    '<input type="file">';
  globalThis.seen = [];
  const note = document.getElementById("note-file");
  for (const type of ["input", "change"])
    note.addEventListener(type, (event) => {
      globalThis.seen.push(type + " " + note.files.length + " " + event.bubbles);
    });
</script>`;
  const openHtml = async (html: string) => {
    page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(html);
  };
  // A file as the client sends one.
  const file = (name: string, type: string, text: string) => ({
    name,
    type,
    data: Buffer.from(text).toString("base64"),
  });
  // The numbers the main process reserves for the input a retarget picks.
  let nextFileRef = 500;
  const retarget = (target: Record<string, unknown>): Promise<any> =>
    operate("retargetFile", { ...target, firstRef: (nextFileRef += 1) });
  // The apply runs on its own, the way the chooser path runs it.
  const fileScript = `(${FILES_SOURCE})`;
  const applyFiles = (
    ref: string,
    files: { name: string; type: string; data: string }[],
    namespace = "test",
  ): Promise<any> =>
    page.evaluate(
      ([script, payload, namespace]) =>
        (0, eval)(script as string)("applyFiles", payload, namespace),
      [fileScript, { ref, files }, namespace] as const,
    );
  const names = (selector: string) =>
    page.evaluate(
      (selector) =>
        Array.from(
          document.querySelector<HTMLInputElement>(selector)!.files ?? [],
        ).map((item) => item.name),
      selector,
    );

  it("setInputFiles retargets from labels and containers", async () => {
    await openHtml(FILE_PAGE);
    const png = file("listing.png", "image/png", "pixels");
    // A label names the hidden input a person would click it for.
    const labelled = await retarget(selectorTarget("#listing-label", "none"));
    expect(labelled).toMatchObject({ ok: true });
    expect(await applyFiles(labelled.ref, [png])).toEqual({
      ok: true,
      selected: 1,
    });
    expect(await names("#listing-file")).toEqual(["listing.png"]);
    // Text inside a label that wraps its own input.
    const inside = await retarget(selectorTarget("#note-text", "none"));
    expect(
      await applyFiles(inside.ref, [file("note.txt", "text/plain", "hello")]),
    ).toEqual({ ok: true, selected: 1 });
    expect(await names("#note-file")).toEqual(["note.txt"]);
    // A panel whose one file input sits in an open shadow root.
    const panel = await retarget(selectorTarget("#panel", "none"));
    expect(await applyFiles(panel.ref, [png])).toEqual({
      ok: true,
      selected: 1,
    });
    expect(
      await page.evaluate(() =>
        Array.from(
          document
            .getElementById("widget")!
            .shadowRoot!.querySelector<HTMLInputElement>("input")!.files ?? [],
        ).map((item) => item.name),
      ),
    ).toEqual(["listing.png"]);
    // The input itself keeps the ref it already holds.
    expect(await retarget(selectorTarget("#note-file", "none"))).toEqual({
      ok: true,
      ref: inside.ref,
    });
    // A selector may name the hidden input itself.
    expect(await retarget(selectorTarget("#listing-file", "none"))).toEqual({
      ok: true,
      ref: labelled.ref,
    });
  }, 20000);

  it("refuses several, disabled, directory and inert inputs; [] clears", async () => {
    await openHtml(FILE_PAGE);
    expect(await retarget(selectorTarget("#two", "none"))).toMatchObject({
      ok: false,
      code: "multiple_file_inputs",
      fields: { count: 2 },
    });
    expect(await retarget(selectorTarget("#empty", "none"))).toMatchObject({
      ok: false,
      code: "invalid_upload_target",
    });
    for (const selector of ["#off", "#folder", "#inert", "#locked"])
      expect(
        await retarget(selectorTarget(selector, "none")),
        selector,
      ).toMatchObject({ ok: false, code: "invalid_upload_target" });
    const listing = await retarget(selectorTarget("#listing-label", "none"));
    const png = file("listing.png", "image/png", "pixels");
    // One file unless the input takes many, and only the types it accepts.
    expect(await applyFiles(listing.ref, [png, png])).toMatchObject({
      ok: false,
      code: "invalid_files",
    });
    expect(
      await applyFiles(listing.ref, [file("note.txt", "text/plain", "hello")]),
    ).toMatchObject({ ok: false, code: "invalid_file_type" });
    expect(await names("#listing-file")).toEqual([]);
    expect(await applyFiles(listing.ref, [png])).toEqual({
      ok: true,
      selected: 1,
    });
    // An empty list clears the selection and skips both checks.
    expect(await applyFiles(listing.ref, [])).toEqual({
      ok: true,
      selected: 0,
    });
    expect(await names("#listing-file")).toEqual([]);
  }, 20000);

  it("applying files fires input then change, and the bytes reach the input in order", async () => {
    await openHtml(FILE_PAGE);
    const note = await retarget(selectorTarget("#note-label", "none"));
    expect(
      await applyFiles(note.ref, [
        file("one.txt", "text/plain", "first"),
        file("two.txt", "text/plain", "second"),
      ]),
    ).toEqual({ ok: true, selected: 2 });
    expect(await page.evaluate(() => (globalThis as any).seen)).toEqual([
      "input 2 true",
      "change 2 true",
    ]);
    expect(
      await page.evaluate(async () => {
        const input = document.getElementById("note-file") as HTMLInputElement;
        return Promise.all(
          Array.from(input.files ?? []).map(async (item) => [
            item.name,
            item.type,
            await item.text(),
          ]),
        );
      }),
    ).toEqual([
      ["one.txt", "text/plain", "first"],
      ["two.txt", "text/plain", "second"],
    ]);
  }, 20000);
});
