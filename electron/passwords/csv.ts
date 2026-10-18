import { chmod, writeFile } from "node:fs/promises";
import { PasswordError } from "./errors";
import { asciiHost, webOrigin } from "./origin";
import { VAULT_LIMITS, type ImportedLogin } from "./vault";

export const CSV_LIMITS = { bytes: 10 * 1024 * 1024, rows: 10000 } as const;

// Headers other browsers and password managers write, compared lower case.
// One-time codes and every other column are ignored.
const COLUMNS = {
  url: ["url", "login_uri", "website"],
  username: ["username", "login_username", "login"],
  password: ["password", "login_password"],
  note: ["note", "notes", "extra"],
  realm: ["httprealm"],
  type: ["type"],
  createdAt: ["timecreated"],
  changedAt: ["timepasswordchanged"],
  usedAt: ["timelastused"],
} as const;

const invalidFile = (reason: "size" | "text" | "columns") =>
  new PasswordError("import_file_invalid", { reason });

// RFC 4180: quoted fields, doubled quotes, CRLF or LF, newlines inside
// quotes. A final empty line is not a row.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let index = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  while (index < text.length) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"' && !field) {
      quoted = true;
      index += 1;
      continue;
    }
    if (character === ",") {
      endField();
      index += 1;
      continue;
    }
    if (character === "\r" || character === "\n") {
      endRow();
      index += character === "\r" && text[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += character;
    index += 1;
  }
  if (field || row.length) endRow();
  return rows;
}

export interface CsvLogins {
  rows: ImportedLogin[];
  skipped: number;
}

// Bitwarden rows may hold several URIs; the first one is the login's. A bare
// host becomes https://.
function rowOrigin(value: string): string | undefined {
  const first = value.split(/[\s,]+/u).find((part) => part);
  if (!first) return;
  return webOrigin(
    /^[a-z][a-z\d+.-]*:\/\//i.test(first) ? first : `https://${first}`,
  );
}
// Firefox writes its times in milliseconds.
function msTime(value: string): number | undefined {
  const time = Number(value.trim());
  return Number.isFinite(time) && time > 0 ? Math.floor(time) : undefined;
}

export function readLoginCsv(data: Uint8Array): CsvLogins {
  if (data.byteLength > CSV_LIMITS.bytes) throw invalidFile("size");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw invalidFile("text");
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  const table = parseCsv(text);
  const names = (table[0] ?? []).map((cell) => cell.trim().toLowerCase());
  const column = (aliases: readonly string[]) =>
    names.findIndex((name) => aliases.includes(name));
  const columns = {
    url: column(COLUMNS.url),
    username: column(COLUMNS.username),
    password: column(COLUMNS.password),
    note: column(COLUMNS.note),
    realm: column(COLUMNS.realm),
    type: column(COLUMNS.type),
    createdAt: column(COLUMNS.createdAt),
    changedAt: column(COLUMNS.changedAt),
    usedAt: column(COLUMNS.usedAt),
  };
  if (columns.url < 0 || columns.password < 0) throw invalidFile("columns");
  const body = table.slice(1);
  if (body.length > CSV_LIMITS.rows) throw invalidFile("size");

  const rows: ImportedLogin[] = [];
  let skipped = 0;
  const cell = (row: string[], index: number) =>
    index < 0 ? "" : (row[index] ?? "");
  for (const row of body) {
    if (row.every((value) => !value)) continue;
    const login = loginRow(row, columns, cell);
    if (login) rows.push(login);
    else skipped += 1;
  }
  return { rows, skipped };
}

type Columns = Record<keyof typeof COLUMNS, number>;

// A row is skipped when a type column is not login, the URL is not http or
// https, the password is empty, or a field is too long.
function loginRow(
  row: string[],
  columns: Columns,
  cell: (row: string[], index: number) => string,
): ImportedLogin | undefined {
  if (
    columns.type >= 0 &&
    cell(row, columns.type).trim().toLowerCase() !== "login"
  )
    return;
  const origin = rowOrigin(cell(row, columns.url));
  const password = cell(row, columns.password);
  const username = cell(row, columns.username);
  const realm = cell(row, columns.realm).trim();
  const note = cell(row, columns.note);
  if (
    !origin ||
    !password ||
    password.length > VAULT_LIMITS.password ||
    username.length > VAULT_LIMITS.username ||
    realm.length > VAULT_LIMITS.realm ||
    note.length > VAULT_LIMITS.note
  )
    return;
  const createdAt = msTime(cell(row, columns.createdAt));
  const changedAt = msTime(cell(row, columns.changedAt));
  const usedAt = msTime(cell(row, columns.usedAt));
  return {
    kind: realm ? "http" : "form",
    origin,
    ...(realm ? { realm } : {}),
    username,
    password,
    ...(note ? { note } : {}),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(changedAt === undefined ? {} : { changedAt }),
    ...(usedAt === undefined ? {} : { usedAt }),
  };
}

export interface ExportRow {
  origin: string;
  username: string;
  password: string;
  note?: string;
}

const quote = (value: string) =>
  /[",\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
const compare = (first: string, second: string) =>
  first.toLowerCase().localeCompare(second.toLowerCase());

export function writeLoginCsv(rows: ExportRow[]): string {
  const sorted = [...rows].sort(
    (first, second) =>
      compare(asciiHost(first.origin), asciiHost(second.origin)) ||
      compare(first.username, second.username),
  );
  const lines = ["name,url,username,password,note"];
  for (const row of sorted)
    lines.push(
      [
        asciiHost(row.origin),
        `${row.origin}/`,
        row.username,
        row.password,
        row.note ?? "",
      ]
        .map(quote)
        .join(","),
    );
  return `${lines.join("\r\n")}\r\n`;
}

// The export holds passwords in plain text, so only the person can read it.
export async function writeCsvFile(path: string, text: string): Promise<void> {
  await writeFile(path, text, { mode: 0o600 });
  await chmod(path, 0o600);
}
