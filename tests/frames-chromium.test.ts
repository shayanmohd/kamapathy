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
import {
  createResolver,
  frameTargetOf,
  inArea,
  revealThroughFrames,
  translatePoint,
  type Resolver,
} from "../electron/agent/resolve";
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
      // What a read that runs out of time reports is pinned on the fake in
      // tests/automation.test.ts, "a snapshot counts unread frames": there a
      // pending frame, an unavailable one and one past the group limit are
      // all produced at once, with their origins and contentFrames, and
      // unreadFrames counted over the three. Chromium cannot do better,
      // because a group is pending only when the deadline falls between the
      // page's own read, which throws instead of being skipped, and a child
      // group's turn, and that window moves with how busy the machine is.
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

    it("an open dialog prints first, with its frame's lines under the iframe line", async () => {
      await open("/frames/dialog", 2);
      const shape = await take({ format: "outline" });
      expect(shape.outline!.replace(/ @e\d+/g, "").split("\n")).toEqual([
        'dialog "Pay"',
        '  iframe "Card details"',
        '    "Card number"',
        '    textbox "Card number"',
        "main",
        '  "Order summary"',
      ]);
      // The frame's control is listed after its owner, as its line prints.
      expect(
        Array.from(shape.outline!.matchAll(/@e\d+/g)).map((found) => found[0]),
      ).toEqual(shape.interactables.map((control) => control.ref));
    }, 60000);

    it("pages an outline through its frames within both bounds", async () => {
      await open("/frames/pay", 3);
      const whole = (await take({ format: "outline" })).outline!.split("\n");
      const refsIn = (lines: readonly string[]) =>
        lines.flatMap((line) => line.match(/@e\d+/g) ?? []);
      const lineOf = (cursor: string) =>
        readCursor(cursor, {
          h: optionsHash({ scope: "page", format: "outline" }),
        }).l;
      // The lines around a line of the outline: each line above it that is
      // less indented than every line between them.
      const indent = (line: string) => line.length - line.trimStart().length;
      const around = (at: number) => {
        const chain: string[] = [];
        for (
          let above = at - 1, depth = indent(whole[at]);
          above >= 0;
          above -= 1
        )
          if (indent(whole[above]) < depth) {
            chain.unshift(whole[above]);
            depth = indent(whole[above]);
          }
        return chain;
      };
      for (const bounds of [
        { maxChars: 60, maxControls: 100 },
        { maxChars: 24000, maxControls: 1 },
      ]) {
        const name = JSON.stringify(bounds);
        const parts: Listing[] = [];
        let cursor: string | undefined;
        do {
          const got = await take({
            format: "outline",
            ...bounds,
            ...(cursor === undefined ? {} : { cursor }),
          });
          parts.push(got);
          cursor = got.next;
        } while (cursor !== undefined && parts.length < 20);
        expect(cursor, `${name} ends`).toBeUndefined();
        // Each part prints the lines from its cursor to the next one's,
        // after the lines around the first of them, which for a part that
        // starts among a frame's own lines include the iframe line.
        let from = 0;
        let inside = 0;
        for (const [index, part] of parts.entries()) {
          const printed = part.outline!.split("\n");
          const to = part.next ? lineOf(part.next) : whole.length;
          expect(to, `${name} part ${index}`).toBeGreaterThan(from);
          const fresh = whole.slice(from, to);
          expect(printed, `${name} part ${index}`).toEqual([
            ...around(from),
            ...fresh,
          ]);
          // Frame refs count toward maxControls like any control's.
          expect(refsIn(fresh).length, `${name} part ${index}`).toBeLessThanOrEqual(
            bounds.maxControls,
          );
          // A part lists the controls and frames it printed.
          expect(part.interactables.map((control) => control.ref)).toEqual(
            refsIn(printed),
          );
          if (around(from).some((line) => line.startsWith("iframe "))) inside += 1;
          from = to;
        }
        expect(from, name).toBe(whole.length);
        expect(inside, name).toBeGreaterThan(0);
      }
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

    // Section 9's actions: the element's own point from the world of its
    // frame, mapped out through every owner, and the input sent on the top
    // page session at what comes out, as section 5's dispatcher sends it.
    const focusEmulation = async () => {
      const sessions = new Set<string | undefined>([undefined]);
      for (const frame of await session!.frames(step()))
        if (frame.sessionId !== undefined) sessions.add(frame.sessionId);
      for (const sessionId of sessions)
        await session!.send(
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
          { ...step(), ...(sessionId === undefined ? {} : { sessionId }) },
        );
    };
    // One page operation on a ref, in the world of the frame that issued it.
    const inHome = (
      operation: "actionPoint" | "fillPrepare" | "fillRead" | "input",
      ref: string,
      extra: Record<string, unknown> = {},
    ) => {
      const home = groups!.homeFrame(ref)!;
      return resolver.run(
        "tab-1",
        session!,
        operation,
        { ref, ...extra },
        {
          deadline: Date.now() + 20000,
          namespace: "frames",
          frameId: home.frameId,
        },
      );
    };
    const target = (ref: string) =>
      frameTargetOf(groups!, groups!.homeFrame(ref)!.frameId);
    // The native input of one gesture, on the tab's own page session.
    const sendMouse = async (point: { x: number; y: number }) => {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await session!.send(
          "Input.dispatchMouseEvent",
          {
            type,
            x: point.x,
            y: point.y,
            button: type === "mouseMoved" ? "none" : "left",
            buttons: type === "mousePressed" ? 1 : 0,
            clickCount: type === "mouseMoved" ? 0 : 1,
            modifiers: 0,
          },
          step(),
        );
    };
    const sendKey = async (key: string, code: string) => {
      for (const type of ["keyDown", "keyUp"])
        await session!.send(
          "Input.dispatchKeyEvent",
          {
            type,
            key,
            code,
            windowsVirtualKeyCode: key === "Enter" ? 13 : 0,
            modifiers: 0,
          },
          step(),
        );
    };
    // Where a ref's own point lands in the top viewport, through its owners.
    const placeOf = async (ref: string, kind = "click") => {
      const found = await inHome("actionPoint", ref, { kind, force: false });
      expect(found).toMatchObject({ ok: true });
      expect(found.blocked).toBeUndefined();
      return {
        found,
        placed: await translatePoint(
          session!,
          target(ref),
          found.point as { x: number; y: number },
          step(),
        ),
      };
    };
    // Chromium routes input to an out-of-process frame by the layout it last
    // drew, which under load trails a scroll by seconds, so a press waits
    // until a move at its point reaches the element's own document.
    const routedTo = async (ref: string, point: { x: number; y: number }) => {
      const { sessionId, contextId } = await session!.world(
        groups!.homeFrame(ref)!.frameId,
        step(),
      );
      const moves = async (expression: string) =>
        (
          await session!.send(
            "Runtime.evaluate",
            { expression, contextId, returnByValue: true },
            { ...step(), ...(sessionId === undefined ? {} : { sessionId }) },
          )
        ).result?.value as number;
      const before = await moves(
        "if (!globalThis.__moves) { globalThis.__moves = { count: 0 }; addEventListener('mousemove', () => { globalThis.__moves.count += 1; }, true); } globalThis.__moves.count",
      );
      const until = Date.now() + 30000;
      for (let attempt = 0; Date.now() < until; attempt++) {
        await session!.send(
          "Input.dispatchMouseEvent",
          {
            type: "mouseMoved",
            x: point.x + (attempt % 2),
            y: point.y,
            button: "none",
            buttons: 0,
            modifiers: 0,
          },
          step(),
        );
        if ((await moves("globalThis.__moves.count")) > before) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(`No move at ${point.x},${point.y} reached its frame.`);
    };
    const clickRef = async (ref: string) => {
      const { placed } = await placeOf(ref);
      expect(placed.covered).toBeUndefined();
      expect(inArea(placed.point, placed.area)).toBe(true);
      await routedTo(ref, placed.point);
      await sendMouse(placed.point);
      return placed;
    };
    const counters = async (ref: string) =>
      (await inHome("input", ref)) as {
        mouse?: number;
        key?: number;
      };
    const topCounters = () =>
      resolver.run(
        "tab-1",
        session!,
        "input",
        {},
        { deadline: Date.now() + 20000, namespace: "frames" },
      ) as Promise<{ mouse?: number; key?: number }>;

    it("clicks, fills and presses Enter in a cross-site frame and in a same-site frame on another port", async () => {
      await open("/frames/pay", 3);
      await focusEmulation();
      const listing = await take();
      const before = await topCounters();
      for (const [label, button, pressed] of [
        ["Card number", "Pay now", "Paid"],
        ["Postcode", "Save billing", "Billing saved"],
      ] as const) {
        const field = byLabel(listing, label).ref;
        const armed = await counters(field);
        await clickRef(byLabel(listing, button).ref);
        // The frame that holds the target counted the press, once, and the
        // page's own document counted none of it.
        const after = await counters(field);
        expect((after.mouse ?? 0) - (armed.mouse ?? 0), label).toBe(1);
        expect(await take().then((now) => labels(now)), label).toContain(
          pressed,
        );
        // The field takes text at the caret the frame's own world prepared.
        const value = label === "Card number" ? "4111 1111 1111 11" : "AB1 2CD";
        expect(
          await inHome("fillPrepare", field, { value }),
          label,
        ).toMatchObject({ ok: true });
        await session!.send("Input.insertText", { text: value }, step());
        expect(
          await inHome("fillRead", field, { value, previous: "" }),
          label,
        ).toMatchObject({ ok: true, match: "exact" });
      }
      // Enter reaches the field the frame focused, and its own handler runs.
      const card = byLabel(listing, "Card number").ref;
      expect(
        await inHome("fillPrepare", card, { value: "4111 1111 1111 11" }),
      ).toMatchObject({ ok: true });
      const keys = await counters(card);
      await sendKey("Enter", "Enter");
      expect((await counters(card)).key).toBe((keys.key ?? 0) + 1);
      expect((await take()).text).toContain("Entered 17 digits");
      // Every press and key went out on the tab's own page session, so the
      // page's own counters never saw any of it.
      expect((await topCounters()).mouse).toBe(before.mouse ?? 0);
      expect((await topCounters()).key).toBe(before.key ?? 0);
    }, 60000);

    it("clicks in a nested cross-site frame scaled to 0.5", async () => {
      await open("/frames/half", 3);
      const listing = await take();
      // The grid sits two boundaries in: the half size frame from another
      // site, then a frame of this page's own name on another port.
      const button = listing.interactables.find(
        (control) => control.label === "Target",
      )!;
      expect(button.frame).toBe("0/0");
      const inner = target(button.ref);
      expect(inner.owners).toHaveLength(2);
      const placed = await clickRef(button.ref);
      // Half of the frame's own pixels, from the owner's content box.
      expect(placed.scaleX).toBeCloseTo(0.5, 5);
      expect(placed.point.x).toBeCloseTo(5 + 150 * 0.5, 1);
      // The press landed on the control, not beside it.
      expect((await take()).text).toContain("Grid hit Target");
    }, 60000);

    it("clicks a button two same-origin frames deep by its ref, with no frame named", async () => {
      await open("/frames/outer", 4);
      const listing = await take();
      const deep = byLabel(listing, "Deep button");
      expect(deep.frame).toBe("0/0");
      // The ref's home is the frame the button sits in, which the page's own
      // group reads.
      expect(groups!.homeFrame(deep.ref)).toMatchObject({
        path: "0/0",
        group: "",
      });
      // As a route sends it: the resolver finds the world for the ref, one
      // frame deep and two.
      const pointOf = async (ref: string) => {
        const found = await resolver.run(
          "tab-1",
          session!,
          "actionPoint",
          { ref, kind: "click", force: false },
          { deadline: Date.now() + 20000, namespace: "frames" },
        );
        expect(found, ref).toMatchObject({ ok: true });
        expect(found.blocked, ref).toBeUndefined();
        return found.point as { x: number; y: number };
      };
      await pointOf(byLabel(listing, "Frame note").ref);
      await sendMouse(await pointOf(deep.ref));
      expect(labels(await take())).toContain("Deep clicked");
    }, 60000);

    it("uploads by its ref to a file input in a same-origin frame after a key press looked for the focused frame", async () => {
      await open("/frames/outer", 4);
      const listing = await take();
      const file = byLabel(listing, "Frame file");
      expect(file.frame).toBe("0");
      const run = (
        operation: "focusTarget" | "upload",
        payload: Record<string, unknown>,
      ) =>
        resolver.run("tab-1", session!, operation, payload, {
          deadline: Date.now() + 20000,
          namespace: "frames",
        });
      // As a press of Enter on the note sends it: the target is focused, then
      // the frame its keys go to is found through the page's own world.
      expect(
        await run("focusTarget", { ref: byLabel(listing, "Frame note").ref }),
      ).toMatchObject({ ok: true });
      expect(await groups!.focusedFrame(step())).toMatchObject({
        path: "0",
        editable: true,
      });
      // As the upload route sends it, with the ref the snapshot gave out.
      expect(
        await run("upload", {
          ref: file.ref,
          files: [{ name: "note.txt", type: "text/plain", data: "aGk=" }],
        }),
      ).toEqual({ ok: true, selected: 1 });
      expect((await take()).text).toContain("Files 1");
    }, 60000);

    it("scrolls a frame 1600 px below the fold into view before clicking", async () => {
      await open("/frames/far", 2);
      const listing = await take();
      const button = byLabel(listing, "Pay now").ref;
      const scrollY = () =>
        resolver
          .run(
            "tab-1",
            session!,
            "info",
            {},
            { deadline: Date.now() + 20000, namespace: "frames" },
          )
          .then(
            (state) => (state as { scroll?: { y?: number } }).scroll?.y ?? 0,
          );
      expect(await scrollY()).toBe(0);
      // The frame's own world sees the button, but no part of the frame is
      // on screen, so the point maps outside every owner's visible area.
      const first = await placeOf(button);
      expect(inArea(first.placed.point, first.placed.area)).toBe(false);
      // The outermost owner is brought into view first, then the element's
      // own point is measured again and the press lands on it.
      await revealThroughFrames(session!, target(button), step());
      expect(await scrollY()).toBeGreaterThan(1000);
      await clickRef(button);
      expect((await take()).text).toContain("Paid");
    }, 60000);

    it("an element covering an owner is reported as covered with its interceptor", async () => {
      await open("/frames/sealed", 2);
      const listing = await take();
      // The control sits under the veil the page draws over its frame, so
      // the world around the owner names what covers it rather than letting
      // the press through.
      const { placed } = await placeOf(byLabel(listing, "Target").ref);
      expect(placed.point).toMatchObject({ x: 150, y: 100 });
      expect(placed.covered).toBe(true);
      // The page's own element, not the frame it covers.
      expect(placed.interceptor).toMatchObject({ tag: "div", role: "div" });
      // The control below the veil, in the same frame, is reached as usual.
      await clickRef(byLabel(listing, "Decoy").ref);
      expect((await take()).text).toContain("Grid hit Decoy");
    }, 60000);
  });
