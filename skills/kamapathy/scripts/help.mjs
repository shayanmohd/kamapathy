// What the client says about itself, all from the schema: help() in
// scripts, kamapathy help and the generated reference.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  API_LEVEL,
  CLIENT_VERSION,
  COMMANDS,
  editDistance,
  ENTRIES,
  ENVIRONMENT,
  ERRORS,
  GLOBAL_FLAGS,
  ROUTES,
  routeKey,
  SELECTOR_FORMS,
} from "./schema/index.mjs";

const callName = (entry) => entry.signature.split("(")[0];
const memberName = (entry) => entry.name.split(".").slice(1).join(".");
// The class part of a name in any case: Page.wait, page.wait, PAGE.wait.
const folded = (name) => {
  const dot = name.indexOf(".");
  return dot < 0
    ? name
    : `${name.slice(0, dot).toLowerCase()}${name.slice(dot)}`;
};

// Entries by canonical (Page.wait), instance-style (page.wait,
// kamapathy.createSpace) or bare (wait) name; a trailing () is ignored.
export function resolveNames(query) {
  const name = folded(String(query).trim().replace(/\(\)$/, ""));
  const exact = ENTRIES.filter(
    (entry) => folded(entry.name) === name || folded(callName(entry)) === name,
  );
  return exact.length
    ? exact
    : ENTRIES.filter((entry) => memberName(entry) === name);
}

// Up to five names within two edits of the query, or sharing its start.
// Each candidate is [the name shown, ...the names compared].
function closeMatches(query, candidates) {
  const near = (name) =>
    editDistance(query.toLowerCase(), name.toLowerCase()) <= 2 ||
    (query.length >= 3 && (name.startsWith(query) || query.startsWith(name)));
  const found = [];
  for (const [shown, ...names] of candidates)
    if (!found.includes(shown) && names.some(near)) found.push(shown);
  return found.slice(0, 5);
}
const closeText = (matches) =>
  matches.length ? ` Close matches: ${matches.join(", ")}.` : "";

// "  <left padded to the column><right>", or right on a line of its own
// under a long left.
function columns(left, right, width = 38) {
  return left.length + 2 < width
    ? `  ${left.padEnd(width - 2)}${right}`
    : `  ${left}\n${" ".repeat(width)}${right}`;
}

const GROUPS = [
  ["Globals", (entry) => entry.kind === "global"],
  ["Client", (entry) => entry.name.startsWith("Client.")],
  ["Space", (entry) => entry.name.startsWith("Space.")],
  [
    "Page",
    (entry) =>
      entry.name.startsWith("Page.") && entry.name.split(".").length === 2,
  ],
  [
    "Page controllers",
    (entry) =>
      entry.name.startsWith("Page.") && entry.name.split(".").length > 2,
  ],
];

export function formatIndex() {
  const lines = [
    `Kamapathy script API, client ${CLIENT_VERSION}, API level ${API_LEVEL}`,
  ];
  for (const [title, belongs] of GROUPS) {
    const entries = ENTRIES.filter(belongs);
    if (entries.length)
      lines.push(
        "",
        title,
        ...entries.map((entry) => columns(entry.signature, entry.summary)),
      );
  }
  lines.push(
    "",
    'help("page.click") shows one entry; help("errors") lists error codes.',
  );
  return lines.join("\n");
}

// A field's kind and range, as "integer from 1 to 20".
function kindOf(field) {
  const range =
    field.min !== undefined && field.max !== undefined
      ? ` from ${field.min} to ${field.max}`
      : field.max !== undefined
        ? ` of at most ${field.max}`
        : field.min !== undefined
          ? ` of at least ${field.min}`
          : "";
  switch (field.kind) {
    case "ms":
      return `milliseconds${range}`;
    case "string":
      return `string${field.max !== undefined ? ` of at most ${field.max} characters` : ""}`;
    case "url":
      return `URL of at most ${field.max ?? 8192} characters`;
    case "boolean":
      return "true or false";
    case "enum":
      return `one of ${field.values.join(", ")}`;
    case "json":
      return "JSON";
    default:
      return `${field.kind}${range}`;
  }
}

// Whether an error clears without the request changing.
function retryText(spec) {
  if (spec.transient === true) return "retryable";
  if (spec.transient === false) return "not retryable";
  return `retryable when ${spec.transient
    .map((rule) =>
      rule.absent
        ? `${rule.field} is absent`
        : rule.values
          ? `${rule.field} is ${rule.values.join(" or ")}`
          : `${rule.field} is in range`,
    )
    .join(", or ")}`;
}
const statusText = (spec) =>
  spec.carriedIn
    ? `in ${spec.carriedIn}`
    : spec.status === null
      ? "client"
      : String(spec.status);

