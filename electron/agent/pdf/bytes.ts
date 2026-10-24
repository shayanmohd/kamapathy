import { pdfDocument, readBlobPdf, type BlobPdfReply } from "../dom/pdf";
import { fail } from "../errors";
import { ContextLostError, DialogOpenError } from "../session/errors";
import type { TabSession } from "../session/tab-session";
import type { Step } from "../session/types";

export const PDF_LIMIT_BYTES = 64 * 1024 * 1024;
export const BLOB_PDF_LIMIT_BYTES = 16 * 1024 * 1024;
export const BLOB_CHUNK_BYTES = 4 * 1024 * 1024;

export interface PdfSource {
  kind: "http" | "blob";
  url: string;
}
export interface PdfBytesOptions {
  source: PdfSource;
  contents: {
    session: { fetch(input: string, init?: RequestInit): Promise<Response> };
  };
  session: TabSession;
  step: Step;
  // The route's own timeout, which a timeout reports.
  timeoutMs?: number;
}

const tooLarge = (limitBytes: number): never =>
  fail(
    "pdf_too_large",
    `The PDF is larger than ${limitBytes / (1024 * 1024)} MiB.`,
    { limitBytes },
  );
const unreadable = (): never =>
  fail("pdf_unreadable", "This is not a PDF Kamapathy can read.");
const fetchFailed = (httpStatus?: number): never =>
  httpStatus === undefined
    ? fail(
        "pdf_fetch_failed",
        "Kamapathy could not read the PDF again. Try again.",
      )
    : fail(
        "pdf_fetch_failed",
        `Kamapathy could not read the PDF again: the site answered HTTP ${httpStatus}.`,
        { httpStatus },
      );
const timedOut = (timeoutMs: number): never =>
  fail(
    "pdf_timeout",
    `Reading the PDF did not finish within ${timeoutMs} ms.`,
    {
      awaited: "fetch",
      timeoutMs,
    },
  );

// Runs one of dom/pdf.ts's functions with a JSON argument in Kamapathy's
// world of the tab's main frame. Nothing an agent sends becomes code.
export async function runInMainWorld<A, T>(
  session: TabSession,
  fn: (arg: A) => T | Promise<T>,
  arg: A,
  step: Step,
): Promise<T> {
  const dialog = session.dialog();
  if (dialog) throw new DialogOpenError(dialog, false);
  const expression = `(${fn.toString()})(${JSON.stringify(arg)})`;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const frameId = await session.mainFrameId(step);
      const { sessionId, contextId } = await session.world(frameId, step);
      const reply = await session.send<{
        result?: { value?: unknown };
        exceptionDetails?: {
          text?: string;
          exception?: { description?: string };
        };
      }>(
        "Runtime.evaluate",
        {
          expression,
          contextId,
          returnByValue: true,
          awaitPromise: true,
          silent: true,
        },
        {
          sessionId,
          deadline: step.deadline,
          signal: step.signal,
          guard: step.guard,
        },
      );
      if (reply.exceptionDetails)
        throw new Error(
          reply.exceptionDetails.exception?.description ??
            reply.exceptionDetails.text ??
            "The page operation failed.",
        );
      return reply.result?.value as T;
    } catch (error) {
      // The world was gone before the call ran: make it again, once.
      if (attempt === 0 && error instanceof ContextLostError && !error.started)
        continue;
      throw error;
    }
  }
}

// Section 4's snapshot header and the pdf route read this.
export async function pdfDocumentOf(
  session: TabSession,
  step: Step,
): Promise<{ contentType: string; pdf: boolean }> {
  const reply = await runInMainWorld(session, pdfDocument, {}, step);
  const contentType =
    typeof reply?.contentType === "string" ? reply.contentType : "";
  return { contentType, pdf: contentType === "application/pdf" };
}

// Which bytes a PDF can be read from again. A form submission's result is
// never sent a second time.
export function pdfSource(url: string, method: string | undefined): PdfSource {
  let scheme = "";
  try {
    scheme = new URL(url).protocol;
  } catch {
    scheme = "";
  }
  if (scheme === "http:" || scheme === "https:") {
    if (method !== undefined && method.toUpperCase() !== "GET")
      fail(
        "pdf_not_refetchable",
        "This PDF came from a form submission, and Kamapathy never sends a form again to read it. Ask the person to save the PDF.",
        { reason: "post" },
      );
    return { kind: "http", url };
  }
  if (scheme === "blob:") return { kind: "blob", url };
  return fail(
    "pdf_not_refetchable",
    "Kamapathy reads PDFs from web addresses and blob: URLs only.",
    { reason: "scheme" },
  );
}

export async function readPdfBytes(options: PdfBytesOptions): Promise<Buffer> {
  const bytes =
    options.source.kind === "http"
      ? await readOverHttp(options)
      : await readFromPage(options);
  if (!bytes.subarray(0, 1024).includes("%PDF-", 0, "latin1")) unreadable();
  return bytes;
}

// The tab's own session, so the re-read carries its cookies and cache.
async function readOverHttp(options: PdfBytesOptions): Promise<Buffer> {
  const { step } = options;
  const left = step.deadline - Date.now();
  const timeoutMs = options.timeoutMs ?? Math.max(0, left);
  if (left <= 0) timedOut(timeoutMs);
  const expiry = AbortSignal.timeout(left);
  const signal = step.signal ? AbortSignal.any([step.signal, expiry]) : expiry;
  // A failed fetch or body read: the deadline, a takeover, or the site.
  const readFailed = (): never => {
    step.guard?.();
    if (expiry.aborted || Date.now() >= step.deadline) timedOut(timeoutMs);
    return fetchFailed();
  };
  let response: Response;
  try {
    response = await options.contents.session.fetch(options.source.url, {
      credentials: "include",
      cache: "force-cache",
      redirect: "follow",
      signal,
    });
  } catch {
    return readFailed();
  }
  if (!response.ok) fetchFailed(response.status);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > PDF_LIMIT_BYTES)
    tooLarge(PDF_LIMIT_BYTES);
  if (!response.body) return unreadable();
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(Buffer.from(value));
        total += value.byteLength;
      }
      if (total > PDF_LIMIT_BYTES) break;
    }
  } catch {
    return readFailed();
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (total > PDF_LIMIT_BYTES) tooLarge(PDF_LIMIT_BYTES);
  return Buffer.concat(chunks);
}

// Chromium keeps a blob PDF's bytes in the page, so the page reads them.
async function readFromPage(options: PdfBytesOptions): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (let offset = 0; ; offset += BLOB_CHUNK_BYTES) {
    const reply: BlobPdfReply = await runInMainWorld(
      options.session,
      readBlobPdf,
      {
        offset,
        chunkBytes: BLOB_CHUNK_BYTES,
        maxBytes: BLOB_PDF_LIMIT_BYTES,
      },
      options.step,
    );
    if (!reply?.ok) {
      if (reply?.reason === "too_large") tooLarge(BLOB_PDF_LIMIT_BYTES);
      return fetchFailed();
    }
    if (!reply.total) unreadable();
    chunks.push(Buffer.from(reply.data, "base64"));
    if (offset + BLOB_CHUNK_BYTES >= reply.total) break;
  }
  return Buffer.concat(chunks);
}
