# Kamapathy API reference

Client 0.2.0, API level 4. Generated from the schema by `npm run docs:api`; edit the schema, not this file.

## Globals

### `kamapathy`

The connected client: a Client with createSpace, openSpace, space, spaces and requestSpace.

Returns `Client`. Since API level 1.

### `createSpace(name, options?)`

Creates a background agent space.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `isolated` | true or false |  | Give the space a session of its own instead of the person's sign-ins. |
| `pageBudget` | integer from 1 to 20 |  | How many pages the agent may manage in the space at once, 20 by default or KAMAPATHY_PAGE_BUDGET. |

Returns `Promise<Space>`. Route `POST /spaces`. Errors: `invalid_field`, `space_limit`, `automation_stopped`. Since API level 1.

### `space(id)`

Finds an accessible agent space by ID.

Returns `Promise<Space>`. Route `GET /spaces`. Errors: `space_not_found`, `automation_stopped`. Since API level 1.

### `spaces()`

Lists the agent spaces this API session can reach.

Returns `Promise<Space[]>`. Route `GET /spaces`. Errors: `automation_stopped`. Since API level 1.

### `openSpace(nameOrId, options?)`

Returns the listed space with this ID, or else the first with this name, and creates one when none matches.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `isolated` | true or false |  | Give the space a session of its own instead of the person's sign-ins. |
| `pageBudget` | integer from 1 to 20 |  | How many pages the agent may manage in the space at once, 20 by default or KAMAPATHY_PAGE_BUDGET. |

Returns `Promise<Space>`. Route `POST /spaces`. Errors: `invalid_field`, `space_limit`, `automation_stopped`, `sign_ins_mismatch`. Since API level 2.

### `requestSpace(options)`

Asks the person to let an agent use one of their spaces and waits for their answer.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `reason` | string of at most 120 characters, required |  | Why the agent needs a space, shown to the person. |
| `name` | string of at most 48 characters |  | The name of the space to suggest. |
| `timeout` | milliseconds from 5000 to 600000 |  | How long to wait for the answer, 600000 by default. |

Returns `Promise<Space>`. Route `POST /space-requests`. Errors: `request_declined`, `request_timeout`, `busy`, `invalid_field`, `automation_stopped`. Since API level 2.

### `help(...names)`

Prints the API, or one entry such as help("page.click"), or the topics errors and routes.

Returns `void`. Since API level 2.

## Client

### `kamapathy.app`

The running Kamapathy's version and API level, or null until the client has found it.

Returns `{ version?: string, apiLevel: number, electron?: string, chromium?: string, node?: string, update?: { version: string, state: "available" | "downloading" | "ready" } } | null`. Since API level 1.

### `kamapathy.createSpace(name, options?)`

Creates a background agent space.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `isolated` | true or false |  | Give the space a session of its own instead of the person's sign-ins. |
| `pageBudget` | integer from 1 to 20 |  | How many pages the agent may manage in the space at once, 20 by default or KAMAPATHY_PAGE_BUDGET. |

Returns `Promise<Space>`. Route `POST /spaces`. Errors: `invalid_field`, `space_limit`, `automation_stopped`. Since API level 1.

### `kamapathy.space(id)`

Finds an accessible agent space by ID.

Returns `Promise<Space>`. Route `GET /spaces`. Errors: `space_not_found`, `automation_stopped`. Since API level 1.

### `kamapathy.spaces()`

Lists the agent spaces this API session can reach.

Returns `Promise<Space[]>`. Route `GET /spaces`. Errors: `automation_stopped`. Since API level 1.

### `kamapathy.openSpace(nameOrId, options?)`

Returns the listed space with this ID, or else the first with this name, and creates one when none matches.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `isolated` | true or false |  | Give the space a session of its own instead of the person's sign-ins. |
| `pageBudget` | integer from 1 to 20 |  | How many pages the agent may manage in the space at once, 20 by default or KAMAPATHY_PAGE_BUDGET. |

