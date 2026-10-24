import { remaining } from "../actions";
import { fail } from "../errors";
import { send, type RouteCall, type RouteDeps, type RouteImpl } from "../http";
import { pdfDocumentOf, pdfSource, readPdfBytes } from "../pdf/bytes";
import type { DocumentMethods } from "../pdf/document-method";
import type { Extractor } from "../pdf/extract";
import type { Step } from "../session/types";

// The pages one read may cover, and the body's defaults, as section 16.7
// and the schema give them.
const PAGE_RANGE = 500;
const MAX_CHARS = 20000;
const TIMEOUT_MS = 15000;

export interface PdfServices {
  extractor: Extractor;
  documents: DocumentMethods;
}

/**
 * "POST /tabs/:id/pdf/text". The deps are read inside the handler, so a
 * route table can be built without the PDF services.
 */
export function pdfRoutes(
  deps: RouteDeps & { pdf?: PdfServices },
): Record<string, RouteImpl> {
  const readText = async ({ response, body, tab, run }: RouteCall) => {
    const { controller, authority, actions, pdf } = deps;
    if (!pdf) throw new Error("The PDF routes have no extractor.");
    const { authorizeTab } = authority;
    const from = (body?.from as number | undefined) ?? 1;
    const last = from + PAGE_RANGE - 1;
    const to = body?.to as number | undefined;
    // One read covers 500 pages at most, and never counts backwards.
    if (to !== undefined && (to < from || to > last))
      fail("invalid_field", `to must be an integer from ${from} to ${last}.`, {
        field: "to",
        expected: `an integer from ${from} to ${last}`,
      });
    const maxChars = (body?.maxChars as number | undefined) ?? MAX_CHARS;
    const timeoutMs = (body?.timeoutMs as number | undefined) ?? TIMEOUT_MS;
    const deadline = Math.min(run.deadline, Date.now() + timeoutMs);
    const step: Step = {
      deadline,
      signal: run.signal,
      guard: () => {
        authorizeTab(tab!.id);
      },
    };
    const { contents, session } = await actions.readyContents(
      tab!.id,
      remaining(deadline),
      false,
      run.park,
    );
    const shown = await pdfDocumentOf(session, step);
    if (!shown.pdf)
      fail(
        "not_pdf",
        "This tab is not showing a PDF. Use snapshot for web pages.",
        { contentType: shown.contentType },
      );
    const url = contents.getURL();
    const main = (await session.frames(step)).find(
      (frame) => frame.parentFrameId === undefined,
    );
    const source = pdfSource(
      url,
      main && pdf.documents.method(session, main.loaderId),
    );
    const epoch = session.epoch;
    // The fetch and the extraction give the space's lane up, so other
    // requests in the space go on while this one reads.
    const bytes = await run.park(() =>
      readPdfBytes({ source, contents, session, step, timeoutMs }),
    );
    authorizeTab(tab!.id);
    if (session.epoch !== epoch || contents.getURL() !== url)
      fail(
        "page_changed",
        "The page changed while Kamapathy read the PDF. Read it again.",
      );
    const text = await run.park(() =>
      pdf.extractor.extract(bytes, { from, to, maxChars }, deadline),
    );
    // A takeover while the PDF was read withholds its text.
    authorizeTab(tab!.id);
    const count = text.pageCount;
    controller.addActivity(
      tab!.spaceId,
      `Agent read a PDF (${count} ${count === 1 ? "page" : "pages"}).`,
      "info",
    );
    return send(response, 200, {
      url,
      title: text.title || tab!.title,
      pageCount: text.pageCount,
      from: text.from,
      to: text.to,
      pages: text.pages,
      chars: text.chars,
      truncated: text.truncated,
      ...(text.nextPage === undefined ? {} : { nextPage: text.nextPage }),
      ...(text.noText ? { noText: text.noText } : {}),
    });
  };
  return { "POST /tabs/:id/pdf/text": { handler: readText } };
}
