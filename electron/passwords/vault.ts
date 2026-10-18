import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open as openFile,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Compromised,
  LoginKind,
  NeverSavedOrigin,
  PasswordImportSummary,
  SavedLoginSummary,
  VaultState,
  VaultStatus,
} from "../../shared/types";
import type { ExportRow } from "./csv";
import { PasswordError } from "./errors";
import { httpUpgradeOrigin, loginOrigin, webOrigin, wwwTwin } from "./origin";
import type { Sealer } from "./seal";

export const VAULT_LIMITS = {
  origin: 2048,
  realm: 256,
  username: 1000,
  password: 1000,
  note: 1000,
  logins: 10000,
  neverSaved: 1000,
} as const;
export const VAULT_MAGIC = "KPV1";

export interface LoginInput {
  kind: LoginKind;
  origin: string;
  realm?: string;
  username: string;
  password: string;
  note?: string;
  compromised?: Compromised;
  createdAt?: number;
  changedAt?: number;
  usedAt?: number;
}
// The rows CSV files and other browsers' saved passwords become.
export type ImportedLogin = LoginInput;
// A note of null or "" removes the note.
export interface VaultChanges {
  origin?: string;
  realm?: string;
  username?: string;
  password?: string;
  note?: string | null;
}
export interface VaultFiles {
  read(path: string): Promise<Buffer | undefined>;
  write(path: string, data: Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export const nodeVaultFiles: VaultFiles = {
  async read(path) {
    try {
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  },
  // Through <path>.tmp and a rename, so the file is either whole or as it was.
  async write(path, data) {
    const folder = dirname(path);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(folder, 0o700);
    const temporary = `${path}.tmp`;
    await rm(temporary, { force: true });
    const file = await openFile(temporary, "wx", 0o600);
    try {
      await file.writeFile(data);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  },
  rename: (from, to) => rename(from, to),
};

export interface VaultOptions {
  path: string;
  sealer: Sealer;
  files?: VaultFiles;
  now?: () => number;
  usedAtDelayMs?: number;
}

// Origins and usernames are plain in memory. Each password and note stays
// sealed (base64) until it is opened on its own.
interface StoredLogin extends SavedLoginSummary {
  password: string;
  note?: string;
}
interface VaultData {
  logins: StoredLogin[];
  neverSaved: NeverSavedOrigin[];
}
const emptyData = (): VaultData => ({ logins: [], neverSaved: [] });

const identity = (
  kind: LoginKind,
  origin: string,
  username: string,
  realm?: string,
) =>
  JSON.stringify([
    kind,
    origin,
    kind === "http" ? (realm ?? "") : "",
    username,
  ]);
const identityOf = (login: StoredLogin) =>
  identity(login.kind, login.origin, login.username, login.realm);

function summary(login: StoredLogin): SavedLoginSummary {
  return {
    id: login.id,
    kind: login.kind,
    origin: login.origin,
    ...(login.realm === undefined ? {} : { realm: login.realm }),
    username: login.username,
    ...(login.compromised ? { compromised: login.compromised } : {}),
    createdAt: login.createdAt,
    changedAt: login.changedAt,
    ...(login.usedAt === undefined ? {} : { usedAt: login.usedAt }),
  };
}
// Most recently used first, then most recently changed.
const byUse = (a: StoredLogin, b: StoredLogin) =>
  (b.usedAt ?? 0) - (a.usedAt ?? 0) || b.changedAt - a.changedAt;

const isTime = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function invalid(field: string, limit?: number): PasswordError {
  return new PasswordError(
    "invalid_login",
    limit === undefined ? { field } : { field, limit },
  );
}
function within(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string") throw invalid(field);
  if (value.length > limit) throw invalid(field, limit);
  return value;
}
function checkPassword(value: unknown): string {
  if (typeof value !== "string" || !value) throw invalid("password");
  return within(value, "password", VAULT_LIMITS.password);
}
// Logins belong to a web origin, never to a bare host.
function originOf(value: unknown): string {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value.trim()))
    throw invalid("url");
  return loginOrigin(value);
}

// A login's fields, checked against the limits but not yet sealed. A form
// login carries no realm, whatever the input held.
type CheckedLogin = LoginInput;
function checkedLogin(input: LoginInput): CheckedLogin {
  const origin = originOf(input.origin);
  const realm =
    input.kind === "http"
      ? within(input.realm ?? "", "realm", VAULT_LIMITS.realm)
      : undefined;
  const username = within(input.username, "username", VAULT_LIMITS.username);
  const password = checkPassword(input.password);
  const note = input.note
    ? within(input.note, "note", VAULT_LIMITS.note)
    : undefined;
  return { ...input, origin, realm, username, password, note };
}

// What a merge changes about a saved login; a compromised flag of null is
// that flag removed.
interface MergeEdit {
  password?: string;
  note?: string;
  compromised?: Compromised | null;
}
const flagOf = (value: unknown): Compromised | undefined =>
  value === "leaked" || value === "phished" ? value : undefined;

function storedLogin(value: unknown): StoredLogin | undefined {
  if (!isRecord(value)) return;
  const {
    id,
    kind,
    origin,
    realm,
    username,
    password,
    note,
    compromised,
    createdAt,
    changedAt,
    usedAt,
  } = value;
  if (
    typeof id !== "string" ||
    !id ||
    (kind !== "form" && kind !== "http") ||
    typeof origin !== "string" ||
    (realm !== undefined && typeof realm !== "string") ||
    typeof username !== "string" ||
    typeof password !== "string" ||
    !password ||
    (note !== undefined && typeof note !== "string") ||
    (compromised !== undefined &&
      compromised !== "leaked" &&
      compromised !== "phished") ||
    !isTime(createdAt) ||
    !isTime(changedAt) ||
    (usedAt !== undefined && !isTime(usedAt))
  )
    return;
  return {
    id,
    kind,
    origin,
    ...(kind === "http" ? { realm: realm ?? "" } : {}),
    username,
    password,
    ...(note === undefined ? {} : { note }),
    ...(compromised === undefined ? {} : { compromised }),
    createdAt,
    changedAt,
    ...(usedAt === undefined ? {} : { usedAt }),
  };
}

// Entries with wrong types, and later copies of an id or a login, are dropped.
function parseData(text: string): VaultData | undefined {
  const parsed: unknown = JSON.parse(text);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.logins) ||
    !Array.isArray(parsed.neverSaved)
  )
    return;
  const data = emptyData();
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const value of parsed.logins) {
    const login = storedLogin(value);
    if (!login || ids.has(login.id) || identities.has(identityOf(login)))
      continue;
    ids.add(login.id);
    identities.add(identityOf(login));
    data.logins.push(login);
  }
  const origins = new Set<string>();
  for (const value of parsed.neverSaved) {
    if (
      !isRecord(value) ||
      typeof value.origin !== "string" ||
      !isTime(value.createdAt) ||
      origins.has(value.origin)
    )
      continue;
    origins.add(value.origin);
    data.neverSaved.push({ origin: value.origin, createdAt: value.createdAt });
  }
  return data;
}

