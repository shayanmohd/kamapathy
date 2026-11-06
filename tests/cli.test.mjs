import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  agentPaths,
  checkSocket,
  formatSnapshot,
  launchEnvironment,
  launchKamapathy,
  launchRecord,
  main,
  resolveSocket,
  runCli,
  socketFetch,
} from "../skills/kamapathy/scripts/kamapathy.mjs";
import {
  Download,
  FileChooser,
  KamapathyError,
  Page,
  connect,
  schema,
} from "../skills/kamapathy/scripts/api.mjs";
import {
  httpTimeout,
  queueNotice,
  Session,
  takeNotices,
} from "../skills/kamapathy/scripts/lib/request.mjs";
import { workspacePath } from "../skills/kamapathy/scripts/lib/workspace.mjs";
import { agentPaths as kamapathyAgentPaths } from "../electron/agent-socket.ts";

// A workspace that does not exist, so runs load no .env from the real profile.
const env = {
  KAMAPATHY_NO_LAUNCH: "1",
  KAMAPATHY_WORKSPACE: join(
    tmpdir(),
    `kamapathy-no-workspace-${randomBytes(8).toString("hex")}`,
  ),
};
const posix = process.platform !== "win32";
const directories = [];
const servers = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((done) => server.close(done))),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const realpathOf = async (path) =>
  (await import("node:fs/promises")).realpath(path);
const sink = () => {
  const output = [];
  return { write: (value) => output.push(value), text: () => output.join("") };
};
async function scratchFile() {
  const directory = await mkdtemp(join(tmpdir(), "kamapathy-cli-test-"));
  directories.push(directory);
  const path = join(directory, "fixture.json");
  await writeFile(path, "{}", { mode: 0o600 });
  return path;
}
// A Kamapathy profile whose agent folder is laid out the way Kamapathy writes it.
async function profile() {
  const userData = await mkdtemp(join(tmpdir(), "kamapathy-cli-profile-"));
  directories.push(userData);
  const paths = agentPaths({ KAMAPATHY_USER_DATA: userData });
  await mkdir(paths.directory, { mode: 0o700 });
  return {
    userData,
    paths,
    env: { KAMAPATHY_USER_DATA: userData, KAMAPATHY_NO_LAUNCH: "1" },
  };
}
const newPipe = () =>
  `\\\\.\\pipe\\kamapathy-${randomBytes(16).toString("hex")}`;
const publish = (paths, socket, instance) =>
  writeFile(paths.endpoint, JSON.stringify({ socket, instance }), {
    mode: 0o600,
  });
// A stand-in Kamapathy on the profile's socket or pipe. `answerAs` is the instance
// it claims; an impostor answers with another value or none.
async function fakeKamapathy(paths, { answerAs, handler } = {}) {
  const socket = posix ? join(paths.directory, "kamapathy.sock") : newPipe();
  const instance = randomBytes(16).toString("hex");
  const server = createServer((request, response) => {
    const claimed = answerAs === undefined ? instance : answerAs;
    if (claimed) response.setHeader("X-Kamapathy-Instance", claimed);
    if (handler) return handler(request, response);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({ status: "ok", version: "test", path: request.url }),
    );
  });
  await new Promise((done) => server.listen(socket, done));
  servers.push(server);
  await publish(paths, socket, instance);
  return { socket, instance };
}
// A socket file whose server died without removing it, as after a crash.
async function staleSocket(path) {
  const child = spawn(process.execPath, [
    "-e",
    "require('node:net').createServer().listen(process.argv[1], () => console.log('up')); setInterval(() => {}, 1e6)",
    path,
  ]);
  await new Promise((done) => child.stdout.once("data", done));
  child.kill("SIGKILL");
  await new Promise((done) => child.once("exit", done));
}

describe("automatic connection", () => {
  it("finds a running Kamapathy in its profile with no setup and talks over its socket", async () => {
    const { paths, env: profileEnv } = await profile();
    const kamapathy = await fakeKamapathy(paths);
    expect(await resolveSocket(profileEnv)).toEqual(kamapathy);
    const stdout = sink();
    expect(await runCli(["health"], { env: profileEnv, stdout })).toBe(0);
    expect(stdout.text()).toBe("ok Kamapathy test\n");
  });

  it("derives the same agent folder as Kamapathy", () => {
    const userData = join(tmpdir(), "kamapathy-agreement");
    const client = agentPaths({ KAMAPATHY_USER_DATA: userData });
    const app = kamapathyAgentPaths(userData);
    expect([
      client.directory,
      client.endpoint,
      client.off,
      client.launch,
    ]).toEqual([app.directory, app.endpoint, app.off, app.launch]);
  });

  it.skipIf(!posix)(
    "refuses a rendezvous that others could read, replace, or redirect",
    async () => {
      const { paths, env: profileEnv } = await profile();
      const kamapathy = await fakeKamapathy(paths);
      await chmod(paths.endpoint, 0o644);
      await expect(resolveSocket(profileEnv)).rejects.toThrow("0600");
      await chmod(paths.endpoint, 0o600);
      const real = `${paths.endpoint}.real`;
      await writeFile(real, JSON.stringify(kamapathy), { mode: 0o600 });
      await rm(paths.endpoint);
      await symlink(real, paths.endpoint);
      await expect(resolveSocket(profileEnv)).rejects.toThrow("link");
      await rm(paths.endpoint);
      await publish(paths, "/tmp/elsewhere.sock", kamapathy.instance);
      await expect(resolveSocket(profileEnv)).rejects.toThrow("kamapathy.sock");
      await publish(paths, "/tmp/kamapathy.sock", kamapathy.instance);
      await expect(resolveSocket(profileEnv)).rejects.toThrow("private");
      await publish(paths, kamapathy.socket, kamapathy.instance);
      await chmod(paths.directory, 0o755);
      await expect(resolveSocket(profileEnv)).rejects.toThrow(
        "private directory",
      );
    },
  );

  it("refuses a pipe that is not Kamapathy's own on Windows-style endpoints", async () => {
    const { paths } = await profile();
    const valid = newPipe();
    expect(checkSocket(valid, paths, "win32")).toBe(valid);
    for (const pipe of [
      "\\\\.\\pipe\\other",
      `\\\\server\\pipe\\kamapathy-${"a".repeat(32)}`,
    ])
      expect(() => checkSocket(pipe, paths, "win32")).toThrow("Kamapathy pipe");
  });

  it("never sends a command to a server that took over Kamapathy's socket or pipe", async () => {
    for (const answerAs of [null, "f".repeat(32)]) {
      const { paths, env: profileEnv } = await profile();
      const requests = [];
      await fakeKamapathy(paths, {
        answerAs,
        handler: (request, response) => {
          requests.push(request.url);
          response.end("{}");
        },
      });
      await expect(resolveSocket(profileEnv)).rejects.toThrow("not running");
      expect(requests).toEqual(["/health"]);
    }
  });

  it("respects the off switch and never starts Kamapathy against it", async () => {
    const { paths, userData } = await profile();
    await writeFile(paths.off, "", { mode: 0o600 });
    const launch = vi.fn();
    await expect(
      resolveSocket({ KAMAPATHY_USER_DATA: userData }, { launch }),
    ).rejects.toThrow("turned off");
    expect(launch).not.toHaveBeenCalled();
  });

  it("starts Kamapathy when access was left on, then waits for it to answer", async () => {
    const { paths, userData } = await profile();
    let kamapathy;
    const launch = vi.fn(async () => {
      kamapathy = await fakeKamapathy(paths);
    });
    expect(
      await resolveSocket(
        { KAMAPATHY_USER_DATA: userData },
        { launch, intervalMs: 10 },
      ),
    ).toEqual(kamapathy);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0].directory).toBe(paths.directory);
  });

  it("reports when Kamapathy never starts, and when launching is disabled", async () => {
    const { userData, env: profileEnv } = await profile();
    await expect(resolveSocket(profileEnv)).rejects.toThrow("not running");
    await expect(
      resolveSocket(
        { KAMAPATHY_USER_DATA: userData },
        { launch: vi.fn(), intervalMs: 10, timeoutMs: 50 },
      ),
    ).rejects.toThrow("did not accept agents");
  });

  it.skipIf(!posix)(
    "treats a socket and endpoint left by a crashed Kamapathy as not running",
    async () => {
      const { paths, env: profileEnv } = await profile();
      const socket = join(paths.directory, "kamapathy.sock");
      await staleSocket(socket);
      expect(existsSync(socket)).toBe(true);
      await publish(paths, socket, "a".repeat(32));
      await expect(resolveSocket(profileEnv)).rejects.toThrow("not running");
    },
  );

  it.skipIf(!posix)(
    "treats a crashed Kamapathy's vanished fallback folder as not running",
    async () => {
      const { paths, env: profileEnv } = await profile();
      await publish(
        paths,
        join(
          tmpdir(),
          `kamapathy-gone-${randomBytes(4).toString("hex")}`,
          "kamapathy.sock",
        ),
        "a".repeat(32),
      );
      await expect(resolveSocket(profileEnv)).rejects.toThrow("not running");
    },
  );

  it("reads Kamapathy's answer even when it replies before the whole request is sent", async () => {
    const { paths } = await profile();
    const kamapathy = await fakeKamapathy(paths, {
      handler: (request, response) => {
        if (request.url === "/health") return response.end("{}");
        response.writeHead(429, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: "busy" } }));
      },
    });
    const body = JSON.stringify({ value: "x".repeat(60000) });
    const response = await socketFetch(kamapathy)("/tabs/t/fill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    expect(response.status).toBe(429);
  });

  it.skipIf(!posix)(
    "never runs a recorded program that another account could have replaced",
    async () => {
      const { paths, userData } = await profile();
      const shared = join(userData, "shared");
      await mkdir(shared);
      await chmod(shared, 0o777);
      const marker = join(userData, "ran");
      const program = join(shared, "kamapathy");
      await writeFile(program, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, {
        mode: 0o755,
      });
      // macOS checks a new program before its first run, which takes about
      // half a second on an idle machine and seconds on a busy one, longer
      // than the wait below. It runs once first, so one started by mistake
      // leaves the marker in time.
      execFileSync(program);
      await rm(marker);
      await writeFile(
        paths.launch,
        JSON.stringify({ command: program, args: [] }),
        { mode: 0o600 },
      );
      await expect(
        launchKamapathy(
          paths,
          { KAMAPATHY_USER_DATA: userData },
          { platform: "darwin" },
        ),
      ).rejects.toThrow("other accounts");
      await new Promise((done) => setTimeout(done, 200));
      expect(existsSync(marker)).toBe(false);
      await chmod(shared, 0o700);
      await launchKamapathy(paths, {
        KAMAPATHY_USER_DATA: userData,
        PATH: process.env.PATH,
      });
      // A busy machine can be slow to start it.
      await expect
        .poll(() => existsSync(marker), { timeout: 10000 })
        .toBe(true);
    },
    20000,
  );

  it("on macOS, does not start the default profile for a named profile Kamapathy never recorded", async () => {
    const { paths, userData } = await profile();
    const darwin = { platform: "darwin" };
    await expect(
      launchKamapathy(paths, { KAMAPATHY_USER_DATA: userData }, darwin),
    ).rejects.toThrow("has not started with this profile");
    await writeFile(
      paths.launch,
      JSON.stringify({
        command: join(userData, "missing", "kamapathy"),
        args: [],
      }),
      { mode: 0o600 },
    );
    await expect(
      launchKamapathy(paths, { KAMAPATHY_USER_DATA: userData }, darwin),
    ).rejects.toThrow("has not started with this profile");
  });

  it("elsewhere, starts the installed Kamapathy with the named profile passed on", async () => {
    const { paths, userData } = await profile();
    // The installed launcher receives KAMAPATHY_USER_DATA; here it is not installed.
    await expect(
      launchKamapathy(
        paths,
        { KAMAPATHY_USER_DATA: userData, PATH: "", HOME: userData },
        { platform: "linux" },
      ),
    ).rejects.toThrow("Could not start Kamapathy");
  });

  it.skipIf(!posix)(
    "Linux start tries kamapathy-browser, then the AppImage",
    async () => {
      const { paths, userData } = await profile();
      const bin = join(userData, "bin");
      const home = join(userData, "home");
      const appImage = join(home, "Applications", "Kamapathy.AppImage");
      await mkdir(bin);
      await mkdir(join(home, "Applications"), { recursive: true });
      const marker = join(userData, "started");
      // Shell builtins only, since PATH holds nothing but the stubs.
      const stub = async (program, name) => {
        await writeFile(
          program,
          `#!/bin/sh\nprintf '%s %s' ${name} "$KAMAPATHY_USER_DATA" > ${JSON.stringify(marker)}\n`,
        );
        await chmod(program, 0o755);
      };
      await stub(join(bin, "kamapathy-browser"), "browser");
      await stub(appImage, "appimage");
      const start = (PATH) =>
        launchKamapathy(
          paths,
          { PATH, HOME: home, KAMAPATHY_USER_DATA: userData },
          { platform: "linux" },
        );
      // Each stub is a new program, which macOS checks before its first run.
      const started = async (name) => {
        await expect
          .poll(() => readFile(marker, "utf8").catch(() => ""), {
            timeout: 10000,
          })
          .toBe(`${name} ${userData}`);
        await rm(marker);
      };
      await start(bin);
      await started("browser");
      await start("");
      await started("appimage");
      const refusal = (promise) =>
        promise.then(
          () => "started",
          (error) => [error.reason, error.message],
        );
      const notInstalled = [
        "not_installed",
        "Could not start Kamapathy (ENOENT). Open Kamapathy, then retry.",
      ];
      // An AppImage another account could replace is never run.
      await chmod(appImage, 0o777);
      expect(await refusal(start(""))).toEqual(notInstalled);
      await new Promise((done) => setTimeout(done, 200));
      expect(existsSync(marker)).toBe(false);
      await rm(appImage);
      expect(await refusal(start(""))).toEqual(notInstalled);
    },
    30000,
  );

  it.skipIf(!posix)(
    "starts the checked program itself, not a link that could be swapped",
    async () => {
      const { paths, userData } = await profile();
      const program = join(userData, "kamapathy");
      await writeFile(program, "#!/bin/sh\n", { mode: 0o755 });
      const link = join(userData, "kamapathy-link");
      await symlink(program, link);
      await writeFile(
        paths.launch,
        JSON.stringify({ command: link, args: ["/app"] }),
        { mode: 0o600 },
      );
      const record = await launchRecord(paths);
      expect(record).toEqual({
        command: await realpathOf(program),
        args: ["/app"],
      });
    },
  );

  it("treats a server that never answers the health check as not running", async () => {
    const { paths, env: profileEnv } = await profile();
    await fakeKamapathy(paths, { handler: () => {} });
    await expect(
      resolveSocket(profileEnv, { healthTimeoutMs: 200 }),
    ).rejects.toThrow("not running");
  });

  it("reports a busy Kamapathy instead of starting another when it resets the connection", async () => {
    const { paths, userData } = await profile();
    await fakeKamapathy(paths, {
      handler: (request) => request.socket.destroy(),
    });
    const launch = vi.fn();
    await expect(
      resolveSocket({ KAMAPATHY_USER_DATA: userData }, { launch }),
    ).rejects.toThrow("busy");
    expect(launch).not.toHaveBeenCalled();
  });

  it("finds each platform's default Kamapathy profile", () => {
    const home = "/home/me";
    expect(agentPaths({ HOME: home }, "darwin").directory).toBe(
      join(home, "Library", "Application Support", "Kamapathy", "agent"),
    );
    expect(agentPaths({ HOME: home }, "linux").directory).toBe(
      join(home, ".config", "Kamapathy", "agent"),
    );
    expect(
      agentPaths({ HOME: home, XDG_CONFIG_HOME: "/xdg" }, "linux").directory,
    ).toBe(join("/xdg", "Kamapathy", "agent"));
    expect(
      agentPaths({ USERPROFILE: home, APPDATA: "/roaming" }, "win32").directory,
    ).toBe(join("/roaming", "Kamapathy", "agent"));
  });

  it("starts Kamapathy as an app even from editors that run Electron as Node", () => {
    // VS Code, Cursor and similar tools set this for their terminals. Passed on,
    // it makes Kamapathy's executable run as plain Node and exit immediately.
    const environment = launchEnvironment({
      ELECTRON_RUN_AS_NODE: "1",
      // Another AppImage or portable app's variables would make Kamapathy record
      // that app as its own launcher.
      APPIMAGE: "/home/me/Other.AppImage",
      APPDIR: "/tmp/.mount_Other",
      ARGV0: "Other",
      OWD: "/home/me",
      PORTABLE_EXECUTABLE_FILE: "C:\\Other.exe",
      PORTABLE_EXECUTABLE_DIR: "C:\\",
      PORTABLE_EXECUTABLE_APP_FILENAME: "Other",
      KAMAPATHY_USER_DATA: "/profile",
      PATH: "/bin",
    });
    expect(environment).toEqual({
      KAMAPATHY_USER_DATA: "/profile",
      PATH: "/bin",
    });
  });

  it("discovery failures name their reason: not_installed for a missing app or start command and quit_by_person under a fresh quit marker, neither retryable", async () => {
    const reasonOf = (promise) =>
      promise.then(
        () => "found",
        (error) => [error.code, error.reason, error.retryable === true],
      );
    const missing = await profile();
    for (const options of [
      { platform: "linux", env: { PATH: "", HOME: missing.userData } },
      {
        platform: "win32",
        env: { USERPROFILE: missing.userData, LOCALAPPDATA: missing.userData },
      },
    ])
      expect(
        await reasonOf(
          resolveSocket(
            { KAMAPATHY_USER_DATA: missing.userData },
            {
              launch: (paths) =>
                launchKamapathy(
                  paths,
                  { KAMAPATHY_USER_DATA: missing.userData, ...options.env },
                  { platform: options.platform },
                ),
            },
          ),
        ),
        options.platform,
      ).toEqual(["not_connected", "not_installed", false]);
    const quit = await profile();
    await writeFile(quit.paths.quit, JSON.stringify({ at: Date.now() }), {
      mode: 0o600,
    });
    const launch = vi.fn();
    expect(
      await reasonOf(
        resolveSocket({ KAMAPATHY_USER_DATA: quit.userData }, { launch }),
      ),
    ).toEqual(["not_connected", "quit_by_person", false]);
    expect(launch).not.toHaveBeenCalled();
    // An old quit no longer blocks starting Kamapathy.
    await writeFile(
      quit.paths.quit,
      JSON.stringify({ at: Date.now() - 600001 }),
      { mode: 0o600 },
    );
    expect(await reasonOf(resolveSocket(quit.env))).toEqual([
      "not_connected",
      "not_running",
      false,
    ]);
    expect(
      await reasonOf(
        resolveSocket(
          { KAMAPATHY_USER_DATA: quit.userData },
          { launch, intervalMs: 10, timeoutMs: 50 },
        ),
      ),
    ).toEqual(["not_connected", "start_timeout", false]);
    await writeFile(quit.paths.off, "", { mode: 0o600 });
    expect(await reasonOf(resolveSocket(quit.env))).toEqual([
      "not_connected",
      "access_off",
      false,
    ]);
    const busy = await profile();
    await fakeKamapathy(busy.paths, {
      handler: (request) => request.socket.destroy(),
    });
    expect(await reasonOf(resolveSocket(busy.env))).toEqual([
      "not_connected",
      "busy",
      true,
    ]);
    if (posix) {
      const untrusted = await profile();
      await fakeKamapathy(untrusted.paths);
      await chmod(untrusted.paths.endpoint, 0o644);
      expect(await reasonOf(resolveSocket(untrusted.env))).toEqual([
        "not_connected",
        "untrusted_files",
        false,
      ]);
      const denied = await profile();
      const { socket } = await fakeKamapathy(denied.paths);
      await chmod(socket, 0o000);
      expect(await reasonOf(resolveSocket(denied.env))).toEqual([
        "not_connected",
        "permission_denied",
        false,
      ]);
    }
  });

  it("after a lost connection the next call finds the restarted app without starting it", async () => {
    const { paths, userData } = await profile();
    const answer = (request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          request.url === "/health"
            ? { status: "ok", version: "test" }
            : { spaces: [] },
        ),
      );
    };
    const first = await fakeKamapathy(paths, { handler: answer });
    const launch = vi.fn();
    const client = await connect({
      env: { KAMAPATHY_USER_DATA: userData },
      connect: { launch },
    });
    expect(await client.spaces()).toEqual([]);
    // Kamapathy quits: the call in progress loses its connection.
    const server = servers.pop();
    await new Promise((done) => server.close(done));
    await rm(first.socket, { force: true });
    await expect(client.spaces()).rejects.toMatchObject({
      code: "not_connected",
      reason: "lost",
      entry: "kamapathy.spaces",
      message: expect.stringContaining("may still have taken effect"),
    });
    // It restarts on its own: the next call finds it, and nothing was started.
    const second = await fakeKamapathy(paths, { handler: answer });
    expect(await client.spaces()).toEqual([]);
    expect(second.instance).not.toBe(first.instance);
    expect(launch).not.toHaveBeenCalled();
  });

  it("checks arguments before looking for or starting Kamapathy", async () => {
    const { userData } = await profile();
    const launch = vi.fn();
    await expect(
      runCli(["click", "tab-1"], {
        env: { KAMAPATHY_USER_DATA: userData },
        connect: { launch },
        stdout: sink(),
      }),
    ).rejects.toThrow("Missing");
    expect(launch).not.toHaveBeenCalled();
  });
});

