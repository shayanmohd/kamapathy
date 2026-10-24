import { basename } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import type { ImportOutcome } from "../shared/types";
import {
  applyImported,
  decodeXml,
  entry,
  ImportError,
  unique,
  visit,
  type ImportedBookmark,
  type ImportedVisit,
  type ImportTarget,
} from "./import";

/** The largest export file the person may hand over, matching the IPC channel's limit. */
export const SAFARI_ARCHIVE_LIMIT = 16 * 1024 * 1024;

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;
const EOCD_LENGTH = 22;
// The end record plus the longest comment that can follow it.
const EOCD_SEARCH = 65557;
const ENTRY_LIMIT = 512;
const BYTE_LIMIT = 64 * 1024 * 1024;

const NOT_ZIP = "That is not a .zip file. Choose the file Safari exported.";
const NOT_EXPORT = "That is not the file Safari exported. Choose it again.";
const INVALID_REQUEST = "Something was wrong with that import. Try again.";

const notZip = () => new ImportError("invalid_archive", NOT_ZIP);
const notExport = () => new ImportError("invalid_archive", NOT_EXPORT);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

function buffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function endRecord(zip: Buffer): number {
  const last = zip.length - EOCD_LENGTH;
  const first = Math.max(0, zip.length - EOCD_SEARCH);
  for (let at = last; at >= first; at--)
    if (zip.readUInt32LE(at) === EOCD) return at;
  throw notZip();
}

/** Entries of an in-memory zip: store and deflate, at most 512 entries and 64 MiB unpacked by default. */
export function readZip(
  bytes: Uint8Array,
  limits: { entries?: number; bytes?: number } = {},
): ZipEntry[] {
  const zip = buffer(bytes);
  const start = zip.length >= 4 ? zip.readUInt32LE(0) : 0;
  if (zip.length < EOCD_LENGTH || (start !== LOCAL && start !== EOCD))
    throw notZip();
  const end = endRecord(zip);
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const offset = zip.readUInt32LE(end + 16);
  // Zip64 archives keep their real counts and offsets elsewhere; Safari's
  // export is far too small to be one.
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff)
    throw notExport();
  if (count > (limits.entries ?? ENTRY_LIMIT) || offset + size > zip.length)
    throw notExport();
  let budget = limits.bytes ?? BYTE_LIMIT;
  const entries: ZipEntry[] = [];
  let at = offset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL)
      throw notExport();
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const checksum = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const unpacked = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip
      .subarray(at + 46, at + 46 + nameLength)
      .toString(flags & 0x800 ? "utf8" : "latin1");
    at +=
      46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (
      compressed === 0xffffffff ||
      unpacked === 0xffffffff ||
      local === 0xffffffff
    )
      throw notExport();
    // Folders, entries behind a password and anything compressed another way.
    if (name.endsWith("/") || flags & 1 || (method !== 0 && method !== 8))
      continue;
    if (unpacked > budget) throw notExport();
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL)
      throw notExport();
    const from =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (from + compressed > zip.length) throw notExport();
    const body = zip.subarray(from, from + compressed);
    let data: Buffer;
    try {
      data =
        method === 0
          ? Buffer.from(body)
          : inflateRawSync(body, { maxOutputLength: budget });
    } catch {
      throw notExport();
    }
    if (crc32(data) !== checksum) throw notExport();
    budget -= data.length;
    entries.push({ name, data });
  }
  return entries;
}

const anchors =
  /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a\s*>/gi;

function decodeText(text: string): string {
  return decodeXml(text.replace(/&nbsp;/gi, " "));
}

export function parseBookmarksHtml(html: string): ImportedBookmark[] {
  const found: ImportedBookmark[] = [];
  for (const match of html.matchAll(anchors)) {
    const url = decodeText(match[1] ?? match[2] ?? "");
    // Safari wraps parts of a title in markup, which the title drops.
    const title = decodeText((match[3] ?? "").replace(/<[^>]*>/g, ""));
    const item = entry(title, url);
    if (item) found.push(item);
  }
  return found;
}

function historyItems(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const { history } = record(json);
  return Array.isArray(history) ? history : [];
}

