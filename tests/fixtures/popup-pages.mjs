// Pages that open real popups: an OAuth-style sign-in that posts to its
// opener and closes itself, about:blank, blob: and data: popups, and
// target=_blank forms in each encoding.
const page = (title, body, script = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

const forms = [
  ["application/x-www-form-urlencoded", "Echo urlencoded"],
  ["multipart/form-data", "Echo multipart"],
  ["text/plain", "Echo text"],
]
  .map(
    ([type, button]) =>
      `<form action="/popups/echo" method="post" enctype="${type}" target="_blank"><input type="hidden" name="message" value="Hello popup"><button type="submit">${button}</button></form>`,
  )
  .join("");

export const popupPages = {
  "/popups/opener": page(
    "Popup opener",
    `<h1>Popup opener</h1><button id="oauth">Sign in with popup</button><button id="blank">Open blank popup</button><button id="blob">Open blob popup</button><button id="data">Open data popup</button><p id="token" role="status">No token</p><p id="data-result" role="status"></p>${forms}`,
    `addEventListener("message", (event) => { if (event.origin === location.origin && event.data?.token) document.querySelector("#token").textContent = "Token: " + event.data.token; });
document.querySelector("#oauth").onclick = () => window.open("/popups/oauth", "oauth", "popup");
document.querySelector("#blank").onclick = () => { const popup = window.open(""); popup.document.write("<p>Written by opener</p>"); popup.location = "/popups/landing"; };
document.querySelector("#blob").onclick = () => window.open(URL.createObjectURL(new Blob(["<title>Blob popup</title><h1>Blob popup</h1>"], { type: "text/html" })));
document.querySelector("#data").onclick = () => { const popup = window.open("data:text/html,<p>data</p>"); document.querySelector("#data-result").textContent = popup === null ? "Data popup refused" : "Data popup opened"; };`,
  ),
  "/popups/oauth": page(
    "Signing in",
    "<h1>Signing in</h1>",
    `setTimeout(() => { window.opener.postMessage({ token: "token-123" }, location.origin); setTimeout(() => window.close(), 300); }, 300);`,
  ),
  "/popups/landing": page("Popup landing", '<h1 id="landing">Popup landing</h1>'),
};
