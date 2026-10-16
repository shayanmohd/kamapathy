import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PasswordError } from "./errors";

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

// Seals with the system keyring through async safeStorage. Its methods are
// looked up on each call. A Linux backend that keeps the key in plain text,
// or none at all, counts as no keyring.
export function safeStorageSealer(
  storage: Pick<
    Electron.SafeStorage,
    | "isAsyncEncryptionAvailable"
    | "encryptStringAsync"
    | "decryptStringAsync"
    | "getSelectedStorageBackend"
  >,
  platform: NodeJS.Platform,
): Sealer {
  return {
    async check() {
      if (
        !(await storage.isAsyncEncryptionAvailable()) ||
        (platform === "linux" &&
          ["basic_text", "unknown"].includes(
            storage.getSelectedStorageBackend(),
          ))
      )
        throw new PasswordError("vault_unavailable", { reason: "no_keyring" });
    },
    seal: (text) => storage.encryptStringAsync(text),
    async open(sealed) {
      const { result, shouldReEncrypt } =
        await storage.decryptStringAsync(sealed);
      return { text: result, stale: shouldReEncrypt };
    },
  };
}
