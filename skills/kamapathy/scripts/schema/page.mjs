// The members of Page.
import { ROUTES, routeKey } from "./routes.mjs";

const body = (key) => ROUTES.find((route) => routeKey(route) === key).body;
// pdfText's client options are the route's fields, with timeout for timeoutMs.
const pdfText = body("POST /tabs/:id/pdf/text");
// Every input method takes the label its route declares, in an options
// object after its own arguments.
const labelOption = (type) => ({
  options: { label: body(`POST /tabs/:id/${type}`).label },
});
const OPTIONS = { name: "options", kind: "options", optional: true };
// An element action's options: Playwright's names over the route's own
// fields, so delay and timeout stand for delayMs and timeoutMs and a
// position takes either spelling. Only the names a route declares are
// listed, in the order Playwright documents them.
const options = (type, names) => {
  const fields = body(`POST /tabs/:id/${type}`);
  const spec = {
    button: () => fields.button,
    clickCount: () => fields.clickCount,
    delay: () => ({ ...fields.delayMs, field: "delayMs" }),
    position: () => point(fields.position),
    sourcePosition: () => point(fields.sourcePosition),
    targetPosition: () => point(fields.targetPosition),
    steps: () => fields.steps,
    force: () => fields.force,
    append: () => fields.append,
    timeout: () => ({ ...fields.timeoutMs, field: "timeoutMs" }),
    label: () => fields.label,
  };
  return {
    options: Object.fromEntries(names.map((name) => [name, spec[name]()])),
  };
};
// A position option, which takes { x, y } or "x,y".
const point = (field) => ({
  ...field,
  kind: "point",
  description: `${field.description.replace(/\.$/, "")}, as { x, y } or "x,y" from its top left corner.`,
});
const PAGE = [
  "human_control",
  "tab_not_found",
  "no_web_page",
  "page_timeout",
  "action_timeout",
  "page_changed",
  "dialog_open",
  "debugger_busy",
  "page_crashed",
  "tab_closed",
  "automation_stopped",
];
const TARGET = [
  "invalid_target",
  "invalid_ref",
  "invalid_selector",
  "unknown_ref",
  "stale_ref",
  "cross_origin_frame",
  "no_match",
  "ambiguous_match",
  "element_action_failed",
];
// Input refusals: a gesture that did not land, and the guards that stop
// input which would leave the page, open something native or reach the
// system clipboard.
const INPUT = [
  "element_obscured",
  "input_not_delivered",
  "input_target_blocked",
  "native_popup_blocked",
  "clipboard_blocked",
];
// What a drag answers when it cannot run as a drag.
const DRAG = ["drag_out_of_view", "drag_unavailable", "drag_not_delivered"];
// A raw mouse or keyboard route resolves no target, so a bad value and the
// frame guard are all it refuses before it acts.
const RAW = ["invalid_field", "input_target_blocked"];
// What a press at a point can answer beyond the raw refusals.
const MOUSE_PRESS = [
  "point_outside_viewport",
  "native_popup_blocked",
  "clipboard_blocked",
  "input_not_delivered",
];
// The one key a raw keyboard route takes, and the paste body's fields.
const KEY = { name: "key", kind: "string", since: 4 };
const paste = body("POST /tabs/:id/keyboard/paste");
const coordinate = (name) => ({
  name,
  kind: "number",
  min: -10000,
  max: 10000,
  since: 4,
});
// What a snapshot's root, scope selector or cursor can answer.
const SCOPE = [
  "invalid_field",
  "invalid_ref",
  "invalid_selector",
  "invalid_cursor",
  "unknown_ref",
  "stale_ref",
  "cross_origin_frame",
  "no_match",
  "ambiguous_match",
];
const target = (name = "target", optional = false) => ({
  name,
  kind: "target",
  ...(optional ? { optional } : {}),
});
// page.screenshot's options overload, listed before the path one so an object
// never falls through to it. Its options are the route's own fields, plus the
// file to write.
const SHOT = { name: "options", kind: "options", optional: true, since: 3 };
const shot = body("POST /tabs/:id/screenshot");
const SHOT_OPTIONS = {
  path: {
    kind: "string",
    max: 4096,
    since: 3,
    description: "Also write the PNG to this new file, which must end in .png.",
  },
  fullPage: shot.fullPage,
  clip: shot.clip,
  scale: shot.scale,
  timeout: { ...shot.timeoutMs, field: "timeoutMs" },
};

