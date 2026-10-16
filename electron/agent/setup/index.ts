import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { posix, win32 } from "node:path";
import type {
  AgentSetupRequest,
  AgentSetupStatus,
} from "../../../shared/types";
import { codexHome, codexRuleState, setCodexRule } from "./codex";
import {
  addCommandLink,
  addPathBlock,
  commandLinkState,
  onPathFrom,
  pathBlockState,
  profileFile,
  removeCommandLink,
  removeLaunchers,
  removePathBlock,
  windowsPath,
  writeLaunchers,
} from "./command";
import { backupPath, entryState, linkEntry, unlinkEntry } from "./links";
import {
  SetupError,
  setupSupported,
  toolPaths,
  withLock,
  writeFailure,
  type SetupEnvironment,
} from "./paths";
import { nodeStatus, probeShell } from "./probe";
import { AGENT_IDS, agentRows, type AgentRow } from "./registry";
import { refreshSkill } from "./skill";

export { SetupError } from "./paths";

type AgentStatus = AgentSetupStatus["agents"][number];
type CommandStatus = AgentSetupStatus["command"];

export interface AgentSetup {
  refresh(): Promise<void>;
  status(options?: { probe?: boolean }): Promise<AgentSetupStatus>;
  apply(request: AgentSetupRequest): Promise<AgentSetupStatus>;
  remove(): Promise<AgentSetupStatus>;
}

const INVALID_REQUEST = "Invalid agent setup request.";
const REQUEST_KEYS = ["agents", "replace", "command", "path", "codexRule"];

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

function agentIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > AGENT_IDS.length)
    throw new Error(INVALID_REQUEST);
  const ids: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const id: unknown = value[index];
    if (typeof id !== "string" || !AGENT_IDS.includes(id) || ids.includes(id))
      throw new Error(INVALID_REQUEST);
    ids.push(id);
  }
  return ids;
}

// The renderer's request, exactly: five keys, known unique ids, and
// booleans.
export function parseAgentSetupRequest(value: unknown): AgentSetupRequest {
  if (
    !plainObject(value) ||
    Object.keys(value).length !== REQUEST_KEYS.length ||
    !REQUEST_KEYS.every((key) => Object.hasOwn(value, key))
  )
    throw new Error(INVALID_REQUEST);
  const { command, path, codexRule } = value;
  if (
    typeof command !== "boolean" ||
    typeof path !== "boolean" ||
    typeof codexRule !== "boolean"
  )
    throw new Error(INVALID_REQUEST);
  const agents = agentIds(value.agents);
  const replace = agentIds(value.replace);
  if (!replace.every((id) => agents.includes(id)))
    throw new Error(INVALID_REQUEST);
  return { agents, replace, command, path, codexRule };
}

const NOTHING: AgentSetupRequest = {
  agents: [],
  replace: [],
  command: false,
  path: false,
  codexRule: false,
};

// What apply saw that the files alone do not show.
interface Outcome {
  agents: Map<string, Partial<AgentStatus>>;
  command: Partial<CommandStatus>;
}

function merge(status: AgentSetupStatus, outcome: Outcome) {
  for (const row of status.agents)
    Object.assign(row, outcome.agents.get(row.id));
  Object.assign(status.command, outcome.command);
  return status;
}

const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const readText = (path: string) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const sameFile = (a: string, b: string) => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

