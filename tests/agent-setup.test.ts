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
import {
  refreshSkill,
  skillDigest,
  stableTarget,
} from "../electron/agent/setup/skill";

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
