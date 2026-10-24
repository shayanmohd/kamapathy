import { createCipheriv } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decryptValue,
  deriveKey,
  type SafeStorageKeys,
} from "../electron/import-cookies";
import {
  CSV_LIMITS,
  parseCsv,
  readLoginCsv,
  writeLoginCsv,
} from "../electron/passwords/csv";
import { PasswordError } from "../electron/passwords/errors";
import {
  memoizeKeys,
  readChromiumPasswords,
  unreadableWarning,
} from "../electron/passwords/import-chromium";
import type { Sealer } from "../electron/passwords/seal";
import {
  Vault,
  VAULT_LIMITS,
  type ImportedLogin,
  type VaultFiles,
} from "../electron/passwords/vault";
import type { PasswordErrorBody } from "../shared/types";

const bytes = (text: string) => Buffer.from(text, "utf8");
const reverse = (text: string) => Buffer.from(text, "utf8").reverse();

function memoryFiles() {
  const store = new Map<string, Buffer>();
  const files = {
    store,
    writes: 0,
    async read(path: string) {
      return store.get(path);
    },
    async write(path: string, data: Buffer) {
      files.writes += 1;
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

// Seals by reversing bytes and counts the seals, so a merge that writes
// nothing can be told from one that does.
function countingSealer() {
  const sealer = {
    seals: 0,
    async check() {},
    async seal(text: string) {
      sealer.seals += 1;
      return reverse(text);
    },
    async open(sealed: Buffer) {
      return {
        text: Buffer.from(sealed).reverse().toString("utf8"),
        stale: false,
      };
    },
  };
  return sealer satisfies Sealer;
}

let clock = 1_700_000_000_000;
afterEach(() => {
  clock = 1_700_000_000_000;
});

function makeVault(files = memoryFiles()) {
  const sealer = countingSealer();
  const vault = new Vault({
    path: "/passwords/vault.bin",
    sealer,
    files,
    now: () => clock,
  });
  return { vault, files, sealer };
}

async function failure(promise: Promise<unknown>): Promise<PasswordErrorBody> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PasswordError) return error.body();
    throw error;
  }
  throw new Error("That call was expected to fail.");
}

const row = (extra: Partial<ImportedLogin>): ImportedLogin => ({
  kind: "form",
  origin: "https://a.example",
  username: "ada",
  password: "secret-1",
  ...extra,
});

