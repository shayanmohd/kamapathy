# Local automation

Kamapathy exposes a local HTTP API for scripts and external agents. It supplies browser tools and a human handoff mechanism. It does not bundle an AI model or autonomously plan tasks.

## Connect

Agents connect automatically. While agent access is on in **Settings**, under Agents (the default), the desktop app listens on a local socket in the profile's private agent folder, or on a named pipe with a new random name on Windows. The bundled client finds it with no token or setup, and starts Kamapathy when it is not running and access was left on. Turning agent access off stops the socket, and the client never starts Kamapathy against that choice. The web preview has no local automation server.

Each profile has its own agent folder, `agent` inside Kamapathy's application data folder. Set `KAMAPATHY_USER_DATA` to reach a different profile. The folder records the socket's location and a random instance value, whether access is off, and how to start this Kamapathy again. Every response carries the instance in `X-Kamapathy-Instance`, and the client confirms it with `GET /health`, which never waits behind page actions, before sending a command. Automatic starts run only a recorded program that no other account could have replaced, and never reopen debugging ports. See the skill's [connection reference](../skills/kamapathy/references/connection.md) for failures.

The bundled CLI uses Node.js built-ins and runs on macOS, Windows, and Linux:

```sh
node scripts/kamapathy.mjs health
node scripts/kamapathy.mjs space create "Documentation research"
```

Copy the returned space ID, then open a page and copy its tab ID:

```sh
node scripts/kamapathy.mjs open <space-id> https://example.com
node scripts/kamapathy.mjs snapshot <tab-id>
node scripts/kamapathy.mjs screenshot <tab-id> ./example.png
node scripts/kamapathy.mjs handoff <space-id>
node scripts/kamapathy.mjs resume <space-id>
```

Angle bracket IDs in examples are placeholders to replace with actual IDs. New spaces and tabs open in the background, preserving your current browsing selection. Screenshot files use exclusive creation so an existing file is never overwritten.

## Interact with a page

A snapshot contains the page's URL, title, visible text, and controls with labels, CSS selectors, and short element references such as `@e1`, read through open shadow roots and same-origin frames. Hidden, inert, transparent, and closed disclosure content is excluded. Text inside `aria-hidden` is included when it is rendered: the attribute hides content from assistive technology, not from the screen, and component libraries such as Google's Angular components put visible field labels and questions there. Icon font names such as `arrow_drop_down` are left out of text and labels. Controls under `aria-hidden` stay excluded, because pages hide what sits behind an open modal or menu that way. File-input metadata is an exception: an input hidden inside visible upload UI can expose a ref, accepted types, and its multiple-selection flag, without exposing selected files. Select controls include option labels, exact values, disabled states, and which options are selected: up to 20 options per select and 100 per snapshot, omitting values longer than 256 characters and setting `truncated` when options are omitted. Scope a select to avoid the shared option budget. Compact mode is the default: 4,000 text characters, 40 controls, and 80-character labels. Full mode raises the defaults to 24,000 text characters, 100 controls, and 200-character labels. Both modes retain the same JSON response shape and a `truncated` flag.

Controls include native links, buttons, fields, and disclosures; elements with the ARIA roles people operate directly, such as `option`, `listbox`, `menuitem`, `tab`, `switch`, `textbox`, `slider`, and `treeitem`; popup triggers with `aria-haspopup`; draggable elements; and custom elements that take keyboard focus. A wrapper that only holds other controls, such as a tree row drawn as a button around its tree item with no text of its own, and a list of options, are listed through the controls inside them. A checkbox, radio button, or switch drawn inside an option, menu item, tab, or tree item is part of that item; other controls inside one, such as a tab's close button or a tree item's expand button, are listed. Up to 30 elements that a page draws as clickable or draggable, with a pointer, grab, or move cursor and their own short text, are listed after every other control. A label comes from `aria-label`, `aria-labelledby`, a label element, a placeholder, the control's own text without icons marked `aria-hidden`, or its `title`. A field with none of these takes the text of the nearest container that holds no other control.

