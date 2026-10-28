// Runs the page script, engine included, inside Playwright's Chromium,
// where shadow roots, frames and layout behave as they do in Kamapathy's
// tabs. These tests skip when Playwright's browser is not installed.
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  axSources,
  matchRole,
  readAx,
  resetAccessibility,
} from "../electron/agent/accessibility";
import type { Query, WaitState } from "../electron/agent/dom/select";
import { RefBook } from "../electron/agent/refs";
import {
  createResolver,
  waitMode,
  type Resolver,
} from "../electron/agent/resolve";
import { parseSelector } from "../electron/agent/selectors";
import { EventBufferPool } from "../electron/agent/session/event-buffer";
import { PAGE_SOURCE } from "../electron/agent/session/operations";
import { TabSession } from "../electron/agent/session/tab-session";
import type { PageOperation } from "../electron/automation-dom";
import {
  chromiumAvailable,
  launchChromium,
  type ChromiumBrowser,
  type ChromiumPage,
} from "./cdp-socket";
import { selectorPages } from "./fixtures/selector-pages.mjs";

const executable = chromium.executablePath();
const browserAvailable = !!executable && existsSync(executable);
const script = `(${PAGE_SOURCE})`;

describe.skipIf(!browserAvailable)("selector engine in Chromium", () => {
  let site: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    site = createServer((request, response) => {
      const html =
        selectorPages[new URL(request.url || "/", "http://x").pathname];
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
  }, 60000);
  const open = async (path: string) => {
    await page?.close();
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
  // A target the way the server will send one once section 5 lands: the
  // selector as written, with the parsed query beside it.
  const ask = (
    selector: string,
    extra: Partial<Omit<Query, "ast">> = {},
  ): Record<string, unknown> => {
    const parsed = parseSelector(selector);
    if (!parsed.ok) throw new Error(`${selector}: ${parsed.problem.message}`);
    if (parsed.ast.kind === "ref") throw new Error(`${selector} is a ref`);
    return {
      selector,
      query: { ast: parsed.ast, mode: "strict", level: "none", ...extra },
    };
  };
  const focusWith = async (payload: Record<string, unknown>) => {
    const result = await operate("focus", payload);
    if (result.ok !== true) return result;
    return page.evaluate(() => document.activeElement?.id ?? "");
  };
  const centerOf = (id: string) =>
    page.evaluate((id) => {
      const box = document.getElementById(id)!.getBoundingClientRect();
      return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
    }, id);
  const valueOf = (id: string) =>
    page.evaluate(
      (id) => (document.getElementById(id) as HTMLInputElement).value,
      id,
    );
  const frameAt = (path: string) =>
    page.frames().find((frame) => frame.url().endsWith(path))!;

  it("pierces open shadow roots one tree at a time, in composed order", async () => {
    await open("/selectors/shadow");
    const order = [
      "Item first",
      "Item shadow",
      "Item light",
      "Item last",
      "Item framed",
    ];
    for (const [index, text] of order.entries())
      expect(
        await operate("check", {
          ...ask(`.item >> nth=${index}`, { mode: "first", state: "attached" }),
          text,
        }),
        text,
      ).toMatchObject({ ok: true, matched: true });
    expect(
      await operate("check", {
        ...ask(".item >> nth=-1", { mode: "first", state: "attached" }),
        text: "Item framed",
      }),
    ).toMatchObject({ ok: true, matched: true });
    // A host's light child, never the button inside its shadow root.
    for (const selector of ["#host .item", ".card > .item"])
      expect(
        await operate("check", {
          ...ask(selector, { state: "attached" }),
          text: "Item light",
        }),
        selector,
      ).toMatchObject({ ok: true, matched: true });
    // Five matches: the closed root's button is not one of them.
    expect(
      await operate("target", ask(".item", { level: "pointer-enabled" })),
    ).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      fields: { count: 5, visible: 5, hidden: 0, actionable: 5 },
    });
  }, 30000);

  it("matches text, href, XPath and both filters as specified", async () => {
    await open("/selectors/text");
    expect(await focusWith(ask("text=sign in", { level: "enabled" }))).toBe(
      "signin",
    );
    expect(await focusWith(ask('text="Log in"', { level: "enabled" }))).toBe(
      "exact",
    );
    expect(await focusWith(ask("text=place order", { level: "enabled" }))).toBe(
      "order",
    );
    expect(
      await focusWith(ask('text="Place order"', { level: "enabled" })),
    ).toBe("order");
    expect(
      await focusWith(ask("href=/plans?tier=pro#faq", { level: "enabled" })),
    ).toBe("plans");
    expect(
      await focusWith(
        ask(`href=${origin}/plans?tier=pro#faq`, { level: "enabled" }),
      ),
    ).toBe("plans");
    expect(
      await focusWith(ask('button:text-is("Save")', { level: "enabled" })),
    ).toBe("save");
    // XPath runs per document, the top one first, and never enters a shadow
    // root: four list items in all, not the six the shadow root would add.
    for (const selector of ["xpath=//li[2]", "//li[2]"])
      expect(
        await operate("check", {
          ...ask(selector, { mode: "first", state: "attached" }),
          text: "Invoice 12 due",
        }),
        selector,
      ).toMatchObject({ ok: true, matched: true });
    expect(
      await operate("check", {
        ...ask("//li[2] >> nth=1", { mode: "first", state: "attached" }),
        text: "Frame second",
      }),
    ).toMatchObject({ ok: true, matched: true });
    expect(
      await operate("check", {
        ...ask("//li >> nth=3", { mode: "first", state: "attached" }),
        text: "Frame second",
      }),
    ).toMatchObject({ ok: true, matched: true });
    expect(
      await operate(
        "check",
        ask("//li >> nth=4", { mode: "first", state: "attached" }),
      ),
    ).toMatchObject({ ok: true, matched: false });
    // :has-text keeps ancestors and reads the text a shadow root draws.
    const rows = await operate(
      "target",
      ask('li:has-text("invoice 12")', { firstRef: 30 }),
    );
    expect(rows).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      fields: { count: 2 },
    });
    expect(rows.fields.candidates.map((item: any) => item.tag)).toEqual([
      "li",
      "li",
    ]);
    expect(
      await operate("check", {
        ...ask('li:has-text("invoice 12") >> nth=1', {
          mode: "first",
          state: "attached",
        }),
        text: "Invoice 12 due",
      }),
    ).toMatchObject({ ok: true, matched: true });
    // text= keeps the innermost match, inside a shadow root as well.
    const innermost = await operate(
      "target",
      ask("text=invoice 12", { firstRef: 40 }),
    );
    expect(innermost.fields.candidates.map((item: any) => item.tag)).toEqual([
      "span",
      "em",
    ]);
    expect(await operate("target", ask("xpath=//p/text()"))).toMatchObject({
      ok: false,
      code: "invalid_selector",
      fields: { reason: "xpath" },
    });
  }, 30000);

  it("applies nth before levels", async () => {
    await open("/selectors/nth");
    expect(
      await operate(
        "target",
        ask(".pick >> nth=1", { level: "pointer-enabled" }),
      ),
    ).toMatchObject({
      ok: false,
      code: "element_action_failed",
      error: "Element is not visible.",
      blocked: { blocker: "hidden" },
    });
    expect(await focusWith(ask(".pick >> nth=-1", { level: "enabled" }))).toBe(
      "two",
    );
    expect(
      await operate(
        "target",
        ask(".pick >> nth=9", { level: "pointer-enabled" }),
      ),
    ).toMatchObject({
      ok: false,
      code: "no_match",
      error:
        "Nothing on the page matches this selector. Take a snapshot to check the page.",
      fields: { selector: ".pick >> nth=9" },
    });
  }, 30000);

  it("ignores hidden and disabled duplicates at each level", async () => {
    await open("/selectors/levels");
    expect(await focusWith(ask(".save", { level: "enabled" }))).toBe(
      "saveReady",
    );
    expect(
      await operate("fill", {
        ...ask(".save", { level: "enabled" }),
        value: "note",
      }),
    ).toMatchObject({ ok: true });
    expect(await valueOf("saveReady")).toBe("note");
    const point = await operate(
      "target",
      ask(".save", { level: "pointer-enabled" }),
    );
    expect(point).toMatchObject({ ok: true });
    const center = await centerOf("saveReady");
    expect(Math.abs(point.x - center.x)).toBeLessThan(1);
    expect(Math.abs(point.y - center.y)).toBeLessThan(1);
    // Scroll counts every visible match, the disabled one included.
    const scrolled = await operate("scroll", {
      ...ask(".save", { level: "visible", firstRef: 60 }),
      direction: "down",
      pixels: 50,
    });
    expect(scrolled).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      fields: { count: 3, visible: 2, hidden: 1, actionable: 2 },
    });
    expect(scrolled.fields.candidates.map((item: any) => item.name)).toEqual([
      "Save disabled",
      "Save ready",
      "Save hidden",
    ]);
    expect(
      scrolled.fields.candidates.map((item: any) => [
        item.visible,
        item.disabled,
      ]),
    ).toEqual([
      [true, true],
      [true, false],
      [false, false],
    ]);
    // A snapshot scope counts hidden matches too.
    const scoped = await operate("snapshot", {
      ...ask(".save", { firstRef: 70 }),
      mode: "full",
      maxChars: 4000,
      maxControls: 50,
      firstRef: 70,
    });
    expect(scoped).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      fields: { count: 3, visible: 2, hidden: 1, actionable: 3 },
    });
    expect(scoped.fields.candidates.map((item: any) => item.name)).toEqual([
      "Save hidden",
      "Save disabled",
      "Save ready",
    ]);
    expect(
      await operate("target", ask(".gone", { level: "pointer-enabled" })),
    ).toMatchObject({
      ok: false,
      error: "Element is not visible.",
      blocked: { blocker: "hidden" },
    });
    // The hidden and detached states read every match, and a strict state
    // that is ambiguous ends at once.
    for (const [selector, state, matched] of [
      [".gone", "hidden", true],
      [".save", "hidden", false],
      [".missing", "detached", true],
      [".save", "detached", false],
    ] as const)
      expect(
        await operate("check", ask(selector, { state })),
        `${selector} ${state}`,
      ).toMatchObject({ ok: true, matched });
    expect(
      await operate(
        "check",
        ask(".save", { state: "visible", level: "visible", firstRef: 85 }),
      ),
    ).toMatchObject({ ok: false, code: "ambiguous_match" });
    // One candidate in the top document decides, although the frame holds two.
    expect(
      await operate("fill", {
        ...ask(".only", { level: "enabled" }),
        value: "top wins",
      }),
    ).toMatchObject({ ok: true });
    expect(await valueOf("onlyTop")).toBe("top wins");
    const deep = await operate(
      "focus",
      ask(".deep", { level: "enabled", firstRef: 80 }),
    );
    expect(deep).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      fields: { count: 2, actionable: 2 },
    });
    expect(deep.fields.candidates.map((item: any) => item.frame)).toEqual([
      "0",
      "0",
    ]);
    expect(
      await operate("fill", {
        ...ask(".lone", { level: "enabled" }),
        value: "deep value",
      }),
    ).toMatchObject({ ok: true });
    expect(
      await frameAt("/selectors/frame-levels").evaluate(
        () => (document.getElementById("lone") as HTMLInputElement).value,
      ),
    ).toBe("deep value");
  }, 30000);

  it("lists 3 candidates with refs", async () => {
    await open("/selectors/many");
    const scoped = await operate("snapshot", {
      ...ask("#row2"),
      mode: "full",
      maxChars: 4000,
      maxControls: 50,
      firstRef: 1,
    });
    expect(scoped.interactables.map((item: any) => item.ref)).toEqual(["@e1"]);
    const result = await operate(
      "target",
      ask(".row-remove", { level: "pointer-enabled", firstRef: 50 }),
    );
    expect(result).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      error:
        "Selector matched 4 elements (4 visible, 0 hidden). Use a ref from candidates or a more specific selector.",
      fields: {
        selector: ".row-remove",
        count: 4,
        visible: 4,
        hidden: 0,
        actionable: 4,
      },
      issued: [50, 51],
    });
    expect(result.fields.candidates).toHaveLength(3);
    expect(result.fields.candidates.map((item: any) => item.ref)).toEqual([
      "@e50",
      "@e1",
      "@e51",
    ]);
    for (const candidate of result.fields.candidates)
      expect(candidate).toMatchObject({
        tag: "button",
        role: "button",
        name: "Remove",
        visible: true,
        disabled: false,
      });
    expect(
      result.fields.candidates.map((item: any) => item.context.slice(0, 10)),
    ).toEqual(["Invoice 11", "Invoice 12", "Invoice 13"]);
    expect(result.fields.candidates.some((item: any) => "frame" in item)).toBe(
      false,
    );
    // The failure left the ref the snapshot issued on its own button.
    expect(await operate("focus", { ref: "@e1" })).toMatchObject({ ok: true });
    expect(
      await page.evaluate(
        () => document.activeElement?.closest("li")?.id ?? "",
      ),
    ).toBe("row2");
  }, 30000);

  it("chooses a lone visible match under a sticky header and uses the hit test only between candidates", async () => {
    await open("/selectors/covered");
    const behind = await page.evaluate(() => {
      const button = document.getElementById("under")!;
      const box = button.getBoundingClientRect();
      scrollBy(0, box.top + box.height / 2 - 30);
      const after = button.getBoundingClientRect();
      return document.elementFromPoint(
        (after.left + after.right) / 2,
        (after.top + after.bottom) / 2,
      )?.id;
    });
    expect(behind).toBe("bar");
    const point = await operate(
      "target",
      ask("#under", { level: "pointer-enabled" }),
    );
    expect(point).toMatchObject({ ok: true });
    const center = await centerOf("under");
    expect(Math.abs(point.x - center.x)).toBeLessThan(1);
    expect(Math.abs(point.y - center.y)).toBeLessThan(1);
    await open("/selectors/modal");
    const choice = await operate(
      "target",
      ask(".act", { level: "pointer-enabled" }),
    );
    expect(choice).toMatchObject({ ok: true });
    await page.mouse.click(choice.x, choice.y);
    expect(
      await page.evaluate(() => document.getElementById("status")!.textContent),
    ).toBe("clicked modalAct");
    // Without a pointer level both buttons stay candidates.
    expect(
      await operate("focus", ask(".act", { level: "enabled", firstRef: 90 })),
    ).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      fields: { count: 2, actionable: 2 },
    });
  }, 30000);

  it("keeps picked role nodes only when the walk holds them", async () => {
    await open("/selectors/picked");
    await page.evaluate(() => {
      const world = window as unknown as {
        shadowSave: Element;
        lockedSave: Element;
        __kamapathyPicked?: Map<string, { node: Element; editable: boolean }[]>;
      };
      const frame = (document.getElementById("saveFrame") as HTMLIFrameElement)
        .contentDocument!;
      const detached = document.createElement("button");
      detached.textContent = "Save";
      const entry = (node: Element | null, editable = false) => ({
        node: node!,
        editable,
      });
      world.__kamapathyPicked = new Map([
        [
          "trio",
          [
            entry(document.getElementById("topSave")),
            entry(world.shadowSave),
            entry(frame.getElementById("frameSave")),
          ],
        ],
        ["gone", [entry(detached), entry(world.lockedSave)]],
        ["editor", [entry(document.getElementById("editor"), true)]],
        ["plain", [entry(document.getElementById("plain"), true)]],
      ]);
    });
    const saves = ask('role=button[name="Save"]', {
      level: "pointer-enabled",
      picked: "trio",
      firstRef: 100,
    });
    const trio = await operate("target", saves);
    expect(trio).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      fields: { count: 3, visible: 3, hidden: 0, actionable: 3 },
    });
    expect(trio.fields.candidates.map((item: any) => item.frame)).toEqual([
      undefined,
      undefined,
      "0",
    ]);
    // The entries are taken once.
    expect(await operate("target", saves)).toMatchObject({
      ok: false,
      code: "page_changed",
      error: "The page changed during this operation. Take a new snapshot.",
    });
    expect(
      await operate(
        "target",
        ask('role=button[name="Save"]', {
          level: "pointer-enabled",
          picked: "gone",
        }),
      ),
    ).toMatchObject({ ok: false, code: "no_match" });
    const editor = await operate(
      "target",
      ask("role=textbox", { level: "pointer-enabled", picked: "editor" }),
    );
    expect(editor).toMatchObject({ ok: true });
    const center = await centerOf("editor");
    expect(Math.abs(editor.x - center.x)).toBeLessThan(1);
    expect(
      await operate(
        "target",
        ask("role=textbox", { level: "pointer-enabled", picked: "plain" }),
      ),
    ).toMatchObject({ ok: false, code: "no_match" });
    expect(
      await operate("target", ask("role=button", { level: "pointer-enabled" })),
    ).toMatchObject({ ok: false, code: "page_changed" });
  }, 30000);

  it("reports CSS and XPath errors", async () => {
    await open("/selectors/nth");
    const broken = await operate(
      "target",
      ask("div[", { level: "pointer-enabled" }),
    );
    expect(broken).toMatchObject({
      ok: false,
      code: "invalid_selector",
      error: "The page rejected this CSS selector.",
      fields: { selector: "div[", reason: "css" },
    });
    expect(broken.fields.hint).toBeUndefined();
    expect(await operate("target", ask("xpath=//["))).toMatchObject({
      ok: false,
      code: "invalid_selector",
      error:
        "The page rejected this XPath, or it selects something other than elements.",
      fields: { reason: "xpath" },
    });
    // The parser refuses an id that starts with a digit, so this query is
    // built the way a caller that skipped it would send one.
    const digits = {
      selector: "#1abc",
      query: {
        ast: { kind: "css", css: "#1abc", raw: true },
        mode: "strict",
        level: "none",
      },
    };
    for (const operation of ["target", "check"] as const)
      expect(await operate(operation, digits), operation).toMatchObject({
        ok: false,
        code: "invalid_selector",
        fields: {
          selector: "#1abc",
          reason: "css",
          hint: 'Write ids that start with a digit as [id="1abc"].',
        },
      });
    expect(
      await operate("snapshot", {
        ...digits,
        mode: "full",
        maxChars: 2000,
        maxControls: 20,
        firstRef: 1,
      }),
    ).toMatchObject({
      ok: false,
      code: "invalid_selector",
      fields: { reason: "css" },
    });
  }, 30000);
});

