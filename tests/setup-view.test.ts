import { describe, expect, it } from "vitest";
import type { AgentSetupStatus } from "../shared/types";
import {
  agentHint,
  initialChoices,
  nodeWarning,
  pathOption,
  setupRequest,
  setupSummary,
} from "../src/lib/setupView";

const HOME = "/Users/ada";
const SKILL = `${HOME}/.local/share/kamapathy/skill`;
type Agent = AgentSetupStatus["agents"][number];

function agent(id: string, name: string, state: Agent["state"]): Agent {
  return { id, name, folder: `${HOME}/.${id}/skills`, state };
}

function status({
  command,
  codex,
  ...rest
}: Partial<Omit<AgentSetupStatus, "command" | "codex">> & {
  command?: Partial<AgentSetupStatus["command"]>;
  codex?: Partial<AgentSetupStatus["codex"]>;
} = {}): AgentSetupStatus {
  return {
    supported: true,
    skillFolder: null,
    agents: [
      agent("claude-code", "Claude Code", "available"),
      agent("codex", "Codex", "own_copy"),
      agent("cursor", "Cursor", "available"),
    ],
    node: { found: true, version: "24.1.0" },
    ...rest,
    command: {
      state: "off",
      path: `${HOME}/.local/bin/kamapathy`,
      onPath: false,
      profileFile: `${HOME}/.zshrc`,
      pathAdded: false,
      ...command,
    },
    codex: { detected: true, allowed: false, ...codex },
  };
}

const WINDOWS_COMMAND = {
  path: "C:\\Users\\ada\\AppData\\Local\\Kamapathy\\tools\\bin\\kamapathy.cmd",
  profileFile: null,
};

