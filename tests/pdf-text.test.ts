import { describe, expect, it, vi } from "vitest";
import type { ApiError } from "../electron/agent/errors";
import {
  cMapDirectory,
  createExtractor,
  EXTRACTION_LIMIT,
} from "../electron/agent/pdf/extract";
import {
  pageText,
  readPdf,
  type PdfPages,
  type PdfReply,
} from "../electron/agent/pdf/worker";
import {
  cjkPdf,
  imagePdf,
  lockedPdf,
  textPdf,
  truncatedPdf,
} from "./fixtures/pdf/index.mjs";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  utilityProcess: { fork: vi.fn() },
}));

const cMapUrl = cMapDirectory();
const PAGES = [["Line one", "Line two"], ["Page two"], ["Three a", "Three b"]];
const TEXT = PAGES.map((lines) => lines.join("\n"));

const read = (
  bytes: Uint8Array,
  request: { from?: number; to?: number; maxChars?: number } = {},
): Promise<PdfReply> =>
  readPdf(bytes, { from: 1, maxChars: 20000, cMapUrl, ...request });

// The pages of a reply that was expected to succeed.
const ok = (reply: PdfReply): { ok: true } & PdfPages => {
  if (!reply.ok) throw new Error(`The read failed with ${reply.code}.`);
  return reply;
};

// What the call threw, so its code and fields can be read.
const failure = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("The call did not fail.");
};

class FakeChild {
  messages: unknown[] = [];
  killed = false;
  private readonly listeners = new Map<string, ((value: never) => void)[]>();