// role= is resolved in the main process, so these run the resolver and the
// accessibility filter against a real tab session over a raw DevTools
// socket, where shadow roots, frames and Chromium's own roles are real.
describe.skipIf(!chromiumAvailable)(
  "role selectors through a tab session",
  () => {
    let site: Server;
    let origin: string;
    let browser: ChromiumBrowser;
    let tab: ChromiumPage | undefined;
    let session: TabSession | undefined;
    let refs: RefBook;
    let resolver: Resolver;
    beforeAll(async () => {
      site = createServer((request, response) => {
        const html =
          selectorPages[new URL(request.url || "/", "http://x").pathname];
        response.writeHead(html ? 200 : 404, { "Content-Type": "text/html" });
        response.end(html || "");
      });
      await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
      origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
      browser = await launchChromium();
    }, 60000);
    afterEach(async () => {
      await session?.release();
      await tab?.close();
      session = undefined;
      tab = undefined;
    });
    afterAll(async () => {
      await browser?.close();
      site?.close();
    }, 60000);
    const step = () => ({ deadline: Date.now() + 15000 });
    // A session on the page with the resolver the routes use, once every
    // frame has loaded.
    const load = async (path: string, frames = 1) => {
      tab = await browser.newPage();
      refs = new RefBook();
      resolver = createResolver({ refs });
      const opened = new TabSession(tab.host, {
        tabId: "tab-1",
        waitForSpaceIdle: async () => {},
        buffer: new EventBufferPool().create("tab-1"),
      });
      session = opened;
      opened.attach();
      await opened.send("Page.navigate", { url: origin + path }, step());
      await vi.waitFor(
        async () => {
          const main = await opened.mainFrameId(step());
          expect(
            await opened.evaluateInFrame(
              main,
              "ready",
              {},
              { ...step(), namespace: "internal" },
            ),
          ).toEqual({ ok: true, readyState: "complete" });
          expect(await opened.frames(step())).toHaveLength(frames);
        },
        { timeout: 15000, interval: 100 },
      );
      return opened;
    };
    const astOf = (selector: string) => {
      const parsed = parseSelector(selector);
      if (!parsed.ok) throw new Error(`${selector}: ${parsed.problem.message}`);
      if (parsed.ast.kind === "ref") throw new Error(`${selector} is a ref`);
      return parsed.ast;
    };
    // A target the way the server sends one, with the mode and level the
    // resolver fills in unless the caller is a wait.
    const run = (
      operation: PageOperation,
      selector: string,
      extra: Partial<Omit<Query, "ast">> = {},
      payload: Record<string, unknown> = {},
    ) =>
      resolver.run(
        "tab-1",
        session!,
        operation,
        { ...payload, selector, query: { ast: astOf(selector), ...extra } },
        { deadline: Date.now() + 15000, namespace: "roles" },
      );
    const waiting = (selector: string, state: WaitState) => ({
      ...waitMode(astOf(selector), state),
      state,
    });
    const read = async (expression: string) => {
      const main = await session!.mainFrameId(step());
      const { sessionId, contextId } = await session!.world(main, step());
      const reply = await session!.send<{ result?: { value?: unknown } }>(
        "Runtime.evaluate",
        { expression, contextId, returnByValue: true },
        { sessionId, deadline: Date.now() + 10000 },
      );
      return reply.result?.value;
    };
    // Which element holds focus, named from its own tree.
    const focused = () =>
      read(
        `(() => { const top = document.activeElement; if (!top) return ""; if (top.shadowRoot) return "shadow:" + (top.shadowRoot.activeElement || {}).id; if (top.localName === "iframe") return "frame:" + ((top.contentDocument || {}).activeElement || {}).id; return top.id })()`,
      );

    it("matches role names exactly and by part", async () => {
      const opened = await load("/selectors/roles", 2);
      // An exact name is Chromium's computed name, case and all.
      expect(await run("focus", 'role=button[name="Save"]')).toMatchObject({
        ok: true,
      });
      expect(await focused()).toBe("save");
      expect(await run("focus", 'role=button[name="save"]')).toMatchObject({
        ok: true,
      });
      expect(await focused()).toBe("saveLower");
      expect(await run("focus", 'role=button[name="SAVE"]')).toMatchObject({
        ok: false,
        code: "no_match",
      });
      // A computed name holding U+00A0 needs it written; a part is normalized.
      expect(
        await run("focus", 'role=button[name="Keep draft"]'),
      ).toMatchObject({
        ok: false,
        code: "no_match",
      });
      expect(
        await run("focus", 'role=button[name="Keep draft"]'),
      ).toMatchObject({ ok: true });
      expect(await focused()).toBe("keep");
      expect(
        await run("focus", 'role=button[name*="keep draft"]'),
      ).toMatchObject({ ok: true });
      expect(await focused()).toBe("keep");
      // Open shadow content and a same-origin frame are found and act.
      expect(
        await run("focus", 'role=button[name*="shadow sav"]'),
      ).toMatchObject({ ok: true });
      expect(await focused()).toBe("shadow:shadowSave");
      expect(
        await run("focus", 'role=button[name="Frame save"]'),
      ).toMatchObject({
        ok: true,
      });
      expect(await focused()).toBe("frame:frameSave");
      // Without a name every button counts, through the aliases.
      expect(await run("focus", "role=button")).toMatchObject({
        ok: false,
        code: "ambiguous_match",
        fields: { count: 7, visible: 7, hidden: 0 },
      });
      expect(await run("focus", 'role=button[name="More"]')).toMatchObject({
        ok: true,
      });
      expect(await focused()).toBe("summary");
      expect(
        await run("check", "role=cell", waiting("role=cell", "visible"), {
          text: "Cell one",
        }),
      ).toMatchObject({ ok: true, matched: true });
      expect(await run("focus", 'role=textbox[name="Notes"]')).toMatchObject({
        ok: true,
      });
      expect(await focused()).toBe("notes");
      expect(await run("target", 'role=img[name="Logo"]')).toMatchObject({
        ok: true,
      });
      expect(await run("focus", 'role=textfield[name="Field"]')).toMatchObject({
        ok: true,
      });
      expect(await focused()).toBe("field");
      // The alias reaches both options of the list, and the name one.
      const option = 'role=ListBoxOption[name="Red"]';
      expect(
        await run("check", option, waiting(option, "visible")),
      ).toMatchObject({ ok: true, matched: true });
      const options = "role=listboxoption";
      expect(
        await run("check", options, waiting(options, "visible")),
      ).toMatchObject({
        ok: false,
        code: "ambiguous_match",
        fields: { count: 2 },
      });
      // The closed shadow button and the date input's own parts are in the
      // tree and resolve into the world, and the page drops both.
      const sources = axSources(
        await opened.knownFrames(step()),
        await opened.mainFrameId(step()),
      );
      const entries = await readAx(opened, sources, step());
      await resetAccessibility(opened, [undefined]);
      expect(
        matchRole(entries, "button", { value: "Sealed save", match: "exact" }),
      ).toHaveLength(1);
      expect(matchRole(entries, "spinbutton").length).toBeGreaterThan(0);
      expect(
        await run("focus", 'role=button[name="Sealed save"]'),
      ).toMatchObject({ ok: false, code: "no_match" });
      expect(await run("focus", "role=spinbutton")).toMatchObject({
        ok: false,
        code: "no_match",
      });
      // Nothing read a user agent shadow root's mode: the renderer answers.
      expect(await read("1 + 1")).toBe(2);
    }, 60000);

    it("fails an ambiguous role= wait at once while raw CSS takes the first match", async () => {
      await load("/selectors/role-twins");
      const name = 'role=button[name="Save"]';
      const ambiguous = await run("check", name, waiting(name, "visible"));
      expect(ambiguous).toMatchObject({
        ok: false,
        code: "ambiguous_match",
        fields: { count: 3, visible: 2, hidden: 1 },
      });
      // The candidates carry refs the book counts as this tab's.
      const candidates = (ambiguous.fields as { candidates: { ref: string }[] })
        .candidates;
      expect(candidates).toHaveLength(3);
      for (const candidate of candidates)
        expect(refs.classify("tab-1", candidate.ref)).toBe("live");
      expect(
        await run("check", "button", waiting("button", "visible"), {
          text: "First copy",
        }),
      ).toMatchObject({ ok: true, matched: true });
    }, 60000);
  },
);
