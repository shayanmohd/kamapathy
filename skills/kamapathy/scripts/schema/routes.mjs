// Every HTTP route, with its body fields, body limit in bytes, time budget in
// milliseconds, lane, and whether it follows the page it acts on, and every
// batch step type. Section 1's router and section 3's client read these.

const BODY_LIMIT = 65536;

const ref = {
  kind: "string",
  max: 32,
  description: "An element ref from a current snapshot, such as @e1.",
};
const selector = {
  kind: "target",
  description: "A CSS selector matching exactly one visible element.",
};
const target = { ref, selector };
const url = {
  kind: "url",
  required: true,
  description: "A complete http or https URL.",
};
// How far a navigation or a load-state wait waits.
const waitUntil = {
  kind: "enum",
  values: ["commit", "domcontentloaded", "load", "networkidle"],
  default: "load",
  since: 2,
  description:
    "commit returns once the new document commits; domcontentloaded and load wait for those events; networkidle adds a quiet network window.",
};
// A URL glob. The main process matches it without backtracking, so a script
// that needs a RegExp or a predicate watches this page's commits instead.
const urlGlob = {
  kind: "string",
  max: 2048,
  since: 2,
  description:
    "A glob for the whole URL: * inside a path segment, ** across segments, {a,b} for one alternative, a backslash for a literal character.",
};
// How long a wait waits for its condition.
const waitTimeout = {
  kind: "ms",
  max: 60000,
  default: 10000,
  since: 2,
  description: "How long to wait. 0 checks once.",
};
// The state a load-state wait judges on the document the page shows, rather
// than on a new one it starts.
const loadState =
  "commit needs a committed document; domcontentloaded and load wait for those events; networkidle adds a quiet network window.";
// The quiet window networkidle asks for.
const idleMs = {
  kind: "ms",
  max: 10000,
  default: 500,
  since: 2,
  description: "How long nothing may be in flight before networkidle answers.",
};

const FIELDS = {
  snapshot: {
    mode: {
      kind: "enum",
      values: ["compact", "full"],
      default: "compact",
      description: "compact keeps the page short; full reads more.",
    },
    maxChars: {
      kind: "integer",
      min: 0,
      max: 24000,
      description:
        "Most text characters to return. Defaults to 4000 compact, 24000 full.",
    },
    maxControls: {
      kind: "integer",
      min: 0,
      max: 100,
      description: "Most controls to return. Defaults to 40 compact, 100 full.",
    },
    selector: {
      ...selector,
      description: "Read only the element this CSS selector matches.",
    },
  },
  click: { ...target },
  fill: {
    ...target,
    value: {
      kind: "string",
      min: 0,
      max: 16384,
      required: true,
      description: "The field's new value, exactly.",
    },
  },
  press: {
    key: {
      kind: "string",
      max: 20,
      required: true,
      description:
        "Enter, Tab, Escape, Backspace, Delete, an arrow key, Home, End, PageUp, PageDown or Space.",
    },
    ...target,
  },
  scroll: {
    direction: {
      kind: "enum",
      values: ["up", "down", "left", "right"],
      required: true,
      description: "Which way to scroll.",
    },
    pixels: {
      kind: "integer",
      min: 1,
      max: 2000,
      default: 600,
      description: "How far to scroll.",
    },
    ...target,
  },
  drag: {
    source: {
      kind: "object",
      fields: target,
      required: true,
      description: "The element to drag: a ref or selector.",
    },
    target: {
      kind: "object",
      fields: target,
      required: true,
      description: "The element to drop on: a ref or selector.",
    },
  },
  wait: {
    selector: {
      ...selector,
      description: "Wait until this CSS selector matches a visible element.",
    },
    text: {
      kind: "string",
      max: 1000,
      description: "Wait until the page shows this text.",
    },
    timeoutMs: {
      kind: "ms",
      max: 15000,
      default: 5000,
      description: "How long to wait.",
    },
  },
  navigate: {
    url,
    waitUntil,
    timeoutMs: {
      kind: "ms",
      min: 1,
      max: 60000,
      default: 15000,
      since: 2,
      description: "How long to wait for the state.",
    },
    referer: {
      kind: "url",
      max: 8192,
      since: 2,
      description: "The Referer header to send, exactly as given.",
    },
  },
  reload: {
    waitUntil,
    timeoutMs: {
      kind: "ms",
      min: 1,
      max: 60000,
      default: 15000,
      description: "How long to wait for the state.",
    },
    ignoreCache: {
      kind: "boolean",
      default: false,
      description: "Fetch the page and its subresources past the cache.",
    },
  },
  "wait-for-url": {
    url: { ...urlGlob, required: true },
    waitUntil,
    timeoutMs: waitTimeout,
  },
  "wait-for-load-state": {
    state: { ...waitUntil, description: loadState },
    idleMs,
    timeoutMs: waitTimeout,
  },
  "wait-for-function": {
    expression: {
      kind: "string",
      max: 16384,
      since: 2,
      description:
        "An expression to evaluate in the page. Give this or function, not both.",
    },
    function: {
      kind: "string",
      max: 16384,
      since: 2,
      description: "The source of a function to call in the page.",
    },
    arg: {
      kind: "json",
      since: 2,
      description: "The one JSON argument the function is called with.",
    },
    intervalMs: {
      kind: "ms",
      min: 10,
      max: 10000,
      default: 100,
      since: 2,
      description: "How long between checks.",
    },
    timeoutMs: waitTimeout,
  },
};

