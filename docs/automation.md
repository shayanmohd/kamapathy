# Local automation

Kamapathy exposes a local HTTP API for scripts and external agents. It supplies browser tools and a human handoff mechanism. It does not bundle an AI model or autonomously plan tasks.

## Connect

Agents connect automatically. While agent access is on in **Settings**, under Agents (the default), the desktop app listens on a local socket in the profile's private agent folder, or on a named pipe with a new random name on Windows. The bundled client finds it with no token or setup, and starts Kamapathy when it is not running and access was left on. Turning agent access off stops the socket, and the client never starts Kamapathy against that choice. The web preview has no local automation server.

Each profile has its own agent folder, `agent` inside Kamapathy's application data folder. Set `KAMAPATHY_USER_DATA` to reach a different profile. The folder records the socket's location and a random instance value, whether access is off, and how to start this Kamapathy again. Every response carries the instance in `X-Kamapathy-Instance`, and the client confirms it with `GET /health`, which never waits behind page actions, before sending its first command. A client starts Kamapathy at most once, and a script's client connects only when the script makes its first call. Automatic starts run only a recorded program that no other account could have replaced, and never reopen debugging ports. See the skill's [connection reference](../skills/kamapathy/references/connection.md) for failures and the `not_connected` reason each one carries.

**Set up agents**, in Settings under Agents, gives the agents on this computer Kamapathy's own copy of the skill and, if you want it, a `kamapathy` command. The copy lives in a private tools folder, `~/.local/share/kamapathy` or `%LOCALAPPDATA%\Kamapathy\tools`, where a stable `skill` folder always points at the copy for the running version; every start refreshes it. Each agent's skills folder holds a link to that stable folder, and the `kamapathy` command runs the same copy, so both stay in step with the browser without another install. When a start cannot refresh the folder, Recent activity in Settings says so and the older copy keeps working. Where this guide writes `node scripts/kamapathy.mjs`, `kamapathy` works once the command is set up.

The bundled CLI uses Node.js built-ins, needs Node.js 22.13 or later for every command but `help` and `--version`, and runs on macOS, Windows, and Linux:

```sh
node scripts/kamapathy.mjs health
node scripts/kamapathy.mjs space open "Documentation research"
```

`space open` returns the listed space with that ID or name, or creates it; `space create` always creates a new one. Copy the returned space ID. A new space's first page is `p1`, and `<space-id>:p1` names it anywhere a tab ID goes:

```sh
node scripts/kamapathy.mjs navigate <space-id>:p1 https://example.com
node scripts/kamapathy.mjs snapshot <space-id>:p1
node scripts/kamapathy.mjs screenshot <space-id>:p1 ./example.png
node scripts/kamapathy.mjs handoff <space-id>
node scripts/kamapathy.mjs resume <space-id>
node scripts/kamapathy.mjs space finish <space-id> --keep none
```

Angle bracket IDs in examples are placeholders to replace with actual IDs. New spaces open in the background. In an agent space you are looking at, the tab an agent works in comes forward; Kamapathy never switches your space or focuses its window. Screenshot files use exclusive creation so an existing file is never overwritten. `node scripts/kamapathy.mjs help <command>` explains any command without connecting.

## Spaces, pages and labels

