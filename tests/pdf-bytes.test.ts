import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiError } from "../electron/agent/errors";
import { DocumentMethods } from "../electron/agent/pdf/document-method";
import {
  BLOB_CHUNK_BYTES,
  PDF_LIMIT_BYTES,
  pdfSource,
  readPdfBytes,
} from "../electron/agent/pdf/bytes";
import type { AutomationController } from "../electron/agent/server";
import { EventBufferPool } from "../electron/agent/session/event-buffer";
import { TabSession } from "../electron/agent/session/tab-session";
import { TabSessions } from "../electron/agent/session/tab-sessions";
import type { SessionHost, Step } from "../electron/agent/session/types";
import { isTransient } from "../skills/kamapathy/scripts/schema/index.mjs";
import { initialState, newTab } from "../shared/state";
import type { BrowserState, Space } from "../shared/types";
import { FakeContents } from "./fake-automation";
import { FakeHost } from "./fake-cdp";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(0);
const PDF = Buffer.concat([
  Buffer.from("%PDF-1.7\n"),
  Buffer.from("one page\n"),
]);
const step = (deadline = Date.now() + 10000): Step => ({ deadline });

// What the call threw, so its code and fields can be read.
const failure = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    return error as ApiError;
  }
  throw new Error("The call did not fail.");
};

// A tab whose debugger answers page operations, ready for a page operation.
async function ready(host: FakeHost = new FakeContents()) {
  const session = new TabSession(host as unknown as SessionHost, {
    tabId: "tab-1",
    waitForSpaceIdle: async () => {},
    buffer: new EventBufferPool().create("tab-1"),
  });
  session.attach();
  await settle();
  expect(session.state).toBe("ready");
  return { host, session, cdp: host.debugger };
}

