import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Compromised } from "../../shared/types";
import { chromiumTime, withDatabase } from "../import";
import { webOrigin } from "./origin";
import { VAULT_LIMITS, type ImportedLogin } from "./vault";

// Section 15's key for this browser, and its one-row decrypt. The key is
// whatever that lookup returns; only the decrypt knows what is in it.
export interface ChromiumPasswordSecrets {
  key(): Promise<unknown>;
  decrypt(value: Uint8Array, key: unknown): string | undefined;
}
export interface ChromiumPasswords {
  logins: ImportedLogin[];
  neverSaved: string[];
  unreadable: number;
  warnings: string[];
}

// The profile's own saved passwords and the signed-in account's.
const FILES = ["Login Data", "Login Data For Account"];
// Chromium's times pass 2^53 microseconds, which node:sqlite refuses as a
// number, so they are read as doubles.
const LOGIN_ROWS =
  "SELECT id, origin_url, signon_realm, username_value, password_value," +
  " scheme, blacklisted_by_user, federation_url," +
  " CAST(date_created AS REAL) AS date_created," +
  " CAST(date_last_used AS REAL) AS date_last_used," +
  " CAST(date_password_modified AS REAL) AS date_password_modified FROM logins";
const NOTE_ROWS = "SELECT parent_id, key, value FROM password_notes";
const FLAG_ROWS =
  "SELECT parent_id, insecurity_type, is_muted FROM insecure_credentials";

interface LoginRow {
  id: number;
  origin_url: string;
  signon_realm: string;
  username_value: string;
  password_value: Uint8Array;
  scheme: number;
  blacklisted_by_user: number;
  federation_url: string;
  date_created: number;
  date_last_used: number;
  date_password_modified: number;
}
interface LoginTables {
  rows: LoginRow[];
  notes: Map<number, Uint8Array>;
  flags: Map<number, Compromised>;
  failed: boolean;
}

export function unreadableWarning(count: number, browserName: string): string {
  return `${count} ${browserName} passwords couldn't be read. Export them from ${browserName} as a CSV file and import that file.`;
}

/** One key lookup per browser id for a whole import, refusals included, so sign-ins and passwords never prompt twice. */
export function memoizeKeys<K>(
  lookup: (browserId: string) => Promise<K>,
): (browserId: string) => Promise<K> {
  const asked = new Map<string, Promise<K>>();
  return (browserId) => {
    let pending = asked.get(browserId);
    if (!pending) {
      pending = lookup(browserId);
      asked.set(browserId, pending);
    }
    return pending;
  };
}

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;
const blob = (value: unknown): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array();

// The realm is what follows the origin in signon_realm.
function realmOf(signonRealm: string): string {
  const scheme = signonRealm.indexOf("://");
  const mark = scheme < 0 ? -1 : signonRealm.indexOf("/", scheme + 3);
  return mark < 0 ? "" : signonRealm.slice(mark + 1);
}

// Each table is read on its own, so one Chromium version's missing column
// costs a warning instead of the whole import.
function readTables(db: DatabaseSync): LoginTables {
  const tables: LoginTables = {
    rows: [],
    notes: new Map(),
    flags: new Map(),
    failed: false,
  };
  try {
    const rows = db.prepare(LOGIN_ROWS).all() as unknown as Record<
      string,
      unknown
    >[];
    tables.rows = rows.map((row) => ({
      id: count(row.id),
      origin_url: text(row.origin_url),
      signon_realm: text(row.signon_realm),
      username_value: text(row.username_value),
      password_value: blob(row.password_value),
      scheme: count(row.scheme),
      blacklisted_by_user: count(row.blacklisted_by_user),
      federation_url: text(row.federation_url),
      date_created: count(row.date_created),
      date_last_used: count(row.date_last_used),
      date_password_modified: count(row.date_password_modified),
    }));
  } catch {
    tables.failed = true;
    return tables;
  }
  if (!tables.rows.length) return tables;
  try {
    const notes = db.prepare(NOTE_ROWS).all() as unknown as Record<
      string,
      unknown
    >[];
    // The password's own note is the one without a name.
    for (const note of notes)
      if (!text(note.key))
        tables.notes.set(count(note.parent_id), blob(note.value));
  } catch {
    tables.failed = true;
  }
  try {
    const flags = db.prepare(FLAG_ROWS).all() as unknown as Record<
      string,
      unknown
    >[];
    for (const flag of flags) {
      if (count(flag.is_muted) !== 0) continue;
      const type = count(flag.insecurity_type);
      const value = type === 0 ? "leaked" : type === 1 ? "phished" : undefined;
      const parent = count(flag.parent_id);
      if (!value || tables.flags.get(parent) === "leaked") continue;
      tables.flags.set(parent, value);
    }
  } catch {
    tables.failed = true;
  }
  return tables;
}