export function formatEntry(entry) {
  const lines = [entry.signature, entry.summary];
  const options = Object.entries(entry.options ?? {});
  if (options.length)
    lines.push(
      "",
      "Options:",
      ...options.map(
        ([name, field]) =>
          `  ${name}: ${kindOf(field)}${field.required ? ", required" : ""}${
            field.default !== undefined
              ? `, default ${JSON.stringify(field.default)}`
              : ""
          }. ${field.description}`,
      ),
    );
  lines.push("", `Returns: ${entry.returns}`);
  if (entry.route) lines.push(`Route: ${entry.route}`);
  if (entry.errors.length)
    lines.push(
      "Errors:",
      ...entry.errors.map((code) =>
        ERRORS[code]
          ? `  ${code}: ${statusText(ERRORS[code])}, ${retryText(ERRORS[code])}`
          : `  ${code}`,
      ),
    );
  lines.push(`Since: API level ${entry.since}`);
  return lines.join("\n");
}

export function formatCommand(command, program) {
  const lines = [`Usage: ${program} ${command.usage}`, command.summary];
  if (command.arguments.length)
    lines.push(
      "",
      "Arguments:",
      ...command.arguments.map((argument) =>
        columns(`<${argument.name}>`, argument.description),
      ),
    );
  if (command.flags.length)
    lines.push(
      "",
      "Flags:",
      ...command.flags.map((flag) =>
        columns(
          `${flag.name}${flag.value ? ` ${flag.value}` : ""}`,
          flag.description,
        ),
      ),
    );
  if (command.stdin) lines.push("", `Stdin: ${command.stdin}`);
  if (command.route) lines.push(`Route: ${command.route}`);
  if (command.script) lines.push(`Script: ${command.script}`);
  if (command.examples.length)
    lines.push(
      "",
      "Examples:",
      ...command.examples.map((example) => `  ${program} ${example}`),
    );
  lines.push(`Since: API level ${command.since}`);
  return lines.join("\n");
}

export function formatErrors() {
  return [
    "Error codes",
    ...Object.entries(ERRORS).map(([code, spec]) =>
      columns(code, `${statusText(spec)}, ${retryText(spec)}. ${spec.summary}`),
    ),
  ].join("\n");
}

export function formatRoutes() {
  return [
    "Routes",
    ...ROUTES.map((route) => columns(routeKey(route), route.summary, 40)),
  ].join("\n");
}

export function formatSelectors() {
  return [
    "Selectors",
    ...SELECTOR_FORMS.map((form) => columns(form.example, form.matches, 40)),
    "",
    "Refs skip the search. Docs and help show only the css=, text=, role=, href= and xpath= spellings.",
  ].join("\n");
}

// "kamapathy" when a launcher says so; otherwise how to run this client.
export function programName(env = process.env) {
  return env.KAMAPATHY_PROGRAM
    ? "kamapathy"
    : `node ${fileURLToPath(new URL("./kamapathy.mjs", import.meta.url))}`;
}

// The skill folder that holds this client, and its SKILL.md, links
// resolved.
const resolved = (relative) => {
  try {
    return realpathSync(fileURLToPath(new URL(relative, import.meta.url)));
  } catch {
    return null;
  }
};
export const skillFolder = () => resolved("..");
export const skillPath = () => resolved("../SKILL.md");

export function formatGeneralHelp(program, skill) {
  const groups = [...new Set(COMMANDS.map((command) => command.group))];
  return [
    "Kamapathy browser client",
    "",
    "Kamapathy connects automatically. Each command finds Kamapathy on this",
    "computer and starts it when agent access was left on. The switch in Settings,",
    "under Agents, turns access off. Set KAMAPATHY_USER_DATA to use another profile.",
    "Requires Node.js 22.13 or later.",
    "",
    `Usage: ${program} <command> [arguments] [--json]`,
    ...groups.flatMap((group) => [
      "",
      group,
      ...COMMANDS.filter((command) => command.group === group).map((command) =>
        columns(command.usage, command.summary),
      ),
    ]),
    "",
    "Global options",
    ...GLOBAL_FLAGS.map((flag) => columns(flag.name, flag.description)),
    "",
    "Environment",
    ...ENVIRONMENT.map((variable) =>
      columns(variable.name, variable.description),
    ),
    "",
    "A <tab-id> may also be <space-id>:<label>, such as s1:p2.",
    "Default output is concise text. --json returns compact JSON for programs.",
    "Batch stops at the first failed action. Submitted actions are never retried.",
    "Take a snapshot again after navigation before reusing element refs. A ref",
    "follows a control the page draws again only when that control is unmistakable.",
    "",
    "Agents: read the Kamapathy skill before using these commands.",
    skill ? `  ${skill}` : "SKILL.md was not found beside this client.",
    'In run scripts, help() lists the API and help("page.click") shows one entry.',
    "",
  ].join("\n");
}

