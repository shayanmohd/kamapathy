// Runs the page's own fetch inside Playwright's Chromium, in an isolated
// world made the way Kamapathy makes its own. This is what verify first item
// 3 asks: in that world the page's cookies, its origin and CORS apply, and
// the bytes come back byte for byte. These tests skip when Playwright's
// browser is not installed.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fetchOperation,
  type FetchPhase,
  type FetchReply,
} from "../electron/agent/dom/fetch";
import {
  NETWORK_BODY,
  SCRIPT_BINARY,
  SCRIPT_BINARY_SHA256,
  WORKER_BODY,
  scriptPageHeaders,
  scriptPages,
  serveScriptEndpoint,
} from "./fixtures/script-pages.mjs";

const executable = chromium.executablePath();
const browserAvailable = !!executable && existsSync(executable);
const source = `(${fetchOperation})`;

describe.skipIf(!browserAvailable)("page fetch in Chromium", () => {
  let site: Server;
  let origin: string;
  let other: string;
  let browser: Browser;
  let page: Page;
  let cdp: CDPSession;
  let world: number;
  let events: Record<string, unknown>[] = [];
  beforeAll(async () => {
    site = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (serveScriptEndpoint(request, response, url, events)) return;
      const html = scriptPages[url.pathname];
      // A page asking for {{other}} gets this server through its other
      // loopback name, which makes its frames and its fetches cross origin.
      const name = request.headers.host?.startsWith("localhost")
        ? "127.0.0.1"
        : "localhost";
      const port = (site.address() as AddressInfo).port;
      response.writeHead(html ? 200 : 404, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...scriptPageHeaders[url.pathname],
      });
      response.end(
        (html || "").replaceAll("{{other}}", `http://${name}:${port}`),
      );
    });
    await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
    const { port } = site.address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
    other = `http://localhost:${port}`;
    browser = await chromium.launch();
  }, 60000);
  afterEach(async () => {
    await page?.close();
    events = [];
  });
  afterAll(async () => {
    await browser?.close();
    site?.close();
  });
  // Kamapathy's world in the main frame: its own realm, with the document's
  // origin and none of the page's globals.
  const makeWorld = async () => {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const made = await cdp.send("Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: "kamapathy",
      grantUniveralAccess: false,
    });
    world = made.executionContextId;
  };
  const open = async (path: string) => {
    page = await browser.newPage();
    await page.goto(origin + path);
    cdp = await page.context().newCDPSession(page);
    await makeWorld();
  };
  const run = async (
    phase: FetchPhase,
    payload: Record<string, unknown>,
  ): Promise<FetchReply> => {
    const reply = await cdp.send("Runtime.evaluate", {
      expression: `${source}(${JSON.stringify(phase)},${JSON.stringify(payload)})`,
      contextId: world,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.exceptionDetails)
      throw new Error(
        reply.exceptionDetails.exception?.description ??
          reply.exceptionDetails.text,
      );
    return reply.result.value as FetchReply;
  };
  const started = (reply: FetchReply) => {
    if (!reply.ok || reply.phase !== "start")
      throw new Error(`Not a started fetch: ${JSON.stringify(reply)}`);
    return reply;
  };
  // Every chunk of one body, as the route reads them.
  const readAll = async (handle: string) => {
    const parts: Buffer[] = [];
    for (let reads = 0; reads < 40; reads += 1) {
      const reply = await run("read", { handle });
      if (!reply.ok || reply.phase !== "read")
        throw new Error(`Not a read: ${JSON.stringify(reply)}`);
      parts.push(Buffer.from(reply.data, "base64"));
      expect(Buffer.from(reply.data, "base64")).toHaveLength(reply.bytes);
      if (reply.done) return Buffer.concat(parts);
    }
    throw new Error("The body did not end.");
  };
  const text = async (handle: string) =>
    (await readAll(handle)).toString("utf8");

  it("a same-origin fetch sends the page's cookies", async () => {
    await open("/scripts/cookie");
    expect(await page.textContent("#cookie")).toBe("Cookie: lab=sugar");
    const sent = started(
      await run("start", {
        url: `${origin}/scripts/echo-cookie`,
        method: "GET",
        headers: [["accept", "application/json"]],
        mode: "cors",
      }),
    );
    expect(sent.head).toMatchObject({
      ok: true,
      status: 200,
      url: `${origin}/scripts/echo-cookie`,
      redirected: false,
      type: "basic",
    });
    // Header names arrive lowercase, as the route answers them.
    expect(sent.head.headers["content-type"]).toBe(
      "application/json; charset=utf-8",
    );
    expect(JSON.parse(await text(sent.handle))).toEqual({
      cookie: "lab=sugar",
    });
    expect(events.at(-1)).toMatchObject({
      type: "script-fetch",
      path: "/scripts/echo-cookie",
      cookie: "lab=sugar",
    });
    // The page's own fetch sends the same cookie, so the isolated world is
    // not a weaker context than the page itself.
    const inPage = await page.evaluate(
      async (url) => (await (await fetch(url)).json()).cookie,
      `${origin}/scripts/echo-cookie`,
    );
    expect(inPage).toBe("lab=sugar");
    // Omitting credentials drops it.
    const bare = started(
      await run("start", {
        url: `${origin}/scripts/echo-cookie`,
        method: "GET",
        headers: [],
        mode: "cors",
        credentials: "omit",
      }),
    );
    expect(JSON.parse(await text(bare.handle))).toEqual({ cookie: "" });
  }, 30000);

  it("binary bodies read byte for byte", async () => {
    await open("/scripts/cookie");
    const sent = started(
      await run("start", {
        url: `${origin}/scripts/binary`,
        method: "GET",
        headers: [],
        mode: "cors",
      }),
    );
    expect(sent.head.headers["content-length"]).toBe(
      String(SCRIPT_BINARY.length),
    );
    const parts: Buffer[] = [];
    for (;;) {
      const reply = await run("read", { handle: sent.handle });
      if (!reply.ok || reply.phase !== "read") throw new Error("Not a read.");
      // No chunk is larger than the megabyte an NDJSON line carries.
      expect(reply.bytes).toBeLessThanOrEqual(1024 * 1024);
      parts.push(Buffer.from(reply.data, "base64"));
      if (reply.done) break;
    }
    const body = Buffer.concat(parts);
    expect(body).toHaveLength(SCRIPT_BINARY.length);
    expect(createHash("sha256").update(body).digest("hex")).toBe(
      SCRIPT_BINARY_SHA256,
    );
    expect(body.equals(SCRIPT_BINARY)).toBe(true);
  }, 30000);

  it("a cancel aborts the request", async () => {
    await open("/scripts/cookie");
    const sent = started(
      await run("start", {
        url: `${origin}/scripts/hold`,
        method: "GET",
        headers: [],
        mode: "cors",
      }),
    );
    // The first eight bytes arrive; the rest never does.
    const first = await run("read", { handle: sent.handle, max: 8 });
    expect(first).toMatchObject({
      ok: true,
      phase: "read",
      done: false,
      bytes: 8,
    });
    expect(await run("cancel", { handle: sent.handle })).toEqual({
      ok: true,
      phase: "cancel",
    });
    await expect
      .poll(() => events.some((event) => event.type === "script-fetch-aborted"))
      .toBe(true);
    // The handle goes with the cancel, so a later read says so.
    expect(await run("read", { handle: sent.handle })).toMatchObject({
      ok: false,
      code: "page_changed",
    });
    // Cancelling again changes nothing.
    expect(await run("cancel", { handle: sent.handle })).toEqual({
      ok: true,
      phase: "cancel",
    });
  }, 30000);

  it("a cancel reaches a request whose response has not arrived", async () => {
    await open("/scripts/cookie");
    // The route names the handle before it sends the start, so this cancel
    // lands while the server is still silent.
    const handle = "00112233445566778899aabbccddeeff";
    const sent = run("start", {
      handle,
      url: `${origin}/scripts/silent`,
      method: "GET",
      headers: [],
      mode: "cors",
    });
    await expect
      .poll(() => events.some((event) => event.path === "/scripts/silent"))
      .toBe(true);
    expect(await run("cancel", { handle })).toEqual({
      ok: true,
      phase: "cancel",
    });
    expect(await sent).toMatchObject({
      ok: false,
      code: "fetch_failed",
      name: "AbortError",
      pageOrigin: origin,
    });
    await expect
      .poll(() => events.some((event) => event.type === "script-fetch-aborted"))
      .toBe(true);
  }, 30000);

  it("no-cors answers an opaque response", async () => {
    await open("/scripts/cookie");
    const sent = started(
      await run("start", {
        url: `${other}/scripts/no-cors`,
        method: "GET",
        headers: [],
        mode: "no-cors",
      }),
    );
    expect(sent.head).toMatchObject({
      ok: false,
      status: 0,
      statusText: "",
      type: "opaque",
      headers: {},
    });
    expect(await text(sent.handle)).toBe("");
    // The server answered: only the page is kept from reading it. A no-cors
    // GET carries no Origin header, as the page's own fetch would not.
    expect(events.at(-1)).toMatchObject({
      type: "script-fetch",
      path: "/scripts/no-cors",
      origin: "",
    });
  }, 30000);

  it("a cross-origin request carries the page's own origin", async () => {
    await open("/scripts/cookie");
    const sent = started(
      await run("start", {
        url: `${other}/scripts/cors`,
        method: "GET",
        headers: [],
        mode: "cors",
      }),
    );
    expect(sent.head).toMatchObject({ ok: true, status: 200, type: "cors" });
    expect(JSON.parse(await text(sent.handle))).toEqual({ origin });
    // The page's own fetch sends the same Origin header, so the server
    // cannot tell the two apart.
    const inPage = await page.evaluate(
      async (url) => (await (await fetch(url)).json()).origin,
      `${other}/scripts/cors`,
    );
    expect(inPage).toBe(origin);
  }, 30000);

  it("the page's content policy applies", async () => {
    await open("/scripts/csp");
    // connect-src 'self' keeps this world off other origins, exactly as it
    // keeps the page's own code off them.
    const refused = await run("start", {
      url: `${other}/scripts/cors`,
      method: "GET",
      headers: [],
      mode: "cors",
    });
    expect(refused).toMatchObject({ ok: false, code: "fetch_failed" });
    const inPage = await page.evaluate(
      (url) =>
        fetch(url).then(
          () => "read",
          (error: Error) => error.name,
        ),
      `${other}/scripts/cors`,
    );
    expect(inPage).toBe("TypeError");
    // Its own origin is allowed, so the policy is the only reason.
    const allowed = started(
      await run("start", {
        url: `${origin}/scripts/echo-cookie`,
        method: "GET",
        headers: [],
        mode: "cors",
      }),
    );
    expect(allowed.head.status).toBe(200);
  }, 30000);

  it("a service worker does not see this world's fetch", async () => {
    await open("/scripts/worker");
    expect(await page.evaluate(() => (window as any).ready)).toBe("ready");
    // The page's own fetch goes through its worker.
    const inPage = await page.evaluate(
      async (url) => (await (await fetch(url)).text()).trim(),
      `${origin}/scripts/sw-echo`,
    );
    expect(inPage).toBe(WORKER_BODY);
    // Kamapathy's world does not: its request reaches the server itself.
    const sent = started(
      await run("start", {
        url: `${origin}/scripts/sw-echo`,
        method: "GET",
        headers: [],
        mode: "cors",
      }),
    );
    expect(await text(sent.handle)).toBe(NETWORK_BODY);
    expect(events.at(-1)).toMatchObject({
      type: "script-fetch",
      path: "/scripts/sw-echo",
    });
  }, 30000);

  it("a cross-origin fetch without CORS fails with the TypeError name", async () => {
    await open("/scripts/cookie");
    const refused = await run("start", {
      url: `${other}/scripts/no-cors`,
      method: "GET",
      headers: [],
      mode: "cors",
    });
    expect(refused).toMatchObject({
      ok: false,
      code: "fetch_failed",
      name: "TypeError",
      pageOrigin: origin,
    });
    expect(typeof (refused as { error: string }).error).toBe("string");
  }, 30000);

  it("handles expire after 30 s idle and with the document", async () => {
    await open("/scripts/cookie");
    const sent = started(
      await run("start", {
        url: `${origin}/scripts/hold`,
        method: "GET",
        headers: [],
        mode: "cors",
      }),
    );
    // This world's own clock, half a minute on.
    await cdp.send("Runtime.evaluate", {
      expression: "const at = Date.now() + 31000; Date.now = () => at;",
      contextId: world,
    });
    expect(await run("read", { handle: sent.handle, max: 8 })).toMatchObject({
      ok: false,
      code: "page_changed",
    });
    await expect
      .poll(() => events.some((event) => event.type === "script-fetch-aborted"))
      .toBe(true);
    // A handle belongs to the document that opened it: the next document's
    // world knows nothing of it.
    const kept = started(
      await run("start", {
        url: `${origin}/scripts/binary`,
        method: "GET",
        headers: [],
        mode: "cors",
      }),
    );
    await page.goto(`${origin}/scripts/busy`);
    await makeWorld();
    expect(await run("read", { handle: kept.handle })).toMatchObject({
      ok: false,
      code: "page_changed",
    });
  }, 30000);
});