/** Saved logins and never-saved origins from one profile's Login Data files; rows that do not decrypt are counted, never thrown. */
export async function readChromiumPasswords(
  profileDir: string,
  browserName: string,
  secrets: ChromiumPasswordSecrets,
  options: { withDatabase?: typeof withDatabase } = {},
): Promise<ChromiumPasswords> {
  const open = options.withDatabase ?? withDatabase;
  const found: ChromiumPasswords = {
    logins: [],
    neverSaved: [],
    unreadable: 0,
    warnings: [],
  };
  const warn = () => {
    const warning = `Could not read ${browserName} passwords.`;
    if (!found.warnings.includes(warning)) found.warnings.push(warning);
  };
  // The key is asked for the first time a value needs it, so a profile with
  // no saved password never reaches the keychain.
  let key: unknown;
  let asked = false;
  let refused = false;
  const decrypt = async (value: Uint8Array): Promise<string | undefined> => {
    if (!asked) {
      asked = true;
      try {
        key = await secrets.key();
      } catch {
        refused = true;
      }
    }
    return refused ? undefined : secrets.decrypt(value, key);
  };
  const blocked = new Set<string>();
  const byIdentity = new Map<string, ImportedLogin>();
  for (const name of FILES) {
    const file = join(profileDir, name);
    if (!existsSync(file)) continue;
    let tables: LoginTables;
    try {
      tables = await open(file, readTables);
    } catch {
      warn();
      continue;
    }
    if (tables.failed) warn();
    for (const row of tables.rows) {
      // A login belongs to its signon_realm, so an app's android:// realm
      // never becomes a web login.
      const origin = webOrigin(row.signon_realm);
      if (row.blacklisted_by_user === 1) {
        const site = origin ?? webOrigin(row.origin_url);
        if (site) blocked.add(site);
        continue;
      }
      // Federated sign-ins hold no password, and only web forms and HTTP
      // challenges have one to fill.
      if (!origin || row.federation_url || row.scheme > 2) continue;
      const kind = row.scheme === 0 ? "form" : "http";
      const realm = kind === "http" ? realmOf(row.signon_realm) : undefined;
      if (realm !== undefined && realm.length > VAULT_LIMITS.realm) continue;
      if (!row.password_value.length) continue;
      const password = await decrypt(row.password_value);
      if (password === undefined) {
        found.unreadable += 1;
        continue;
      }
      if (!password) continue;
      const noted = tables.notes.get(row.id);
      const note = noted ? await decrypt(noted) : undefined;
      const time = (value: number) =>
        value > 0 ? chromiumTime(value) : undefined;
      const createdAt = time(row.date_created);
      const changedAt = time(row.date_password_modified) ?? createdAt;
      const usedAt = time(row.date_last_used);
      const login: ImportedLogin = {
        kind,
        origin,
        ...(realm ? { realm } : {}),
        username: row.username_value,
        password,
        ...(note && note.length <= VAULT_LIMITS.note ? { note } : {}),
        ...(tables.flags.has(row.id)
          ? { compromised: tables.flags.get(row.id) }
          : {}),
        ...(createdAt === undefined ? {} : { createdAt }),
        ...(changedAt === undefined ? {} : { changedAt }),
        ...(usedAt === undefined ? {} : { usedAt }),
      };
      // The same login in both files: the newer password wins.
      const identity = JSON.stringify([
        kind,
        origin,
        realm ?? "",
        login.username,
      ]);
      const saved = byIdentity.get(identity);
      if (saved && (saved.changedAt ?? 0) >= (changedAt ?? 0)) continue;
      byIdentity.set(identity, login);
    }
  }
  found.logins = [...byIdentity.values()];
  found.neverSaved = [...blocked];
  return found;
}
