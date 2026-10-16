import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { CookiesSetDetails } from "electron";
import { withDatabase } from "./import";

export type ChromiumBrowserId =
  "chrome" | "chromium" | "edge" | "brave" | "arc" | "vivaldi" | "opera";

export type RunCommand = (
  command: string,
  args: string[],
  options?: { input?: string; timeoutMs?: number },
) => Promise<string>;

export interface KeyEnv {
  platform: NodeJS.Platform;
  run: RunCommand;
}

export interface SafeStorageKeys {
  v10?: Buffer;
  v11?: Buffer;
}

// The keychain service and account per browser (macOS), and the libsecret
// application attribute (Linux). Verified against the installed browsers.
export const SAFE_STORAGE: Record<
  ChromiumBrowserId,
  { service: string; account: string; secretApplication: string }
> = {
  chrome: {
    service: "Chrome Safe Storage",
    account: "Chrome",
    secretApplication: "chrome",
  },
  chromium: {
    service: "Chromium Safe Storage",
    account: "Chromium",
    secretApplication: "chromium",
  },
  edge: {
    service: "Microsoft Edge Safe Storage",
    account: "Microsoft Edge",
    secretApplication: "microsoft-edge",
  },
  brave: {
    service: "Brave Safe Storage",
    account: "Brave",
    secretApplication: "brave",
  },
  arc: {
    service: "Arc Safe Storage",
    account: "Arc",
    secretApplication: "arc",
  },
  vivaldi: {
    service: "Vivaldi Safe Storage",
    account: "Vivaldi",
    secretApplication: "vivaldi",
  },
  opera: {
    service: "Opera Safe Storage",
    account: "Opera",
    secretApplication: "opera",
  },
};

const KEYCHAIN_DENIED =
  "Kamapathy could not get the sign-in key from your keychain.";

export class CookieImportError extends Error {
  constructor(
    readonly code: "keychain_denied" | "cookies_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CookieImportError";
  }
}

export function deriveKey(
  password: string | Buffer,
  iterations: number,
): Buffer {
  return pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
}

// The script reads a base64 DPAPI blob on stdin, unwraps it for the current
// user and prints the key as base64.
const DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$blob = [Console]::In.ReadToEnd()",
  "$bytes = [Convert]::FromBase64String($blob)",
  "$key = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')",
  "[Convert]::ToBase64String($key)",
].join("; ");

export async function safeStorageKeys(
  browser: ChromiumBrowserId,
  dataDir: string,
  env: KeyEnv,
): Promise<SafeStorageKeys> {
  const names = SAFE_STORAGE[browser];
  if (env.platform === "darwin") {
    let password: string;
    try {
      password = (
        await env.run(
          "security",
          [
            "find-generic-password",
            "-w",
            "-s",
            names.service,
            "-a",
            names.account,
          ],
          { timeoutMs: 120000 },
        )
      ).trim();
    } catch {
      throw new CookieImportError("keychain_denied", KEYCHAIN_DENIED);
    }
    if (!password)
      throw new CookieImportError("keychain_denied", KEYCHAIN_DENIED);
    return { v10: deriveKey(password, 1003) };
  }
  if (env.platform === "linux") {
    const keys: SafeStorageKeys = { v10: deriveKey("peanuts", 1) };
    try {
      const secret = await env.run("secret-tool", [
        "lookup",
        "application",
        names.secretApplication,
      ]);
      if (secret) keys.v11 = deriveKey(secret, 1);
    } catch {
      // No keyring entry: v11 rows are skipped later, never a thrown error.
    }
    return keys;
  }
  if (env.platform === "win32") {
    try {
      const localState = JSON.parse(
        readFileSync(join(dataDir, "Local State"), "utf8"),
      );
      const encryptedKey: unknown = localState?.os_crypt?.encrypted_key;
      if (typeof encryptedKey !== "string") throw new Error("no key");
      const raw = Buffer.from(encryptedKey, "base64");
      if (raw.subarray(0, 5).toString("latin1") !== "DPAPI")
        throw new Error("not DPAPI");
      const output = await env.run(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT],
        { input: raw.subarray(5).toString("base64"), timeoutMs: 30000 },
      );
      const key = Buffer.from(output.trim(), "base64");
      if (key.length !== 32) throw new Error("bad key length");
      return { v10: key };
    } catch {
      throw new CookieImportError("keychain_denied", KEYCHAIN_DENIED);
    }
  }
  return {};
}

