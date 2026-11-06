// CI step "Test install scripts": runs the install script for this computer's
// platform against a local release server, in temporary folders.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  releaseEntry,
  sha256sums,
  startReleaseServer,
} from "../tests/fixtures/release-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPTS = join(root, "skills", "kamapathy", "scripts");
const BUNDLE_ID = "app.kamapathy.browser";
const VERSION = "9.9.9";
// A newer release that carries no installer for any platform.
const SKIPPED = "9.9.10";
const workspace = mkdtempSync(join(tmpdir(), "kamapathy-install-test-"));
const unregister = [];
let serving = () => ({ list: [], files: new Map() });
const server = await startReleaseServer({
  releases: (origin) => serving(origin),
});

// Windows PowerShell ends its lines with CRLF.
const lines = (text) => text.split(/\r?\n/).filter((line) => line !== "");

// A home, a temporary folder, an install folder and, for Windows, an HKCU
// subkey for uninstall entries of its own per run.
function area(name) {
  const base = join(workspace, name);
  const paths = {
    home: join(base, "home"),
    temp: join(base, "temp"),
    dir: join(base, "apps"),
  };
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  return { ...paths, key: `Software\\Kamapathy install test ${randomUUID()}` };
}

function offer(name, data, sums = sha256sums([[name, data]])) {
  const text = Buffer.from(sums);
  serving = (origin) => ({
    list: [
      releaseEntry(origin, SKIPPED, [
        {
          name: `Kamapathy-${SKIPPED}-mac-arm64.zip`,
          data: Buffer.from("zip"),
        },
        { name: "SHA256SUMS.txt", data: Buffer.from("sums") },
      ]),
      releaseEntry(origin, VERSION, [
        { name, data },
        { name: "SHA256SUMS.txt", data: text },
      ]),
    ],
    files: new Map([
      [`v${VERSION}/${name}`, data],
      [`v${VERSION}/SHA256SUMS.txt`, text],
    ]),
  });
}

// The release server answers in this process, so a run must never block it.
// Nothing reaches the script's stdin, so it is never at a terminal.
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (status) =>
      resolve({
        status,
        out: lines(out),
        err: lines(err),
        text: `${out}${err}`,
      }),
    );
  });
}

const sh = (args, { home, temp }) =>
  run("sh", [join(SCRIPTS, "install.sh"), ...args], {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: temp,
    KAMAPATHY_RELEASES_API: server.listUrl,
  });

// The script reads the run's own uninstall entries, never this computer's.
const powershell = (
  args,
  { home, temp, key },
  { script = join(SCRIPTS, "install.ps1"), env = {} } = {},
) =>
  run(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
    {
      ...process.env,
      USERPROFILE: home,
      LOCALAPPDATA: join(home, "AppData", "Local"),
      TEMP: temp,
      TMP: temp,
      KAMAPATHY_RELEASES_API: server.listUrl,
      KAMAPATHY_UNINSTALL_KEY: key,
      ...env,
    },
  );

const skippedFetched = () =>
  server.requests.some((request) => request.url.includes(`/v${SKIPPED}/`));