Returns `Promise<Space>`. Route `POST /spaces`. Errors: `invalid_field`, `space_limit`, `automation_stopped`, `sign_ins_mismatch`. Since API level 2.

### `kamapathy.requestSpace(options)`

Asks the person to let an agent use one of their spaces and waits for their answer.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `reason` | string of at most 120 characters, required |  | Why the agent needs a space, shown to the person. |
| `name` | string of at most 48 characters |  | The name of the space to suggest. |
| `timeout` | milliseconds from 5000 to 600000 |  | How long to wait for the answer, 600000 by default. |

Returns `Promise<Space>`. Route `POST /space-requests`. Errors: `request_declined`, `request_timeout`, `busy`, `invalid_field`, `automation_stopped`. Since API level 2.

### `kamapathy.updateStatus()`

Reads Kamapathy's update status.

Returns `Promise<UpdateStatus>`. Route `GET /update`. Errors: `update_unsupported`, `automation_stopped`. Since API level 3.

### `kamapathy.checkForUpdates()`

Checks GitHub Releases for a newer Kamapathy.

Returns `Promise<UpdateStatus>`. Route `POST /update/check`. Errors: `update_unsupported`, `update_check_failed`. Since API level 3.

### `kamapathy.downloadUpdate(options?)`

Downloads this computer's installer and waits for it; only the person installs it.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `timeout` | milliseconds from 0 to 1800000 | `600000` | How long to wait for the download, 600000 by default; 0 returns once it starts. |
| `interval` | milliseconds from 250 to 10000 | `1000` | How often the status is read, 1000 by default. |

Returns `Promise<UpdateStatus>`. Route `POST /update/download`. Errors: `update_unsupported`, `update_check_failed`, `update_download_failed`, `update_verify_failed`, `timeout`. Since API level 3.

## Space

### `space.id`

The space's ID.

Returns `string`. Since API level 1.

### `space.name`

The space's name.

Returns `string`. Since API level 1.

### `space.owner`

Who controls the space. handoff and resume update it.

Returns `"agent" | "human"`. Since API level 1.

### `space.signIns`

Whether the space uses the person's sign-ins or its own.

Returns `"shared" | "separate" | undefined`. Since API level 1.

### `space.kind`

An agent space, or one of the person's spaces they let an agent use.

Returns `"agent" | "personal" | undefined`. Since API level 1.

### `space.createdBy`

Who made the space.

Returns `"agent" | "person" | undefined`. Since API level 1.

### `space.pageBudget`

How many pages the agent may manage in the space at once.

Returns `number | undefined`. Since API level 1.

### `space.reason`

Why the person has control, while they have it.

Returns `string | undefined`. Since API level 1.

### `space.prompt`

What the person is asked to answer, while a site or Kamapathy waits for them.

Returns `string | undefined`. Since API level 1.

### `space.since`

When the person got control, in milliseconds since 1970.

Returns `number | undefined`. Since API level 1.

### `space.status`

The status the person is reading, set through setStatus or read from a listing.

Returns `string | undefined`. Since API level 3.

### `space.state`

How the space stands: it needs the person, the task is done or failed, or a page stopped working.

Returns `"needs-you" | "done" | "failed" | "error" | undefined`. Since API level 3.

### `space.open(url)`

Opens a background tab.

Returns `Promise<Page>`. Route `POST /spaces/:id/tabs`. Errors: `invalid_url`, `tab_limit`, `tab_creation_failed`, `human_control`, `space_not_found`, `automation_stopped`. Since API level 1.

### `space.tabs()`

Lists the space's tabs.

Returns `Promise<Page[]>`. Route `GET /spaces/:id/tabs`. Errors: `human_control`, `space_not_found`, `automation_stopped`. Since API level 1.

### `space.page(label)`

The page with this label, such as p2. It finds its tab on first use and keeps it.

Returns `Page`. Errors: `page_not_found`. Since API level 2.