const route = (method, path, summary, response, body, options = {}) => ({
  method,
  path,
  summary,
  response,
  body,
  limit: options.limit ?? BODY_LIMIT,
  budget: options.budget ?? 10000,
  lane: options.lane ?? "space",
  follow: options.follow ?? false,
  label: false,
  since: options.since ?? 1,
});
const action = (type, summary, response) =>
  route("POST", `/tabs/:id/${type}`, summary, response, FIELDS[type], {
    budget: 30000,
    follow: true,
  });

export const ROUTES = [
  route(
    "GET",
    "/health",
    "Checks the connection.",
    '{ status: "ok", version, apiLevel, versions, skill?, update? }',
    null,
    { budget: 0, lane: "preadmission" },
  ),
  route(
    "GET",
    "/update",
    "Reads Kamapathy's update status.",
    "UpdateStatus",
    null,
    { lane: "none", budget: 5000, since: 3 },
  ),
  route(
    "POST",
    "/update/check",
    "Checks GitHub Releases for a newer Kamapathy, or returns the result of a check under 60 s old.",
    "UpdateStatus",
    {},
    { lane: "none", budget: 15000, since: 3 },
  ),
  route(
    "POST",
    "/update/download",
    "Starts or joins the download of this computer's installer; only the person installs it.",
    "202 UpdateStatus while downloading; 200 UpdateStatus when current or ready",
    {},
    { lane: "none", budget: 15000, since: 3 },
  ),
  route(
    "GET",
    "/spaces",
    "Lists the spaces this API session can reach.",
    "{ spaces: SpaceView[] }",
    null,
    { lane: "none" },
  ),
  route(
    "POST",
    "/spaces",
    "Creates an agent space whose first page is p1, or with reuse returns the listed space whose ID or name matches.",
    "201 { space: SpaceView, tab: TabView, created: true }; reused 200 { space: SpaceView, created: false }",
    {
      name: {
        kind: "string",
        max: 48,
        required: true,
        description: "The space's name.",
      },
      isolated: {
        kind: "boolean",
        default: false,
        description: "Give the space its own sign-ins instead of the person's.",
      },
      pageBudget: {
        kind: "integer",
        min: 1,
        max: 20,
        default: 20,
        since: 2,
        description:
          "Most pages the agent may manage in the space at once. A reused space takes the new value.",
      },
      reuse: {
        kind: "boolean",
        default: false,
        since: 2,
        description:
          "Return the listed space whose ID, or else first whose name, equals name instead of creating one.",
      },
    },
    { lane: "server" },
  ),
  route(
    "GET",
    "/spaces/:id",
    "Reads one space the agent can reach, also while the person has control.",
    "{ space: SpaceView }",
    null,
    { lane: "none", since: 2 },
  ),
  route(
    "DELETE",
    "/spaces/:id",
    "Closes an agent space and its tabs. A space holding tabs the person opened is refused.",
    "{ ok: true }",
    null,
  ),
  route(
    "POST",
    "/spaces/:id/handoff",
    "Hands the space to the person.",
    '{ ok: true, owner: "human" }',
    {},
  ),
  route(
    "POST",
    "/spaces/:id/resume",
    "Takes control of the space back after the person took over, a handoff or a reported failure, and lists what changed meanwhile.",
    '{ ok: true, owner: "agent", active: TabView | null, opened: TabView[], closed: label[] }',
    {},
  ),
  route(
    "POST",
    "/spaces/:id/wait-for-control",
    "Waits until the agent has control of the space, answering at once when it already has, and lists what changed while the person had control.",
    '{ ok: true, owner: "agent", active: TabView | null, opened: TabView[], closed: label[] }',
    {
      timeoutMs: {
        kind: "ms",
        min: 0,
        max: 600000,
        default: 600000,
        description: "How long to wait.",
      },
    },
    { lane: "none", budget: { field: "timeoutMs" }, since: 2 },
  ),
  route(
    "POST",
    "/spaces/:id/finish",
    "Ends the agent's task in a space: closes the pages it does not keep, keeps the person's tabs and ends its access.",
    "{ ok: true, spaceId, closedSpace, closed: label[], kept: label[], protected: label[] }",
    {
      keep: {
        kind: "json",
        required: true,
        description: '"all", or up to 20 unique tab ids to keep open.',
      },
    },
    { since: 2 },
  ),
  route(
    "GET",
    "/spaces/:id/tabs",
    "Lists every tab of a space with its label and origin, the last 100 closed labels and the page budget.",
    "{ tabs: TabView[], closed: [{ label, closedBy, at }], budget: { used, limit } }",
    null,
    { lane: "none" },
  ),
  route(
    "POST",
    "/spaces/:id/tabs",
    "Opens a page in the background, or a blank page without url. Stops at the page budget.",
    "201 { tab: TabView }",
    {
      url: {
        kind: "url",
        description:
          "The page to open. From API level 2 it may be left out for a blank page.",
      },
    },
    { follow: true },
  ),
  route(
    "POST",
    "/space-requests",
    "Asks the person to let an agent use one of their spaces and waits for their answer.",
    "{ space: SpaceView, tabs: TabView[], active: TabView | null }",
    {
      reason: {
        kind: "string",
        min: 1,
        max: 120,
        required: true,
        description:
          "Why the agent needs a space, shown to the person as the agent's words.",
      },
      name: {
        kind: "string",
        max: 48,
        description: "The name of the space to suggest.",
      },
      timeoutMs: {
        kind: "ms",
        min: 5000,
        max: 600000,
        default: 600000,
        description: "How long to wait for the person's answer.",
      },
    },
    { lane: "none", budget: { field: "timeoutMs" }, since: 2 },
  ),
  route(
    "DELETE",
    "/tabs/:id",
    "Closes a page the agent manages. Its label is retired, and a blank page with the next label replaces a space's last page.",
    "{ ok: true, closed?: label, replacement?: TabView }",
    null,
  ),
  route(
    "POST",
    "/tabs/:id/adopt",
    "Makes a page the agent did not open its own, within the page budget. The page keeps its label.",
    "{ tab: TabView }",
    {},
    { since: 2 },
  ),
  route(
    "POST",
    "/tabs/:id/release",
    "Gives a page the agent did not open back to the person. The page stays open.",
    "{ tab: TabView }",
    {},
    { since: 2 },
  ),
  route(
    "POST",
    "/tabs/:id/navigate",
    "Loads a URL in the tab and waits for the new document to reach a state.",
    "{ ok: true, tab: TabView, httpStatus?, waitUntil, dialog? }",
    FIELDS.navigate,
    { follow: true, budget: { field: "timeoutMs" } },
  ),
  route(
    "POST",
    "/tabs/:id/reload",
    "Reloads the page and waits for the new document to reach a state.",
    "{ ok: true, tab: TabView, httpStatus?, waitUntil, dialog? }",
    FIELDS.reload,
    { follow: true, budget: { field: "timeoutMs" }, since: 2 },
  ),
  route(
    "POST",
    "/tabs/:id/wait-for-url",
    "Waits for this page's URL to match a glob, or reports its commits so a script can match them itself.",
    "{ ok: true, tab: TabView, url } or { ok: true, tab: TabView, url, navigation, committed, missed?, popups }",
    {
      url: urlGlob,
      waitUntil,
      after: {
        kind: "integer",
        min: 0,
        max: 2147483647,
        since: 2,
        description:
          "A navigation count from an earlier answer. Without a url, the wait ends once a later commit exists.",
      },
      timeoutMs: waitTimeout,
    },
    { budget: { field: "timeoutMs" }, since: 2 },
  ),
  route(
    "POST",
    "/tabs/:id/wait-for-load-state",
    "Waits for the document this page shows to reach a state.",
    "{ ok: true, tab: TabView, state }",
    FIELDS["wait-for-load-state"],
    { budget: { field: "timeoutMs" }, since: 2 },
  ),
  route(
    "POST",
    "/tabs/:id/wait-for-function",
    "Waits for a function the agent wrote to return a truthy value in the page.",
    "{ ok: true, tab: TabView, value? } or { ok: true, tab: TabView, unserializable }",
    FIELDS["wait-for-function"],
    { budget: { field: "timeoutMs" }, since: 2 },
  ),
  route(
    "GET",
    "/tabs/:id/info",
    "Reads the viewport, scroll offsets, document size and ready state.",
    "{ tab: TabView, viewport: { width, height }, scroll: { x, y }, document: { width, height }, readyState, loading } or { tab: TabView, dialog }",
    null,
    { budget: 10000, follow: false, since: 2 },
  ),
  route(
    "GET",
    "/tabs/:id/snapshot",
    "Reads a compact snapshot.",
    "snapshot",
    null,
    { budget: 30000, follow: true },
  ),
  route(
    "POST",
    "/tabs/:id/snapshot",
    "Reads bounded page text and controls with refs.",
    "snapshot",
    FIELDS.snapshot,
    {
      budget: 30000,
      follow: true,
    },
  ),
  route(
    "POST",
    "/tabs/:id/actions",
    "Runs 1 to 20 actions in order, stopping at the first failure.",
    "{ ok: true, results } or { ok: false, results, failedIndex, error }",
    {
      actions: {
        kind: "array",
        of: "action",
        required: true,
        description: "The steps, each an object with a type.",
      },
    },
    { budget: 60000, follow: true },
  ),
  route(
    "GET",
    "/tabs/:id/screenshot",
    "Captures the viewport as PNG.",
    "image/png",
    null,
    { budget: 30000, follow: true },
  ),
  action(
    "click",
    "Clicks a control with native mouse input.",
    "{ ok: true, url, fallback?, rebound? }",
  ),
  action(
    "fill",
    "Replaces the value of a field, select or editable region.",
    "{ ok: true, rebound? }",
  ),
  action(
    "press",
    "Presses a supported key, focusing a control first when given.",
    "{ ok: true, url, rebound? }",
  ),
  action(
    "scroll",
    "Scrolls the page, the panel holding a control, or the panel in the middle.",
    "{ ok: true, scrolled, selector?, x, y, moved }",
  ),
  action(
    "drag",
    "Drags one element onto another.",
    "{ ok: true, url, drag, rebound? }",
  ),
  action("wait", "Waits for a visible element, text, or both.", "{ ok: true }"),
  route(
    "POST",
    "/tabs/:id/upload",
    "Selects files on a file input.",
    "{ ok: true, selected }",
    {
      ...target,
      files: {
        kind: "array",
        required: true,
        of: {
          kind: "object",
          fields: {
            name: {
              kind: "string",
              max: 255,
              required: true,
              description: "The file's base name.",
            },
            type: {
              kind: "string",
              min: 0,
              max: 128,
              required: true,
              description: "The MIME type, or an empty string.",
            },
            data: {
              kind: "string",
              min: 0,
              max: Math.ceil((16 * 1024 * 1024) / 3) * 4,
              required: true,
              description: "The content as canonical base64.",
            },
          },
          description: "One file.",
        },
        description: "1 to 8 files, at most 16 MiB together.",
      },
    },
    { budget: 30000, limit: 24 * 1024 * 1024, follow: true },
  ),
  route(
    "POST",
    "/tabs/:id/pdf/text",
    "Reads a PDF's text by page without entering Chromium's viewer.",
    "PdfText",
    {
      from: {
        kind: "integer",
        min: 1,
        max: 100000,
        default: 1,
        description: "The first page to read.",
      },
      to: {
        kind: "integer",
        min: 1,
        max: 100000,
        description:
          "The last page, at most from + 499. Defaults to the last page or from + 499.",
      },
      maxChars: {
        kind: "integer",
        min: 0,
        max: 1000000,
        default: 20000,
        description:
          "Most characters to return; whole pages come in order. 0 returns only pageCount and title.",
      },
      timeoutMs: {
        kind: "ms",
        max: 60000,
        default: 15000,
        description: "How long loading, reading and extracting may take.",
      },
    },
    { budget: { field: "timeoutMs", plusMs: 5000 }, follow: true, since: 3 },
  ),
];