function holdsHistory(json: unknown): boolean {
  return Array.isArray(json) || Array.isArray(record(json).history);
}

export function parseHistoryJson(json: unknown): ImportedVisit[] {
  const found: ImportedVisit[] = [];
  for (const item of historyItems(json)) {
    const { url, title, time_usec: time, visit_count: count } = record(item);
    const visited = visit(
      title,
      url,
      typeof time === "number" ? time / 1000 : NaN,
      count,
    );
    if (visited) found.push(visited);
  }
  found.sort((a, b) => b.visitedAt - a.visitedAt);
  return unique(found);
}

function json(data: Buffer): unknown {
  try {
    return JSON.parse(data.toString("utf8"));
  } catch {
    return undefined;
  }
}

/** By extension: .html and .htm are bookmarks, .json with history entries is history, and Passwords.csv is section 18's. */
export function readSafariArchive(
  bytes: Uint8Array,
  options: { bookmarks: boolean; history: boolean; passwords?: boolean },
): {
  bookmarks: ImportedBookmark[];
  history: ImportedVisit[];
  passwords?: Buffer;
  warnings: string[];
} {
  const bookmarks: ImportedBookmark[] = [];
  const history: ImportedVisit[] = [];
  let hasBookmarks = false;
  let hasHistory = false;
  let hasPasswords = false;
  let passwords: Buffer | undefined;
  for (const file of readZip(bytes)) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".html") || name.endsWith(".htm")) {
      hasBookmarks = true;
      if (options.bookmarks)
        bookmarks.push(...parseBookmarksHtml(file.data.toString("utf8")));
      continue;
    }
    // Saved passwords are read by the password manager, never parsed here.
    if (basename(name) === "passwords.csv") {
      hasPasswords = true;
      if (options.passwords) passwords ??= file.data;
      continue;
    }
    if (!name.endsWith(".json")) continue;
    const parsed = json(file.data);
    if (!holdsHistory(parsed)) continue;
    hasHistory = true;
    if (options.history) history.push(...parseHistoryJson(parsed));
  }
  // Passwords alone are an export only when the person asked for them.
  if (!hasBookmarks && !hasHistory && !(options.passwords && hasPasswords))
    throw notExport();
  const warnings: string[] = [];
  if (options.bookmarks && !hasBookmarks)
    warnings.push("That file had no bookmarks in it.");
  if (options.history && !hasHistory)
    warnings.push("That file had no history in it.");
  history.sort((a, b) => b.visitedAt - a.visitedAt);
  return {
    bookmarks: unique(bookmarks),
    history: unique(history),
    ...(passwords ? { passwords } : {}),
    warnings,
  };
}

export async function runSafariImport(
  target: ImportTarget,
  bytes: unknown,
  options: unknown,
  // Section 18's import of the archive's Passwords.csv, handed over by main.
  mergePasswords?: (
    csv: Buffer,
  ) => Promise<{ added: number; warnings: string[] }>,
): Promise<ImportOutcome> {
  const { bookmarks, history, passwords } = record(options);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < EOCD_LENGTH ||
    bytes.byteLength > SAFARI_ARCHIVE_LIMIT ||
    typeof bookmarks !== "boolean" ||
    typeof history !== "boolean" ||
    (passwords !== undefined && typeof passwords !== "boolean") ||
    (!bookmarks && !history && passwords !== true)
  )
    throw new ImportError("import_invalid_request", INVALID_REQUEST);
  const wanted = passwords === true && mergePasswords !== undefined;
  const data = readSafariArchive(bytes, {
    bookmarks,
    history,
    passwords: wanted,
  });
  const counts = await applyImported(target, data);
  const saved =
    wanted && data.passwords && mergePasswords
      ? await mergePasswords(data.passwords)
      : undefined;
  // Safari's export carries no cookies, so no sign-in ever comes from it.
  return {
    bookmarks: counts.bookmarks,
    history: counts.history,
    signIns: 0,
    spaces: [],
    warnings: [...data.warnings, ...(saved?.warnings ?? [])],
    ...(wanted ? { passwords: saved?.added ?? 0 } : {}),
  };
}