describe("standalone skill client", () => {
  it("shows help without connecting or reading credentials", async () => {
    const fetch = vi.fn();
    const stdout = sink();
    expect(await runCli(["help"], { env: {}, fetch, stdout })).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(stdout.text()).toContain("batch");
  });
  it("runs through a linked skill folder", async () => {
    // Agents' skills folders hold a link to the skill, a junction on Windows.
    const directory = await mkdtemp(join(tmpdir(), "kamapathy-cli-link-"));
    directories.push(directory);
    const link = join(directory, "kamapathy");
    await symlink(
      join(process.cwd(), "skills", "kamapathy"),
      link,
      posix ? "dir" : "junction",
    );
    const child = spawn(
      process.execPath,
      [join(link, "scripts", "kamapathy.mjs"), "help"],
      {
        env: { ...process.env, ...env },
      },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const status = await new Promise((done) => child.once("close", done));
    expect([status, stdout.split("\n")[0]]).toEqual([
      0,
      "Kamapathy browser client",
    ]);
  });
  it("preserves exact stdin values and sends one request", async () => {
    const value = 'Quoted "value" with a newline\n';
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    expect(
      await runCli(["fill", "tab-1", "@e2", "--stdin"], {
        env,
        fetch,
        stdin: Readable.from([value]),
        stdout: sink(),
      }),
    ).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url.pathname).toBe("/tabs/tab-1/fill");
    expect(JSON.parse(options.body)).toEqual({ ref: "@e2", value });
    expect(options.headers.Authorization).toBeUndefined();
  });
  it("returns partial batch progress with a failing exit code and never retries", async () => {
    const result = {
      ok: false,
      failedIndex: 1,
      results: [{ index: 0, type: "fill", result: { ok: true } }],
      error: { code: "stale_ref", message: "Observe again." },
    };
    const fetch = vi.fn(async () => Response.json(result, { status: 422 }));
    const stdout = sink();
    expect(
      await runCli(["batch", "tab-1", "--json"], {
        env,
        fetch,
        stdin: Readable.from([
          JSON.stringify([
            { type: "fill", ref: "@e1", value: "A" },
            { type: "click", ref: "@e2" },
          ]),
        ]),
        stdout,
      }),
    ).toBe(1);
    expect(JSON.parse(stdout.text())).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reports ambiguous timeouts without retrying a possible submission", async () => {
    const fetch = vi.fn(async () => {
      throw new DOMException("Timed out", "TimeoutError");
    });
    const stderr = sink();
    expect(await main(["click", "tab-1", "@e1"], { env, fetch, stderr })).toBe(
      1,
    );
    expect(stderr.text()).toContain("Inspect the page before retrying");
    expect(stderr.text()).not.toContain(env.KAMAPATHY_TOKEN);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("takes control of a space back with resume and says so plainly", async () => {
    const help = sink();
    await runCli(["help"], { env, fetch: vi.fn(), stdout: help });
    expect(help.text()).toMatch(/ handoff <space-id> .*\n  resume <space-id> /);
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, owner: "agent" }),
    );
    const stdout = sink();
    expect(await runCli(["resume", "space-1"], { env, fetch, stdout })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url.pathname).toBe("/spaces/space-1/resume");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(options.body)).toEqual({});
    expect(stdout.text()).toBe("ok: agent control resumed\n");
    const json = sink();
    expect(
      await runCli(["resume", "space-1", "--json"], {
        env,
        fetch,
        stdout: json,
      }),
    ).toBe(0);
    expect(JSON.parse(json.text())).toEqual({ ok: true, owner: "agent" });
  });
  it("prints control state, field values, group questions and omitted controls on one line each", async () => {
    const snapshot = {
      tabId: "tab-1",
      url: "https://example.test/listing",
      title: "Store listing",
      text: "Main store listing",
      interactables: [
        {
          ref: "@e1",
          role: "radio",
          label: "Yes",
          checked: false,
          group: "Does your app\ntarget children?",
        },
        {
          ref: "@e2",
          role: "radio",
          label: "No",
          checked: true,
          group: "Does your app target children?",
        },
        {
          ref: "@e3",
          role: "checkbox",
          label: "Select all",
          disabled: true,
          checked: "mixed",
        },
        {
          ref: "@e4",
          role: "option",
          label: "France",
          checked: true,
          selected: true,
        },
        { ref: "@e5", role: "tab", label: "Custom listings", selected: false },
        {
          ref: "@e6",
          role: "button",
          label: "Data safety",
          expanded: false,
          pressed: "mixed",
        },
        {
          ref: "@e7",
          role: "button",
          label: "Notify",
          expanded: true,
          pressed: false,
        },
        {
          ref: "@e8",
          role: "input",
          label: "Short description",
          value: 'Count "taps"\nquickly\u001b[31m',
          valueTruncated: true,
        },
        { ref: "@e9", role: "input", label: "Password", valueHidden: true },
        {
          ref: "@e10",
          role: "select",
          label: "Category",
          value: "tools",
          options: [
            { value: "tools", label: "Tools", disabled: false, selected: true },
            { value: "games", label: "Games", disabled: true },
          ],
        },
      ],
      omittedControls: 12,
      truncated: true,
    };
    const stdout = sink();
    const fetch = vi.fn(async () => Response.json(snapshot));
    expect(await runCli(["snapshot", "tab-1"], { env, fetch, stdout })).toBe(0);
    expect(stdout.text()).toBe(
      [
        "Store listing",
        "https://example.test/listing",
        "",
        "Main store listing",
        "",
        "Controls:",
        '@e1 radio "Yes" [unchecked] group "Does your app target children?"',
        '@e2 radio "No" [checked] group "Does your app target children?"',
        '@e3 checkbox "Select all" [disabled] [mixed]',
        '@e4 option "France" [checked] [selected]',
        '@e5 tab "Custom listings"',
        '@e6 button "Data safety" [collapsed] [partly pressed]',
        '@e7 button "Notify" [expanded] [not pressed]',
        '@e8 input "Short description" value="Count \\"taps\\"\\nquickly[31m" (truncated)',
        '@e9 input "Password" (value hidden)',
        '@e10 select "Category" value="tools"',
        '  "tools": "Tools" [selected]',
        '  "games": "Games" [disabled]',
        "12 more controls not listed. Scope with --selector to list them.",
        "",
        "Truncated. Scope with --selector or request --full if needed.",
        "",
      ].join("\n"),
    );
    const controlsOnly = sink();
    await runCli(["snapshot", "tab-1", "--max-controls", "0"], {
      env,
      fetch: vi.fn(async () =>
        Response.json({
          ...snapshot,
          text: "",
          interactables: [],
          omittedControls: 3,
          truncated: true,
        }),
      ),
      stdout: controlsOnly,
    });
    expect(controlsOnly.text()).toContain(
      "https://example.test/listing\n\n3 more controls not listed.",
    );
    const json = sink();
    await runCli(["snapshot", "tab-1", "--json"], { env, fetch, stdout: json });
    expect(JSON.parse(json.text())).toEqual(snapshot);
  });
  it("sends drags and targeted scrolls, and checks their arguments before connecting", async () => {
    const help = sink();
    await runCli(["help"], { env, fetch: vi.fn(), stdout: help });
    expect(help.text()).toContain("drag <tab-id> <source> <target>");
    expect(help.text()).toContain(
      "scroll <tab-id> <direction> [pixels] [ref-or-selector]",
    );
    for (const [args, path, body] of [
      [
        ["drag", "tab-1", "@e1", "#zone"],
        "/tabs/tab-1/drag",
        { source: { ref: "@e1" }, target: { selector: "#zone" } },
      ],
      [
        ["scroll", "tab-1", "down"],
        "/tabs/tab-1/scroll",
        { direction: "down" },
      ],
      [
        ["scroll", "tab-1", "down", "300"],
        "/tabs/tab-1/scroll",
        { direction: "down", pixels: 300 },
      ],
      [
        ["scroll", "tab-1", "down", "300", "@e4"],
        "/tabs/tab-1/scroll",
        { direction: "down", pixels: 300, ref: "@e4" },
      ],
      [
        ["scroll", "tab-1", "right", "#table"],
        "/tabs/tab-1/scroll",
        { direction: "right", selector: "#table" },
      ],
      [
        ["scroll", "tab-1", "down", ".panel"],
        "/tabs/tab-1/scroll",
        { direction: "down", selector: ".panel" },
      ],
      [
        ["scroll", "tab-1", "down", "600", ".panel"],
        "/tabs/tab-1/scroll",
        { direction: "down", pixels: 600, selector: ".panel" },
      ],
    ]) {
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      expect(await runCli(args, { env, fetch, stdout: sink() })).toBe(0);
      const [url, options] = fetch.mock.calls[0];
      expect(url.pathname).toBe(path);
      expect(options.method).toBe("POST");
      expect(JSON.parse(options.body)).toEqual(body);
    }
    const fetch = vi.fn();
    for (const args of [
      ["drag", "tab-1", "@e1"],
      ["drag", "tab-1", "@e1", "@e2", "@e3"],
      ["scroll", "tab-1", "down", "#panel", "#other"],
      ["scroll", "tab-1", "down", "300", "@e4", "@e5"],
      ["scroll", "tab-1", "down", "0"],
      ["scroll", "tab-1", "down", "-5"],
      ["scroll", "tab-1", "down", "1.5", "@e4"],
    ])
      await expect(
        runCli(args, { env, fetch, stdout: sink() }),
      ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("says how an action was done, what scrolled and which refs moved to redrawn controls", async () => {
    for (const [result, text] of [
      [
        { ok: true, url: "https://example.test/", drag: "html5" },
        "ok: dragged with HTML drag and drop",
      ],
      [
        {
          ok: true,
          url: "https://example.test/",
          drag: "mouse",
          rebound: ["@e3", "@e4"],
        },
        "ok: dragged with the mouse; @e3, @e4 now point to the redrawn controls",
      ],
      [
        {
          ok: true,
          url: "https://example.test/",
          fallback: "dom_click",
          rebound: ["@e2"],
        },
        "ok: clicked in the page because the control has no size; @e2 now points to the redrawn control",
      ],
      [
        {
          ok: true,
          scrolled: "element",
          selector: "#content\n\u001b[31m",
          x: 0,
          y: 723.5,
          moved: true,
        },
        "ok: scrolled panel #content [31m to 0,723.5",
      ],
      [
        { ok: true, scrolled: "page", x: 0, y: 0, moved: false },
        "ok: page did not move",
      ],
      [{ ok: true, url: "https://example.test/" }, "ok"],
    ]) {
      const stdout = sink();
      await runCli(["click", "tab-1", "@e1"], {
        env,
        fetch: vi.fn(async () => Response.json(result)),
        stdout,
      });
      expect(stdout.text()).toBe(`${text}\n`);
    }
    const stdout = sink();
    await runCli(["batch", "tab-1"], {
      env,
      fetch: vi.fn(async () =>
        Response.json({
          ok: true,
          results: [
            { index: 0, type: "drag", result: { ok: true, drag: "html5" } },
            {
              index: 1,
              type: "scroll",
              result: { ok: true, scrolled: "page", x: 0, y: 600, moved: true },
            },
            { index: 2, type: "fill", result: { ok: true, rebound: ["@e7"] } },
          ],
        }),
      ),
      stdin: Readable.from([JSON.stringify([{ type: "snapshot" }])]),
      stdout,
    });
    expect(stdout.text()).toBe(
      [
        "1. drag ok: dragged with HTML drag and drop",
        "2. scroll ok: scrolled page to 0,600",
        "3. fill ok: @e7 now points to the redrawn control",
        "",
      ].join("\n"),
    );
  });
  it("checks the resume space ID before connecting", async () => {
    const fetch = vi.fn();
    await expect(
      runCli(["resume"], { env, fetch, stdout: sink() }),
    ).rejects.toThrow("Missing ID");
    for (const id of ["../space", "space/1", "x".repeat(129)])
      await expect(
        runCli(["resume", id], { env, fetch, stdout: sink() }),
      ).rejects.toThrow("Invalid space or tab ID");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("never overwrites an existing screenshot", async () => {
    const path = `${await scratchFile()}.png`;
    await writeFile(path, "original");
    const fetch = vi.fn(
      async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        }),
    );
    await expect(
      runCli(["screenshot", "tab-1", path], { env, fetch, stdout: sink() }),
    ).rejects.toThrow("EEXIST");
  });

  it("uploads exact selected bytes with basenames and MIME types, without disclosing local paths", async () => {
    const prefix = await scratchFile();
    const paths = [`${prefix}.aab`, `${prefix}.PNG`];
    const bytes = [
      Buffer.from([0, 255, 128, 65, 10]),
      Buffer.from([137, 80, 78, 71]),
    ];
    await Promise.all(
      paths.map((path, index) => writeFile(path, bytes[index])),
    );
    const fetch = vi.fn(async () => Response.json({ ok: true, selected: 2 }));
    const stdout = sink();
    expect(
      await runCli(["upload", "tab-1", "@e3", ...paths], {
        env,
        fetch,
        stdout,
      }),
    ).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url.pathname).toBe("/tabs/tab-1/upload");
    const payload = JSON.parse(options.body);
    expect(payload.ref).toBe("@e3");
    expect(payload.files).toEqual([
      {
        name: "fixture.json.aab",
        type: "application/octet-stream",
        data: bytes[0].toString("base64"),
      },
      {
        name: "fixture.json.PNG",
        type: "image/png",
        data: bytes[1].toString("base64"),
      },
    ]);
    for (const [index, path] of paths.entries()) {
      expect(options.body).not.toContain(path);
      expect(stdout.text()).not.toContain(path);
      expect(await readFile(path)).toEqual(bytes[index]);
    }
  });

  it("rejects upload selectors, directories, excess file counts, and aggregate size before connecting", async () => {
    const file = await scratchFile();
    const directory = await mkdtemp(
      join(tmpdir(), "kamapathy-upload-directory-"),
    );
    directories.push(directory);
    const fetch = vi.fn();
    for (const args of [
      ["upload", "tab-1", "#upload", file],
      ["upload", "tab-1", "@e0", file],
      ["upload", "tab-1", "@e1"],
      ["upload", "tab-1", "@e1", ...Array(9).fill(file)],
      ["upload", "tab-1", "@e1", directory],
    ])
      await expect(
        runCli(args, { env, fetch, stdout: sink() }),
      ).rejects.toThrow();
    const large = `${file}.aab`;
    const handle = await open(large, "w");
    await handle.truncate(16 * 1024 * 1024 + 1);
    await handle.close();
    await expect(
      runCli(["upload", "tab-1", "@e1", large], { env, fetch, stdout: sink() }),
    ).rejects.toThrow("16 MiB");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "refuses symbolic links for selected upload files",
    async () => {
      const file = await scratchFile();
      const link = `${file}.png`;
      await symlink(file, link);
      const fetch = vi.fn();
      await expect(
        runCli(["upload", "tab-1", "@e1", link], {
          env,
          fetch,
          stdout: sink(),
        }),
      ).rejects.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not disclose selected local paths when a file cannot be read", async () => {
    const missing = `${await scratchFile()}.missing-private-bundle.aab`;
    const stderr = sink();
    const fetch = vi.fn();
    expect(
      await main(["upload", "tab-1", "@e1", missing], { env, fetch, stderr }),
    ).toBe(1);
    expect(stderr.text()).not.toContain(missing);
    expect(stderr.text()).not.toContain("missing-private-bundle");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("scripted sessions", () => {
  const space = {
    id: "space-1",
    name: "Research",
    kind: "agent",
    owner: "agent",
    signIns: "shared",
  };
  const tab = {
    id: "tab-1",
    spaceId: "space-1",
    title: "Reserve",
    url: "https://example.test/reserve",
  };
  const snapshot = {
    tabId: "tab-1",
    url: "https://example.test/reserve",
    title: "Reserve",
    text: "Book a table",
    interactables: [
      { ref: "@e1", role: "input", label: "Name", value: "" },
      { ref: "@e2", role: "button", label: "Check availability" },
    ],
    omittedControls: 0,
    truncated: false,
  };
  // A stand-in API answering by route, recording every request it receives.
  function fakeApi(routes) {
    const requests = [];
    const fetch = vi.fn(async (url, options = {}) => {
      const method = options.method || "GET";
      const body =
        options.body === undefined ? undefined : JSON.parse(options.body);
      requests.push({ method, path: url.pathname, body });
      const answer = routes[`${method} ${url.pathname}`];
      if (!answer)
        return Response.json(
          { error: { code: "not_found", message: `No route ${url.pathname}` } },
          { status: 404 },
        );
      return typeof answer === "function"
        ? answer(body, options)
        : Response.json(answer);
    });
    return { fetch, requests };
  }
  const routes = {
    "POST /spaces": { space },
    "GET /spaces": { spaces: [space] },
    "DELETE /spaces/space-1": { ok: true },
    "POST /spaces/space-1/tabs": { tab },
    "GET /spaces/space-1/tabs": { tabs: [tab] },
    "POST /spaces/space-1/handoff": { ok: true, owner: "human" },
    "POST /spaces/space-1/resume": { ok: true, owner: "agent" },
    "POST /tabs/tab-1/navigate": {
      tab: { ...tab, url: "https://example.test/slots", title: "Slots" },
    },
    "POST /tabs/tab-1/snapshot": snapshot,
    "POST /tabs/tab-1/click": { ok: true, url: tab.url, rebound: ["@e2"] },
    "POST /tabs/tab-1/fill": { ok: true },
    "POST /tabs/tab-1/press": { ok: true },
    "POST /tabs/tab-1/scroll": {
      ok: true,
      scrolled: "page",
      x: 0,
      y: 300,
      moved: true,
    },
    "POST /tabs/tab-1/drag": { ok: true, url: tab.url, drag: "mouse" },
    "POST /tabs/tab-1/wait": { ok: true },
    "POST /tabs/tab-1/actions": {
      ok: true,
      results: [{ index: 0, type: "click", result: { ok: true } }],
    },
    "POST /tabs/tab-1/upload": { ok: true, selected: 1 },
    "GET /tabs/tab-1/screenshot": () =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "Content-Type": "image/png" },
      }),
    "DELETE /tabs/tab-1": { ok: true },
  };
  async function scriptFile(name, source) {
    const directory = await mkdtemp(join(tmpdir(), "kamapathy-run-test-"));
    directories.push(directory);
    const path = join(directory, name);
    await writeFile(path, source, { mode: 0o600 });
    return path;
  }
  afterEach(() => {
    delete globalThis.__scripted;
  });

  it("drives spaces and pages through the documented routes only, one request per call", async () => {
    const api = fakeApi(routes);
    const client = await connect({ env, fetch: api.fetch });
    const research = await client.createSpace("Research");
    expect(research).toMatchObject({
      id: "space-1",
      name: "Research",
      owner: "agent",
      signIns: "shared",
    });
    const page = await research.open("https://example.test/reserve");
    expect(page).toMatchObject({
      id: "tab-1",
      spaceId: "space-1",
      url: tab.url,
      title: "Reserve",
    });
    expect(await page.snapshot()).toEqual(snapshot);
    expect(
      await page.snapshot({
        mode: "full",
        selector: "#slots",
        maxChars: 500,
        maxControls: 5,
      }),
    ).toEqual(snapshot);
    expect(await page.text()).toBe(formatSnapshot(snapshot));
    expect(await page.click("@e2")).toEqual({
      ok: true,
      url: tab.url,
      rebound: ["@e2"],
    });
    await page.click("#submit");
    await page.fill("@e1", "Avery Quinn");
    await page.press("Enter", "@e1");
    await page.press("Escape");
    await page.scroll("down", 300, "@e1");
    await page.scroll("down", ".panel");
    await page.scroll("up");
    await page.drag("@e1", "#zone");
    await page.wait({ selector: "#slots", text: "Free", timeoutMs: 1000 });
    const batch = await page.batch([{ type: "click", ref: "@e2" }]);
    expect(batch.results).toHaveLength(1);
    expect(await page.navigate("https://example.test/slots")).toBe(page);
    expect([page.url, page.title]).toEqual([
      "https://example.test/slots",
      "Slots",
    ]);
    expect((await research.tabs()).map((item) => item.id)).toEqual(["tab-1"]);
    await page.close();
    expect(await research.handoff()).toEqual({ ok: true, owner: "human" });
    expect(research.owner).toBe("human");
    await research.resume();
    expect(research.owner).toBe("agent");
    await research.close();
    expect((await client.spaces()).map((item) => item.name)).toEqual([
      "Research",
    ]);
    expect((await client.space("space-1")).id).toBe("space-1");
    expect(api.requests).toEqual([
      { method: "POST", path: "/spaces", body: { name: "Research" } },
      {
        method: "POST",
        path: "/spaces/space-1/tabs",
        body: { url: "https://example.test/reserve" },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/snapshot",
        body: { mode: "compact" },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/snapshot",
        body: {
          mode: "full",
          selector: "#slots",
          maxChars: 500,
          maxControls: 5,
        },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/snapshot",
        body: { mode: "compact" },
      },
      { method: "POST", path: "/tabs/tab-1/click", body: { ref: "@e2" } },
      {
        method: "POST",
        path: "/tabs/tab-1/click",
        body: { selector: "#submit" },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/fill",
        body: { ref: "@e1", value: "Avery Quinn" },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/press",
        body: { key: "Enter", ref: "@e1" },
      },
      { method: "POST", path: "/tabs/tab-1/press", body: { key: "Escape" } },
      {
        method: "POST",
        path: "/tabs/tab-1/scroll",
        body: { direction: "down", pixels: 300, ref: "@e1" },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/scroll",
        body: { direction: "down", selector: ".panel" },
      },
      { method: "POST", path: "/tabs/tab-1/scroll", body: { direction: "up" } },
      {
        method: "POST",
        path: "/tabs/tab-1/drag",
        body: { source: { ref: "@e1" }, target: { selector: "#zone" } },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/wait",
        body: { selector: "#slots", text: "Free", timeoutMs: 1000 },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/actions",
        body: { actions: [{ type: "click", ref: "@e2" }] },
      },
      // navigate waits for the new document to commit, so it sends waitUntil.
      {
        method: "POST",
        path: "/tabs/tab-1/navigate",
        body: { url: "https://example.test/slots", waitUntil: "commit" },
      },
      { method: "GET", path: "/spaces/space-1/tabs", body: undefined },
      { method: "DELETE", path: "/tabs/tab-1", body: undefined },
      { method: "POST", path: "/spaces/space-1/handoff", body: {} },
      { method: "POST", path: "/spaces/space-1/resume", body: {} },
      { method: "DELETE", path: "/spaces/space-1", body: undefined },
      { method: "GET", path: "/spaces", body: undefined },
      { method: "GET", path: "/spaces", body: undefined },
    ]);
    for (const [, options] of api.fetch.mock.calls) {
      expect(options.headers.Authorization).toBeUndefined();
      if (options.body !== undefined)
        expect(options.headers["Content-Type"]).toBe("application/json");
    }
  });

  it("refuses unknown options before sending: only /health is requested", async () => {
    const { paths, env: profileEnv } = await profile();
    const requests = [];
    await fakeKamapathy(paths, {
      handler: (request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "ok", version: "test" }));
      },
    });
    const client = await connect({ env: profileEnv });
    await expect(
      client.createSpace("Research", { isolatd: true }),
    ).rejects.toMatchObject({
      code: "invalid_option",
      entry: "kamapathy.createSpace",
      option: "isolatd",
      suggestion: "isolated",
    });
    await expect(client.space(7)).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "kamapathy.space",
    });
    expect(requests).toEqual(["GET /health"]);
  });

  it("queues the stale skill notice once through session.notice: it prints as notice: on stderr only", async () => {
    const { paths, env: profileEnv } = await profile();
    await fakeKamapathy(paths, {
      handler: (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            status: "ok",
            version: "0.9.0",
            apiLevel: schema.API_LEVEL + 1,
            skill: { path: "/opt/kamapathy/skill" },
          }),
        );
      },
    });
    const stdout = sink();
    const stderr = sink();
    expect(
      await main(["health", "--json"], { env: profileEnv, stdout, stderr }),
    ).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({
      status: "ok",
      version: "0.9.0",
    });
    expect(stderr.text()).toBe(
      `notice: This skill copy (${schema.CLIENT_VERSION}) is older than Kamapathy 0.9.0. Read /opt/kamapathy/skill/SKILL.md for the current API.\n`,
    );
    const again = sink();
    expect(
      await main(["health"], {
        env: profileEnv,
        stdout: sink(),
        stderr: again,
      }),
    ).toBe(0);
    expect(again.text()).toBe("");
  });

  it("copies retryable and dispatched as own fields, adds entry, and prints retry guidance", async () => {
    const api = fakeApi({
      ...routes,
      "POST /tabs/tab-1/click": () =>
        Response.json(
          {
            error: {
              code: "action_timeout",
              message: "The control never became actionable.",
              awaited: "actionable",
              timeoutMs: 5000,
              retryable: true,
            },
          },
          { status: 504 },
        ),
      "POST /tabs/tab-1/fill": () =>
        Response.json(
          {
            error: {
              code: "element_obscured",
              message: "Covered.",
              dispatched: true,
            },
          },
          { status: 409 },
        ),
    });
    const client = await connect({ env, fetch: api.fetch });
    const page = await (
      await client.space("space-1")
    ).open("https://example.test/reserve");
    const timedOut = await page.click("@e2").catch((error) => error);
    expect(timedOut).toBeInstanceOf(KamapathyError);
    expect(timedOut).toMatchObject({
      code: "action_timeout",
      status: 504,
      awaited: "actionable",
      timeoutMs: 5000,
      retryable: true,
      entry: "page.click",
    });
    expect(Object.hasOwn(timedOut, "retryable")).toBe(true);
    const reached = await page.fill("@e1", "A").catch((error) => error);
    expect(reached).toMatchObject({
      code: "element_obscured",
      dispatched: true,
      entry: "page.fill",
    });
    expect(reached).not.toHaveProperty("retryable");
    // Single commands add the same line after their status line.
    const retried = sink();
    expect(
      await main(["click", "tab-1", "@e2"], {
        env,
        fetch: api.fetch,
        stdout: sink(),
        stderr: retried,
      }),
    ).toBe(1);
    expect(retried.text()).toBe(
      "Kamapathy: 504 action_timeout: The control never became actionable.\nKamapathy: Nothing reached the page, so the same command can be retried.\n",
    );
    const inspected = sink();
    expect(
      await main(["fill", "tab-1", "@e1", "--stdin"], {
        env,
        fetch: api.fetch,
        stdin: Readable.from(["A"]),
        stdout: sink(),
        stderr: inspected,
      }),
    ).toBe(1);
    expect(inspected.text()).toBe(
      "Kamapathy: 409 element_obscured: Covered.\nKamapathy: The action reached the page before it failed. Inspect the page before retrying.\n",
    );
  });

  it("an injected fetch sends no health request, and space(id) lists spaces for an app without apiLevel", async () => {
    const api = fakeApi(routes);
    const client = await connect({ env, fetch: api.fetch });
    expect(client.app).toEqual({ apiLevel: 1 });
    expect((await client.space("space-1")).id).toBe("space-1");
    expect(api.requests).toEqual([
      { method: "GET", path: "/spaces", body: undefined },
    ]);
    const current = await connect({
      env,
      fetch: api.fetch,
      health: {
        status: "ok",
        version: "0.2.0",
        apiLevel: 2,
        versions: { electron: "44.2.0" },
      },
    });
    expect(current.app).toEqual({
      version: "0.2.0",
      apiLevel: 2,
      electron: "44.2.0",
    });
  });

  // Section 2's shapes: labeled tabs, the closed list and a boundary.
  const level2 = { status: "ok", version: "0.2.0", apiLevel: 2 };
  const labeled = [
    { ...tab, label: "p1", openedBy: "agent", managed: true, active: true },
    {
      id: "tab-2",
      spaceId: "space-1",
      title: "Slots",
      url: "https://example.test/slots",
      label: "p2",
      openedBy: "page",
      openerId: "tab-1",
      managed: false,
      active: false,
      unseen: true,
    },
  ];
  const listing = {
    tabs: labeled,
    closed: [{ label: "p4", closedBy: "page", at: 1 }],
    budget: { used: 1, limit: 20 },
  };
  const boundary = {
    ok: true,
    owner: "agent",
    active: labeled[0],
    opened: [labeled[1]],
    closed: ["p3"],
  };
  const sectionTwo = {
    ...routes,
    "GET /spaces/space-1": { space },
    "GET /spaces/space-1/tabs": listing,
    "POST /spaces/space-1/resume": boundary,
    "POST /spaces/space-1/wait-for-control": boundary,
    "POST /tabs/tab-1/adopt": { tab: labeled[0] },
    "POST /tabs/tab-2/adopt": { tab: { ...labeled[1], managed: true } },
    "POST /tabs/tab-2/release": { tab: labeled[1] },
    "POST /tabs/tab-404/adopt": () =>
      Response.json(
        {
          error: {
            code: "tab_not_found",
            message: "Agent tab was not found.",
            tabId: "tab-404",
          },
        },
        { status: 404 },
      ),
    "POST /spaces/space-1/finish": {
      ok: true,
      spaceId: "space-1",
      closedSpace: false,
      closed: ["p1", "p3"],
      kept: ["p2"],
      protected: ["p5"],
    },
    "POST /space-requests": {
      space: {
        id: "work",
        name: "Work",
        kind: "personal",
        owner: "agent",
        signIns: "shared",
      },
      tabs: [
        {
          id: "tab-w",
          spaceId: "work",
          title: "Mail",
          url: "https://mail.test/",
          label: "p1",
          openedBy: "person",
          managed: false,
          active: true,
        },
      ],
      active: {
        id: "tab-w",
        spaceId: "work",
        title: "Mail",
        url: "https://mail.test/",
        label: "p1",
        openedBy: "person",
        managed: false,
        active: true,
      },
    },
  };
  const paths = (api) =>
    api.requests.map((item) => `${item.method} ${item.path}`);

  it("<space-id>:<label> resolves with one tabs request", async () => {
    const api = fakeApi(sectionTwo);
    expect(
      await runCli(["click", "space-1:p1", "@e2"], {
        env,
        fetch: api.fetch,
        stdout: sink(),
      }),
    ).toBe(0);
    expect(paths(api)).toEqual([
      "GET /spaces/space-1/tabs",
      "POST /tabs/tab-1/click",
    ]);
    await expect(
      runCli(["click", "space-1:p4", "@e2"], {
        env,
        fetch: api.fetch,
        stdout: sink(),
      }),
    ).rejects.toMatchObject({
      code: "page_not_found",
      label: "p4",
      closedBy: "page",
    });
    expect(paths(api).slice(2)).toEqual(["GET /spaces/space-1/tabs"]);
    await expect(
      runCli(["click", "space-1:x1", "@e2"], {
        env,
        fetch: api.fetch,
        stdout: sink(),
      }),
    ).rejects.toThrow("Invalid space or tab ID.");
  });

  it("finish() without keep throws invalid_argument before any request, and space finish requires --keep", async () => {
    const api = fakeApi(sectionTwo);
    const client = await connect({ env, fetch: api.fetch, health: level2 });
    const research = await client.space("space-1");
    expect(paths(api)).toEqual(["GET /spaces/space-1"]);
    for (const options of [undefined, {}, { keep: "some" }, { keep: 3 }])
      await expect(
        research.finish(options),
        JSON.stringify(options),
      ).rejects.toMatchObject({
        code: "invalid_argument",
        entry: "space.finish",
        expected: '{ keep: "all" | page[] }',
      });
    await expect(
      runCli(["space", "finish", "space-1"], {
        env,
        fetch: api.fetch,
        health: level2,
        stdout: sink(),
      }),
    ).rejects.toThrow(
      "Use space finish <space-id> --keep all|none|<tab-id>[,<tab-id>].",
    );
    expect(paths(api)).toEqual(["GET /spaces/space-1"]);
    // Pages, labels and ids all become ids, with one tabs request for the labels.
    const page = research.page("p1");
    expect(await research.finish({ keep: [page, "p2", "tab-3"] })).toEqual(
      sectionTwo["POST /spaces/space-1/finish"],
    );
    expect(api.requests.slice(1)).toEqual([
      { method: "GET", path: "/spaces/space-1/tabs", body: undefined },
      {
        method: "POST",
        path: "/spaces/space-1/finish",
        body: { keep: ["tab-1", "tab-2", "tab-3"] },
      },
    ]);
    expect(await research.finish({ keep: "all" })).toMatchObject({ ok: true });
    expect(api.requests.at(-1).body).toEqual({ keep: "all" });
    const stdout = sink();
    expect(
      await runCli(["space", "finish", "space-1", "--keep", "none"], {
        env,
        fetch: api.fetch,
        health: level2,
        stdout,
      }),
    ).toBe(0);
    expect(api.requests.at(-1).body).toEqual({ keep: [] });
    expect(stdout.text()).toBe(
      "ok: space space-1 finished\nclosed p1 p3\nkept p2\nprotected p5\n",
    );
    await runCli(["space", "finish", "space-1", "--keep", "p2,tab-3"], {
      env,
      fetch: api.fetch,
      health: level2,
      stdout: sink(),
    });
    expect(api.requests.slice(-2)).toEqual([
      { method: "GET", path: "/spaces/space-1/tabs", body: undefined },
      {
        method: "POST",
        path: "/spaces/space-1/finish",
        body: { keep: ["tab-2", "tab-3"] },
      },
    ]);
  });

  it("page(label) resolves lazily and reports closed labels", async () => {
    const api = fakeApi(sectionTwo);
    const client = await connect({ env, fetch: api.fetch, health: level2 });
    const research = await client.space("space-1");
    const page = research.page("p1");
    expect(page).toMatchObject({ label: "p1", spaceId: "space-1" });
    expect(page.id).toBeUndefined();
    expect(paths(api)).toEqual(["GET /spaces/space-1"]);
    await page.click("@e2");
    await page.click("@e2");
    expect(page).toMatchObject({
      id: "tab-1",
      openedBy: "agent",
      managed: true,
    });
    expect(paths(api).slice(1)).toEqual([
      "GET /spaces/space-1/tabs",
      "POST /tabs/tab-1/click",
      "POST /tabs/tab-1/click",
    ]);
    await expect(research.page("p4").click("@e1")).rejects.toMatchObject({
      code: "page_not_found",
      label: "p4",
      closedBy: "page",
      message:
        "Page p4 was closed by the page. Open another with space.newPage().",
      entry: "page.click",
    });
    expect(() => research.page("tab-1")).toThrow(KamapathyError);
    // A popup's opener is the open page that opened it.
    const [, popup] = await research.tabs();
    expect(popup).toMatchObject({
      label: "p2",
      openedBy: "page",
      openerId: "tab-1",
      managed: false,
    });
    expect(await popup.opener()).toMatchObject({ id: "tab-1", label: "p1" });
    expect(await (await research.tabs())[0].opener()).toBeNull();
  });

  it("long waits use their timeout plus 5000 ms", async () => {
    const api = fakeApi(sectionTwo);
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    try {
      const client = await connect({ env, fetch: api.fetch, health: level2 });
      const research = await client.space("space-1");
      await research.waitForControl({ timeout: 1000 });
      expect(api.requests.at(-1).body).toEqual({ timeoutMs: 1000 });
      expect(timeouts).toHaveBeenLastCalledWith(6000);
      await research.waitForControl();
      expect(api.requests.at(-1).body).toEqual({});
      expect(timeouts).toHaveBeenLastCalledWith(605000);
      await client.requestSpace({ reason: "Book a table", timeout: 10000 });
      expect(timeouts).toHaveBeenLastCalledWith(15000);
      await runCli(["wait-for-control", "space-1", "--timeout", "2000"], {
        env,
        fetch: api.fetch,
        health: level2,
        stdout: sink(),
      });
      expect(timeouts).toHaveBeenLastCalledWith(7000);
      await research.tabs();
      expect(timeouts).toHaveBeenLastCalledWith(45000);
    } finally {
      timeouts.mockRestore();
    }
  });

  it("a label parameter resolves on each call; an unknown label throws page_not_found, with closedBy for a retired one, and an unknown tab id keeps tab_not_found", async () => {
    const api = fakeApi(sectionTwo);
    const client = await connect({ env, fetch: api.fetch, health: level2 });
    const research = await client.space("space-1");
    const adopted = await research.adopt("p2");
    expect(adopted).toMatchObject({ id: "tab-2", label: "p2", managed: true });
    await research.release("p2");
    expect(paths(api).slice(1)).toEqual([
      "GET /spaces/space-1/tabs",
      "POST /tabs/tab-2/adopt",
      "GET /spaces/space-1/tabs",
      "POST /tabs/tab-2/release",
    ]);
    await expect(research.adopt("p9")).rejects.toMatchObject({
      code: "page_not_found",
      label: "p9",
      message: "No page in this space is labeled p9. space.pages() lists them.",
    });
    await expect(research.adopt("p4")).rejects.toMatchObject({
      code: "page_not_found",
      closedBy: "page",
    });
    await expect(research.adopt("tab-404")).rejects.toMatchObject({
      code: "tab_not_found",
      tabId: "tab-404",
    });
    // A page handle sends its own id.
    const page = (await research.pages())[0];
    await research.adopt(page);
    expect(api.requests.at(-1).path).toBe("/tabs/tab-1/adopt");
  });

  it("openSpace reuses or creates, createSpace sends KAMAPATHY_PAGE_BUDGET, and requestSpace returns the granted space with its user page", async () => {
    const api = fakeApi(sectionTwo);
    const budgeted = { ...env, KAMAPATHY_PAGE_BUDGET: "5" };
    const client = await connect({
      env: budgeted,
      fetch: api.fetch,
      health: level2,
    });
    await client.openSpace("Research");
    await client.openSpace("space-1", { isolated: false, pageBudget: 3 });
    await client.createSpace("Other");
    await client.createSpace("Own", { isolated: true, pageBudget: 2 });
    expect(api.requests.map((item) => item.body)).toEqual([
      { name: "Research", reuse: true, pageBudget: 5 },
      { name: "space-1", reuse: true, isolated: false, pageBudget: 3 },
      { name: "Other", pageBudget: 5 },
      { name: "Own", isolated: true, pageBudget: 2 },
    ]);
    const wrong = await connect({
      env: { ...env, KAMAPATHY_PAGE_BUDGET: "21" },
      fetch: api.fetch,
      health: level2,
    });
    await expect(wrong.createSpace("Other")).rejects.toMatchObject({
      code: "invalid_option",
      option: "KAMAPATHY_PAGE_BUDGET",
    });
    expect(api.requests).toHaveLength(4);
    const work = await client.requestSpace({
      reason: "Book a table",
      name: "Work",
    });
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/space-requests",
      body: { reason: "Book a table", name: "Work" },
    });
    expect(work).toMatchObject({
      id: "work",
      kind: "personal",
      owner: "agent",
    });
    expect(work.userPage()).toMatchObject({
      id: "tab-w",
      label: "p1",
      openedBy: "person",
    });
    // Taking control back reports the boundary and the page the person left.
    const research = await client.space("space-1");
    expect(research.userPage()).toBeNull();
    const resumed = await research.resume();
    expect(resumed).toMatchObject({ ok: true, owner: "agent", closed: ["p3"] });
    expect(resumed.active).toMatchObject({ id: "tab-1", label: "p1" });
    expect(resumed.opened.map((item) => item.label)).toEqual(["p2"]);
    expect(research.userPage()).toBe(resumed.active);
  });

  it("tabs prints labels, origins and flags, and resume, wait-for-control, space request and space finish print what they return", async () => {
    const api = fakeApi(sectionTwo);
    const run = async (args) => {
      const stdout = sink();
      expect(
        await runCli(args, { env, fetch: api.fetch, health: level2, stdout }),
        args.join(" "),
      ).toBe(0);
      return stdout.text();
    };
    expect(await run(["tabs", "space-1"])).toBe(
      'p1 tab-1 agent active https://example.test/reserve "Reserve"\np2 tab-2 page from p1 unmanaged new https://example.test/slots "Slots"\n',
    );
    const lines =
      'active p1 tab-1 https://example.test/reserve\nopened p2 tab-2 page from tab-1 unmanaged new https://example.test/slots "Slots"\nclosed p3\n';
    expect(await run(["resume", "space-1"])).toBe(
      `ok: agent control resumed\n${lines}`,
    );
    expect(await run(["wait-for-control", "space-1"])).toBe(
      `ok: agent has control\n${lines}`,
    );
    expect(
      await run([
        "space",
        "request",
        "--reason",
        "Book a table",
        "--name",
        "Work",
        "--timeout",
        "60000",
      ]),
    ).toBe(
      'space work "Work" agent shared\np1 tab-w person unmanaged active https://mail.test/ "Mail"\nactive p1 tab-w https://mail.test/\n',
    );
    expect(api.requests.at(-1).body).toEqual({
      reason: "Book a table",
      name: "Work",
      timeoutMs: 60000,
    });
    expect(await run(["space", "open", "Research", "--page-budget", "4"])).toBe(
      'space space-1 "Research" agent shared\n',
    );
    expect(api.requests.at(-1).body).toEqual({
      name: "Research",
      reuse: true,
      pageBudget: 4,
    });
    expect(await run(["new-page", "space-1"])).toBe(
      "tab tab-1 https://example.test/reserve\n",
    );
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/spaces/space-1/tabs",
      body: {},
    });
    expect(await run(["adopt", "space-1:p2"])).toBe(
      "tab tab-2 https://example.test/slots\n",
    );
    expect(await run(["release", "tab-2"])).toBe(
      "tab tab-2 https://example.test/slots\n",
    );
    await expect(
      runCli(["space", "open", "Research", "--page-budget", "21"], {
        env,
        fetch: api.fetch,
        stdout: sink(),
      }),
    ).rejects.toThrow("--page-budget must be an integer from 1 to 20.");
    await expect(
      runCli(["space", "nope"], { env, fetch: api.fetch, stdout: sink() }),
    ).rejects.toThrow(
      "Use space create, space open, space finish, space request or space close.",
    );
  });

  it("refuses calls the app is too old for (methods and commands)", async () => {
    const api = fakeApi(sectionTwo);
    const old = { status: "ok", version: "0.1.9", apiLevel: 1 };
    const client = await connect({ env, fetch: api.fetch, health: old });
    const research = await client.space("space-1");
    expect(paths(api)).toEqual(["GET /spaces"]);
    await expect(research.newPage()).rejects.toMatchObject({
      code: "app_outdated",
      entry: "space.newPage",
      required: 2,
      available: 1,
      appVersion: "0.1.9",
      message:
        "space.newPage needs Kamapathy API level 2, and Kamapathy 0.1.9 has level 1. Ask the person to update Kamapathy, then read the skill again.",
    });
    await expect(
      client.createSpace("Research", { pageBudget: 3 }),
    ).rejects.toMatchObject({
      code: "app_outdated",
      option: "pageBudget",
    });
    await expect(
      runCli(["new-page", "space-1"], {
        env,
        fetch: api.fetch,
        health: old,
        stdout: sink(),
      }),
    ).rejects.toMatchObject({
      code: "app_outdated",
      message:
        "new-page needs Kamapathy API level 2, and Kamapathy 0.1.9 has level 1. Ask the person to update Kamapathy, then read the skill again.",
    });
    expect(paths(api)).toEqual(["GET /spaces"]);
  });

  it("pdf-text reads a page range, prints each page, offers the next and refuses bad values before connecting", async () => {
    const current = {
      status: "ok",
      version: "0.2.0",
      apiLevel: schema.API_LEVEL,
    };
    const document = {
      url: "https://example.test/report.pdf",
      title: "Quarterly report",
      pageCount: 9,
      from: 2,
      to: 3,
    };
    let answer = {
      ...document,
      pages: [{ number: 2, text: "Page two text" }],
      chars: 13,
      truncated: true,
      nextPage: 3,
    };
    const api = fakeApi({
      ...sectionTwo,
      "POST /tabs/tab-1/pdf/text": () => Response.json(answer),
    });
    const stdout = sink();
    expect(
      await runCli(
        [
          "pdf-text",
          "tab-1",
          "--from",
          "2",
          "--to",
          "3",
          "--max-chars",
          "100",
          "--timeout",
          "20000",
        ],
        { env, fetch: api.fetch, health: current, stdout },
      ),
    ).toBe(0);
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/pdf/text",
      body: { from: 2, to: 3, maxChars: 100, timeoutMs: 20000 },
    });
    expect(stdout.text()).toBe(
      "Quarterly report, 9 pages, https://example.test/report.pdf\n[page 2]\nPage two text\nMore pages: rerun with --from 3.\n",
    );
    // Every page of the range, and a range without text.
    answer = {
      ...document,
      pages: [
        { number: 2, text: "Page two text" },
        { number: 3, text: "Page three text" },
      ],
      chars: 28,
      truncated: false,
    };
    const both = sink();
    expect(
      await runCli(["pdf-text", "tab-1"], {
        env,
        fetch: api.fetch,
        health: current,
        stdout: both,
      }),
    ).toBe(0);
    expect(api.requests.at(-1).body).toEqual({});
    expect(both.text()).toBe(
      "Quarterly report, 9 pages, https://example.test/report.pdf\n[page 2]\nPage two text\n[page 3]\nPage three text\n",
    );
    answer = {
      ...document,
      pages: [{ number: 2, text: "" }],
      chars: 0,
      truncated: false,
      noText: true,
    };
    const scan = sink();
    await runCli(["pdf-text", "tab-1"], {
      env,
      fetch: api.fetch,
      health: current,
      stdout: scan,
    });
    expect(scan.text()).toBe(
      "Quarterly report, 9 pages, https://example.test/report.pdf\n[page 2]\nNo text on these pages; they may be scans.\n",
    );
    const asJson = sink();
    await runCli(["pdf-text", "tab-1", "--json"], {
      env,
      fetch: api.fetch,
      health: current,
      stdout: asJson,
    });
    expect(JSON.parse(asJson.text())).toEqual(answer);
    // Bad values never reach the socket.
    const sent = api.requests.length;
    for (const [args, message] of [
      [["--from", "0"], "--from must be an integer from 1 to 100000."],
      [["--to", "100001"], "--to must be an integer from 1 to 100000."],
      [
        ["--max-chars", "1000001"],
        "--max-chars must be an integer from 0 to 1000000.",
      ],
      [["--timeout", "60001"], "--timeout must be an integer from 0 to 60000."],
      [["--pages", "2"], "Unknown option: --pages. Run help for usage."],
    ])
      await expect(
        runCli(["pdf-text", "tab-1", ...args], {
          env,
          fetch: api.fetch,
          health: current,
          stdout: sink(),
        }),
        args.join(" "),
      ).rejects.toThrow(message);
    expect(api.requests.length).toBe(sent);
    const help = sink();
    expect(await runCli(["help", "pdf-text"], { env, stdout: help })).toBe(0);
    expect(help.text()).toContain(
      "pdf-text <tab-id> [--from <n>] [--to <n>] [--max-chars <n>] [--timeout <ms>]",
    );
    expect(help.text()).toContain("Route: POST /tabs/:id/pdf/text");
    expect(help.text()).toContain("Since: API level 3");
    // A script sends timeout as the route's timeoutMs and refuses the field name.
    const client = await connect({ env, fetch: api.fetch, health: current });
    const page = (await client.space("space-1")).page("p1");
    expect(await page.pdfText({ from: 2, timeout: 5000 })).toEqual(answer);
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/pdf/text",
      body: { from: 2, timeoutMs: 5000 },
    });
    expect(await page.pdfText()).toEqual(answer);
    expect(api.requests.at(-1).body).toEqual({});
    await expect(page.pdfText({ timeoutMs: 5000 })).rejects.toMatchObject({
      code: "invalid_option",
      option: "timeoutMs",
      suggestion: "timeout",
      entry: "page.pdfText",
    });
  });

  // Section 7's waits: the arm is sent when waitForEvent is called, later
  // calls on the page wait for it, and the long poll answers with the event.
  const dialogRecord = {
    type: "confirm",
    message: "Delete this file?",
    answer: "dismissed",
    url: "https://example.test/reserve",
    at: 1700,
  };

  it("waitForEvent refuses timeout 0 with invalid_option before anything is sent", async () => {
    const api = fakeApi(sectionTwo);
    const client = await connect({ env, fetch: api.fetch, health: level2 });
    const page = (await client.space("space-1")).page("p1");
    const sent = api.requests.length;
    await expect(
      page.waitForEvent("popup", { timeout: 0 }),
    ).rejects.toMatchObject({
      code: "invalid_option",
      entry: "page.waitForEvent",
      option: "timeout",
      message:
        "page.waitForEvent got an invalid option: timeout must be an integer from 1 to 60000. Expected page.waitForEvent(event, { timeout? }).",
    });
    await expect(
      page.waitForEvent("popup", { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      code: "invalid_option",
      option: "timeoutMs",
      suggestion: "timeout",
    });
    await expect(page.waitForEvent("pop")).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "page.waitForEvent",
    });
    expect(api.requests.length).toBe(sent);
  });

  it("waitForEvent arms first and holds later calls on that page until the arm is acknowledged, then long-polls and resolves with a Page for a popup and the record for a dialog", async () => {
    let acknowledge;
    const held = new Promise((done) => {
      acknowledge = done;
    });
    let arms = 0;
    const api = fakeApi({
      ...sectionTwo,
      "POST /tabs/tab-1/expectations": async (body) => {
        arms += 1;
        if (arms === 1) await held;
        return Response.json(
          {
            expectation: {
              id: body.event === "popup" ? "x1" : "x2",
              event: body.event,
              tabId: "tab-1",
              expiresAt: 2000,
            },
          },
          { status: 201 },
        );
      },
      "POST /expectations/x1/wait": { popup: labeled[1] },
      "POST /expectations/x2/wait": { dialog: dialogRecord },
      "GET /tabs/tab-1/popups": {
        popups: [
          {
            id: "tab-2",
            label: "p2",
            url: "https://example.test/slots",
            openedAt: 10,
            unseen: true,
          },
        ],
      },
    });
    const client = await connect({ env, fetch: api.fetch, health: level2 });
    const page = (await client.space("space-1")).page("p1");
    await page.snapshot();
    const sent = api.requests.length;
    // The arm leaves with the call itself; a second arm and the click queue
    // behind it.
    const next = page.waitForEvent("popup");
    const alsoWaiting = page.waitForEvent("dialog");
    const clicked = page.click("@e2");
    await new Promise((done) => setImmediate(done));
    expect(paths(api).slice(sent)).toEqual(["POST /tabs/tab-1/expectations"]);
    acknowledge();
    const popup = await next;
    expect(await alsoWaiting).toEqual(dialogRecord);
    expect(await clicked).toMatchObject({ ok: true });
    // The first arm goes out alone; the rest follow once it is acknowledged.
    const after = paths(api).slice(sent);
    expect(after[0]).toBe("POST /tabs/tab-1/expectations");
    expect([...after.slice(1)].sort()).toEqual([
      "POST /expectations/x1/wait",
      "POST /expectations/x2/wait",
      "POST /tabs/tab-1/click",
      "POST /tabs/tab-1/expectations",
    ]);
    expect(api.requests[sent].body).toEqual({ event: "popup" });
    expect(
      api.requests.find((item) => item.path === "/expectations/x1/wait").body,
    ).toEqual({});
    expect(popup).toBeInstanceOf(Page);
    expect(popup).toMatchObject({
      id: "tab-2",
      label: "p2",
      spaceId: "space-1",
      openerId: "tab-1",
      url: "https://example.test/slots",
    });
    // A dialog wait answers with the record as it was sent, and the client's
    // timeout travels as the route's timeoutMs.
    expect(await page.waitForEvent("dialog", { timeout: 5000 })).toEqual(
      dialogRecord,
    );
    expect(api.requests.at(-2).body).toEqual({
      event: "dialog",
      timeoutMs: 5000,
    });
    // With no arm live a call goes straight out, and popups lists the pages
    // this page opened without clearing them.
    const idle = api.requests.length;
    await page.click("@e2");
    const opened = await page.popups();
    expect(paths(api).slice(idle)).toEqual([
      "POST /tabs/tab-1/click",
      "GET /tabs/tab-1/popups",
    ]);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toBeInstanceOf(Page);
    expect(opened[0]).toMatchObject({
      id: "tab-2",
      label: "p2",
      spaceId: "space-1",
      openerId: "tab-1",
    });
  });

  it("a wait that times out throws expectation_timeout with awaited, event and timeoutMs, and a second wait for the same event throws expectation_pending", async () => {
    let arm = (body) =>
      Response.json(
        {
          expectation: {
            id: "x9",
            event: body.event,
            tabId: "tab-1",
            expiresAt: 2000,
          },
        },
        { status: 201 },
      );
    const api = fakeApi({
      ...sectionTwo,
      "POST /tabs/tab-1/expectations": (body) => arm(body),
      "POST /expectations/x9/wait": () =>
        Response.json(
          {
            error: {
              code: "expectation_timeout",
              message:
                "No popup arrived within 5000 ms. Arm another wait before the action that causes it.",
              awaited: "event",
              event: "popup",
              timeoutMs: 5000,
            },
          },
          { status: 504 },
        ),
    });
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    try {
      const client = await connect({ env, fetch: api.fetch, health: level2 });
      const page = (await client.space("space-1")).page("p1");
      await expect(
        page.waitForEvent("popup", { timeout: 5000 }),
      ).rejects.toMatchObject({
        code: "expectation_timeout",
        entry: "page.waitForEvent",
        awaited: "event",
        event: "popup",
        timeoutMs: 5000,
        status: 504,
      });
      // The poll keeps the route's own budget whatever the caller's timeout,
      // so the server answers the timeout instead of the transport.
      expect(timeouts).toHaveBeenLastCalledWith(65000);
      // A second arm for the same event is refused, and the call queued
      // behind the failed arm fails with it instead of running unarmed.
      arm = () =>
        Response.json(
          {
            error: {
              code: "expectation_pending",
              message:
                "This page is already waiting for a popup. Wait for it, or cancel that wait before arming another.",
              event: "popup",
              expectationId: "x9",
            },
          },
          { status: 409 },
        );
      const clicks = paths(api).filter(
        (item) => item === "POST /tabs/tab-1/click",
      ).length;
      const failing = page.waitForEvent("popup");
      const queued = page.click("@e2");
      await expect(failing).rejects.toMatchObject({
        code: "expectation_pending",
        event: "popup",
        expectationId: "x9",
      });
      await expect(queued).rejects.toMatchObject({
        code: "expectation_pending",
      });
      expect(
        paths(api).filter((item) => item === "POST /tabs/tab-1/click").length,
      ).toBe(clicks);
      // The failed arm is cleared, so the next call sends as usual.
      expect(await page.click("@e2")).toMatchObject({ ok: true });
    } finally {
      timeouts.mockRestore();
    }
  });

  it("setDialogPolicy sends accept, promptText, times and lifetimeMs, setDialogPolicy(null) sends DELETE, and dialogs() returns the policy and records", async () => {
    const api = fakeApi({
      ...sectionTwo,
      "POST /tabs/tab-1/dialog-policy": (body) =>
        Response.json({
          policy: {
            accept: body.accept,
            ...(body.promptText === undefined
              ? {}
              : { promptText: body.promptText }),
            remaining: body.times ?? 1,
            expiresAt: 5000,
          },
        }),
      "DELETE /tabs/tab-1/dialog-policy": { policy: null },
      "GET /tabs/tab-1/dialogs": {
        policy: { accept: true, remaining: 2, expiresAt: 5000 },
        dialogs: [dialogRecord],
      },
    });
    const client = await connect({ env, fetch: api.fetch, health: level2 });
    const page = (await client.space("space-1")).page("p1");
    expect(
      await page.setDialogPolicy({
        accept: true,
        promptText: "Avery Quinn",
        times: 2,
        lifetime: 120000,
      }),
    ).toEqual({
      policy: {
        accept: true,
        promptText: "Avery Quinn",
        remaining: 2,
        expiresAt: 5000,
      },
    });
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/dialog-policy",
      body: {
        accept: true,
        promptText: "Avery Quinn",
        times: 2,
        lifetimeMs: 120000,
      },
    });
    await page.setDialogPolicy({ accept: false });
    expect(api.requests.at(-1).body).toEqual({ accept: false });
    expect(await page.setDialogPolicy(null)).toEqual({ policy: null });
    expect(api.requests.at(-1)).toEqual({
      method: "DELETE",
      path: "/tabs/tab-1/dialog-policy",
      body: undefined,
    });
    expect(await page.dialogs()).toEqual({
      policy: { accept: true, remaining: 2, expiresAt: 5000 },
      dialogs: [dialogRecord],
    });
    expect(api.requests.at(-1)).toEqual({
      method: "GET",
      path: "/tabs/tab-1/dialogs",
      body: undefined,
    });
    // A policy that is neither a plain object with an accept nor null, and a
    // field outside its range, are refused before anything is sent.
    const sent = api.requests.length;
    for (const policy of ["accept", 1, {}, { accept: "yes" }, [], undefined])
      await expect(
        page.setDialogPolicy(policy),
        String(policy),
      ).rejects.toMatchObject({
        code: "invalid_argument",
        entry: "page.setDialogPolicy",
        expected:
          "page.setDialogPolicy({ accept, promptText?, times?, lifetime? }) or page.setDialogPolicy(null)",
      });
    await expect(
      page.setDialogPolicy({ accept: true, lifetime: 999 }),
    ).rejects.toMatchObject({
      code: "invalid_field",
      field: "lifetimeMs",
      entry: "page.setDialogPolicy",
    });
    await expect(
      page.setDialogPolicy({ accept: true, times: 21 }),
    ).rejects.toMatchObject({
      code: "invalid_field",
      field: "times",
    });
    await expect(
      page.setDialogPolicy({ accept: true, promtText: "Avery" }),
    ).rejects.toMatchObject({
      code: "unknown_field",
      field: "promtText",
      suggestion: "promptText",
    });
    expect(api.requests.length).toBe(sent);
  });

  it("expect, wait-expectation, dialog-policy and dialogs print their lines, and an action prints its receipt lines in order", async () => {
    const receipt = {
      ok: true,
      url: "https://example.test/reserve",
      popups: [{ id: "tab-3", label: "p3", url: "https://example.test/share" }],
      dialog: dialogRecord,
      moreDialogs: 2,
      download: {
        id: "d1",
        suggestedFilename: "report.pdf",
        url: "https://example.test/report.pdf",
      },
      deniedRequests: [
        { origin: "https://maps.example", permission: "location" },
      ],
    };
    const api = fakeApi({
      ...sectionTwo,
      "POST /tabs/tab-1/expectations": (body) =>
        Response.json(
          {
            expectation: {
              id: "x1",
              event: body.event,
              tabId: "tab-1",
              expiresAt: 9,
            },
          },
          { status: 201 },
        ),
      "POST /expectations/x1/wait": { popup: labeled[1] },
      "POST /expectations/x2/wait": { dialog: dialogRecord },
      "POST /expectations/x3/wait": {
        download: {
          id: "d1",
          tabId: "tab-1",
          url: "https://example.test/report.pdf",
          suggestedFilename: "report.pdf",
          mimeType: "application/pdf",
          state: "progressing",
          receivedBytes: 0,
          totalBytes: 10,
          failure: null,
        },
      },
      "POST /expectations/x4/wait": {
        fileChooser: {
          id: "c1",
          tabId: "tab-1",
          multiple: true,
          accept: [".pdf"],
        },
      },
      "POST /tabs/tab-1/dialog-policy": (body) =>
        Response.json({
          policy: {
            accept: body.accept,
            remaining: body.times ?? 1,
            expiresAt: 9,
          },
        }),
      "DELETE /tabs/tab-1/dialog-policy": { policy: null },
      "GET /tabs/tab-1/dialogs": {
        policy: { accept: false, remaining: 1, expiresAt: 9 },
        dialogs: [
          dialogRecord,
          {
            type: "prompt",
            message: "Your name?",
            defaultValue: "",
            answer: "accepted",
            promptText: "Avery",
            url: "https://example.test/reserve",
            at: 1800,
          },
        ],
      },
      "POST /tabs/tab-1/click": () => Response.json(receipt),
    });
    const options = { env, fetch: api.fetch, health: level2 };
    const armed = sink();
    expect(
      await runCli(["expect", "tab-1", "popup"], { ...options, stdout: armed }),
    ).toBe(0);
    expect(api.requests.at(-1).body).toEqual({
      event: "popup",
      timeoutMs: 60000,
    });
    expect(armed.text()).toBe("expectation x1 popup tab-1\n");
    const timed = sink();
    await runCli(["expect", "tab-1", "dialog", "--timeout", "5000"], {
      ...options,
      stdout: timed,
    });
    expect(api.requests.at(-1).body).toEqual({
      event: "dialog",
      timeoutMs: 5000,
    });
    expect(timed.text()).toBe("expectation x1 dialog tab-1\n");
    for (const [id, printed] of [
      ["x1", "popup p2 tab-2 https://example.test/slots\n"],
      ["x2", 'dialog confirm "Delete this file?" dismissed\n'],
      ["x3", "download d1 report.pdf\n"],
      ["x4", "file-chooser c1 multiple\n"],
    ]) {
      const stdout = sink();
      expect(
        await runCli(["wait-expectation", id], { ...options, stdout }),
        id,
      ).toBe(0);
      expect(api.requests.at(-1), id).toEqual({
        method: "POST",
        path: `/expectations/${id}/wait`,
        body: {},
      });
      expect(stdout.text(), id).toBe(printed);
    }
    const policy = sink();
    expect(
      await runCli(
        [
          "dialog-policy",
          "tab-1",
          "accept",
          "--times",
          "2",
          "--lifetime",
          "120000",
          "--prompt-stdin",
        ],
        {
          ...options,
          stdin: Readable.from(["Avery Quinn"]),
          stdout: policy,
        },
      ),
    ).toBe(0);
    expect(api.requests.at(-1).body).toEqual({
      accept: true,
      times: 2,
      lifetimeMs: 120000,
      promptText: "Avery Quinn",
    });
    expect(policy.text()).toBe("policy accept 2 left\n");
    const dismissed = sink();
    await runCli(["dialog-policy", "tab-1", "dismiss"], {
      ...options,
      stdout: dismissed,
    });
    expect(api.requests.at(-1).body).toEqual({ accept: false });
    expect(dismissed.text()).toBe("policy dismiss 1 left\n");
    const cleared = sink();
    await runCli(["dialog-policy", "tab-1", "reset"], {
      ...options,
      stdout: cleared,
    });
    expect(api.requests.at(-1)).toEqual({
      method: "DELETE",
      path: "/tabs/tab-1/dialog-policy",
      body: undefined,
    });
    expect(cleared.text()).toBe("policy none\n");
    const logged = sink();
    expect(
      await runCli(["dialogs", "tab-1"], { ...options, stdout: logged }),
    ).toBe(0);
    expect(logged.text()).toBe(
      [
        "policy dismiss 1 left",
        'confirm "Delete this file?" dismissed',
        'prompt "Your name?" accepted',
        "",
      ].join("\n"),
    );
    const asJson = sink();
    await runCli(["dialogs", "tab-1", "--json"], {
      ...options,
      stdout: asJson,
    });
    expect(JSON.parse(asJson.text()).dialogs).toHaveLength(2);
    // An action prints its own line, then what it caused, in one order.
    const clicked = sink();
    expect(
      await runCli(["click", "tab-1", "@e2"], { ...options, stdout: clicked }),
    ).toBe(0);
    expect(clicked.text()).toBe(
      [
        "ok",
        "opened p3 tab-3 https://example.test/share",
        'confirm "Delete this file?" dismissed',
        "and 2 more dialogs",
        "download d1 report.pdf",
        "refused location for https://maps.example",
        "",
      ].join("\n"),
    );
    // A blocked download says so, and one further dialog reads as one.
    const blocked = sink();
    receipt.download = {
      blocked: true,
      suggestedFilename: "report.pdf",
      url: "https://example.test/report.pdf",
    };
    receipt.moreDialogs = 1;
    receipt.popups = [{ id: "tab-3", url: "https://example.test/share" }];
    await runCli(["click", "tab-1", "@e2"], { ...options, stdout: blocked });
    expect(blocked.text()).toBe(
      [
        "ok",
        "opened tab-3 tab-3 https://example.test/share",
        'confirm "Delete this file?" dismissed',
        "and 1 more dialog",
        "download blocked report.pdf",
        "refused location for https://maps.example",
        "",
      ].join("\n"),
    );
    // Bad arguments never reach the socket.
    const sent = api.requests.length;
    for (const [args, message] of [
      [
        ["expect", "tab-1", "popup", "--timeout", "0"],
        "--timeout must be an integer from 1 to 60000.",
      ],
      [
        ["expect", "tab-1", "pop"],
        "Use expect <tab-id> popup|download|filechooser|dialog.",
      ],
      [
        ["dialog-policy", "tab-1", "maybe"],
        "Use dialog-policy <tab-id> accept|dismiss|reset.",
      ],
      [
        ["dialog-policy", "tab-1", "reset", "--times", "2"],
        "dialog-policy reset takes no other options.",
      ],
      [
        ["dialog-policy", "tab-1", "accept", "--times", "21"],
        "--times must be an integer from 1 to 20.",
      ],
      [
        ["dialog-policy", "tab-1", "accept", "--lifetime", "999"],
        "--lifetime must be an integer from 1000 to 600000.",
      ],
    ])
      await expect(
        runCli(args, { ...options, stdout: sink() }),
        args.join(" "),
      ).rejects.toThrow(message);
    expect(api.requests.length).toBe(sent);
    const help = sink();
    expect(await runCli(["help", "expect"], { env, stdout: help })).toBe(0);
    expect(help.text()).toContain("expect <tab-id> <event> [--timeout <ms>]");
    expect(help.text()).toContain("Route: POST /tabs/:id/expectations");
    const commands = sink();
    await runCli(["help"], { env, stdout: commands });
    for (const usage of [
      "wait-expectation <id>",
      "dialog-policy <tab-id> accept|dismiss|reset",
      "dialogs <tab-id>",
    ])
      expect(commands.text()).toContain(usage);
  });

  // Section 7's downloads, file inputs, choosers and credentials.
  const heldDownload = {
    id: "d1",
    tabId: "tab-1",
    url: "https://example.test/report.pdf",
    suggestedFilename: "report.pdf",
    mimeType: "application/pdf",
    state: "progressing",
    receivedBytes: 0,
    totalBytes: 4,
    failure: null,
  };
  const doneDownload = {
    ...heldDownload,
    state: "completed",
    receivedBytes: 4,
    totalBytes: 4,
  };
  const otherDownload = {
    ...heldDownload,
    id: "d2",
    suggestedFilename: "slides.pdf",
    receivedBytes: 1,
    totalBytes: 10,
  };
  const downloadBytes = Buffer.from([1, 2, 3, 4]);
  const bytesRoute =
    (bytes = downloadBytes, length = bytes.length) =>
    () =>
      new Response(bytes, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(length),
        },
      });
  const scratchDirectory = async () => {
    const directory = await mkdtemp(join(tmpdir(), "kamapathy-download-test-"));
    directories.push(directory);
    return directory;
  };

  it("a Download waits in 30-second polls until it finishes, writes mode 0600 through missing folders, and path() gives a private copy delete() removes", async () => {
    let waits = 0;
    const api = fakeApi({
      ...sectionTwo,
      "GET /spaces/space-1/downloads": { downloads: [heldDownload] },
      "GET /downloads/d1": { download: heldDownload },
      "POST /downloads/d1/wait": () => {
        waits += 1;
        return waits === 1
          ? refusal(504, {
              code: "download_timeout",
              message: "The download is still running.",
              awaited: "download",
              downloadId: "d1",
              receivedBytes: 2,
              totalBytes: 4,
              timeoutMs: 30000,
              retryable: true,
            })()
          : Response.json({ download: doneDownload });
      },
      "GET /downloads/d1/content": bytesRoute(),
      "DELETE /downloads/d1": { ok: true },
    });
    const client = await connect({ env, fetch: api.fetch, health: level2 });
    const space = await client.space("space-1");
    const [download] = await space.downloads();
    expect(download).toBeInstanceOf(Download);
    expect([download.url(), download.suggestedFilename()]).toEqual([
      heldDownload.url,
      "report.pdf",
    ]);
    expect(download.page()).toBeInstanceOf(Page);
    expect(download.page().id).toBe("tab-1");
    // A record still progressing is refreshed before failure() answers.
    expect(await download.failure()).toBeNull();
    expect(api.requests.at(-1)).toEqual({
      method: "GET",
      path: "/downloads/d1",
      body: undefined,
    });
    const directory = await scratchDirectory();
    const output = join(directory, "nested", "deep", "report.pdf");
    const mark = api.requests.length;
    expect(await download.saveAs(output)).toBe(output);
    expect(await readFile(output)).toEqual(downloadBytes);
    if (posix) expect((await stat(output)).mode & 0o777).toBe(0o600);
    // Two 30-second polls, the server's own timeout asking again, then bytes.
    expect(paths(api).slice(mark)).toEqual([
      "POST /downloads/d1/wait",
      "POST /downloads/d1/wait",
      "GET /downloads/d1/content",
    ]);
    expect(api.requests.slice(mark, mark + 2).map((item) => item.body)).toEqual(
      [{ timeoutMs: 30000 }, { timeoutMs: 30000 }],
    );
    // The record is finished now, so nothing waits again, and the file stays.
    const written = api.requests.length;
    await expect(download.saveAs(output)).rejects.toMatchObject({
      code: "file_exists",
      path: output,
    });
    expect(paths(api).slice(written)).toEqual([]);
    expect(await readFile(output)).toEqual(downloadBytes);
    expect(await download.failure()).toBeNull();
    // path() keeps a private copy of its own, which delete() removes.
    const copy = await download.path();
    expect(await readFile(copy)).toEqual(downloadBytes);
    expect(copy).not.toBe(output);
    expect(await download.path()).toBe(copy);
    if (posix) {
      expect((await stat(copy)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(copy))).mode & 0o777).toBe(0o700);
    }
    expect(await download.delete()).toEqual({ ok: true });
    expect(api.requests.at(-1)).toEqual({
      method: "DELETE",
      path: "/downloads/d1",
      body: undefined,
    });
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(output)).toBe(true);
  });

  it("a Download that failed throws download_failed, and cancel reports the record", async () => {
    const cancelled = {
      ...heldDownload,
      state: "cancelled",
      failure: "cancelled",
    };
    const api = fakeApi({
      ...sectionTwo,
      "GET /spaces/space-1/downloads": { downloads: [heldDownload] },
      "POST /downloads/d1/cancel": { download: cancelled },
    });
    const client = await connect({ env, fetch: api.fetch, health: level2 });
    const [download] = await (await client.space("space-1")).downloads();
    expect(await download.cancel()).toEqual({ download: cancelled });
    expect(await download.failure()).toBe("cancelled");
    const directory = await scratchDirectory();
    await expect(
      download.saveAs(join(directory, "report.pdf")),
    ).rejects.toMatchObject({
      code: "download_failed",
      failure: "cancelled",
      entry: "download.saveAs",
    });
    expect(existsSync(join(directory, "report.pdf"))).toBe(false);
  });

  it("a stream that stops short removes the partial file and throws download_interrupted", async () => {
    const api = fakeApi({
      ...sectionTwo,
      "GET /spaces/space-1/downloads": { downloads: [doneDownload] },
      "GET /downloads/d1/content": bytesRoute(Buffer.from([1, 2]), 4),
    });
    const client = await connect({ env, fetch: api.fetch, health: level2 });
    const [download] = await (await client.space("space-1")).downloads();
    const directory = await scratchDirectory();
    const output = join(directory, "report.pdf");
    await expect(download.saveAs(output)).rejects.toMatchObject({
      code: "download_interrupted",
      downloadId: "d1",
      path: output,
    });
    expect(existsSync(output)).toBe(false);
    // The same goes for the private copy, and nothing is left behind.
    await expect(download.path()).rejects.toMatchObject({
      code: "download_interrupted",
    });
  });

  it("save-download never overwrites", async () => {
    const existing = await scratchFile();
    const api = fakeApi({
      ...sectionTwo,
      "GET /downloads/d1": { download: doneDownload },
      "GET /downloads/d1/content": bytesRoute(),
      "DELETE /downloads/d1": { ok: true },
    });
    const options = { env, fetch: api.fetch, health: level2 };
    await expect(
      runCli(["save-download", "d1", existing], { ...options, stdout: sink() }),
    ).rejects.toMatchObject({
      code: "file_exists",
      path: existing,
    });
    expect(await readFile(existing)).toEqual(Buffer.from("{}"));
    const target = `${existing}.pdf`;
    const stdout = sink();
    expect(
      await runCli(["save-download", "d1", target], { ...options, stdout }),
    ).toBe(0);
    expect(stdout.text()).toBe(`saved ${target} (4 bytes)\n`);
    expect(await readFile(target)).toEqual(downloadBytes);
    const deleted = sink();
    expect(
      await runCli(["delete-download", "d1"], { ...options, stdout: deleted }),
    ).toBe(0);
    expect(api.requests.at(-1)).toEqual({
      method: "DELETE",
      path: "/downloads/d1",
      body: undefined,
    });
    expect(deleted.text()).toBe("ok\n");
  });

  it("space.downloads lists Download objects and download arms, clicks and saves in one command", async () => {
    const api = fakeApi({
      ...sectionTwo,
      "GET /spaces/space-1/downloads": {
        downloads: [doneDownload, otherDownload],
      },
      "POST /tabs/tab-1/expectations": (body) =>
        Response.json(
          {
            expectation: {
              id: "x3",
              event: body.event,
              tabId: "tab-1",
              expiresAt: 9,
            },
          },
          { status: 201 },
        ),
      "POST /expectations/x3/wait": { download: doneDownload },
      "GET /downloads/d1/content": bytesRoute(),
      "POST /downloads/d1/cancel": {
        download: { ...doneDownload, state: "cancelled", failure: "cancelled" },
      },
      "DELETE /downloads/d1": { ok: true },
    });
    const options = { env, fetch: api.fetch, health: level2 };
    const client = await connect(options);
    const list = await (await client.space("space-1")).downloads();
    expect(list.map((item) => item instanceof Download)).toEqual([true, true]);
    expect(list.map((item) => item.suggestedFilename())).toEqual([
      "report.pdf",
      "slides.pdf",
    ]);
    const listed = sink();
    expect(
      await runCli(["downloads", "space-1"], { ...options, stdout: listed }),
    ).toBe(0);
    expect(listed.text()).toBe(
      [
        "d1 completed 4/4 report.pdf",
        "d2 progressing 1/10 slides.pdf",
        "",
      ].join("\n"),
    );
    const stopped = sink();
    expect(
      await runCli(["cancel-download", "d1"], { ...options, stdout: stopped }),
    ).toBe(0);
    expect(stopped.text()).toBe("d1 cancelled 4/4 report.pdf\n");
    // One command arms the wait, clicks, waits for the file and saves it.
    const directory = await scratchDirectory();
    const output = join(directory, "report.pdf");
    const mark = api.requests.length;
    const stdout = sink();
    expect(
      await runCli(["download", "tab-1", "@e2", output], {
        ...options,
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toBe(`saved ${output} (4 bytes)\n`);
    expect(await readFile(output)).toEqual(downloadBytes);
    const after = paths(api).slice(mark);
    expect(after[0]).toBe("POST /tabs/tab-1/expectations");
    expect([...after.slice(1, 3)].sort()).toEqual([
      "POST /expectations/x3/wait",
      "POST /tabs/tab-1/click",
    ]);
    expect(after.slice(3)).toEqual(["GET /downloads/d1/content"]);
    expect(api.requests[mark].body).toEqual({
      event: "download",
      timeoutMs: 60000,
    });
    // The arm follows --timeout, and nothing downloaded reads as the wait's
    // own error.
    const timed = fakeApi({
      ...sectionTwo,
      "POST /tabs/tab-1/expectations": (body) =>
        Response.json(
          {
            expectation: {
              id: "x3",
              event: body.event,
              tabId: "tab-1",
              expiresAt: 9,
            },
          },
          { status: 201 },
        ),
      "POST /expectations/x3/wait": refusal(504, {
        code: "expectation_timeout",
        message: "No download arrived within 5000 ms.",
        awaited: "event",
        event: "download",
        timeoutMs: 5000,
      }),
    });
    await expect(
      runCli(
        [
          "download",
          "space-1:p1",
          "@e2",
          join(directory, "other.pdf"),
          "--timeout",
          "5000",
        ],
        {
          env,
          fetch: timed.fetch,
          health: level2,
          stdout: sink(),
        },
      ),
    ).rejects.toMatchObject({ code: "expectation_timeout", event: "download" });
    expect(
      timed.requests.find((item) => item.path === "/tabs/tab-1/expectations")
        .body,
    ).toEqual({
      event: "download",
      timeoutMs: 5000,
    });
    expect(existsSync(join(directory, "other.pdf"))).toBe(false);
  });

  it("setInputFiles sends 0 to 8 files with their bytes, refuses 9 and a folder, and accepts a selector or a ref", async () => {
    const prefix = await scratchFile();
    const files = [`${prefix}.png`, `${prefix}.csv`];
    const bytes = [Buffer.from([137, 80, 78, 71]), Buffer.from("a,b\n1,2\n")];
    await Promise.all(
      files.map((path, index) => writeFile(path, bytes[index])),
    );
    const api = fakeApi({
      ...sectionTwo,
      "POST /tabs/tab-1/set-input-files": (body) =>
        Response.json({
          ok: true,
          selected: body.files.length,
          ...(body.files.length
            ? {
                popups: [
                  {
                    id: "tab-3",
                    label: "p3",
                    url: "https://example.test/share",
                  },
                ],
              }
            : {}),
        }),
    });
    const options = { env, fetch: api.fetch, health: level2 };
    const client = await connect(options);
    const page = (await client.space("space-1")).page("p1");
    expect(await page.setInputFiles("#resume", files)).toMatchObject({
      ok: true,
      selected: 2,
    });
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/set-input-files",
      body: {
        selector: "#resume",
        files: [
          {
            name: "fixture.json.png",
            type: "image/png",
            data: bytes[0].toString("base64"),
          },
          {
            name: "fixture.json.csv",
            type: "text/csv",
            data: bytes[1].toString("base64"),
          },
        ],
      },
    });
    // A ref travels as ref, the timeout as timeoutMs, and an empty list clears.
    expect(
      await page.setInputFiles("@e3", [], { timeout: 1000 }),
    ).toMatchObject({ ok: true, selected: 0 });
    expect(api.requests.at(-1).body).toEqual({
      ref: "@e3",
      files: [],
      timeoutMs: 1000,
    });
    // Nine files, a folder and a bad target never leave this computer.
    const folder = await scratchDirectory();
    const sent = api.requests.length;
    await expect(
      page.setInputFiles("@e3", Array(9).fill(files[0])),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "page.setInputFiles",
      expected:
        "page.setInputFiles(target, files, { timeout? }) with 0 to 8 file paths",
    });
    await expect(page.setInputFiles("@e3", [folder])).rejects.toMatchObject({
      code: "invalid_files",
      entry: "page.setInputFiles",
    });
    await expect(page.setInputFiles("", files)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(
      page.setInputFiles("@e3", files, { timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      code: "invalid_option",
      option: "timeoutMs",
      suggestion: "timeout",
    });
    expect(api.requests.length).toBe(sent);
    for (const [index, path] of files.entries())
      expect(await readFile(path)).toEqual(bytes[index]);
    // The CLI sends the same body and prints the receipt under its own line.
    const stdout = sink();
    expect(
      await runCli(["set-input-files", "tab-1", "#resume", ...files], {
        ...options,
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toBe(
      ["ok: selected 2", "opened p3 tab-3 https://example.test/share", ""].join(
        "\n",
      ),
    );
    expect(api.requests.at(-1).body.files).toHaveLength(2);
    expect(JSON.stringify(api.requests.at(-1).body)).not.toContain(prefix);
    const cleared = sink();
    expect(
      await runCli(["set-input-files", "tab-1", "@e3"], {
        ...options,
        stdout: cleared,
      }),
    ).toBe(0);
    expect(api.requests.at(-1).body).toEqual({ ref: "@e3", files: [] });
    expect(cleared.text()).toBe("ok: selected 0\n");
    const refused = sink();
    await expect(
      runCli(["set-input-files", "tab-1", "@e3", ...Array(9).fill(files[0])], {
        ...options,
        stdout: refused,
      }),
    ).rejects.toThrow("Select at most 8 file paths.");
  });

  it("a chooser's setFiles sends the same body, and FileChooser.isMultiple and page() read the arm's answer", async () => {
    const file = await scratchFile();
    const api = fakeApi({
      ...sectionTwo,
      "POST /tabs/tab-1/expectations": (body) =>
        Response.json(
          {
            expectation: {
              id: "x4",
              event: body.event,
              tabId: "tab-1",
              expiresAt: 9,
            },
          },
          { status: 201 },
        ),
      "POST /expectations/x4/wait": {
        fileChooser: {
          id: "c1",
          tabId: "tab-1",
          multiple: true,
          accept: [".pdf"],
        },
      },
      "POST /file-choosers/c1/files": (body) =>
        Response.json({ ok: true, selected: body.files.length }),
    });
    const options = { env, fetch: api.fetch, health: level2 };
    const client = await connect(options);
    const page = (await client.space("space-1")).page("p1");
    const chooser = await page.waitForEvent("filechooser");
    expect(chooser).toBeInstanceOf(FileChooser);
    expect(chooser.isMultiple()).toBe(true);
    expect(chooser.page()).toBeInstanceOf(Page);
    expect(chooser.page().id).toBe("tab-1");
    expect(await chooser.setFiles([file])).toEqual({ ok: true, selected: 1 });
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/file-choosers/c1/files",
      body: {
        files: [
          {
            name: "fixture.json",
            type: "application/json",
            data: Buffer.from("{}").toString("base64"),
          },
        ],
      },
    });
    // An empty list cancels the chooser, and the same limits apply.
    expect(await chooser.setFiles([])).toEqual({ ok: true, selected: 0 });
    expect(api.requests.at(-1).body).toEqual({ files: [] });
    const sent = api.requests.length;
    await expect(chooser.setFiles(Array(9).fill(file))).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "fileChooser.setFiles",
      expected: "fileChooser.setFiles(files) with 0 to 8 file paths",
    });
    await expect(chooser.setFiles("one")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(api.requests.length).toBe(sent);
    const stdout = sink();
    expect(
      await runCli(["set-files", "c1", file], { ...options, stdout }),
    ).toBe(0);
    expect(stdout.text()).toBe("ok: selected 1\n");
    expect(api.requests.at(-1).path).toBe("/file-choosers/c1/files");
    const cancelled = sink();
    expect(
      await runCli(["set-files", "c1"], { ...options, stdout: cancelled }),
    ).toBe(0);
    expect(api.requests.at(-1).body).toEqual({ files: [] });
    expect(cancelled.text()).toBe("ok: selected 0\n");
  });

  it("http-credentials never echoes", async () => {
    const api = fakeApi({
      ...sectionTwo,
      "POST /spaces/space-1/http-credentials": (body) =>
        Response.json({ ok: true, origin: body.origin }),
      "DELETE /spaces/space-1/http-credentials": { ok: true },
    });
    const options = { env, fetch: api.fetch, health: level2 };
    const client = await connect(options);
    const space = await client.space("space-1");
    expect(
      await space.setHTTPCredentials({
        origin: "https://example.test",
        username: "avery",
        password: "hunter2",
      }),
    ).toEqual({ ok: true, origin: "https://example.test" });
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/spaces/space-1/http-credentials",
      body: {
        origin: "https://example.test",
        username: "avery",
        password: "hunter2",
      },
    });
    expect(await space.setHTTPCredentials(null)).toEqual({ ok: true });
    expect(api.requests.at(-1)).toEqual({
      method: "DELETE",
      path: "/spaces/space-1/http-credentials",
      body: undefined,
    });
    // A shape the route would refuse never leaves, and no message names a value.
    const sent = api.requests.length;
    for (const value of ["https://example.test", 5, [], undefined])
      await expect(
        space.setHTTPCredentials(value),
        String(value),
      ).rejects.toMatchObject({
        code: "invalid_argument",
        entry: "space.setHTTPCredentials",
        expected:
          "space.setHTTPCredentials({ origin, username, password }) or space.setHTTPCredentials(null)",
      });
    await expect(
      space.setHTTPCredentials({ origin: "https://example.test" }),
    ).rejects.toMatchObject({
      code: "invalid_field",
      field: "username",
    });
    await expect(
      space.setHTTPCredentials({
        origin: "https://example.test",
        username: "avery",
        password: "x",
        extra: 1,
      }),
    ).rejects.toMatchObject({ code: "unknown_field", field: "extra" });
    expect(api.requests.length).toBe(sent);
    // The CLI prints the origin only, as text and as JSON.
    const credentials = () =>
      Readable.from([
        JSON.stringify({ username: "avery", password: "hunter2" }),
      ]);
    const stdout = sink();
    const stderr = sink();
    expect(
      await runCli(
        ["http-credentials", "space-1", "https://example.test", "--stdin"],
        {
          ...options,
          stdin: credentials(),
          stdout,
          stderr,
        },
      ),
    ).toBe(0);
    expect(stdout.text()).toBe("ok: https://example.test\n");
    const asJson = sink();
    await runCli(
      [
        "http-credentials",
        "space-1",
        "https://example.test",
        "--stdin",
        "--json",
      ],
      {
        ...options,
        stdin: credentials(),
        stdout: asJson,
      },
    );
    expect(JSON.parse(asJson.text())).toEqual({
      ok: true,
      origin: "https://example.test",
    });
    const cleared = sink();
    expect(
      await runCli(["http-credentials", "space-1", "clear"], {
        ...options,
        stdout: cleared,
      }),
    ).toBe(0);
    expect(api.requests.at(-1).method).toBe("DELETE");
    expect(cleared.text()).toBe("ok: credentials cleared\n");
    // A refusal names the field, never the name or the password.
    const failing = fakeApi({
      ...sectionTwo,
      "POST /spaces/space-1/http-credentials": refusal(400, {
        code: "invalid_field",
        message: "origin must be an http or https origin with no path.",
        field: "origin",
      }),
    });
    const out = sink();
    const failed = sink();
    expect(
      await main(["http-credentials", "space-1", "not-an-origin", "--stdin"], {
        env,
        fetch: failing.fetch,
        health: level2,
        stdin: credentials(),
        stdout: out,
        stderr: failed,
      }),
    ).toBe(1);
    expect(failed.text()).toContain("invalid_field");
    for (const text of [
      stdout.text(),
      stderr.text(),
      asJson.text(),
      cleared.text(),
      out.text(),
      failed.text(),
    ]) {
      expect(text).not.toContain("hunter2");
      expect(text).not.toContain("avery");
    }
    // Usage is refused before anything connects.
    const unsent = failing.requests.length;
    for (const args of [
      ["http-credentials", "space-1"],
      ["http-credentials", "space-1", "https://example.test"],
      ["http-credentials", "space-1", "clear", "--stdin"],
    ])
      await expect(
        runCli(args, {
          env,
          fetch: failing.fetch,
          health: level2,
          stdin: credentials(),
          stdout: sink(),
        }),
        args.join(" "),
      ).rejects.toThrow();
    expect(failing.requests.length).toBe(unsent);
  });

  it("run notes up to 20 unseen popups once each, then one counting line, and deletes the downloads it received", async () => {
    const opened = Array.from({ length: 23 }, (_, index) => ({
      id: `tab-${index + 10}`,
      label: `p${index + 10}`,
      url: `https://example.test/p${index + 10}`,
      openedAt: index,
      ...(index < 22 ? { unseen: true } : {}),
    }));
    const directory = await scratchDirectory();
    const output = join(directory, "report.pdf");
    const table = {
      ...sectionTwo,
      "GET /tabs/tab-1/popups": { popups: opened },
      // The same popup listed by a second tab is noticed once.
      "GET /tabs/tab-2/popups": { popups: [opened[0]] },
      "GET /spaces/space-1/downloads": { downloads: [doneDownload] },
      "GET /downloads/d1/content": bytesRoute(),
      "DELETE /downloads/d1": { ok: true },
    };
    const run = await runIn(
      `const home = await space("space-1");
      const page = (await home.tabs())[0];
      await page.click("@e2");
      await home.adopt("p2");
      const [file] = await home.downloads();
      await file.saveAs(${JSON.stringify(output)});`,
      table,
    );
    expect(run.status).toBe(0);
    expect(await readFile(output)).toEqual(downloadBytes);
    const notices = run.stderr.split("\n").filter(Boolean);
    expect(notices).toHaveLength(21);
    expect(notices[0]).toBe(
      "notice: unused page p10 opened by p1: https://example.test/p10",
    );
    expect(notices.at(-1)).toBe(
      "notice: and 2 more unused pages this run opened",
    );
    // Both touched tabs are read, and what the run received is deleted.
    const ending = paths(run.api).slice(
      paths(run.api).indexOf("GET /tabs/tab-1/popups"),
    );
    expect(ending).toEqual([
      "GET /tabs/tab-1/popups",
      "GET /tabs/tab-2/popups",
      "DELETE /downloads/d1",
    ]);
  });

  it("the end-of-run hooks ignore what Kamapathy refuses and delete nothing the script already deleted", async () => {
    const table = {
      ...sectionTwo,
      "GET /tabs/tab-1/popups": refusal(404, {
        code: "tab_not_found",
        message: "Agent tab was not found.",
      }),
      "GET /tabs/tab-2/popups": {
        popups: [
          {
            id: "tab-9",
            label: "p9",
            url: "https://example.test/p9",
            openedAt: 1,
            unseen: true,
          },
        ],
      },
      "GET /spaces/space-1/downloads": { downloads: [doneDownload] },
      "GET /downloads/d1/content": bytesRoute(),
      "DELETE /downloads/d1": { ok: true },
    };
    const run = await runIn(
      `const home = await space("space-1");
      const page = (await home.tabs())[0];
      await page.click("@e2");
      await home.adopt("p2");
      const [file] = await home.downloads();
      globalThis.__scripted = { copy: await file.path() };
      await file.delete();`,
      table,
    );
    expect(run.status).toBe(0);
    // A tab that refuses the read does not stop the next one, and the run
    // deletes the download once.
    expect(run.stderr).toBe(
      "notice: unused page p9 opened by p2: https://example.test/p9\n",
    );
    expect(
      paths(run.api).filter((item) => item === "DELETE /downloads/d1"),
    ).toEqual(["DELETE /downloads/d1"]);
    expect(existsSync(globalThis.__scripted.copy)).toBe(false);
  });

  it("asks for an isolated space only when told to", async () => {
    const api = fakeApi(routes);
    const client = await connect({ env, fetch: api.fetch });
    await client.createSpace("Shared");
    await client.createSpace("Own session", { isolated: true });
    await client.createSpace("Also shared", { isolated: false });
    expect(api.requests.map((request) => request.body)).toEqual([
      { name: "Shared" },
      { name: "Own session", isolated: true },
      { name: "Also shared" },
    ]);
  });

  it("prints the same text as the snapshot command", async () => {
    const api = fakeApi(routes);
    const stdout = sink();
    await runCli(["snapshot", "tab-1"], { env, fetch: api.fetch, stdout });
    const client = await connect({ env, fetch: api.fetch });
    const [page] = await (await client.space("space-1")).tabs();
    expect(`${await page.text()}\n`).toBe(stdout.text());
    const full = sink();
    await runCli(["snapshot", "tab-1", "--full", "--selector", "main"], {
      env,
      fetch: api.fetch,
      stdout: full,
    });
    expect(`${await page.text({ mode: "full", selector: "main" })}\n`).toBe(
      full.text(),
    );
    expect(api.requests.at(-1).body).toEqual(api.requests.at(-2).body);
  });

  it("throws errors that carry the API's code and message, and a failed batch keeps its progress", async () => {
    const api = fakeApi({
      ...routes,
      "POST /tabs/tab-1/click": () =>
        Response.json(
          {
            error: {
              code: "human_control",
              message: "The person is using this space.",
            },
          },
          { status: 409 },
        ),
      "POST /tabs/tab-1/actions": () =>
        Response.json(
          {
            ok: false,
            failedIndex: 1,
            results: [{ index: 0, type: "fill", result: { ok: true } }],
            error: { code: "stale_ref", message: "Observe again." },
          },
          { status: 422 },
        ),
      "POST /tabs/tab-1/fill": () => {
        throw new DOMException("Timed out", "TimeoutError");
      },
      "POST /tabs/tab-1/wait": () => new Response("not json", { status: 200 }),
    });
    const client = await connect({ env, fetch: api.fetch });
    const page = await (
      await client.space("space-1")
    ).open("https://example.test/reserve");
    const refused = await page.click("@e2").catch((error) => error);
    expect(refused).toBeInstanceOf(KamapathyError);
    expect(refused).toMatchObject({
      code: "human_control",
      message: "The person is using this space.",
      status: 409,
    });
    const stopped = await page
      .batch([
        { type: "fill", ref: "@e1", value: "A" },
        { type: "click", ref: "@e2" },
      ])
      .catch((error) => error);
    expect(stopped).toMatchObject({
      code: "stale_ref",
      message: "Observe again.",
      status: 422,
      failedIndex: 1,
      results: [{ index: 0, type: "fill", result: { ok: true } }],
    });
    await expect(page.fill("@e1", "A")).rejects.toMatchObject({
      code: "timeout",
      message: expect.stringContaining("Inspect the page before retrying"),
    });
    await expect(page.wait()).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(client.space("space-9")).rejects.toMatchObject({
      code: "space_not_found",
    });
    // The identity check stays in place: a wrong instance never gets a command.
    const { paths, env: profileEnv } = await profile();
    await fakeKamapathy(paths, { answerAs: "f".repeat(32) });
    await expect(connect({ env: profileEnv })).rejects.toThrow("not running");
  });

  it("uploads and saves screenshots like the commands do", async () => {
    const api = fakeApi(routes);
    const client = await connect({ env, fetch: api.fetch });
    const page = await (
      await client.space("space-1")
    ).open("https://example.test/reserve");
    const file = `${await scratchFile()}.pdf`;
    await writeFile(file, Buffer.from([1, 2, 3]));
    expect(await page.upload("@e3", [file])).toEqual({ ok: true, selected: 1 });
    expect(api.requests.at(-1).body).toEqual({
      ref: "@e3",
      files: [
        {
          name: "fixture.json.pdf",
          type: "application/pdf",
          data: Buffer.from([1, 2, 3]).toString("base64"),
        },
      ],
    });
    await expect(page.upload("#file", [file])).rejects.toThrow("ref");
    await expect(page.upload("@e3", [])).rejects.toThrow("between 1 and 8");
    const png = `${await scratchFile()}.png`;
    expect(await page.screenshot(png)).toBe(png);
    expect([...(await readFile(png))]).toEqual([137, 80, 78, 71]);
    await expect(page.screenshot(png)).rejects.toThrow("EEXIST");
    await expect(page.screenshot(`${png}.jpg`)).rejects.toThrow(".png");
  });

  it("runs a script file with the connected client and its entry points as globals", async () => {
    const api = fakeApi(routes);
    const path = await scriptFile(
      "task.mjs",
      [
        'const research = await createSpace("Research", { isolated: true });',
        'const page = await research.open("https://example.test/reserve");',
        "globalThis.__scripted = {",
        "  client: kamapathy,",
        "  text: await page.text(),",
        "  names: (await spaces()).map((item) => item.name),",
        '  found: (await space("space-1")).id,',
        "};",
      ].join("\n"),
    );
    const stderr = sink();
    expect(
      await runCli(["run", path], {
        env,
        fetch: api.fetch,
        stdout: sink(),
        stderr,
      }),
    ).toBe(0);
    expect(stderr.text()).toBe("");
    expect(globalThis.__scripted.text).toBe(formatSnapshot(snapshot));
    expect(globalThis.__scripted.names).toEqual(["Research"]);
    expect(globalThis.__scripted.found).toBe("space-1");
    expect(typeof globalThis.__scripted.client.createSpace).toBe("function");
    expect(api.requests[0]).toEqual({
      method: "POST",
      path: "/spaces",
      body: { name: "Research", isolated: true },
    });
  });

  it("runs code from stdin or -e through a private temporary module it removes afterwards", async () => {
    const api = fakeApi(routes);
    const source = [
      'import { statSync } from "node:fs";',
      'import { fileURLToPath } from "node:url";',
      "const path = fileURLToPath(import.meta.url);",
      "globalThis.__scripted = { path, mode: statSync(path).mode & 0o777, count: (await spaces()).length };",
    ].join("\n");
    expect(
      await runCli(["run", "-"], {
        env,
        fetch: api.fetch,
        stdin: Readable.from([source]),
        stdout: sink(),
        stderr: sink(),
      }),
    ).toBe(0);
    const fromStdin = globalThis.__scripted;
    expect(fromStdin.count).toBe(1);
    expect(basename(fromStdin.path)).toMatch(
      /^kamapathy-run-[a-f0-9]{16}\.mjs$/,
    );
    if (posix) expect(fromStdin.mode).toBe(0o600);
    expect(existsSync(fromStdin.path)).toBe(false);
    expect(
      await runCli(["run", "-e", source], {
        env,
        fetch: api.fetch,
        stdout: sink(),
        stderr: sink(),
      }),
    ).toBe(0);
    expect(globalThis.__scripted.path).not.toBe(fromStdin.path);
    expect(existsSync(globalThis.__scripted.path)).toBe(false);
  });

  // Vite's module runner names a script run in this process by a
  // forward-slash path on Windows, a form Node never prints there, so only
  // POSIX shows where it failed. Spawned runs show it on every platform.
  const failedAt = posix ? "  at -e:1:\\d+\\n" : "";

  it("ends a failing script with the error's code and message and exit status 1", async () => {
    const api = fakeApi({
      ...routes,
      "POST /tabs/tab-1/click": () =>
        Response.json(
          { error: { code: "stale_ref", message: "Observe again." } },
          { status: 422 },
        ),
    });
    const stale = sink();
    expect(
      await runCli(
        [
          "run",
          "-e",
          'const page = await (await space("space-1")).open("https://example.test/reserve"); await page.click("@e2");',
        ],
        { env, fetch: api.fetch, stdout: sink(), stderr: stale },
      ),
    ).toBe(1);
    expect(stale.text()).toMatch(
      new RegExp(`^error: stale_ref: Observe again\\.\\n${failedAt}$`),
    );
    const plain = sink();
    expect(
      await runCli(["run", "-e", 'throw new Error("boom")'], {
        env,
        fetch: api.fetch,
        stdout: sink(),
        stderr: plain,
      }),
    ).toBe(1);
    expect(plain.text()).toMatch(new RegExp(`^error: boom\\n${failedAt}$`));
    const missing = sink();
    expect(
      await runCli(["run", "-e", 'await space("space-9")'], {
        env,
        fetch: api.fetch,
        stdout: sink(),
        stderr: missing,
      }),
    ).toBe(1);
    expect(missing.text()).toMatch(/^error: space_not_found: /);
    await expect(
      runCli(["run"], { env, fetch: api.fetch, stdout: sink() }),
    ).rejects.toThrow("Missing");
    await expect(
      runCli(["run", join(tmpdir(), "kamapathy-absent.mjs")], {
        env,
        fetch: api.fetch,
        stdout: sink(),
      }),
    ).rejects.toThrow("not found");
  });

  it("connects a script over the profile's socket with the same discovery as every command", async () => {
    const { paths, env: profileEnv } = await profile();
    const requests = [];
    await fakeKamapathy(paths, {
      handler: (request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.writeHead(request.method === "POST" ? 201 : 200, {
          "Content-Type": "application/json",
        });
        response.end(
          JSON.stringify(
            request.url === "/health"
              ? { status: "ok", version: "test" }
              : request.method === "POST"
                ? { space: { ...space, signIns: "separate" } }
                : { spaces: [space] },
          ),
        );
      },
    });
    // A real process with Node's own module loader, started from either entry
    // point.
    for (const entry of [
      "skills/kamapathy/scripts/kamapathy.mjs",
      "scripts/kamapathy.mjs",
    ]) {
      const child = spawn(
        process.execPath,
        [
          entry,
          "run",
          "-e",
          'console.log((await createSpace("Research", { isolated: true })).signIns)',
        ],
        { env: { ...process.env, ...profileEnv } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const code = await new Promise((done) => child.once("close", done));
      expect([code, stdout, stderr]).toEqual([0, "separate\n", ""]);
    }
    expect(requests).toEqual([
      "GET /health",
      "POST /spaces",
      "GET /health",
      "POST /spaces",
    ]);
  }, 20000);

  it("fails loudly when a script exits early, never settles or forgets an await, and always removes its file", async () => {
    const { paths, env: profileEnv } = await profile();
    await fakeKamapathy(paths, {
      handler: (request, response) => {
        if (request.url === "/health") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ status: "ok", version: "test" }));
        } else if (request.url === "/spaces") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ spaces: [space] }));
        } else if (request.url === "/spaces/space-1/tabs") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ tabs: [tab] }));
        } else {
          response.writeHead(422, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              error: { code: "stale_ref", message: "Observe again." },
            }),
          );
        }
      },
    });
    const run = async (code) => {
      const child = spawn(
        process.execPath,
        ["skills/kamapathy/scripts/kamapathy.mjs", "run", "-e", code],
        {
          env: { ...process.env, ...profileEnv },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const status = await new Promise((done) => child.once("close", done));
      return { status, stdout, stderr };
    };
    const leftovers = async () =>
      (await readdir(tmpdir())).filter((name) =>
        name.startsWith("kamapathy-run-"),
      );
    const before = await leftovers();
    expect(
      await run(
        'await spaces(); console.log("waiting"); await new Promise(() => {})',
      ),
    ).toEqual({
      status: 1,
      stdout: "waiting\n",
      stderr:
        "error: The script stopped with work still pending. Await every call.\n",
    });
    expect(await run("await spaces(); process.exit(0)")).toMatchObject({
      status: 0,
      stderr: "",
    });
    const unawaited = await run(
      'const page = (await (await space("space-1")).tabs())[0]; page.click("@e2"); console.log("done")',
    );
    expect(unawaited.status).toBe(1);
    expect(unawaited.stdout).toBe("done\n");
    expect(unawaited.stderr).toBe("error: stale_ref: Observe again.\n");
    expect(await leftovers()).toEqual(before);
  }, 30000);

  // Runs a script in this process; its output arrives in the sinks once it
  // settles.
  const runIn = async (code, routeTable, extra = {}) => {
    const api = fakeApi(routeTable);
    const stdout = sink();
    const stderr = sink();
    const status = await runCli(["run", ...(extra.args ?? []), "-e", code], {
      env,
      fetch: api.fetch,
      health: level2,
      stdout,
      stderr,
      ...extra.options,
    });
    return { status, stdout: stdout.text(), stderr: stderr.text(), api };
  };
  const refusal = (status, error) => () => Response.json({ error }, { status });
  const firstPage = 'const page = (await (await space("space-1")).tabs())[0];';
  const takeover =
    "Kamapathy stopped this run: the person has control of the space.\n";
  const withheld =
    "Output from this run was withheld. Stop here, do not retry or work around it, and continue only when the person asks.\n";
  const stopGuidance =
    "Kamapathy stopped this run: the person stopped the agent in this space.\nOutput from this run was withheld. Stop here and tell the person; only they can let an agent use it again.\n";
  const accessGuidance =
    "Kamapathy stopped this run: agent access is turned off.\nOutput from this run was withheld. Stop here and tell the person. Only they can turn agent access on, in Settings under Agents.\n";

  it("a caught human_control with reason manual withholds output, sends no later request and prints only the guidance", async () => {
    const message =
      "The person took over this space. Stop, and resume only when they ask you to.";
    const run = await runIn(
      `${firstPage}
      process.stdout.write("before\\n");
      const error = await page.click("@e2").catch((error) => error);
      const again = await page.fill("@e1", "A").catch((error) => error);
      globalThis.__scripted = { first: error.hardStop, again: again.hardStop, code: again.code };
      process.stdout.write("after\\n");`,
      {
        ...sectionTwo,
        "POST /tabs/tab-1/click": refusal(409, {
          code: "human_control",
          message,
          reason: "manual",
          spaceId: "space-1",
        }),
      },
    );
    expect(run).toMatchObject({
      status: 3,
      stdout: "",
      stderr: `${takeover}${message}\n${withheld}`,
    });
    expect(globalThis.__scripted).toEqual({
      first: true,
      again: true,
      code: "human_control",
    });
    expect(paths(run.api)).toEqual([
      "GET /spaces/space-1",
      "GET /spaces/space-1/tabs",
      "POST /tabs/tab-1/click",
    ]);
  });

  it("hard-stop guidance follows the human_control reason", async () => {
    const message = "Taken.";
    const hold =
      "Tell the person what is waiting for their answer in Kamapathy, then run kamapathy wait-for-control space-1 and start a new run when it returns.\n";
    for (const [reason, expected] of [
      [
        "manual",
        { status: 3, stdout: "", stderr: `${takeover}${message}\n${withheld}` },
      ],
      [
        "handoff",
        { status: 3, stdout: "", stderr: `${takeover}${message}\n${withheld}` },
      ],
      [
        undefined,
        { status: 3, stdout: "", stderr: `${takeover}${message}\n${withheld}` },
      ],
      [
        "permission",
        {
          status: 1,
          stdout: "kept\n",
          stderr: expect.stringMatching(
            new RegExp(
              `^error: human_control: ${message}\\n${failedAt}${hold}$`,
            ),
          ),
        },
      ],
      [
        "failed",
        {
          status: 1,
          stdout: "kept\n",
          stderr: expect.stringMatching(
            new RegExp(`^error: human_control: ${message}\\n${failedAt}$`),
          ),
        },
      ],
    ])
      expect(
        await runIn(
          `${firstPage} process.stdout.write("kept\\n"); await page.click("@e2");`,
          {
            ...sectionTwo,
            "POST /tabs/tab-1/click": refusal(409, {
              code: "human_control",
              message,
              reason,
              spaceId: "space-1",
            }),
          },
        ),
        String(reason),
      ).toMatchObject(expected);
  });

  it("a caught hold is not a hard stop: waitForControl returns when the fake hands control back and later calls send", async () => {
    const run = await runIn(
      `const research = await space("space-1");
      const page = (await research.tabs())[0];
      await page.click("@e2").catch(() => {});
      await research.waitForControl();
      await page.fill("@e1", "A");
      process.stdout.write("done\\n");`,
      {
        ...sectionTwo,
        "POST /tabs/tab-1/click": refusal(409, {
          code: "human_control",
          message: "Asked.",
          reason: "permission",
          prompt: "camera",
          spaceId: "space-1",
        }),
      },
    );
    expect(run).toMatchObject({ status: 0, stdout: "done\n", stderr: "" });
    expect(paths(run.api).slice(-3, -1)).toEqual([
      "POST /spaces/space-1/wait-for-control",
      "POST /tabs/tab-1/fill",
    ]);
    expect(paths(run.api).at(-1)).toBe("GET /tabs/tab-1/popups");
  });

  it("the person's Stop is a hard stop with its own guidance, also when it ends a waitForControl; space_ended after the agent's own finish is an ordinary error", async () => {
    const stopped = {
      code: "space_ended",
      message: "Stopped.",
      spaceId: "space-1",
      endedBy: "person",
      reason: "stopped",
    };
    expect(
      await runIn(
        `${firstPage} process.stdout.write("x\\n"); await page.click("@e2").catch(() => {});`,
        {
          ...sectionTwo,
          "POST /tabs/tab-1/click": refusal(409, stopped),
        },
      ),
    ).toMatchObject({ status: 3, stdout: "", stderr: stopGuidance });
    expect(
      await runIn(
        'process.stdout.write("x\\n"); await (await space("space-1")).waitForControl();',
        {
          ...sectionTwo,
          "POST /spaces/space-1/wait-for-control": refusal(409, stopped),
        },
      ),
    ).toMatchObject({ status: 3, stdout: "", stderr: stopGuidance });
    expect(
      await runIn(
        `${firstPage} process.stdout.write("x\\n"); await page.click("@e2");`,
        {
          ...sectionTwo,
          "POST /tabs/tab-1/click": refusal(409, {
            ...stopped,
            endedBy: "agent",
            reason: "finished",
            message: "Finished.",
          }),
        },
      ),
    ).toMatchObject({
      status: 1,
      stdout: "x\n",
      stderr: expect.stringMatching(
        new RegExp(`^error: space_ended: Finished\\.\\n${failedAt}$`),
      ),
    });
  });

  it("automation_stopped and an off marker at the first call are hard stops; a delayed waitForControl answer is not", async () => {
    expect(
      await runIn(
        `${firstPage} process.stdout.write("x\\n"); await page.click("@e2");`,
        {
          ...sectionTwo,
          "POST /tabs/tab-1/click": refusal(503, {
            code: "automation_stopped",
            message: "Automation is disabled.",
          }),
        },
      ),
    ).toMatchObject({ status: 3, stdout: "", stderr: accessGuidance });
    const { paths: agent, userData } = await profile();
    await writeFile(agent.off, "", { mode: 0o600 });
    const stdout = sink();
    const stderr = sink();
    expect(
      await runCli(
        ["run", "-e", 'process.stdout.write("x\\n"); await spaces();'],
        {
          env: { KAMAPATHY_USER_DATA: userData },
          stdout,
          stderr,
        },
      ),
    ).toBe(3);
    expect([stdout.text(), stderr.text()]).toEqual(["", accessGuidance]);
    expect(
      await runIn(
        'const result = await (await space("space-1")).waitForControl(); process.stdout.write(`${result.owner}\\n`);',
        {
          ...sectionTwo,
          "POST /spaces/space-1/wait-for-control": async () => {
            await new Promise((done) => setTimeout(done, 100));
            return Response.json(boundary);
          },
        },
      ),
    ).toMatchObject({ status: 0, stdout: "agent\n", stderr: "" });
  });

  it("end-of-run hooks run once, in order, with the touched tab ids, after the module settles, throws or stalls; a hard stop skips them, the 5000 ms cap cuts them short, and their errors print nothing and keep the exit status", async () => {
    const calls = [];
    const hooks = [
      async ({ touched, signal }) => {
        calls.push(["first", touched, signal instanceof AbortSignal]);
        throw new Error("ignored");
      },
      async ({ touched }) => {
        calls.push(["second", touched]);
      },
    ];
    expect(
      await runIn(
        `${firstPage} await page.click("@e2"); process.stdout.write("ok\\n");`,
        sectionTwo,
        { options: { endHooks: hooks } },
      ),
    ).toMatchObject({ status: 0, stdout: "ok\n", stderr: "" });
    expect(calls).toEqual([
      ["first", ["tab-1"], true],
      ["second", ["tab-1"]],
    ]);
    calls.length = 0;
    expect(
      await runIn(
        `${firstPage} await page.click("@e2"); throw new Error("boom");`,
        sectionTwo,
        { options: { endHooks: hooks } },
      ),
    ).toMatchObject({
      status: 1,
      stderr: expect.stringMatching(new RegExp(`^error: boom\\n${failedAt}$`)),
    });
    expect(calls.map(([name]) => name)).toEqual(["first", "second"]);
    calls.length = 0;
    await runIn(
      `${firstPage} await page.click("@e2").catch(() => {});`,
      {
        ...sectionTwo,
        "POST /tabs/tab-1/click": refusal(409, {
          code: "human_control",
          message: "Taken.",
          reason: "manual",
        }),
      },
      { options: { endHooks: hooks } },
    );
    expect(calls).toEqual([]);
    // The cap ends the step, and later hooks never start.
    const started = Date.now();
    const capped = await runIn('process.stdout.write("ok\\n");', sectionTwo, {
      options: {
        endCapMs: 100,
        endHooks: [
          ({ signal }) =>
            new Promise((done) => signal.addEventListener("abort", done)),
          async () => calls.push(["late"]),
        ],
      },
    });
    expect(capped).toMatchObject({ status: 0, stdout: "ok\n", stderr: "" });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(calls).toEqual([]);
    // A script whose work never settles still runs the step, once.
    const directory = await mkdtemp(join(tmpdir(), "kamapathy-run-driver-"));
    directories.push(directory);
    const driver = join(directory, "driver.mjs");
    await writeFile(
      driver,
      [
        `import { writeSync } from "node:fs";`,
        `import { runScript } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "skills/kamapathy/scripts/lib/run.mjs")).href)};`,
        `runScript(["-e", "await new Promise(() => {})"], {`,
        `  env: { KAMAPATHY_NO_LAUNCH: "1" },`,
        `  fetch: async () => Response.json({}),`,
        `  endHooks: [async () => writeSync(2, "hook\\n")],`,
        `}).then((status) => (process.exitCode = status));`,
      ].join("\n"),
    );
    const child = spawn(process.execPath, [driver]);
    let output = "";
    child.stderr.on("data", (chunk) => (output += chunk));
    const status = await new Promise((done) => child.once("close", done));
    expect([status, output]).toEqual([
      1,
      "hook\nerror: The script stopped with work still pending. Await every call.\n",
    ]);
  }, 20000);

  it("the deadline aborts the call in progress, flushes and exits 1 with run_timeout", async () => {
    let aborted = false;
    const run = await runIn(
      `process.stdout.write("started\\n"); await spaces();`,
      {
        ...sectionTwo,
        "GET /spaces": (_body, options) =>
          new Promise((_done, reject) =>
            options.signal.addEventListener("abort", () => {
              aborted = true;
              reject(options.signal.reason);
            }),
          ),
      },
      { args: ["--timeout", "1000"] },
    );
    expect(aborted).toBe(true);
    expect(run).toMatchObject({
      status: 1,
      stdout: "started\n",
      stderr:
        "error: run_timeout: The script did not finish within 1000 ms. A call in progress may still have taken effect, so inspect the page before retrying. Use --timeout for longer tasks.\n",
    });
  });

  it("SIGTERM aborts the call in progress, flushes and exits 143 with interrupted; Windows, which cannot deliver it, ends the run at once", async () => {
    const { paths: agent, env: profileEnv } = await profile();
    let closed = false;
    let arrived;
    const request = new Promise((done) => (arrived = done));
    await fakeKamapathy(agent, {
      handler: (incoming, response) => {
        if (incoming.url === "/health") {
          response.writeHead(200, { "Content-Type": "application/json" });
          return response.end(
            JSON.stringify({ status: "ok", version: "test", apiLevel: 2 }),
          );
        }
        response.once("close", () => (closed = true));
        arrived();
      },
    });
    const child = spawn(
      process.execPath,
      [
        "skills/kamapathy/scripts/kamapathy.mjs",
        "run",
        "-e",
        'process.stdout.write("started\\n"); await spaces();',
      ],
      { env: { ...process.env, ...profileEnv } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    await request;
    child.kill("SIGTERM");
    const status = await new Promise((done) => child.once("close", done));
    // Windows ends the process without running its handlers, so the held
    // output and the interrupted line never print.
    expect([status, stdout, stderr]).toEqual(
      posix
        ? [
            143,
            "started\n",
            "error: interrupted: The run was stopped by SIGTERM. A call in progress may still have taken effect, so inspect the page before retrying.\n",
          ]
        : [null, "", ""],
    );
    await expect.poll(() => closed).toBe(true);
  }, 20000);

  it("held output keeps its order through process.exit and rejections, each queued notice prints once as a notice: line before the error line, and past 4 MiB is dropped with a count", async () => {
    const { paths: agent, env: profileEnv } = await profile();
    await fakeKamapathy(agent, {
      handler: (incoming, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(
            incoming.url === "/health"
              ? {
                  status: "ok",
                  version: "9.0.0",
                  apiLevel: schema.API_LEVEL + 1,
                }
              : { spaces: [] },
          ),
        );
      },
    });
    const run = async (code) => {
      const child = spawn(
        process.execPath,
        ["skills/kamapathy/scripts/kamapathy.mjs", "run", "-e", code],
        {
          env: { ...process.env, ...profileEnv },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const status = await new Promise((done) => child.once("close", done));
      return { status, stdout, stderr };
    };
    expect(
      await run(
        [
          'process.stdout.write("one\\n");',
          'console.error("two");',
          'Promise.reject(new Error("late"));',
          "await new Promise((done) => setTimeout(done, 10));",
          "await spaces();",
          'process.stdout.write("x".repeat(5 * 1024 * 1024));',
          'process.stdout.write("three\\n");',
          'throw new Error("final");',
        ].join(" "),
      ),
    ).toEqual({
      status: 1,
      stdout: "one\nthree\n",
      stderr: [
        "two",
        "error: late",
        "  at -e:1:69",
        "notice: Update this skill copy, then read its SKILL.md again.",
        "error: final",
        "  at -e:1:246",
        `Kamapathy: ${5 * 1024 * 1024} more bytes of output were dropped after the first 4 MiB. Write large results to a file.`,
        "",
      ].join("\n"),
    });
    expect(
      await run(
        'process.stdout.write("a\\n"); console.error("b"); process.exit(5);',
      ),
    ).toEqual({
      status: 5,
      stdout: "a\n",
      stderr: "b\n",
    });
  }, 30000);

  it("an idle script ends at once under --timeout 60000; out-of-range timeouts fail before connecting", async () => {
    const { env: profileEnv } = await profile();
    const started = Date.now();
    const child = spawn(
      process.execPath,
      [
        "skills/kamapathy/scripts/kamapathy.mjs",
        "run",
        "--timeout",
        "60000",
        "-e",
        'process.stdout.write("idle\\n")',
      ],
      { env: { ...process.env, ...profileEnv } },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    expect(await new Promise((done) => child.once("close", done))).toBe(0);
    expect(stdout).toBe("idle\n");
    expect(Date.now() - started).toBeLessThan(10000);
    const fetch = vi.fn();
    for (const [args, runEnv, message] of [
      [
        ["--timeout", "999"],
        env,
        "--timeout must be an integer from 1000 to 3600000 milliseconds.",
      ],
      [
        ["--timeout", "3600001"],
        env,
        "--timeout must be an integer from 1000 to 3600000 milliseconds.",
      ],
      [
        [],
        { ...env, KAMAPATHY_RUN_TIMEOUT_MS: "soon" },
        "KAMAPATHY_RUN_TIMEOUT_MS must be an integer from 1000 to 3600000 milliseconds.",
      ],
      [["--fast"], env, "Unknown run option: --fast. Run help for usage."],
    ])
      await expect(
        runCli(["run", ...args, "-e", "1"], {
          env: runEnv,
          fetch,
          stdout: sink(),
          stderr: sink(),
        }),
      ).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  }, 20000);

  it("stdin for fill, wait, batch and run - fails on an open pipe", async () => {
    const fetch = vi.fn();
    for (const args of [
      ["fill", "tab-1", "@e1", "--stdin"],
      ["wait", "tab-1", "--stdin"],
      ["batch", "tab-1"],
      ["run", "-"],
    ]) {
      const stdin = new PassThrough();
      stdin.write("{");
      await expect(
        runCli(args, {
          env,
          fetch,
          stdin,
          stdinTimeoutMs: 200,
          stdout: sink(),
          stderr: sink(),
        }),
        args.join(" "),
      ).rejects.toThrow(
        "Standard input did not end within 0.2 seconds. Pipe the complete value and close the input.",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a script that never calls Kamapathy never starts it", async () => {
    const { userData } = await profile();
    const launch = vi.fn();
    const stdout = sink();
    expect(
      await runCli(["run", "-e", 'process.stdout.write("hi\\n")'], {
        env: { KAMAPATHY_USER_DATA: userData },
        connect: { launch },
        stdout,
        stderr: sink(),
      }),
    ).toBe(0);
    expect(stdout.text()).toBe("hi\n");
    expect(launch).not.toHaveBeenCalled();
  });

  it("globals forward to the client methods and are not enumerable", async () => {
    const run = await runIn(
      `const names = ["kamapathy", "createSpace", "openSpace", "space", "spaces", "requestSpace"];
      globalThis.__scripted = names.map((name) => {
        const { enumerable, writable, configurable } = Object.getOwnPropertyDescriptor(globalThis, name);
        return [name, enumerable, writable, configurable, Object.keys(globalThis).includes(name)];
      });
      await openSpace("Research");
      await requestSpace({ reason: "Book a table" });`,
      sectionTwo,
    );
    expect(run.status).toBe(0);
    expect(globalThis.__scripted).toEqual(
      [
        "kamapathy",
        "createSpace",
        "openSpace",
        "space",
        "spaces",
        "requestSpace",
      ].map((name) => [name, false, true, true, false]),
    );
    expect(run.api.requests).toEqual([
      {
        method: "POST",
        path: "/spaces",
        body: { name: "Research", reuse: true },
      },
      {
        method: "POST",
        path: "/space-requests",
        body: { reason: "Book a table" },
      },
    ]);
  });

  it("the CLI refuses Node older than 22.13 for every command but help, --help, -h, --version and -v", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const stderr = sink();
    expect(
      await main(["health"], { env, fetch, stderr, nodeVersion: "22.12.0" }),
    ).toBe(1);
    expect(stderr.text()).toBe(
      "Kamapathy: Kamapathy's client needs Node.js 22.13 or later. This is Node.js 22.12.0.\n",
    );
    expect(fetch).not.toHaveBeenCalled();
    for (const argv of [
      ["help"],
      ["--help"],
      ["-h"],
      ["tabs", "--help"],
      ["--version"],
      ["-v"],
    ]) {
      const output = sink();
      await main(argv, {
        env,
        fetch,
        stdout: sink(),
        stderr: output,
        nodeVersion: "20.0.0",
      });
      expect(output.text(), argv.join(" ")).not.toContain("needs Node.js");
    }
    expect(
      await main(["health"], {
        env,
        fetch,
        stdout: sink(),
        stderr: sink(),
        nodeVersion: "22.13.0",
      }),
    ).toBe(0);
  });

  // Runs the CLI as its own process with this profile.
  const spawnCli = async (args, extraEnv, input) => {
    const child = spawn(
      process.execPath,
      ["skills/kamapathy/scripts/kamapathy.mjs", ...args],
      {
        env: { ...process.env, ...extraEnv },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(input);
    const status = await new Promise((done) => child.once("close", done));
    return { status, stdout, stderr };
  };

  it("TypeScript runs from .mts, .ts and --ts sources, refuses --ts with a .mjs file, and re-runs once with the flags when stripping is missing", async () => {
    const { env: profileEnv } = await profile();
    const typed = "const count: number = 2; console.log(`typed ${count}`);";
    expect(
      await spawnCli(["run", await scriptFile("task.mts", typed)], profileEnv),
    ).toEqual({
      status: 0,
      stdout: "typed 2\n",
      stderr: "",
    });
    expect(
      (await spawnCli(["run", await scriptFile("task.ts", typed)], profileEnv))
        .stdout,
    ).toBe("typed 2\n");
    expect(
      (await spawnCli(["run", "--ts", "-e", typed], profileEnv)).stdout,
    ).toBe("typed 2\n");
    expect(
      (await spawnCli(["run", "--ts", "-"], profileEnv, typed)).stdout,
    ).toBe("typed 2\n");
    await expect(
      runCli(["run", "--ts", await scriptFile("task.mjs", "1")], {
        env,
        stdout: sink(),
        stderr: sink(),
      }),
    ).rejects.toThrow(
      "--ts applies to run - and run -e. Name a TypeScript file .ts, .mts or .cts.",
    );
    // Without type stripping, run starts itself once more with Node's flag.
    const calls = [];
    const fakeSpawn = (command, args, options) => {
      calls.push({
        command,
        args,
        options,
        file: args.at(-1),
        existed: existsSync(args.at(-1)),
      });
      const child = new EventEmitter();
      child.kill = vi.fn();
      setTimeout(() => child.emit("exit", 4, null), 10);
      return child;
    };
    const stripping = {
      features: { typescript: false },
      execArgv: [],
      spawn: fakeSpawn,
      execPath: "/bin/node",
    };
    const file = await scriptFile("task.mts", typed);
    const envFile = await scratchFile();
    expect(
      await runCli(["run", "--timeout", "5000", "--env-file", envFile, file], {
        env,
        stdout: sink(),
        stderr: sink(),
        ...stripping,
      }),
    ).toBe(4);
    expect(calls[0]).toMatchObject({
      command: "/bin/node",
      args: [
        "--experimental-strip-types",
        "--disable-warning=ExperimentalWarning",
        join(process.cwd(), "skills/kamapathy/scripts/kamapathy.mjs"),
        "run",
        "--timeout",
        "5000",
        "--env-file",
        envFile,
        file,
      ],
      options: { stdio: "inherit" },
    });
    expect(
      await runCli(["run", "--ts", "-e", typed], {
        env,
        stdout: sink(),
        stderr: sink(),
        ...stripping,
      }),
    ).toBe(4);
    expect(calls[1].file).toMatch(/kamapathy-run-[a-f0-9]{16}\.mts$/);
    expect(calls[1].existed).toBe(true);
    expect(calls[1].options.env.KAMAPATHY_RUN_SOURCE).toBe("-e");
    expect(existsSync(calls[1].file)).toBe(false);
    await expect(
      runCli(["run", file], {
        env,
        stdout: sink(),
        stderr: sink(),
        ...stripping,
        execArgv: ["--experimental-strip-types"],
      }),
    ).rejects.toThrow(
      "This Node.js cannot run TypeScript. Use Node.js 22.18 or later, or write the script in JavaScript.",
    );
    expect(calls).toHaveLength(2);
  }, 30000);

  it("the workspace follows the profile or KAMAPATHY_WORKSPACE; env files fill only unset variables, later files win, profile and workspace names are skipped, unsafe files are refused without printing values", async () => {
    const { userData } = await profile();
    expect(workspacePath({ KAMAPATHY_USER_DATA: userData })).toBe(
      join(userData, "workspace"),
    );
    // An absolute folder on each platform: a Windows one has a drive.
    const cwd = posix ? "/home/me" : "C:\\Users\\me";
    expect(
      workspacePath(
        { KAMAPATHY_USER_DATA: userData, KAMAPATHY_WORKSPACE: "tasks" },
        cwd,
      ),
    ).toBe(join(cwd, "tasks"));
    const workspace = join(userData, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const dotEnv = join(workspace, ".env");
    await writeFile(
      dotEnv,
      "FROM_ENV=first\nLATER=workspace\nSTART=changed\nKAMAPATHY_USER_DATA=/elsewhere\n",
      { mode: 0o600 },
    );
    const extra = join(userData, "extra.env");
    await writeFile(extra, "LATER=extra-file\nADDED=3\n", { mode: 0o600 });
    const runEnv = {
      KAMAPATHY_USER_DATA: userData,
      KAMAPATHY_NO_LAUNCH: "1",
      START: "kept",
    };
    const stderr = sink();
    expect(
      await runCli(["run", "--env-file", extra, "-e", "1"], {
        env: runEnv,
        fetch: vi.fn(),
        stdout: sink(),
        stderr,
      }),
    ).toBe(0);
    expect(runEnv).toMatchObject({
      FROM_ENV: "first",
      LATER: "extra-file",
      ADDED: "3",
      START: "kept",
      KAMAPATHY_USER_DATA: userData,
      KAMAPATHY_WORKSPACE: workspace,
    });
    expect(stderr.text()).toBe(
      `Kamapathy: ${dotEnv} cannot set KAMAPATHY_USER_DATA. Set it in the environment instead.\n`,
    );
    if (posix) {
      await chmod(extra, 0o666);
      const refused = runCli(["run", "--env-file", extra, "-e", "1"], {
        env: { ...runEnv },
        fetch: vi.fn(),
        stdout: sink(),
        stderr: sink(),
      });
      await expect(refused).rejects.toThrow(
        `Kamapathy will not load ${extra}: it must be a regular file of at most 64 KiB that your account owns and others cannot change.`,
      );
      await expect(refused).rejects.not.toThrow("extra-file");
      const link = join(userData, "link.env");
      await symlink(dotEnv, link);
      await expect(
        runCli(["run", "--env-file", link, "-e", "1"], {
          env: { ...runEnv },
          fetch: vi.fn(),
          stdout: sink(),
          stderr: sink(),
        }),
      ).rejects.toThrow(`Kamapathy will not load ${link}`);
      await chmod(workspace, 0o777);
      await expect(
        runCli(["run", "-e", "1"], {
          env: { ...runEnv },
          fetch: vi.fn(),
          stdout: sink(),
          stderr: sink(),
        }),
      ).rejects.toThrow(
        `Kamapathy's workspace ${workspace} must be a folder your account owns that others cannot change.`,
      );
      await chmod(workspace, 0o700);
    }
  });

  it("env files cannot set the variables that locate the profile or the installed app", async () => {
    const home = await mkdtemp(join(tmpdir(), "kamapathy-cli-home-"));
    directories.push(home);
    const runEnv = { HOME: home, USERPROFILE: home, KAMAPATHY_NO_LAUNCH: "1" };
    const { userData } = agentPaths(runEnv);
    const workspace = join(userData, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const dotEnv = join(workspace, ".env");
    // util.parseEnv returns names sorted, so the lines report them in that order.
    const names = [
      "APPDATA",
      "HOME",
      "LOCALAPPDATA",
      "USERPROFILE",
      "XDG_CONFIG_HOME",
    ];
    await writeFile(
      dotEnv,
      names.map((name) => `${name}=${join(home, "elsewhere")}\n`).join(""),
      { mode: 0o600 },
    );
    const stderr = sink();
    expect(
      await runCli(["run", "-e", "1"], {
        env: runEnv,
        fetch: vi.fn(),
        stdout: sink(),
        stderr,
      }),
    ).toBe(0);
    expect(runEnv).toEqual({
      HOME: home,
      USERPROFILE: home,
      KAMAPATHY_NO_LAUNCH: "1",
      KAMAPATHY_WORKSPACE: workspace,
    });
    expect(agentPaths(runEnv).userData).toBe(userData);
    expect(stderr.text()).toBe(
      names
        .map(
          (name) =>
            `Kamapathy: ${dotEnv} cannot set ${name}. Set it in the environment instead.\n`,
        )
        .join(""),
    );
  });

  it("run and repl start Kamapathy without the variables their env files set", async () => {
    for (const command of ["run", "repl"]) {
      const { userData, paths } = await profile();
      const workspace = join(userData, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      await writeFile(
        join(workspace, ".env"),
        "SCRIPT_SECRET=s3cret\nHTTPS_PROXY=http://127.0.0.1:9\n",
        { mode: 0o600 },
      );
      const runEnv = { KAMAPATHY_USER_DATA: userData, FROM_SHELL: "kept" };
      const launch = vi.fn(() =>
        fakeKamapathy(paths, {
          handler: (request, response) => {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify(
                request.url === "/health"
                  ? { status: "ok", version: "test" }
                  : { spaces: [] },
              ),
            );
          },
        }),
      );
      const connect = { launch, intervalMs: 10, timeoutMs: 5000 };
      if (command === "run")
        expect(
          await runCli(["run", "-e", "await spaces()"], {
            env: runEnv,
            connect,
            stdout: sink(),
            stderr: sink(),
          }),
        ).toBe(0);
      else {
        const input = new PassThrough();
        const output = new PassThrough();
        let text = "";
        output.on("data", (chunk) => (text += chunk));
        const ended = runCli(["repl"], {
          env: runEnv,
          connect,
          stdin: input,
          stdout: output,
          terminal: true,
        });
        await expect.poll(() => text).toContain("kamapathy> ");
        input.write("(await spaces()).length\n");
        await expect.poll(() => text).toContain("0");
        input.write(".exit\n");
        expect(await ended).toBe(0);
      }
      expect(runEnv, command).toMatchObject({
        SCRIPT_SECRET: "s3cret",
        HTTPS_PROXY: "http://127.0.0.1:9",
      });
      expect(launch, command).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0][1], command).toEqual({
        KAMAPATHY_USER_DATA: userData,
        FROM_SHELL: "kept",
        KAMAPATHY_WORKSPACE: workspace,
      });
    }
  }, 20000);

  it('workspace prints and creates the folder with mode 0700, and --json prints {"workspace": path}', async () => {
    const { userData } = await profile();
    const fetch = vi.fn();
    const stdout = sink();
    expect(
      await runCli(["workspace"], {
        env: { KAMAPATHY_USER_DATA: userData },
        fetch,
        stdout,
      }),
    ).toBe(0);
    const workspace = join(userData, "workspace");
    expect(stdout.text()).toBe(`${workspace}\n`);
    if (posix) expect((await stat(workspace)).mode & 0o777).toBe(0o700);
    const json = sink();
    expect(
      await runCli(["workspace", "--json"], {
        env: { KAMAPATHY_USER_DATA: userData },
        fetch,
        stdout: json,
      }),
    ).toBe(0);
    expect(JSON.parse(json.text())).toEqual({ workspace });
    expect(fetch).not.toHaveBeenCalled();
  });

  // A workspace of this case's own, so no case depends on the packs the skill
  // ships or on the person's own workspace.
  async function siteWorkspace() {
    const home = await mkdtemp(join(tmpdir(), "kamapathy-cli-sites-"));
    directories.push(home);
    await chmod(home, 0o700);
    const sites = join(home, "sites");
    await mkdir(sites, { mode: 0o700 });
    return { home, sites, env: { KAMAPATHY_WORKSPACE: home } };
  }
  async function writeSitePack(root, id, manifest, files = {}) {
    const dir = join(root, id);
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, "pack.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    for (const [relative, text] of Object.entries(files)) {
      const path = join(dir, relative);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, text, { mode: 0o600 });
    }
    return dir;
  }
  // The samples the skill ships, read from the folder, so a task that adds one
  // extends these checks without touching them.
  async function bundledPackIds() {
    try {
      const root = new URL("../skills/kamapathy/sites/", import.meta.url);
      return (await readdir(root, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith("_") &&
            !entry.name.startsWith("."),
        )
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  }
  // A pack a case can list, read and check: one note, one Node tool and one
  // page tool, with every file the manifest declares.
  const labPack = {
    format: 1,
    id: "local-lab",
    name: "Local lab",
    domains: ["127.0.0.1"],
    notes: ["notes/overview.md"],
    tools: {
      list_products: {
        description: "List the products the lab page shows.",
        file: "tools/list-products.mjs",
        export: "listProducts",
        args: {
          limit: {
            type: "integer",
            description: "How many products to read, 1 to 20.",
          },
        },
        returns: { type: "array", description: "[{ name, price }]" },
      },
    },
    pageTools: {
      cart_total: {
        description: "Read the total the cart page shows.",
        file: "page-tools/cart-total.js",
        returns: { type: "number", description: "The total in cents." },
      },
    },
  };
  const labFiles = {
    "notes/overview.md": "The lab serves /packs/products and /packs/cart.\n",
    "tools/list-products.mjs": "export const listProducts = async () => [];\n",
    "page-tools/cart-total.js": "() => 0\n",
  };
  const noConnection = () =>
    vi.fn(() => {
      throw new Error("sites answers from this computer's files.");
    });

  it("sites lists both roots without connecting or starting Kamapathy", async () => {
    const { sites, env: siteEnv } = await siteWorkspace();
    await writeSitePack(sites, "local-lab", labPack, labFiles);
    const broken = await writeSitePack(sites, "broken", {
      ...labPack,
      format: 2,
      id: "broken",
      name: "Broken",
    });
    const fetch = noConnection();
    // KAMAPATHY_NO_LAUNCH is unset, so a parser that built a session would go
    // looking for Kamapathy; allowLaunch keeps such a regression from starting
    // the real app.
    const options = { env: siteEnv, fetch, connect: { allowLaunch: false } };
    const stdout = sink();
    expect(await runCli(["sites"], { ...options, stdout })).toBe(0);
    const lines = stdout.text().trimEnd().split("\n");
    expect(lines).toContain(
      'local-lab "Local lab" workspace 127.0.0.1; tools list_products; page tools cart_total',
    );
    expect(lines.at(-1)).toBe(`Skipped ${broken}: format: format must be 1.`);
    const bundled = await bundledPackIds();
    for (const id of bundled)
      expect(
        lines.some((text) => text.startsWith(`${id} "`)),
        id,
      ).toBe(true);
    expect(lines.length).toBe(bundled.length + 2);
    const json = sink();
    expect(
      await runCli(["sites", "--json"], { ...options, stdout: json }),
    ).toBe(0);
    const data = JSON.parse(json.text());
    expect(Object.keys(data).sort()).toEqual(["packs", "skipped"]);
    expect(data.packs.find((pack) => pack.id === "local-lab")).toEqual({
      id: "local-lab",
      name: "Local lab",
      source: "workspace",
      dir: join(sites, "local-lab"),
      domains: ["127.0.0.1"],
      notes: ["notes/overview.md"],
      tools: [
        {
          name: "list_products",
          kind: "node",
          description: "List the products the lab page shows.",
        },
        {
          name: "cart_total",
          kind: "page",
          description: "Read the total the cart page shows.",
        },
      ],
    });
    expect(data.skipped).toEqual([
      {
        path: broken,
        source: "workspace",
        problem: "format: format must be 1.",
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sites <url> prints notes, tools and examples", async () => {
    const { sites, env: siteEnv } = await siteWorkspace();
    const dir = await writeSitePack(
      sites,
      "github",
      {
        format: 1,
        id: "github",
        name: "GitHub",
        domains: ["*.github.com"],
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
              limit: {
                type: "integer",
                description: "How many results to read, 1 to 50.",
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
            description: "Read the stars, forks and topics the page shows.",
            file: "page-tools/repository-stats.js",
            returns: {
              type: "object",
              description: "{ fullName, stars, forks } or null",
            },
          },
        },
      },
      {
        "notes/overview.md":
          "Gists live on gist.github.com.\nA search page lists repositories.\n",
        "tools/search-repositories.mjs":
          "export const searchRepositories = async () => [];\n",
        "page-tools/repository-stats.js": "() => null\n",
      },
    );
    const fetch = noConnection();
    const options = { env: siteEnv, fetch, connect: { allowLaunch: false } };
    const stdout = sink();
    expect(
      await runCli(["sites", "https://gist.github.com/x"], {
        ...options,
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toBe(
      [
        'github "GitHub" (workspace, matches *.github.com)',
        dir,
        "--- notes/overview.md",
        "Gists live on gist.github.com.",
        "A search page lists repositories.",
        "search_repositories query: string, limit?: integer",
        "  Search repositories and read the first results.",
        "  returns array: [{ fullName, url, description, stars, language }]",
        '  await runSiteTool("github", "search_repositories", { query: "<query>" }, { page })',
        "repository_stats (page tool, needs page scripts)",
        "  Read the stars, forks and topics the page shows.",
        "  returns object: { fullName, stars, forks } or null",
        '  await runPageTool("github", "repository_stats", {}, { page })',
        "",
      ].join("\n"),
    );
    const empty = sink();
    expect(
      await runCli(["sites", "https://example.invalid/"], {
        ...options,
        stdout: empty,
      }),
    ).toBe(0);
    expect(empty.text()).toBe("No site pack matches example.invalid.\n");
    const blank = sink();
    expect(
      await runCli(["sites", "about:blank"], { ...options, stdout: blank }),
    ).toBe(0);
    expect(blank.text()).toBe("No site pack matches about:blank.\n");
    const json = sink();
    expect(
      await runCli(["sites", "gist.github.com", "--json"], {
        ...options,
        stdout: json,
      }),
    ).toBe(0);
    const data = JSON.parse(json.text());
    expect(data).toMatchObject({
      url: "https://gist.github.com/",
      host: "gist.github.com",
      skipped: [],
    });
    expect(data.packs[0]).toMatchObject({
      id: "github",
      source: "workspace",
      dir,
      matchedBy: "*.github.com",
    });
    expect(data.packs[0].notes).toEqual([
      {
        file: "notes/overview.md",
        text: "Gists live on gist.github.com.\nA search page lists repositories.\n",
      },
    ]);
    await expect(
      runCli(["sites", "not a host"], options),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(
      await main(["sites", "not a host"], {
        ...options,
        stdout: sink(),
        stderr: sink(),
      }),
    ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sites check exits 1 with problems by file and line, 0 when clean", async () => {
    const { sites, env: siteEnv } = await siteWorkspace();
    await writeSitePack(sites, "local-lab", labPack, labFiles);
    const brokenDir = await writeSitePack(
      sites,
      "broken",
      { ...labPack, id: "broken", name: "Broken" },
      {
        ...labFiles,
        "notes/overview.md":
          "The lab serves /packs/products.\nOpen @e3 to buy.\n",
      },
    );
    const refusal =
      'holds the temporary ref @e3. Refs change with every snapshot; use a locator such as role=button[name="Save"].';
    const fetch = noConnection();
    const options = { env: siteEnv, fetch, connect: { allowLaunch: false } };
    const bundled = await bundledPackIds();
    const passed = 1 + bundled.length;
    const stdout = sink();
    expect(await runCli(["sites", "check"], { ...options, stdout })).toBe(1);
    const lines = stdout.text().trimEnd().split("\n");
    expect(lines).toContain("ok local-lab (workspace)");
    expect(lines).toContain(`broken: notes/overview.md:2: ${refusal}`);
    expect(lines.at(-1)).toBe(
      `${passed} pack${passed === 1 ? "" : "s"} passed and 1 failed.`,
    );
    const one = sink();
    expect(
      await runCli(["sites", "check", "local-lab"], {
        ...options,
        stdout: one,
      }),
    ).toBe(0);
    expect(one.text()).toBe("ok local-lab (workspace)\n1 pack passed.\n");
    const folder = sink();
    expect(
      await runCli(["sites", "check", join(sites, "local-lab")], {
        ...options,
        stdout: folder,
      }),
    ).toBe(0);
    expect(folder.text()).toBe("ok local-lab (workspace)\n1 pack passed.\n");
    // A pack outside both roots is checked where it sits, so it can be read
    // before it is moved into the workspace.
    const elsewhere = await mkdtemp(join(tmpdir(), "kamapathy-cli-pack-"));
    directories.push(elsewhere);
    const away = await writeSitePack(elsewhere, "local-lab", labPack, labFiles);
    const apart = sink();
    expect(
      await runCli(["sites", "check", away], { ...options, stdout: apart }),
    ).toBe(0);
    expect(apart.text()).toBe("ok local-lab (workspace)\n1 pack passed.\n");
    const unknown = sink();
    expect(
      await runCli(["sites", "check", "nope"], { ...options, stdout: unknown }),
    ).toBe(1);
    expect(unknown.text()).toBe(
      'No site pack named "nope".\n0 packs passed.\n',
    );
    const json = sink();
    expect(
      await runCli(["sites", "check", "broken", "--json"], {
        ...options,
        stdout: json,
      }),
    ).toBe(1);
    const data = JSON.parse(json.text());
    expect(Object.keys(data).sort()).toEqual(["ok", "packs"]);
    expect(data).toEqual({
      ok: false,
      packs: [
        {
          id: "broken",
          source: "workspace",
          dir: brokenDir,
          ok: false,
          problems: [{ file: "notes/overview.md", line: 2, message: refusal }],
        },
      ],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("repl runs top-level await with the globals, prints queued notices once before the next prompt, aborts in-flight calls on SIGINT and needs a terminal", async () => {
    await expect(
      runCli(["repl"], {
        env,
        fetch: vi.fn(),
        stdin: new PassThrough(),
        stdout: sink(),
      }),
    ).rejects.toThrow("repl needs a terminal. Pipe a script to run - instead.");
    const api = fakeApi({
      ...sectionTwo,
      "GET /spaces": (_body, options) =>
        new Promise((_done, reject) =>
          options.signal.addEventListener("abort", () =>
            reject(options.signal.reason),
          ),
        ),
    });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => (text += chunk));
    const ended = runCli(["repl"], {
      env,
      fetch: api.fetch,
      health: level2,
      stdin: input,
      stdout: output,
      terminal: true,
    });
    const entry = async (code, expected) => {
      input.write(`${code}\n`);
      await expect.poll(() => text).toContain(expected);
    };
    await expect
      .poll(() => text)
      .toContain(
        "Kamapathy scripting session. Type help() for the API and .exit to leave.",
      );
    await entry('const replSpace = await space("space-1")', "kamapathy> ");
    await entry("replSpace.name", "'Research'");
    queueNotice("repl-test", "A notice for this session.");
    await entry("1 + 1", "2");
    await entry("2 + 2", "4");
    expect(text.split("notice: A notice for this session.").length).toBe(2);
    expect(text.indexOf("notice: A notice for this session.")).toBeGreaterThan(
      text.indexOf("\n2"),
    );
    input.write("await spaces()\n");
    await expect
      .poll(() => api.requests.some((request) => request.path === "/spaces"))
      .toBe(true);
    input.write("\u0003");
    await expect
      .poll(() => text)
      .toContain(
        "error: interrupted: The entry was stopped by Ctrl+C. A call in progress may still have taken effect, so inspect the page before retrying.",
      );
    await entry("typeof openSpace", "'function'");
    input.write(".exit\n");
    expect(await ended).toBe(0);
  }, 20000);

  it("prints help for every command and topic without connecting", async () => {
    const fetch = vi.fn();
    const launch = vi.fn();
    const stdin = new PassThrough();
    const help = async (args) => {
      const stdout = sink();
      expect(
        await runCli(args, { env, fetch, connect: { launch }, stdin, stdout }),
        args.join(" "),
      ).toBe(0);
      return stdout.text();
    };
    for (const command of schema.COMMANDS) {
      const text = await help(["help", ...command.name.split(" ")]);
      expect(text, command.name).toContain(command.usage);
      expect(text, command.name).toContain(command.summary);
      if (command.name !== "help") {
        expect(await help([...command.name.split(" "), "--help"])).toBe(text);
        expect(await help([...command.name.split(" "), "-h"])).toBe(text);
      }
    }
    expect(await help(["help", "api"])).toContain("Kamapathy script API");
    expect(await help(["help", "api", "page.click"])).toContain(
      "page.click(target, options?)",
    );
    expect(await help(["help", "errors"])).toContain("human_control");
    expect(await help(["help", "routes"])).toContain("POST /tabs/:id/click");
    expect(await help(["help", "page.wait"])).toContain("page.wait(options?)");
    expect(await help(["help", "--json"])).toBe(await help(["help"]));
    expect(await help(["--help"])).toBe(await help(["help"]));
    expect(fetch).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it("ends general help with this client's SKILL.md", async () => {
    const stdout = sink();
    await runCli(["help"], { env, stdout });
    const skill = await realpathOf(
      join(process.cwd(), "skills/kamapathy/SKILL.md"),
    );
    expect(
      stdout
        .text()
        .endsWith(
          `Agents: read the Kamapathy skill before using these commands.\n  ${skill}\nIn run scripts, help() lists the API and help("page.click") shows one entry.\n`,
        ),
    ).toBe(true);
    expect(stdout.text()).toContain("Requires Node.js 22.13 or later.");
    for (const name of [
      "KAMAPATHY_USER_DATA",
      "KAMAPATHY_NO_LAUNCH",
      "KAMAPATHY_WORKSPACE",
      "KAMAPATHY_RUN_TIMEOUT_MS",
      "KAMAPATHY_PAGE_BUDGET",
      "KAMAPATHY_PROGRAM",
      "--version",
    ])
      expect(stdout.text(), name).toContain(name);
  });

  it("names the program kamapathy only when KAMAPATHY_PROGRAM is set", async () => {
    const named = sink();
    await runCli(["help", "click"], {
      env: { ...env, KAMAPATHY_PROGRAM: "launcher-secret" },
      stdout: named,
    });
    expect(named.text()).toContain(
      "Usage: kamapathy click <tab-id> <ref-or-selector>",
    );
    expect(named.text()).not.toContain("launcher-secret");
    const plain = sink();
    await runCli(["help", "click"], { env, stdout: plain });
    expect(plain.text()).toContain(
      `Usage: node ${join(process.cwd(), "skills/kamapathy/scripts/kamapathy.mjs")} click <tab-id> <ref-or-selector>`,
    );
  });

  it("reports unknown topics with close matches and status 1", async () => {
    const stderr = sink();
    expect(
      await main(["help", "snapshto"], { env, stdout: sink(), stderr }),
    ).toBe(1);
    expect(stderr.text()).toBe(
      'Kamapathy: No help topic "snapshto". Close matches: snapshot.\n',
    );
    const none = sink();
    expect(
      await main(["help", "zzzzzz"], { env, stdout: sink(), stderr: none }),
    ).toBe(1);
    expect(none.text()).toBe('Kamapathy: No help topic "zzzzzz".\n');
  });

  it("reads arguments after -- literally", async () => {
    const fetch = vi.fn(async () => Response.json({ space }));
    const stdout = sink();
    expect(
      await runCli(["space", "create", "--", "--help"], { env, fetch, stdout }),
    ).toBe(0);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: "--help" });
    expect(stdout.text()).toBe('space space-1 "Research" agent shared\n');
    await runCli(["space", "create", "--", "--json"], {
      env,
      fetch,
      stdout: sink(),
    });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ name: "--json" });
  });

  it("prints versions without starting Kamapathy", async () => {
    const launch = vi.fn();
    const skillFolder = await realpathOf(
      join(process.cwd(), "skills/kamapathy"),
    );
    const client = `Kamapathy client ${schema.CLIENT_VERSION}, API level ${schema.API_LEVEL}, Node ${process.versions.node}\nSkill ${skillFolder}\n`;
    const version = async (argv, profileEnv) => {
      const stdout = sink();
      expect(
        await main(argv, {
          env: profileEnv,
          connect: { launch },
          stdout,
          stderr: sink(),
        }),
      ).toBe(0);
      return stdout.text();
    };
    const running = await profile();
    // An app at this client's own level, so the plain lines are all it prints.
    const health = {
      status: "ok",
      version: "0.2.0",
      apiLevel: schema.API_LEVEL,
      versions: {
        electron: "44.2.0",
        chromium: "152.0.7977.76",
        node: "24.20.0",
        v8: "x",
      },
    };
    await fakeKamapathy(running.paths, {
      handler: (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(health));
      },
    });
    const runningEnv = { KAMAPATHY_USER_DATA: running.userData };
    expect(await version(["--version"], runningEnv)).toBe(
      `${client}Kamapathy 0.2.0, API level ${schema.API_LEVEL}, Electron 44.2.0, Chromium 152.0.7977.76, Node 24.20.0\n`,
    );
    expect(await version(["-v"], runningEnv)).toBe(
      await version(["--version"], runningEnv),
    );
    expect(
      JSON.parse(await version(["--version", "--json"], runningEnv)),
    ).toEqual({
      client: {
        version: schema.CLIENT_VERSION,
        apiLevel: schema.API_LEVEL,
        node: process.versions.node,
        skill: skillFolder,
      },
      app: {
        version: "0.2.0",
        apiLevel: schema.API_LEVEL,
        electron: "44.2.0",
        chromium: "152.0.7977.76",
        node: "24.20.0",
      },
      appStatus: "running",
    });
    const idle = await profile();
    expect(
      await version(["--version"], { KAMAPATHY_USER_DATA: idle.userData }),
    ).toBe(`${client}Kamapathy is not running.\n`);
    expect(
      JSON.parse(
        await version(["--version", "--json"], {
          KAMAPATHY_USER_DATA: idle.userData,
        }),
      ),
    ).toMatchObject({
      app: null,
      appStatus: "not_running",
    });
    await writeFile(idle.paths.off, "", { mode: 0o600 });
    expect(
      await version(["--version"], { KAMAPATHY_USER_DATA: idle.userData }),
    ).toBe(`${client}Agent access is off in Kamapathy.\n`);
    const older = await profile();
    await fakeKamapathy(older.paths, {
      handler: (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "ok", version: "0.1.9" }));
      },
    });
    expect(
      await version(["--version"], { KAMAPATHY_USER_DATA: older.userData }),
    ).toBe(
      `${client}Kamapathy 0.1.9, API level 1\nKamapathy 0.1.9 has API level 1 and this client uses ${schema.API_LEVEL}. Calls added after level 1 fail until the person updates Kamapathy.\n`,
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("help() in a run prints the index and one entry", async () => {
    const { env: profileEnv } = await profile();
    const run = await spawnCli(
      ["run", "-e", 'help(); help("page.click"); help("clik"); help("close");'],
      profileEnv,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(
      `Kamapathy script API, client ${schema.CLIENT_VERSION}, API level ${schema.API_LEVEL}`,
    );
    expect(run.stdout).toContain(
      'help("page.click") shows one entry; help("errors") lists error codes.',
    );
    expect(run.stdout).toContain("page.click(target, options?)\n");
    expect(run.stdout).toContain(
      'No help entry named "clik". Close matches: page.click, page.mouse.click.',
    );
    expect(run.stdout).toContain("space.close()\n");
    expect(run.stdout).toContain("page.close()\n");
  }, 20000);

  it("creates isolated spaces from the command line and says how each space signs in", async () => {
    for (const [args, body] of [
      [["space", "create", "Research"], { name: "Research" }],
      [
        ["space", "create", "Research", "--isolated"],
        { name: "Research", isolated: true },
      ],
      [
        ["space", "create", "--isolated", "Research"],
        { name: "Research", isolated: true },
      ],
    ]) {
      const fetch = vi.fn(async () => Response.json({ space }));
      expect(await runCli(args, { env, fetch, stdout: sink() })).toBe(0);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
    }
    for (const [signIns, suffix] of [
      ["separate", " isolated"],
      ["shared", " shared"],
      [undefined, ""],
    ]) {
      const created = sink();
      await runCli(["space", "create", "Research"], {
        env,
        fetch: vi.fn(async () =>
          Response.json({ space: { ...space, signIns } }),
        ),
        stdout: created,
      });
      expect(created.text()).toBe(`space space-1 "Research" agent${suffix}\n`);
      const listed = sink();
      await runCli(["spaces"], {
        env,
        fetch: vi.fn(async () =>
          Response.json({ spaces: [{ ...space, signIns }] }),
        ),
        stdout: listed,
      });
      expect(listed.text()).toBe(`space-1 "Research" agent${suffix}\n`);
    }
    const help = sink();
    await runCli(["help"], { env, fetch: vi.fn(), stdout: help });
    expect(help.text()).toContain("--isolated");
    expect(help.text()).toMatch(/\n  run /);
  });

  // Section 4: the client and CLI reach the snapshot and screenshot options.
  const level3 = { status: "ok", version: "0.3.0", apiLevel: 3 };
  const level3Routes = { ...routes, "GET /spaces/space-1": { space } };
  // A PNG whose IHDR carries the pixel size, as Chromium encodes it.
  const pngOf = (width, height) => {
    const bytes = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "ascii");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
  };
  const header = {
    page: { id: "tab-1", label: "p2", title: "Checkout" },
    space: {
      id: "6f1c9a2e-3b0d-4c55-9e1a-2d7b8c4f0a11",
      name: "Reserve a table",
    },
    tabs: [
      {
        id: "tab-0",
        label: "p1",
        title: "Home",
        openedBy: "agent",
        managed: true,
      },
      {
        id: "tab-1",
        label: "p2",
        title: "Checkout",
        openedBy: "agent",
        managed: true,
        current: true,
      },
      {
        id: "tab-2",
        label: "p3",
        title: "Receipt",
        openedBy: "page",
        managed: true,
      },
      {
        id: "tab-3",
        label: "p4",
        title: "Menu",
        openedBy: "person",
        managed: false,
      },
    ],
    budget: { used: 3, limit: 4 },
  };
  const headerLine =
    'page p2 "Checkout" | space "Reserve a table" 6f1c9a2e-3b0d-4c55-9e1a-2d7b8c4f0a11 | tabs: p1 "Home", p2 "Checkout" (this page), p3 "Receipt" (popup), p4 "Menu" (person) (unmanaged) | budget 3 of 4';

  it("page.screenshot checks options before sending", async () => {
    const api = fakeApi(level3Routes);
    const client = await connect({ env, fetch: api.fetch, health: level3 });
    const page = await (
      await client.space("space-1")
    ).open("https://example.test/reserve");
    const sent = api.requests.length;
    await expect(page.screenshot({ timeoutMs: 5000 })).rejects.toMatchObject({
      code: "invalid_option",
      entry: "page.screenshot",
      option: "timeoutMs",
      suggestion: "timeout",
      expected: "page.screenshot(options?) or page.screenshot(path)",
    });
    await expect(page.screenshot({ scale: 2 })).rejects.toMatchObject({
      code: "invalid_option",
      entry: "page.screenshot",
      option: "scale",
    });
    await expect(page.screenshot({ timeout: 0 })).rejects.toMatchObject({
      code: "invalid_option",
      option: "timeout",
    });
    expect(api.requests.length).toBe(sent);
  });

  it("page.screenshot with options posts them and resolves to the PNG bytes", async () => {
    const bytes = pngOf(640, 400);
    const api = fakeApi({
      ...level3Routes,
      "POST /tabs/tab-1/screenshot": () =>
        new Response(bytes, {
          headers: {
            "Content-Type": "image/png",
            "X-Kamapathy-Clip": "0,0,640,400",
            "X-Kamapathy-Pixel-Ratio": "1",
          },
        }),
    });
    const client = await connect({ env, fetch: api.fetch, health: level3 });
    const page = await (
      await client.space("space-1")
    ).open("https://example.test/reserve");
    const captured = await page.screenshot({
      fullPage: true,
      clip: { x: 0, y: 0, width: 640, height: 400 },
      scale: "device",
      timeout: 3000,
    });
    expect(Buffer.isBuffer(captured)).toBe(true);
    expect([...captured]).toEqual([...bytes]);
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/screenshot",
      body: {
        fullPage: true,
        clip: { x: 0, y: 0, width: 640, height: 400 },
        scale: "device",
        timeoutMs: 3000,
      },
    });
    // The route's own field budget sets the HTTP timeout: timeout plus 5000 ms.
    const route = schema.ROUTES.find(
      (item) => schema.routeKey(item) === "POST /tabs/:id/screenshot",
    );
    expect(
      httpTimeout(schema.requestBudget(route, { timeoutMs: 3000 }), route),
    ).toBe(8000);
    expect(httpTimeout(schema.requestBudget(route, {}), route)).toBe(20000);
    const png = `${await scratchFile()}.png`;
    expect([...(await page.screenshot({ path: png }))]).toEqual([...bytes]);
    expect([...(await readFile(png))]).toEqual([...bytes]);
    expect(api.requests.at(-1).body).toEqual({});
    await expect(page.screenshot({ path: png })).rejects.toThrow("EEXIST");
    await expect(page.screenshot({ path: `${png}.jpg` })).rejects.toThrow(
      ".png",
    );
    // A path string keeps today's GET flow and answer.
    const saved = `${await scratchFile()}.png`;
    expect(await page.screenshot(saved)).toBe(saved);
    expect(api.requests.at(-1)).toEqual({
      method: "GET",
      path: "/tabs/tab-1/screenshot",
      body: undefined,
    });
    // The options form needs level 3; the path form does not.
    const older = fakeApi(level3Routes);
    const old = await connect({ env, fetch: older.fetch, health: level2 });
    const [page2] = await (await old.space("space-1")).tabs();
    const requests = older.requests.length;
    await expect(page2.screenshot({ fullPage: true })).rejects.toMatchObject({
      code: "app_outdated",
      entry: "page.screenshot",
      required: 3,
      available: 2,
    });
    await expect(page2.screenshot()).rejects.toMatchObject({
      code: "app_outdated",
      required: 3,
    });
    expect(older.requests.length).toBe(requests);
    expect(await page2.screenshot(`${await scratchFile()}.png`)).toMatch(
      /\.png$/,
    );
  });

  it("snapshot flags send scope, root, format, locators, header and cursor", async () => {
    const api = fakeApi(level3Routes);
    expect(
      await runCli(
        [
          "snapshot",
          "tab-1",
          "--viewport",
          "--root",
          "@e5",
          "--outline",
          "--locators",
          "--no-header",
          "--cursor",
          "c1.x",
        ],
        { env, fetch: api.fetch, health: level3, stdout: sink() },
      ),
    ).toBe(0);
    expect(api.requests.at(-1).body).toEqual({
      mode: "compact",
      scope: "viewport",
      root: "@e5",
      format: "outline",
      locators: true,
      header: false,
      cursor: "c1.x",
    });
    const older = fakeApi(routes);
    await expect(
      runCli(["snapshot", "tab-1", "--viewport", "--outline"], {
        env,
        fetch: older.fetch,
        health: level2,
        stdout: sink(),
      }),
    ).rejects.toMatchObject({
      code: "app_outdated",
      option: "scope",
      required: 3,
      available: 2,
      message:
        'snapshot option "scope" needs Kamapathy API level 3, and Kamapathy 0.2.0 has level 2. Ask the person to update Kamapathy, then read the skill again.',
    });
    expect(older.requests).toEqual([]);
    const fetch = vi.fn();
    for (const args of [
      ["snapshot", "tab-1", "--root"],
      ["snapshot", "tab-1", "--cursor"],
      ["snapshot", "tab-1", "--scope", "viewport"],
    ])
      await expect(
        runCli(args, { env, fetch, stdout: sink() }),
        args.join(" "),
      ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("prints the header line, the outline, locators and the next cursor", async () => {
    const outlined = {
      tabId: "tab-1",
      url: "https://example.test/checkout",
      title: "Checkout",
      header,
      outline: [
        'main "Checkout"',
        '  heading "Your order" level=2',
        "  list",
        '    listitem "Table for two"',
        '  link "Help" @e3 href=/help',
        '  button "Save" @e4 locator: css=#save',
      ].join("\n"),
      interactables: [
        {
          ref: "@e3",
          role: "link",
          label: "Help",
          href: "https://example.test/help",
        },
        { ref: "@e4", role: "button", label: "Save", locator: "css=#save" },
      ],
      omittedControls: 0,
      truncated: true,
      next: "c1.eyJlIjoxfQ",
    };
    const api = fakeApi({
      ...level3Routes,
      "POST /tabs/tab-1/snapshot": outlined,
    });
    const stdout = sink();
    expect(
      await runCli(["snapshot", "tab-1", "--outline", "--locators"], {
        env,
        fetch: api.fetch,
        health: level3,
        stdout,
      }),
    ).toBe(0);
    expect(stdout.text()).toBe(
      [
        headerLine,
        "https://example.test/checkout",
        "",
        'main "Checkout"',
        '  heading "Your order" level=2',
        "  list",
        '    listitem "Table for two"',
        '  link "Help" @e3 href=/help',
        '  button "Save" @e4 locator: css=#save',
        "",
        "Next part: cursor c1.eyJlIjoxfQ",
        "",
      ].join("\n"),
    );
    const client = await connect({ env, fetch: api.fetch, health: level3 });
    const page = await (
      await client.space("space-1")
    ).open("https://example.test/reserve");
    expect(`${await page.text({ format: "outline", locators: true })}\n`).toBe(
      stdout.text(),
    );
    // A list snapshot: locator suffixes, the unchecked-locator note, a PDF
    // header, and no Truncated line while a cursor continues it.
    const listed = {
      ...outlined,
      outline: undefined,
      text: "Your order",
      locatorsIncomplete: true,
      omittedControls: 2,
      header: { ...header, budget: undefined, pdf: true },
    };
    const parts = fakeApi({
      ...level3Routes,
      "POST /tabs/tab-1/snapshot": listed,
    });
    const second = sink();
    await runCli(["snapshot", "tab-1", "--locators", "--cursor", "c1.x"], {
      env,
      fetch: parts.fetch,
      health: level3,
      stdout: second,
    });
    expect(second.text()).toBe(
      [
        `${headerLine.replace(" | budget 3 of 4", "")} | pdf: read it with pdfText()`,
        "https://example.test/checkout",
        "",
        "Your order",
        "",
        "Controls:",
        '@e3 link "Help"',
        '@e4 button "Save" locator: css=#save',
        "2 more controls not listed. Scope with --selector to list them.",
        "Some locators were not checked in time.",
        "",
        "Next part: cursor c1.eyJlIjoxfQ",
        "",
      ].join("\n"),
    );
    // Without a header the title line comes back, and a last part says it was
    // truncated.
    const last = {
      ...listed,
      header: undefined,
      next: undefined,
      locatorsIncomplete: undefined,
      omittedControls: 0,
    };
    const bare = fakeApi({
      ...level3Routes,
      "POST /tabs/tab-1/snapshot": last,
    });
    const third = sink();
    await runCli(["snapshot", "tab-1", "--no-header"], {
      env,
      fetch: bare.fetch,
      health: level3,
      stdout: third,
    });
    expect(third.text().split("\n")[0]).toBe("Checkout");
    expect(third.text()).toContain(
      "Truncated. Scope with --selector or request --full if needed.",
    );
  });

  it("screenshot flags post the options and print the saved size", async () => {
    const bytes = pngOf(1280, 3200);
    const png = `${await scratchFile()}.png`;
    const fetch = vi.fn(
      async () =>
        new Response(bytes, {
          headers: {
            "Content-Type": "image/png",
            "X-Kamapathy-Clip": "0,0,1280,3200",
            "X-Kamapathy-Pixel-Ratio": "2",
          },
        }),
    );
    const stdout = sink();
    expect(
      await runCli(
        ["screenshot", "tab-1", png, "--full-page", "--scale", "device"],
        {
          env,
          fetch,
          health: level3,
          stdout,
        },
      ),
    ).toBe(0);
    const [url, options] = fetch.mock.calls[0];
    expect([url.pathname, options.method]).toEqual([
      "/tabs/tab-1/screenshot",
      "POST",
    ]);
    expect(JSON.parse(options.body)).toEqual({
      fullPage: true,
      scale: "device",
    });
    expect(stdout.text()).toBe(`saved ${png} (1280x3200)\n`);
    const clipped = `${await scratchFile()}.png`;
    const json = sink();
    await runCli(
      ["screenshot", "tab-1", clipped, "--clip", "10,20,30.5,40", "--json"],
      {
        env,
        fetch,
        health: level3,
        stdout: json,
      },
    );
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      clip: { x: 10, y: 20, width: 30.5, height: 40 },
    });
    expect(JSON.parse(json.text())).toEqual({
      saved: clipped,
      width: 1280,
      height: 3200,
      clip: { x: 0, y: 0, width: 1280, height: 3200 },
      pixelRatio: 2,
    });
    // Without flags it stays a GET, and bytes without an IHDR print no size.
    const plainFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        }),
    );
    const small = `${await scratchFile()}.png`;
    const plain = sink();
    expect(
      await runCli(["screenshot", "tab-1", small], {
        env,
        fetch: plainFetch,
        stdout: plain,
      }),
    ).toBe(0);
    expect(plainFetch.mock.calls[0][1].method).toBe("GET");
    expect(plain.text()).toBe(`saved ${small}\n`);
    // Flags are checked before anything connects.
    const refused = vi.fn();
    const unwritten = `${await scratchFile()}.png`;
    for (const args of [
      ["screenshot", "tab-1", unwritten, "--clip", "10,20,30"],
      ["screenshot", "tab-1", unwritten, "--clip", "a,b,c,d"],
      ["screenshot", "tab-1", unwritten, "--clip", "10,20,,40"],
      ["screenshot", "tab-1", unwritten, "--clip"],
      ["screenshot", "tab-1", unwritten, "--scale", "retina"],
      ["screenshot", "tab-1", unwritten, "--crop"],
    ])
      await expect(
        runCli(args, { env, fetch: refused, stdout: sink() }),
        args.join(" "),
      ).rejects.toThrow();
    await expect(
      runCli(["screenshot", "tab-1", unwritten, "--full-page"], {
        env,
        fetch: refused,
        health: level2,
        stdout: sink(),
      }),
    ).rejects.toMatchObject({
      code: "app_outdated",
      required: 3,
      available: 2,
    });
    expect(refused).not.toHaveBeenCalled();
    expect(existsSync(unwritten)).toBe(false);
  });

  it("prints invalid_selector hints and ambiguous_match candidates under the error line", async () => {
    const stderr = sink();
    const hinted = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "invalid_selector",
            message: "Refs are written @e12.",
            selector: "@21",
            reason: "ref_form",
            forms: [],
            hint: 'Write a ref as @e21, or quote a selector such as [id="21"].',
          },
        },
        { status: 400 },
      ),
    );
    expect(
      await main(["click", "tab-1", "@21"], {
        env,
        fetch: hinted,
        stdout: sink(),
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toBe(
      [
        "Kamapathy: 400 invalid_selector: Refs are written @e12.",
        'hint: Write a ref as @e21, or quote a selector such as [id="21"].',
        "",
      ].join("\n"),
    );
    const ambiguous = sink();
    const many = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "ambiguous_match",
            message:
              "Selector matched 3 elements (2 visible, 1 hidden). Use a ref from candidates or a more specific selector.",
            selector: "button",
            count: 3,
            visible: 2,
            hidden: 1,
            actionable: 2,
            candidates: [
              {
                ref: "@e7",
                tag: "button",
                role: "button",
                name: "Save",
                context: "Order form",
                visible: true,
                disabled: false,
              },
              {
                ref: "@e8",
                tag: "button",
                role: "button",
                name: "Save\ndraft",
                context: "",
                visible: true,
                disabled: true,
                frame: "#checkout",
              },
              {
                tag: "button",
                role: "button",
                name: "Save",
                context: "",
                visible: false,
                disabled: false,
              },
            ],
          },
        },
        { status: 422 },
      ),
    );
    expect(
      await main(["click", "tab-1", "button"], {
        env,
        fetch: many,
        stdout: sink(),
        stderr: ambiguous,
      }),
    ).toBe(1);
    expect(ambiguous.text()).toBe(
      [
        "Kamapathy: 422 ambiguous_match: Selector matched 3 elements (2 visible, 1 hidden). Use a ref from candidates or a more specific selector.",
        '  candidate @e7 button "Save" in "Order form"',
        '  candidate @e8 button "Save draft" [disabled] frame #checkout',
        '  candidate button "Save" (hidden)',
        "",
      ].join("\n"),
    );
  });

  it("help selectors prints the forms table without connecting", async () => {
    const fetch = vi.fn();
    const stdout = sink();
    expect(await runCli(["help", "selectors"], { env, fetch, stdout })).toBe(0);
    const text = stdout.text();
    expect(text.split("\n")[0]).toBe("Selectors");
    for (const form of schema.SELECTOR_FORMS)
      expect(text, form.form).toContain(form.example);
    expect(text).toContain(
      "Refs skip the search. Docs and help show only the css=, text=, role=, href= and xpath= spellings.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("status, --clear, fail and --label anywhere reach their routes, and spaces prints state and status", async () => {
    const level3 = { status: "ok", version: "0.2.0", apiLevel: 3 };
    const set = sink();
    const status = vi.fn(async () =>
      Response.json({ ok: true, status: "Comparing prices" }),
    );
    expect(
      await runCli(["status", "space-1", "Comparing prices"], {
        env,
        fetch: status,
        health: level3,
        stdout: set,
      }),
    ).toBe(0);
    expect(status).toHaveBeenCalledTimes(1);
    const [url, options] = status.mock.calls[0];
    expect([url.pathname, options.method]).toEqual([
      "/spaces/space-1/status",
      "POST",
    ]);
    expect(JSON.parse(options.body)).toEqual({ text: "Comparing prices" });
    expect(set.text()).toBe('ok: status "Comparing prices"\n');
    const cleared = sink();
    const clear = vi.fn(async () => Response.json({ ok: true }));
    expect(
      await runCli(["status", "space-1", "--clear"], {
        env,
        fetch: clear,
        health: level3,
        stdout: cleared,
      }),
    ).toBe(0);
    expect(JSON.parse(clear.mock.calls[0][1].body)).toEqual({ text: "" });
    expect(cleared.text()).toBe("ok: status cleared\n");
    const failed = sink();
    const reported = {
      ok: true,
      owner: "human",
      state: "failed",
      status: "The site needs a phone number",
    };
    const fail = vi.fn(async () => Response.json(reported));
    expect(
      await runCli(["fail", "space-1", "The site needs a phone number"], {
        env,
        fetch: fail,
        health: level3,
        stdout: failed,
      }),
    ).toBe(0);
    expect(fail.mock.calls[0][0].pathname).toBe("/spaces/space-1/fail");
    expect(JSON.parse(fail.mock.calls[0][1].body)).toEqual({
      message: "The site needs a phone number",
    });
    expect(failed.text()).toBe(
      "ok: failure reported, the person has control\n",
    );
    const json = sink();
    await runCli(["fail", "space-1", "No number", "--json"], {
      env,
      fetch: fail,
      health: level3,
      stdout: json,
    });
    expect(JSON.parse(json.text())).toEqual(reported);
    // A status needs either a text or --clear, never both and never neither.
    const unused = vi.fn();
    for (const args of [
      ["status", "space-1", "Later", "--clear"],
      ["status", "space-1"],
      ["fail", "space-1"],
    ]) {
      const stderr = sink();
      expect(
        await main(args, { env, fetch: unused, health: level3, stderr }),
        args.join(" "),
      ).toBe(1);
      expect(stderr.text(), args.join(" ")).toContain("Kamapathy: ");
    }
    expect(unused).not.toHaveBeenCalled();
    // --label is read wherever it sits, and reaches the body once.
    for (const args of [
      ["click", "--label", "Add to cart", "tab-1", "@e2"],
      ["click", "tab-1", "--label", "Add to cart", "@e2"],
      ["click", "tab-1", "@e2", "--label", "Add to cart"],
    ]) {
      const labeled = vi.fn(async () =>
        Response.json({ ok: true, url: tab.url }),
      );
      expect(
        await runCli(args, {
          env,
          fetch: labeled,
          health: level3,
          stdout: sink(),
        }),
        args.join(" "),
      ).toBe(0);
      expect(labeled.mock.calls[0][0].pathname).toBe("/tabs/tab-1/click");
      expect(JSON.parse(labeled.mock.calls[0][1].body)).toEqual({
        ref: "@e2",
        label: "Add to cart",
      });
    }
    for (const [args, body] of [
      [
        ["fill", "tab-1", "@e1", "--label", "Name the guest", "--stdin"],
        { ref: "@e1", value: "Avery Quinn", label: "Name the guest" },
      ],
      [
        ["press", "--label", "Submit the form", "tab-1", "Enter"],
        { key: "Enter", label: "Submit the form" },
      ],
      [
        ["press", "tab-1", "Enter", "@e1", "--label", "Submit the form"],
        { key: "Enter", ref: "@e1", label: "Submit the form" },
      ],
      [
        ["scroll", "tab-1", "down", "--label", "Read the terms"],
        { direction: "down", label: "Read the terms" },
      ],
      [
        ["scroll", "tab-1", "down", "300", "@e1", "--label", "Read the terms"],
        { direction: "down", pixels: 300, ref: "@e1", label: "Read the terms" },
      ],
      [
        ["scroll", "--label", "Read the panel", "tab-1", "down", ".panel"],
        { direction: "down", selector: ".panel", label: "Read the panel" },
      ],
      [
        ["drag", "tab-1", "@e1", "--label", "Reorder the list", "#zone"],
        {
          source: { ref: "@e1" },
          target: { selector: "#zone" },
          label: "Reorder the list",
        },
      ],
    ]) {
      const labeled = vi.fn(async () =>
        Response.json({ ok: true, url: tab.url }),
      );
      expect(
        await runCli(args, {
          env,
          fetch: labeled,
          health: level3,
          stdin: Readable.from(["Avery Quinn"]),
          stdout: sink(),
        }),
        args.join(" "),
      ).toBe(0);
      expect(JSON.parse(labeled.mock.calls[0][1].body), args.join(" ")).toEqual(
        body,
      );
    }
    // Commands without a label keep today's unknown-option error.
    const refused = sink();
    expect(
      await main(["wait-for-control", "space-1", "--label", "Waiting"], {
        env,
        fetch: unused,
        health: level3,
        stderr: refused,
      }),
    ).toBe(1);
    expect(refused.text()).toBe(
      "Kamapathy: Unknown option: --label. Run help for usage.\n",
    );
    const twice = sink();
    expect(
      await main(
        ["click", "tab-1", "@e2", "--label", "One", "--label", "Two"],
        { env, fetch: unused, health: level3, stderr: twice },
      ),
    ).toBe(1);
    expect(twice.text()).toContain("--label");
    expect(unused).not.toHaveBeenCalled();
    // Each listed space shows its state and the status the person reads.
    const listed = sink();
    await runCli(["spaces"], {
      env,
      health: level3,
      fetch: vi.fn(async () =>
        Response.json({
          spaces: [
            {
              ...space,
              state: "failed",
              status: "The site needs a phone number",
            },
            { ...space, id: "space-2", state: "needs-you" },
            { ...space, id: "space-3", status: "Comparing prices" },
            { ...space, id: "space-4" },
          ],
        }),
      ),
      stdout: listed,
    });
    expect(listed.text()).toBe(
      [
        'space-1 "Research" agent shared failed status "The site needs a phone number"',
        'space-2 "Research" agent shared needs-you',
        'space-3 "Research" agent shared status "Comparing prices"',
        'space-4 "Research" agent shared',
        "",
      ].join("\n"),
    );
    const help = sink();
    await runCli(["help"], { env, fetch: vi.fn(), stdout: help });
    expect(help.text()).toContain(
      "status <space-id> <text> | status <space-id> --clear",
    );
    expect(help.text()).toContain("fail <space-id> <message>");
  });

  it("the client keeps space.status and space.state in step and refuses bad arguments before connecting", async () => {
    const level3 = { status: "ok", version: "0.2.0", apiLevel: 3 };
    const api = fakeApi({
      ...routes,
      "GET /spaces": {
        spaces: [{ ...space, status: "Comparing prices", state: "needs-you" }],
      },
      "POST /spaces/space-1/status": (body) =>
        Response.json({
          ok: true,
          ...(body.text ? { status: body.text } : {}),
        }),
      "POST /spaces/space-1/fail": {
        ok: true,
        owner: "human",
        state: "failed",
        status: "The site needs a phone number",
      },
    });
    const client = await connect({ env, fetch: api.fetch, health: level3 });
    const [research] = await client.spaces();
    expect([research.status, research.state]).toEqual([
      "Comparing prices",
      "needs-you",
    ]);
    expect(await research.setStatus("Checking three sites")).toEqual({
      ok: true,
      status: "Checking three sites",
    });
    expect(research.status).toBe("Checking three sites");
    for (const text of [null, ""]) {
      expect(await research.setStatus(text), String(text)).toEqual({
        ok: true,
      });
      expect(research.status, String(text)).toBeUndefined();
    }
    expect(await research.fail("The site needs a phone number")).toEqual({
      ok: true,
      owner: "human",
      state: "failed",
      status: "The site needs a phone number",
    });
    expect([research.owner, research.state, research.status]).toEqual([
      "human",
      "failed",
      "The site needs a phone number",
    ]);
    // A label on every input method reaches its body.
    const page = await research.open("https://example.test/reserve");
    await page.click("@e2", { label: "Check availability" });
    await page.fill("@e1", "Avery Quinn", { label: "Name the guest" });
    await page.press("Enter", "@e1", { label: "Submit the form" });
    await page.press("Escape", undefined, { label: "Close the dialog" });
    await page.scroll("down", 300, "@e1", { label: "Read the terms" });
    await page.scroll("down", ".panel", { label: "Read the panel" });
    await page.drag("@e1", "#zone", { label: "Reorder the list" });
    await page.click("@e2");
    expect(api.requests).toEqual([
      { method: "GET", path: "/spaces", body: undefined },
      {
        method: "POST",
        path: "/spaces/space-1/status",
        body: { text: "Checking three sites" },
      },
      { method: "POST", path: "/spaces/space-1/status", body: { text: "" } },
      { method: "POST", path: "/spaces/space-1/status", body: { text: "" } },
      {
        method: "POST",
        path: "/spaces/space-1/fail",
        body: { message: "The site needs a phone number" },
      },
      {
        method: "POST",
        path: "/spaces/space-1/tabs",
        body: { url: "https://example.test/reserve" },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/click",
        body: { ref: "@e2", label: "Check availability" },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/fill",
        body: { ref: "@e1", value: "Avery Quinn", label: "Name the guest" },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/press",
        body: { key: "Enter", ref: "@e1", label: "Submit the form" },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/press",
        body: { key: "Escape", label: "Close the dialog" },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/scroll",
        body: {
          direction: "down",
          pixels: 300,
          ref: "@e1",
          label: "Read the terms",
        },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/scroll",
        body: {
          direction: "down",
          selector: ".panel",
          label: "Read the panel",
        },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/drag",
        body: {
          source: { ref: "@e1" },
          target: { selector: "#zone" },
          label: "Reorder the list",
        },
      },
      { method: "POST", path: "/tabs/tab-1/click", body: { ref: "@e2" } },
    ]);
    // Bad arguments never reach the socket.
    const sent = api.requests.length;
    await expect(research.setStatus("x".repeat(121))).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "space.setStatus",
    });
    await expect(research.setStatus(5)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(research.fail("")).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "space.fail",
    });
    await expect(
      page.click("@e2", { label: "x".repeat(61) }),
    ).rejects.toMatchObject({ code: "invalid_option" });
    expect(api.requests).toHaveLength(sent);
    expect(
      schema.checkCall(schema.findEntry("Page.click"), [
        "@e1",
        { label: "x".repeat(61) },
      ]),
    ).toMatchObject({
      code: "invalid_option",
      message:
        "page.click got an invalid option: label must be a nonempty string of at most 60 characters. Expected page.click(target, { button?, clickCount?, delay?, position?, force?, timeout?, label? }).",
    });
    expect(
      schema.checkCall(schema.findEntry("Page.click"), [
        "@e1",
        { labl: "Add to cart" },
      ]),
    ).toMatchObject({
      message:
        'page.click got unknown option "labl". Expected page.click(target, { button?, clickCount?, delay?, position?, force?, timeout?, label? }). Did you mean "label"?',
    });
  });

  // Section 6: navigation, the waits and their CLI commands.
  const level4 = { status: "ok", version: "0.4.0", apiLevel: 4 };
  const slots = { ...tab, url: "https://example.test/slots", title: "Slots" };
  const infoAnswer = {
    tab: slots,
    viewport: { width: 1200, height: 800 },
    scroll: { x: 0, y: 640 },
    document: { width: 1200, height: 5400 },
    readyState: "complete",
    loading: false,
  };
  const navigationRoutes = {
    ...level3Routes,
    "POST /tabs/tab-1/navigate": {
      ok: true,
      tab: slots,
      httpStatus: 200,
      waitUntil: "load",
    },
    "POST /tabs/tab-1/reload": {
      ok: true,
      tab: slots,
      httpStatus: 200,
      waitUntil: "load",
    },
    "GET /tabs/tab-1/info": infoAnswer,
    "POST /tabs/tab-1/wait-for-url": { ok: true, tab: slots, url: slots.url },
    "POST /tabs/tab-1/wait-for-load-state": {
      ok: true,
      tab: slots,
      state: "load",
    },
    "POST /tabs/tab-1/wait-for-selector": {
      ok: true,
      tab: slots,
      state: "visible",
      matched: 1,
    },
    "POST /tabs/tab-1/wait-for-function": {
      ok: true,
      tab: slots,
      value: { slots: 3 },
    },
  };
  // The page the navigation tests drive. Finding the space and opening the
  // page are the two requests before each test's own.
  const navigationPage = async (api, health = level4) => {
    const client = await connect({ env, fetch: api.fetch, health });
    return (await client.space("space-1")).open("https://example.test/reserve");
  };
  // The HTTP timeout a route's own field budget sets for a body.
  const budgetOf = (key, body) => {
    const route = schema.ROUTES.find((item) => schema.routeKey(item) === key);
    return httpTimeout(schema.requestBudget(route, body), route);
  };

  it("goto, reload and the waits map their options", async () => {
    const api = fakeApi(navigationRoutes);
    const page = await navigationPage(api);
    expect(
      await page.goto("https://example.test/slots", {
        waitUntil: "domcontentloaded",
        timeout: 3000,
        referer: "https://example.test/",
      }),
    ).toEqual({
      ok: true,
      tab: slots,
      httpStatus: 200,
      waitUntil: "load",
    });
    await page.reload({
      waitUntil: "networkidle",
      timeout: 2000,
      ignoreCache: true,
    });
    expect(await page.info()).toEqual(infoAnswer);
    await page.waitForURL("https://example.test/**/done", {
      waitUntil: "commit",
      timeout: 4000,
    });
    await page.waitForLoadState("networkidle", { timeout: 5000, idleMs: 750 });
    await page.waitForSelector("@e2", { state: "hidden", timeout: 6000 });
    await page.waitForFunction("window.slots > 0", undefined, {
      timeout: 7000,
      interval: 250,
    });
    expect(api.requests.slice(2)).toEqual([
      {
        method: "POST",
        path: "/tabs/tab-1/navigate",
        body: {
          url: "https://example.test/slots",
          waitUntil: "domcontentloaded",
          timeoutMs: 3000,
          referer: "https://example.test/",
        },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/reload",
        body: { waitUntil: "networkidle", timeoutMs: 2000, ignoreCache: true },
      },
      { method: "GET", path: "/tabs/tab-1/info", body: undefined },
      {
        method: "POST",
        path: "/tabs/tab-1/wait-for-url",
        body: {
          url: "https://example.test/**/done",
          waitUntil: "commit",
          timeoutMs: 4000,
        },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/wait-for-load-state",
        body: { state: "networkidle", idleMs: 750, timeoutMs: 5000 },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/wait-for-selector",
        body: { ref: "@e2", state: "hidden", timeoutMs: 6000 },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/wait-for-function",
        body: {
          expression: "window.slots > 0",
          intervalMs: 250,
          timeoutMs: 7000,
        },
      },
    ]);
    // Each call's HTTP timeout is its operation timeout plus 5000 ms, from
    // the route's own field budget.
    expect(budgetOf("POST /tabs/:id/navigate", { timeoutMs: 3000 })).toBe(8000);
    expect(budgetOf("POST /tabs/:id/navigate", {})).toBe(20000);
    expect(budgetOf("POST /tabs/:id/reload", { timeoutMs: 2000 })).toBe(7000);
    for (const key of [
      "POST /tabs/:id/wait-for-url",
      "POST /tabs/:id/wait-for-load-state",
      "POST /tabs/:id/wait-for-selector",
      "POST /tabs/:id/wait-for-function",
    ]) {
      expect(budgetOf(key, { timeoutMs: 4000 }), key).toBe(9000);
      expect(budgetOf(key, {}), key).toBe(15000);
    }
    // What a call that names no options sends.
    const defaults = fakeApi(navigationRoutes);
    const plain = await navigationPage(defaults);
    await plain.goto("https://example.test/slots");
    await plain.reload();
    await plain.waitForLoadState();
    await plain.waitForSelector("#slots");
    await plain.waitForFunction("window.slots > 0");
    expect(defaults.requests.slice(2).map((item) => item.body)).toEqual([
      {
        url: "https://example.test/slots",
        waitUntil: "load",
        timeoutMs: 15000,
      },
      { waitUntil: "load", timeoutMs: 15000, ignoreCache: false },
      { state: "load", idleMs: 500, timeoutMs: 10000 },
      { selector: "#slots", state: "visible", timeoutMs: 10000 },
      { expression: "window.slots > 0", intervalMs: 100, timeoutMs: 10000 },
    ]);
  });

  it("navigate sends waitUntil commit and goto sends load", async () => {
    const api = fakeApi(navigationRoutes);
    const page = await navigationPage(api);
    expect(await page.navigate("https://example.test/slots")).toBe(page);
    await page.goto("https://example.test/slots");
    expect(api.requests.slice(2).map((item) => item.body)).toEqual([
      { url: "https://example.test/slots", waitUntil: "commit" },
      {
        url: "https://example.test/slots",
        waitUntil: "load",
        timeoutMs: 15000,
      },
    ]);
    // The command without --wait-until returns at commit too.
    const cli = fakeApi(navigationRoutes);
    expect(
      await runCli(["navigate", "tab-1", "https://example.test/slots"], {
        env,
        fetch: cli.fetch,
        health: level4,
        stdout: sink(),
      }),
    ).toBe(0);
    expect(cli.requests).toEqual([
      {
        method: "POST",
        path: "/tabs/tab-1/navigate",
        body: { url: "https://example.test/slots", waitUntil: "commit" },
      },
    ]);
    const flagged = fakeApi(navigationRoutes);
    expect(
      await runCli(
        [
          "navigate",
          "tab-1",
          "https://example.test/slots",
          "--wait-until",
          "networkidle",
          "--timeout",
          "30000",
          "--referer",
          "https://example.test/",
        ],
        {
          env,
          fetch: flagged.fetch,
          health: level4,
          stdout: sink(),
        },
      ),
    ).toBe(0);
    expect(flagged.requests.at(-1).body).toEqual({
      url: "https://example.test/slots",
      waitUntil: "networkidle",
      timeoutMs: 30000,
      referer: "https://example.test/",
    });
    // --ignore-cache refetches past the cache.
    const cached = fakeApi(navigationRoutes);
    expect(
      await runCli(["reload", "tab-1", "--ignore-cache"], {
        env,
        fetch: cached.fetch,
        health: level4,
        stdout: sink(),
      }),
    ).toBe(0);
    expect(cached.requests.at(-1).body).toEqual({ ignoreCache: true });
    // A Kamapathy that predates the field is told which one, before anything
    // is sent.
    const older = fakeApi(navigationRoutes);
    await expect(
      runCli(
        [
          "navigate",
          "tab-1",
          "https://example.test/slots",
          "--wait-until",
          "load",
        ],
        {
          env,
          fetch: older.fetch,
          health: { status: "ok", version: "0.1.9", apiLevel: 1 },
          stdout: sink(),
        },
      ),
    ).rejects.toMatchObject({
      code: "app_outdated",
      entry: "navigate",
      option: "waitUntil",
      required: 4,
    });
    expect(older.requests).toEqual([]);
  });

  it("the watch loop tests every commit and throws on a popup match", async () => {
    const committed = [
      { navigation: 5, url: "" },
      { navigation: 6, url: "https://example.test/step" },
      { navigation: 7, url: "https://example.test/done" },
    ];
    const watched = [
      {
        ok: true,
        tab: slots,
        url: "https://example.test/slots",
        navigation: 4,
        committed: [],
        popups: [],
      },
      {
        ok: true,
        tab: slots,
        url: "https://example.test/done",
        navigation: 7,
        committed,
        popups: [],
      },
    ];
    const api = fakeApi({
      ...navigationRoutes,
      "POST /tabs/tab-1/wait-for-url": () => Response.json(watched.shift()),
    });
    const page = await navigationPage(api);
    const seen = [];
    const result = await page.waitForURL(
      (address) => {
        seen.push(address);
        return address.pathname === "/done";
      },
      { timeout: 5000 },
    );
    expect(result).toMatchObject({
      ok: true,
      url: "https://example.test/done",
    });
    // The predicate saw the URL at entry and every commit, oldest first, as
    // URL objects, and never an address that does not parse.
    expect(seen.map(String)).toEqual([
      "https://example.test/slots",
      "https://example.test/step",
      "https://example.test/done",
    ]);
    expect(seen.every((address) => address instanceof URL)).toBe(true);
    expect(api.requests.slice(2)).toEqual([
      {
        method: "POST",
        path: "/tabs/tab-1/wait-for-url",
        body: { timeoutMs: expect.any(Number) },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/wait-for-url",
        body: { after: 4, timeoutMs: expect.any(Number) },
      },
      {
        method: "POST",
        path: "/tabs/tab-1/wait-for-load-state",
        body: { state: "load", timeoutMs: expect.any(Number) },
      },
    ]);
    // A RegExp is reset before each test, so one matcher works twice.
    const repeated = fakeApi({
      ...navigationRoutes,
      "POST /tabs/tab-1/wait-for-url": () =>
        Response.json({
          ok: true,
          tab: slots,
          url: "https://example.test/done",
          navigation: 2,
          committed: [],
          popups: [],
        }),
    });
    const twice = await navigationPage(repeated);
    const pattern = /example\.test\/done/g;
    for (const attempt of [1, 2])
      expect(
        (await twice.waitForURL(pattern, { timeout: 1000 })).url,
        String(attempt),
      ).toBe("https://example.test/done");
    // A popup that reached the URL ends the wait: the action already happened.
    const popup = {
      id: "tab-9",
      label: "p3",
      url: "https://example.test/done",
    };
    const opened = fakeApi({
      ...navigationRoutes,
      "POST /tabs/tab-1/wait-for-url": () =>
        Response.json({
          ok: true,
          tab: slots,
          url: "https://example.test/slots",
          navigation: 3,
          committed: [],
          popups: [popup],
        }),
    });
    const popped = await navigationPage(opened);
    await expect(
      popped.waitForURL(/\/done$/, { timeout: 1000 }),
    ).rejects.toMatchObject({
      code: "url_opened_in_popup",
      entry: "page.waitForURL",
      lastUrl: "https://example.test/slots",
      popup,
      message:
        "tab-1 stayed at https://example.test/slots, but popup p3 opened from it at https://example.test/done. The action already happened, so do not repeat it. Continue in p3.",
    });
    // The client raises the timeout itself, naming what it waited for.
    const stalled = fakeApi({
      ...navigationRoutes,
      "POST /tabs/tab-1/wait-for-url": () =>
        Response.json(
          {
            error: {
              code: "wait_timeout",
              message:
                "The page did not commit another URL within 200 ms. It is at https://example.test/slots.",
              awaited: "url",
              timeoutMs: 200,
              lastUrl: "https://example.test/slots",
            },
          },
          { status: 504 },
        ),
    });
    const waiting = await navigationPage(stalled);
    await expect(
      waiting.waitForURL(/\/done$/, { timeout: 200 }),
    ).rejects.toMatchObject({
      code: "wait_timeout",
      entry: "page.waitForURL",
      awaited: "url",
      expected: "\\/done$",
      lastUrl: "https://example.test/slots",
      timeoutMs: 200,
      message:
        "The page did not reach a URL matching \\/done$ within 200 ms. It is at https://example.test/slots.",
    });
    await expect(
      waiting.waitForURL((address) => address.pathname === "/done", {
        timeout: 200,
      }),
    ).rejects.toMatchObject({
      code: "wait_timeout",
      expected: "a URL predicate",
    });
  });

  it("misplaced waitForFunction options throw before sending", async () => {
    const api = fakeApi(navigationRoutes);
    const page = await navigationPage(api);
    const sent = api.requests.length;
    for (const options of [
      { timeout: 5000 },
      { interval: 250 },
      { timeout: 5000, interval: 250 },
    ])
      await expect(
        page.waitForFunction(() => true, options),
        JSON.stringify(options),
      ).rejects.toMatchObject({
        code: "invalid_argument",
        entry: "page.waitForFunction",
        expected:
          "page.waitForFunction(pageFunction, arg?, { timeout?, interval? })",
      });
    expect(api.requests).toHaveLength(sent);
    // An argument of its own still reaches the page, options and all.
    await page.waitForFunction((rows) => rows > 0, 3, { interval: 250 });
    expect(api.requests.at(-1).body).toEqual({
      function: "(rows) => rows > 0",
      arg: 3,
      intervalMs: 250,
      timeoutMs: 10000,
    });
    await page.waitForFunction((data) => data.rows > 0, { rows: 3 });
    expect(api.requests.at(-1).body).toEqual({
      function: "(data) => data.rows > 0",
      arg: { rows: 3 },
      intervalMs: 100,
      timeoutMs: 10000,
    });
  });

  it("waitForTimeout validates and sends nothing", async () => {
    const api = fakeApi(navigationRoutes);
    const page = await navigationPage(api);
    const sent = api.requests.length;
    expect(await page.waitForTimeout(0)).toBeUndefined();
    const started = Date.now();
    await page.waitForTimeout(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    expect(
      schema.checkCall(schema.findEntry("Page.waitForTimeout"), [600000]),
    ).toBeNull();
    for (const ms of [-1, 600001, 1.5, "1000", null])
      await expect(page.waitForTimeout(ms), String(ms)).rejects.toMatchObject({
        code: "invalid_argument",
        entry: "page.waitForTimeout",
      });
    expect(api.requests).toHaveLength(sent);
  });

  it("each new command sends one request", async () => {
    const cases = [
      [
        ["navigate", "tab-1", "https://example.test/slots"],
        {
          method: "POST",
          path: "/tabs/tab-1/navigate",
          body: { url: "https://example.test/slots", waitUntil: "commit" },
        },
      ],
      [
        [
          "reload",
          "tab-1",
          "--wait-until",
          "domcontentloaded",
          "--timeout",
          "9000",
        ],
        {
          method: "POST",
          path: "/tabs/tab-1/reload",
          body: { waitUntil: "domcontentloaded", timeoutMs: 9000 },
        },
      ],
      [
        ["info", "tab-1"],
        { method: "GET", path: "/tabs/tab-1/info", body: undefined },
      ],
      [
        [
          "wait-for-url",
          "tab-1",
          "https://example.test/**/done",
          "--wait-until",
          "commit",
          "--timeout",
          "8000",
        ],
        {
          method: "POST",
          path: "/tabs/tab-1/wait-for-url",
          body: {
            url: "https://example.test/**/done",
            waitUntil: "commit",
            timeoutMs: 8000,
          },
        },
      ],
      [
        ["wait-for-load-state", "tab-1", "networkidle", "--idle", "750"],
        {
          method: "POST",
          path: "/tabs/tab-1/wait-for-load-state",
          body: { state: "networkidle", idleMs: 750 },
        },
      ],
      [
        ["wait-for-load-state", "tab-1", "--timeout", "0"],
        {
          method: "POST",
          path: "/tabs/tab-1/wait-for-load-state",
          body: { timeoutMs: 0 },
        },
      ],
      [
        ["wait-for-selector", "tab-1", "#slots", "--state", "attached"],
        {
          method: "POST",
          path: "/tabs/tab-1/wait-for-selector",
          body: { selector: "#slots", state: "attached" },
        },
      ],
      [
        ["wait-for-selector", "tab-1", "@e2"],
        {
          method: "POST",
          path: "/tabs/tab-1/wait-for-selector",
          body: { ref: "@e2" },
        },
      ],
      [
        [
          "wait-for-function",
          "tab-1",
          "--stdin",
          "--interval",
          "250",
          "--timeout",
          "8000",
        ],
        {
          method: "POST",
          path: "/tabs/tab-1/wait-for-function",
          body: {
            expression: "window.slots > 0",
            intervalMs: 250,
            timeoutMs: 8000,
          },
        },
        "window.slots > 0\n",
      ],
    ];
    for (const [args, expected, stdin] of cases) {
      const api = fakeApi(navigationRoutes);
      expect(
        await runCli(args, {
          env,
          fetch: api.fetch,
          health: level4,
          stdin: stdin === undefined ? undefined : Readable.from([stdin]),
          stdout: sink(),
        }),
        args.join(" "),
      ).toBe(0);
      expect(api.requests, args.join(" ")).toEqual([expected]);
    }
    const unused = vi.fn();
    await expect(
      runCli(["wait-for-function", "tab-1"], {
        env,
        fetch: unused,
        health: level4,
        stdout: sink(),
      }),
    ).rejects.toThrow(/--stdin/);
    // Each new command is refused by name against a Kamapathy that predates it.
    for (const args of [
      ["reload", "tab-1"],
      ["info", "tab-1"],
      ["wait-for-url", "tab-1", "https://example.test/**"],
      ["wait-for-load-state", "tab-1"],
      ["wait-for-selector", "tab-1", "#slots"],
    ])
      await expect(
        runCli(args, { env, fetch: unused, health: level3, stdout: sink() }),
        args.join(" "),
      ).rejects.toMatchObject({
        code: "app_outdated",
        required: 4,
        available: 3,
      });
    expect(unused).not.toHaveBeenCalled();
  });

  it("the new output lines read as the spec says", async () => {
    const cases = [
      [
        ["navigate", "tab-1", "https://example.test/slots"],
        {
          ok: true,
          tab: slots,
          httpStatus: 200,
          waitUntil: "commit",
          dialog: { type: "beforeunload", message: "", answer: "accepted" },
        },
        [
          "tab tab-1 https://example.test/slots 200",
          "dialog beforeunload accepted",
        ],
      ],
      [
        ["reload", "tab-1"],
        { ok: true, tab: slots, waitUntil: "load" },
        ["tab tab-1 https://example.test/slots"],
      ],
      [
        ["info", "tab-1"],
        infoAnswer,
        [
          "tab tab-1 https://example.test/slots",
          "viewport 1200x800 scroll 0,640 document 1200x5400 complete",
        ],
      ],
      [
        ["wait-for-url", "tab-1", "https://example.test/**/done"],
        { ok: true, tab: slots, url: "https://example.test/done" },
        ["ok: url https://example.test/done"],
      ],
      [
        ["wait-for-load-state", "tab-1", "networkidle"],
        { ok: true, tab: slots, state: "networkidle" },
        ["ok: networkidle https://example.test/slots"],
      ],
      [
        ["wait-for-selector", "tab-1", "#slots"],
        { ok: true, tab: slots, state: "visible", matched: 1 },
        ["ok: visible 1 match"],
      ],
      [
        ["wait-for-selector", "tab-1", "#slots", "--state", "hidden"],
        { ok: true, tab: slots, state: "hidden", matched: 3 },
        ["ok: hidden 3 matches"],
      ],
      [
        ["wait-for-function", "tab-1", "--stdin"],
        { ok: true, tab: slots, value: { slots: 3 } },
        ['ok: value {"slots":3}'],
      ],
      [
        ["wait-for-function", "tab-1", "--stdin"],
        { ok: true, tab: slots },
        ["ok: value undefined"],
      ],
      [
        ["wait-for-function", "tab-1", "--stdin"],
        { ok: true, tab: slots, unserializable: "Infinity" },
        ["ok: value Infinity"],
      ],
    ];
    for (const [args, answer, lines] of cases) {
      const stdout = sink();
      expect(
        await runCli(args, {
          env,
          fetch: vi.fn(async () => Response.json(answer)),
          health: level4,
          stdin: Readable.from(["window.slots"]),
          stdout,
        }),
        args.join(" "),
      ).toBe(0);
      expect(stdout.text(), args.join(" ")).toBe(`${lines.join("\n")}\n`);
    }
    // A long value is cut, and --json keeps printing the answer itself.
    const cutoff = sink();
    await runCli(["wait-for-function", "tab-1", "--stdin"], {
      env,
      fetch: vi.fn(async () =>
        Response.json({ ok: true, tab: slots, value: "x".repeat(400) }),
      ),
      health: level4,
      stdin: Readable.from(["window.slots"]),
      stdout: cutoff,
    });
    expect(cutoff.text()).toBe(
      `ok: value ${`"${"x".repeat(400)}"`.slice(0, 200)}\n`,
    );
    const json = sink();
    await runCli(["info", "tab-1", "--json"], {
      env,
      fetch: vi.fn(async () => Response.json(infoAnswer)),
      health: level4,
      stdout: json,
    });
    expect(JSON.parse(json.text())).toEqual(infoAnswer);
  });

  it("a batch with navigation steps is checked before its first action", async () => {
    const api = fakeApi(navigationRoutes);
    const page = await navigationPage(api);
    const sent = api.requests.length;
    await expect(
      page.batch([
        { type: "navigate", url: "https://example.test/slots" },
        { type: "wait-for-selector", selector: "#slots", state: "gone" },
      ]),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "page.batch",
      index: 1,
      field: "state",
      message: expect.stringContaining(
        "state must be attached, visible, hidden, or detached.",
      ),
    });
    // A URL step watches nothing: the after field belongs to the route only.
    await expect(
      page.batch([{ type: "wait-for-url", after: 3 }]),
    ).rejects.toMatchObject({
      code: "invalid_argument",
      field: "after",
      message: expect.stringContaining(
        'Batch step 1 (wait-for-url) has no field "after"',
      ),
    });
    expect(api.requests).toHaveLength(sent);
    // A plan the schema accepts reaches the route as one request.
    expect(
      await page.batch([
        {
          type: "navigate",
          url: "https://example.test/slots",
          waitUntil: "commit",
        },
        { type: "wait-for-load-state", state: "networkidle", idleMs: 750 },
        { type: "wait-for-selector", ref: "@e2", state: "visible" },
        { type: "reload", ignoreCache: true },
        {
          type: "wait-for-function",
          expression: "window.slots > 0",
          intervalMs: 250,
        },
      ]),
    ).toMatchObject({ ok: true });
    expect(api.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/tabs/tab-1/actions",
    });
  });

  it("page.url and page.title follow every answer", async () => {
    const done = { ...tab, url: "https://example.test/done", title: "Done" };
    const api = fakeApi({
      ...navigationRoutes,
      "POST /tabs/tab-1/reload": {
        ok: true,
        tab: { ...slots, title: "Slots again" },
        waitUntil: "load",
      },
      "POST /tabs/tab-1/wait-for-selector": {
        ok: true,
        tab: done,
        state: "visible",
        matched: 2,
      },
      "GET /tabs/tab-1/info": {
        ...infoAnswer,
        tab: { ...done, title: "Done page" },
      },
    });
    const page = await navigationPage(api);
    expect([page.url, page.title]).toEqual([
      "https://example.test/reserve",
      "Reserve",
    ]);
    await page.goto("https://example.test/slots");
    expect([page.url, page.title]).toEqual([
      "https://example.test/slots",
      "Slots",
    ]);
    await page.reload();
    expect([page.url, page.title]).toEqual([
      "https://example.test/slots",
      "Slots again",
    ]);
    expect(await page.waitForSelector("#slots")).toEqual({
      ok: true,
      tab: done,
      state: "visible",
      matched: 2,
    });
    expect([page.url, page.title]).toEqual([
      "https://example.test/done",
      "Done",
    ]);
    await page.info();
    expect(page.title).toBe("Done page");
  });

  // Section 5's client surface: the element options, both press orders, the
  // mouse and keyboard controllers, and the release at the end of a run.
  const current = {
    status: "ok",
    version: "0.2.0",
    apiLevel: schema.API_LEVEL,
  };
  const pointer = { x: 40, y: 60, buttons: 0, keys: [], modifiers: 0 };
  const inputAnswers = {
    ...level3Routes,
    "POST /tabs/tab-1/click": {
      ok: true,
      url: tab.url,
      point: { x: 40, y: 60 },
    },
    "POST /tabs/tab-1/dblclick": {
      ok: true,
      url: tab.url,
      point: { x: 40, y: 60 },
    },
    "POST /tabs/tab-1/hover": { ok: true, point: { x: 40, y: 60 } },
    "POST /tabs/tab-1/fill": { ok: true, match: "equivalent", value: "12.50" },
    "POST /tabs/tab-1/select": { ok: true, values: ["pro", "team"] },
    "POST /tabs/tab-1/focus": { ok: true },
    "POST /tabs/tab-1/press": { ok: true, url: tab.url },
    "POST /tabs/tab-1/mouse/move": { ok: true, input: pointer },
    "POST /tabs/tab-1/mouse/down": {
      ok: true,
      input: { ...pointer, buttons: 1 },
    },
    "POST /tabs/tab-1/mouse/up": { ok: true, input: pointer },
    "POST /tabs/tab-1/mouse/click": { ok: true, url: tab.url, input: pointer },
    "POST /tabs/tab-1/mouse/wheel": { ok: true, input: pointer },
    "POST /tabs/tab-1/keyboard/down": {
      ok: true,
      input: { ...pointer, keys: ["Shift"], modifiers: 8 },
    },
    "POST /tabs/tab-1/keyboard/up": { ok: true, input: pointer },
    "POST /tabs/tab-1/keyboard/type": { ok: true, input: pointer },
    "POST /tabs/tab-1/keyboard/insert-text": { ok: true },
    "POST /tabs/tab-1/keyboard/paste": { ok: true, handled: "page" },
    "POST /tabs/tab-1/input/release": { ok: true, released: ["Shift", "left"] },
  };
  // One page of an agent space, against an app of this client's own level.
  const inputPage = async (api, health = current) => {
    const client = await connect({ env, fetch: api.fetch, health });
    return (await client.space("space-1")).open("https://example.test/reserve");
  };
  const routeOf = (key) =>
    schema.ROUTES.find((item) => schema.routeKey(item) === key);

  it("takes press in both argument orders", async () => {
    const api = fakeApi(inputAnswers);
    const page = await inputPage(api);
    const body = () => api.requests.at(-1).body;
    await page.press("Enter");
    expect(body()).toEqual({ key: "Enter" });
    await page.press("Enter", "@e3");
    expect(body()).toEqual({ key: "Enter", ref: "@e3" });
    await page.press("@e3", "Enter");
    expect(body()).toEqual({ key: "Enter", ref: "@e3" });
    await page.press("#search", "Shift+KeyA");
    expect(body()).toEqual({ key: "Shift+KeyA", selector: "#search" });
    await page.press("ControlOrMeta+KeyS", "@e3", { delay: 50, timeout: 1000 });
    expect(body()).toEqual({
      key: "ControlOrMeta+KeyS",
      ref: "@e3",
      delayMs: 50,
      timeoutMs: 1000,
    });
    // A lone argument that is no chord is not guessed at.
    const sent = api.requests.length;
    await expect(page.press("@e3")).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "page.press",
    });
    await expect(page.press("#search")).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "page.press",
    });
    expect(api.requests).toHaveLength(sent);
    // keyboard.press is the same route with no target.
    await page.keyboard.press("Shift+Tab", { delay: 20 });
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/press",
      body: { key: "Shift+Tab", delayMs: 20 },
    });
  });

  it("checks the new options before sending", async () => {
    const api = fakeApi(inputAnswers);
    const page = await inputPage(api);
    const sent = api.requests.length;
    await expect(page.click("@e1", { clickCount: 4 })).rejects.toMatchObject({
      code: "invalid_option",
      entry: "page.click",
      option: "clickCount",
    });
    await expect(page.click("@e1", { button: "back" })).rejects.toMatchObject({
      code: "invalid_option",
      entry: "page.click",
      option: "button",
    });
    await expect(page.click("@e1", { delayMs: 10 })).rejects.toMatchObject({
      code: "invalid_option",
      option: "delayMs",
      suggestion: "delay",
    });
    await expect(page.dblclick("@e1", { clickCount: 2 })).rejects.toMatchObject(
      {
        code: "invalid_option",
        entry: "page.dblclick",
        option: "clickCount",
      },
    );
    await expect(page.hover("@e1", { position: "10" })).rejects.toMatchObject({
      code: "invalid_option",
      option: "position",
    });
    await expect(page.keyboard.type("x".repeat(2001))).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "page.keyboard.type",
    });
    await expect(page.mouse.move(0, "40")).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "page.mouse.move",
    });
    await expect(page.mouse.wheel(0, 20000)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(api.requests).toHaveLength(sent);
    // A lone choice, an object and null all reach the route as its array.
    for (const [values, chosen] of [
      ["pro", ["pro"]],
      [{ label: "Pro" }, [{ label: "Pro" }]],
      [null, []],
      [[], []],
      [
        ["pro", "team"],
        ["pro", "team"],
      ],
    ]) {
      await page.selectOption("@e1", values);
      expect(api.requests.at(-1).body, JSON.stringify(values)).toEqual({
        ref: "@e1",
        values: chosen,
      });
    }
    // Both position spellings reach the route as { x, y }.
    await page.click("@e1", { position: "10,20" });
    expect(api.requests.at(-1).body).toEqual({
      ref: "@e1",
      position: { x: 10, y: 20 },
    });
    await page.dragAndDrop("@e1", "#zone", {
      sourcePosition: { x: 1, y: 2 },
      targetPosition: "3,4",
      force: true,
      timeout: 2000,
    });
    expect(api.requests.at(-1).body).toEqual({
      source: { ref: "@e1" },
      target: { selector: "#zone" },
      sourcePosition: { x: 1, y: 2 },
      targetPosition: { x: 3, y: 4 },
      force: true,
      timeoutMs: 2000,
    });
    // page.drag keeps its own signature, and fill, focus and the raw routes
    // send what their options name.
    await page.drag("@e1", "#zone");
    expect(api.requests.at(-1).body).toEqual({
      source: { ref: "@e1" },
      target: { selector: "#zone" },
    });
    await page.fill("@e1", "Avery", { append: true, timeout: 1000 });
    expect(api.requests.at(-1).body).toEqual({
      ref: "@e1",
      value: "Avery",
      append: true,
      timeoutMs: 1000,
    });
    await page.focus("@e1", { timeout: 0 });
    expect(api.requests.at(-1).body).toEqual({ ref: "@e1", timeoutMs: 0 });
    await page.mouse.move(40, 60, { steps: 10 });
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/mouse/move",
      body: { x: 40, y: 60, steps: 10 },
    });
    await page.mouse.down({ button: "right" });
    expect(api.requests.at(-1).body).toEqual({ button: "right" });
    await page.mouse.up();
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/mouse/up",
      body: {},
    });
    await page.mouse.click(5, 6, { clickCount: 2, delay: 30 });
    expect(api.requests.at(-1).body).toEqual({
      x: 5,
      y: 6,
      clickCount: 2,
      delayMs: 30,
    });
    await page.mouse.dblclick(5, 6, { delay: 30 });
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/mouse/click",
      body: { x: 5, y: 6, clickCount: 2, delayMs: 30 },
    });
    await page.mouse.wheel(0, 120);
    expect(api.requests.at(-1).body).toEqual({ deltaX: 0, deltaY: 120 });
    await page.keyboard.down("Shift");
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/keyboard/down",
      body: { key: "Shift" },
    });
    await page.keyboard.up("Shift");
    expect(api.requests.at(-1).body).toEqual({ key: "Shift" });
    await page.keyboard.type("hello", { delay: 10 });
    expect(api.requests.at(-1).body).toEqual({ text: "hello", delayMs: 10 });
    await page.keyboard.insertText("hello");
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/keyboard/insert-text",
      body: { text: "hello" },
    });
    expect(await page.keyboard.paste("hello")).toEqual({
      ok: true,
      handled: "page",
    });
    expect(api.requests.at(-1).body).toEqual({ text: "hello" });
    await page.keyboard.paste({ text: "hello", html: "<b>hello</b>" });
    expect(api.requests.at(-1).body).toEqual({
      text: "hello",
      html: "<b>hello</b>",
    });
    // The paste body may hold the whole text and HTML the route takes.
    await page.keyboard.paste({
      text: "é".repeat(16384),
      html: "é".repeat(32768),
    });
    expect(api.requests.at(-1).body.text).toHaveLength(16384);
    await expect(page.keyboard.paste({ text: 5 })).rejects.toMatchObject({
      code: "invalid_option",
      option: "text",
    });
  });

  it("sends the HTTP timeouts the spec lists", async () => {
    const api = fakeApi(inputAnswers);
    const page = await inputPage(api);
    const timeoutOf = (key, body) =>
      httpTimeout(schema.requestBudget(routeOf(key), body), routeOf(key));
    // A delayed triple click: the wait for an actionable target, one delay
    // per gap, the settle and load wait, and the client's own 5000 ms.
    await page.click("@e1", { clickCount: 3, delay: 500, timeout: 3000 });
    expect(api.requests.at(-1).body).toEqual({
      ref: "@e1",
      clickCount: 3,
      delayMs: 500,
      timeoutMs: 3000,
    });
    expect(timeoutOf("POST /tabs/:id/click", api.requests.at(-1).body)).toBe(
      3000 + 2500 + 15100 + 5000,
    );
    for (const name of ["hover", "fill", "select", "focus"])
      expect(
        timeoutOf(`POST /tabs/:id/${name}`, { timeoutMs: 4000 }),
        name,
      ).toBe(4000 + 15000);
    for (const name of [
      "mouse/move",
      "mouse/down",
      "mouse/up",
      "mouse/wheel",
      "keyboard/down",
      "keyboard/up",
      "keyboard/insert-text",
      "keyboard/paste",
    ])
      expect(timeoutOf(`POST /tabs/:id/${name}`, {}), name).toBe(15000);
    expect(
      timeoutOf("POST /tabs/:id/keyboard/type", {
        text: "hello",
        delayMs: 100,
      }),
    ).toBe(10000 + 500 + 5000);
    // input/release declares a plain budget, which the client passes itself.
    const release = routeOf("POST /tabs/:id/input/release");
    expect(httpTimeout(schema.requestBudget(release), release)).toBe(15000);
    await page.releaseInput();
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/input/release",
      body: {},
    });
  });

  it("runs every new command", async () => {
    for (const [args, path, body, piped] of [
      [
        [
          "click",
          "tab-1",
          "@e2",
          "--button",
          "right",
          "--click-count",
          "2",
          "--delay",
          "100",
          "--position",
          "10,20",
          "--force",
          "--timeout",
          "5000",
          "--label",
          "Add",
        ],
        "/tabs/tab-1/click",
        {
          ref: "@e2",
          button: "right",
          clickCount: 2,
          delayMs: 100,
          position: { x: 10, y: 20 },
          force: true,
          timeoutMs: 5000,
          label: "Add",
        },
      ],
      [
        [
          "dblclick",
          "tab-1",
          "#row",
          "--button",
          "left",
          "--delay",
          "0",
          "--position",
          "-5,2.5",
          "--timeout",
          "0",
        ],
        "/tabs/tab-1/dblclick",
        {
          selector: "#row",
          button: "left",
          delayMs: 0,
          position: { x: -5, y: 2.5 },
          timeoutMs: 0,
        },
      ],
      [
        [
          "hover",
          "tab-1",
          "@e2",
          "--position",
          "4,5",
          "--force",
          "--timeout",
          "1000",
        ],
        "/tabs/tab-1/hover",
        { ref: "@e2", position: { x: 4, y: 5 }, force: true, timeoutMs: 1000 },
      ],
      [
        [
          "drag",
          "tab-1",
          "@e1",
          "#zone",
          "--source-position",
          "1,2",
          "--target-position",
          "3,4",
          "--button",
          "left",
          "--force",
          "--timeout",
          "9000",
        ],
        "/tabs/tab-1/drag",
        {
          source: { ref: "@e1" },
          target: { selector: "#zone" },
          sourcePosition: { x: 1, y: 2 },
          targetPosition: { x: 3, y: 4 },
          button: "left",
          force: true,
          timeoutMs: 9000,
        },
      ],
      [
        ["fill", "tab-1", "@e1", "--stdin", "--append", "--timeout", "2000"],
        "/tabs/tab-1/fill",
        { ref: "@e1", value: "Avery Quinn", append: true, timeoutMs: 2000 },
        "Avery Quinn",
      ],
      [
        ["select", "tab-1", "@e1", "pro", "team", "max", "--timeout", "3000"],
        "/tabs/tab-1/select",
        { ref: "@e1", values: ["pro", "team", "max"], timeoutMs: 3000 },
      ],
      [
        ["select", "tab-1", "@e1"],
        "/tabs/tab-1/select",
        { ref: "@e1", values: [] },
      ],
      [
        ["focus", "tab-1", "@e1", "--timeout", "1500"],
        "/tabs/tab-1/focus",
        { ref: "@e1", timeoutMs: 1500 },
      ],
      [
        [
          "press",
          "tab-1",
          "Shift+KeyA",
          "@e1",
          "--delay",
          "40",
          "--timeout",
          "2500",
        ],
        "/tabs/tab-1/press",
        { key: "Shift+KeyA", ref: "@e1", delayMs: 40, timeoutMs: 2500 },
      ],
      [
        ["mouse-move", "tab-1", "40", "60", "--steps", "20"],
        "/tabs/tab-1/mouse/move",
        { x: 40, y: 60, steps: 20 },
      ],
      [
        ["mouse-down", "tab-1", "--button", "middle", "--click-count", "2"],
        "/tabs/tab-1/mouse/down",
        { button: "middle", clickCount: 2 },
      ],
      [
        ["mouse-up", "tab-1", "--button", "middle"],
        "/tabs/tab-1/mouse/up",
        { button: "middle" },
      ],
      [
        [
          "mouse-click",
          "tab-1",
          "-1.5",
          "60",
          "--button",
          "right",
          "--click-count",
          "3",
          "--delay",
          "20",
        ],
        "/tabs/tab-1/mouse/click",
        { x: -1.5, y: 60, button: "right", clickCount: 3, delayMs: 20 },
      ],
      [
        ["mouse-wheel", "tab-1", "0", "-120"],
        "/tabs/tab-1/mouse/wheel",
        { deltaX: 0, deltaY: -120 },
      ],
      [
        ["key-down", "tab-1", "Shift"],
        "/tabs/tab-1/keyboard/down",
        { key: "Shift" },
      ],
      [
        ["key-up", "tab-1", "Shift"],
        "/tabs/tab-1/keyboard/up",
        { key: "Shift" },
      ],
      [
        ["type", "tab-1", "--stdin", "--delay", "15"],
        "/tabs/tab-1/keyboard/type",
        { text: "Avery Quinn", delayMs: 15 },
        "Avery Quinn",
      ],
      [
        ["insert-text", "tab-1", "--stdin"],
        "/tabs/tab-1/keyboard/insert-text",
        { text: "Avery Quinn" },
        "Avery Quinn",
      ],
      [
        ["paste", "tab-1", "--stdin"],
        "/tabs/tab-1/keyboard/paste",
        { text: "Avery Quinn" },
        "Avery Quinn",
      ],
      [
        ["paste", "tab-1", "--stdin", "--html"],
        "/tabs/tab-1/keyboard/paste",
        { text: "Avery", html: "<b>Avery</b>" },
        '{"text":"Avery","html":"<b>Avery</b>"}',
      ],
      [["release-input", "tab-1"], "/tabs/tab-1/input/release", {}],
    ]) {
      const fetch = vi.fn(async () => Response.json({ ok: true }));
      expect(
        await runCli(args, {
          env,
          fetch,
          health: current,
          ...(piped === undefined ? {} : { stdin: Readable.from([piped]) }),
          stdout: sink(),
        }),
        args.join(" "),
      ).toBe(0);
      const [url, options] = fetch.mock.calls[0];
      expect(url.pathname, args.join(" ")).toBe(path);
      expect(options.method, args.join(" ")).toBe("POST");
      expect(JSON.parse(options.body), args.join(" ")).toEqual(body);
    }
    // An unknown flag, a bad value and a missing argument fail before
    // anything connects.
    const unused = vi.fn();
    for (const args of [
      ["click", "tab-1", "@e2", "--clicks", "2"],
      ["click", "tab-1", "@e2", "--click-count", "4"],
      ["click", "tab-1", "@e2", "--button", "back"],
      ["click", "tab-1", "@e2", "--position", "10"],
      ["click", "tab-1", "@e2", "--position", "a,b"],
      ["click", "tab-1", "@e2", "--timeout"],
      ["click", "tab-1", "@e2", "@e3"],
      ["dblclick", "tab-1", "@e2", "--click-count", "2"],
      ["hover", "tab-1"],
      ["select", "tab-1"],
      ["focus", "tab-1", "@e1", "--force"],
      ["mouse-move", "tab-1", "40"],
      ["mouse-move", "tab-1", "40", "60", "--steps", "0"],
      ["mouse-move", "tab-1", "40", "99999"],
      ["mouse-click", "tab-1", "40", "x"],
      ["mouse-wheel", "tab-1", "0"],
      ["key-down", "tab-1"],
      ["type", "tab-1"],
      ["type", "tab-1", "--stdin", "--delay", "2000"],
      ["insert-text", "tab-1"],
      ["paste", "tab-1", "--html"],
      ["release-input"],
      ["release-input", "tab-1", "tab-2"],
    ])
      await expect(
        runCli(args, {
          env,
          fetch: unused,
          health: current,
          stdin: Readable.from(["x"]),
          stdout: sink(),
        }),
        args.join(" "),
      ).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
  });

  it("prints the new results", async () => {
    const print = async (args, answer, piped) => {
      const stdout = sink();
      expect(
        await runCli(args, {
          env,
          fetch: vi.fn(async () => Response.json(answer)),
          health: current,
          ...(piped === undefined ? {} : { stdin: Readable.from([piped]) }),
          stdout,
        }),
        args.join(" "),
      ).toBe(0);
      return stdout.text();
    };
    const clicked = { ok: true, url: tab.url, point: { x: 40, y: 60 } };
    expect(await print(["click", "tab-1", "@e2"], clicked)).toBe(
      "ok: clicked at 40,60\n",
    );
    expect(
      await print(["click", "tab-1", "@e2"], { ...clicked, loading: true }),
    ).toBe("ok: clicked at 40,60 (page loading)\n");
    expect(await print(["dblclick", "tab-1", "@e2"], clicked)).toBe(
      "ok: clicked at 40,60\n",
    );
    expect(
      await print(["hover", "tab-1", "@e2"], {
        ok: true,
        point: { x: 12, y: 8 },
      }),
    ).toBe("ok: moved to 12,8\n");
    expect(
      await print(
        ["fill", "tab-1", "@e1", "--stdin"],
        { ok: true, match: "equivalent", value: "12.50" },
        "12.5",
      ),
    ).toBe("ok: filled (equivalent)\n");
    expect(
      await print(["select", "tab-1", "@e1", "pro", "team"], {
        ok: true,
        values: ["pro", "team"],
      }),
    ).toBe("ok: selected pro, team\n");
    expect(
      await print(["select", "tab-1", "@e1"], { ok: true, values: [] }),
    ).toBe("ok: selection cleared\n");
    expect(
      await print(["mouse-move", "tab-1", "40", "60"], {
        ok: true,
        input: pointer,
      }),
    ).toBe("ok: mouse at 40,60 buttons 0\n");
    expect(
      await print(["mouse-down", "tab-1"], {
        ok: true,
        input: { ...pointer, buttons: 1 },
      }),
    ).toBe("ok: mouse at 40,60 buttons 1\n");
    expect(
      await print(["key-down", "tab-1", "Shift"], {
        ok: true,
        input: { ...pointer, keys: ["Shift"], modifiers: 8 },
      }),
    ).toBe("ok: keys Shift\n");
    expect(
      await print(["key-up", "tab-1", "Shift"], { ok: true, input: pointer }),
    ).toBe("ok: no keys held\n");
    expect(
      await print(["release-input", "tab-1"], {
        ok: true,
        released: ["Shift", "left"],
      }),
    ).toBe("ok: released Shift, left\n");
    expect(
      await print(["release-input", "tab-1"], { ok: true, released: [] }),
    ).toBe("ok: nothing held\n");
    expect(
      await print(
        ["paste", "tab-1", "--stdin"],
        { ok: true, handled: "page" },
        "hello",
      ),
    ).toBe("ok\n");
    // --json prints the body unchanged.
    const json = sink();
    await runCli(["mouse-wheel", "tab-1", "0", "120", "--json"], {
      env,
      fetch: vi.fn(async () => Response.json({ ok: true, input: pointer })),
      health: current,
      stdout: json,
    });
    expect(JSON.parse(json.text())).toEqual({ ok: true, input: pointer });
  });

  it("refuses level 4 calls and flags against an older app", async () => {
    const api = fakeApi(inputAnswers);
    const page = await inputPage(api, level3);
    const sent = api.requests.length;
    for (const [call, fields] of [
      [() => page.hover("@e1"), { entry: "page.hover" }],
      [() => page.dblclick("@e1"), { entry: "page.dblclick" }],
      [() => page.selectOption("@e1", "pro"), { entry: "page.selectOption" }],
      [() => page.focus("@e1"), { entry: "page.focus" }],
      [() => page.dragAndDrop("@e1", "#zone"), { entry: "page.dragAndDrop" }],
      [() => page.releaseInput(), { entry: "page.releaseInput" }],
      [() => page.mouse.move(10, 10), { entry: "page.mouse.move" }],
      [() => page.keyboard.type("hi"), { entry: "page.keyboard.type" }],
      [
        () => page.click("@e1", { force: true }),
        { entry: "page.click", option: "force" },
      ],
      [
        () => page.fill("@e1", "x", { append: true }),
        { entry: "page.fill", option: "append" },
      ],
      [
        () => page.press("Enter", "@e1", { delay: 10 }),
        { entry: "page.press", option: "delay" },
      ],
    ])
      await expect(call()).rejects.toMatchObject({
        code: "app_outdated",
        required: 4,
        available: 3,
        ...fields,
      });
    expect(api.requests).toHaveLength(sent);
    // The CLI makes the same check after its health check and before the
    // route, for a new command and for a level 4 flag on an old one.
    const older = fakeApi(inputAnswers);
    await expect(
      runCli(["hover", "tab-1", "@e1"], {
        env,
        fetch: older.fetch,
        health: level3,
        stdout: sink(),
      }),
    ).rejects.toMatchObject({
      code: "app_outdated",
      entry: "hover",
      required: 4,
      available: 3,
    });
    await expect(
      runCli(["click", "tab-1", "@e1", "--force"], {
        env,
        fetch: older.fetch,
        health: level3,
        stdout: sink(),
      }),
    ).rejects.toMatchObject({
      code: "app_outdated",
      entry: "click",
      option: "force",
      required: 4,
    });
    expect(older.requests).toEqual([]);
  });

  it("releases input at the end of a run", async () => {
    const released = [];
    const table = {
      ...sectionTwo,
      "POST /tabs/tab-1/click": {
        ok: true,
        url: tab.url,
        point: { x: 1, y: 2 },
      },
      "POST /tabs/tab-2/click": {
        ok: true,
        url: tab.url,
        point: { x: 1, y: 2 },
      },
      "POST /tabs/tab-1/input/release": () => {
        released.push("tab-1");
        return Response.json({ ok: true, released: ["Shift"] });
      },
      // A failed release is not the script's business.
      "POST /tabs/tab-2/input/release": () => {
        released.push("tab-2");
        return Response.json(
          { error: { code: "tab_not_found", message: "Gone." } },
          { status: 404 },
        );
      },
    };
    const clicked = await runIn(
      'const [first, second] = await (await space("space-1")).tabs(); await first.click("@e2"); await second.click("@e2"); process.stdout.write("done\\n");',
      table,
      { options: { health: current } },
    );
    expect(clicked).toMatchObject({ status: 0, stdout: "done\n", stderr: "" });
    expect(released).toEqual(["tab-1", "tab-2"]);
    expect(
      clicked.api.requests.filter((item) =>
        item.path.endsWith("/input/release"),
      ),
    ).toHaveLength(2);
    // A page the run only listed holds nothing to let go of.
    released.length = 0;
    const listed = await runIn(
      'await (await space("space-1")).tabs(); process.stdout.write("listed\\n");',
      table,
      { options: { health: current } },
    );
    expect(listed).toMatchObject({ status: 0, stdout: "listed\n", stderr: "" });
    expect(released).toEqual([]);
  });

  it("registers the end-of-run release once when a run and the REPL share a session", async () => {
    const api = fakeApi({
      ...sectionTwo,
      "POST /tabs/tab-1/input/release": { ok: true, released: ["Shift"] },
    });
    const shared = new Session({ env, fetch: api.fetch, health: current });
    // run and the REPL hand connect a session they already hold, so its end
    // hooks must not stack up on a second connect.
    await connect({ session: shared });
    await connect({ session: shared });
    const { signal } = new AbortController();
    for (const hook of shared.endHooks)
      await hook({ touched: ["tab-1"], signal });
    expect(
      api.requests.filter((item) => item.path.endsWith("/input/release")),
    ).toHaveLength(1);
  });

  // Section 8's client surface: page scripts, the page's own fetch, protocol
  // commands, recorded events and clearing one site's data.
  const scriptAnswers = {
    ...inputAnswers,
    "POST /tabs/tab-1/evaluate": { ok: true, tab: slots, value: 42 },
  };
  // What one evaluate answer resolves to, through a page of its own.
  const evaluated = async (answer) => {
    const api = fakeApi({
      ...scriptAnswers,
      "POST /tabs/tab-1/evaluate": { ok: true, tab: slots, ...answer },
    });
    const page = await inputPage(api);
    return { page, value: await page.evaluate(() => document.title) };
  };
  // What a CLI command printed for one answer.
  const printed = async (args, answer, piped) => {
    const stdout = sink();
    expect(
      await runCli(args, {
        env,
        fetch: vi.fn(async () => Response.json(answer)),
        health: current,
        ...(piped === undefined ? {} : { stdin: Readable.from([piped]) }),
        stdout,
      }),
      args.join(" "),
    ).toBe(0);
    return stdout.text();
  };
  // A fetch's whole answer, a non-2xx one included.
  const fetchedResponse = {
    ok: false,
    status: 404,
    statusText: "Not Found",
    url: "https://example.test/api/cart",
    redirected: true,
    type: "basic",
    headers: { "content-type": "application/json", "x-total": "0" },
    body: '{"items":[]}',
  };
  // The head of a streamed body, and an NDJSON answer that arrives in
  // pieces of a few hundred bytes, so lines are split across chunks.
  const streamedHead = {
    ok: true,
    status: 200,
    statusText: "OK",
    url: "https://example.test/report.bin",
    redirected: false,
    type: "basic",
    headers: { "content-type": "application/octet-stream" },
  };
  const ndjsonAnswer =
    (lines, size = 777) =>
    () => {
      const text = Buffer.from(
        lines.map((item) => `${JSON.stringify(item)}\n`).join(""),
      );
      const parts = [];
      for (let at = 0; at < text.length; at += size)
        parts.push(text.subarray(at, at + size));
      return new Response(ReadableStream.from(parts), {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    };
  // A 300000 byte body as three data lines and its end.
  const streamedBytes = randomBytes(300000);
  const dataLines = [0, 100000, 200000].map((at) => ({
    data: streamedBytes.subarray(at, at + 100000).toString("base64"),
  }));
  const savedStream = ndjsonAnswer([
    { head: streamedHead },
    ...dataLines,
    { end: { bytes: 300000 } },
  ]);
  const fetchFolder = async () => {
    const directory = await mkdtemp(join(tmpdir(), "kamapathy-fetch-test-"));
    directories.push(directory);
    return directory;
  };

  it("page.evaluate decodes every value form", async () => {
    const { page, value } = await evaluated({
      value: { rows: [1, 2], name: "Avery", none: null },
    });
    expect(value).toEqual({ rows: [1, 2], name: "Avery", none: null });
    // The answer carries the tab, so the page follows it.
    expect([page.url, page.title]).toEqual([slots.url, slots.title]);
    for (const [answer, expected] of [
      [{ value: null }, null],
      [{ value: "Slots" }, "Slots"],
      [{ value: 0 }, 0],
      [{ unserializable: "NaN" }, Number.NaN],
      [{ unserializable: "Infinity" }, Number.POSITIVE_INFINITY],
      [{ unserializable: "-Infinity" }, Number.NEGATIVE_INFINITY],
      [{ unserializable: "-0" }, -0],
      [{ unserializable: "12n" }, 12n],
      [{ unserializable: "-9007199254740993n" }, -9007199254740993n],
      [{}, undefined],
    ])
      expect(
        Object.is((await evaluated(answer)).value, expected),
        JSON.stringify(answer),
      ).toBe(true);
    await expect(evaluated({ unserializable: "Wat" })).rejects.toMatchObject({
      code: "invalid_response",
      entry: "page.evaluate",
    });
    // The CLI prints the value as JSON, and the rest as JavaScript writes them.
    for (const [answer, text] of [
      [{ value: { rows: 3 } }, '{"rows":3}'],
      [{ value: "Slots" }, '"Slots"'],
      [{ value: null }, "null"],
      [{ unserializable: "NaN" }, "NaN"],
      [{ unserializable: "-0" }, "-0"],
      [{ unserializable: "12n" }, "12n"],
      [{}, "undefined"],
    ])
      expect(
        await printed(
          ["evaluate", "tab-1", "--stdin"],
          { ok: true, tab: slots, ...answer },
          "document.title",
        ),
        JSON.stringify(answer),
      ).toBe(`${text}\n`);
    const json = sink();
    await runCli(["evaluate", "tab-1", "--stdin", "--json"], {
      env,
      fetch: vi.fn(async () =>
        Response.json({ ok: true, tab: slots, unserializable: "12n" }),
      ),
      health: current,
      stdin: Readable.from(["10n + 2n"]),
      stdout: json,
    });
    expect(JSON.parse(json.text())).toEqual({
      ok: true,
      tab: slots,
      unserializable: "12n",
    });
  });

  it("page.evaluate refuses a bad call before sending", async () => {
    const api = fakeApi(scriptAnswers);
    const page = await inputPage(api);
    const sent = api.requests.length;
    const expected = "page.evaluate(fnOrString, arg?, { timeout? })";
    // An expression takes no argument.
    for (const arg of [5, null, { rows: 3 }])
      await expect(
        page.evaluate("document.title", arg),
        JSON.stringify(arg),
      ).rejects.toMatchObject({
        code: "invalid_argument",
        entry: "page.evaluate",
        expected,
      });
    // An argument must be JSON data, and the error names where it is not.
    const loop = { name: "loop" };
    loop.self = loop;
    for (const [arg, what, path] of [
      [{ items: [{ total: 12n }] }, "a BigInt", "arg.items[0].total"],
      [5n, "a BigInt", "arg"],
      [{ total: Number.POSITIVE_INFINITY }, "Infinity", "arg.total"],
      [[1, Number.NaN], "NaN", "arg[1]"],
      [{ run: () => 1 }, "a function", "arg.run"],
      [{ tag: Symbol("tag") }, "a symbol", "arg.tag"],
      [loop, "a cycle", "arg.self"],
      [[1, undefined], "undefined", "arg[1]"],
      [{ "first name": [undefined] }, "undefined", 'arg["first name"][0]'],
    ]) {
      const refused = await page.evaluate((value) => value, arg).then(
        () => null,
        (error) => error,
      );
      expect(refused, path).toMatchObject({
        code: "invalid_argument",
        entry: "page.evaluate",
        expected: `JSON data at ${path}`,
      });
      expect(refused.message, path).toBe(
        `page.evaluate got ${what} at ${path}, which JSON cannot carry. Pass strings, finite numbers, booleans, null, arrays and objects.`,
      );
    }
    // The first argument, the options and their range are checked too.
    for (const call of [
      () => page.evaluate(5),
      () => page.evaluate(""),
      () => page.evaluate(() => 1, undefined, { timeout: 1000 }),
      () => page.evaluate(() => 1, undefined, { timeoutMs: 5000 }),
    ])
      await expect(call(), String(call)).rejects.toMatchObject({
        entry: "page.evaluate",
      });
    expect(api.requests).toHaveLength(sent);
    // An undefined property is absent, and an object reached twice is no
    // cycle.
    const shared = { n: 1 };
    await page.evaluate((value) => value, { a: shared, b: shared, c: undefined });
    expect(api.requests.at(-1).body).toEqual({
      function: "(value) => value",
      arg: { a: { n: 1 }, b: { n: 1 } },
      timeoutMs: 15000,
    });
    // The CLI needs the expression on stdin.
    const unused = vi.fn();
    for (const args of [
      ["evaluate", "tab-1"],
      ["evaluate", "tab-1", "--stdin", "--timeout", "1000"],
      ["evaluate", "tab-1", "--stdin", "--frame", "0"],
    ])
      await expect(
        runCli(args, {
          env,
          fetch: unused,
          health: current,
          stdin: Readable.from(["document.title"]),
          stdout: sink(),
        }),
        args.join(" "),
      ).rejects.toThrow();
    await expect(
      runCli(["evaluate", "tab-1", "--stdin"], {
        env,
        fetch: unused,
        health: current,
        stdin: Readable.from(["  \n"]),
        stdout: sink(),
      }),
    ).rejects.toThrow(/expression/);
    expect(unused).not.toHaveBeenCalled();
  });

  it("page.evaluate sends the function source and the argument", async () => {
    const api = fakeApi(scriptAnswers);
    const page = await inputPage(api);
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    try {
      expect(await page.evaluate((x) => x * 2, 21)).toBe(42);
      expect(api.requests.at(-1)).toEqual({
        method: "POST",
        path: "/tabs/tab-1/evaluate",
        body: { function: "(x) => x * 2", arg: 21, timeoutMs: 15000 },
      });
      expect(timeouts).toHaveBeenLastCalledWith(20000);
      await page.evaluate(() => document.title);
      expect(api.requests.at(-1).body).toEqual({
        function: "() => document.title",
        timeoutMs: 15000,
      });
      await page.evaluate(
        "await Promise.resolve(document.title)",
        undefined,
        { timeout: 9000 },
      );
      expect(api.requests.at(-1).body).toEqual({
        expression: "await Promise.resolve(document.title)",
        timeoutMs: 9000,
      });
      expect(timeouts).toHaveBeenLastCalledWith(14000);
      // An async function travels in the function field with its argument,
      // never as an expression: the page awaits a called function's promise,
      // where replMode would answer {}.
      await page.evaluate(async (args) => args.stars + 1, { stars: 3 });
      expect(api.requests.at(-1).body).toEqual({
        function: "async (args) => args.stars + 1",
        arg: { stars: 3 },
        timeoutMs: 15000,
      });
      // Every JSON argument is sent as given, a falsy one included.
      for (const arg of [0, false, null, "", [], {}]) {
        await page.evaluate((value) => value, arg);
        expect(api.requests.at(-1).body, JSON.stringify(arg)).toEqual({
          function: "(value) => value",
          arg,
          timeoutMs: 15000,
        });
      }
      // A function is sent as what its toString gives, so a site pack's
      // page tool, which is source text read from its file, reaches the
      // function field with its checked arguments. The newline it ends with
      // keeps a trailing line comment from swallowing the call.
      const tool = "async (args) => args.stars + 1 // the open repository";
      const fromText = Object.assign(() => {}, { toString: () => `${tool}\n` });
      await page.evaluate(fromText, { stars: 3 });
      expect(api.requests.at(-1).body).toEqual({
        function: `${tool}\n`,
        arg: { stars: 3 },
        timeoutMs: 15000,
      });
      // The command sends the expression as it was piped.
      await runCli(["evaluate", "tab-1", "--stdin", "--timeout", "30000"], {
        env,
        fetch: api.fetch,
        health: current,
        stdin: Readable.from(["\nawait 1\n"]),
        stdout: sink(),
      });
      expect(api.requests.at(-1)).toEqual({
        method: "POST",
        path: "/tabs/tab-1/evaluate",
        body: { expression: "\nawait 1\n", timeoutMs: 30000 },
      });
      expect(timeouts).toHaveBeenLastCalledWith(35000);
    } finally {
      timeouts.mockRestore();
    }
    // A body up to the route's 1 MiB is sent; past it nothing is.
    await page.evaluate((value) => value.length, "x".repeat(600000));
    expect(api.requests.at(-1).body.arg).toHaveLength(600000);
    const sent = api.requests.length;
    await expect(
      page.evaluate((value) => value.length, "x".repeat(1100000)),
    ).rejects.toMatchObject({ code: "request_too_large" });
    expect(api.requests).toHaveLength(sent);
  });

  it("a page function's ReferenceError gets the hint about script variables", async () => {
    const failed = await runIn(
      `${firstPage} await page.evaluate(() => total);`,
      {
        ...sectionTwo,
        "POST /tabs/tab-1/evaluate": refusal(422, {
          code: "script_error",
          message:
            "The page function failed at line 1, column 7: ReferenceError: total is not defined",
          name: "ReferenceError",
          line: 1,
          column: 7,
          description: "ReferenceError: total is not defined",
        }),
      },
      { options: { health: current } },
    );
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(
      "error: script_error: The page function failed at line 1, column 7: ReferenceError: total is not defined\n",
    );
    expect(failed.stderr).toContain(
      "hint: Page functions run in the page and cannot see script variables. Pass values as the argument: page.evaluate((x) => x * 2, x).\n",
    );
  });

  it("a refused protocol command gets a hint naming its reason", async () => {
    const hints = async (fields) => {
      const failed = await runIn(
        `${firstPage} await page.cdp(${JSON.stringify(fields.method)});`,
        {
          ...sectionTwo,
          "POST /tabs/tab-1/cdp": refusal(403, {
            code: "cdp_method_blocked",
            message: `Kamapathy does not pass ${fields.method}.`,
            ...fields,
          }),
        },
        { options: { health: current } },
      );
      expect(failed.status, fields.method).toBe(1);
      return failed.stderr
        .split("\n")
        .filter((text) => text.startsWith("hint: "));
    };
    expect(
      await hints({ method: "Network.getCookies", reason: "session" }),
    ).toEqual(["hint: Kamapathy refused Network.getCookies for reason session."]);
    expect(
      await hints({ method: "Page.bringToFront", reason: "person" }),
    ).toEqual(["hint: Kamapathy refused Page.bringToFront for reason person."]);
    // A command that is the person's names the call that does the same.
    expect(
      await hints({
        method: "Fetch.enable",
        reason: "person",
        param: "handleAuthRequests",
      }),
    ).toEqual([
      "hint: Kamapathy refused Fetch.enable for reason person. space.setHTTPCredentials({ origin, username, password }) answers a site's sign-in in this space.",
    ]);
    expect(
      await hints({ method: "Fetch.continueWithAuth", reason: "person" }),
    ).toEqual([
      "hint: Kamapathy refused Fetch.continueWithAuth for reason person. space.setHTTPCredentials({ origin, username, password }) answers a site's sign-in in this space.",
    ]);
    for (const param of ["key", "commands", "button"])
      expect(
        await hints({ method: "Input.dispatchKeyEvent", reason: "person", param }),
        param,
      ).toEqual([
        "hint: Kamapathy refused Input.dispatchKeyEvent for reason person. page.keyboard.paste(text) offers the page a paste without the system clipboard.",
      ]);
  });

  it("page.fetch resolves the response object", async () => {
    const api = fakeApi({
      ...scriptAnswers,
      "POST /tabs/tab-1/fetch": {
        ok: true,
        tab: slots,
        response: fetchedResponse,
      },
    });
    const page = await inputPage(api);
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    try {
      expect(await page.fetch("/api/cart")).toEqual(fetchedResponse);
      expect(api.requests.at(-1)).toEqual({
        method: "POST",
        path: "/tabs/tab-1/fetch",
        body: { url: "/api/cart", timeoutMs: 20000 },
      });
      expect(timeouts).toHaveBeenLastCalledWith(25000);
      // Every option reaches the route under its own name, timeout as
      // timeoutMs.
      const options = {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Token": "t" },
        body: '{"qty":2}',
        cache: "no-store",
        credentials: "include",
        integrity: "sha256-abc",
        keepalive: true,
        mode: "same-origin",
        redirect: "manual",
        referrer: "https://example.test/",
        referrerPolicy: "no-referrer",
        timeout: 45000,
      };
      await page.fetch("https://example.test/api/cart", options);
      const { timeout, ...fields } = options;
      expect(api.requests.at(-1).body).toEqual({
        url: "https://example.test/api/cart",
        ...fields,
        timeoutMs: timeout,
      });
      expect(timeouts).toHaveBeenLastCalledWith(50000);
    } finally {
      timeouts.mockRestore();
    }
    // A bad option, and a timeout past a minute without saveAs, are refused
    // before anything is sent.
    const sent = api.requests.length;
    for (const [options, option] of [
      [{ timeout: 61000 }, "timeout"],
      [{ timeout: 500 }, "timeout"],
      [{ mode: "navigate" }, "mode"],
      [{ timout: 1000 }, "timout"],
    ])
      await expect(
        page.fetch("/api/cart", options),
        JSON.stringify(options),
      ).rejects.toMatchObject({
        code: "invalid_option",
        entry: "page.fetch",
        option,
      });
    await expect(page.fetch("")).rejects.toMatchObject({
      code: "invalid_argument",
      entry: "page.fetch",
    });
    expect(api.requests).toHaveLength(sent);
    // The command prints the status line, the headers and the body.
    expect(
      await printed(["fetch", "tab-1", "/api/cart"], {
        ok: true,
        tab: slots,
        response: fetchedResponse,
      }),
    ).toBe(
      [
        "404 Not Found basic https://example.test/api/cart redirected",
        "content-type: application/json",
        "x-total: 0",
        "",
        '{"items":[]}',
        "",
      ].join("\n"),
    );
    // An opaque answer has no status text, headers or body to print.
    expect(
      await printed(["fetch", "tab-1", "https://cdn.test/x"], {
        ok: true,
        tab: slots,
        response: {
          ok: false,
          status: 0,
          statusText: "",
          url: "https://cdn.test/x",
          redirected: false,
          type: "opaque",
          headers: {},
          body: "",
        },
      }),
    ).toBe("0 opaque https://cdn.test/x\n");
    // Its flags build the same body.
    const cli = fakeApi({
      ...scriptAnswers,
      "POST /tabs/tab-1/fetch": {
        ok: true,
        tab: slots,
        response: fetchedResponse,
      },
    });
    await runCli(
      [
        "fetch",
        "tab-1",
        "https://example.test/api/cart",
        "--method",
        "POST",
        "--header",
        "Content-Type: application/json",
        "--header",
        "X-Token:  t ",
        "--stdin",
        "--timeout",
        "45000",
      ],
      {
        env,
        fetch: cli.fetch,
        health: current,
        stdin: Readable.from(['{"qty":2}']),
        stdout: sink(),
      },
    );
    expect(cli.requests).toEqual([
      {
        method: "POST",
        path: "/tabs/tab-1/fetch",
        body: {
          url: "https://example.test/api/cart",
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Token": "t" },
          body: '{"qty":2}',
          timeoutMs: 45000,
        },
      },
    ]);
    const unused = vi.fn();
    for (const args of [
      ["fetch", "tab-1"],
      ["fetch", "tab-1", "/x", "--header", "no colon"],
      ["fetch", "tab-1", "/x", "--header", ": empty"],
      ["fetch", "tab-1", "/x", "--timeout", "61000"],
      ["fetch", "tab-1", "/x", "--timeout", "500"],
      ["fetch", "tab-1", "/x", "--mode", "cors"],
      ["fetch", "tab-1", "/x", "--method", "GET", "--method", "POST"],
      ["fetch", "tab-1", "/x", "/y"],
    ])
      await expect(
        runCli(args, {
          env,
          fetch: unused,
          health: current,
          stdin: Readable.from(["x"]),
          stdout: sink(),
        }),
        args.join(" "),
      ).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
  });

  it("saveAs streams and never overwrites", async () => {
    const directory = await fetchFolder();
    const path = join(directory, "report.bin");
    const api = fakeApi({
      ...scriptAnswers,
      "POST /tabs/tab-1/fetch": savedStream,
    });
    const page = await inputPage(api);
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    try {
      expect(
        await page.fetch("/report.bin", { saveAs: path, timeout: 120000 }),
      ).toEqual({ ...streamedHead, savedPath: path, bytes: 300000 });
      expect(timeouts).toHaveBeenLastCalledWith(125000);
    } finally {
      timeouts.mockRestore();
    }
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/fetch",
      body: { url: "/report.bin", timeoutMs: 120000, stream: true },
    });
    expect((await readFile(path)).equals(streamedBytes)).toBe(true);
    if (posix) expect((await stat(path)).mode & 0o777).toBe(0o600);
    // A path already taken fails before anything is sent, and the file
    // stays as it was.
    const sent = api.requests.length;
    await expect(
      page.fetch("/report.bin", { saveAs: path }),
    ).rejects.toMatchObject({ code: "file_exists", path, entry: "page.fetch" });
    expect(api.requests).toHaveLength(sent);
    expect((await readFile(path)).equals(streamedBytes)).toBe(true);
    // An error line, a stream without its end line and a refusal before the
    // head each leave no file behind.
    const failures = [
      [
        ndjsonAnswer([
          { head: streamedHead },
          dataLines[0],
          {
            error: {
              code: "fetch_timeout",
              message: "The fetch did not answer within 20000 ms.",
              awaited: "body",
              timeoutMs: 20000,
            },
          },
          dataLines[1],
        ]),
        {
          code: "fetch_timeout",
          status: 504,
          awaited: "body",
          timeoutMs: 20000,
        },
      ],
      [
        ndjsonAnswer([{ head: streamedHead }, dataLines[0]]),
        { code: "download_interrupted" },
      ],
      [
        ndjsonAnswer([{ head: streamedHead }, ...dataLines, { end: { bytes: 5 } }]),
        { code: "download_interrupted" },
      ],
      [
        () =>
          new Response(`${JSON.stringify({ head: streamedHead })}\n{"data":`, {
            headers: { "Content-Type": "application/x-ndjson" },
          }),
        { code: "download_interrupted" },
      ],
      [
        () => new Response("not json\n"),
        { code: "invalid_response" },
      ],
      [
        refusal(403, {
          code: "agent_scripts_off",
          message:
            "Page scripts are off in Kamapathy's Settings, under Agents. Continue with snapshots and actions.",
        }),
        { code: "agent_scripts_off", status: 403 },
      ],
    ];
    for (const [answer, expected] of failures) {
      const failing = fakeApi({
        ...scriptAnswers,
        "POST /tabs/tab-1/fetch": answer,
      });
      const target = join(directory, `failed-${expected.code}.bin`);
      const failed = await (await inputPage(failing))
        .fetch("/report.bin", { saveAs: target })
        .then(
          () => null,
          (error) => error,
        );
      expect(failed, expected.code).toMatchObject({
        ...expected,
        entry: "page.fetch",
      });
      expect(existsSync(target), expected.code).toBe(false);
    }
  });

  it("a takeover during a saved fetch stops the run", async () => {
    const directory = await fetchFolder();
    const target = join(directory, "taken.bin");
    const message =
      "The person took over this space. Stop, and resume only when they ask you to.";
    const run = await runIn(
      `${firstPage}
      const error = await page.fetch("/report.bin", { saveAs: ${JSON.stringify(target)} }).catch((error) => error);
      globalThis.__scripted = { code: error.code, hardStop: error.hardStop };
      process.stdout.write("after\\n");`,
      {
        ...sectionTwo,
        "POST /tabs/tab-1/fetch": ndjsonAnswer([
          { head: streamedHead },
          dataLines[0],
          {
            error: {
              code: "human_control",
              message,
              reason: "manual",
              spaceId: "space-1",
            },
          },
        ]),
      },
      { options: { health: current } },
    );
    expect(run).toMatchObject({
      status: 3,
      stdout: "",
      stderr: `${takeover}${message}\n${withheld}`,
    });
    expect(globalThis.__scripted).toEqual({
      code: "human_control",
      hardStop: true,
    });
    expect(existsSync(target)).toBe(false);
  });

  it("fetch --save cleans up after a failure", async () => {
    const directory = await fetchFolder();
    const path = join(directory, "report.bin");
    const api = fakeApi({
      ...scriptAnswers,
      "POST /tabs/tab-1/fetch": savedStream,
    });
    const stdout = sink();
    expect(
      await runCli(
        ["fetch", "tab-1", "/report.bin", "--save", path, "--timeout", "90000"],
        { env, fetch: api.fetch, health: current, stdout },
      ),
    ).toBe(0);
    expect(api.requests).toEqual([
      {
        method: "POST",
        path: "/tabs/tab-1/fetch",
        body: { url: "/report.bin", timeoutMs: 90000, stream: true },
      },
    ]);
    expect(stdout.text()).toBe(
      [
        "200 OK basic https://example.test/report.bin",
        "content-type: application/octet-stream",
        `saved ${path} (300000 bytes)`,
        "",
      ].join("\n"),
    );
    expect((await readFile(path)).equals(streamedBytes)).toBe(true);
    // --json prints what page.fetch resolved, and a taken path is refused.
    const json = sink();
    const second = join(directory, "second.bin");
    await runCli(["fetch", "tab-1", "/report.bin", "--save", second, "--json"], {
      env,
      fetch: api.fetch,
      health: current,
      stdout: json,
    });
    expect(JSON.parse(json.text())).toEqual({
      ...streamedHead,
      savedPath: second,
      bytes: 300000,
    });
    const taken = sink();
    expect(
      await main(["fetch", "tab-1", "/report.bin", "--save", path], {
        env,
        fetch: api.fetch,
        health: current,
        stdout: sink(),
        stderr: taken,
      }),
    ).toBe(1);
    expect(taken.text()).toBe(
      `Kamapathy: ${path} already exists, so nothing was fetched. Choose another path or remove that file first.\n`,
    );
    // A failure in the stream prints its error and leaves no file.
    const failing = fakeApi({
      ...scriptAnswers,
      "POST /tabs/tab-1/fetch": ndjsonAnswer([
        { head: streamedHead },
        dataLines[0],
        {
          error: {
            code: "fetch_timeout",
            message: "The fetch did not answer within 20000 ms.",
            awaited: "body",
            timeoutMs: 20000,
          },
        },
      ]),
    });
    const target = join(directory, "failed.bin");
    const stderr = sink();
    expect(
      await main(["fetch", "tab-1", "/report.bin", "--save", target], {
        env,
        fetch: failing.fetch,
        health: current,
        stdout: sink(),
        stderr,
      }),
    ).toBe(1);
    expect(stderr.text()).toBe(
      "Kamapathy: 504 fetch_timeout: The fetch did not answer within 20000 ms.\n",
    );
    expect(existsSync(target)).toBe(false);
  });

  it("page.cdp and space cdp send params from stdin", async () => {
    const history = { entries: [], currentIndex: 0 };
    const targets = { targetInfos: [] };
    const answers = {
      ...scriptAnswers,
      "POST /tabs/tab-1/cdp": { ok: true, result: history, newSession: true },
      "POST /spaces/space-1/cdp": { ok: true, result: targets },
    };
    const api = fakeApi(answers);
    const client = await connect({ env, fetch: api.fetch, health: current });
    const research = await client.space("space-1");
    const page = await research.open("https://example.test/reserve");
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    try {
      expect(await page.cdp("Page.getNavigationHistory")).toEqual(history);
      expect(api.requests.at(-1)).toEqual({
        method: "POST",
        path: "/tabs/tab-1/cdp",
        body: {
          method: "Page.getNavigationHistory",
          params: {},
          timeoutMs: 15000,
        },
      });
      expect(timeouts).toHaveBeenLastCalledWith(20000);
      // A frame by its path or by its entry's ref, and a timeout of its own.
      await page.cdp(
        "Runtime.evaluate",
        { expression: "1" },
        { frame: "0/1", timeout: 5000 },
      );
      expect(api.requests.at(-1).body).toEqual({
        method: "Runtime.evaluate",
        params: { expression: "1" },
        frame: "0/1",
        timeoutMs: 5000,
      });
      expect(timeouts).toHaveBeenLastCalledWith(10000);
      await page.cdp("DOM.getDocument", undefined, { frame: "@e4" });
      expect(api.requests.at(-1).body).toEqual({
        method: "DOM.getDocument",
        params: {},
        frame: "@e4",
        timeoutMs: 15000,
      });
    } finally {
      timeouts.mockRestore();
    }
    expect(await research.cdp("Target.getTargets")).toEqual(targets);
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/spaces/space-1/cdp",
      body: { method: "Target.getTargets", params: {} },
    });
    await research.cdp("Browser.getVersion", { verbose: true });
    expect(api.requests.at(-1).body).toEqual({
      method: "Browser.getVersion",
      params: { verbose: true },
    });
    // A method outside the pattern, params JSON cannot carry, and a bad
    // option are refused before anything is sent.
    const sent = api.requests.length;
    for (const [call, code] of [
      [() => page.cdp("getNavigationHistory"), "invalid_argument"],
      [() => page.cdp("page.reload"), "invalid_argument"],
      [() => page.cdp("Page.navigate", { when: 1n }), "invalid_argument"],
      [() => page.cdp("Page.reload", {}, { timeout: 500 }), "invalid_option"],
      [() => page.cdp("Page.reload", {}, { frames: "0" }), "invalid_option"],
      [() => research.cdp("Target"), "invalid_argument"],
      [() => research.cdp("Target.getTargets", { at: Number.NaN }), "invalid_argument"],
    ])
      await expect(call(), String(call)).rejects.toMatchObject({ code });
    expect(api.requests).toHaveLength(sent);
    // The commands read the params from stdin.
    for (const [args, path, body, piped] of [
      [
        [
          "cdp",
          "tab-1",
          "Runtime.evaluate",
          "--stdin",
          "--frame",
          "0/1",
          "--timeout",
          "5000",
        ],
        "/tabs/tab-1/cdp",
        {
          method: "Runtime.evaluate",
          params: { expression: "1" },
          frame: "0/1",
          timeoutMs: 5000,
        },
        '{"expression":"1"}',
      ],
      [
        ["cdp", "tab-1", "Page.getNavigationHistory", "--frame", "@e4"],
        "/tabs/tab-1/cdp",
        { method: "Page.getNavigationHistory", frame: "@e4" },
      ],
      [
        ["space", "cdp", "space-1", "Target.getTargets", "--stdin"],
        "/spaces/space-1/cdp",
        { method: "Target.getTargets", params: {} },
        "{}",
      ],
      [
        ["space", "cdp", "space-1", "Browser.getVersion"],
        "/spaces/space-1/cdp",
        { method: "Browser.getVersion" },
      ],
    ]) {
      const cli = fakeApi(answers);
      await runCli(args, {
        env,
        fetch: cli.fetch,
        health: current,
        ...(piped === undefined ? {} : { stdin: Readable.from([piped]) }),
        stdout: sink(),
      });
      expect(cli.requests, args.join(" ")).toEqual([
        { method: "POST", path, body },
      ]);
    }
    // They print the result, and say when the command opened a new session.
    expect(
      await printed(["cdp", "tab-1", "Page.getNavigationHistory"], {
        ok: true,
        result: history,
        newSession: true,
      }),
    ).toBe(
      '{"entries":[],"currentIndex":0}\nnew session: enable again what earlier commands enabled\n',
    );
    expect(
      await printed(["space", "cdp", "space-1", "Target.getTargets"], {
        ok: true,
        result: targets,
      }),
    ).toBe('{"targetInfos":[]}\n');
    const unused = vi.fn();
    for (const [args, piped] of [
      [["cdp", "tab-1"]],
      [["cdp", "tab-1", "nope"]],
      [["cdp", "tab-1", "Page.reload", "--stdin"], "[1]"],
      [["cdp", "tab-1", "Page.reload", "--stdin"], "not json"],
      [["cdp", "tab-1", "Page.reload", "--timeout", "500"]],
      [["cdp", "tab-1", "Page.reload", "Page.stop"]],
      [["space", "cdp", "space-1"]],
      [["space", "cdp", "space-1", "Target.getTargets", "--frame", "0"]],
    ])
      await expect(
        runCli(args, {
          env,
          fetch: unused,
          health: current,
          stdin: Readable.from([piped ?? "{}"]),
          stdout: sink(),
        }),
        args.join(" "),
      ).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
  });

  it("events prints one line per event", async () => {
    const at = (seconds) => Date.UTC(2026, 9, 27, 10, 0, seconds, 5);
    const drained = {
      events: [
        { time: at(0), method: "Page.frameNavigated", params: { frame: {} } },
        {
          time: at(1),
          method: "Network.requestWillBeSent",
          params: {},
          frame: "0/1",
        },
        {
          time: at(2),
          method: "Network.responseReceived",
          frame: null,
          omitted: "too_large",
          bytes: 2097152,
        },
      ],
      dropped: 3,
      gaps: [{ reason: "human_control", from: at(3), to: at(9) }],
      remaining: 12,
    };
    const api = fakeApi({
      ...scriptAnswers,
      "POST /tabs/tab-1/events": { ok: true, ...drained },
    });
    const page = await inputPage(api);
    expect(await page.events()).toEqual(drained);
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/tabs/tab-1/events",
      body: { max: 10000 },
    });
    await page.events({ max: 50 });
    expect(api.requests.at(-1).body).toEqual({ max: 50 });
    const sent = api.requests.length;
    for (const options of [{ max: 0 }, { max: 10001 }, { limit: 5 }])
      await expect(
        page.events(options),
        JSON.stringify(options),
      ).rejects.toMatchObject({ code: "invalid_option", entry: "page.events" });
    expect(api.requests).toHaveLength(sent);
    // The command: time, the frame path or - for the page and gone for a
    // frame that has gone, and the method; then what was not recorded.
    expect(
      await printed(["events", "tab-1", "--max", "50"], {
        ok: true,
        ...drained,
      }),
    ).toBe(
      [
        "2026-10-27T10:00:00.005Z - Page.frameNavigated",
        "2026-10-27T10:00:01.005Z 0/1 Network.requestWillBeSent",
        "2026-10-27T10:00:02.005Z gone Network.responseReceived (too large, 2097152 bytes)",
        "dropped 3 events",
        "not recorded while human_control from 2026-10-27T10:00:03.005Z to 2026-10-27T10:00:09.005Z",
        "12 more events: run events again",
        "",
      ].join("\n"),
    );
    expect(
      await printed(["events", "tab-1"], {
        ok: true,
        events: [],
        dropped: 0,
        gaps: [],
        remaining: 0,
      }),
    ).toBe("No events.\n");
    const cli = fakeApi({
      ...scriptAnswers,
      "POST /tabs/tab-1/events": { ok: true, ...drained },
    });
    const json = sink();
    await runCli(["events", "tab-1", "--max", "50", "--json"], {
      env,
      fetch: cli.fetch,
      health: current,
      stdout: json,
    });
    expect(cli.requests).toEqual([
      { method: "POST", path: "/tabs/tab-1/events", body: { max: 50 } },
    ]);
    expect(JSON.parse(json.text())).toEqual({ ok: true, ...drained });
    const unused = vi.fn();
    for (const args of [
      ["events"],
      ["events", "tab-1", "--max", "0"],
      ["events", "tab-1", "--max", "10001"],
      ["events", "tab-1", "--stdin"],
    ])
      await expect(
        runCli(args, { env, fetch: unused, health: current, stdout: sink() }),
        args.join(" "),
      ).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
  });

  it("clear-site-data maps its flags", async () => {
    const cleared = {
      ok: true,
      origin: "https://shop.test",
      cleared: {
        cookies: { removed: 2, domains: ["shop.test", ".shop.test"] },
        storage: ["localStorage", "indexedDB"],
        cache: true,
      },
      approvedBy: "person",
    };
    const api = fakeApi({
      ...scriptAnswers,
      "POST /tabs/tab-1/clear-site-data": cleared,
    });
    const page = await inputPage(api);
    const timeouts = vi.spyOn(AbortSignal, "timeout");
    try {
      expect(await page.clearSiteData({ cookies: true })).toEqual(cleared);
      expect(api.requests.at(-1)).toEqual({
        method: "POST",
        path: "/tabs/tab-1/clear-site-data",
        body: { cookies: true, timeoutMs: 60000 },
      });
      expect(timeouts).toHaveBeenLastCalledWith(65000);
      await page.clearSiteData({
        origin: "https://shop.test",
        cookies: [{ name: "cart", path: "/" }],
        storage: ["localStorage"],
        cache: true,
        timeout: 120000,
      });
      expect(api.requests.at(-1).body).toEqual({
        origin: "https://shop.test",
        cookies: [{ name: "cart", path: "/" }],
        storage: ["localStorage"],
        cache: true,
        timeoutMs: 120000,
      });
      expect(timeouts).toHaveBeenLastCalledWith(125000);
    } finally {
      timeouts.mockRestore();
    }
    const sent = api.requests.length;
    for (const options of [
      undefined,
      {},
      { cache: false },
      { cookie: true },
      { cookies: true, timeout: 500 },
    ])
      await expect(
        page.clearSiteData(options),
        JSON.stringify(options),
      ).rejects.toMatchObject({
        code: "invalid_option",
        entry: "page.clearSiteData",
      });
    expect(api.requests).toHaveLength(sent);
    // The command's flags build the same bodies.
    for (const [args, body] of [
      [["clear-site-data", "tab-1", "--cookies"], { cookies: true }],
      [
        [
          "clear-site-data",
          "tab-1",
          "--origin",
          "https://shop.test",
          "--cookie",
          "cart",
          "--cookie",
          "session",
          "--storage",
          "--cache",
          "--timeout",
          "120000",
        ],
        {
          origin: "https://shop.test",
          cookies: [{ name: "cart" }, { name: "session" }],
          storage: true,
          cache: true,
          timeoutMs: 120000,
        },
      ],
      [["clear-site-data", "tab-1", "--storage"], { storage: true }],
    ]) {
      const cli = fakeApi({
        ...scriptAnswers,
        "POST /tabs/tab-1/clear-site-data": cleared,
      });
      await runCli(args, {
        env,
        fetch: cli.fetch,
        health: current,
        stdout: sink(),
      });
      expect(cli.requests, args.join(" ")).toEqual([
        { method: "POST", path: "/tabs/tab-1/clear-site-data", body },
      ]);
    }
    // It prints what was cleared, and who approved it.
    expect(await printed(["clear-site-data", "tab-1", "--cookies"], cleared)).toBe(
      "ok: cleared https://shop.test: 2 cookies from shop.test, .shop.test; storage localStorage, indexedDB; cache; approved by the person\n",
    );
    expect(
      await printed(["clear-site-data", "tab-1", "--cookie", "cart"], {
        ok: true,
        origin: "https://shop.test",
        cleared: { cookies: { removed: 0, domains: [] } },
      }),
    ).toBe("ok: cleared https://shop.test: 0 cookies\n");
    const unused = vi.fn();
    for (const args of [
      ["clear-site-data", "tab-1"],
      ["clear-site-data", "tab-1", "--cookies", "--cookie", "cart"],
      ["clear-site-data", "tab-1", "--cookie"],
      ["clear-site-data", "tab-1", "--cache", "--timeout", "500"],
      ["clear-site-data", "tab-1", "--cache", "--origin"],
      ["clear-site-data", "tab-1", "--cache", "--all"],
    ])
      await expect(
        runCli(args, { env, fetch: unused, health: current, stdout: sink() }),
        args.join(" "),
      ).rejects.toThrow();
    expect(unused).not.toHaveBeenCalled();
  });

  it("snapshots print frame entries and the unread line", async () => {
    const framed = {
      tabId: "tab-1",
      url: "https://shop.test/checkout",
      title: "Checkout",
      interactables: [
        { ref: "@e1", role: "button", label: "Pay" },
        {
          ref: "@e2",
          role: "iframe",
          label: "Card",
          crossOrigin: true,
          origin: "https://js.stripe.com",
          contentFrame: "0",
          content: "read",
        },
        {
          ref: "@e3",
          role: "textbox",
          label: "Card number",
          frame: "0",
          valueHidden: true,
        },
        {
          ref: "@e4",
          role: "iframe",
          label: "Map",
          crossOrigin: true,
          origin: "http://127.0.0.1:4321",
          contentFrame: "1",
          content: "pending",
        },
        {
          ref: "@e5",
          role: "iframe",
          label: "Ads",
          crossOrigin: true,
          origin: "opaque",
          contentFrame: "2",
          content: "unavailable",
        },
        {
          ref: "@e6",
          role: "iframe",
          label: "Deep",
          crossOrigin: true,
          origin: "https://deep.test",
          contentFrame: "3",
          content: "limit",
        },
        {
          ref: "@e7",
          role: "iframe",
          label: "Extension: Kamapathy marker",
          extension: "Kamapathy marker",
          crossOrigin: true,
          content: "blocked",
        },
        {
          ref: "@e8",
          role: "iframe",
          label: "Later",
          crossOrigin: true,
          content: "pending",
        },
      ],
      unreadFrames: 4,
      truncated: false,
    };
    const lines = [
      "Checkout",
      "https://shop.test/checkout",
      "",
      "Controls:",
      '@e1 button "Pay"',
      '@e2 iframe "Card" frame from js.stripe.com',
      '@e3 textbox "Card number" (value hidden)',
      '@e4 iframe "Map" frame from 127.0.0.1:4321, not read: still loading',
      '@e5 iframe "Ads" frame from an opaque origin, not read: did not respond',
      '@e6 iframe "Deep" frame from deep.test, not read: frame limit reached',
      '@e7 iframe "Extension: Kamapathy marker" extension or internal frame, not read',
      '@e8 iframe "Later" frame, not read: still loading',
      "",
      "4 frames were not read. Snapshot again, or scope to one with --root <ref>.",
    ];
    expect(formatSnapshot(framed)).toBe(lines.join("\n"));
    // One unread frame reads as one, and none prints no line.
    expect(
      formatSnapshot({ ...framed, unreadFrames: 1 }).split("\n").at(-1),
    ).toBe(
      "1 frame was not read. Snapshot again, or scope to one with --root <ref>.",
    );
    expect(formatSnapshot({ ...framed, unreadFrames: undefined })).toBe(
      lines.slice(0, -2).join("\n"),
    );
    // The command and page.text() print the same.
    expect(await printed(["snapshot", "tab-1"], framed)).toBe(
      `${lines.join("\n")}\n`,
    );
    const api = fakeApi({ ...scriptAnswers, "POST /tabs/tab-1/snapshot": framed });
    expect(await (await inputPage(api)).text()).toBe(lines.join("\n"));
  });

  it("each command sends one request and respects --json", async () => {
    const directory = await fetchFolder();
    const answers = {
      evaluate: { ok: true, tab: slots, value: 42 },
      fetch: { ok: true, tab: slots, response: fetchedResponse },
      cdp: { ok: true, result: { entries: [] } },
      "space cdp": { ok: true, result: { targetInfos: [] } },
      events: { ok: true, events: [], dropped: 0, gaps: [], remaining: 0 },
      "clear-site-data": {
        ok: true,
        origin: "https://shop.test",
        cleared: { cache: true },
      },
    };
    for (const [args, name, piped] of [
      [["evaluate", "tab-1", "--stdin"], "evaluate", "document.title"],
      [["fetch", "tab-1", "/api/cart"], "fetch"],
      [["cdp", "tab-1", "Page.getNavigationHistory"], "cdp"],
      [["space", "cdp", "space-1", "Target.getTargets"], "space cdp"],
      [["events", "tab-1"], "events"],
      [["clear-site-data", "tab-1", "--cache"], "clear-site-data"],
    ])
      for (const json of [false, true]) {
        const fetch = vi.fn(async () => Response.json(answers[name]));
        const stdout = sink();
        expect(
          await runCli(json ? [...args, "--json"] : args, {
            env,
            fetch,
            health: current,
            ...(piped === undefined ? {} : { stdin: Readable.from([piped]) }),
            stdout,
          }),
          args.join(" "),
        ).toBe(0);
        expect(fetch, args.join(" ")).toHaveBeenCalledTimes(1);
        if (json)
          expect(JSON.parse(stdout.text()), args.join(" ")).toEqual(
            answers[name],
          );
        else
          expect(stdout.text(), args.join(" ")).not.toBe(
            `${JSON.stringify(answers[name])}\n`,
          );
      }
    // A saved fetch is one request too.
    const fetch = vi.fn(savedStream);
    await runCli(
      ["fetch", "tab-1", "/report.bin", "--save", join(directory, "one.bin")],
      { env, fetch, health: current, stdout: sink() },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    // Each one is refused by name against a Kamapathy that predates it.
    const unused = vi.fn();
    for (const [args, piped] of [
      [["evaluate", "tab-1", "--stdin"], "1"],
      [["fetch", "tab-1", "/api/cart"]],
      [["fetch", "tab-1", "/x", "--save", join(directory, "old.bin")]],
      [["cdp", "tab-1", "Page.reload"]],
      [["space", "cdp", "space-1", "Target.getTargets"]],
      [["events", "tab-1"]],
      [["clear-site-data", "tab-1", "--cache"]],
    ])
      await expect(
        runCli(args, {
          env,
          fetch: unused,
          health: level3,
          ...(piped === undefined ? {} : { stdin: Readable.from([piped]) }),
          stdout: sink(),
        }),
        args.join(" "),
      ).rejects.toMatchObject({
        code: "app_outdated",
        required: 4,
        available: 3,
      });
    expect(unused).not.toHaveBeenCalled();
    expect(existsSync(join(directory, "old.bin"))).toBe(false);
  });
});

