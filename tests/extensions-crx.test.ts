import { describe, expect, it } from "vitest";
import {
  CrxError,
  MAX_CRX_HEADER,
  WEBSTORE_PUBLISHER_KEY_HASH,
  verifyCrx,
  type CrxFailure,
} from "../electron/extensions/crx";
import {
  crxOf,
  extensionZip,
  hashOf,
  idOf,
  keyPair,
} from "./extension-builders";

const developer = { kind: "rsa" as const, ...keyPair("rsa") };
const publisher = { kind: "ec" as const, ...keyPair("ec") };
const third = { kind: "ec" as const, ...keyPair("ec") };
const other = { kind: "rsa" as const, ...keyPair("rsa") };
const id = idOf(developer.publicKey);
const publisherHash = hashOf(publisher.publicKey);
// For exact header sizes: another RSA key stands in for the publisher.
const rsaOnly = [developer, other];
const archive = extensionZip(
  { manifest_version: 3, name: "Example", version: "1.0.0" },
  { "background.js": "chrome.runtime.onInstalled.addListener(() => {});" },
);

function reason(run: () => unknown): CrxFailure {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CrxError);
    return (error as CrxError).reason;
  }
  throw new Error("Expected a CrxError.");
}
function crxIdOf(publicKey: Buffer): Buffer {
  return Buffer.from(hashOf(publicKey), "hex").subarray(0, 16);
}
function varint(value: number): number[] {
  const bytes: number[] = [];
  for (; value > 0x7f; value = Math.floor(value / 128))
    bytes.push((value % 128) | 0x80);
  return [...bytes, value];
}
// Header field 4 is verified_contents, which the verifier skips.
function verifiedContents(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x22, ...varint(data.length)]), data]);
}

describe("CRX3 files", () => {
  it("a valid file passes and yields its ID", () => {
    const verified = verifyCrx(
      crxOf(archive, [developer, publisher]),
      id,
      publisherHash,
    );
    expect(verified.id).toBe(id);
    expect(verified.publicKey.equals(developer.publicKey)).toBe(true);
    expect(verified.archive.equals(archive)).toBe(true);

    // An ECDSA proof by a third key still passes, as does the developer
    // proof in any position.
    expect(
      verifyCrx(
        crxOf(archive, [developer, publisher, third]),
        id,
        publisherHash,
      ).id,
    ).toBe(id);
    const reordered = verifyCrx(
      crxOf(archive, [third, publisher, developer], {
        crxId: crxIdOf(developer.publicKey),
      }),
      id,
      publisherHash,
    );
    expect(reordered.publicKey.equals(developer.publicKey)).toBe(true);
    // An EC developer key works too.
    expect(
      verifyCrx(
        crxOf(archive, [third, publisher]),
        idOf(third.publicKey),
        publisherHash,
      ).publicKey.equals(third.publicKey),
    ).toBe(true);

    // Unknown header fields are skipped, and a header of exactly
    // MAX_CRX_HEADER bytes is read. RSA signatures have a fixed length, so
    // the header's size is known before the suffix is added.
    const size = crxOf(archive, rsaOnly).readUInt32LE(8);
    const largest = crxOf(archive, rsaOnly, {
      headerSuffix: verifiedContents(Buffer.alloc(MAX_CRX_HEADER - size - 4)),
    });
    expect(largest.readUInt32LE(8)).toBe(MAX_CRX_HEADER);
    expect(
      verifyCrx(largest, id, hashOf(other.publicKey)).archive.equals(archive),
    ).toBe(true);
  });

  it("a wrong ID, a flipped byte, a bad proof, a missing publisher proof, bad magic or an oversized header each fail", () => {
    const crx = crxOf(archive, [developer, publisher]);
    const check = (bytes: Buffer, expectedId = id) =>
      reason(() => verifyCrx(bytes, expectedId, publisherHash));

    expect(check(crx, idOf(other.publicKey))).toBe("id");
    // crx_id names another key, so no proof carries the declared id.
    expect(
      check(
        crxOf(archive, [developer, publisher], {
          crxId: crxIdOf(other.publicKey),
        }),
      ),
    ).toBe("id");

    const flipped = Buffer.from(crx);
    flipped[flipped.length - 1] ^= 1;
    expect(check(flipped)).toBe("proof");
    // A signature by another key, an RSA key in the ECDSA list, a key that
    // isn't a key, and no proofs at all.
    expect(
      check(
        crxOf(archive, [
          { ...developer, privateKey: other.privateKey },
          publisher,
        ]),
      ),
    ).toBe("proof");
    expect(
      check(crxOf(archive, [developer, publisher, { ...other, kind: "ec" }])),
    ).toBe("proof");
    expect(
      check(
        crxOf(archive, [
          developer,
          publisher,
          { ...other, publicKey: Buffer.from("not a key") },
        ]),
      ),
    ).toBe("proof");
    expect(
      check(crxOf(archive, [], { crxId: crxIdOf(developer.publicKey) })),
    ).toBe("proof");

    expect(check(crxOf(archive, [developer]))).toBe("publisher");

    expect(
      check(crxOf(archive, [developer, publisher], { magic: "Cr23" })),
    ).toBe("magic");
    expect(check(archive)).toBe("magic");
    expect(check(Buffer.alloc(0))).toBe("magic");
    expect(check(crxOf(archive, [developer, publisher], { version: 2 }))).toBe(
      "version",
    );

    const size = crxOf(archive, rsaOnly).readUInt32LE(8);
    const oversized = crxOf(archive, rsaOnly, {
      headerSuffix: verifiedContents(Buffer.alloc(MAX_CRX_HEADER - size - 3)),
    });
    expect(oversized.readUInt32LE(8)).toBe(MAX_CRX_HEADER + 1);
    expect(
      reason(() => verifyCrx(oversized, id, hashOf(other.publicKey))),
    ).toBe("header");
    const pastTheEnd = Buffer.from(crx);
    pastTheEnd.writeUInt32LE(crx.length - 11, 8);
    expect(check(pastTheEnd)).toBe("header");
    expect(check(crx.subarray(0, 11))).toBe("header");
    // A header that a zip reader could take for the archive's end.
    for (const marker of ["PK\x05\x06", "PK\x06\x06", "PK\x06\x07"])
      expect(
        check(
          crxOf(archive, [developer, publisher], {
            headerSuffix: verifiedContents(Buffer.from(marker, "latin1")),
          }),
        ),
      ).toBe("header");
    // A crx_id that isn't 16 bytes, a truncated field and a group.
    expect(
      check(
        crxOf(archive, [developer, publisher], { crxId: Buffer.alloc(15) }),
      ),
    ).toBe("header");
    expect(
      check(
        crxOf(archive, [developer, publisher], {
          headerSuffix: Buffer.from([0x22, 0x10, 0x01]),
        }),
      ),
    ).toBe("header");
    expect(
      check(
        crxOf(archive, [developer, publisher], {
          headerSuffix: Buffer.from([0x23]),
        }),
      ),
    ).toBe("header");
  });

  it("the publisher hash is pinned", () => {
    expect(WEBSTORE_PUBLISHER_KEY_HASH).toBe(
      "61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf",
    );
    expect(
      reason(() => verifyCrx(crxOf(archive, [developer, publisher]), id)),
    ).toBe("publisher");
  });
});
