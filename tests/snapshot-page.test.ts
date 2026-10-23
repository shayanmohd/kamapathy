// Snapshots run through a real tab session over a raw DevTools socket, where
// scrolling, frames and layout behave as they do in Kamapathy's tabs, with
// the resolver the routes use. These tests skip when Playwright's browser is
// not installed.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RefBook } from "../electron/agent/refs";
import { createResolver, type Resolver } from "../electron/agent/resolve";
import { parseSelector } from "../electron/agent/selectors";
import { EventBufferPool } from "../electron/agent/session/event-buffer";
import { TabSession } from "../electron/agent/session/tab-session";
import {
  chromiumAvailable,
  launchChromium,
  type ChromiumBrowser,
  type ChromiumPage,
} from "./cdp-socket";
import { snapshotPages } from "./fixtures/snapshot-pages.mjs";

// A viewport shorter than a section, so a scroll leaves whole sections out.
const VIEWPORT = { width: 900, height: 600 };

type Control = {
  ref: string;
  tag: string;
  label: string;
  href?: string;
};
type Offsets = { text: number; control: number; line: number };
type Listing = {
  text: string;
  interactables: Control[];
  rebound?: string[];
  next?: Offsets;
  omittedControls?: number;
  truncated?: boolean;
  ok?: false;
  code?: string;
  fields?: Record<string, unknown>;
};

