// Pages for the navigation and wait checks. A page whose script and image
// arrive SLOW_LOAD_MS late reaches commit, DOMContentLoaded, load and network
// idle at four separate moments, a handler page holds readyState interactive
// while it runs, and a long poll leaves one request in flight. The rest cover
// the answers a navigation can end on: a 302, a 204, an attachment, a result
// that was posted, a script the browser may cache, a 404, a page that sends
// itself elsewhere, pushState, a popup, a page that asks to stay, elements
// that change or repeat, and a frame from each origin.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const pixel = Buffer.from(PIXEL, "base64");
const html = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:14px sans-serif;margin:16px}</style></head><body>${body}</body></html>`;

// How late the slow page's blocking script and its image arrive.
export const SLOW_LOAD_MS = 600;
// How long the long poll holds its request, longer than any wait here.
export const POLL_MS = 20000;
// How late each of the slow page's staggered fetches answers.
const STAGGER_MS = 150;

// What the fixture saw: the Referer headers it was sent, how often the
// cacheable script was fetched, how many results were posted, and when each
// delayed answer left the server.
export const navigationLog = {
  referers: [],
  scriptFetches: 0,
  posts: 0,
  served: [],
};

// The paths the suite drives, by purpose.
export const NAVIGATION_PATHS = {
  slow: "/nav/slow",
  handler: "/nav/handler",
  poll: "/nav/poll",
  jsRedirect: "/nav/js-redirect",
  redirect: "/nav/redirect-302",
  landing: "/nav/landing",
  noContent: "/nav/204",
  attachment: "/nav/attachment",
  postForm: "/nav/post-form",
  postResult: "/nav/post-result",
  cached: "/nav/cached",
  referer: "/nav/referer",
  guarded: "/nav/guarded",
  pushState: "/nav/push-state",
  pushed: "/nav/pushed",
  changing: "/nav/changing",
  popupOpener: "/nav/popup-opener",
  info: "/nav/info",
  missing: "/nav/missing",
};

export const navigationPages = {
  "/nav/slow": page(
    "Slow page",
    `<h1>Slow page</h1>
<p id="slow-ready" role="status">Still loading</p>
<script>
// The image is asked for once the DOMContentLoaded handlers have run, so the
// preload scanner cannot fetch it while the blocking script is still on its
// way and the load event stays SLOW_LOAD_MS behind DOMContentLoaded.
addEventListener("DOMContentLoaded", () => {
  const image = document.createElement("img");
  image.alt = "";
  image.width = 1;
  image.height = 1;
  image.src = "/nav/slow.png";
  document.body.append(image);
});
// The load event starts three fetches, each one when the one before it
// answered, so the network stays busy without a gap for network idle to
// settle in. Each body is read, since an answer nobody reads leaves its
// request in flight.
addEventListener("load", async () => {
  document.querySelector("#slow-ready").textContent = "Loaded";
  for (let step = 0; step < 3; step += 1)
    await fetch("/nav/stagger?step=" + step)
      .then((answer) => answer.text())
      .catch(() => {});
});
</script>
<script src="/nav/slow.js"></script>`,
  ),
  "/nav/handler": page(
    "Handler page",
    `<h1>DOMContentLoaded handler</h1>
<p id="handler" role="status">Handler waiting</p>
<script>
// A handler that keeps the document at readyState interactive while it runs,
// so a wait for domcontentloaded has to outlast it.
document.addEventListener("DOMContentLoaded", () => {
  const until = Date.now() + 500;
  while (Date.now() < until);
  window.handlerDone = true;
  document.querySelector("#handler").textContent = "Handler finished";
});
</script>`,
  ),
  "/nav/poll": page(
    "Long poll page",
    `<h1>Long poll page</h1>
<p id="poll" role="status">Polling</p>
<script>
fetch("/nav/poll-wait")
  .then(() => {
    document.querySelector("#poll").textContent = "Poll answered";
  })
  .catch(() => {});