Each control can carry its state and value, in fields that appear only when they apply. `checked` is `true`, `false`, or `"mixed"`; `selected`, `expanded`, and `pressed` report the ARIA and native states. `value` is the current value of a text-like input, textarea, single select, contenteditable region, ARIA slider or spin button, or the choice a custom select shows without the options of a list open inside it, bounded to the label length; `valueTruncated` marks a shortened value. Password inputs, fields whose `autocomplete` is `current-password`, `new-password`, `one-time-code`, or any `cc-` token, and fields masked by `-webkit-text-security` report `valueHidden: true` instead of any value they hold. Radio buttons and checkboxes carry `group`, the question they answer: a fieldset legend, the name of a `radiogroup` or `group`, or the text before the choices when the group has no name. Radio buttons that share a name form a group even without a container. Text that a website echoes elsewhere remains visible, so snapshots are not a secret-redaction service.

When a page has more controls than the budget, the snapshot lists controls inside open dialogs, popups, listboxes, and menus first, then controls on screen inside fixed or sticky bars, then the rest of the screen, then controls on screen inside tall pinned columns, then everything else, and keeps the list in page order. A pinned box is a bar, such as a header, a banner, or the action bar at the bottom of a form, when it is at most a third of the viewport tall or at least two thirds as wide. A taller, narrower one, such as a navigation sidebar or a table of contents, is the same on every page, so the page beside it comes first. `omittedControls` counts the controls left out, and the CLI says how many more exist. Scope with `--selector` to list them.

Text and controls inside an open shadow root appear where the page draws them, in the order a person sees them, with slotted content where its slot is; labels, `aria-labelledby`, and refs resolve inside the shadow root. Text and controls inside a same-origin iframe appear where the frame sits in the page, nested frames included. Each control inside a frame carries `frame`, the index path of its frame among the frames of the document around it, such as `"0"` or `"0/1"`. Clicks and drags add the position of every frame around the control, fill and key presses act in the frame's document, and waits and scoped snapshots search the top document first, then frames depth first. A CSS selector resolves in the top document when it matches anything there, and otherwise in the first frame, depth first, where it matches; that document must hold exactly one match. A control inside a frame lists its selector within its own document, which may also match in the page around it, so prefer its ref. CSS selectors do not enter shadow roots. A frame from another origin, such as a payment form or an embedded map, is listed as a control with `role: "iframe"`, `crossOrigin: true`, and a label from its title, name, or host, so an agent knows content exists that Kamapathy cannot read. Any action on it fails with `409 cross_origin_frame`; ask the person to continue there. Closed shadow roots, PDF documents, and canvas interfaces stay out of reach.

Prefer compact snapshots, scoped snapshots, and element references for short agent conversations. A scoped snapshot observes one uniquely matching CSS selector, such as `form` or `#checkout`. Set `maxChars: 0` for controls only or `maxControls: 0` for text only. Explicit bounds are 0 to 24,000 text characters and 0 to 100 controls. Scope and bounds constrain the result; they do not grant access to other tabs or spaces.

```sh
node scripts/kamapathy.mjs snapshot <tab-id>
node scripts/kamapathy.mjs snapshot <tab-id> --selector '#search-form' --max-chars 1000
node scripts/kamapathy.mjs snapshot <tab-id> --full --json
node scripts/kamapathy.mjs click <tab-id> @e2
node scripts/kamapathy.mjs press <tab-id> Enter
node scripts/kamapathy.mjs drag <tab-id> @e4 @e7
node scripts/kamapathy.mjs scroll <tab-id> down 600 @e9
node scripts/kamapathy.mjs navigate <tab-id> https://example.com
```

Element references remain stable while the same document and element remain available. Pages often draw a control again after an input, for example a Save button that becomes enabled once a field changes. When a reference's element is gone, Kamapathy looks for the control drawn in its place: an element with the same tag, role, type, label, group question, and surrounding text as when a snapshot last listed it, on the same URL, that no current reference holds. It prefers the element at the same position in the page, and otherwise accepts exactly one match among at most 2,000 elements of the same kind. A control that looked like another visible control when a snapshot listed it, such as the Remove buttons of two rows with the same name, is never re-bound, because Kamapathy cannot tell which one the reference meant. The action reports the reference in `rebound`, and the reference points to the new element from then on. When nothing matches, or more than one element does, the reference fails with `stale_ref`. References never follow a control across a navigation or a change of URL, and file inputs are never re-bound. References also expire when the API restarts or when the bounded reference cache expires. Take a new snapshot after navigation or a stale-reference error. CSS selectors remain supported for compatibility and must uniquely match.