describe.skipIf(!chromiumAvailable)("snapshots through a tab session", () => {
  const sites: Server[] = [];
  let origin: string;
  let other: string;
  let browser: ChromiumBrowser;
  let tab: ChromiumPage | undefined;
  let session: TabSession | undefined;
  let refs: RefBook;
  let resolver: Resolver;
  // The same pages on two ports, so one frame is from another origin.
  const serve = async () => {
    const site = createServer((request, response) => {
      const html =
        snapshotPages[new URL(request.url || "/", "http://x").pathname];
      response.writeHead(html ? 200 : 404, { "Content-Type": "text/html" });
      response.end(html ? html.replaceAll("{{other}}", other) : "");
    });
    sites.push(site);
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  };
  beforeAll(async () => {
    other = await serve();
    origin = await serve();
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
    for (const site of sites) site.close();
  }, 60000);
  const step = () => ({ deadline: Date.now() + 15000 });
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
    // A known viewport, so what a scroll leaves on screen is known too.
    await opened.send(
      "Emulation.setDeviceMetricsOverride",
      { ...VIEWPORT, deviceScaleFactor: 1, mobile: false },
      step(),
    );
    await opened.send("Page.navigate", { url: origin + path }, step());
    await vi.waitFor(
      async () => {
        const main = await opened.mainFrameId(step());
        expect(
          await opened.evaluateInFrame(
            main,
            "ready",
            {},
            {
              ...step(),
              namespace: "internal",
            },
          ),
        ).toEqual({ ok: true, readyState: "complete" });
        expect(await opened.frames(step())).toHaveLength(frames);
      },
      { timeout: 15000, interval: 100 },
    );
    return opened;
  };
  const run = (
    operation: "snapshot" | "focus",
    payload: Record<string, unknown>,
  ) =>
    resolver.run("tab-1", session!, operation, payload, {
      deadline: Date.now() + 15000,
      namespace: "snapshots",
    });
  const snapshot = (request: Record<string, unknown> = {}) =>
    run("snapshot", {
      mode: "full",
      maxChars: 24000,
      maxControls: 100,
      scope: "page",
      ...request,
    }) as Promise<Listing>;
  // A scope as the server sends it: a ref as root, anything else parsed.
  const scopeTo = (selector: string) => {
    const parsed = parseSelector(selector);
    if (!parsed.ok) throw new Error(`${selector}: ${parsed.problem.message}`);
    return parsed.ast.kind === "ref"
      ? { root: parsed.ast.ref }
      : { selector, query: { ast: parsed.ast } };
  };
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
  const refFor = (listing: Listing, label: string) =>
    listing.interactables.find((control) => control.label === label)!.ref;

  it("keeps only on-screen content in viewport scope, frames included", async () => {
    await load("/snapshot/sections", 3);
    const whole = await snapshot();
    for (const text of [
      "Top section text",
      "Middle section text",
      "Bottom section text",
      "Frame near text",
      "Frame far text",
      "Card top text",
      "Card bottom text",
    ])
      expect(whole.text, text).toContain(text);
    const top = refFor(whole, "Top button");
    const card = whole.interactables.find(
      (control) => control.tag === "div",
    )!.ref;
    expect(
      await read(
        "window.scrollTo(0, document.getElementById('middle').offsetTop), window.scrollY",
      ),
    ).toBe(2000);
    const shown = await snapshot({ scope: "viewport" });
    for (const text of [
      "Middle section text",
      "Frame near text",
      "Card top text",
    ])
      expect(shown.text, text).toContain(text);
    for (const text of [
      "Top section text",
      "Bottom section text",
      "Frame far text",
      "Card bottom text",
    ])
      expect(shown.text, text).not.toContain(text);
    const labels = shown.interactables.map((control) => control.label);
    expect(labels).toContain("Middle button");
    expect(labels).toContain("Frame button");
    for (const label of [
      "Top button",
      "Bottom button",
      "Card button",
      "Frame far button",
    ])
      expect(labels, label).not.toContain(label);
    // A root keeps only the part of its own subtree that is on screen.
    const rooted = await snapshot({ scope: "viewport", root: card });
    expect(rooted.text).toContain("Card top text");
    expect(rooted.text).not.toContain("Card bottom text");
    expect(rooted.text).not.toContain("Middle section text");
    // Nothing left the registry, so a control left out still acts.
    expect(await run("focus", { ref: top })).toMatchObject({ ok: true });
  }, 60000);

  it("scopes to a control ref, a selector of any form and a frame's document", async () => {
    await load("/snapshot/sections", 3);
    const whole = await snapshot();
    const middle = refFor(whole, "Middle button");
    const rooted = await snapshot({ root: middle });
    expect(rooted.text).toBe("Middle button");
    expect(rooted.rebound).toBeUndefined();
    // A control the page draws again keeps its ref, which is reported.
    await read(
      `(() => { const button = document.getElementById("middleButton"); button.replaceWith(button.cloneNode(true)) })()`,
    );
    const again = await snapshot({ root: middle });
    expect(again.rebound).toEqual([middle]);
    expect(again.text).toBe("Middle button");
    for (const [selector, expected] of [
      ["#card", "Card top text"],
      ["css=#card", "Card top text"],
      ["text=Card top text", "Card top text"],
      ['role=button[name="Card button"]', "Card button"],
      ["//div[@id='card']", "Card top text"],
    ] as const) {
      const scoped = await snapshot(scopeTo(selector));
      expect(scoped.text, selector).toContain(expected);
      expect(scoped.text, selector).not.toContain("Middle section text");
    }
    // A frame of this origin scopes to its own document.
    const framed = await snapshot(scopeTo("#inner"));
    expect(framed.text).toContain("Frame near text");
    expect(framed.text).toContain("Frame far text");
    expect(framed.interactables.map((control) => control.label)).toEqual([
      "Frame button",
      "Frame far button",
    ]);
    expect(await snapshot(scopeTo("#outer"))).toMatchObject({
      ok: false,
      code: "cross_origin_frame",
    });
    // A scope selector matches at level none, where hidden copies count.
    expect(await snapshot(scopeTo(".twin"))).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      fields: { count: 2, visible: 1, hidden: 1 },
    });
  }, 60000);

  it("covers the page in parts without repeats", async () => {
    await load("/snapshot/parts");
    // Every part the page gives for one set of bounds, from its own next.
    const cover = async (bounds: Record<string, unknown>) => {
      const parts: Listing[] = [];
      let offsets: Offsets = { text: 0, control: 0, line: 0 };
      for (let part = 0; part < 30; part += 1) {
        const got = await snapshot({ mode: "compact", ...bounds, offsets });
        parts.push(got);
        if (!got.next) break;
        // A part that cannot advance would repeat itself forever.
        expect(
          got.next.text > offsets.text || got.next.control > offsets.control,
          `part ${part}`,
        ).toBe(true);
        offsets = got.next;
      }
      expect(parts.at(-1)!.next).toBeUndefined();
      return parts;
    };
    const parts = await cover({ maxChars: 500, maxControls: 5 });
    expect(parts.length).toBeGreaterThan(3);
    // The whole page, read after the parts so their refs are the page's.
    const whole = await snapshot({ mode: "compact" });
    expect(whole.truncated).toBe(false);
    expect(parts.map((part) => part.text).join("")).toBe(whole.text);
    // Every control the whole page lists, once, in ranked order instead of
    // page order, and each part's controls back in page order.
    const refsOf = (listing: Listing | Listing[]) =>
      ([] as Listing[])
        .concat(listing)
        .flatMap((part) => part.interactables.map((control) => control.ref));
    expect(refsOf(parts).sort()).toEqual(refsOf(whole).sort());
    expect(new Set(refsOf(parts)).size).toBe(refsOf(whole).length);
    expect(refsOf(parts)).not.toEqual(refsOf(whole));
    const order = refsOf(whole);
    for (const part of parts) {
      const inPart = refsOf(part);
      expect(inPart).toEqual(
        [...inPart].sort(
          (first, second) => order.indexOf(first) - order.indexOf(second),
        ),
      );
    }
    // The action bar at the end of the page is in the first part.
    expect(parts[0].interactables.map((control) => control.label)).toContain(
      "Submit",
    );
    // A part only ever issues refs inside the block of 100 it reserved.
    const base = Number(parts[0].interactables[0].ref.slice(2));
    for (const [index, part] of parts.entries())
      for (const control of part.interactables) {
        const number = Number(control.ref.slice(2));
        expect(number, control.ref).toBeGreaterThanOrEqual(base + index * 100);
        expect(number, control.ref).toBeLessThan(base + (index + 1) * 100);
        expect(refs.classify("tab-1", control.ref), control.ref).toBe("live");
      }

    // One character at a time still advances, by one character.
    const slow = await snapshot({
      mode: "compact",
      maxChars: 1,
      offsets: { text: 0, control: 0, line: 0 },
    });
    expect(slow.text).toBe(whole.text.slice(0, 1));
    expect(slow.next).toMatchObject({ text: 1 });
    const second = await snapshot({
      mode: "compact",
      maxChars: 1,
      offsets: slow.next!,
    });
    expect(second.text).toBe(whole.text.slice(1, 2));
    expect(second.next).toMatchObject({ text: 2 });
    // Bounds of 0 cannot print their half of the page, so they never ask
    // for it again: the controls cover, the text does not, and the other
    // way round, and neither leaves a part that cannot advance.
    const textless = await cover({ maxChars: 0, maxControls: 5 });
    expect(refsOf(textless).sort()).toEqual(refsOf(whole).sort());
    expect(textless.every((part) => part.text === "")).toBe(true);
    expect(textless.at(-1)!.truncated).toBe(true);
    const controlless = await cover({ maxChars: 500, maxControls: 0 });
    expect(controlless.map((part) => part.text).join("")).toBe(whole.text);
    expect(refsOf(controlless)).toEqual([]);
    expect(controlless[0].omittedControls).toBe(refsOf(whole).length);
    const neither = await cover({ maxChars: 0, maxControls: 0 });
    expect(neither).toHaveLength(1);
    expect(neither[0].truncated).toBe(true);
  }, 60000);

  it("lists absolute http, https, mailto and tel links", async () => {
    await load("/snapshot/links");
    const listing = await snapshot();
    expect(
      Object.fromEntries(
        listing.interactables.map((control) => [control.label, control.href]),
      ),
    ).toEqual({
      Catalog: "http://example.com/catalog",
      Account: "https://example.com/account?tab=plans#fees",
      "Mail us": "mailto:help@example.com?subject=Order",
      "Call us": "tel:+15550100",
      Orders: `${origin}/orders/4?from=list`,
      // A script link and a link over 2,048 characters carry none.
      "Run a script": undefined,
      "A long link": undefined,
    });
  }, 60000);
});
