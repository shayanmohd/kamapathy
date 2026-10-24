export type BlobPdfRequest = {
  offset: number;
  chunkBytes: number;
  maxBytes: number;
  // Tests only: the server reads the document's own URL.
  url?: string;
};
export type BlobPdfReply =
  | { ok: true; total: number; offset: number; data: string }
  | { ok: false; reason: "too_large"; total: number }
  | { ok: false; reason: "fetch_failed" };

// These complete functions are serialized into Kamapathy's world in a tab's
// main frame. They have no imports, no Node APIs and no access to the
// browser interface's preload bridge.
export function pdfDocument(): { contentType: string } {
  return { contentType: document.contentType };
}

// One chunk of the document's own bytes as base64. Chromium keeps a blob
// PDF's bytes in the page, so only the page can read them again.
export async function readBlobPdf(
  request: BlobPdfRequest,
): Promise<BlobPdfReply> {
  try {
    const response = await fetch(request.url ?? location.href);
    if (!response.ok) return { ok: false, reason: "fetch_failed" };
    const blob = await response.blob();
    const total = blob.size;
    if (total > request.maxBytes)
      return { ok: false, reason: "too_large", total };
    const chunk = blob.slice(
      request.offset,
      request.offset + request.chunkBytes,
    );
    const bytes = new Uint8Array(await chunk.arrayBuffer());
    let binary = "";
    for (let at = 0; at < bytes.length; at += 32768)
      binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
    return { ok: true, total, offset: request.offset, data: btoa(binary) };
  } catch {
    return { ok: false, reason: "fetch_failed" };
  }
}