describe("password files", () => {
  it("maps Chrome, Firefox, Safari, Bitwarden and 1Password headers", () => {
    expect(CSV_LIMITS).toEqual({ bytes: 10 * 1024 * 1024, rows: 10000 });

    const chrome = readLoginCsv(
      bytes(
        [
          "name,url,username,password,note",
          "example.com,https://example.com/signin,ada,secret-1,work account",
        ].join("\r\n"),
      ),
    );
    expect(chrome).toEqual({
      skipped: 0,
      rows: [
        {
          kind: "form",
          origin: "https://example.com",
          username: "ada",
          password: "secret-1",
          note: "work account",
        },
      ],
    });

    const firefox = readLoginCsv(
      bytes(
        [
          "url,username,password,httpRealm,formActionOrigin,guid,timeCreated,timeLastUsed,timePasswordChanged",
          "https://mail.example/login,grace,secret-2,,https://mail.example,{abc},1600000000000,1600000100000,1600000200000",
          "http://router.example,admin,secret-3,Router admin,,{def},1500000000000,,",
        ].join("\n"),
      ),
    );
    expect(firefox).toEqual({
      skipped: 0,
      rows: [
        {
          kind: "form",
          origin: "https://mail.example",
          username: "grace",
          password: "secret-2",
          createdAt: 1600000000000,
          changedAt: 1600000200000,
          usedAt: 1600000100000,
        },
        {
          kind: "http",
          origin: "http://router.example",
          realm: "Router admin",
          username: "admin",
          password: "secret-3",
          createdAt: 1500000000000,
        },
      ],
    });

    const safari = readLoginCsv(
      bytes(
        [
          "Title,URL,Username,Password,Notes,OTPAuth",
          "shop.example,https://shop.example/account,ada@example.com,secret-4,family card,otpauth://totp/shop",
        ].join("\r\n"),
      ),
    );
    expect(safari).toEqual({
      skipped: 0,
      rows: [
        {
          kind: "form",
          origin: "https://shop.example",
          username: "ada@example.com",
          password: "secret-4",
          note: "family card",
        },
      ],
    });
    expect(JSON.stringify(safari.rows)).not.toContain("otpauth");

    const bitwarden = readLoginCsv(
      bytes(
        [
          "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
          `,,login,news.example,"reader, weekly",,0,"https://news.example/login,https://m.news.example",reader,secret-5,otpauth://totp/news`,
          ",,card,My card,,,0,,,,",
          ",,login,bad.example,,,0,ftp://bad.example,anon,secret-6,",
          ",,login,empty.example,,,0,https://empty.example,ada,,",
          `,,login,long.example,,,0,https://long.example,ada,${"x".repeat(VAULT_LIMITS.password + 1)},`,
        ].join("\r\n"),
      ),
    );
    expect(bitwarden).toEqual({
      skipped: 4,
      rows: [
        {
          kind: "form",
          origin: "https://news.example",
          username: "reader",
          password: "secret-5",
          note: "reader, weekly",
        },
      ],
    });
    expect(JSON.stringify(bitwarden.rows)).not.toContain("otpauth");

    const onePassword = readLoginCsv(
      bytes(
        `Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes\r\nbank.example,bank.example,finance,"secret,""7""",otpauth://totp/bank,,,,"line one\r\nline two"\r\n`,
      ),
    );
    expect(onePassword).toEqual({
      skipped: 0,
      rows: [
        {
          kind: "form",
          origin: "https://bank.example",
          username: "finance",
          password: 'secret,"7"',
          note: "line one\r\nline two",
        },
      ],
    });
    expect(JSON.stringify(onePassword.rows)).not.toContain("otpauth");
  });

  it("keeps differing passwords unless replace is on", async () => {
    const { vault, sealer, files } = makeVault();
    const saved = await vault.add({
      kind: "form",
      origin: "https://a.example",
      username: "ada",
      password: "secret-1",
    });

    // Nothing to merge never touches the keychain.
    sealer.seals = 0;
    const writes = files.writes;
    expect(await vault.merge([], [], { replace: false })).toEqual({
      added: 0,
      unchanged: 0,
      kept: 0,
      replaced: 0,
      skipped: 0,
      neverSaved: 0,
      warnings: [],
    });
    expect(sealer.seals).toBe(0);
    expect(files.writes).toBe(writes);

    clock += 1000;
    expect(
      await vault.merge(
        [
          row({ note: "home" }),
          row({
            origin: "https://b.example",
            username: "bob",
            password: "b-1",
          }),
          row({
            origin: "https://b.example",
            username: "bob",
            password: "b-2",
          }),
          row({
            origin: "https://c.example",
            username: "cleo",
            password: "c-1",
            compromised: "leaked",
          }),
        ],
        ["https://never.example", "https://never.example"],
        { replace: false, skipped: 2, warnings: ["2 rows couldn't be read."] },
      ),
    ).toEqual({
      added: 2,
      unchanged: 1,
      kept: 0,
      replaced: 0,
      skipped: 2,
      neverSaved: 1,
      warnings: ["2 rows couldn't be read."],
    });
    // The identical login gained the missing note; the first duplicate won.
    expect(await vault.reveal(saved.id)).toEqual({
      password: "secret-1",
      note: "home",
    });
    expect(vault.get(saved.id)?.compromised).toBeUndefined();
    const bob = vault.find("form", "https://b.example", "bob")!;
    expect(await vault.reveal(bob.id)).toEqual({ password: "b-1" });
    expect(vault.find("form", "https://c.example", "cleo")?.compromised).toBe(
      "leaked",
    );
    expect(vault.neverSaved()).toEqual([
      { origin: "https://never.example", createdAt: clock },
    ]);

    // A different password stays, and the row's flag stays with the row.
    clock += 1000;
    expect(
      await vault.merge(
        [row({ password: "changed", compromised: "leaked" })],
        [],
        {
          replace: false,
        },
      ),
    ).toMatchObject({ added: 0, unchanged: 0, kept: 1, replaced: 0 });
    expect(await vault.reveal(saved.id)).toEqual({
      password: "secret-1",
      note: "home",
    });
    expect(vault.get(saved.id)?.compromised).toBeUndefined();
    expect(vault.get(saved.id)?.changedAt).toBe(saved.changedAt);

    // With replace on the new password wins and takes the row's flag.
    clock += 1000;
    expect(
      await vault.merge(
        [row({ password: "changed", compromised: "leaked" })],
        [],
        {
          replace: true,
        },
      ),
    ).toMatchObject({ added: 0, unchanged: 0, kept: 0, replaced: 1 });
    expect(await vault.reveal(saved.id)).toEqual({
      password: "changed",
      note: "home",
    });
    expect(vault.get(saved.id)?.compromised).toBe("leaked");
    expect(vault.get(saved.id)?.changedAt).toBe(clock);

    // A row without a flag clears it, and an identical row writes nothing.
    clock += 1000;
    expect(
      await vault.merge([row({ password: "changed-2" })], [], {
        replace: true,
      }),
    ).toMatchObject({ replaced: 1 });
    expect(vault.get(saved.id)?.compromised).toBeUndefined();
    sealer.seals = 0;
    const settled = files.writes;
    expect(
      await vault.merge([row({ password: "changed-2", note: "home" })], [], {
        replace: true,
      }),
    ).toMatchObject({ unchanged: 1, replaced: 0 });
    expect(sealer.seals).toBe(0);
    expect(files.writes).toBe(settled);

    // A merge that would pass the limit changes nothing.
    const full = memoryFiles();
    full.store.set(
      "/passwords/vault.bin",
      Buffer.concat([
        Buffer.from("KPV1"),
        reverse(
          JSON.stringify({
            version: 1,
            logins: Array.from(
              { length: VAULT_LIMITS.logins - 1 },
              (_item, index) => ({
                id: `id-${index}`,
                kind: "form",
                origin: `https://site${index}.example`,
                username: "ada",
                password: reverse("secret").toString("base64"),
                createdAt: 1,
                changedAt: 1,
              }),
            ),
            neverSaved: [],
          }),
        ),
      ]),
    );
    const packed = makeVault(full);
    expect(await packed.vault.open()).toBe("ready");
    const before = full.writes;
    expect(
      await failure(
        packed.vault.merge(
          [
            row({ origin: "https://one.example" }),
            row({ origin: "https://two.example" }),
          ],
          [],
          { replace: false },
        ),
      ),
    ).toEqual({
      code: "vault_full",
      limit: VAULT_LIMITS.logins,
      message: expect.any(String),
    });
    expect(packed.vault.status().count).toBe(VAULT_LIMITS.logins - 1);
    expect(full.writes).toBe(before);
  });

  it("export round-trips through import", async () => {
    const { vault } = makeVault();
    await vault.add({
      kind: "form",
      origin: "https://b.example",
      username: "bob",
      password: 'pw,with,"commas"',
      note: "line one\r\nline two",
    });
    await vault.add({
      kind: "form",
      origin: "https://a.example",
      username: "zed",
      password: "z-1",
    });
    await vault.add({
      kind: "form",
      origin: "https://a.example",
      username: "ada",
      password: "a-1",
      note: "work",
    });
    await vault.add({
      kind: "http",
      origin: "http://router.example",
      realm: "Router admin",
      username: "admin",
      password: "r-1",
    });

    const rows = await vault.exportRows();
    expect(rows).toHaveLength(4);
    const text = writeLoginCsv(rows);
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("name,url,username,password,note");
    expect(lines[1]).toBe("a.example,https://a.example/,ada,a-1,work");
    expect(lines[2]).toBe("a.example,https://a.example/,zed,z-1,");
    expect(lines[3]).toBe(
      'b.example,https://b.example/,bob,"pw,with,""commas""","line one',
    );
    expect(lines[4]).toBe('line two"');
    expect(lines[5]).toBe("router.example,http://router.example/,admin,r-1,");
    expect(lines.at(-1)).toBe("");
    expect(parseCsv(text)).toHaveLength(5);

    const restored = makeVault().vault;
    const read = readLoginCsv(bytes(text));
    expect(read.skipped).toBe(0);
    expect(
      await restored.merge(read.rows, [], { replace: false }),
    ).toMatchObject({ added: 4, skipped: 0 });
    const back = await restored.exportRows();
    expect(back).toEqual(
      expect.arrayContaining([
        {
          origin: "https://b.example",
          username: "bob",
          password: 'pw,with,"commas"',
          note: "line one\r\nline two",
        },
        {
          origin: "https://a.example",
          username: "ada",
          password: "a-1",
          note: "work",
        },
        { origin: "https://a.example", username: "zed", password: "z-1" },
      ]),
    );
    // An http login comes back as a form login at the same origin.
    const router = restored.find("form", "http://router.example", "admin");
    expect(router?.kind).toBe("form");
    expect(await restored.reveal(router!.id)).toEqual({ password: "r-1" });
  });

  it("refuses oversized, non-UTF-8 and columnless files", () => {
    const oversized = Buffer.alloc(CSV_LIMITS.bytes + 1, 0x61);
    expect(() => readLoginCsv(oversized)).toThrow(PasswordError);
    const size = (data: Uint8Array): PasswordErrorBody => {
      try {
        readLoginCsv(data);
      } catch (error) {
        return (error as PasswordError).body();
      }
      throw new Error("That file was expected to fail.");
    };
    expect(size(oversized)).toEqual({
      code: "import_file_invalid",
      reason: "size",
      message: expect.any(String),
    });

    const many = ["url,password"];
    for (let index = 0; index <= CSV_LIMITS.rows; index += 1)
      many.push(`https://site${index}.example,secret`);
    expect(size(bytes(many.join("\r\n"))).reason).toBe("size");
    expect(
      readLoginCsv(bytes(many.slice(0, CSV_LIMITS.rows + 1).join("\r\n"))).rows,
    ).toHaveLength(CSV_LIMITS.rows);

    expect(
      size(
        Buffer.concat([
          bytes("url,password\nhttps://a.example,"),
          Buffer.from([0xc3, 0x28]),
        ]),
      ).reason,
    ).toBe("text");

    expect(size(bytes("name,username\nshop,ada")).reason).toBe("columns");
    expect(size(bytes("url,username\nhttps://a.example,ada")).reason).toBe(
      "columns",
    );
    expect(size(bytes("")).reason).toBe("columns");

    // A byte order mark belongs to the file, not to the first header.
    expect(
      readLoginCsv(bytes("﻿url,password\r\nhttps://a.example,secret\r\n")),
    ).toEqual({
      skipped: 0,
      rows: [
        {
          kind: "form",
          origin: "https://a.example",
          username: "",
          password: "secret",
        },
      ],
    });
  });
});

