import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LIMITS,
  PackProblem,
  cleanText,
  declaredFiles,
  hostOf,
  importToolExport,
  listSitePacks,
  loadPacks,
  matchPacks,
  pageToolCall,
  problemText,
  readManifest,
  readTrustedFile,
  rootState,
  runPageToolIn,
  runToolIn,
  siteContextFor,
  siteRoots,
  summarize,
} from "../skills/kamapathy/scripts/lib/sites.mjs";
import {
  checkAll,
  checkPack,
} from "../skills/kamapathy/scripts/lib/site-check.mjs";
import {
  HELPER_LIMIT,
  loadHelperModule,
} from "../skills/kamapathy/scripts/lib/helper-module.mjs";
import {
  KamapathyError,
  hardStopCause,
} from "../skills/kamapathy/scripts/lib/errors.mjs";
import { Page, connect } from "../skills/kamapathy/scripts/api.mjs";
import { Session } from "../skills/kamapathy/scripts/lib/request.mjs";
import { runCli } from "../skills/kamapathy/scripts/kamapathy.mjs";

const posix = process.platform !== "win32";
let workspace;
let sites;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "kamapathy-site-packs-"));
  await chmod(workspace, 0o700);
  sites = join(workspace, "sites");
  await mkdir(sites, { mode: 0o700 });
});
afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const temporary = [];
afterAll(async () => {
  for (const path of temporary)
    await rm(path, { recursive: true, force: true });
});

// A workspace root and a bundled root of one case's own, so no case depends
// on the packs the skill ships.
async function freshRoots() {
  // The real path, so a stack frame from a tool a case imports names the
  // folder the pack sits in.
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "kamapathy-site-roots-")),
  );
  temporary.push(base);
  const home = join(base, "workspace");
  await mkdir(home, { mode: 0o700 });
  const roots = [
    { path: join(home, "sites"), source: "workspace" },
    { path: join(base, "bundled"), source: "bundled" },
  ];
  for (const root of roots) await mkdir(root.path, { mode: 0o700 });
  return { roots, env: { KAMAPATHY_WORKSPACE: home } };
}

// A pack folder holding a pack.json and whatever files a case needs.
async function writePackIn(sitesDir, id, manifest, files = {}) {
  const dir = join(sitesDir, id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { mode: 0o700 });
  await writeFile(
    join(dir, "pack.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    { mode: 0o600 },
  );
  for (const [relative, text] of Object.entries(files)) {
    const path = join(dir, relative);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, text, { mode: 0o600 });
  }
  return dir;
}

async function writePack(id, manifest, files = {}) {
  return writePackIn(sites, id, manifest, files);
}

// The smallest manifest that passes every rule.
const bare = (id, domains) => ({ format: 1, id, name: id, domains });

const good = () => ({
  format: 1,
  id: "github",
  name: "GitHub",
  domains: ["github.com"],
  notes: ["notes/overview.md"],
  tools: {
    search_repositories: {
      description: "Search repositories and read the first results.",
      file: "tools/search-repositories.mjs",
      export: "searchRepositories",
      args: {
        query: {
          type: "string",
          required: true,
          description: "Words to search for.",
        },
      },
      returns: {
        type: "array",
        description: "[{ fullName, url, description, stars, language }]",
      },
    },
  },
  pageTools: {
    repository_stats: {
      description: "Read the stars, forks and topics of the open repository.",
      file: "page-tools/repository-stats.js",
      returns: { type: "object", description: "{ fullName, stars, forks }" },
    },
  },
});

// A note holding a control character, a bidirectional control and text a
// context must keep as it is.
const OVERVIEW =
  "# GitHub\n\nSearch at /search?q=<q>\tand read the rows.\u0007\n\u202eclean\u200e\n";

// A pack with two notes, two Node tools and one page tool, for contexts.
const contextPack = () => ({
  format: 1,
  id: "github",
  name: "GitHub",
  domains: ["*.github.com", "github.com"],
  notes: ["notes/overview.md", "notes/issues.md"],
  tools: {
    search_repositories: {
      description: "Search repositories and read the first results.",
      file: "tools/search-repositories.mjs",
      export: "searchRepositories",
      args: {
        query: {
          type: "string",
          required: true,
          description: "Words to search for.",
        },
        limit: {
          type: "integer",
          description: "How many results to read, 10 by default.",
        },
      },
      returns: {
        type: "array",
        description: "[{ fullName, url, description, stars, language }]",
      },
    },
    open_issues: {
      description: "Read the open issues of one repository.",
      file: "tools/open-issues.mjs",
      export: "openIssues",
      args: {
        owner: {
          type: "string",
          required: true,
          description: "The account the repository belongs to.",
        },
        repo: {
          type: "string",
          required: true,
          description: "The repository name.",
        },
        limit: {
          type: "integer",
          required: true,
          description: "How many issues to read, 25 by default.",
        },
      },
      returns: {
        type: "array",
        description: "[{ number, title, url, labels }]",
      },
    },
  },
  pageTools: {
    repository_stats: {
      description: "Read the stars, forks and topics of the open repository.",
      file: "page-tools/repository-stats.js",
      returns: { type: "object", description: "{ fullName, stars, forks }" },
    },
  },
});

// The problems one manifest reports, as the lines the CLI prints.
async function readPack(manifest, { id = "github" } = {}) {
  const dir = await writePack(id, manifest);
  const { pack, problems } = await readManifest(dir, {
    source: "workspace",
    id,
  });
  return { dir, pack, text: problems.map(problemText).join("\n") };
}

const repeat = (count) => "x".repeat(count);
// 254 characters of labels no longer than the 63 a label allows.
const longHost = () => Array.from({ length: 5 }, () => repeat(50)).join(".");
const hosts = (count) =>
  Array.from({ length: count }, (_value, index) => `h${index}.example`);
const notes = (count) =>
  Array.from({ length: count }, (_value, index) => `notes/n${index}.md`);
const tools = (count) =>
  Object.fromEntries(
    Array.from({ length: count }, (_value, index) => [
      `tool_${index}`,
      {
        description: "A tool.",
        file: `tools/t${index}.mjs`,
        export: "run",
        returns: { type: "object", description: "A value." },
      },
    ]),
  );
const args = (count) =>
  Object.fromEntries(
    Array.from({ length: count }, (_value, index) => [
      `a${index}`,
      { type: "string", description: "An argument." },
    ]),
  );

// Every row of the manifest table: a change to a good manifest and the
// problem line it must report, or null when the manifest stays valid.
const rules = [
  [
    "format other than 1",
    (m) => (m.format = 2),
    /^format: format must be 1\.$/m,
  ],
  [
    "an id that is not the folder name",
    (m) => (m.id = "gitlab"),
    /^id: .*folder/m,
  ],
  ["an id outside the pattern", (m) => (m.id = "Git Hub"), /^id: .*lowercase/m],
  [
    "a name of 0 characters",
    (m) => (m.name = ""),
    /^name: name must be 1 to 48 characters\.$/m,
  ],
  [
    "a name of 49 characters",
    (m) => (m.name = repeat(49)),
    /^name: name must be 1 to 48 characters\.$/m,
  ],
  [
    "a control character in a name",
    (m) => (m.name = "Git\u0007Hub"),
    /^name: .*control or bidirectional/m,
  ],
  [
    "a bidirectional control in a name",
    (m) => (m.name = "\u202eGitHub"),
    /^name: .*control or bidirectional/m,
  ],
  ["no domains", (m) => (m.domains = []), /^domains: .*1 to 32/m],
  ["33 domains", (m) => (m.domains = hosts(33)), /^domains: .*1 to 32/m],
  [
    "a repeated domain",
    (m) => (m.domains = ["github.com", "github.com"]),
    /^domains\.1: .*twice/m,
  ],
  [
    "an uppercase host",
    (m) => (m.domains = ["GitHub.com"]),
    /^domains\.0: .*lowercase host/m,
  ],
  [
    "a host with a scheme",
    (m) => (m.domains = ["https://github.com"]),
    /^domains\.0: .*lowercase host/m,
  ],
  [
    "a port",
    (m) => (m.domains = ["github.com:443"]),
    /^domains\.0: .*lowercase host/m,
  ],
  [
    "a path",
    (m) => (m.domains = ["github.com/kamapathy"]),
    /^domains\.0: .*lowercase host/m,
  ],
  [
    "a trailing dot",
    (m) => (m.domains = ["github.com."]),
    /^domains\.0: .*lowercase host/m,
  ],
  [
    "a wildcard of one label",
    (m) => (m.domains = ["*.com"]),
    /^domains\.0: .*lowercase host/m,
  ],
  [
    "a bare wildcard",
    (m) => (m.domains = ["*"]),
    /^domains\.0: .*lowercase host/m,
  ],
  [
    "a wildcard inside a host",
    (m) => (m.domains = ["a.*.b"]),
    /^domains\.0: .*lowercase host/m,
  ],
  [
    "a 254 character host",
    (m) => (m.domains = [longHost()]),
    /^domains\.0: .*253 characters/m,
  ],
  ["an IPv4 address", (m) => (m.domains = ["127.0.0.1"]), null],
  [
    "punycode",
    (m) => (m.domains = ["xn--bcher-kva.example", "*.github.com"]),
    null,
  ],
  [
    "a host outside ASCII",
    (m) => (m.domains = ["b\u00fccher.example"]),
    /^domains\.0: .*xn--bcher-kva\.example/m,
  ],
  ["9 notes", (m) => (m.notes = notes(9)), /^notes: .*up to 8/m],
  [
    "a note outside notes/",
    (m) => (m.notes = ["../secret.md"]),
    /^notes\.0: .*notes\/<name>\.md/m,
  ],
  [
    "a note not ending .md",
    (m) => (m.notes = ["notes/overview.txt"]),
    /^notes\.0: .*notes\/<name>\.md/m,
  ],
  [
    "a note reaching out of the pack",
    (m) => (m.notes = ["notes/../../secret.md"]),
    /^notes\.0: .*notes\/<name>\.md/m,
  ],
  [
    "a repeated note",
    (m) => (m.notes = ["notes/overview.md", "notes/overview.md"]),
    /^notes\.1: .*twice/m,
  ],
  ["33 tools", (m) => (m.tools = tools(33)), /^tools: .*up to 32/m],
  [
    "a tool name outside the pattern",
    (m) => (m.tools = { Search: m.tools.search_repositories }),
    /^tools\.Search: a tool name must be/m,
  ],
  [
    "one name in both maps",
    (m) =>
      (m.pageTools.search_repositories = {
        description: "Read the open repository.",
        file: "page-tools/search-repositories.js",
        returns: { type: "object", description: "Stats." },
      }),
    /^pageTools\.search_repositories: .*already a Node tool/m,
  ],
  [
    "a tool file outside tools/",
    (m) => (m.tools.search_repositories.file = "lib/search.mjs"),
    /^tools\.search_repositories\.file: .*tools\/<name>\.mjs/m,
  ],
  [
    "a tool file name with .. and a slash",
    (m) => (m.tools.search_repositories.file = "tools/../search.mjs"),
    /^tools\.search_repositories\.file: .*tools\/<name>\.mjs/m,
  ],
  [
    "a page tool file outside page-tools/",
    (m) => (m.pageTools.repository_stats.file = "tools/stats.js"),
    /^pageTools\.repository_stats\.file: .*page-tools\/<name>\.js/m,
  ],
  [
    "an export that is not an identifier",
    (m) => (m.tools.search_repositories.export = "2search"),
    /^tools\.search_repositories\.export: /m,
  ],
  [
    "a missing export",
    (m) => delete m.tools.search_repositories.export,
    /^tools\.search_repositories\.export: /m,
  ],
  [
    "17 args",
    (m) => (m.tools.search_repositories.args = args(17)),
    /^tools\.search_repositories\.args: .*up to 16/m,
  ],
  [
    "an arg name outside the pattern",
    (m) =>
      (m.tools.search_repositories.args = {
        _query: { type: "string", description: "Words." },
      }),
    /^tools\.search_repositories\.args\._query: an argument name must be/m,
  ],
  [
    "an unknown type",
    (m) => (m.tools.search_repositories.args.query.type = "date"),
    /^tools\.search_repositories\.args\.query\.type: type must be one of/m,
  ],
  [
    "a required that is not a boolean",
    (m) => (m.tools.search_repositories.args.query.required = "yes"),
    /^tools\.search_repositories\.args\.query\.required: /m,
  ],
  [
    "a missing returns",
    (m) => delete m.tools.search_repositories.returns,
    /^tools\.search_repositories\.returns: returns must be an object/m,
  ],
  [
    "an unknown returns type",
    (m) => (m.tools.search_repositories.returns.type = "date"),
    /^tools\.search_repositories\.returns\.type: /m,
  ],
  [
    "a description of 0 characters",
    (m) => (m.tools.search_repositories.description = ""),
    /^tools\.search_repositories\.description: description must be 1 to 200 characters\.$/m,
  ],
  [
    "a description of 201 characters",
    (m) => (m.tools.search_repositories.description = repeat(201)),
    /^tools\.search_repositories\.description: description must be 1 to 200 characters\.$/m,
  ],
  [
    "a description of 200 characters",
    (m) => (m.tools.search_repositories.description = repeat(200)),
    null,
  ],
  [
    "a control character in a description",
    (m) => (m.tools.search_repositories.description = "Search\u0001."),
    /^tools\.search_repositories\.description: .*control or bidirectional/m,
  ],
  [
    "a bidirectional control in a description",
    (m) => (m.tools.search_repositories.description = "Search\u2066."),
    /^tools\.search_repositories\.description: .*control or bidirectional/m,
  ],
  [
    "a returns description of 300 characters",
    (m) => (m.tools.search_repositories.returns.description = repeat(300)),
    null,
  ],
  [
    "a returns description of 301 characters",
    (m) => (m.tools.search_repositories.returns.description = repeat(301)),
    /^tools\.search_repositories\.returns\.description: description must be 1 to 300 characters\.$/m,
  ],
  [
    "an unknown key at the top level",
    (m) => (m.allow = ["post"]),
    /^allow: .*not a field of pack\.json/m,
  ],
  [
    "an unknown key inside a tool",
    (m) => (m.tools.search_repositories.timeoutMs = 1000),
    /^tools\.search_repositories\.timeoutMs: .*not a field of a tool/m,
  ],
  [
    "an export on a page tool",
    (m) => (m.pageTools.repository_stats.export = "stats"),
    /^pageTools\.repository_stats\.export: .*not a field of a page tool/m,
  ],
  [
    "only the required fields",
    (m) => {
      delete m.notes;
      delete m.tools;
      delete m.pageTools;
    },
    null,
  ],
];

