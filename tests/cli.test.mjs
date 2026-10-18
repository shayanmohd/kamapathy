import { afterEach, describe, expect, it, vi } from "vitest";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
import { KamapathyError, connect, schema } from "../skills/kamapathy/scripts/api.mjs";
import { httpTimeout, queueNotice } from "../skills/kamapathy/scripts/lib/request.mjs";
import { workspacePath } from "../skills/kamapathy/scripts/lib/workspace.mjs";
import { agentPaths as kamapathyAgentPaths } from "../electron/agent-socket.ts";

// A workspace that does not exist, so runs load no .env from the real profile.
const env = {
  KAMAPATHY_NO_LAUNCH: "1",
  KAMAPATHY_WORKSPACE: join(tmpdir(), `kamapathy-no-workspace-${randomBytes(8).toString("hex")}`),
};
const posix = process.platform !== "win32";
const directories = [];
const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const realpathOf = async (path) => (await import("node:fs/promises")).realpath(path);
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
  return { userData, paths, env: { KAMAPATHY_USER_DATA: userData, KAMAPATHY_NO_LAUNCH: "1" } };
}
const newPipe = () => `\\\\.\\pipe\\kamapathy-${randomBytes(16).toString("hex")}`;
const publish = (paths, socket, instance) =>
  writeFile(paths.endpoint, JSON.stringify({ socket, instance }), { mode: 0o600 });
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
    response.end(JSON.stringify({ status: "ok", version: "test", path: request.url }));
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
    expect([client.directory, client.endpoint, client.off, client.launch]).toEqual([
      app.directory,
      app.endpoint,
      app.off,
      app.launch,
    ]);
  });

  it.skipIf(!posix)("refuses a rendezvous that others could read, replace, or redirect", async () => {
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
    await expect(resolveSocket(profileEnv)).rejects.toThrow("private directory");
  });

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
      await resolveSocket({ KAMAPATHY_USER_DATA: userData }, { launch, intervalMs: 10 }),
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

  it.skipIf(!posix)("treats a socket and endpoint left by a crashed Kamapathy as not running", async () => {
    const { paths, env: profileEnv } = await profile();
    const socket = join(paths.directory, "kamapathy.sock");
    await staleSocket(socket);
    expect(existsSync(socket)).toBe(true);
    await publish(paths, socket, "a".repeat(32));
    await expect(resolveSocket(profileEnv)).rejects.toThrow("not running");
  });

  it.skipIf(!posix)("treats a crashed Kamapathy's vanished fallback folder as not running", async () => {
    const { paths, env: profileEnv } = await profile();
    await publish(paths, join(tmpdir(), `kamapathy-gone-${randomBytes(4).toString("hex")}`, "kamapathy.sock"), "a".repeat(32));
    await expect(resolveSocket(profileEnv)).rejects.toThrow("not running");
  });

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

  it.skipIf(!posix)("never runs a recorded program that another account could have replaced", async () => {
    const { paths, userData } = await profile();
    const shared = join(userData, "shared");
    await mkdir(shared);
    await chmod(shared, 0o777);
    const marker = join(userData, "ran");
    const program = join(shared, "kamapathy");
    await writeFile(program, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    await writeFile(paths.launch, JSON.stringify({ command: program, args: [] }), { mode: 0o600 });
    await expect(
      launchKamapathy(paths, { KAMAPATHY_USER_DATA: userData }, { platform: "darwin" }),
    ).rejects.toThrow("other accounts");
    await new Promise((done) => setTimeout(done, 200));
    expect(existsSync(marker)).toBe(false);
    await chmod(shared, 0o700);
    await launchKamapathy(paths, { KAMAPATHY_USER_DATA: userData, PATH: process.env.PATH });
    await expect.poll(() => existsSync(marker)).toBe(true);
  });

  it("on macOS, does not start the default profile for a named profile Kamapathy never recorded", async () => {
    const { paths, userData } = await profile();
    const darwin = { platform: "darwin" };
    await expect(launchKamapathy(paths, { KAMAPATHY_USER_DATA: userData }, darwin)).rejects.toThrow(
      "has not started with this profile",
    );
    await writeFile(
      paths.launch,
      JSON.stringify({ command: join(userData, "missing", "kamapathy"), args: [] }),
      { mode: 0o600 },
    );
    await expect(launchKamapathy(paths, { KAMAPATHY_USER_DATA: userData }, darwin)).rejects.toThrow(
      "has not started with this profile",
    );
  });

  it("elsewhere, starts the installed Kamapathy with the named profile passed on", async () => {
    const { paths, userData } = await profile();
    // The installed launcher receives KAMAPATHY_USER_DATA; here it is not installed.
    await expect(
      launchKamapathy(paths, { KAMAPATHY_USER_DATA: userData, PATH: "", HOME: userData }, { platform: "linux" }),
    ).rejects.toThrow("Could not start Kamapathy");
  });

  it.skipIf(!posix)("Linux start tries kamapathy-browser, then the AppImage", async () => {
    const { paths, userData } = await profile();
    const bin = join(userData, "bin");
    const home = join(userData, "home");
    const appImage = join(home, "Applications", "Kamapathy.AppImage");
    await mkdir(bin);
    await mkdir(join(home, "Applications"), { recursive: true });
    const marker = join(userData, "started");
    // Shell builtins only, since PATH holds nothing but the stubs.
    const stub = async (program, name) => {
      await writeFile(program, `#!/bin/sh\nprintf '%s %s' ${name} "$KAMAPATHY_USER_DATA" > ${JSON.stringify(marker)}\n`);
      await chmod(program, 0o755);
    };
    await stub(join(bin, "kamapathy-browser"), "browser");
    await stub(appImage, "appimage");
    const start = (PATH) =>
      launchKamapathy(paths, { PATH, HOME: home, KAMAPATHY_USER_DATA: userData }, { platform: "linux" });
    const started = async (name) => {
      await expect.poll(() => readFile(marker, "utf8").catch(() => "")).toBe(`${name} ${userData}`);
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
    const notInstalled = ["not_installed", "Could not start Kamapathy (ENOENT). Open Kamapathy, then retry."];
    // An AppImage another account could replace is never run.
    await chmod(appImage, 0o777);
    expect(await refusal(start(""))).toEqual(notInstalled);
    await new Promise((done) => setTimeout(done, 200));
    expect(existsSync(marker)).toBe(false);
    await rm(appImage);
    expect(await refusal(start(""))).toEqual(notInstalled);
  });

  it.skipIf(!posix)("starts the checked program itself, not a link that could be swapped", async () => {
    const { paths, userData } = await profile();
    const program = join(userData, "kamapathy");
    await writeFile(program, "#!/bin/sh\n", { mode: 0o755 });
    const link = join(userData, "kamapathy-link");
    await symlink(program, link);
    await writeFile(paths.launch, JSON.stringify({ command: link, args: ["/app"] }), { mode: 0o600 });
    const record = await launchRecord(paths);
    expect(record).toEqual({ command: await realpathOf(program), args: ["/app"] });
  });

  it("treats a server that never answers the health check as not running", async () => {
    const { paths, env: profileEnv } = await profile();
    await fakeKamapathy(paths, { handler: () => {} });
    await expect(resolveSocket(profileEnv, { healthTimeoutMs: 200 })).rejects.toThrow(
      "not running",
    );
  });

  it("reports a busy Kamapathy instead of starting another when it resets the connection", async () => {
    const { paths, userData } = await profile();
    await fakeKamapathy(paths, { handler: (request) => request.socket.destroy() });
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
    expect(agentPaths({ HOME: home, XDG_CONFIG_HOME: "/xdg" }, "linux").directory).toBe(
      join("/xdg", "Kamapathy", "agent"),
    );
    expect(agentPaths({ USERPROFILE: home, APPDATA: "/roaming" }, "win32").directory).toBe(
      join("/roaming", "Kamapathy", "agent"),
    );
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
    expect(environment).toEqual({ KAMAPATHY_USER_DATA: "/profile", PATH: "/bin" });
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
      { platform: "win32", env: { USERPROFILE: missing.userData, LOCALAPPDATA: missing.userData } },
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
    await writeFile(quit.paths.quit, JSON.stringify({ at: Date.now() }), { mode: 0o600 });
    const launch = vi.fn();
    expect(
      await reasonOf(resolveSocket({ KAMAPATHY_USER_DATA: quit.userData }, { launch })),
    ).toEqual(["not_connected", "quit_by_person", false]);
    expect(launch).not.toHaveBeenCalled();
    // An old quit no longer blocks starting Kamapathy.
    await writeFile(quit.paths.quit, JSON.stringify({ at: Date.now() - 600001 }), { mode: 0o600 });
    expect(await reasonOf(resolveSocket(quit.env))).toEqual(["not_connected", "not_running", false]);
    expect(
      await reasonOf(
        resolveSocket({ KAMAPATHY_USER_DATA: quit.userData }, { launch, intervalMs: 10, timeoutMs: 50 }),
      ),
    ).toEqual(["not_connected", "start_timeout", false]);
    await writeFile(quit.paths.off, "", { mode: 0o600 });
    expect(await reasonOf(resolveSocket(quit.env))).toEqual(["not_connected", "access_off", false]);
    const busy = await profile();
    await fakeKamapathy(busy.paths, { handler: (request) => request.socket.destroy() });
    expect(await reasonOf(resolveSocket(busy.env))).toEqual(["not_connected", "busy", true]);
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
          request.url === "/health" ? { status: "ok", version: "test" } : { spaces: [] },
        ),
      );
    };
    const first = await fakeKamapathy(paths, { handler: answer });
    const launch = vi.fn();
    const client = await connect({ env: { KAMAPATHY_USER_DATA: userData }, connect: { launch } });
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
    await symlink(join(process.cwd(), "skills", "kamapathy"), link, posix ? "dir" : "junction");
    const child = spawn(process.execPath, [join(link, "scripts", "kamapathy.mjs"), "help"], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const status = await new Promise((done) => child.once("close", done));
    expect([status, stdout.split("\n")[0]]).toEqual([0, "Kamapathy browser client"]);
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
    const fetch = vi.fn(async () => Response.json({ ok: true, owner: "agent" }));
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
    expect(await runCli(["resume", "space-1", "--json"], { env, fetch, stdout: json })).toBe(0);
    expect(JSON.parse(json.text())).toEqual({ ok: true, owner: "agent" });
  });
  it("prints control state, field values, group questions and omitted controls on one line each", async () => {
    const snapshot = {
      tabId: "tab-1",
      url: "https://example.test/listing",
      title: "Store listing",
      text: "Main store listing",
      interactables: [
        { ref: "@e1", role: "radio", label: "Yes", checked: false, group: "Does your app\ntarget children?" },
        { ref: "@e2", role: "radio", label: "No", checked: true, group: "Does your app target children?" },
        { ref: "@e3", role: "checkbox", label: "Select all", disabled: true, checked: "mixed" },
        { ref: "@e4", role: "option", label: "France", checked: true, selected: true },
        { ref: "@e5", role: "tab", label: "Custom listings", selected: false },
        { ref: "@e6", role: "button", label: "Data safety", expanded: false, pressed: "mixed" },
        { ref: "@e7", role: "button", label: "Notify", expanded: true, pressed: false },
        { ref: "@e8", role: "input", label: "Short description", value: 'Count "taps"\nquickly\u001b[31m', valueTruncated: true },
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
        Response.json({ ...snapshot, text: "", interactables: [], omittedControls: 3, truncated: true }),
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
    expect(help.text()).toContain("scroll <tab-id> <direction> [pixels] [ref-or-selector]");
    for (const [args, path, body] of [
      [["drag", "tab-1", "@e1", "#zone"], "/tabs/tab-1/drag", { source: { ref: "@e1" }, target: { selector: "#zone" } }],
      [["scroll", "tab-1", "down"], "/tabs/tab-1/scroll", { direction: "down" }],
      [["scroll", "tab-1", "down", "300"], "/tabs/tab-1/scroll", { direction: "down", pixels: 300 }],
      [["scroll", "tab-1", "down", "300", "@e4"], "/tabs/tab-1/scroll", { direction: "down", pixels: 300, ref: "@e4" }],
      [["scroll", "tab-1", "right", "#table"], "/tabs/tab-1/scroll", { direction: "right", selector: "#table" }],
      [["scroll", "tab-1", "down", ".panel"], "/tabs/tab-1/scroll", { direction: "down", selector: ".panel" }],
      [["scroll", "tab-1", "down", "600", ".panel"], "/tabs/tab-1/scroll", { direction: "down", pixels: 600, selector: ".panel" }],
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
      await expect(runCli(args, { env, fetch, stdout: sink() })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("says how an action was done, what scrolled and which refs moved to redrawn controls", async () => {
    for (const [result, text] of [
      [{ ok: true, url: "https://example.test/", drag: "html5" }, "ok: dragged with HTML drag and drop"],
      [
        { ok: true, url: "https://example.test/", drag: "mouse", rebound: ["@e3", "@e4"] },
        "ok: dragged with the mouse; @e3, @e4 now point to the redrawn controls",
      ],
      [
        { ok: true, url: "https://example.test/", fallback: "dom_click", rebound: ["@e2"] },
        "ok: clicked in the page because the control has no size; @e2 now points to the redrawn control",
      ],
      [
        { ok: true, scrolled: "element", selector: "#content\n\u001b[31m", x: 0, y: 723.5, moved: true },
        "ok: scrolled panel #content [31m to 0,723.5",
      ],
      [{ ok: true, scrolled: "page", x: 0, y: 0, moved: false }, "ok: page did not move"],
      [{ ok: true, url: "https://example.test/" }, "ok"],
    ]) {
      const stdout = sink();
      await runCli(["click", "tab-1", "@e1"], { env, fetch: vi.fn(async () => Response.json(result)), stdout });
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
            { index: 1, type: "scroll", result: { ok: true, scrolled: "page", x: 0, y: 600, moved: true } },
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
    await expect(runCli(["resume"], { env, fetch, stdout: sink() })).rejects.toThrow("Missing ID");
    for (const id of ["../space", "space/1", "x".repeat(129)])
      await expect(runCli(["resume", id], { env, fetch, stdout: sink() })).rejects.toThrow(
        "Invalid space or tab ID",
      );
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
    const bytes = [Buffer.from([0, 255, 128, 65, 10]), Buffer.from([137, 80, 78, 71])];
    await Promise.all(paths.map((path, index) => writeFile(path, bytes[index])));
    const fetch = vi.fn(async () => Response.json({ ok: true, selected: 2 }));
    const stdout = sink();
    expect(await runCli(["upload", "tab-1", "@e3", ...paths], { env, fetch, stdout })).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url.pathname).toBe("/tabs/tab-1/upload");
    const payload = JSON.parse(options.body);
    expect(payload.ref).toBe("@e3");
    expect(payload.files).toEqual([
      { name: "fixture.json.aab", type: "application/octet-stream", data: bytes[0].toString("base64") },
      { name: "fixture.json.PNG", type: "image/png", data: bytes[1].toString("base64") },
    ]);
    for (const [index, path] of paths.entries()) {
      expect(options.body).not.toContain(path);
      expect(stdout.text()).not.toContain(path);
      expect(await readFile(path)).toEqual(bytes[index]);
    }
  });

  it("rejects upload selectors, directories, excess file counts, and aggregate size before connecting", async () => {
    const file = await scratchFile();
    const directory = await mkdtemp(join(tmpdir(), "kamapathy-upload-directory-"));
    directories.push(directory);
    const fetch = vi.fn();
    for (const args of [
      ["upload", "tab-1", "#upload", file],
      ["upload", "tab-1", "@e0", file],
      ["upload", "tab-1", "@e1"],
      ["upload", "tab-1", "@e1", ...Array(9).fill(file)],
      ["upload", "tab-1", "@e1", directory],
    ])
      await expect(runCli(args, { env, fetch, stdout: sink() })).rejects.toThrow();
    const large = `${file}.aab`;
    const handle = await open(large, "w");
    await handle.truncate(16 * 1024 * 1024 + 1);
    await handle.close();
    await expect(runCli(["upload", "tab-1", "@e1", large], { env, fetch, stdout: sink() })).rejects.toThrow("16 MiB");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("refuses symbolic links for selected upload files", async () => {
    const file = await scratchFile();
    const link = `${file}.png`;
    await symlink(file, link);
    const fetch = vi.fn();
    await expect(runCli(["upload", "tab-1", "@e1", link], { env, fetch, stdout: sink() })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not disclose selected local paths when a file cannot be read", async () => {
    const missing = `${await scratchFile()}.missing-private-bundle.aab`;
    const stderr = sink();
    const fetch = vi.fn();
    expect(await main(["upload", "tab-1", "@e1", missing], { env, fetch, stderr })).toBe(1);
    expect(stderr.text()).not.toContain(missing);
    expect(stderr.text()).not.toContain("missing-private-bundle");
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("scripted sessions", () => {
  const space = { id: "space-1", name: "Research", kind: "agent", owner: "agent", signIns: "shared" };
  const tab = { id: "tab-1", spaceId: "space-1", title: "Reserve", url: "https://example.test/reserve" };
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
      const body = options.body === undefined ? undefined : JSON.parse(options.body);
      requests.push({ method, path: url.pathname, body });
      const answer = routes[`${method} ${url.pathname}`];
      if (!answer)
        return Response.json({ error: { code: "not_found", message: `No route ${url.pathname}` } }, { status: 404 });
      return typeof answer === "function" ? answer(body, options) : Response.json(answer);
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
    "POST /tabs/tab-1/navigate": { tab: { ...tab, url: "https://example.test/slots", title: "Slots" } },
    "POST /tabs/tab-1/snapshot": snapshot,
    "POST /tabs/tab-1/click": { ok: true, url: tab.url, rebound: ["@e2"] },
    "POST /tabs/tab-1/fill": { ok: true },
    "POST /tabs/tab-1/press": { ok: true },
    "POST /tabs/tab-1/scroll": { ok: true, scrolled: "page", x: 0, y: 300, moved: true },
    "POST /tabs/tab-1/drag": { ok: true, url: tab.url, drag: "mouse" },
    "POST /tabs/tab-1/wait": { ok: true },
    "POST /tabs/tab-1/actions": { ok: true, results: [{ index: 0, type: "click", result: { ok: true } }] },
    "POST /tabs/tab-1/upload": { ok: true, selected: 1 },
    "GET /tabs/tab-1/screenshot": () =>
      new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } }),
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
    expect(research).toMatchObject({ id: "space-1", name: "Research", owner: "agent", signIns: "shared" });
    const page = await research.open("https://example.test/reserve");
    expect(page).toMatchObject({ id: "tab-1", spaceId: "space-1", url: tab.url, title: "Reserve" });
    expect(await page.snapshot()).toEqual(snapshot);
    expect(await page.snapshot({ mode: "full", selector: "#slots", maxChars: 500, maxControls: 5 })).toEqual(snapshot);
    expect(await page.text()).toBe(formatSnapshot(snapshot));
    expect(await page.click("@e2")).toEqual({ ok: true, url: tab.url, rebound: ["@e2"] });
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
    expect([page.url, page.title]).toEqual(["https://example.test/slots", "Slots"]);
    expect((await research.tabs()).map((item) => item.id)).toEqual(["tab-1"]);
    await page.close();
    expect(await research.handoff()).toEqual({ ok: true, owner: "human" });
    expect(research.owner).toBe("human");
    await research.resume();
    expect(research.owner).toBe("agent");
    await research.close();
    expect((await client.spaces()).map((item) => item.name)).toEqual(["Research"]);
    expect((await client.space("space-1")).id).toBe("space-1");
    expect(api.requests).toEqual([
      { method: "POST", path: "/spaces", body: { name: "Research" } },
      { method: "POST", path: "/spaces/space-1/tabs", body: { url: "https://example.test/reserve" } },
      { method: "POST", path: "/tabs/tab-1/snapshot", body: { mode: "compact" } },
      { method: "POST", path: "/tabs/tab-1/snapshot", body: { mode: "full", selector: "#slots", maxChars: 500, maxControls: 5 } },
      { method: "POST", path: "/tabs/tab-1/snapshot", body: { mode: "compact" } },
      { method: "POST", path: "/tabs/tab-1/click", body: { ref: "@e2" } },
      { method: "POST", path: "/tabs/tab-1/click", body: { selector: "#submit" } },
      { method: "POST", path: "/tabs/tab-1/fill", body: { ref: "@e1", value: "Avery Quinn" } },
      { method: "POST", path: "/tabs/tab-1/press", body: { key: "Enter", ref: "@e1" } },
      { method: "POST", path: "/tabs/tab-1/press", body: { key: "Escape" } },
      { method: "POST", path: "/tabs/tab-1/scroll", body: { direction: "down", pixels: 300, ref: "@e1" } },
      { method: "POST", path: "/tabs/tab-1/scroll", body: { direction: "down", selector: ".panel" } },
      { method: "POST", path: "/tabs/tab-1/scroll", body: { direction: "up" } },
      { method: "POST", path: "/tabs/tab-1/drag", body: { source: { ref: "@e1" }, target: { selector: "#zone" } } },
      { method: "POST", path: "/tabs/tab-1/wait", body: { selector: "#slots", text: "Free", timeoutMs: 1000 } },
      { method: "POST", path: "/tabs/tab-1/actions", body: { actions: [{ type: "click", ref: "@e2" }] } },
      { method: "POST", path: "/tabs/tab-1/navigate", body: { url: "https://example.test/slots" } },
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
      if (options.body !== undefined) expect(options.headers["Content-Type"]).toBe("application/json");
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
    await expect(client.createSpace("Research", { isolatd: true })).rejects.toMatchObject({
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
    expect(await main(["health", "--json"], { env: profileEnv, stdout, stderr })).toBe(0);
    expect(JSON.parse(stdout.text())).toMatchObject({ status: "ok", version: "0.9.0" });
    expect(stderr.text()).toBe(
      `notice: This skill copy (${schema.CLIENT_VERSION}) is older than Kamapathy 0.9.0. Read /opt/kamapathy/skill/SKILL.md for the current API.\n`,
    );
    const again = sink();
    expect(await main(["health"], { env: profileEnv, stdout: sink(), stderr: again })).toBe(0);
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
          { error: { code: "element_obscured", message: "Covered.", dispatched: true } },
          { status: 409 },
        ),
    });
    const client = await connect({ env, fetch: api.fetch });
    const page = await (await client.space("space-1")).open("https://example.test/reserve");
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
    expect(reached).toMatchObject({ code: "element_obscured", dispatched: true, entry: "page.fill" });
    expect(reached).not.toHaveProperty("retryable");
    // Single commands add the same line after their status line.
    const retried = sink();
    expect(await main(["click", "tab-1", "@e2"], { env, fetch: api.fetch, stdout: sink(), stderr: retried })).toBe(1);
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
    expect(api.requests).toEqual([{ method: "GET", path: "/spaces", body: undefined }]);
    const current = await connect({
      env,
      fetch: api.fetch,
      health: { status: "ok", version: "0.2.0", apiLevel: 2, versions: { electron: "44.2.0" } },
    });
    expect(current.app).toEqual({ version: "0.2.0", apiLevel: 2, electron: "44.2.0" });
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
        { error: { code: "tab_not_found", message: "Agent tab was not found.", tabId: "tab-404" } },
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
      space: { id: "work", name: "Work", kind: "personal", owner: "agent", signIns: "shared" },
      tabs: [{ id: "tab-w", spaceId: "work", title: "Mail", url: "https://mail.test/", label: "p1", openedBy: "person", managed: false, active: true }],
      active: { id: "tab-w", spaceId: "work", title: "Mail", url: "https://mail.test/", label: "p1", openedBy: "person", managed: false, active: true },
    },
  };
  const paths = (api) => api.requests.map((item) => `${item.method} ${item.path}`);

  it("<space-id>:<label> resolves with one tabs request", async () => {
    const api = fakeApi(sectionTwo);
    expect(await runCli(["click", "space-1:p1", "@e2"], { env, fetch: api.fetch, stdout: sink() })).toBe(0);
    expect(paths(api)).toEqual(["GET /spaces/space-1/tabs", "POST /tabs/tab-1/click"]);
    await expect(
      runCli(["click", "space-1:p4", "@e2"], { env, fetch: api.fetch, stdout: sink() }),
    ).rejects.toMatchObject({ code: "page_not_found", label: "p4", closedBy: "page" });
    expect(paths(api).slice(2)).toEqual(["GET /spaces/space-1/tabs"]);
    await expect(
      runCli(["click", "space-1:x1", "@e2"], { env, fetch: api.fetch, stdout: sink() }),
    ).rejects.toThrow("Invalid space or tab ID.");
  });

  it("finish() without keep throws invalid_argument before any request, and space finish requires --keep", async () => {
    const api = fakeApi(sectionTwo);
    const client = await connect({ env, fetch: api.fetch, health: level2 });
    const research = await client.space("space-1");
    expect(paths(api)).toEqual(["GET /spaces/space-1"]);
    for (const options of [undefined, {}, { keep: "some" }, { keep: 3 }])
      await expect(research.finish(options), JSON.stringify(options)).rejects.toMatchObject({
        code: "invalid_argument",
        entry: "space.finish",
        expected: '{ keep: "all" | page[] }',
      });
    await expect(
      runCli(["space", "finish", "space-1"], { env, fetch: api.fetch, health: level2, stdout: sink() }),
    ).rejects.toThrow("Use space finish <space-id> --keep all|none|<tab-id>[,<tab-id>].");
    expect(paths(api)).toEqual(["GET /spaces/space-1"]);
    // Pages, labels and ids all become ids, with one tabs request for the labels.
    const page = research.page("p1");
    expect(await research.finish({ keep: [page, "p2", "tab-3"] })).toEqual(sectionTwo["POST /spaces/space-1/finish"]);
    expect(api.requests.slice(1)).toEqual([
      { method: "GET", path: "/spaces/space-1/tabs", body: undefined },
      { method: "POST", path: "/spaces/space-1/finish", body: { keep: ["tab-1", "tab-2", "tab-3"] } },
    ]);
    expect(await research.finish({ keep: "all" })).toMatchObject({ ok: true });
    expect(api.requests.at(-1).body).toEqual({ keep: "all" });
    const stdout = sink();
    expect(
      await runCli(["space", "finish", "space-1", "--keep", "none"], { env, fetch: api.fetch, health: level2, stdout }),
    ).toBe(0);
    expect(api.requests.at(-1).body).toEqual({ keep: [] });
    expect(stdout.text()).toBe("ok: space space-1 finished\nclosed p1 p3\nkept p2\nprotected p5\n");
    await runCli(["space", "finish", "space-1", "--keep", "p2,tab-3"], { env, fetch: api.fetch, health: level2, stdout: sink() });
    expect(api.requests.slice(-2)).toEqual([
      { method: "GET", path: "/spaces/space-1/tabs", body: undefined },
      { method: "POST", path: "/spaces/space-1/finish", body: { keep: ["tab-2", "tab-3"] } },
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
    expect(page).toMatchObject({ id: "tab-1", openedBy: "agent", managed: true });
    expect(paths(api).slice(1)).toEqual(["GET /spaces/space-1/tabs", "POST /tabs/tab-1/click", "POST /tabs/tab-1/click"]);
    await expect(research.page("p4").click("@e1")).rejects.toMatchObject({
      code: "page_not_found",
      label: "p4",
      closedBy: "page",
      message: "Page p4 was closed by the page. Open another with space.newPage().",
      entry: "page.click",
    });
    expect(() => research.page("tab-1")).toThrow(KamapathyError);
    // A popup's opener is the open page that opened it.
    const [, popup] = await research.tabs();
    expect(popup).toMatchObject({ label: "p2", openedBy: "page", openerId: "tab-1", managed: false });
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
      await runCli(["wait-for-control", "space-1", "--timeout", "2000"], { env, fetch: api.fetch, health: level2, stdout: sink() });
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
    await expect(research.adopt("p4")).rejects.toMatchObject({ code: "page_not_found", closedBy: "page" });
    await expect(research.adopt("tab-404")).rejects.toMatchObject({ code: "tab_not_found", tabId: "tab-404" });
    // A page handle sends its own id.
    const page = (await research.pages())[0];
    await research.adopt(page);
    expect(api.requests.at(-1).path).toBe("/tabs/tab-1/adopt");
  });

  it("openSpace reuses or creates, createSpace sends KAMAPATHY_PAGE_BUDGET, and requestSpace returns the granted space with its user page", async () => {
    const api = fakeApi(sectionTwo);
    const budgeted = { ...env, KAMAPATHY_PAGE_BUDGET: "5" };
    const client = await connect({ env: budgeted, fetch: api.fetch, health: level2 });
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
    const wrong = await connect({ env: { ...env, KAMAPATHY_PAGE_BUDGET: "21" }, fetch: api.fetch, health: level2 });
    await expect(wrong.createSpace("Other")).rejects.toMatchObject({
      code: "invalid_option",
      option: "KAMAPATHY_PAGE_BUDGET",
    });
    expect(api.requests).toHaveLength(4);
    const work = await client.requestSpace({ reason: "Book a table", name: "Work" });
    expect(api.requests.at(-1)).toEqual({
      method: "POST",
      path: "/space-requests",
      body: { reason: "Book a table", name: "Work" },
    });
    expect(work).toMatchObject({ id: "work", kind: "personal", owner: "agent" });
    expect(work.userPage()).toMatchObject({ id: "tab-w", label: "p1", openedBy: "person" });
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
      expect(await runCli(args, { env, fetch: api.fetch, health: level2, stdout }), args.join(" ")).toBe(0);
      return stdout.text();
    };
    expect(await run(["tabs", "space-1"])).toBe(
      'p1 tab-1 agent active https://example.test/reserve "Reserve"\np2 tab-2 page from p1 unmanaged new https://example.test/slots "Slots"\n',
    );
    const lines = 'active p1 tab-1 https://example.test/reserve\nopened p2 tab-2 page from tab-1 unmanaged new https://example.test/slots "Slots"\nclosed p3\n';
    expect(await run(["resume", "space-1"])).toBe(`ok: agent control resumed\n${lines}`);
    expect(await run(["wait-for-control", "space-1"])).toBe(`ok: agent has control\n${lines}`);
    expect(await run(["space", "request", "--reason", "Book a table", "--name", "Work", "--timeout", "60000"])).toBe(
      'space work "Work" agent shared\np1 tab-w person unmanaged active https://mail.test/ "Mail"\nactive p1 tab-w https://mail.test/\n',
    );
    expect(api.requests.at(-1).body).toEqual({ reason: "Book a table", name: "Work", timeoutMs: 60000 });
    expect(await run(["space", "open", "Research", "--page-budget", "4"])).toBe('space space-1 "Research" agent shared\n');
    expect(api.requests.at(-1).body).toEqual({ name: "Research", reuse: true, pageBudget: 4 });
    expect(await run(["new-page", "space-1"])).toBe("tab tab-1 https://example.test/reserve\n");
    expect(api.requests.at(-1)).toEqual({ method: "POST", path: "/spaces/space-1/tabs", body: {} });
    expect(await run(["adopt", "space-1:p2"])).toBe("tab tab-2 https://example.test/slots\n");
    expect(await run(["release", "tab-2"])).toBe("tab tab-2 https://example.test/slots\n");
    await expect(
      runCli(["space", "open", "Research", "--page-budget", "21"], { env, fetch: api.fetch, stdout: sink() }),
    ).rejects.toThrow("--page-budget must be an integer from 1 to 20.");
    await expect(runCli(["space", "nope"], { env, fetch: api.fetch, stdout: sink() })).rejects.toThrow(
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
    await expect(client.createSpace("Research", { pageBudget: 3 })).rejects.toMatchObject({
      code: "app_outdated",
      option: "pageBudget",
    });
    await expect(
      runCli(["new-page", "space-1"], { env, fetch: api.fetch, health: old, stdout: sink() }),
    ).rejects.toMatchObject({
      code: "app_outdated",
      message:
        "new-page needs Kamapathy API level 2, and Kamapathy 0.1.9 has level 1. Ask the person to update Kamapathy, then read the skill again.",
    });
    expect(paths(api)).toEqual(["GET /spaces"]);
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
    await runCli(["snapshot", "tab-1", "--full", "--selector", "main"], { env, fetch: api.fetch, stdout: full });
    expect(`${await page.text({ mode: "full", selector: "main" })}\n`).toBe(full.text());
    expect(api.requests.at(-1).body).toEqual(api.requests.at(-2).body);
  });

  it("throws errors that carry the API's code and message, and a failed batch keeps its progress", async () => {
    const api = fakeApi({
      ...routes,
      "POST /tabs/tab-1/click": () =>
        Response.json(
          { error: { code: "human_control", message: "The person is using this space." } },
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
    const page = await (await client.space("space-1")).open("https://example.test/reserve");
    const refused = await page.click("@e2").catch((error) => error);
    expect(refused).toBeInstanceOf(KamapathyError);
    expect(refused).toMatchObject({ code: "human_control", message: "The person is using this space.", status: 409 });
    const stopped = await page
      .batch([{ type: "fill", ref: "@e1", value: "A" }, { type: "click", ref: "@e2" }])
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
    await expect(page.wait()).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client.space("space-9")).rejects.toMatchObject({ code: "space_not_found" });
    // The identity check stays in place: a wrong instance never gets a command.
    const { paths, env: profileEnv } = await profile();
    await fakeKamapathy(paths, { answerAs: "f".repeat(32) });
    await expect(connect({ env: profileEnv })).rejects.toThrow("not running");
  });

  it("uploads and saves screenshots like the commands do", async () => {
    const api = fakeApi(routes);
    const client = await connect({ env, fetch: api.fetch });
    const page = await (await client.space("space-1")).open("https://example.test/reserve");
    const file = `${await scratchFile()}.pdf`;
    await writeFile(file, Buffer.from([1, 2, 3]));
    expect(await page.upload("@e3", [file])).toEqual({ ok: true, selected: 1 });
    expect(api.requests.at(-1).body).toEqual({
      ref: "@e3",
      files: [{ name: "fixture.json.pdf", type: "application/pdf", data: Buffer.from([1, 2, 3]).toString("base64") }],
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
    expect(await runCli(["run", path], { env, fetch: api.fetch, stdout: sink(), stderr })).toBe(0);
    expect(stderr.text()).toBe("");
    expect(globalThis.__scripted.text).toBe(formatSnapshot(snapshot));
    expect(globalThis.__scripted.names).toEqual(["Research"]);
    expect(globalThis.__scripted.found).toBe("space-1");
    expect(typeof globalThis.__scripted.client.createSpace).toBe("function");
    expect(api.requests[0]).toEqual({ method: "POST", path: "/spaces", body: { name: "Research", isolated: true } });
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
      await runCli(["run", "-"], { env, fetch: api.fetch, stdin: Readable.from([source]), stdout: sink(), stderr: sink() }),
    ).toBe(0);
    const fromStdin = globalThis.__scripted;
    expect(fromStdin.count).toBe(1);
    expect(basename(fromStdin.path)).toMatch(/^kamapathy-run-[a-f0-9]{16}\.mjs$/);
    if (posix) expect(fromStdin.mode).toBe(0o600);
    expect(existsSync(fromStdin.path)).toBe(false);
    expect(await runCli(["run", "-e", source], { env, fetch: api.fetch, stdout: sink(), stderr: sink() })).toBe(0);
    expect(globalThis.__scripted.path).not.toBe(fromStdin.path);
    expect(existsSync(globalThis.__scripted.path)).toBe(false);
  });

  it("ends a failing script with the error's code and message and exit status 1", async () => {
    const api = fakeApi({
      ...routes,
      "POST /tabs/tab-1/click": () =>
        Response.json({ error: { code: "stale_ref", message: "Observe again." } }, { status: 422 }),
    });
    const stale = sink();
    expect(
      await runCli(
        ["run", "-e", 'const page = await (await space("space-1")).open("https://example.test/reserve"); await page.click("@e2");'],
        { env, fetch: api.fetch, stdout: sink(), stderr: stale },
      ),
    ).toBe(1);
    expect(stale.text()).toMatch(/^error: stale_ref: Observe again\.\n  at -e:1:\d+\n$/);
    const plain = sink();
    expect(await runCli(["run", "-e", 'throw new Error("boom")'], { env, fetch: api.fetch, stdout: sink(), stderr: plain })).toBe(1);
    expect(plain.text()).toMatch(/^error: boom\n  at -e:1:\d+\n$/);
    const missing = sink();
    expect(await runCli(["run", "-e", 'await space("space-9")'], { env, fetch: api.fetch, stdout: sink(), stderr: missing })).toBe(1);
    expect(missing.text()).toMatch(/^error: space_not_found: /);
    await expect(runCli(["run"], { env, fetch: api.fetch, stdout: sink() })).rejects.toThrow("Missing");
    await expect(
      runCli(["run", join(tmpdir(), "kamapathy-absent.mjs")], { env, fetch: api.fetch, stdout: sink() }),
    ).rejects.toThrow("not found");
  });

  it("connects a script over the profile's socket with the same discovery as every command", async () => {
    const { paths, env: profileEnv } = await profile();
    const requests = [];
    await fakeKamapathy(paths, {
      handler: (request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.writeHead(request.method === "POST" ? 201 : 200, { "Content-Type": "application/json" });
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
    for (const entry of ["skills/kamapathy/scripts/kamapathy.mjs", "scripts/kamapathy.mjs"]) {
      const child = spawn(
        process.execPath,
        [entry, "run", "-e", 'console.log((await createSpace("Research", { isolated: true })).signIns)'],
        { env: { ...process.env, ...profileEnv } },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const code = await new Promise((done) => child.once("close", done));
      expect([code, stdout, stderr]).toEqual([0, "separate\n", ""]);
    }
    expect(requests).toEqual(["GET /health", "POST /spaces", "GET /health", "POST /spaces"]);
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
          response.end(JSON.stringify({ error: { code: "stale_ref", message: "Observe again." } }));
        }
      },
    });
    const run = async (code) => {
      const child = spawn(process.execPath, ["skills/kamapathy/scripts/kamapathy.mjs", "run", "-e", code], {
        env: { ...process.env, ...profileEnv },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      const status = await new Promise((done) => child.once("close", done));
      return { status, stdout, stderr };
    };
    const leftovers = async () =>
      (await readdir(tmpdir())).filter((name) => name.startsWith("kamapathy-run-"));
    const before = await leftovers();
    expect(await run('await spaces(); console.log("waiting"); await new Promise(() => {})')).toEqual({
      status: 1,
      stdout: "waiting\n",
      stderr: "error: The script stopped with work still pending. Await every call.\n",
    });
    expect(await run('await spaces(); process.exit(0)')).toMatchObject({ status: 0, stderr: "" });
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
    const message = "The person took over this space. Stop, and resume only when they ask you to.";
    const run = await runIn(
      `${firstPage}
      process.stdout.write("before\\n");
      const error = await page.click("@e2").catch((error) => error);
      const again = await page.fill("@e1", "A").catch((error) => error);
      globalThis.__scripted = { first: error.hardStop, again: again.hardStop, code: again.code };
      process.stdout.write("after\\n");`,
      {
        ...sectionTwo,
        "POST /tabs/tab-1/click": refusal(409, { code: "human_control", message, reason: "manual", spaceId: "space-1" }),
      },
    );
    expect(run).toMatchObject({ status: 3, stdout: "", stderr: `${takeover}${message}\n${withheld}` });
    expect(globalThis.__scripted).toEqual({ first: true, again: true, code: "human_control" });
    expect(paths(run.api)).toEqual(["GET /spaces/space-1", "GET /spaces/space-1/tabs", "POST /tabs/tab-1/click"]);
  });

  it("hard-stop guidance follows the human_control reason", async () => {
    const message = "Taken.";
    const hold = "Tell the person what is waiting for their answer in Kamapathy, then run kamapathy wait-for-control space-1 and start a new run when it returns.\n";
    for (const [reason, expected] of [
      ["manual", { status: 3, stdout: "", stderr: `${takeover}${message}\n${withheld}` }],
      ["handoff", { status: 3, stdout: "", stderr: `${takeover}${message}\n${withheld}` }],
      [undefined, { status: 3, stdout: "", stderr: `${takeover}${message}\n${withheld}` }],
      [
        "permission",
        {
          status: 1,
          stdout: "kept\n",
          stderr: expect.stringMatching(new RegExp(`^error: human_control: ${message}\\n  at -e:1:\\d+\\n${hold}$`)),
        },
      ],
      [
        "failed",
        {
          status: 1,
          stdout: "kept\n",
          stderr: expect.stringMatching(new RegExp(`^error: human_control: ${message}\\n  at -e:1:\\d+\\n$`)),
        },
      ],
    ])
      expect(
        await runIn(`${firstPage} process.stdout.write("kept\\n"); await page.click("@e2");`, {
          ...sectionTwo,
          "POST /tabs/tab-1/click": refusal(409, { code: "human_control", message, reason, spaceId: "space-1" }),
        }),
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
        "POST /tabs/tab-1/click": refusal(409, { code: "human_control", message: "Asked.", reason: "permission", prompt: "camera", spaceId: "space-1" }),
      },
    );
    expect(run).toMatchObject({ status: 0, stdout: "done\n", stderr: "" });
    expect(paths(run.api).slice(-2)).toEqual(["POST /spaces/space-1/wait-for-control", "POST /tabs/tab-1/fill"]);
  });

  it("the person's Stop is a hard stop with its own guidance, also when it ends a waitForControl; space_ended after the agent's own finish is an ordinary error", async () => {
    const stopped = { code: "space_ended", message: "Stopped.", spaceId: "space-1", endedBy: "person", reason: "stopped" };
    expect(
      await runIn(`${firstPage} process.stdout.write("x\\n"); await page.click("@e2").catch(() => {});`, {
        ...sectionTwo,
        "POST /tabs/tab-1/click": refusal(409, stopped),
      }),
    ).toMatchObject({ status: 3, stdout: "", stderr: stopGuidance });
    expect(
      await runIn('process.stdout.write("x\\n"); await (await space("space-1")).waitForControl();', {
        ...sectionTwo,
        "POST /spaces/space-1/wait-for-control": refusal(409, stopped),
      }),
    ).toMatchObject({ status: 3, stdout: "", stderr: stopGuidance });
    expect(
      await runIn(`${firstPage} process.stdout.write("x\\n"); await page.click("@e2");`, {
        ...sectionTwo,
        "POST /tabs/tab-1/click": refusal(409, { ...stopped, endedBy: "agent", reason: "finished", message: "Finished." }),
      }),
    ).toMatchObject({
      status: 1,
      stdout: "x\n",
      stderr: expect.stringMatching(/^error: space_ended: Finished\.\n  at -e:1:\d+\n$/),
    });
  });

  it("automation_stopped and an off marker at the first call are hard stops; a delayed waitForControl answer is not", async () => {
    expect(
      await runIn(`${firstPage} process.stdout.write("x\\n"); await page.click("@e2");`, {
        ...sectionTwo,
        "POST /tabs/tab-1/click": refusal(503, { code: "automation_stopped", message: "Automation is disabled." }),
      }),
    ).toMatchObject({ status: 3, stdout: "", stderr: accessGuidance });
    const { paths: agent, userData } = await profile();
    await writeFile(agent.off, "", { mode: 0o600 });
    const stdout = sink();
    const stderr = sink();
    expect(
      await runCli(["run", "-e", 'process.stdout.write("x\\n"); await spaces();'], {
        env: { KAMAPATHY_USER_DATA: userData },
        stdout,
        stderr,
      }),
    ).toBe(3);
    expect([stdout.text(), stderr.text()]).toEqual(["", accessGuidance]);
    expect(
      await runIn('const result = await (await space("space-1")).waitForControl(); process.stdout.write(`${result.owner}\\n`);', {
        ...sectionTwo,
        "POST /spaces/space-1/wait-for-control": async () => {
          await new Promise((done) => setTimeout(done, 100));
          return Response.json(boundary);
        },
      }),
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
      await runIn(`${firstPage} await page.click("@e2"); process.stdout.write("ok\\n");`, sectionTwo, { options: { endHooks: hooks } }),
    ).toMatchObject({ status: 0, stdout: "ok\n", stderr: "" });
    expect(calls).toEqual([["first", ["tab-1"], true], ["second", ["tab-1"]]]);
    calls.length = 0;
    expect(
      await runIn(`${firstPage} await page.click("@e2"); throw new Error("boom");`, sectionTwo, { options: { endHooks: hooks } }),
    ).toMatchObject({ status: 1, stderr: expect.stringMatching(/^error: boom\n  at -e:1:\d+\n$/) });
    expect(calls.map(([name]) => name)).toEqual(["first", "second"]);
    calls.length = 0;
    await runIn(`${firstPage} await page.click("@e2").catch(() => {});`, {
      ...sectionTwo,
      "POST /tabs/tab-1/click": refusal(409, { code: "human_control", message: "Taken.", reason: "manual" }),
    }, { options: { endHooks: hooks } });
    expect(calls).toEqual([]);
    // The cap ends the step, and later hooks never start.
    const started = Date.now();
    const capped = await runIn('process.stdout.write("ok\\n");', sectionTwo, {
      options: {
        endCapMs: 100,
        endHooks: [
          ({ signal }) => new Promise((done) => signal.addEventListener("abort", done)),
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
    expect([status, output]).toEqual([1, "hook\nerror: The script stopped with work still pending. Await every call.\n"]);
  }, 20000);

  it("the deadline aborts the call in progress, flushes and exits 1 with run_timeout", async () => {
    let aborted = false;
    const run = await runIn(`process.stdout.write("started\\n"); await spaces();`, {
      ...sectionTwo,
      "GET /spaces": (_body, options) =>
        new Promise((_done, reject) =>
          options.signal.addEventListener("abort", () => {
            aborted = true;
            reject(options.signal.reason);
          }),
        ),
    }, { args: ["--timeout", "1000"] });
    expect(aborted).toBe(true);
    expect(run).toMatchObject({
      status: 1,
      stdout: "started\n",
      stderr:
        "error: run_timeout: The script did not finish within 1000 ms. A call in progress may still have taken effect, so inspect the page before retrying. Use --timeout for longer tasks.\n",
    });
  });

  it("SIGTERM aborts the call in progress, flushes and exits 143 with interrupted", async () => {
    const { paths: agent, env: profileEnv } = await profile();
    let closed = false;
    let arrived;
    const request = new Promise((done) => (arrived = done));
    await fakeKamapathy(agent, {
      handler: (incoming, response) => {
        if (incoming.url === "/health") {
          response.writeHead(200, { "Content-Type": "application/json" });
          return response.end(JSON.stringify({ status: "ok", version: "test", apiLevel: 2 }));
        }
        response.once("close", () => (closed = true));
        arrived();
      },
    });
    const child = spawn(
      process.execPath,
      ["skills/kamapathy/scripts/kamapathy.mjs", "run", "-e", 'process.stdout.write("started\\n"); await spaces();'],
      { env: { ...process.env, ...profileEnv } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    await request;
    child.kill("SIGTERM");
    const status = await new Promise((done) => child.once("close", done));
    expect([status, stdout, stderr]).toEqual([
      143,
      "started\n",
      "error: interrupted: The run was stopped by SIGTERM. A call in progress may still have taken effect, so inspect the page before retrying.\n",
    ]);
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
              ? { status: "ok", version: "9.0.0", apiLevel: schema.API_LEVEL + 1 }
              : { spaces: [] },
          ),
        );
      },
    });
    const run = async (code) => {
      const child = spawn(process.execPath, ["skills/kamapathy/scripts/kamapathy.mjs", "run", "-e", code], {
        env: { ...process.env, ...profileEnv },
      });
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
    expect(await run('process.stdout.write("a\\n"); console.error("b"); process.exit(5);')).toEqual({
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
      ["skills/kamapathy/scripts/kamapathy.mjs", "run", "--timeout", "60000", "-e", 'process.stdout.write("idle\\n")'],
      { env: { ...process.env, ...profileEnv } },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    expect(await new Promise((done) => child.once("close", done))).toBe(0);
    expect(stdout).toBe("idle\n");
    expect(Date.now() - started).toBeLessThan(10000);
    const fetch = vi.fn();
    for (const [args, runEnv, message] of [
      [["--timeout", "999"], env, "--timeout must be an integer from 1000 to 3600000 milliseconds."],
      [["--timeout", "3600001"], env, "--timeout must be an integer from 1000 to 3600000 milliseconds."],
      [[], { ...env, KAMAPATHY_RUN_TIMEOUT_MS: "soon" }, "KAMAPATHY_RUN_TIMEOUT_MS must be an integer from 1000 to 3600000 milliseconds."],
      [["--fast"], env, "Unknown run option: --fast. Run help for usage."],
    ])
      await expect(
        runCli(["run", ...args, "-e", "1"], { env: runEnv, fetch, stdout: sink(), stderr: sink() }),
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
        runCli(args, { env, fetch, stdin, stdinTimeoutMs: 200, stdout: sink(), stderr: sink() }),
        args.join(" "),
      ).rejects.toThrow("Standard input did not end within 0.2 seconds. Pipe the complete value and close the input.");
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
      ["kamapathy", "createSpace", "openSpace", "space", "spaces", "requestSpace"].map((name) => [name, false, true, true, false]),
    );
    expect(run.api.requests).toEqual([
      { method: "POST", path: "/spaces", body: { name: "Research", reuse: true } },
      { method: "POST", path: "/space-requests", body: { reason: "Book a table" } },
    ]);
  });

  it("the CLI refuses Node older than 22.13 for every command but help, --help, -h, --version and -v", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "ok" }));
    const stderr = sink();
    expect(await main(["health"], { env, fetch, stderr, nodeVersion: "22.12.0" })).toBe(1);
    expect(stderr.text()).toBe("Kamapathy: Kamapathy's client needs Node.js 22.13 or later. This is Node.js 22.12.0.\n");
    expect(fetch).not.toHaveBeenCalled();
    for (const argv of [["help"], ["--help"], ["-h"], ["tabs", "--help"], ["--version"], ["-v"]]) {
      const output = sink();
      await main(argv, { env, fetch, stdout: sink(), stderr: output, nodeVersion: "20.0.0" });
      expect(output.text(), argv.join(" ")).not.toContain("needs Node.js");
    }
    expect(await main(["health"], { env, fetch, stdout: sink(), stderr: sink(), nodeVersion: "22.13.0" })).toBe(0);
  });

  // Runs the CLI as its own process with this profile.
  const spawnCli = async (args, extraEnv, input) => {
    const child = spawn(process.execPath, ["skills/kamapathy/scripts/kamapathy.mjs", ...args], {
      env: { ...process.env, ...extraEnv },
    });
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
    expect(await spawnCli(["run", await scriptFile("task.mts", typed)], profileEnv)).toEqual({
      status: 0,
      stdout: "typed 2\n",
      stderr: "",
    });
    expect((await spawnCli(["run", await scriptFile("task.ts", typed)], profileEnv)).stdout).toBe("typed 2\n");
    expect((await spawnCli(["run", "--ts", "-e", typed], profileEnv)).stdout).toBe("typed 2\n");
    expect((await spawnCli(["run", "--ts", "-"], profileEnv, typed)).stdout).toBe("typed 2\n");
    await expect(
      runCli(["run", "--ts", await scriptFile("task.mjs", "1")], { env, stdout: sink(), stderr: sink() }),
    ).rejects.toThrow("--ts applies to run - and run -e. Name a TypeScript file .ts, .mts or .cts.");
    // Without type stripping, run starts itself once more with Node's flag.
    const calls = [];
    const fakeSpawn = (command, args, options) => {
      calls.push({ command, args, options, file: args.at(-1), existed: existsSync(args.at(-1)) });
      const child = new EventEmitter();
      child.kill = vi.fn();
      setTimeout(() => child.emit("exit", 4, null), 10);
      return child;
    };
    const stripping = { features: { typescript: false }, execArgv: [], spawn: fakeSpawn, execPath: "/bin/node" };
    const file = await scriptFile("task.mts", typed);
    const envFile = await scratchFile();
    expect(
      await runCli(["run", "--timeout", "5000", "--env-file", envFile, file], { env, stdout: sink(), stderr: sink(), ...stripping }),
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
    expect(await runCli(["run", "--ts", "-e", typed], { env, stdout: sink(), stderr: sink(), ...stripping })).toBe(4);
    expect(calls[1].file).toMatch(/kamapathy-run-[a-f0-9]{16}\.mts$/);
    expect(calls[1].existed).toBe(true);
    expect(calls[1].options.env.KAMAPATHY_RUN_SOURCE).toBe("-e");
    expect(existsSync(calls[1].file)).toBe(false);
    await expect(
      runCli(["run", file], { env, stdout: sink(), stderr: sink(), ...stripping, execArgv: ["--experimental-strip-types"] }),
    ).rejects.toThrow("This Node.js cannot run TypeScript. Use Node.js 22.18 or later, or write the script in JavaScript.");
    expect(calls).toHaveLength(2);
  }, 30000);

  it("the workspace follows the profile or KAMAPATHY_WORKSPACE; env files fill only unset variables, later files win, profile and workspace names are skipped, unsafe files are refused without printing values", async () => {
    const { userData } = await profile();
    expect(workspacePath({ KAMAPATHY_USER_DATA: userData })).toBe(join(userData, "workspace"));
    expect(workspacePath({ KAMAPATHY_USER_DATA: userData, KAMAPATHY_WORKSPACE: "tasks" }, "/home/me")).toBe(
      join("/home/me", "tasks"),
    );
    const workspace = join(userData, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const dotEnv = join(workspace, ".env");
    await writeFile(dotEnv, "FROM_ENV=first\nLATER=workspace\nSTART=changed\nKAMAPATHY_USER_DATA=/elsewhere\n", { mode: 0o600 });
    const extra = join(userData, "extra.env");
    await writeFile(extra, "LATER=extra-file\nADDED=3\n", { mode: 0o600 });
    const runEnv = { KAMAPATHY_USER_DATA: userData, KAMAPATHY_NO_LAUNCH: "1", START: "kept" };
    const stderr = sink();
    expect(
      await runCli(["run", "--env-file", extra, "-e", "1"], { env: runEnv, fetch: vi.fn(), stdout: sink(), stderr }),
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
        runCli(["run", "--env-file", link, "-e", "1"], { env: { ...runEnv }, fetch: vi.fn(), stdout: sink(), stderr: sink() }),
      ).rejects.toThrow(`Kamapathy will not load ${link}`);
      await chmod(workspace, 0o777);
      await expect(
        runCli(["run", "-e", "1"], { env: { ...runEnv }, fetch: vi.fn(), stdout: sink(), stderr: sink() }),
      ).rejects.toThrow(`Kamapathy's workspace ${workspace} must be a folder your account owns that others cannot change.`);
      await chmod(workspace, 0o700);
    }
  });

  it("env files cannot set the variables that locate the profile or the installed app", async () => {
    const home = await mkdtemp(join(tmpdir(), "kamapathy-cli-home-"));
    const runEnv = { HOME: home, USERPROFILE: home, KAMAPATHY_NO_LAUNCH: "1" };
    const { userData } = agentPaths(runEnv);
    const workspace = join(userData, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const dotEnv = join(workspace, ".env");
    // util.parseEnv returns names sorted, so the lines report them in that order.
    const names = ["APPDATA", "HOME", "LOCALAPPDATA", "USERPROFILE", "XDG_CONFIG_HOME"];
    await writeFile(dotEnv, names.map((name) => `${name}=${join(home, "elsewhere")}\n`).join(""), { mode: 0o600 });
    const stderr = sink();
    expect(await runCli(["run", "-e", "1"], { env: runEnv, fetch: vi.fn(), stdout: sink(), stderr })).toBe(0);
    expect(runEnv).toEqual({ HOME: home, USERPROFILE: home, KAMAPATHY_NO_LAUNCH: "1", KAMAPATHY_WORKSPACE: workspace });
    expect(agentPaths(runEnv).userData).toBe(userData);
    expect(stderr.text()).toBe(
      names.map((name) => `Kamapathy: ${dotEnv} cannot set ${name}. Set it in the environment instead.\n`).join(""),
    );
  });

  it("run and repl start Kamapathy without the variables their env files set", async () => {
    for (const command of ["run", "repl"]) {
      const { userData, paths } = await profile();
      const workspace = join(userData, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      await writeFile(join(workspace, ".env"), "SCRIPT_SECRET=s3cret\nHTTPS_PROXY=http://127.0.0.1:9\n", { mode: 0o600 });
      const runEnv = { KAMAPATHY_USER_DATA: userData, FROM_SHELL: "kept" };
      const launch = vi.fn(() =>
        fakeKamapathy(paths, {
          handler: (request, response) => {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(request.url === "/health" ? { status: "ok", version: "test" } : { spaces: [] }));
          },
        }),
      );
      const connect = { launch, intervalMs: 10, timeoutMs: 5000 };
      if (command === "run")
        expect(await runCli(["run", "-e", "await spaces()"], { env: runEnv, connect, stdout: sink(), stderr: sink() })).toBe(0);
      else {
        const input = new PassThrough();
        const output = new PassThrough();
        let text = "";
        output.on("data", (chunk) => (text += chunk));
        const ended = runCli(["repl"], { env: runEnv, connect, stdin: input, stdout: output, terminal: true });
        await expect.poll(() => text).toContain("kamapathy> ");
        input.write("(await spaces()).length\n");
        await expect.poll(() => text).toContain("0");
        input.write(".exit\n");
        expect(await ended).toBe(0);
      }
      expect(runEnv, command).toMatchObject({ SCRIPT_SECRET: "s3cret", HTTPS_PROXY: "http://127.0.0.1:9" });
      expect(launch, command).toHaveBeenCalledTimes(1);
      expect(launch.mock.calls[0][1], command).toEqual({
        KAMAPATHY_USER_DATA: userData,
        FROM_SHELL: "kept",
        KAMAPATHY_WORKSPACE: workspace,
      });
    }
  }, 20000);

  it("workspace prints and creates the folder with mode 0700, and --json prints {\"workspace\": path}", async () => {
    const { userData } = await profile();
    const fetch = vi.fn();
    const stdout = sink();
    expect(await runCli(["workspace"], { env: { KAMAPATHY_USER_DATA: userData }, fetch, stdout })).toBe(0);
    const workspace = join(userData, "workspace");
    expect(stdout.text()).toBe(`${workspace}\n`);
    if (posix) expect((await stat(workspace)).mode & 0o777).toBe(0o700);
    const json = sink();
    expect(await runCli(["workspace", "--json"], { env: { KAMAPATHY_USER_DATA: userData }, fetch, stdout: json })).toBe(0);
    expect(JSON.parse(json.text())).toEqual({ workspace });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("repl runs top-level await with the globals, prints queued notices once before the next prompt, aborts in-flight calls on SIGINT and needs a terminal", async () => {
    await expect(
      runCli(["repl"], { env, fetch: vi.fn(), stdin: new PassThrough(), stdout: sink() }),
    ).rejects.toThrow("repl needs a terminal. Pipe a script to run - instead.");
    const api = fakeApi({
      ...sectionTwo,
      "GET /spaces": (_body, options) =>
        new Promise((_done, reject) =>
          options.signal.addEventListener("abort", () => reject(options.signal.reason)),
        ),
    });
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => (text += chunk));
    const ended = runCli(["repl"], { env, fetch: api.fetch, health: level2, stdin: input, stdout: output, terminal: true });
    const entry = async (code, expected) => {
      input.write(`${code}\n`);
      await expect.poll(() => text).toContain(expected);
    };
    await expect.poll(() => text).toContain("Kamapathy scripting session. Type help() for the API and .exit to leave.");
    await entry('const replSpace = await space("space-1")', "kamapathy> ");
    await entry("replSpace.name", "'Research'");
    queueNotice("repl-test", "A notice for this session.");
    await entry("1 + 1", "2");
    await entry("2 + 2", "4");
    expect(text.split("notice: A notice for this session.").length).toBe(2);
    expect(text.indexOf("notice: A notice for this session.")).toBeGreaterThan(text.indexOf("\n2"));
    input.write("await spaces()\n");
    await expect.poll(() => api.requests.some((request) => request.path === "/spaces")).toBe(true);
    input.write("\u0003");
    await expect.poll(() => text).toContain(
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
      expect(await runCli(args, { env, fetch, connect: { launch }, stdin, stdout }), args.join(" ")).toBe(0);
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
    expect(await help(["help", "api", "page.click"])).toContain("page.click(target)");
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
    const skill = await realpathOf(join(process.cwd(), "skills/kamapathy/SKILL.md"));
    expect(stdout.text().endsWith(
      `Agents: read the Kamapathy skill before using these commands.\n  ${skill}\nIn run scripts, help() lists the API and help("page.click") shows one entry.\n`,
    )).toBe(true);
    expect(stdout.text()).toContain("Requires Node.js 22.13 or later.");
    for (const name of ["KAMAPATHY_USER_DATA", "KAMAPATHY_NO_LAUNCH", "KAMAPATHY_WORKSPACE", "KAMAPATHY_RUN_TIMEOUT_MS", "KAMAPATHY_PAGE_BUDGET", "KAMAPATHY_PROGRAM", "--version"])
      expect(stdout.text(), name).toContain(name);
  });

  it("names the program kamapathy only when KAMAPATHY_PROGRAM is set", async () => {
    const named = sink();
    await runCli(["help", "click"], { env: { ...env, KAMAPATHY_PROGRAM: "launcher-secret" }, stdout: named });
    expect(named.text()).toContain("Usage: kamapathy click <tab-id> <ref-or-selector>");
    expect(named.text()).not.toContain("launcher-secret");
    const plain = sink();
    await runCli(["help", "click"], { env, stdout: plain });
    expect(plain.text()).toContain(
      `Usage: node ${join(process.cwd(), "skills/kamapathy/scripts/kamapathy.mjs")} click <tab-id> <ref-or-selector>`,
    );
  });

  it("reports unknown topics with close matches and status 1", async () => {
    const stderr = sink();
    expect(await main(["help", "snapshto"], { env, stdout: sink(), stderr })).toBe(1);
    expect(stderr.text()).toBe('Kamapathy: No help topic "snapshto". Close matches: snapshot.\n');
    const none = sink();
    expect(await main(["help", "zzzzzz"], { env, stdout: sink(), stderr: none })).toBe(1);
    expect(none.text()).toBe('Kamapathy: No help topic "zzzzzz".\n');
  });

  it("reads arguments after -- literally", async () => {
    const fetch = vi.fn(async () => Response.json({ space }));
    const stdout = sink();
    expect(await runCli(["space", "create", "--", "--help"], { env, fetch, stdout })).toBe(0);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ name: "--help" });
    expect(stdout.text()).toBe('space space-1 "Research" agent shared\n');
    await runCli(["space", "create", "--", "--json"], { env, fetch, stdout: sink() });
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({ name: "--json" });
  });

  it("prints versions without starting Kamapathy", async () => {
    const launch = vi.fn();
    const skillFolder = await realpathOf(join(process.cwd(), "skills/kamapathy"));
    const client = `Kamapathy client ${schema.CLIENT_VERSION}, API level ${schema.API_LEVEL}, Node ${process.versions.node}\nSkill ${skillFolder}\n`;
    const version = async (argv, profileEnv) => {
      const stdout = sink();
      expect(await main(argv, { env: profileEnv, connect: { launch }, stdout, stderr: sink() })).toBe(0);
      return stdout.text();
    };
    const running = await profile();
    const health = { status: "ok", version: "0.2.0", apiLevel: schema.API_LEVEL, versions: { electron: "44.2.0", chromium: "152.0.7977.76", node: "24.20.0", v8: "x" } };
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
    expect(await version(["-v"], runningEnv)).toBe(await version(["--version"], runningEnv));
    expect(JSON.parse(await version(["--version", "--json"], runningEnv))).toEqual({
      client: { version: schema.CLIENT_VERSION, apiLevel: schema.API_LEVEL, node: process.versions.node, skill: skillFolder },
      app: { version: "0.2.0", apiLevel: schema.API_LEVEL, electron: "44.2.0", chromium: "152.0.7977.76", node: "24.20.0" },
      appStatus: "running",
    });
    const idle = await profile();
    expect(await version(["--version"], { KAMAPATHY_USER_DATA: idle.userData })).toBe(`${client}Kamapathy is not running.\n`);
    expect(JSON.parse(await version(["--version", "--json"], { KAMAPATHY_USER_DATA: idle.userData }))).toMatchObject({
      app: null,
      appStatus: "not_running",
    });
    await writeFile(idle.paths.off, "", { mode: 0o600 });
    expect(await version(["--version"], { KAMAPATHY_USER_DATA: idle.userData })).toBe(`${client}Agent access is off in Kamapathy.\n`);
    const older = await profile();
    await fakeKamapathy(older.paths, {
      handler: (_request, response) => {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "ok", version: "0.1.9" }));
      },
    });
    expect(await version(["--version"], { KAMAPATHY_USER_DATA: older.userData })).toBe(
      `${client}Kamapathy 0.1.9, API level 1\nKamapathy 0.1.9 has API level 1 and this client uses ${schema.API_LEVEL}. Calls added after level 1 fail until the person updates Kamapathy.\n`,
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("help() in a run prints the index and one entry", async () => {
    const { env: profileEnv } = await profile();
    const run = await spawnCli(["run", "-e", 'help(); help("page.click"); help("clik"); help("close");'], profileEnv);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`Kamapathy script API, client ${schema.CLIENT_VERSION}, API level ${schema.API_LEVEL}`);
    expect(run.stdout).toContain('help("page.click") shows one entry; help("errors") lists error codes.');
    expect(run.stdout).toContain("page.click(target)\n");
    expect(run.stdout).toContain('No help entry named "clik". Close matches: page.click.');
    expect(run.stdout).toContain("space.close()\n");
    expect(run.stdout).toContain("page.close()\n");
  }, 20000);

  it("creates isolated spaces from the command line and says how each space signs in", async () => {
    for (const [args, body] of [
      [["space", "create", "Research"], { name: "Research" }],
      [["space", "create", "Research", "--isolated"], { name: "Research", isolated: true }],
      [["space", "create", "--isolated", "Research"], { name: "Research", isolated: true }],
    ]) {
      const fetch = vi.fn(async () => Response.json({ space }));
      expect(await runCli(args, { env, fetch, stdout: sink() })).toBe(0);
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(body);
    }
    for (const [signIns, suffix] of [["separate", " isolated"], ["shared", " shared"], [undefined, ""]]) {
      const created = sink();
      await runCli(["space", "create", "Research"], {
        env,
        fetch: vi.fn(async () => Response.json({ space: { ...space, signIns } })),
        stdout: created,
      });
      expect(created.text()).toBe(`space space-1 "Research" agent${suffix}\n`);
      const listed = sink();
      await runCli(["spaces"], {
        env,
        fetch: vi.fn(async () => Response.json({ spaces: [{ ...space, signIns }] })),
        stdout: listed,
      });
      expect(listed.text()).toBe(`space-1 "Research" agent${suffix}\n`);
    }
    const help = sink();
    await runCli(["help"], { env, fetch: vi.fn(), stdout: help });
    expect(help.text()).toContain("--isolated");
    expect(help.text()).toMatch(/\n  run /);
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
    expect(new KamapathyError("not_connected", "Busy.", { reason: "busy" }).retryable).toBe(true);
    expect(
      new KamapathyError("not_connected", "Off.", { reason: "access_off" }),
    ).not.toHaveProperty("retryable");
    const route = (key) => schema.ROUTES.find((item) => schema.routeKey(item) === key);
    expect(httpTimeout(600000, route("POST /spaces/:id/wait-for-control"))).toBe(605000);
    expect(httpTimeout(undefined, route("POST /tabs/:id/click"))).toBe(45000);
    expect(httpTimeout(undefined, route("POST /tabs/:id/actions"))).toBe(180000);
    expect(httpTimeout(undefined, undefined)).toBe(45000);
  });
});
