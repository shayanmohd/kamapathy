# Kamapathy API reference

Client 0.2.0, API level 2. Generated from the schema by `npm run docs:api`; edit the schema, not this file.

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

Returns `{ version?: string, apiLevel: number, electron?: string, chromium?: string, node?: string } | null`. Since API level 1.

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
| `selector` | target |  | Read only the element this CSS selector matches. |

Returns `Promise<Snapshot>`. Route `POST /tabs/:id/snapshot`. Errors: `invalid_field`, `invalid_selector`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.text(options?)`

The same compact text the CLI's snapshot command prints.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `mode` | one of compact, full | `"compact"` | compact keeps the page short; full reads more. |
| `maxChars` | integer from 0 to 24000 |  | Most text characters to return. Defaults to 4000 compact, 24000 full. |
| `maxControls` | integer from 0 to 100 |  | Most controls to return. Defaults to 40 compact, 100 full. |
| `selector` | target |  | Read only the element this CSS selector matches. |

Returns `Promise<string>`. Route `POST /tabs/:id/snapshot`. Errors: `invalid_field`, `invalid_selector`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.click(target)`

Clicks a control.

Returns `Promise<{ ok: true, url, fallback?, rebound? }>`. Route `POST /tabs/:id/click`. Errors: `invalid_target`, `invalid_ref`, `invalid_selector`, `stale_ref`, `cross_origin_frame`, `element_action_failed`, `element_obscured`, `input_not_delivered`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.fill(target, value)`

Replaces the value of a field, select or editable region.

Returns `Promise<{ ok: true, rebound? }>`. Route `POST /tabs/:id/fill`. Errors: `invalid_target`, `invalid_ref`, `invalid_selector`, `stale_ref`, `cross_origin_frame`, `element_action_failed`, `invalid_value`, `invalid_field`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.press(key, target?)`

Presses a supported key, focusing a control first when given.

Returns `Promise<{ ok: true, rebound? }>`. Route `POST /tabs/:id/press`. Errors: `invalid_key`, `invalid_target`, `invalid_ref`, `invalid_selector`, `stale_ref`, `cross_origin_frame`, `element_action_failed`, `element_obscured`, `input_not_delivered`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.scroll(direction, pixels?, target?)`

Scrolls the page, the panel holding a control, or the panel in the middle when the page cannot scroll.

Returns `Promise<{ ok: true, scrolled, selector?, x, y, moved }>`. Route `POST /tabs/:id/scroll`. Errors: `invalid_field`, `invalid_target`, `invalid_ref`, `invalid_selector`, `stale_ref`, `cross_origin_frame`, `element_action_failed`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.drag(source, target)`

Drags one element onto another with native mouse input or HTML drag and drop.

Returns `Promise<{ ok: true, url, drag, rebound? }>`. Route `POST /tabs/:id/drag`. Errors: `invalid_target`, `invalid_ref`, `invalid_selector`, `stale_ref`, `cross_origin_frame`, `element_action_failed`, `element_obscured`, `input_not_delivered`, `drag_out_of_view`, `drag_unavailable`, `drag_not_delivered`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.wait(options?)`

Waits for a visible element, text, or both.

| Option | Kind | Default | Description |
| --- | --- | --- | --- |
| `selector` | target |  | Wait until this CSS selector matches a visible element. |
| `text` | string of at most 1000 characters |  | Wait until the page shows this text. |
| `timeoutMs` | milliseconds of at most 15000 | `5000` | How long to wait. |

Returns `Promise<{ ok: true }>`. Route `POST /tabs/:id/wait`. Errors: `wait_timeout`, `invalid_field`, `invalid_selector`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.batch(actions)`

Runs 1 to 20 actions in order and stops at the first failure.

Returns `Promise<{ ok: true, results }>`. Route `POST /tabs/:id/actions`. Errors: `invalid_actions`, `invalid_action`, `invalid_field`, `invalid_target`, `invalid_ref`, `invalid_selector`, `stale_ref`, `cross_origin_frame`, `element_action_failed`, `element_obscured`, `input_not_delivered`, `wait_timeout`, `request_too_large`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.upload(ref, files)`

Selects local files on a file input. The site may upload them at once.

Returns `Promise<{ ok: true, selected }>`. Route `POST /tabs/:id/upload`. Errors: `invalid_files`, `files_too_large`, `invalid_upload_target`, `invalid_file_type`, `upload_busy`, `stale_ref`, `invalid_target`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.screenshot(path)`

