// Every error code Kamapathy, its isolated-world code and the client raise,
// each with one status and whether it can clear without the request
// changing. Client-only codes have no status.

const code = (status, transient, summary, fields = [], since = 1) => ({
  status,
  transient,
  summary,
  fields,
  since,
});

export const ERRORS = {
  invalid_path: code(
    400,
    false,
    "The path has a query string, an encoded segment or characters no route uses.",
  ),
  invalid_json: code(400, false, "The request body is not valid JSON."),
  invalid_body: code(400, false, "The request body is not a JSON object."),
  invalid_field: code(
    400,
    false,
    "A field has the wrong kind or is out of range.",
    ["field", "expected", "index"],
  ),
  invalid_target: code(
    400,
    false,
    "The action needs exactly one of ref or selector, or cannot use the target it got.",
  ),
  invalid_ref: code(
    400,
    false,
    "The ref is not one a snapshot gives, such as @e1.",
  ),
  invalid_key: code(400, false, "The key is not one press supports."),
  invalid_action: code(
    400,
    false,
    "A batch step is not an object with a supported type.",
    ["allowed", "index"],
  ),
  invalid_actions: code(400, false, "A batch needs 1 to 20 actions."),
  invalid_url: code(
    400,
    false,
    "The URL is not a complete HTTP or HTTPS URL without credentials.",
  ),
  invalid_files: code(
    400,
    false,
    "The upload has no files, too many, or a malformed one.",
  ),
  unknown_field: code(
    400,
    false,
    "A body or batch step has a field its route does not define.",
    ["field", "allowed", "route", "index", "action", "suggestion", "apiLevel"],
    2,
  ),
  local_clients_only: code(
    403,
    false,
    "Only local programs may use the API, never web pages.",
  ),
  cdp_method_blocked: code(
    403,
    false,
    "The protocol command reaches beyond this tab's own page and frames.",
    ["method", "reason"],
  ),
  route_not_found: code(404, false, "This Kamapathy has no such route.", [
    "method",
    "route",
    "apiLevel",
    "version",
  ]),
  space_not_found: code(404, false, "No accessible agent space has this ID."),
  tab_not_found: code(
    404,
    false,
    "No tab in an accessible agent space has this ID.",
  ),
  body_timeout: code(408, true, "The request body did not arrive in time."),
  human_control: code(409, false, "The person controls this space."),
  tab_limit: code(409, false, "The space already has its most tabs."),
  space_limit: code(409, false, "The API already manages its most spaces."),
  screenshot_unavailable: code(
    409,
    false,
    "Screenshots need the Kamapathy window shown.",
  ),
  empty_screenshot: code(409, true, "The page has not rendered yet."),
  no_web_page: code(409, false, "The tab is not showing a web page."),
  debugger_busy: code(
    409,
    [{ field: "reason", values: ["unavailable"] }],
    "Kamapathy has no debugger connection to the tab: developer tools hold it, or the connection was lost.",
    ["reason"],
  ),
  page_changed: code(409, false, "The page navigated during the operation."),
  dialog_open: code(409, false, "A JavaScript dialog is open on the page.", [
    "dialog",
    "started",
  ]),
  page_crashed: code(409, false, "The page process stopped."),
  tab_closed: code(409, false, "The tab was closed."),
  cross_origin_frame: code(
    409,
    false,
    "The control is inside a frame from another origin.",
  ),
  drag_unavailable: code(409, false, "Chromium could not take over the drag."),
  drag_not_delivered: code(
    409,
    false,
    "The page started a drag Kamapathy never received.",
  ),
  input_not_delivered: code(409, true, "The page never received the input."),
  stale_ref: code(
    409,
    false,
    "The ref belongs to an earlier snapshot or a control the page removed.",
  ),
  element_obscured: code(409, true, "Another element covers the target."),
  body_too_large: code(
    413,
    false,
    "The request body is larger than the route accepts.",
  ),
  files_too_large: code(413, false, "The upload files total more than 16 MiB."),
  content_type: code(415, false, "The request body is not JSON."),
  element_action_failed: code(422, false, "The page refused the action."),
  drag_out_of_view: code(
    422,
    false,
    "A drag endpoint is outside the viewport.",
  ),
  invalid_file_type: code(
    422,
    false,
    "The file input does not accept a selected file's type.",
  ),
  invalid_upload_target: code(
    422,
    false,
    "The ref is not a file input that can take these files.",
  ),
  invalid_value: code(422, false, "The control cannot take this value."),
  invalid_selector: code(
    422,
    false,
    "The selector is not valid CSS, or matches no single visible element.",
  ),
  busy: code(429, true, "Too many requests are waiting.", ["scope"]),
  upload_busy: code(429, true, "Another file transfer is in progress."),
  operation_failed: code(
    500,
    false,
    "The browser could not complete the operation.",
  ),
  tab_creation_failed: code(500, false, "Kamapathy could not create the tab."),
  automation_stopped: code(503, false, "Agent access is turned off."),
  screenshot_failed: code(503, true, "The page could not render a screenshot."),
  page_timeout: code(504, true, "The page did not respond or load in time.", [
    "awaited",
    "timeoutMs",
  ]),
  action_timeout: code(504, true, "The action did not start in time.", [
    "awaited",
    "timeoutMs",
    "blocker",
    "detail",
    "interceptor",
  ]),
  wait_timeout: {
    ...code(504, true, "The condition was not met before the timeout.", [
      "awaited",
      "timeoutMs",
    ]),
    override: { status: 408, route: "POST /tabs/:id/wait", action: "wait" },
  },
  not_connected: code(
    null,
    [{ field: "reason", values: ["busy"] }],
    "Kamapathy is unreachable, missing or must not be started, or the connection was lost.",
    ["reason"],
  ),
  timeout: code(
    null,
    false,
    "The request timed out. An action may already have reached the page.",
  ),
  request_too_large: code(
    null,
    false,
    "The encoded request is larger than its route accepts.",
  ),
  invalid_response: code(
    null,
    false,
    "Kamapathy's answer was not what the route returns.",
  ),
  request_failed: code(
    null,
    false,
    "The request failed without an error code.",
  ),
  invalid_option: code(
    null,
    false,
    "Options are not a plain object, or have an undeclared key or a bad value.",
    ["entry", "option", "expected", "suggestion"],
    2,
  ),
  invalid_argument: code(
    null,
    false,
    "Arguments are missing, extra or of the wrong kind.",
    ["entry", "expected"],
    2,
  ),
  app_outdated: code(
    null,
    false,
    "The running Kamapathy predates this call.",
    ["entry", "option", "required", "available", "appVersion"],
    2,
  ),
};

// Whether an error can clear without the request changing: its code says
// so, or one of its rules matches the error's fields.
export function isTransient(name, fields = {}) {
  const spec = ERRORS[name];
  if (!spec) return false;
  if (typeof spec.transient === "boolean") return spec.transient;
  return spec.transient.some((rule) => {
    const value = fields?.[rule.field];
    if (rule.absent) return value === undefined;
    if (rule.values) return rule.values.includes(value);
    return (
      typeof value === "number" &&
      (rule.min === undefined || value >= rule.min) &&
      (rule.max === undefined || value <= rule.max)
    );
  });
}