describe("client errors and timeouts", () => {
  it("KamapathyError copies structured fields; httpTimeout adds 5000 ms to a declared budget and keeps 45000 ms and 180000 ms otherwise", () => {
    const error = new KamapathyError("page_timeout", "The page did not load.", {
      status: 504,
      awaited: "load",
      timeoutMs: 100,
      name: "Other",
      stack: "replaced",
      cause: "replaced",
    });
    expect(error).toMatchObject({
      name: "KamapathyError",
      code: "page_timeout",
      message: "The page did not load.",
      status: 504,
      awaited: "load",
      timeoutMs: 100,
    });
    expect(error.stack).not.toBe("replaced");
    expect(Object.hasOwn(error, "cause")).toBe(false);
    // The client's own codes take retryable from the registry.
    expect(
      new KamapathyError("not_connected", "Busy.", { reason: "busy" })
        .retryable,
    ).toBe(true);
    expect(
      new KamapathyError("not_connected", "Off.", { reason: "access_off" }),
    ).not.toHaveProperty("retryable");
    const route = (key) =>
      schema.ROUTES.find((item) => schema.routeKey(item) === key);
    expect(
      httpTimeout(600000, route("POST /spaces/:id/wait-for-control")),
    ).toBe(605000);
    expect(httpTimeout(undefined, route("POST /tabs/:id/click"))).toBe(45000);
    expect(httpTimeout(undefined, route("POST /tabs/:id/actions"))).toBe(
      180000,
    );
    expect(httpTimeout(undefined, undefined)).toBe(45000);
  });
});

