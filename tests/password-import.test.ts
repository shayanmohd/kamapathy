import { afterEach, describe, expect, it } from "vitest";
import {
  CSV_LIMITS,
  parseCsv,
  readLoginCsv,
  writeLoginCsv,
} from "../electron/passwords/csv";
import { PasswordError } from "../electron/passwords/errors";
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