  postMessage(message: unknown): void {
    this.messages.push(message);
  }
  on(event: "message" | "exit", listener: (value: never) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  send(event: "message" | "exit", value: unknown): void {
    for (const listener of this.listeners.get(event) ?? [])
      (listener as (value: unknown) => void)(value);
  }
}

describe("pdf text", () => {
  it("page numbering", async () => {
    const reply = ok(await read(textPdf(PAGES, { title: "Fixture title" })));
    expect(reply).toMatchObject({
      title: "Fixture title",
      pageCount: 3,
      from: 1,
      to: 3,
      chars: TEXT.join("").length,
      truncated: false,
    });
    expect(reply.pages).toEqual([
      { number: 1, text: TEXT[0] },
      { number: 2, text: TEXT[1] },
      { number: 3, text: TEXT[2] },
    ]);
    expect(reply.nextPage).toBeUndefined();
    const one = ok(await read(textPdf(PAGES), { from: 2, to: 2 }));
    expect(one).toMatchObject({ title: "", pageCount: 3, from: 2, to: 2 });
    expect(one.pages).toEqual([{ number: 2, text: TEXT[1] }]);
  });

  it("maxChars 0", async () => {
    const reply = ok(
      await read(textPdf(PAGES, { title: "Fixture title" }), { maxChars: 0 }),
    );
    expect(reply).toMatchObject({
      title: "Fixture title",
      pageCount: 3,
      pages: [],
      chars: 0,
      truncated: false,
    });
    expect(reply.noText).toBeUndefined();
  });

  it("truncation with nextPage", async () => {
    const bytes = textPdf(PAGES);
    const stop = ok(await read(bytes, { maxChars: TEXT[0].length + 1 }));
    expect(stop.pages).toEqual([{ number: 1, text: TEXT[0] }]);
    expect(stop).toMatchObject({
      chars: TEXT[0].length,
      truncated: true,
      nextPage: 2,
    });
    const cut = ok(await read(bytes, { maxChars: 4 }));
    expect(cut.pages).toEqual([{ number: 1, text: TEXT[0].slice(0, 4) }]);
    expect(cut).toMatchObject({ chars: 4, truncated: true, nextPage: 1 });
  });

  it("noText", async () => {
    const reply = ok(await read(imagePdf()));
    expect(reply.pages).toEqual([{ number: 1, text: "" }]);
    expect(reply).toMatchObject({
      pageCount: 1,
      chars: 0,
      truncated: false,
      noText: true,
    });
  });

  it("CJK", async () => {
    const reply = ok(await read(cjkPdf("你好世界")));
    expect(reply.pages).toEqual([{ number: 1, text: "你好世界" }]);
  });

  it("pdf_locked", async () => {
    expect(await read(lockedPdf())).toEqual({ ok: false, code: "pdf_locked" });
  });

  it("pdf_unreadable", async () => {
    expect(await read(truncatedPdf())).toEqual({
      ok: false,
      code: "pdf_unreadable",
    });
    expect(await read(Buffer.from("this is not a pdf at all"))).toEqual({
      ok: false,
      code: "pdf_unreadable",
    });
    expect(await read(textPdf(PAGES), { from: 5 })).toEqual({
      ok: false,
      code: "page_out_of_range",
      pageCount: 3,
    });
  });

  it("text assembly", () => {
    expect(
      pageText([{ str: "Line one", hasEOL: true }, { str: "Line two" }]),
    ).toBe("Line one\nLine two");
    expect(
      pageText([{ str: "  a\u0007   b  ", hasEOL: true }, { str: "c\td" }]),
    ).toBe("a b\nc\td");
    expect(pageText([{ hasEOL: true }, { str: "tail" }])).toBe("\ntail");
    expect(pageText([{ str: "a\u000db" }])).toBe("ab");
  });
});

describe("pdf extraction", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const request = { from: 1, maxChars: 10 };
  const pages: { ok: true } & PdfPages = {
    ok: true,
    title: "Two",
    pageCount: 2,
    from: 1,
    to: 2,
    pages: [{ number: 1, text: "one" }],
    chars: 3,
    truncated: true,
    nextPage: 2,
  };

  it("worker killed at the deadline", async () => {
    const child = new FakeChild();
    const extractor = createExtractor({ fork: () => child, cMapUrl });
    const error = await failure(
      extractor.extract(bytes, request, Date.now() + 30),
    );
    expect(error.code).toBe("pdf_timeout");
    expect(error.fields.awaited).toBe("extract");
    expect(error.fields.timeoutMs).toBeLessThanOrEqual(30);
    expect(child.killed).toBe(true);
    expect(child.messages).toEqual([
      { data: bytes, request: { ...request, cMapUrl } },
    ]);
    expect(extractor.running()).toBe(0);
  });

  it("an exit without a reply", async () => {
    const child = new FakeChild();
    const extractor = createExtractor({ fork: () => child, cMapUrl });
    const promise = extractor.extract(bytes, request, Date.now() + 10000);
    child.send("exit", 1);
    const error = await failure(promise);
    expect(error.code).toBe("pdf_unreadable");
    expect(extractor.running()).toBe(0);
  });

  it("a refusal from the worker", async () => {
    const child = new FakeChild();
    const extractor = createExtractor({ fork: () => child, cMapUrl });
    const promise = extractor.extract(bytes, request, Date.now() + 10000);
    child.send("message", {
      ok: false,
      code: "page_out_of_range",
      pageCount: 7,
    });
    const error = await failure(promise);
    expect(error.code).toBe("page_out_of_range");
    expect(error.fields).toEqual({ pageCount: 7 });
    expect(error.message).toContain("7 pages");
  });

  it("two at a time", async () => {
    const children: FakeChild[] = [];
    const extractor = createExtractor({
      fork: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      cMapUrl,
    });
    const deadline = Date.now() + 10000;
    const first = extractor.extract(bytes, request, deadline);
    const second = extractor.extract(bytes, request, deadline);
    expect(extractor.running()).toBe(EXTRACTION_LIMIT);
    const error = await failure(extractor.extract(bytes, request, deadline));
    expect(error.code).toBe("busy");
    expect(error.fields).toEqual({ scope: "pdf" });
    expect(children).toHaveLength(2);
    children[0].send("message", pages);
    await expect(first).resolves.toEqual(pages);
    expect(extractor.running()).toBe(1);
    const third = extractor.extract(bytes, request, deadline);
    expect(children).toHaveLength(3);
    children[1].send("message", pages);
    children[2].send("message", pages);
    await Promise.all([second, third]);
    expect(extractor.running()).toBe(0);
  });
});
