import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODEX_BLOCK,
  codexHome,
  codexRulesFile,
  codexRuleState,
  setCodexRule,
} from "../electron/agent/setup/codex";
import {
  addCommandLink,
  addPathBlock,
  cmdLauncher,
  commandLinkState,
  FISH_PATH_BLOCK,
  gitBashLauncher,
  onPathFrom,
  pathBlockState,
  posixLauncher,
  profileFile,
  removeCommandLink,
  removeLaunchers,
  removePathBlock,
  SH_PATH_BLOCK,
  WINDOWS_PATH_SCRIPT,
  windowsPath,
  writeLaunchers,
} from "../electron/agent/setup/command";
import {
  createAgentSetup,
  parseAgentSetupRequest,
  SetupError as ExportedSetupError,
} from "../electron/agent/setup/index";
import {
  backupPath,
  entryState,
  linkEntry,
  unlinkEntry,
} from "../electron/agent/setup/links";
import {
  ensureTools,
  SetupError,
  setupSupported,
  toolPaths,
  withLock,
  type Runner,
  type SetupEnvironment,
} from "../electron/agent/setup/paths";
import {
  execRunner,
  nodeStatus,
  probeShell,
} from "../electron/agent/setup/probe";
import { AGENT_IDS, agentRows } from "../electron/agent/setup/registry";
import {
  refreshSkill,
  skillDigest,
  stableTarget,
} from "../electron/agent/setup/skill";
import type { AgentSetupRequest } from "../shared/types";

const posix = process.platform !== "win32";
const root = process.getuid?.() === 0;
const realSkill = fileURLToPath(
  new URL("../skills/kamapathy", import.meta.url),
);
const NODE_MESSAGE =
  "Kamapathy: the kamapathy command needs Node.js 22.13 or later from https://nodejs.org.";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function temporary() {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "kamapathy-setup-")),
  );
  directories.push(directory);
  return directory;
}
type Answer = Awaited<ReturnType<Runner>>;
const noRunner: Runner = async () => {
  throw new Error("This test runs nothing.");
};
function environment(
  overrides: Partial<SetupEnvironment> = {},
): SetupEnvironment {
  return {
    platform: process.platform,
    home: temporary(),
    accountHome: join(tmpdir(), "kamapathy-account-home"),
    env: {},
    testProfile: true,
    bundledSkill: null,
    version: "0.2.0",
    shell: posix ? "/bin/zsh" : null,
    run: noRunner,
    ...overrides,
  };
}
// A small bundled skill holding the given files.
function skillFolder(files: Record<string, string>) {
  const folder = join(temporary(), "kamapathy");
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, name)), { recursive: true });
    writeFileSync(join(folder, name), text);
  }
  return folder;
}
function thrown(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Nothing was thrown.");
}
const link = (target: string, path: string) =>
  symlinkSync(target, path, posix ? undefined : "junction");
const unlink = (path: string) => (posix ? unlinkSync(path) : rmdirSync(path));

describe("tools folder", () => {
  it("keeps the tools under the home and spots a test profile on the real home", () => {
    const env = environment({ platform: "darwin", home: "/Users/avery" });
    expect(toolPaths(env)).toEqual({
      tools: "/Users/avery/.local/share/kamapathy",
      skills: "/Users/avery/.local/share/kamapathy/skills",
      stable: "/Users/avery/.local/share/kamapathy/skill",
      bin: "/Users/avery/.local/share/kamapathy/bin",
      launcher: "/Users/avery/.local/share/kamapathy/bin/kamapathy",
      launcherCmd: null,
      localBin: "/Users/avery/.local/bin",
      commandLink: "/Users/avery/.local/bin/kamapathy",
      lock: "/Users/avery/.local/share/kamapathy/.lock",
    });
    const windows = environment({
      platform: "win32",
      home: "C:\\Users\\avery",
      shell: null,
    });
    const tools = "C:\\Users\\avery\\AppData\\Local\\Kamapathy\\tools";
    expect(toolPaths(windows)).toEqual({
      tools,
      skills: `${tools}\\skills`,
      stable: `${tools}\\skill`,
      bin: `${tools}\\bin`,
      launcher: `${tools}\\bin\\kamapathy`,
      launcherCmd: `${tools}\\bin\\kamapathy.cmd`,
      localBin: null,
      commandLink: null,
      lock: `${tools}\\.lock`,
    });
    expect(
      toolPaths({ ...windows, env: { LOCALAPPDATA: "D:\\Local" } }).tools,
    ).toBe("D:\\Local\\Kamapathy\\tools");

    expect(setupSupported({ ...env, accountHome: "/Users/avery/" })).toBe(
      false,
    );
    expect(
      setupSupported({
        ...env,
        accountHome: "/Users/avery",
        testProfile: false,
      }),
    ).toBe(true);
    expect(setupSupported({ ...env, accountHome: "/Users/other" })).toBe(true);
    expect(
      setupSupported({ ...windows, accountHome: "c:\\users\\AVERY" }),
    ).toBe(false);
  });

  it.skipIf(!posix)(
    "keeps the tools folder private and refuses a link or a file",
    () => {
      const env = environment();
      const paths = toolPaths(env);
      ensureTools(env, paths);
      expect(statSync(paths.tools).mode & 0o777).toBe(0o700);
      chmodSync(paths.tools, 0o755);
      ensureTools(env, paths);
      expect(statSync(paths.tools).mode & 0o777).toBe(0o700);

      const refusal = {
        reason: "not_private",
        message: `Kamapathy's tools folder ${paths.tools} must be a folder your account owns, not a link.`,
      };
      rmSync(paths.tools, { recursive: true });
      symlinkSync(temporary(), paths.tools);
      const error = thrown(() => ensureTools(env, paths));
      expect(error).toBeInstanceOf(SetupError);
      expect(error).toMatchObject(refusal);
      rmSync(paths.tools);
      writeFileSync(paths.tools, "");
      expect(thrown(() => ensureTools(env, paths))).toMatchObject(refusal);
    },
  );

  it.skipIf(!posix || root)(
    "reports a folder it cannot write as not_writable",
    () => {
      const env = environment();
      const paths = toolPaths(env);
      const share = dirname(paths.tools);
      mkdirSync(share, { recursive: true });
      chmodSync(share, 0o500);
      try {
        expect(thrown(() => ensureTools(env, paths))).toMatchObject({
          reason: "not_writable",
          message: `Kamapathy could not write to ${paths.tools}.`,
        });
      } finally {
        chmodSync(share, 0o700);
      }
    },
  );

  it("a held lock reports busy", async () => {
    let clock = 0;
    const env = environment({ now: () => clock });
    const paths = toolPaths(env);
    ensureTools(env, paths);
    writeFileSync(paths.lock, JSON.stringify({ pid: 1, at: 0 }));
    utimesSync(paths.lock, 1000, 1000);

    clock = 1_000_000 + 29_999;
    const busy = await withLock(env, paths, async () => "ran").catch(
      (error: unknown) => error,
    );
    expect(busy).toBeInstanceOf(SetupError);
    expect(busy).toMatchObject({
      reason: "busy",
      message:
        "Another Kamapathy is changing agent setup. Try again in a moment.",
    });
    expect(JSON.parse(readFileSync(paths.lock, "utf8"))).toEqual({
      pid: 1,
      at: 0,
    });

    clock = 1_000_000 + 30_001;
    let held: unknown;
    const result = await withLock(env, paths, async () => {
      held = JSON.parse(readFileSync(paths.lock, "utf8"));
      return "ran";
    });
    expect(result).toBe("ran");
    expect(held).toEqual({ pid: process.pid, at: clock });
    expect(existsSync(paths.lock)).toBe(false);

    await expect(
      withLock(env, paths, async () => {
        throw new Error("Failed inside.");
      }),
    ).rejects.toThrow("Failed inside.");
    expect(existsSync(paths.lock)).toBe(false);
  });
});