### `space.pages()`

Lists the pages the agent manages, in tab order.

Returns `Promise<Page[]>`. Route `GET /spaces/:id/tabs`. Errors: `human_control`, `space_not_found`, `automation_stopped`. Since API level 2.

### `space.newPage()`

Opens a blank background page for goto.

Returns `Promise<Page>`. Route `POST /spaces/:id/tabs`. Errors: `page_budget`, `tab_limit`, `tab_creation_failed`, `human_control`, `space_not_found`, `automation_stopped`. Since API level 2.

### `space.adopt(page)`

Makes a page the agent did not open its own, within the page budget.

Returns `Promise<Page>`. Route `POST /tabs/:id/adopt`. Errors: `page_budget`, `page_not_found`, `tab_not_found`, `human_control`, `space_not_found`, `automation_stopped`. Since API level 2.

### `space.release(page)`

Gives a page the agent did not open back to the person. The page stays open.

Returns `Promise<Page>`. Route `POST /tabs/:id/release`. Errors: `release_refused`, `page_not_found`, `tab_not_found`, `human_control`, `space_not_found`, `automation_stopped`. Since API level 2.

### `space.finish(options)`

Ends the agent's task: closes the pages it does not keep and ends its access. The person's tabs stay.

Returns `Promise<{ ok: true, spaceId: string, closedSpace: boolean, closed: string[], kept: string[], protected: string[] }>`. Route `POST /spaces/:id/finish`. Errors: `tab_not_found`, `page_not_found`, `invalid_field`, `human_control`, `space_not_found`, `automation_stopped`. Since API level 2.

### `space.waitForControl(options?)`

Waits until the agent has control, at once if it has, and reports what changed meanwhile.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `timeout` | milliseconds of at most 600000 |  | How long to wait, 600000 by default. |

Returns `Promise<{ ok: true, owner: "agent", active?: Page | null, opened?: Page[], closed?: string[] }>`. Route `POST /spaces/:id/wait-for-control`. Errors: `control_timeout`, `busy`, `space_not_found`, `automation_stopped`. Since API level 2.

### `space.userPage()`

The page the space showed when control last came back to this Space object, or null.

Returns `Page | null`. Since API level 2.

### `space.setStatus(text)`

Shows the person what the agent is doing. null or an empty text clears it.

Returns `Promise<{ ok: true, status?: string }>`. Route `POST /spaces/:id/status`. Errors: `invalid_field`, `human_control`, `space_not_found`, `automation_stopped`. Since API level 3.

### `space.fail(message)`

Reports that the task cannot be done and hands the space to the person.

Returns `Promise<{ ok: true, owner: "human", state: "failed", status: string }>`. Route `POST /spaces/:id/fail`. Errors: `invalid_field`, `human_control`, `space_not_found`, `automation_stopped`. Since API level 3.

### `space.handoff()`

Pauses automation so the person can continue, for example to sign in.

Returns `Promise<{ ok: true, owner: "human" }>`. Route `POST /spaces/:id/handoff`. Errors: `human_control`, `space_not_found`, `automation_stopped`. Since API level 1.

### `space.resume()`

Takes control back once the reason for the handoff is finished, and reports what changed meanwhile.

Returns `Promise<{ ok: true, owner: "agent", active?: Page | null, opened?: Page[], closed?: string[] }>`. Route `POST /spaces/:id/resume`. Errors: `space_not_found`, `automation_stopped`. Since API level 1.

### `space.close()`

Closes the space and its tabs.

Returns `Promise<{ ok: true }>`. Route `DELETE /spaces/:id`. Errors: `human_control`, `space_not_found`, `automation_stopped`. Since API level 1.

## Page

### `page.id`

The tab's ID.

Returns `string`. Since API level 1.

### `page.spaceId`

The ID of the space holding the tab.

Returns `string | undefined`. Since API level 1.

### `page.url`

The last known URL. navigate and snapshot refresh it.

Returns `string`. Since API level 1.