const property = (name, signature, summary) => ({
  name,
  kind: "property",
  signature,
  summary,
  args: [],
  returns: name === "Page.spaceId" ? "string | undefined" : "string",
  errors: [],
  since: 1,
});
const field = (name, signature, summary, returns) => ({
  ...property(name, signature, summary),
  returns,
});
const method = (
  name,
  signature,
  summary,
  args,
  returns,
  route,
  errors,
  extra = {},
) => ({
  name,
  kind: "method",
  signature,
  summary,
  args,
  ...extra,
  returns,
  route,
  errors: [...errors, ...PAGE],
  since: extra.since ?? 1,
});

export const PAGE_ENTRIES = [
  property("Page.id", "page.id", "The tab's ID."),
  property(
    "Page.spaceId",
    "page.spaceId",
    "The ID of the space holding the tab.",
  ),
  property(
    "Page.url",
    "page.url",
    "The last known URL. navigate and snapshot refresh it.",
  ),
  property(
    "Page.title",
    "page.title",
    "The last known title. navigate and snapshot refresh it.",
  ),
  field(
    "Page.label",
    "page.label",
    "The page's label in its space, such as p2. Labels are never reused.",
    "string | undefined",
  ),
  field(
    "Page.openedBy",
    "page.openedBy",
    "Who opened the page: the agent, a page (a popup) or the person.",
    '"agent" | "page" | "person" | undefined',
  ),
  field(
    "Page.openerId",
    "page.openerId",
    "The ID of the page that opened this popup.",
    "string | undefined",
  ),
  field(
    "Page.managed",
    "page.managed",
    "Whether the agent may use the page. Adopt a page to manage it.",
    "boolean | undefined",
  ),
  {
    ...field(
      "Page.mouse",
      "page.mouse",
      "This page's mouse: it moves, presses and scrolls where it stands.",
      "Mouse",
    ),
    since: 4,
  },
  {
    ...field(
      "Page.keyboard",
      "page.keyboard",
      "This page's keyboard: it holds keys, types text and pastes.",
      "Keyboard",
    ),
    since: 4,
  },
  method(
    "Page.navigate",
    "page.navigate(url)",
    "Loads a complete http or https URL. Refs from before become stale.",
    [{ name: "url", kind: "url" }],
    "Promise<Page>",
    "POST /tabs/:id/navigate",
    ["invalid_url"],
  ),
  method(
    "Page.snapshot",
    "page.snapshot(options?)",
    "Reads bounded visible text and controls with refs.",
    [{ name: "options", kind: "options", optional: true }],
    "Promise<Snapshot>",
    "POST /tabs/:id/snapshot",
    SCOPE,
    { options: body("POST /tabs/:id/snapshot") },
  ),
  method(
    "Page.text",
    "page.text(options?)",
    "The same compact text the CLI's snapshot command prints.",
    [{ name: "options", kind: "options", optional: true }],
    "Promise<string>",
    "POST /tabs/:id/snapshot",
    SCOPE,
    { options: body("POST /tabs/:id/snapshot") },
  ),
  method(
    "Page.click",
    "page.click(target, options?)",
    "Clicks a control, waiting until it can take the press.",
    [target(), OPTIONS],
    "Promise<{ ok: true, url, point, loading?, fallback?, rebound? }>",
    "POST /tabs/:id/click",
    [...TARGET, ...INPUT, "invalid_field"],
    options("click", [
      "button",
      "clickCount",
      "delay",
      "position",
      "force",
      "timeout",
      "label",
    ]),
  ),
  method(
    "Page.dblclick",
    "page.dblclick(target, options?)",
    "Double-clicks a control with one gesture of two presses.",
    [target(), OPTIONS],
    "Promise<{ ok: true, url, point, loading?, fallback?, rebound? }>",
    "POST /tabs/:id/dblclick",
    [...TARGET, ...INPUT, "invalid_field"],
    {
      ...options("dblclick", [
        "button",
        "delay",
        "position",
        "force",
        "timeout",
        "label",
      ]),
      since: 4,
    },
  ),
  method(
    "Page.hover",
    "page.hover(target, options?)",
    "Moves the mouse onto a control and leaves it there.",
    [target(), OPTIONS],
    "Promise<{ ok: true, point, rebound? }>",
    "POST /tabs/:id/hover",
    [
      ...TARGET,
      "invalid_field",
      "input_target_blocked",
      "native_popup_blocked",
    ],
    {
      ...options("hover", ["position", "force", "timeout", "label"]),
      since: 4,
    },
  ),
  method(
    "Page.fill",
    "page.fill(target, value, options?)",
    "Replaces the value of a field, select or editable region, or adds to it.",
    [target(), { name: "value", kind: "string" }, OPTIONS],
    "Promise<{ ok: true, match, value?, valueHidden?, rebound? }>",
    "POST /tabs/:id/fill",
    [
      ...TARGET,
      "invalid_value",
      "invalid_field",
      "not_editable",
      "ambiguous_field",
      "fill_not_accepted",
      "input_target_blocked",
      "native_popup_blocked",
    ],
    options("fill", ["append", "timeout", "label"]),
  ),
  method(
    "Page.selectOption",
    "page.selectOption(target, values, options?)",
    "Chooses a select's options by value, label or index. A lone choice is wrapped; null and [] clear the select.",
    [target(), { name: "values", kind: "choices", since: 4 }, OPTIONS],
    "Promise<{ ok: true, values, rebound? }>",
    "POST /tabs/:id/select",
    [
      ...TARGET,
      "invalid_field",
      "not_selectable",
      "ambiguous_field",
      "input_target_blocked",
    ],
    { ...options("select", ["timeout", "label"]), since: 4 },
  ),
  method(
    "Page.focus",
    "page.focus(target, options?)",
    "Focuses a control, retargeting to the nearest one that takes focus.",
    [target(), OPTIONS],
    "Promise<{ ok: true, rebound? }>",
    "POST /tabs/:id/focus",
    [
      ...TARGET,
      "invalid_field",
      "not_focusable",
      "ambiguous_field",
      "input_target_blocked",
    ],
    { ...options("focus", ["timeout", "label"]), since: 4 },
  ),
  method(
    "Page.press",
    "page.press(key, target?, options?)",
    "Presses a key name, a printable character or a chord, focusing a control first when given. page.press(target, key) works too.",
    [{ name: "key", kind: "string" }, target("target", true), OPTIONS],
    "Promise<{ ok: true, url, loading?, rebound? }>",
    "POST /tabs/:id/press",
    ["invalid_key", ...TARGET, ...INPUT, "invalid_field"],
    options("press", ["delay", "timeout", "label"]),
  ),
  method(
    "Page.scroll",
    "page.scroll(direction, pixels?, target?, options?)",
    "Scrolls the page, the panel holding a control, or the panel in the middle when the page cannot scroll.",
    [
      {
        name: "direction",
        kind: "enum",
        values: ["up", "down", "left", "right"],
      },
      { name: "pixels", kind: "integer", optional: true },
      target("target", true),
      OPTIONS,
    ],
    "Promise<{ ok: true, scrolled, selector?, x, y, moved }>",
    "POST /tabs/:id/scroll",
    ["invalid_field", ...TARGET],
    {
      overloads: [
        [
          {
            name: "direction",
            kind: "enum",
            values: ["up", "down", "left", "right"],
          },
          { name: "pixels", kind: "integer", optional: true },
          target("target", true),
          OPTIONS,
        ],
        [
          {
            name: "direction",
            kind: "enum",
            values: ["up", "down", "left", "right"],
          },
          target(),
          OPTIONS,
        ],
      ],
      ...labelOption("scroll"),
    },
  ),
  method(
    "Page.drag",
    "page.drag(source, target, options?)",
    "Drags one element onto another with native mouse input or HTML drag and drop.",
    [target("source"), target(), OPTIONS],
    "Promise<{ ok: true, url, drag, loading?, rebound? }>",
    "POST /tabs/:id/drag",
    [...TARGET, ...INPUT, ...DRAG],
    labelOption("drag"),
  ),
  method(
    "Page.dragAndDrop",
    "page.dragAndDrop(source, target, options?)",
    "Drags one element onto another, with its own positions and a button.",
    [target("source"), target(), OPTIONS],
    "Promise<{ ok: true, url, drag, loading?, rebound? }>",
    "POST /tabs/:id/drag",
    [...TARGET, ...INPUT, ...DRAG, "invalid_field"],
    {
      ...options("drag", [
        "sourcePosition",
        "targetPosition",
        "button",
        "force",
        "timeout",
        "label",
      ]),
      since: 4,
    },
  ),
  method(
    "Page.wait",
    "page.wait(options?)",
    "Waits for a visible element, text, or both.",
    [{ name: "options", kind: "options", optional: true }],
    "Promise<{ ok: true }>",
    "POST /tabs/:id/wait",
    [
      "wait_timeout",
      "invalid_field",
      "invalid_selector",
      "unknown_ref",
      "stale_ref",
    ],
    { options: body("POST /tabs/:id/wait") },
  ),
  method(
    "Page.batch",
    "page.batch(actions)",
    "Runs 1 to 20 actions in order and stops at the first failure.",
    [{ name: "actions", kind: "actions" }],
    "Promise<{ ok: true, results }>",
    "POST /tabs/:id/actions",
    [
      "invalid_actions",
      "invalid_action",
      "invalid_field",
      ...TARGET,
      ...INPUT,
      "wait_timeout",
      "request_too_large",
    ],
  ),
  method(
    "Page.upload",
    "page.upload(ref, files)",
    "Selects local files on a file input. The site may upload them at once.",
    [
      { name: "ref", kind: "string" },
      { name: "files", kind: "array" },
    ],
    "Promise<{ ok: true, selected }>",
    "POST /tabs/:id/upload",
    [
      "invalid_files",
      "files_too_large",
      "invalid_upload_target",
      "invalid_file_type",
      "upload_busy",
      "unknown_ref",
      "stale_ref",
      "invalid_target",
    ],
  ),
  method(
    "Page.screenshot",
    "page.screenshot(options?)",
    "Captures the page as PNG: the viewport, the whole page or a clip, at CSS scale by default. With a path string it saves the file and returns its path.",
    [SHOT],
    "Promise<Buffer | string>",
    "POST /tabs/:id/screenshot",
    [
      "screenshot_failed",
      "empty_screenshot",
      "clip_outside_page",
      "screenshot_too_large",
      "invalid_field",
      "invalid_response",
    ],
    {
      expected: "page.screenshot(options?) or page.screenshot(path)",
      overloads: [[SHOT], [{ name: "path", kind: "string" }]],
      options: SHOT_OPTIONS,
    },
  ),
  method(
    "Page.pdfText",
    "page.pdfText(options?)",
    "Reads a PDF's text by page. Continue from nextPage.",
    [{ name: "options", kind: "options", optional: true }],
    "Promise<PdfText>",
    "POST /tabs/:id/pdf/text",
    [
      "not_pdf",
      "pdf_not_refetchable",
      "pdf_too_large",
      "pdf_locked",
      "pdf_unreadable",
      "pdf_fetch_failed",
      "page_out_of_range",
      "pdf_timeout",
      "busy",
      "invalid_field",
    ],
    {
      options: {
        from: pdfText.from,
        to: pdfText.to,
        maxChars: pdfText.maxChars,
        timeout: {
          kind: "ms",
          max: 60000,
          description: "How long the read may take, 15000 by default.",
        },
      },
      since: 3,
    },
  ),
  method(
    "Page.opener",
    "page.opener()",
    "The open page that opened this popup, or null.",
    [],
    "Promise<Page | null>",
    "GET /spaces/:id/tabs",
    [],
    { since: 2 },
  ),
  method(
    "Page.releaseInput",
    "page.releaseInput()",
    "Lets go of every key and mouse button this page holds. A run sends it for each page it touched.",
    [],
    "Promise<{ ok: true, released }>",
    "POST /tabs/:id/input/release",
    [],
    { since: 4 },
  ),
  method(
    "Page.close",
    "page.close()",
    "Closes the tab.",
    [],
    "Promise<{ ok: true }>",
    "DELETE /tabs/:id",
    [],
  ),
  method(
    "Mouse.move",
    "page.mouse.move(x, y, options?)",
    "Moves the pointer to a point in the page's viewport, interpolating from where it stands.",
    [coordinate("x"), coordinate("y"), OPTIONS],
    "Promise<{ ok: true, input }>",
    "POST /tabs/:id/mouse/move",
    [...RAW, "point_outside_viewport"],
    { ...options("mouse/move", ["steps"]), since: 4 },
  ),
  method(
    "Mouse.down",
    "page.mouse.down(options?)",
    "Presses a mouse button where the pointer stands.",
    [OPTIONS],
    "Promise<{ ok: true, input }>",
    "POST /tabs/:id/mouse/down",
    [...RAW, "native_popup_blocked", "clipboard_blocked"],
    { ...options("mouse/down", ["button", "clickCount"]), since: 4 },
  ),
  method(
    "Mouse.up",
    "page.mouse.up(options?)",
    "Lets a held mouse button go where the pointer stands.",
    [OPTIONS],
    "Promise<{ ok: true, input }>",
    "POST /tabs/:id/mouse/up",
    ["invalid_field"],
    { ...options("mouse/up", ["button", "clickCount"]), since: 4 },
  ),
  method(
    "Mouse.click",
    "page.mouse.click(x, y, options?)",
    "Moves to a point and clicks there, without resolving a target.",
    [coordinate("x"), coordinate("y"), OPTIONS],
    "Promise<{ ok: true, url, input, loading? }>",
    "POST /tabs/:id/mouse/click",
    [...RAW, ...MOUSE_PRESS],
    {
      ...options("mouse/click", ["button", "clickCount", "delay"]),
      since: 4,
    },
  ),
  method(
    "Mouse.dblclick",
    "page.mouse.dblclick(x, y, options?)",
    "Clicks twice at a point in one gesture.",
    [coordinate("x"), coordinate("y"), OPTIONS],
    "Promise<{ ok: true, url, input, loading? }>",
    "POST /tabs/:id/mouse/click",
    [...RAW, ...MOUSE_PRESS],
    { ...options("mouse/click", ["button", "delay"]), since: 4 },
  ),
  method(
    "Mouse.wheel",
    "page.mouse.wheel(deltaX, deltaY)",
    "Scrolls with the wheel where the pointer stands.",
    [coordinate("deltaX"), coordinate("deltaY")],
    "Promise<{ ok: true, input }>",
    "POST /tabs/:id/mouse/wheel",
    RAW,
    { since: 4 },
  ),
  method(
    "Keyboard.down",
    "page.keyboard.down(key)",
    "Holds one key down, so later input carries it.",
    [KEY],
    "Promise<{ ok: true, input }>",
    "POST /tabs/:id/keyboard/down",
    [...RAW, "invalid_key", "native_popup_blocked", "clipboard_blocked"],
    { since: 4 },
  ),
  method(
    "Keyboard.up",
    "page.keyboard.up(key)",
    "Lets one held key go.",
    [KEY],
    "Promise<{ ok: true, input }>",
    "POST /tabs/:id/keyboard/up",
    ["invalid_key", "invalid_field"],
    { since: 4 },
  ),
  method(
    "Keyboard.press",
    "page.keyboard.press(chord, options?)",
    "Presses a key or a chord where the focus is, holding its modifiers.",
    [{ name: "chord", kind: "string", since: 4 }, OPTIONS],
    "Promise<{ ok: true, url, loading? }>",
    "POST /tabs/:id/press",
    ["invalid_key", ...INPUT, "invalid_field"],
    { ...options("press", ["delay"]), since: 4 },
  ),
  method(
    "Keyboard.type",
    "page.keyboard.type(text, options?)",
    "Types text where the focus is, character by character.",
    [{ name: "text", kind: "text", min: 0, max: 2000, since: 4 }, OPTIONS],
    "Promise<{ ok: true, input }>",
    "POST /tabs/:id/keyboard/type",
    [...RAW, "native_popup_blocked", "clipboard_blocked"],
    { ...options("keyboard/type", ["delay"]), since: 4 },
  ),
  method(
    "Keyboard.insertText",
    "page.keyboard.insertText(text)",
    "Inserts text at the focused editable's caret, without key events.",
    [{ name: "text", kind: "text", min: 0, max: 16384, since: 4 }],
    "Promise<{ ok: true }>",
    "POST /tabs/:id/keyboard/insert-text",
    [...RAW, "not_editable"],
    { since: 4 },
  ),
  method(
    "Keyboard.paste",
    "page.keyboard.paste(text | { text, html })",
    "Offers the page a paste in a DataTransfer of its own, without the system clipboard.",
    [{ name: "input", kind: "options", since: 4 }],
    'Promise<{ ok: true, handled: "page" | "text" }>',
    "POST /tabs/:id/keyboard/paste",
    [...RAW, "not_editable", "request_too_large"],
    {
      expected:
        "page.keyboard.paste(text) or page.keyboard.paste({ text, html? })",
      overloads: [
        [{ name: "input", kind: "options", since: 4 }],
        [{ name: "text", kind: "text", min: 0, max: 16384, since: 4 }],
      ],
      options: {
        text: paste.text,
        html: paste.html,
      },
      since: 4,
    },
  ),
];