describe("skill copies", () => {
  it("copies by digest and swaps S", async () => {
    const bundled = skillFolder({
      "SKILL.md": "# Kamapathy\n",
      "scripts/kamapathy.mjs": "one\n",
    });
    const env = environment({ bundledSkill: bundled });
    const paths = toolPaths(env);
    const script = join(paths.stable, "scripts", "kamapathy.mjs");

    // Without S, a refresh at start does nothing.
    expect(await refreshSkill(env, paths, { create: false })).toBeNull();
    expect(existsSync(paths.tools)).toBe(false);
    expect(
      await refreshSkill({ ...env, bundledSkill: null }, paths, {
        create: true,
      }),
    ).toBeNull();
    expect(existsSync(paths.tools)).toBe(false);

    const digest = await skillDigest(bundled);
    const first = join(paths.skills, `0.2.0-${digest}`, "kamapathy");
    expect(await refreshSkill(env, paths, { create: true })).toEqual({
      folder: first,
      digest,
      swapped: true,
      previous: null,
    });
    if (posix) {
      expect(readlinkSync(paths.stable)).toBe(
        `skills/0.2.0-${digest}/kamapathy`,
      );
      expect(statSync(paths.tools).mode & 0o777).toBe(0o700);
    }
    expect(stableTarget(paths)).toBe(first);
    expect(readFileSync(script, "utf8")).toBe("one\n");

    // The same content reuses the copy and swaps nothing.
    expect(await refreshSkill(env, paths, { create: false })).toEqual({
      folder: first,
      digest,
      swapped: false,
      previous: null,
    });
    expect(readdirSync(paths.skills)).toEqual([`0.2.0-${digest}`]);

    writeFileSync(join(bundled, "scripts", "kamapathy.mjs"), "two\n");
    const second = (await refreshSkill(env, paths, { create: false }))!;
    expect(second).toMatchObject({ swapped: true, previous: first });
    expect(second.digest).not.toBe(digest);
    expect(second.folder).toBe(
      join(paths.skills, `0.2.0-${second.digest}`, "kamapathy"),
    );
    expect(stableTarget(paths)).toBe(second.folder);
    expect(readFileSync(script, "utf8")).toBe("two\n");

    // A third content keeps the newest and previous copies; a leftover
    // staging folder goes and a link stays.
    mkdirSync(join(paths.skills, ".staging-0badc0de", "kamapathy"), {
      recursive: true,
    });
    const elsewhere = temporary();
    link(elsewhere, join(paths.skills, "elsewhere"));
    writeFileSync(join(bundled, "scripts", "kamapathy.mjs"), "three\n");
    const third = (await refreshSkill(env, paths, { create: false }))!;
    expect(third).toMatchObject({ swapped: true, previous: second.folder });
    expect(readdirSync(paths.skills).sort()).toEqual(
      [
        basename(dirname(second.folder)),
        basename(dirname(third.folder)),
        "elsewhere",
      ].sort(),
    );
    expect(existsSync(elsewhere)).toBe(true);
    expect(readFileSync(script, "utf8")).toBe("three\n");
  });

  it("skillDigest is 12 hex digits and changes with any path or byte", async () => {
    const files = { "SKILL.md": "a", "scripts/x.mjs": "bc" };
    const digest = await skillDigest(skillFolder(files));
    const expected = createHash("sha256");
    for (const [path, text] of Object.entries(files))
      expected.update(`${path}\0${Buffer.byteLength(text)}\0${text}`);
    expect(digest).toBe(expected.digest("hex").slice(0, 12));
    expect(digest).toMatch(/^[0-9a-f]{12}$/);

    expect(
      await skillDigest(
        skillFolder({ "scripts/x.mjs": "bc", "SKILL.md": "a" }),
      ),
    ).toBe(digest);
    const changes: Record<string, string>[] = [
      { "SKILL.md": "a", "scripts/y.mjs": "bc" },
      { "SKILL.md": "a", "scripts/x.mjs": "bd" },
      { "SKILL.md": "a", "scripts/x.mjs": "bc", "notes.md": "" },
    ];
    for (const changed of changes)
      expect(await skillDigest(skillFolder(changed))).not.toBe(digest);
  });

  it.skipIf(!posix)("refuses a link inside the bundled skill", async () => {
    const bundled = skillFolder({ "SKILL.md": "a" });
    symlinkSync("SKILL.md", join(bundled, "other.md"));
    await expect(skillDigest(bundled)).rejects.toThrow("other.md");
    const env = environment({ bundledSkill: bundled });
    await expect(
      refreshSkill(env, toolPaths(env), { create: true }),
    ).rejects.toThrow("other.md");
  });
});

describe("agent entries", () => {
  it("an entry is linked, available or its own copy, and only a link to S is removed", () => {
    const folder = temporary();
    const stable = join(folder, "skill");
    mkdirSync(stable);
    const skills = join(folder, "agent", "skills");
    mkdirSync(skills, { recursive: true });
    const entry = join(skills, "kamapathy");
    const platform = process.platform;

    expect(entryState(entry, stable, platform)).toBe("available");
    linkEntry(entry, stable, platform);
    expect(entryState(entry, stable, platform)).toBe("linked");
    if (posix) expect(readlinkSync(entry)).toBe(stable);
    expect(unlinkEntry(entry, stable, platform)).toBe(true);
    expect(existsSync(entry)).toBe(false);
    expect(existsSync(stable)).toBe(true);
    expect(unlinkEntry(entry, stable, platform)).toBe(false);

    const other = join(folder, "other");
    mkdirSync(other);
    writeFileSync(join(other, "SKILL.md"), "theirs");
    link(other, entry);
    expect(entryState(entry, stable, platform)).toBe("own_copy");
    expect(unlinkEntry(entry, stable, platform)).toBe(false);
    expect(readFileSync(join(entry, "SKILL.md"), "utf8")).toBe("theirs");
    unlink(entry);

    mkdirSync(entry);
    writeFileSync(join(entry, "SKILL.md"), "mine");
    expect(entryState(entry, stable, platform)).toBe("own_copy");
    expect(unlinkEntry(entry, stable, platform)).toBe(false);
    expect(readFileSync(join(entry, "SKILL.md"), "utf8")).toBe("mine");

    if (posix) {
      rmSync(entry, { recursive: true });
      symlinkSync("../../skill", entry);
      expect(entryState(entry, stable, platform)).toBe("linked");
    }
    expect(backupPath(entry, 1_700_000_000_000, "0a1b2c3d")).toBe(
      join(skills, ".kamapathy-backup-1700000000000-0a1b2c3d"),
    );
  });
});