function macChecks() {
  const machine = execFileSync("uname", ["-m"], { encoding: "utf8" }).trim();
  const translated = spawnSync("sysctl", ["-n", "sysctl.proc_translated"], {
    encoding: "utf8",
  }).stdout?.trim();
  const asset = `Kamapathy-${VERSION}-${
    machine === "arm64" || translated === "1" ? "mac-arm64" : "mac-x64"
  }.dmg`;
  const image = stubImage("current", "11.0");
  const unsupported = stubImage("future", "99.0");
  const first = area("mac");
  const app = join(first.dir, "Kamapathy.app");
  return [
    [
      "macOS installs a verified disk image",
      async () => {
        offer(asset, image);
        const run = await sh(["--dir", first.dir, "--no-open"], first);
        unregister.push(app);
        assert.equal(run.status, 0, run.text);
        for (const line of run.err)
          assert.ok(line.startsWith("Kamapathy install: "), line);
        assert.equal(run.out.at(-1), `installed ${app}`);
        assert.equal(bundleId(app), BUNDLE_ID);
        assert.equal(skippedFetched(), false, "fetched the skipped release");
        assert.deepEqual(readdirSync(first.temp), []);
      },
    ],
    [
      "macOS reports an app that is already installed",
      async () => {
        const run = await sh(["--dir", first.dir, "--no-open"], first);
        assert.equal(run.status, 0, run.text);
        assert.equal(run.out.at(-1), `already installed ${app}`);
      },
    ],
    [
      "macOS installs nothing after a checksum mismatch",
      async () => {
        const where = area("mac-checksum");
        offer(asset, image, sha256sums([[asset, Buffer.from("other")]]));
        const run = await sh(["--dir", where.dir, "--no-open"], where);
        assert.equal(run.status, 1, run.text);
        assert.deepEqual(readdirSync(where.dir), []);
        assert.deepEqual(readdirSync(where.temp), []);
      },
    ],
    [
      "macOS refuses a disk image that needs a newer system",
      async () => {
        const where = area("mac-system");
        offer(asset, unsupported);
        const run = await sh(["--dir", where.dir, "--no-open"], where);
        assert.equal(run.status, 3, run.text);
        assert.deepEqual(readdirSync(where.dir), []);
      },
    ],
    [
      "an unknown option stops the script",
      async () => {
        const where = area("mac-option");
        const run = await sh(["--enable-everything"], where);
        assert.equal(run.status, 2, run.text);
        assert.deepEqual(readdirSync(where.temp), []);
      },
    ],
  ];
}

const bundleId = (app) =>
  execFileSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :CFBundleIdentifier", join(app, "Contents", "Info.plist")],
    { encoding: "utf8" },
  ).trim();