export function decryptValue(
  encrypted: Uint8Array,
  keys: SafeStorageKeys,
  platform: NodeJS.Platform,
  hostKey?: string,
): string | undefined {
  try {
    const buf = Buffer.from(encrypted);
    const prefix = buf.subarray(0, 3).toString("latin1");
    if (prefix !== "v10" && prefix !== "v11") return undefined;
    let plain: Buffer;
    if (platform === "win32") {
      if (prefix !== "v10" || !keys.v10) return undefined;
      const nonce = buf.subarray(3, 15);
      const tag = buf.subarray(buf.length - 16);
      const body = buf.subarray(15, buf.length - 16);
      const decipher = createDecipheriv("aes-256-gcm", keys.v10, nonce);
      decipher.setAuthTag(tag);
      plain = Buffer.concat([decipher.update(body), decipher.final()]);
    } else {
      const key = prefix === "v10" ? keys.v10 : keys.v11;
      if (!key) return undefined;
      const decipher = createDecipheriv(
        "aes-128-cbc",
        key,
        Buffer.alloc(16, 0x20),
      );
      plain = Buffer.concat([
        decipher.update(buf.subarray(3)),
        decipher.final(),
      ]);
    }
    if (hostKey && plain.length >= 32) {
      const hash = createHash("sha256").update(hostKey).digest();
      if (plain.subarray(0, 32).equals(hash)) plain = plain.subarray(32);
    }
    return plain.toString("utf8");
  } catch {
    return undefined;
  }
}

export interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  is_persistent: number;
  top_frame_site_key?: string | null;
}

export function sameSiteOf(
  value: number,
): "strict" | "lax" | "no_restriction" | "unspecified" {
  if (value === 2) return "strict";
  if (value === 1) return "lax";
  if (value === 0) return "no_restriction";
  return "unspecified";
}

export function unixSeconds(expiresUtc: number): number {
  return expiresUtc / 1_000_000 - 11_644_473_600;
}

export function cookieDetails(
  row: CookieRow,
  value: string,
  now: number = Date.now(),
): CookiesSetDetails | undefined {
  const sameSite = sameSiteOf(row.samesite);
  const secure = row.is_secure === 1 || sameSite === "no_restriction";
  const host = row.host_key.replace(/^\./, "");
  const details: CookiesSetDetails = {
    url: `${secure ? "https" : "http"}://${host}${row.path || "/"}`,
    name: row.name,
    value,
    secure,
    httpOnly: row.is_httponly === 1,
    sameSite,
  };
  if (row.host_key.startsWith(".")) details.domain = row.host_key;
  if (row.is_persistent === 1) {
    const expirationDate = unixSeconds(row.expires);
    if (expirationDate * 1000 <= now) return undefined;
    details.expirationDate = expirationDate;
  }
  return details;
}

function queryCookies(db: DatabaseSync): CookieRow[] {
  const columns =
    "host_key, name, value, encrypted_value, path, CAST(expires_utc AS REAL) AS expires, is_secure, is_httponly";
  const variants = [
    `SELECT ${columns}, samesite, is_persistent, top_frame_site_key FROM cookies`,
    `SELECT ${columns}, samesite, is_persistent FROM cookies`,
    `SELECT ${columns}, is_persistent FROM cookies`,
  ];
  for (const sql of variants) {
    try {
      const rows = db.prepare(sql).all() as unknown as Partial<CookieRow>[];
      return rows.map((row) => ({
        host_key: String(row.host_key ?? ""),
        name: String(row.name ?? ""),
        value: typeof row.value === "string" ? row.value : "",
        encrypted_value:
          row.encrypted_value instanceof Uint8Array
            ? row.encrypted_value
            : new Uint8Array(),
        path: String(row.path ?? "/"),
        expires: Number(row.expires ?? 0),
        is_secure: Number(row.is_secure ?? 0),
        is_httponly: Number(row.is_httponly ?? 0),
        samesite: row.samesite == null ? -1 : Number(row.samesite),
        is_persistent: Number(row.is_persistent ?? 0),
        top_frame_site_key: row.top_frame_site_key ?? null,
      }));
    } catch {
      continue;
    }
  }
  return [];
}

export async function readChromiumCookies(
  profileDir: string,
  keys: SafeStorageKeys,
  platform: NodeJS.Platform,
  now?: number,
): Promise<{ cookies: CookiesSetDetails[]; skipped: number }> {
  const file = [
    join(profileDir, "Network", "Cookies"),
    join(profileDir, "Cookies"),
  ].find((candidate) => existsSync(candidate));
  if (!file) return { cookies: [], skipped: 0 };
  return withDatabase(file, (db) => {
    const cookies: CookiesSetDetails[] = [];
    let skipped = 0;
    for (const row of queryCookies(db)) {
      if (row.top_frame_site_key) {
        skipped++;
        continue;
      }
      const value =
        row.encrypted_value.length === 0 && row.value
          ? row.value
          : decryptValue(row.encrypted_value, keys, platform, row.host_key);
      if (value === undefined) {
        skipped++;
        continue;
      }
      const details = cookieDetails(row, value, now);
      if (details) cookies.push(details);
    }
    return { cookies, skipped };
  });
}

export function defaultRun(): RunCommand {
  return (command, args, options = {}) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        command,
        args,
        {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          timeout: options.timeoutMs ?? 0,
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
}

export function keyCache(
  env: KeyEnv,
): (browser: ChromiumBrowserId, dataDir: string) => Promise<SafeStorageKeys> {
  const cache = new Map<ChromiumBrowserId, Promise<SafeStorageKeys>>();
  return (browser, dataDir) => {
    let pending = cache.get(browser);
    if (!pending) {
      pending = safeStorageKeys(browser, dataDir, env);
      cache.set(browser, pending);
    }
    return pending;
  };
}