</script>`,
  ),
  "/nav/js-redirect": page(
    "Redirecting page",
    `<h1>Redirecting page</h1>
<p id="redirect" role="status">Waiting to leave</p>
<script>
// to and after say where this page sends itself and how long after its load
// event it goes.
addEventListener("load", () => {
  const options = new URLSearchParams(location.search);
  const to = options.get("to") || "/nav/landing";
  const after = Number(options.get("after") || 800);
  setTimeout(() => location.replace(to), after);
});
</script>`,
  ),
  "/nav/landing": page(
    "Landing page",
    '<h1 id="landing">Landing page</h1><p>The page a redirect lands on.</p>',
  ),
  "/nav/pushed": page(
    "Pushed page",
    '<h1 id="pushed">Pushed page</h1><p>The address the pushing page writes.</p>',
  ),
  "/nav/push-state": page(
    "Pushing page",
    `<h1>Pushing page</h1>
<p id="push-status" role="status">Not pushed</p>
<script>
addEventListener("load", () =>
  setTimeout(() => {
    history.pushState({}, "", "/nav/pushed?step=1");
    document.querySelector("#push-status").textContent = "Pushed";
  }, 600),
);
</script>`,
  ),
  "/nav/popup-opener": page(
    "Popup opener",
    '<h1>Popup opener</h1><p><a id="open-landing" href="/nav/landing" target="_blank">Open the landing page</a></p>',
  ),
  "/nav/post-form": page(
    "Post a result",
    `<h1>Post a result</h1>
<form action="/nav/post-result" method="post">
<label for="note">Note</label>
<input id="note" name="note" value="A posted note">
<button id="post-it" type="submit">Post the form</button>
</form>`,
  ),
  "/nav/cached": page(
    "Cached script page",
    `<h1>Cached script page</h1>
<p id="counted" role="status">Script not run</p>
<script src="/nav/counted.js"></script>`,
  ),
  "/nav/guarded": page(
    "Guarded page",
    `<h1>Guarded page</h1>
<button id="touch" type="button">Touch this page</button>
<p id="touched" role="status">Not touched</p>
<label for="note">Note</label>
<input id="note">
<script>
document.querySelector("#touch").onclick = () => {
  document.querySelector("#touched").textContent = "Touched";
};
// A page that asks to stay. Chromium only asks once the page has had a user
// gesture, which the click on the button gives it.
addEventListener("beforeunload", (event) => {
  event.preventDefault();
  event.returnValue = "";
});
</script>`,
  ),
  "/nav/info": page(
    "Page state",
    `<h1>Page state</h1>
