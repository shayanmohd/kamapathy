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
  PackProblem,
  cleanText,
  declaredFiles,
  problemText,
  readManifest,
  readTrustedFile,
  rootState,
  siteRoots,
} from "../skills/kamapathy/scripts/lib/sites.mjs";

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

// A pack folder holding a pack.json and whatever files a case needs.
async function writePack(id, manifest, files = {}) {
  const dir = join(sites, id);
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

  it("cleans control and bidirectional characters, keeping newlines when asked", () => {
    expect(cleanText("a\u0007b\u202ec\u0085")).toBe("abc");
    expect(cleanText("a\tb\nc\rd", { newlines: true })).toBe("a\tb\ncd");
    expect(cleanText("a\tb\nc")).toBe("abc");
    expect(cleanText(undefined)).toBe("");
  });
});