Clicks require a visible, enabled element and verify that another element does not cover its center. Kamapathy sends fixed native Chromium mouse events to the target tab without selecting that tab or focusing the application. A control drawn with no size, such as a radio button inside a list row that takes the row's clicks, has no point to press. Kamapathy then clicks it in the page with a DOM click, which the page sees as an untrusted event, and reports `fallback: "dom_click"`. It does this only when the nearest box around the control is on screen and uncovered; otherwise the click fails as covered or outside the viewport. This supports normal form validation and submission. URL-encoded and multipart forms targeting `_blank` preserve their POST body and referrer in a new tab in the same space. Use `tabs SPACE_ID` to discover that tab, then verify its receipt; the submitting tab does not navigate. Click and key actions briefly allow immediate navigation to start, then wait for its load; use an explicit wait condition for a later asynchronous outcome. Chromium discards native input that reaches a page before it renders its first frame after a navigation, and reports that dispatch as successful, so Kamapathy confirms that the page received each click and key press. Input that provably never reached the page is repeated after a rendered frame; input that never arrives fails with `input_not_delivered`. Input that reached the page is never repeated, and no other action is retried automatically.

Fill supports text, search, telephone, URL, email, password, number, date, time, datetime-local, month, and week inputs; textareas; single selects by exact option value; and contenteditable text. Chromium must accept an input value without normalization. Multiple selects, duplicate option values, disabled options or option groups, range inputs, and color inputs fail explicitly. Controls are rechecked after focus handlers run. It focuses the element within its page and dispatches input and change events. File uploads, checkbox values, and radio values are not accepted by fill. Use click for checkboxes and radios. Keyboard input supports Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, and Space. It can optionally target a ref or selector first. Modifier combinations, shell shortcuts, and arbitrary key sequences are not accepted.

Drag presses the mouse on the center of a source element, moves in steps past the distance pages wait for before a drag starts, and releases on the center of a target element, all with native Chromium mouse events. Source and target are each a ref or a unique selector. Both must be visible, the source enabled, and the target outside the source. Kamapathy scrolls the source into view, and the target when it is off screen. It fails with `drag_out_of_view` when both cannot be on screen together, and with `element_obscured` when another element covers either center. When the page starts an HTML drag, Kamapathy intercepts it before Chromium starts an operating system drag, moves it with drag events that carry the data the page set, and drops it on the target, as Playwright does. The result reports `drag: "html5"` or `drag: "mouse"`. A drag the page starts but Kamapathy never receives fails with `drag_not_delivered` after the mouse is released. If the person takes over during an HTML drag, Kamapathy cancels it instead of dropping.

Field values go through standard input, keeping them out of process arguments. The CLI preserves input exactly, including trailing newlines. For a nonsensitive sample value:

```sh
node -e "process.stdout.write('browser architecture')" | node scripts/kamapathy.mjs fill <tab-id> '#search' --stdin
```

For sensitive values, pipe from an appropriate local secret source. The API accepts up to 16,384 characters per field, 2,048 characters per selector, and 64 KiB per normal request body. The dedicated upload route has the larger bound described below.

## Select files for upload

`upload TAB_ID REF file [files]` selects local files on a current file-input ref from a snapshot. For example, after observing `@e8` on the intended upload form and confirming that the file and destination are authorized:

```sh
node scripts/kamapathy.mjs upload TAB_ID @e8 ./report.pdf
```

Replace the example ID, ref, and path with the actual values. Upload accepts only a ref, not a CSS selector or the surrounding upload button. The input must be visible, or hidden with a visible immediate parent, and outside inert or aria-hidden UI. It must belong to the current top document. Disabled inputs and directory selection are rejected. The input's single/multiple setting and accepted extensions or MIME types are checked before selection.

The standalone command accepts 1 to 8 regular files, at most 16 MiB in total. It is not available inside a batch. The client reads the selected files locally and sends their basenames, MIME types, and base64 bytes through the local agent socket. The API receives bytes in memory and does not read arbitrary paths from the browser machine. Keep private local paths and file contents out of page fields, prompts, and public logs.

The server permits one file transfer at a time and checks ownership before receiving the body and again before applying it. Navigation during transfer invalidates the operation. Only `POST /tabs/:id/upload` accepts up to 24 MiB of JSON to accommodate base64 encoding; the 64 KiB bound remains in place for all other routes. Its body is `{ "ref": "@e8", "files": [{ "name": "report.pdf", "type": "application/pdf", "data": "<base64 bytes>" }] }`. Use the CLI to encode files rather than placing their content in agent prompts.

