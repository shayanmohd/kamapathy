// Snapshots over real cross-site frames, driven through the raw DevTools
// socket, where frame groups, their worlds and their layout behave as they do
// in Kamapathy's tabs. The whole suite runs twice: once with Chromium's site
// isolation, and once without it, where a frame from another site stays in the
// page's own process. These tests skip when Playwright's browser is not
// installed.
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
import { ApiError } from "../electron/agent/errors";
import {
  createFrameGroups,
  type FrameGroups,
} from "../electron/agent/frames/groups";
import { RefBook } from "../electron/agent/refs";
import { createResolver, type Resolver } from "../electron/agent/resolve";
import { parseSelector } from "../electron/agent/selectors";
import type { AutomationController } from "../electron/agent/server";
import {
  createSnapshots,
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
import { framePages } from "./fixtures/frame-pages.mjs";

type Control = {
  ref: string;
  role?: string;
  label: string;
  frame?: string;
  crossOrigin?: true;
  origin?: string;
  contentFrame?: string;
  content?: string;
  value?: string;
  valueHidden?: true;
};
type Listing = {
  url: string;
  title: string;
  text: string;
  outline?: string;
  interactables: Control[];
  unreadFrames?: number;
  truncated?: boolean;
  next?: string;
};

// The fixtures on two ports of one server, so a page can hold a frame of
// another site (the other loopback name) beside one of its own site on
// another port, which Chromium keeps in the page's process.
async function startPages(): Promise<{
  ports: number[];
  close(): Promise<void>;
}> {
  const ports: number[] = [];
  const serve = (self: number) =>
    createServer((request, response) => {
      const path = new URL(request.url || "/", "http://x").pathname;
      const html = framePages[path];
      response.writeHead(html === undefined ? 404 : 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      if (html === undefined) return response.end("");
      const name = (request.headers.host ?? "").split(":")[0];
      const across = name === "localhost" ? "127.0.0.1" : "localhost";
      const other = ports[self === 0 ? 1 : 0];
      response.end(
        html
          .replaceAll("{{other}}", `http://${across}:${ports[self]}`)
          .replaceAll("{{otherPort}}", `http://${name}:${other}`),
      );
    });
  const servers: Server[] = [serve(0), serve(1)];
  for (const server of servers) {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    ports.push((server.address() as AddressInfo).port);
  }
  return {
    ports,
    close: async () => {
      for (const server of servers) server.close();
    },
  };
}

const ISOLATION = [
  { name: "with site isolation", isolated: true, args: [] as string[] },
  {
    name: "without site isolation",
    isolated: false,
    args: [
      "--disable-site-isolation-trials",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  },
];

for (const mode of ISOLATION)
  describe.skipIf(!chromiumAvailable)(`frame snapshots ${mode.name}`, () => {
    let pages: Awaited<ReturnType<typeof startPages>>;
    let origin = "";
    let browser: ChromiumBrowser;
    let page: ChromiumPage | undefined;
    let session: TabSession | undefined;
    let groups: FrameGroups | undefined;
    let resolver: Resolver;
    let refs: RefBook;
    let snapshots: ReturnType<typeof createSnapshots> | undefined;
    beforeAll(async () => {
      pages = await startPages();
      origin = `http://127.0.0.1:${pages.ports[0]}`;
      browser = await launchChromium({ args: mode.args });
    }, 60000);
    const shut = async () => {
      groups?.dispose();
      await session?.release();
      await page?.close();
      groups = undefined;
      session = undefined;
      snapshots = undefined;
      page = undefined;
    };
    afterEach(shut, 20000);
    afterAll(async () => {
      await browser?.close();
      await pages?.close();
    }, 30000);

    const step = () => ({ deadline: Date.now() + 20000 });
    // Opens the path with a session attached before it loads, and waits for
    // its frames. A frame's first document, about:blank, is complete at
    // once, so the frames are counted only once the page itself is.
    const open = async (path: string, frames: number) => {
      await shut();
      page = await browser.newPage();
      const opened = new TabSession(page.host, {
        tabId: "tab-1",
        waitForSpaceIdle: async () => {},
        buffer: new EventBufferPool().create("tab-1"),
      });
      session = opened;
      opened.attach();
      await opened.send(
        "Emulation.setDeviceMetricsOverride",
        { width: 900, height: 700, deviceScaleFactor: 1, mobile: false },
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
              { ...step(), namespace: "internal" },
            ),
          ).toEqual({ ok: true, readyState: "complete" });
          const known = await opened.frames(step());
          expect(known).toHaveLength(frames);
          // Every frame has committed a document of its own site, so a read
          // of it carries that document's origin rather than the empty one
          // a frame starts with.
          expect(
            known.filter((frame) => /^https?:\/\//.test(frame.origin)),
          ).toHaveLength(frames);
        },
        { timeout: 20000, interval: 100 },
      );
      refs = new RefBook();
      groups = createFrameGroups(opened, { refs, tabId: "tab-1" });
      const held = groups;
      // The resolver searches this tab's frame groups, as it does behind a
      // route, so a selector covers the whole page.
      resolver = createResolver({
        refs,
        frames: { for: () => held, dispose: () => {} },
      });
      snapshots = createSnapshots({
        controller: {
          state: { tabs: [{ id: "tab-1", url: origin + path, title: "" }] },
        } as unknown as AutomationController,
        // The page call a route makes: the resolver's run, with the page's
        // own refusal raised as the error a route would answer.
        evaluatePage: async (
          tabId,
          tabSession,
          operation,
          payload,
          deadline,
          inner,
          frameId,
        ) => {
          const result = await resolver.run(
            tabId,
            tabSession,
            operation,
            payload,
            {
              deadline,
              namespace: "frames",
              ...(inner?.signal ? { signal: inner.signal } : {}),
              ...(frameId === undefined ? {} : { frameId }),
            },
          );
          if (result?.ok === false)
            throw new ApiError(
              typeof result.code === "string"
                ? result.code
                : "element_action_failed",
              String(result.error),
              (result.fields ?? {}) as Record<string, unknown>,
            );
          return result;
        },
        resolver,
        namespace: () => "frames",
        frames: { for: () => held, dispose: () => {} },
      });
      return opened;
    };
    const take = (request: Partial<SnapshotRequest> = {}, budgetMs = 20000) =>
      snapshots!.take(
        "tab-1",
        session!,
        {
          mode: "full",
          maxChars: 24000,
          maxControls: 100,
          scope: "page",
          format: "list",
          locators: false,
          header: false,
          ...request,
        },
        Date.now() + budgetMs,
        { deadline: Date.now() + budgetMs },
      ) as Promise<Listing>;
    const labels = (listing: Listing) =>
      listing.interactables.map((control) => control.label);
    const byLabel = (listing: Listing, label: string) =>
      listing.interactables.find((control) => control.label === label)!;
    // One page operation with a selector, as a route runs it: the resolver
    // picks the frame group and sends the operation to that group alone.
    const act = (
      operation: "fill" | "actionPoint",
      selector: string,
      extra: Record<string, unknown> = {},
      mode?: "strict" | "first",
    ) => {
      const parsed = parseSelector(selector);
      if (!parsed.ok || parsed.ast.kind === "ref")
        throw new Error(`Not a search: ${selector}`);
      return resolver.run(
        "tab-1",
        session!,
        operation,
        {
          selector,
          query: {
            ast: parsed.ast,
            ...(mode === undefined ? {} : { mode }),
          },
          ...extra,
        },
        { deadline: Date.now() + 20000, namespace: "frames" },
      );
    };
    // The frame a path names, once the groups have been bound.
    const frameAt = async (path: string) => {
      await groups!.groups({ deadline: Date.now() + 20000 });
      return groups!.frameAt(path)!.frameId;
    };

    it("reads a cross-site frame and a same-site frame on another port with frame-bound refs", async () => {
      await open("/frames/pay", 3);
      const listing = await take();
      // Each frame's controls carry the path of the document they sit in.
      expect(
        listing.interactables.map((control) => [control.label, control.frame]),
      ).toEqual([
        ["Card details", undefined],
        ["Card number", "0"],
        ["Pay now", "0"],
        ["Billing details", undefined],
        ["Postcode", "1"],
        ["Save billing", "1"],
      ]);
      // Each group's read took its own block of numbers, so no two frames
      // gave out the same ref.
      const given = listing.interactables.map((control) => control.ref);
      expect(new Set(given).size).toBe(given.length);
      // The refs of both frames resolve in their own group's world.
      for (const label of ["Card number", "Save billing"]) {
        const control = byLabel(listing, label);
        const home = groups!.homeFrame(control.ref)!;
        expect(groups!.pathOf(home.frameId), label).toBe(control.frame);
        expect(
          await resolver.run(
            "tab-1",
            session!,
            "target",
            { ref: control.ref },
            {
              deadline: Date.now() + 10000,
              namespace: "frames",
              frameId: home.frameId,
            },
          ),
          label,
        ).toMatchObject({ ok: true });
      }
      // The page's own URL and title, not a frame's.
      expect(listing.url).toBe(`${origin}/frames/pay`);
      expect(listing.title).toBe("Checkout");
    }, 60000);

    it("an iframe entry carries origin, contentFrame and content", async () => {
      await open("/frames/pay", 3);
      const listing = await take();
      expect(byLabel(listing, "Card details")).toMatchObject({
        role: "iframe",
        crossOrigin: true,
        origin: `http://localhost:${pages.ports[0]}`,
        contentFrame: "0",
        content: "read",
      });
      expect(byLabel(listing, "Billing details")).toMatchObject({
        crossOrigin: true,
        origin: `http://127.0.0.1:${pages.ports[1]}`,
        contentFrame: "1",
        content: "read",
      });
      expect(listing.unreadFrames).toBeUndefined();
      // A read that runs out of time lists the frames it did not reach and
      // counts every one of them. The budget that leaves some unread has to
      // sit above the page's own group read, which throws instead of being
      // skipped, and below the whole pass. How long either takes is the
      // machine's business and both stretch together when the machine is
      // busy, so a whole read is timed first and the budgets tried are
      // shares of it rather than fixed milliseconds. The shares run up, past
      // the whole, and then back down, because the machine can also free up
      // or slow down between the timing and the attempt, and the page is
      // opened again each time so that no frame is remembered as silent.
      let starved: Listing | undefined;
      let whole = 0;
      // Each round times a whole read again, because how long the page's own
      // group takes against the whole pass moves while the suite runs, and
      // a budget above the measured whole can still starve a slower one.
      for (let round = 0; round < 2 && !starved; round += 1) {
        await open("/frames/many", 13);
        const began = Date.now();
        await take();
        whole = Math.max(Date.now() - began, 8);
        for (const share of [0.4, 0.55, 0.7, 0.85, 1.1, 0.25, 0.12]) {
          await open("/frames/many", 13);
          starved = await take({}, Math.ceil(whole * share)).catch(
            () => undefined,
          );
          if (starved?.unreadFrames) break;
          starved = undefined;
        }
      }
      expect(
        starved,
        `no budget left a frame unread; a whole read took ${whole} ms`,
      ).toBeDefined();
      const left = starved!.interactables.filter(
        (control) =>
          control.content !== undefined && control.content !== "read",
      );
      // Whether a frame's turn came up before the budget ran out, which
      // leaves it pending, or its own read started and ran out, which
      // leaves it unavailable, is the machine's business; either way the
      // read did not reach it.
      expect(
        left.some(
          (control) =>
            control.content === "pending" || control.content === "unavailable",
        ),
      ).toBe(true);
      // A frame left unread still says which frame it was.
      expect(
        left.every(
          (control) =>
            typeof control.origin === "string" &&
            typeof control.contentFrame === "string",
        ),
      ).toBe(true);
      expect(starved!.unreadFrames).toBe(left.length);
      // A frame that blocks its own thread answers no read at all. Without
      // site isolation it blocks the page around it too, so there is
      // nothing to tell apart.
      if (!mode.isolated) return;
      await open("/frames/stuck", 3);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stuck = await take();
      expect(byLabel(stuck, "Busy widget").content).toBe("unavailable");
      expect(byLabel(stuck, "Calm widget").content).toBe("read");
      expect(stuck.unreadFrames).toBe(1);
    }, 120000);

    it("hides a card number in a frame", async () => {
      await open("/frames/pay", 3);
      const first = await take();
      const card = byLabel(first, "Card number");
      await resolver.run(
        "tab-1",
        session!,
        "fill",
        { ref: card.ref, value: "4111111111111111" },
        {
          deadline: Date.now() + 10000,
          namespace: "frames",
          frameId: groups!.homeFrame(card.ref)!.frameId,
        },
      );
      const listing = await take();
      expect(byLabel(listing, "Card number")).toMatchObject({
        valueHidden: true,
      });
      expect(byLabel(listing, "Card number").value).toBeUndefined();
      expect(listing.text).not.toContain("4111");
      const shape = await take({ format: "outline" });
      expect(shape.outline).toContain("(value hidden)");
      expect(shape.outline).not.toContain("4111");
    }, 60000);

    it("a frame's text is spliced at its owner and its outline nests under the iframe line", async () => {
      await open("/frames/pay", 3);
      const listing = await take();
      const lines = listing.text.split("\n").filter(Boolean);
      // Each frame's text sits where its owner does, on lines of its own.
      expect(lines).toEqual([
        "Checkout",
        "Text above the frames",
        "Pay with a card",
        "Card number Pay now",
        "Checkout untouched",
        "Text between the frames",
        "Billing address",
        "Postcode Save billing",
        "Nothing paid",
      ]);
      const shape = await take({ format: "outline" });
      const printed = shape.outline!.replace(/ @e\d+/g, "").split("\n");
      const at = printed.indexOf('iframe "Card details"');
      expect(at).toBeGreaterThanOrEqual(0);
      // The frame's own lines sit one level deeper than its iframe line.
      expect(printed[at + 1]).toBe('  "Pay with a card"');
      expect(
        printed.some((line) => line.startsWith('  textbox "Card number"')),
      ).toBe(true);
      expect(printed[printed.indexOf('iframe "Billing details"') + 1]).toBe(
        '  "Billing address"',
      );
    }, 60000);

    it("viewport scope reads only the visible part of each frame", async () => {
      await open("/frames/far", 2);
      const whole = await take();
      expect(whole.text).toContain("Pay with a card");
      // The frame sits 1600 pixels below the fold, so nothing of it is read
      // and nothing of it is counted as left unread.
      const shown = await take({ scope: "viewport" });
      expect(shown.text).toContain("Top of the far page");
      expect(shown.text).not.toContain("Pay with a card");
      expect(labels(shown)).toEqual([]);
      expect(shown.unreadFrames).toBeUndefined();
    }, 90000);

    it("a root ref on an iframe entry scopes to that frame's document", async () => {
      await open("/frames/pay", 3);
      const listing = await take();
      const scoped = await take({ root: byLabel(listing, "Card details").ref });
      expect(labels(scoped)).toEqual(["Card number", "Pay now"]);
      // The paths stay the page's, and the text holds only the frame.
      expect(scoped.interactables.map((control) => control.frame)).toEqual([
        "0",
        "0",
      ]);
      expect(scoped.text).toContain("Pay with a card");
      expect(scoped.text).not.toContain("Text above the frames");
      expect(scoped.url).toBe(`${origin}/frames/pay`);
    }, 60000);

    it("twelve cross-site frames, three of them nested, answer within 1500 ms", async () => {
      await open("/frames/many", 13);
      // The first read binds every owner and makes a world in every frame.
      // What this measures is a read of a page already bound: a machine
      // busy with other work can leave one read waiting on a frame's own
      // renderer, which then answers the next one, so the best of a few
      // reads is what counts.
      await take();
      let best = Number.POSITIVE_INFINITY;
      let whole: Listing | undefined;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const started = Date.now();
        const listing = await take();
        if (listing.unreadFrames !== undefined) continue;
        best = Math.min(best, Date.now() - started);
        whole ??= listing;
      }
      expect(best).toBeLessThan(1500);
      expect(
        whole!.interactables.filter(
          (control) => control.label === "Widget action",
        ),
      ).toHaveLength(11);
      expect(
        whole!.interactables
          .filter((control) => control.content !== undefined)
          .every((control) => control.content === "read"),
      ).toBe(true);
      // A frame stuck in a long script fails its own read without holding
      // up the frames beside it, and the read after it does not wait for
      // that frame again.
      if (!mode.isolated) return;
      await open("/frames/stuck", 3);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const stuck = Date.now();
      const busy = await take();
      expect(Date.now() - stuck).toBeLessThan(3000);
      expect(byLabel(busy, "Busy widget").content).toBe("unavailable");
      expect(byLabel(busy, "Calm widget").content).toBe("read");
      const after = Date.now();
      const next = await take();
      expect(Date.now() - after).toBeLessThan(1500);
      expect(byLabel(next, "Busy widget").content).toBe("unavailable");
      expect(byLabel(next, "Calm widget").content).toBe("read");
    }, 120000);
    it("searches the top document, then frames in owner order", async () => {
      await open("/frames/pay", 3);
      const card = await frameAt("0");
      const billing = await frameAt("1");
      // A selector the page's own document answers never reads a frame.
      expect(
        await act("actionPoint", "css=h1", { kind: "click" }),
      ).toMatchObject({ ok: true });
      expect(groups!.contentOf(card)).toBe("pending");
      expect(groups!.contentOf(billing)).toBe("pending");
      // Nothing in the page's own document: the frames follow in owner
      // order, so the field of the first frame takes the value.
      expect(
        await act("fill", "css=input", { value: "4111111111111111" }, "first"),
      ).toMatchObject({ ok: true });
      expect(groups!.contentOf(card)).toBe("read");
      let listing = await take();
      // The card number is a secret, so only the frame that holds it says
      // that it has a value at all.
      expect(byLabel(listing, "Card number")).toMatchObject({
        valueHidden: true,
      });
      expect(byLabel(listing, "Postcode").value).toBeUndefined();
      // A selector only the second frame holds resolves there.
      expect(
        await act("fill", "css=#postcode", { value: "AB1 2CD" }, "first"),
      ).toMatchObject({ ok: true });
      listing = await take();
      expect(byLabel(listing, "Postcode").value).toBe("AB1 2CD");
    }, 60000);

    it("a text selector passes a covered top-page duplicate for the frame's button", async () => {
      await open("/frames/covered", 2);
      const card = await frameAt("0");
      // The page's own duplicate is under an overlay, so it holds nothing
      // at the pointer level and the frame's own match answers.
      const found = await act("actionPoint", "text=Pay now", { kind: "click" });
      expect(found.blocked).toBeUndefined();
      expect(found.point).toMatchObject({
        x: expect.any(Number),
        y: expect.any(Number),
      });
      expect(groups!.contentOf(card)).toBe("read");
      // The point is inside the frame's own document, far below the overlay
      // the page's own duplicate sits under.
      const box = found.box as { top: number };
      expect(box.top).toBeGreaterThan(100);
      // The page's own duplicate is the covered one.
      const covered = await act("actionPoint", "css=#duplicate", {
        kind: "click",
      });
      expect(covered.blocked).toMatchObject({ blocker: "covered" });
    }, 60000);
  });