### `page.title`

The last known title. navigate and snapshot refresh it.

Returns `string`. Since API level 1.

### `page.label`

The page's label in its space, such as p2. Labels are never reused.

Returns `string | undefined`. Since API level 1.

### `page.openedBy`

Who opened the page: the agent, a page (a popup) or the person.

Returns `"agent" | "page" | "person" | undefined`. Since API level 1.

### `page.openerId`

The ID of the page that opened this popup.

Returns `string | undefined`. Since API level 1.

### `page.managed`

Whether the agent may use the page. Adopt a page to manage it.

Returns `boolean | undefined`. Since API level 1.

### `page.navigate(url)`

Loads a complete http or https URL. Refs from before become stale.

Returns `Promise<Page>`. Route `POST /tabs/:id/navigate`. Errors: `invalid_url`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.snapshot(options?)`

Reads bounded visible text and controls with refs.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `mode` | one of compact, full | `"compact"` | compact keeps the page short; full reads more. |
| `maxChars` | integer from 0 to 24000 |  | Most text characters to return. Defaults to 4000 compact, 24000 full. |
| `maxControls` | integer from 0 to 100 |  | Most controls to return. Defaults to 40 compact, 100 full. |
| `selector` | target |  | Read only the element this selector matches, of any form. |
| `scope` | one of page, viewport | `"page"` | page reads everything; viewport keeps only what is on screen. |
| `root` | string of at most 32 characters |  | Read only this ref's subtree, or a frame ref's document. Not with selector. |
| `header` | true or false | `true` | Name the page, its space and the space's tabs. |
| `cursor` | string of at most 512 characters |  | The next value of an earlier part, for the part after it. Keep scope, root, selector and format. |
| `format` | one of list, outline | `"list"` | list reads text and controls; outline prints the page's structure instead of its text. |
| `locators` | true or false | `false` | Give each control a locator: a selector that names it alone, which outlives refs. |

Returns `Promise<Snapshot>`. Route `POST /tabs/:id/snapshot`. Errors: `invalid_field`, `invalid_ref`, `invalid_selector`, `invalid_cursor`, `unknown_ref`, `stale_ref`, `cross_origin_frame`, `no_match`, `ambiguous_match`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.text(options?)`

The same compact text the CLI's snapshot command prints.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `mode` | one of compact, full | `"compact"` | compact keeps the page short; full reads more. |
| `maxChars` | integer from 0 to 24000 |  | Most text characters to return. Defaults to 4000 compact, 24000 full. |
| `maxControls` | integer from 0 to 100 |  | Most controls to return. Defaults to 40 compact, 100 full. |
| `selector` | target |  | Read only the element this selector matches, of any form. |
| `scope` | one of page, viewport | `"page"` | page reads everything; viewport keeps only what is on screen. |
| `root` | string of at most 32 characters |  | Read only this ref's subtree, or a frame ref's document. Not with selector. |
| `header` | true or false | `true` | Name the page, its space and the space's tabs. |
| `cursor` | string of at most 512 characters |  | The next value of an earlier part, for the part after it. Keep scope, root, selector and format. |
| `format` | one of list, outline | `"list"` | list reads text and controls; outline prints the page's structure instead of its text. |
| `locators` | true or false | `false` | Give each control a locator: a selector that names it alone, which outlives refs. |

Returns `Promise<string>`. Route `POST /tabs/:id/snapshot`. Errors: `invalid_field`, `invalid_ref`, `invalid_selector`, `invalid_cursor`, `unknown_ref`, `stale_ref`, `cross_origin_frame`, `no_match`, `ambiguous_match`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.click(target, options?)`

Clicks a control.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `label` | string of at most 60 characters |  | A few words naming this step, shown by the cursor and in the agent bar. |

Returns `Promise<{ ok: true, url, fallback?, rebound? }>`. Route `POST /tabs/:id/click`. Errors: `invalid_target`, `invalid_ref`, `invalid_selector`, `unknown_ref`, `stale_ref`, `cross_origin_frame`, `no_match`, `ambiguous_match`, `element_action_failed`, `element_obscured`, `input_not_delivered`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.fill(target, value, options?)`

