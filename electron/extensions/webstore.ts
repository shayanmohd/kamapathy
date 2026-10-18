import { net } from "electron";
import type { Session } from "electron";
import { STORE_UPDATE_URL } from "../../shared/extensions";

// The store session: in memory, cookie free and used by no tab.
export const STORE_PARTITION = "kamapathy-extension-store";
export const DOWNLOAD_LIMITS = {
  redirects: 5,
  timeoutMs: 120_000,
  maxBytes: 256 * 1024 ** 2,
} as const;

export interface StoreEnv {
  chromeVersion: string;
  os: "mac" | "win" | "linux";
  arch: string;
}
export function storeEnv(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  chromeVersion: string = process.versions.chrome,
): StoreEnv {
  return {
    chromeVersion,
    os: platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux",
    arch,
  };
}

// What Chrome asks the update service for an install the person started.
export function crxUrl(id: string, env: StoreEnv): string {
  return (
    `${STORE_UPDATE_URL}?response=redirect&acceptformat=crx3` +
    `&prodversion=${env.chromeVersion}&os=${env.os}&arch=${env.arch}` +
    `&x=id%3D${id}%26installsource%3Dondemand%26uc`
  );
}

export interface FetchLimits {
  timeoutMs: number;
  maxBytes: number;
  redirects: number;
}
export interface FetchResult {
  status: number;
  body: Buffer;
  url: string;
}
export type Fetcher = (
  url: string,
  limits: FetchLimits,
) => Promise<FetchResult>;

export type DownloadFailure =
  "insecure" | "redirects" | "too_large" | "timeout" | "network";
export class DownloadError extends Error {
  constructor(readonly reason: DownloadFailure) {
    super(`The download failed its ${reason} check.`);
  }
}

function isSecure(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

// Downloads through one session, following only secure redirects and keeping
// the whole exchange inside the limits. Any status is returned; only the
// transport fails.
export function sessionFetcher(
  ses: Session,
  request: typeof net.request = net.request,
): Fetcher {
  return (url, limits) =>
    new Promise<FetchResult>((resolve, reject) => {
      if (!isSecure(url)) {
        reject(new DownloadError("insecure"));
        return;
      }
      const client = request({
        url,
        session: ses,
        redirect: "manual",
        useSessionCookies: false,
        cache: "no-store",
      });
      const chunks: Buffer[] = [];
      let last = url;
      let redirects = 0;
      let read = 0;
      let settled = false;
      const timer = setTimeout(() => fail("timeout"), limits.timeoutMs);
      function settle(run: () => void): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run();
      }
      function fail(reason: DownloadFailure): void {
        settle(() => {
          reject(new DownloadError(reason));
          try {
            client.abort();
          } catch {
            /* The request may already be over. */
          }
        });
      }
      client.on("redirect", (_status, _method, redirectUrl) => {
        if (settled) return;
        if (++redirects > limits.redirects) return fail("redirects");
        if (!isSecure(redirectUrl)) return fail("insecure");
        last = redirectUrl;
        client.followRedirect();
      });
      client.on("response", (response) => {
        response.on("data", (chunk) => {
          if (settled) return;
          read += chunk.length;
          if (read > limits.maxBytes) return fail("too_large");
          chunks.push(chunk);
        });
        response.on("end", () =>
          settle(() =>
            resolve({
              status: response.statusCode,
              body: Buffer.concat(chunks),
              url: last,
            }),
          ),
        );
        response.on("error", () => fail("network"));
      });
      client.on("error", () => fail("network"));
      client.end();
    });
}
