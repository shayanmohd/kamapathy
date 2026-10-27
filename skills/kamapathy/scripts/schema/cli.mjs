// Every CLI command, with the usage line help prints.

const command = (name, group, usage, summary, extra = {}) => ({
  name,
  group,
  usage,
  summary,
  arguments: extra.arguments ?? [],
  flags: extra.flags ?? [],
  ...(extra.stdin ? { stdin: extra.stdin } : {}),
  ...(extra.route ? { route: extra.route } : {}),
  ...(extra.script ? { script: extra.script } : {}),
  examples: extra.examples ?? [],
  since: extra.since ?? 1,
});
const SPACE_ID = { name: "space-id", description: "A space ID from spaces." };
const TAB_ID = {
  name: "tab-id",
  description:
    "A tab ID from tabs or open, or <space-id>:<label> such as s1:p2.",
};
const TARGET = {
  name: "ref-or-selector",
  description:
    "A ref such as @e3 from a current snapshot, or a selector: CSS, css=, text=, role=, href= or xpath=.",
};
const FILE = {
  name: "file",
  description:
    "A local file to put on the input, up to 8 of them and 16 MiB together.",
};
const DOWNLOAD_ID = {
  name: "id",
  description: "A download ID from downloads or an armed download wait.",
};
const AGENT_URL = {
  name: "url",
  description: "A complete http or https URL, or about:blank.",
};
// The flags navigation and the waits share, each the route field it sets.
const WAIT_UNTIL = {
  name: "--wait-until",
  value: "<state>",
  description:
    "commit, domcontentloaded, load or networkidle. load by default.",
  since: 4,
};
const timeoutFlag = (range) => ({
  name: "--timeout",
  value: "<ms>",
  description: `How long to wait, ${range}.`,
  since: 4,
});
// The action commands take a label anywhere in their arguments.
const LABEL = {
  name: "--label",
  value: "<text>",
  description: "A few words naming this step, in at most 60 characters.",
  since: 3,
};
// The flags the element actions share, named after the client's options.
const BUTTON = {
  name: "--button",
  value: "left|middle|right",
  description: "Which mouse button to press.",
  since: 4,
};
const CLICK_COUNT = {
  name: "--click-count",
  value: "<n>",
  description: "How many presses the one gesture sends, 1 to 3.",
  since: 4,
};
const DELAY = {
  name: "--delay",
  value: "<ms>",
  description: "How long to hold each press, and to wait between presses.",
  since: 4,
};
const POSITION = {
  name: "--position",
  value: "x,y",
  description: "Where in the element to act, instead of its centre.",
  since: 4,
};
const FORCE = {
  name: "--force",
  description:
    "Act even when something covers the target. A disabled target is never forced.",
  since: 4,
};
const TIMEOUT = {
  name: "--timeout",
  value: "<ms>",
  description:
    "How long to wait for a target that can take the input, 0 to 60000. 0 looks once.",
  since: 4,
};
const STDIN = (what) => ({ name: "--stdin", description: `Read ${what}` });
const KEY = {
  name: "key",
  description:
    "A key name such as Enter, KeyA or F12, a printable character, or a chord such as Shift+KeyA.",
};
const POINT = [
  { name: "x", description: "The point's x, in the page's viewport pixels." },
  { name: "y", description: "The point's y, in the page's viewport pixels." },
];

