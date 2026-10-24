export type FetchPhase = "start" | "read" | "cancel";
// A request as the route sends it: data only, with the URL already absolute.
export interface FetchStart {
  url: string;
  method: string;
  headers: [string, string][];
  body?: string;
  cache?: string;
  credentials?: string;
  integrity?: string;
  keepalive?: boolean;
  mode: string;
  redirect?: string;
  referrer?: string;
  referrerPolicy?: string;
}
export interface FetchHead {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  redirected: boolean;
  type: string;
  headers: Record<string, string>;
}
export type FetchReply =
  | { ok: true; phase: "start"; handle: string; head: FetchHead }
  | { ok: true; phase: "read"; data: string; done: boolean; bytes: number }
  | { ok: true; phase: "cancel" }
  | {
      ok: false;
      code: "fetch_failed";
      name: string;
      error: string;
      pageOrigin: string;
    }
  | { ok: false; code: "page_changed" | "invalid_url"; error: string };

// This complete function is serialized into Kamapathy's world in a tab's
// main frame. It has no imports, no Node APIs and no access to the browser
// interface's preload bridge. The page's origin, cookies, CSP and CORS apply
// to the request, and page code cannot intercept it. The page's service
// worker does not see it: a request from this world goes to the network.
export function fetchOperation(
  phase: FetchPhase,
  payload: Record<string, unknown>,
): FetchReply | Promise<FetchReply> {
  // How long a body may sit unread, and the most bytes one read returns.
  const HANDLE_IDLE_MS = 30000;
  const READ_MAX = 1024 * 1024;
  type Entry = {
    reader?: ReadableStreamDefaultReader<Uint8Array>;
    aborter: AbortController;
    // Bytes read from the body but over the last read's limit.
    pending: Uint8Array[];
    done: boolean;
    at: number;
  };
  // The handles live in this world, which lasts as long as the document, so
  // a handle never outlives the page that opened it.
  const world = globalThis as unknown as {
    __kamapathyFetches?: Map<string, Entry>;
  };
  const handles = (world.__kamapathyFetches ||= new Map<string, Entry>());
  const drop = (handle: string, entry: Entry) => {
    handles.delete(handle);
    entry.aborter.abort();
    entry.reader?.cancel().catch(() => {});
  };
  // A body left unread for half a minute goes before this call runs. A
  // request still waiting for its response has nothing to read yet.
  for (const [handle, entry] of [...handles])
    if (entry.reader && Date.now() - entry.at > HANDLE_IDLE_MS)
      drop(handle, entry);
  const handle = typeof payload.handle === "string" ? payload.handle : "";
  const entry = handles.get(handle);
  const failure = (error: unknown): FetchReply => {
    const thrown = error as { name?: string; message?: string } | null;
    return {
      ok: false,
      code: "fetch_failed",
      name: typeof thrown?.name === "string" ? thrown.name : "TypeError",
      error:
        typeof thrown?.message === "string" ? thrown.message : String(error),
      pageOrigin: location.origin,
    };
  };
  if (phase === "cancel") {
    if (entry) drop(handle, entry);
    return { ok: true, phase: "cancel" };
  }
  if (phase === "read") {
    if (!entry)
      return {
        ok: false,
        code: "page_changed",
        error: "This fetch is no longer open in the page.",
      };
    const max = Math.min(
      typeof payload.max === "number" && payload.max > 0
        ? payload.max
        : READ_MAX,
      READ_MAX,
    );
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    // What is over the limit waits for the next read.
    const take = (chunk: Uint8Array) => {
      const room = max - bytes;
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
      bytes += Math.min(chunk.length, room);
      if (chunk.length > room) entry.pending.unshift(chunk.subarray(room));
    };
    return (async () => {
      try {
        while (bytes < max && entry.pending.length > 0)
          take(entry.pending.shift()!);
        while (bytes < max && !entry.done) {
          if (!entry.reader) {
            entry.done = true;
            break;
          }
          const next = await entry.reader.read();
          if (next.done) entry.done = true;
          else if (next.value && next.value.length > 0) take(next.value);
        }
      } catch (error) {
        drop(handle, entry);
        return failure(error);
      }
      let binary = "";
      for (const chunk of chunks)
        for (let at = 0; at < chunk.length; at += 32768)
          binary += String.fromCharCode(...chunk.subarray(at, at + 32768));
      const done = entry.done && entry.pending.length === 0;
      // The last read frees the handle, so nothing is left to expire.
      if (done) handles.delete(handle);
      else entry.at = Date.now();
      return { ok: true, phase: "read", data: btoa(binary), done, bytes };
    })();
  }
  const request = payload as unknown as FetchStart;
  // The route sends an absolute URL; a page that cannot parse it says so
  // instead of failing as a network error.
  try {
    new URL(request.url);
  } catch {
    return {
      ok: false,
      code: "invalid_url",
      error: `${request.url} is not a URL this page can fetch.`,
    };
  }
  // The caller names the handle, so a cancel reaches the request before its
  // response does. Without one, this world names it.
  let opened = handle;
  if (!opened)
    for (const byte of crypto.getRandomValues(new Uint8Array(16)))
      opened += byte.toString(16).padStart(2, "0");
  return (async () => {
    const aborter = new AbortController();
    const open: Entry = { aborter, pending: [], done: false, at: Date.now() };
    handles.set(opened, open);
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        mode: request.mode as RequestMode,
        signal: aborter.signal,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(request.cache === undefined
          ? {}
          : { cache: request.cache as RequestCache }),
        ...(request.credentials === undefined
          ? {}
          : { credentials: request.credentials as RequestCredentials }),
        ...(request.integrity === undefined
          ? {}
          : { integrity: request.integrity }),
        ...(request.keepalive === undefined
          ? {}
          : { keepalive: request.keepalive }),
        ...(request.redirect === undefined
          ? {}
          : { redirect: request.redirect as RequestRedirect }),
        ...(request.referrer === undefined
          ? {}
          : { referrer: request.referrer }),
        ...(request.referrerPolicy === undefined
          ? {}
          : { referrerPolicy: request.referrerPolicy as ReferrerPolicy }),
      });
    } catch (error) {
      handles.delete(opened);
      return failure(error);
    }
    // A cancel while the response was on its way wins: nothing is read.
    if (handles.get(opened) !== open) {
      response.body?.cancel().catch(() => {});
      return {
        ok: false,
        code: "page_changed",
        error: "This fetch is no longer open in the page.",
      };
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    if (response.body) open.reader = response.body.getReader();
    // An opaque response and a response without a body have nothing to read,
    // so the first read ends it.
    else open.done = true;
    open.at = Date.now();
    return {
      ok: true,
      phase: "start",
      handle: opened,
      head: {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        redirected: response.redirected,
        type: response.type,
        headers,
      },
    };
  })();
}