describe("the kamapathy command", () => {
  it("writes the three launcher texts", () => {
    const lines = (skill: string) => [
      "#!/bin/sh",
      "# kamapathy command, launcher 1. Written by Kamapathy; Settings > Agents removes it.",
      `skill=${skill}`,
      `command -v node >/dev/null 2>&1 || { echo "${NODE_MESSAGE}" >&2; exit 127; }`,
      "KAMAPATHY_PROGRAM=kamapathy",
      "export KAMAPATHY_PROGRAM",
      'exec node "$skill/scripts/kamapathy.mjs" "$@"',
      "",
    ];
    expect(posixLauncher("/Users/a'b/.local/share/kamapathy/skill")).toBe(
      lines("'/Users/a'\\''b/.local/share/kamapathy/skill'").join("\n"),
    );
    expect(gitBashLauncher()).toBe(
      lines('"$(dirname "$0")/../skill"').join("\n"),
    );
    expect(cmdLauncher()).toBe(
      [
        "@echo off",
        "rem kamapathy command, launcher 1. Written by Kamapathy; Settings > Agents removes it.",
        "setlocal",
        `where node >nul 2>nul || (echo ${NODE_MESSAGE} 1>&2 & exit /b 127)`,
        'set "KAMAPATHY_PROGRAM=kamapathy"',
        'node "%~dp0..\\skill\\scripts\\kamapathy.mjs" %*',
        "",
      ].join("\r\n"),
    );
  });

  it.skipIf(!posix)("the launcher exits 127 without node", async () => {
    // A quote in the home checks the launcher's quoting.
    const home = join(temporary(), "it's home");
    mkdirSync(home);
    const env = environment({ home, bundledSkill: realSkill });
    const paths = toolPaths(env);
    await refreshSkill(env, paths, { create: true });
    expect(writeLaunchers(env, paths, { create: false })).toBe(false);
    expect(existsSync(paths.launcher)).toBe(false);
    expect(writeLaunchers(env, paths, { create: true })).toBe(true);
    expect(statSync(paths.launcher).mode & 0o777).toBe(0o755);
    expect(readFileSync(paths.launcher, "utf8")).toBe(
      posixLauncher(paths.stable),
    );
    expect(writeLaunchers(env, paths, { create: false })).toBe(false);

    const run = (launcher: string, path: string) =>
      spawnSync("/bin/sh", [launcher, "help"], {
        env: { PATH: path, HOME: home },
        encoding: "utf8",
      });
    const missing = run(paths.launcher, temporary());
    expect(missing.status).toBe(127);
    expect(missing.stderr).toBe(`${NODE_MESSAGE}\n`);
    const found = run(paths.launcher, dirname(process.execPath));
    expect(found.status).toBe(0);
    expect(found.stdout).toContain(
      "Usage: kamapathy <command> [arguments] [--json]",
    );

    // The Git Bash launcher finds the stable folder beside its own folder,
    // with dirname from Git's tools.
    const gitBash = join(paths.bin, "kamapathy-git-bash");
    writeFileSync(gitBash, gitBashLauncher());
    const beside = run(gitBash, `${dirname(process.execPath)}:/usr/bin:/bin`);
    expect(beside.status).toBe(0);
    expect(beside.stdout).toContain(
      "Usage: kamapathy <command> [arguments] [--json]",
    );

    // A changed launcher is rewritten at start; a removed one stays removed.
    writeFileSync(paths.launcher, "#!/bin/sh\n");
    expect(writeLaunchers(env, paths, { create: false })).toBe(true);
    expect(readFileSync(paths.launcher, "utf8")).toBe(
      posixLauncher(paths.stable),
    );
    removeLaunchers(paths);
    expect(existsSync(paths.launcher)).toBe(false);
    expect(writeLaunchers(env, paths, { create: false })).toBe(false);
    expect(existsSync(paths.launcher)).toBe(false);
  });

  it.skipIf(!posix)("the command link is ours, absent or taken", () => {
    const env = environment();
    const paths = toolPaths(env);
    const commandLink = paths.commandLink!;
    expect(commandLinkState(paths)).toBe("absent");
    expect(addCommandLink(paths)).toBe("ours");
    expect(readlinkSync(commandLink)).toBe(paths.launcher);
    expect(addCommandLink(paths)).toBe("ours");
    removeCommandLink(paths);
    expect(commandLinkState(paths)).toBe("absent");

    writeFileSync(commandLink, "#!/bin/sh\n");
    expect(commandLinkState(paths)).toBe("taken");
    expect(addCommandLink(paths)).toBe("taken");
    removeCommandLink(paths);
    expect(readFileSync(commandLink, "utf8")).toBe("#!/bin/sh\n");

    rmSync(commandLink);
    symlinkSync("/usr/bin/true", commandLink);
    expect(addCommandLink(paths)).toBe("taken");
    removeCommandLink(paths);
    expect(readlinkSync(commandLink)).toBe("/usr/bin/true");
  });
});

