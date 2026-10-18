// Reads a PDF's text. This file runs in its own utility process and
// imports nothing else from Kamapathy, so the parser stays away from the
// browser: no network, no eval path, no fonts, one PDF per process and a
// deadline the parent enforces.

export interface PdfRequest {
  from: number;
  to?: number;
  maxChars: number;
  cMapUrl: string;
}
export interface PdfPages {
  title: string;
  pageCount: number;
  from: number;
  to: number;
  pages: { number: number; text: string }[];
  chars: number;
  truncated: boolean;
  nextPage?: number;
  noText?: true;
}
export type PdfReply =
  | ({ ok: true } & PdfPages)
  | {
      ok: false;
      code: "pdf_locked" | "pdf_unreadable" | "page_out_of_range";
      pageCount?: number;
    };

const PAGE_RANGE = 500;
const TITLE_LIMIT = 300;
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F]/gu;

// A page as the agent reads it: the items in order, a line per end of line
// pdf.js reports, no control characters and no padding.
export function pageText(
  items: readonly { str?: string; hasEOL?: boolean }[],
): string {
  let text = "";
  for (const item of items) {
    text += item.str ?? "";
    if (item.hasEOL) text += "\n";
  }
  return text
    .replace(/ {2,}/gu, " ")
    .replace(CONTROLS, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

const documentTitle = (value: unknown): string =>
  typeof value === "string"
    ? value.replace(CONTROLS, "").trim().slice(0, TITLE_LIMIT)
    : "";

export async function readPdf(
  data: Uint8Array,
  request: PdfRequest,
): Promise<PdfReply> {
  // pdf.js reads process.type to tell a browser from Node. In a utility
  // process it reads "utility", which sends pdf.js looking for a web worker
  // and a fetchable CMap URL, so the type goes before the parser loads. The
  // build itself has no eval or Function path left, so it takes no switch.
  delete (process as unknown as { type?: string }).type;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    // pdf.js takes a plain Uint8Array, never a Buffer.
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    cMapUrl: request.cMapUrl,
    cMapPacked: true,
    verbosity: 0,
  });
  try {
    let document;
    try {
      document = await loadingTask.promise;
    } catch (error) {
      const name = (error as { name?: string } | undefined)?.name;
      return {
        ok: false,
        code: name === "PasswordException" ? "pdf_locked" : "pdf_unreadable",
      };
    }
    const pageCount = document.numPages;
    const { from, maxChars } = request;
    if (from > pageCount)
      return { ok: false, code: "page_out_of_range", pageCount };
    const to = Math.min(request.to ?? from + PAGE_RANGE - 1, pageCount);
    const title = documentTitle(
      ((await document.getMetadata()).info as { Title?: unknown } | undefined)
        ?.Title,
    );
    const pages: { number: number; text: string }[] = [];
    let chars = 0;
    let truncated = false;
    let nextPage: number | undefined;
    for (let number = from; maxChars > 0 && number <= to; number += 1) {
      const page = await document.getPage(number);
      let text: string;
      try {
        const content = await page.getTextContent();
        text = pageText(
          content.items as unknown as { str?: string; hasEOL?: boolean }[],
        );
      } finally {
        page.cleanup();
      }
      if (chars + text.length > maxChars) {
        truncated = true;
        nextPage = number;
        // A first page of its own over the cap comes back cut.
        if (pages.length === 0) {
          pages.push({ number, text: text.slice(0, maxChars) });
          chars = maxChars;
        }
        break;
      }
      pages.push({ number, text });
      chars += text.length;
    }
    const noText = pages.length > 0 && pages.every((page) => page.text === "");
    return {
      ok: true,
      title,
      pageCount,
      from,
      to,
      pages,
      chars,
      truncated,
      ...(nextPage === undefined ? {} : { nextPage }),
      ...(noText ? { noText: true as const } : {}),
    };
  } catch {
    return { ok: false, code: "pdf_unreadable" };
  } finally {
    // In pdf.js 6 the document proxy has no destroy of its own.
    await loadingTask.destroy().catch(() => {});
  }
}

interface ParentPort {
  on(
    event: "message",
    listener: (event: {
      data: { data: ArrayLike<number>; request: PdfRequest };
    }) => void,
  ): void;
  postMessage(message: unknown): void;
}

// One PDF per process: answer the request, then go.
const parentPort = (process as unknown as { parentPort?: ParentPort })
  .parentPort;
if (parentPort) {
  parentPort.on("message", (event) => {
    void (async () => {
      let reply: PdfReply;
      try {
        reply = await readPdf(
          new Uint8Array(event.data.data),
          event.data.request,
        );
      } catch {
        reply = { ok: false, code: "pdf_unreadable" };
      }
      parentPort.postMessage(reply);
      process.exit(0);
    })();
  });
}
