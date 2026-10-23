/**
 * A local update feed for KAMAPATHY_UPDATE_FEED: GET /api/releases lists one
 * release of `version` with the kind's installer and SHA256SUMS.txt under
 * /releases/download/v<version>/.
 * Modes: "current" lists nothing newer; "available" lists the release with a
 * correct sums file and digest; "bad-sum" lists it with a wrong
 * SHA256SUMS.txt line.
 */
import { createHash } from "node:crypto";
import {
  releaseEntry,
  sha256sums,
  startReleaseServer,
} from "./release-server.mjs";

// The names releases publish, as electron/update-release.ts spells them.
const SUFFIXES = {
  "mac-arm64": "mac-arm64.dmg",
  "mac-x64": "mac-x64.dmg",
  "windows-setup": "windows-x64-setup.exe",
  "windows-portable": "windows-x64-portable.exe",
  "linux-appimage": "linux-x86_64.AppImage",
  "linux-deb": "linux-amd64.deb",
};
const LIST = "/api/releases";

/**
 * @param {{ version?: string, kind?: string, size?: number }} [options]
 */
export async function startUpdateFeed({
  version = "9.9.9",
  kind = "linux-appimage",
  size = 2 * 1024 * 1024,
} = {}) {
  const suffix = SUFFIXES[kind];
  if (!suffix) throw new Error(`No installer for ${kind}.`);
  const name = `Kamapathy-${version}-${suffix}`;
  const data = Buffer.alloc(size, 0x4b);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const sums = {
    available: Buffer.from(sha256sums([[name, data]])),
    // A well-formed line for other bytes, so the file is deleted as a mismatch.
    "bad-sum": Buffer.from(
      sha256sums([[name, Buffer.concat([data, Buffer.from("x")])]]),
    ),
  };
  let mode = "current";
  const server = await startReleaseServer({
    releases: (origin) => {
      const text = sums[mode];
      if (!text) return { list: [], files: new Map() };
      return {
        list: [
          releaseEntry(origin, version, [
            { name, data },
            { name: "SHA256SUMS.txt", data: text },
          ]),
        ],
        files: new Map([
          [`v${version}/${name}`, data],
          [`v${version}/SHA256SUMS.txt`, text],
        ]),
      };
    },
  });
  return {
    origin: server.origin,
    installer: { name, size, sha256 },
    /** @param {"current" | "available" | "bad-sum"} next */
    setMode(next) {
      if (next !== "current" && !sums[next])
        throw new Error(`Unknown feed mode: ${next}`);
      mode = next;
    },
    /** When the feed last served the release list, for the 60 s reuse rule. */
    lastListRequestAt: () =>
      server.requests.filter((request) => request.url.startsWith(LIST)).at(-1)
        ?.at ?? null,
    close: server.close,
  };
}
