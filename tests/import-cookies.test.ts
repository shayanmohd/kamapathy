import {
  createCipheriv,
  createHash,
  randomBytes,
  type BinaryLike,
} from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CookieImportError,
  cookieDetails,
  decryptValue,
  defaultRun,
  deriveKey,
  keyCache,
  readChromiumCookies,
  safeStorageKeys,
  sameSiteOf,
  unixSeconds,
  type CookieRow,
} from "../electron/import-cookies";

const directories: string[] = [];
function folder(): string {
  const directory = mkdtempSync(join(tmpdir(), "kamapathy-cookies-test-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

// The same AES-128-CBC and AES-256-GCM shapes Chromium writes, so a value the
// test encrypts decrypts back through the module under test.
function encryptCbc(
  key: Buffer,
  plaintext: BinaryLike,
  prefix: string,
): Buffer {
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from(prefix), body]);
}
function encryptGcm(key: Buffer, plaintext: BinaryLike): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, body, cipher.getAuthTag()]);
}
const sha256 = (text: string) => createHash("sha256").update(text).digest();

const baseRow: CookieRow = {
  host_key: "example.com",
  name: "sid",
  value: "",
  encrypted_value: new Uint8Array(),
  path: "/app",
  expires: 0,
  is_secure: 0,
  is_httponly: 0,
  samesite: -1,
  is_persistent: 0,
};