describe("updates", () => {
  const level3 = { status: "ok", version: "0.2.0", apiLevel: 3 };
  const INSTALLER = "Kamapathy-0.3.0-mac-arm64.dmg";
  const latest = {
    version: "0.3.0",
    publishedAt: 1760000000000,
    url: "https://github.com/shayanmohd/kamapathy/releases/tag/v0.3.0",
    installer: {
      name: INSTALLER,
      size: 94371840,
      url: `https://github.com/shayanmohd/kamapathy/releases/download/v0.3.0/${INSTALLER}`,
      sha256: "a".repeat(64),
    },
    sums: `${"a".repeat(64)}  ${INSTALLER}\n`,
  };
  const installer = {
    path: `/Users/avery/Library/Application Support/Kamapathy/updates/0.3.0/${INSTALLER}`,
    sha256: "a".repeat(64),
  };
  const state = (extra) => ({
    version: "0.2.0",
    checks: true,
    kind: "mac-arm64",
    checkedAt: 1760000000000,
    ...extra,
  });
  const available = state({ state: "available", latest });
  const downloading = state({ state: "downloading", latest });
  const ready = state({ state: "ready", latest, installer });
  const SETTINGS_STEP =
    "Next: when your task is done, ask the person to choose Install in Kamapathy's Settings, under Updates. Kamapathy quits to install, which closes agent spaces.";
  const NOTICE =
    "notice: update_available: Kamapathy 0.3.0 is out (this is 0.2.0). Finish this task first, then ask the person before you run kamapathy upgrade. Read the Kamapathy skill again after the update.\n";
  // The update routes, answered from a script: each GET /update takes the next
  // polled status, so a test proves how many polls ran.
  function updateApi({ check, download, polls = [], routes = {} }) {
    const requests = [];
    const answer = (entry) => {
      if (!entry) throw new Error("unexpected update request");
      return Response.json(entry.body, { status: entry.status ?? 200 });
    };
    const fetch = vi.fn(async (url, options = {}) => {
      const method = options.method || "GET";
      const key = `${method} ${url.pathname}`;
      requests.push(key);
      if (key === "POST /update/check") return answer(check);
      if (key === "POST /update/download") return answer(download);
      if (key === "GET /update") return answer(polls.shift());
      if (routes[key]) return Response.json(routes[key]);
      return Response.json(
        {
          error: {
            code: "route_not_found",
            message: `No route ${url.pathname}`,
          },
        },
        { status: 404 },
      );
    });
    return { fetch, requests };
  }
  // The client as an agent runs it: its own process, over the profile's socket.
  async function cli(args, profileEnv) {
    const child = spawn(
      process.execPath,
      ["skills/kamapathy/scripts/kamapathy.mjs", ...args],
      {
        env: { ...process.env, ...profileEnv },
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const status = await new Promise((done) => child.once("close", done));
    return { status, stdout, stderr };
  }

  it("upgrade waits for a verified installer and prints its path and next step", async () => {
    const api = updateApi({
      check: { body: available },
      download: { status: 202, body: downloading },
      polls: [{ body: downloading }, { body: downloading }, { body: ready }],
    });
    const stdout = sink();
    const stderr = sink();
    expect(
      await main(["upgrade"], {
        env,
        fetch: api.fetch,
        health: level3,
        stdout,
        stderr,
      }),
    ).toBe(0);
    expect(stdout.text()).toBe(
      [
        "Kamapathy 0.3.0 is downloaded and checked (this is 0.2.0).",
        `Installer: ${installer.path}`,
        SETTINGS_STEP,
        "Read the Kamapathy skill again once the new version runs.",
        "",
      ].join("\n"),
    );
    expect(stderr.text()).toBe(`Downloading ${INSTALLER} (94 MB)...\n`);
    expect(api.requests).toEqual([
      "POST /update/check",
      "POST /update/download",
      "GET /update",
      "GET /update",
      "GET /update",
    ]);
    // --json prints the status the command ends with.
    const json = sink();
    const jsonApi = updateApi({
      check: { body: ready },
      download: { body: ready },
    });
    expect(
      await main(["upgrade", "--json"], {
        env,
        fetch: jsonApi.fetch,
        health: level3,
        stdout: json,
        stderr: sink(),
      }),
    ).toBe(0);
    expect(JSON.parse(json.text())).toEqual(ready);
    // Each install kind names the step the person takes.
    const steps = {
      "mac-x64": SETTINGS_STEP,
      "windows-setup": SETTINGS_STEP,
      "windows-portable":
        "Next: when your task is done, ask the person to replace their copy of Kamapathy with this file.",
      "linux-appimage":
        "Next: when your task is done, ask the person to replace their copy of Kamapathy with this file.",
      "linux-deb":
        "Next: when your task is done, ask the person to install it from Kamapathy's Settings, under Updates, or with sudo apt install.",
    };
    for (const [kind, step] of Object.entries(steps)) {
      const body = { ...ready, kind };
      const kindApi = updateApi({ check: { body }, download: { body } });
      const out = sink();
      expect(
        await main(["upgrade"], {
          env,
          fetch: kindApi.fetch,
          health: level3,
          stdout: out,
          stderr: sink(),
        }),
        kind,
      ).toBe(0);
      expect(out.text().split("\n")[2], kind).toBe(step);
    }
    // A failure the status carries has no HTTP status of its own.
    const failedApi = updateApi({
      check: { body: available },
      download: { status: 202, body: downloading },
      polls: [
        {
          body: state({
            state: "available",
            latest,
            error: {
              code: "update_verify_failed",
              message:
                "The downloaded installer did not match its checksum, so it was deleted.",
              reason: "sums_mismatch",
              retryable: false,
              file: INSTALLER,
            },
          }),
        },
      ],
    });
    const failed = sink();
    expect(
      await main(["upgrade"], {
        env,
        fetch: failedApi.fetch,
        health: level3,
        stdout: sink(),
        stderr: failed,
      }),
    ).toBe(1);
    expect(failed.text()).toBe(
      [
        `Downloading ${INSTALLER} (94 MB)...`,
        "Kamapathy: update_verify_failed: The downloaded installer did not match its checksum, so it was deleted.",
        "",
      ].join("\n"),
    );
    const refusedApi = updateApi({
      check: {
        status: 409,
        body: {
          error: {
            code: "update_unsupported",
            message:
              "This copy runs from source. Pull the latest code to update it.",
            reason: "source",
            platform: "darwin",
            arch: "arm64",
          },
        },
      },
    });
    const refused = sink();
    expect(
      await main(["upgrade"], {
        env,
        fetch: refusedApi.fetch,
        health: level3,
        stdout: sink(),
        stderr: refused,
      }),
    ).toBe(1);
    expect(refused.text()).toBe(
      "Kamapathy: 409 update_unsupported: This copy runs from source. Pull the latest code to update it.\n",
    );
  }, 30000);

  it("upgrade --check and --timeout 0 do not wait", async () => {
    const api = updateApi({ check: { body: available } });
    const stdout = sink();
    const stderr = sink();
    expect(
      await main(["upgrade", "--check"], {
        env,
        fetch: api.fetch,
        health: level3,
        stdout,
        stderr,
      }),
    ).toBe(0);
    expect(stdout.text()).toBe(
      "Kamapathy 0.3.0 is available (this is 0.2.0). Run kamapathy upgrade, with the person's approval, to download it.\n",
    );
    expect(stderr.text()).toBe("");
    expect(api.requests).toEqual(["POST /update/check"]);
    const current = updateApi({ check: { body: state({ state: "current" }) } });
    const up = sink();
    expect(
      await main(["upgrade", "--check"], {
        env,
        fetch: current.fetch,
        health: level3,
        stdout: up,
        stderr: sink(),
      }),
    ).toBe(0);
    expect(up.text()).toBe("Kamapathy 0.2.0 is up to date.\n");
    expect(current.requests).toEqual(["POST /update/check"]);
    // --timeout 0 returns as soon as the download is under way.
    const zero = updateApi({
      check: { body: available },
      download: { status: 202, body: downloading },
    });
    const started = sink();
    expect(
      await main(["upgrade", "--timeout", "0"], {
        env,
        fetch: zero.fetch,
        health: level3,
        stdout: started,
        stderr: sink(),
      }),
    ).toBe(0);
    expect(started.text()).toBe(
      "Kamapathy is downloading 0.3.0. Run kamapathy upgrade again to wait for it.\n",
    );
    expect(zero.requests).toEqual([
      "POST /update/check",
      "POST /update/download",
    ]);
    const unused = vi.fn();
    for (const value of ["1800001", "x"]) {
      const bad = sink();
      expect(
        await main(["upgrade", "--timeout", value], {
          env,
          fetch: unused,
          health: level3,
          stdout: sink(),
          stderr: bad,
        }),
        value,
      ).toBe(1);
      expect(bad.text()).toBe(
        "Kamapathy: --timeout must be an integer from 0 to 1800000.\n",
      );
    }
    expect(unused).not.toHaveBeenCalled();
  });

  it("upgrade and other commands print no update notice", async () => {
    const { paths, env: profileEnv } = await profile();
    await fakeKamapathy(paths, {
      handler: (request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(
            request.url === "/health"
              ? {
                  status: "ok",
                  version: "0.2.0",
                  apiLevel: 3,
                  update: { version: "0.3.0", state: "available" },
                }
              : request.url === "/spaces"
                ? { spaces: [] }
                : request.url === "/update/check"
                  ? state({ state: "current" })
                  : {
                      tabId: "tab-1",
                      url: "https://example.test/",
                      title: "Example",
                      text: "Hello",
                      interactables: [],
                      truncated: false,
                    },
          ),
        );
      },
    });
    for (const args of [
      ["spaces"],
      ["snapshot", "tab-1"],
      ["upgrade", "--check"],
    ]) {
      const { status, stderr } = await cli(args, profileEnv);
      expect([args.join(" "), status, stderr]).toEqual([args.join(" "), 0, ""]);
    }
    // connect() without a session queues nothing, so no command but health does.
    takeNotices();
    const client = await connect({ env: profileEnv });
    await client.spaces();
    expect(takeNotices()).toEqual([]);
  }, 30000);

  it("health and run print one notice: update_available line through session.notice and keep the exit status", async () => {
    const { paths, env: profileEnv } = await profile();
    let update = { version: "0.3.0", state: "available" };
    await fakeKamapathy(paths, {
      handler: (request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(
            request.url === "/health"
              ? {
                  status: "ok",
                  version: "0.2.0",
                  apiLevel: 3,
                  ...(update ? { update } : {}),
                }
              : { spaces: [] },
          ),
        );
      },
    });
    expect(await cli(["health"], profileEnv)).toEqual({
      status: 0,
      stdout: "ok Kamapathy 0.2.0\n",
      stderr: NOTICE,
    });
    expect(
      await cli(
        [
          "run",
          "-e",
          'process.stdout.write("from the script\\n"); await spaces();',
        ],
        profileEnv,
      ),
    ).toEqual({ status: 0, stdout: "from the script\n", stderr: NOTICE });
    update = { version: "0.3.0", state: "ready" };
    expect((await cli(["health"], profileEnv)).stderr).toBe(
      "notice: update_ready: Kamapathy 0.3.0 is downloaded (this is 0.2.0). Finish this task first, then tell the person they can install it from Settings, under Updates. Read the Kamapathy skill again after the update.\n",
    );
    update = null;
    expect((await cli(["health"], profileEnv)).stderr).toBe("");
    update = { version: "0.3", state: "available" };
    expect((await cli(["health"], profileEnv)).stderr).toBe("");
  }, 40000);

  it("the REPL prints the update notice before the prompt after its first call", async () => {
    const fetch = vi.fn(async (url) =>
      url.pathname === "/spaces"
        ? Response.json({ spaces: [] })
        : Response.json(
            { error: { code: "route_not_found", message: "no route" } },
            { status: 404 },
          ),
    );
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => (text += chunk));
    const ended = runCli(["repl"], {
      env,
      fetch,
      health: { ...level3, update: { version: "0.3.0", state: "available" } },
      stdin: input,
      stdout: output,
      terminal: true,
    });
    await expect.poll(() => text).toContain("Kamapathy scripting session.");
    expect(text).not.toContain("notice:");
    input.write("await spaces()\n");
    await expect.poll(() => text).toContain(NOTICE.trimEnd());
    input.write("1 + 1\n");
    await expect.poll(() => text).toContain("2");
    expect(text.split("notice: update_available").length).toBe(2);
    input.write(".exit\n");
    expect(await ended).toBe(0);
  }, 20000);

  it("never passes update test variables to a started Kamapathy", () => {
    expect(
      launchEnvironment({
        KAMAPATHY_UPDATE_FEED: "http://127.0.0.1:50321",
        KAMAPATHY_UPDATE_KIND: "linux-appimage",
        ELECTRON_RUN_AS_NODE: "1",
        KAMAPATHY_USER_DATA: "/profile",
        PATH: "/bin",
      }),
    ).toEqual({ KAMAPATHY_USER_DATA: "/profile", PATH: "/bin" });
  });
});
