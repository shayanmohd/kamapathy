// Pages and endpoints for the page script checks: a page that sets a cookie,
// one the server sends a connect-src policy with, one that registers a
// service worker, a page with a loop a button starts, and a page with a
// frame on the other loopback name. The endpoints echo the Cookie and Origin
// headers, allow or refuse a cross-origin reader, carry a binary body with a
// known digest, never answer, or never finish, and they record what they
// received, so a check can see the cookie and the origin the page sent.
import { createHash } from "node:crypto";

export const scriptPages = {
  "/scripts/cookie": `<!doctype html><meta charset="utf-8"><title>Cookie lab</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<h1>Cookie lab</h1>
<p id="cookie" role="status">No cookie yet</p>
<script>
document.cookie = "lab=sugar; path=/";
document.getElementById("cookie").textContent = "Cookie: " + document.cookie;
</script>`,
  "/scripts/csp": `<!doctype html><meta charset="utf-8"><title>Policy lab</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<h1>Policy lab</h1>
<p>This page is sent with connect-src 'self', so it fetches from its own origin only.</p>`,
  "/scripts/worker": `<!doctype html><meta charset="utf-8"><title>Worker lab</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<h1>Worker lab</h1>
<p id="worker" role="status">No worker yet</p>
<script>
window.ready = navigator.serviceWorker
  .register("/scripts/sw.js")
  .then(async () => {
    await navigator.serviceWorker.ready;
    document.getElementById("worker").textContent = "Worker ready";
    return "ready";
  });
</script>`,
  "/scripts/busy": `<!doctype html><meta charset="utf-8"><title>Busy page</title>
<style>body{font:14px sans-serif;margin:16px}</style>
<h1>Busy page</h1>
<button id="spin" type="button">Spin for ten seconds</button>
<p id="spun" role="status">Idle</p>
<script>
document.getElementById("spin").onclick = () => {
  const end = Date.now() + 10000;
  while (Date.now() < end) {}
  document.getElementById("spun").textContent = "Spun";
};
</script>`,
  "/scripts/frames": `<!doctype html><meta charset="utf-8"><title>Frame lab</title>
<style>body{font:14px sans-serif;margin:16px}iframe{display:block;border:2px solid #666;width:380px;height:160px}</style>
<h1>Frame lab</h1>
<p>Text in the top page</p>
<iframe id="remote" title="Remote cookie lab" src="{{other}}/scripts/cookie"></iframe>`,
};

// Headers a page needs beyond the usual ones, by path.
export const scriptPageHeaders = {
  "/scripts/csp": { "Content-Security-Policy": "connect-src 'self'" },
};

// Two MiB of bytes a check can compare against, the same on every run.
export const SCRIPT_BINARY = (() => {
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  for (let at = 0; at < bytes.length; at += 1)
    bytes[at] = (at * 37 + (at >> 8) * 101) & 255;
  return bytes;
})();
export const SCRIPT_BINARY_SHA256 = createHash("sha256")
  .update(SCRIPT_BINARY)
  .digest("hex");

// What the service worker answers for /scripts/sw-echo, and what the server
// answers when no worker took the request.
export const WORKER_BODY = "from the worker";
export const NETWORK_BODY = "from the network";
const WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (new URL(event.request.url).pathname === "/scripts/sw-echo")
    event.respondWith(
      new Response(${JSON.stringify(WORKER_BODY)}, {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
    );
});`;

const ENDPOINTS = [
  "/scripts/echo-cookie",
  "/scripts/cors",
  "/scripts/no-cors",
  "/scripts/binary",
  "/scripts/hold",
  "/scripts/silent",
  "/scripts/sw.js",
  "/scripts/sw-echo",
];

// The endpoints the pages and the agent fetch. Returns false for a path that
// belongs to another fixture, so one server can serve them all.
export function serveScriptEndpoint(request, response, url, events = []) {
  const path = url.pathname;
  if (!ENDPOINTS.includes(path)) return false;
  events.push({
    type: "script-fetch",
    path,
    cookie: request.headers.cookie ?? "",
    origin: request.headers.origin ?? "",
  });
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const json = (body, extra = {}) => {
    response.writeHead(200, {
      ...headers,
      ...extra,
      "Content-Type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(body));
  };
  if (path === "/scripts/echo-cookie")
    json({ cookie: request.headers.cookie ?? "" });
  // Any origin may read this one, so a cross-origin request carries its
  // Origin header all the way back.
  else if (path === "/scripts/cors")
    json(
      { origin: request.headers.origin ?? "" },
      { "Access-Control-Allow-Origin": "*" },
    );
  // No Access-Control-Allow-Origin: a page on the other loopback name reads
  // this only as an opaque response.
  else if (path === "/scripts/no-cors")
    json({ reading: "allowed for this origin only" });
  else if (path === "/scripts/binary") {
    response.writeHead(200, {
      ...headers,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(SCRIPT_BINARY.length),
    });
    response.end(SCRIPT_BINARY);
  } else if (path === "/scripts/sw.js") {
    response.writeHead(200, {
      ...headers,
      "Content-Type": "text/javascript; charset=utf-8",
      "Service-Worker-Allowed": "/",
    });
    response.end(WORKER);
  } else if (path === "/scripts/silent") {
    // Headers that never arrive, so a cancel before the response is visible
    // here.
    response.on("close", () => {
      if (!response.writableFinished)
        events.push({ type: "script-fetch-aborted", path });
    });
  } else if (path === "/scripts/sw-echo") {
    response.writeHead(200, {
      ...headers,
      "Content-Type": "text/plain; charset=utf-8",
    });
    response.end(NETWORK_BODY);
  } else {
    // A body that starts and never ends, so a cancelled read is visible here.
    response.writeHead(200, {
      ...headers,
      "Content-Type": "application/octet-stream",
    });
    response.write(Buffer.alloc(8, 7));
    response.on("close", () => {
      if (!response.writableFinished)
        events.push({ type: "script-fetch-aborted", path });
    });
  }
  return true;
}
