// The globals run gives a script, and the members of Client.

const CREATE_OPTIONS = {
  isolated: {
    kind: "boolean",
    description:
      "Give the space a session of its own instead of the person's sign-ins.",
  },
  pageBudget: {
    kind: "integer",
    min: 1,
    max: 20,
    since: 2,
    description:
      "How many pages the agent may manage in the space at once, 20 by default or KAMAPATHY_PAGE_BUDGET.",
  },
};
const CREATE_ERRORS = ["invalid_field", "space_limit", "automation_stopped"];

const create = (name, signature, kind) => ({
  name,
  kind,
  signature,
  summary: "Creates a background agent space.",
  args: [
    { name: "name", kind: "string" },
    { name: "options", kind: "options", optional: true },
  ],
  options: CREATE_OPTIONS,
  returns: "Promise<Space>",
  route: "POST /spaces",
  errors: CREATE_ERRORS,
  since: 1,
});
const find = (name, signature, kind) => ({
  name,
  kind,
  signature,
  summary: "Finds an accessible agent space by ID.",
  args: [{ name: "id", kind: "string" }],
  returns: "Promise<Space>",
  route: "GET /spaces",
  errors: ["space_not_found", "automation_stopped"],
  since: 1,
});
const list = (name, signature, kind) => ({
  name,
  kind,
  signature,
  summary: "Lists the agent spaces this API session can reach.",
  args: [],
  returns: "Promise<Space[]>",
  route: "GET /spaces",
  errors: ["automation_stopped"],
  since: 1,
});

const open = (name, signature, kind) => ({
  name,
  kind,
  signature,
  summary:
    "Returns the listed space with this ID, or else the first with this name, and creates one when none matches.",
  args: [
    { name: "nameOrId", kind: "string" },
    { name: "options", kind: "options", optional: true },
  ],
  options: CREATE_OPTIONS,
  returns: "Promise<Space>",
  route: "POST /spaces",
  errors: [...CREATE_ERRORS, "sign_ins_mismatch"],
  since: 2,
});
const request = (name, signature, kind) => ({
  name,
  kind,
  signature,
  summary:
    "Asks the person to let an agent use one of their spaces and waits for their answer.",
  args: [{ name: "options", kind: "options" }],
  options: {
    reason: {
      kind: "string",
      max: 120,
      required: true,
      description: "Why the agent needs a space, shown to the person.",
    },
    name: {
      kind: "string",
      max: 48,
      description: "The name of the space to suggest.",
    },
    timeout: {
      kind: "ms",
      min: 5000,
      max: 600000,
      description: "How long to wait for the answer, 600000 by default.",
    },
  },
  returns: "Promise<Space>",
  route: "POST /space-requests",
  errors: [
    "request_declined",
    "request_timeout",
    "busy",
    "invalid_field",
    "automation_stopped",
  ],
  since: 2,
});

const packs = (name, signature, kind) => ({
  name,
  kind,
  signature,
  summary:
    "Lists the site packs in the workspace and the skill, or the ones matching a page.",
  args: [{ name: "target", kind: "site", optional: true }],
  returns:
    "Promise<{ host?: string | null, packs: PackSummary[], skipped: Skipped[] }>",
  errors: ["invalid_argument"],
  since: 4,
});
const context = (name, signature, kind) => ({
  name,
  kind,
  signature,
  summary:
    "Reads the notes and tools of every pack matching a page, with example calls.",
  args: [{ name: "target", kind: "site" }],
  returns:
    "Promise<{ url: string, host: string | null, packs: PackContext[], skipped: Skipped[] }>",
  errors: ["invalid_argument"],
  since: 4,
});
const runTool = (name, signature, kind) => ({
  name,
  kind,
  signature,
  summary: "Runs a site pack's Node tool in the agent's own Node.js.",
  args: [
    { name: "packId", kind: "string" },
    { name: "tool", kind: "string" },
    { name: "args", kind: "json", optional: true },
    { name: "options", kind: "options" },
  ],
  options: {
    page: {
      kind: "page",
      required: true,
      description: "The agent page the tool works in.",
    },
  },
  returns: "Promise<unknown>",
  errors: [
    "invalid_argument",
    "site_pack_not_found",
    "site_tool_not_found",
    "site_pack_invalid",
    "invalid_tool_args",
    "site_tool_failed",
  ],
  since: 4,
});

