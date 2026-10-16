import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PasswordError, passwordErrorBody } from "../electron/passwords/errors";
import {
  asciiHost,
  httpUpgradeOrigin,
  isLoopbackOrigin,
  loginOrigin,
  webOrigin,
  wwwTwin,
} from "../electron/passwords/origin";
import { memorySealer, type Sealer } from "../electron/passwords/seal";
import {
  nodeVaultFiles,
  Vault,
  VAULT_LIMITS,
  VAULT_MAGIC,
  type LoginInput,
  type VaultFiles,
} from "../electron/passwords/vault";
import type { PasswordErrorBody, PasswordErrorCode } from "../shared/types";

const directories: string[] = [];
function vaultPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "kamapathy-vault-test-"));
  directories.push(directory);
  return join(directory, "passwords", "vault.bin");
}
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const reverse = (text: string) => Buffer.from(text, "utf8").reverse();
const sealedValue = (text: string) => reverse(text).toString("base64");
// The outer JSON of a file written with the reversing sealer.
const stored = (bytes: Buffer) =>
  JSON.parse(Buffer.from(bytes.subarray(4)).reverse().toString("utf8"));
function writeVault(path: string, contents: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(VAULT_MAGIC),
      reverse(JSON.stringify(contents)),
    ]),
  );
}

// Seals by reversing bytes, so the file is unreadable as text but easy to
// build, and records every call in order.
function reversingSealer() {
  const sealer = {
    calls: [] as string[],
    failOpen: false,
    stale: false,
    checkError: undefined as Error | undefined,
    async check() {
      sealer.calls.push("check");
      if (sealer.checkError) throw sealer.checkError;
    },
    async seal(text: string) {
      sealer.calls.push("seal");
      return reverse(text);
    },
    async open(sealed: Buffer) {
      sealer.calls.push("open");
      if (sealer.failOpen) throw new Error("The keychain refused.");
      return {
        text: Buffer.from(sealed).reverse().toString("utf8"),
        stale: sealer.stale,
      };
    },
  };
  return sealer satisfies Sealer;
}

function memoryFiles() {
  const store = new Map<string, Buffer>();
  const files = {
    store,
    writes: [] as Buffer[],
    fail: false,
    async read(path: string) {
      return store.get(path);
    },
    async write(path: string, data: Buffer) {
      if (files.fail) throw new Error("No space left on device.");
      files.writes.push(data);
      store.set(path, data);
    },
    async rename(from: string, to: string) {
      const data = store.get(from);
      if (!data) throw new Error("No such file.");
      store.delete(from);
      store.set(to, data);
    },
  };
  return files satisfies VaultFiles;
}

