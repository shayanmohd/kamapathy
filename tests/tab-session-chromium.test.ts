// Drives TabSession over a raw DevTools Protocol socket to Playwright's
// Chromium, where a cross-site frame runs in its own process as it does in
// Kamapathy's tabs. These tests skip when Playwright's browser is not
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
import { TabSession } from "../electron/agent/session/tab-session";
import type { FrameInfo, Step } from "../electron/agent/session/types";
import {
  chromiumAvailable,
  launchChromium,
  type ChromiumBrowser,
  type ChromiumPage,
} from "./cdp-socket";
import { framePages } from "./fixtures/frame-pages.mjs";

describe.skipIf(!chromiumAvailable)("TabSession in Chromium", () => {
  let site: Server;
  let origin: string;
  let browser: ChromiumBrowser;
  let page: ChromiumPage | undefined;
  let tab: TabSession | undefined;
  beforeAll(async () => {
    site = createServer((request, response) => {
      const html = framePages[new URL(request.url || "/", "http://x").pathname];
      response.writeHead(html ? 200 : 404, { "Content-Type": "text/html" });
      response.end(html || "");
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    browser = await launchChromium();
  }, 60000);
  afterEach(async () => {
    await tab?.release();
    await page?.close();
    tab = undefined;
    page = undefined;
  });
  afterAll(async () => {
    await browser?.close();
    site?.close();
  });
  const step = () => ({ deadline: Date.now() + 10000 });
  const internal = () => ({ ...step(), namespace: "internal" });
  const agent = () => ({ ...step(), namespace: "agent" });
  // Opens the path in a new page with a session attached before it loads,
  // and waits for its load, which waits for every frame inside it. A frame's
  // first document, about:blank, is complete at once, so the frames are read
  // only after that.
  const open = async (path: string, count: number) => {
    page = await browser.newPage();
    const session = new TabSession(page.host, {
      tabId: "tab-1",
      waitForSpaceIdle: async () => {},
    });
    tab = session;
    session.attach();
    await session.send("Page.navigate", { url: origin + path }, step());
    let frames: FrameInfo[] = [];
    await vi.waitFor(
      async () => {
        const main = await session.mainFrameId(step());
        expect(
          await session.evaluateInFrame(main, "ready", {}, internal()),
        ).toEqual({ ok: true, readyState: "complete" });
        frames = await session.frames(step());
        expect(frames).toHaveLength(count);
      },
      { timeout: 10000, interval: 100 },
    );
    return { session, frames };
  };
  const snapshotPayload = {
    mode: "full",
    maxChars: 24000,
    maxControls: 100,
    firstRef: 1,
  };

  it("gives the localhost frame of /frames/outer its own session and crossOrigin true against its 127.0.0.1 parent, and runs ready inside it", async () => {
    const { session, frames } = await open("/frames/outer", 4);
    const localhost = origin.replace("127.0.0.1", "localhost");
    expect(
      frames.map(({ url, path, crossOrigin, sessionId, blocked }) => ({
        url,
        path,
        crossOrigin,
        ownSession: sessionId !== undefined,
        blocked,
      })),
    ).toEqual([
      {
        url: `${origin}/frames/outer`,
        path: "",
        crossOrigin: false,
        ownSession: false,
      },
      {
        url: `${origin}/frames/inner`,
        path: "0",
        crossOrigin: false,
        ownSession: false,
      },
      {
        url: `${origin}/frames/nested`,
        path: "0/0",
        crossOrigin: false,
        ownSession: false,
      },
      {
        url: `${localhost}/frames/other`,
        path: "1",
        crossOrigin: true,
        ownSession: true,
      },
    ]);
    const [main, , , other] = frames;
    expect(other.parentFrameId).toBe(main.frameId);
    expect(other.origin).toBe(localhost);
    expect(
      await session.evaluateInFrame(other.frameId, "ready", {}, internal()),
    ).toEqual({ ok: true, readyState: "complete" });
    // Its world reads its own document, which the main frame cannot.
    expect(
      await session.evaluateInFrame(
        other.frameId,
        "check",
        { text: "Card number" },
        internal(),
      ),
    ).toEqual({ ok: true, matched: true });
    expect(
      await session.evaluateInFrame(
        main.frameId,
        "check",
        { text: "Card number" },
        internal(),
      ),
    ).toEqual({ ok: true, matched: false });
    const world = await session.world(other.frameId, step());
    expect(world.sessionId).toBe(other.sessionId);
  }, 20000);

  it("reads same-origin frames through the main frame's world as snapshots did before", async () => {
    const { session, frames } = await open("/frames/outer", 4);
    const listing = await session.evaluateInFrame(
      frames[0].frameId,
      "snapshot",
      snapshotPayload,
      agent(),
    );
    expect(listing.text).toContain("Text inside the frame");
    expect(listing.text).toContain("Text two frames deep");
    expect(listing.text).not.toContain("Card number");
    expect(
      (listing.interactables as { label: string; frame?: string }[]).map(
        ({ label, frame }) => [label, frame],
      ),
    ).toEqual([
      ["Frame note", "0"],
      ["Apply in frame", "0"],
      ["Frame file", "0"],
      ["Deep button", "0/0"],
      ["Card details", undefined],
    ]);
    // frames() reports the paths the snapshot prints.
    expect(frames.map((frame) => frame.path)).toEqual(["", "0", "0/0", "1"]);
  }, 20000);

  it("computing frame paths keeps refs from an earlier snapshot valid", async () => {
    const { session, frames } = await open("/frames/outer", 4);
    const main = frames[0].frameId;
    const listing = await session.evaluateInFrame(
      main,
      "snapshot",
      snapshotPayload,
      agent(),
    );
    const apply = (
      listing.interactables as { label: string; ref: string }[]
    ).find((control) => control.label === "Apply in frame")!;
    // Paths of frames in the main document are read in its world, where the
    // snapshot keeps its refs.
    expect((await session.frames(step())).map((frame) => frame.path)).toEqual([
      "",
      "0",
      "0/0",
      "1",
    ]);
    expect(
      await session.evaluateInFrame(
        main,
        "target",
        { ref: apply.ref },
        agent(),
      ),
    ).toMatchObject({ ok: true });
  }, 20000);
});
// Its own server answers /probe/delay 800 ms late and notes when the answer
// ended.
describe.skipIf(!chromiumAvailable)("lifecycle and network in Chromium", () => {
  const WORKER_PAGE = `<!doctype html><meta charset="utf-8"><title>Worker probe</title>
<p id="worker-result">Worker not started</p>
<script>
const source = "postMessage('worker-ready')";
const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
worker.onmessage = (event) => { document.getElementById("worker-result").textContent = event.data; };
</script>`;
  let site: Server;
  let origin: string;
  let browser: ChromiumBrowser;
  let page: ChromiumPage | undefined;
  let session: TabSession | undefined;
  let delayEnded = 0;
  beforeAll(async () => {
    site = createServer((request, response) => {
      const path = new URL(request.url || "/", "http://x").pathname;
      if (path === "/probe/delay") {
        setTimeout(() => {
          response.writeHead(200, { "Content-Type": "text/plain" });
          response.end("Delayed", () => {
            delayEnded = Date.now();
          });
        }, 800);
        return;
      }
      const html = path === "/probe/worker" ? WORKER_PAGE : framePages[path];
      response.writeHead(html ? 200 : 404, { "Content-Type": "text/html" });
      response.end(html || "");
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    browser = await launchChromium();
  }, 60000);
  afterEach(async () => {
    await session?.release();
    await page?.close();
    session = page = undefined;
  });
  afterAll(async () => {
    await browser?.close();
    site?.close();
  });
  const step = (): Step => ({ deadline: Date.now() + 10000 });
  // A session attached to a fresh page, then the page loaded through it.
  const open = async (path: string) => {
    page = await browser.newPage();
    const opened = new TabSession(page.host, {
      tabId: "chromium",
      waitForSpaceIdle: async () => {},
    });
    session = opened;
    opened.attach();
    const { loaderId } = await opened.send<{ loaderId: string }>(
      "Page.navigate",
      { url: origin + path },
      step(),
    );
    await opened.waitForLifecycle("load", { ...step(), loaderId });
    return opened;
  };

  it("waits for network idle until a delayed request in the localhost frame finishes", async () => {
    const opened = await open("/frames/outer");
    let frame: FrameInfo | undefined;
    for (const end = Date.now() + 10000; !frame && Date.now() < end; ) {
      frame = (await opened.frames(step())).find(
        (item) => item.url.includes("//localhost:") && !!item.sessionId,
      );
      if (!frame) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await opened.waitForLifecycle("load", {
      ...step(),
      frameId: frame!.frameId,
    });
    // Every document request has ended, the localhost frame's included,
    // though only that frame's own session could have seen its end.
    await opened.network.waitForIdle(300, step());
    const sent = Date.now();
    await opened.send(
      "Runtime.evaluate",
      { expression: "fetch('/probe/delay').then((response) => response.text())" },
      { ...step(), sessionId: frame!.sessionId, mutates: true },
    );
    await expect.poll(() => opened.network.inFlight()).toBe(1);
    await opened.network.waitForIdle(300, step());
    const idle = Date.now();
    expect(idle - sent).toBeGreaterThanOrEqual(700);
    expect(delayEnded).toBeGreaterThan(0);
    expect(idle).toBeGreaterThanOrEqual(delayEnded);
    expect(opened.network.inFlight()).toBe(0);
  }, 20000);

  it("lets a blob worker post worker-ready within 3 seconds", async () => {
    const opened = await open("/probe/worker");
    const main = await opened.mainFrameId(step());
    const end = Date.now() + 3000;
    let posted = false;
    while (!posted && Date.now() < end) {
      const { matched } = await opened.evaluateInFrame(
        main,
        "check",
        { text: "worker-ready" },
        { ...step(), namespace: "internal" },
      );
      posted = matched === true;
      if (!posted) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(posted).toBe(true);
    // The worker's script request ends where no session of the tab hears
    // it, so it never keeps the tab busy.
    await opened.network.waitForIdle(300, step());
  }, 20000);
});
