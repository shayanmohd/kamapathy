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
  command("tabs", "Pages", "tabs <space-id>", "List tabs in an agent space", {
    arguments: [SPACE_ID],
    route: "GET /spaces/:id/tabs",
    script: "space.tabs",
  }),
  command("open", "Pages", "open <space-id> <url>", "Open a background tab", {
    arguments: [
      SPACE_ID,
      { name: "url", description: "A complete http or https URL." },
    ],
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
  command("navigate", "Pages", "navigate <tab-id> <url>", "Navigate a tab", {
    arguments: [
      TAB_ID,
      { name: "url", description: "A complete http or https URL." },
    ],
    route: "POST /tabs/:id/navigate",
    script: "page.navigate",
  }),
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
    "click <tab-id> <ref-or-selector>",
    "Click a control",
    {
      arguments: [TAB_ID, TARGET],
      route: "POST /tabs/:id/click",
      script: "page.click",
    },
  ),
  command(
    "fill",
    "Page actions",
    "fill <tab-id> <ref-or-selector> --stdin",
    "Read the exact field value from stdin",
    {
      arguments: [TAB_ID, TARGET],
      flags: [
        { name: "--stdin", description: "Read the field value from stdin" },
      ],
      stdin: "The exact field value.",
      route: "POST /tabs/:id/fill",
      script: "page.fill",
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
    "press <tab-id> <key> [ref-or-selector]",
    "Press a supported key",
    {
      arguments: [
        TAB_ID,
        {
          name: "key",
          description: "Enter, Tab, Escape, an arrow key and others.",
        },
        TARGET,
      ],
      route: "POST /tabs/:id/press",
      script: "page.press",
    },
  ),
  command(
    "drag",
    "Page actions",
    "drag <tab-id> <source> <target>",
    "Drag one element onto another (refs or selectors)",
    {
      arguments: [
        TAB_ID,
        { name: "source", description: "The element to drag." },
        { name: "target", description: "The element to drop on." },
      ],
      route: "POST /tabs/:id/drag",
      script: "page.drag",
    },
  ),
  command(
    "scroll",
    "Page actions",
    "scroll <tab-id> <direction> [pixels] [ref-or-selector]",
    "Scroll up, down, left or right: the page, the panel holding a control, or the panel in the middle when the page cannot scroll",
    {
      arguments: [
        TAB_ID,
        { name: "direction", description: "up, down, left or right." },
        { name: "pixels", description: "1 to 2000, default 600." },
        TARGET,
      ],
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