Saves a viewport PNG. Never overwrites an existing file.

Returns `Promise<string>`. Route `GET /tabs/:id/screenshot`. Errors: `screenshot_unavailable`, `screenshot_failed`, `empty_screenshot`, `invalid_response`, `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

### `page.opener()`

The open page that opened this popup, or null.

Returns `Promise<Page | null>`. Route `GET /spaces/:id/tabs`. Errors: `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 2.

### `page.close()`

Closes the tab.

Returns `Promise<{ ok: true }>`. Route `DELETE /tabs/:id`. Errors: `human_control`, `tab_not_found`, `no_web_page`, `page_timeout`, `action_timeout`, `page_changed`, `dialog_open`, `debugger_busy`, `page_crashed`, `tab_closed`, `automation_stopped`. Since API level 1.

## CLI commands

### `health`

Check the connection

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

### `snapshot <tab-id> [options]`

Read bounded page text and control refs

### `click <tab-id> <ref-or-selector>`

Click a control

### `fill <tab-id> <ref-or-selector> --stdin`

Read the exact field value from stdin

### `upload <tab-id> <ref> <file> [files]`

Select up to 8 files, 16 MiB total

### `press <tab-id> <key> [ref-or-selector]`

Press a supported key

### `drag <tab-id> <source> <target>`

Drag one element onto another (refs or selectors)

### `scroll <tab-id> <direction> [pixels] [ref-or-selector]`

Scroll up, down, left or right: the page, the panel holding a control, or the panel in the middle when the page cannot scroll

### `wait <tab-id> --stdin`

Read wait options as JSON from stdin

### `batch <tab-id>`

Read an actions array or {actions} JSON

### `screenshot <tab-id> <file.png>`

Save a viewport PNG without overwriting

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
| GET | `/health` |  | Checks the connection. Returns `{ status: "ok", version, apiLevel, versions }`. |
| GET | `/spaces` |  | Lists the spaces this API session can reach. Returns `{ spaces: SpaceView[] }`. |
| POST | `/spaces` | `name`, `isolated?`, `pageBudget?`, `reuse?` | Creates an agent space whose first page is p1, or with reuse returns the listed space whose ID or name matches. Returns `201 { space: SpaceView, tab: TabView, created: true }; reused 200 { space: SpaceView, created: false }`. |
| GET | `/spaces/:id` |  | Reads one space the agent can reach, also while the person has control. Returns `{ space: SpaceView }`. |
| DELETE | `/spaces/:id` |  | Closes an agent space and its tabs. A space holding tabs the person opened is refused. Returns `{ ok: true }`. |
| POST | `/spaces/:id/handoff` | `{}` | Hands the space to the person. Returns `{ ok: true, owner: "human" }`. |
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
| GET | `/tabs/:id/info` |  | Reads the viewport, scroll offsets, document size and ready state. Returns `{ tab: TabView, viewport: { width, height }, scroll: { x, y }, document: { width, height }, readyState, loading } or { tab: TabView, dialog }`. |
| GET | `/tabs/:id/snapshot` |  | Reads a compact snapshot. Returns `snapshot`. |
| POST | `/tabs/:id/snapshot` | `mode?`, `maxChars?`, `maxControls?`, `selector?` | Reads bounded page text and controls with refs. Returns `snapshot`. |
| POST | `/tabs/:id/actions` | `actions` | Runs 1 to 20 actions in order, stopping at the first failure. Returns `{ ok: true, results } or { ok: false, results, failedIndex, error }`. |
| GET | `/tabs/:id/screenshot` |  | Captures the viewport as PNG. Returns `image/png`. |
| POST | `/tabs/:id/click` | `ref?`, `selector?` | Clicks a control with native mouse input. Returns `{ ok: true, url, fallback?, rebound? }`. |
| POST | `/tabs/:id/fill` | `ref?`, `selector?`, `value` | Replaces the value of a field, select or editable region. Returns `{ ok: true, rebound? }`. |
| POST | `/tabs/:id/press` | `key`, `ref?`, `selector?` | Presses a supported key, focusing a control first when given. Returns `{ ok: true, url, rebound? }`. |
| POST | `/tabs/:id/scroll` | `direction`, `pixels?`, `ref?`, `selector?` | Scrolls the page, the panel holding a control, or the panel in the middle. Returns `{ ok: true, scrolled, selector?, x, y, moved }`. |
| POST | `/tabs/:id/drag` | `source`, `target` | Drags one element onto another. Returns `{ ok: true, url, drag, rebound? }`. |
| POST | `/tabs/:id/wait` | `selector?`, `text?`, `timeoutMs?` | Waits for a visible element, text, or both. Returns `{ ok: true }`. |
| POST | `/tabs/:id/upload` | `ref?`, `selector?`, `files` | Selects files on a file input. Returns `{ ok: true, selected }`. |