describe("PATH lines", () => {
  it("the profile file follows the shell", () => {
    const env = environment({ platform: "darwin" });
    const { home } = env;
    const at = (shell: string | null, more: Partial<SetupEnvironment> = {}) =>
      profileFile({ ...env, shell, ...more });
    expect(at("/bin/zsh")).toEqual({ path: join(home, ".zshrc"), kind: "sh" });
    expect(at("/bin/zsh", { env: { ZDOTDIR: join(home, "zsh") } })).toEqual({
      path: join(home, "zsh", ".zshrc"),
      kind: "sh",
    });
    expect(at("/bin/bash")).toEqual({
      path: join(home, ".bash_profile"),
      kind: "sh",
    });
    expect(at("/usr/bin/bash", { platform: "linux" })).toEqual({
      path: join(home, ".bashrc"),
      kind: "sh",
    });
    expect(at("/usr/bin/fish", { platform: "linux" })).toEqual({
      path: join(home, ".config", "fish", "conf.d", "kamapathy.fish"),
      kind: "fish",
    });
    expect(at("/bin/sh")).toBeNull();
    expect(at("/bin/ksh")).toBeNull();
    expect(at(null, { platform: "win32" })).toBeNull();
    expect(
      at("C:\\Program Files\\Git\\bin\\bash.exe", { platform: "win32" }),
    ).toBeNull();

    // A new ~/.bash_profile would stop bash reading the login file it uses.
    writeFileSync(join(home, ".profile"), "export A=1\n");
    expect(at("/bin/bash")?.path).toBe(join(home, ".profile"));
    writeFileSync(join(home, ".bash_login"), "export B=2\n");
    expect(at("/bin/bash")?.path).toBe(join(home, ".bash_login"));
    writeFileSync(join(home, ".bash_profile"), "export C=3\n");
    expect(at("/bin/bash")?.path).toBe(join(home, ".bash_profile"));
    expect(at("/usr/bin/bash", { platform: "linux" })?.path).toBe(
      join(home, ".bashrc"),
    );
  });

  it("adds and removes only Kamapathy's exact PATH block", () => {
    const env = environment({ platform: "darwin", shell: "/bin/zsh" });
    const target = profileFile(env)!;
    const read = () => readFileSync(target.path, "utf8");
    expect(pathBlockState(target)).toBe("absent");
    expect(removePathBlock(target)).toBe("absent");

    writeFileSync(target.path, "alias ll='ls -l'");
    addPathBlock(target);
    expect(read()).toBe(`alias ll='ls -l'\n${SH_PATH_BLOCK}`);
    expect(pathBlockState(target)).toBe("present");
    addPathBlock(target);
    expect(read()).toBe(`alias ll='ls -l'\n${SH_PATH_BLOCK}`);
    appendFileSync(target.path, "export EDITOR=vi\n");
    expect(removePathBlock(target)).toBe("removed");
    expect(read()).toBe("alias ll='ls -l'\nexport EDITOR=vi\n");

    const edited = SH_PATH_BLOCK.replace("$HOME/.local/bin", "$HOME/bin");
    writeFileSync(target.path, `a\n${edited}b\n`);
    expect(pathBlockState(target)).toBe("changed");
    expect(removePathBlock(target)).toBe("profile_changed");
    expect(read()).toBe(`a\n${edited}b\n`);

    rmSync(target.path);
    addPathBlock(target);
    expect(read()).toBe(SH_PATH_BLOCK);

    const fish = profileFile({ ...env, shell: "/usr/bin/fish" })!;
    addPathBlock(fish);
    expect(readFileSync(fish.path, "utf8")).toBe(FISH_PATH_BLOCK);
    expect(pathBlockState(fish)).toBe("present");
    expect(removePathBlock(fish)).toBe("removed");
    expect(existsSync(fish.path)).toBe(false);
  });

  it.skipIf(!posix)("keeps a linked profile a link", () => {
    const env = environment({ platform: "darwin", shell: "/bin/zsh" });
    const target = profileFile(env)!;
    const real = join(temporary(), "zshrc");
    writeFileSync(real, "export A=1\n");
    symlinkSync(real, target.path);
    addPathBlock(target);
    expect(lstatSync(target.path).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe(`export A=1\n${SH_PATH_BLOCK}`);
    expect(removePathBlock(target)).toBe("removed");
    expect(lstatSync(target.path).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("export A=1\n");
  });

  it("runs the fixed PATH script with only the variables it needs", async () => {
    const calls: Parameters<Runner>[] = [];
    let answer: Answer = {
      code: 0,
      stdout: "added\r\n",
      stderr: "",
      timedOut: false,
    };
    const env = environment({
      platform: "win32",
      shell: null,
      env: {
        SystemRoot: "C:\\Windows",
        TEMP: "C:\\Temp",
        TMP: "C:\\Temp",
        Path: "C:\\elsewhere",
        PSModulePath: "C:\\modules",
      },
      run: async (...call) => {
        calls.push(call);
        return answer;
      },
    });
    const bin = "C:\\Users\\avery\\AppData\\Local\\Kamapathy\\tools\\bin";
    expect(await windowsPath(env, bin, "add")).toBe("added");
    const [file, args, options] = calls[0];
    expect(file).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(args.slice(0, 5)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
    ]);
    expect(Buffer.from(args[5], "base64").toString("utf16le")).toBe(
      WINDOWS_PATH_SCRIPT,
    );
    expect(options.env).toEqual({
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      KAMAPATHY_BIN: bin,
      KAMAPATHY_PATH_ACTION: "add",
    });
    expect(WINDOWS_PATH_SCRIPT).not.toMatch(/setx/i);

    answer = { ...answer, stdout: "present\r\n" };
    expect(
      await windowsPath(env, bin, "query", { key: "Software\\Test" }),
    ).toBe("present");
    expect(calls[1][2].env).toMatchObject({
      KAMAPATHY_PATH_ACTION: "query",
      KAMAPATHY_PATH_KEY: "Software\\Test",
    });

    for (const failure of [
      { ...answer, code: 1, stdout: "" },
      { ...answer, stdout: "denied\r\n" },
      { ...answer, code: null, timedOut: true },
    ]) {
      answer = failure;
      const error = await windowsPath(env, bin, "remove").catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(SetupError);
      expect(error).toMatchObject({
        reason: "not_writable",
        message: "Kamapathy could not write to HKCU\\Environment.",
      });
    }
  });

  it.skipIf(process.platform !== "win32")(
    "the PATH script keeps other entries and the value kind",
    async () => {
      const key = `Software\\KamapathyTest-${randomBytes(4).toString("hex")}`;
      const reg = (...args: string[]) =>
        execFileSync("reg.exe", args, { encoding: "utf8" });
      const value = () => reg("query", `HKCU\\${key}`, "/v", "Path");
      reg(
        "add",
        `HKCU\\${key}`,
        "/v",
        "Path",
        "/t",
        "REG_EXPAND_SZ",
        "/d",
        "%USERPROFILE%\\tools;C:\\Other\\Bin",
        "/f",
      );
      try {
        const env = environment({
          platform: "win32",
          shell: null,
          env: process.env,
          run: execRunner,
        });
        const bin = "C:\\Kamapathy Test\\tools\\bin";
        const options = { key };
        expect(await windowsPath(env, bin, "query", options)).toBe("absent");
        expect(await windowsPath(env, bin, "add", options)).toBe("added");
        expect(
          await windowsPath(
            env,
            "c:\\kamapathy test\\TOOLS\\bin\\",
            "add",
            options,
          ),
        ).toBe("present");
        expect(await windowsPath(env, bin, "query", options)).toBe("present");
        expect(value()).toMatch(
          /REG_EXPAND_SZ\s+%USERPROFILE%\\tools;C:\\Other\\Bin;C:\\Kamapathy Test\\tools\\bin\r?\n/,
        );
        expect(
          await windowsPath(
            env,
            "C:\\KAMAPATHY TEST\\tools\\bin\\",
            "remove",
            options,
          ),
        ).toBe("removed");
        expect(await windowsPath(env, bin, "remove", options)).toBe("absent");
        expect(value()).toMatch(
          /REG_EXPAND_SZ\s+%USERPROFILE%\\tools;C:\\Other\\Bin\r?\n/,
        );
      } finally {
        reg("delete", `HKCU\\${key}`, "/f");
      }
    },
    120_000,
  );
});

describe("shell probe", () => {
  it("a probe timeout gives onPath null", async () => {
    const calls: Parameters<Runner>[] = [];
    const timesOut: Runner = async (...call) => {
      calls.push(call);
      return { code: null, stdout: "", stderr: "", timedOut: true };
    };
    const env = environment({
      platform: "darwin",
      home: "/Users/avery",
      shell: "/bin/zsh",
      run: timesOut,
      env: {
        USER: "avery",
        LOGNAME: "avery",
        PATH: "/usr/bin",
        SHELL: "/bin/bash",
        CODEX_HOME: "/elsewhere",
      },
    });
    expect(await probeShell(env)).toBeNull();
    expect(
      await probeShell({ ...env, shell: "/usr/local/bin/bash" }),
    ).toBeNull();
    expect(
      await probeShell({ ...env, shell: "/opt/homebrew/bin/fish" }),
    ).toBeNull();
    await probeShell({ ...env, env: {} });
    expect(calls.map(([file, args]) => [file, args[0]])).toEqual([
      ["/bin/zsh", "-ilc"],
      ["/usr/local/bin/bash", "-ilc"],
      ["/opt/homebrew/bin/fish", "-lc"],
      ["/bin/zsh", "-ilc"],
    ]);
    const environments = calls.map(([, , options]) => options);
    expect(environments[0]).toEqual({
      env: {
        HOME: env.home,
        USER: "avery",
        LOGNAME: "avery",
        SHELL: "/bin/zsh",
        TERM: "dumb",
      },
      timeoutMs: 5000,
    });
    expect(environments[2].env.SHELL).toBe("/opt/homebrew/bin/fish");
    expect(environments[3].env).toEqual({
      HOME: env.home,
      SHELL: "/bin/zsh",
      TERM: "dumb",
    });

    const localBin = toolPaths(env).localBin!;
    expect(
      onPathFrom(null, 'export PATH="$HOME/.local/bin:$PATH"\n', localBin),
    ).toBe(true);
    expect(onPathFrom(null, "alias ll='ls -l'\n", localBin)).toBeNull();
    expect(onPathFrom(null, null, localBin)).toBeNull();

    const answers: Runner = async () => ({
      code: 0,
      stdout: `Last login: today\n__KAMAPATHY_PATH__/early\n\n__KAMAPATHY_PATH__/usr/bin:${localBin}/:/bin\n__KAMAPATHY_COMMAND__${localBin}/kamapathy\n__KAMAPATHY_NODE__24.3.0\n`,
      stderr: "",
      timedOut: false,
    });
    const probe = (await probeShell({ ...env, run: answers }))!;
    expect(probe).toEqual({
      path: ["/usr/bin", `${localBin}/`, "/bin"],
      kamapathy: `${localBin}/kamapathy`,
      node: "24.3.0",
    });
    expect(onPathFrom(probe, null, localBin)).toBe(true);
    const elsewhere = { ...probe, path: ["/usr/bin"] };
    expect(onPathFrom(elsewhere, "", localBin)).toBe(false);
    expect(onPathFrom(elsewhere, "# ~/.local/bin\n", localBin)).toBe(true);
  });

  it("gives null without markers and reads empty answers as nothing found", async () => {
    const env = environment({ platform: "linux", shell: "/bin/bash" });
    const answer =
      (stdout: string): Runner =>
      async () => ({
        code: 0,
        stdout,
        stderr: "",
        timedOut: false,
      });
    expect(await probeShell({ ...env, run: answer("hello\n") })).toBeNull();
    expect(
      await probeShell({
        ...env,
        run: async () => {
          throw new Error("spawn failed");
        },
      }),
    ).toBeNull();
    expect(
      await probeShell({
        ...env,
        run: answer(
          "\n__KAMAPATHY_PATH__/bin\n__KAMAPATHY_COMMAND__\n__KAMAPATHY_NODE__\n",
        ),
      }),
    ).toEqual({ path: ["/bin"], kamapathy: null, node: null });
  });

  it("asks cmd.exe for node on Windows", async () => {
    const calls: Parameters<Runner>[] = [];
    let answer: Answer = {
      code: 0,
      stdout: "24.3.0\r\n",
      stderr: "",
      timedOut: false,
    };
    const env = environment({
      platform: "win32",
      shell: null,
      env: { Path: "C:\\nodejs", SystemRoot: "C:\\Windows", Unset: undefined },
      run: async (...call) => {
        calls.push(call);
        return answer;
      },
    });
    expect(await probeShell(env)).toEqual({
      path: [],
      kamapathy: null,
      node: "24.3.0",
    });
    expect(calls[0]).toEqual([
      "cmd.exe",
      ["/d", "/c", "node", "-p", "process.versions.node"],
      {
        env: { Path: "C:\\nodejs", SystemRoot: "C:\\Windows" },
        timeoutMs: 5000,
      },
    ]);
    answer = { code: 9009, stdout: "", stderr: "not found", timedOut: false };
    expect(await probeShell(env)).toEqual({
      path: [],
      kamapathy: null,
      node: null,
    });
    answer = { code: null, stdout: "", stderr: "", timedOut: true };
    expect(await probeShell(env)).toBeNull();
  });

  it("warns about a missing or old Node", () => {
    expect(nodeStatus(null)).toEqual({
      found: false,
      version: null,
      warning: "node_missing",
    });
    expect(nodeStatus("22.12.9")).toEqual({
      found: true,
      version: "22.12.9",
      warning: "node_too_old",
    });
    expect(nodeStatus("18.20.1")).toEqual({
      found: true,
      version: "18.20.1",
      warning: "node_too_old",
    });
    expect(nodeStatus("22.13.0")).toEqual({ found: true, version: "22.13.0" });
    expect(nodeStatus("24.3.0")).toEqual({ found: true, version: "24.3.0" });
  });

  it.skipIf(!posix)(
    "the probe reads its markers through a real login shell",
    async () => {
      const shells = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((shell) =>
        existsSync(shell),
      );
      for (const shell of shells) {
        const env = environment({
          shell,
          run: execRunner,
          env: { USER: "avery" },
        });
        const probe = await probeShell(env);
        expect(probe, shell).not.toBeNull();
        expect(probe!.path.length, shell).toBeGreaterThan(0);
        expect(probe!.kamapathy, shell).toBeNull();
        if (probe!.node !== null) expect(probe!.node).toMatch(/^\d+\.\d+\.\d+/);
      }
    },
    30_000,
  );

  it.skipIf(!posix)(
    "the runner ignores stdin and stops a command that takes too long",
    async () => {
      const env = { PATH: "/usr/bin:/bin" };
      expect(
        await execRunner(
          "/bin/sh",
          ["-c", "cat; echo out; echo err >&2; exit 3"],
          { env, timeoutMs: 5000 },
        ),
      ).toEqual({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false });

      const started = Date.now();
      expect(
        await execRunner("/bin/sh", ["-c", "sleep 5 & sleep 5; echo late"], {
          env,
          timeoutMs: 300,
        }),
      ).toMatchObject({ code: null, timedOut: true });
      expect(Date.now() - started).toBeLessThan(3000);

      await expect(
        execRunner("/bin/sh", ["-c", "head -c 70000 /dev/zero"], {
          env,
          timeoutMs: 5000,
        }),
      ).rejects.toThrow();
      await expect(
        execRunner(join(temporary(), "missing"), [], { env, timeoutMs: 1000 }),
      ).rejects.toThrow();
    },
  );
});

// A login shell, cmd.exe and the Windows PATH script, answering from these
// fields.
interface FakeShell {
  onPath: boolean;
  kamapathy: string | null;
  node: string | null;
  fails: boolean;
  userPath: string[];
  calls: string[];
}
function fakeShell(): { shell: FakeShell; run: Runner } {
  const shell: FakeShell = {
    onPath: false,
    kamapathy: null,
    node: "24.3.0",
    fails: false,
    userPath: [],
    calls: [],
  };
  const answer = (stdout: string): Answer => ({
    code: 0,
    stdout,
    stderr: "",
    timedOut: false,
  });
  const run: Runner = async (file, _args, { env }) => {
    shell.calls.push(file);
    if (file.endsWith("powershell.exe")) {
      const bin = env.KAMAPATHY_BIN.toLowerCase();
      const present = shell.userPath.includes(bin);
      const action = env.KAMAPATHY_PATH_ACTION;
      if (action === "add" && !present) {
        shell.userPath.push(bin);
        return answer("added\r\n");
      }
      if (action === "remove" && present) {
        shell.userPath = shell.userPath.filter((entry) => entry !== bin);
        return answer("removed\r\n");
      }
      return answer(present ? "present\r\n" : "absent\r\n");
    }
    if (shell.fails)
      return { code: null, stdout: "", stderr: "", timedOut: true };
    if (file === "cmd.exe") return answer(`${shell.node ?? ""}\r\n`);
    const path = ["/usr/bin", "/bin"];
    if (shell.onPath) path.push(`${env.HOME}/.local/bin`);
    return answer(
      `Last login: today\n__KAMAPATHY_PATH__${path.join(":")}\n__KAMAPATHY_COMMAND__${shell.kamapathy ?? ""}\n__KAMAPATHY_NODE__${shell.node ?? ""}\n`,
    );
  };
  return { shell, run };
}
function setupEnvironment(overrides: Partial<SetupEnvironment> = {}) {
  const { shell, run } = fakeShell();
  const env = environment({
    bundledSkill: skillFolder({
      "SKILL.md": "# Kamapathy\n",
      "scripts/kamapathy.mjs": "one\n",
    }),
    run,
    ...overrides,
  });
  return { env, shell, home: env.home, paths: toolPaths(env) };
}
const request = (
  choices: Partial<AgentSetupRequest> = {},
): AgentSetupRequest => ({
  agents: [],
  replace: [],
  command: false,
  path: false,
  codexRule: false,
  ...choices,
});
const lexists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
// Every path under a folder with its kind and its text or link target.
function snapshot(folder: string) {
  const entries: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const name of readdirSync(join(folder, relative))) {
      const path = join(relative, name);
      const full = join(folder, path);
      const metadata = lstatSync(full);
      if (metadata.isSymbolicLink())
        entries[path] = `link ${readlinkSync(full)}`;
      else if (metadata.isDirectory()) {
        entries[path] = "folder";
        walk(path);
      } else entries[path] = `file ${readFileSync(full, "utf8")}`;
    }
  };
  walk("");
  return entries;
}
const toolsFolder = posix ? ".local" : "AppData";