// An ad hoc signed stub bundle in a disk image, as a release carries one.
function stubImage(name, minimum) {
  const folder = join(workspace, "images", name);
  const source = join(folder, "image");
  const app = join(source, "Kamapathy.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>`,
    "  <key>CFBundleName</key><string>Kamapathy</string>",
    "  <key>CFBundleExecutable</key><string>Kamapathy</string>",
    `  <key>CFBundleShortVersionString</key><string>${VERSION}</string>`,
    "  <key>CFBundlePackageType</key><string>APPL</string>",
    `  <key>LSMinimumSystemVersion</key><string>${minimum}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
  writeFileSync(join(app, "Contents", "Info.plist"), plist);
  writeFileSync(
    join(app, "Contents", "MacOS", "Kamapathy"),
    "#!/bin/sh\nexit 0\n",
    { mode: 0o755 },
  );
  execFileSync("codesign", ["--force", "--deep", "-s", "-", app]);
  const image = join(folder, `Kamapathy-${VERSION}.dmg`);
  execFileSync("hdiutil", [
    "create",
    "-srcfolder",
    source,
    "-volname",
    "Kamapathy",
    "-format",
    "UDZO",
    "-quiet",
    "-ov",
    image,
  ]);
  return readFileSync(image);
}

function linuxChecks() {
  const stub = Buffer.from('#!/bin/sh\necho "Kamapathy stub"\n');
  const first = area("linux");
  const app = join(first.home, "Applications", "Kamapathy.AppImage");
  return [
    [
      "Linux installs an AppImage with a desktop entry",
      async () => {
        offer(`Kamapathy-${VERSION}-linux-x86_64.AppImage`, stub);
        const run = await sh(["--no-open"], first);
        assert.equal(run.status, 0, run.text);
        for (const line of run.err)
          assert.ok(line.startsWith("Kamapathy install: "), line);
        assert.equal(run.out.at(-1), `installed ${app}`);
        assert.equal(statSync(app).mode & 0o777, 0o755);
        const entry = readFileSync(
          join(first.home, ".local/share/applications", `${BUNDLE_ID}.desktop`),
          "utf8",
        );
        assert.match(entry, /^Type=Application$/m);
        assert.match(entry, /^Terminal=false$/m);
        assert.match(entry, /^StartupWMClass=app\.kamapathy\.browser$/m);
        assert.ok(entry.includes(`Exec="${app}" %U`), entry);
        assert.equal(skippedFetched(), false, "fetched the skipped release");
        assert.deepEqual(readdirSync(first.temp), []);
      },
    ],
    [
      "Linux reports an AppImage that is already installed",
      async () => {
        const run = await sh(["--no-open"], first);
        assert.equal(run.status, 0, run.text);
        assert.equal(run.out.at(-1), `already installed ${app}`);
      },
    ],
    [
      "Linux saves and verifies a package without installing it",
      async () => {
        const where = area("linux-deb");
        const name = `Kamapathy-${VERSION}-linux-amd64.deb`;
        const data = Buffer.from("stub package\n");
        offer(name, data);
        const run = await sh(["--deb", "--no-open"], where);
        const path = join(where.home, "Downloads", name);
        assert.equal(run.status, 0, run.text);
        assert.ok(
          run.err.includes(
            `Kamapathy install: run: sudo apt-get install -y ${path}`,
          ),
          run.text,
        );
        assert.equal(run.out.at(-1), `downloaded ${path}`);
        assert.ok(readFileSync(path).equals(data));
      },
    ],
  ];
}

function windowsChecks() {
  const name = `Kamapathy-${VERSION}-windows-x64-setup.exe`;
  const data = Buffer.from("stub installer\n");
  const modules = pwshModulePath();
  // Without PowerShell 7 no module folder of its can reach Windows PowerShell.
  if (!modules)
    console.log("SKIP checks under PowerShell 7's module path: no pwsh.exe");
  const underPwsh = [
    [
      "Windows verifies an installer under PowerShell 7's module path",
      async () => {
        const where = area("windows-pwsh");
        offer(name, data);
        const run = await powershell(["-NoRun"], where, {
          env: { PSModulePath: modules },
        });
        assert.equal(run.status, 0, run.text);
        const path = join(where.home, "Downloads", name);
        assert.equal(run.out.at(-1), `downloaded ${path}`);
        assert.ok(readFileSync(path).equals(data));
      },
    ],
    [
      "Windows checks a pinned publisher under PowerShell 7's module path",
      async () => {
        const where = area("windows-publisher");
        const publisher = "Kamapathy test publisher";
        const source = readFileSync(join(SCRIPTS, "install.ps1"), "utf8");
        const pinned = source.replace(
          /^\$PUBLISHER = '[^']*'$/m,
          () => `$PUBLISHER = '${publisher}'`,
        );
        assert.notEqual(pinned, source, "install.ps1 sets no $PUBLISHER");
        const script = join(where.dir, "install.ps1");
        writeFileSync(script, pinned);
        offer(name, data);
        const run = await powershell(["-NoRun"], where, {
          script,
          env: { PSModulePath: modules },
        });
        assert.equal(run.status, 1, run.text);
        assert.equal(
          run.err.at(-1),
          `Kamapathy install: ${name} is not signed by ${publisher}, so nothing was installed.`,
          run.text,
        );
        assert.equal(existsSync(join(where.home, "Downloads", name)), false);
      },
    ],
  ];
  return [
    [
      "Windows deletes an installer that fails its checksum",
      async () => {
        const where = area("windows-checksum");
        offer(name, data, sha256sums([[name, Buffer.from("other")]]));
        const run = await powershell(["-NoRun"], where);
        assert.equal(run.status, 1, run.text);
        assert.equal(existsSync(join(where.home, "Downloads", name)), false);
      },
    ],
    [
      "Windows keeps a verified installer",
      async () => {
        const where = area("windows-download");
        offer(name, data);
        const run = await powershell(["-NoRun"], where);
        assert.equal(run.status, 0, run.text);
        const path = join(where.home, "Downloads", name);
        assert.equal(run.out.at(-1), `downloaded ${path}`);
        assert.ok(readFileSync(path).equals(data));
        assert.equal(skippedFetched(), false, "fetched the skipped release");
      },
    ],
    ...(modules ? underPwsh : []),
    [
      "Windows finds Kamapathy installed in a folder the person chose",
      async () => {
        const where = area("windows-folder");
        const folder = join(where.dir, "Chosen", "Kamapathy");
        const app = join(folder, "Kamapathy.exe");
        mkdirSync(folder, { recursive: true });
        writeFileSync(app, "");
        const requests = server.requests.length;
        try {
          await writeEntries(where.key, {
            [randomUUID()]: uninstallEntry(folder),
          });
          const run = await powershell(["-NoRun"], where);
          assert.equal(run.status, 0, run.text);
          assert.equal(run.out.at(-1), `already installed ${app}`);
          assert.equal(server.requests.length, requests, "looked for releases");
        } finally {
          await removeKey(where.key);
        }
      },
    ],
    [
      "Windows passes over entries without Kamapathy.exe or of other products",
      async () => {
        const where = area("windows-entries");
        const removed = join(where.dir, "Removed", "Kamapathy");
        const tools = join(where.dir, "Kamapathy Tools");
        mkdirSync(removed, { recursive: true });
        mkdirSync(tools, { recursive: true });
        writeFileSync(join(tools, "Kamapathy.exe"), "");
        offer(name, data);
        try {
          await writeEntries(where.key, {
            removed: uninstallEntry(removed),
            tools: {
              ...uninstallEntry(tools),
              DisplayName: "Kamapathy Tools 1.0.0",
              UninstallString: `"${join(tools, "Uninstall Kamapathy Tools.exe")}" /currentuser`,
              InstallLocation: tools,
            },
            // The entry the script used to trust, naming no folder.
            bare: { DisplayName: "Kamapathy" },
          });
          const run = await powershell(["-NoRun"], where);
          assert.equal(run.status, 0, run.text);
          const path = join(where.home, "Downloads", name);
          assert.equal(run.out.at(-1), `downloaded ${path}`);
        } finally {
          await removeKey(where.key);
        }
      },
    ],
  ];
}

// The PSModulePath a PowerShell 7 process hands its children, with its own
// module folders first, or undefined without PowerShell 7.
function pwshModulePath() {
  const result = spawnSync(
    "pwsh.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "$env:PSModulePath"],
    { encoding: "utf8" },
  );
  if (result.error?.code === "ENOENT") return undefined;
  assert.equal(result.status, 0, `${result.error ?? ""}${result.stderr}`);
  return result.stdout.trim();
}

// The values electron-builder's installer writes to its uninstall entry.
const uninstallEntry = (folder) => ({
  DisplayName: `Kamapathy ${VERSION}`,
  DisplayVersion: VERSION,
  UninstallString: `"${join(folder, "Uninstall Kamapathy.exe")}" /currentuser`,
  DisplayIcon: `${join(folder, "Kamapathy.exe")},0`,
});

// Windows PowerShell with .NET calls only, so no PSModulePath can break it.
async function registry(script) {
  const encoded = Buffer.from(
    `$ErrorActionPreference = 'Stop'\n${script}`,
    "utf16le",
  ).toString("base64");
  const result = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    process.env,
  );
  assert.equal(result.status, 0, result.text);
}

const literal = (text) => `'${text.replaceAll("'", "''")}'`;

// One subkey of `key` per entry, holding REG_SZ values.
const writeEntries = (key, entries) =>
  registry(
    Object.entries(entries)
      .flatMap(([name, values]) => [
        `$entry = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${literal(`${key}\\${name}`)})`,
        ...Object.entries(values).map(
          ([value, data]) =>
            `$entry.SetValue(${literal(value)}, ${literal(data)})`,
        ),
        "$entry.Close()",
      ])
      .join("\n"),
  );

const removeKey = (key) =>
  registry(
    `[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${literal(key)}, $false)`,
  );

const parts = {
  darwin: macChecks,
  linux: linuxChecks,
  win32: windowsChecks,
};
let failures = 0;
try {
  const checks = parts[process.platform]?.() ?? [];
  if (!checks.length) console.log(`No install checks for ${process.platform}.`);
  for (const [name, check] of checks)
    try {
      await check();
      console.log(`PASS ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${name}`);
      console.error(error?.message ?? error);
    }
} finally {
  await server.close();
  // LaunchServices must forget every stub before its folder disappears.
  for (const app of unregister)
    spawnSync(
      "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
      ["-u", app],
      { stdio: "ignore" },
    );
  rmSync(workspace, { recursive: true, force: true });
}
if (failures) process.exitCode = 1;
