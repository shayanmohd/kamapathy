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
const INPUT = ["element_obscured", "input_not_delivered"];
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
    "Clicks a control.",
    [target(), OPTIONS],
    "Promise<{ ok: true, url, fallback?, rebound? }>",
    "POST /tabs/:id/click",
    [...TARGET, ...INPUT],
    labelOption("click"),
  ),
  method(
    "Page.fill",
    "page.fill(target, value, options?)",
    "Replaces the value of a field, select or editable region.",
    [target(), { name: "value", kind: "string" }, OPTIONS],
    "Promise<{ ok: true, rebound? }>",
    "POST /tabs/:id/fill",
    [
      ...TARGET,
      "invalid_value",
      "invalid_field",
      "not_editable",
      "ambiguous_field",
      "fill_not_accepted",
    ],
    labelOption("fill"),
  ),
  method(
    "Page.press",
    "page.press(key, target?, options?)",
    "Presses a supported key, focusing a control first when given.",
    [{ name: "key", kind: "string" }, target("target", true), OPTIONS],
    "Promise<{ ok: true, rebound? }>",
    "POST /tabs/:id/press",
    ["invalid_key", ...TARGET, ...INPUT],
    labelOption("press"),
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
    "Promise<{ ok: true, url, drag, rebound? }>",
    "POST /tabs/:id/drag",
    [
      ...TARGET,
      ...INPUT,
      "drag_out_of_view",
      "drag_unavailable",
      "drag_not_delivered",
    ],
    labelOption("drag"),
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
    "Page.close",
    "page.close()",
    "Closes the tab.",
    [],
    "Promise<{ ok: true }>",
    "DELETE /tabs/:id",
    [],
  ),
];