describe("agent setup", () => {
  it("lists ten agents with their skills folders and how each is detected", () => {
    const env = environment({ platform: "darwin", home: "/Users/avery" });
    expect(agentRows(env)).toEqual([
      {
        id: "claude-code",
        name: "Claude Code",
        folder: "/Users/avery/.claude/skills",
        detected: false,
      },
      {
        id: "codex",
        name: "Codex",
        folder: "/Users/avery/.codex/skills",
        detected: false,
      },
      {
        id: "cursor",
        name: "Cursor",
        folder: "/Users/avery/.cursor/skills",
        detected: false,
      },
      {
        id: "gemini-cli",
        name: "Gemini CLI",
        folder: "/Users/avery/.gemini/skills",
        detected: false,
      },
      {
        id: "github-copilot",
        name: "GitHub Copilot",
        folder: "/Users/avery/.copilot/skills",
        detected: false,
      },
      {
        id: "opencode",
        name: "OpenCode",
        folder: "/Users/avery/.config/opencode/skills",
        detected: false,
      },
      {
        id: "windsurf",
        name: "Windsurf",
        folder: "/Users/avery/.codeium/windsurf/skills",
        detected: false,
      },
      {
        id: "goose",
        name: "Goose",
        folder: "/Users/avery/.config/goose/skills",
        detected: false,
      },
      {
        id: "amp",
        name: "Amp",
        folder: "/Users/avery/.config/agents/skills",
        detected: false,
      },
      {
        id: "shared",
        name: "Cline, Warp, Zed",
        folder: "/Users/avery/.agents/skills",
        detected: false,
      },
    ]);
    expect(agentRows(env).map((row) => row.id)).toEqual(AGENT_IDS);

    // Variables count only as found in the app's own environment.
    const folders = (more: Partial<SetupEnvironment>) =>
      agentRows({ ...env, ...more }).map((row) => row.folder);
    expect(
      folders({
        env: {
          CLAUDE_CONFIG_DIR: "/claude",
          CODEX_HOME: "/codex",
          XDG_CONFIG_HOME: "/config",
        },
      }),
    ).toEqual([
      "/claude/skills",
      "/codex/skills",
      "/Users/avery/.cursor/skills",
      "/Users/avery/.gemini/skills",
      "/Users/avery/.copilot/skills",
      "/config/opencode/skills",
      "/Users/avery/.codeium/windsurf/skills",
      "/Users/avery/.config/goose/skills",
      "/Users/avery/.config/agents/skills",
      "/Users/avery/.agents/skills",
    ]);
    const windows = "C:\\Users\\avery";
    expect(folders({ platform: "win32", home: windows, shell: null })).toEqual(
      [
        ".claude\\skills",
        ".codex\\skills",
        ".cursor\\skills",
        ".gemini\\skills",
        ".copilot\\skills",
        ".config\\opencode\\skills",
        ".codeium\\windsurf\\skills",
        ".config\\goose\\skills",
        ".config\\agents\\skills",
        ".agents\\skills",
      ].map((folder) => `${windows}\\${folder}`),
    );

    const detected = (...folders: string[][]) => {
      const home = environment();
      for (const folder of folders)
        mkdirSync(join(home.home, ...folder), { recursive: true });
      return agentRows(home)
        .filter((row) => row.detected)
        .map((row) => row.id);
    };
    expect(detected()).toEqual([]);
    expect(detected([".config", "agents"])).toEqual([]);
    expect(detected([".config", "amp"])).toEqual(["amp"]);
    const zed = posix ? [".config", "zed"] : ["AppData", "Roaming", "Zed"];
    for (const mark of [[".agents"], [".cline"], [".warp"], zed])
      expect(detected(mark), mark.join("/")).toEqual(["shared"]);
    expect(
      detected(
        [".claude"],
        [".codex"],
        [".cursor"],
        [".gemini"],
        [".copilot"],
        [".config", "opencode"],
        [".codeium", "windsurf"],
        [".config", "goose"],
      ),
    ).toEqual(AGENT_IDS.slice(0, 8));
  });

  it("links only detected agents, never over own copies", async () => {
    const { env, home, paths } = setupEnvironment();
    mkdirSync(join(home, ".claude"));
    const codexEntry = join(home, ".codex", "skills", "kamapathy");
    mkdirSync(codexEntry, { recursive: true });
    writeFileSync(join(codexEntry, "SKILL.md"), "theirs");
    const claude = {
      id: "claude-code",
      name: "Claude Code",
      folder: join(home, ".claude", "skills"),
    };
    const codex = {
      id: "codex",
      name: "Codex",
      folder: join(home, ".codex", "skills"),
    };
    const setup = createAgentSetup(env);

    const before = await setup.status();
    expect(before).toMatchObject({
      supported: true,
      skillFolder: null,
      node: null,
    });
    expect(before.agents).toEqual([
      { ...claude, state: "available" },
      { ...codex, state: "own_copy" },
    ]);
    // Reading the status changes nothing.
    expect(readdirSync(home).sort()).toEqual([".claude", ".codex"]);

    const after = await setup.apply(request({ agents: [...AGENT_IDS] }));
    expect(after.skillFolder).toBe(paths.stable);
    expect(after.agents).toEqual([
      { ...claude, state: "linked" },
      { ...codex, state: "own_copy" },
    ]);
    const claudeEntry = join(claude.folder, "kamapathy");
    expect(entryState(claudeEntry, paths.stable, process.platform)).toBe(
      "linked",
    );
    expect(readFileSync(join(claudeEntry, "SKILL.md"), "utf8")).toBe(
      "# Kamapathy\n",
    );
    expect(readdirSync(codex.folder)).toEqual(["kamapathy"]);
    expect(readFileSync(join(codexEntry, "SKILL.md"), "utf8")).toBe("theirs");
    // Undetected agents get nothing, and the Codex rule stays off.
    expect(readdirSync(home).sort()).toEqual([
      ".claude",
      ".codex",
      toolsFolder,
    ]);
    expect(readdirSync(join(home, ".codex"))).toEqual(["skills"]);
  });

  it("replace keeps a backup", async () => {
    const { env, home, paths } = setupEnvironment({
      now: () => 1_700_000_000_000,
    });
    const folder = join(home, ".codex", "skills");
    const entry = join(folder, "kamapathy");
    mkdirSync(join(entry, "scripts"), { recursive: true });
    writeFileSync(join(entry, "SKILL.md"), "theirs");
    writeFileSync(join(entry, "scripts", "x.mjs"), "x");

    const status = await createAgentSetup(env).apply(
      request({ agents: ["codex"], replace: ["codex"] }),
    );
    const [row] = status.agents;
    expect(row).toMatchObject({ id: "codex", state: "linked" });
    const backup = row.backup!;
    expect(dirname(backup)).toBe(folder);
    expect(basename(backup)).toMatch(
      /^\.kamapathy-backup-1700000000000-[0-9a-f]{8}$/,
    );
    expect(readdirSync(folder).sort()).toEqual(
      [basename(backup), "kamapathy"].sort(),
    );
    expect(entryState(entry, paths.stable, process.platform)).toBe("linked");
    expect(readFileSync(join(backup, "SKILL.md"), "utf8")).toBe("theirs");
    expect(readFileSync(join(backup, "scripts", "x.mjs"), "utf8")).toBe("x");
  });

  it("unlinking one agent keeps the skill copy", async () => {
    const { env, home, paths } = setupEnvironment();
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".cursor"));
    const setup = createAgentSetup(env);
    await setup.apply(request({ agents: ["claude-code", "cursor"] }));
    const copy = stableTarget(paths)!;
    const claudeEntry = join(home, ".claude", "skills", "kamapathy");
    const cursorEntry = join(home, ".cursor", "skills", "kamapathy");
    expect(entryState(cursorEntry, paths.stable, process.platform)).toBe(
      "linked",
    );

    const status = await setup.apply(request({ agents: ["claude-code"] }));
    expect(status.agents.map((row) => [row.id, row.state])).toEqual([
      ["claude-code", "linked"],
      ["cursor", "available"],
    ]);
    expect(lexists(cursorEntry)).toBe(false);
    expect(readdirSync(join(home, ".cursor", "skills"))).toEqual([]);
    expect(stableTarget(paths)).toBe(copy);
    expect(readFileSync(join(copy, "SKILL.md"), "utf8")).toBe("# Kamapathy\n");
    expect(entryState(claudeEntry, paths.stable, process.platform)).toBe(
      "linked",
    );
  });

  it("remove deletes only Kamapathy entries, blocks and T", async () => {
    const { env, home, paths, shell } = setupEnvironment();
    for (const name of [".claude", ".codex", ".cursor"])
      mkdirSync(join(home, name));
    // Cursor links to another skill copy; Codex has its own folder.
    const other = join(temporary(), "other");
    mkdirSync(other);
    writeFileSync(join(other, "SKILL.md"), "other");
    const cursorEntry = join(home, ".cursor", "skills", "kamapathy");
    mkdirSync(dirname(cursorEntry));
    link(other, cursorEntry);
    const codexEntry = join(home, ".codex", "skills", "kamapathy");
    mkdirSync(codexEntry, { recursive: true });
    writeFileSync(join(codexEntry, "SKILL.md"), "theirs");
    const rules = codexRulesFile(env);
    mkdirSync(dirname(rules));
    const ownRule =
      'prefix_rule(pattern=["git", "status"], decision="allow")\n';
    writeFileSync(rules, ownRule);
    const profile = join(home, ".zshrc");
    if (posix) writeFileSync(profile, "alias ll='ls -l'\n");

    const setup = createAgentSetup(env);
    const applied = await setup.apply(
      request({
        agents: ["claude-code", "codex", "cursor"],
        replace: ["codex"],
        command: true,
        path: true,
        codexRule: true,
      }),
    );
    const backup = applied.agents.find((row) => row.id === "codex")!.backup!;
    expect(readFileSync(rules, "utf8")).toBe(ownRule + CODEX_BLOCK);
    // The person edits the PATH lines and adds one of their own, and a link
    // inside T leads out of it.
    const editedPath = SH_PATH_BLOCK.replace("$HOME/.local/bin", "$HOME/bin");
    const editedProfile = `alias ll='ls -l'\n${editedPath}export EDITOR=vi\n`;
    if (posix) writeFileSync(profile, editedProfile);
    const outside = temporary();
    writeFileSync(join(outside, "keep.txt"), "keep");
    link(outside, join(paths.tools, "outside"));

    const removed = await setup.remove();
    expect(lexists(paths.tools)).toBe(false);
    expect(lexists(join(home, ".claude", "skills", "kamapathy"))).toBe(false);
    expect(lexists(codexEntry)).toBe(false);
    expect(readFileSync(join(backup, "SKILL.md"), "utf8")).toBe("theirs");
    expect(readFileSync(join(cursorEntry, "SKILL.md"), "utf8")).toBe("other");
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(readFileSync(rules, "utf8")).toBe(ownRule);
    expect(removed).toMatchObject({
      supported: true,
      skillFolder: null,
      codex: { detected: true, allowed: false },
      node: null,
    });
    expect(removed.agents.map((row) => [row.id, row.state])).toEqual([
      ["claude-code", "available"],
      ["codex", "available"],
      ["cursor", "own_copy"],
    ]);
    if (posix) {
      expect(lexists(paths.commandLink!)).toBe(false);
      expect(readFileSync(profile, "utf8")).toBe(editedProfile);
      expect(removed.command).toMatchObject({
        state: "off",
        pathAdded: false,
        reason: "profile_changed",
      });
    } else expect(shell.userPath).toEqual([]);

    // Unchanged PATH lines go, and an edited Codex block stays.
    if (posix) writeFileSync(profile, "alias ll='ls -l'\n");
    await setup.apply(
      request({
        agents: ["claude-code"],
        command: true,
        path: true,
        codexRule: true,
      }),
    );
    if (posix)
      expect(readFileSync(profile, "utf8")).toBe(
        `alias ll='ls -l'\n${SH_PATH_BLOCK}`,
      );
    const editedRule = CODEX_BLOCK.replace(
      'decision="allow"',
      'decision="prompt"',
    );
    writeFileSync(rules, ownRule + editedRule);
    const again = await setup.remove();
    expect(readFileSync(rules, "utf8")).toBe(ownRule + editedRule);
    if (posix) {
      expect(readFileSync(profile, "utf8")).toBe("alias ll='ls -l'\n");
      expect(again.command.reason).toBeUndefined();
    }
    expect(lexists(paths.tools)).toBe(false);
    expect(readFileSync(join(backup, "SKILL.md"), "utf8")).toBe("theirs");
  });

  it("apply is idempotent", async () => {
    const { env, home } = setupEnvironment();
    mkdirSync(join(home, ".claude"));
    const codexEntry = join(home, ".codex", "skills", "kamapathy");
    mkdirSync(codexEntry, { recursive: true });
    writeFileSync(join(codexEntry, "SKILL.md"), "theirs");
    if (posix) writeFileSync(join(home, ".zshrc"), "alias ll='ls -l'\n");
    const setup = createAgentSetup(env);
    const same = request({
      agents: ["claude-code", "codex"],
      replace: ["codex"],
      command: true,
      path: true,
      codexRule: true,
    });

    const first = await setup.apply(same);
    expect(first.agents[1].backup).toBeDefined();
    const files = snapshot(home);
    const second = await setup.apply(same);
    expect(snapshot(home)).toEqual(files);
    expect(second).toEqual({
      ...first,
      agents: first.agents.map(({ backup, ...row }) => row),
    });
    expect(
      readdirSync(join(home, ".codex", "skills")).filter((name) =>
        name.startsWith(".kamapathy-backup-"),
      ),
    ).toHaveLength(1);
    expect(readFileSync(codexRulesFile(env), "utf8")).toBe(CODEX_BLOCK);
    if (posix)
      expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe(
        `alias ll='ls -l'\n${SH_PATH_BLOCK}`,
      );
  });

  it("calls from one process wait for each other", async () => {
    const { env, home } = setupEnvironment();
    mkdirSync(join(home, ".claude"));
    const setup = createAgentSetup(env);
    const same = request({ agents: ["claude-code"], command: true });
    const [first, between, second] = await Promise.all([
      setup.apply(same),
      setup.status(),
      setup.apply(same),
    ]);
    expect(first.agents).toMatchObject([{ state: "linked" }]);
    expect(between.agents).toMatchObject([{ state: "linked" }]);
    expect(second).toEqual(first);
  });

  it.skipIf(!posix)(
    "an occupied ~/.local/bin/kamapathy is command_taken",
    async () => {
      const { env, paths } = setupEnvironment();
      const commandLink = paths.commandLink!;
      mkdirSync(dirname(commandLink), { recursive: true });
      writeFileSync(commandLink, "#!/bin/sh\necho mine\n");
      const setup = createAgentSetup(env);

      expect((await setup.status()).command).toEqual({
        state: "off",
        path: commandLink,
        onPath: null,
        profileFile: join(env.home, ".zshrc"),
        pathAdded: false,
        reason: "command_taken",
      });
      const taken = await setup.apply(request({ command: true }));
      expect(taken.command).toMatchObject({
        state: "error",
        reason: "command_taken",
      });
      expect(readFileSync(commandLink, "utf8")).toBe("#!/bin/sh\necho mine\n");

      rmSync(commandLink);
      symlinkSync("/usr/bin/true", commandLink);
      expect((await setup.status()).command).toMatchObject({
        state: "off",
        reason: "command_taken",
      });
      expect(
        (await setup.apply(request({ command: true }))).command,
      ).toMatchObject({ state: "error", reason: "command_taken" });
      expect((await setup.apply(request())).command).toMatchObject({
        state: "off",
        reason: "command_taken",
      });
      expect(readlinkSync(commandLink)).toBe("/usr/bin/true");
    },
  );

  it.skipIf(!posix)(
    "status reads PATH, the command and Node from the login shell",
    async () => {
      const { env, paths, shell } = setupEnvironment();
      const commandLink = paths.commandLink!;
      const profile = join(env.home, ".zshrc");
      const setup = createAgentSetup(env);
      const off = {
        state: "off",
        path: commandLink,
        onPath: null,
        profileFile: profile,
        pathAdded: false,
      };

      expect(await setup.status()).toMatchObject({ command: off, node: null });
      expect(shell.calls).toEqual([]);
      const probed = await setup.status({ probe: true });
      expect(probed.command).toEqual({ ...off, onPath: false });
      expect(probed.node).toEqual({ found: true, version: "24.3.0" });
      expect(shell.calls).toEqual(["/bin/zsh"]);

      const applied = await setup.apply(request({ command: true, path: true }));
      expect(applied.command).toEqual({
        ...off,
        state: "on",
        onPath: true,
        pathAdded: true,
      });
      const elsewhere = join(temporary(), "kamapathy");
      writeFileSync(elsewhere, "#!/bin/sh\n");
      shell.kamapathy = elsewhere;
      expect((await setup.status({ probe: true })).command.reason).toBe(
        "shadowed",
      );
      shell.kamapathy = commandLink;
      expect(
        (await setup.status({ probe: true })).command.reason,
      ).toBeUndefined();

      shell.fails = true;
      const failed = await setup.status({ probe: true });
      expect(failed.command).toMatchObject({
        onPath: true,
        reason: "probe_failed",
      });
      expect(failed.node).toBeNull();

      shell.fails = false;
      shell.node = null;
      writeFileSync(
        profile,
        SH_PATH_BLOCK.replace("$HOME/.local/bin", "$HOME/bin"),
      );
      const changed = await setup.status({ probe: true });
      expect(changed.command).toMatchObject({
        state: "on",
        pathAdded: false,
        reason: "profile_changed",
      });
      expect(changed.node).toEqual({ found: false, version: null });
    },
  );

  it.skipIf(!posix || root)(
    "a folder Kamapathy cannot write marks only that agent or the command",
    async () => {
      const { env, home, paths } = setupEnvironment();
      mkdirSync(join(home, ".claude"));
      const cursor = join(home, ".cursor");
      mkdirSync(cursor);
      chmodSync(cursor, 0o500);
      const localBin = paths.localBin!;
      mkdirSync(localBin, { recursive: true });
      chmodSync(localBin, 0o500);
      try {
        const status = await createAgentSetup(env).apply(
          request({ agents: ["claude-code", "cursor"], command: true }),
        );
        expect(status.agents).toEqual([
          {
            id: "claude-code",
            name: "Claude Code",
            folder: join(home, ".claude", "skills"),
            state: "linked",
          },
          {
            id: "cursor",
            name: "Cursor",
            folder: join(cursor, "skills"),
            state: "error",
            reason: "not_writable",
          },
        ]);
        expect(status.command).toMatchObject({
          state: "error",
          reason: "not_writable",
        });
      } finally {
        chmodSync(cursor, 0o700);
        chmodSync(localBin, 0o700);
      }
    },
  );

  it.skipIf(!posix)(
    "a tools folder that is a link rejects the whole apply",
    async () => {
      const { env, home, paths } = setupEnvironment();
      mkdirSync(join(home, ".claude"));
      mkdirSync(dirname(paths.tools), { recursive: true });
      symlinkSync(temporary(), paths.tools);
      const setup = createAgentSetup(env);
      const error = await setup
        .apply(request({ agents: ["claude-code"], command: true, path: true }))
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SetupError);
      expect(error).toMatchObject({ reason: "not_private" });
      expect(readdirSync(join(home, ".claude"))).toEqual([]);
      expect(existsSync(join(home, ".zshrc"))).toBe(false);
      expect(existsSync(join(home, ".local", "bin"))).toBe(false);
      // Later calls still run.
      expect((await setup.status()).agents).toMatchObject([
        { id: "claude-code", state: "available" },
      ]);
    },
  );

  it("the Codex block follows CODEX_HOME", async () => {
    expect(CODEX_BLOCK).toBe(
      '# Added by Kamapathy: lets Codex run the kamapathy command without asking\nprefix_rule(pattern=["kamapathy"], decision="allow")\n# End of Kamapathy lines\n',
    );
    // A CODEX_HOME set only in the developer's shell is never read.
    const shellCodex = temporary();
    mkdirSync(join(shellCodex, "rules"));
    writeFileSync(join(shellCodex, "rules", "default.rules"), CODEX_BLOCK);
    const saved = process.env.CODEX_HOME;
    process.env.CODEX_HOME = shellCodex;
    try {
      const { env, home } = setupEnvironment();
      const setup = createAgentSetup(env);
      expect(codexHome(env)).toBe(join(home, ".codex"));
      expect(codexRulesFile(env)).toBe(
        join(home, ".codex", "rules", "default.rules"),
      );
      expect((await setup.status()).codex).toEqual({
        detected: false,
        allowed: false,
      });
      // Without Codex the rule is not written.
      expect((await setup.apply(request({ codexRule: true }))).codex).toEqual({
        detected: false,
        allowed: false,
      });
      expect(existsSync(join(home, ".codex"))).toBe(false);

      mkdirSync(join(home, ".codex"));
      expect((await setup.apply(request({ codexRule: true }))).codex).toEqual({
        detected: true,
        allowed: true,
      });
      expect(readFileSync(codexRulesFile(env), "utf8")).toBe(CODEX_BLOCK);
      expect((await setup.apply(request())).codex).toEqual({
        detected: true,
        allowed: false,
      });
      expect(readFileSync(codexRulesFile(env), "utf8")).toBe("");

      const codex = join(temporary(), "codex-home");
      const moved = { ...env, env: { CODEX_HOME: codex } };
      const rules = join(codex, "rules", "default.rules");
      expect(codexHome(moved)).toBe(codex);
      expect(codexRulesFile(moved)).toBe(rules);
      mkdirSync(dirname(rules), { recursive: true });
      const own = 'prefix_rule(pattern=["git", "status"], decision="allow")';
      writeFileSync(rules, own);
      expect(codexRuleState(moved)).toBe("absent");
      expect(setCodexRule(moved, true)).toBe("present");
      expect(setCodexRule(moved, true)).toBe("present");
      expect(readFileSync(rules, "utf8")).toBe(`${own}\n${CODEX_BLOCK}`);
      const movedStatus = await createAgentSetup(moved).status();
      expect(movedStatus.codex).toEqual({ detected: true, allowed: true });
      expect(movedStatus.agents.find((row) => row.id === "codex")?.folder).toBe(
        join(codex, "skills"),
      );
      expect(setCodexRule(moved, false)).toBe("absent");
      expect(readFileSync(rules, "utf8")).toBe(`${own}\n`);

      // An edited block is the person's and stays either way.
      const edited = `${own}\n${CODEX_BLOCK.replace('decision="allow"', 'decision="prompt"')}`;
      writeFileSync(rules, edited);
      expect(codexRuleState(moved)).toBe("changed");
      expect(setCodexRule(moved, false)).toBe("profile_changed");
      expect(setCodexRule(moved, true)).toBe("profile_changed");
      expect(readFileSync(rules, "utf8")).toBe(edited);
      expect((await createAgentSetup(moved).status()).codex).toEqual({
        detected: true,
        allowed: false,
      });
      expect(
        readFileSync(join(shellCodex, "rules", "default.rules"), "utf8"),
      ).toBe(CODEX_BLOCK);
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = saved;
    }
  });

  it("a test profile on the real home is unsupported", async () => {
    const home = temporary();
    mkdirSync(join(home, ".claude"));
    const { env, paths, shell } = setupEnvironment({
      home,
      accountHome: home,
    });
    const setup = createAgentSetup(env);
    expect(await setup.status({ probe: true })).toEqual({
      supported: false,
      reason: "test_profile",
      skillFolder: null,
      agents: [],
      command: {
        state: "off",
        path: paths.commandLink ?? paths.launcherCmd,
        onPath: null,
        profileFile: null,
        pathAdded: false,
      },
      codex: { detected: false, allowed: false },
      node: null,
    });
    for (const call of [
      () =>
        setup.apply(
          request({ agents: ["claude-code"], command: true, path: true }),
        ),
      () => setup.remove(),
    ]) {
      const error = await call().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SetupError);
      expect(error).toMatchObject({ reason: "unsupported" });
    }
    await setup.refresh();
    expect(readdirSync(home)).toEqual([".claude"]);
    expect(shell.calls).toEqual([]);
    expect(ExportedSetupError).toBe(SetupError);

    const elsewhere = createAgentSetup({ ...env, accountHome: temporary() });
    expect((await elsewhere.status()).supported).toBe(true);
  });

  it("rejects requests that are not exactly an AgentSetupRequest", () => {
    const valid = {
      agents: ["claude-code", "codex"],
      replace: ["codex"],
      command: true,
      path: false,
      codexRule: false,
    };
    const parsed = parseAgentSetupRequest(valid);
    expect(parsed).toEqual(valid);
    expect(parsed.agents).not.toBe(valid.agents);
    expect(
      parseAgentSetupRequest({ ...valid, agents: [...AGENT_IDS] }).agents,
    ).toEqual(AGENT_IDS);

    const sparse = new Array<string>(2);
    sparse[1] = "codex";
    const invalid: unknown[] = [
      undefined,
      null,
      "request",
      1,
      [],
      new Map(Object.entries(valid)),
      {},
      Object.assign(Object.create({ inherited: true }), valid),
      { ...valid, extra: true },
      { agents: [], replace: [], command: false, path: false },
      { ...valid, agents: ["claude-code", "claude-code"] },
      { ...valid, agents: ["claude-code", "vim"], replace: [] },
      { ...valid, agents: "claude-code", replace: [] },
      { ...valid, agents: [1], replace: [] },
      { ...valid, agents: sparse },
      { ...valid, agents: [...AGENT_IDS, "codex"] },
      { ...valid, replace: ["cursor"] },
      { ...valid, replace: ["codex", "codex"] },
      { ...valid, replace: "codex" },
      { ...valid, command: "true" },
      { ...valid, path: 0 },
      { ...valid, codexRule: null },
    ];
    for (const value of invalid)
      expect(() => parseAgentSetupRequest(value)).toThrow(
        /^Invalid agent setup request\.$/,
      );
  });

  it("refresh at start updates S and launchers but never recreates a deleted agent entry", async () => {
    const { env, home, paths } = setupEnvironment();
    mkdirSync(join(home, ".claude"));
    const setup = createAgentSetup(env);
    // Before any setup a refresh changes nothing.
    await setup.refresh();
    expect(readdirSync(home)).toEqual([".claude"]);

    await setup.apply(request({ agents: ["claude-code"], command: true }));
    const first = stableTarget(paths);
    const entry = join(home, ".claude", "skills", "kamapathy");
    unlink(entry);
    writeFileSync(paths.launcher, "#!/bin/sh\n# an older launcher\n");
    writeFileSync(join(env.bundledSkill!, "scripts", "kamapathy.mjs"), "two\n");

    await setup.refresh();
    expect(stableTarget(paths)).not.toBe(first);
    expect(
      readFileSync(join(paths.stable, "scripts", "kamapathy.mjs"), "utf8"),
    ).toBe("two\n");
    expect(readFileSync(paths.launcher, "utf8")).toBe(
      posix ? posixLauncher(paths.stable) : gitBashLauncher(),
    );
    expect(lexists(entry)).toBe(false);
    expect(readdirSync(join(home, ".claude", "skills"))).toEqual([]);
    if (posix) expect(commandLinkState(paths)).toBe("ours");
  });
});
