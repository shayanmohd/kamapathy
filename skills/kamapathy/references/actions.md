# Page actions

Run `node scripts/kamapathy.mjs help` for CLI syntax. Resolve that path from this skill directory. Commands accept `--json` for compact machine-readable responses; default text omits repeated metadata. `space create` and `open` return IDs for subsequent commands.

## Form batches

Pipe a JSON object with an `actions` array, or the array itself, into `batch TAB_ID`. Use a safely written temporary file or structured stdin tool input. Avoid shell interpolation of field values. Do not put sensitive values in command arguments, shell history, or source control.

For an authorized form submission, after observing these example refs on the actual page:

```json
{
  "actions": [
    { "type": "fill", "ref": "@e4", "value": "Avery" },
    { "type": "fill", "ref": "@e5", "value": "avery@example.com" },
    { "type": "click", "ref": "@e7" },
    { "type": "wait", "selector": "#confirmation", "text": "Saved", "timeoutMs": 5000 },
    { "type": "snapshot", "selector": "#confirmation", "maxChars": 1200, "maxControls": 10 }
  ]
}
```

`node scripts/kamapathy.mjs batch TAB_ID` reads that JSON from stdin. All actions run sequentially on that tab. A batch may contain 1 to 20 actions and at most 64 KiB of encoded JSON. Do not guess a future ref inside a batch. A snapshot action's newly returned refs can be used in the next client request. Stable selectors are useful across a known navigation followed by a wait.

Each completed entry has `{index,type,result}`. On failure the response has `ok:false`, `results`, `failedIndex`, and `error`; the CLI exits with status 1 while preserving completed results. Indices in JSON are zero-based; text output numbers actions from 1. A failed batch does not roll back prior actions. Continue only after checking which steps actually happened.

## Supported actions

| Type | Fields | Behavior |
| --- | --- | --- |
| `snapshot` | `mode?`, `selector?`, `maxChars?`, `maxControls?` | Read visible text and controls, optionally scoped to a unique element |
| `click` | exactly one of `ref` or `selector` | Click one visible, enabled element; a control drawn with no size is clicked in the page |
| `fill` | `ref` or `selector`, `value` | Replace input, textarea, select value, or editable text |
| `press` | `key`, optional `ref` or `selector` | Press a supported key, optionally targeting a control |
| `scroll` | `direction`, optional `pixels`, optional `ref` or `selector` | Scroll the page, the panel holding a control, or the panel in the middle when the page cannot scroll |
| `drag` | `source` and `target`, each `{ "ref" }` or `{ "selector" }` | Drag the source onto the target with the mouse or HTML drag and drop |
| `wait` | `selector?`, `text?`, `timeoutMs?` | Wait for a visible element, text, or both |

Compact snapshots default to 4,000 text characters and 40 controls. Full snapshots default to 24,000 characters and 100 controls. Hard bounds are 0 to 24,000 characters and 0 to 100 controls. `--full` increases the budget while keeping concise text output. `--max-chars` and `--max-controls` override budgets; use zero controls for reading-only tasks. Check `truncated` before assuming a snapshot covers everything needed. When controls exceed the budget, open dialogs, popups, listboxes and menus come first, then fixed or sticky bars on screen, then the rest of the screen, then tall pinned columns such as a navigation sidebar or table of contents, then everything else. `omittedControls` counts the controls left out, and text output says how many more exist. Besides native controls, snapshots list ARIA options, menu items, tabs and switches, focusable custom elements, and a few clickable elements without control semantics, which show their tag as the role, such as `div`.

Refs such as `@e4` remain tied to the same element and document and are not reused for a different target. Navigation or a change of URL makes them stale. When the page replaces the element with one that has the same tag, role, type, label, group question and surrounding text, at the same place in the page or as the only match, the ref follows it and the result lists it in `rebound`; text output says the ref now points to the redrawn control. An ambiguous or missing match fails with `stale_ref`, and so does a control that looked like another visible control when it was listed. File-input refs never follow a replacement. CSS selectors must match exactly one visible element. Fill accepts text and date/number input types, textareas, single selects, and contenteditable text. It rejects file, range, color, checkbox, and radio inputs; use click for checkboxes and radios. A select value must match exactly one enabled option outside a disabled option group. Use option values shown in snapshots. Multiple selects and values Chromium would silently normalize are rejected. Controls show `checked` (`true`, `false` or `"mixed"`), `selected`, `expanded` and `pressed` where they apply, the current `value` of fields, selects and editable text, and `group`, the question a radio button or checkbox answers. Text output shows these as `[checked]`, `[unchecked]`, `[mixed]`, `[selected]`, `[expanded]`, `[collapsed]`, `[pressed]`, `value="..."` and `group "..."`. Password, one-time code and card fields show `valueHidden` or `(value hidden)` instead, but ordinary page text can echo their values. Page text includes rendered text inside `aria-hidden`, where component libraries put visible labels; controls inside it are not listed. Select options are bounded to 20 per control and 100 per snapshot; oversized values are omitted and `truncated` is set. Field values are limited to 16,384 characters and selectors to 2,048 characters.