describe("set up agents panel", () => {
  it("checks linked agents, or every detected agent before any setup", () => {
    expect(initialChoices(status(), "darwin")).toEqual({
      agents: ["claude-code", "codex", "cursor"],
      replace: [],
      command: true,
      path: true,
      codexRule: false,
    });
    const errored = status({
      agents: [
        agent("claude-code", "Claude Code", "available"),
        {
          ...agent("gemini-cli", "Gemini CLI", "error"),
          reason: "not_writable",
        },
      ],
      command: { onPath: true },
      codex: { allowed: true },
    });
    expect(initialChoices(errored, "linux")).toEqual({
      agents: ["claude-code", "gemini-cli"],
      replace: [],
      command: true,
      path: false,
      codexRule: false,
    });
    const after = status({
      skillFolder: SKILL,
      agents: [
        agent("claude-code", "Claude Code", "linked"),
        agent("codex", "Codex", "own_copy"),
        agent("cursor", "Cursor", "linked"),
      ],
      command: { state: "on", onPath: true, pathAdded: true },
      codex: { allowed: true },
    });
    expect(initialChoices(after, "darwin")).toEqual({
      agents: ["claude-code", "cursor"],
      replace: [],
      command: true,
      path: true,
      codexRule: true,
    });
    const partly = status({
      skillFolder: SKILL,
      agents: [
        agent("claude-code", "Claude Code", "available"),
        agent("codex", "Codex", "linked"),
      ],
      command: { state: "off", onPath: false, pathAdded: false },
    });
    expect(initialChoices(partly, "darwin")).toEqual({
      agents: ["codex"],
      replace: [],
      command: false,
      path: false,
      codexRule: false,
    });
  });

  it("offers PATH lines only when needed and keeps Kamapathy's lines", () => {
    expect(pathOption(status(), "darwin")).toEqual({
      kind: "profile",
      file: "~/.zshrc",
    });
    // A failed probe still offers the lines.
    expect(
      pathOption(
        status({ command: { onPath: null, profileFile: `${HOME}/.bashrc` } }),
        "linux",
      ),
    ).toEqual({ kind: "profile", file: "~/.bashrc" });
    // Only the home folder itself becomes ~.
    expect(
      pathOption(
        status({ command: { profileFile: "/etc/zdotdir/.zshrc" } }),
        "darwin",
      ),
    ).toEqual({ kind: "profile", file: "/etc/zdotdir/.zshrc" });
    expect(
      pathOption(
        status({ command: { profileFile: "/Users/adam/.zshrc" } }),
        "darwin",
      ),
    ).toEqual({ kind: "profile", file: "/Users/adam/.zshrc" });
    expect(pathOption(status({ command: WINDOWS_COMMAND }), "win32")).toEqual({
      kind: "windows",
    });
    expect(
      pathOption(status({ command: { profileFile: null } }), "linux"),
    ).toEqual({
      kind: "manual",
      line: 'export PATH="$HOME/.local/bin:$PATH"',
    });
    expect(pathOption(status({ command: { onPath: true } }), "darwin")).toBe(
      null,
    );
    expect(
      pathOption(
        status({ command: { ...WINDOWS_COMMAND, onPath: true } }),
        "win32",
      ),
    ).toBe(null);
    // Lines Kamapathy added stay offered, and checked, so Set up keeps them.
    const added = status({
      skillFolder: SKILL,
      command: { state: "on", onPath: true, pathAdded: true },
    });
    expect(pathOption(added, "darwin")).toEqual({
      kind: "profile",
      file: "~/.zshrc",
    });
    expect(initialChoices(added, "darwin").path).toBe(true);
    const windows = status({
      skillFolder: SKILL,
      command: {
        ...WINDOWS_COMMAND,
        state: "on",
        onPath: true,
        pathAdded: true,
      },
    });
    expect(pathOption(windows, "win32")).toEqual({ kind: "windows" });
    expect(initialChoices(windows, "win32").path).toBe(true);
  });

  it("builds the request from the choices", () => {
    const current = status({
      agents: [
        agent("claude-code", "Claude Code", "available"),
        agent("codex", "Codex", "own_copy"),
        agent("cursor", "Cursor", "own_copy"),
      ],
    });
    expect(
      setupRequest(
        {
          agents: ["cursor", "goose", "claude-code"],
          replace: ["codex", "cursor"],
          command: true,
          path: true,
          codexRule: true,
        },
        current,
        "darwin",
      ),
    ).toEqual({
      agents: ["claude-code", "cursor"],
      replace: ["cursor"],
      command: true,
      path: true,
      codexRule: true,
    });
    const choices = {
      agents: ["claude-code"],
      replace: [],
      command: true,
      path: true,
      codexRule: true,
    };
    // No option offered and no lines of Kamapathy's to keep.
    expect(
      setupRequest(choices, status({ command: { onPath: true } }), "darwin")
        .path,
    ).toBe(false);
    // A shell without a startup file to edit shows the line instead.
    expect(
      setupRequest(choices, status({ command: { profileFile: null } }), "linux")
        .path,
    ).toBe(false);
    // The PATH lines belong to the command.
    expect(
      setupRequest({ ...choices, command: false }, status(), "darwin").path,
    ).toBe(false);
    expect(
      setupRequest(choices, status({ command: WINDOWS_COMMAND }), "win32").path,
    ).toBe(true);
    expect(
      setupRequest(choices, status({ codex: { detected: false } }), "darwin")
        .codexRule,
    ).toBe(false);
    expect(
      setupRequest({ ...choices, codexRule: false }, status(), "darwin")
        .codexRule,
    ).toBe(false);
  });

  it("summarizes the setup for Settings", () => {
    const linked = (...names: [string, string][]) =>
      status({
        skillFolder: SKILL,
        agents: names.map(([id, name]) => agent(id, name, "linked")),
      });
    expect(setupSummary(linked(["claude-code", "Claude Code"]))).toBe(
      "Set up for Claude Code",
    );
    expect(
      setupSummary(linked(["claude-code", "Claude Code"], ["codex", "Codex"])),
    ).toBe("Set up for Claude Code and Codex");
    expect(
      setupSummary(
        status({
          skillFolder: SKILL,
          agents: [
            agent("claude-code", "Claude Code", "linked"),
            agent("codex", "Codex", "linked"),
            agent("cursor", "Cursor", "linked"),
            agent("goose", "Goose", "available"),
          ],
          command: { state: "on" },
        }),
      ),
    ).toBe("Set up for Claude Code, Codex and Cursor");
    expect(
      setupSummary(status({ skillFolder: SKILL, command: { state: "on" } })),
    ).toBe("Set up for the kamapathy command");
    expect(setupSummary(status())).toBe("Not set up yet");
    expect(
      setupSummary(
        status({ supported: false, reason: "desktop_only", agents: [] }),
      ),
    ).toBe("Available in the desktop app.");
    expect(
      setupSummary(
        status({ supported: false, reason: "test_profile", agents: [] }),
      ),
    ).toBe("Agent setup is off for test profiles.");
    expect(setupSummary(null)).toBe("");
  });

  it("warns about Node and hints each agent", () => {
    expect(nodeWarning({ found: false, version: null })).toBe("node_missing");
    expect(nodeWarning({ found: true, version: "22.12.0" })).toBe(
      "node_too_old",
    );
    expect(nodeWarning({ found: true, version: "18.20.4" })).toBe(
      "node_too_old",
    );
    expect(nodeWarning({ found: true, version: "22.13.0" })).toBe(null);
    expect(nodeWarning({ found: true, version: "23.0.0" })).toBe(null);
    expect(nodeWarning(null)).toBe(null);
    expect(agentHint("claude-code")).toBe(
      "In Claude Code, type /kamapathy, then your task.",
    );
    expect(agentHint("codex")).toBe(
      "In Codex, type $kamapathy, then your task.",
    );
    expect(agentHint("cursor")).toBe(
      "Ask your agent to use Kamapathy, then give it your task.",
    );
    expect(agentHint("toString")).toBe(
      "Ask your agent to use Kamapathy, then give it your task.",
    );
  });
});
