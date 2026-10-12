import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const projectDirectory = fileURLToPath(new URL("../", import.meta.url));

export function runtimeExecutable(directory, platform = process.platform) {
  if (platform === "darwin") return join(directory, "Kamapathy.app", "Contents", "MacOS", "Kamapathy");
  return join(directory, platform === "win32" ? "Kamapathy.exe" : "kamapathy");
}

async function available(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Use the same native branding pipeline as releases, once per runtime and icon
// revision. The original Electron installation is never edited.
export async function prepareDesktopRuntime() {
  const metadata = JSON.parse(await readFile(join(projectDirectory, "package.json"), "utf8"));
  const electronDirectory = dirname(require.resolve("electron/package.json"));
  const electronVersion = JSON.parse(await readFile(join(electronDirectory, "package.json"), "utf8")).version;
  // Electron 44 installs its native binary lazily when this entry is loaded.
  // Resolving package metadata alone does not prepare a fresh npm checkout.
  const stockExecutable = require("electron");
  const electronDist = process.platform === "darwin"
    ? dirname(dirname(dirname(dirname(stockExecutable))))
    : dirname(stockExecutable);
  const builderVersion = require("electron-builder/package.json").version;
  const fingerprint = createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(JSON.stringify([process.platform, process.arch, metadata, electronVersion, builderVersion]));
  for (const icon of ["icon.icns", "icon.ico", "icon.png"])
    fingerprint.update(await readFile(join(projectDirectory, "build", icon)));
  const cacheDirectory = join(projectDirectory, "node_modules", ".cache", "kamapathy-runtime");
  const destination = join(cacheDirectory, fingerprint.digest("hex").slice(0, 20));
  const executable = runtimeExecutable(destination);
  if (await available(join(destination, ".ready")) && await available(executable))
    return executable;

  await mkdir(cacheDirectory, { recursive: true });
  const staging = await mkdtemp(join(cacheDirectory, "preparing-"));
  try {
    console.log("Preparing the Kamapathy desktop runtime. Future launches reuse this copy.");
    const { build, Platform } = await import("electron-builder");
    const source = join(staging, "source");
    await mkdir(source);
    // electron-builder reads the project folder's package.json while it
    // collects node modules; this runtime has none.
    await writeFile(join(staging, "package.json"), JSON.stringify({ name: "kamapathy-runtime", private: true }));
    await writeFile(join(source, "package.json"), JSON.stringify({
      name: "kamapathy",
      productName: "Kamapathy",
      desktopName: "app.kamapathy.browser.desktop",
      version: metadata.version,
      description: metadata.description,
      author: metadata.author,
      license: metadata.license,
      main: "index.cjs",
    }));
    await writeFile(join(source, "index.cjs"), 'require("electron").app.quit();\n');
    let outputDirectory;
    await build({
      projectDir: staging,
      targets: Platform.current().createTarget("dir"),
      publish: "never",
      config: {
        appId: "app.kamapathy.browser",
        productName: "Kamapathy",
        directories: { app: source, output: join(staging, "output") },
        files: ["package.json", "index.cjs"],
        asar: false,
        npmRebuild: false,
        electronVersion,
        electronDist,
        mac: { icon: join(projectDirectory, "build/icon.icns"), identity: null, hardenedRuntime: false, notarize: false },
        win: { icon: join(projectDirectory, "build/icon.ico") },
        linux: { icon: join(projectDirectory, "build/icon.png"), executableName: "kamapathy", syncDesktopName: true },
        afterPack(context) { outputDirectory = context.appOutDir; },
      },
    });
    if (!outputDirectory) throw new Error("The Kamapathy desktop runtime was not created.");
    const resources = process.platform === "darwin"
      ? join(outputDirectory, "Kamapathy.app", "Contents", "Resources")
      : join(outputDirectory, "resources");
    const originalResources = process.platform === "darwin"
      ? join(dirname(dirname(stockExecutable)), "Resources")
      : join(electronDist, "resources");
    // Keep Electron's development entry loader so CLI arguments, Playwright,
    // process.defaultApp, and the Vite development server behave as before.
    await rm(join(resources, "app"), { recursive: true, force: true });
    await copyFile(join(originalResources, "default_app.asar"), join(resources, "default_app.asar"));
    await writeFile(join(outputDirectory, ".ready"), "Kamapathy desktop runtime\n");
    try {
      await rename(outputDirectory, destination);
    } catch (error) {
      // Another launch can finish the same immutable cache while we prepare it.
      if (!(await available(join(destination, ".ready"))) || !(await available(executable)))
        throw error;
    }
    return executable;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function desktopLaunch(mode, executable, environment = process.env) {
  if (mode !== "dev" && mode !== "start")
    throw new Error(`Unknown desktop mode: ${mode}. Use dev or start.`);
  const env = { ...environment, ELECTRON_EXEC_PATH: executable };
  delete env.ELECTRON_RUN_AS_NODE;
  return {
    executable: mode === "dev" ? process.execPath : executable,
    args: mode === "dev"
      ? [join(projectDirectory, "node_modules/electron-vite/bin/electron-vite.js"), "dev"]
      : [resolve(projectDirectory)],
    options: { cwd: projectDirectory, stdio: "inherit", env },
  };
}