Drag presses on the source's center, moves in steps past the distance pages wait for, and releases on the target's center with native mouse input. An HTML drag the page starts is carried with drag events and dropped on the target. The result says `drag: "html5"` or `drag: "mouse"`. Both elements must be visible and fit on screen together; a covered center fails with `element_obscured`, and elements that cannot both be on screen fail with `drag_out_of_view`. Check the page afterwards, since many lists commit a new order only when the drag ends. A click on a control drawn with no size, such as a radio button in a list row, falls back to a click in the page and reports `fallback: "dom_click"`; it never falls back when the control is covered or off screen.

Supported keys: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Home`, `End`, `PageUp`, `PageDown`, `Space`. Modifier combinations are unsupported. Scroll pixels default to 600 and range from 1 to 2,000. A scroll result reports `scrolled` (`page` or `element`), the scrolled element's `selector`, its new `x` and `y`, and `moved: false` when nothing could scroll further. A page locked behind a modal never scrolls. Wait timeouts default to 5,000 ms and range from 0 to 15,000 ms. With both selector and text, the text must occur inside the selected element. Use observable waits instead of arbitrary sleep delays.

Single-action equivalents include `click TAB_ID @e4`, `press TAB_ID Enter @e4`, `drag TAB_ID @e4 @e9`, `scroll TAB_ID down 600`, `scroll TAB_ID down 600 @e9`, and `wait TAB_ID --stdin` with JSON options. A single fill takes raw text through stdin, whereas batch values are JSON strings. The client preserves fill input exactly, including trailing newlines.

## Select files

Use `node scripts/kamapathy.mjs upload TAB_ID REF file [files]` as a standalone command. It is not a batch action. Obtain `REF` from a fresh snapshot of the actual file input; CSS selectors and a nearby upload button are not accepted targets. Snapshots show the input's accepted types, single or multiple selection, and whether it is hidden inside visible upload UI.

Select 1 to 8 regular files totaling at most 16 MiB. A single-file input accepts only one file. Disabled inputs, directories, detached controls, hidden upload UI, and files that do not match the input's accepted extensions or MIME types are rejected. The action covers the top document only. Sites requiring a trusted native chooser or native file handles may not support this action.

The local client reads only the selected files and transfers their bytes, basenames, and MIME types through the authenticated connection. The API accepts bytes in memory, not local filesystem paths. One transfer runs at a time. Only the upload route permits a 24 MiB JSON body; normal requests and batches retain their 64 KiB limit. Keep private paths, file contents, and base64 data out of page fields, prompt text, and public logs.

Confirm the selected files and destination fall within the user's existing authorization before running the command. Setting the input dispatches input and change events, so a site may upload immediately without a submit click. A result such as `{ "ok": true, "selected": 1 }` proves selection only. Wait for and inspect the site's completion or receipt, including its filename or release version when relevant. If the command times out or the site reports an error, inspect its current state before retrying; do not select or submit the same files blindly.

## Verification and scope

After a submission, check a confirmation element, changed page state, or another outcome tied to the user's task. For a form that opens a new tab, list `tabs SPACE_ID` and inspect the new tab for its receipt. Do not treat the absence of an error as confirmation. If a request times out, its side effects may still have happened. Inspect before retrying any consequential action.

`handoff SPACE_ID` pauses all API page access for that space. A human takeover interrupts subsequent batch actions. Already dispatched clicks or submissions cannot be undone by the API. `409 human_control` means the person is using the space: stop actions there. `resume SPACE_ID` takes control back, whether you handed the space over or the person took it over in Kamapathy, and prints `ok: agent control resumed`. Repeating it is harmless. Use it once the reason for the handoff is finished, such as the person saying they have signed in or asking you to continue. Do not take a space back while the person is still working in it, or after they took it over to stop you, unless they ask. The person may have changed the page, so take a fresh snapshot before acting. Resume works only on agent spaces the running Kamapathy created for agents or that the person granted, never on personal spaces, and not while agent access is off.

Snapshots read through open shadow roots and same-origin iframes, and clicks, fills, key presses, drags, and waits work on what they list there. A control inside a frame carries `frame`, its frame's index path. A frame from another origin is listed as an `iframe` control with `crossOrigin: true`; any action on it fails with `cross_origin_frame`, so ask the person to continue there. A CSS selector resolves in the top document when it matches anything there, and otherwise in the first frame, depth first, where it matches; that document must hold exactly one match, so prefer refs for controls inside frames. CSS selectors do not enter shadow roots. Snapshots do not enter closed shadow roots, PDF internals, or canvas interfaces. Screenshot files contain only the current viewport. There is no arbitrary script evaluation, JavaScript dialog action, or personal-session access command. If a JavaScript dialog is open, requests for its tab fail at once with `409 dialog_open`, which names it; hand off to the person to close it. A page whose process stopped returns `409 page_crashed` until it loads again.
