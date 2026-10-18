// Runs the form script inside Playwright's Chromium against the sign-in
// pages. Like the frame preload, it starts in every frame before the page's
// own scripts. These tests skip when Playwright's browser is not installed.
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { watchForms, type HelloReply } from "../electron/passwords/form-dom";
import { signInPages } from "./fixtures/sign-in-pages.mjs";

const executable = chromium.executablePath();
const browserAvailable = !!executable && existsSync(executable);
const script = `(${watchForms.toString()})`;
const flagsOn: HelloReply = { fill: true, capture: true, checkOutcome: false };
const captured = (payload: Record<string, string>) => ({
  channel: "captured",
  payload,
});
const signIn = captured({
  kind: "sign-in",
  username: "ada",
  password: "correct horse 1",
});

describe.skipIf(!browserAvailable)("form script in Chromium", () => {
  let site: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    // Form posts and form gets answer 204, so the page stays with what its
    // script sent.
    site = createServer((request, response) => {
      const url = new URL(request.url || "/", "http://x");
      const html =
        request.method === "GET" && !url.search
          ? signInPages[url.pathname]
          : undefined;
      response.writeHead(html ? 200 : 204, { "Content-Type": "text/html" });
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
  // Every frame gets the script before its own scripts run, with an env that
  // records what it sends, answers hello (null refuses it, as main does for
  // a frame it does not serve) and keeps the listener main reaches the frame
  // through.
  const open = async (path: string, hello: HelloReply | null = flagsOn) => {
    await page?.close();
    page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.addInitScript(
      ([source, reply]) => {
        const world = window as any;
        world.__formsSent = [];
        world.__formsHello = reply;
        (0, eval)(source)({
          send: (channel: string, payload: unknown) =>
            world.__formsSent.push({ channel, payload, at: performance.now() }),
          invoke: () =>
            world.__formsHello
              ? Promise.resolve(world.__formsHello)
              : Promise.reject(new Error("No handler registered")),
          onMessage: (listener: unknown) => {
            world.__formsDeliver = listener;
          },
        });
      },
      [script, hello] as const,
    );
    await page.goto(origin + path);
  };
  const sent = async (frame: Page | Frame = page): Promise<any[]> =>
    (await frame.evaluate(() => (window as any).__formsSent)).map(
      ({ channel, payload }: any) => ({ channel, payload }),
    );
  const deliver = (
    channel: "state" | "fill",
    payload: unknown,
    frame: Page | Frame = page,
  ) =>
    frame.evaluate(
      ([channel, payload]) => (window as any).__formsDeliver(channel, payload),
      [channel, payload] as const,
    );
  // The script sends while the page handles the event, so a short wait is
  // enough to show nothing was sent.
  const settle = () => page.waitForTimeout(100);
  const signInAs = async (username: string, password: string) => {
    await page.fill("#username", username);
    await page.fill("#password", password);
  };

  it("classifies the four form kinds in frames and shadow roots", async () => {
    await open("/passwords/sign-in");
    await signInAs("ada", "correct horse 1");
    await page.click("#submit");
    await expect.poll(sent).toEqual([signIn]);

    await open("/passwords/sign-up");
    await page.fill("#email", "ada@example.com");
    await page.fill("#new-password", "new horse 2");
    await page.fill("#confirm-password", "new horse 2");
    await page.click("#submit");
    await expect.poll(sent).toEqual([
      captured({
        kind: "sign-up",
        username: "ada@example.com",
        newPassword: "new horse 2",
      }),
    ]);

    // The page filled in the hidden username.
    await open("/passwords/change");
    await page.fill("#current-password", "correct horse 1");
    await page.fill("#new-password", "new horse 2");
    await page.fill("#confirm-password", "new horse 2");
    await page.click("#submit");
    await expect.poll(sent).toEqual([
      captured({
        kind: "change",
        username: "ada",
        password: "correct horse 1",
        newPassword: "new horse 2",
      }),
    ]);

    await open("/passwords/username-first");
    await page.fill("#username", "ada@example.com");
    await page.click("#next");
    await expect
      .poll(sent)
      .toEqual([captured({ kind: "username", username: "ada@example.com" })]);

    await open("/passwords/frames");
    const frame = page
      .frames()
      .find((frame) => frame.url().endsWith("/passwords/sign-in"))!;
    await frame.fill("#username", "ada");
    await frame.fill("#password", "correct horse 1");
    await frame.click("#submit");
    await expect.poll(() => sent(frame)).toEqual([signIn]);
    expect(await sent()).toEqual([]);

    await open("/passwords/shadow");
    await page.fill("#shadow-username", "ada");
    await page.fill("#shadow-password", "correct horse 1");
    await page.click("#shadow-submit");
    await expect.poll(sent).toEqual([signIn]);

    // Three fields make a change only when the last two agree, and four
    // fields are none of the kinds.
    await open("/passwords/change");
    await page.fill("#current-password", "correct horse 1");
    await page.fill("#new-password", "new horse 2");
    await page.fill("#confirm-password", "new horse 3");
    await page.click("#submit");
    await settle();
    expect(await sent()).toEqual([]);
    await page.$eval("#submit", (button) => {
      const fourth = document.createElement("input");
      fourth.type = "password";
      fourth.id = "fourth-password";
      button.before(fourth);
    });
    for (const id of ["current", "new", "confirm", "fourth"])
      await page.fill(`#${id}-password`, "new horse 2");
    await page.click("#submit");
    await page.focus("#fourth-password");
    await page.keyboard.press("Enter");
    await settle();
    expect(await sent()).toEqual([]);
  }, 30000);

  it("captures submit, submit clicks and Enter once, never untrusted events", async () => {
    await open("/passwords/sign-in");
    await signInAs("ada", "correct horse 1");
    // The click submits the form, and the second click comes within 1000 ms.
    await page.click("#submit");
    await page.click("#submit");
    await settle();
    expect(await sent()).toEqual([signIn]);
    await page.waitForTimeout(1000);
    await page.click("#submit");
    await expect.poll(sent).toEqual([signIn, signIn]);

    // Enter fires keydown, then a click on the submit button and submit.
    await open("/passwords/sign-in");
    await signInAs("ada", "correct horse 1");
    await page.focus("#password");
    await page.keyboard.press("Enter");
    await settle();
    expect(await sent()).toEqual([signIn]);

    await open("/passwords/sign-in");
    await signInAs("ada", "correct horse 1");
    await page.evaluate(() => {
      document
        .getElementById("sign-in")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      document.getElementById("submit")!.click();
      document
        .getElementById("password")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
    });
    await settle();
    expect(await sent()).toEqual([]);
    // The group could capture, as a trusted Enter shows.
    await page.focus("#password");
    await page.keyboard.press("Enter");
    await expect.poll(sent).toEqual([signIn]);

    // A link that submits the form from its click handler is caught by the
    // submit alone.
    await open("/passwords/sign-in");
    await signInAs("ada", "correct horse 1");
    await page.$eval("#sign-in", (form) => {
      const link = document.createElement("a");
      link.id = "submit-link";
      link.href = "#";
      link.textContent = "Continue";
      link.onclick = (event) => {
        event.preventDefault();
        (form as HTMLFormElement).requestSubmit();
      };
      form.append(link);
    });
    await page.click("#submit-link");
    await expect.poll(sent).toEqual([signIn]);

    // A frame whose hello is refused gets no listener at all.
    await open("/passwords/sign-in", null);
    expect(
      await page.evaluate(() => typeof (window as any).__formsDeliver),
    ).toBe("undefined");

    await open("/passwords/sign-in", {
      fill: false,
      capture: false,
      checkOutcome: true,
    });
    await page.click("#username");
    await page.keyboard.press("ArrowDown");
    await signInAs("ada", "correct horse 1");
    await page.click("#submit");
    await page.focus("#password");
    await page.keyboard.press("Enter");
    // The outcome check would have run 500 ms after DOMContentLoaded.
    await page.waitForTimeout(600);
    expect(await sent()).toEqual([]);
  }, 30000);

  it("fills through native setters, skipping hidden, disabled and read-only fields", async () => {
    await open("/passwords/fill");
    const login = { origin, username: "ada", password: "correct horse 1" };
    const values = () =>
      page.evaluate(() =>
        Object.fromEntries(
          Array.from(document.querySelectorAll("input"), (input) => [
            input.id,
            input.value,
          ]),
        ),
      );
    const before = await values();
    // No field was reported, so the fill has nowhere to go.
    await deliver("fill", login);
    expect(await values()).toEqual(before);

    await page.click("#plain-username");
    const rect = await page.$eval("#plain-username", (input) => {
      const { x, y, width, height } = input.getBoundingClientRect();
      return { x, y, width, height };
    });
    const [report] = await sent();
    expect(report).toEqual({
      channel: "field",
      payload: {
        kind: "sign-in",
        rect,
        click: { x: expect.any(Number), y: expect.any(Number) },
        cause: "click",
      },
    });
    expect(report.payload.click.x).toBeGreaterThan(0);
    expect(report.payload.click.x).toBeLessThan(rect.width);
    expect(report.payload.click.y).toBeGreaterThan(0);
    expect(report.payload.click.y).toBeLessThan(rect.height);

    await deliver("fill", {
      ...login,
      origin: origin.replace("127.0.0.1", "localhost"),
    });
    expect(await values()).toEqual(before);
    await deliver("fill", login);
    expect(await values()).toEqual({
      ...before,
      "plain-username": "ada",
      "plain-password": "correct horse 1",
    });
    expect(await page.evaluate(() => (window as any).setterCalls)).toEqual([]);
    expect(await page.evaluate(() => (window as any).fillEvents)).toEqual([
      "input plain-username",
      "change plain-username",
      "input plain-password",
      "change plain-password",
    ]);

    // A click in a filled field reports nothing; ArrowDown asks anyway.
    await page.click("#plain-username");
    await page.keyboard.press("ArrowDown");
    expect((await sent()).slice(1)).toEqual([
      { channel: "field", payload: { kind: "sign-in", rect, cause: "key" } },
    ]);

    for (const field of [
      "#hidden-password",
      "#disabled-username",
      "#readonly-password",
    ]) {
      await page.click(field);
      await deliver("fill", login);
    }
    expect(await values()).toEqual({
      ...before,
      "plain-username": "ada",
      "plain-password": "correct horse 1",
      "hidden-password": "correct horse 1",
      "disabled-username": "ada",
      "readonly-password": "correct horse 1",
    });
    expect(before).toMatchObject({
      "hidden-username": "",
      "disabled-password": "",
      "readonly-username": "grace",
    });
    expect(await page.evaluate(() => (window as any).setterCalls)).toEqual([]);

    // A username-only group gets only its username.
    await open("/passwords/username-first");
    await page.click("#username");
    expect(await sent()).toEqual([
      {
        channel: "field",
        payload: expect.objectContaining({
          kind: "username-only",
          cause: "click",
        }),
      },
    ]);
    await deliver("fill", login);
    expect(
      await page.$eval(
        "#username",
        (input) => (input as HTMLInputElement).value,
      ),
    ).toBe("ada");

    // Sign-up fields open no menu.
    await open("/passwords/sign-up");
    await page.click("#email");
    await page.click("#new-password");
    await settle();
    expect(await sent()).toEqual([]);
  }, 30000);

  it("a value typed while capture was off is never captured", async () => {
    const captureOff = { fill: true, capture: false, checkOutcome: false };
    await open("/passwords/sign-in", captureOff);
    // The page fills in the username without an input event.
    await page.$eval("#username", (input) => {
      (input as HTMLInputElement).value = "ada";
    });
    await page.fill("#password", "typed under the agent");
    await deliver("state", { fill: true, capture: true });
    await page.click("#submit");
    await settle();
    expect(await sent()).toEqual([]);
    await page.fill("#password", "correct horse 1");
    await page.click("#submit");
    await expect.poll(sent).toEqual([signIn]);

    // A username typed while capture was off holds the capture back too.
    await open("/passwords/sign-in", captureOff);
    await page.fill("#username", "eve");
    await deliver("state", { fill: true, capture: true });
    await page.fill("#password", "correct horse 2");
    await page.click("#submit");
    await settle();
    expect(await sent()).toEqual([]);
    await page.fill("#username", "grace");
    await page.click("#submit");
    await expect.poll(sent).toEqual([
      captured({
        kind: "sign-in",
        username: "grace",
        password: "correct horse 2",
      }),
    ]);
  }, 30000);

  it("reports the new document's password field and a form that went away", async () => {
    for (const [path, passwordField] of [
      ["/passwords/signed-in", false],
      ["/passwords/sign-in", true],
    ] as const) {
      await open(path, { fill: true, capture: true, checkOutcome: true });
      await expect
        .poll(sent, { timeout: 3000 })
        .toEqual([{ channel: "outcome", payload: { passwordField } }]);
      const { at, loaded } = await page.evaluate(() => ({
        at: (window as any).__formsSent[0].at as number,
        loaded: (
          performance.getEntriesByType(
            "navigation",
          )[0] as PerformanceNavigationTiming
        ).domContentLoadedEventStart,
      }));
      expect(at - loaded).toBeGreaterThanOrEqual(495);
      expect(at - loaded).toBeLessThan(1500);
    }

    await open("/passwords/sign-in");
    await signInAs("ada", "correct horse 1");
    await page.click("#submit");
    await expect.poll(sent).toEqual([signIn]);
    // The page hides the form between the first poll, 500 ms after the
    // capture, and the second.
    await page.evaluate(() => {
      const capturedAt: number = (window as any).__formsSent[0].at;
      return new Promise<void>((done) =>
        setTimeout(
          () => {
            document.getElementById("sign-in")!.style.display = "none";
            done();
          },
          capturedAt + 650 - performance.now(),
        ),
      );
    });
    const gone = { channel: "outcome", payload: { formGone: true } };
    await expect.poll(sent, { timeout: 2000 }).toEqual([signIn, gone]);
    // The second and third polls both saw the field gone.
    const [capturedAt, goneAt] = await page.evaluate(() =>
      (window as any).__formsSent.map((sent: any) => sent.at as number),
    );
    expect(goneAt - capturedAt).toBeGreaterThan(1250);
    // Polling stopped, so the next poll's time passes without a second one.
    await page.waitForTimeout(700);
    expect(await sent()).toEqual([signIn, gone]);
  }, 30000);
});
