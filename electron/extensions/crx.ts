import { createHash, createPublicKey, verify } from "node:crypto";
import { idFromKey } from "./manifest";

// SHA-256 of the Chrome Web Store's publisher key, copied from
// kPublisherKeyHash in Chromium's components/crx_file/crx_verifier.cc.
export const WEBSTORE_PUBLISHER_KEY_HASH =
  "61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf";
export const MAX_CRX_HEADER = 1024 * 1024;

export type CrxFailure =
  "magic" | "version" | "header" | "proof" | "id" | "publisher";
export class CrxError extends Error {
  constructor(readonly reason: CrxFailure) {
    super(`The CRX file failed its ${reason} check.`);
  }
}
export interface VerifiedCrx {
  id: string;
  // The developer key, SPKI DER.
  publicKey: Buffer;
  archive: Buffer;
}

const MAGIC = Buffer.from("Cr24", "latin1");
const SIGNED_DATA = Buffer.from("CRX3 SignedData\x00", "latin1");
// Chromium refuses headers a zip reader could take for the archive's end.
const ZIP_MARKERS = ["PK\x05\x06", "PK\x06\x06", "PK\x06\x07"].map((marker) =>
  Buffer.from(marker, "latin1"),
);

interface Proof {
  kind: "rsa" | "ec";
  publicKey: Buffer;
  signature: Buffer;
}

function fail(reason: CrxFailure): never {
  throw new CrxError(reason);
}

// A protobuf message's length-delimited fields. Varint, 64-bit and 32-bit
// fields are skipped.
function fieldsOf(message: Buffer): { number: number; data: Buffer }[] {
  const fields: { number: number; data: Buffer }[] = [];
  let at = 0;
  const varint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 70; shift += 7) {
      if (at >= message.length) fail("header");
      const byte = message[at++];
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
    }
    return fail("header");
  };
  while (at < message.length) {
    const key = varint();
    const wireType = key % 8;
    const number = Math.floor(key / 8);
    if (number < 1 || !Number.isSafeInteger(key)) fail("header");
    if (wireType === 0) varint();
    else if (wireType === 1 || wireType === 5) {
      at += wireType === 1 ? 8 : 4;
      if (at > message.length) fail("header");
    } else if (wireType === 2) {
      const length = varint();
      if (length > message.length - at) fail("header");
      fields.push({ number, data: message.subarray(at, at + length) });
      at += length;
    } else fail("header");
  }
  return fields;
}

function verifies(proof: Proof, message: Buffer): boolean {
  try {
    const key = createPublicKey({
      key: proof.publicKey,
      format: "der",
      type: "spki",
    });
    return (
      key.asymmetricKeyType === proof.kind &&
      verify("sha256", message, key, proof.signature)
    );
  } catch {
    return false;
  }
}

// Checks a CRX3 file as Chromium's verifier does, and that it is the
// extension asked for. Only tests pass publisherKeyHash.
export function verifyCrx(
  bytes: Buffer,
  expectedId: string,
  publisherKeyHash: string = WEBSTORE_PUBLISHER_KEY_HASH,
): VerifiedCrx {
  if (bytes.length < 4 || !bytes.subarray(0, 4).equals(MAGIC)) fail("magic");
  if (bytes.length < 12) fail("header");
  if (bytes.readUInt32LE(4) !== 3) fail("version");
  const size = bytes.readUInt32LE(8);
  if (size > MAX_CRX_HEADER || size > bytes.length - 12) fail("header");
  const header = bytes.subarray(12, 12 + size);
  if (ZIP_MARKERS.some((marker) => header.includes(marker))) fail("header");
  const archive = bytes.subarray(12 + size);

  // Fields 2 and 3 are the RSA and ECDSA proofs, 10000 the signed data.
  const proofs: Proof[] = [];
  let signedData: Buffer = Buffer.alloc(0);
  for (const field of fieldsOf(header)) {
    if (field.number === 2 || field.number === 3) {
      const proof: Proof = {
        kind: field.number === 2 ? "rsa" : "ec",
        publicKey: Buffer.alloc(0),
        signature: Buffer.alloc(0),
      };
      for (const part of fieldsOf(field.data))
        if (part.number === 1) proof.publicKey = part.data;
        else if (part.number === 2) proof.signature = part.data;
      proofs.push(proof);
    } else if (field.number === 10000) signedData = field.data;
  }
  let crxId: Buffer | undefined;
  for (const field of fieldsOf(signedData))
    if (field.number === 1) crxId = field.data;
  if (crxId?.length !== 16) fail("header");
  if (!proofs.length) fail("proof");

  const id = Array.from(crxId.toString("hex"), (digit) =>
    String.fromCharCode(97 + parseInt(digit, 16)),
  ).join("");
  const developer = proofs.find((proof) => idFromKey(proof.publicKey) === id);
  if (!developer || id !== expectedId) fail("id");
  if (
    !proofs.some(
      (proof) =>
        createHash("sha256").update(proof.publicKey).digest("hex") ===
        publisherKeyHash,
    )
  )
    fail("publisher");

  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedData.length);
  const message = Buffer.concat([SIGNED_DATA, length, signedData, archive]);
  if (!proofs.every((proof) => verifies(proof, message))) fail("proof");
  return { id, publicKey: Buffer.from(developer.publicKey), archive };
}