// The text of kamapathy help <topic>; an unknown topic throws.
export function helpTopic(words, program) {
  const topic = words.join(" ");
  const command = COMMANDS.find((item) => item.name === topic);
  if (command) return formatCommand(command, program);
  if (words[0] === "api")
    return words.length > 1
      ? words.slice(1).map(entryText).join("\n\n")
      : formatIndex();
  if (topic === "errors") return formatErrors();
  if (topic === "routes") return formatRoutes();
  if (topic === "selectors") return formatSelectors();
  const entries = resolveNames(topic);
  if (entries.length) return entries.map(formatEntry).join("\n\n");
  throw new Error(
    `No help topic "${topic}".${closeText(
      closeMatches(topic, [
        ...COMMANDS.map((item) => [item.name, item.name]),
        ...["api", "errors", "routes", "selectors"].map((name) => [name, name]),
        ...ENTRIES.map((entry) => [callName(entry), callName(entry)]),
      ]),
    )}`,
  );
}

// One help() argument: entries, a topic, or a note with close matches.
function entryText(name) {
  if (name === "errors") return formatErrors();
  if (name === "routes") return formatRoutes();
  if (name === "selectors") return formatSelectors();
  const entries = resolveNames(name);
  if (entries.length) return entries.map(formatEntry).join("\n\n");
  return `No help entry named "${name}".${closeText(
    closeMatches(String(name), [
      ...ENTRIES.map((entry) => [
        callName(entry),
        callName(entry),
        memberName(entry) || entry.name,
      ]),
      ["errors", "errors"],
      ["routes", "routes"],
      ["selectors", "selectors"],
    ]),
  )}`;
}

/**
 * Prints the API, or the entries and topics named.
 * @param {...string} names Such as "page.click", "selectors", "errors" or
 * "routes".
 */
export function help(...names) {
  console.log(names.length ? names.map(entryText).join("\n\n") : formatIndex());
}

const cell = (text) => String(text ?? "").replace(/\|/g, "\\|");

// The reference npm run docs:api writes: references/api.md, and the route
// and error tables in docs/automation.md.
export function generateReference() {
  const entrySection = (entry) => {
    const options = Object.entries(entry.options ?? {});
    return [
      `### \`${entry.signature}\``,
      "",
      entry.summary,
      ...(options.length
        ? [
            "",
            "| Option | Kind | Default | Description |",
            "| --- | --- | --- | --- |",
            ...options.map(
              ([name, field]) =>
                `| \`${name}\` | ${cell(kindOf(field))}${field.required ? ", required" : ""} | ${
                  field.default === undefined
                    ? ""
                    : `\`${JSON.stringify(field.default)}\``
                } | ${cell(field.description)} |`,
            ),
          ]
        : []),
      "",
      [
        `Returns \`${entry.returns}\`.`,
        ...(entry.route ? [`Route \`${entry.route}\`.`] : []),
        ...(entry.errors.length
          ? [`Errors: ${entry.errors.map((code) => `\`${code}\``).join(", ")}.`]
          : []),
        `Since API level ${entry.since}.`,
      ].join(" "),
      "",
    ];
  };
  const routesTable = [
    "| Method | Route | Body | Description |",
    "| --- | --- | --- | --- |",
    ...ROUTES.map(
      (route) =>
        `| ${route.method} | \`${route.path}\` | ${
          route.body
            ? Object.entries(route.body)
                .map(
                  ([name, field]) => `\`${name}${field.required ? "" : "?"}\``,
                )
                .join(", ") || "`{}`"
            : ""
        } | ${cell(route.summary)} Returns \`${cell(route.response)}\`. |`,
    ),
  ];
  const errorsTable = [
    "| Code | Status | Retryable | Fields | Meaning |",
    "| --- | --- | --- | --- | --- |",
    ...Object.entries(ERRORS).map(
      ([code, spec]) =>
        `| \`${code}\` | ${statusText(spec)} | ${retryText(spec)} | ${spec.fields
          .map((field) => `\`${field}\``)
          .join(", ")} | ${cell(spec.summary)} |`,
    ),
  ];
  const apiMarkdown = [
    "# Kamapathy API reference",
    "",
    `Client ${CLIENT_VERSION}, API level ${API_LEVEL}. Generated from the schema by \`npm run docs:api\`; edit the schema, not this file.`,
    "",
    ...GROUPS.flatMap(([title, belongs]) => {
      const entries = ENTRIES.filter(belongs);
      return entries.length
        ? [`## ${title}`, "", ...entries.flatMap(entrySection)]
        : [];
    }),
    "## CLI commands",
    "",
    ...COMMANDS.flatMap((command) => [
      `### \`${command.usage}\``,
      "",
      command.summary,
      "",
    ]),
    "## Routes",
    "",
    ...routesTable,
    "",
    "## Errors",
    "",
    ...errorsTable,
    "",
  ].join("\n");
  return {
    apiMarkdown,
    routesBlock: `\n${routesTable.join("\n")}\n`,
    errorsBlock: `\n${errorsTable.join("\n")}\n`,
  };
}