export function createAgentSetup(env: SetupEnvironment): AgentSetup {
  const paths = toolPaths(env);
  const windows = env.platform === "win32";
  const { join } = windows ? win32 : posix;
  const supported = setupSupported(env);
  const now = env.now ?? Date.now;
  const commandPath = paths.commandLink ?? paths.launcherCmd ?? "";
  const entryOf = (row: AgentRow) => join(row.folder, "kamapathy");
  const unsupported = () =>
    new SetupError("unsupported", "Agent setup is off for test profiles.");

  // Calls from this process run one at a time; T/.lock keeps other Kamapathy
  // processes out.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    queue = result.catch(() => undefined);
    return result;
  };

  async function read(probe: boolean): Promise<AgentSetupStatus> {
    if (!supported)
      return {
        supported: false,
        reason: "test_profile",
        skillFolder: null,
        agents: [],
        command: {
          state: "off",
          path: commandPath,
          onPath: null,
          profileFile: null,
          pathAdded: false,
        },
        codex: { detected: false, allowed: false },
        node: null,
      };
    const agents: AgentStatus[] = [];
    for (const row of agentRows(env)) {
      const { id, name, folder } = row;
      let state: AgentStatus["state"];
      try {
        state = entryState(entryOf(row), paths.stable, env.platform);
      } catch {
        if (row.detected)
          agents.push({
            id,
            name,
            folder,
            state: "error",
            reason: "not_writable",
          });
        continue;
      }
      if (row.detected || state === "linked")
        agents.push({ id, name, folder, state });
    }
    const target = profileFile(env);
    const block = target ? pathBlockState(target) : "absent";
    const link = commandLinkState(paths);
    const on = windows
      ? present(paths.launcher) && present(paths.launcherCmd!)
      : link === "ours";
    const command: CommandStatus = {
      state: on ? "on" : "off",
      path: commandPath,
      onPath: null,
      profileFile: target?.path ?? null,
      pathAdded: block === "present",
    };
    let node: AgentSetupStatus["node"] = null;
    let shadowed = false;
    let failed = false;
    if (probe) {
      const [shell, query] = await Promise.all([
        probeShell(env),
        windows ? windowsPath(env, paths.bin, "query").catch(() => null) : null,
      ]);
      if (windows) {
        command.onPath = query === null ? null : query === "present";
        command.pathAdded = query === "present";
      } else
        command.onPath = onPathFrom(
          shell,
          target && readText(target.path),
          paths.localBin!,
        );
      failed = shell === null || (windows && query === null);
      shadowed =
        on &&
        !windows &&
        !!shell?.kamapathy &&
        !sameFile(shell.kamapathy, paths.commandLink!);
      if (shell) {
        const { found, version } = nodeStatus(shell.node);
        node = { found, version };
      }
    }
    const reason =
      link === "taken"
        ? "command_taken"
        : shadowed
          ? "shadowed"
          : block === "changed"
            ? "profile_changed"
            : failed
              ? "probe_failed"
              : undefined;
    if (reason) command.reason = reason;
    return {
      supported: true,
      skillFolder: present(paths.stable) ? paths.stable : null,
      agents,
      command,
      codex: {
        detected: existsSync(codexHome(env)),
        allowed: codexRuleState(env) === "present",
      },
      node,
    };
  }

  // Links a listed agent, backing up its own copy only when asked, and
  // unlinks one no longer listed. A failure marks only that agent.
  function changeAgent(
    row: AgentRow,
    request: AgentSetupRequest,
  ): Partial<AgentStatus> | undefined {
    const entry = entryOf(row);
    let backup: string | undefined;
    try {
      const state = entryState(entry, paths.stable, env.platform);
      const listed =
        request.agents.includes(row.id) && (row.detected || state === "linked");
      if (!listed) unlinkEntry(entry, paths.stable, env.platform);
      else if (
        state === "available" ||
        (state === "own_copy" && request.replace.includes(row.id))
      ) {
        if (state === "own_copy") {
          const moved = backupPath(
            entry,
            now(),
            randomBytes(4).toString("hex"),
          );
          renameSync(entry, moved);
          backup = moved;
        }
        mkdirSync(row.folder, { recursive: true });
        linkEntry(entry, paths.stable, env.platform);
      }
      return backup ? { backup } : undefined;
    } catch {
      return {
        state: "error",
        reason: "not_writable",
        ...(backup ? { backup } : {}),
      };
    }
  }

  // Apply's steps after the skill refresh, under the caller's lock.
  async function change(request: AgentSetupRequest): Promise<Outcome> {
    const outcome: Outcome = { agents: new Map(), command: {} };
    for (const row of agentRows(env)) {
      const result = changeAgent(row, request);
      if (result) outcome.agents.set(row.id, result);
    }
    try {
      if (request.command) {
        writeLaunchers(env, paths, { create: true });
        if (paths.commandLink && addCommandLink(paths) === "taken")
          outcome.command = { state: "error", reason: "command_taken" };
      } else if (paths.commandLink) removeCommandLink(paths);
      else removeLaunchers(paths);
    } catch {
      outcome.command = { state: "error", reason: "not_writable" };
    }
    try {
      const target = profileFile(env);
      if (windows)
        await windowsPath(env, paths.bin, request.path ? "add" : "remove");
      else if (target && request.path) {
        if (pathBlockState(target) === "absent") addPathBlock(target);
      } else if (target) removePathBlock(target);
    } catch {
      outcome.command.reason ??= "not_writable";
    }
    // The rule is written only where Codex is installed.
    if (!request.codexRule || existsSync(codexHome(env)))
      setCodexRule(env, request.codexRule);
    return outcome;
  }

  return {
    refresh: () =>
      serial(async () => {
        if (!supported || !present(paths.stable)) return;
        await withLock(env, paths, async () => {
          await refreshSkill(env, paths, { create: false });
          writeLaunchers(env, paths, { create: false });
        });
      }),
    status: (options = {}) => serial(() => read(options.probe === true)),
    apply: (request) =>
      serial(async () => {
        if (!supported) throw unsupported();
        const outcome = await withLock(env, paths, async () => {
          try {
            await refreshSkill(env, paths, { create: true });
          } catch (error) {
            throw writeFailure(error, paths.tools);
          }
          if (!existsSync(paths.stable))
            throw new SetupError(
              "unsupported",
              "Kamapathy could not find its agent skill.",
            );
          return change(request);
        });
        return merge(await read(true), outcome);
      }),
    remove: () =>
      serial(async () => {
        if (!supported) throw unsupported();
        const outcome = await withLock(env, paths, async () => {
          const result = await change(NOTHING);
          // S is a link and T a real folder, so nothing outside T goes.
          try {
            if (
              present(paths.stable) &&
              lstatSync(paths.stable).isSymbolicLink()
            )
              (windows ? rmdirSync : unlinkSync)(paths.stable);
            if (lstatSync(paths.tools).isDirectory())
              rmSync(paths.tools, { recursive: true, force: true });
          } catch (error) {
            throw writeFailure(error, paths.tools);
          }
          return result;
        });
        return merge(await read(false), outcome);
      }),
  };
}