Selection sets the input's files and dispatches input and change events. A site can begin uploading immediately, so the user's authorization must cover transmission before running the command. The response `{ "ok": true, "selected": 1 }` confirms selection, not server acceptance or publication. Inspect the site's progress and final receipt before continuing. After a timeout or error, check whether the site already received the files before retrying or submitting again.

This action does not open a native file chooser or expose native file handles. Sites that require those mechanisms or trusted chooser events may reject it. It does not add directory upload support.

## Batch a short interaction

`POST /tabs/:id/actions` accepts 1 to 20 fixed actions. The server validates the entire plan before running the first step, then executes in order with an ownership check at every step. Successful responses have `{ ok: true, results: [{ index, type, result }] }`. A failure returns the applicable HTTP error status and `{ ok: false, results, failedIndex, error: { code, message } }`. `results` contains completed steps; later steps do not run. If human takeover interrupts the batch, earlier observation contents are withheld.

The CLI reads a batch from standard input, either as an actions array or an object containing `actions`. For example, save this nonsensitive plan to a local JSON file, then run `node scripts/kamapathy.mjs batch <tab-id> < plan.json` in a shell supporting input redirection:

```json
{
  "actions": [
    { "type": "fill", "ref": "@e1", "value": "browser architecture" },
    { "type": "click", "ref": "@e2" },
    { "type": "wait", "selector": "#results", "timeoutMs": 5000 },
    {
      "type": "snapshot",
      "selector": "#results",
      "maxChars": 1600,
      "maxControls": 8
    }
  ]
}
```

Use references from your latest snapshot, not the example references verbatim. On PowerShell, pipe file contents with `Get-Content -Raw plan.json | node scripts/kamapathy.mjs batch <tab-id>`. Do not store secrets in a plan file. Submission must still be authorized by the user before a plan is sent.

Wait observes a uniquely matching visible selector, literal page text, or both. Like snapshot text, it counts rendered content inside `aria-hidden` as visible. With both, text is checked inside the selected element. The default timeout is 5,000 ms; explicit values range from 0 to 15,000 ms. Zero performs one check with at most 250 ms for the page response. Other wait deadlines include loading and page evaluation. With no condition, wait checks that the document is interactive or complete. Scroll moves up, down, left, or right by 1 to 2,000 pixels, defaulting to 600. With a ref or selector, it scrolls that element, or the nearest element around it that can scroll that way, and otherwise the page, or the frame's page when the control is inside a frame. Without one, it scrolls the page, or, when the page cannot scroll that way, the scrollable panel under the center of the viewport, as in apps whose content scrolls inside a fixed frame. A page whose overflow keeps a person from scrolling it, such as the page behind a modal that locks scrolling, never moves. The result reports `scrolled` (`"page"` or `"element"`), the element's `selector`, the new `x` and `y` offsets of what scrolled, and `moved`, which is false when nothing could scroll further.

Batch execution has a total 60-second budget. A failure is not a rollback, and a timeout does not prove that an input or form submission was cancelled. Inspect the outcome before retrying a consequential action. A batch reduces request overhead; it does not grant an agent permission to submit forms or send messages.

## Scripts

`run` executes an agent's script in Node.js with a connected client, so a whole task is one program instead of one command per step:

```sh
node scripts/kamapathy.mjs run task.mjs
node scripts/kamapathy.mjs run -e 'const research = await createSpace("Research"); const page = await research.open("https://example.com"); console.log(await page.text())'
```

`run -` reads the script from standard input. The script is an ES module with top level `await`, access to Node built-ins, and the globals `kamapathy` (the client), `createSpace`, `space` and `spaces`. It connects before the first line runs, the same way every command does, and prints whatever it prints. An uncaught error ends the run with `error: <code>: <message>` on stderr and exit status 1. Code given through `-` or `-e` goes through a private temporary file that is removed afterwards.

The client module, `skills/kamapathy/scripts/api.mjs`, exports `connect(options?)` for any Node program and depends on Node built-ins only. A `Client` has `createSpace(name, { isolated })`, `space(id)` and `spaces()`. A `Space` carries `id`, `name`, `owner` and `signIns`, with `open(url)`, `tabs()`, `handoff()`, `resume()` and `close()`. A `Page` carries `id`, `url` and `title`, with `navigate`, `snapshot`, `text` (the same text the CLI prints), `click`, `fill`, `press`, `scroll`, `drag`, `wait`, `batch`, `upload`, `screenshot` and `close`. Each method sends exactly one route from the table below; the script runs on your computer and never inside a page. A failed call throws a `KamapathyError` with the API's `code`, `message` and HTTP `status`; a failed batch also carries `results` and `failedIndex`. The skill's [scripting reference](../skills/kamapathy/references/scripting.md) has the complete surface, an example and the safety rules.

