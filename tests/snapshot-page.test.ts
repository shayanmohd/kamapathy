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
import {
  findLocators,
  LOCATOR_GROUP,
  type LocatorSource,
} from "../electron/agent/locators";
import { createFrameGroups } from "../electron/agent/frames/groups";
import { RefBook } from "../electron/agent/refs";
import { createResolver, type Resolver } from "../electron/agent/resolve";
import { parseSelector } from "../electron/agent/selectors";
import type { AutomationController } from "../electron/agent/server";
import {
  createSnapshots,
  optionsHash,
  readCursor,
  type SnapshotRequest,
} from "../electron/agent/snapshot";
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
  role?: string;
  label: string;
  href?: string;
  locator?: string;
};
type Offsets = { text: number; control: number; line: number };
type Listing = {
  text: string;
  outline?: string;
  interactables: Control[];
  rebound?: string[];
  next?: Offsets;
  omittedControls?: number;
  truncated?: boolean;
  locatorSources?: LocatorSource[];
  locatorsIncomplete?: true;
  ok?: false;
  code?: string;
  fields?: Record<string, unknown>;
};
// A part as the snapshot path answers it, with the cursor to the next one.
type Part = Omit<Listing, "next"> & { next?: string };

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
  // Snapshots as the routes and the CLI take them: every frame group of the
  // page read with its frame context, and the reads composed, with the
  // routes' compact bounds unless a request gives its own.
  const routes = (opened: TabSession) => {
    const groups = createFrameGroups(opened, { refs, tabId: "tab-1" });
    const snapshots = createSnapshots({
      controller: { state: { tabs: [] } } as unknown as AutomationController,
      evaluatePage: (
        tabId,
        tabSession,
        operation,
        payload,
        deadline,
        inner,
        frameId,
      ) =>
        resolver.run(tabId, tabSession, operation, payload, {
          deadline,
          namespace: "snapshots",
          signal: inner?.signal,
          guard: inner?.guard,
          ...(frameId === undefined ? {} : { frameId }),
        }),
      resolver,
      namespace: () => "snapshots",
      frames: { for: () => groups, dispose: () => {} },
    });
    return (request: Partial<SnapshotRequest> = {}) =>
      snapshots.take(
        "tab-1",
        opened,
        {
          mode: "compact",
          maxChars: 4000,
          maxControls: 40,
          scope: "page",
          format: "list",
          locators: false,
          header: false,
          ...request,
        },
        Date.now() + 15000,
        step(),
      ) as Promise<Part>;
  };
  // Every part one set of bounds gives, each from the last one's cursor.
  const partsOf = async (
    take: ReturnType<typeof routes>,
    request: Partial<SnapshotRequest>,
  ) => {
    const parts: Part[] = [];
    let cursor: string | undefined;
    for (let part = 0; part < 40; part += 1) {
      const got = await take({
        ...request,
        ...(cursor === undefined ? {} : { cursor }),
      });
      parts.push(got);
      if (!got.next) return parts;
      cursor = got.next;
    }
    throw new Error(`The parts of one page must end: ${JSON.stringify(request)}`);
  };

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
    // An outline of the same scope keeps the same part of the page.
    const shape = await snapshot({ scope: "viewport", format: "outline" });
    expect(shape.outline).toContain('button "Middle button"');
    expect(shape.outline).toContain('"Middle section text"');
    for (const gone of [
      "Top section text",
      "Bottom section text",
      "Frame far text",
      "Frame far button",
    ])
      expect(shape.outline, gone).not.toContain(gone);
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
    // A frame from another origin is read by its own group, so the scope
    // stops at the owner and the main process reads that frame.
    expect(await snapshot(scopeTo("#outer"))).toMatchObject({
      text: "",
      interactables: [
        {
          role: "iframe",
          label: "Other origin",
          crossOrigin: true,
          contentFrame: "0",
        },
      ],
    });
    // A scope selector matches at level none, where hidden copies count.
    expect(await snapshot(scopeTo(".twin"))).toMatchObject({
      ok: false,
      code: "ambiguous_match",
      fields: { count: 2, visible: 1, hidden: 1 },
    });
    // An outline gives every frame a ref, and that ref reads its document.
    const outlined = await snapshot({ format: "outline" });
    const frameOf = (label: string) =>
      outlined.interactables.find(
        (control) => control.tag === "iframe" && control.label === label,
      )!;
    const inner = frameOf("Inner notes");
    const outer = frameOf("Other origin");
    // A frame of this origin carries its document's lines beneath it.
    expect(outlined.outline!.replace(/ @e\d+/g, " @e")).toContain(
      [
        'iframe "Inner notes" @e',
        '  "Frame near text"',
        '  button "Frame button" @e',
        '  "Frame far text"',
        '  button "Frame far button" @e',
      ].join("\n"),
    );
    expect(outlined.outline).toContain(
      `iframe "Other origin" ${outer.ref} (not read)`,
    );
    const document = await snapshot({ format: "outline", root: inner.ref });
    expect(document.outline).toContain('"Frame near text"');
    expect(document.outline).toContain('button "Frame button" @e');
    expect(document.outline).toContain('"Frame far text"');
    // A control ref reads its own subtree.
    expect(await snapshot({ format: "outline", root: middle })).toMatchObject({
      outline: `button "Middle button" ${middle}`,
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
          got.next.text > offsets.text ||
            got.next.control > offsets.control ||
            got.next.line > offsets.line,
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

    // An outline advances by line: every line is printed once, after the
    // ancestors a continued part repeats to place it.
    const outlines = await cover({
      format: "outline",
      maxChars: 300,
      maxControls: 3,
    });
    expect(outlines.length).toBeGreaterThan(3);
    const wholeOutline = (
      await snapshot({
        mode: "compact",
        format: "outline",
      })
    ).outline!.split("\n");
    let from = 0;
    let repeated = 0;
    for (const [index, part] of outlines.entries()) {
      const printed = part.outline!.split("\n");
      const to = part.next ? part.next.line : wholeOutline.length;
      expect(to, `part ${index}`).toBeGreaterThan(from);
      const fresh = wholeOutline.slice(from, to);
      expect(
        printed.slice(printed.length - fresh.length),
        `part ${index}`,
      ).toEqual(fresh);
      // Whatever opens a part instead repeats a line from an earlier one.
      for (const before of printed.slice(0, printed.length - fresh.length))
        expect(wholeOutline.slice(0, from), `part ${index}`).toContain(before);
      repeated += printed.length - fresh.length;
      from = to;
    }
    expect(from).toBe(wholeOutline.length);
    expect(repeated).toBeGreaterThan(0);
    // Bounds of 0 still advance one line per part.
    let line: Offsets = { text: 0, control: 0, line: 0 };
    for (let part = 0; part < 4; part += 1) {
      const got = await snapshot({
        mode: "compact",
        format: "outline",
        maxChars: 0,
        maxControls: 0,
        offsets: line,
      });
      expect(got.next!.line, `part ${part}`).toBe(line.line + 1);
      line = got.next!;
    }
  }, 60000);

  it("prints the outline with structure, href and an open dialog first", async () => {
    await load("/snapshot/outline");
    // The form on its own first, so the whole shape of a part, with the
    // refs it issued in print order, is one assertion.
    const form = await snapshot({ format: "outline", ...scopeTo("#order") });
    const issued = form.interactables.map((control) => control.ref);
    expect(form.outline).toBe(
      [
        'form "Order"',
        '  group "Delivery"',
        `    radio "Pickup" ${issued[0]} [checked] group "Delivery"`,
        `    radio "Courier" ${issued[1]} [unchecked] group "Delivery"`,
        `  textbox "Password" ${issued[2]} (value hidden)`,
        `  combobox "Tier" ${issued[3]} value="pro"`,
        '    option "Free"',
        '    option "Pro" value="pro" [selected]',
        `  button "Papers" ${issued[4]} file upload: multiple; accepts .pdf`,
        `  button "Save" ${issued[5]}`,
      ].join("\n"),
    );
    expect(form.text).toBeUndefined();
    expect(form.truncated).toBe(false);
    // The refs of one part run through its own block, in print order.
    const numbers = issued.map((ref) => Number(ref.slice(2)));
    expect(numbers).toHaveLength(6);
    expect(numbers).toEqual(numbers.map((_unused, at) => numbers[0] + at));

    const whole = await snapshot({ format: "outline" });
    const lines = whole.outline!.split("\n");
    // An open dialog comes first, with the rest of the page after it.
    expect(lines.slice(0, 3)).toEqual([
      'dialog "Confirm"',
      '  "Dialog text"',
      `  button "OK" ${refFor(whole, "OK")}`,
    ]);
    // Refs appear on control and frame lines only, in listing order.
    expect(
      Array.from(whole.outline!.matchAll(/@e\d+/g)).map((found) => found[0]),
    ).toEqual(whole.interactables.map((control) => control.ref));
    // Refs vary with what the page issued before, so the lines are compared
    // without them, each between the newlines around its own line.
    const shown = `\n${whole.outline!.replace(/ @e\d+/g, " @e")}\n`;
    for (const line of [
      "\nbanner\n",
      '\n  link "Plans" @e href=/plans?tier=pro#faq\n',
      '\n  link "Pricing elsewhere" @e href=http://other.example/pricing\n',
      '\nnavigation "Sections"\n',
      "\n  list\n",
      "\n    listitem\n",
      '\n      link "One" @e href=/one\n',
      '\n    listitem "Just text"\n',
      "\nmain\n",
      '\n  heading "Plans" level=2\n',
      '\n  region "Pictures"\n',
      '\n    img "Company logo"\n',
      "\n    canvas\n",
      '\n  "Plain section text"\n',
      '\n  table "Prices"\n',
      "\n    row\n",
      '\n      columnheader "Plan"\n',
      '\n      columnheader "Price"\n',
      '\n      cell "Pro"\n',
      '\n      cell "9"\n',
      // An unnamed form is transparent, so its field sits under main.
      '\n  textbox "Loose field" @e\n',
      '\n    button "More" @e [collapsed]\n',
      // A page that names nothing leaves the name out; the value stays.
      '\n  textbox @e value="Editable note"\n',
      "\ncomplementary\n",
      '\n  "Aside text"\n',
      "\nsearch\n",
      '\n  searchbox "Find" @e\n',
      "\ncontentinfo\n",
      '\n  "Footer text"\n',
    ])
      expect(shown, line).toContain(line);
    // An unnamed image and an empty list and listitem print nothing.
    expect(lines.filter((line) => line.trim().startsWith("img "))).toHaveLength(
      1,
    );
    expect(lines.filter((line) => line.trim() === "list")).toHaveLength(1);
    expect(lines.filter((line) => line.trim() === "listitem")).toHaveLength(1);
    // Long text continues on the next line, in JSON strings.
    const long = lines.findIndex((line) => line.startsWith('  "Long text'));
    expect(long).toBeGreaterThan(0);
    for (const line of lines.slice(long, long + 2))
      expect(line.trim().length).toBeLessThanOrEqual(400);
    expect(
      lines
        .slice(long, long + 2)
        .map((line) => JSON.parse(line.trim()) as string)
        .join(""),
    ).toBe("Long text about the plans. ".repeat(20).trim());
    expect(lines[long + 2].startsWith('  "')).toBe(false);

    // A select prints its options, up to today's budget of 20.
    const many = await snapshot({ format: "outline", ...scopeTo("#many") });
    const chosen = many.outline!.split("\n");
    expect(chosen[0]).toBe(
      `combobox "Size" ${many.interactables[0].ref} value="s1" (more options)`,
    );
    expect(chosen[1]).toBe('  option "Size 1" value="s1" [selected]');
    expect(chosen).toHaveLength(21);
    expect(many.truncated).toBe(true);
  }, 60000);

  it("prints an open dialog first in a full-page outline taken as the routes take it", async () => {
    const opened = await load("/snapshot/outline");
    const alone = await snapshot({ format: "outline" });
    // The routes and the CLI read the page frame group by frame group and
    // compose what the reads report, even on a page without frames.
    const groups = createFrameGroups(opened, { refs, tabId: "tab-1" });
    const snapshots = createSnapshots({
      controller: { state: { tabs: [] } } as unknown as AutomationController,
      evaluatePage: (
        tabId,
        tabSession,
        operation,
        payload,
        deadline,
        inner,
        frameId,
      ) =>
        resolver.run(tabId, tabSession, operation, payload, {
          deadline,
          namespace: "snapshots",
          signal: inner?.signal,
          guard: inner?.guard,
          ...(frameId === undefined ? {} : { frameId }),
        }),
      resolver,
      namespace: () => "snapshots",
      frames: { for: () => groups, dispose: () => {} },
    });
    const whole = (await snapshots.take(
      "tab-1",
      opened,
      {
        mode: "full",
        maxChars: 24000,
        maxControls: 100,
        scope: "page",
        format: "outline",
        locators: false,
        header: false,
      },
      Date.now() + 15000,
      step(),
    )) as Listing;
    expect(whole.outline!.split("\n").slice(0, 4)).toEqual([
      'dialog "Confirm"',
      '  "Dialog text"',
      `  button "OK" ${refFor(whole, "OK")}`,
      "banner",
    ]);
    // Composing one document changes nothing: the same lines, and the
    // controls listed in the order they print.
    expect(whole.outline).toBe(alone.outline);
    expect(whole.interactables.map((control) => control.ref)).toEqual(
      alone.interactables.map((control) => control.ref),
    );
  }, 60000);

  it("covers the page in outline parts taken as the routes take them", async () => {
    const take = routes(await load("/snapshot/parts"));
    const whole = (
      await take({ format: "outline", maxChars: 24000, maxControls: 100 })
    ).outline!.split("\n");
    const refsIn = (lines: readonly string[]) =>
      lines.flatMap((line) => line.match(/@e\d+/g) ?? []);
    expect(refsIn(whole)).toHaveLength(12);
    const lineOf = (cursor: string) =>
      readCursor(cursor, { h: optionsHash({ scope: "page", format: "outline" }) })
        .l;
    // The skill suite's bounds, then a control bound that binds first.
    for (const bounds of [
      { maxChars: 600 },
      { maxChars: 300, maxControls: 3 },
    ]) {
      const name = JSON.stringify(bounds);
      const parts = await partsOf(take, { format: "outline", ...bounds });
      expect(parts.length, name).toBeGreaterThan(1);
      // Each part prints the lines from its cursor to the next one's, after
      // whatever it repeats from earlier parts to place them.
      let from = 0;
      for (const [index, part] of parts.entries()) {
        const printed = part.outline!.split("\n");
        const to = part.next ? lineOf(part.next) : whole.length;
        expect(to, `${name} part ${index}`).toBeGreaterThan(from);
        const fresh = whole.slice(from, to);
        expect(printed.slice(printed.length - fresh.length)).toEqual(fresh);
        for (const before of printed.slice(0, printed.length - fresh.length))
          expect(whole.slice(0, from), `${name} part ${index}`).toContain(before);
        // maxControls bounds the control lines a part adds.
        expect(refsIn(fresh).length, `${name} part ${index}`).toBeLessThanOrEqual(
          bounds.maxControls ?? 40,
        );
        // A part lists the controls it printed.
        expect(part.interactables.map((control) => control.ref)).toEqual(
          refsIn(printed),
        );
        from = to;
      }
      expect(from, name).toBe(whole.length);
      // Every ref of the page comes back, once.
      expect(
        refsIn(parts.flatMap((part) => part.outline!.split("\n"))),
        name,
      ).toEqual(refsIn(whole));
    }
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

  it("prefers test-id locators and skips duplicate hrefs and generated ids", async () => {
    const opened = await load("/snapshot/locators");
    const pageUrl = `${origin}/snapshot/locators`;
    const sent = vi.spyOn(opened, "send");
    // The page reports what a locator may be built from, for the controls
    // this part printed and nothing else.
    const listing = await snapshot({ locators: true });
    expect(listing.locatorSources?.map((source) => source.ref)).toEqual(
      listing.interactables.map((control) => control.ref),
    );
    expect(listing.locatorSources![0]).toEqual({
      ref: listing.interactables[0].ref,
      tag: "button",
      attributes: { "data-testid": "save-button", id: "save" },
    });
    const pass = (budgetMs?: number) =>
      findLocators({
        session: opened,
        resolver,
        tabId: "tab-1",
        namespace: "snapshots",
        sources: listing.locatorSources!,
        pageUrl,
        deadline: Date.now() + 15000,
        step: step(),
        ...(budgetMs === undefined ? {} : { budgetMs }),
      });
    const found = await pass();
    expect(found.incomplete).toBe(false);
    const expected = [
      ["Save", 'css=[data-testid="save-button"]'],
      ["Checkout", "css=#checkout-form"],
      ["Ship it", 'role=button[name="Ship it"]'],
      // A generated id is skipped, so the role names this one.
      ["Archive", 'role=button[name="Archive"]'],
      // Two fields of one name fall through to their placeholders.
      ["Note", 'css=input[placeholder="First note"]'],
      ["Note", 'css=input[placeholder="Second note"]'],
      ["Open", "href=/one"],
      ["Open", "href=/two"],
      // Two links of one name to one path, with generated ids, have
      // nothing that names either alone.
      ["Shared", undefined],
      ["Shared", undefined],
    ];
    expect(
      listing.interactables.map((control) => [
        control.label,
        found.locators.get(control.ref),
      ]),
    ).toEqual(expected);
    // The pass reads the tree once, hands the renderer's accessibility
    // state back and keeps no objects.
    expect(
      sent.mock.calls
        .map(([method]) => method)
        .filter((method) => method.startsWith("Accessibility.")),
    ).toEqual([
      "Accessibility.getFullAXTree",
      "Accessibility.enable",
      "Accessibility.disable",
    ]);
    expect(
      sent.mock.calls.some(
        ([method, params]) =>
          method === "Runtime.releaseObjectGroup" &&
          (params as { objectGroup?: string }).objectGroup === LOCATOR_GROUP,
      ),
    ).toBe(true);
    sent.mockRestore();
    // A budget already spent ends the pass with what it has.
    expect(await pass(0)).toEqual({ locators: new Map(), incomplete: true });
    // Every locator resolves through the resolver to its own control alone.
    const resolves = async (controls: readonly Control[]) => {
      for (const control of controls) {
        if (!control.locator) continue;
        const scoped = await snapshot(scopeTo(control.locator));
        expect(
          scoped.interactables.map((inside) => inside.ref),
          control.locator,
        ).toEqual([control.ref]);
      }
    };
    await resolves(
      listing.interactables.map((control) => ({
        ...control,
        locator: found.locators.get(control.ref),
      })),
    );

    // The snapshot path puts each locator on its control, in both formats,
    // and keeps the page's sources to itself.
    // The snapshot reads each frame group of the page, so it is given the
    // tab's frame map as the server gives it.
    const groups = createFrameGroups(opened, { refs, tabId: "tab-1" });
    const snapshots = createSnapshots({
      controller: { state: { tabs: [] } } as unknown as AutomationController,
      evaluatePage: (
        tabId,
        tabSession,
        operation,
        payload,
        deadline,
        inner,
        frameId,
      ) =>
        resolver.run(tabId, tabSession, operation, payload, {
          deadline,
          namespace: "snapshots",
          signal: inner?.signal,
          guard: inner?.guard,
          ...(frameId === undefined ? {} : { frameId }),
        }),
      resolver,
      namespace: () => "snapshots",
      frames: { for: () => groups, dispose: () => {} },
    });
    const take = (request: Partial<SnapshotRequest> = {}) =>
      snapshots.take(
        "tab-1",
        opened,
        {
          mode: "full",
          maxChars: 24000,
          maxControls: 100,
          scope: "page",
          format: "list",
          header: false,
          locators: true,
          ...request,
        },
        Date.now() + 15000,
        step(),
      ) as Promise<Listing>;
    const taken = await take();
    expect(taken.locatorSources).toBeUndefined();
    expect(taken.locatorsIncomplete).toBeUndefined();
    expect(
      taken.interactables.map((control) => [control.label, control.locator]),
    ).toEqual(expected);
    const shape = await take({ format: "outline" });
    expect(shape.outline!.replace(/@e\d+/g, "@e").split("\n")).toEqual([
      'button "Save" @e locator: css=[data-testid="save-button"]',
      'button "Checkout" @e locator: css=#checkout-form',
      'button "Ship it" @e locator: role=button[name="Ship it"]',
      'button "Archive" @e locator: role=button[name="Archive"]',
      'textbox "Note" @e locator: css=input[placeholder="First note"]',
      'textbox "Note" @e locator: css=input[placeholder="Second note"]',
      'link "Open" @e href=/one locator: href=/one',
      'link "Open" @e href=/two locator: href=/two',
      'link "Shared" @e href=/shared',
      'link "Shared" @e href=/shared',
    ]);

    // A locator outlives the refs: the same page again names the same
    // controls, and each one resolves to its new ref.
    await opened.send("Page.reload", {}, step());
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
      },
      { timeout: 15000, interval: 100 },
    );
    const after = await take();
    expect(
      after.interactables.map((control) => [control.label, control.locator]),
    ).toEqual(expected);
    await resolves(after.interactables);
  }, 60000);
});