Replaces the value of a field, select or editable region.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `label` | string of at most 60 characters |  | A few words naming this step, shown by the cursor and in the agent bar. |

Returns `Promise<{ ok: true, rebound? }>`. Route `POST /tabs/:id/fill`. Errors: `invalid_target`, `invalid_ref`, `invalid_selector`, `unknown_ref`, `stale_ref`, `cross_origin_frame`, `no_match`, `ambiguous_match`, `element_action_failed`, `invalid_value`, `invalid_field`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.press(key, target?, options?)`

Presses a supported key, focusing a control first when given.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `label` | string of at most 60 characters |  | A few words naming this step, shown by the cursor and in the agent bar. |

Returns `Promise<{ ok: true, rebound? }>`. Route `POST /tabs/:id/press`. Errors: `invalid_key`, `invalid_target`, `invalid_ref`, `invalid_selector`, `unknown_ref`, `stale_ref`, `cross_origin_frame`, `no_match`, `ambiguous_match`, `element_action_failed`, `element_obscured`, `input_not_delivered`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.scroll(direction, pixels?, target?, options?)`

Scrolls the page, the panel holding a control, or the panel in the middle when the page cannot scroll.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `label` | string of at most 60 characters |  | A few words naming this step, shown by the cursor and in the agent bar. |

Returns `Promise<{ ok: true, scrolled, selector?, x, y, moved }>`. Route `POST /tabs/:id/scroll`. Errors: `invalid_field`, `invalid_target`, `invalid_ref`, `invalid_selector`, `unknown_ref`, `stale_ref`, `cross_origin_frame`, `no_match`, `ambiguous_match`, `element_action_failed`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.drag(source, target, options?)`

Drags one element onto another with native mouse input or HTML drag and drop.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `label` | string of at most 60 characters |  | A few words naming this step, shown by the cursor and in the agent bar. |

Returns `Promise<{ ok: true, url, drag, rebound? }>`. Route `POST /tabs/:id/drag`. Errors: `invalid_target`, `invalid_ref`, `invalid_selector`, `unknown_ref`, `stale_ref`, `cross_origin_frame`, `no_match`, `ambiguous_match`, `element_action_failed`, `element_obscured`, `input_not_delivered`, `drag_out_of_view`, `drag_unavailable`, `drag_not_delivered`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.wait(options?)`

Waits for a visible element, text, or both.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `selector` | target |  | Wait until this selector matches a visible element. |
| `text` | string of at most 1000 characters |  | Wait until the page shows this text. |
| `timeoutMs` | milliseconds of at most 15000 | `5000` | How long to wait. |

Returns `Promise<{ ok: true }>`. Route `POST /tabs/:id/wait`. Errors: `wait_timeout`, `invalid_field`, `invalid_selector`, `unknown_ref`, `stale_ref`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.batch(actions)`

Runs 1 to 20 actions in order and stops at the first failure.

Returns `Promise<{ ok: true, results }>`. Route `POST /tabs/:id/actions`. Errors: `invalid_actions`, `invalid_action`, `invalid_field`, `invalid_target`, `invalid_ref`, `invalid_selector`, `unknown_ref`, `stale_ref`, `cross_origin_frame`, `no_match`, `ambiguous_match`, `element_action_failed`, `element_obscured`, `input_not_delivered`, `wait_timeout`, `request_too_large`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.upload(ref, files)`

Selects local files on a file input. The site may upload them at once.