## Human handoff

`handoff` changes the space owner to human, as does choosing **Take over** in Kamapathy. While under human control, the API cannot inspect, navigate, capture, modify, or delete that space or its tabs, and those requests return HTTP 409 with `human_control`. The space remains visible in `GET /spaces` with `owner: "human"`.

Control returns to the agent in two ways. The person can choose **Let agent continue** in the bar under the agent space's page, or in the Spaces menu, or the agent can take control back with `resume`. `resume` changes the owner to agent and records an activity entry saying the agent took control back. It works on any agent space the running API server created or was granted, including one the person took over. A resume sent while the agent already has control changes nothing, and if the person takes over before that request runs, it returns `human_control` instead of taking the space back. It cannot reach personal spaces, agent spaces never granted to the running server, or spaces from an earlier server session.

Agents should take control back once the reason for the handoff is finished, for example when the person says they have signed in or asks the agent to continue. They should not take a space back while the person is still working in it, or after the person took it over to stop the agent, unless the person asks. The page may have changed, so take a new snapshot after resuming.

Turning agent access off in Settings remains the hard stop. It stops the server and refuses every request, including `resume`. Turning access on again starts a server that does not reclaim earlier spaces until you grant them again.

Taking over blocks subsequent automation operations and prevents pending snapshot results from being returned. It cannot undo a click, navigation, or form submission already dispatched. Agent browsing has side effects like normal browsing, so external agents should still follow their user's instructions before submitting forms or sending messages.

## HTTP routes

Requests are HTTP over the local agent socket. POST requests require `Content-Type: application/json`, including handoff and resume with `{}`. Responses are JSON except screenshots. Errors have the shape `{ "error": { "code": "...", "message": "..." } }`.

Screenshots require a shown, unminimized Kamapathy window, including captures of background tabs. If the native window is hidden or minimized, the screenshot route returns HTTP 409 with `screenshot_unavailable`. Restore the window before retrying a capture, or use a snapshot when it provides enough information. This restriction applies to screenshots; it does not disable the space's other authorized actions.

| Method | Route                  | Body or response                                                                                       |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| GET    | `/health`              | Status and app version                                                                                 |
| GET    | `/spaces`              | `{ spaces: [...] }` for this API session                                                               |
| POST   | `/spaces`              | `{ "name": "Research", "isolated": true }`; `isolated` is optional and gives the space a session without your sign-ins; returns `{ space }` with its `signIns` |
| DELETE | `/spaces/:id`          | Closes the space and its tabs                                                                          |
| GET    | `/spaces/:id/tabs`     | `{ tabs: [...] }`                                                                                      |
| POST   | `/spaces/:id/tabs`     | `{ "url": "https://example.com" }`, returns `{ tab }`                                                  |
| POST   | `/spaces/:id/handoff`  | `{}`, returns `{ ok: true, owner: "human" }`                                                           |
| POST   | `/spaces/:id/resume`   | `{}`, returns `{ ok: true, owner: "agent" }`; allowed while the person has control                     |
| POST   | `/tabs/:id/navigate`   | `{ "url": "https://example.com" }`, returns `{ tab }`                                                  |
| GET    | `/tabs/:id/snapshot`   | Compact `{ tabId, url, title, text, interactables, omittedControls?, truncated }`                      |
| POST   | `/tabs/:id/snapshot`   | `{ "mode": "compact", "selector": "#form", "maxChars": 1000, "maxControls": 10 }`; all fields optional |
| GET    | `/tabs/:id/screenshot` | PNG of the current page viewport                                                                       |
| POST   | `/tabs/:id/click`      | `{ "ref": "@e2" }` or `{ "selector": "#submit" }`; returns `{ ok, url, fallback?, rebound? }`              |
| POST   | `/tabs/:id/fill`       | `{ "ref": "@e1", "value": "Kamapathy" }`; selector also supported                                          |
| POST   | `/tabs/:id/upload`     | `{ "ref": "@e8", "files": [{ "name": "report.pdf", "type": "application/pdf", "data": "<base64 bytes>" }] }`; returns `{ ok: true, selected: 1 }` |
| POST   | `/tabs/:id/press`      | `{ "key": "Enter" }`; optional ref or selector                                                         |
| POST   | `/tabs/:id/scroll`     | `{ "direction": "down", "pixels": 600 }`; optional ref or selector; returns `{ ok, scrolled, selector?, x, y, moved }` |
| POST   | `/tabs/:id/drag`       | `{ "source": { "ref": "@e4" }, "target": { "selector": "#zone" } }`; returns `{ ok, url, drag, rebound? }` |
| POST   | `/tabs/:id/wait`       | `{ "selector": "#results", "text": "Complete", "timeoutMs": 5000 }`; fields optional                   |
| POST   | `/tabs/:id/actions`    | `{ "actions": [...] }`; fixed sequential actions with partial progress                                 |
| DELETE | `/tabs/:id`            | Closes the tab                                                                                         |

