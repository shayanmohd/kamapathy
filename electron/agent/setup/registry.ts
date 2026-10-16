import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { codexHome } from "./codex";
import type { SetupEnvironment } from "./paths";

export interface AgentRow {
  id: string;
  name: string;
  folder: string;
  detected: boolean;
}

export const AGENT_IDS: readonly string[] = [
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "github-copilot",
  "opencode",
  "windsurf",
  "goose",
  "amp",
  "shared",
];

// Variables count only as found in the app's own environment. An agent is
// detected when the folder holding its skills folder exists; Amp and the
// shared folder have their own marks.
export function agentRows(env: SetupEnvironment): AgentRow[] {
  const windows = env.platform === "win32";
  const { dirname, join } = windows ? win32 : posix;
  const home = (...parts: string[]) => join(env.home, ...parts);
  const config = env.env.XDG_CONFIG_HOME || home(".config");
  const zed = windows
    ? join(env.env.APPDATA || home("AppData", "Roaming"), "Zed")
    : join(config, "zed");
  const rows: [id: string, name: string, folder: string, marks?: string[]][] = [
    [
      "claude-code",
      "Claude Code",
      join(env.env.CLAUDE_CONFIG_DIR || home(".claude"), "skills"),
    ],
    ["codex", "Codex", join(codexHome(env), "skills")],
    ["cursor", "Cursor", home(".cursor", "skills")],
    ["gemini-cli", "Gemini CLI", home(".gemini", "skills")],
    ["github-copilot", "GitHub Copilot", home(".copilot", "skills")],
    ["opencode", "OpenCode", join(config, "opencode", "skills")],
    ["windsurf", "Windsurf", home(".codeium", "windsurf", "skills")],
    ["goose", "Goose", home(".config", "goose", "skills")],
    [
      "amp",
      "Amp",
      home(".config", "agents", "skills"),
      [home(".config", "amp")],
    ],
    [
      "shared",
      "Cline, Warp, Zed",
      home(".agents", "skills"),
      [home(".agents"), home(".cline"), home(".warp"), zed],
    ],
  ];
  return rows.map(([id, name, folder, marks = [dirname(folder)]]) => ({
    id,
    name,
    folder,
    detected: marks.some((mark) => existsSync(mark)),
  }));
}