Returns `Promise<{ ok: true, selected }>`. Route `POST /tabs/:id/upload`. Errors: `invalid_files`, `files_too_large`, `invalid_upload_target`, `invalid_file_type`, `upload_busy`, `unknown_ref`, `stale_ref`, `invalid_target`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.screenshot(options?)`

Captures the page as PNG: the viewport, the whole page or a clip, at CSS scale by default. With a path string it saves the file and returns its path.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `path` | string of at most 4096 characters |  | Also write the PNG to this new file, which must end in .png. |
| `fullPage` | true or false | `false` | Capture the whole scrollable document, not the viewport. |
| `clip` | object |  | The part to capture, in CSS pixels of the image's own space. |
| `scale` | one of css, device | `"css"` | css gives one image pixel per CSS pixel; device keeps device pixels. |
| `timeout` | milliseconds from 1 to 60000 | `15000` | Most time for the load wait and the capture together. |

Returns `Promise<Buffer | string>`. Route `POST /tabs/:id/screenshot`. Errors: `screenshot_failed`, `empty_screenshot`, `clip_outside_page`, `screenshot_too_large`, `invalid_field`, `invalid_response`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.pdfText(options?)`

Reads a PDF's text by page. Continue from nextPage.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `from` | integer from 1 to 100000 | `1` | The first page to read. |
| `to` | integer from 1 to 100000 |  | The last page, at most from + 499. Defaults to the last page or from + 499. |
| `maxChars` | integer from 0 to 1000000 | `20000` | Most characters to return; whole pages come in order. 0 returns only pageCount and title. |
| `timeout` | milliseconds of at most 60000 |  | How long the read may take, 15000 by default. |

Returns `Promise<PdfText>`. Route `POST /tabs/:id/pdf/text`. Errors: `not_pdf`, `pdf_not_refetchable`, `pdf_too_large`, `pdf_locked`, `pdf_unreadable`, `pdf_fetch_failed`, `page_out_of_range`, `pdf_timeout`, `busy`, `invalid_field`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 3.

### `page.opener()`

The open page that opened this popup, or null.

Returns `Promise<Page | null>`. Route `GET /spaces/:id/tabs`. Errors: `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 2.

### `page.close()`

Closes the tab.

Returns `Promise<{ ok: true }>`. Route `DELETE /tabs/:id`. Errors: `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

## CLI commands

### `health`

Check the connection

### `upgrade [--check] [--timeout <ms>]`

Check for a newer Kamapathy and download its installer for the person to install

### `spaces`

List accessible spaces

### `space create <name> [--isolated]`

Create a background agent space, with its own sign-ins when --isolated is given

### `space open <name-or-id> [--isolated] [--page-budget <n>]`

Reuse the listed space with this ID or name, or create it

### `space finish <space-id> --keep all|none|<tab-id>[,<tab-id>]`

Close the pages the agent does not keep and end its access

### `space request --reason <text> [--name <name>] [--timeout <ms>]`

Ask the person to let an agent use one of their spaces

### `wait-for-control <space-id> [--timeout <ms>]`

Wait until the agent has control again

### `space close <space-id>`

Close a space and its tabs

### `handoff <space-id>`

Pause automation for human control

### `resume <space-id>`

Take control back when the person says to continue

### `status <space-id> <text> | status <space-id> --clear`

Show the person what the agent is doing

### `fail <space-id> <message>`

Report that the task cannot be done and hand the space to the person

### `tabs <space-id>`

List tabs in an agent space

### `open <space-id> <url>`

Open a background tab

### `new-page <space-id>`

Open a blank background page

### `adopt <tab-id>`

Make a page the agent did not open its own

### `release <tab-id>`

Give a page back to the person, leaving it open

### `navigate <tab-id> <url>`

Navigate a tab

### `close <tab-id>`

Close a tab

### `snapshot <tab-id> [--full] [--selector <selector>] [--root <ref>] [--viewport] [--outline] [--locators] [--no-header] [--cursor <cursor>] [--max-chars n] [--max-controls n] [--json]`

Read bounded page text and control refs

### `click <tab-id> <ref-or-selector> [--label <text>]`

Click a control

### `fill <tab-id> <ref-or-selector> --stdin [--label <text>]`

