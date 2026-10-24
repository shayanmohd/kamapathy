// Pages for the popups, dialogs, downloads, file choosers and prompts
// checks: dialogs that write their own answers, a popup that opens after a
// pause, file inputs a selector has to retarget to, a chooser the page opens
// from script, download links, a location request and the page behind Basic
// auth.
const page = (title, body, script = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:20px}p{margin:10px 0}</style></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

/** The small download every check compares bytes with. */
export const ATTACHMENT = {
  name: "file.txt",
  type: "text/plain; charset=utf-8",
  body: "Quarterly notes for the end-to-end checks.\n",
};
/** What /prompts/big.bin streams, in chunks, so a download stays in progress. */
export const BIG = { chunks: 8, chunkBytes: 8192, pauseMs: 40 };
/** The sign-in /prompts/auth asks for. */
export const AUTH = {
  realm: "Kamapathy lab",
  username: "lab",
  password: "open-sesame",
  get header() {
    return `Basic ${Buffer.from(`${this.username}:${this.password}`).toString("base64")}`;
  },
};
/** How long /prompts/delayed waits before it opens a page. */
export const DELAYED_POPUP_MS = 400;
// The location request comes after the click that caused it, inside the
// 5000 ms window the action left open.
export const LOCATION_DELAY_MS = 250;

// Every file input a retarget has to choose between, and a change handler
// that asks before it accepts what arrived.
const fileControls = `<label id="notes-label" for="notes-file">Notes file</label><input id="notes-file" type="file" style="display:none">
<label id="wrapping-label">Artwork<input id="artwork-file" type="file" hidden></label>
<p><input id="visible-file" type="file" aria-label="Visible file"></p>
<div id="one-input"><input type="file" aria-label="Inside one container"></div>
<div id="two-inputs"><input type="file" aria-label="First of two"><input type="file" aria-label="Second of two"></div>
<p><input id="disabled-file" type="file" aria-label="Disabled file" disabled></p>
<p><input id="directory-file" type="file" aria-label="Directory file" webkitdirectory></p>
<p id="files-result" role="status">No files chosen</p>`;

export const promptPages = {
  "/prompts/dialogs": page(
    "Dialog lab",
    `<h1>Dialog lab</h1><button id="ask-alert">Show a note</button><button id="ask-confirm">Delete the draft</button><button id="ask-prompt">Name the report</button><p id="result" role="status">Nothing asked yet</p>`,
    `const result = document.querySelector("#result");
document.querySelector("#ask-alert").onclick = () => { alert("A note for you"); result.textContent = "alert returned"; };
document.querySelector("#ask-confirm").onclick = () => { result.textContent = "confirm " + confirm("Delete the draft?"); };
document.querySelector("#ask-prompt").onclick = () => { result.textContent = "prompt " + prompt("What is the title?", "Untitled"); };`,
  ),
  "/prompts/delayed": page(
    "Delayed pages",
    `<h1>Delayed pages</h1><button id="open-later">Open a page in a moment</button><button id="open-two">Open two pages</button><p id="opened" role="status">Nothing opened</p>`,
    `const note = (text) => { document.querySelector("#opened").textContent = text; };
document.querySelector("#open-later").onclick = () => setTimeout(() => { window.open("/prompts/landing"); note("one page opened"); }, ${DELAYED_POPUP_MS});
document.querySelector("#open-two").onclick = () => setTimeout(() => { window.open("/prompts/landing?first"); window.open("/prompts/landing?second"); note("two pages opened"); }, ${DELAYED_POPUP_MS});`,
  ),
  "/prompts/landing": page(
    "Opened page",
    '<h1 id="landing">Opened page</h1><p>This page was opened by another one.</p>',
  ),
  "/prompts/files": page(
    "File input lab",
    `<h1>File input lab</h1><form id="files-form">${fileControls}</form>`,
    `const result = document.querySelector("#files-result");
document.querySelector("#files-form").addEventListener("change", (event) => {
  const input = event.target;
  if (!confirm("Upload these?")) { result.textContent = "Upload refused"; return; }
  result.textContent = "Chose " + Array.from(input.files).map((file) => file.name + " " + file.size).join(", ");
});`,
  ),
  "/prompts/chooser": page(
    "File chooser lab",
    `<h1>File chooser lab</h1><p><input id="pick" type="file" aria-label="Pick a file"></p><button id="create">Choose a file from script</button><p id="chooser-result" role="status">No file chosen</p><p id="chooser-events" role="status">No events</p>`,
    `const events = [];
const note = (text) => { events.push(text); document.querySelector("#chooser-events").textContent = events.join(" "); };
for (const type of ["cancel", "input", "change"])
  document.querySelector("#pick").addEventListener(type, () => note("pick:" + type));
document.querySelector("#create").onclick = () => {
  const input = document.createElement("input");
  input.type = "file";
  for (const type of ["cancel", "input", "change"]) input.addEventListener(type, () => note("made:" + type));
  input.addEventListener("change", () => {
    document.querySelector("#chooser-result").textContent = "Chose " + Array.from(input.files).map((file) => file.name + " " + file.size).join(", ");
  });
  // The page takes its own input away again, so the chooser is answered on
  // an input nothing in the document holds.
  document.body.append(input);
  input.click();
  input.remove();
};`,
  ),
  "/prompts/download": page(
    "Download lab",
    `<h1>Download lab</h1><p><a id="attachment-link" href="/prompts/file.txt">Download the notes</a></p><p><a id="big-link" href="/prompts/big.bin">Download the big file</a></p><button id="popup-download">Download in a new page</button><p id="download-note" role="status">No download yet</p>`,
    `document.querySelector("#popup-download").onclick = () => {
  window.open("/prompts/popup-download");
  document.querySelector("#download-note").textContent = "a new page is downloading";
};`,
  ),
  "/prompts/popup-download": page(
    "Opening a download",
    "<h1>Opening a download</h1>",
    `location.href = "/prompts/file.txt";`,
  ),
  "/prompts/location": page(
    "Location lab",
    `<h1>Location lab</h1><button id="ask-location">Where am I?</button><p id="location-result" role="status">Nothing asked yet</p>`,
    `document.querySelector("#ask-location").onclick = () => {
  const result = document.querySelector("#location-result");
  result.textContent = "asked";
  setTimeout(() => navigator.geolocation.getCurrentPosition(
    () => { result.textContent = "position"; },
    (error) => { result.textContent = "error " + error.code; },
  ), ${LOCATION_DELAY_MS});
};`,
  ),
  // Served behind Basic auth. The same-origin image is behind it too; the
  // cross-origin one is the subresource challenge Kamapathy never shows.
  "/prompts/auth": page(
    "Signed in",
    `<h1 id="auth-ok">Signed in</h1><p>This page needed a name and password.</p><img id="same-origin-image" src="/prompts/auth-image.png" alt="" width="1" height="1"><img id="cross-origin-image" src="{{other}}/prompts/auth-image.png" alt="" width="1" height="1">`,
  ),
};