const runPage = (name, signature, kind) => ({
  name,
  kind,
  signature,
  summary: "Runs a site pack's page tool in the page, through one evaluate.",
  args: [
    { name: "packId", kind: "string" },
    { name: "tool", kind: "string" },
    { name: "args", kind: "json", optional: true },
    { name: "options", kind: "options" },
  ],
  options: {
    page: {
      kind: "page",
      required: true,
      description: "The agent page the tool works in.",
    },
  },
  returns: "Promise<unknown>",
  pageFunction: true,
  errors: [
    "invalid_argument",
    "site_pack_not_found",
    "site_tool_not_found",
    "site_pack_invalid",
    "invalid_tool_args",
    "agent_scripts_off",
    "script_error",
    "result_too_large",
    "evaluation_timeout",
    "request_too_large",
  ],
  since: 4,
});

export const GLOBALS = [
  {
    name: "kamapathy",
    kind: "global",
    signature: "kamapathy",
    summary:
      "The connected client: a Client with createSpace, openSpace, space, spaces and requestSpace.",
    args: [],
    returns: "Client",
    errors: [],
    since: 1,
  },
  create("createSpace", "createSpace(name, options?)", "global"),
  find("space", "space(id)", "global"),
  list("spaces", "spaces()", "global"),
  open("openSpace", "openSpace(nameOrId, options?)", "global"),
  request("requestSpace", "requestSpace(options)", "global"),
  packs("sitePacks", "sitePacks(target?)", "global"),
  context("siteContext", "siteContext(target)", "global"),
  runTool("runSiteTool", "runSiteTool(packId, tool, args, options)", "global"),
  runPage("runPageTool", "runPageTool(packId, tool, args, options)", "global"),
  {
    name: "help",
    kind: "global",
    signature: "help(...names)",
    summary:
      'Prints the API, or one entry such as help("page.click"), or the topics errors and routes.',
    args: [],
    returns: "void",
    errors: [],
    since: 2,
  },
];

export const CLIENT = [
  {
    name: "Client.app",
    kind: "property",
    signature: "kamapathy.app",
    summary:
      "The running Kamapathy's version and API level, or null until the client has found it.",
    args: [],
    returns:
      '{ version?: string, apiLevel: number, electron?: string, chromium?: string, node?: string, update?: { version: string, state: "available" | "downloading" | "ready" } } | null',
    errors: [],
    since: 1,
  },
  create(
    "Client.createSpace",
    "kamapathy.createSpace(name, options?)",
    "method",
  ),
  find("Client.space", "kamapathy.space(id)", "method"),
  list("Client.spaces", "kamapathy.spaces()", "method"),
  open("Client.openSpace", "kamapathy.openSpace(nameOrId, options?)", "method"),
  request("Client.requestSpace", "kamapathy.requestSpace(options)", "method"),
  {
    name: "Client.updateStatus",
    kind: "method",
    signature: "kamapathy.updateStatus()",
    summary: "Reads Kamapathy's update status.",
    args: [],
    returns: "Promise<UpdateStatus>",
    route: "GET /update",
    errors: ["update_unsupported", "automation_stopped"],
    since: 3,
  },
  {
    name: "Client.checkForUpdates",
    kind: "method",
    signature: "kamapathy.checkForUpdates()",
    summary: "Checks GitHub Releases for a newer Kamapathy.",
    args: [],
    returns: "Promise<UpdateStatus>",
    route: "POST /update/check",
    errors: ["update_unsupported", "update_check_failed"],
    since: 3,
  },
  {
    name: "Client.downloadUpdate",
    kind: "method",
    signature: "kamapathy.downloadUpdate(options?)",
    summary:
      "Downloads this computer's installer and waits for it; only the person installs it.",
    args: [{ name: "options", kind: "options", optional: true }],
    options: {
      timeout: {
        kind: "ms",
        min: 0,
        max: 1800000,
        default: 600000,
        description:
          "How long to wait for the download, 600000 by default; 0 returns once it starts.",
      },
      interval: {
        kind: "ms",
        min: 250,
        max: 10000,
        default: 1000,
        description: "How often the status is read, 1000 by default.",
      },
    },
    returns: "Promise<UpdateStatus>",
    route: "POST /update/download",
    errors: [
      "update_unsupported",
      "update_check_failed",
      "update_download_failed",
      "update_verify_failed",
      "timeout",
    ],
    since: 3,
  },
  packs("Client.sitePacks", "kamapathy.sitePacks(target?)", "method"),
  context("Client.siteContext", "kamapathy.siteContext(target)", "method"),
  runTool(
    "Client.runSiteTool",
    "kamapathy.runSiteTool(packId, tool, args, options)",
    "method",
  ),
  runPage(
    "Client.runPageTool",
    "kamapathy.runPageTool(packId, tool, args, options)",
    "method",
  ),
];
