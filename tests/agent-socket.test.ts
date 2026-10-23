import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentPaths,
  chooseSocketPath,
  clearQuitMarker,
  clearStaleEndpoint,
  launchCommand,
  prepareAgentDirectory,
  publishEndpoint,
  releaseSocket,
  setAgentAccess,
  withdrawEndpoint,
  writeLaunchInfo,
  writeQuitMarker,
} from "../electron/agent-socket";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function profile() {
  const directory = mkdtempSync(join(tmpdir(), "kamapathy-agent-"));
  directories.push(directory);
  return directory;
}
const posix = process.platform !== "win32";

describe("agent directory", () => {
  it("keeps every rendezvous file inside the profile's agent directory", () => {
    const userData = profile();
    const paths = agentPaths(userData);
    expect(paths.directory).toBe(join(userData, "agent"));
    for (const file of [paths.endpoint, paths.off, paths.launch])
      expect(file.startsWith(paths.directory)).toBe(true);
  });

  it.skipIf(!posix)("creates the directory private to this account and tightens a loose one", () => {
    const paths = agentPaths(profile());
    prepareAgentDirectory(paths);
    expect(statSync(paths.directory).mode & 0o777).toBe(0o700);
    mkdirSync(paths.directory, { recursive: true, mode: 0o755 });
    // A directory we own that has become readable by others is tightened, not trusted.
    chmodSync(paths.directory, 0o755);
    prepareAgentDirectory(paths);
    expect(statSync(paths.directory).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!posix)("refuses an agent directory that is a symbolic link", () => {
    const userData = profile();
    const elsewhere = profile();
    symlinkSync(elsewhere, join(userData, "agent"));
    expect(() => prepareAgentDirectory(agentPaths(userData))).toThrow();
  });
});

describe("socket location", () => {
  it.skipIf(!posix)("uses a socket inside the agent directory when the path fits", () => {
    const userData = profile();
    const path = chooseSocketPath(userData);
    expect(path).toBe(join(userData, "agent", "kamapathy.sock"));
  });

  it.skipIf(!posix)("falls back to a new private temporary directory when the path is too long", () => {
    const userData = join(profile(), "p".repeat(120));
    mkdirSync(userData, { recursive: true });
    const path = chooseSocketPath(userData);
    const directory = path.slice(0, path.lastIndexOf("/"));
    directories.push(directory);
    expect(Buffer.byteLength(path)).toBeLessThan(104);
    expect(path.startsWith(join(tmpdir(), "kamapathy-"))).toBe(true);
    expect(path.endsWith("/kamapathy.sock")).toBe(true);
    const metadata = lstatSync(directory);
    expect(metadata.isDirectory()).toBe(true);
    expect(metadata.mode & 0o077).toBe(0);
    // A new unpredictable folder each start: another account cannot claim it first.
    const again = chooseSocketPath(userData);
    directories.push(again.slice(0, again.lastIndexOf("/")));
    expect(again).not.toBe(path);
  });

  it.skipIf(!posix)("removes a fallback directory on release and never the agent directory", () => {
    const userData = join(profile(), "p".repeat(120));
    mkdirSync(userData, { recursive: true });
    const paths = agentPaths(userData);
    prepareAgentDirectory(paths);
    const fallback = chooseSocketPath(userData);
    releaseSocket(paths, fallback);
    expect(existsSync(fallback.slice(0, fallback.lastIndexOf("/")))).toBe(false);
    releaseSocket(paths, join(paths.directory, "kamapathy.sock"));
    expect(existsSync(paths.directory)).toBe(true);
  });

  it("uses an unguessable pipe on Windows that changes every start", () => {
    const first = chooseSocketPath(profile(), "win32");
    const second = chooseSocketPath(profile(), "win32");
    expect(first).toMatch(/^\\\\\.\\pipe\\kamapathy-[a-f0-9]{32}$/);
    expect(second).not.toBe(first);
  });
});

describe("published state", () => {
  it("publishes and withdraws the endpoint as a private file", () => {
    const paths = agentPaths(profile());
    prepareAgentDirectory(paths);
    publishEndpoint(paths, "/tmp/example.sock", "a".repeat(32));
    expect(JSON.parse(readFileSync(paths.endpoint, "utf8"))).toEqual({
      socket: "/tmp/example.sock",
      instance: "a".repeat(32),
    });
    if (posix) expect(statSync(paths.endpoint).mode & 0o777).toBe(0o600);
    withdrawEndpoint(paths);
    expect(existsSync(paths.endpoint)).toBe(false);
    withdrawEndpoint(paths);
  });

  it("marks access as off exactly while the switch is off", () => {
    const paths = agentPaths(profile());
    prepareAgentDirectory(paths);
    setAgentAccess(paths, false);
    expect(existsSync(paths.off)).toBe(true);
    setAgentAccess(paths, false);
    setAgentAccess(paths, true);
    expect(existsSync(paths.off)).toBe(false);
  });

  it("records how to start Kamapathy again without reopening debugging ports", () => {
    const paths = agentPaths(profile());
    prepareAgentDirectory(paths);
    writeLaunchInfo(paths, "/Applications/Kamapathy.app/Contents/MacOS/Kamapathy", [
      "/project",
      "--remote-debugging-port=0",
      "-remote-debugging-port=1",
      "--REMOTE-DEBUGGING-PIPE",
      "--inspect=9229",
      "--inspect-brk",
      "/inspector/app",
    ], "linux");
    expect(JSON.parse(readFileSync(paths.launch, "utf8"))).toEqual({
      command: "/Applications/Kamapathy.app/Contents/MacOS/Kamapathy",
      args: ["/project", "/inspector/app"],
    });
    if (posix) expect(statSync(paths.launch).mode & 0o777).toBe(0o600);
  });

  it("replaces files atomically without leaving temporary files behind", () => {
    const paths = agentPaths(profile());
    prepareAgentDirectory(paths);
    writeFileSync(paths.endpoint, "stale");
    publishEndpoint(paths, "/tmp/new.sock", "b".repeat(32));
    expect(JSON.parse(readFileSync(paths.endpoint, "utf8")).socket).toBe("/tmp/new.sock");
    const leftovers = readdirSync(paths.directory).filter((name) =>
      name.includes(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});

describe("launch command", () => {
  it("records the stable AppImage and portable launchers, not their temporary copies", () => {
    expect(
      launchCommand({
        env: { APPIMAGE: "/home/me/Apps/Kamapathy.AppImage", APPDIR: "/tmp/.mount_Kamapathy-abc123" },
        execPath: "/tmp/.mount_Kamapathy-abc123/kamapathy",
        defaultApp: false,
        appPath: "/tmp/.mount_Kamapathy-abc123/resources/app.asar",
        platform: "linux",
      }),
    ).toEqual({ command: "/home/me/Apps/Kamapathy.AppImage", args: [] });
    expect(
      launchCommand({
        env: { PORTABLE_EXECUTABLE_FILE: "C:\\Tools\\Kamapathy.exe", PORTABLE_EXECUTABLE_APP_FILENAME: "Kamapathy" },
        execPath: "C:\\Users\\me\\AppData\\Local\\Temp\\2x\\Kamapathy.exe",
        defaultApp: false,
        appPath: "C:\\Users\\me\\AppData\\Local\\Temp\\2x\\resources\\app.asar",
        platform: "win32",
      }).command,
    ).toBe("C:\\Tools\\Kamapathy.exe");
  });

  it("replays only the absolute app folder Electron loaded for a source checkout", () => {
    const result = launchCommand({
      env: {},
      execPath: "/runtime/Kamapathy",
      defaultApp: true,
      appPath: ".",
    });
    expect(result.command).toBe("/runtime/Kamapathy");
    expect(result.args).toEqual([process.cwd()]);
  });

  it("never replays a packaged launch's URLs or switches", () => {
    expect(
      launchCommand({
        env: {},
        execPath: "/Applications/Kamapathy.app/Contents/MacOS/Kamapathy",
        defaultApp: false,
        appPath: "/Applications/Kamapathy.app/Contents/Resources/app.asar",
      }).args,
    ).toEqual([]);
  });
});

describe("second review hardening", () => {
  it("ignores AppImage and portable variables inherited from another application", () => {
    // Another AppImage's variables leak into programs it starts.
    expect(
      launchCommand({
        env: { APPIMAGE: "/home/me/Other.AppImage" },
        execPath: "/opt/Kamapathy/kamapathy",
        defaultApp: false,
        appPath: "/opt/Kamapathy/resources/app.asar",
        platform: "linux",
      }).command,
    ).toBe("/opt/Kamapathy/kamapathy");
    expect(
      launchCommand({
        env: { APPIMAGE: "/home/me/Kamapathy.AppImage", APPDIR: "/tmp/.mount_Kamapathy-abc" },
        execPath: "/tmp/.mount_Kamapathy-abc/kamapathy",
        defaultApp: false,
        appPath: "/tmp/.mount_Kamapathy-abc/resources/app.asar",
        platform: "linux",
      }).command,
    ).toBe("/home/me/Kamapathy.AppImage");
    expect(
      launchCommand({
        env: { PORTABLE_EXECUTABLE_FILE: "C:\\Tools\\Other.exe", PORTABLE_EXECUTABLE_APP_FILENAME: "Other" },
        execPath: "C:\\Program Files\\Kamapathy\\Kamapathy.exe",
        defaultApp: false,
        appPath: "C:\\Program Files\\Kamapathy\\resources\\app.asar",
        platform: "win32",
      }).command,
    ).toBe("C:\\Program Files\\Kamapathy\\Kamapathy.exe");
  });

  it("keeps a root-level app folder and drops slash switches only on Windows", () => {
    const paths = agentPaths(profile());
    prepareAgentDirectory(paths);
    writeLaunchInfo(paths, "/runtime/Kamapathy", ["/app", "/remote-debugging-port=1"], "linux");
    expect(JSON.parse(readFileSync(paths.launch, "utf8")).args).toEqual([
      "/app",
      "/remote-debugging-port=1",
    ]);
    writeLaunchInfo(paths, "C:\\Kamapathy.exe", ["C:\\app", "/remote-debugging-port=1"], "win32");
    expect(JSON.parse(readFileSync(paths.launch, "utf8")).args).toEqual(["C:\\app"]);
  });

  it.skipIf(!posix)("uses /tmp for the fallback when the temporary folder path is too long", () => {
    const userData = join(profile(), "p".repeat(120));
    mkdirSync(userData, { recursive: true });
    const path = chooseSocketPath(userData, process.platform, join(profile(), "t".repeat(90)));
    directories.push(path.slice(0, path.lastIndexOf("/")));
    expect(path.startsWith("/tmp/kamapathy-")).toBe(true);
    expect(Buffer.byteLength(path)).toBeLessThan(104);
  });

  it.skipIf(!posix)("removes the fallback folder a crashed start left behind", () => {
    const userData = join(profile(), "p".repeat(120));
    mkdirSync(userData, { recursive: true });
    const paths = agentPaths(userData);
    prepareAgentDirectory(paths);
    const leftover = chooseSocketPath(userData);
    publishEndpoint(paths, leftover, "a".repeat(32));
    clearStaleEndpoint(paths);
    expect(existsSync(leftover.slice(0, leftover.lastIndexOf("/")))).toBe(false);
    expect(existsSync(paths.endpoint)).toBe(false);
    // An endpoint naming some other folder is withdrawn without touching it.
    const unrelated = profile();
    publishEndpoint(paths, join(unrelated, "kamapathy.sock"), "a".repeat(32));
    clearStaleEndpoint(paths);
    expect(existsSync(unrelated)).toBe(true);
  });
});

// The client is Node-only JavaScript with no types of its own, so it answers
// here the way agents run it: in its own Node, over this profile's folder.
function clientRefusal(userData: string): { code: string; reason: string } {
  const transport = new URL(
    "../skills/kamapathy/scripts/lib/transport.mjs",
    import.meta.url,
  ).href;
  const script = `import { resolveSocket } from ${JSON.stringify(transport)};
let answer = { code: "connected", reason: "connected" };
try {
  await resolveSocket();
} catch (error) {
  answer = { code: error.code, reason: error.reason };
}
process.stdout.write(JSON.stringify(answer));`;
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: {
        ...process.env,
        KAMAPATHY_USER_DATA: userData,
        KAMAPATHY_NO_LAUNCH: "1",
      },
    }),
  );
}

describe("the quit marker", () => {
  it("blocks automatic starts for ten minutes and is removed at start", () => {
    const userData = profile();
    const paths = agentPaths(userData);
    prepareAgentDirectory(paths);
    // Beside the endpoint and the off marker, at the path the client derives.
    expect(paths.quit).toBe(join(paths.directory, "quit"));
    for (const file of [paths.endpoint, paths.off, paths.quit])
      expect(file.startsWith(paths.directory)).toBe(true);
    writeQuitMarker(paths, 1700000000000);
    expect(JSON.parse(readFileSync(paths.quit, "utf8"))).toEqual({
      at: 1700000000000,
    });
    if (posix) expect(statSync(paths.quit).mode & 0o777).toBe(0o600);
    // A quit just now stops the client from starting Kamapathy again.
    writeQuitMarker(paths);
    const { at } = JSON.parse(readFileSync(paths.quit, "utf8"));
    expect(Math.abs(Date.now() - at)).toBeLessThan(5000);
    expect(clientRefusal(userData)).toEqual({
      code: "not_connected",
      reason: "quit_by_person",
    });
    // Ten minutes on, the quit no longer stands in the way of a start.
    writeQuitMarker(paths, Date.now() - 600001);
    expect(clientRefusal(userData)).toEqual({
      code: "not_connected",
      reason: "not_running",
    });
    // Every start removes it, and removing one that is gone is no error.
    writeQuitMarker(paths);
    clearQuitMarker(paths);
    expect(existsSync(paths.quit)).toBe(false);
    clearQuitMarker(paths);
    expect(existsSync(paths.quit)).toBe(false);
  });
});
