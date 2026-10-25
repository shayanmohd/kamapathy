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

  it("measures both drag ends and refuses only ends that cannot share the screen", async () => {
    await open("/input/drag");
    // Each end carries its own candidate refs, as the resolver reserves
    // them per target.
    const end = (selector: string, firstRef: number) => {
      const base = aim(selector, {}, "pointer");
      return { ...base, query: { ...(base.query as object), firstRef } };
    };
    const ends = (
      source: string,
      target: string,
      extra: Record<string, unknown> = {},
    ) =>
      operate("actionPoint", {
        source: end(source, 900000),
        target: end(target, 910000),
        kind: "drag",
        force: false,
        ...extra,
      });
    // Both ends in view: each point is the centre of what it shows.
    const close = await ends("#card", "#zone");
    expect(close.blocked).toBeUndefined();
    expect(close.from).toEqual(await centreOf("card"));
    expect(close.to).toEqual(await centreOf("zone"));
    // A position is measured from that end's own top left corner.
    expect(
      await ends("#card", "#zone", {
        sourcePosition: { x: 10, y: 20 },
        targetPosition: { x: 4, y: 8 },
      }),
    ).toMatchObject({ from: { x: 50, y: 320 }, to: { x: 244, y: 308 } });
    // Something over an end is the covered blocker, named with the end it
    // belongs to, and force skips the check.
    expect((await ends("#card", "#blocked")).blocked).toEqual({
      blocker: "covered",
      end: "target",
      interceptor: "div#shade",
    });
    const forced = await ends("#card", "#blocked", { force: true });
    expect(forced.blocked).toBeUndefined();
    expect(forced.to).toEqual(await centreOf("blocked"));
    // A drop inside what is dragged, and an end with no area, are refused
    // for good.
    expect(await ends("#card", "#inner")).toMatchObject({
      ok: false,
      code: "invalid_target",
    });
    expect(await ends("#card", "#flat")).toMatchObject({
      ok: false,
      code: "element_action_failed",
    });
    // An end below the fold that can still share the screen asks for one
    // wheel gesture: the least that brings both ends into view.
    const below = await ends("#card", "#near");
    expect(below.blocked).toBeUndefined();
    expect(below.from).toBeUndefined();
    expect(below.scroll).toEqual({
      x: 450,
      y: 350,
      deltaX: 0,
      deltaY: 100,
      end: "target",
    });
    await page.evaluate(() => scrollBy(0, 100));
    const after = await ends("#card", "#near");
    expect(after.scroll).toBeUndefined();
    expect(after.from).toEqual(await centreOf("card"));
    expect(after.to).toEqual(await centreOf("near"));
    await page.evaluate(() => scrollTo(0, 0));
    // Ends too far apart to share the screen are refused instead of
    // scrolled, and a sixth gesture leaves the scrolling to the page.
    expect(await ends("#card", "#far")).toMatchObject({
      ok: false,
      code: "drag_out_of_view",
    });
    // An end taller than the viewport can share the screen with one below
    // the fold, so that pair scrolls instead of being refused.
    const tall = await ends("#rail", "#near");
    expect(tall).toMatchObject({ ok: true });
    expect(tall.scroll).toMatchObject({ end: "target" });
    await page.evaluate(
      (delta: number) => scrollBy(0, delta),
      tall.scroll.deltaY,
    );
    const reached = await ends("#rail", "#near");
    expect(reached.to).toEqual(await centreOf("near"));
    expect(reached.from).toBeDefined();
    await page.evaluate(() => scrollTo(0, 0));
    expect(await ends("#card", "#near", { scrolls: 6 })).toMatchObject({
      ok: true,
      intoView: true,
    });
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
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

  it("names the picker a press would open, and nothing behind a closed shadow root", async () => {
    await open("/input/selects");
    const pickerOf = async (
      selector: string,
      extra: Record<string, unknown> = {},
    ) => (await point(selector, extra)).picker;
    expect(await pickerOf("#city")).toBe("select");
    expect(await pickerOf("#several")).toBeUndefined();
    expect(await pickerOf("#sized")).toBeUndefined();
    // A closed shadow root holds a dropdown no selector reaches and the
    // page's hit test stops at its host, so the page names no picker and
    // the session's own hit test is what catches it.
    const buried = await point("#closed-root");
    expect(buried.blocked).toBeUndefined();
    expect(buried.picker).toBeUndefined();
    expect(
      await page.evaluate(() => document.querySelectorAll("#buried").length),
    ).toBe(0);
    await open("/input/fields");
    expect(await pickerOf("#tint")).toBe("color");
    expect(await pickerOf("#name")).toBeUndefined();
    expect(await pickerOf("#notes")).toBeUndefined();
    // A date input names its kind wherever the point lands, its picker
    // indicator at the right end included, and the main process decides
    // from its own hit which of those opens the picker.
    const day = await page.evaluate(() => {
      const box = document.getElementById("day")!.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
    expect(await pickerOf("#day")).toBe("date");
    expect(
      await pickerOf("#day", {
        position: { x: day.width - 6, y: day.height / 2 },
      }),
    ).toBe("date");
  }, 30000);

  // The field operations the fill, select and focus routes drive.
  const prepare = (selector: string, extra: Record<string, unknown> = {}) =>
    operate("fillPrepare", aim(selector, { value: "Ada", ...extra }));
  const choose = (selector: string, values: unknown[]) =>
    operate("selectChoose", aim(selector, { values }));
  const setValue = (selector: string, value: string) =>
    operate("setDirectValue", aim(selector, { value }));
  const activeId = () => page.evaluate(() => document.activeElement?.id);
  // One composed input and one bubbling change, counted at the document.
  const watchEvents = () =>
    page.evaluate(() => {
      const counts = { input: 0, change: 0, composed: 0 };
      (window as unknown as { counts: typeof counts }).counts = counts;
      document.addEventListener("input", (event) => {
        counts.input++;
        if (event.composed) counts.composed++;
      });
      document.addEventListener("change", () => counts.change++);
    });
  // What was counted since the last reading, which the listeners keep
  // writing into.
  const counted = () =>
    page.evaluate(() => {
      const held = (window as unknown as { counts: Record<string, number> })
        .counts;
      const seen = { ...held };
      held.input = 0;
      held.change = 0;
      held.composed = 0;
      return seen;
    });
  // What a trusted insertion at the prepared caret would leave behind.
  const insertInto = (selector: string, text: string) =>
    page.evaluate(
      ([selector, text]) => {
        document.execCommand("insertText", false, text);
        return (document.querySelector(selector) as HTMLInputElement).value;
      },
      [selector, text] as const,
    );
  const selectionOf = (id: string) =>
    page.evaluate((id) => {
      const field = document.getElementById(id) as HTMLInputElement;
      return {
        start: field.selectionStart,
        end: field.selectionEnd,
        value: field.value,
      };
    }, id);

  it("retargets fills, selects and focus", async () => {
    await open("/input/fields");
    // A label around an input, and a wrapper holding one field.
    expect(await prepare("#wrap")).toMatchObject({
      ok: true,
      mode: "insert",
      previous: "",
    });
    expect(await activeId()).toBe("nick");
    expect(await prepare("#one-area")).toMatchObject({ ok: true });
    expect(await activeId()).toBe("area");
    // A hidden decoy leaves one field to fill.
    expect(await prepare("#decoy")).toMatchObject({ ok: true });
    expect(await activeId()).toBe("real");
    // Several fillable descendants name themselves instead.
    const two = await prepare("#two-fields");
    expect(two).toMatchObject({ ok: false, code: "ambiguous_field" });
    expect(two.fields.candidates).toEqual([
      {
        tag: "input",
        role: "textbox",
        name: "First",
        context: expect.any(String),
      },
      {
        tag: "input",
        role: "textbox",
        name: "Second",
        context: expect.any(String),
      },
    ]);
    // Three at most, the ones an action can take first.
    const many = await prepare("#many-fields");
    expect(
      many.fields.candidates.map((item: { name: string }) => item.name),
    ).toEqual(["One", "Two", "Three"]);
    // A child of an editing host fills the host.
    expect(await prepare("#note-word")).toMatchObject({
      ok: true,
      previous: "Written here",
    });
    expect(await activeId()).toBe("notes");
    expect(await prepare("#notes")).toMatchObject({ ok: true });
    // Nothing to type into, and a kind fill never takes.
    expect(await prepare("#plain")).toMatchObject({
      ok: false,
      code: "not_editable",
      fields: { reason: "none" },
    });
    expect(await prepare("#pick")).toMatchObject({
      ok: false,
      code: "not_editable",
      fields: { reason: "kind" },
    });
    // A field inside a frame from another origin is named by the frame.
    await page.evaluate(
      async (src) => {
        const wrapper = document.createElement("div");
        wrapper.id = "foreign-wrap";
        const frame = document.createElement("iframe");
        frame.src = src;
        const loaded = new Promise((done) =>
          frame.addEventListener("load", done),
        );
        wrapper.append(frame);
        document.body.append(wrapper);
        await loaded;
      },
      `${origin.replace("127.0.0.1", "localhost")}/input/fields`,
    );
    expect(await prepare("#foreign-wrap")).toMatchObject({
      ok: false,
      code: "not_editable",
      fields: { reason: "frame" },
    });
    await open("/input/selects");
    // A label's select, a wrapper's only select, and nothing to choose in.
    expect(await choose("#city-label", ["ams"])).toMatchObject({
      ok: true,
      values: ["ams"],
    });
    expect(await choose("#one-select", ["b"])).toMatchObject({
      ok: true,
      values: ["b"],
    });
    expect(await choose("#nothing-here", ["a"])).toMatchObject({
      ok: false,
      code: "not_selectable",
    });
    // Focus takes the single editable descendant, or nothing.
    await open("/input/fields");
    expect(await operate("focusTarget", aim("#one-area"))).toMatchObject({
      ok: true,
    });
    expect(await activeId()).toBe("area");
    expect(await operate("focusTarget", aim("#plain"))).toMatchObject({
      ok: false,
      code: "not_focusable",
    });
    const crowded = await operate("focusTarget", aim("#two-fields"));
    expect(crowded).toMatchObject({ ok: false, code: "ambiguous_field" });
  }, 30000);

  it("matches options by value, label, index and object", async () => {
    await open("/input/selects");
    await watchEvents();
    // A string matches a value first, then a label.
    expect(await choose("#city", ["ams"])).toMatchObject({ values: ["ams"] });
    expect(await counted()).toEqual({ input: 1, change: 1, composed: 1 });
    expect(
      await page.evaluate(
        () => (document.getElementById("city") as HTMLSelectElement).value,
      ),
    ).toBe("ams");
    expect(await choose("#city", ["Bengaluru"])).toMatchObject({
      values: ["blr"],
    });
    expect(await choose("#city", [{ label: "Amsterdam" }])).toMatchObject({
      values: ["ams"],
    });
    // A value beats another option's label.
    expect(await choose("#tricky", ["two"])).toMatchObject({
      values: ["two"],
    });
    // Every field of an object has to match.
    expect(await choose("#city", [{ value: "blr", index: 2 }])).toMatchObject({
      values: ["blr"],
    });
    expect(await choose("#city", [{ value: "blr", index: 1 }])).toMatchObject({
      blocked: { blocker: "option_missing" },
    });
    expect(await choose("#city", [{}])).toMatchObject({
      ok: false,
      code: "invalid_field",
    });
    // A disabled option stays selectable.
    expect(await choose("#roles", ["w"])).toMatchObject({ values: ["w"] });
    // A missing option names what was asked for and the first 20 options.
    await counted();
    const missing = await choose("#many", ["nope"]);
    expect(missing.blocked).toEqual({
      blocker: "option_missing",
      detail: "nope",
    });
    expect(missing.options).toHaveLength(20);
    expect(missing.options[0]).toBe("Option 1");
    expect(await counted()).toEqual({ input: 0, change: 0, composed: 0 });
    // A multiple select takes several, and an empty list clears it.
    expect(await choose("#several", ["a", "Gamma"])).toMatchObject({
      values: ["a", "c"],
    });
    expect(await choose("#several", [])).toMatchObject({ values: [] });
    // A single select cannot hold nothing, so clearing reports what it keeps.
    expect(await choose("#city", [])).toMatchObject({ values: [""] });
    expect(
      await page.evaluate(
        () =>
          Array.from(
            document.querySelectorAll<HTMLOptionElement>("#several option"),
          ).filter((option) => option.selected).length,
      ),
    ).toBe(0);
    // A single select takes one choice.
    expect(await choose("#city", ["ams", "blr"])).toMatchObject({
      ok: false,
      code: "invalid_field",
    });
  }, 30000);

  it("sets range and color directly and refuses what fill cannot take", async () => {
    await open("/input/fields");
    await watchEvents();
    expect(await setValue("#volume", "7")).toMatchObject({
      ok: true,
      value: "7",
    });
    expect(await counted()).toEqual({ input: 1, change: 1, composed: 1 });
    // A colour ignores case, and a range must equal its sanitized value.
    expect(await setValue("#tint", "#ABCDEF")).toMatchObject({
      ok: true,
      value: "#abcdef",
    });
    expect(await counted()).toEqual({ input: 1, change: 1, composed: 1 });
    expect(await setValue("#volume", "15")).toMatchObject({
      ok: false,
      code: "invalid_value",
    });
    expect(
      await page.evaluate(
        () => (document.getElementById("volume") as HTMLInputElement).value,
      ),
    ).toBe("7");
    expect(await setValue("#day", "not-a-day")).toMatchObject({
      ok: false,
      code: "invalid_value",
    });
    expect(await setValue("#week", "2026-W01")).toMatchObject({ ok: true });
    // Nothing fired for a value the field refused.
    expect(await counted()).toEqual({ input: 1, change: 1, composed: 1 });
    for (const id of ["pick", "choice", "upload", "token", "picture", "go"])
      expect(await setValue(`#${id}`, "x")).toMatchObject({
        ok: false,
        code: "not_editable",
        fields: { reason: "kind" },
      });
    await open("/input/selects");
    expect(await setValue("#several", "a")).toMatchObject({
      ok: false,
      code: "not_editable",
      fields: { reason: "kind" },
    });
    expect(await setValue("#empty", "a")).toMatchObject({
      ok: false,
      code: "not_editable",
      fields: { reason: "readonly_select" },
    });
    // A single select keeps its exact value match, set and never typed into.
    expect(await prepare("#city")).toMatchObject({ mode: "direct" });
    expect(await setValue("#city", "ams")).toMatchObject({
      ok: true,
      value: "ams",
    });
    expect(await setValue("#city", "Amsterdam")).toMatchObject({
      ok: false,
      code: "invalid_value",
    });
    expect(await setValue("#roles", "w")).toMatchObject({
      ok: false,
      code: "invalid_value",
    });
  }, 30000);

  it("prepares a field with preventScroll and reports not_focused", async () => {
    await open("/input/fields");
    // A field whose own handler moves focus away is not prepared.
    expect(await prepare("#jumpy")).toMatchObject({
      blocked: { blocker: "not_focused" },
    });
    expect(await prepare("#code")).toMatchObject({
      blocked: { blocker: "read_only" },
    });
    // Replacing selects everything the field holds.
    await page.fill("#name", "Grace");
    expect(await prepare("#name")).toMatchObject({
      ok: true,
      mode: "insert",
      previous: "Grace",
    });
    expect(await selectionOf("name")).toEqual({
      start: 0,
      end: 5,
      value: "Grace",
    });
    // Appending leaves the value and puts the caret at its end.
    expect(await prepare("#name", { append: true })).toMatchObject({
      previous: "Grace",
    });
    expect(await selectionOf("name")).toEqual({
      start: 5,
      end: 5,
      value: "Grace",
    });
    // An empty value is deleted instead of typed.
    expect(await prepare("#name", { value: "" })).toMatchObject({
      mode: "delete",
    });
    expect(await prepare("#name", { value: "", append: true })).toMatchObject({
      mode: "insert",
    });
    // The kinds a fill sets through their own setter instead of typing.
    for (const id of [
      "day",
      "moment",
      "when",
      "month",
      "week",
      "volume",
      "tint",
    ])
      expect(await prepare(`#${id}`), id).toMatchObject({ mode: "direct" });
    // Email and number inputs have no selection to set; their previous value
    // is still read, and the caret of a field just focused rests at its end,
    // so appending fills the old value and the new one.
    await page.fill("#email", "ada@example.com");
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    expect(await prepare("#email", { append: true })).toMatchObject({
      ok: true,
      mode: "insert",
      previous: "ada@example.com",
    });
    expect(await insertInto("#email", "X")).toBe("ada@example.comX");
    expect(await prepare("#email", { value: "new@example.com" })).toMatchObject(
      { previous: "ada@example.comX" },
    );
    expect(await insertInto("#email", "new@example.com")).toBe(
      "new@example.com",
    );
    await page.fill("#count", "12");
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    expect(await prepare("#count", { value: "3", append: true })).toMatchObject(
      { previous: "12" },
    );
    expect(await insertInto("#count", "3")).toBe("123");
    // A value the field would normalize never reaches it.
    expect(await prepare("#count", { value: "12x" })).toMatchObject({
      ok: false,
      code: "invalid_value",
    });
    // An editing host has its contents selected.
    expect(await prepare("#notes")).toMatchObject({ ok: true });
    expect(await page.evaluate(() => String(getSelection()))).toBe(
      "Written here",
    );
    // A secret field answers valueHidden instead of a value, and reports the
    // point a retry click would land on.
    await page.fill("#secret", "hunter2");
    const secret = await prepare("#secret");
    expect(secret).toMatchObject({ ok: true, valueHidden: true, previous: "" });
    expect(secret.point).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
    });
    // Preparation never scrolls, wherever the field stands.
    const resting = await page.evaluate(() => scrollY);
    expect(await prepare("#three")).toMatchObject({ ok: true });
    expect(await page.evaluate(() => scrollY)).toBe(resting);
  }, 30000);

  it("reads a field until two reads agree", async () => {
    await open("/input/fields");
    const read = (selector: string, extra: Record<string, unknown> = {}) =>
      operate(
        "fillRead",
        aim(selector, { value: "Ada", previous: "", ...extra }),
      );
    await page.fill("#name", "Ada");
    expect(await read("#name")).toEqual({
      ok: true,
      match: "exact",
      value: "Ada",
    });
    expect(await read("#name", { value: "Grace" })).toMatchObject({
      match: "transformed",
    });
    // A field a component rewrites after it changes settles before the read
    // answers.
    await page.evaluate(() => {
      const slow = document.getElementById("slow") as HTMLInputElement;
      slow.value = "Ada";
      slow.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(await read("#slow")).toMatchObject({
      match: "transformed",
      value: "Ada-one-two",
    });
    // A wrapper reads the field it would fill, and a secret field reports no
    // value at all.
    expect(await read("#one-area", { value: "" })).toMatchObject({
      match: "exact",
    });
    await page.fill("#secret", "hunter2");
    const secret = await read("#secret", { value: "hunter2" });
    expect(secret).toEqual({ ok: true, match: "exact", valueHidden: true });
  }, 30000);

  it("fills a controlled field and appends to an email and a number input", async () => {
    await open("/input/fields");
    // The three steps a fill route runs, with Chromium's own insertion in
    // the middle: prepare the caret, insert the text, read what was kept.
    const fill = async (
      selector: string,
      value: string,
      extra: Record<string, unknown> = {},
    ) => {
      const prepared = await operate(
        "fillPrepare",
        aim(selector, { value, ...extra }),
      );
      expect(prepared, selector).toMatchObject({ ok: true });
      expect(prepared.blocked, selector).toBeUndefined();
      await page.keyboard.insertText(value);
      return operate(
        "fillRead",
        aim(selector, { value, previous: prepared.previous, ...extra }),
      );
    };
    // A component that reformats what it is given keeps its own value: the
    // same digits read as equivalent, a reformatted amount as transformed.
    expect(await fill("#currency", "1250")).toEqual({
      ok: true,
      match: "equivalent",
      value: "12.50",
    });
    expect(await fill("#currency", "7")).toEqual({
      ok: true,
      match: "transformed",
      value: "0.07",
    });
    // Appending to an email or a number input, which have no selection to
    // set, leaves the old value and types after it.
    await page.fill("#email", "ada@");
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    expect(await fill("#email", "example.com", { append: true })).toEqual({
      ok: true,
      match: "exact",
      value: "ada@example.com",
    });
    await page.fill("#count", "12");
    await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
    expect(await fill("#count", "34", { append: true })).toEqual({
      ok: true,
      match: "exact",
      value: "1234",
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

  it("measures a position from the border box and refuses one outside the clip", async () => {
    await open("/input/buttons");
    const box = await page.evaluate(() => {
      const rect = document.getElementById("save")!.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    });
    const corner = await point("#save", { position: { x: 3, y: 4 } });
    expect(corner.blocked).toBeUndefined();
    expect(corner.point.x).toBeCloseTo(box.left + 3, 5);
    expect(corner.point.y).toBeCloseTo(box.top + 4, 5);
    // Without a position the centre is what the press lands on.
    const middle = await point("#save");
    expect(middle.point.x).toBeCloseTo(box.left + box.width / 2, 5);
    expect(middle.point.y).toBeCloseTo(box.top + box.height / 2, 5);
    // A point past the viewport, past the 10000 px limit, or no number at
    // all, has nowhere to land.
    for (const position of [
      { x: 1000 - box.left, y: 0 },
      { x: 0, y: -box.top - 40 },
      { x: 10001, y: 0 },
      { x: Number.NaN, y: 0 },
    ])
      expect(
        (await point("#save", { position })).blocked,
        JSON.stringify(position),
      ).toEqual({ blocker: "outside_viewport" });
    // A position inside the element but under something else is covered.
    expect(
      await point("#overlaid", { position: { x: 2, y: 2 } }),
    ).toMatchObject({ blocked: { blocker: "covered", interceptor: "div#shade" } });
  }, 30000);
});
