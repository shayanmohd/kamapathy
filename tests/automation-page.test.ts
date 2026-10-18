// Runs the page script inside Playwright's Chromium, where shadow roots,
// frames and layout behave as they do in Kamapathy's tabs. These tests skip
// when Playwright's browser is not installed.
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DIALOG_DRAIN_SOURCE,
  dialogHandlerSource,
  dialogQueueSource,
} from "../electron/agent/dom/dialog-handler";
import { pageOperation, type PageOperation } from "../electron/automation-dom";
import { framePages } from "./fixtures/frame-pages.mjs";

const executable = chromium.executablePath();
const browserAvailable = !!executable && existsSync(executable);
const script = `(${pageOperation.toString()})`;

describe.skipIf(!browserAvailable)("page script in Chromium", () => {
  let site: Server;
  let origin: string;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    site = createServer((request, response) => {
      const html = framePages[new URL(request.url || "/", "http://x").pathname];
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
  const open = async (path: string) => {
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
  // frameIndex takes the frame element itself, which cannot travel as JSON.
  const frameIndex = async (
    find: () => Element | null | undefined,
    namespace = "test",
  ): Promise<any> =>
    page.evaluate(
      ([script, element, namespace]) =>
        (0, eval)(script)("frameIndex", { element }, namespace),
      [script, await page.evaluateHandle(find), namespace] as const,
    );
  // The frame /frames/shadow-frame hosts in a shadow root.
  const shadowFrame = () =>
    document.getElementById("widget")!.shadowRoot!.getElementById("embedded");
  const snapshot = () =>
    operate("snapshot", {
      mode: "full",
      maxChars: 24000,
      maxControls: 100,
      firstRef: 1,
    });
  const byLabel = (listing: any, label: string) =>
    listing.interactables.find((control: any) => control.label === label);
  const frameAt = (path: string) =>
    page.frames().find((frame) => frame.url().endsWith(path))!;

  it("counts native input inside a frame hosted by a shadow root", async () => {
    await open("/frames/shadow-frame");
    const listing = await snapshot();
    const count = byLabel(listing, "Count clicks");
    expect(count.frame).toBe("0");
    const armed = await operate("input");
    const point = await operate("target", { ref: count.ref });
    expect(point.ok).toBe(true);
    await page.mouse.click(point.x, point.y);
    const received = await operate("input");
    expect(received.mouse).toBe(armed.mouse + 1);
    expect(await frameAt("/frames/embedded").evaluate(() => (window as any).clicks)).toBe(1);
    const word = byLabel(listing, "Embedded word");
    expect((await operate("focus", { ref: word.ref })).ok).toBe(true);
    await page.keyboard.press("Enter");
    expect((await operate("input")).key).toBe(received.key + 1);
    expect((await snapshot()).text).toMatch(/Entered/);
  }, 20000);

  it("scrolls the frame around a target instead of the page", async () => {
    await open("/frames/scroller");
    const first = byLabel(await snapshot(), "First item");
    expect(first.frame).toBe("0");
    const result = await operate("scroll", {
      direction: "down",
      pixels: 600,
      ref: first.ref,
    });
    expect(result).toMatchObject({
      ok: true,
      scrolled: "page",
      x: 0,
      y: 600,
      moved: true,
    });
    expect(await frameAt("/frames/tall").evaluate(() => scrollY)).toBe(600);
    expect(await page.evaluate(() => scrollY)).toBe(0);
  }, 20000);

  it("lands clicks inside frames drawn at another scale", async () => {
    await open("/frames/scaled");
    const listing = await snapshot();
    for (const [frame, title] of [
      ["0", "Scaled grid"],
      ["1", "Zoomed grid"],
    ]) {
      const control = listing.interactables.find(
        (control: any) => control.label === "Target" && control.frame === frame,
      );
      const point = await operate("target", { ref: control.ref });
      expect(point.ok).toBe(true);
      await page.mouse.click(point.x, point.y);
      const text = (await snapshot()).text;
      expect(text).toContain(`${title} hit Target`);
      expect(text).not.toContain("hit Decoy");
    }
  }, 20000);

  it("resolves a selector in the top document before the frames", async () => {
    await open("/frames/twins");
    const saves = (await snapshot()).interactables.filter(
      (control: any) => control.label === "Save",
    );
    expect(saves.map((control: any) => control.frame)).toEqual([undefined, "0"]);
    expect(saves[0].selector).toBe("#save");
    expect(saves[1].selector).not.toBe("#save");
    const outer = await operate("target", { selector: "#save" });
    expect(outer.ok).toBe(true);
    await page.mouse.click(outer.x, outer.y);
    expect(
      await page.evaluate(() => document.getElementById("twin-result")!.textContent),
    ).toBe("Outer saved");
    // One match in the top document wins over two inside the frame.
    expect(await operate("target", { selector: "button" })).toMatchObject({
      ok: true,
      x: outer.x,
      y: outer.y,
    });
    const inner = await operate("target", { selector: "#other" });
    expect(inner.ok).toBe(true);
    await page.mouse.click(inner.x, inner.y);
    expect(
      await frameAt("/frames/twin").evaluate(
        () => document.getElementById("other")!.textContent,
      ),
    ).toBe("Other saved");
    expect(await operate("target", { selector: ".twin" })).toMatchObject({
      ok: false,
      error: "Selector matched 2 elements. Use a unique selector.",
    });
  }, 20000);

  it("leaves out frames and shadow trees hidden by CSS visibility", async () => {
    await open("/frames/hidden");
    const before = await snapshot();
    expect(before.text).toContain("Shown around the frames");
    expect(before.text).not.toContain("Twin text");
    expect(before.text).not.toContain("Veiled text");
    expect(before.interactables).toEqual([]);
    await page.evaluate(() => {
      for (const element of document.querySelectorAll<HTMLElement>(
        "#hidden,#collapsed,#veiled",
      ))
        element.style.visibility = "visible";
    });
    const after = await snapshot();
    expect(after.text).toContain("Twin text");
    expect(after.text).toContain("Veiled text");
    expect(after.interactables.map((control: any) => control.label)).toEqual([
      "Save",
      "Other",
      "Save",
      "Other",
      "Veiled button",
    ]);
  }, 20000);

  it("ready returns the document's readyState", async () => {
    await open("/frames/outer");
    expect(await operate("ready", {}, "internal")).toEqual({
      ok: true,
      readyState: "complete",
    });
  }, 20000);

  it("frameIndex returns the index snapshots print for a frame inside a shadow root", async () => {
    await open("/frames/shadow-frame");
    const count = byLabel(await snapshot(), "Count clicks");
    expect(count.frame).toBe("0");
    expect(await frameIndex(shadowFrame)).toEqual({ ok: true, path: "0" });
    // A frame inside a frame is counted from this world's document.
    await page.goto(origin + "/frames/outer");
    await page.waitForLoadState("networkidle");
    expect(byLabel(await snapshot(), "Deep button").frame).toBe("0/0");
    expect(
      await frameIndex(() =>
        document
          .querySelector<HTMLIFrameElement>("#inner")!
          .contentDocument!.getElementById("nested"),
      ),
    ).toEqual({ ok: true, path: "0/0" });
    expect(await frameIndex(() => document.body)).toMatchObject({ ok: false });
  }, 20000);

  it("ready and frameIndex leave refs from a snapshot under another namespace valid", async () => {
    await open("/frames/shadow-frame");
    const count = byLabel(await snapshot(), "Count clicks");
    expect(await operate("ready", {}, "internal")).toMatchObject({ ok: true });
    expect(await frameIndex(shadowFrame, "internal")).toEqual({
      ok: true,
      path: "0",
    });
    expect(await operate("target", { ref: count.ref })).toMatchObject({
      ok: true,
    });
  }, 20000);

  // Section 7's dialog handler, installed in the page the way an init script
  // installs it, with a stand-in for the CDP binding it reports through.
  const BINDING = "__kamapathyReports";
  const EVENT = "kamapathy-dialog-test";
  const installDialogs = async (
    options: {
      mode?: "agent" | "person";
      policy?: { accept: boolean; promptText?: string } | null;
      key?: string;
      binding?: string;
      event?: string;
    } = {},
  ) => {
    await page.evaluate((binding) => {
      const scope = globalThis as unknown as Record<string, unknown>;
      scope.__reports = scope.__reports ?? [];
      scope[binding] = (text: string) => {
        (scope.__reports as string[]).push(text);
      };
    }, BINDING);
    await page.evaluate(
      dialogHandlerSource({
        binding: options.binding ?? BINDING,
        key: options.key ?? "__kamapathyUpdate",
        mode: options.mode ?? "agent",
        policy: options.policy ?? null,
        ...(options.event === undefined ? {} : { event: options.event }),
      }),
    );
  };
  const dialogReports = () =>
    page.evaluate(() =>
      ((globalThis as unknown as { __reports: string[] }).__reports ?? []).map(
        (text) => JSON.parse(text) as Record<string, unknown>,
      ),
    );

  it("handler answers from the policy and reports", async () => {
    await open("/frames/other");
    await installDialogs();
    // Dismissing is the default: confirm is false and prompt is null.
    expect(
      await page.evaluate(() => [
        window.confirm("Delete this file?"),
        window.prompt("Your name?", "preset"),
      ]),
    ).toEqual([false, null]);
    // A second install finds the updater and changes the policy in place.
    await installDialogs({ policy: { accept: true, promptText: "Ada" } });
    expect(
      await page.evaluate(() => [
        window.confirm("Delete this file?"),
        window.prompt("Your name?", "preset"),
      ]),
    ).toEqual([true, "Ada"]);
    // An accepted prompt without text returns the default value.
    await installDialogs({ policy: { accept: true } });
    expect(
      await page.evaluate(() => [
        window.prompt("Your name?", "preset"),
        window.prompt("Your name?"),
      ]),
    ).toEqual(["preset", ""]);
    const seen = await dialogReports();
    expect(seen).toEqual([
      {
        type: "confirm",
        message: "Delete this file?",
        answer: "dismissed",
        url: page.url(),
      },
      {
        type: "prompt",
        message: "Your name?",
        defaultValue: "preset",
        answer: "dismissed",
        url: page.url(),
      },
      {
        type: "confirm",
        message: "Delete this file?",
        answer: "accepted",
        url: page.url(),
      },
      {
        type: "prompt",
        message: "Your name?",
        defaultValue: "preset",
        answer: "accepted",
        promptText: "Ada",
        url: page.url(),
      },
      {
        type: "prompt",
        message: "Your name?",
        defaultValue: "preset",
        answer: "accepted",
        promptText: "preset",
        url: page.url(),
      },
      {
        type: "prompt",
        message: "Your name?",
        answer: "accepted",
        promptText: "",
        url: page.url(),
      },
    ]);
  }, 20000);

  it("alerts keep the arm", async () => {
    await open("/frames/other");
    await installDialogs({ policy: { accept: true } });
    expect(
      await page.evaluate(() => [
        window.alert("Saved"),
        window.confirm("Delete this file?"),
        window.confirm("And this one?"),
      ]),
    ).toEqual([undefined, true, true]);
    expect(
      (await dialogReports()).map((report) => [report.type, report.answer]),
    ).toEqual([
      ["alert", "accepted"],
      ["confirm", "accepted"],
      ["confirm", "accepted"],
    ]);
  }, 20000);

  it("native mode shows real dialogs", async () => {
    await open("/frames/other");
    const native: string[] = [];
    page.on("dialog", async (dialog) => {
      native.push(`${dialog.type()} ${dialog.message()}`);
      await dialog.dismiss();
    });
    await installDialogs();
    expect(await page.evaluate(() => window.confirm("Agent answers"))).toBe(
      false,
    );
    expect(native).toEqual([]);
    // The person takes over, so the page gets its own functions back.
    await installDialogs({ mode: "person" });
    expect(await page.evaluate(() => window.confirm("You answer"))).toBe(false);
    expect(native).toEqual(["confirm You answer"]);
    expect(await dialogReports()).toHaveLength(1);
    // Handing the page back puts the handler in charge again.
    await installDialogs({ mode: "agent", policy: { accept: true } });
    expect(await page.evaluate(() => window.confirm("Agent again"))).toBe(true);
    expect(native).toHaveLength(1);
    expect(await dialogReports()).toHaveLength(2);
  }, 20000);

  it("reports through its event in a context without the binding", async () => {
    await open("/frames/other");
    // The queue a frame's isolated world keeps, installed twice as a
    // re-attach installs it.
    await page.evaluate(dialogQueueSource(EVENT));
    await page.evaluate(dialogQueueSource(EVENT));
    await installDialogs({ binding: "__absent", event: EVENT });
    expect(await page.evaluate(() => window.confirm("No binding here"))).toBe(
      false,
    );
    const drained = (await page.evaluate(DIALOG_DRAIN_SOURCE)) as string[];
    expect(drained.map((text) => JSON.parse(text))).toEqual([
      {
        type: "confirm",
        message: "No binding here",
        answer: "dismissed",
        url: page.url(),
      },
    ]);
    // Draining clears the queue, so nothing is reported twice.
    expect(await page.evaluate(DIALOG_DRAIN_SOURCE)).toEqual([]);
    expect(await dialogReports()).toEqual([]);
  }, 20000);
});