// A pack whose Node tools cover every argument type, beside a page tool
// runSiteTool must never find.
const argsPack = () => ({
  format: 1,
  id: "github",
  name: "GitHub",
  domains: ["github.com"],
  tools: {
    search_repositories: {
      description: "Search repositories and read the first results.",
      file: "tools/search-repositories.mjs",
      export: "searchRepositories",
      args: {
        query: {
          type: "string",
          required: true,
          description: "Words to search for.",
        },
        limit: {
          type: "integer",
          description: "How many results to read, 10 by default.",
        },
      },
      returns: { type: "array", description: "[{ fullName, url }]" },
    },
    read_types: {
      description: "Return the arguments it got, of every type.",
      file: "tools/read-types.mjs",
      export: "readTypes",
      args: {
        text: { type: "string", description: "Any string." },
        count: { type: "number", description: "Any finite number." },
        tags: { type: "array", description: "Any array." },
        shape: { type: "object", description: "Any plain object." },
        flag: { type: "boolean", description: "True or false." },
      },
      returns: { type: "object", description: "The arguments it got." },
    },
  },
  pageTools: {
    repository_stats: {
      description: "Read the stars and forks of the open repository.",
      file: "page-tools/repository-stats.js",
      returns: { type: "object", description: "{ stars, forks }" },
    },
  },
});

// A tool that reports the context it ran with. Its module counts its own
// calls and imports one module beside the workspace, which every pack
// shares.
const reportPack = (id, name) => ({
  format: 1,
  id,
  name,
  domains: [`${id}.example`],
  tools: {
    report: {
      description: "Return the context and arguments the tool got.",
      file: "tools/report.mjs",
      export: "report",
      args: { query: { type: "string", description: "Anything at all." } },
      returns: { type: "object", description: "What the tool was given." },
    },
  },
});

const SHARED_MODULE = `let calls = 0;
export const note = () => ++calls;
`;
const REPORT_TOOL = `import { note } from "../../../shared.mjs";
let calls = 0;
export const report = (context, args) => {
  calls += 1;
  args.query = "mutated";
  return { ...context, args, calls, shared: note() };
};
`;

// Tools that throw, and exports that are missing or are not functions.
const failurePack = () => ({
  format: 1,
  id: "github",
  name: "GitHub",
  domains: ["github.com"],
  tools: {
    thrower: {
      description: "Throw a TypeError of its own.",
      file: "tools/thrower.mjs",
      export: "thrower",
      returns: { type: "object", description: "Nothing: it throws." },
    },
    stopped: {
      description: "Throw the error a takeover raises.",
      file: "tools/raise.mjs",
      export: "stopped",
      returns: { type: "object", description: "Nothing: it throws." },
    },
    timed_out: {
      description: "Throw an error that can be retried.",
      file: "tools/raise.mjs",
      export: "timedOut",
      returns: { type: "object", description: "Nothing: it throws." },
    },
    missing_export: {
      description: "Name an export its module does not have.",
      file: "tools/extras.mjs",
      export: "absent",
      returns: { type: "object", description: "Nothing: it cannot load." },
    },
    not_function: {
      description: "Name an export that is not a function.",
      file: "tools/extras.mjs",
      export: "number",
      returns: { type: "object", description: "Nothing: it cannot load." },
    },
  },
  pageTools: {
    repository_stats: {
      description: "Read the stars and forks of the open repository.",
      file: "page-tools/repository-stats.js",
      returns: { type: "object", description: "{ stars, forks }" },
    },
  },
});

const THROWER_TOOL = `export function thrower() {
  const data = { x: 1 };
  throw new TypeError("no " + data.x);
}
`;
const RAISE_TOOL = (
  url,
) => `import { KamapathyError } from ${JSON.stringify(url)};
export function stopped() {
  throw new KamapathyError("human_control", "The person has control of the space.", {
    reason: "manual",
  });
}
export function timedOut() {
  throw new KamapathyError("timeout", "The tool's own call timed out.", {
    retryable: true,
    dispatched: true,
  });
}
`;
const EXTRAS_TOOL = `export const number = 5;
export const other = () => "other";
`;

const CLI = fileURLToPath(
  new URL("../skills/kamapathy/scripts/kamapathy.mjs", import.meta.url),
);

// A workspace of one case's own, holding the files it names.
async function helperWorkspace(files = {}) {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), "kamapathy-helpers-")),
  );
  temporary.push(base);
  const home = join(base, "workspace");
  await mkdir(home, { mode: 0o700 });
  for (const [name, text] of Object.entries(files))
    await writeFile(join(home, name), text, { mode: 0o600 });
  return home;
}

