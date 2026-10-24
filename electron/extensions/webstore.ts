import { net } from "electron";
import type { Session } from "electron";
import {
  STORE_UPDATE_URL,
  isExtensionId,
  isVersion,
} from "../../shared/extensions";

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

// The daily update check: one request for up to 25 extensions.
export const UPDATE_LIMITS = {
  timeoutMs: 30_000,
  batch: 25,
  maxBytes: 1024 * 1024,
} as const;

// What Chrome asks the update service about the extensions it has.
export function updateCheckUrl(
  items: readonly { id: string; version: string }[],
  env: StoreEnv,
): string {
  return (
    `${STORE_UPDATE_URL}?response=updatecheck&acceptformat=crx3` +
    `&prodversion=${env.chromeVersion}&os=${env.os}&arch=${env.arch}` +
    items
      .map(({ id, version }) => `&x=id%3D${id}%26v%3D${version}%26uc`)
      .join("")
  );
}

export interface UpdateAnswer {
  id: string;
  status: "update" | "noupdate" | "error";
  version?: string;
  codebase?: string;
  hashSha256?: string;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
function decode(value: string): string {
  return value.replace(
    /&(#[Xx]?[0-9A-Fa-f]+|[A-Za-z]+);/g,
    (whole, name: string) => {
      if (!name.startsWith("#")) return ENTITIES[name.toLowerCase()] ?? whole;
      const digits = name.slice(1);
      const code = Number(
        digits.startsWith("x") || digits.startsWith("X")
          ? `0x${digits.slice(1)}`
          : digits,
      );
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    },
  );
}
function attributes(tag: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [, name, value] of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g))
    fields[name] = decode(value);
  return fields;
}
const UPDATE_CHECK = /<updatecheck\s([^<>]*?)\/?>/;
const SHA256 = /^[0-9A-Fa-f]{64}$/;

function answerFor(
  id: string,
  status: string | undefined,
  inner: string,
): UpdateAnswer {
  const found = status === "ok" ? UPDATE_CHECK.exec(inner) : null;
  if (!found) return { id, status: "error" };
  const fields = attributes(found[1]);
  if (fields.status === "noupdate") return { id, status: "noupdate" };
  const { version, codebase } = fields;
  const hash = fields.hash_sha256;
  if (
    fields.status !== "ok" ||
    !isVersion(version) ||
    !codebase ||
    !isSecure(codebase) ||
    (hash !== undefined && !SHA256.test(hash))
  )
    return { id, status: "error" };
  return {
    id,
    status: "update",
    version,
    codebase,
    // The installer compares lowercase hex.
    ...(hash ? { hashSha256: hash.toLowerCase() } : {}),
  };
}

// A small reader for the update service's answer: one entry per app element
// it knows, in the order they come.
export function parseUpdateXml(xml: string): UpdateAnswer[] {
  const answers: UpdateAnswer[] = [];
  if (!xml.includes("<gupdate")) return answers;
  const apps = [...xml.matchAll(/<app\s([^<>]*?)\/?>/g)];
  for (const [at, app] of apps.entries()) {
    const fields = attributes(app[1]);
    const id = fields.appid;
    if (!isExtensionId(id) || answers.some((answer) => answer.id === id))
      continue;
    const from = (app.index ?? 0) + app[0].length;
    answers.push(
      answerFor(id, fields.status, xml.slice(from, apps[at + 1]?.index)),
    );
  }
  return answers;
}
