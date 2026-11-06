// Runs an agent's page script in Playwright's Chromium, whose own execution
// limit and by-value replies answer as they do in Kamapathy's tabs. These
// tests skip when Playwright's browser is not installed.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../electron/agent/errors";
import { evaluateScript, type ScriptStep } from "../electron/agent/evaluate";
import { EventBufferPool } from "../electron/agent/session/event-buffer";
import { TabSession } from "../electron/agent/session/tab-session";
import {
  chromiumAvailable,
  launchChromium,
  type ChromiumBrowser,
  type ChromiumPage,
} from "./cdp-socket";

describe.skipIf(!chromiumAvailable)("evaluate in Chromium", () => {
  let browser: ChromiumBrowser;
  let page: ChromiumPage | undefined;
  let tab: TabSession | undefined;
  beforeAll(async () => {
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
  }, 60000);
  // A page whose session is ready, so a script's limits start when it is
  // sent.
  const open = async () => {
    page = await browser.newPage();
    tab = new TabSession(page.host, {
      tabId: "tab-1",
      waitForSpaceIdle: async () => {},
      buffer: new EventBufferPool().create("tab-1"),
    });
    tab.attach();
    await tab.send(
      "Runtime.evaluate",
      { expression: "0" },
      { deadline: Date.now() + 20000 },
    );
    return tab;
  };
  // A step as the evaluate route builds one, with its shortest timeout: the
  // page's own limit comes 1000 ms in.
  const step = (): ScriptStep => ({
    deadline: Date.now() + 2000,
    timeoutMs: 2000,
    dispatch: { dispatched: false },
  });
  const failure = (call: Promise<unknown>) =>
    call.then(
      () => undefined,
      (error: unknown) => error,
    );

  it("the page's own limit stops a busy script, and the page answers after it", async () => {
    const session = await open();
    const error = await failure(
      evaluateScript(
        session,
        {
          function:
            "() => { const end = Date.now() + 30000; while (Date.now() < end) {} }",
        },
        step(),
      ),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("evaluation_timeout");
    expect((error as ApiError).fields).toEqual({
      awaited: "script",
      timeoutMs: 2000,
      executionStopped: true,
      mayHaveLateEffects: true,
      pageResponsive: true,
    });
    expect(
      await evaluateScript(session, { function: "() => 1 + 1" }, step()),
    ).toEqual({ value: 2 });
  }, 30000);

  it("a value Chromium cannot return, settled after the limit, is the page's own failure", async () => {
    const session = await open();
    // Chromium answers this with the same internal error as its own limit,
    // 500 ms after that limit.
    const error = await failure(
      evaluateScript(
        session,
        {
          function:
            "() => new Promise((resolve) => setTimeout(() => resolve({ get x() { throw new Error('no') } }), 1500))",
        },
        step(),
      ),
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ApiError);
    expect((error as Error).message).toBe("Internal error");
  }, 30000);

  it("a script whose own continuation holds the page past both limits is left running", async () => {
    const session = await open();
    // The limit covers only the script's own run, so the work it continues
    // with holds the main thread from 400 ms to 2150 ms, past the call's own
    // limit, and the script then waits on a promise that never settles.
    const error = await failure(
      evaluateScript(
        session,
        {
          function: `async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            const end = Date.now() + 1750;
            while (Date.now() < end) {}
            await new Promise((resolve) => setTimeout(resolve, 300));
            window.finished = true;
            await new Promise(() => {});
          }`,
        },
        step(),
      ),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).fields).toEqual({
      awaited: "script",
      timeoutMs: 2000,
      executionStopped: false,
      mayHaveLateEffects: true,
      pageResponsive: true,
    });
    // Nothing stopped it, so its work still lands.
    await expect
      .poll(
        () =>
          evaluateScript(
            session,
            { expression: "window.finished === true" },
            step(),
          ),
        { timeout: 5000, interval: 100 },
      )
      .toEqual({ value: true });
  }, 30000);
});
