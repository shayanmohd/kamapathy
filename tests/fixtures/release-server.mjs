// A local stand-in for GitHub Releases: the release list and the asset files,
// shared by the install and update tests. Node built-ins only.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const PUBLISHED = "2026-10-01T12:00:00.000Z";
const DOWNLOAD = "/releases/download/";
const digest = (data) =>
  `sha256:${createHash("sha256").update(data).digest("hex")}`;

/**
 * One GitHub-shaped release whose URLs live under `origin`.
 * @param {string} origin
 * @param {string} version
 * @param {{ name: string, data: Buffer, state?: "uploaded" | "starter", digest?: boolean }[]} assets
 *   `digest: false` leaves that asset's digest out, as an older release has it.
 * @param {{ draft?: boolean, prerelease?: boolean, publishedAt?: string }} [options]
 */
export function releaseEntry(origin, version, assets, options = {}) {
  const tag = `v${version}`;
  return {
    tag_name: tag,
    name: `Kamapathy ${version}`,
    draft: options.draft === true,
    prerelease: options.prerelease !== false,
    published_at: options.publishedAt ?? PUBLISHED,
    html_url: `${origin}/releases/tag/${tag}`,
    assets: assets.map((asset) => ({
      name: asset.name,
      size: asset.data.length,
      state: asset.state ?? "uploaded",
      browser_download_url: `${origin}${DOWNLOAD}${tag}/${asset.name}`,
      ...(asset.digest === false ? {} : { digest: digest(asset.data) }),
    })),
  };
}

/**
 * SHA256SUMS.txt as scripts/publish-release.mjs writes it.
 * @param {Iterable<[string, Buffer]>} files
 * @returns {string} one "<hex>  <name>" line per file, by name
 */
export function sha256sums(files) {
  return [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, data]) => `${digest(data).slice(7)}  ${name}\n`)
    .join("");
}

/**
 * Serves GET /api/releases (with any query) as the list and
 * GET /releases/download/v<x>/<name> as files, keyed "v<x>/<name>".
 * @param {{ releases: (origin: string) => { list: object[], files: Map<string, Buffer> } }} options
 *   Read on every request, so a test can change what the server offers.
 */
export async function startReleaseServer({ releases }) {
  /** @type {{ method: string, url: string, at: number }[]} */
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      at: Date.now(),
    });
    const send = (status, type, body) => {
      response.writeHead(status, {
        "Content-Type": type,
        "Cache-Control": "no-store",
      });
      response.end(body);
    };
    const plain = "text/plain; charset=utf-8";
    if (request.method !== "GET") return send(405, plain, "Method not allowed");
    const { pathname } = new URL(request.url, "http://127.0.0.1");
    const { list, files } = releases(
      `http://127.0.0.1:${server.address().port}`,
    );
    if (pathname === "/api/releases")
      return send(200, "application/json; charset=utf-8", JSON.stringify(list));
    const file = pathname.startsWith(DOWNLOAD)
      ? files.get(pathname.slice(DOWNLOAD.length))
      : undefined;
    if (file)
      return send(
        200,
        pathname.endsWith(".txt") ? plain : "application/octet-stream",
        file,
      );
    return send(404, plain, "Not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    listUrl: `${origin}/api/releases`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
