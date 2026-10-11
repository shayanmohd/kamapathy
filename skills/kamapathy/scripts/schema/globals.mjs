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

export const GLOBALS = [
  {
    name: "kamapathy",
    kind: "global",
    signature: "kamapathy",
    summary:
      "The connected client: a Client with createSpace, space and spaces.",
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
      "{ version?: string, apiLevel: number, electron?: string, chromium?: string, node?: string } | null",
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
];
