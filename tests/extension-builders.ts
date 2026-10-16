import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";

// Test helpers: keys, ids, zips and CRX3 files.

export function keyPair(kind: "rsa" | "ec" = "rsa"): {
  publicKey: Buffer;
  privateKey: KeyObject;
} {
  const { publicKey, privateKey } =
    kind === "rsa"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }),
    privateKey,
  };
}

export function hashOf(publicKey: Buffer): string {
  return createHash("sha256").update(publicKey).digest("hex");
}

// Computed here rather than with the app's idFromKey, so tests check it.
export function idOf(publicKey: Buffer): string {
  return Array.from(hashOf(publicKey).slice(0, 32), (digit) =>
    String.fromCharCode(97 + parseInt(digit, 16)),
  ).join("");
}

export function zipOf(
  entries: {
    path: string;
    data?: Buffer | string;
    method?: 0 | 8 | number;
    crc?: number;
    unixMode?: number;
    flags?: number;
  }[],
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = Buffer.from(entry.data ?? "");
    const folder = entry.path.endsWith("/");
    const method = entry.method ?? (folder ? 0 : 8);
    const stored = method === 8 ? deflateRawSync(data) : data;
    const crc = entry.crc ?? crc32(data);
    // Bit 11: the name is UTF-8.
    const flags = (entry.flags ?? 0) | 0x800;
    const mode = entry.unixMode ?? (folder ? 0o40755 : 0o100644);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    // Made by a Unix host, so the mode is in the external attributes.
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((mode << 16) | (folder ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, stored);
    centrals.push(central, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  for (; value > 0x7f; value = Math.floor(value / 128))
    bytes.push((value % 128) | 0x80);
  bytes.push(value);
  return Buffer.from(bytes);
}
// A length-delimited protobuf field.
function field(number: number, data: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(data.length), data]);
}

// A CRX3 file: every proof signs the message Chromium's verifier checks, and
// crx_id is the first proof's id unless crxId is given.
export function crxOf(
  archive: Buffer,
  proofs: { kind: "rsa" | "ec"; publicKey: Buffer; privateKey: KeyObject }[],
  options: {
    crxId?: Buffer;
    version?: number;
    magic?: string;
    headerSuffix?: Buffer;
  } = {},
): Buffer {
  const crxId =
    options.crxId ??
    Buffer.from(hashOf(proofs[0].publicKey), "hex").subarray(0, 16);
  const signedData = field(1, crxId);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(signedData.length);
  const message = Buffer.concat([
    Buffer.from("CRX3 SignedData\x00", "latin1"),
    size,
    signedData,
    archive,
  ]);
  const header = Buffer.concat([
    ...proofs.map((proof) =>
      field(
        proof.kind === "rsa" ? 2 : 3,
        Buffer.concat([
          field(1, proof.publicKey),
          field(2, sign("sha256", message, proof.privateKey)),
        ]),
      ),
    ),
    field(10000, signedData),
    options.headerSuffix ?? Buffer.alloc(0),
  ]);
  const start = Buffer.alloc(12);
  start.write(options.magic ?? "Cr24", 0, 4, "latin1");
  start.writeUInt32LE(options.version ?? 3, 4);
  start.writeUInt32LE(header.length, 8);
  return Buffer.concat([start, header, archive]);
}

export function extensionZip(
  manifest: Record<string, unknown>,
  files: Record<string, string | Buffer> = {},
): Buffer {
  return zipOf([
    { path: "manifest.json", data: JSON.stringify(manifest) },
    ...Object.entries(files).map(([path, data]) => ({ path, data })),
  ]);
}
