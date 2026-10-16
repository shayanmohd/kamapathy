import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Encrypts vault values. The app seals saved passwords with async
// safeStorage; check() throws PasswordError vault_unavailable when sealing
// cannot work on this computer, and open() reports a value sealed with an
// older key as stale.
export interface Sealer {
  check(): Promise<void>;
  seal(text: string): Promise<Buffer>;
  open(sealed: Buffer): Promise<{ text: string; stale: boolean }>;
}

const IV = 12;
const TAG = 16;

// Holds captured values until the person saves them, with a key that lives
// for this run only.
export function memorySealer(): Sealer {
  const key = randomBytes(32);
  return {
    check: async () => {},
    async seal(text) {
      const iv = randomBytes(IV);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async open(sealed) {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        sealed.subarray(0, IV),
        { authTagLength: TAG },
      );
      decipher.setAuthTag(sealed.subarray(IV, IV + TAG));
      const text = Buffer.concat([
        decipher.update(sealed.subarray(IV + TAG)),
        decipher.final(),
      ]).toString("utf8");
      return { text, stale: false };
    },
  };
}