Read the exact field value from stdin

### `upload <tab-id> <ref> <file> [files]`

Select up to 8 files, 16 MiB total

### `press <tab-id> <key> [ref-or-selector] [--label <text>]`

Press a supported key

### `drag <tab-id> <source> <target> [--label <text>]`

Drag one element onto another (refs or selectors)

### `scroll <tab-id> <direction> [pixels] [ref-or-selector] [--label <text>]`

Scroll up, down, left or right: the page, the panel holding a control, or the panel in the middle when the page cannot scroll

### `wait <tab-id> --stdin`

Read wait options as JSON from stdin

### `batch <tab-id>`

Read an actions array or {actions} JSON

### `screenshot <tab-id> <file.png> [--full-page] [--clip x,y,width,height] [--scale css|device]`

Save a PNG of the viewport, the whole page or a clip, without overwriting

### `pdf-text <tab-id> [--from <n>] [--to <n>] [--max-chars <n>] [--timeout <ms>]`

Read a PDF's text by page

### `run [--ts] [--timeout <ms>] [--env-file <path>]... <file.mjs>`

Run a script with the client as the globals kamapathy, createSpace, openSpace, space, spaces and requestSpace; run - reads it from stdin and run -e <code> runs the code itself

### `repl [--env-file <path>]...`

Start a scripting session in a terminal, with the same globals as run

### `workspace [--json]`

Print the workspace folder, creating it with mode 0700 when missing

### `help [topic]`

Show the commands, or help on one

## Routes

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
| POST | `/tabs/:id/evaluate` | `expression?`, `function?`, `arg?`, `timeoutMs?` | Runs the agent's own expression or function in the page's main frame. Returns `{ ok: true, tab: TabView, value?: json } or { ok: true, tab: TabView, unserializable } or { ok: true, tab: TabView }`. |
| POST | `/tabs/:id/fetch` | `url`, `method?`, `headers?`, `body?`, `cache?`, `credentials?`, `integrity?`, `keepalive?`, `mode?`, `redirect?`, `referrer?`, `referrerPolicy?`, `stream?`, `timeoutMs?` | Fetches a URL from the page, with its cookies, origin and CORS. Returns `{ ok: true, tab: TabView, response: { ok, status, statusText, url, redirected, type, headers, body } }, or NDJSON head, data and end lines with stream`. |
| POST | `/tabs/:id/events` | `max?` | Drains the protocol events recorded for this tab. Returns `{ ok: true, events, dropped, gaps, remaining }`. |
| GET | `/tabs/:id/info` |  | Reads the viewport, scroll offsets, document size and ready state. Returns `{ tab: TabView, viewport: { width, height }, scroll: { x, y }, document: { width, height }, readyState, loading } or { tab: TabView, dialog }`. |
| GET | `/tabs/:id/snapshot` |  | Reads a compact snapshot. Returns `snapshot`. |
| POST | `/tabs/:id/snapshot` | `mode?`, `maxChars?`, `maxControls?`, `selector?`, `scope?`, `root?`, `header?`, `cursor?`, `format?`, `locators?` | Reads bounded page text and controls with refs. Returns `snapshot`. |
| POST | `/tabs/:id/actions` | `actions` | Runs 1 to 20 actions in order, stopping at the first failure. Returns `{ ok: true, results } or { ok: false, results, failedIndex, error }`. |
| GET | `/tabs/:id/screenshot` |  | Captures the viewport as PNG at CSS scale in any window state, the same as POST with {}. Returns `image/png`. |
| POST | `/tabs/:id/screenshot` | `fullPage?`, `clip?`, `scale?`, `timeoutMs?` | Captures the viewport, the whole page or a clip as PNG, at CSS or device scale. Returns `image/png with X-Kamapathy-Clip and X-Kamapathy-Pixel-Ratio`. |
| POST | `/tabs/:id/click` | `ref?`, `selector?`, `label?` | Clicks a control with native mouse input. Returns `{ ok: true, url, fallback?, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/fill` | `ref?`, `selector?`, `value`, `label?` | Replaces the value of a field, select or editable region. Returns `{ ok: true, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/press` | `key`, `ref?`, `selector?`, `label?` | Presses a supported key, focusing a control first when given. Returns `{ ok: true, url, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/scroll` | `direction`, `pixels?`, `ref?`, `selector?`, `label?` | Scrolls the page, the panel holding a control, or the panel in the middle. Returns `{ ok: true, scrolled, selector?, x, y, moved, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/drag` | `source`, `target`, `label?` | Drags one element onto another. Returns `{ ok: true, url, drag, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }`. |
| POST | `/tabs/:id/wait` | `selector?`, `text?`, `timeoutMs?` | Waits for a visible element, text, or both. Returns `{ ok: true }`. |
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

