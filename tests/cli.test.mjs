import { afterEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
import { httpTimeout } from "../skills/kamapathy/scripts/lib/request.mjs";
import { agentPaths as kamapathyAgentPaths } from "../electron/agent-socket.ts";

const env = { KAMAPATHY_NO_LAUNCH: "1" };
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
      launchKamapathy(paths, { KAMAPATHY_USER_DATA: userData, PATH: "" }, { platform: "linux" }),
    ).rejects.toThrow("Could not start Kamapathy");
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
      { platform: "linux", env: { PATH: "" } },
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

  it("copies retryable and dispatched as own fields and adds entry", async () => {
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
    expect(stale.text()).toBe("error: stale_ref: Observe again.\n");
    const plain = sink();
    expect(await runCli(["run", "-e", 'throw new Error("boom")'], { env, fetch: api.fetch, stdout: sink(), stderr: plain })).toBe(1);
    expect(plain.text()).toBe("error: boom\n");
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
