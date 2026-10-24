import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIMITS,
  PackProblem,
  cleanText,
  declaredFiles,
  hostOf,
  listSitePacks,
  loadPacks,
  matchPacks,
  problemText,
  readManifest,
  readTrustedFile,
  rootState,
  siteContextFor,
  siteRoots,
  summarize,
} from "../skills/kamapathy/scripts/lib/sites.mjs";
import { KamapathyError } from "../skills/kamapathy/scripts/lib/errors.mjs";
import { Page, connect } from "../skills/kamapathy/scripts/api.mjs";

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
  const base = await mkdtemp(join(tmpdir(), "kamapathy-site-roots-"));
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
});
