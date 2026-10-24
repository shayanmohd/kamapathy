// Runs the action operations of the page script inside Playwright's
// Chromium, where shadow roots, frames, layout and hit testing behave as
// they do in Kamapathy's tabs. These tests skip when Playwright's browser is
// not installed.
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Level, Mode } from "../electron/agent/dom/select";
import { parseSelector } from "../electron/agent/selectors";
import { PAGE_SOURCE } from "../electron/agent/session/operations";
import type { PageOperation } from "../electron/automation-dom";
import { inputPages } from "./fixtures/input-pages.mjs";

const executable = chromium.executablePath();
const browserAvailable = !!executable && existsSync(executable);
const script = `(${PAGE_SOURCE})`;

describe.skipIf(!browserAvailable)("action operations in Chromium", () => {
  let site: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    site = createServer((request, response) => {
      const html = inputPages[new URL(request.url || "/", "http://x").pathname];
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
  const open = async (path: string, scale?: number) => {
    await page?.close();
    page = await browser.newPage({
      viewport: { width: 900, height: 700 },
      ...(scale === undefined ? {} : { deviceScaleFactor: scale }),
    });
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
  // A target the way an input route sends one: the selector as written, with
  // the query the resolver built from it beside it.
  const aim = (
    selector: string,
    extra: Record<string, unknown> = {},
    level: Level = "none",
    mode: Mode = "strict",
  ): Record<string, unknown> => {
    const parsed = parseSelector(selector);
    if (!parsed.ok) throw new Error(`${selector}: ${parsed.problem.message}`);
    if (parsed.ast.kind === "ref") throw new Error(`${selector} is a ref`);
    return {
      selector,
      query: { ast: parsed.ast, mode, level, firstRef: 900000 },
      ...extra,
    };
  };
  const point = (selector: string, extra: Record<string, unknown> = {}) =>
    operate("actionPoint", aim(selector, { kind: "click", ...extra }));
  const blockerOf = async (
    selector: string,
    extra: Record<string, unknown> = {},
  ) => (await point(selector, extra)).blocked?.blocker;
  const centreOf = (id: string) =>
    page.evaluate((id) => {
      const box = document.getElementById(id)!.getBoundingClientRect();
      return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    }, id);

  it("names the disabled state from the composed chain", async () => {
    await open("/input/disabled");
    // A disabled fieldset reaches everything but its first legend, whether
    // or not the target is a form control of its own.
    expect(await blockerOf("#in-fieldset")).toBe("disabled");
    expect(await blockerOf("#marked-in-fieldset")).toBe("disabled");
    expect(await blockerOf("#marked-alone")).toBe("disabled");
    expect(await blockerOf("#in-second-legend")).toBe("disabled");
    expect(await blockerOf("#in-legend")).toBeUndefined();
    // aria-disabled counts where the role supports it, and the nearest
    // answer decides.
    expect(await blockerOf("#aria-off")).toBe("disabled");
    expect(await blockerOf("#aria-self")).toBe("disabled");
    expect(await blockerOf("#aria-on")).toBeUndefined();
    expect(await blockerOf("#aria-plain")).toBeUndefined();
    // Options and option groups count as well.
    const choice = (selector: string) =>
      blockerOf(selector, { kind: "select" });
    expect(await choice("#dead")).toBe("disabled");
    expect(await choice("#grouped")).toBe("disabled");
    expect(await choice("#group")).toBe("disabled");
    expect(await choice("#live")).toBeUndefined();
    // force skips the pointer check, never any of this.
    expect(await blockerOf("#in-fieldset", { force: true })).toBe("disabled");
    expect(await blockerOf("#aria-off", { force: true })).toBe("disabled");
    await open("/input/fields");
    expect(await blockerOf("#code", { kind: "fill" })).toBe("read_only");
    expect(await blockerOf("#name", { kind: "fill" })).toBeUndefined();
  }, 30000);

  it("lets descendants and interactive ancestors take the hit", async () => {
    await open("/input/buttons");
    for (const selector of [
      "#save",
      "#agree",
      "#more-text",
      "#link-text",
      "#widget-text",
    ]) {
      const result = await point(selector);
      expect({ selector, blocked: result.blocked }).toEqual({
        selector,
        blocked: undefined,
      });
      expect(result.point).toMatchObject({
        x: expect.any(Number),
        y: expect.any(Number),
      });
    }
    // A box of its own that something else draws over is covered, named by
    // what took the hit.
    for (const [selector, interceptor] of [
      ["#overlaid", "div#shade"],
      ["#under-footer", 'div#footer.bar "Site footer"'],
    ] as const)
      expect(await point(selector)).toMatchObject({
        ok: true,
        blocked: { blocker: "covered", interceptor },
      });
    // force sends the press anyway.
    expect(await point("#overlaid", { force: true })).toMatchObject({
      ok: true,
      point: { x: expect.any(Number) },
    });
    expect((await point("#overlaid", { force: true })).blocked).toBeUndefined();
    // A modal dialog takes the hit everywhere outside itself.
    await page.evaluate(() =>
      (document.getElementById("confirm") as HTMLDialogElement).showModal(),
    );
    expect(await point("#behind")).toMatchObject({
      ok: true,
      blocked: { blocker: "covered", interceptor: 'dialog "Confirm delete"' },
    });
  }, 30000);

  it("names the interceptor", async () => {
    await open("/input/buttons");
    const banner = (await point("#under-banner")).blocked;
    expect(banner.blocker).toBe("covered");
    expect(banner.interceptor).toHaveLength(120);
    expect(
      banner.interceptor.startsWith('div#consent.banner "Accept all'),
    ).toBe(true);
    // A box with nothing to name is named by its tag alone.
    expect((await point("#under-bare")).blocked.interceptor).toBe("div");
    // Control and bidirectional characters never reach the agent.
    expect((await point("#under-marked")).blocked.interceptor).toBe(
      'div#marked "Reversed text"',
    );
    await page.evaluate(() =>
      (document.getElementById("confirm") as HTMLDialogElement).showModal(),
    );
    expect((await point("#behind")).blocked.interceptor).toBe(
      'dialog "Confirm delete"',
    );
  }, 30000);

  it("asks for scroll gestures through frames and gives up after six", async () => {
    // The gesture the main process would send, and the wait for the
    // compositor to finish moving both scrollers.
    const send = async (scroll: {
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
    }) => {
      await page.mouse.move(scroll.x, scroll.y);
      await page.mouse.wheel(scroll.deltaX, scroll.deltaY);
      let last = "";
      for (let tries = 0; tries < 60; tries++) {
        const now = await page.evaluate(() => {
          const frame = document.getElementById(
            "panel-frame",
          ) as HTMLIFrameElement;
          const panel = frame.contentDocument?.getElementById("panel");
          return `${scrollY},${panel ? panel.scrollTop : -1}`;
        });
        if (now === last) return;
        last = now;
        await new Promise((done) => setTimeout(done, 25));
      }
    };
    const panelCentre = () =>
      page.evaluate(() => {
        const frame = document.getElementById(
          "panel-frame",
        ) as HTMLIFrameElement;
        const box = frame.getBoundingClientRect();
        const panel = frame.contentDocument!.getElementById("panel")!;
        const inner = panel.getBoundingClientRect();
        return {
          x: box.left + inner.left + panel.clientLeft + panel.clientWidth / 2,
          y: box.top + inner.top + panel.clientTop + panel.clientHeight / 2,
        };
      });
    const target = () => aim("#deep");
    await open("/input/scrollers");
    // The frame comes first: a gesture at the top viewport's centre with the
    // delta that centres the frame.
    const first = await operate("actionPoint", { ...target(), kind: "click" });
    const frame = await centreOf("panel-frame");
    expect(first.point).toBeUndefined();
    expect(first.scroll).toMatchObject({ x: 450, y: 350 });
    expect(first.scroll.deltaX).toBeCloseTo(frame.x - 450, 1);
    expect(first.scroll.deltaY).toBeCloseTo(frame.y - 350, 1);
    expect(first.scroll.frame).toBeUndefined();
    await send(first.scroll);
    // Then the panel inside the frame, in the frame's own pixels.
    const second = await operate("scrollRequest", { ...target(), scrolls: 1 });
    const centre = await panelCentre();
    const deep = await page.evaluate(() => {
      const frame = document.getElementById("panel-frame") as HTMLIFrameElement;
      const box = frame
        .contentDocument!.getElementById("deep")!
        .getBoundingClientRect();
      const panel = frame.contentDocument!.getElementById("panel")!;
      const inner = panel.getBoundingClientRect();
      return {
        x: (box.left + box.right) / 2,
        y: (box.top + box.bottom) / 2,
        centreX: inner.left + panel.clientLeft + panel.clientWidth / 2,
        centreY: inner.top + panel.clientTop + panel.clientHeight / 2,
      };
    });
    expect(second.scroll.frame).toBe("0");
    expect(second.scroll.x).toBeCloseTo(centre.x, 1);
    expect(second.scroll.y).toBeCloseTo(centre.y, 1);
    expect(second.scroll.deltaX).toBeCloseTo(deep.x - deep.centreX, 1);
    expect(second.scroll.deltaY).toBeCloseTo(deep.y - deep.centreY, 1);
    await send(second.scroll);
    expect(
      await operate("scrollRequest", { ...target(), scrolls: 2 }),
    ).toMatchObject({ ok: true, settled: true });
    const landed = await operate("actionPoint", { ...target(), kind: "click" });
    const middle = await panelCentre();
    expect(landed.scroll).toBeUndefined();
    expect(Math.abs(landed.point.y - middle.y)).toBeLessThan(2);
    // Focus and selectOption never ask for a scroll, and need no point.
    for (const kind of ["focus", "select"]) {
      const quiet = await operate("actionPoint", { ...target(), kind });
      expect(quiet).toMatchObject({ ok: true });
      expect(quiet.scroll).toBeUndefined();
      expect(quiet.point).toBeUndefined();
    }
    // A gesture that moved nothing gives up at once.
    await open("/input/scrollers");
    expect(
      (await operate("actionPoint", { ...target(), kind: "click" })).scroll,
    ).toBeDefined();
    expect(
      await operate("scrollRequest", { ...target(), scrolls: 1 }),
    ).toMatchObject({ ok: true, intoView: true });
    // So does the sixth gesture, and the element then sits in the middle.
    await open("/input/scrollers");
    const asked = await operate("actionPoint", { ...target(), kind: "click" });
    await send(asked.scroll);
    expect(
      await operate("scrollRequest", { ...target(), scrolls: 6 }),
    ).toMatchObject({ ok: true, intoView: true });
    const after = await operate("actionPoint", { ...target(), kind: "click" });
    const rest = await panelCentre();
    expect(after.blocked).toBeUndefined();
    expect(Math.abs(after.point.y - rest.y)).toBeLessThan(2);
  }, 60000);

  it("gives SVG and MathML points", async () => {
    await open("/input/graphics");
    const drawn = await page.evaluate(() => {
      const boxes: Record<string, number[]> = {};
      for (const id of ["bar", "variable"]) {
        const box = document.getElementById(id)!.getBoundingClientRect();
        boxes[id] = [box.left, box.top, box.right, box.bottom];
      }
      return boxes;
    });
    for (const [id, box] of Object.entries(drawn)) {
      const result = await point(`#${id}`);
      expect({ id, blocked: result.blocked }).toEqual({
        id,
        blocked: undefined,
      });
      expect(result.point.x).toBeGreaterThan(box[0]);
      expect(result.point.x).toBeLessThan(box[2]);
      expect(result.point.y).toBeGreaterThan(box[1]);
      expect(result.point.y).toBeLessThan(box[3]);
    }
    // A group with nothing drawn in it has no point of its own.
    expect(await point("#nothing")).toMatchObject({ ok: true, empty: true });
    expect((await point("#nothing")).point).toBeUndefined();
  }, 30000);

  it("reports the viewport and the focused control's kind", async () => {
    await open("/input/fields");
    expect(await operate("viewport")).toEqual({
      ok: true,
      ...(await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        zoom: devicePixelRatio,
      }))),
    });
    const kind = () => operate("focusedKind");
    expect(await kind()).toEqual({ ok: true, kind: "none" });
    await page.focus("#tint");
    expect(await kind()).toEqual({ ok: true, kind: "color" });
    await page.focus("#day");
    expect(await kind()).toEqual({ ok: true, kind: "date" });
    await page.focus("#notes");
    expect(await kind()).toEqual({ ok: true, kind: "editable" });
    await page.focus("#name");
    expect(await kind()).toEqual({ ok: true, kind: "editable" });
    await open("/input/selects");
    await page.focus("#city");
    expect(await kind()).toEqual({ ok: true, kind: "select" });
    await page.focus("#sized");
    expect(await kind()).toEqual({ ok: true, kind: "other" });
    // A frame from another origin is reported, never read.
    const foreign = `${origin.replace("127.0.0.1", "localhost")}/input/fields`;
    await page.evaluate(async (src) => {
      const frame = document.createElement("iframe");
      frame.id = "foreign";
      frame.src = src;
      const loaded = new Promise((done) =>
        frame.addEventListener("load", done),
      );
      document.body.append(frame);
      await loaded;
      frame.focus();
    }, foreign);
    expect(await kind()).toEqual({
      ok: true,
      kind: "other",
      blockedFrame: true,
    });
    // The viewport carries the zoom a capture is drawn at.
    await open("/input/fields", 2);
    expect(await operate("viewport")).toEqual({
      ok: true,
      width: 900,
      height: 700,
      zoom: 2,
    });
  }, 30000);

  it("measures stability across two frames", async () => {
    await open("/input/moving");
    const still = await operate("stableBox", aim("#still"));
    expect(still).toMatchObject({ ok: true, moved: 0 });
    expect(still.box).toMatchObject({ left: expect.any(Number) });
    expect(still.blocked).toBeUndefined();
    const drift = await operate("stableBox", aim("#drift"));
    expect(drift.moved).toBeGreaterThan(0);
    expect(drift.moved).toBeLessThanOrEqual(0.5);
    expect(drift.blocked).toBeUndefined();
    const shake = await operate("stableBox", aim("#shake"));
    expect(shake.moved).toBeGreaterThanOrEqual(1);
    expect(shake.blocked).toEqual({ blocker: "moving" });
    // A page whose frames never come settles on the timeout instead.
    await open("/input/stalled");
    const started = Date.now();
    const stalled = await operate("stableBox", aim("#waiting"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(stalled).toMatchObject({ ok: true, moved: 0 });
    expect(stalled.blocked).toBeUndefined();
  }, 30000);
});