`GET /spaces` lists the spaces this API session can reach: the agent spaces it created and the spaces the person let it use, until the agent finishes them or the person stops it. Each carries `id`, `name`, `kind` (`agent`, or `personal` for one of the person's own spaces), `owner` (`agent` or `human`, whoever has control), `signIns`, `createdBy` (`agent` or `person`) and `pageBudget`. While the person has control it adds `reason` and `since`; while the agent has control it adds `recentTabTitles`, the titles of up to three of its newest pages.

`space create <name>` (`createSpace` in scripts) always creates an agent space. `space open <name-or-id>` (`openSpace`) returns the listed space with that ID, or else the first listed space with exactly that name, and creates one only when neither exists, so a later run finds its space again by name. A new space starts with one blank page, `p1`. When `space open` finds a space with other sign-ins than an explicit `--isolated`, or the `isolated` option, asks for, it answers `409 sign_ins_mismatch` instead of reusing it.

### Labels

Every tab in an agent space, and in a personal space while an agent may use it, gets a label, `p1`, `p2` and so on, in the order the tabs appear. A label is never reused in its space while Kamapathy runs, so it keeps naming the same page, open or closed. Labels are not saved. The CLI takes `<space-id>:<label>` anywhere it takes a tab ID; scripts take a Page, a tab ID or a label wherever a page goes, and `space.page("p2")` returns a page by its label. An unknown label throws `page_not_found`, and a retired one says who closed it.

`tabs <space-id>` (`GET /spaces/:id/tabs`) lists every tab of the space with its `label`, `openedBy` (`agent`, `page` for a popup, or `person`), `openerId` for a popup, `managed`, `active` for the tab the space shows, and `unseen` for a popup no request has addressed yet. Tabs showing files on this computer are never listed, and `active` is null while the space shows one. It also returns the last 100 closed labels with `closedBy` and `at`, and the page budget's `used` and `limit`. The CLI prints one line per tab, such as `p3 <tab-id> page from p2 new https://example.com/receipt "Receipt"`, adding `unmanaged`, `active` and `new` where they apply.

### Managed pages

Only pages the agent manages answer page routes; any other page answers `409 tab_unmanaged`. Pages the agent opens are managed, and so is a popup that a managed page opens while the agent has control. Tabs the person opened, in the app or while they had control, are not. `adopt <tab>` (`space.adopt(page)`) makes such a page the agent's and keeps its label, and `release <tab>` (`space.release(page)`) gives it back to the person and leaves it open. A page the agent opened cannot be released (`409 release_refused`); close it instead.

### Page budget

A space's page budget is how many pages the agent may manage there at once: 1 to 20, and 20 by default, the earlier limit of tabs per space, so existing scripts keep working. Set it with `pageBudget` in `createSpace` or `openSpace`, with `--page-budget` on `space open`, or with `KAMAPATHY_PAGE_BUDGET` for every space the client creates or opens. At the budget, `open`, `new-page` and `adopt` change nothing and answer `409 page_budget` with the managed `pages`, for example `Page budget reached (20 of 20) in "Research". Close a page or reuse one with navigate.` Popups count toward the budget but are never refused by it.

### Closing and finishing

`close <tab>` (`page.close()`) closes a managed page and retires its label. Closing a space's last page leaves a blank page with the next label in its place, returned as `replacement`.

Finish every task. `space finish <space-id> --keep all|none|<tab>[,<tab>]` (`space.finish({ keep })`) closes the managed pages that the agent and its popups opened, except the ones it keeps, and ends the agent's access to the space. Tabs the person opened and pages the agent never adopted are protected and stay open. `keep` is `"all"` or up to 20 pages, all checked before anything closes, and scripts must pass it: `finish()` without it throws `invalid_argument` before sending anything. An agent space with nothing kept or protected is deleted. Otherwise the space stays open with the person, marked **Done**, and leaves the agent's listing, and every later request on it answers `409 space_ended`. The result lists the `closed`, `kept` and `protected` labels and says whether the space closed (`closedSpace`).

`space close <space-id>` (`space.close()`) closes an agent space and every tab in it. It answers `409 space_protected`, listing the person's tabs, for a space where the person opened tabs and for one of the person's own spaces; finish those instead.

### Popups

In every space, `window.open`, links that target `_blank` and forms that target a new window open a real popup: a tab in the opener's space that keeps its opener and shares its session. `window.open` returns a handle, and `opener`, `postMessage` and `window.name` work both ways, as sign-in windows expect. Chromium sends a form's body itself, in every encoding. The popup gets the next label, `openedBy: "page"` and its opener's tab ID in `openerId`, and `tabs` shows it as `new` until a request addresses it; `page.opener()` returns the opener while it is open. In an agent space, or a personal space while an agent may use it, popups open in the background and never change the person's selection; in a personal space they open in front, as before.

- A popup may show `about:blank`, an HTTP or HTTPS page without credentials, or a `blob:` URL a web page made, and its `url` follows it from `about:blank`. `data:` popups and other schemes are refused, so `window.open` returns `null`.
- A popup outlives its opener. A page that closes itself closes its tab, and its label retires with `closedBy: "page"`.
- A click with a modifier key opens its link in a new tab without an opener. Kamapathy loads it with its referrer and, for a URL-encoded or multipart form, its body.
- An agent space, or a personal space while an agent may use it, holds at most 20 tabs. A popup past that is refused, and the space's activity says `A popup was blocked. This space has 20 tabs.`
- A same-origin popup opened with `window.open(url)` may run its first document before Kamapathy's page functions are ready in it.

## Asking for one of your spaces

Agents never see a personal space until the person lets one use it. The person can do that at any time with **Let an agent use this space** in the space's options, which shows the access line before a second click grants it, or by allowing an agent's request:

```sh
node scripts/kamapathy.mjs space request --reason "Read the order in your shop tab" --name "Shopping"
```

`space request` (`requestSpace({ reason, name, timeout })` in scripts) puts an alert dot on the Spaces button and a row, **An agent is asking for a space**, in the Spaces menu. The row opens **Let an agent use a space?**: the reason, marked as coming from the agent, the access line, which says agents can read and act on the space's tabs and use its sign-ins until the person stops them, and a choice among the person's spaces and agent spaces without access, with the space named `name` chosen first. The reason is 1 to 120 characters and the name at most 48; control and bidirectional characters are removed, and both always show as the agent's text.

The request waits up to its timeout, 5000 to 600000 ms and 600000 by default. **Allow** grants the chosen space and answers with the space, all of its tabs and the active one, which a script reads with `space.userPage()`. **Don't allow** answers `403 request_declined`, and no answer `504 request_timeout`, which is not retryable because asking again interrupts the person. At most 3 requests wait at once, and for 60 seconds after a decline new requests answer `429 busy` with `retryAfterMs`. A request disappears when its client disconnects, and until the person allows one, no answer says which spaces they have.

A granted space follows agent rules for as long as the grant lasts: Kamapathy records no history there, opens its popups in the background, keeps its pages painting, denies downloads and permission prompts, and disables its sign-ins switch. Every tab already in it is the person's and unmanaged, so the agent adopts a page before acting on it. The grant ends when the agent finishes, when the person chooses **Stop** or **Stop agent access**, when agent access is turned off and when Kamapathy quits, and it is never saved. Finishing never deletes a personal space.

## Interact with a page

A snapshot contains the page's URL, title, visible text, and controls with labels, CSS selectors, and short element references such as `@e1`, read through open shadow roots and same-origin frames. Hidden, inert, transparent, and closed disclosure content is excluded. Text inside `aria-hidden` is included when it is rendered: the attribute hides content from assistive technology, not from the screen, and component libraries such as Google's Angular components put visible field labels and questions there. Icon font names such as `arrow_drop_down` are left out of text and labels. Controls under `aria-hidden` stay excluded, because pages hide what sits behind an open modal or menu that way. File-input metadata is an exception: an input hidden inside visible upload UI can expose a ref, accepted types, and its multiple-selection flag, without exposing selected files. Select controls include option labels, exact values, disabled states, and which options are selected: up to 20 options per select and 100 per snapshot, omitting values longer than 256 characters and setting `truncated` when options are omitted. Scope a select to avoid the shared option budget. Compact mode is the default: 4,000 text characters, 40 controls, and 80-character labels. Full mode raises the defaults to 24,000 text characters, 100 controls, and 200-character labels. Both modes retain the same JSON response shape and a `truncated` flag.

Controls include native links, buttons, fields, and disclosures; elements with the ARIA roles people operate directly, such as `option`, `listbox`, `menuitem`, `tab`, `switch`, `textbox`, `slider`, and `treeitem`; popup triggers with `aria-haspopup`; draggable elements; and custom elements that take keyboard focus. A wrapper that only holds other controls, such as a tree row drawn as a button around its tree item with no text of its own, and a list of options, are listed through the controls inside them. A checkbox, radio button, or switch drawn inside an option, menu item, tab, or tree item is part of that item; other controls inside one, such as a tab's close button or a tree item's expand button, are listed. Up to 30 elements that a page draws as clickable or draggable, with a pointer, grab, or move cursor and their own short text, are listed after every other control. A label comes from `aria-label`, `aria-labelledby`, a label element, a placeholder, the control's own text without icons marked `aria-hidden`, or its `title`. A field with none of these takes the text of the nearest container that holds no other control.

Each control can carry its state and value, in fields that appear only when they apply. `checked` is `true`, `false`, or `"mixed"`; `selected`, `expanded`, and `pressed` report the ARIA and native states. `value` is the current value of a text-like input, textarea, single select, contenteditable region, ARIA slider or spin button, or the choice a custom select shows without the options of a list open inside it, bounded to the label length; `valueTruncated` marks a shortened value. Password inputs, fields whose `autocomplete` is `current-password`, `new-password`, `one-time-code`, or any `cc-` token, and fields masked by `-webkit-text-security` report `valueHidden: true` instead of any value they hold. Radio buttons and checkboxes carry `group`, the question they answer: a fieldset legend, the name of a `radiogroup` or `group`, or the text before the choices when the group has no name. Radio buttons that share a name form a group even without a container. Text that a website echoes elsewhere remains visible, so snapshots are not a secret-redaction service.

When a page has more controls than the budget, the snapshot lists controls inside open dialogs, popups, listboxes, and menus first, then controls on screen inside fixed or sticky bars, then the rest of the screen, then controls on screen inside tall pinned columns, then everything else, and keeps the list in page order. A pinned box is a bar, such as a header, a banner, or the action bar at the bottom of a form, when it is at most a third of the viewport tall or at least two thirds as wide. A taller, narrower one, such as a navigation sidebar or a table of contents, is the same on every page, so the page beside it comes first. `omittedControls` counts the controls left out, and the CLI says how many more exist. Scope with `--selector` to list them.

Text and controls inside an open shadow root appear where the page draws them, in the order a person sees them, with slotted content where its slot is; labels, `aria-labelledby`, and refs resolve inside the shadow root. Text and controls inside a same-origin iframe appear where the frame sits in the page, nested frames included. Each control inside a frame carries `frame`, the index path of its frame among the frames of the document around it, such as `"0"` or `"0/1"`. Clicks and drags add the position of every frame around the control, fill and key presses act in the frame's document, and every selector searches the top document first, then frames depth first, as [Selectors](#selectors) describes, with CSS searching each open shadow root on its own. A control inside a frame lists its selector within its own document, which may also match in the page around it, so prefer its ref or a locator. A frame from another origin, such as a payment form or an embedded map, is listed as a control with `role: "iframe"`, `crossOrigin: true`, and a label from its title, name, or host, so an agent knows content exists that Kamapathy cannot read. Any action on it fails with `409 cross_origin_frame`; ask the person to continue there. Closed shadow roots and canvas interfaces stay out of reach. PDFs show in Chromium's viewer, whose frames agents never enter; pdf/text reads them.

Prefer compact snapshots, scoped snapshots, and element references for short agent conversations. A scoped snapshot observes one uniquely matching selector, such as `form`, `#checkout` or `role=dialog`. Set `maxChars: 0` for controls only or `maxControls: 0` for text only. Explicit bounds are 0 to 24,000 text characters and 0 to 100 controls. Scope and bounds constrain the result; they do not grant access to other tabs or spaces.

`scope: "viewport"` keeps only the text runs and controls whose boxes meet the visible part of the viewport, frames included; refs it leaves out stay valid. `root: "@eN"` reads one ref's subtree, and a frame's ref reads that frame's document; with `selector` it answers `400 invalid_field`, and a root that rebinds reports `rebound` as any ref does. `selector` takes any form of the grammar and must match exactly one element, hidden matches counted. A root or a selector combines with `scope: "viewport"`.

`header` is on by default and names the page, its space and the space's tabs: `{page: {id, label, title}, space: {id, name}, tabs: [{id, label, title, openedBy, managed, current?}]}`, plus `budget: {used, limit}` when the space is within one page of its budget and `pdf: true` on a PDF. `tabs` is what `GET /spaces/:id/tabs` returns, titles are cleaned like other agent text and cut at 60 characters, and text output prints the header in place of the title line:

```
page p2 "Checkout" | space "Reserve a table" 6f1c9a2e-3b0d-4c55-9e1a-2d7b8c4f0a11 | tabs: p1 "Home", p2 "Checkout" (this page), p3 "Receipt" (popup), p4 "Menu" (person) (unmanaged) | budget 3 of 4
```

`(popup)` marks a page another page opened and `(person)` one the person opened, `(unmanaged)` follows a page the agent has not adopted, and `header: false` leaves the line out and restores the title.

`format: "outline"` returns `outline` in place of `text`: the page's structure, one line per printed node, two spaces per level. An element line reads `role "name" @eN` and then the state tokens, file-input details and values a control list shows, `level=N` on a heading and `href=` on a link. Outlines print landmarks, dialogs, headings, lists, tables, named images, canvases, named regions and forms, groups and other containers holding controls, controls themselves, and frames with their document nested beneath them; other elements are transparent, and a list item, row or cell holding one text line takes it as its name. Text lines are JSON strings of at most 400 characters, open dialogs and popups print first, `interactables` lists the controls and frames the part printed, and `maxChars` bounds the characters:

```
form "Order"
  group "Delivery"
    radio "Pickup" @e1 [checked] group "Delivery"
    radio "Courier" @e2 [unchecked] group "Delivery"
  textbox "Password" @e3 (value hidden)
  button "Save" @e4
```

`locators: true` gives each listed control a `locator`: a selector of the grammar that resolves to that control alone, which outlives its ref and works in a later run. Kamapathy proposes `css=[data-testid="..."]` and the same for `data-test`, `data-qa` and `data-cy`, then `css=#id`, then `role=<role>[name="..."]`, then `href=` for a link, then `css=<tag>[name="..."]` and the same tag with `aria-label` and `placeholder`, takes the first that resolves to that one control across every document, and keeps values to 100 characters. Ids that look generated are skipped: ids holding a colon or three digits in a row, ids with a run of eight or more characters mixing letters and digits, and ids starting `react-`, `radix-`, `headlessui-`, `mui-`, `ember`, `yui_` or `ext-gen`. A control may end up without one. The pass stops after 1,500 ms and sets `locatorsIncomplete: true`, and text output ends a control's line with ` locator: <locator>`.

A snapshot that left something out carries `next`, a cursor. Send it back as `cursor` with the same `scope`, `root` or `selector` and `format` for the part after it; `mode`, `maxChars` and `maxControls` may change between parts. Text advances by character, controls by ranked position and outlines by line, with the ancestors of a continued outline's first line repeated above it. Parts hold no repeats and no gaps while the page and its scroll position stay as they were. Text output ends with `Next part: cursor <next>`. A cursor made for another scope, root, selector or format answers `400 invalid_cursor`, and one from an earlier document or URL answers `409 page_changed`.

```sh
node scripts/kamapathy.mjs snapshot <tab-id>
node scripts/kamapathy.mjs snapshot <tab-id> --selector '#search-form' --max-chars 1000
node scripts/kamapathy.mjs snapshot <tab-id> --full --json
node scripts/kamapathy.mjs snapshot <tab-id> --viewport --outline --locators
node scripts/kamapathy.mjs snapshot <tab-id> --cursor 'c1.<next>'
node scripts/kamapathy.mjs screenshot <tab-id> ./page.png --full-page
node scripts/kamapathy.mjs click <tab-id> @e2
node scripts/kamapathy.mjs press <tab-id> Enter
node scripts/kamapathy.mjs drag <tab-id> @e4 @e7
node scripts/kamapathy.mjs scroll <tab-id> down 600 @e9
node scripts/kamapathy.mjs navigate <tab-id> https://example.com
```

Element references remain stable while the same document and element remain available. Pages often draw a control again after an input, for example a Save button that becomes enabled once a field changes. When a reference's element is gone, Kamapathy looks for the control drawn in its place: an element with the same tag, role, type, label, group question, and surrounding text as when a snapshot last listed it, on the same URL, that no current reference holds. It prefers the element at the same position in the page, and otherwise accepts exactly one match among at most 2,000 elements of the same kind. A control that looked like another visible control when a snapshot listed it, such as the Remove buttons of two rows with the same name, is never re-bound, because Kamapathy cannot tell which one the reference meant. The action reports the reference in `rebound`, and the reference points to the new element from then on. When nothing matches, or more than one element does, the reference fails with `stale_ref`. References never follow a control across a navigation or a change of URL, and file inputs are never re-bound. References also expire when the API restarts or when the bounded reference cache expires. Take a new snapshot after navigation or a stale-reference error. A well-formed ref Kamapathy never issued for the page answers `404 unknown_ref` without any page work. Selectors of every documented form work beside refs, and `locators: true` proposes one selector per control that outlives them.

Clicks require a visible, enabled element and verify that another element does not cover its center. Kamapathy sends fixed native Chromium mouse events to the target tab without focusing the application. A control drawn with no size, such as a radio button inside a list row that takes the row's clicks, has no point to press. Kamapathy then clicks it in the page with a DOM click, which the page sees as an untrusted event, and reports `fallback: "dom_click"`. It does this only when the nearest box around the control is on screen and uncovered; otherwise the click fails as covered or outside the viewport. This supports normal form validation and submission. A link or form that targets a new window opens a real popup in the same space, as [Popups](#popups) describes; the submitting tab does not navigate, so list `tabs SPACE_ID` to find the popup, then verify its receipt there. Click and key actions briefly allow immediate navigation to start, then wait for its load; use an explicit wait condition for a later asynchronous outcome. Chromium discards native input that reaches a page before it renders its first frame after a navigation, and reports that dispatch as successful, so Kamapathy confirms that the page received each click and key press. Input that provably never reached the page is repeated after a rendered frame; input that never arrives fails with `input_not_delivered`. Input that reached the page is never repeated, and no other action is retried automatically.

Fill supports text, search, telephone, URL, email, password, number, date, time, datetime-local, month, and week inputs; textareas; single selects by exact option value; and contenteditable text. Chromium must accept an input value without normalization. Multiple selects, duplicate option values, disabled options or option groups, range inputs, and color inputs fail explicitly. Controls are rechecked after focus handlers run. It focuses the element within its page and dispatches input and change events. File uploads, checkbox values, and radio values are not accepted by fill. Use click for checkboxes and radios. Keyboard input supports Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, and Space. It can optionally target a ref or selector first. Modifier combinations, shell shortcuts, and arbitrary key sequences are not accepted.

Drag presses the mouse on the center of a source element, moves in steps past the distance pages wait for before a drag starts, and releases on the center of a target element, all with native Chromium mouse events. Source and target are each a ref or a unique selector. Both must be visible, the source enabled, and the target outside the source. Kamapathy scrolls the source into view, and the target when it is off screen. It fails with `drag_out_of_view` when both cannot be on screen together, and with `element_obscured` when another element covers either center. When the page starts an HTML drag, Kamapathy intercepts it before Chromium starts an operating system drag, moves it with drag events that carry the data the page set, and drops it on the target, as Playwright does. The result reports `drag: "html5"` or `drag: "mouse"`. A drag the page starts but Kamapathy never receives fails with `drag_not_delivered` after the mouse is released. If the person takes over during an HTML drag, Kamapathy cancels it instead of dropping.

Field values go through standard input, keeping them out of process arguments. The CLI preserves input exactly, including trailing newlines. For a nonsensitive sample value:

```sh
node -e "process.stdout.write('browser architecture')" | node scripts/kamapathy.mjs fill <tab-id> '#search' --stdin
```

For sensitive values, pipe from an appropriate local secret source. The API accepts up to 16,384 characters per field, 2,048 characters per selector, and 64 KiB per normal request body. The dedicated upload route has the larger bound described below.

## Selectors

Every `selector` field takes one grammar: page routes, batch steps and a snapshot's scope alike, at most 2,048 characters. A `ref` field still takes only a ref, each body still gives exactly one of `ref` or `selector`, and `selector: "@e12"` acts as `ref: "@e12"`. A batch's selectors are all parsed before its first step runs.

| Form | Example | Matches |
| --- | --- | --- |
| Ref | `@e12` | Its snapshot element; no search |
| CSS, the default | `form .save` | CSS in the document and each open shadow root, each tree alone |
| `css=` | `css=#save` | The same |
| `text=`, unquoted | `text=sign in` | Innermost elements whose text contains it, ignoring case and extra spaces |
| `text=`, quoted | `text="Sign in"` | Elements with an own text run equal to it |
| `role=` | `role=button[name="Save"]` | Chromium's computed role with that exact accessible name; `[name*="pri"]` takes part of the name, ignoring case, and `role=checkbox` takes any name |
| `href=` | `href=/plans?tier=pro#faq` | Links whose path, query and hash, or whose whole URL, equals it |
| `xpath=`, or a leading `//` or `..` | `xpath=//table//tr[2]` | Elements from `document.evaluate` in each document, never in a shadow root |
| CSS ending in `:has-text("...")` | `li:has-text("Invoice 12")` | CSS matches whose text, shadow content included, contains it, ignoring case |
| CSS ending in `:text-is("...")` | `button:text-is("Save")` | CSS matches with an own text run equal to it |
| Any form but a ref, ending in `>> nth=N` | `role=button[name="Delete"] >> nth=-1` | The Nth match in search order, from 0; -1 is the last |

`node scripts/kamapathy.mjs help selectors` prints the same forms, and `help("selectors")` prints them in a script.

Text is compared with U+200B and U+00AD removed, whitespace collapsed and the ends trimmed. An element's text is its `textContent` through open shadow roots, without `head`, `script`, `style`, `noscript`, `template` and `title`; button, submit and reset inputs use their value instead. An own text run is a sequence of adjacent text node children, ended by an element child. An unquoted `text=` drops a match that renders another match, so the innermost element wins, while `:has-text` keeps the ancestors. Double-quoted values decode as JSON strings, single-quoted values take `\'` and `\\`, and an unquoted role name runs to its closing `]`. `:has-text` and `:text-is` end the CSS, take one quoted argument and need a base without a top-level comma; `>> nth=` ends the whole selector, and any other `>>` is an error.

An exact `role=` name is compared with Chromium's computed accessible name as it stands. That name collapses ordinary whitespace but keeps U+00A0, U+00AD and U+200B, so a name holding one of those must be written with the character in it. `[name*="..."]` normalizes both sides and ignores case instead.

### Search order

The top document first, then its same-origin frames depth first, nested frames included. Within a document the order is the one a person sees, with a host's open shadow content before its light children. CSS runs on the document and on each open shadow root alone, so no CSS selector reaches across a shadow boundary, and XPath never enters one.

### Matching

An action's selector must name one element that action can take, and each action counts matches at its own level:

| Action | Level | A match counts when it is |
| --- | --- | --- |
| click | `pointer-enabled` | rendered and not disabled |
| drag | `pointer` | rendered |
| fill, press with a target | `enabled` | rendered and not disabled |
| scroll with a target, wait | `visible` | rendered, counting content inside `aria-hidden` |
| snapshot `selector` | `none` | matched at all |

The top document decides while it holds a candidate at the level; with none there, the frames decide together. One candidate acts. Several answer `422 ambiguous_match`, so hidden and disabled duplicates of a control no longer make an action's selector ambiguous. None answers `422 no_match` with the `selector` and `waitedMs` once the action's wait runs out. A match that fails the level, such as the one Save button while it is disabled, still answers today's `element_action_failed` or `element_obscured`.

The center hit test only chooses between candidates: a lone match under a sticky header is scrolled to and clicked as before, while a control behind a modal backdrop loses to the one the dialog shows. `>> nth=N` picks from the whole search-order list before any level applies, and an index past the end matches nothing. A ref skips the search and the level, and the action's own checks still run.

`wait` and its batch step name one visible element the same way, but they keep polling while the selector matches several, so a selector that never settles ends as `wait_timeout`; they end at once on `invalid_selector`, `unknown_ref` or `stale_ref`. `wait` with `selector: "@eN"` waits for that ref's element to be visible.

`ambiguous_match` carries `count`, `visible`, `hidden` and `actionable`, and up to 3 `candidates`, the ones the action could take first. A candidate is `{ref, tag, role, name, context, visible, disabled, frame?}`, with `name` and `context` computed as a snapshot computes them and cut at 80 characters, and a `ref` issued now when the element had none. Act on a candidate's ref, or narrow the selector; single CLI commands print one `candidate ...` line each. A failed resolution never changes a ref that already stands.

### Role words

`role=` compares Chromium's computed role, lowercased. These words cover more than their name suggests, so that `role=` and an outline's role words agree:

| Word | Also matches |
| --- | --- |
| `button` | `summary`, a color input and a file input |
| `textbox` | a contenteditable region, and date, time and datetime inputs |
| `img` | the `image` role Chromium reports |
| `table`, `row`, `cell` | the layout table, row and cell Chromium reports for a table of `td` cells without headers |
| `checkbox` | an `input` with the `switch` attribute |

`textfield` is accepted as another word for `textbox`, `listboxoption` and `menulistoption` for `option`, and `image` for `img`. Every other word stands for itself, which matters where Chromium's role differs from the element: a `header` or `footer` inside an `article`, `aside`, `main`, `nav` or `section` is `sectionheader` or `sectionfooter`, not `banner` or `contentinfo`, and a `section` the page does not name is `generic`, not `region`.

### Selector errors

A selector that does not parse answers `400 invalid_selector` with the `selector`, a `reason` (`grammar`, `ref_form`, `css` or `xpath`), `forms`, the examples above, a `hint` where one helps, and the batch step's `index`. Grammar and ref-form problems, and an id that starts with a digit, are found in Kamapathy before any page work; other CSS and XPath the page rejects are found while resolving, before any input. `@21`, `ref=21` and `21` are `ref_form` and hint `Refs look like @e21. Take one from a snapshot.`, and `#1abc` hints `Write ids that start with a digit as [id="1abc"].`

A well-formed ref Kamapathy never issued for the page answers `404 unknown_ref`, and one it retired, or whose element is gone and does not rebind, answers `409 stale_ref`. Both name the `ref`, and neither a never-issued nor a retired ref reaches the page. With a JavaScript dialog open, a `role=` selector, a locator pass and a capture answer `409 dialog_open` at once instead of waiting out their timeout.

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

## Read a PDF

A PDF shows in Chromium's viewer, whose frames agents never enter, so there is no page text to snapshot. `pdf-text <tab-id>` (`page.pdfText(options)` in scripts, `POST /tabs/:id/pdf/text`) reads the document's text by page instead:

```sh
node scripts/kamapathy.mjs pdf-text <tab-id>
node scripts/kamapathy.mjs pdf-text <tab-id> --from 3 --to 8 --max-chars 40000
```

The answer carries the PDF's `url` and `title`, its `pageCount`, the `from` and `to` pages this read covers, `pages`, each with its `number` and `text`, the `chars` returned, and `truncated`. The CLI prints the title, the page count and the URL, then `[page N]` and that page's text for every page. When the cap cut the text, the answer adds `nextPage` and the CLI prints `More pages: rerun with --from N.`; when the pages carry no text, as in a scan, it adds `noText` and says the pages may be scans.

One read covers at most 500 pages, so `--to` is at most 499 after `--from`, and returns at most `--max-chars` characters, 20,000 by default and 1,000,000 at most; a single page longer than the cap comes back cut. `--timeout <ms>` bounds the whole read, 15,000 ms by default and 60,000 ms at most. Two PDFs are read at a time across the whole app, and a third answers `429 busy` with `scope: "pdf"`. A read lets other requests in its space run meanwhile, and if the person takes over or stops the agent while it runs, the text is withheld.

Kamapathy reads the bytes again through the tab's own session, with its cookies, so a PDF behind a sign-in reads. A PDF a form submission returned is never asked for a second time: that answers `409 pdf_not_refetchable` with `reason: "post"`, and a PDF from any scheme but http, https and `blob:` answers the same with `reason: "scheme"`. A tab showing something else answers `409 not_pdf` with its `contentType`. A PDF over 64 MiB, or over 16 MiB when it came from a `blob:` URL, answers `422 pdf_too_large` with the `limitBytes`, one that needs a password `422 pdf_locked`, bytes no parser can read `422 pdf_unreadable`, a read that failed `422 pdf_fetch_failed` with the `httpStatus` when there was one, and a `from` past the end `422 page_out_of_range` with the `pageCount`. Parsing runs in a separate process with no network and no browser access, and a read that passes its deadline answers `504 pdf_timeout` with `awaited: "fetch"` or `"extract"`. A PDF's text is page content: untrusted data, like a snapshot's text.

## Batch a short interaction

`POST /tabs/:id/actions` accepts 1 to 20 fixed actions. The server validates the entire plan before running the first step, then executes in order with an ownership check at every step. A field a step does not define is refused with `400 unknown_field`, naming the step's `index` and `action`. Successful responses have `{ ok: true, results: [{ index, type, result }] }`. A failure returns the applicable HTTP error status and `{ ok: false, results, failedIndex, error: { code, message } }`, and `retryable` and `dispatched` in that error describe only the failed step. `results` contains completed steps; later steps do not run. If the person takes over or stops the agent during the batch, or agent access is turned off, earlier observation contents are withheld.

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

`run` executes an agent's script in the agent's own Node.js with the client as globals, so a whole task is one program instead of one command per step:

```sh
node scripts/kamapathy.mjs run task.mjs
node scripts/kamapathy.mjs run --timeout 600000 --env-file ./site.env task.mts
node scripts/kamapathy.mjs run -e 'const research = await openSpace("Research"); const page = research.page("p1"); await page.navigate("https://example.com"); console.log(await page.text())'
```

`run [--ts] [--timeout <ms>] [--env-file <path>]... (<file> | - | -e <code>)` takes its options before the source and checks them before it reads standard input or reaches Kamapathy. `run -` reads the script from standard input. The script is an ES module with top-level `await`, imports relative to its own file, and Node built-ins. It gets the globals `kamapathy` (the client), `createSpace`, `openSpace`, `space`, `spaces`, `requestSpace` and `help`, which are writable and not enumerable. Code given through `-` or `-e` goes through a private temporary file, created exclusively with mode 0600 and always removed.

Nothing connects until the script's first call, so a script that never calls Kamapathy never starts it, and a script may set `KAMAPATHY_USER_DATA` or `KAMAPATHY_NO_LAUNCH` before that call. The client starts Kamapathy at most once. When the connection drops during a call, that call throws `not_connected` with reason `lost`, and the next call finds Kamapathy again without starting it.

**Output.** Everything the script writes through `process.stdout` and `process.stderr`, and so every `console` method, is held in order and printed when the run ends. Writes straight to a file descriptor, such as a child process with inherited output, are not held. Past 4 MiB, further output is dropped and the run ends with `Kamapathy: <n> more bytes of output were dropped after the first 4 MiB. Write large results to a file.` Notices, such as the skill notice under [Versions and API levels](#versions-and-api-levels), print once each on stderr as `notice: <text>`, after the held output.

**Exit status.** 0 when the script finishes. 1 for an uncaught error or unhandled rejection, a script that stopped with calls still pending (`error: The script stopped with work still pending. Await every call.`), `run_timeout` or a failed setup. 3 after a hard stop, whatever the script passed to `process.exit`. 128 plus the signal number after a signal, such as 130 after Ctrl+C.

**Hard stops.** The first error showing a decision of the person stops the run for good, even when the script catches it: `human_control` with reason `manual` or `handoff` (the person took over or was handed the space), `space_ended` with `endedBy: "person"` (they stopped the agent there), and `automation_stopped` or `not_connected` with reason `access_off` (agent access is off). Later calls throw a copy with `hardStop: true` and send nothing. The run drops its held output and notices, prints only the guidance for that cause on stderr, and exits with status 3:

```
Kamapathy stopped this run: the person has control of the space.
The person took over this space. Stop, and resume only when they ask you to.
Output from this run was withheld. Stop here, do not retry or work around it, and continue only when the person asks.
```

The second line is the error's own message. After the person's Stop the guidance reads `Kamapathy stopped this run: the person stopped the agent in this space.` and `Output from this run was withheld. Stop here and tell the person; only they can let an agent use it again.`; with agent access off it reads `Kamapathy stopped this run: agent access is turned off.` and `Output from this run was withheld. Stop here and tell the person. Only they can turn agent access on, in Settings under Agents.` Other errors stay ordinary, `space_ended` after the agent's own finish included. A `human_control` with any reason but `manual`, `handoff` and `failed` is a hold the script can catch and wait out with `space.waitForControl()`; an uncaught one ends the run with status 1 and this line after its error: `Tell the person what is waiting for their answer in Kamapathy, then run kamapathy wait-for-control <space-id> and start a new run when it returns.`

**Time limits.** A run stops at `--timeout <ms>`, else `KAMAPATHY_RUN_TIMEOUT_MS`, else 300000 ms; either value must be an integer from 1000 to 3600000. At the deadline the call in progress is stopped, and the run prints its held output and `error: run_timeout: The script did not finish within <ms> ms. A call in progress may still have taken effect, so inspect the page before retrying. Use --timeout for longer tasks.`, then exits with status 1. SIGINT, SIGTERM and SIGHUP, and SIGBREAK on Windows, stop it the same way with `error: interrupted: The run was stopped by <signal>. A call in progress may still have taken effect, so inspect the page before retrying.` and exit 128 plus the signal number. Standard input for `run -`, `fill --stdin`, `wait --stdin` and `batch` is limited to 64 KiB and must end within 30 seconds: `Standard input did not end within 30 seconds. Pipe the complete value and close the input.`

**Failures.** A failed run prints the error's headline, `error: <code>: <message>` for a Kamapathy error and `error: <Name>: <message>` for a built-in one, then `  at <label>:<line>:<column>` for the first place in the script, where the label is the file as typed, `stdin` or `-e`, never the temporary file. A retryable error adds `Kamapathy: Nothing reached the page, so the same command can be retried.`, and one that reached the page adds `Kamapathy: The action reached the page before it failed. Inspect the page before retrying.` Up to two `hint:` lines follow, for example when a script uses a page global such as `document`, which Node.js does not have, or misspells a method. For a script that does not compile, `node --check` parses the file without running it, and the run prints the line with a caret:

```
error: SyntaxError: Unexpected token ',' (-e:2:8)
  2 |   b: 1,,
    |        ^
```

The client module, `skills/kamapathy/scripts/api.mjs`, exports `connect(options?)` for any Node program and depends on Node built-ins only; `connect({ lazy: true })` waits for the first call, as `run` does. A `Client` has `createSpace(name, { isolated, pageBudget })`, `openSpace(nameOrId, { isolated, pageBudget })`, `requestSpace({ reason, name, timeout })`, `space(id)`, `spaces()` and `app`, the running Kamapathy's version and API level. A `Space` carries `id`, `name`, `owner`, `signIns`, `kind`, `createdBy`, `pageBudget` and, while the person has control, `reason`, `prompt` and `since`, with `open(url)`, `newPage()`, `page(label)`, `pages()`, `tabs()`, `adopt(page)`, `release(page)`, `handoff()`, `resume()`, `waitForControl({ timeout })`, `userPage()`, `finish({ keep })` and `close()`. A `Page` carries `id`, `label`, `spaceId`, `openedBy`, `openerId`, `managed`, `url` and `title`, with `navigate`, `snapshot`, `text` (the same text the CLI prints), `click`, `fill`, `press`, `scroll`, `drag`, `wait`, `batch`, `upload`, `screenshot`, `opener` and `close`. Each method sends one route from the table below, plus at most one spaces or tabs request to resolve an ID or a label; the script runs on your computer and never inside a page. Every method checks its arguments and options before sending, so an unknown option throws `invalid_option` and a missing or wrong argument `invalid_argument`. A failed call throws a `KamapathyError` with the API's `code`, `message` and HTTP `status`, the failing call in `entry`, and every other field of the error as a property of its own, such as `retryable`, `dispatched` or `reason`; a failed batch also carries `results` and `failedIndex`. `help()` lists the API and `help("page.click")` shows one entry. The skill's [scripting reference](../skills/kamapathy/references/scripting.md) has the complete surface, examples and the safety rules.

### TypeScript

`run` takes `.ts`, `.mts` and `.cts` files, and `--ts` with `-` or `-e`. Node.js erases the types without checking them, and syntax that would need compiling, such as `enum`, fails with a SyntaxError. A `.ts` file follows the `type` in its folder's `package.json`, so `.mts` is the safe choice for top-level `await`. Node.js 22.18 and later strip types by themselves; on 22.13 to 22.17, `run` starts itself once more with `--experimental-strip-types`, passing the child the script's path, never its code, and exits with the child's status. `--ts` with a file fails with `--ts applies to run - and run -e. Name a TypeScript file .ts, .mts or .cts.`, and a Node.js that still cannot strip types fails with `This Node.js cannot run TypeScript. Use Node.js 22.18 or later, or write the script in JavaScript.`

### Workspace and .env

Each profile has a scripting workspace, the `workspace` folder in Kamapathy's profile folder beside `agent`, or the folder `KAMAPATHY_WORKSPACE` names, resolved against the current folder. `node scripts/kamapathy.mjs workspace` prints its absolute path, or `{"workspace":"<path>"}` with `--json`, and creates it with mode 0700 when it is missing; `run` and `repl` never create it. On macOS and Linux an existing workspace must be a folder your account owns that others cannot change, or `run`, `repl` and `workspace` refuse it: `Kamapathy's workspace <path> must be a folder your account owns that others cannot change.`

`run` and `repl` set `KAMAPATHY_WORKSPACE` to the workspace's absolute path, then load `<workspace>/.env` when it exists, then each `--env-file` in order. A variable that was set when the run started never changes, and a later file overrides an earlier one. A file cannot set `KAMAPATHY_USER_DATA` or `KAMAPATHY_WORKSPACE`, or `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA` and `XDG_CONFIG_HOME`, from which the client finds the profile and the app; such a line is skipped with `Kamapathy: <path> cannot set <name>. Set it in the environment instead.` Variables such as `KAMAPATHY_NO_LAUNCH`, `KAMAPATHY_RUN_TIMEOUT_MS` and `KAMAPATHY_PAGE_BUDGET` may come from a file. Each file must be a regular file of at most 64 KiB, not a link, that your account owns and, on macOS and Linux, others cannot change: `Kamapathy will not load <path>: it must be a regular file of at most 64 KiB that your account owns and others cannot change.` Values reach only the script's `process.env`, and a Kamapathy that `run` or `repl` starts does not inherit them; Kamapathy never prints, logs or sends them. Single commands load no `.env`.

Files are parsed with Node's `util.parseEnv`, which reads them as `node --env-file` does:

- A line starting with `#` is a comment, and so is the rest of an unquoted value from `#` on, even without a space before it: `KEY=value#note` sets `value`. Text after a closing quote is dropped.
- Single quotes, double quotes and backticks keep `#` and spaces, and a quoted value may span lines. Only double quotes turn `\n` into a newline, and there are no other escapes: in a double-quoted value, `\"` keeps the backslash and ends the value. An unterminated `"` stays part of the value and does not swallow later lines.
- `export KEY=value` works. Spaces around `=` and around an unquoted value are trimmed, `KEY=a=b` sets `a=b`, a repeated key takes its last value, and CRLF line endings are fine.

Node.js 22.13.0 alone reads three things differently, in `run` as in its own `--env-file`: an unquoted value keeps a trailing tab, a line without `=` joins the next line's key (`NOEQ` followed by `C=3` sets a key made of both lines), and `export` followed by two spaces leaves a space at the start of the key. Such a key is a different variable, so on 22.13.0 a `KAMAPATHY_USER_DATA` line written after `export` and two spaces is not skipped with a message, and it changes nothing Kamapathy reads.

### repl

`node scripts/kamapathy.mjs repl [--env-file <path>]...` starts a scripting session for a person at a terminal, and refuses to start without one: `repl needs a terminal. Pipe a script to run - instead.` It loads the workspace and `.env` files as `run` does, installs the same globals over a client that connects on its first call, prints `Kamapathy scripting session. Type help() for the API and .exit to leave.` and prompts with `kamapathy> `. It runs JavaScript only; top-level `await`, multi-line entries and `.editor` come from Node.js, and modules load with `await import()`. Output appears at once and nothing is withheld; after a hard stop, later entries still send requests, which Kamapathy refuses while the person has control. Notices print once, before the next prompt. Ctrl+C stops the calls of the entry in progress, which reject with `interrupted`, though their actions may already have happened. History stays in memory, `.exit` or Ctrl+D leaves, and no time limit applies. Agents use `run`.

## Human handoff

`handoff` gives the person control of a space with reason `handoff`, choosing **Take over** in Kamapathy gives it with reason `manual`, and `fail` gives it with reason `failed`, as [Status, labels and the agent cursor](#status-labels-and-the-agent-cursor) describes. While the person has control, the API cannot inspect, navigate, capture, modify, or delete that space or its tabs, and those requests return HTTP 409 with `human_control`. `GET /spaces/:id` and wait-for-control still answer, and the space remains visible in `GET /spaces` with `owner: "human"`, its `reason` and `since`, the time the person got control in milliseconds since 1970.

`human_control` carries `spaceId`, `reason`, `since` and, when the person is asked something, `prompt`. Its message is fixed per reason:

| Reason | Message |
| --- | --- |
| `manual` | The person took over this space. Stop, and resume only when they ask you to. |
| `handoff` | You handed this space to the person. Resume when they say they are done. |
| `failed` | You reported that this task could not be finished. Resume only when the person asks you to. |
| `approval` | Kamapathy is asking the person to approve `<prompt>`. Wait for control. |
| `permission`, `device`, `http_auth`, `client_certificate` | The site asked for `<prompt>`, and only the person can answer. Wait for control. |

This version of Kamapathy records `manual`, `handoff` and `failed`. The other reasons are part of the API so that clients handle them: the last two rows are holds, which only the person's answer ends.

Control returns to the agent in two ways. The person can choose **Let agent continue** in the bar under the space's page, or in the Spaces menu, or the agent can take control back with `resume`. `resume` changes the owner to agent and records an activity entry saying the agent took control back. It passes the person's control after `manual`, `handoff` and `failed`, and answers `human_control` for a hold or an approval. It works on any space the running API server created or was granted, including one the person took over. A resume sent while the agent already has control changes nothing, and if the person takes over before that request runs, it returns `human_control` instead of taking the space back. It cannot reach personal spaces the person has not granted, agent spaces never granted to the running server, spaces from an earlier server session, or a space whose access ended.

`resume` and `wait-for-control` answer `{ ok: true, owner: "agent", active, opened, closed }`, what changed while the person had control. `active` is the tab the space shows, or `null`; `opened` lists the tabs that opened meanwhile and are still open, all unmanaged until the agent adopts them; `closed` lists the labels retired meanwhile. `space.userPage()` returns the `active` page from the last such answer that Space object received. The CLI prints them as `active`, `opened` and `closed` lines after `ok: agent control resumed` or `ok: agent has control`.

`wait-for-control <space-id> [--timeout <ms>]` (`space.waitForControl({ timeout })`) waits until the agent has control and never takes it: it answers at once when the agent has control, and otherwise when the person lets the agent continue. It waits beside the space's queue, so the space's other requests keep running, and at most 8 waits run at once (`429 busy`, retryable). Its timeout is 0 to 600000 ms, 600000 by default; when it passes, the wait answers `504 control_timeout` with `awaited: "control"`, `timeoutMs` and the `reason` the person still has control for. When the person stops the agent meanwhile, it answers `409 space_ended`.

Agents should take control back once the reason for the handoff is finished, for example when the person says they have signed in or asks the agent to continue. They should not take a space back while the person is still working in it, or after the person took it over to stop the agent, unless the person asks. The page may have changed, so take a new snapshot after resuming.

### Stop and finish

**Stop**, in the bar under a space's page or in the space's details in the Spaces menu, ends the agent's access to that one space, whoever has control, without closing any tab. The bar asks first, **Stop the agent in this space?**, with **Stop**, **Stop all agents**, which turns agent access off, and **Cancel**. Other spaces keep working. Steps in flight fail at their next ownership check, withholding earlier results as for `human_control`, and every later request on the space, `resume` and wait-for-control included, answers `409 space_ended` with `spaceId`, `endedBy: "person"`, `reason: "stopped"` and the message `The person stopped the agent in this space. Stop here and tell them; only they can let an agent use it again.` After the agent's own [finish](#closing-and-finishing), it carries `endedBy: "agent"`, `reason: "finished"` and `The agent finished this space. Open or create another space to continue.` Only the person can let an agent use the space again, with **Let agent continue**, which grants it anew with every tab unmanaged, or by allowing a request.

An agent space whose agent finished or was stopped stays open until Kamapathy quits, marked **Done** or **You stopped the agent**; the activity entry still reads Agent finished and carries the agent's last status. A space where the agent reported a failure stays the person's, marked **Failed** with the message as its status, until they let the agent continue. **Keep as personal space**, in its bar and options, makes it a personal space that Kamapathy saves like any other. Shared sign-ins stay. Separate ones end, as the confirmation `Its temporary sign-ins end and its pages reload.` says, and its pages reload in a new persistent session of its own.

Turning agent access off in Settings remains the hard stop for every space. It stops the server, refuses every request, including `resume`, ends every grant and withdraws waiting requests for a space. Turning access on again starts a server that does not reclaim earlier spaces until you grant them again.

Taking over or stopping the agent blocks subsequent automation operations and prevents pending snapshot results from being returned. It cannot undo a click, navigation, or form submission already dispatched. Agent browsing has side effects like normal browsing, so external agents should still follow their user's instructions before submitting forms or sending messages.

## Updates

While **Check for updates** is on in Settings, under Updates, Kamapathy asks GitHub Releases once a day whether a newer version exists, sending no ID or usage data. Agents can read that state, ask for a check and start the download, and never install:

- `GET /update` returns the update status: the install `kind`, the `state` (`unchecked`, `current`, `available`, `downloading`, `ready` or `unsupported`), `checkedAt`, the `latest` release, download `progress`, a verified `installer` and the last `error`, with the running `version` and whether `checks` are on.
- `POST /update/check` with `{}` asks GitHub for a newer version, or answers with the result of a check under 60 seconds old.
- `POST /update/download` with `{}` starts the download of this computer's installer, or joins one already running. It answers 202 while the download runs and 200 when the copy is current, an installer is ready, or the status carries an error.

The three routes declare no lane, so they never wait behind a page action, and they count toward the server's 32 pending requests rather than a space's 16. A copy with no published installer refuses all three with `409 update_unsupported` and `reason` `source`, for a run from a checkout, or `platform`; Settings then says the copy runs from source. A check GitHub does not answer gives `502 update_check_failed`, the only 502 in the API, with a `reason` and sometimes `retryAfterMs`. A download that stops or fails its checksum has no status of its own: `update_download_failed` and `update_verify_failed` arrive in the status's `error`.

`GET /health` carries `skill: { path }` while the skill folder the app ships exists, and `update: { version, state }` while a newer version is available, downloading or ready. The client turns that into one line on stderr for `health`, `run` and the REPL, `notice: update_available: ...` or `notice: update_ready: ...`, and leaves output and exit statuses alone. `node scripts/kamapathy.mjs upgrade` checks and then downloads, prints the installer's path and what the person does next, and never installs; `--check` stops after the check and `--timeout 0` returns once the download starts. Opening, installing, cancelling and quitting exist only in the window. A Kamapathy the client starts never inherits the `KAMAPATHY_UPDATE_FEED` and `KAMAPATHY_UPDATE_KIND` test variables.

## Status, labels and the agent cursor

The person watching a space should not have to read logs to see what an agent is doing. An agent says what it is working on, names the steps that matter, and says when it cannot finish; Kamapathy shows a cursor where the agent acts and keeps every word of the agent's in its own voice.

`status <space-id> <text>` (`space.setStatus(text)`) shows the person what the agent is doing, in at most 120 characters. `status <space-id> --clear`, an empty text or `setStatus(null)` clears it. A status stays until the agent changes it, so text set before a handoff, such as `Sign in, then let me continue`, is what the person reads meanwhile, and repeating the current status changes nothing.

`fail <space-id> <message>` (`space.fail(message)`) reports that the task cannot be done, in at most 300 characters. It hands the space to the person, marked **Failed** with the message as its status, and answers `{ ok: true, owner: "human", state: "failed", status }`. Afterwards every request that is refused under human control answers `409 human_control` with `reason: "failed"`; `GET /spaces/:id` and wait-for-control still answer, and `resume`, or the person's **Let agent continue**, clears the failure and its message. Report a failure and stop, rather than trying a task again in a way the person did not ask for.

`click`, `fill`, `press`, `scroll` and `drag` take `label`, a few words naming the step, in at most 60 characters: `--label "Open the details"` anywhere in a command's arguments, `{ label }` in a script's final options object, and a `label` field on those batch steps. Observation routes and the other batch steps do not declare it and answer `400 unknown_field`; a batch checks every label before its first step and names the step in `index`. A label shows beside the cursor and under the space's name while its action runs and for five seconds after it ends, and it stays on that action's activity entry. An action without a label leaves none behind.

Labels, status text and failure messages are the agent's own words, and so are the names agents give spaces. Line breaks and tabs become spaces, other control characters and the bidirectional marks are removed, runs of spaces collapse and the ends are trimmed; a value longer than its limit, or a label, message or name that is empty after cleaning, answers `400 invalid_field` with `field` and `expected`. Kamapathy always shows what is left as the agent's, quoted or styled apart from its own phrases, and never in a button, the address bar, the window title or a prompt. Keep field values, secrets and personal data out of labels and status: they are on the person's screen and in the space's activity.

While the person is looking at an agent space, a cursor glides to each point the agent acts on, with the current label in a pill beside it. It is a separate view over the page, so no website can see it and no screenshot contains it. It hides while the person has control, while agent access is off, when the window is hidden or the page is frozen, and for a second after the person's own pointer reaches it.

`GET /spaces` and `GET /spaces/:id` carry a space's `status` and its `state`: `needs-you` while the agent is waiting for the person, `done` after the agent finished the space, `failed` after a reported failure, and `error` for an agent space whose page stopped working. The `spaces` command prints both at the end of a space's line, and a `Space` in a script carries them as `status` and `state`. Kamapathy shows them as **Needs you**, **Done**, **Failed** and **Page stopped** in the bar under the page, the Spaces menu and the overview, and the space's activity records each status change, each outcome and a crashed page once.

A route that reads or acts on a page first makes its tab the one its space shows, then waits up to 500 ms for its next rendered frame: in the space the person is looking at the tab becomes active, and in another space it becomes the tab that space opens on. The person's space, the window and keyboard focus never change, a split pane keeps its other half, and the routes that only list or read state, such as `GET /spaces`, `GET /spaces/:id/tabs` or wait-for-control, move nothing. Agent pages are created at the size of Kamapathy's content area, so a page the person has not looked at yet reports the viewport it will have when they do.

## HTTP routes

Requests are HTTP over the local agent socket. POST requests require `Content-Type: application/json`, including handoff and resume with `{}`. Responses are JSON except screenshots. Errors have the shape `{ "error": { "code": "...", "message": "..." } }`, with the fields [Errors](#errors) describes. The server checks every body against its route before the request waits for its turn, and refuses a field the route does not define with `400 unknown_field`.

Screenshots capture the tab's own page on its own debugger session, with the Kamapathy window shown, hidden or minimized. A capture never shows or focuses a window and never changes which space is active, and the image holds only that tab's page, never the Kamapathy interface or another tab. `GET /tabs/:id/screenshot` is the same as a `POST` with `{}`: the viewport, at CSS scale.

`fullPage: true` captures the whole scrollable document, and `clip` captures part of the image's own space, in CSS pixels from its top left: the viewport, or the document with `fullPage`. A clip's `x` and `y` are at least 0, its `width` and `height` above 0; it is rounded outward to whole pixels and intersected with that space, and `422 clip_outside_page` answers a clip with nothing left. `scale: "css"`, the default, makes one image pixel one CSS pixel at any zoom and display density, which is the space clicks and clips use; `scale: "device"` keeps device pixels. Output is at most 16,384 pixels on a side and 33,554,432 pixels in all, else `422 screenshot_too_large` names the size and both limits. The response adds `X-Kamapathy-Clip: x,y,width,height`, the whole CSS pixels captured in the image's own space, and `X-Kamapathy-Pixel-Ratio`, `1` for `css` and the zoom times the display's scale for `device`. `timeoutMs` covers the load wait and the capture together and defaults to 15,000 ms. A capture cut off by a navigation, a renderer exit, a detached session or the deadline answers `503 screenshot_failed`, which can be retried, and developer tools holding the tab's session answer `409 debugger_busy`.

A capture reaching past the current visual viewport, which is any full page and any clip outside it, costs the page one `resize` event, one visual viewport resize and matchMedia changes, and now and then gives it a viewport of 1 by 1 pixel for an instant that ResizeObserver and IntersectionObserver can report. It leaves unloaded lazy content unloaded and paints fixed elements where the current scroll position puts them. The first capture of an agent tab in a hidden window also turns that page's `visibilityState` to `visible` for good. A viewport capture, and a clip inside the viewport, cause none of this.

`POST /tabs/:id/pdf/text` reads the text of a PDF a tab shows, page by page, without entering Chromium's viewer; [Read a PDF](#read-a-pdf) describes its bounds and its errors.

<!-- generated:routes -->
| Method | Route | Body | Description |
| --- | --- | --- | --- |
| GET | `/health` |  | Checks the connection. Returns `{ status: "ok", version, apiLevel, versions, skill?, update? }`. |
| GET | `/update` |  | Reads Kamapathy's update status. Returns `UpdateStatus`. |
| POST | `/update/check` | `{}` | Checks GitHub Releases for a newer Kamapathy, or returns the result of a check under 60 s old. Returns `UpdateStatus`. |
| POST | `/update/download` | `{}` | Starts or joins the download of this computer's installer; only the person installs it. Returns `202 UpdateStatus while downloading; 200 UpdateStatus when current or ready`. |
| GET | `/spaces` |  | Lists the spaces this API session can reach. Returns `{ spaces: SpaceView[] }`. |
| POST | `/spaces` | `name`, `isolated?`, `pageBudget?`, `reuse?` | Creates an agent space whose first page is p1, or with reuse returns the listed space whose ID or name matches. Returns `201 { space: SpaceView, tab: TabView, created: true }; reused 200 { space: SpaceView, created: false }`. |
| GET | `/spaces/:id` |  | Reads one space the agent can reach, also while the person has control. Returns `{ space: SpaceView }`. |
| DELETE | `/spaces/:id` |  | Closes an agent space and its tabs. A space holding tabs the person opened is refused. Returns `{ ok: true }`. |
| POST | `/spaces/:id/handoff` | `{}` | Hands the space to the person. Returns `{ ok: true, owner: "human" }`. |
| POST | `/spaces/:id/status` | `text` | Shows the person what the agent is doing. Returns `{ ok: true, status? }`. |
| POST | `/spaces/:id/fail` | `message` | Reports that the task cannot be done and hands the space to the person. Returns `{ ok: true, owner: "human", state: "failed", status }`. |
| POST | `/spaces/:id/resume` | `{}` | Takes control of the space back after the person took over, a handoff or a reported failure, and lists what changed meanwhile. Returns `{ ok: true, owner: "agent", active: TabView \| null, opened: TabView[], closed: label[] }`. |
| POST | `/spaces/:id/wait-for-control` | `timeoutMs?` | Waits until the agent has control of the space, answering at once when it already has, and lists what changed while the person had control. Returns `{ ok: true, owner: "agent", active: TabView \| null, opened: TabView[], closed: label[] }`. |
| POST | `/spaces/:id/finish` | `keep` | Ends the agent's task in a space: closes the pages it does not keep, keeps the person's tabs and ends its access. Returns `{ ok: true, spaceId, closedSpace, closed: label[], kept: label[], protected: label[] }`. |
| GET | `/spaces/:id/tabs` |  | Lists every tab of a space with its label and origin, the last 100 closed labels and the page budget. Returns `{ tabs: TabView[], closed: [{ label, closedBy, at }], budget: { used, limit } }`. |
| POST | `/spaces/:id/tabs` | `url?` | Opens a page in the background, or a blank page without url. Stops at the page budget. Returns `201 { tab: TabView }`. |
| POST | `/space-requests` | `reason`, `name?`, `timeoutMs?` | Asks the person to let an agent use one of their spaces and waits for their answer. Returns `{ space: SpaceView, tabs: TabView[], active: TabView \| null }`. |
| DELETE | `/tabs/:id` |  | Closes a page the agent manages. Its label is retired, and a blank page with the next label replaces a space's last page. Returns `{ ok: true, closed?: label, replacement?: TabView }`. |
| POST | `/tabs/:id/adopt` | `{}` | Makes a page the agent did not open its own, within the page budget. The page keeps its label. Returns `{ tab: TabView }`. |
| POST | `/tabs/:id/release` | `{}` | Gives a page the agent did not open back to the person. The page stays open. Returns `{ tab: TabView }`. |
| POST | `/tabs/:id/navigate` | `url`, `waitUntil?`, `timeoutMs?`, `referer?` | Loads a URL in the tab and waits for the new document to reach a state. Returns `{ ok: true, tab: TabView, httpStatus?, waitUntil, dialog? }`. |
| POST | `/tabs/:id/reload` | `waitUntil?`, `timeoutMs?`, `ignoreCache?` | Reloads the page and waits for the new document to reach a state. Returns `{ ok: true, tab: TabView, httpStatus?, waitUntil, dialog? }`. |
| POST | `/tabs/:id/wait-for-url` | `url?`, `waitUntil?`, `after?`, `timeoutMs?` | Waits for this page's URL to match a glob, or reports its commits so a script can match them itself. Returns `{ ok: true, tab: TabView, url } or { ok: true, tab: TabView, url, navigation, committed, missed?, popups }`. |
| POST | `/tabs/:id/wait-for-load-state` | `state?`, `idleMs?`, `timeoutMs?` | Waits for the document this page shows to reach a state. Returns `{ ok: true, tab: TabView, state }`. |
| POST | `/tabs/:id/wait-for-function` | `expression?`, `function?`, `arg?`, `intervalMs?`, `timeoutMs?` | Waits for a function the agent wrote to return a truthy value in the page. Returns `{ ok: true, tab: TabView, value? } or { ok: true, tab: TabView, unserializable }`. |
| GET | `/tabs/:id/info` |  | Reads the viewport, scroll offsets, document size and ready state. Returns `{ tab: TabView, viewport: { width, height }, scroll: { x, y }, document: { width, height }, readyState, loading } or { tab: TabView, dialog }`. |
| GET | `/tabs/:id/snapshot` |  | Reads a compact snapshot. Returns `snapshot`. |
| POST | `/tabs/:id/snapshot` | `mode?`, `maxChars?`, `maxControls?`, `selector?`, `scope?`, `root?`, `header?`, `cursor?`, `format?`, `locators?` | Reads bounded page text and controls with refs. Returns `snapshot`. |
| POST | `/tabs/:id/actions` | `actions` | Runs 1 to 20 actions in order, stopping at the first failure. Returns `{ ok: true, results } or { ok: false, results, failedIndex, error }`. |
| GET | `/tabs/:id/screenshot` |  | Captures the viewport as PNG at CSS scale in any window state, the same as POST with {}. Returns `image/png`. |
| POST | `/tabs/:id/screenshot` | `fullPage?`, `clip?`, `scale?`, `timeoutMs?` | Captures the viewport, the whole page or a clip as PNG, at CSS or device scale. Returns `image/png with X-Kamapathy-Clip and X-Kamapathy-Pixel-Ratio`. |
| POST | `/tabs/:id/click` | `ref?`, `selector?`, `button?`, `clickCount?`, `delayMs?`, `position?`, `force?`, `timeoutMs?`, `label?` | Clicks a control with native mouse input, waiting until it can take the press. Returns `{ ok: true, url, point, loading?, fallback?, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/dblclick` | `ref?`, `selector?`, `button?`, `delayMs?`, `position?`, `force?`, `timeoutMs?`, `label?` | Double-clicks a control with native mouse input. Returns `{ ok: true, url, point, loading?, fallback?, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/hover` | `ref?`, `selector?`, `position?`, `force?`, `timeoutMs?`, `label?` | Moves the mouse onto a control and leaves it there. Returns `{ ok: true, point, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/fill` | `ref?`, `selector?`, `value`, `append?`, `timeoutMs?`, `label?` | Replaces the value of a field, select or editable region, or adds to it. Returns `{ ok: true, match, value?, valueHidden?, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/select` | `ref?`, `selector?`, `values`, `timeoutMs?`, `label?` | Chooses a select's options by value, label or index. Returns `{ ok: true, values, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/focus` | `ref?`, `selector?`, `timeoutMs?`, `label?` | Focuses a control, retargeting to the nearest one that takes focus. Returns `{ ok: true, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/press` | `key`, `ref?`, `selector?`, `delayMs?`, `timeoutMs?`, `label?` | Presses a key or a chord, focusing a control first when given. Returns `{ ok: true, url, loading?, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/scroll` | `direction`, `pixels?`, `ref?`, `selector?`, `label?` | Scrolls the page, the panel holding a control, or the panel in the middle. Returns `{ ok: true, scrolled, selector?, x, y, moved, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/drag` | `source`, `target`, `sourcePosition?`, `targetPosition?`, `button?`, `force?`, `timeoutMs?`, `label?` | Drags one element onto another, waiting until both ends can take the gesture. Returns `{ ok: true, url, drag, loading?, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/wait` | `selector?`, `text?`, `timeoutMs?` | Waits for a visible element, text, or both. Returns `{ ok: true }`. |
| POST | `/tabs/:id/mouse/move` | `x`, `y`, `steps?` | Moves the mouse to a point, interpolating from where it stands. Returns `{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/mouse/down` | `button?`, `clickCount?` | Presses a mouse button where the pointer stands. Returns `{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/mouse/up` | `button?`, `clickCount?` | Lets a held mouse button go where the pointer stands. Returns `{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/mouse/click` | `x`, `y`, `button?`, `clickCount?`, `delayMs?` | Clicks at a point with native mouse input, without resolving a target. Returns `{ ok: true, url, input, loading?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/mouse/wheel` | `deltaX`, `deltaY` | Scrolls with the wheel where the pointer stands. Returns `{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/keyboard/down` | `key` | Holds one key down and reports the tab's input state. Returns `{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/keyboard/up` | `key` | Lets one held key go and reports the tab's input state. Returns `{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/keyboard/type` | `text`, `delayMs?` | Types text as key events, character by character. Returns `{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/keyboard/insert-text` | `text` | Inserts text at the focused editable's caret, without key events. Returns `{ ok: true, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/keyboard/paste` | `text`, `html?` | Pastes text, and optional HTML, without the system clipboard. Returns `{ ok: true, handled, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/input/release` | `{}` | Lets go of every key and mouse button this tab holds. Returns `{ ok: true, released }`. |
| POST | `/tabs/:id/upload` | `ref?`, `selector?`, `files` | Selects files on a file input. Returns `{ ok: true, selected, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/pdf/text` | `from?`, `to?`, `maxChars?`, `timeoutMs?` | Reads a PDF's text by page without entering Chromium's viewer. Returns `PdfText`. |
| POST | `/tabs/:id/expectations` | `event`, `timeoutMs?` | Arms a wait for the next popup, download, file chooser or dialog in the tab, before the action that causes it. Returns `201 { expectation: { id, event, tabId, expiresAt } }`. |
| POST | `/expectations/:id/wait` | `{}` | Waits for the armed event outside the space's queue, so the action that causes it can run meanwhile. Returns `{ popup: TabView }, { download: Download }, { fileChooser: { id, tabId, multiple, accept } } or { dialog: DialogRecord }`. |
| DELETE | `/expectations/:id` |  | Cancels an armed wait and ends the wait running on it. Returns `{ ok: true }`. |
| POST | `/tabs/:id/dialog-policy` | `accept`, `promptText?`, `times?`, `lifetimeMs?` | Arms how the tab answers JavaScript dialogs, before the action that opens one. Without a policy, confirms are dismissed and prompts return nothing. Returns `{ policy: { accept, promptText, remaining, expiresAt } }`. |
| DELETE | `/tabs/:id/dialog-policy` |  | Clears the tab's dialog policy, so its dialogs are dismissed again. Returns `{ policy: null }`. |
| GET | `/tabs/:id/dialogs` |  | Reads the tab's dialog policy and the last 20 dialogs Kamapathy answered in it, oldest first. Returns `{ policy: { accept, promptText, remaining, expiresAt } \| null, dialogs: [{ type, message, defaultValue, answer, promptText, url, at }] }`. |
| POST | `/spaces/:id/http-credentials` | `origin`, `username`, `password` | Stores a name and password for one http or https origin, in memory only, to answer the first server sign-in from that origin in the space's own pages. A repeat, a proxy sign-in and a certificate request always go to the person. Returns `{ ok: true, origin }`. |
| DELETE | `/spaces/:id/http-credentials` |  | Forgets every origin the space stored credentials for. Returns `{ ok: true }`. |
| GET | `/spaces/:id/downloads` |  | Lists the downloads this space holds, newest first. Only downloads an agent armed are kept. Returns `{ downloads: [{ id, tabId, url, suggestedFilename, mimeType, state, receivedBytes, totalBytes, failure }] }`. |
| GET | `/downloads/:id` |  | Reads one held download and how far it has come. Returns `{ download: { id, tabId, url, suggestedFilename, mimeType, state, receivedBytes, totalBytes, failure } }`. |
| POST | `/downloads/:id/cancel` | `{}` | Stops a download that is still running. A finished one is left as it is. Returns `{ download: { id, state, receivedBytes, totalBytes, failure } }`. |
| DELETE | `/downloads/:id` |  | Deletes the download's bytes from the browser's profile. Returns `{ ok: true }`. |
| POST | `/downloads/:id/wait` | `timeoutMs?` | Waits until the download stops running, outside the space's queue. Ask again to keep waiting. Returns `{ download: { id, tabId, url, suggestedFilename, mimeType, state, receivedBytes, totalBytes, failure } }`. |
| GET | `/downloads/:id/content` |  | Reads a finished download's bytes over the socket. The connection drops if the space leaves the agent while it streams. Returns `application/octet-stream with Content-Length, Cache-Control: no-store and X-Content-Type-Options: nosniff`. |
| GET | `/tabs/:id/popups` |  | Lists the open pages this page opened, with the ones nothing has reported yet marked unseen. Returns `{ popups: [{ id, label, url, openedAt, unseen? }] }`. |
<!-- /generated:routes -->

Navigation accepts only complete HTTP or HTTPS URLs without embedded credentials. Paths do not accept query strings or encoded segments. The server manages at most 12 spaces at once, granted personal spaces included, and a space under agent rules holds at most 20 tabs; within that, each space's page budget limits the pages the agent manages. Requests for one space run one at a time in arrival order, and different spaces run at the same time, up to six at once. A space can have 16 requests pending and the server 32; more return `429 busy`. Requests that only list spaces or tabs count only toward the server's 32. Waits for control and requests for a space wait outside these queues, at most 8 and 3 at once. A wait lets other requests in its space run between checks. Waiting beyond 3 seconds comes out of a request's own timeout, and a request that cannot start in time returns `504 action_timeout` with `awaited: "queue"` without touching the page. Page operations wait up to 15 seconds for loading and another 15 seconds for a response. A timeout does not guarantee a page action was cancelled; inspect the page before retrying a consequential action.

## Errors

Every error is `{ "error": { "code", "message", ...fields } }`, and a failed batch keeps `{ ok: false, results, failedIndex, error }`. Codes are stable, and each answers with one HTTP status, except that `POST /tabs/:id/wait` and a batch's wait step answer `wait_timeout` with 408, as before. Messages are stripped of control characters and cut to 300 characters; treat them, like page text, as untrusted data.

- `retryable: true` appears only when the error's condition can clear by itself and nothing reached the page, so the same request can be sent again. The table below says which codes can be retryable.
- `dispatched: true` appears once the request sent anything that can change the page, such as input, a navigation, a fill, an upload or a scroll. Inspect the page before retrying a request whose error carries it.
- Timeouts carry `timeoutMs` and `awaited`, what ran out: `queue` when the request could not start in time, `page` or `load` when the page did not answer or load, `condition` for a wait, `control` for wait-for-control and `approval` for a request for a space.

An unknown body or batch field answers `400 unknown_field` with the `field`, the `allowed` fields, the `route`, the step's `index` and `action` in a batch, and a `suggestion` for a near miss, as in `POST /tabs/:id/wait has no field "timeout". Allowed: selector, text, timeoutMs. Did you mean "timeoutMs"?` The client makes the same checks before sending: an undeclared or invalid option throws `invalid_option`, and a missing, extra or wrong argument throws `invalid_argument`, each naming the call in `entry` and the shape it expects.

Some answers changed in this version. `stale_ref` and `element_obscured` answer 409 instead of 422, and `invalid_target`, whether the request or the page refused the target, and `invalid_files` answer 400 instead of 422. A request authorized again after agent access was turned off answers `503 automation_stopped` instead of 404. An unknown route answers `404 route_not_found`, naming the `method`, the `route` with its ID replaced by `:id`, the `apiLevel` and the app's `version`, as in `Kamapathy <version> (API level <n>) has no route POST /tabs/:id/hover. A newer client may need a newer Kamapathy.` Page routes answer `409 tab_unmanaged` for pages the agent did not open or adopt, and `busy` can carry `retryAfterMs`.

Every code, its status, whether it can be retried, and its fields:

<!-- generated:errors -->
| Code | Status | Retryable | Fields | Meaning |
| --- | --- | --- | --- | --- |
| `invalid_path` | 400 | not retryable |  | The path has a query string, an encoded segment or characters no route uses. |
| `invalid_json` | 400 | not retryable |  | The request body is not valid JSON. |
| `invalid_body` | 400 | not retryable |  | The request body is not a JSON object. |
| `invalid_field` | 400 | not retryable | `field`, `expected`, `index` | A field has the wrong kind or is out of range. |
| `invalid_target` | 400 | not retryable |  | The action needs exactly one of ref or selector, or cannot use the target it got. |
| `invalid_ref` | 400 | not retryable |  | The ref is not one a snapshot gives, such as @e1. |
| `invalid_key` | 400 | not retryable | `suggestion`, `forms` | The key is not a name, character or chord Kamapathy accepts. |
| `invalid_selector` | 400 | not retryable | `selector`, `reason`, `forms`, `hint`, `index` | The selector does not parse, or the page rejects its CSS or XPath. |
| `invalid_cursor` | 400 | not retryable |  | The cursor is malformed or was made for another scope. |
| `invalid_action` | 400 | not retryable | `allowed`, `index` | A batch step is not an object with a supported type. |
| `invalid_actions` | 400 | not retryable |  | A batch needs 1 to 20 actions. |
| `invalid_url` | 400 | not retryable |  | The URL is not a complete HTTP or HTTPS URL without credentials. |
| `invalid_files` | 400 | not retryable |  | The upload has no files, too many, or a malformed one. |
| `unknown_field` | 400 | not retryable | `field`, `allowed`, `route`, `index`, `action`, `suggestion`, `apiLevel` | A body or batch step has a field its route does not define. |
| `local_clients_only` | 403 | not retryable |  | Only local programs may use the API, never web pages. |
| `cdp_method_blocked` | 403 | not retryable | `method`, `reason` | The protocol command reaches beyond this tab's own page and frames. |
| `agent_scripts_off` | 403 | not retryable |  | Page scripts are off in Kamapathy's Settings. |
| `request_declined` | 403 | not retryable |  | The person did not let an agent use a space. |
| `clipboard_blocked` | 403 | not retryable |  | A copy, cut or paste chord, or a Linux middle press on an editable, is refused. |
| `input_target_blocked` | 403 | not retryable |  | The point, or the frame holding focus, belongs to an extension or an internal page. |
| `native_popup_blocked` | 403 | not retryable | `use` | The input would open a native select, color or date picker. |
| `route_not_found` | 404 | not retryable | `method`, `route`, `apiLevel`, `version` | This Kamapathy has no such route. |
| `space_not_found` | 404 | not retryable |  | No accessible agent space has this ID. |
| `tab_not_found` | 404 | not retryable | `tabId` | No tab in an accessible agent space has this ID. |
| `unknown_ref` | 404 | not retryable | `ref` | The ref was never issued for this page. |
| `expectation_not_found` | 404 | not retryable |  | No live wait has this ID: it was answered, cancelled, or its time ran out. |
| `download_not_found` | 404 | not retryable |  | No held download has this ID: it was deleted, its space closed, or an hour passed since it finished. |
| `body_timeout` | 408 | retryable |  | The request body did not arrive in time. |
| `human_control` | 409 | not retryable | `spaceId`, `reason`, `prompt`, `since` | The person controls this space. |
| `tab_unmanaged` | 409 | not retryable | `tabId`, `label`, `openedBy` | The page is not the agent's yet. Adopt it before any other page route. |
| `release_refused` | 409 | not retryable | `tabId`, `label` | The agent opened this page, so it closes the page instead of releasing it. |
| `page_budget` | 409 | not retryable | `limit`, `used`, `pages` | The space already holds as many pages as its budget allows. Close or reuse a page. |
| `space_protected` | 409 | not retryable | `tabs` | The space holds tabs the person opened, so the agent cannot close it. |
| `sign_ins_mismatch` | 409 | not retryable | `spaceId`, `signIns` | The space a reuse found uses other sign-ins than the request asked for. |
| `space_ended` | 409 | not retryable | `spaceId`, `endedBy`, `reason` | The agent finished this space or the person stopped it. Only the person can let an agent use it again. |
| `expectation_pending` | 409 | not retryable | `event`, `expectationId` | The page already waits for that event. |
| `download_limit` | 409 | not retryable | `limit` | The space already holds its most downloads. Delete one before arming another. |
| `download_not_finished` | 409 | not retryable | `state`, `receivedBytes`, `totalBytes` | The download is still running, so it has no bytes to read yet. |
| `download_failed` | 409 | not retryable | `failure` | The download was cancelled or broke off, so it has no bytes to read. |
| `tab_limit` | 409 | not retryable |  | The space already has its most tabs. |
| `space_limit` | 409 | not retryable |  | The API already manages its most spaces. |
| `screenshot_unavailable` | 409 | not retryable |  | Retired from API level 3: screenshots work with the window hidden or minimized. |
| `empty_screenshot` | 409 | retryable |  | The page has not rendered yet. |
| `no_web_page` | 409 | not retryable |  | The tab is not showing a web page. |
| `debugger_busy` | 409 | retryable when reason is unavailable | `reason` | Kamapathy has no debugger connection to the tab: developer tools hold it, or the connection was lost. |
| `page_changed` | 409 | not retryable |  | The page navigated during the operation. |
| `navigation_interrupted` | 409 | not retryable | `url`, `by` | A newer main-frame navigation replaced the one this request started. |
| `navigation_blocked` | 409 | not retryable | `url`, `reason` | The page's leave guard kept it open. |
| `reload_would_resubmit` | 409 | not retryable | `url` | Reloading would send the page's form again. |
| `url_opened_in_popup` | 409 | not retryable | `lastUrl`, `popup` | The URL opened in a popup this page opened. |
| `not_pdf` | 409 | not retryable | `contentType` | The tab is not showing a PDF. |
| `pdf_not_refetchable` | 409 | not retryable | `reason` | The PDF came from a form submission, or from a scheme Kamapathy cannot read again. |
| `dialog_open` | 409 | not retryable | `dialog`, `started` | A JavaScript dialog is open on the page. |
| `page_crashed` | 409 | not retryable |  | The page process stopped. |
| `tab_closed` | 409 | not retryable |  | The tab was closed. |
| `cross_origin_frame` | 409 | not retryable |  | The control is inside a frame from another origin. |
| `drag_unavailable` | 409 | not retryable |  | Chromium could not take over the drag. |
| `drag_not_delivered` | 409 | not retryable |  | The page started a drag Kamapathy never received. |
| `input_not_delivered` | 409 | retryable |  | The page never received the input. |
| `stale_ref` | 409 | not retryable | `ref` | The ref belongs to an earlier snapshot, a control the page removed, or refs the page retired. |
| `element_obscured` | 409 | retryable | `presses` | Another element covers the target, after input the action already sent. |
| `body_too_large` | 413 | not retryable |  | The request body is larger than the route accepts. |
| `files_too_large` | 413 | not retryable |  | The upload files total more than 16 MiB. |
| `content_type` | 415 | not retryable |  | The request body is not JSON. |
| `element_action_failed` | 422 | not retryable |  | The page refused the action. |
| `navigation_failed` | 422 | retryable when netError is ERR_INTERNET_DISCONNECTED or ERR_NETWORK_CHANGED or ERR_NETWORK_IO_SUSPENDED or ERR_NAME_RESOLUTION_FAILED or ERR_CONNECTION_REFUSED or ERR_CONNECTION_TIMED_OUT | `url`, `netError`, `errorCode`, `httpStatus`, `blockedUrl` | The navigation ended without loading a document. |
| `navigation_download` | 422 | not retryable | `url`, `armed` | The address is a download, not a page. |
| `script_error` | 422 | not retryable | `name`, `line`, `column`, `description` | The page function threw or did not parse. |
| `no_match` | 422 | retryable | `selector`, `waitedMs` | Nothing matched the selector by the deadline. |
| `ambiguous_match` | 422 | not retryable | `selector`, `count`, `visible`, `hidden`, `actionable`, `candidates` | The selector matched more than one element the action can take. |
| `drag_out_of_view` | 422 | not retryable |  | A drag endpoint is outside the viewport. |
| `invalid_file_type` | 422 | not retryable |  | The file input does not accept a selected file's type. |
| `invalid_upload_target` | 422 | not retryable |  | The ref is not a file input that can take these files. |
| `invalid_value` | 422 | not retryable |  | The control cannot take this value. |
| `not_editable` | 422 | not retryable | `reason` | Nothing at, around or inside the target can take typing or a value. |
| `not_selectable` | 422 | not retryable |  | No select at, for or inside the target. |
| `not_focusable` | 422 | not retryable |  | Nothing focusable at, around or inside the target. |
| `ambiguous_field` | 422 | not retryable | `candidates` | Retargeting found several candidates. |
| `fill_not_accepted` | 422 | not retryable | `match` | The field kept its old value after one retry. |
| `point_outside_viewport` | 422 | not retryable | `width`, `height` | The point lies outside the page's viewport. |
| `clip_outside_page` | 422 | not retryable | `clip` | The clip misses the viewport, or the document with fullPage. |
| `screenshot_too_large` | 422 | not retryable | `width`, `height`, `maxSide`, `maxPixels` | The image would be larger than 16,384 pixels on a side or 33,554,432 pixels in all. |
| `pdf_too_large` | 422 | not retryable | `limitBytes` | The PDF is over the byte cap. |
| `pdf_locked` | 422 | not retryable |  | The PDF needs a password. |
| `pdf_unreadable` | 422 | not retryable |  | The bytes are not a PDF Kamapathy can read, or reading them failed. |
| `pdf_fetch_failed` | 422 | retryable when httpStatus is absent | `httpStatus` | Reading the PDF again failed. |
| `page_out_of_range` | 422 | not retryable | `pageCount` | The first page asked for is past the last page. |
| `busy` | 429 | retryable | `scope`, `retryAfterMs` | Too many requests are waiting. |
| `upload_busy` | 429 | retryable |  | Another file transfer is in progress. |
| `operation_failed` | 500 | not retryable |  | The browser could not complete the operation. |
| `tab_creation_failed` | 500 | not retryable |  | Kamapathy could not create the tab. |
| `automation_stopped` | 503 | not retryable |  | Agent access is turned off. |
| `screenshot_failed` | 503 | retryable |  | The page could not render a screenshot. |
| `page_timeout` | 504 | retryable | `awaited`, `timeoutMs` | The page did not respond or load in time. |
| `action_timeout` | 504 | retryable | `awaited`, `timeoutMs`, `blocker`, `detail`, `interceptor` | The request did not start in time, or its target never became ready for input. |
| `pdf_timeout` | 504 | not retryable | `awaited`, `timeoutMs` | Reading the PDF did not finish before the timeout. |
| `control_timeout` | 504 | retryable | `awaited`, `timeoutMs`, `reason` | Control did not return to the agent before the timeout. |
| `request_timeout` | 504 | not retryable | `awaited`, `timeoutMs` | The person did not answer a request for a space in time. Asking again interrupts them. |
| `navigation_timeout` | 504 | retryable | `awaited`, `timeoutMs`, `committed`, `url`, `readyState` | The navigation did not reach the requested state before the timeout. |
| `expectation_timeout` | 504 | not retryable | `awaited`, `event`, `timeoutMs` | No popup, download, file chooser or dialog arrived before the arm ran out. |
| `download_timeout` | 504 | retryable | `awaited`, `downloadId`, `receivedBytes`, `totalBytes`, `timeoutMs` | The download is still running. Asking again keeps waiting for it. |
| `wait_timeout` | 504 | retryable | `awaited`, `timeoutMs`, `expected`, `lastUrl`, `state`, `url`, `readyState`, `inflight`, `pending`, `title`, `popups` | The condition was not met before the timeout. |
| `update_unsupported` | 409 | not retryable | `reason`, `platform`, `arch` | No installer is published for this copy of Kamapathy. |
| `update_check_failed` | 502 | retryable when reason is offline or network or timeout or rate_limited, or httpStatus is in range | `reason`, `httpStatus`, `retryAfterMs` | GitHub Releases gave no usable answer to the update check. |
| `update_download_failed` | in GET /update | retryable when reason is network or stalled, or httpStatus is in range | `reason`, `httpStatus` | The installer download stopped. |
| `update_verify_failed` | in GET /update | not retryable | `reason`, `file` | The downloaded installer did not match its checksum, so it was deleted. |
| `not_connected` | client | retryable when reason is busy | `reason` | Kamapathy is unreachable, missing or must not be started, or the connection was lost. |
| `timeout` | client | not retryable |  | The request timed out. An action may already have reached the page. |
| `request_too_large` | client | not retryable |  | The encoded request is larger than its route accepts. |
| `invalid_response` | client | not retryable |  | Kamapathy's answer was not what the route returns. |
| `request_failed` | client | not retryable |  | The request failed without an error code. |
| `run_timeout` | client | not retryable | `timeoutMs` | The run passed its deadline. A call in progress may still have taken effect. |
| `interrupted` | client | not retryable | `signal` | A signal or Ctrl+C stopped the run. A call in progress may still have taken effect. |
| `page_not_found` | client | not retryable | `label`, `closedBy` | No open page in the space has the label; a retired label says who closed it. |
| `invalid_option` | client | not retryable | `entry`, `option`, `expected`, `suggestion` | Options are not a plain object, or have an undeclared key or a bad value. |
| `invalid_argument` | client | not retryable | `entry`, `expected` | Arguments are missing, extra or of the wrong kind. |
| `app_outdated` | client | not retryable | `entry`, `option`, `required`, `available`, `appVersion` | The running Kamapathy predates this call. |
<!-- /generated:errors -->

## Versions and API levels

`GET /health` answers `{ "status": "ok", version, apiLevel, versions, skill?, update? }` outside every queue, where `versions` holds the Electron, Chromium, Node and V8 versions Kamapathy runs on, `skill` is `{ path }` for the skill folder the app ships, and `update` is `{ version, state }` while a newer version waits. The API level is an integer that rises when a release adds or changes a call, option, field, action or error code. This version is level 4, and a Kamapathy that answers without `apiLevel` is level 1. `help` and the [API reference](../skills/kamapathy/references/api.md) give the level each call and command needs.

The client compares levels after its health check. A call, option or command the running Kamapathy predates fails before anything is sent, with `app_outdated` and the message `<call> needs Kamapathy API level <n>, and Kamapathy <version> has level <m>. Ask the person to update Kamapathy, then read the skill again.` A Kamapathy newer than the client still runs every call, and the client prints the skill notice `notice: Update this skill copy, then read its SKILL.md again.` once. `node scripts/kamapathy.mjs --version` prints the client's version and API level with its Node.js and skill folder, then Kamapathy's version, API level and engine versions, and a line about any level mismatch. It never starts Kamapathy, and `--json` prints the same as JSON.

## Isolation and limitations

- The server listens only on a Unix socket in a private directory, or a Windows named pipe, never on a network port. Browsers cannot open either, and it also rejects Origin and Sec-Fetch-Site headers. There is no CORS access.
- There is no token. Any program running under your account can use the API while agent access is on; other accounts cannot open the socket. This is the same boundary as other local developer tools, and it is not a defense against an already compromised account. Turn agent access off in Settings to refuse all agents.
- Spaces created through the current API server are accessible until the agent finishes them or the person stops it. An agent space created in the interface starts under human control; choose **Let agent continue** to grant the running API access to it. A personal space is reachable only once the person grants it, with **Let an agent use this space** or by allowing a request, and then follows agent rules until the grant ends. Restarting the API does not reclaim older spaces unless you explicitly grant access again.
- Agent spaces share the person's sign-ins by default, so a site they are signed in to works for the agent too. A space created with `isolated: true`, or every agent space while **Isolate agent spaces** is on in Settings, gets a temporary session of its own instead; sign in inside that space when a site needs it. Agent spaces never see tabs in other spaces and deny downloads and permission prompts. They are excluded from the persisted session, history, and activity state, unless the person keeps one as a personal space after its agent finished or was stopped.
- Kamapathy keeps one internal debugger session on each page an agent manages while the agent controls its space, and releases it when you take over or stop the agent, when the agent releases the page or finishes, when the space closes and when agent access is turned off. Other tabs, including the person's tabs in a granted space until the agent adopts them, never get one. Through it Kamapathy follows frames, loads, network activity and dialogs, sends fixed trusted input (Chromium's Input commands), and runs its fixed page functions in an isolated world it creates in each web frame. There is no arbitrary JavaScript, CDP, Node.js, shell, filesystem, or browser-wide debugging endpoint. Developer tools can stay open on an agent tab while the agent works; pausing the page there stalls agent requests until they time out.
- Pages see a Chromium 152 browser without Electron or Kamapathy tokens. Files on this computer open only in personal spaces and are never listed to agents; a tab showing one answers `404 tab_not_found`.
- Snapshots are bounded summaries built from the DOM; role selectors and locators read Chromium's accessibility tree through Kamapathy's internal session on the agent tab. They read through open shadow roots and same-origin frames, list a frame from another origin without reading it, and do not enter closed shadow roots, PDF documents, or canvas interfaces. PDFs show in Chromium's viewer, whose frames agents never enter; pdf/text reads them. If a JavaScript dialog is open on an agent tab, requests for that tab fail at once with `409 dialog_open`, which names it; hand off to the person to close it. A page whose process stopped returns `409 page_crashed` until it loads again. Site compatibility varies.
- Scripts run in the agent's own Node.js, never inside Kamapathy. The client borrows Playwright's method names but is not Playwright, and Kamapathy ships no MCP server, scheduling, model inference or built-in agent runtime. It does not implement Chrome DevTools Protocol compatibility either. Use the documented HTTP routes, the CLI or the client from your own automation program.
- Agent spaces, and personal spaces while an agent may use them, deny browser permission requests and downloads, including while under human control.
- Agents can check for and download updates; only the person installs them.
- Closing the window keeps Kamapathy running while agent access is on: always on macOS, where applications run without a window, and on Windows and Linux while an agent space, or a space the person granted, is open. The window hides, the person's own pages close as a close closes them, agent pages, their sessions and the socket stay, and a tray icon appears on Windows and Linux. The window comes back from the tray, the Dock, a second launch or a notification. Snapshots, page actions and screenshots all keep working meanwhile. Agents continue only while agent access is on, which remains the hard stop.
- Quitting Kamapathy while a space is the agent's own or needs the person asks first, naming up to three spaces. A confirmed quit stops every agent and writes a private marker, holding only the time, in the profile's agent folder: for ten minutes the client refuses to start Kamapathy, failing with `not_connected` and reason `quit_by_person`, so ask the person before starting it again. Every start removes the marker, and a shutdown or logout never asks.
- Activity records describe operations without recording filled values. Page content is untrusted data and should not be treated as instructions by an external agent.
- File selection is limited to the documented upload route. It transfers supplied bytes into a file input, can trigger an immediate site upload, and returns a selected-file count. Activity records do not include file contents or local paths. File selection does not bypass a site's validation or establish that an upload succeeded.

Use `node scripts/kamapathy.mjs help` to see every CLI command and `help <command>` for one command's usage, flags, route and script equivalent. `node scripts/kamapathy.mjs --version` shows the client's, the skill's and Kamapathy's versions, and the skill's [API reference](../skills/kamapathy/references/api.md) lists every script entry, CLI command, route and error code.
