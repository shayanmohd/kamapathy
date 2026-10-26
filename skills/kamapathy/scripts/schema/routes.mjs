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
  description:
    "A ref or selector: CSS by default, or css=, text=, role=, href= or xpath=, with an optional final >> nth=N. It must pick one element the action can take.",
};
const target = { ref, selector };
const url = {
  kind: "url",
  required: true,
  description: "A complete http or https URL, or about:blank.",
};
// How far a navigation or a load-state wait waits.
const waitUntil = {
  kind: "enum",
  values: ["commit", "domcontentloaded", "load", "networkidle"],
  default: "load",
  since: 4,
  description:
    "commit returns once the new document commits; domcontentloaded and load wait for those events; networkidle adds a quiet network window.",
};
// A URL glob. The main process matches it without backtracking, so a script
// that needs a RegExp or a predicate watches this page's commits instead.
const urlGlob = {
  kind: "string",
  max: 2048,
  since: 4,
  description:
    "A glob for the whole URL: * inside a path segment, ** across segments, {a,b} for one alternative, a backslash for a literal character.",
};
// How long a wait waits for its condition.
const waitTimeout = {
  kind: "ms",
  max: 60000,
  default: 10000,
  since: 4,
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
  since: 4,
  description: "How long nothing may be in flight before networkidle answers.",
};
// One file as it travels to a file input: its metadata and its bytes.
const uploadFile = {
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
};
const label = {
  kind: "string",
  min: 1,
  max: 60,
  since: 3,
  description:
    "A few words naming this step, shown by the cursor and in the agent bar.",
};
// The pointer options an element press takes, with Playwright's meanings.
const button = {
  kind: "enum",
  values: ["left", "middle", "right"],
  default: "left",
  since: 4,
  description: "Which mouse button to press.",
};
const clickCount = {
  kind: "integer",
  min: 1,
  max: 3,
  default: 1,
  since: 4,
  description: "How many presses the one gesture sends.",
};
const pressDelay = {
  kind: "ms",
  min: 0,
  max: 5000,
  default: 0,
  since: 4,
  description: "How long to hold each press, and to wait between presses.",
};
const positionAxis = (way) => ({
  kind: "number",
  min: -10000,
  max: 10000,
  required: true,
  since: 4,
  description: `Pixels ${way} the element's top left corner.`,
});
const position = {
  kind: "object",
  fields: { x: positionAxis("right of"), y: positionAxis("below") },
  since: 4,
  description: "Where in the element to act, instead of its centre.",
};
const force = {
  kind: "boolean",
  default: false,
  since: 4,
  description:
    "Act even when something covers the target. A disabled target is never forced.",
};
// How long an element action waits for a target that can take its input.
const actionTimeout = {
  kind: "ms",
  min: 0,
  max: 60000,
  default: 3000,
  since: 4,
  description:
    "How long to wait for a target that can take the input. 0 looks once.",
};
// Keeps a field's old value and types after it.
const append = {
  kind: "boolean",
  default: false,
  since: 4,
  description: "Add to the field's value instead of replacing it.",
};
// The one key a raw keyboard route holds or lets go.
const keyboardKey = {
  kind: "string",
  min: 1,
  max: 64,
  required: true,
  since: 4,
  description:
    "One key: a name such as Shift, Enter or KeyA, or a printable character. Not a chord.",
};
// Where a raw mouse route acts, in the top frame's viewport pixels.
const coordinate = (axis) => ({
  kind: "number",
  min: -10000,
  max: 10000,
  required: true,
  since: 4,
  description: `The ${axis} of the point, in the page's own viewport pixels.`,
});
// A wheel delta, in pixels of the page's own viewport.
const delta = (way) => ({
  kind: "number",
  min: -10000,
  max: 10000,
  required: true,
  since: 4,
  description: `How far to scroll ${way}.`,
});
// How many events a move is interpolated into.
const steps = {
  kind: "integer",
  min: 1,
  max: 100,
  default: 1,
  since: 4,
  description: "How many moves to send from the pointer's stored position.",
};
// The options selectOption chooses, as strings or objects.
const choices = {
  kind: "array",
  required: true,
  since: 4,
  description:
    "0 to 100 choices: a string matching an option's value, else its label, or an object with value, label or index. An empty list clears the select.",
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
      description: "Read only the element this selector matches, of any form.",
    },
    scope: {
      kind: "enum",
      values: ["page", "viewport"],
      default: "page",
      since: 3,
      description:
        "page reads everything; viewport keeps only what is on screen.",
    },
    root: {
      kind: "string",
      max: 32,
      since: 3,
      description:
        "Read only this ref's subtree, or a frame ref's document. Not with selector.",
    },
    header: {
      kind: "boolean",
      default: true,
      since: 3,
      description: "Name the page, its space and the space's tabs.",
    },
    cursor: {
      kind: "string",
      max: 512,
      since: 3,
      description:
        "The next value of an earlier part, for the part after it. Keep scope, root, selector and format.",
    },
    format: {
      kind: "enum",
      values: ["list", "outline"],
      default: "list",
      since: 3,
      description:
        "list reads text and controls; outline prints the page's structure instead of its text.",
    },
    locators: {
      kind: "boolean",
      default: false,
      since: 3,
      description:
        "Give each control a locator: a selector that names it alone, which outlives refs.",
    },
  },
  click: {
    ...target,
    button,
    clickCount,
    delayMs: pressDelay,
    position,
    force,
    timeoutMs: actionTimeout,
    label,
  },
  dblclick: {
    ...target,
    button,
    delayMs: pressDelay,
    position,
    force,
    timeoutMs: actionTimeout,
    label,
  },
  hover: { ...target, position, force, timeoutMs: actionTimeout, label },
  fill: {
    ...target,
    value: {
      kind: "string",
      min: 0,
      max: 16384,
      required: true,
      description: "The field's new value, exactly.",
    },
    append,
    timeoutMs: actionTimeout,
    label,
  },
  select: { ...target, values: choices, timeoutMs: actionTimeout, label },
  focus: { ...target, timeoutMs: actionTimeout, label },
  press: {
    key: {
      kind: "string",
      max: 64,
      required: true,
      description:
        "A key name such as Enter, KeyA or F12, a printable character, or a chord of at most 6 keys such as Shift+KeyA or ControlOrMeta+KeyS.",
    },
    ...target,
    delayMs: {
      ...pressDelay,
      description: "How long to hold the key before releasing it.",
    },
    timeoutMs: actionTimeout,
    label,
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
    label,
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
    sourcePosition: {
      ...position,
      description: "Where in the source to press, instead of its centre.",
    },
    targetPosition: {
      ...position,
      description: "Where in the target to drop, instead of its centre.",
    },
    button,
    force,
    timeoutMs: actionTimeout,
    label,
  },
  mouseMove: { x: coordinate("x"), y: coordinate("y"), steps },
  mouseButton: { button, clickCount },
  mouseWheel: { deltaX: delta("right"), deltaY: delta("down") },
  mouseClick: {
    x: coordinate("x"),
    y: coordinate("y"),
    button,
    clickCount,
    delayMs: pressDelay,
  },
  keyboardKey: { key: keyboardKey },
  keyboardType: {
    text: {
      kind: "string",
      min: 0,
      max: 2000,
      required: true,
      since: 4,
      description:
        "The text to type. Characters the US layout has go out as key events, a newline as Enter, and anything else is inserted.",
    },
    delayMs: {
      kind: "ms",
      min: 0,
      max: 1000,
      default: 0,
      since: 4,
      description:
        "How long to wait between characters. Times the text length it is at most 60000 ms.",
    },
  },
  keyboardInsert: {
    text: {
      kind: "string",
      min: 0,
      max: 16384,
      required: true,
      since: 4,
      description: "The text to insert at the focused editable's caret.",
    },
  },
  keyboardPaste: {
    text: {
      kind: "string",
      min: 0,
      max: 16384,
      required: true,
      since: 4,
      description: "The plain text to paste. It may be empty only beside html.",
    },
    html: {
      kind: "string",
      min: 0,
      max: 32768,
      since: 4,
      description:
        "The rich flavour offered beside the text, which only the page's own handler can take.",
    },
  },
  wait: {
    selector: {
      ...selector,
      description: "Wait until this selector matches a visible element.",
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
      since: 4,
      description: "How long to wait for the state.",
    },
    referer: {
      kind: "url",
      max: 8192,
      since: 4,
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
  "wait-for-selector": {
    ...target,
    selector: {
      ...selector,
      description:
        "A ref or selector of any form. For attached and visible a locator or a ref must name one element; raw CSS and XPath take any match.",
    },
    state: {
      kind: "enum",
      values: ["attached", "visible", "hidden", "detached"],
      default: "visible",
      since: 4,
      description:
        "attached needs any match; visible a match the page draws; hidden no visible match; detached no match at all.",
    },
    timeoutMs: waitTimeout,
  },
  "wait-for-function": {
    expression: {
      kind: "string",
      max: 16384,
      since: 4,
      description:
        "An expression to evaluate in the page. Give this or function, not both.",
    },
    function: {
      kind: "string",
      max: 16384,
      since: 4,
      description: "The source of a function to call in the page.",
    },
    arg: {
      kind: "json",
      since: 4,
      description: "The one JSON argument the function is called with.",
    },
    intervalMs: {
      kind: "ms",
      min: 10,
      max: 10000,
      default: 100,
      since: 4,
      description: "How long between checks.",
    },
    timeoutMs: waitTimeout,
  },
  evaluate: {
    expression: {
      kind: "string",
      max: 16384,
      since: 4,
      description:
        "An expression to run in the page, with top-level await. Give this or function, not both.",
    },
    function: {
      kind: "string",
      max: 16384,
      since: 4,
      description: "The source of a function to call in the page.",
    },
    arg: {
      kind: "json",
      since: 4,
      description: "The one JSON argument the function is called with.",
    },
    timeoutMs: {
      kind: "ms",
      min: 2000,
      max: 60000,
      default: 15000,
      since: 4,
      description:
        "How long the script may run. The page itself gets this less 1000 ms.",
    },
  },
  fetch: {
    url: {
      kind: "string",
      max: 8192,
      required: true,
      since: 4,
      description:
        "What to fetch. A relative URL resolves against the tab's URL; it must end up http or https without credentials, or a blob of the page's own origin.",
    },
    method: {
      kind: "string",
      max: 32,
      default: "GET",
      since: 4,
      description: "The request method. CONNECT, TRACE and TRACK are refused.",
    },
    headers: {
      kind: "json",
      since: 4,
      description:
        "Request headers as an object of at most 64 string pairs. Headers the browser sets itself, such as Cookie, Host, Origin, Referer, Sec- and Proxy-, are refused.",
    },
    body: {
      kind: "string",
      min: 0,
      max: 524288,
      since: 4,
      description: "The request body. Not with GET or HEAD.",
    },
    cache: {
      kind: "enum",
      values: [
        "default",
        "no-store",
        "reload",
        "no-cache",
        "force-cache",
        "only-if-cached",
      ],
      since: 4,
      description: "The cache mode, as in the Fetch standard.",
    },
    credentials: {
      kind: "enum",
      values: ["omit", "same-origin", "include"],
      since: 4,
      description:
        "Which cookies and credentials the request carries. The page's own default applies without it.",
    },
    integrity: {
      kind: "string",
      max: 256,
      since: 4,
      description: "A subresource integrity value the body must match.",
    },
    keepalive: {
      kind: "boolean",
      since: 4,
      description: "Let the request outlive the page.",
    },
    mode: {
      kind: "enum",
      values: ["cors", "no-cors", "same-origin"],
      default: "cors",
      since: 4,
      description:
        "cors reads a cross-origin answer the server allows; no-cors answers opaquely; same-origin refuses another origin.",
    },
    redirect: {
      kind: "enum",
      values: ["follow", "error", "manual"],
      since: 4,
      description: "What a redirect does.",
    },
    referrer: {
      kind: "string",
      max: 8192,
      since: 4,
      description: "The referrer the request carries.",
    },
    referrerPolicy: {
      kind: "enum",
      values: [
        "",
        "no-referrer",
        "no-referrer-when-downgrade",
        "same-origin",
        "origin",
        "strict-origin",
        "origin-when-cross-origin",
        "strict-origin-when-cross-origin",
        "unsafe-url",
      ],
      since: 4,
      description: "Which referrer policy applies.",
    },
    stream: {
      kind: "boolean",
      default: false,
      since: 4,
      description:
        "Answer NDJSON head, data and end lines instead of one body, which is how a client saves a large body to a file.",
    },
    timeoutMs: {
      kind: "ms",
      min: 1000,
      max: 300000,
      default: 20000,
      since: 4,
      description:
        "How long the request and its body may take. Above 60000 ms only with stream.",
    },
  },
  events: {
    max: {
      kind: "integer",
      min: 1,
      max: 10000,
      default: 10000,
      since: 4,
      description: "How many of the oldest events to take.",
    },
  },
  cdp: {
    method: {
      kind: "string",
      max: 64,
      required: true,
      since: 4,
      description:
        "The protocol method, such as Page.getNavigationHistory. Commands that reach past this tab's own page and frames are refused.",
    },
    params: {
      kind: "json",
      since: 4,
      description:
        "The command's parameters as an object. Object, context and stream ids must be ones this tab gave the agent.",
    },
    frame: {
      kind: "string",
      max: 160,
      since: 4,
      description:
        "An out-of-process frame to send the command to: an iframe entry's contentFrame path, such as 0/1, or that entry's ref.",
    },
    timeoutMs: {
      kind: "ms",
      min: 1000,
      max: 60000,
      default: 15000,
      since: 4,
      description: "How long to wait for Chromium's answer.",
    },
  },
  spaceCdp: {
    method: {
      kind: "string",
      max: 64,
      required: true,
      since: 4,
      description:
        "The protocol method. Kamapathy answers Target.getTargets and Browser.getVersion itself and refuses every other one.",
    },
    params: {
      kind: "json",
      since: 4,
      description: "The command's parameters as an object.",
    },
  },
  screenshot: {
    fullPage: {
      kind: "boolean",
      default: false,
      since: 3,
      description: "Capture the whole scrollable document, not the viewport.",
    },
    clip: {
      kind: "object",
      since: 3,
      description:
        "The part to capture, in CSS pixels of the image's own space.",
      fields: {
        x: {
          kind: "number",
          min: 0,
          required: true,
          since: 3,
          description: "Distance from the left of that space.",
        },
        y: {
          kind: "number",
          min: 0,
          required: true,
          since: 3,
          description: "Distance from the top of that space.",
        },
        width: {
          kind: "number",
          min: 0,
          required: true,
          since: 3,
          description: "Width in CSS pixels, above 0.",
        },
        height: {
          kind: "number",
          min: 0,
          required: true,
          since: 3,
          description: "Height in CSS pixels, above 0.",
        },
      },
    },
    scale: {
      kind: "enum",
      values: ["css", "device"],
      default: "css",
      since: 3,
      description:
        "css gives one image pixel per CSS pixel; device keeps device pixels.",
    },
    timeoutMs: {
      kind: "ms",
      min: 1,
      max: 60000,
      default: 15000,
      since: 3,
      description: "Most time for the load wait and the capture together.",
    },
  },
};

// A snapshot reads every web frame of the page, so an iframe entry says
// which frame it opens and whether that frame was read, and the snapshot
// counts the frames it left out.
const SNAPSHOT_RESPONSE =
  "snapshot, where an iframe entry adds origin, contentFrame and content, and unreadFrames counts the frames left unread";

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
  label: options.label ?? false,
  since: options.since ?? 1,
});
// An action route takes a label exactly when its fields declare one, so the
// flag and the field can never disagree.
const action = (type, summary, response, options = {}) =>
  route("POST", `/tabs/:id/${type}`, summary, response, FIELDS[type], {
    budget: 30000,
    follow: true,
    label: Object.hasOwn(FIELDS[type], "label"),
    ...options,
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
    "/spaces/:id/status",
    "Shows the person what the agent is doing.",
    "{ ok: true, status? }",
    {
      text: {
        kind: "string",
        min: 0,
        max: 120,
        required: true,
        since: 3,
        description:
          "What the agent is doing now, shown as the agent's words. An empty string clears it.",
      },
    },
    { since: 3 },
  ),
  route(
    "POST",
    "/spaces/:id/fail",
    "Reports that the task cannot be done and hands the space to the person.",
    '{ ok: true, owner: "human", state: "failed", status }',
    {
      message: {
        kind: "string",
        min: 1,
        max: 300,
        required: true,
        since: 3,
        description:
          "Why the task cannot be finished, shown as the agent's words.",
      },
    },
    { since: 3 },
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
          "The page to open: a complete http or https URL, or about:blank. From API level 2 it may be left out for a blank page.",
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
    { follow: true, budget: { field: "timeoutMs" }, since: 4 },
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
        since: 4,
        description:
          "A navigation count from an earlier answer. Without a url, the wait ends once a later commit exists.",
      },
      timeoutMs: waitTimeout,
    },
    { budget: { field: "timeoutMs" }, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/wait-for-load-state",
    "Waits for the document this page shows to reach a state.",
    "{ ok: true, tab: TabView, state }",
    FIELDS["wait-for-load-state"],
    { budget: { field: "timeoutMs" }, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/wait-for-selector",
    "Waits for an element to be attached, visible, hidden or detached.",
    "{ ok: true, tab: TabView, state, matched }",
    FIELDS["wait-for-selector"],
    { budget: { field: "timeoutMs" }, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/wait-for-function",
    "Waits for a function the agent wrote to return a truthy value in the page.",
    "{ ok: true, tab: TabView, value? } or { ok: true, tab: TabView, unserializable }",
    FIELDS["wait-for-function"],
    { budget: { field: "timeoutMs" }, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/evaluate",
    "Runs the agent's own expression or function in the page's main frame.",
    "{ ok: true, tab: TabView, value?: json } or { ok: true, tab: TabView, unserializable } or { ok: true, tab: TabView }",
    FIELDS.evaluate,
    {
      limit: 1048576,
      budget: { field: "timeoutMs" },
      follow: true,
      since: 4,
    },
  ),
  route(
    "POST",
    "/tabs/:id/fetch",
    "Fetches a URL from the page, with its cookies, origin and CORS.",
    "{ ok: true, tab: TabView, response: { ok, status, statusText, url, redirected, type, headers, body } }, or NDJSON head, data and end lines with stream",
    FIELDS.fetch,
    {
      limit: 1048576,
      budget: { field: "timeoutMs" },
      follow: true,
      since: 4,
    },
  ),
  route(
    "POST",
    "/tabs/:id/events",
    "Drains the protocol events recorded for this tab.",
    "{ ok: true, events, dropped, gaps, remaining }",
    FIELDS.events,
    { lane: "none", budget: 10000, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/cdp",
    "Sends one protocol command to the tab's own page or one of its frames.",
    "{ ok: true, result, newSession? }",
    FIELDS.cdp,
    {
      lane: "body",
      limit: 1048576,
      budget: { field: "timeoutMs" },
      follow: true,
      since: 4,
    },
  ),
  route(
    "POST",
    "/spaces/:id/cdp",
    "Answers Target.getTargets for this space's pages and Browser.getVersion.",
    "{ ok: true, result }",
    FIELDS.spaceCdp,
    { lane: "none", budget: 10000, since: 4 },
  ),
  route(
    "GET",
    "/tabs/:id/info",
    "Reads the viewport, scroll offsets, document size and ready state.",
    "{ tab: TabView, viewport: { width, height }, scroll: { x, y }, document: { width, height }, readyState, loading } or { tab: TabView, dialog }",
    null,
    { budget: 10000, follow: false, since: 4 },
  ),
  route(
    "GET",
    "/tabs/:id/snapshot",
    "Reads a compact snapshot.",
    SNAPSHOT_RESPONSE,
    null,
    { budget: 30000, follow: true },
  ),
  route(
    "POST",
    "/tabs/:id/snapshot",
    "Reads bounded page text and controls with refs.",
    SNAPSHOT_RESPONSE,
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
    "Captures the viewport as PNG at CSS scale in any window state, the same as POST with {}.",
    "image/png",
    null,
    { budget: 15000, follow: true },
  ),
  route(
    "POST",
    "/tabs/:id/screenshot",
    "Captures the viewport, the whole page or a clip as PNG, at CSS or device scale.",
    "image/png with X-Kamapathy-Clip and X-Kamapathy-Pixel-Ratio",
    FIELDS.screenshot,
    { budget: { field: "timeoutMs" }, follow: true, since: 3 },
  ),
  action(
    "click",
    "Clicks a control with native mouse input, waiting until it can take the press.",
    "{ ok: true, url, point, loading?, fallback?, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    { budget: { compute: "clickBudget", maxMs: 100100 } },
  ),
  action(
    "dblclick",
    "Double-clicks a control with native mouse input.",
    "{ ok: true, url, point, loading?, fallback?, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    { budget: { compute: "dblclickBudget", maxMs: 90100 }, since: 4 },
  ),
  action(
    "hover",
    "Moves the mouse onto a control and leaves it there.",
    "{ ok: true, point, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    { budget: { field: "timeoutMs", plusMs: 10000 }, since: 4 },
  ),
  action(
    "fill",
    "Replaces the value of a field, select or editable region, or adds to it.",
    "{ ok: true, match, value?, valueHidden?, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    { budget: { field: "timeoutMs", plusMs: 10000 } },
  ),
  action(
    "select",
    "Chooses a select's options by value, label or index.",
    "{ ok: true, values, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    { budget: { field: "timeoutMs", plusMs: 10000 }, since: 4 },
  ),
  action(
    "focus",
    "Focuses a control, retargeting to the nearest one that takes focus.",
    "{ ok: true, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    { budget: { field: "timeoutMs", plusMs: 10000 }, since: 4 },
  ),
  action(
    "press",
    "Presses a key or a chord, focusing a control first when given.",
    "{ ok: true, url, loading?, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    { budget: { compute: "pressBudget", maxMs: 80100 } },
  ),
  action(
    "scroll",
    "Scrolls the page, the panel holding a control, or the panel in the middle.",
    "{ ok: true, scrolled, selector?, x, y, moved, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
  ),
  action(
    "drag",
    "Drags one element onto another, waiting until both ends can take the gesture.",
    "{ ok: true, url, drag, loading?, rebound?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    { budget: { compute: "dragBudget", maxMs: 75100 } },
  ),
  action("wait", "Waits for a visible element, text, or both.", "{ ok: true }"),
  route(
    "POST",
    "/tabs/:id/mouse/move",
    "Moves the mouse to a point, interpolating from where it stands.",
    "{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    FIELDS.mouseMove,
    { budget: { compute: "rawBudget", maxMs: 10000 }, follow: true, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/mouse/down",
    "Presses a mouse button where the pointer stands.",
    "{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    FIELDS.mouseButton,
    { budget: { compute: "rawBudget", maxMs: 10000 }, follow: true, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/mouse/up",
    "Lets a held mouse button go where the pointer stands.",
    "{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    FIELDS.mouseButton,
    { budget: { compute: "rawBudget", maxMs: 10000 }, follow: true, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/mouse/click",
    "Clicks at a point with native mouse input, without resolving a target.",
    "{ ok: true, url, input, loading?, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    FIELDS.mouseClick,
    {
      budget: { compute: "mouseClickBudget", maxMs: 40100 },
      follow: true,
      since: 4,
    },
  ),
  route(
    "POST",
    "/tabs/:id/mouse/wheel",
    "Scrolls with the wheel where the pointer stands.",
    "{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    FIELDS.mouseWheel,
    { budget: { compute: "rawBudget", maxMs: 10000 }, follow: true, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/keyboard/down",
    "Holds one key down and reports the tab's input state.",
    "{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    FIELDS.keyboardKey,
    { budget: { compute: "rawBudget", maxMs: 10000 }, follow: true, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/keyboard/up",
    "Lets one held key go and reports the tab's input state.",
    "{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    FIELDS.keyboardKey,
    { budget: { compute: "rawBudget", maxMs: 10000 }, follow: true, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/keyboard/type",
    "Types text as key events, character by character.",
    "{ ok: true, input, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    FIELDS.keyboardType,
    { budget: { compute: "typeBudget", maxMs: 70000 }, follow: true, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/keyboard/insert-text",
    "Inserts text at the focused editable's caret, without key events.",
    "{ ok: true, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    FIELDS.keyboardInsert,
    { budget: { compute: "rawBudget", maxMs: 10000 }, follow: true, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/keyboard/paste",
    "Pastes text, and optional HTML, without the system clipboard.",
    "{ ok: true, handled, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    FIELDS.keyboardPaste,
    {
      budget: { compute: "rawBudget", maxMs: 10000 },
      limit: 192 * 1024,
      follow: true,
      since: 4,
    },
  ),
  route(
    "POST",
    "/tabs/:id/input/release",
    "Lets go of every key and mouse button this tab holds.",
    "{ ok: true, released }",
    {},
    { budget: 10000, since: 4 },
  ),
  route(
    "POST",
    "/tabs/:id/upload",
    "Selects files on a file input.",
    "{ ok: true, selected, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    {
      ...target,
      files: {
        kind: "array",
        required: true,
        of: uploadFile,
        description: "1 to 8 files, at most 16 MiB together.",
      },
    },
    { budget: 30000, limit: 24 * 1024 * 1024, follow: true },
  ),
  route(
    "POST",
    "/tabs/:id/set-input-files",
    "Puts files on the file input a target names, retargeting from a label or the panel around it, hidden inputs included. An empty list clears the input.",
    "{ ok: true, selected, popups?, dialog?, moreDialogs?, download?, deniedRequests? }",
    {
      ...target,
      files: {
        kind: "array",
        required: true,
        of: uploadFile,
        since: 2,
        description:
          "0 to 8 files, at most 16 MiB together. An empty list clears the selection.",
      },
      timeoutMs: {
        kind: "ms",
        max: 60000,
        default: 3000,
        since: 2,
        description: "How long to wait for the target. 0 looks once.",
      },
    },
    {
      budget: { field: "timeoutMs", plusMs: 10000 },
      limit: 24 * 1024 * 1024,
      follow: true,
      since: 2,
    },
  ),
  route(
    "POST",
    "/file-choosers/:id/files",
    "Files bytes on the input of a file chooser an armed wait received, even one the page has removed. An empty list cancels the chooser.",
    "{ ok: true, selected }",
    {
      files: {
        kind: "array",
        required: true,
        of: uploadFile,
        since: 2,
        description:
          "0 to 8 files, at most 16 MiB together. An empty list cancels the chooser.",
      },
    },
    { budget: 30000, limit: 24 * 1024 * 1024, since: 2 },
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
  route(
    "POST",
    "/tabs/:id/expectations",
    "Arms a wait for the next popup, download, file chooser or dialog in the tab, before the action that causes it.",
    "201 { expectation: { id, event, tabId, expiresAt } }",
    {
      event: {
        kind: "enum",
        values: ["popup", "download", "filechooser", "dialog"],
        required: true,
        since: 2,
        description: "Which event to wait for.",
      },
      timeoutMs: {
        kind: "ms",
        min: 1,
        max: 60000,
        default: 10000,
        since: 2,
        description: "How long the arm lasts, counted from arming.",
      },
    },
    { since: 2 },
  ),
  route(
    "POST",
    "/expectations/:id/wait",
    "Waits for the armed event outside the space's queue, so the action that causes it can run meanwhile.",
    "{ popup: TabView }, { download: Download }, { fileChooser: { id, tabId, multiple, accept } } or { dialog: DialogRecord }",
    {},
    { lane: "none", budget: 60000, since: 2 },
  ),
  route(
    "DELETE",
    "/expectations/:id",
    "Cancels an armed wait and ends the wait running on it.",
    "{ ok: true }",
    null,
    { lane: "none", since: 2 },
  ),
  route(
    "POST",
    "/tabs/:id/dialog-policy",
    "Arms how the tab answers JavaScript dialogs, before the action that opens one. Without a policy, confirms are dismissed and prompts return nothing.",
    "{ policy: { accept, promptText, remaining, expiresAt } }",
    {
      accept: {
        kind: "boolean",
        required: true,
        since: 2,
        description: "true accepts the next confirms and prompts; false dismisses them.",
      },
      promptText: {
        kind: "string",
        min: 0,
        max: 4096,
        since: 2,
        description: "What an accepted prompt returns instead of its default value.",
      },
      times: {
        kind: "integer",
        min: 1,
        max: 20,
        default: 1,
        since: 2,
        description: "How many confirms or prompts the policy answers. Alerts do not count.",
      },
      lifetimeMs: {
        kind: "ms",
        min: 1000,
        max: 600000,
        default: 60000,
        since: 2,
        description: "How long the policy lasts.",
      },
    },
    { since: 2 },
  ),
  route(
    "DELETE",
    "/tabs/:id/dialog-policy",
    "Clears the tab's dialog policy, so its dialogs are dismissed again.",
    "{ policy: null }",
    null,
    { since: 2 },
  ),
  route(
    "GET",
    "/tabs/:id/dialogs",
    "Reads the tab's dialog policy and the last 20 dialogs Kamapathy answered in it, oldest first.",
    "{ policy: { accept, promptText, remaining, expiresAt } | null, dialogs: [{ type, message, defaultValue, answer, promptText, url, at }] }",
    null,
    { lane: "none", since: 2 },
  ),
  route(
    "POST",
    "/spaces/:id/http-credentials",
    "Stores a name and password for one http or https origin, in memory only, to answer the first server sign-in from that origin in the space's own pages. A repeat, a proxy sign-in and a certificate request always go to the person.",
    "{ ok: true, origin }",
    {
      origin: {
        kind: "string",
        max: 2048,
        required: true,
        since: 2,
        description:
          "The origin the credentials belong to, such as https://example.com, with no path, query, fragment or credentials.",
      },
      username: {
        kind: "string",
        max: 256,
        required: true,
        since: 2,
        description: "The name to send.",
      },
      password: {
        kind: "string",
        min: 0,
        max: 1024,
        required: true,
        since: 2,
        description: "The password to send. May be empty.",
      },
    },
    { since: 2 },
  ),
  route(
    "DELETE",
    "/spaces/:id/http-credentials",
    "Forgets every origin the space stored credentials for.",
    "{ ok: true }",
    null,
    { since: 2 },
  ),
  route(
    "GET",
    "/spaces/:id/downloads",
    "Lists the downloads this space holds, newest first. Only downloads an agent armed are kept.",
    "{ downloads: [{ id, tabId, url, suggestedFilename, mimeType, state, receivedBytes, totalBytes, failure }] }",
    null,
    { lane: "none", since: 2 },
  ),
  route(
    "GET",
    "/downloads/:id",
    "Reads one held download and how far it has come.",
    "{ download: { id, tabId, url, suggestedFilename, mimeType, state, receivedBytes, totalBytes, failure } }",
    null,
    { lane: "none", since: 2 },
  ),
  route(
    "POST",
    "/downloads/:id/cancel",
    "Stops a download that is still running. A finished one is left as it is.",
    "{ download: { id, state, receivedBytes, totalBytes, failure } }",
    {},
    { lane: "none", since: 2 },
  ),
  route(
    "DELETE",
    "/downloads/:id",
    "Deletes the download's bytes from the browser's profile.",
    "{ ok: true }",
    null,
    { lane: "none", since: 2 },
  ),
  route(
    "POST",
    "/downloads/:id/wait",
    "Waits until the download stops running, outside the space's queue. Ask again to keep waiting.",
    "{ download: { id, tabId, url, suggestedFilename, mimeType, state, receivedBytes, totalBytes, failure } }",
    {
      timeoutMs: {
        kind: "ms",
        min: 1,
        max: 60000,
        default: 30000,
        description: "How long to wait for the download to finish.",
      },
    },
    { lane: "none", budget: { field: "timeoutMs" }, since: 2 },
  ),
  route(
    "GET",
    "/downloads/:id/content",
    "Reads a finished download's bytes over the socket. The connection drops if the space leaves the agent while it streams.",
    "application/octet-stream with Content-Length, Cache-Control: no-store and X-Content-Type-Options: nosniff",
    null,
    { lane: "none", budget: 60000, since: 2 },
  ),
  route(
    "GET",
    "/tabs/:id/popups",
    "Lists the open pages this page opened, with the ones nothing has reported yet marked unseen.",
    "{ popups: [{ id, label, url, openedAt, unseen? }] }",
    null,
    { lane: "none", since: 2 },
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
    type: "dblclick",
    summary: "Double-clicks a control.",
    fields: FIELDS.dblclick,
    since: 4,
  },
  {
    type: "hover",
    summary: "Moves the mouse onto a control.",
    fields: FIELDS.hover,
    since: 4,
  },
  {
    type: "fill",
    summary: "Replaces a field's value.",
    fields: FIELDS.fill,
    since: 1,
  },
  {
    type: "select",
    summary: "Chooses a select's options.",
    fields: FIELDS.select,
    since: 4,
  },
  {
    type: "press",
    summary: "Presses a key or a chord.",
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
    type: "mouse-click",
    summary: "Clicks at a point, without resolving a target.",
    fields: FIELDS.mouseClick,
    since: 4,
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
    since: 4,
  },
  {
    type: "reload",
    summary:
      "Reloads the page and waits for the new document to reach a state.",
    fields: FIELDS.reload,
    since: 4,
  },
  {
    type: "wait-for-url",
    summary: "Waits for this page's URL to match a glob.",
    fields: FIELDS["wait-for-url"],
    since: 4,
  },
  {
    type: "wait-for-load-state",
    summary: "Waits for the document this page shows to reach a state.",
    fields: FIELDS["wait-for-load-state"],
    since: 4,
  },
  {
    type: "wait-for-selector",
    summary: "Waits for an element to reach a state.",
    fields: FIELDS["wait-for-selector"],
    since: 4,
  },
  {
    type: "wait-for-function",
    summary: "Waits for a page function to return a truthy value.",
    fields: FIELDS["wait-for-function"],
    since: 4,
  },
];

// Budgets that combine several body fields, by name. A route declares one as
// {compute, maxMs}: maxMs is what admission counts, and the request narrows
// its own deadline to the function's answer.
// How long the action waits for a target it can take, from the body or the
// route's own default.
const timeout = (body, fallback) =>
  typeof body.timeoutMs === "number" ? body.timeoutMs : fallback;
// The delay a gesture spends in its gaps: one delayMs per gap.
const gaps = (count, body) =>
  Math.max(0, count) * (typeof body.delayMs === "number" ? body.delayMs : 0);
const clicks = (body) =>
  typeof body.clickCount === "number" ? body.clickCount : 1;
// The settle and the load wait every pressing route adds.
const AFTER_INPUT_MS = 15100;

export const COMPUTE = {
  clickBudget: (body) =>
    timeout(body, 3000) + gaps(2 * clicks(body) - 1, body) + AFTER_INPUT_MS,
  dblclickBudget: (body) =>
    timeout(body, 3000) + gaps(3, body) + AFTER_INPUT_MS,
  dragBudget: (body) => timeout(body, 3000) + AFTER_INPUT_MS,
  pressBudget: (body) =>
    (body.ref || body.selector ? timeout(body, 3000) : 0) +
    gaps(1, body) +
    AFTER_INPUT_MS,
  mouseClickBudget: (body) =>
    gaps(2 * clicks(body) - 1, body) + AFTER_INPUT_MS,
  typeBudget: (body) =>
    10000 +
    (typeof body.delayMs === "number" ? body.delayMs : 0) *
      (typeof body.text === "string" ? body.text.length : 0),
  rawBudget: () => 10000,
};

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