## Errors

| Code | Status | Retryable | Fields | Meaning |
| --- | --- | --- | --- | --- |
| `invalid_path` | 400 | not retryable |  | The path has a query string, an encoded segment or characters no route uses. |
| `invalid_json` | 400 | not retryable |  | The request body is not valid JSON. |
| `invalid_body` | 400 | not retryable |  | The request body is not a JSON object. |
| `invalid_field` | 400 | not retryable | `field`, `expected`, `index` | A field has the wrong kind or is out of range. |
| `invalid_target` | 400 | not retryable |  | The action needs exactly one of ref or selector, or cannot use the target it got. |
| `invalid_ref` | 400 | not retryable |  | The ref is not one a snapshot gives, such as @e1. |
| `invalid_key` | 400 | not retryable |  | The key is not one press supports. |
| `invalid_action` | 400 | not retryable | `allowed`, `index` | A batch step is not an object with a supported type. |
| `invalid_actions` | 400 | not retryable |  | A batch needs 1 to 20 actions. |
| `invalid_url` | 400 | not retryable |  | The URL is not a complete HTTP or HTTPS URL without credentials. |
| `invalid_files` | 400 | not retryable |  | The upload has no files, too many, or a malformed one. |
| `unknown_field` | 400 | not retryable | `field`, `allowed`, `route`, `index`, `action`, `suggestion`, `apiLevel` | A body or batch step has a field its route does not define. |
| `local_clients_only` | 403 | not retryable |  | Only local programs may use the API, never web pages. |
| `cdp_method_blocked` | 403 | not retryable | `method`, `reason` | The protocol command reaches beyond this tab's own page and frames. |
| `request_declined` | 403 | not retryable |  | The person did not let an agent use a space. |
| `route_not_found` | 404 | not retryable | `method`, `route`, `apiLevel`, `version` | This Kamapathy has no such route. |
| `space_not_found` | 404 | not retryable |  | No accessible agent space has this ID. |
| `tab_not_found` | 404 | not retryable | `tabId` | No tab in an accessible agent space has this ID. |
| `body_timeout` | 408 | retryable |  | The request body did not arrive in time. |
| `human_control` | 409 | not retryable | `spaceId`, `reason`, `prompt`, `since` | The person controls this space. |
| `tab_unmanaged` | 409 | not retryable | `tabId`, `label`, `openedBy` | The page is not the agent's yet. Adopt it before any other page route. |
| `release_refused` | 409 | not retryable | `tabId`, `label` | The agent opened this page, so it closes the page instead of releasing it. |
| `page_budget` | 409 | not retryable | `limit`, `used`, `pages` | The space already holds as many pages as its budget allows. Close or reuse a page. |
| `space_protected` | 409 | not retryable | `tabs` | The space holds tabs the person opened, so the agent cannot close it. |
| `sign_ins_mismatch` | 409 | not retryable | `spaceId`, `signIns` | The space a reuse found uses other sign-ins than the request asked for. |
| `space_ended` | 409 | not retryable | `spaceId`, `endedBy`, `reason` | The agent finished this space or the person stopped it. Only the person can let an agent use it again. |
| `tab_limit` | 409 | not retryable |  | The space already has its most tabs. |
| `space_limit` | 409 | not retryable |  | The API already manages its most spaces. |
| `screenshot_unavailable` | 409 | not retryable |  | Screenshots need the Kamapathy window shown. |
| `empty_screenshot` | 409 | retryable |  | The page has not rendered yet. |
| `no_web_page` | 409 | not retryable |  | The tab is not showing a web page. |
| `debugger_busy` | 409 | retryable when reason is unavailable | `reason` | Kamapathy has no debugger connection to the tab: developer tools hold it, or the connection was lost. |
| `page_changed` | 409 | not retryable |  | The page navigated during the operation. |
| `navigation_interrupted` | 409 | not retryable | `url`, `by` | A newer main-frame navigation replaced the one this request started. |
| `navigation_blocked` | 409 | not retryable | `url`, `reason` | The page's leave guard kept it open. |
| `dialog_open` | 409 | not retryable | `dialog`, `started` | A JavaScript dialog is open on the page. |
| `page_crashed` | 409 | not retryable |  | The page process stopped. |
| `tab_closed` | 409 | not retryable |  | The tab was closed. |
| `cross_origin_frame` | 409 | not retryable |  | The control is inside a frame from another origin. |
| `drag_unavailable` | 409 | not retryable |  | Chromium could not take over the drag. |
| `drag_not_delivered` | 409 | not retryable |  | The page started a drag Kamapathy never received. |
| `input_not_delivered` | 409 | retryable |  | The page never received the input. |
| `stale_ref` | 409 | not retryable |  | The ref belongs to an earlier snapshot or a control the page removed. |
| `element_obscured` | 409 | retryable |  | Another element covers the target. |
| `body_too_large` | 413 | not retryable |  | The request body is larger than the route accepts. |
| `files_too_large` | 413 | not retryable |  | The upload files total more than 16 MiB. |
| `content_type` | 415 | not retryable |  | The request body is not JSON. |
| `element_action_failed` | 422 | not retryable |  | The page refused the action. |
| `navigation_failed` | 422 | retryable when netError is ERR_INTERNET_DISCONNECTED or ERR_NETWORK_CHANGED or ERR_NETWORK_IO_SUSPENDED or ERR_NAME_RESOLUTION_FAILED or ERR_CONNECTION_REFUSED or ERR_CONNECTION_TIMED_OUT | `url`, `netError`, `errorCode`, `httpStatus`, `blockedUrl` | The navigation ended without loading a document. |
| `navigation_download` | 422 | not retryable | `url`, `armed` | The address is a download, not a page. |
| `drag_out_of_view` | 422 | not retryable |  | A drag endpoint is outside the viewport. |
| `invalid_file_type` | 422 | not retryable |  | The file input does not accept a selected file's type. |
| `invalid_upload_target` | 422 | not retryable |  | The ref is not a file input that can take these files. |
| `invalid_value` | 422 | not retryable |  | The control cannot take this value. |
| `invalid_selector` | 422 | not retryable |  | The selector is not valid CSS, or matches no single visible element. |
| `busy` | 429 | retryable | `scope`, `retryAfterMs` | Too many requests are waiting. |
| `upload_busy` | 429 | retryable |  | Another file transfer is in progress. |
| `operation_failed` | 500 | not retryable |  | The browser could not complete the operation. |
| `tab_creation_failed` | 500 | not retryable |  | Kamapathy could not create the tab. |
| `automation_stopped` | 503 | not retryable |  | Agent access is turned off. |
| `screenshot_failed` | 503 | retryable |  | The page could not render a screenshot. |
| `page_timeout` | 504 | retryable | `awaited`, `timeoutMs` | The page did not respond or load in time. |
| `action_timeout` | 504 | retryable | `awaited`, `timeoutMs`, `blocker`, `detail`, `interceptor` | The action did not start in time. |
| `control_timeout` | 504 | retryable | `awaited`, `timeoutMs`, `reason` | Control did not return to the agent before the timeout. |
| `request_timeout` | 504 | not retryable | `awaited`, `timeoutMs` | The person did not answer a request for a space in time. Asking again interrupts them. |
| `navigation_timeout` | 504 | retryable | `awaited`, `timeoutMs`, `committed`, `url`, `readyState` | The navigation did not reach the requested state before the timeout. |
| `wait_timeout` | 504 | retryable | `awaited`, `timeoutMs` | The condition was not met before the timeout. |
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
