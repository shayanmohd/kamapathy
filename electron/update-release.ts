import type { InstallKind, UpdateRelease } from "../shared/types";
import { compareVersions, isVersion } from "../shared/version";
import { runningAppImage, runningPortable } from "./agent-socket";

// What an update check needs to know about releases, with no Electron import.

export interface Repository {
  owner: string;
  repo: string;
}

export interface UpdateSource {
  listUrl: string;
  releasesBase: string;
  loopback: boolean;
}

// Installer names are an update contract: scripts/publish-release.mjs
// publishes exactly these, and no file name ever comes from the network.
const INSTALLERS = new Map<InstallKind, string>([
  ["mac-arm64", "mac-arm64.dmg"],
  ["mac-x64", "mac-x64.dmg"],
  ["windows-setup", "windows-x64-setup.exe"],
  ["windows-portable", "windows-x64-portable.exe"],
  ["linux-appimage", "linux-x86_64.AppImage"],
  ["linux-deb", "linux-amd64.deb"],
]);

export const INSTALLER_KINDS: readonly InstallKind[] = [...INSTALLERS.keys()];

const SMALLEST_INSTALLER = 1048576;
const LARGEST_INSTALLER = 1073741824;

// A fork's homepage names its own repository, so it checks its own releases.
export function repository(homepage: unknown): Repository | null {
  const match =
    typeof homepage === "string"
      ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/i.exec(homepage)
      : null;
  // A clone URL is not a repository's page.
  if (!match || /\.git$/i.test(match[2])) return null;
  return { owner: match[1], repo: match[2] };
}

// Source runs may name a loopback test feed that serves the same paths.
export function updateSource(repo: Repository, feed?: string): UpdateSource {
  if (feed && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(feed))
    return {
      listUrl: `${feed}/api/releases?per_page=20`,
      releasesBase: `${feed}/releases`,
      loopback: true,
    };
  return {
    listUrl: `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=20`,
    releasesBase: `https://github.com/${repo.owner}/${repo.repo}/releases`,
    loopback: false,
  };
}

export function installKind(input: {
  platform: NodeJS.Platform;
  arch: string;
  translated: boolean;
  packaged: boolean;
  env: NodeJS.ProcessEnv;
  execPath: string;
}): InstallKind {
  const { platform, arch } = input;
  if (!input.packaged) return "source";
  // A Rosetta copy moves to the native build.
  if (platform === "darwin")
    return arch === "arm64" || input.translated
      ? "mac-arm64"
      : arch === "x64"
        ? "mac-x64"
        : "other";
  // Windows 11 on Arm runs the x64 build too.
  if (platform === "win32")
    return runningPortable(input) ? "windows-portable" : "windows-setup";
  if (platform === "linux" && arch === "x64")
    return runningAppImage(input) ? "linux-appimage" : "linux-deb";
  return "other";
}

export function installerName(
  kind: InstallKind,
  version: string,
): string | null {
  const suffix = INSTALLERS.get(kind);
  return suffix ? `Kamapathy-${version}-${suffix}` : null;
}

type Fields = Record<string, unknown>;
type PickOptions = { source: UpdateSource; current: string; kind: InstallKind };

const fields = (value: unknown): Fields | undefined =>
  value && typeof value === "object" ? (value as Fields) : undefined;

// GitHub spells the repository its own way, so letter case may differ from
// homepage. Only ASCII letters fold, so no other character can pass for one.
const fold = (text: string) =>
  text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

// An asset counts once uploaded, at exactly the file in the release's download
// folder, with letter case free only before the name. No query, fragment, dot
// segment, other scheme or other host can pass.
function assetUrl(
  asset: Fields | undefined,
  folder: string,
  name: string,
): string | null {
  const url = asset?.browser_download_url;
  return asset?.state === "uploaded" &&
    typeof url === "string" &&
    url.endsWith(`/${name}`) &&
    fold(url) === fold(folder + name)
    ? url
    : null;
}

function usableRelease(
  value: unknown,
  { source, current, kind }: PickOptions,
): UpdateRelease | null {
  const release = fields(value);
  const tag = release?.tag_name;
  if (
    !release ||
    release.draft === true ||
    typeof tag !== "string" ||
    !tag.startsWith("v")
  )
    return null;
  const version = tag.slice(1);
  if (!isVersion(version) || compareVersions(version, current) <= 0)
    return null;
  const name = installerName(kind, version);
  const page = release.html_url;
  const publishedAt =
    typeof release.published_at === "string"
      ? Date.parse(release.published_at)
      : NaN;
  if (
    !name ||
    typeof page !== "string" ||
    fold(page) !== fold(`${source.releasesBase}/tag/v${version}`) ||
    !Number.isFinite(publishedAt) ||
    !Array.isArray(release.assets)
  )
    return null;
  const assets = release.assets.map(fields);
  const installer = assets.find((asset) => asset?.name === name);
  const folder = `${source.releasesBase}/download/v${version}/`;
  const installerUrl = assetUrl(installer, folder, name);
  const sums = assetUrl(
    assets.find((asset) => asset?.name === "SHA256SUMS.txt"),
    folder,
    "SHA256SUMS.txt",
  );
  const size = installer?.size;
  if (
    !installerUrl ||
    !sums ||
    typeof size !== "number" ||
    !Number.isInteger(size) ||
    size < SMALLEST_INSTALLER ||
    size > LARGEST_INSTALLER
  )
    return null;
  const digest =
    typeof installer?.digest === "string"
      ? /^sha256:([0-9a-f]{64})$/.exec(installer.digest)
      : null;
  return {
    version,
    publishedAt,
    url: page,
    installer: {
      name,
      size,
      url: installerUrl,
      ...(digest ? { sha256: digest[1] } : {}),
    },
    sums,
  };
}

// Every release is published as a prerelease, so the list is read in full and
// the highest usable version wins, whatever the order.
export function pickRelease(
  json: unknown,
  options: PickOptions,
): UpdateRelease | null {
  if (!Array.isArray(json))
    throw new TypeError("The release list is not an array.");
  let newest: UpdateRelease | null = null;
  for (const value of json) {
    const release = usableRelease(value, options);
    if (
      release &&
      (!newest || compareVersions(release.version, newest.version) > 0)
    )
      newest = release;
  }
  return newest;
}

// SHA256SUMS.txt as scripts/publish-release.mjs writes it: one
// "<64 lowercase hex>  <name>" line per file and each name once.
export function parseChecksums(text: string): Map<string, string> | null {
  const sums = new Map<string, string>();
  for (const line of text.replace(/\n$/, "").split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([\x21-\x7e]+)$/.exec(line);
    if (!match || /[/\\]/.test(match[2]) || sums.has(match[2])) return null;
    sums.set(match[2], match[1]);
  }
  return sums;
}