async function failure(promise: Promise<unknown>): Promise<PasswordErrorBody> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PasswordError) return error.body();
    throw error;
  }
  throw new Error("Expected a password error.");
}
function thrown(work: () => unknown): PasswordErrorBody {
  try {
    work();
  } catch (error) {
    if (error instanceof PasswordError) return error.body();
    throw error;
  }
  throw new Error("Expected a password error.");
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const names = (logins: { username: string }[]) =>
  logins.map((login) => login.username);

describe("password vault", () => {
  it("the file holds no readable origin, username or password", async () => {
    const path = vaultPath();
    const vault = new Vault({ path, sealer: reversingSealer() });
    expect(await vault.open()).toBe("empty");
    const login = await vault.add({
      kind: "form",
      origin: "https://accounts.example.com",
      username: "alice@example.com",
      password: "correct horse battery",
      note: "Recovery code 4417",
    });
    await vault.addNeverSaved("https://never.example.org");

    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 4).toString("latin1")).toBe("KPV1");
    for (const secret of [
      "accounts.example.com",
      "alice@example.com",
      "correct horse battery",
      "Recovery code 4417",
      "never.example.org",
    ]) {
      expect(bytes.includes(secret)).toBe(false);
      expect(bytes.includes(Buffer.from(secret).toString("base64"))).toBe(
        false,
      );
    }
    // Inside the outer seal, each password and note is sealed again.
    const inner = stored(bytes);
    expect(inner).toMatchObject({
      version: 1,
      logins: [
        {
          id: login.id,
          origin: "https://accounts.example.com",
          username: "alice@example.com",
          password: sealedValue("correct horse battery"),
          note: sealedValue("Recovery code 4417"),
        },
      ],
      neverSaved: [{ origin: "https://never.example.org" }],
    });
    if (process.platform !== "win32") {
      expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(dirname(path))).toEqual(["vault.bin"]);

    expect(Object.keys(login).sort()).toEqual([
      "changedAt",
      "createdAt",
      "id",
      "kind",
      "origin",
      "username",
    ]);
    const again = new Vault({ path, sealer: reversingSealer() });
    expect(await again.open()).toBe("ready");
    expect(again.list()).toEqual([login]);
    expect(again.list()).toEqual(vault.list());
    expect(again.neverSaved()).toEqual(vault.neverSaved());
    expect(await again.reveal(login.id)).toEqual({
      password: "correct horse battery",
      note: "Recovery code 4417",
    });
  });

  it("a failed open keeps the file and Start over renames it", async () => {
    const path = vaultPath();
    const writer = new Vault({ path, sealer: reversingSealer() });
    await writer.open();
    const saved = await writer.add({
      kind: "form",
      origin: "https://example.com",
      username: "alice",
      password: "first",
    });
    const bytes = readFileSync(path);

    const sealer = reversingSealer();
    sealer.failOpen = true;
    const vault = new Vault({ path, sealer });
    expect(vault.state).toBe("opening");
    expect(await vault.open()).toBe("locked");
    expect(vault.status()).toEqual({
      state: "locked",
      count: 0,
      compromised: 0,
    });
    expect(vault.list()).toEqual([]);
    expect(
      await failure(
        vault.add({
          kind: "form",
          origin: "https://example.com",
          username: "bob",
          password: "second",
        }),
      ),
    ).toEqual({
      code: "vault_locked",
      message:
        "Saved passwords are locked. Choose Try again and allow Kamapathy's keychain access.",
    });
    expect(await failure(vault.reveal(saved.id))).toMatchObject({
      code: "vault_locked",
    });
    expect(await vault.retry()).toBe("locked");
    expect(readFileSync(path)).toEqual(bytes);
    sealer.failOpen = false;
    expect(await vault.retry()).toBe("ready");
    expect(vault.list()).toEqual([saved]);
    // Start over acts only on a locked vault.
    expect(await vault.startOver()).toBe("ready");
    expect(readFileSync(path)).toEqual(bytes);

    const refusing = reversingSealer();
    refusing.failOpen = true;
    const locked = new Vault({
      path,
      sealer: refusing,
      now: () => 1760000000000,
    });
    expect(await locked.open()).toBe("locked");
    expect(await locked.startOver()).toBe("empty");
    expect(readdirSync(dirname(path))).toEqual([
      "vault.unreadable-1760000000000.bin",
    ]);
    expect(
      readFileSync(join(dirname(path), "vault.unreadable-1760000000000.bin")),
    ).toEqual(bytes);
    expect(locked.status()).toEqual({
      state: "empty",
      count: 0,
      compromised: 0,
    });
    expect(locked.list()).toEqual([]);
    expect(await locked.retry()).toBe("empty");

    // A file that is not a vault, or a vault of another version, is locked
    // and kept as it is.
    for (const contents of [
      Buffer.from("not a vault"),
      Buffer.concat([Buffer.from(VAULT_MAGIC), reverse("{not json")]),
      Buffer.concat([
        Buffer.from(VAULT_MAGIC),
        reverse(JSON.stringify({ version: 2, logins: [], neverSaved: [] })),
      ]),
    ]) {
      writeFileSync(path, contents);
      expect(await new Vault({ path, sealer: reversingSealer() }).open()).toBe(
        "locked",
      );
      expect(readFileSync(path)).toEqual(contents);
    }
    const unreadable: VaultFiles = {
      ...nodeVaultFiles,
      read: async () => {
        throw Object.assign(new Error("Permission denied."), {
          code: "EACCES",
        });
      },
    };
    expect(
      await new Vault({
        path,
        sealer: reversingSealer(),
        files: unreadable,
      }).open(),
    ).toBe("locked");
  });

  it("limits, duplicates and failed writes change nothing", async () => {
    const path = vaultPath();
    let failWrites = false;
    const files: VaultFiles = {
      ...nodeVaultFiles,
      async write(target, data) {
        if (failWrites)
          throw Object.assign(new Error("No space left on device."), {
            code: "ENOSPC",
          });
        await nodeVaultFiles.write(target, data);
      },
    };
    const vault = new Vault({ path, sealer: reversingSealer(), files });
    const base: LoginInput = {
      kind: "form",
      origin: "https://example.com",
      username: "alice",
      password: "secret",
    };
    const first = await vault.add(base);
    const over = (length: number) => "x".repeat(length);
    // An origin of exactly `length` characters.
    const host = (length: number) => `https://${"a".repeat(length - 12)}.com`;

    await vault.add({
      kind: "form",
      origin: host(2048),
      username: over(1000),
      password: over(1000),
      note: over(1000),
    });
    await vault.add({ ...base, kind: "http", realm: over(256) });
    const refused: [LoginInput, Partial<PasswordErrorBody>][] = [
      [
        { ...base, origin: host(2049) },
        {
          field: "url",
          limit: 2048,
          message: "That web address is longer than 2048 characters.",
        },
      ],
      [
        { ...base, origin: "ftp://example.com" },
        {
          field: "url",
          message: "Use a web address that starts with http:// or https://.",
        },
      ],
      [{ ...base, origin: "example.com" }, { field: "url" }],
      [
        { ...base, kind: "http", realm: over(257) },
        { field: "realm", limit: 256 },
      ],
      [
        { ...base, username: over(1001) },
        {
          field: "username",
          limit: 1000,
          message: "That username is longer than 1000 characters.",
        },
      ],
      [
        { ...base, username: "bob", password: "" },
        { field: "password", message: "Enter a password." },
      ],
      [
        { ...base, username: "bob", password: over(1001) },
        { field: "password", limit: 1000 },
      ],
      [
        { ...base, username: "bob", note: over(1001) },
        { field: "note", limit: 1000 },
      ],
    ];
    for (const [input, fields] of refused)
      expect(await failure(vault.add(input))).toEqual({
        code: "invalid_login",
        message: expect.any(String),
        ...fields,
      });
    expect(
      await failure(vault.update(first.id, { username: over(1001) })),
    ).toMatchObject({ code: "invalid_login", field: "username", limit: 1000 });
    expect(await failure(vault.update(first.id, { password: "" }))).toEqual({
      code: "invalid_login",
      field: "password",
      message: "Enter a password.",
    });

    // Kind, origin, realm and username make a login.
    expect(await failure(vault.add({ ...base, password: "other" }))).toEqual({
      code: "login_exists",
      id: first.id,
      message: "That site and username are already saved.",
    });
    const bob = await vault.add({ ...base, username: "bob" });
    expect(
      await failure(vault.update(bob.id, { username: "alice" })),
    ).toMatchObject({ code: "login_exists", id: first.id });
    await vault.add({ ...base, kind: "http", realm: "Staff" });
    await vault.add({ ...base, origin: "https://www.example.com" });
    expect(
      await failure(
        vault.add({ ...base, kind: "http", realm: "Staff", password: "x" }),
      ),
    ).toMatchObject({ code: "login_exists" });

    // Saves made at the same time run one after another.
    const [kept, refusedTwin] = await Promise.allSettled([
      vault.add({ ...base, username: "dana" }),
      vault.add({ ...base, username: "dana", password: "other" }),
    ]);
    expect(kept.status).toBe("fulfilled");
    expect(
      refusedTwin.status === "rejected" &&
        (refusedTwin.reason as PasswordError).body(),
    ).toMatchObject({
      code: "login_exists",
      id: (kept as PromiseFulfilledResult<{ id: string }>).value.id,
    });
    await Promise.all([
      vault.add({ ...base, username: "erin" }),
      vault.add({ ...base, username: "fay" }),
      vault.addNeverSaved("https://never.example.com"),
    ]);
    const reopened = new Vault({ path, sealer: reversingSealer() });
    await reopened.open();
    expect(reopened.list()).toEqual(vault.list());
    expect(names(reopened.list())).toEqual(
      expect.arrayContaining(["dana", "erin", "fay"]),
    );
    expect(reopened.neverSaved()).toEqual(vault.neverSaved());

    // A write that fails leaves memory and the file as they were.
    await vault.addNeverSaved("https://never.example");
    const listed = vault.list();
    const never = vault.neverSaved();
    const bytes = readFileSync(path);
    const revision = vault.revision;
    failWrites = true;
    for (const attempt of [
      () => vault.add({ ...base, username: "carol" }),
      () => vault.update(first.id, { password: "changed" }),
      () => vault.update(first.id, { username: "zed", note: "n" }),
      () => vault.remove(first.id),
      () => vault.addNeverSaved("https://never.example.net"),
      () => vault.removeNeverSaved("https://never.example"),
    ])
      expect(await failure(attempt())).toEqual({
        code: "vault_write_failed",
        retryable: true,
        message: "Passwords couldn't be saved to disk. Try again.",
      });
    expect(vault.list()).toEqual(listed);
    expect(vault.neverSaved()).toEqual(never);
    expect(readFileSync(path)).toEqual(bytes);
    expect(vault.revision).toBe(revision);
    expect(await vault.reveal(first.id)).toEqual({ password: "secret" });
    failWrites = false;
    await vault.add({ ...base, username: "carol" });
    expect(vault.list()).toHaveLength(listed.length + 1);

    // The first save of an empty vault fails the same way.
    const emptyPath = vaultPath();
    failWrites = true;
    const empty = new Vault({
      path: emptyPath,
      sealer: reversingSealer(),
      files,
    });
    expect(await failure(empty.add(base))).toMatchObject({
      code: "vault_write_failed",
      retryable: true,
    });
    expect(empty.status()).toEqual({
      state: "empty",
      count: 0,
      compromised: 0,
    });
    expect(existsSync(emptyPath)).toBe(false);
    failWrites = false;

    // The 10001st login and the 1001st never-saved origin are refused.
    const fullPath = vaultPath();
    writeVault(fullPath, {
      version: 1,
      logins: Array.from({ length: VAULT_LIMITS.logins - 1 }, (_, n) => ({
        id: `login-${n}`,
        kind: "form",
        origin: "https://full.example",
        username: `user${n}`,
        password: sealedValue("pw"),
        createdAt: 1,
        changedAt: 1,
      })),
      neverSaved: Array.from(
        { length: VAULT_LIMITS.neverSaved - 1 },
        (_, n) => ({
          origin: `https://site${n}.example`,
          createdAt: 1,
        }),
      ),
    });
    const full = new Vault({ path: fullPath, sealer: reversingSealer() });
    expect(await full.open()).toBe("ready");
    await full.add({ ...base, origin: "https://full.example" });
    await full.addNeverSaved("https://one-more.example");
    expect(full.status()).toMatchObject({ count: 10000 });
    expect(
      await failure(
        full.add({ ...base, origin: "https://full.example", username: "bob" }),
      ),
    ).toEqual({
      code: "vault_full",
      limit: 10000,
      message: "Kamapathy keeps up to 10000 of these.",
    });
    expect(await failure(full.addNeverSaved("https://last.example"))).toEqual({
      code: "vault_full",
      limit: 1000,
      message: "Kamapathy keeps up to 1000 of these.",
    });
    // An origin already listed is not added twice.
    await full.addNeverSaved("https://one-more.example");
    expect(full.neverSaved()).toHaveLength(1000);
  });

  it("matches the exact origin, its www twin and http on https only", async () => {
    const vault = new Vault({
      path: vaultPath(),
      sealer: reversingSealer(),
      now: () => 10000,
    });
    const add = (
      origin: string,
      username: string,
      extra: Partial<LoginInput> = {},
    ) =>
      vault.add({ kind: "form", origin, username, password: "pw", ...extra });
    await add("https://example.com", "a", { changedAt: 100, usedAt: 500 });
    await add("https://www.example.com", "b", { changedAt: 900 });
    await add("https://example.com", "b2", { changedAt: 800 });
    await add("http://example.com", "c", { changedAt: 50, usedAt: 700 });
    await add("https://sub.example.com", "d");
    await add("https://example.com:8443", "e");
    await add("http://www.example.com", "f", { changedAt: 300 });
    await add("https://example.com", "g", { kind: "http", realm: "Staff" });
    await add("https://example.com", "g2", {
      kind: "http",
      realm: "Staff",
      usedAt: 900,
    });

    expect(names(vault.matches("https://example.com"))).toEqual([
      "c",
      "a",
      "b",
      "b2",
    ]);
    // http on https applies to the same host, not to its www twin.
    expect(names(vault.matches("https://www.example.com"))).toEqual([
      "a",
      "b",
      "b2",
      "f",
    ]);
    expect(names(vault.matches("https://example.com:8443"))).toEqual(["e"]);
    expect(names(vault.matches("http://example.com"))).toEqual(["c", "f"]);
    expect(names(vault.matches("https://sub.example.com"))).toEqual(["d"]);
    expect(vault.matches("https://other.example")).toEqual([]);
    expect(vault.matches("null")).toEqual([]);
    for (const origin of [
      "https://example.com",
      "https://www.example.com",
      "http://example.com",
    ])
      expect(
        vault.matches(origin).every((login) => login.kind === "form"),
      ).toBe(true);

    expect(names(vault.httpMatches("https://example.com", "Staff"))).toEqual([
      "g2",
      "g",
    ]);
    expect(vault.httpMatches("https://example.com", "staff")).toEqual([]);
    expect(vault.httpMatches("https://www.example.com", "Staff")).toEqual([]);
    expect(vault.find("form", "https://example.com", "a")?.usedAt).toBe(500);
    expect(vault.find("form", "https://example.com", "c")).toBeUndefined();
    expect(
      vault.find("http", "https://example.com", "g", "Staff")?.username,
    ).toBe("g");
    expect(vault.find("http", "https://example.com", "g")).toBeUndefined();

    await vault.addNeverSaved("https://www.never.example");
    expect(vault.isNeverSaved("https://never.example")).toBe(true);
    expect(vault.isNeverSaved("https://www.never.example")).toBe(true);
    expect(vault.isNeverSaved("http://never.example")).toBe(false);
    expect(vault.isNeverSaved("https://never.example:8443")).toBe(false);
  });

  it("the keychain is not touched until the first save", async () => {
    const path = vaultPath();
    const sealer = reversingSealer();
    const vault = new Vault({ path, sealer });
    expect(vault.status()).toEqual({
      state: "opening",
      count: 0,
      compromised: 0,
    });
    expect(await vault.open()).toBe("empty");
    expect(await vault.open()).toBe("empty");
    vault.list();
    vault.matches("https://example.com");
    vault.status();
    vault.neverSaved();
    vault.isNeverSaved("https://example.com");
    expect(await failure(vault.remove("missing"))).toMatchObject({
      code: "login_not_found",
    });
    expect(
      await failure(
        vault.add({
          kind: "form",
          origin: "https://example.com",
          username: "alice",
          password: "",
        }),
      ),
    ).toMatchObject({ code: "invalid_login" });
    await vault.removeNeverSaved("https://example.com");
    expect(sealer.calls).toEqual([]);
    expect(existsSync(dirname(path))).toBe(false);

    await vault.add({
      kind: "form",
      origin: "https://example.com",
      username: "alice",
      password: "secret",
    });
    // The password, then the file.
    expect(sealer.calls).toEqual(["check", "seal", "seal"]);
    expect(vault.state).toBe("ready");

    const otherPath = vaultPath();
    const refusing = reversingSealer();
    refusing.checkError = new PasswordError("vault_unavailable", {
      reason: "no_keyring",
    });
    const unavailable = new Vault({ path: otherPath, sealer: refusing });
    expect(await unavailable.open()).toBe("empty");
    expect(
      await failure(
        unavailable.add({
          kind: "form",
          origin: "https://example.com",
          username: "alice",
          password: "secret",
        }),
      ),
    ).toEqual({
      code: "vault_unavailable",
      reason: "no_keyring",
      message: "Kamapathy can't save passwords without a system keyring.",
    });
    expect(unavailable.status()).toEqual({
      state: "unavailable",
      reason: "no_keyring",
      count: 0,
      compromised: 0,
    });
    expect(
      await failure(unavailable.addNeverSaved("https://example.com")),
    ).toMatchObject({ code: "vault_unavailable", reason: "no_keyring" });
    expect(refusing.calls).toEqual(["check"]);
    expect(existsSync(dirname(otherPath))).toBe(false);

    // A saved file on a computer without a keyring is never opened.
    const stranded = new Vault({ path, sealer: refusing });
    expect(await stranded.open()).toBe("unavailable");
    expect(refusing.calls).toEqual(["check", "check"]);

    // A save before open() opens the file first.
    const early = new Vault({ path, sealer: reversingSealer() });
    await early.add({
      kind: "form",
      origin: "https://example.com",
      username: "bob",
      password: "other",
    });
    expect(names(early.list())).toEqual(["alice", "bob"]);
  });

  it("usedAt writes are batched over 10 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let time = 1_000_000;
    const files = memoryFiles();
    const vault = new Vault({
      path: "/profile/passwords/vault.bin",
      sealer: reversingSealer(),
      files,
      now: () => time,
    });
    const login = await vault.add({
      kind: "form",
      origin: "https://example.com",
      username: "alice",
      password: "secret",
    });
    files.writes.length = 0;
    const revision = vault.revision;
    vault.touch(login.id);
    vault.touch("missing");
    expect(vault.get(login.id)?.usedAt).toBe(1_000_000);
    expect(vault.revision).toBeGreaterThan(revision);
    for (const step of [3000, 3000]) {
      time += step;
      await vi.advanceTimersByTimeAsync(step);
      vault.touch(login.id);
    }
    await vi.advanceTimersByTimeAsync(3999);
    await settle();
    expect(files.writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(files.writes).toHaveLength(1);
    expect(stored(files.writes[0]).logins[0].usedAt).toBe(1_006_000);
    await vi.advanceTimersByTimeAsync(30000);
    await settle();
    expect(files.writes).toHaveLength(1);

    time += 40000;
    vault.touch(login.id);
    await vault.flush();
    expect(files.writes).toHaveLength(2);
    expect(stored(files.writes[1]).logins[0].usedAt).toBe(1_046_000);
    await vi.advanceTimersByTimeAsync(10000);
    await settle();
    await vault.flush();
    expect(files.writes).toHaveLength(2);

    // A failed usedAt write is dropped; the next write carries it.
    files.fail = true;
    time += 1000;
    vault.touch(login.id);
    await vi.advanceTimersByTimeAsync(10000);
    await settle();
    expect(vault.get(login.id)?.usedAt).toBe(1_047_000);
    files.fail = false;
    await vault.addNeverSaved("https://never.example");
    expect(stored(files.writes[2]).logins[0].usedAt).toBe(1_047_000);
  });

  it("a new password sets changedAt and clears compromised, and reveal opens one value at a time", async () => {
    let time = 5000;
    const sealer = reversingSealer();
    const vault = new Vault({ path: vaultPath(), sealer, now: () => time });
    const login = await vault.add({
      kind: "form",
      origin: "https://Example.com:443/sign-in",
      username: "alice",
      password: "one",
      note: "first",
      compromised: "leaked",
      createdAt: 100,
      changedAt: 200,
      usedAt: 300,
    });
    expect(login).toEqual({
      id: expect.any(String),
      kind: "form",
      origin: "https://example.com",
      username: "alice",
      compromised: "leaked",
      createdAt: 100,
      changedAt: 200,
      usedAt: 300,
    });
    // Times in the future or not finite become now.
    const later = await vault.add({
      kind: "form",
      origin: "https://example.com",
      username: "bob",
      password: "two",
      createdAt: time + 1,
      changedAt: Number.NaN,
      usedAt: time + 1,
    });
    expect(later).toEqual({
      id: expect.any(String),
      kind: "form",
      origin: "https://example.com",
      username: "bob",
      createdAt: 5000,
      changedAt: 5000,
    });
    expect(vault.status()).toEqual({
      state: "ready",
      count: 2,
      compromised: 1,
    });

    time = 6000;
    sealer.calls.length = 0;
    expect(await vault.reveal(login.id)).toEqual({
      password: "one",
      note: "first",
    });
    expect(sealer.calls).toEqual(["open", "open"]);
    expect(await vault.passwordEquals(login.id, "one")).toBe(true);
    expect(await vault.passwordEquals(login.id, "One")).toBe(false);

    // The same password again is not a new one.
    expect(await vault.update(login.id, { password: "one" })).toMatchObject({
      compromised: "leaked",
      changedAt: 200,
    });
    expect(
      await vault.update(login.id, {
        password: "three",
        username: "alice@example.com",
        note: null,
      }),
    ).toEqual({
      id: login.id,
      kind: "form",
      origin: "https://example.com",
      username: "alice@example.com",
      createdAt: 100,
      changedAt: 6000,
      usedAt: 300,
    });
    expect(await vault.reveal(login.id)).toEqual({ password: "three" });
    await vault.update(login.id, { note: "again" });
    expect(await vault.reveal(login.id)).toEqual({
      password: "three",
      note: "again",
    });
    await vault.update(login.id, { note: "" });
    expect(await vault.reveal(login.id)).toEqual({ password: "three" });
    expect(
      await vault.update(login.id, { origin: "http://www.example.com/x" }),
    ).toMatchObject({ origin: "http://www.example.com", changedAt: 6000 });
    expect(vault.status()).toEqual({
      state: "ready",
      count: 2,
      compromised: 0,
    });

    await vault.remove(login.id);
    expect(vault.get(login.id)).toBeUndefined();
    for (const attempt of [
      () => vault.reveal(login.id),
      () => vault.passwordEquals(login.id, "three"),
      () => vault.update(login.id, { username: "x" }),
      () => vault.remove(login.id),
    ])
      expect(await failure(attempt())).toEqual({
        code: "login_not_found",
        message: "That password is no longer saved.",
      });

    // Only http logins carry a realm.
    const basic = await vault.add({
      kind: "http",
      origin: "https://example.com",
      realm: "Staff",
      username: "carol",
      password: "four",
    });
    expect(basic.realm).toBe("Staff");
    expect(await vault.update(basic.id, { realm: "Admins" })).toMatchObject({
      realm: "Admins",
    });
    const form = await vault.add({
      kind: "form",
      origin: "https://example.com",
      realm: "ignored",
      username: "dave",
      password: "five",
    });
    expect(form).not.toHaveProperty("realm");

    await vault.addNeverSaved("https://never.example/path");
    await vault.addNeverSaved("https://never.example");
    expect(vault.neverSaved()).toEqual([
      { origin: "https://never.example", createdAt: 6000 },
    ]);
    await vault.removeNeverSaved("https://never.example");
    expect(vault.neverSaved()).toEqual([]);
    expect(
      await failure(vault.addNeverSaved("chrome-extension://abc")),
    ).toMatchObject({ code: "invalid_login", field: "url" });
  });

  it("drops stored entries with wrong types and rewrites a stale file", async () => {
    const path = vaultPath();
    const good = {
      id: "a",
      kind: "form",
      origin: "https://example.com",
      username: "alice",
      password: sealedValue("one"),
      createdAt: 1,
      changedAt: 2,
    };
    writeVault(path, {
      version: 1,
      logins: [
        good,
        { ...good, id: "b", username: 7 },
        { ...good, id: "c", kind: "card" },
        { ...good, id: "d", password: "" },
        { ...good, id: "e", createdAt: "yesterday" },
        { ...good, id: "f", compromised: "maybe" },
        { ...good, id: "a", username: "same id" },
        { ...good, id: "g" },
        {
          ...good,
          id: "h",
          kind: "http",
          realm: "Staff",
          usedAt: 3,
          note: sealedValue("n"),
        },
        null,
        "text",
      ],
      neverSaved: [
        { origin: "https://never.example", createdAt: 1 },
        { origin: 5, createdAt: 1 },
        { origin: "https://never.example", createdAt: 2 },
        "x",
      ],
    });
    const before = readFileSync(path);
    const vault = new Vault({ path, sealer: reversingSealer() });
    expect(await vault.open()).toBe("ready");
    expect(vault.list().map((login) => login.id)).toEqual(["a", "h"]);
    expect(vault.neverSaved()).toEqual([
      { origin: "https://never.example", createdAt: 1 },
    ]);
    expect(await vault.reveal("h")).toEqual({ password: "one", note: "n" });
    // Nothing is written until something changes.
    expect(readFileSync(path)).toEqual(before);

    const sealer = reversingSealer();
    sealer.stale = true;
    const stale = new Vault({ path, sealer });
    expect(await stale.open()).toBe("ready");
    expect(sealer.calls).toEqual(["check", "open", "seal"]);
    expect(
      stored(readFileSync(path)).logins.map(
        (login: { id: string }) => login.id,
      ),
    ).toEqual(["a", "h"]);
  });

  it("the memory sealer opens only its own values", async () => {
    const sealer = memorySealer();
    await sealer.check();
    const one = await sealer.seal("hunter2");
    const two = await sealer.seal("hunter2");
    expect(one).toHaveLength(12 + 16 + 7);
    expect(one.equals(two)).toBe(false);
    expect(one.includes("hunter2")).toBe(false);
    expect(await sealer.open(one)).toEqual({ text: "hunter2", stale: false });
    await expect(memorySealer().open(one)).rejects.toThrow();
    const tampered = Buffer.from(one);
    tampered[tampered.length - 1] ^= 1;
    await expect(sealer.open(tampered)).rejects.toThrow();
    await expect(sealer.open(one.subarray(0, 20))).rejects.toThrow();
  });

  it("password errors carry their class, fields and message", () => {
    const statuses: Record<PasswordErrorCode, number> = {
      invalid_login: 400,
      import_file_invalid: 400,
      vault_unavailable: 403,
      reauth_failed: 403,
      login_not_found: 404,
      vault_locked: 409,
      vault_full: 409,
      login_exists: 409,
      vault_write_failed: 500,
    };
    for (const [code, status] of Object.entries(statuses))
      expect(new PasswordError(code as PasswordErrorCode).status).toBe(status);
    const messages: [PasswordError, string][] = [
      [
        new PasswordError("import_file_invalid", { reason: "size" }),
        "That file is larger than 10 MB or has more than 10000 rows.",
      ],
      [
        new PasswordError("import_file_invalid", { reason: "text" }),
        "That file isn't UTF-8 text.",
      ],
      [
        new PasswordError("import_file_invalid", { reason: "columns" }),
        "That file has no url and password columns.",
      ],
      [
        new PasswordError("vault_unavailable", { reason: "web" }),
        "Saved passwords are available in the desktop app.",
      ],
      [
        new PasswordError("reauth_failed"),
        "Passwords stay hidden until you confirm it's you.",
      ],
      [
        new PasswordError("invalid_login", { field: "note", limit: 1000 }),
        "That note is longer than 1000 characters.",
      ],
      [new PasswordError("vault_locked", {}, "Custom."), "Custom."],
    ];
    for (const [error, message] of messages) {
      expect(error.message).toBe(message);
      expect(error.body()).toEqual({
        code: error.code,
        message,
        ...error.fields,
      });
    }
    expect(
      passwordErrorBody(new PasswordError("login_exists", { id: "x" })),
    ).toEqual({
      code: "login_exists",
      id: "x",
      message: "That site and username are already saved.",
    });
    const busy = Object.assign(new Error("An import is already running."), {
      code: "import_busy",
    });
    expect(passwordErrorBody(busy)).toEqual({
      code: "import_busy",
      message: "An import is already running.",
      retryable: true,
    });
    expect(passwordErrorBody(new Error("boom"))).toBeUndefined();
    expect(passwordErrorBody({ code: "import_busy" })).toBeUndefined();
  });

  it("reads web origins for logins and frames", () => {
    expect(loginOrigin("example.com/x")).toBe("https://example.com");
    expect(loginOrigin("  HTTP://Example.com:8080/a?b  ")).toBe(
      "http://example.com:8080",
    );
    expect(loginOrigin("localhost:3000")).toBe("https://localhost:3000");
    expect(loginOrigin("bücher.de")).toBe("https://xn--bcher-kva.de");
    for (const bad of [
      "",
      "ftp://example.com",
      "javascript:alert(1)",
      "mailto:alice@example.com",
      "https://alice:pw@example.com",
      "file:///etc/hosts",
      "exa mple.com",
    ])
      expect(thrown(() => loginOrigin(bad))).toEqual({
        code: "invalid_login",
        field: "url",
        message: "Use a web address that starts with http:// or https://.",
      });
    expect(thrown(() => loginOrigin(`${"a".repeat(2041)}.com`))).toMatchObject({
      code: "invalid_login",
      field: "url",
      limit: 2048,
    });

    expect(webOrigin("https://example.com/path?q")).toBe("https://example.com");
    expect(webOrigin("https://example.com:443")).toBe("https://example.com");
    for (const none of [
      "https://alice:pw@example.com",
      "chrome-extension://abc",
      "file:///etc/hosts",
      "null",
      "example.com",
      `https://${"a".repeat(2037)}.com`,
    ])
      expect(webOrigin(none)).toBeUndefined();

    expect(wwwTwin("https://www.example.com")).toBe("https://example.com");
    expect(wwwTwin("https://example.com")).toBe("https://www.example.com");
    expect(wwwTwin("https://example.com:8443")).toBe(
      "https://www.example.com:8443",
    );
    expect(wwwTwin("http://example.com")).toBe("http://www.example.com");
    for (const none of [
      "https://127.0.0.1",
      "https://[::1]",
      "https://localhost",
      "https://www.localhost",
      "https://intranet",
      "https://www.com",
    ])
      expect(wwwTwin(none)).toBeUndefined();

    expect(httpUpgradeOrigin("https://example.com")).toBe("http://example.com");
    expect(httpUpgradeOrigin("https://www.example.com")).toBe(
      "http://www.example.com",
    );
    expect(httpUpgradeOrigin("https://example.com:8443")).toBeUndefined();
    expect(httpUpgradeOrigin("http://example.com")).toBeUndefined();

    expect(asciiHost("https://bücher.de")).toBe("xn--bcher-kva.de");
    expect(asciiHost("https://www.example.com:8443")).toBe("www.example.com");
    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1",
      "http://127.2.3.4:8080",
      "http://[::1]:8080",
    ])
      expect(isLoopbackOrigin(origin)).toBe(true);
    for (const origin of [
      "http://example.com",
      "http://10.0.0.1",
      "http://localhost.example.com",
    ])
      expect(isLoopbackOrigin(origin)).toBe(false);
  });
});
