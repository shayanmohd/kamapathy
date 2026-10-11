// The globals run gives a script, and the members of Client.

const CREATE_OPTIONS = {
  isolated: {
    kind: "boolean",
    description:
      "Give the space a session of its own instead of the person's sign-ins.",
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
];