describe("import-cookies", () => {
  it("macOS v10 CBC round-trip", () => {
    const key = deriveKey("macpass", 1003);
    const plain = decryptValue(
      encryptCbc(key, "secret-value", "v10"),
      { v10: key },
      "darwin",
    );
    expect(plain).toBe("secret-value");

    const host = "mail.example.com";
    const withPrefix = encryptCbc(
      key,
      Buffer.concat([sha256(host), Buffer.from("after-hash")]),
      "v10",
    );
    expect(decryptValue(withPrefix, { v10: key }, "darwin", host)).toBe(
      "after-hash",
    );

    const notHash = Buffer.alloc(32, 0x41);
    const kept = encryptCbc(
      key,
      Buffer.concat([notHash, Buffer.from("tail")]),
      "v10",
    );
    expect(decryptValue(kept, { v10: key }, "darwin", host)).toBe(
      "A".repeat(32) + "tail",
    );
  });

  it("Linux v11 CBC round-trip", async () => {
    const secret = "keyring-secret";
    const run = vi.fn(async (command: string) => {
      if (command === "secret-tool") return secret;
      throw new Error("unexpected command");
    });
    const keys = await safeStorageKeys("chrome", folder(), {
      platform: "linux",
      run,
    });
    expect(keys.v10).toEqual(deriveKey("peanuts", 1));
    expect(keys.v11).toEqual(deriveKey(secret, 1));

    const host = "login.example.com";
    const v11 = encryptCbc(
      keys.v11!,
      Buffer.concat([sha256(host), Buffer.from("keyring-value")]),
      "v11",
    );
    expect(decryptValue(v11, keys, "linux", host)).toBe("keyring-value");

    const v10 = encryptCbc(keys.v10!, "peanuts-value", "v10");
    expect(decryptValue(v10, keys, "linux")).toBe("peanuts-value");

    // No keyring entry: v11 is absent and the read never throws.
    const noKeyring = await safeStorageKeys("chrome", folder(), {
      platform: "linux",
      run: vi.fn(async () => {
        throw new Error("no secret");
      }),
    });
    expect(noKeyring.v10).toEqual(deriveKey("peanuts", 1));
    expect(noKeyring.v11).toBeUndefined();
  });

  it("Windows v10 GCM round-trip", () => {
    const key = randomBytes(32);
    expect(
      decryptValue(encryptGcm(key, "win-value"), { v10: key }, "win32"),
    ).toBe("win-value");

    const v20 = Buffer.concat([Buffer.from("v20"), randomBytes(40)]);
    expect(decryptValue(v20, { v10: key }, "win32")).toBeUndefined();
  });

  it("samesite and expiry mapping", () => {
    expect(sameSiteOf(2)).toBe("strict");
    expect(sameSiteOf(1)).toBe("lax");
    expect(sameSiteOf(0)).toBe("no_restriction");
    expect(sameSiteOf(-1)).toBe("unspecified");

    const open = cookieDetails({ ...baseRow, samesite: 0 }, "v");
    expect(open?.sameSite).toBe("no_restriction");
    expect(open?.secure).toBe(true);
    expect(open?.url).toBe("https://example.com/app");

    expect(unixSeconds(13_000_000_000_000_000)).toBe(
      13_000_000_000 - 11_644_473_600,
    );

    const session = cookieDetails({ ...baseRow, samesite: 1 }, "v");
    expect(session?.expirationDate).toBeUndefined();

    const future = (1_900_000_000 + 11_644_473_600) * 1_000_000;
    const persistent = cookieDetails(
      { ...baseRow, is_persistent: 1, expires: future },
      "v",
    );
    expect(persistent?.expirationDate).toBe(1_900_000_000);

    const past = (1_400_000_000 + 11_644_473_600) * 1_000_000;
    expect(
      cookieDetails({ ...baseRow, is_persistent: 1, expires: past }, "v"),
    ).toBeUndefined();

    const domain = cookieDetails({ ...baseRow, host_key: ".example.com" }, "v");
    expect(domain?.domain).toBe(".example.com");
    expect(cookieDetails(baseRow, "v")?.domain).toBeUndefined();
  });

  it("keeps each cookie's path, which Chromium does not take from the URL", () => {
    expect(cookieDetails(baseRow, "v")).toMatchObject({
      url: "http://example.com/app",
      path: "/app",
    });
    expect(cookieDetails({ ...baseRow, path: "" }, "v")).toMatchObject({
      url: "http://example.com/",
      path: "/",
    });
  });

  it("undecryptable rows are skipped and counted", async () => {
    const key = deriveKey("dbpass", 1003);
    const profileDir = folder();
    const file = join(profileDir, "Network", "Cookies");
    mkdirSync(dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(
      "CREATE TABLE cookies(host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, is_persistent INTEGER, top_frame_site_key TEXT)",
    );
    const insert = db.prepare(
      "INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      "example.com",
      "good",
      "",
      encryptCbc(key, "good-value", "v10"),
      "/",
      0,
      1,
      0,
      -1,
      0,
      "",
    );
    insert.run(
      "example.com",
      "garbage",
      "",
      Buffer.concat([Buffer.from("v10"), Buffer.alloc(5)]),
      "/",
      0,
      1,
      0,
      -1,
      0,
      "",
    );
    insert.run(
      "example.com",
      "partitioned",
      "",
      encryptCbc(key, "partitioned-value", "v10"),
      "/",
      0,
      1,
      0,
      -1,
      0,
      "https://top.example",
    );
    db.close();

    const result = await readChromiumCookies(
      profileDir,
      { v10: key },
      "darwin",
    );
    expect(result.cookies).toHaveLength(1);
    expect(result.cookies[0].name).toBe("good");
    expect(result.cookies[0].value).toBe("good-value");
    expect(result.skipped).toBe(2);
  });

  it("missing keychain key raises keychain_denied", async () => {
    const run = vi.fn(async () => {
      throw new Error("exit 128");
    });
    await expect(
      safeStorageKeys("chrome", folder(), { platform: "darwin", run }),
    ).rejects.toMatchObject({
      name: "CookieImportError",
      code: "keychain_denied",
    });
    await expect(
      safeStorageKeys("chrome", folder(), { platform: "darwin", run }),
    ).rejects.toBeInstanceOf(CookieImportError);
  });

  it("keyCache reads one key per browser and reuses it", async () => {
    const run = vi.fn(async () => "cached-pass");
    const cache = keyCache({ platform: "darwin", run });
    const first = await cache("chrome", folder());
    const second = await cache("chrome", folder());
    expect(first).toBe(second);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("defaultRun passes input on stdin and returns stdout", async () => {
    const run = defaultRun();
    const out = await run(
      process.execPath,
      [
        "-e",
        "process.stdout.write('got:' + require('fs').readFileSync(0, 'utf8'))",
      ],
      { input: "stdin-data" },
    );
    expect(out).toBe("got:stdin-data");
  });
});