// A session.fetch that answers with the chunks a body reader yields,
// recording what it was called with and how much of the body was read.
function fetcher(options: {
  chunks?: Buffer[];
  status?: number;
  headers?: Record<string, string>;
  error?: Error;
}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let reads = 0;
  let cancelled = false;
  const fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (options.error) return Promise.reject(options.error);
    const chunks = options.chunks ?? [];
    const reader = {
      read: async () => {
        const chunk = chunks[reads++];
        return chunk
          ? { done: false, value: new Uint8Array(chunk) }
          : { done: true, value: undefined };
      },
      cancel: async () => {
        cancelled = true;
      },
    };
    const status = options.status ?? 200;
    return Promise.resolve({
      ok: status < 400,
      status,
      headers: new Headers(options.headers),
      body: { getReader: () => reader },
    } as unknown as Response);
  };
  return {
    calls,
    contents: { session: { fetch } },
    get reads() {
      return reads;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

describe("pdfSource", () => {
  it("takes http and https documents loaded with GET or an unknown method", () => {
    for (const url of ["http://a.example/x.pdf", "https://a.example/x.pdf"])
      for (const method of ["GET", undefined])
        expect(pdfSource(url, method)).toEqual({ kind: "http", url });
  });

  it("refuses a form submission's result", () => {
    const error = (() => {
      try {
        pdfSource("https://a.example/x.pdf", "POST");
      } catch (thrown) {
        return thrown as ApiError;
      }
      throw new Error("POST was accepted.");
    })();
    expect(error.code).toBe("pdf_not_refetchable");
    expect(error.status).toBe(409);
    expect(error.fields).toEqual({ reason: "post" });
    expect(error.message).toBe(
      "This PDF came from a form submission, and Kamapathy never sends a form again to read it. Ask the person to save the PDF.",
    );
  });

  it("takes a blob URL whatever the method and refuses every other scheme", () => {
    for (const method of ["GET", "POST", undefined])
      expect(pdfSource("blob:https://a.example/id", method)).toEqual({
        kind: "blob",
        url: "blob:https://a.example/id",
      });
    for (const url of [
      "file:///home/person/x.pdf",
      "data:application/pdf;base64,JVBERi0=",
      "about:blank",
      "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
    ]) {
      let thrown: ApiError | undefined;
      try {
        pdfSource(url, "GET");
      } catch (error) {
        thrown = error as ApiError;
      }
      expect(thrown?.code, url).toBe("pdf_not_refetchable");
      expect(thrown?.fields, url).toEqual({ reason: "scheme" });
      expect(thrown?.message, url).toBe(
        "Kamapathy reads PDFs from web addresses and blob: URLs only.",
      );
    }
  });
});

describe("readPdfBytes over http", () => {
  const url = "https://a.example/x.pdf";
  const source = { kind: "http" as const, url };

  it("re-reads the document on the tab's own session with its cookies and cache", async () => {
    const { session } = await ready();
    const fetched = fetcher({ chunks: [PDF.subarray(0, 4), PDF.subarray(4)] });
    const bytes = await readPdfBytes({
      source,
      contents: fetched.contents,
      session,
      step: step(),
    });
    expect(bytes.equals(PDF)).toBe(true);
    expect(fetched.calls.length).toBe(1);
    expect(fetched.calls[0].url).toBe(url);
    const init = fetched.calls[0].init!;
    expect(Object.keys(init).sort()).toEqual([
      "cache",
      "credentials",
      "redirect",
      "signal",
    ]);
    expect(init).toMatchObject({
      credentials: "include",
      cache: "force-cache",
      redirect: "follow",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("stops reading a streamed body past the cap", async () => {
    const { session } = await ready();
    const chunk = Buffer.alloc(8 * 1024 * 1024, 0x20);
    chunk.write("%PDF-1.7");
    const fetched = fetcher({
      chunks: Array.from({ length: 12 }, () => chunk),
    });
    const error = await failure(
      readPdfBytes({
        source,
        contents: fetched.contents,
        session,
        step: step(),
      }),
    );
    expect(error.code).toBe("pdf_too_large");
    expect(error.status).toBe(422);
    expect(error.fields).toEqual({ limitBytes: PDF_LIMIT_BYTES });
    expect(error.message).toBe("The PDF is larger than 64 MiB.");
    expect(fetched.reads).toBe(9);
    expect(fetched.cancelled).toBe(true);
  });

  it("refuses a declared length over the cap before reading the body", async () => {
    const { session } = await ready();
    const fetched = fetcher({
      chunks: [PDF],
      headers: { "content-length": String(PDF_LIMIT_BYTES + 1) },
    });
    const error = await failure(
      readPdfBytes({
        source,
        contents: fetched.contents,
        session,
        step: step(),
      }),
    );
    expect(error.code).toBe("pdf_too_large");
    expect(error.fields).toEqual({ limitBytes: PDF_LIMIT_BYTES });
    expect(fetched.reads).toBe(0);
  });

  it("reports the site's status, and a failure without one as retryable", async () => {
    const { session } = await ready();
    const refused = fetcher({ chunks: [PDF], status: 403 });
    const denied = await failure(
      readPdfBytes({
        source,
        contents: refused.contents,
        session,
        step: step(),
      }),
    );
    expect(denied.code).toBe("pdf_fetch_failed");
    expect(denied.status).toBe(422);
    expect(denied.fields).toEqual({ httpStatus: 403 });
    expect(denied.message).toBe(
      "Kamapathy could not read the PDF again: the site answered HTTP 403.",
    );
    expect(isTransient("pdf_fetch_failed", denied.fields)).toBe(false);
    const broken = fetcher({ error: new TypeError("fetch failed") });
    const lost = await failure(
      readPdfBytes({
        source,
        contents: broken.contents,
        session,
        step: step(),
      }),
    );
    expect(lost.code).toBe("pdf_fetch_failed");
    expect(lost.fields).toEqual({});
    expect(lost.message).toBe(
      "Kamapathy could not read the PDF again. Try again.",
    );
    expect(isTransient("pdf_fetch_failed", lost.fields)).toBe(true);
  });

  it("refuses bytes without a PDF header in the first kibibyte", async () => {
    const { session } = await ready();
    const late = Buffer.concat([Buffer.alloc(1024, 0x20), PDF]);
    for (const chunks of [[Buffer.from("<html></html>")], [late]]) {
      const fetched = fetcher({ chunks });
      const error = await failure(
        readPdfBytes({
          source,
          contents: fetched.contents,
          session,
          step: step(),
        }),
      );
      expect(error.code).toBe("pdf_unreadable");
      expect(error.status).toBe(422);
      expect(error.message).toBe("This is not a PDF Kamapathy can read.");
    }
  });

  it("reports the deadline as a fetch timeout", async () => {
    const { session } = await ready();
    const fetched = fetcher({ chunks: [PDF] });
    const error = await failure(
      readPdfBytes({
        source,
        contents: fetched.contents,
        session,
        step: step(Date.now() - 1),
        timeoutMs: 15000,
      }),
    );
    expect(error.code).toBe("pdf_timeout");
    expect(error.status).toBe(504);
    expect(error.fields).toEqual({ awaited: "fetch", timeoutMs: 15000 });
    expect(error.message).toBe(
      "Reading the PDF did not finish within 15000 ms.",
    );
    expect(fetched.calls.length).toBe(0);
    // An abort while the body is in flight reads the same way.
    const aborted = fetcher({ error: new Error("The operation was aborted.") });
    const late = await failure(
      readPdfBytes({
        source,
        contents: {
          session: {
            fetch: (url: string, init?: RequestInit) => {
              vi.advanceTimersByTime(20000);
              return aborted.contents.session.fetch(url, init);
            },
          },
        },
        session,
        step: step(),
        timeoutMs: 15000,
      }),
    );
    expect(late.code).toBe("pdf_timeout");
    expect(late.fields).toEqual({ awaited: "fetch", timeoutMs: 15000 });
  });
});

describe("readPdfBytes over blob", () => {
  const url = "blob:https://a.example/id";
  const source = { kind: "blob" as const, url };
  // A page answering readBlobPdf per call, from the request the server built.
  const blobPage = (
    answer: (request: {
      offset: number;
      chunkBytes: number;
      maxBytes: number;
    }) => unknown,
  ) => {
    const requests: { offset: number; chunkBytes: number; maxBytes: number }[] =
      [];
    const host = new FakeContents();
    host.result = (code: string) => {
      const request = JSON.parse(code.slice(code.lastIndexOf(")(") + 2, -1));
      requests.push(request);
      return answer(request);
    };
    return { host, requests };
  };

  it("joins the page's chunks in order", async () => {
    const parts = [
      Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("first")]),
      Buffer.from("second"),
      Buffer.from("third"),
    ];
    const total = 2 * BLOB_CHUNK_BYTES + 10;
    const { host, requests } = blobPage(({ offset }) => ({
      ok: true,
      total,
      offset,
      data: parts[offset / BLOB_CHUNK_BYTES].toString("base64"),
    }));
    const { session } = await ready(host);
    const bytes = await readPdfBytes({
      source,
      contents: { session: { fetch: () => Promise.reject(new Error("no")) } },
      session,
      step: step(),
    });
    expect(bytes.equals(Buffer.concat(parts))).toBe(true);
    expect(requests).toEqual([
      { offset: 0, chunkBytes: BLOB_CHUNK_BYTES, maxBytes: 16 * 1024 * 1024 },
      {
        offset: BLOB_CHUNK_BYTES,
        chunkBytes: BLOB_CHUNK_BYTES,
        maxBytes: 16 * 1024 * 1024,
      },
      {
        offset: 2 * BLOB_CHUNK_BYTES,
        chunkBytes: BLOB_CHUNK_BYTES,
        maxBytes: 16 * 1024 * 1024,
      },
    ]);
  });

  it("maps the page's refusals to the PDF codes", async () => {
    const big = blobPage(() => ({
      ok: false,
      reason: "too_large",
      total: 20 * 1024 * 1024,
    }));
    const tooLarge = await failure(
      readPdfBytes({
        source,
        contents: { session: { fetch: () => Promise.reject(new Error("no")) } },
        session: (await ready(big.host)).session,
        step: step(),
      }),
    );
    expect(tooLarge.code).toBe("pdf_too_large");
    expect(tooLarge.fields).toEqual({ limitBytes: 16 * 1024 * 1024 });
    expect(tooLarge.message).toBe("The PDF is larger than 16 MiB.");
    const gone = blobPage(() => ({ ok: false, reason: "fetch_failed" }));
    const failed = await failure(
      readPdfBytes({
        source,
        contents: { session: { fetch: () => Promise.reject(new Error("no")) } },
        session: (await ready(gone.host)).session,
        step: step(),
      }),
    );
    expect(failed.code).toBe("pdf_fetch_failed");
    expect(failed.fields).toEqual({});
    const empty = blobPage(({ offset }) => ({
      ok: true,
      total: 0,
      offset,
      data: "",
    }));
    const unreadable = await failure(
      readPdfBytes({
        source,
        contents: { session: { fetch: () => Promise.reject(new Error("no")) } },
        session: (await ready(empty.host)).session,
        step: step(),
      }),
    );
    expect(unreadable.code).toBe("pdf_unreadable");
  });
});

describe("DocumentMethods", () => {
  const documentRequest = (
    cdp: FakeHost["debugger"],
    options: {
      loaderId?: string;
      requestId?: string;
      method?: string;
      type?: string;
      redirect?: boolean;
    },
  ) =>
    cdp.event("Network.requestWillBeSent", {
      requestId: options.requestId ?? options.loaderId,
      ...(options.loaderId === undefined ? {} : { loaderId: options.loaderId }),
      documentURL: "https://a.example/x.pdf",
      request: {
        url: "https://a.example/x.pdf",
        method: options.method ?? "GET",
      },
      type: options.type ?? "Document",
      frameId: "main",
      ...(options.redirect ? { redirectResponse: { status: 307 } } : {}),
    });

  it("records a main document's method and the last redirect hop's", async () => {
    const { session, cdp } = await ready(new FakeHost());
    const methods = new DocumentMethods();
    const stop = methods.watch(session);
    documentRequest(cdp, { loaderId: "loader-2", method: "POST" });
    expect(methods.method(session, "loader-2")).toBe("POST");
    documentRequest(cdp, {
      loaderId: "loader-2",
      method: "GET",
      redirect: true,
    });
    expect(methods.method(session, "loader-2")).toBe("GET");
    stop();
    documentRequest(cdp, { loaderId: "loader-3", method: "POST" });
    expect(methods.method(session, "loader-3")).toBeUndefined();
  });

  it("ignores subresources, requests without a loaderId and other requests of the document's loader", async () => {
    const { session, cdp } = await ready(new FakeHost());
    const methods = new DocumentMethods();
    methods.watch(session);
    documentRequest(cdp, { loaderId: "loader-2", method: "POST", type: "XHR" });
    documentRequest(cdp, { method: "POST", requestId: "request-1" });
    documentRequest(cdp, {
      loaderId: "loader-2",
      requestId: "request-2",
      method: "POST",
    });
    expect(methods.method(session, "loader-2")).toBeUndefined();
    expect(methods.method(session, "request-1")).toBeUndefined();
  });

  it("keeps the last 64 documents of a session", async () => {
    const { session, cdp } = await ready(new FakeHost());
    const methods = new DocumentMethods();
    methods.watch(session);
    for (let at = 0; at < 65; at += 1)
      documentRequest(cdp, { loaderId: `loader-${at}`, method: "POST" });
    expect(methods.method(session, "loader-0")).toBeUndefined();
    expect(methods.method(session, "loader-1")).toBe("POST");
    expect(methods.method(session, "loader-64")).toBe("POST");
  });

  it("is given every new session before it attaches", async () => {
    const views = new OpeningViews();
    const space: Space = {
      id: "agent-space",
      name: "Agent",
      color: "purple",
      kind: "agent",
      owner: "agent",
      signIns: "shared",
      createdAt: 0,
    };
    views.state.spaces.push(space);
    const tab = newTab(space.id, "https://a.example/");
    views.state.tabs.push(tab);
    const opened: TabSession[] = [];
    const attachesAtOpen: number[] = [];
    const sessions = new TabSessions({
      controller: views as unknown as AutomationController,
      agentDriven: (spaceId) => spaceId === space.id,
      managedTab: () => true,
      waitForSpaceIdle: async () => {},
      buffers: new EventBufferPool(),
      onOpen: (session) => {
        opened.push(session);
        attachesAtOpen.push(views.pages.get(tab.id)!.debugger.attachCount);
      },
    });
    sessions.start();
    expect(opened).toEqual([]);
    const page = views.open(tab.id);
    expect(opened.length).toBe(1);
    expect(opened[0]).toBe(sessions.get(tab.id));
    expect(attachesAtOpen).toEqual([0]);
    expect(page.debugger.attachCount).toBe(1);
    sessions.sync();
    expect(opened.length).toBe(1);
    await sessions.close();
    await settle();
  });
});

// Pages that open as BrowserController's views do: the view-created listeners
// run before the first load.
class OpeningViews {
  state: BrowserState = initialState("linux");
  pages = new Map<string, FakeHost>();
  private created = new Set<(tabId: string, contents: WebContents) => void>();
  subscribe() {
    return () => {};
  }
  onViewCreated(listener: (tabId: string, contents: WebContents) => void) {
    this.created.add(listener);
    return () => {
      this.created.delete(listener);
    };
  }
  peekWebContents(tabId: string) {
    return this.pages.get(tabId) as unknown as WebContents | undefined;
  }
  open(tabId: string) {
    const page = new FakeHost({ url: "" });
    this.pages.set(tabId, page);
    for (const listener of this.created)
      listener(tabId, page as unknown as WebContents);
    return page;
  }
}