// One vault per profile: <userData>/passwords/vault.bin holds KPV1 and the
// sealed JSON {version: 1, logins, neverSaved}.
export class Vault {
  readonly path: string;
  private readonly sealer: Sealer;
  private readonly files: VaultFiles;
  private readonly now: () => number;
  private readonly usedAtDelayMs: number;
  private current: VaultState = "opening";
  private reason: VaultStatus["reason"];
  private version = 0;
  private data = emptyData();
  private byId = new Map<string, StoredLogin>();
  private byIdentity = new Map<string, StoredLogin>();
  private forms = new Map<string, StoredLogin[]>();
  // HTTP sign-ins by origin and realm.
  private challenges = new Map<string, StoredLogin[]>();
  private blocked = new Set<string>();
  private listeners = new Set<() => void>();
  // Opening, Try again, Start over and every write run one at a time.
  private chain: Promise<unknown> = Promise.resolve();
  private opened: Promise<unknown> | undefined;
  private checked = false;
  // usedAt changes made in memory, and how many of them are on disk.
  private touches = 0;
  private written = 0;
  private usedAtTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: VaultOptions) {
    this.path = options.path;
    this.sealer = options.sealer;
    this.files = options.files ?? nodeVaultFiles;
    this.now = options.now ?? Date.now;
    this.usedAtDelayMs = options.usedAtDelayMs ?? 10000;
  }

  get state(): VaultState {
    return this.current;
  }
  get revision(): number {
    return this.version;
  }
  status(): VaultStatus {
    return {
      state: this.current,
      ...(this.current === "unavailable" && this.reason
        ? { reason: this.reason }
        : {}),
      count: this.data.logins.length,
      compromised: this.data.logins.filter((login) => login.compromised).length,
    };
  }
  on(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Without a file the vault is empty and the keychain is not asked.
  async open(): Promise<VaultState> {
    await (this.opened ??= this.queue(() => this.load()));
    return this.current;
  }
  async retry(): Promise<VaultState> {
    await this.open();
    return this.queue(async () => {
      if (this.current === "locked") await this.load();
      return this.current;
    });
  }
  async startOver(): Promise<VaultState> {
    await this.open();
    return this.queue(async () => {
      if (this.current !== "locked") return this.current;
      const kept = join(
        dirname(this.path),
        `vault.unreadable-${this.now()}.bin`,
      );
      try {
        await this.files.rename(this.path, kept);
      } catch {
        throw new PasswordError("vault_write_failed", { retryable: true });
      }
      this.settle("empty");
      return this.current;
    });
  }

  list(): SavedLoginSummary[] {
    return this.data.logins.map(summary);
  }
  get(id: string): SavedLoginSummary | undefined {
    const login = this.byId.get(id);
    return login && summary(login);
  }
  find(
    kind: LoginKind,
    origin: string,
    username: string,
    realm?: string,
  ): SavedLoginSummary | undefined {
    const login = this.byIdentity.get(
      identity(kind, webOrigin(origin) ?? origin, username, realm),
    );
    return login && summary(login);
  }
  // Form logins for the frame's origin, its www twin and, on https at the
  // default port, http on the same host.
  matches(frameOrigin: string): SavedLoginSummary[] {
    const origin = webOrigin(frameOrigin);
    if (!origin) return [];
    const origins = new Set([
      origin,
      wwwTwin(origin),
      httpUpgradeOrigin(origin),
    ]);
    return [...origins]
      .flatMap((key) => (key && this.forms.get(key)) || [])
      .sort(byUse)
      .map(summary);
  }
  httpMatches(origin: string, realm: string): SavedLoginSummary[] {
    const key = webOrigin(origin);
    if (!key) return [];
    return [...(this.challenges.get(`${key}\n${realm}`) ?? [])]
      .sort(byUse)
      .map(summary);
  }
  isNeverSaved(origin: string): boolean {
    const value = webOrigin(origin);
    if (!value) return false;
    const twin = wwwTwin(value);
    return (
      this.blocked.has(value) || (twin !== undefined && this.blocked.has(twin))
    );
  }
  neverSaved(): NeverSavedOrigin[] {
    return this.data.neverSaved.map((entry) => ({ ...entry }));
  }

  async reveal(id: string): Promise<{ password: string; note?: string }> {
    const login = await this.stored(id);
    const password = await this.openValue(login.password);
    if (login.note === undefined) return { password };
    return { password, note: await this.openValue(login.note) };
  }
  async passwordEquals(id: string, password: string): Promise<boolean> {
    const login = await this.stored(id);
    return (await this.openValue(login.password)) === password;
  }
  // Every saved login as plain rows, opened one at a time.
  async exportRows(): Promise<ExportRow[]> {
    await this.open();
    this.usable();
    const rows: ExportRow[] = [];
    for (const login of this.data.logins)
      rows.push({
        origin: login.origin,
        username: login.username,
        password: await this.openValue(login.password),
        ...(login.note === undefined
          ? {}
          : { note: await this.openValue(login.note) }),
      });
    return rows;
  }

  add(input: LoginInput): Promise<SavedLoginSummary> {
    return this.change(async () => {
      const now = this.now();
      const checked = checkedLogin(input);
      const existing = this.byIdentity.get(
        identity(checked.kind, checked.origin, checked.username, checked.realm),
      );
      if (existing)
        throw new PasswordError("login_exists", { id: existing.id });
      if (this.data.logins.length >= VAULT_LIMITS.logins)
        throw new PasswordError("vault_full", { limit: VAULT_LIMITS.logins });
      await this.unlock();
      const login = await this.sealedLogin(checked, now);
      return {
        data: { ...this.data, logins: [...this.data.logins, login] },
        result: summary(login),
      };
    });
  }
  // A new password sets changedAt and clears compromised.
  update(id: string, changes: VaultChanges): Promise<SavedLoginSummary> {
    return this.change(async () => {
      const login = this.byId.get(id);
      if (!login) throw new PasswordError("login_not_found");
      const origin =
        changes.origin === undefined ? login.origin : originOf(changes.origin);
      const realm =
        login.kind === "http"
          ? within(
              changes.realm ?? login.realm ?? "",
              "realm",
              VAULT_LIMITS.realm,
            )
          : undefined;
      const username =
        changes.username === undefined
          ? login.username
          : within(changes.username, "username", VAULT_LIMITS.username);
      const password =
        changes.password === undefined
          ? undefined
          : checkPassword(changes.password);
      const note = changes.note
        ? within(changes.note, "note", VAULT_LIMITS.note)
        : changes.note;
      const existing = this.byIdentity.get(
        identity(login.kind, origin, username, realm),
      );
      if (existing && existing.id !== id)
        throw new PasswordError("login_exists", { id: existing.id });
      const next: StoredLogin = { ...login, origin, username };
      if (realm !== undefined) next.realm = realm;
      if (
        password !== undefined &&
        password !== (await this.openValue(login.password))
      ) {
        next.password = await this.sealValue(password);
        next.changedAt = this.now();
        delete next.compromised;
      }
      if (note) next.note = await this.sealValue(note);
      else if (note !== undefined) delete next.note;
      return {
        data: {
          ...this.data,
          logins: this.data.logins.map((entry) =>
            entry.id === id ? next : entry,
          ),
        },
        result: summary(next),
      };
    });
  }
  remove(id: string): Promise<void> {
    return this.change(async () => {
      if (!this.byId.has(id)) throw new PasswordError("login_not_found");
      return {
        data: {
          ...this.data,
          logins: this.data.logins.filter((login) => login.id !== id),
        },
        result: undefined,
      };
    });
  }
  // One import, written once. Rows go in order, the first row of an identity
  // wins, and nothing changes when a limit would be passed.
  merge(
    rows: ImportedLogin[],
    neverSaved: string[],
    options: { replace: boolean; skipped?: number; warnings?: string[] },
  ): Promise<PasswordImportSummary> {
    return this.change(async () => {
      const now = this.now();
      const result: PasswordImportSummary = {
        added: 0,
        unchanged: 0,
        kept: 0,
        replaced: 0,
        skipped: options.skipped ?? 0,
        neverSaved: 0,
        warnings: [...(options.warnings ?? [])],
      };
      const seen = new Set<string>();
      const added: CheckedLogin[] = [];
      const edits = new Map<string, MergeEdit>();
      for (const row of rows) {
        let checked: CheckedLogin;
        try {
          checked = checkedLogin(row);
        } catch {
          result.skipped += 1;
          continue;
        }
        const key = identity(
          checked.kind,
          checked.origin,
          checked.username,
          checked.realm,
        );
        if (seen.has(key)) continue;
        seen.add(key);
        const existing = this.byIdentity.get(key);
        if (!existing) {
          added.push(checked);
          result.added += 1;
          continue;
        }
        // An imported flag applies only where the password is the same.
        if (await this.passwordEquals(existing.id, checked.password)) {
          result.unchanged += 1;
          const edit: MergeEdit = {};
          if (checked.note && existing.note === undefined)
            edit.note = checked.note;
          const flag = flagOf(checked.compromised);
          if (flag && flag !== existing.compromised) edit.compromised = flag;
          if (Object.keys(edit).length) edits.set(existing.id, edit);
          continue;
        }
        if (!options.replace) {
          result.kept += 1;
          continue;
        }
        result.replaced += 1;
        edits.set(existing.id, {
          password: checked.password,
          compromised: flagOf(checked.compromised) ?? null,
        });
      }
      const origins: NeverSavedOrigin[] = [];
      for (const origin of neverSaved) {
        const value = webOrigin(origin);
        if (
          !value ||
          this.blocked.has(value) ||
          origins.some((entry) => entry.origin === value)
        )
          continue;
        origins.push({ origin: value, createdAt: now });
        result.neverSaved += 1;
      }
      if (this.data.logins.length + added.length > VAULT_LIMITS.logins)
        throw new PasswordError("vault_full", { limit: VAULT_LIMITS.logins });
      if (
        this.data.neverSaved.length + origins.length >
        VAULT_LIMITS.neverSaved
      )
        throw new PasswordError("vault_full", {
          limit: VAULT_LIMITS.neverSaved,
        });
      // An import with nothing to add or change never seals anything.
      if (!added.length && !edits.size && !origins.length) return { result };
      await this.unlock();
      const logins: StoredLogin[] = [];
      for (const login of this.data.logins) {
        const edit = edits.get(login.id);
        if (!edit) {
          logins.push(login);
          continue;
        }
        const next: StoredLogin = { ...login };
        if (edit.password !== undefined) {
          next.password = await this.sealValue(edit.password);
          next.changedAt = now;
        }
        if (edit.note !== undefined)
          next.note = await this.sealValue(edit.note);
        if (edit.compromised) next.compromised = edit.compromised;
        else if (edit.compromised === null) delete next.compromised;
        logins.push(next);
      }
      for (const checked of added)
        logins.push(await this.sealedLogin(checked, now));
      return {
        data: { logins, neverSaved: [...this.data.neverSaved, ...origins] },
        result,
      };
    });
  }
  addNeverSaved(origin: string): Promise<void> {
    return this.change(async () => {
      const value = originOf(origin);
      if (this.blocked.has(value)) return { result: undefined };
      if (this.data.neverSaved.length >= VAULT_LIMITS.neverSaved)
        throw new PasswordError("vault_full", {
          limit: VAULT_LIMITS.neverSaved,
        });
      return {
        data: {
          ...this.data,
          neverSaved: [
            ...this.data.neverSaved,
            { origin: value, createdAt: this.now() },
          ],
        },
        result: undefined,
      };
    });
  }
  removeNeverSaved(origin: string): Promise<void> {
    return this.change(async () => {
      const value = this.blocked.has(origin) ? origin : webOrigin(origin);
      if (!value || !this.blocked.has(value)) return { result: undefined };
      return {
        data: {
          ...this.data,
          neverSaved: this.data.neverSaved.filter(
            (entry) => entry.origin !== value,
          ),
        },
        result: undefined,
      };
    });
  }

  // usedAt changes at once and reaches the file within usedAtDelayMs.
  touch(id: string): void {
    const login = this.byId.get(id);
    if (!login || this.current !== "ready") return;
    login.usedAt = this.now();
    this.touches += 1;
    this.changed();
    this.usedAtTimer ??= setTimeout(() => {
      this.usedAtTimer = undefined;
      void this.writeUsedAt();
    }, this.usedAtDelayMs);
  }
  async flush(): Promise<void> {
    clearTimeout(this.usedAtTimer);
    this.usedAtTimer = undefined;
    await this.writeUsedAt();
  }

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work);
    this.chain = run.catch(() => undefined);
    return run;
  }
  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
  private settle(state: VaultState, data: VaultData = emptyData()): void {
    this.current = state;
    this.data = data;
    this.byId = new Map();
    this.byIdentity = new Map();
    this.forms = new Map();
    this.challenges = new Map();
    for (const login of data.logins) {
      this.byId.set(login.id, login);
      this.byIdentity.set(identityOf(login), login);
      const [index, key] =
        login.kind === "form"
          ? [this.forms, login.origin]
          : [this.challenges, `${login.origin}\n${login.realm ?? ""}`];
      const logins = index.get(key);
      if (logins) logins.push(login);
      else index.set(key, [login]);
    }
    this.blocked = new Set(data.neverSaved.map((entry) => entry.origin));
    this.changed();
  }

  private async load(): Promise<void> {
    let bytes: Buffer | undefined;
    try {
      bytes = await this.files.read(this.path);
    } catch {
      return this.settle("locked");
    }
    if (!bytes) return this.settle("empty");
    try {
      await this.sealer.check();
    } catch (error) {
      if (!this.refused(error)) this.settle("locked");
      return;
    }
    let data: VaultData | undefined;
    let stale = false;
    try {
      if (bytes.subarray(0, 4).toString("latin1") === VAULT_MAGIC) {
        const opened = await this.sealer.open(bytes.subarray(4));
        stale = opened.stale;
        data = parseData(opened.text);
      }
    } catch {
      // The key did not open it, or it is not a vault.
    }
    if (!data) return this.settle("locked");
    this.settle("ready", data);
    if (stale) await this.write(data).catch(() => undefined);
  }
  // A computer without a keyring makes the vault unavailable for this run.
  private refused(error: unknown): boolean {
    if (!(error instanceof PasswordError) || error.code !== "vault_unavailable")
      return false;
    this.reason = error.fields.reason === "web" ? "web" : "no_keyring";
    this.settle("unavailable");
    return true;
  }
  private usable(): void {
    if (this.current === "locked") throw new PasswordError("vault_locked");
    if (this.current === "unavailable")
      throw new PasswordError("vault_unavailable", { reason: this.reason });
  }
  // The first save of an empty vault is the first time the keychain is used.
  private async unlock(): Promise<void> {
    if (this.current !== "empty" || this.checked) return;
    try {
      await this.sealer.check();
    } catch (error) {
      if (this.refused(error))
        throw new PasswordError("vault_unavailable", { reason: this.reason });
      throw new PasswordError("vault_write_failed", { retryable: true });
    }
    this.checked = true;
  }
  // Each change is checked against the data as it is, written whole, and
  // kept only once the file is written.
  // Given times are kept unless they are in the future.
  private async sealedLogin(
    checked: CheckedLogin,
    now: number,
  ): Promise<StoredLogin> {
    const time = (value: unknown) =>
      isTime(value) && value <= now ? value : undefined;
    const usedAt = time(checked.usedAt);
    return {
      id: randomUUID(),
      kind: checked.kind,
      origin: checked.origin,
      ...(checked.realm === undefined ? {} : { realm: checked.realm }),
      username: checked.username,
      password: await this.sealValue(checked.password),
      ...(checked.note ? { note: await this.sealValue(checked.note) } : {}),
      ...(checked.compromised === "leaked" || checked.compromised === "phished"
        ? { compromised: checked.compromised }
        : {}),
      createdAt: time(checked.createdAt) ?? now,
      changedAt: time(checked.changedAt) ?? now,
      ...(usedAt === undefined ? {} : { usedAt }),
    };
  }
  private async change<T>(
    work: () => Promise<{ data?: VaultData; result: T }>,
  ): Promise<T> {
    await this.open();
    return this.queue(async () => {
      this.usable();
      const carried = this.touches;
      const { data, result } = await work();
      if (!data) return result;
      await this.unlock();
      await this.write(data);
      // A login used while the file was written keeps that use.
      for (const login of data.logins) {
        const before = this.byId.get(login.id);
        if (before && (before.usedAt ?? 0) > (login.usedAt ?? 0))
          login.usedAt = before.usedAt;
      }
      this.written = carried;
      this.settle("ready", data);
      return result;
    });
  }
  private writeUsedAt(): Promise<void> {
    return this.queue(async () => {
      if (this.touches === this.written || this.current !== "ready") return;
      const carried = this.touches;
      try {
        await this.write(this.data);
        this.written = carried;
      } catch {
        // The next write carries it.
      }
    });
  }
  private async write(data: VaultData): Promise<void> {
    const text = JSON.stringify({
      version: 1,
      logins: data.logins,
      neverSaved: data.neverSaved,
    });
    const sealed = await this.sealed(text);
    try {
      await this.files.write(
        this.path,
        Buffer.concat([Buffer.from(VAULT_MAGIC, "latin1"), sealed]),
      );
    } catch {
      throw new PasswordError("vault_write_failed", { retryable: true });
    }
  }
  // A seal that fails changes nothing, like a failed write.
  private async sealed(text: string): Promise<Buffer> {
    try {
      return await this.sealer.seal(text);
    } catch (error) {
      if (error instanceof PasswordError) throw error;
      throw new PasswordError("vault_write_failed", { retryable: true });
    }
  }
  private async sealValue(text: string): Promise<string> {
    return (await this.sealed(text)).toString("base64");
  }
  private async openValue(value: string): Promise<string> {
    try {
      return (await this.sealer.open(Buffer.from(value, "base64"))).text;
    } catch (error) {
      if (error instanceof PasswordError) throw error;
      throw new PasswordError("vault_locked");
    }
  }
  private async stored(id: string): Promise<StoredLogin> {
    await this.open();
    this.usable();
    const login = this.byId.get(id);
    if (!login) throw new PasswordError("login_not_found");
    return login;
  }
}
