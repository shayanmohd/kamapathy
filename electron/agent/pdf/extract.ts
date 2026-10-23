import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { app, utilityProcess } from "electron";
import { ApiError } from "../errors";
import type { PdfPages, PdfReply, PdfRequest } from "./worker";

export const EXTRACTION_LIMIT = 2;

export interface PdfChild {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}
export interface Extractor {
  extract(
    bytes: Uint8Array,
    request: Omit<PdfRequest, "cMapUrl">,
    deadline: number,
  ): Promise<PdfPages>;
  running(): number;
}

const unreadable = (): ApiError =>
  new ApiError("pdf_unreadable", "This is not a PDF Kamapathy can read.");

// What the worker refused to read, in the agent's words.
function refusal(reply: Extract<PdfReply, { ok: false }>): ApiError {
  if (reply.code === "pdf_locked")
    return new ApiError(
      "pdf_locked",
      "The PDF needs a password, so Kamapathy cannot read it. Ask the person.",
    );
  if (reply.code === "page_out_of_range")
    return new ApiError(
      "page_out_of_range",
      `This PDF has ${reply.pageCount} pages.`,
      reply.pageCount === undefined ? {} : { pageCount: reply.pageCount },
    );
  return unreadable();
}

// Each request gets a process of its own, and two run app-wide.
export function createExtractor(
  options: { fork?: () => PdfChild; cMapUrl?: string } = {},
): Extractor {
  const fork = options.fork ?? forkPdfWorker;
  let cMapUrl = options.cMapUrl;
  let running = 0;
  return {
    running: () => running,
    async extract(bytes, request, deadline) {
      if (running >= EXTRACTION_LIMIT)
        throw new ApiError(
          "busy",
          "Two PDFs are being read. Try again shortly.",
          { scope: "pdf" },
        );
      const cmaps = (cMapUrl ??= cMapDirectory());
      // A slot is taken once the process exists, so a fork that fails holds
      // none.
      const child = fork();
      running += 1;
      const timeoutMs = Math.max(0, deadline - Date.now());
      return await new Promise<PdfPages>((resolve, reject) => {
        let settled = false;
        const finish = (action: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          running -= 1;
          action();
        };
        const timer = setTimeout(
          () =>
            finish(() => {
              child.kill();
              reject(
                new ApiError(
                  "pdf_timeout",
                  `Extracting the PDF's text did not finish within ${timeoutMs} ms.`,
                  { awaited: "extract", timeoutMs },
                ),
              );
            }),
          timeoutMs,
        );
        child.on("message", (message) => {
          const reply = message as PdfReply;
          finish(() =>
            reply?.ok ? resolve(reply) : reject(refusal(reply ?? unreadable())),
          );
        });
        // The worker left without an answer.
        child.on("exit", () => finish(() => reject(unreadable())));
        // Utility processes transfer only ports, so the bytes are copied.
        child.postMessage({
          data: bytes,
          request: { ...request, cMapUrl: cmaps },
        });
      });
    },
  };
}

export function forkPdfWorker(): PdfChild {
  const entry = fileURLToPath(new URL("./pdf-worker.js", import.meta.url));
  return utilityProcess.fork(entry, [], {
    serviceName: "Kamapathy PDF reader",
    stdio: "ignore",
    env: {},
    execArgv: ["--max-old-space-size=1024"],
  });
}

// The CMaps a predefined encoding needs, next to the app when packaged.
export function cMapDirectory(): string {
  if (app.isPackaged) return join(process.resourcesPath, "pdfjs-cmaps") + sep;
  const build = createRequire(import.meta.url).resolve(
    "pdfjs-dist/legacy/build/pdf.mjs",
  );
  return join(dirname(dirname(dirname(build))), "cmaps") + sep;
}
