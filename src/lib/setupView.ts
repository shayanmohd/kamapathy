import type {
  AgentSetupRequest,
  AgentSetupStatus,
  BrowserState,
} from "../../shared/types";
import { agentSetupCopy } from "../copy";

type Platform = BrowserState["platform"];

export interface SetupChoices {
  agents: string[];
  replace: string[];
  command: boolean;
  path: boolean;
  codexRule: boolean;
}

const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH"';
// On macOS and Linux the command link is <home>/.local/bin/kamapathy.
const COMMAND_LINK = "/.local/bin/kamapathy";

// The file as people know it, with their home folder written as ~.
function homeRelative(file: string, commandPath: string): string {
  if (!commandPath.endsWith(COMMAND_LINK)) return file;
  const home = commandPath.slice(0, -COMMAND_LINK.length);
  return home && file.startsWith(`${home}/`)
    ? `~${file.slice(home.length)}`
    : file;
}

export function pathOption(
  status: AgentSetupStatus,
  platform: Platform,
):
  | { kind: "profile"; file: string }
  | { kind: "windows" }
  | { kind: "manual"; line: string }
  | null {
  const { onPath, profileFile, pathAdded, path } = status.command;
  // Lines Kamapathy added stay offered, so a later Set up keeps them.
  if (onPath === true && !pathAdded) return null;
  if (platform === "win32") return { kind: "windows" };
  if (profileFile)
    return { kind: "profile", file: homeRelative(profileFile, path) };
  return { kind: "manual", line: PATH_LINE };
}

// Before any setup every agent found starts checked; after it, the choices
// match what is in place. The Codex rule never starts checked on its own.
export function initialChoices(
  status: AgentSetupStatus,
  platform: Platform,
): SetupChoices {
  const fresh = status.skillFolder === null;
  return {
    agents: status.agents
      .filter((agent) => fresh || agent.state === "linked")
      .map((agent) => agent.id),
    replace: [],
    command: fresh || status.command.state === "on",
    path: fresh
      ? pathOption(status, platform) !== null
      : status.command.pathAdded,
    codexRule: !fresh && status.codex.allowed,
  };
}

export function setupRequest(
  choices: SetupChoices,
  status: AgentSetupStatus,
  platform: Platform,
): AgentSetupRequest {
  const listed = (ids: string[]) =>
    status.agents
      .filter((agent) => ids.includes(agent.id))
      .map((agent) => agent.id);
  const agents = listed(choices.agents);
  const kind = pathOption(status, platform)?.kind;
  return {
    agents,
    replace: listed(choices.replace).filter((id) => agents.includes(id)),
    command: choices.command,
    // Only a PATH checkbox the panel showed adds lines, and only with the
    // command they are for.
    path:
      (kind === "profile" || kind === "windows") &&
      choices.command &&
      choices.path,
    codexRule: status.codex.detected && choices.codexRule,
  };
}

export function setupSummary(status: AgentSetupStatus | null): string {
  if (!status) return "";
  if (!status.supported)
    return status.reason === "test_profile"
      ? agentSetupCopy.testProfile
      : agentSetupCopy.desktopOnly;
  const names = status.agents
    .filter((agent) => agent.state === "linked")
    .map((agent) => agent.name);
  const command = status.command.state === "on";
  return names.length || command
    ? agentSetupCopy.summary(names, command)
    : agentSetupCopy.notSetUp;
}

export function nodeWarning(
  node: AgentSetupStatus["node"],
): "node_missing" | "node_too_old" | null {
  if (!node) return null;
  if (!node.found) return "node_missing";
  if (!node.version) return null;
  const [major, minor] = node.version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 13) ? null : "node_too_old";
}

export function agentHint(id: string): string {
  return id === "claude-code" || id === "codex"
    ? agentSetupCopy.hints[id]
    : agentSetupCopy.genericHint;
}