export const COMMANDS = [
  command("health", "Connection", "health", "Check the connection", {
    route: "GET /health",
  }),
  command(
    "upgrade",
    "Connection",
    "upgrade [--check] [--timeout <ms>]",
    "Check for a newer Kamapathy and download its installer for the person to install",
    {
      flags: [
        { name: "--check", description: "Only check; download nothing." },
        {
          name: "--timeout",
          value: "<ms>",
          description:
            "How long to wait for the download, 0 to 1800000, 600000 by default; 0 returns once it starts.",
        },
      ],
      route: "POST /update/download",
      script: "kamapathy.downloadUpdate",
      examples: ["upgrade --check", "upgrade --timeout 0"],
      since: 3,
    },
  ),
  command("spaces", "Spaces", "spaces", "List accessible spaces", {
    route: "GET /spaces",
    script: "spaces",
  }),
  command(
    "space create",
    "Spaces",
    "space create <name> [--isolated]",
    "Create a background agent space, with its own sign-ins when --isolated is given",
    {
      arguments: [
        {
          name: "name",
          description: "The space's name, at most 48 characters.",
        },
      ],
      flags: [
        { name: "--isolated", description: "Give the space its own sign-ins." },
      ],
      route: "POST /spaces",
      script: "createSpace",
    },
  ),
  command(
    "space open",
    "Spaces",
    "space open <name-or-id> [--isolated] [--page-budget <n>]",
    "Reuse the listed space with this ID or name, or create it",
    {
      arguments: [{ name: "name-or-id", description: "A space ID or name." }],
      flags: [
        {
          name: "--isolated",
          description: "Give a new space its own sign-ins.",
        },
        {
          name: "--page-budget",
          value: "<n>",
          description: "Pages the agent may manage at once, 1 to 20.",
        },
      ],
      route: "POST /spaces",
      script: "openSpace",
      since: 2,
    },
  ),
  command(
    "space finish",
    "Spaces",
    "space finish <space-id> --keep all|none|<tab-id>[,<tab-id>]",
    "Close the pages the agent does not keep and end its access",
    {
      arguments: [SPACE_ID],
      flags: [
        {
          name: "--keep",
          value: "all|none|<tab-id>[,<tab-id>]",
          description: "The pages to leave open; labels such as p2 work too.",
        },
      ],
      route: "POST /spaces/:id/finish",
      script: "space.finish",
      since: 2,
    },
  ),
  command(
    "space request",
    "Spaces",
    "space request --reason <text> [--name <name>] [--timeout <ms>]",
    "Ask the person to let an agent use one of their spaces",
    {
      flags: [
        {
          name: "--reason",
          value: "<text>",
          description: "Why, in 1 to 120 characters.",
        },
        {
          name: "--name",
          value: "<name>",
          description: "The space to suggest.",
        },
        {
          name: "--timeout",
          value: "<ms>",
          description: "5000 to 600000, default 600000.",
        },
      ],
      route: "POST /space-requests",
      script: "requestSpace",
      since: 2,
    },
  ),
  command(
    "wait-for-control",
    "Spaces",
    "wait-for-control <space-id> [--timeout <ms>]",
    "Wait until the agent has control again",
    {
      arguments: [SPACE_ID],
      flags: [
        {
          name: "--timeout",
          value: "<ms>",
          description: "0 to 600000, default 600000.",
        },
      ],
      route: "POST /spaces/:id/wait-for-control",
      script: "space.waitForControl",
      since: 2,
    },
  ),
  command(
    "space close",
    "Spaces",
    "space close <space-id>",
    "Close a space and its tabs",
    {
      arguments: [SPACE_ID],
      route: "DELETE /spaces/:id",
      script: "space.close",
    },
  ),
  command(
    "handoff",
    "Spaces",
    "handoff <space-id>",
    "Pause automation for human control",
    {
      arguments: [SPACE_ID],
      route: "POST /spaces/:id/handoff",
      script: "space.handoff",
    },
  ),
  command(
    "resume",
    "Spaces",
    "resume <space-id>",
    "Take control back when the person says to continue",
    {
      arguments: [SPACE_ID],
      route: "POST /spaces/:id/resume",
      script: "space.resume",
    },
  ),
  command(
    "status",
    "Spaces",
    "status <space-id> <text> | status <space-id> --clear",
    "Show the person what the agent is doing",
    {
      arguments: [
        SPACE_ID,
        {
          name: "text",
          description: "What the agent is doing, in at most 120 characters.",
        },
      ],
      flags: [{ name: "--clear", description: "Clear the status." }],
      route: "POST /spaces/:id/status",
      script: "space.setStatus",
      since: 3,
    },
  ),
  command(
    "fail",
    "Spaces",
    "fail <space-id> <message>",
    "Report that the task cannot be done and hand the space to the person",
    {
      arguments: [
        SPACE_ID,
        {
          name: "message",
          description:
            "Why the task cannot be finished, in at most 300 characters.",
        },
      ],
      route: "POST /spaces/:id/fail",
      script: "space.fail",
      since: 3,
    },
  ),
  command("tabs", "Pages", "tabs <space-id>", "List tabs in an agent space", {
    arguments: [SPACE_ID],
    route: "GET /spaces/:id/tabs",
    script: "space.tabs",
  }),
  command("open", "Pages", "open <space-id> <url>", "Open a background tab", {
    arguments: [SPACE_ID, AGENT_URL],
    route: "POST /spaces/:id/tabs",
    script: "space.open",
  }),
  command(
    "new-page",
    "Pages",
    "new-page <space-id>",
    "Open a blank background page",
    {
      arguments: [SPACE_ID],
      route: "POST /spaces/:id/tabs",
      script: "space.newPage",
      since: 2,
    },
  ),
  command(
    "adopt",
    "Pages",
    "adopt <tab-id>",
    "Make a page the agent did not open its own",
    {
      arguments: [TAB_ID],
      route: "POST /tabs/:id/adopt",
      script: "space.adopt",
      since: 2,
    },
  ),
  command(
    "release",
    "Pages",
    "release <tab-id>",
    "Give a page back to the person, leaving it open",
    {
      arguments: [TAB_ID],
      route: "POST /tabs/:id/release",
      script: "space.release",
      since: 2,
    },
  ),
  command(
    "navigate",
    "Pages",
    "navigate <tab-id> <url> [--wait-until <state>] [--timeout <ms>] [--referer <url>]",
    "Navigate a tab and wait for the new document, at commit unless --wait-until says otherwise",
    {
      arguments: [TAB_ID, AGENT_URL],
      flags: [
        WAIT_UNTIL,
        timeoutFlag("1 to 60000, default 15000"),
        {
          name: "--referer",
          value: "<url>",
          description: "The Referer header to send, exactly as given.",
          since: 4,
        },
      ],
      route: "POST /tabs/:id/navigate",
      script: "page.navigate",
    },
  ),
  command(
    "reload",
    "Pages",
    "reload <tab-id> [--wait-until <state>] [--timeout <ms>] [--ignore-cache]",
    "Reload the page and wait for the new document",
    {
      arguments: [TAB_ID],
      flags: [
        WAIT_UNTIL,
        timeoutFlag("1 to 60000, default 15000"),
        {
          name: "--ignore-cache",
          description: "Fetch the page and its subresources past the cache",
          since: 4,
        },
      ],
      route: "POST /tabs/:id/reload",
      script: "page.reload",
      since: 4,
    },
  ),
  command(
    "info",
    "Pages",
    "info <tab-id>",
    "Read the viewport, scroll offsets, document size and ready state",
    {
      arguments: [TAB_ID],
      route: "GET /tabs/:id/info",
      script: "page.info",
      since: 4,
    },
  ),
  command("close", "Pages", "close <tab-id>", "Close a tab", {
    arguments: [TAB_ID],
    route: "DELETE /tabs/:id",
    script: "page.close",
  }),
  command(
    "snapshot",
    "Page actions",
    "snapshot <tab-id> [--full] [--selector <selector>] [--root <ref>] [--viewport] [--outline] [--locators] [--no-header] [--cursor <cursor>] [--max-chars n] [--max-controls n] [--json]",
    "Read bounded page text and control refs",
    {
      arguments: [TAB_ID],
      flags: [
        { name: "--full", description: "Request the larger snapshot mode" },
        {
          name: "--selector",
          value: "<selector>",
          description: "Scope the snapshot to one element, of any form",
        },
        {
          name: "--root",
          value: "<ref>",
          description:
            "Scope to a ref's subtree, or a frame ref's document; not with --selector",
          since: 3,
        },
        {
          name: "--viewport",
          description: "Keep only what is on screen",
          since: 3,
        },
        {
          name: "--outline",
          description: "Print the page's structure instead of its text",
          since: 3,
        },
        {
          name: "--locators",
          description: "Give each control a selector that names it alone",
          since: 3,
        },
        {
          name: "--no-header",
          description: "Leave out the page, space and tabs line",
          since: 3,
        },
        {
          name: "--cursor",
          value: "<cursor>",
          description: "Read the part after an earlier one's next cursor",
          since: 3,
        },
        {
          name: "--max-chars",
          value: "<n>",
          description: "Override the text bound",
        },
        {
          name: "--max-controls",
          value: "<n>",
          description: "Override the control bound",
        },
      ],
      route: "POST /tabs/:id/snapshot",
      script: "page.snapshot",
    },
  ),
  command(
    "click",
    "Page actions",
    "click <tab-id> <ref-or-selector> [--button left|middle|right] [--click-count <n>] [--delay <ms>] [--position x,y] [--force] [--timeout <ms>] [--label <text>]",
    "Click a control, waiting until it can take the press",
    {
      arguments: [TAB_ID, TARGET],
      flags: [BUTTON, CLICK_COUNT, DELAY, POSITION, FORCE, TIMEOUT, LABEL],
      route: "POST /tabs/:id/click",
      script: "page.click",
    },
  ),
  command(
    "dblclick",
    "Page actions",
    "dblclick <tab-id> <ref-or-selector> [--button left|middle|right] [--delay <ms>] [--position x,y] [--force] [--timeout <ms>] [--label <text>]",
    "Double-click a control with one gesture of two presses",
    {
      arguments: [TAB_ID, TARGET],
      flags: [BUTTON, DELAY, POSITION, FORCE, TIMEOUT, LABEL],
      route: "POST /tabs/:id/dblclick",
      script: "page.dblclick",
      since: 4,
    },
  ),
  command(
    "hover",
    "Page actions",
    "hover <tab-id> <ref-or-selector> [--position x,y] [--force] [--timeout <ms>] [--label <text>]",
    "Move the mouse onto a control and leave it there",
    {
      arguments: [TAB_ID, TARGET],
      flags: [POSITION, FORCE, TIMEOUT, LABEL],
      route: "POST /tabs/:id/hover",
      script: "page.hover",
      since: 4,
    },
  ),
  command(
    "fill",
    "Page actions",
    "fill <tab-id> <ref-or-selector> --stdin [--append] [--timeout <ms>] [--label <text>]",
    "Read the exact field value from stdin",
    {
      arguments: [TAB_ID, TARGET],
      flags: [
        STDIN("the field value from stdin"),
        {
          name: "--append",
          description: "Add to the field's value instead of replacing it.",
          since: 4,
        },
        TIMEOUT,
        LABEL,
      ],
      stdin: "The exact field value.",
      route: "POST /tabs/:id/fill",
      script: "page.fill",
    },
  ),
  command(
    "select",
    "Page actions",
    "select <tab-id> <ref-or-selector> [choice...] [--timeout <ms>] [--label <text>]",
    "Choose a select's options by value or label; no choice clears it",
    {
      arguments: [
        TAB_ID,
        TARGET,
        {
          name: "choice",
          description:
            "An option's value, else its label. Up to 100, in any order.",
        },
      ],
      flags: [TIMEOUT, LABEL],
      route: "POST /tabs/:id/select",
      script: "page.selectOption",
      examples: ["select 8c1f2e04:p2 @e4 pro"],
      since: 4,
    },
  ),
  command(
    "focus",
    "Page actions",
    "focus <tab-id> <ref-or-selector> [--timeout <ms>] [--label <text>]",
    "Focus a control, retargeting to the nearest one that takes focus",
    {
      arguments: [TAB_ID, TARGET],
      flags: [TIMEOUT, LABEL],
      route: "POST /tabs/:id/focus",
      script: "page.focus",
      since: 4,
    },
  ),
  command(
    "upload",
    "Page actions",
    "upload <tab-id> <ref> <file> [files]",
    "Select up to 8 files, 16 MiB total",
    {
      arguments: [
        TAB_ID,
        {
          name: "ref",
          description: "A file input ref from a current snapshot.",
        },
        { name: "file", description: "One to 8 local files." },
      ],
      route: "POST /tabs/:id/upload",
      script: "page.upload",
    },
  ),
  command(
    "press",
    "Page actions",
    "press <tab-id> <key> [ref-or-selector] [--delay <ms>] [--timeout <ms>] [--label <text>]",
    "Press a key, a printable character or a chord",
    {
      arguments: [TAB_ID, KEY, TARGET],
      flags: [
        {
          ...DELAY,
          description: "How long to hold the key before releasing it.",
        },
        TIMEOUT,
        LABEL,
      ],
      route: "POST /tabs/:id/press",
      script: "page.press",
      examples: ["press 8c1f2e04:p2 ControlOrMeta+KeyS"],
    },
  ),
  command(
    "drag",
    "Page actions",
    "drag <tab-id> <source> <target> [--source-position x,y] [--target-position x,y] [--button left|middle|right] [--force] [--timeout <ms>] [--label <text>]",
    "Drag one element onto another (refs or selectors)",
    {
      arguments: [
        TAB_ID,
        { name: "source", description: "The element to drag." },
        { name: "target", description: "The element to drop on." },
      ],
      flags: [
        {
          ...POSITION,
          name: "--source-position",
          description: "Where in the source to press, instead of its centre.",
        },
        {
          ...POSITION,
          name: "--target-position",
          description: "Where in the target to drop, instead of its centre.",
        },
        BUTTON,
        FORCE,
        TIMEOUT,
        LABEL,
      ],
      route: "POST /tabs/:id/drag",
      script: "page.dragAndDrop",
    },
  ),
  command(
    "scroll",
    "Page actions",
    "scroll <tab-id> <direction> [pixels] [ref-or-selector] [--label <text>]",
    "Scroll up, down, left or right: the page, the panel holding a control, or the panel in the middle when the page cannot scroll",
    {
      arguments: [
        TAB_ID,
        { name: "direction", description: "up, down, left or right." },
        { name: "pixels", description: "1 to 2000, default 600." },
        TARGET,
      ],
      flags: [LABEL],
      route: "POST /tabs/:id/scroll",
      script: "page.scroll",
    },
  ),
  command(
    "wait",
    "Page actions",
    "wait <tab-id> --stdin",
    "Read wait options as JSON from stdin",
    {
      arguments: [TAB_ID],
      flags: [{ name: "--stdin", description: "Read the options from stdin" }],
      stdin: "A JSON object with selector, text and timeoutMs.",
      route: "POST /tabs/:id/wait",
      script: "page.wait",
    },
  ),
  command(
    "wait-for-url",
    "Page actions",
    "wait-for-url <tab-id> <glob> [--wait-until <state>] [--timeout <ms>]",
    "Wait for this page's URL to match a glob, then for the state asked for",
    {
      arguments: [
        TAB_ID,
        {
          name: "glob",
          description:
            "A glob for the whole URL: * inside a path segment, ** across segments, {a,b} for one alternative.",
        },
      ],
      flags: [
        WAIT_UNTIL,
        timeoutFlag("0 to 60000, default 10000; 0 checks once"),
      ],
      route: "POST /tabs/:id/wait-for-url",
      script: "page.waitForURL",
      examples: ['wait-for-url 8c1f2e04:p2 "https://example.com/**/done"'],
      since: 4,
    },
  ),
  command(
    "wait-for-load-state",
    "Page actions",
    "wait-for-load-state <tab-id> [state] [--idle <ms>] [--timeout <ms>]",
    "Wait for the document the page shows to reach a state",
    {
      arguments: [
        TAB_ID,
        {
          name: "state",
          description:
            "commit, domcontentloaded, load or networkidle. load by default.",
        },
      ],
      flags: [
        {
          name: "--idle",
          value: "<ms>",
          description:
            "How long nothing may be in flight before networkidle answers, 0 to 10000, default 500.",
          since: 4,
        },
        timeoutFlag("0 to 60000, default 10000; 0 checks once"),
      ],
      route: "POST /tabs/:id/wait-for-load-state",
      script: "page.waitForLoadState",
      since: 4,
    },
  ),
  command(
    "wait-for-selector",
    "Page actions",
    "wait-for-selector <tab-id> <ref-or-selector> [--state <state>] [--timeout <ms>]",
    "Wait for an element to be attached, visible, hidden or detached",
    {
      arguments: [TAB_ID, TARGET],
      flags: [
        {
          name: "--state",
          value: "<state>",
          description:
            "attached, visible, hidden or detached. visible by default.",
          since: 4,
        },
        timeoutFlag("0 to 60000, default 10000; 0 checks once"),
      ],
      route: "POST /tabs/:id/wait-for-selector",
      script: "page.waitForSelector",
      examples: ["wait-for-selector 8c1f2e04:p2 text=Confirmed"],
      since: 4,
    },
  ),
  command(
    "wait-for-function",
    "Page actions",
    "wait-for-function <tab-id> --stdin [--interval <ms>] [--timeout <ms>]",
    "Read an expression from stdin and wait for it to be truthy in the page",
    {
      arguments: [TAB_ID],
      flags: [
        {
          name: "--stdin",
          description: "Read the expression from stdin",
          since: 4,
        },
        {
          name: "--interval",
          value: "<ms>",
          description: "How long between checks, 10 to 10000, default 100.",
          since: 4,
        },
        timeoutFlag("0 to 60000, default 10000; 0 checks once"),
      ],
      stdin: "An expression to evaluate in the page.",
      route: "POST /tabs/:id/wait-for-function",
      script: "page.waitForFunction",
      since: 4,
    },
  ),
  command(
    "batch",
    "Page actions",
    "batch <tab-id>",
    "Read an actions array or {actions} JSON",
    {
      arguments: [TAB_ID],
      stdin: "A JSON array of 1 to 20 actions, or an object with actions.",
      route: "POST /tabs/:id/actions",
      script: "page.batch",
    },
  ),
  command(
    "screenshot",
    "Page actions",
    "screenshot <tab-id> <file.png> [--full-page] [--clip x,y,width,height] [--scale css|device]",
    "Save a PNG of the viewport, the whole page or a clip, without overwriting",
    {
      arguments: [
        TAB_ID,
        { name: "file.png", description: "A new file ending in .png." },
      ],
      flags: [
        {
          name: "--full-page",
          description: "Capture the whole scrollable document",
          since: 3,
        },
        {
          name: "--clip",
          value: "x,y,width,height",
          description: "Capture this part, in CSS pixels of the image's space",
          since: 3,
        },
        {
          name: "--scale",
          value: "css|device",
          description:
            "css gives one image pixel per CSS pixel; device keeps device pixels",
          since: 3,
        },
      ],
      route: "GET /tabs/:id/screenshot",
      script: "page.screenshot",
    },
  ),
  command(
    "pdf-text",
    "Page actions",
    "pdf-text <tab-id> [--from <n>] [--to <n>] [--max-chars <n>] [--timeout <ms>]",
    "Read a PDF's text by page",
    {
      arguments: [TAB_ID],
      flags: [
        {
          name: "--from",
          value: "<n>",
          description: "The first page to read, 1 to 100000, default 1.",
        },
        {
          name: "--to",
          value: "<n>",
          description: "The last page, at most 499 after --from.",
        },
        {
          name: "--max-chars",
          value: "<n>",
          description: "Most characters to return, 0 to 1000000, default 20000.",
        },
        {
          name: "--timeout",
          value: "<ms>",
          description: "0 to 60000, default 15000.",
        },
      ],
      route: "POST /tabs/:id/pdf/text",
      script: "page.pdfText",
      examples: ["pdf-text 8c1f2e04:p2 --from 3"],
      since: 3,
    },
  ),
  command(
    "expect",
    "Events and dialogs",
    "expect <tab-id> <event> [--timeout <ms>]",
    "Arm a wait for the tab's next popup, download, file chooser or dialog, before the action that causes it",
    {
      arguments: [
        TAB_ID,
        {
          name: "event",
          description: "popup, download, filechooser or dialog.",
        },
      ],
      flags: [
        {
          name: "--timeout",
          value: "<ms>",
          description: "How long the arm lasts, 1 to 60000, 60000 by default.",
          since: 2,
        },
      ],
      route: "POST /tabs/:id/expectations",
      script: "page.waitForEvent",
      examples: ["expect 8c1f2e04:p2 popup"],
      since: 2,
    },
  ),
  command(
    "wait-expectation",
    "Events and dialogs",
    "wait-expectation <id>",
    "Wait for an armed event and print the popup, download, file chooser or dialog that arrived",
    {
      arguments: [
        { name: "id", description: "An expectation ID from expect." },
      ],
      route: "POST /expectations/:id/wait",
      examples: ["wait-expectation 4f2a9c71b3d05e68"],
      since: 2,
    },
  ),
  command(
    "dialog-policy",
    "Events and dialogs",
    "dialog-policy <tab-id> accept|dismiss|reset [--times <n>] [--lifetime <ms>] [--prompt-stdin]",
    "Arm how the tab answers its next confirms and prompts, or clear the policy with reset",
    {
      arguments: [
        TAB_ID,
        {
          name: "answer",
          description:
            "accept answers yes, dismiss answers no, reset clears the policy.",
        },
      ],
      flags: [
        {
          name: "--times",
          value: "<n>",
          description:
            "How many confirms or prompts to answer, 1 to 20, 1 by default.",
          since: 2,
        },
        {
          name: "--lifetime",
          value: "<ms>",
          description:
            "How long the policy lasts, 1000 to 600000, 60000 by default.",
          since: 2,
        },
        {
          name: "--prompt-stdin",
          description:
            "Read what an accepted prompt returns from standard input.",
          since: 2,
        },
      ],
      stdin: "What an accepted prompt returns, with --prompt-stdin.",
      route: "POST /tabs/:id/dialog-policy",
      script: "page.setDialogPolicy",
      examples: ["dialog-policy 8c1f2e04:p2 accept --times 2"],
      since: 2,
    },
  ),
  command(
    "dialogs",
    "Events and dialogs",
    "dialogs <tab-id>",
    "Print the tab's dialog policy and the dialogs Kamapathy answered in it",
    {
      arguments: [TAB_ID],
      route: "GET /tabs/:id/dialogs",
      script: "page.dialogs",
      since: 2,
    },
  ),
  command(
    "set-input-files",
    "Page actions",
    "set-input-files <tab-id> <target> [file...]",
    "Put files on the file input a ref or selector names, hidden ones included; no file clears the selection",
    {
      arguments: [TAB_ID, TARGET, FILE],
      route: "POST /tabs/:id/set-input-files",
      script: "page.setInputFiles",
      examples: ["set-input-files 8c1f2e04:p2 #resume ./resume.pdf"],
      since: 2,
    },
  ),
  command(
    "set-files",
    "Page actions",
    "set-files <chooser-id> [file...]",
    "Put files on the input of a file chooser an armed wait received; no file cancels the chooser",
    {
      arguments: [
        {
          name: "chooser-id",
          description: "A file chooser ID from wait-expectation.",
        },
        FILE,
      ],
      route: "POST /file-choosers/:id/files",
      script: "fileChooser.setFiles",
      since: 2,
    },
  ),
  command(
    "download",
    "Downloads",
    "download <tab-id> <target> <path> [--timeout <ms>]",
    "Arm a download wait, click the target, and save the file that arrives to a new path",
    {
      arguments: [
        TAB_ID,
        TARGET,
        {
          name: "path",
          description: "A new file to write; it is never overwritten.",
        },
      ],
      flags: [
        {
          name: "--timeout",
          value: "<ms>",
          description:
            "How long to wait for the download, 1 to 60000, 60000 by default.",
          since: 2,
        },
      ],
      route: "GET /downloads/:id/content",
      script: "download.saveAs",
      examples: ["download 8c1f2e04:p2 text=Export ./export.csv"],
      since: 2,
    },
  ),
  command(
    "downloads",
    "Downloads",
    "downloads <space-id>",
    "List the downloads a space holds, newest first",
    {
      arguments: [SPACE_ID],
      route: "GET /spaces/:id/downloads",
      script: "space.downloads",
      since: 2,
    },
  ),
  command(
    "save-download",
    "Downloads",
    "save-download <id> <path>",
    "Wait for a held download to finish and write its bytes to a new path",
    {
      arguments: [
        DOWNLOAD_ID,
        {
          name: "path",
          description: "A new file to write; it is never overwritten.",
        },
      ],
      route: "GET /downloads/:id/content",
      script: "download.saveAs",
      since: 2,
    },
  ),
  command(
    "cancel-download",
    "Downloads",
    "cancel-download <id>",
    "Stop a download that is still running",
    {
      arguments: [DOWNLOAD_ID],
      route: "POST /downloads/:id/cancel",
      script: "download.cancel",
      since: 2,
    },
  ),
  command(
    "delete-download",
    "Downloads",
    "delete-download <id>",
    "Delete a held download's bytes from the browser's profile",
    {
      arguments: [DOWNLOAD_ID],
      route: "DELETE /downloads/:id",
      script: "download.delete",
      since: 2,
    },
  ),
  command(
    "http-credentials",
    "Spaces",
    "http-credentials <space-id> <origin> --stdin | http-credentials <space-id> clear",
    "Store a name and password for one origin in memory, to answer its first server sign-in in this space, or forget every origin",
    {
      arguments: [
        SPACE_ID,
        {
          name: "origin",
          description:
            "An http or https origin such as https://example.com, with no path, or clear to forget them all.",
        },
      ],
      flags: [
        {
          name: "--stdin",
          description:
            "Read JSON with username and password from standard input.",
          since: 2,
        },
      ],
      stdin: "JSON with a username and a password, with --stdin.",
      route: "POST /spaces/:id/http-credentials",
      script: "space.setHTTPCredentials",
      examples: ["http-credentials 8c1f2e04 https://intranet.example --stdin"],
      since: 2,
    },
  ),
  command(
    "mouse-move",
    "Mouse and keyboard",
    "mouse-move <tab-id> <x> <y> [--steps <n>]",
    "Move the pointer to a point, interpolating from where it stands",
    {
      arguments: [TAB_ID, ...POINT],
      flags: [
        {
          name: "--steps",
          value: "<n>",
          description: "How many moves to send, 1 to 100.",
          since: 4,
        },
      ],
      route: "POST /tabs/:id/mouse/move",
      script: "page.mouse.move",
      since: 4,
    },
  ),
  command(
    "mouse-down",
    "Mouse and keyboard",
    "mouse-down <tab-id> [--button left|middle|right] [--click-count <n>]",
    "Press a mouse button where the pointer stands",
    {
      arguments: [TAB_ID],
      flags: [BUTTON, CLICK_COUNT],
      route: "POST /tabs/:id/mouse/down",
      script: "page.mouse.down",
      since: 4,
    },
  ),
  command(
    "mouse-up",
    "Mouse and keyboard",
    "mouse-up <tab-id> [--button left|middle|right] [--click-count <n>]",
    "Let a held mouse button go where the pointer stands",
    {
      arguments: [TAB_ID],
      flags: [BUTTON, CLICK_COUNT],
      route: "POST /tabs/:id/mouse/up",
      script: "page.mouse.up",
      since: 4,
    },
  ),
  command(
    "mouse-click",
    "Mouse and keyboard",
    "mouse-click <tab-id> <x> <y> [--button left|middle|right] [--click-count <n>] [--delay <ms>]",
    "Click at a point, without resolving a target",
    {
      arguments: [TAB_ID, ...POINT],
      flags: [BUTTON, CLICK_COUNT, DELAY],
      route: "POST /tabs/:id/mouse/click",
      script: "page.mouse.click",
      since: 4,
    },
  ),
  command(
    "mouse-wheel",
    "Mouse and keyboard",
    "mouse-wheel <tab-id> <delta-x> <delta-y>",
    "Scroll with the wheel where the pointer stands",
    {
      arguments: [
        TAB_ID,
        { name: "delta-x", description: "How far to scroll right." },
        { name: "delta-y", description: "How far to scroll down." },
      ],
      route: "POST /tabs/:id/mouse/wheel",
      script: "page.mouse.wheel",
      examples: ["mouse-wheel 8c1f2e04:p2 0 240"],
      since: 4,
    },
  ),
  command(
    "key-down",
    "Mouse and keyboard",
    "key-down <tab-id> <key>",
    "Hold one key down, so later input carries it",
    {
      arguments: [TAB_ID, KEY],
      route: "POST /tabs/:id/keyboard/down",
      script: "page.keyboard.down",
      since: 4,
    },
  ),
  command(
    "key-up",
    "Mouse and keyboard",
    "key-up <tab-id> <key>",
    "Let one held key go",
    {
      arguments: [TAB_ID, KEY],
      route: "POST /tabs/:id/keyboard/up",
      script: "page.keyboard.up",
      since: 4,
    },
  ),
  command(
    "type",
    "Mouse and keyboard",
    "type <tab-id> --stdin [--delay <ms>]",
    "Type text from stdin where the focus is, character by character",
    {
      arguments: [TAB_ID],
      flags: [
        STDIN("the text from stdin"),
        {
          ...DELAY,
          description: "How long to wait between characters, 0 to 1000.",
        },
      ],
      stdin: "The exact text to type, at most 2000 characters.",
      route: "POST /tabs/:id/keyboard/type",
      script: "page.keyboard.type",
      since: 4,
    },
  ),
  command(
    "insert-text",
    "Mouse and keyboard",
    "insert-text <tab-id> --stdin",
    "Insert text from stdin at the focused editable's caret",
    {
      arguments: [TAB_ID],
      flags: [STDIN("the text from stdin")],
      stdin: "The exact text to insert, at most 16384 characters.",
      route: "POST /tabs/:id/keyboard/insert-text",
      script: "page.keyboard.insertText",
      since: 4,
    },
  ),
  command(
    "paste",
    "Mouse and keyboard",
    "paste <tab-id> --stdin [--html]",
    "Offer the page a paste of stdin, without the system clipboard",
    {
      arguments: [TAB_ID],
      flags: [
        STDIN("the text from stdin"),
        {
          name: "--html",
          description: "Read a JSON object with text and html from stdin.",
          since: 4,
        },
      ],
      stdin:
        "The text to paste, or with --html a JSON object with text and html.",
      route: "POST /tabs/:id/keyboard/paste",
      script: "page.keyboard.paste",
      since: 4,
    },
  ),
  command(
    "release-input",
    "Mouse and keyboard",
    "release-input <tab-id>",
    "Let go of every key and mouse button the page holds",
    {
      arguments: [TAB_ID],
      route: "POST /tabs/:id/input/release",
      script: "page.releaseInput",
      since: 4,
    },
  ),
  command(
    "evaluate",
    "Pages",
    "evaluate <tab-id> --stdin [--timeout <ms>]",
    "Run an expression in the page and print its value",
    {
      arguments: [TAB_ID],
      flags: [
        {
          name: "--stdin",
          description: "Read the expression from stdin",
          since: 4,
        },
        {
          name: "--timeout",
          value: "<ms>",
          description:
            "How long the expression may run, 2000 to 60000, default 15000.",
          since: 4,
        },
      ],
      stdin:
        "An expression to run in the page's main frame, at most 1 MiB. It may use await.",
      route: "POST /tabs/:id/evaluate",
      script: "page.evaluate",
      since: 4,
    },
  ),
  command(
    "fetch",
    "Pages",
    'fetch <tab-id> <url> [--method <m>] [--header "Name: value"]... [--stdin] [--save <file>] [--timeout <ms>]',
    "Fetch a URL with the page's cookies and CORS",
    {
      arguments: [
        TAB_ID,
        {
          name: "url",
          description: "The URL to fetch, absolute or relative to the page's.",
        },
      ],
      flags: [
        {
          name: "--method",
          value: "<m>",
          description: "The request method, GET by default.",
          since: 4,
        },
        {
          name: "--header",
          value: '"Name: value"',
          description: "A request header. Repeat it for more, up to 64.",
          since: 4,
        },
        {
          name: "--stdin",
          description: "Read the request body from stdin, at most 1 MiB.",
          since: 4,
        },
        {
          name: "--save",
          value: "<file>",
          description:
            "Stream the body into this new file instead of printing it. It is never overwritten.",
          since: 4,
        },
        {
          name: "--timeout",
          value: "<ms>",
          description:
            "How long the request and its body may take, 1000 to 60000, default 20000; up to 300000 with --save.",
          since: 4,
        },
      ],
      stdin: "The request body, with --stdin.",
      route: "POST /tabs/:id/fetch",
      script: "page.fetch",
      since: 4,
    },
  ),
  command(
    "cdp",
    "Pages",
    "cdp <tab-id> <method> [--stdin] [--frame <path-or-ref>] [--timeout <ms>]",
    "Send one protocol command to the page or one of its frames",
    {
      arguments: [
        TAB_ID,
        {
          name: "method",
          description: "A protocol method, such as Page.getNavigationHistory.",
        },
      ],
      flags: [
        {
          name: "--stdin",
          description: "Read the command's params from stdin",
          since: 4,
        },
        {
          name: "--frame",
          value: "<path-or-ref>",
          description:
            "Send it to a frame in its own process: an iframe entry's contentFrame, such as 0/1, or its ref.",
          since: 4,
        },
        {
          name: "--timeout",
          value: "<ms>",
          description:
            "How long to wait for Chromium's answer, 1000 to 60000, default 15000.",
          since: 4,
        },
      ],
      stdin: "The command's params as a JSON object, at most 64 KiB.",
      route: "POST /tabs/:id/cdp",
      script: "page.cdp",
      since: 4,
    },
  ),
  command(
    "space cdp",
    "Spaces",
    "space cdp <space-id> <method> [--stdin]",
    "Ask Kamapathy for this space's pages or its versions",
    {
      arguments: [
        SPACE_ID,
        {
          name: "method",
          description: "Target.getTargets or Browser.getVersion.",
        },
      ],
      flags: [
        {
          name: "--stdin",
          description: "Read the command's params from stdin",
          since: 4,
        },
      ],
      stdin: "The command's params as a JSON object, at most 64 KiB.",
      route: "POST /spaces/:id/cdp",
      script: "space.cdp",
      since: 4,
    },
  ),
  command(
    "events",
    "Pages",
    "events <tab-id> [--max <n>]",
    "Drain the protocol events recorded for the page",
    {
      arguments: [TAB_ID],
      flags: [
        {
          name: "--max",
          value: "<n>",
          description:
            "How many of the oldest events to take, 1 to 10000, default 10000.",
          since: 4,
        },
      ],
      route: "POST /tabs/:id/events",
      script: "page.events",
      since: 4,
    },
  ),
  command(
    "clear-site-data",
    "Pages",
    "clear-site-data <tab-id> [--origin <o>] [--cookies | --cookie <name>]... [--storage] [--cache] [--timeout <ms>]",
    "Clear one site's cookies, storage or cache",
    {
      arguments: [TAB_ID],
      flags: [
        {
          name: "--origin",
          value: "<o>",
          description:
            "The http or https origin to clear, the page's own by default.",
          since: 4,
        },
        {
          name: "--cookies",
          description: "Clear every cookie the origin receives.",
          since: 4,
        },
        {
          name: "--cookie",
          value: "<name>",
          description: "Clear the origin's cookies of this name. Repeat it for more.",
          since: 4,
        },
        {
          name: "--storage",
          description: "Clear the origin's storage.",
          since: 4,
        },
        {
          name: "--cache",
          description: "Clear the origin's HTTP cache.",
          since: 4,
        },
        {
          name: "--timeout",
          value: "<ms>",
          description:
            "How long the person has to answer in a space that uses their sign-ins, 1000 to 300000, default 60000.",
          since: 4,
        },
      ],
      route: "POST /tabs/:id/clear-site-data",
      script: "page.clearSiteData",
      since: 4,
    },
  ),
  command(
    "run",
    "Scripts",
    "run [--ts] [--timeout <ms>] [--env-file <path>]... <file.mjs>",
    "Run a script with the client as the globals kamapathy, createSpace, openSpace, space, spaces and requestSpace; run - reads it from stdin and run -e <code> runs the code itself",
    {
      arguments: [
        {
          name: "file.mjs",
          description: "The script, or - to read it from stdin.",
        },
      ],
      flags: [
        { name: "-e", value: "<code>", description: "Run the code itself" },
        {
          name: "--timeout",
          value: "<ms>",
          description:
            "Stop the script after this long, 1000 to 3600000, default 300000 or KAMAPATHY_RUN_TIMEOUT_MS.",
        },
        {
          name: "--ts",
          description: "Read the code of run - or run -e as TypeScript.",
          since: 2,
        },
        {
          name: "--env-file",
          value: "<path>",
          description:
            "Load more variables after the workspace's .env; repeat for several files.",
          since: 2,
        },
      ],
      stdin: "The script, with run -.",
    },
  ),
  command(
    "repl",
    "Scripts",
    "repl [--env-file <path>]...",
    "Start a scripting session in a terminal, with the same globals as run",
    {
      flags: [
        {
          name: "--env-file",
          value: "<path>",
          description: "Load more variables after the workspace's .env.",
        },
      ],
      since: 2,
    },
  ),
  command(
    "workspace",
    "Scripts",
    "workspace [--json]",
    "Print the workspace folder, creating it with mode 0700 when missing",
    { since: 2 },
  ),
  command(
    "sites",
    "Scripts",
    "sites [<url-or-host>] [--json]",
    "List the site packs, or the notes and tools for one site",
    {
      arguments: [
        {
          name: "url-or-host",
          description: "A page's URL or a host such as github.com.",
        },
      ],
      script: "siteContext",
      examples: ["sites", "sites https://github.com/kamapathy"],
      since: 4,
    },
  ),
  command(
    "sites check",
    "Scripts",
    "sites check [<pack-id-or-folder>]... [--json]",
    "Check every site pack, or the ones named, and report each problem",
    {
      arguments: [
        {
          name: "pack-id-or-folder",
          description: "A pack id, or a folder path holding a pack.json.",
        },
      ],
      examples: ["sites check", "sites check github"],
      since: 4,
    },
  ),
  command("help", "Help", "help [topic]", "Show the commands, or help on one", {
    arguments: [
      {
        name: "topic",
        description:
          "A command such as space create, api, errors, routes, or a script entry such as page.click.",
      },
    ],
  }),
];

// Options every command takes.
export const GLOBAL_FLAGS = [
  { name: "--json", description: "Print compact JSON for programs." },
  { name: "--help, -h", description: "Show help for the command." },
  {
    name: "--version, -v",
    description: "Show the client's, the skill's and Kamapathy's versions.",
  },
  { name: "--", description: "Read every later argument literally." },
];

// Variables the client reads.
export const ENVIRONMENT = [
  {
    name: "KAMAPATHY_USER_DATA",
    description: "The Kamapathy profile folder to use.",
  },
  {
    name: "KAMAPATHY_NO_LAUNCH",
    description: "Set to 1 to never start Kamapathy.",
  },
  {
    name: "KAMAPATHY_WORKSPACE",
    description: "The scripting workspace, by default inside the profile.",
  },
  {
    name: "KAMAPATHY_RUN_TIMEOUT_MS",
    description: "How long run lets a script take, 300000 by default.",
  },
  {
    name: "KAMAPATHY_PAGE_BUDGET",
    description: "The page budget new and reused spaces get, 1 to 20.",
  },
  {
    name: "KAMAPATHY_PROGRAM",
    description: "Set by the launchers so help names the program kamapathy.",
  },
];