<p>A page tall enough to scroll.</p>
<div style="height:3000px"></div>
<p id="bottom">The bottom of the page</p>`,
  ),
  "/nav/changing": page(
    "Changing page",
    `<style>iframe{display:block;border:1px solid #666;width:320px;height:90px}</style>
<h1>Changing page</h1>
<p id="fading">Fading away</p>
<p id="leaving">Leaving soon</p>
<div id="slot"></div>
<button type="button">Save</button>
<button type="button">Save</button>
<iframe id="same" title="Same origin frame" src="/nav/frame-slot"></iframe>
<iframe id="across" title="Other origin frame" src="{{other}}/nav/frame-other"></iframe>
<script>
// A ladder of changes, so each wait still has something to come: the element
// arrives invisible, becomes visible, then the first paragraph turns
// invisible and the second one leaves the page.
addEventListener("load", () => {
  setTimeout(() => {
    document.querySelector("#slot").innerHTML =
      '<p id="later" style="visibility:hidden">Here now</p>';
  }, 600);
  setTimeout(() => {
    document.querySelector("#later").style.visibility = "visible";
  }, 1000);
  setTimeout(() => {
    document.querySelector("#fading").style.visibility = "hidden";
  }, 1500);
  setTimeout(() => document.querySelector("#leaving").remove(), 2000);
});
</script>`,
  ),
  "/nav/frame-slot": page(
    "Same origin frame",
    `<p id="in-frame">Frame ready</p>
<script>
// The late element lands well after this frame loaded, so a wait has to look
// in the frame again to find it.
addEventListener("load", () =>
  setTimeout(() => {
    const found = document.createElement("p");
    found.id = "late-in-frame";
    found.textContent = "Late in the frame";
    document.body.append(found);
  }, 3000),
);
</script>`,
  ),
  "/nav/frame-other": page(
    "Other origin frame",
    '<p id="only-across">Only across origins</p>',
  ),
};

// Answers after milliseconds, recording when they left. The timer never holds
// the suite open, and a request whose connection is already gone is dropped.
function later(path, milliseconds, answer) {
  const timer = setTimeout(() => {
    navigationLog.served.push({ path, at: Date.now() });
    answer();
  }, milliseconds);
  timer.unref?.();
}

// The dynamic answers of the navigation fixture: the delayed resources, the
// 302, the 204, the attachment, the posted result, the cacheable script, the
// Referer log and the 404. Returns true when this fixture owns the path.
export function navigationRoute(request, url, respond) {
  const path = url.pathname;
  if (path === "/nav/slow.js") {
    later(path, SLOW_LOAD_MS, () =>
      respond(
        200,
        {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
        },
        "window.slowScript = true;\n",
      ),
    );
    return true;
  }
  if (path === "/nav/slow.png") {
    later(path, SLOW_LOAD_MS, () =>
      respond(
        200,
        { "Content-Type": "image/png", "Cache-Control": "no-store" },
        pixel,
      ),
    );
    return true;
  }
  if (path === "/nav/stagger") {
    later(path, STAGGER_MS, () =>
      respond(
        200,
        {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
        `step ${url.searchParams.get("step") ?? ""}\n`,
      ),
    );
    return true;
  }
  if (path === "/nav/poll-wait") {
    later(path, POLL_MS, () =>
      respond(
        200,
        {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
        "polled\n",
      ),
    );
    return true;
  }
  // The one answer the browser may keep, so a plain reload leaves this count
  // alone and a reload past the cache raises it.
  if (path === "/nav/counted.js") {
    navigationLog.scriptFetches += 1;
    navigationLog.served.push({ path, at: Date.now() });
    respond(
      200,
      {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "max-age=600",
      },
      'document.querySelector("#counted").textContent = "Script run";\n',
    );
    return true;
  }
  if (path === "/nav/redirect-302") {
    respond(302, { Location: "/nav/landing", "Cache-Control": "no-store" });
    return true;
  }
  if (path === "/nav/204") {
    respond(204, { "Cache-Control": "no-store" });
    return true;
  }
  if (path === "/nav/attachment") {
    respond(
      200,
      {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="navigation-report.txt"',
        "Cache-Control": "no-store",
      },
      "A download, not a page.\n",
    );
    return true;
  }
  if (path === "/nav/referer") {
    const referer = request.headers.referer ?? "";
    navigationLog.referers.push(referer);
    respond(
      200,
      html,
      page(
        "Referer received",
        `<h1 id="referer">Referer received</h1><p id="referer-value">${referer.replace(/[&<>"]/g, "")}</p>`,
      ),
    );
    return true;
  }
  if (path === "/nav/post-result") {
    if (request.method !== "POST") {
      respond(
        405,
        html,
        page(
          "Result not available",
          '<h1 id="error">Post the form to see this result.</h1>',
        ),
      );
      return true;
    }
    request.resume();
    request.on("end", () => {
      navigationLog.posts += 1;
      respond(
        200,
        html,
        page(
          "Result posted",
          '<h1 id="posted">Result posted</h1><p>Reloading this page would post the form again.</p>',
        ),
      );
    });
    return true;
  }
  if (path === "/nav/missing") {
    respond(404, html, page("No such page", "<h1>No such page</h1>"));
    return true;
  }
  return false;
}
