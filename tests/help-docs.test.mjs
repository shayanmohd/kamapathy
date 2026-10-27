import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  formatErrors,
  formatGeneralHelp,
  formatIndex,
  formatPageScripts,
  formatRoutes,
  formatSelectors,
  helpTopic,
} from "../skills/kamapathy/scripts/help.mjs";
import {
  COMMANDS,
  ENTRIES,
  ENVIRONMENT,
  ERRORS,
  findCommand,
  GLOBAL_FLAGS,
} from "../skills/kamapathy/scripts/schema/index.mjs";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The Node.js version package.json requires, as people write it: 22.13.
const NODE = JSON.parse(read("package.json"))
  .engines.node.replace(/^>=/, "")
  .replace(/\.0$/, "");
const general = formatGeneralHelp(
  "kamapathy",
  "/Users/avery/.claude/skills/kamapathy/SKILL.md",
);

// Markdown read as the help prints it: no code ticks or bold, single spaces.
const plain = (text) => text.replace(/[`*]/g, "").replace(/\s+/g, " ");
const guide = read("docs/automation.md");
const connect = guide.indexOf("\n## Connect\n");
const CONNECT = plain(
  guide.slice(connect, guide.indexOf("\n## ", connect + 1)),
);
const CONNECTION = plain(read("skills/kamapathy/references/connection.md"));

// Each sentence of the preamble, with the words the Connect section of
// docs/automation.md and references/connection.md give the same fact in.
const PREAMBLE = [
  {
    help: "Kamapathy connects automatically.",
    guide: ["Agents connect automatically."],
    connection: ["Kamapathy connects automatically."],
  },
  {
    help: "Each command finds Kamapathy on this computer and starts it when agent access was left on.",
    guide: [
      "The bundled client finds it with no token or setup, and starts Kamapathy when it is not running and access was left on.",
    ],
    connection: [
      "Every command finds Kamapathy on this computer",
      "If Kamapathy is not running and agent access was left on, the client starts Kamapathy",
    ],
  },
  {
    help: "The switch in Settings, under Agents, turns access off.",
    guide: [
      "While agent access is on in Settings, under Agents (the default)",
      "Turning agent access off stops the socket, and the client never starts Kamapathy against that choice.",
    ],
    connection: [
      "The person switched it off in Settings, under Agents.",
      "The client never starts Kamapathy while access is off.",
    ],
  },
  {
    help: "Set KAMAPATHY_USER_DATA to use another profile.",
    guide: ["Set KAMAPATHY_USER_DATA to reach a different profile."],
    connection: ["Set KAMAPATHY_USER_DATA to reach a different profile"],
  },
  {
    help: `Requires Node.js ${NODE} or later.`,
    guide: [
      `needs Node.js ${NODE} or later for every command but help and --version`,
    ],
    connection: [
      `Every command except help and --version needs Node.js ${NODE} or later`,
    ],
  },
];

describe("kamapathy help", () => {
  it("names the Node.js version, every group, flag and variable, and where to read more", () => {
    expect(general).toContain(`Requires Node.js ${NODE} or later.`);
    const lines = general.split("\n");
    for (const group of new Set(COMMANDS.map((command) => command.group)))
      expect(lines, group).toContain(group);
    for (const command of COMMANDS) {
      expect(general, command.name).toContain(command.usage);
      expect(general, command.name).toContain(command.summary);
    }
    for (const { name, description } of [...GLOBAL_FLAGS, ...ENVIRONMENT]) {
      expect(general, name).toContain(name);
      expect(general, name).toContain(description);
    }
    for (const pointer of ["help <command>", "--version", "references/api.md"])
      expect(general, pointer).toContain(pointer);
    expect(
      existsSync(
        new URL("../skills/kamapathy/references/api.md", import.meta.url),
      ),
    ).toBe(true);
    // The hand-written lines fit a terminal; the columns and usage may not.
    for (const line of lines.filter(
      (text) => !text.startsWith("  ") && !text.startsWith("Usage: "),
    ))
      expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it("answers for every command, every script entry and every topic", () => {
    for (const command of COMMANDS)
      expect(
        helpTopic(command.name.split(" "), "kamapathy").split("\n")[0],
      ).toBe(`Usage: kamapathy ${command.usage}`);
    for (const entry of ENTRIES) {
      expect(helpTopic(["api", entry.name], "kamapathy"), entry.name).toContain(
        entry.signature,
      );
      // A bare topic is a command first, as spaces and help are.
      for (const name of [entry.name, entry.signature.split("(")[0]]) {
        const command = findCommand(name);
        expect(helpTopic([name], "kamapathy"), name).toContain(
          command ? `Usage: kamapathy ${command.usage}` : entry.signature,
        );
      }
    }
    expect(helpTopic(["api"], "kamapathy")).toBe(formatIndex());
    expect(helpTopic(["errors"], "kamapathy")).toBe(formatErrors());
    expect(helpTopic(["routes"], "kamapathy")).toBe(formatRoutes());
    expect(helpTopic(["selectors"], "kamapathy")).toBe(formatSelectors());
    expect(helpTopic(["page-scripts"], "kamapathy")).toBe(formatPageScripts());
  });

  it("offers close matches for a topic it does not know", () => {
    expect(() => helpTopic(["snapshto"], "kamapathy")).toThrow(
      'No help topic "snapshto". Close matches: snapshot.',
    );
    for (const [typed, meant] of [
      ["selectros", "selectors"],
      ["erors", "errors"],
      ["page.clik", "page.click"],
      ["sites chek", "sites check"],
    ])
      expect(() => helpTopic(typed.split(" "), "kamapathy"), typed).toThrow(
        meant,
      );
    expect(() => helpTopic(["zzzzzz"], "kamapathy")).toThrow(
      /^No help topic "zzzzzz"\.$/,
    );
  });

  it("says what the agent guide and connection.md say about connecting and starting", () => {
    const preamble = general.split("\n\n").at(1).replace(/\n/g, " ");
    expect(preamble.split(/(?<=\.) /)).toEqual(PREAMBLE.map((row) => row.help));
    for (const row of PREAMBLE) {
      for (const words of row.guide) expect(CONNECT, row.help).toContain(words);
      for (const words of row.connection)
        expect(CONNECTION, row.help).toContain(words);
    }
  });
});

describe("what the help says frames, page scripts and runs do", () => {
  it("names no retired code among a call's errors, and still explains each", () => {
    const retired = Object.keys(ERRORS).filter((code) =>
      ERRORS[code].summary.startsWith("Retired"),
    );
    expect(retired).toEqual(
      expect.arrayContaining(["cross_origin_frame", "screenshot_unavailable"]),
    );
    for (const entry of ENTRIES)
      expect(
        entry.errors.filter((code) => retired.includes(code)),
        entry.name,
      ).toEqual([]);
    for (const code of retired) expect(formatErrors(), code).toContain(code);
    expect(formatErrors()).toContain(
      "Retired: frames from other origins are read and actionable, so no route returns this.",
    );
    // A click works inside a frame from any web origin, and one that lands on
    // an extension or an internal page is refused.
    const click = helpTopic(["page.click"], "kamapathy");
    expect(click).toContain("input_target_blocked: 403, not retryable");
    expect(click).not.toContain("cross_origin_frame");
  });
});