describe("browser passwords", () => {
  const key = deriveKey("chrome-password", 1003);
  const encrypt = (value: string) => {
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    return Buffer.concat([
      Buffer.from("v10"),
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
  };
  // A value from another key, and a Windows app-bound one.
  const scrambled = Buffer.concat([Buffer.from("v10"), Buffer.alloc(16)]);
  const appBound = Buffer.concat([Buffer.from("v20"), Buffer.alloc(16)]);
  const secrets = (lookup: () => Promise<unknown>) => ({
    key: lookup,
    decrypt: (value: Uint8Array, held: unknown) =>
      decryptValue(value, held as SafeStorageKeys, "darwin"),
  });
  const chromeKeys = () => async () => ({ v10: key });
  // Chromium keeps its times in microseconds since 1601.
  const at = (millis: number) => (millis + 11644473600000) * 1000;
  const created = 1700000000000;
  const changed = 1700000500000;
  const used = 1700000900000;

  const folders: string[] = [];
  function folder(): string {
    const made = mkdtempSync(join(tmpdir(), "kamapathy-logins-"));
    folders.push(made);
    return made;
  }
  afterEach(() => {
    for (const made of folders.splice(0))
      rmSync(made, { recursive: true, force: true });
  });

  const LOGIN_COLUMNS =
    "id INTEGER PRIMARY KEY AUTOINCREMENT, origin_url TEXT, action_url TEXT," +
    " username_element TEXT, username_value TEXT, password_element TEXT," +
    " password_value BLOB, signon_realm TEXT, date_created INTEGER," +
    " blacklisted_by_user INTEGER, scheme INTEGER, federation_url TEXT," +
    " date_last_used INTEGER, date_password_modified INTEGER";
  interface LoginFixture {
    origin: string;
    realm?: string;
    username?: string;
    password?: Uint8Array;
    scheme?: number;
    blacklisted?: number;
    federation?: string;
    created?: number;
    changed?: number;
    used?: number;
    notes?: [string, Uint8Array][];
    insecure?: [number, number][];
  }
  function loginFile(
    path: string,
    rows: LoginFixture[],
    options: { tables?: boolean } = {},
  ): void {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE logins(${LOGIN_COLUMNS})`);
    if (options.tables !== false) {
      db.exec(
        "CREATE TABLE password_notes(id INTEGER PRIMARY KEY AUTOINCREMENT," +
          " parent_id INTEGER, key TEXT, value BLOB, date_created INTEGER)",
      );
      db.exec(
        "CREATE TABLE insecure_credentials(id INTEGER PRIMARY KEY" +
          " AUTOINCREMENT, parent_id INTEGER, insecurity_type INTEGER," +
          " create_time INTEGER, is_muted INTEGER)",
      );
    }
    const login = db.prepare(
      "INSERT INTO logins (origin_url, action_url, username_element," +
        " username_value, password_element, password_value, signon_realm," +
        " date_created, blacklisted_by_user, scheme, federation_url," +
        " date_last_used, date_password_modified)" +
        " VALUES (?, '', '', ?, '', ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      const { lastInsertRowid } = login.run(
        row.origin,
        row.username ?? "",
        row.password ?? new Uint8Array(),
        row.realm ?? row.origin,
        row.created ?? 0,
        row.blacklisted ?? 0,
        row.scheme ?? 0,
        row.federation ?? "",
        row.used ?? 0,
        row.changed ?? 0,
      );
      if (options.tables === false) continue;
      const parent = Number(lastInsertRowid);
      for (const [name, value] of row.notes ?? [])
        db.prepare(
          "INSERT INTO password_notes (parent_id, key, value, date_created)" +
            " VALUES (?, ?, ?, 0)",
        ).run(parent, name, value);
      for (const [type, muted] of row.insecure ?? [])
        db.prepare(
          "INSERT INTO insecure_credentials (parent_id, insecurity_type," +
            " create_time, is_muted) VALUES (?, ?, 0, ?)",
        ).run(parent, type, muted);
    }
    db.close();
  }

  it("reads both files with notes, flags, never-saved origins and realms, counting undecryptable rows", async () => {
    const dir = folder();
    loginFile(join(dir, "Login Data"), [
      {
        origin: "https://a.example/sign-in",
        realm: "https://a.example/",
        username: "ann",
        password: encrypt("secret-a"),
        created: at(created),
        changed: at(changed),
        used: at(used),
        notes: [
          ["", encrypt("the note")],
          ["label", encrypt("ignored")],
        ],
        insecure: [[0, 0]],
      },
      {
        origin: "https://b.example/",
        realm: "https://b.example/My Realm",
        username: "bob",
        password: encrypt("secret-b"),
        scheme: 1,
        created: at(created),
        insecure: [[1, 0]],
      },
      {
        origin: "http://c.example/",
        realm: "http://c.example/Other",
        username: "carl",
        password: encrypt("secret-c"),
        scheme: 2,
      },
      { origin: "https://never.example/", blacklisted: 1 },
      {
        origin: "https://android.example/",
        realm: "android://hash@com.example.app/",
        username: "ana",
        password: encrypt("secret-android"),
      },
      {
        origin: "https://fed.example/",
        username: "fay",
        password: encrypt("secret-fed"),
        federation: "https://accounts.example",
      },
      {
        origin: "https://other.example/",
        realm: "https://other.example/Realm",
        username: "oth",
        password: encrypt("secret-other"),
        scheme: 3,
      },
      { origin: "https://empty.example/", username: "eve" },
      {
        origin: "https://long.example/",
        realm: `https://long.example/${"r".repeat(300)}`,
        username: "len",
        password: encrypt("secret-long"),
        scheme: 1,
      },
      { origin: "https://gone.example/", username: "gus", password: scrambled },
      {
        origin: "https://bound.example/",
        username: "ben",
        password: appBound,
      },
      {
        origin: "https://m.example/",
        username: "mia",
        password: encrypt("secret-m"),
        insecure: [[0, 1]],
      },
      {
        origin: "https://dup.example/",
        username: "dot",
        password: encrypt("dup-old"),
        created: at(created),
        changed: at(created),
      },
    ]);
    loginFile(join(dir, "Login Data For Account"), [
      {
        origin: "https://dup.example/",
        username: "dot",
        password: encrypt("dup-new"),
        created: at(created),
        changed: at(changed),
      },
      {
        origin: "https://acc.example/",
        username: "amy",
        password: encrypt("secret-acc"),
      },
    ]);
    const lookup = vi.fn(chromeKeys());

    const found = await readChromiumPasswords(
      dir,
      "Google Chrome",
      secrets(lookup),
    );

    expect(found.logins).toEqual([
      {
        kind: "form",
        origin: "https://a.example",
        username: "ann",
        password: "secret-a",
        note: "the note",
        compromised: "leaked",
        createdAt: created,
        changedAt: changed,
        usedAt: used,
      },
      {
        kind: "http",
        origin: "https://b.example",
        realm: "My Realm",
        username: "bob",
        password: "secret-b",
        compromised: "phished",
        createdAt: created,
        changedAt: created,
      },
      {
        kind: "http",
        origin: "http://c.example",
        realm: "Other",
        username: "carl",
        password: "secret-c",
      },
      {
        kind: "form",
        origin: "https://m.example",
        username: "mia",
        password: "secret-m",
      },
      {
        kind: "form",
        origin: "https://dup.example",
        username: "dot",
        password: "dup-new",
        createdAt: created,
        changedAt: changed,
      },
      {
        kind: "form",
        origin: "https://acc.example",
        username: "amy",
        password: "secret-acc",
      },
    ]);
    expect(found.neverSaved).toEqual(["https://never.example"]);
    expect(found.unreadable).toBe(2);
    expect(found.warnings).toEqual([]);
    expect(unreadableWarning(found.unreadable, "Google Chrome")).toBe(
      "2 Google Chrome passwords couldn't be read. Export them from Google" +
        " Chrome as a CSV file and import that file.",
    );
    expect(lookup).toHaveBeenCalledTimes(1);

    // A logins table missing a column this needs is one warning, not a throw.
    const old = folder();
    const db = new DatabaseSync(join(old, "Login Data"));
    db.exec(
      "CREATE TABLE logins(origin_url TEXT, signon_realm TEXT," +
        " password_value BLOB)",
    );
    db.close();
    expect(
      await readChromiumPasswords(old, "Google Chrome", secrets(lookup)),
    ).toEqual({
      logins: [],
      neverSaved: [],
      unreadable: 0,
      warnings: ["Could not read Google Chrome passwords."],
    });

    // Notes and flags of their own: without those tables the logins still come.
    const plain = folder();
    loginFile(
      join(plain, "Login Data"),
      [
        {
          origin: "https://old.example/",
          username: "oli",
          password: encrypt("secret-o"),
        },
      ],
      { tables: false },
    );
    const without = await readChromiumPasswords(
      plain,
      "Google Chrome",
      secrets(lookup),
    );
    expect(without.logins).toEqual([
      {
        kind: "form",
        origin: "https://old.example",
        username: "oli",
        password: "secret-o",
      },
    ]);
    expect(without.warnings).toEqual([
      "Could not read Google Chrome passwords.",
    ]);
  });

  it("asks for the browser key only when a row needs decrypting", async () => {
    const lookup = vi.fn(chromeKeys());
    const nothing = folder();
    expect(
      await readChromiumPasswords(nothing, "Google Chrome", secrets(lookup)),
    ).toEqual({ logins: [], neverSaved: [], unreadable: 0, warnings: [] });
    expect(lookup).not.toHaveBeenCalled();

    const blocked = folder();
    loginFile(join(blocked, "Login Data"), [
      { origin: "https://never.example/", blacklisted: 1 },
      { origin: "https://empty.example/", username: "eve" },
    ]);
    expect(
      await readChromiumPasswords(blocked, "Google Chrome", secrets(lookup)),
    ).toEqual({
      logins: [],
      neverSaved: ["https://never.example"],
      unreadable: 0,
      warnings: [],
    });
    expect(lookup).not.toHaveBeenCalled();

    // Two profiles of one browser, through the lookup the import memoizes.
    const first = folder();
    const second = folder();
    loginFile(join(first, "Login Data"), [
      {
        origin: "https://one.example/",
        username: "one",
        password: encrypt("secret-1"),
      },
    ]);
    loginFile(join(second, "Login Data"), [
      {
        origin: "https://two.example/",
        username: "two",
        password: encrypt("secret-2"),
      },
    ]);
    const memo = memoizeKeys(lookup);
    const both = await Promise.all([
      readChromiumPasswords(
        first,
        "Google Chrome",
        secrets(() => memo("chrome")),
      ),
      readChromiumPasswords(
        second,
        "Google Chrome",
        secrets(() => memo("chrome")),
      ),
    ]);
    expect(
      both.flatMap((found) => found.logins.map((login) => login.password)),
    ).toEqual(["secret-1", "secret-2"]);
    expect(lookup).toHaveBeenCalledTimes(1);

    // A key the person refused counts every row that needed it.
    const refused = vi.fn(async () => {
      throw new Error("User canceled the operation.");
    });
    const denied = memoizeKeys(refused);
    expect(
      await readChromiumPasswords(
        first,
        "Google Chrome",
        secrets(() => denied("chrome")),
      ),
    ).toEqual({ logins: [], neverSaved: [], unreadable: 1, warnings: [] });
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it("one memoized key lookup serves sign-ins and passwords", async () => {
    const lookup = vi.fn(async (browserId: string) => ({
      v10: key,
      browserId,
    }));
    const memo = memoizeKeys(lookup);
    // The cookie step asks first; both profiles' passwords reuse that answer.
    const forCookies = await memo("chrome");
    const profiles = [folder(), folder()];
    for (const [index, dir] of profiles.entries())
      loginFile(join(dir, "Login Data"), [
        {
          origin: `https://p${index}.example/`,
          username: "pat",
          password: encrypt(`secret-${index}`),
        },
      ]);
    const found = await Promise.all(
      profiles.map((dir) =>
        readChromiumPasswords(
          dir,
          "Google Chrome",
          secrets(() => memo("chrome")),
        ),
      ),
    );

    expect(
      found.flatMap((one) => one.logins.map((login) => login.password)),
    ).toEqual(["secret-0", "secret-1"]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(await memo("chrome")).toBe(forCookies);
    expect(await memo("edge")).not.toBe(forCookies);
    expect(lookup.mock.calls.map(([browserId]) => browserId)).toEqual([
      "chrome",
      "edge",
    ]);

    // One refusal is shared, so no second prompt reaches the person.
    const refusing = vi.fn(async () => {
      throw new Error("Kamapathy could not get the sign-in key.");
    });
    const shared = memoizeKeys(refusing);
    const answers = await Promise.allSettled([
      shared("chrome"),
      shared("chrome"),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect((answers[0] as PromiseRejectedResult).reason).toBe(
      (answers[1] as PromiseRejectedResult).reason,
    );
    expect(refusing).toHaveBeenCalledTimes(1);
  });
});