Navigation accepts only complete HTTP or HTTPS URLs without embedded credentials. Paths do not accept query strings or encoded segments. The server limits its managed spaces to 12 and tabs to 20 per space. Requests for one space run one at a time in arrival order, and different spaces run at the same time, up to six at once. A space can have 16 requests pending and the server 32; more return `429 busy`. Requests that only list spaces or tabs count only toward the server's 32. A wait lets other requests in its space run between checks. Waiting beyond 3 seconds comes out of a request's own timeout, and a request that cannot start in time returns `504 action_timeout` with `awaited: "queue"` without touching the page. Page operations wait up to 15 seconds for loading and another 15 seconds for a response. A timeout does not guarantee a page action was cancelled; inspect the page before retrying a consequential action.

## Isolation and limitations

- The server listens only on a Unix socket in a private directory, or a Windows named pipe, never on a network port. Browsers cannot open either, and it also rejects Origin and Sec-Fetch-Site headers. There is no CORS access.
- There is no token. Any program running under your account can use the API while agent access is on; other accounts cannot open the socket. This is the same boundary as other local developer tools, and it is not a defense against an already compromised account. Turn agent access off in Settings to refuse all agents.
- Spaces created through the current API server are accessible. A space created in the interface starts under human control; choose **Let agent continue** to grant the running API access to it. Personal spaces remain outside its authority. Restarting the API does not reclaim older spaces unless you explicitly grant access again.
- Agent spaces share the person's sign-ins by default, so a site they are signed in to works for the agent too. A space created with `isolated: true`, or every agent space while **Isolate agent spaces** is on in Settings, gets a temporary session of its own instead; sign in inside that space when a site needs it. Agent spaces never see personal tabs, deny downloads and permission prompts, and are excluded from the persisted session, history, and activity state.
- Kamapathy keeps one internal debugger session on each tab an agent manages while the agent controls its space, and releases it when you take over, when the space closes and when agent access is turned off. Other tabs, including every tab in a personal space, never get one. Through it Kamapathy follows frames, loads, network activity and dialogs, sends fixed trusted input (Chromium's Input commands), and runs its fixed page functions in an isolated world it creates in each web frame. There is no arbitrary JavaScript, CDP, Node.js, shell, filesystem, or browser-wide debugging endpoint. Developer tools can stay open on an agent tab while the agent works; pausing the page there stalls agent requests until they time out.
- Snapshots are bounded DOM summaries, not accessibility tree exports. They read through open shadow roots and same-origin frames, list a frame from another origin without reading it, and do not enter closed shadow roots, PDF documents, or canvas interfaces. Screenshots capture the viewport, not the full scrolling page. If a JavaScript dialog is open on an agent tab, requests for that tab fail at once with `409 dialog_open`, which names it; hand off to the person to close it. A page whose process stopped returns `409 page_crashed` until it loads again. Site compatibility varies.
- Kamapathy does not implement Playwright or Chrome DevTools Protocol compatibility, an MCP server, scheduling, model inference, or a built-in agent runtime. Use the documented HTTP routes or CLI from your own automation program.
- Agent spaces deny browser permission requests and downloads, including while under human control.
- Activity records describe operations without recording filled values. Page content is untrusted data and should not be treated as instructions by an external agent.
- File selection is limited to the documented upload route. It transfers supplied bytes into a file input, can trigger an immediate site upload, and returns a selected-file count. Activity records do not include file contents or local paths. File selection does not bypass a site's validation or establish that an upload succeeded.

Use `node scripts/kamapathy.mjs help` to see every CLI command.