export const ACTIONS = [
  {
    type: "snapshot",
    summary: "Reads bounded page text and controls.",
    fields: FIELDS.snapshot,
    since: 1,
  },
  {
    type: "click",
    summary: "Clicks a control.",
    fields: FIELDS.click,
    since: 1,
  },
  {
    type: "fill",
    summary: "Replaces a field's value.",
    fields: FIELDS.fill,
    since: 1,
  },
  {
    type: "press",
    summary: "Presses a supported key.",
    fields: FIELDS.press,
    since: 1,
  },
  {
    type: "scroll",
    summary: "Scrolls the page or a panel.",
    fields: FIELDS.scroll,
    since: 1,
  },
  {
    type: "drag",
    summary: "Drags one element onto another.",
    fields: FIELDS.drag,
    since: 1,
  },
  {
    type: "wait",
    summary: "Waits for a visible element, text, or both.",
    fields: FIELDS.wait,
    since: 1,
  },
  {
    type: "navigate",
    summary: "Loads a URL and waits for the new document to reach a state.",
    fields: FIELDS.navigate,
    since: 2,
  },
  {
    type: "reload",
    summary:
      "Reloads the page and waits for the new document to reach a state.",
    fields: FIELDS.reload,
    since: 2,
  },
  {
    type: "wait-for-url",
    summary: "Waits for this page's URL to match a glob.",
    fields: FIELDS["wait-for-url"],
    since: 2,
  },
  {
    type: "wait-for-load-state",
    summary: "Waits for the document this page shows to reach a state.",
    fields: FIELDS["wait-for-load-state"],
    since: 2,
  },
  {
    type: "wait-for-function",
    summary: "Waits for a page function to return a truthy value.",
    fields: FIELDS["wait-for-function"],
    since: 2,
  },
];

// Budgets that combine several body fields, by name. Section 5 adds them.
export const COMPUTE = {};

export const routeKey = ({ method, path }) => `${method} ${path}`;

// The route a request names. ":id" matches one path segment.
export function matchRoute(method, path) {
  const parts = path.split("/").filter(Boolean);
  return ROUTES.find((item) => {
    if (item.method !== method) return false;
    const pattern = item.path.split("/").filter(Boolean);
    return (
      pattern.length === parts.length &&
      pattern.every(
        (segment, index) => segment === ":id" || segment === parts[index],
      )
    );
  });
}

// A request's own budget: fixed, a body field's value or default plus any
// load wait, or a named function of the body.
export function requestBudget(item, body = {}) {
  const { budget } = item;
  if (typeof budget === "number") return budget;
  if ("compute" in budget) return COMPUTE[budget.compute]?.(body ?? {});
  const value = body?.[budget.field] ?? item.body?.[budget.field]?.default;
  return typeof value === "number" ? value + (budget.plusMs ?? 0) : undefined;
}
