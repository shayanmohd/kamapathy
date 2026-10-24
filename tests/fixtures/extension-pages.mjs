// Pages for the extension end-to-end checks. The page asks the marker
// extension's content script, through a message of its own origin, to open a
// tab or to change the tab it sits in, and shows what came back. The two
// destinations are plain pages, so a tab that lands anywhere is recognized by
// its title.
const page = (title, body, script = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:14px sans-serif;margin:16px}</style></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

export const extensionPages = {
  "/extensions/agent": page(
    "Extension test page",
    `<h1>Extension test page</h1>
<button type="button" id="open-tab">Open a tab through the extension</button>
<button type="button" id="change-tab">Change this tab through the extension</button>
<p id="kamapathy-marker-result" role="status"></p>`,
    `const ask = (kind, path) => window.postMessage({ kamapathyMarker: kind, url: location.origin + path }, location.origin);
document.getElementById("open-tab").onclick = () => ask("create", "/extensions/opened");
document.getElementById("change-tab").onclick = () => ask("update", "/extensions/changed");`,
  ),
  "/extensions/opened": page(
    "Extension opened page",
    '<h1 id="opened">Opened by the extension</h1>',
  ),
  "/extensions/changed": page(
    "Extension changed page",
    '<h1 id="changed">Changed by the extension</h1>',
  ),
};
