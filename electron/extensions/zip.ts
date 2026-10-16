import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

export const MAX_ZIP_ENTRIES = 20000;
export const MAX_ZIP_BYTES = 1024 ** 3;

export class ZipError extends Error {}
// Directories are not listed.
export interface ZipFile {
  path: string;
  data: Buffer;
}
export interface ZipLimits {
  entries?: number;
  bytes?: number;
}

interface Entry {
  path: string;
  key: string;
  folder: boolean;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  // Where the next central directory record starts.
  next: number;
}

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DAMAGED = "The archive is damaged.";
const ZIP64 = "ZIP64 archives aren't supported.";
const DISKS = "Archives on more than one disk aren't supported.";
const UNSAFE = "The archive has an unsafe path.";
const DUPLICATE = "The archive has duplicate paths.";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function refuse(message: string): never {
  throw new ZipError(message);
}

// Limits passed in can only lower the caps.
function cap(value: number | undefined, most: number): number {
  return value !== undefined && value < most ? value : most;
}

// The end of central directory record: 22 bytes, then a comment of at most
// 65535.
function endOf(archive: Buffer): number {
  const last = archive.length - 22;
  for (let at = last; at >= Math.max(0, last - 0xffff); at--)
    if (
      archive.readUInt32LE(at) === END &&
      at + 22 + archive.readUInt16LE(at + 20) <= archive.length
    )
      return at;
  return refuse("The archive has no end record.");
}

// Chromium also reads segments of dots and spaces that contain "..", such
// as ".. " and "...", as "..", since Windows may.
function unsafeSegment(segment: string): boolean {
  return (
    segment === "" ||
    segment === "." ||
    (/^[. \t\n\r]+$/.test(segment) && segment.includes(".."))
  );
}

function entryAt(archive: Buffer, at: number, end: number): Entry {
  if (at + 46 > end || archive.readUInt32LE(at) !== CENTRAL) refuse(DAMAGED);
  const nameEnd = at + 46 + archive.readUInt16LE(at + 28);
  const next =
    nameEnd + archive.readUInt16LE(at + 30) + archive.readUInt16LE(at + 32);
  if (next > end) refuse(DAMAGED);
  const compressed = archive.readUInt32LE(at + 20);
  const size = archive.readUInt32LE(at + 24);
  const offset = archive.readUInt32LE(at + 42);
  if ([compressed, size, offset].includes(0xffffffff)) refuse(ZIP64);
  if (archive.readUInt16LE(at + 34) !== 0) refuse(DISKS);
  if (archive.readUInt16LE(at + 8) & 1)
    refuse("Encrypted archives aren't supported.");
  const method = archive.readUInt16LE(at + 10);
  if (method !== 0 && method !== 8)
    refuse("The archive uses an unsupported compression method.");
  // Made by a Unix host, with a symbolic link's file type.
  if (
    archive.readUInt8(at + 5) === 3 &&
    ((archive.readUInt32LE(at + 38) >>> 16) & 0o170000) === 0o120000
  )
    refuse("The archive has a symbolic link.");

  let name: string;
  try {
    name = utf8.decode(archive.subarray(at + 46, nameEnd));
  } catch {
    refuse("The archive has a path that isn't UTF-8.");
  }
  if (/^\/|^[A-Za-z]:|[\\\0]/.test(name)) refuse(UNSAFE);
  // A trailing "/" only marks a directory.
  const folder = name.endsWith("/");
  const path = folder ? name.slice(0, -1) : name;
  const segments = path.split("/");
  if (segments.some(unsafeSegment)) refuse(UNSAFE);
  return {
    path,
    key: segments
      .map((segment) => segment.normalize("NFC").toLowerCase())
      .join("/"),
    folder,
    method,
    crc: archive.readUInt32LE(at + 16),
    compressed,
    size,
    offset,
    next,
  };
}

function dataOf(archive: Buffer, entry: Entry, directory: number): Buffer {
  const at = entry.offset;
  if (at + 30 > directory || archive.readUInt32LE(at) !== LOCAL)
    refuse(DAMAGED);
  const start =
    at + 30 + archive.readUInt16LE(at + 26) + archive.readUInt16LE(at + 28);
  if (start + entry.compressed > directory) refuse(DAMAGED);
  const stored = archive.subarray(start, start + entry.compressed);
  let data = stored;
  if (entry.method === 8)
    try {
      data = inflateRawSync(stored, { maxOutputLength: entry.size + 1 });
    } catch {
      refuse("An entry in the archive doesn't inflate.");
    }
  if (data.length !== entry.size)
    refuse("An entry in the archive isn't the size it declares.");
  if (crc32(data) !== entry.crc)
    refuse("An entry in the archive fails its checksum.");
  return data;
}

// Reads a whole archive, sizes and checksums from its central directory,
// refusing anything unsafe before returning a byte.
export function readZip(archive: Buffer, limits: ZipLimits = {}): ZipFile[] {
  const maxEntries = cap(limits.entries, MAX_ZIP_ENTRIES);
  const maxBytes = cap(limits.bytes, MAX_ZIP_BYTES);
  const end = endOf(archive);
  const count = archive.readUInt16LE(end + 10);
  const size = archive.readUInt32LE(end + 12);
  const start = archive.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff)
    refuse(ZIP64);
  if (
    archive.readUInt16LE(end + 4) !== 0 ||
    archive.readUInt16LE(end + 6) !== 0 ||
    archive.readUInt16LE(end + 8) !== count
  )
    refuse(DISKS);
  if (count > maxEntries) refuse("The archive has too many entries.");
  if (start + size > end) refuse(DAMAGED);

  const entries: Entry[] = [];
  const keys = new Set<string>();
  const parents = new Set<string>();
  let total = 0;
  let at = start;
  for (let index = 0; index < count; index++) {
    const entry = entryAt(archive, at, start + size);
    at = entry.next;
    // Paths that differ only by case or Unicode normalization collide on
    // macOS.
    if (keys.has(entry.key)) refuse(DUPLICATE);
    keys.add(entry.key);
    for (
      let slash = entry.key.indexOf("/");
      slash !== -1;
      slash = entry.key.indexOf("/", slash + 1)
    )
      parents.add(entry.key.slice(0, slash));
    total += entry.size;
    if (total > maxBytes) refuse("The archive is too large.");
    entries.push(entry);
  }
  if (at !== start + size) refuse(DAMAGED);
  const files = entries.filter((entry) => !entry.folder);
  // A file where another entry needs a folder.
  if (files.some((entry) => parents.has(entry.key))) refuse(DUPLICATE);
  return files.map((entry) => ({
    path: entry.path,
    data: dataOf(archive, entry, start),
  }));
}

// Extracts into a folder that is missing or empty, and returns the number of
// files written. A refused archive writes nothing.
export async function extractZip(
  archive: Buffer,
  folder: string,
  limits?: ZipLimits,
): Promise<number> {
  const files = readZip(archive, limits);
  const root = resolve(folder);
  const targets = files.map((file) => {
    const target = join(root, ...file.path.split("/"));
    if (!target.startsWith(root + sep)) refuse(UNSAFE);
    return target;
  });
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).length)
    throw new Error("The folder to extract into isn't empty.");
  for (const [index, file] of files.entries()) {
    await mkdir(dirname(targets[index]), { recursive: true });
    await writeFile(targets[index], file.data, { flag: "wx" });
  }
  return files.length;
}