// A run in a process of its own, so the workspace .env reaches process.env
// and the globals a helper meets are the ones a real run installs.
function runWith(home, code) {
  const env = {
    ...process.env,
    KAMAPATHY_NO_LAUNCH: "1",
    KAMAPATHY_USER_DATA: join(home, "profile"),
    KAMAPATHY_WORKSPACE: home,
  };
  // The key comes from the workspace .env, which never changes a name the
  // environment already holds.
  delete env.FIXTURE_KEY;
  const child = spawn(process.execPath, [CLI, "run", "-e", code], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((done) =>
    child.once("close", (status) => done({ status, stdout, stderr })),
  );
}

// What a run says about a helpers.mjs its account cannot trust.
const refusalText = (home) =>
  `error: helpers_failed: Kamapathy will not load ${join(home, "helpers.mjs")}: it must be a regular file of at most 256 KiB that your account owns and others cannot change.\n`;

// One function expression, with a trailing comment the wrapper's own newline
// keeps from swallowing the call.
const STATS_PAGE_TOOL = `(args) => ({
  fullName: document.title,
  stars: args.stars ?? 0,
}) // the open repository
`;
// A file that does not compile, with its mistake on line 2.
const BROKEN_PAGE_TOOL = `(args) => {
  return args.(;
}
`;

// A pack of page tools, beside a Node tool runPageTool must never find.
const pagePack = () => ({
  format: 1,
  id: "github",
  name: "GitHub",
  domains: ["github.com"],
  tools: {
    search_repositories: {
      description: "Search repositories and read the first results.",
      file: "tools/search-repositories.mjs",
      export: "searchRepositories",
      returns: { type: "array", description: "[{ fullName, url }]" },
    },
  },
  pageTools: {
    repository_stats: {
      description: "Read the stars of the open repository.",
      file: "page-tools/repository-stats.js",
      args: {
        stars: { type: "integer", description: "A count to fall back to." },
        note: { type: "string", description: "Anything to carry along." },
      },
      returns: { type: "object", description: "{ fullName, stars }" },
    },
    broken: {
      description: "A page tool whose file does not compile.",
      file: "page-tools/broken.js",
      returns: { type: "object", description: "Nothing: it never runs." },
    },
  },
});

// The route's own reply to one evaluate, and the failures phase 7 raises.
const EVALUATE_FAILURES = [
  [
    403,
    {
      code: "agent_scripts_off",
      message:
        "Page scripts are off. Ask the person to turn Page scripts on in Kamapathy's settings.",
    },
  ],
  [
    422,
    {
      code: "script_error",
      message: "The page script threw TypeError: args.stars is not a function.",
      name: "TypeError",
      line: 2,
      column: 10,
    },
  ],
  [
    413,
    {
      code: "result_too_large",
      message: "The value is larger than 1 MiB. Return less of it.",
      bytes: 2097152,
    },
  ],
  [
    504,
    {
      code: "evaluation_timeout",
      message: "The page script did not finish within 15000 ms.",
      timeoutMs: 15000,
    },
  ],
];

describe("site packs", () => {
  it("reads a pack.json and reports every manifest rule", async () => {
    const dir = await writePack("github", good());
    const { pack, problems } = await readManifest(dir, {
      source: "workspace",
      id: "github",
    });
    expect(problems).toEqual([]);
    expect(pack).toMatchObject({
      id: "github",
      name: "GitHub",
      dir,
      source: "workspace",
      domains: ["github.com"],
      notes: ["notes/overview.md"],
    });
    expect(pack.tools).toEqual([
      {
        name: "search_repositories",
        kind: "node",
        description: "Search repositories and read the first results.",
        file: "tools/search-repositories.mjs",
        export: "searchRepositories",
        args: [
          {
            name: "query",
            type: "string",
            required: true,
            description: "Words to search for.",
          },
        ],
        returns: {
          type: "array",
          description: "[{ fullName, url, description, stars, language }]",
        },
      },
    ]);
    expect(pack.pageTools).toEqual([
      {
        name: "repository_stats",
        kind: "page",
        description: "Read the stars, forks and topics of the open repository.",
        file: "page-tools/repository-stats.js",
        args: [],
        returns: { type: "object", description: "{ fullName, stars, forks }" },
      },
    ]);
    expect(declaredFiles(pack)).toEqual([
      { relative: "notes/overview.md", limit: 16384, kind: "note" },
      {
        relative: "tools/search-repositories.mjs",
        limit: 262144,
        kind: "tool",
      },
      {
        relative: "page-tools/repository-stats.js",
        limit: 32768,
        kind: "pageTool",
      },
    ]);

    const failures = [];
    for (const [why, change, pattern] of rules) {
      const manifest = good();
      change(manifest);
      const read = await readPack(manifest);
      if (pattern === null) {
        if (!read.pack) failures.push(`${why}: ${read.text}`);
      } else if (read.pack || !pattern.test(read.text))
        failures.push(`${why}: ${read.text || "no problem"}`);
    }
    expect(failures).toEqual([]);

    // The document itself: too large, not a file, not an object, not JSON.
    const huge = await readPack({ ...good(), notes: [repeat(70000)] });
    expect(huge.pack).toBe(null);
    expect(huge.text).toMatch(/^pack\.json: .*at most 64 KiB\.$/);
    const list = await readPack("[]");
    expect(list.text).toMatch(
      /^pack\.json: pack\.json must hold a JSON object\.$/,
    );
    const broken = await readPack("{");
    expect(broken.text).toMatch(/^pack\.json: pack\.json is not valid JSON \(/);
    const folder = join(sites, "folder-pack");
    await rm(folder, { recursive: true, force: true });
    await mkdir(join(folder, "pack.json"), { recursive: true, mode: 0o700 });
    const read = await readManifest(folder, {
      source: "workspace",
      id: "folder-pack",
    });
    expect(read.pack).toBe(null);
    expect(read.problems.map(problemText)).toEqual([
      "pack.json: pack.json must be a regular file.",
    ]);
    const empty = join(sites, "empty-pack");
    await rm(empty, { recursive: true, force: true });
    await mkdir(empty, { mode: 0o700 });
    const missing = await readManifest(empty, {
      source: "workspace",
      id: "empty-pack",
    });
    expect(missing.problems.map(problemText)).toEqual([
      "pack.json: pack.json is missing.",
    ]);
  });

  it("refuses linked, foreign owned or group writable paths and reports each root's state", async () => {
    const roots = siteRoots({ KAMAPATHY_WORKSPACE: workspace });
    expect(roots).toEqual([
      { path: sites, source: "workspace" },
      {
        path: resolve(
          fileURLToPath(new URL("../skills/kamapathy/sites", import.meta.url)),
        ),
        source: "bundled",
      },
    ]);

    const files = {
      "notes/overview.md": "How this site works.\n",
      "tools/search-repositories.mjs":
        "export const searchRepositories = () => [];\n",
      "page-tools/repository-stats.js": "() => null\n",
    };
    const dir = await writePack("github", good(), files);
    const space = { path: dir, source: "workspace" };
    const read = (relative, kind, root = space) =>
      readTrustedFile(root, relative, {
        owner: root.source === "workspace",
        kind,
      });
    expect(
      JSON.parse((await read("pack.json", "manifest")).toString()),
    ).toMatchObject({ id: "github" });

    // A linked pack folder, a linked file and a linked folder in between.
    const linked = join(sites, "linked");
    await rm(linked, { recursive: true, force: true });
    await symlink(dir, linked);
    const linkedPack = await read("pack.json", "manifest", {
      path: linked,
      source: "workspace",
    }).catch((error) => error);
    expect(linkedPack).toBeInstanceOf(PackProblem);
    expect(linkedPack.file).toBe("pack.json");
    expect(problemText(linkedPack)).toBe(
      `pack.json: ${linked} is a link. Site packs hold only regular files and folders.`,
    );
    const viaManifest = await readManifest(linked, {
      source: "workspace",
      id: "linked",
    });
    expect(viaManifest.pack).toBe(null);
    expect(viaManifest.problems.map(problemText)).toEqual([
      problemText(linkedPack),
    ]);

    const outside = join(workspace, "outside.md");
    await writeFile(outside, "Planted.\n", { mode: 0o600 });
    const links = await writePack("links", { ...good(), id: "links" }, files);
    await rm(join(links, "notes/overview.md"), { force: true });
    await symlink(outside, join(links, "notes/overview.md"));
    const linkedNote = await read("notes/overview.md", "note", {
      path: links,
      source: "workspace",
    }).catch((error) => error);
    expect(linkedNote.file).toBe("notes/overview.md");
    expect(problemText(linkedNote)).toBe(
      "notes/overview.md: notes/overview.md is a link. Site packs hold only regular files and folders.",
    );

    const between = await writePack(
      "between",
      { ...good(), id: "between" },
      files,
    );
    await rm(join(between, "notes"), { recursive: true, force: true });
    await symlink(join(dir, "notes"), join(between, "notes"));
    const linkedFolder = await read("notes/overview.md", "note", {
      path: between,
      source: "workspace",
    }).catch((error) => error);
    expect(problemText(linkedFolder)).toBe(
      "notes/overview.md: notes is a link. Site packs hold only regular files and folders.",
    );

    // Mode and ownership, under the workspace only.
    if (posix) {
      await chmod(join(dir, "pack.json"), 0o660);
      const shared = await read("pack.json", "manifest").catch(
        (error) => error,
      );
      expect(shared.file).toBe("pack.json");
      expect(problemText(shared)).toBe(
        `pack.json: pack.json must be owned by your account and not changeable by others. Run chmod go-w ${join(dir, "pack.json")}.`,
      );
      // The bundled root shares the trust of the client beside it: links only.
      const bundled = { path: dir, source: "bundled" };
      expect(
        JSON.parse((await read("pack.json", "manifest", bundled)).toString()),
      ).toMatchObject({ id: "github" });
      const bundledLink = await read("notes/overview.md", "note", {
        path: links,
        source: "bundled",
      }).catch((error) => error);
      expect(problemText(bundledLink)).toMatch(/is a link\./);
      await chmod(join(dir, "pack.json"), 0o600);

      // No account here can create a file another account owns, so the
      // account's own id moves instead and the pack reads as another's.
      const other = vi
        .spyOn(process, "getuid")
        .mockReturnValue(process.getuid() + 1);
      const foreign = await read("pack.json", "manifest").catch(
        (error) => error,
      );
      expect(foreign.file).toBe("pack.json");
      expect(problemText(foreign)).toBe(
        `pack.json: ${dir} must be owned by your account and not changeable by others. Run chmod go-w ${dir}.`,
      );
      other.mockRestore();
    }

    // Each root's state.
    expect(await rootState({ path: sites, source: "workspace" })).toEqual({
      path: sites,
      source: "workspace",
      state: "ok",
    });
    expect(
      await rootState({ path: join(workspace, "absent"), source: "workspace" }),
    ).toEqual({
      path: join(workspace, "absent"),
      source: "workspace",
      state: "missing",
    });
    expect(
      await rootState({ path: join(workspace, "absent"), source: "bundled" }),
    ).toMatchObject({ state: "missing" });
    const linkedRoot = join(workspace, "linked-sites");
    await rm(linkedRoot, { force: true });
    await symlink(sites, linkedRoot);
    expect(
      await rootState({ path: linkedRoot, source: "bundled" }),
    ).toMatchObject({
      state: "refused",
      problem: expect.stringMatching(/is a link\./),
    });
    if (posix) {
      await chmod(workspace, 0o707);
      expect(await rootState({ path: sites, source: "workspace" })).toEqual({
        path: sites,
        source: "workspace",
        state: "refused",
        problem: `Kamapathy's workspace ${workspace} must be a folder your account owns that others cannot change.`,
      });
      await chmod(workspace, 0o700);
      await chmod(sites, 0o707);
      expect(
        await rootState({ path: sites, source: "workspace" }),
      ).toMatchObject({
        state: "refused",
        problem: `${sites} must be owned by your account and not changeable by others. Run chmod go-w ${sites}.`,
      });
      await chmod(sites, 0o700);
    }
  });

  it("matches exact hosts and strict subdomains only", () => {
    const packs = [
      { id: "exact", domains: ["github.com"] },
      { id: "wild", domains: ["*.github.com"] },
      { id: "punycode", domains: ["xn--bcher-kva.example"] },
      { id: "local", domains: ["127.0.0.1"] },
    ];
    const matches = (target) => {
      const { host } = hostOf(target, { entry: "siteContext" });
      return { host, ids: matchPacks(packs, host).map((pack) => pack.id) };
    };
    expect(matches("https://gist.github.com/x")).toEqual({
      host: "gist.github.com",
      ids: ["wild"],
    });
    expect(matches("https://a.b.github.com")).toEqual({
      host: "a.b.github.com",
      ids: ["wild"],
    });
    expect(matches("github.com")).toEqual({
      host: "github.com",
      ids: ["exact"],
    });
    expect(matches("https://GitHub.com.:8443/x")).toEqual({
      host: "github.com",
      ids: ["exact"],
    });
    expect(matches({ url: "https://bücher.example/" })).toEqual({
      host: "xn--bcher-kva.example",
      ids: ["punycode"],
    });
    expect(matches("127.0.0.1")).toEqual({
      host: "127.0.0.1",
      ids: ["local"],
    });
    // Another scheme, and a page that has not navigated, match nothing.
    for (const target of [
      "about:blank",
      "file:///x",
      { url: "" },
      { id: "t1", label: "p1" },
    ])
      expect(matches(target)).toEqual({ host: null, ids: [] });

    expect(hostOf("github.com", { entry: "siteContext" })).toEqual({
      url: "https://github.com/",
      host: "github.com",
    });
    expect(hostOf("about:blank", { entry: "siteContext" })).toEqual({
      url: "about:blank",
      host: null,
    });
    expect(hostOf({ url: "" }, { entry: "siteContext" })).toEqual({
      url: null,
      host: null,
    });

    for (const target of ["not a host", ""]) {
      let failure = null;
      try {
        hostOf(target, { entry: "siteContext" });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(KamapathyError);
      expect(failure.code).toBe("invalid_argument");
      expect(failure.entry).toBe("siteContext");
      expect(failure.message).toBe(
        `siteContext got ${JSON.stringify(target)} for target. Expected a complete http or https URL, a host such as github.com, or a Page.`,
      );
    }
  });

  it("orders exact matches, then longer wildcards, then ids; a workspace folder hides the bundled pack even when invalid; pack.json is read on every call", async () => {
    const { env, roots } = await freshRoots();
    const [space, bundled] = roots;
    for (const [id, domains] of [
      ["alpha", ["a.b.c.example"]],
      ["beta", ["a.b.c.example"]],
      ["both", ["*.c.example", "a.b.c.example"]],
      ["wild-b", ["*.b.c.example"]],
      ["wild-c", ["*.c.example"]],
    ])
      await writePackIn(space.path, id, bare(id, domains));
    await writePackIn(bundled.path, "github", good());

    const loaded = await loadPacks(env, { roots });
    expect(loaded.roots).toEqual([
      { path: space.path, source: "workspace", state: "ok" },
      { path: bundled.path, source: "bundled", state: "ok" },
    ]);
    expect(loaded.skipped).toEqual([]);
    // The best entry of each pack decides its place, exact entries first.
    expect(
      matchPacks(loaded.packs, "a.b.c.example").map((pack) => [
        pack.id,
        pack.matchedBy,
      ]),
    ).toEqual([
      ["alpha", "a.b.c.example"],
      ["beta", "a.b.c.example"],
      ["both", "a.b.c.example"],
      ["wild-b", "*.b.c.example"],
      ["wild-c", "*.c.example"],
    ]);
    // A wildcard takes no host of its own, and a pack matches by its best
    // entry.
    expect(
      matchPacks(loaded.packs, "b.c.example").map((pack) => [
        pack.id,
        pack.matchedBy,
      ]),
    ).toEqual([
      ["both", "*.c.example"],
      ["wild-c", "*.c.example"],
    ]);
    expect(matchPacks(loaded.packs, "c.example")).toEqual([]);
    expect(matchPacks(loaded.packs, null)).toEqual([]);

    const matched = await listSitePacks(env, "https://a.b.c.example/x", {
      roots,
    });
    expect(matched.host).toBe("a.b.c.example");
    expect(matched.packs.map((pack) => pack.id)).toEqual([
      "alpha",
      "beta",
      "both",
      "wild-b",
      "wild-c",
    ]);
    // A summary names the folder, the notes and both kinds of tool.
    expect(matched.packs[0]).toEqual({
      id: "alpha",
      name: "alpha",
      source: "workspace",
      dir: join(space.path, "alpha"),
      domains: ["a.b.c.example"],
      notes: [],
      tools: [],
    });

    const every = await listSitePacks(env, undefined, { roots });
    expect(Object.hasOwn(every, "host")).toBe(false);
    expect(every.packs.map((pack) => pack.id)).toEqual([
      "alpha",
      "beta",
      "both",
      "github",
      "wild-b",
      "wild-c",
    ]);
    expect(every.packs.find((pack) => pack.id === "github")).toEqual({
      id: "github",
      name: "GitHub",
      source: "bundled",
      dir: join(bundled.path, "github"),
      domains: ["github.com"],
      notes: ["notes/overview.md"],
      tools: [
        {
          name: "search_repositories",
          kind: "node",
          description: "Search repositories and read the first results.",
        },
        {
          name: "repository_stats",
          kind: "page",
          description:
            "Read the stars, forks and topics of the open repository.",
        },
      ],
    });
    expect(
      summarize(loaded.packs.find((pack) => pack.id === "github")),
    ).toEqual(every.packs.find((pack) => pack.id === "github"));

    // A workspace folder hides the bundled pack with its id, valid or not.
    await writePackIn(
      bundled.path,
      "shared",
      bare("shared", ["bundled.example"]),
    );
    const first = await listSitePacks(env, undefined, { roots });
    expect(first.packs.find((pack) => pack.id === "shared")).toMatchObject({
      source: "bundled",
      domains: ["bundled.example"],
    });
    await writePackIn(
      space.path,
      "shared",
      bare("shared", ["workspace.example"]),
    );
    const second = await listSitePacks(env, undefined, { roots });
    expect(second.packs.find((pack) => pack.id === "shared")).toMatchObject({
      source: "workspace",
      domains: ["workspace.example"],
    });
    expect(second.skipped).toEqual([]);
    await writePackIn(space.path, "shared", "{");
    const broken = await listSitePacks(env, undefined, { roots });
    expect(broken.packs.some((pack) => pack.id === "shared")).toBe(false);
    expect(broken.skipped).toEqual([
      {
        path: join(space.path, "shared"),
        source: "workspace",
        problem: expect.stringContaining(
          "pack.json: pack.json is not valid JSON (",
        ),
      },
    ]);

    // Every call reads pack.json again, so an edit lands at once.
    await writePackIn(space.path, "alpha", {
      ...bare("alpha", ["edited.example"]),
      name: "Edited",
    });
    const edited = await listSitePacks(env, undefined, { roots });
    expect(edited.packs.find((pack) => pack.id === "alpha")).toMatchObject({
      name: "Edited",
      domains: ["edited.example"],
    });
  });

  it("reports unreadable packs under skipped", async () => {
    const { env, roots } = await freshRoots();
    const space = roots[0];
    await writePackIn(space.path, "broken", "{");
    await writePackIn(space.path, "mismatch", bare("other", ["other.example"]));
    const fine = await writePackIn(
      space.path,
      "fine",
      bare("fine", ["fine.example"]),
    );
    await symlink(fine, join(space.path, "linked"));
    const shared = await writePackIn(
      space.path,
      "shared",
      bare("shared", ["shared.example"]),
    );
    if (posix) await chmod(join(shared, "pack.json"), 0o660);
    // Ignored without a word: a draft, a hidden folder and a loose file.
    for (const name of ["_draft", ".hidden"]) {
      await mkdir(join(space.path, name), { mode: 0o700 });
      await writeFile(join(space.path, name, "pack.json"), "{", {
        mode: 0o600,
      });
    }
    await writeFile(join(space.path, "README.md"), "Packs live here.\n", {
      mode: 0o600,
    });

    const { packs, skipped } = await loadPacks(env, { roots });
    expect(packs.map((pack) => pack.id)).toEqual(
      posix ? ["fine"] : ["fine", "shared"],
    );
    expect(skipped.map((row) => [row.path, row.source])).toEqual([
      [join(space.path, "broken"), "workspace"],
      [join(space.path, "linked"), "workspace"],
      [join(space.path, "mismatch"), "workspace"],
      ...(posix ? [[join(space.path, "shared"), "workspace"]] : []),
    ]);
    expect(skipped[0].problem).toMatch(
      /^pack\.json: pack\.json is not valid JSON \(/,
    );
    expect(skipped[1].problem).toBe(
      `pack.json: ${join(space.path, "linked")} is a link. Site packs hold only regular files and folders.`,
    );
    expect(skipped[2].problem).toBe(
      'id: id must be "mismatch", the name of the pack\'s folder.',
    );
    if (posix)
      expect(skipped[3].problem).toBe(
        `pack.json: pack.json must be owned by your account and not changeable by others. Run chmod go-w ${join(shared, "pack.json")}.`,
      );

    if (posix) {
      // A refused root is one line of its own and none of its packs is read.
      await chmod(space.path, 0o707);
      const refused = await loadPacks(env, { roots });
      expect(refused.packs).toEqual([]);
      expect(refused.skipped).toEqual([
        {
          path: space.path,
          source: "workspace",
          problem: `${space.path} must be owned by your account and not changeable by others. Run chmod go-w ${space.path}.`,
        },
      ]);
      expect(refused.roots[0]).toMatchObject({ state: "refused" });
      await chmod(space.path, 0o700);
    }
    if (posix && process.getuid() !== 0) {
      await chmod(space.path, 0o300);
      const unreadable = await loadPacks(env, { roots });
      expect(unreadable.skipped).toEqual([
        {
          path: space.path,
          source: "workspace",
          problem: `${space.path} could not be read (EACCES).`,
        },
      ]);
      await chmod(space.path, 0o700);
    }

    // More than 200 folders: the first 200 by name, and one line saying so.
    const many = await freshRoots();
    await Promise.all(
      Array.from({ length: 205 }, (_value, index) => {
        const id = `p${String(index).padStart(3, "0")}`;
        return writePackIn(many.roots[0].path, id, bare(id, [`${id}.example`]));
      }),
    );
    const cut = await loadPacks(many.env, { roots: many.roots });
    expect(cut.packs.length).toBe(200);
    expect(cut.packs.at(-1).id).toBe("p199");
    expect(cut.skipped).toEqual([
      {
        path: many.roots[0].path,
        source: "workspace",
        problem: `${many.roots[0].path} holds more than 200 pack folders. Only the first 200 by name are read.`,
      },
    ]);

    // At most 20 packs are reported.
    const noisy = await freshRoots();
    await Promise.all(
      Array.from({ length: 25 }, (_value, index) =>
        writePackIn(
          noisy.roots[0].path,
          `b${String(index).padStart(2, "0")}`,
          "{",
        ),
      ),
    );
    const capped = await loadPacks(noisy.env, { roots: noisy.roots });
    expect(capped.packs).toEqual([]);
    expect(capped.skipped.map((row) => row.path)).toEqual(
      Array.from({ length: 20 }, (_value, index) =>
        join(noisy.roots[0].path, `b${String(index).padStart(2, "0")}`),
      ),
    );

    // Named no roots, a call reads the workspace's sites folder and the one
    // beside the client.
    const home = await mkdtemp(join(tmpdir(), "kamapathy-site-default-"));
    temporary.push(home);
    await chmod(home, 0o700);
    const both = await loadPacks({ KAMAPATHY_WORKSPACE: home });
    expect(both.roots.map((root) => [root.path, root.source])).toEqual(
      siteRoots({ KAMAPATHY_WORKSPACE: home }).map((root) => [
        root.path,
        root.source,
      ]),
    );
    expect(both.roots[0].state).toBe("missing");
    expect(both.packs.every((pack) => pack.source === "bundled")).toBe(true);
  });

  it("cleans control and bidirectional characters, keeping newlines when asked", () => {
    expect(cleanText("a\u0007b\u202ec\u0085")).toBe("abc");
    expect(cleanText("a\tb\nc\rd", { newlines: true })).toBe("a\tb\ncd");
    expect(cleanText("a\tb\nc")).toBe("abc");
    expect(cleanText(undefined)).toBe("");
  });

  it("siteContext reads notes and builds example calls", async () => {
    const { env, roots } = await freshRoots();
    const [space] = roots;
    const notePath = join(space.path, "github", "notes", "overview.md");
    await writePackIn(space.path, "github", contextPack(), {
      "notes/overview.md": OVERVIEW,
      "notes/issues.md": "Issues live at /issues.\n",
    });

    const context = await siteContextFor(env, "https://gist.github.com/x", {
      roots,
    });
    expect(context.url).toBe("https://gist.github.com/x");
    expect(context.host).toBe("gist.github.com");
    expect(context.skipped).toEqual([]);
    expect(context.packs).toHaveLength(1);
    const [pack] = context.packs;
    expect(pack).toMatchObject({
      id: "github",
      name: "GitHub",
      source: "workspace",
      dir: join(space.path, "github"),
      domains: ["*.github.com", "github.com"],
      matchedBy: "*.github.com",
    });
    // Notes keep the order the manifest declares, with control and
    // bidirectional characters gone and tabs and newlines kept.
    expect(pack.notes).toEqual([
      {
        file: "notes/overview.md",
        text: "# GitHub\n\nSearch at /search?q=<q>\tand read the rows.\nclean\n",
      },
      { file: "notes/issues.md", text: "Issues live at /issues.\n" },
    ]);
    // Node tools come first in declaration order, then page tools, each with
    // its arguments in order and an example holding its required ones.
    expect(pack.tools).toEqual([
      {
        name: "search_repositories",
        kind: "node",
        description: "Search repositories and read the first results.",
        args: [
          {
            name: "query",
            type: "string",
            required: true,
            description: "Words to search for.",
          },
          {
            name: "limit",
            type: "integer",
            required: false,
            description: "How many results to read, 10 by default.",
          },
        ],
        returns: {
          type: "array",
          description: "[{ fullName, url, description, stars, language }]",
        },
        example:
          'await runSiteTool("github", "search_repositories", { query: "<query>" }, { page })',
      },
      {
        name: "open_issues",
        kind: "node",
        description: "Read the open issues of one repository.",
        args: [
          {
            name: "owner",
            type: "string",
            required: true,
            description: "The account the repository belongs to.",
          },
          {
            name: "repo",
            type: "string",
            required: true,
            description: "The repository name.",
          },
          {
            name: "limit",
            type: "integer",
            required: true,
            description: "How many issues to read, 25 by default.",
          },
        ],
        returns: {
          type: "array",
          description: "[{ number, title, url, labels }]",
        },
        example:
          'await runSiteTool("github", "open_issues", { owner: "<owner>", repo: "<repo>", limit: <limit> }, { page })',
      },
      {
        name: "repository_stats",
        kind: "page",
        description: "Read the stars, forks and topics of the open repository.",
        args: [],
        returns: {
          type: "object",
          description: "{ fullName, stars, forks }",
        },
        example:
          'await runPageTool("github", "repository_stats", {}, { page })',
      },
    ]);

    // The url is what the target parsed to, and the entry that matched is
    // the closest one.
    const exact = await siteContextFor(env, "github.com", { roots });
    expect(exact.url).toBe("https://github.com/");
    expect(exact.packs.map((item) => item.matchedBy)).toEqual(["github.com"]);
    // A page that has not navigated matches nothing and names no host.
    expect(await siteContextFor(env, { url: "" }, { roots })).toEqual({
      url: "",
      host: null,
      packs: [],
      skipped: [],
    });

    // A note over its limit skips the whole pack: half a pack's notes would
    // mislead an agent.
    await writeFile(notePath, "x".repeat(LIMITS.note + 1), { mode: 0o600 });
    const oversized = await siteContextFor(env, "github.com", { roots });
    expect(oversized.packs).toEqual([]);
    expect(oversized.skipped).toEqual([
      {
        path: join(space.path, "github"),
        source: "workspace",
        problem: "notes/overview.md: notes/overview.md must be at most 16 KiB.",
      },
    ]);
    // So does a note the manifest declares and the folder does not hold.
    await rm(notePath);
    const missing = await siteContextFor(env, "github.com", { roots });
    expect(missing.packs).toEqual([]);
    expect(missing.skipped).toEqual([
      {
        path: join(space.path, "github"),
        source: "workspace",
        problem: "notes/overview.md: notes/overview.md is missing.",
      },
    ]);
  });

  it("sitePacks and siteContext send nothing and take a Page, a URL or a host", async () => {
    const { env, roots } = await freshRoots();
    await writePackIn(
      roots[0].path,
      "alpha",
      { ...bare("alpha", ["a.b.c.example"]), notes: ["notes/overview.md"] },
      { "notes/overview.md": "Open /start to begin.\n" },
    );
    let sent = 0;
    const fetch = () => {
      sent += 1;
      throw new Error("A site pack call sent a request.");
    };
    // An app this old predates every site pack call, and neither call needs
    // Kamapathy at all, so its level changes nothing.
    const client = await connect({
      env,
      fetch,
      health: { status: "ok", version: "0.1.9", apiLevel: 1 },
    });
    expect(client.app).toMatchObject({ apiLevel: 1 });

    // A Page is read by the last url it recorded. No session is needed: the
    // page is never asked anything.
    const page = new Page(null, {
      id: "tab-1",
      spaceId: "space-1",
      url: "https://a.b.c.example/start",
      title: "Start",
    });
    const matched = await client.sitePacks(page);
    expect(matched.host).toBe("a.b.c.example");
    expect(matched.packs.map((item) => item.id)).toEqual(["alpha"]);
    const context = await client.siteContext(page);
    expect(context).toMatchObject({
      url: "https://a.b.c.example/start",
      host: "a.b.c.example",
      skipped: [],
    });
    expect(context.packs.map((item) => [item.id, item.matchedBy])).toEqual([
      ["alpha", "a.b.c.example"],
    ]);
    expect(context.packs[0].notes).toEqual([
      { file: "notes/overview.md", text: "Open /start to begin.\n" },
    ]);
    expect(context.packs[0].tools).toEqual([]);

    // A host and a URL reach the same pack.
    for (const target of ["a.b.c.example", "https://a.b.c.example/other"]) {
      const listed = await client.sitePacks(target);
      expect(
        listed.packs.map((item) => item.id),
        target,
      ).toEqual(["alpha"]);
    }
    const blank = new Page(null, { id: "tab-2", url: "", title: "" });
    expect(await client.siteContext(blank)).toEqual({
      url: "",
      host: null,
      packs: [],
      skipped: [],
    });
    // Without a target the listing names no host.
    const every = await client.sitePacks();
    expect(Object.hasOwn(every, "host")).toBe(false);
    expect(every.packs.some((item) => item.id === "alpha")).toBe(true);

    // A target of another kind is refused, by the call that got it.
    await expect(client.siteContext("not a host")).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "siteContext",
    });
    for (const target of [5, true, null, {}])
      await expect(
        client.siteContext(target),
        String(target),
      ).rejects.toMatchObject({
        code: "invalid_argument",
        entry: "kamapathy.siteContext",
      });
    await expect(client.siteContext()).rejects.toMatchObject({
      code: "invalid_argument",
      message:
        "kamapathy.siteContext got no target. Expected kamapathy.siteContext(target).",
    });
    expect(sent).toBe(0);
  });

  it("runSiteTool checks args before loading the tool", async () => {
    const { env, roots } = await freshRoots();
    // The marker sits beside the workspace, so only an import of the tool's
    // module can write it.
    const marker = join(dirname(roots[0].path), "imported.txt");
    await writePackIn(roots[0].path, "github", argsPack(), {
      "tools/search-repositories.mjs": `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "imported");
export const searchRepositories = (context, args) => args;
`,
      "tools/read-types.mjs":
        "export const readTypes = (context, args) => args;\n",
    });
    const page = new Page(null, {
      id: "tab-1",
      spaceId: "space-1",
      url: "https://github.com/",
      title: "GitHub",
    });
    const run = (tool, args) =>
      runToolIn(env, {
        packId: "github",
        tool,
        args,
        page,
        client: null,
        roots,
      });
    const expected = {
      search_repositories: "{ query: string, limit?: integer }",
      read_types:
        "{ text?: string, count?: number, tags?: array, shape?: object, flag?: boolean }",
    };
    class Args {
      constructor() {
        this.query = "kamapathy";
      }
    }
    const cases = [
      // undefined means no arguments at all, so a required one is missing.
      ["search_repositories", undefined, ["query is required."]],
      ["search_repositories", {}, ["query is required."]],
      // An undefined value counts as absent; null never passes.
      ["search_repositories", { query: undefined }, ["query is required."]],
      ["search_repositories", { query: null }, ["query must be a string."]],
      ["search_repositories", { query: 5 }, ["query must be a string."]],
      [
        "search_repositories",
        { query: "kamapathy", limit: 1.5 },
        ["limit must be an integer."],
      ],
      [
        "search_repositories",
        { query: "kamapathy", limit: 2 ** 53 },
        ["limit must be an integer."],
      ],
      [
        "search_repositories",
        { query: "kamapathy", extra: 1 },
        ["extra is not an argument of search_repositories."],
      ],
      [
        "search_repositories",
        { nope: 1 },
        [
          "nope is not an argument of search_repositories.",
          "query is required.",
        ],
      ],
      // Anything that is not a plain object is refused whole.
      ["search_repositories", null, ["arguments must be an object."]],
      ["search_repositories", [], ["arguments must be an object."]],
      ["search_repositories", "{}", ["arguments must be an object."]],
      ["search_repositories", new Args(), ["arguments must be an object."]],
      [
        "search_repositories",
        new Map([["query", "kamapathy"]]),
        ["arguments must be an object."],
      ],
      ["read_types", { count: Number.NaN }, ["count must be a number."]],
      [
        "read_types",
        { count: Number.POSITIVE_INFINITY },
        ["count must be a number."],
      ],
      ["read_types", { tags: {} }, ["tags must be an array."]],
      ["read_types", { shape: [] }, ["shape must be an object."]],
      ["read_types", { shape: new Args() }, ["shape must be an object."]],
      ["read_types", { flag: "true" }, ["flag must be a boolean."]],
      ["read_types", { text: 5 }, ["text must be a string."]],
    ];
    for (const [index, [tool, args, problems]] of cases.entries()) {
      const failed = await run(tool, args).then(
        () => null,
        (error) => error,
      );
      const where = `case ${index}`;
      expect(failed?.code, where).toBe("invalid_tool_args");
      expect(failed.packId, where).toBe("github");
      expect(failed.tool, where).toBe(tool);
      expect(failed.problems, where).toEqual(problems);
      expect(failed.expected, where).toBe(expected[tool]);
      expect(failed.message, where).toBe(
        `${tool} in the github pack got invalid arguments: ${problems[0]}`,
      );
    }
    // A packId or a tool name outside its pattern is the call's own mistake.
    for (const [packId, tool, name] of [
      ["GitHub", "search_repositories", "packId"],
      ["", "search_repositories", "packId"],
      ["github", "Search", "tool"],
      ["github", "", "tool"],
    ]) {
      const refused = await runToolIn(env, {
        packId,
        tool,
        args: {},
        page,
        client: null,
        roots,
      }).then(
        () => null,
        (error) => error,
      );
      expect(refused?.code, `${packId} ${tool}`).toBe("invalid_argument");
      expect(refused.entry, `${packId} ${tool}`).toBe("runSiteTool");
      expect(refused.message, `${packId} ${tool}`).toContain(name);
    }
    // Nothing above imported a module, so the marker is still absent.
    expect(existsSync(marker)).toBe(false);
    // A tool with no required arguments takes a plain object and runs.
    expect(await run("read_types", {})).toEqual({});
    expect(await run("read_types", { text: "x", count: undefined })).toEqual({
      text: "x",
    });
    expect(existsSync(marker)).toBe(false);
    // The tool that passes its check is the one that loads.
    expect(
      await run("search_repositories", { query: "kamapathy", limit: 5 }),
    ).toEqual({ query: "kamapathy", limit: 5 });
    expect(existsSync(marker)).toBe(true);
  });

  it("runSiteTool passes page, client and pack, and reloads only a changed file", async () => {
    const { env, roots } = await freshRoots();
    const home = dirname(roots[0].path);
    await writeFile(join(home, "shared.mjs"), SHARED_MODULE, { mode: 0o600 });
    const tool = join(roots[0].path, "github", "tools", "report.mjs");
    await writePackIn(roots[0].path, "github", reportPack("github", "GitHub"), {
      "tools/report.mjs": REPORT_TOOL,
    });
    await writePackIn(roots[0].path, "beta", reportPack("beta", "Beta"), {
      "tools/report.mjs": REPORT_TOOL,
    });
    let sent = 0;
    const fetch = () => {
      sent += 1;
      throw new Error("A site pack call sent a request.");
    };
    const client = await connect({
      env,
      fetch,
      health: { status: "ok", version: "0.2.0", apiLevel: 4 },
    });
    const page = new Page(null, {
      id: "tab-1",
      spaceId: "space-1",
      url: "https://github.example/",
      title: "GitHub",
    });
    const args = { query: "keep" };
    const first = await client.runSiteTool("github", "report", args, { page });
    // The tool works in the page it was given, through this client, and
    // knows only the pack's own four fields.
    expect(first.page).toBe(page);
    expect(first.kamapathy).toBe(client);
    expect(first.pack).toEqual({
      id: "github",
      name: "GitHub",
      dir: join(roots[0].path, "github"),
      source: "workspace",
    });
    // Its arguments are a copy, so what it writes leaves the caller's
    // object as it was.
    expect(first.args).toEqual({ query: "mutated" });
    expect(first.args).not.toBe(args);
    expect(args).toEqual({ query: "keep" });
    expect([first.calls, first.shared]).toEqual([1, 1]);
    // An unchanged file keeps the module Node already loaded.
    const second = await client.runSiteTool("github", "report", args, { page });
    expect([second.calls, second.shared]).toEqual([2, 2]);
    // Another pack's tool is its own module, over the same shared import.
    const other = await client.runSiteTool("beta", "report", {}, { page });
    expect([other.calls, other.shared]).toEqual([1, 3]);
    expect(other.pack).toMatchObject({ id: "beta", name: "Beta" });
    // An edited file loads fresh, while its own import stays loaded.
    await writeFile(tool, `${REPORT_TOOL}// edited\n`, { mode: 0o600 });
    const edited = await client.runSiteTool("github", "report", args, { page });
    expect([edited.calls, edited.shared]).toEqual([1, 4]);
    // The options must carry a Page from this client.
    await expect(
      client.runSiteTool("github", "report", {}, { page: { id: "tab-1" } }),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "kamapathy.runSiteTool",
    });
    await expect(
      client.runSiteTool("github", "report", {}, {}),
    ).rejects.toMatchObject({ code: "invalid_option", option: "page" });
    await expect(
      client.runSiteTool("github", "report", {}),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(sent).toBe(0);
  });

  it("KamapathyErrors pass through tagged, other throws become site_tool_failed with at, unknown packs name the searched roots", async () => {
    const { env, roots } = await freshRoots();
    const errors = new URL(
      "../skills/kamapathy/scripts/lib/errors.mjs",
      import.meta.url,
    ).href;
    const dir = await writePackIn(roots[0].path, "github", failurePack(), {
      "tools/thrower.mjs": THROWER_TOOL,
      "tools/raise.mjs": RAISE_TOOL(errors),
      "tools/extras.mjs": EXTRAS_TOOL,
    });
    const page = new Page(null, {
      id: "tab-1",
      spaceId: "space-1",
      url: "https://github.com/",
      title: "GitHub",
    });
    const run = (tool, packId = "github") =>
      runToolIn(env, {
        packId,
        tool,
        args: {},
        page,
        client: null,
        roots,
      }).then(
        () => null,
        (error) => error,
      );

    // A KamapathyError from inside is the error the run sees, with the pack
    // and the tool added.
    const held = await run("stopped");
    expect(held).toMatchObject({
      code: "human_control",
      reason: "manual",
      packId: "github",
      tool: "stopped",
    });
    expect(held.message).toBe("The person has control of the space.");
    expect(hardStopCause(held)).toBe("control");
    expect(await run("timed_out")).toMatchObject({
      code: "timeout",
      retryable: true,
      dispatched: true,
      packId: "github",
      tool: "timed_out",
    });

    // Anything else is the tool's failure, naming the frame it threw from.
    const failed = await run("thrower");
    expect(failed).toMatchObject({
      code: "site_tool_failed",
      packId: "github",
      tool: "thrower",
      at: "tools/thrower.mjs:3:9",
    });
    expect(failed.cause).toBe("no 1");
    expect(failed.message).toBe("The github tool thrower failed: no 1.");

    // An export the module does not have, and one that is not a function,
    // are the pack's own problem.
    const absent = await run("missing_export");
    expect(absent).toMatchObject({
      code: "site_pack_invalid",
      packId: "github",
      dir,
      problems: ["tools/extras.mjs: does not export absent."],
    });
    expect(absent.message).toBe(
      "The github pack breaks its rules: tools/extras.mjs: does not export absent.",
    );
    expect(await run("not_function")).toMatchObject({
      code: "site_pack_invalid",
      problems: ["tools/extras.mjs: exports number, which is not a function."],
    });

    // An unknown tool names the kind, what the pack has and the other map.
    const unknown = await run("repository_stats");
    expect(unknown).toMatchObject({
      code: "site_tool_not_found",
      packId: "github",
      tool: "repository_stats",
      kind: "node",
      available: [
        "thrower",
        "stopped",
        "timed_out",
        "missing_export",
        "not_function",
      ],
    });
    expect(unknown.message).toBe(
      "The github pack has no Node tool named repository_stats. Available: thrower, stopped, timed_out, missing_export, not_function. repository_stats is a page tool. Call runPageTool.",
    );
    await writePackIn(roots[0].path, "quiet", bare("quiet", ["quiet.example"]));
    expect((await run("anything", "quiet")).message).toBe(
      "The quiet pack has no Node tool named anything. Available: none.",
    );

    // A pack that breaks its rules names the first problem and counts the
    // rest.
    await writePackIn(roots[0].path, "broken", {
      format: 2,
      id: "broken",
      name: "",
      domains: [],
    });
    const broken = await run("report", "broken");
    expect(broken).toMatchObject({
      code: "site_pack_invalid",
      packId: "broken",
      dir: join(roots[0].path, "broken"),
      problems: [
        "format: format must be 1.",
        "name: name must be 1 to 48 characters.",
        "domains: domains must list 1 to 32 hosts.",
      ],
    });
    expect(broken.message).toBe(
      "The broken pack breaks its rules: format: format must be 1. 2 more problems.",
    );

    // A workspace folder hides the pack the skill ships, broken or not.
    await writePackIn(
      roots[1].path,
      "shadowed",
      bare("shadowed", ["shadowed.example"]),
    );
    await writePackIn(roots[0].path, "shadowed", "{");
    expect(await run("anything", "shadowed")).toMatchObject({
      code: "site_pack_invalid",
      dir: join(roots[0].path, "shadowed"),
    });

    // An id in neither root names both paths and the state each is in.
    const bundled = join(dirname(roots[1].path), "nothing");
    const missing = await runToolIn(env, {
      packId: "nope",
      tool: "report",
      args: {},
      page,
      client: null,
      roots: [roots[0], { path: bundled, source: "bundled" }],
    }).then(
      () => null,
      (error) => error,
    );
    expect(missing).toMatchObject({
      code: "site_pack_not_found",
      packId: "nope",
    });
    expect(missing.roots).toEqual([
      { path: roots[0].path, source: "workspace", state: "ok" },
      { path: bundled, source: "bundled", state: "missing" },
    ]);
    expect(missing.message).toBe(
      `No site pack named "nope" is in Kamapathy's workspace or the skill. Looked in ${roots[0].path} (ok) and ${bundled} (missing).`,
    );
  });

  it("runPageTool sends one evaluate holding the file and args, and refuses 16 KiB of args or a syntax error before sending", async () => {
    const { env, roots } = await freshRoots();
    const dir = await writePackIn(roots[0].path, "github", pagePack(), {
      "tools/search-repositories.mjs":
        "export const searchRepositories = () => [];\n",
      "page-tools/repository-stats.js": STATS_PAGE_TOOL,
      "page-tools/broken.js": BROKEN_PAGE_TOOL,
    });
    // The one request a page tool sends, over a session with an injected
    // fetch, so every byte of the evaluate is observable.
    const sent = [];
    let reply = () =>
      Response.json({
        ok: true,
        tab: { id: "t1" },
        value: { fullName: "kamapathy", stars: 3 },
      });
    const session = new Session({
      env,
      fetch: async (url, init) => {
        sent.push({
          path: url.pathname,
          method: init.method,
          body: JSON.parse(init.body),
        });
        return reply();
      },
      health: { status: "ok", version: "0.2.0", apiLevel: 4 },
    });
    const evaluate = async (source, arg, limit = 1048576) => {
      const { value } = await session.request("/tabs/t1/evaluate", {
        method: "POST",
        body: { function: source, arg },
        limit,
      });
      return value;
    };
    const run = (tool, args, over = evaluate) =>
      runPageToolIn(env, {
        packId: "github",
        tool,
        args,
        evaluate: over,
        roots,
      }).then(
        (value) => value,
        (error) => error,
      );

    // The file is the function, with a newline after it so a trailing line
    // comment cannot swallow the call, and the arguments are its argument.
    const source = `${STATS_PAGE_TOOL}\n`;
    expect(await run("repository_stats", { stars: 3 })).toEqual({
      fullName: "kamapathy",
      stars: 3,
    });
    expect(sent).toEqual([
      {
        path: "/tabs/t1/evaluate",
        method: "POST",
        body: { function: source, arg: { stars: 3 } },
      },
    ]);
    // The same call, built without sending anything, names the pack and the
    // tool it came from.
    const built = await pageToolCall(env, {
      packId: "github",
      tool: "repository_stats",
      args: { stars: 3 },
      roots,
    });
    expect(built.source).toBe(source);
    expect(built.arg).toEqual({ stars: 3 });
    expect(built.pack).toMatchObject({ id: "github", dir });
    expect(built.tool.name).toBe("repository_stats");
    // No arguments at all reach the page as an empty object.
    sent.length = 0;
    await run("repository_stats", undefined);
    expect(sent[0].body).toEqual({ function: source, arg: {} });

    // Arguments over 16 KiB of JSON are refused before anything is sent.
    sent.length = 0;
    const big = await run("repository_stats", {
      note: "x".repeat(LIMITS.pageToolArgs),
    });
    expect(big).toMatchObject({
      code: "invalid_tool_args",
      packId: "github",
      tool: "repository_stats",
      problems: ["the arguments are larger than 16 KiB."],
      expected: "{ stars?: integer, note?: string }",
    });
    expect(big.message).toBe(
      "repository_stats in the github pack got invalid arguments: the arguments are larger than 16 KiB.",
    );
    // An undeclared argument is refused the same way the Node tools are.
    expect(await run("repository_stats", { forks: 2 })).toMatchObject({
      code: "invalid_tool_args",
      problems: ["forks is not an argument of repository_stats."],
    });
    // A file that does not compile is the pack's own problem, with its line.
    const broken = await run("broken", {});
    expect(broken).toMatchObject({
      code: "site_pack_invalid",
      packId: "github",
      dir,
    });
    expect(broken.problems.length).toBe(1);
    expect(broken.problems[0]).toMatch(
      /^page-tools\/broken\.js:2: does not compile \(/,
    );
    expect(broken.message).toMatch(
      /^The github pack breaks its rules: page-tools\/broken\.js:2: does not compile \(/,
    );
    // A Node tool asked for as a page tool names the call that runs it.
    const node = await run("search_repositories", {});
    expect(node).toMatchObject({
      code: "site_tool_not_found",
      packId: "github",
      tool: "search_repositories",
      kind: "page",
      available: ["repository_stats", "broken"],
    });
    expect(node.message).toBe(
      "The github pack has no page tool named search_repositories. Available: repository_stats, broken. search_repositories is a Node tool. Call runSiteTool.",
    );
    // A name or a pack id outside its pattern is the call's own mistake.
    expect(await run("Repository Stats", {})).toMatchObject({
      code: "invalid_argument",
      entry: "runPageTool",
    });
    expect(
      await runPageToolIn(env, {
        packId: "nope",
        tool: "repository_stats",
        args: {},
        evaluate,
        roots,
      }).catch((error) => error),
    ).toMatchObject({ code: "site_pack_not_found", packId: "nope" });
    expect(sent).toEqual([]);

    // Every failure the route raises comes back as it was, with the pack and
    // the tool added.
    for (const [status, error] of EVALUATE_FAILURES) {
      reply = () => Response.json({ ok: false, error }, { status });
      const failed = await run("repository_stats", { stars: 1 });
      // An Error keeps its own name, so a field of that name is the one
      // thing the transport cannot carry.
      const { name, ...fields } = error;
      expect(failed, error.code).toMatchObject({
        ...fields,
        status,
        packId: "github",
        tool: "repository_stats",
      });
      expect(failed.message, error.code).toBe(error.message);
      expect(failed.retryable, error.code).toBeUndefined();
    }
    reply = () =>
      Response.json({ ok: true, tab: { id: "t1" }, value: { stars: 0 } });

    // A body over the route's limit fails before it is sent. The file and
    // the arguments together stay well inside the route's own 1 MiB, so this
    // takes a smaller limit to reach at all.
    sent.length = 0;
    const large = await run("repository_stats", { stars: 1 }, (source, arg) =>
      evaluate(source, arg, 64),
    );
    expect(large).toMatchObject({
      code: "request_too_large",
      packId: "github",
      tool: "repository_stats",
    });
    expect(sent).toEqual([]);
  });

  it("runPageTool reaches the page through the client, which checks the page it was given", async () => {
    const { env, roots } = await freshRoots();
    await writePackIn(roots[0].path, "github", pagePack(), {
      "tools/search-repositories.mjs":
        "export const searchRepositories = () => [];\n",
      "page-tools/repository-stats.js": STATS_PAGE_TOOL,
      "page-tools/broken.js": BROKEN_PAGE_TOOL,
    });
    let sent = 0;
    const client = await connect({
      env,
      fetch: () => {
        sent += 1;
        throw new Error("A site pack call sent a request.");
      },
      health: { status: "ok", version: "0.2.0", apiLevel: 4 },
    });
    const page = new Page(null, {
      id: "tab-1",
      spaceId: "space-1",
      url: "https://github.com/kamapathy",
      title: "kamapathy",
    });
    // The method's one call on the page is the evaluate it was asked for: a
    // function, so the page sends the file as the route's function field and
    // the arguments as its argument.
    const seen = [];
    page.evaluate = (fn, arg) => {
      seen.push({ kind: typeof fn, source: String(fn), arg });
      return Promise.resolve({ fullName: "kamapathy", stars: 7 });
    };
    expect(
      await client.runPageTool(
        "github",
        "repository_stats",
        { stars: 7 },
        {
          page,
        },
      ),
    ).toEqual({ fullName: "kamapathy", stars: 7 });
    expect(seen).toEqual([
      { kind: "function", source: `${STATS_PAGE_TOOL}\n`, arg: { stars: 7 } },
    ]);

    // The options must carry a Page from this client.
    await expect(
      client.runPageTool(
        "github",
        "repository_stats",
        {},
        {
          page: { id: "tab-1" },
        },
      ),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "kamapathy.runPageTool",
    });
    await expect(
      client.runPageTool("github", "repository_stats", {}, {}),
    ).rejects.toMatchObject({ code: "invalid_option", option: "page" });
    await expect(
      client.runPageTool("github", "repository_stats", {}),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(sent).toBe(0);
  });

  it("bundled packs pass the validator", async () => {
    const [, bundled] = siteRoots({ KAMAPATHY_WORKSPACE: workspace });
    expect(bundled.path).toBe(
      resolve(
        fileURLToPath(new URL("../skills/kamapathy/sites", import.meta.url)),
      ),
    );
    // The sample packs arrive with their own tasks. Until then the folder is
    // simply absent, and a root that cannot be read fails either way.
    const state = await rootState(bundled);
    expect(["ok", "missing"]).toContain(state.state);
    const ids =
      state.state === "ok"
        ? (await readdir(bundled.path, { withFileTypes: true }))
            .filter(
              (entry) =>
                entry.isDirectory() &&
                !entry.name.startsWith("_") &&
                !entry.name.startsWith("."),
            )
            .map((entry) => entry.name)
            .sort()
        : [];
    for (const id of ids) {
      const checked = await checkPack(join(bundled.path, id), {
        source: "bundled",
        id,
      });
      expect(checked.problems.map(problemText), id).toEqual([]);
      expect(checked.ok, id).toBe(true);
      expect(checked.source, id).toBe("bundled");
    }
    // The samples this worktree ships; each one arrives with its own task.
    const samples = ["github", "google-search", "x"];
    expect(ids).toEqual(expect.arrayContaining(samples));
    // The github sample's own tools: the names its manifest declares, and an
    // export runSiteTool can call for each Node tool.
    const { pack } = await readManifest(join(bundled.path, "github"), {
      source: "bundled",
      id: "github",
    });
    expect(pack.tools.map((tool) => tool.name)).toEqual([
      "search_repositories",
      "open_issues",
    ]);
    expect(pack.pageTools.map((tool) => tool.name)).toEqual([
      "repository_stats",
    ]);
    for (const tool of pack.tools)
      expect(typeof (await importToolExport(pack, tool)), tool.name).toBe(
        "function",
      );
    // The google-search sample's own tools, read the same way.
    const google = await readManifest(join(bundled.path, "google-search"), {
      source: "bundled",
      id: "google-search",
    });
    expect(google.pack.tools.map((tool) => tool.name)).toEqual(["search"]);
    expect(google.pack.pageTools.map((tool) => tool.name)).toEqual([
      "suggestions",
    ]);
    for (const tool of google.pack.tools)
      expect(
        typeof (await importToolExport(google.pack, tool)),
        tool.name,
      ).toBe("function");
    // The x sample's own tools and its two notes, read the same way.
    const x = await readManifest(join(bundled.path, "x"), {
      source: "bundled",
      id: "x",
    });
    expect(x.pack.tools.map((tool) => tool.name)).toEqual([
      "timeline_posts",
      "search_people",
    ]);
    expect(x.pack.pageTools.map((tool) => tool.name)).toEqual(["focused_post"]);
    expect(x.pack.notes).toEqual(["notes/overview.md", "notes/timeline.md"]);
    for (const tool of x.pack.tools)
      expect(typeof (await importToolExport(x.pack, tool)), tool.name).toBe(
        "function",
      );
  });

  it("checkPack reports every rule", async () => {
    const lines = (checked) => checked.problems.map(problemText);
    const check = async (id, manifest, files = {}) =>
      checkPack(await writePack(id, manifest, files), {
        source: "workspace",
        id,
      });

    // A pack that breaks no rule, with every kind of file.
    const clean = await check("github", good(), {
      "notes/overview.md": "How this site works.\n",
      "tools/search-repositories.mjs":
        "export const searchRepositories = () => [];\n",
      "page-tools/repository-stats.js": "() => null\n",
    });
    expect(clean).toEqual({
      id: "github",
      source: "workspace",
      dir: join(sites, "github"),
      ok: true,
      problems: [],
    });

    // A manifest problem keeps its field, and nothing else is read: the
    // files this pack declares are all absent.
    const manifest = await check("broken", {
      ...good(),
      id: "broken",
      format: 2,
    });
    expect(manifest.ok).toBe(false);
    expect(manifest.problems).toEqual([
      { field: "format", message: "format must be 1." },
    ]);

    // A folder with no pack.json, checked with the defaults.
    const folder = join(sites, "nothing");
    await rm(folder, { recursive: true, force: true });
    await mkdir(folder, { mode: 0o700 });
    const nothing = await checkPack(folder);
    expect(nothing.id).toBe("nothing");
    expect(nothing.source).toBe("workspace");
    expect(lines(nothing)).toEqual(["pack.json: pack.json is missing."]);

    // The file rules, one pack per rule.
    const notePack = (id) => ({
      format: 1,
      id,
      name: id,
      domains: [`${id}.example`],
      notes: ["notes/overview.md"],
    });
    // A missing folder is named by the component that is absent, a missing
    // file by the file itself.
    expect(lines(await check("absent", notePack("absent")))).toEqual([
      "notes/overview.md: notes is missing.",
    ]);
    expect(
      lines(
        await check("absent-file", notePack("absent-file"), {
          "notes/other.md": "Another note, which nothing declares.\n",
        }),
      ),
    ).toEqual(["notes/overview.md: notes/overview.md is missing."]);
    expect(
      lines(
        await check("oversized", notePack("oversized"), {
          "notes/overview.md": "x".repeat(LIMITS.note + 1),
        }),
      ),
    ).toEqual(["notes/overview.md: notes/overview.md must be at most 16 KiB."]);
    const planted = join(workspace, "planted.md");
    await writeFile(planted, "Planted.\n", { mode: 0o600 });
    const linked = await writePack("linked", notePack("linked"));
    await mkdir(join(linked, "notes"), { recursive: true, mode: 0o700 });
    await symlink(planted, join(linked, "notes", "overview.md"));
    expect(
      lines(await checkPack(linked, { source: "workspace", id: "linked" })),
    ).toEqual([
      "notes/overview.md: notes/overview.md is a link. Site packs hold only regular files and folders.",
    ]);
    if (posix) {
      const shared = await check("shared", notePack("shared"), {
        "notes/overview.md": "How this site works.\n",
      });
      expect(lines(shared)).toEqual([]);
      await chmod(join(sites, "shared", "notes", "overview.md"), 0o660);
      expect(
        lines(await checkPack(join(sites, "shared"), { id: "shared" })),
      ).toEqual([
        `notes/overview.md: notes/overview.md must be owned by your account and not changeable by others. Run chmod go-w ${join(sites, "shared", "notes", "overview.md")}.`,
      ]);
    }
    expect(
      lines(
        await check("bytes", notePack("bytes"), {
          "notes/overview.md": Buffer.from([0x41, 0xff, 0x42]),
        }),
      ),
    ).toEqual(["notes/overview.md: notes/overview.md must be UTF-8 text."]);

    // Node tools: the import runs the file's own code, the export must be a
    // function, and the tool itself is never called.
    const imported = join(workspace, "imported.txt");
    const called = join(workspace, "called.txt");
    await rm(imported, { force: true });
    await rm(called, { force: true });
    const tool = (file, exported) => ({
      description: "A tool.",
      file,
      export: exported,
      returns: { type: "object", description: "A value." },
    });
    const tooled = await check(
      "tooled",
      {
        format: 1,
        id: "tooled",
        name: "tooled",
        domains: ["tooled.example"],
        tools: {
          throws_on_import: tool("tools/boom.mjs", "run"),
          missing_export: tool("tools/extras.mjs", "absent"),
          not_function: tool("tools/extras.mjs", "number"),
          marks: tool("tools/marks.mjs", "marks"),
          with_ref: tool("tools/with-ref.mjs", "withRef"),
        },
      },
      {
        "tools/boom.mjs": 'throw new Error("boom");\n',
        "tools/extras.mjs": EXTRAS_TOOL,
        "tools/marks.mjs": `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(imported)}, "imported");
export const marks = () => writeFileSync(${JSON.stringify(called)}, "called");
`,
        "tools/with-ref.mjs": `// Click @e9 after the rows load.
export const withRef = () => "\u200fok";
`,
      },
    );
    expect(lines(tooled)).toEqual([
      'tools/with-ref.mjs:1: holds the temporary ref @e9. Refs change with every snapshot; use a locator such as role=button[name="Save"].',
      "tools/with-ref.mjs:2: holds a bidirectional control (U+200F), which can hide what the text says.",
      "tools/boom.mjs: could not be imported (boom).",
      "tools/extras.mjs: does not export absent.",
      "tools/extras.mjs: exports number, which is not a function.",
    ]);
    // The import ran the module's own code; nothing called the export.
    expect(existsSync(imported)).toBe(true);
    expect(existsSync(called)).toBe(false);

    // A file the rules already refused is never imported, so one broken
    // file reports one problem.
    const linkedTool = await writePack("linked-tool", {
      format: 1,
      id: "linked-tool",
      name: "linked-tool",
      domains: ["linked-tool.example"],
      tools: { marks: tool("tools/marks.mjs", "marks") },
    });
    await mkdir(join(linkedTool, "tools"), { recursive: true, mode: 0o700 });
    await symlink(planted, join(linkedTool, "tools", "marks.mjs"));
    expect(lines(await checkPack(linkedTool, { id: "linked-tool" }))).toEqual([
      "tools/marks.mjs: tools/marks.mjs is a link. Site packs hold only regular files and folders.",
    ]);

    // Page tools: one function expression that compiles, after comments.
    const pageTool = async (name, source) => {
      const id = `page-${name}`;
      const checked = await check(
        id,
        {
          format: 1,
          id,
          name: id,
          domains: [`${id}.example`],
          pageTools: {
            read: {
              description: "A page tool.",
              file: "page-tools/read.js",
              returns: { type: "object", description: "A value." },
            },
          },
        },
        { "page-tools/read.js": source },
      );
      return lines(checked);
    };
    const refused = [
      "page-tools/read.js: must hold one function expression, such as (args) => document.title.",
    ];
    expect(await pageTool("arrow", "(args) => document.title\n")).toEqual([]);
    expect(
      await pageTool(
        "function",
        "function read(args) {\n  return document.title\n}\n",
      ),
    ).toEqual([]);
    expect(await pageTool("async", "async (args) => document.title\n")).toEqual(
      [],
    );
    expect(await pageTool("named", "args => document.title\n")).toEqual([]);
    expect(
      await pageTool(
        "commented",
        "// Reads the title.\n/* and nothing else */\n(args) => document.title\n",
      ),
    ).toEqual([]);
    expect(await pageTool("statement", "const x = 1\n")).toEqual(refused);
    expect(await pageTool("object", "{ title: 1 }\n")).toEqual(refused);
    expect(await pageTool("broken", "(args) => {\n  return ]\n}\n")).toEqual([
      "page-tools/read.js:2: does not compile (Unexpected token ']').",
    ]);

    // Temporary refs and bidirectional controls in a note, with their line.
    const twelve = `${Array.from(
      { length: 11 },
      (_value, index) => `Line ${index + 1}.`,
    ).join("\n")}\nSave with @e14 after typing.\n`;
    expect(
      lines(
        await check("refs", notePack("refs"), { "notes/overview.md": twelve }),
      ),
    ).toEqual([
      'notes/overview.md:12: holds the temporary ref @e14. Refs change with every snapshot; use a locator such as role=button[name="Save"].',
    ]);
    expect(
      lines(
        await check("addresses", notePack("addresses"), {
          "notes/overview.md": "Write to user@e1.example, a@e1 and x.@e1.\n",
        }),
      ),
    ).toEqual([]);
    expect(
      lines(
        await check("bidi", notePack("bidi"), {
          "notes/overview.md": "How this site works.\nSave with \u202eRTL.\n",
        }),
      ),
    ).toEqual([
      "notes/overview.md:2: holds a bidirectional control (U+202E), which can hide what the text says.",
    ]);
  });

  it("checkAll reports every pack in both roots, by id or by folder", async () => {
    const { env, roots } = await freshRoots();
    await writePackIn(roots[0].path, "github", good(), {
      "notes/overview.md": "How this site works.\n",
      "tools/search-repositories.mjs":
        "export const searchRepositories = () => [];\n",
      "page-tools/repository-stats.js": "() => null\n",
    });
    await writePackIn(roots[0].path, "broken", {
      format: 1,
      id: "broken",
      name: "broken",
      domains: ["broken.example"],
      notes: ["notes/overview.md"],
    });
    await writePackIn(roots[1].path, "beta", bare("beta", ["beta.example"]));
    // A workspace folder hides the bundled pack with its id, and a folder
    // starting with _ is no pack at all.
    await writePackIn(
      roots[1].path,
      "github",
      bare("github", ["other.example"]),
    );
    await writePackIn(roots[0].path, "_hidden", bare("hidden", ["h.example"]));

    const all = await checkAll(env, { roots });
    expect(all.packs.map((pack) => [pack.id, pack.source, pack.ok])).toEqual([
      ["broken", "workspace", false],
      ["github", "workspace", true],
      ["beta", "bundled", true],
    ]);
    expect(all.packs[0].problems.map(problemText)).toEqual([
      "notes/overview.md: notes is missing.",
    ]);
    expect(all.packs[1].dir).toBe(join(roots[0].path, "github"));
    expect(all.ok).toBe(false);
    expect(all.missing).toEqual([]);

    // One id, one folder of a root, and arguments that name no pack.
    const some = await checkAll(env, {
      roots,
      targets: [
        "github",
        join(roots[1].path, "beta"),
        "nope",
        join(roots[0].path, "absent"),
      ],
    });
    expect(some.packs.map((pack) => [pack.id, pack.source, pack.ok])).toEqual([
      ["github", "workspace", true],
      ["beta", "bundled", true],
    ]);
    expect(some.missing).toEqual(["nope", join(roots[0].path, "absent")]);
    expect(some.ok).toBe(false);

    const one = await checkAll(env, { roots, targets: ["github"] });
    expect(one.packs).toHaveLength(1);
    expect(one.ok).toBe(true);
    expect(one.missing).toEqual([]);
  });

  it("helpers.mjs exports become globals after .env loads", async () => {
    const home = await helperWorkspace({
      ".env": "FIXTURE_KEY=from-dot-env\n",
    });
    const helpers = join(home, "helpers.mjs");
    const log = join(home, "loads.txt");
    await writeFile(
      helpers,
      [
        `import { appendFileSync } from "node:fs";`,
        `appendFileSync(${JSON.stringify(log)}, "loaded\\n");`,
        // The top level runs after .env, so the key is already in place.
        `const key = process.env.FIXTURE_KEY;`,
        `export const fixtureKey = () => key;`,
        `export function fixtureGreet(name) {`,
        `  return "hello " + name;`,
        `}`,
        `export const _fixturePrivate = () => "private";`,
        `export default function fixtureDefault() {`,
        `  return "default";`,
        `}`,
        ``,
      ].join("\n"),
      { mode: 0o600 },
    );
    const script = [
      `import { readFileSync } from "node:fs";`,
      `const fail = (message) => {`,
      `  throw new Error(message);`,
      `};`,
      `if (fixtureKey() !== "from-dot-env") fail("key " + fixtureKey());`,
      `if (fixtureGreet("world") !== "hello world") fail("second export");`,
      `if (typeof _fixturePrivate !== "undefined") fail("private export");`,
      `if (typeof fixtureDefault !== "undefined") fail("default export");`,
      `if (globalThis.default !== undefined) fail("default name");`,
      `const shape = Object.getOwnPropertyDescriptor(globalThis, "fixtureGreet");`,
      `if (!shape.writable || !shape.configurable || shape.enumerable)`,
      `  fail("shape " + JSON.stringify(shape, (_key, value) => typeof value));`,
      `if (Object.keys(globalThis).includes("fixtureGreet")) fail("enumerable");`,
      `const again = await import(${JSON.stringify(pathToFileURL(helpers).href)});`,
      `if (again.fixtureGreet !== fixtureGreet) fail("another module");`,
      `const loads = readFileSync(${JSON.stringify(log)}, "utf8");`,
      `if (loads !== "loaded\\n") fail("loads " + JSON.stringify(loads));`,
      `globalThis.fixtureGreet = () => "mine";`,
      `if (fixtureGreet() !== "mine") fail("not writable");`,
      `process.stdout.write("ok\\n");`,
    ].join("\n");
    expect(await runWith(home, script)).toEqual({
      status: 0,
      stdout: "ok\n",
      stderr: "",
    });

    // A workspace without the file changes nothing a run already had.
    const bare = await helperWorkspace({ ".env": "FIXTURE_KEY=only-env\n" });
    expect(
      await runWith(
        bare,
        [
          `if (typeof fixtureKey !== "undefined") throw new Error("helpers");`,
          `if (typeof spaces !== "function") throw new Error("globals");`,
          `if (process.env.FIXTURE_KEY !== "only-env") throw new Error("env");`,
          `process.stdout.write("bare\\n");`,
        ].join("\n"),
      ),
    ).toEqual({ status: 0, stdout: "bare\n", stderr: "" });
    expect(await loadHelperModule(bare, {})).toBeNull();
  }, 30000);

  it("a taken name, a failed import, a link or a group writable helpers.mjs ends the run with helpers_failed", async () => {
    const long = `no FIXTURE_KEY: ${repeat(400)}`;
    const cases = [
      {
        what: "a name Node already uses",
        helpers: `export const fetch = () => "mine";\n`,
        message:
          "Kamapathy could not load helpers.mjs: it exports fetch, which is already a global. Rename it, or start the name with _ to keep it private.",
      },
      {
        what: "a name the client installs",
        helpers: `export const sitePacks = () => [];\n`,
        message:
          "Kamapathy could not load helpers.mjs: it exports sitePacks, which is already a global. Rename it, or start the name with _ to keep it private.",
      },
      {
        what: "a name no script can use",
        helpers: `const value = 1;\nexport { value as "two words" };\n`,
        message:
          'Kamapathy could not load helpers.mjs: it exports "two words", which is not a name a script can use. Rename it, or start the name with _ to keep it private.',
      },
      {
        what: "a throw at the top level, cut to 300 characters",
        helpers: `throw new Error(${JSON.stringify(long)});\n`,
        message: `Kamapathy could not load helpers.mjs: ${long.slice(0, 300)}`,
      },
    ];
    for (const entry of cases) {
      const home = await helperWorkspace({ "helpers.mjs": entry.helpers });
      const marker = join(home, "ran.txt");
      const run = await runWith(
        home,
        [
          `import { writeFileSync } from "node:fs";`,
          `writeFileSync(${JSON.stringify(marker)}, "ran");`,
        ].join("\n"),
      );
      expect(run, entry.what).toEqual({
        status: 1,
        stdout: "",
        stderr: `error: helpers_failed: ${entry.message}\n`,
      });
      expect(existsSync(marker), entry.what).toBe(false);
    }

    // A file Node cannot parse fails the same way, in Node's own words.
    const unparsed = await helperWorkspace({
      "helpers.mjs": "export const = 1;\n",
    });
    const broken = await runWith(unparsed, `process.stdout.write("ran\\n");`);
    expect(broken.status).toBe(1);
    expect(broken.stdout).toBe("");
    expect(broken.stderr).toMatch(
      /^error: helpers_failed: Kamapathy could not load helpers\.mjs: \S[^\n]*\n$/,
    );

    // The workspace file rules: no link, and off Windows nothing group or
    // others can change.
    const marker = "ran.txt";
    const writes = (home) =>
      [
        `import { writeFileSync } from "node:fs";`,
        `writeFileSync(${JSON.stringify(join(home, marker))}, "ran");`,
      ].join("\n");
    const linked = await helperWorkspace({
      "real.mjs": `export const fixtureLinked = () => 1;\n`,
    });
    await symlink(join(linked, "real.mjs"), join(linked, "helpers.mjs"));
    expect(await runWith(linked, writes(linked))).toEqual({
      status: 1,
      stdout: "",
      stderr: refusalText(linked),
    });
    expect(existsSync(join(linked, marker))).toBe(false);
    if (posix) {
      const shared = await helperWorkspace({
        "helpers.mjs": `export const fixtureShared = () => 1;\n`,
      });
      await chmod(join(shared, "helpers.mjs"), 0o664);
      expect(await runWith(shared, writes(shared))).toEqual({
        status: 1,
        stdout: "",
        stderr: refusalText(shared),
      });
      expect(existsSync(join(shared, marker))).toBe(false);
    }

    // The 256 KiB cap, with nothing defined on the target it was given.
    expect(HELPER_LIMIT).toBe(262144);
    const big = await helperWorkspace({
      "helpers.mjs": `export const fixtureBig = () => 1;\n// ${repeat(HELPER_LIMIT)}\n`,
    });
    const target = {};
    const refused = await loadHelperModule(big, target).catch((error) => error);
    expect(refused).toBeInstanceOf(KamapathyError);
    expect(refused.code).toBe("helpers_failed");
    expect(refused.path).toBe(join(big, "helpers.mjs"));
    expect(`error: helpers_failed: ${refused.message}\n`).toBe(
      refusalText(big),
    );
    expect(Object.keys(target)).toEqual([]);

    // The repl loads the same file before its prompt, and leaves without
    // one. The waiting .exit is never read, so a session that starts anyway
    // says so at once.
    const session = await helperWorkspace({ "helpers.mjs": cases[0].helpers });
    const input = new PassThrough();
    input.write(".exit\n");
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => (text += chunk));
    expect(
      await runCli(["repl"], {
        env: { KAMAPATHY_NO_LAUNCH: "1", KAMAPATHY_WORKSPACE: session },
        fetch: vi.fn(),
        stdin: input,
        stdout: output,
        terminal: true,
      }),
    ).toBe(1);
    expect(text).toBe(`error: helpers_failed: ${cases[0].message}\n`);
  }, 30000);
});