## Errors

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
| `cdp_method_blocked` | 403 | not retryable | `method`, `reason`, `param` | The protocol command reaches beyond this tab's own page and frames. |
| `agent_scripts_off` | 403 | not retryable |  | Page scripts are off in Kamapathy's Settings. |
| `request_declined` | 403 | not retryable |  | The person did not let an agent use a space. |
| `clipboard_blocked` | 403 | not retryable |  | A copy, cut or paste chord, or a Linux middle press on an editable, is refused. |
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
| `element_obscured` | 409 | retryable |  | Another element covers the target. |
| `body_too_large` | 413 | not retryable |  | The request body is larger than the route accepts. |
| `files_too_large` | 413 | not retryable |  | The upload files total more than 16 MiB. |
| `content_type` | 415 | not retryable |  | The request body is not JSON. |
| `element_action_failed` | 422 | not retryable |  | The page refused the action. |
| `navigation_failed` | 422 | retryable when netError is ERR_INTERNET_DISCONNECTED or ERR_NETWORK_CHANGED or ERR_NETWORK_IO_SUSPENDED or ERR_NAME_RESOLUTION_FAILED or ERR_CONNECTION_REFUSED or ERR_CONNECTION_TIMED_OUT | `url`, `netError`, `errorCode`, `httpStatus`, `blockedUrl` | The navigation ended without loading a document. |
| `navigation_download` | 422 | not retryable | `url`, `armed` | The address is a download, not a page. |
| `script_error` | 422 | not retryable | `name`, `line`, `column`, `description` | The page function threw or did not parse. |
| `result_too_large` | 422 | not retryable | `bytes`, `limit`, `status`, `url`, `headers` | The result is larger than the route returns. |
| `fetch_failed` | 422 | not retryable | `url`, `pageOrigin`, `crossOrigin`, `mode`, `name`, `corsError`, `blockedReason`, `netError` | The page could not fetch the URL. |
| `no_match` | 422 | retryable | `selector`, `waitedMs` | Nothing matched the selector by the deadline. |
| `ambiguous_match` | 422 | not retryable | `selector`, `count`, `visible`, `hidden`, `actionable`, `candidates` | The selector matched more than one element the action can take. |
| `drag_out_of_view` | 422 | not retryable |  | A drag endpoint is outside the viewport. |
| `invalid_file_type` | 422 | not retryable |  | The file input does not accept a selected file's type. |
| `invalid_upload_target` | 422 | not retryable |  | The ref is not a file input that can take these files. |
| `invalid_value` | 422 | not retryable |  | The control cannot take this value. |
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
| `action_timeout` | 504 | retryable | `awaited`, `timeoutMs`, `blocker`, `detail`, `interceptor` | The action did not start in time. |
| `evaluation_timeout` | 504 | not retryable | `awaited`, `timeoutMs`, `executionStopped`, `mayHaveLateEffects`, `pageResponsive` | The page script did not finish within the timeout. |
| `fetch_timeout` | 504 | not retryable | `awaited`, `timeoutMs` | The fetch did not answer within the timeout. |
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
