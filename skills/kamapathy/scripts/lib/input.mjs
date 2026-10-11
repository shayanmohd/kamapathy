// What commands and page methods read: stdin, targets and upload files.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";

export function required(value, label) {
  if (typeof value !== "string" || !value)
    throw new Error(`Missing ${label}. Run help for usage.`);
  return value;
}
export function target(value) {
  const text = required(value, "element ref or CSS selector");
  return /^@e\d+$/.test(text) ? { ref: text } : { selector: text };
}
// Reads standard input to its end, at most limit bytes, and gives up on a
// pipe that stays open longer than timeoutMs.
export async function readInput(
  stream,
  { limit = 65536, timeoutMs = 30000 } = {},
) {
  if (stream.isTTY)
    throw new Error("Pipe the requested value or JSON into standard input.");
  const chunks = [];
  let size = 0;
  const read = (async () => {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) throw new Error("Standard input exceeds 64 KiB.");
      chunks.push(buffer);
    }
  })();
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      read.catch(() => {});
      stream.destroy?.();
      reject(
        new Error(
          `Standard input did not end within ${timeoutMs / 1000} seconds. Pipe the complete value and close the input.`,
        ),
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([read, expired]);
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
export async function readJson(stream, options) {
  try {
    return JSON.parse(await readInput(stream, options));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("Standard input must be valid JSON.");
    throw error;
  }
}

export function uploadRef(value) {
  if (!/^@e[1-9]\d*$/.test(value || ""))
    throw new Error(
      "Upload requires a current file input ref from a snapshot.",
    );
  return value;
}

// Reads 1 to 8 regular files for an upload body: basenames, MIME types and
// base64 bytes. Errors never disclose the local paths.
export async function readUploadFiles(paths) {
  if (paths.length < 1 || paths.length > 8)
    throw new Error("Upload requires between 1 and 8 selected file paths.");
  const mime = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".json": "application/json",
    ".zip": "application/zip",
    ".aab": "application/octet-stream",
    ".apk": "application/vnd.android.package-archive",
  };
  const files = [];
  let total = 0;
  for (const path of paths) {
    let file;
    try {
      file = await open(
        resolve(path),
        constants.O_RDONLY |
          (constants.O_NOFOLLOW || 0) |
          (constants.O_NONBLOCK || 0),
      );
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 - total)
        throw new Error("Select regular files totaling at most 16 MiB.");
      // Read a bounded allocation even if another process grows the file.
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(
          bytes,
          length,
          bytes.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length !== stat.size)
        throw new Error(
          "A selected file changed size while being read. Inspect it before retrying.",
        );
      total += length;
      files.push({
        name: basename(path),
        type: mime[extname(path).toLowerCase()] || "application/octet-stream",
        data: bytes.subarray(0, length).toString("base64"),
      });
    } catch (error) {
      if (typeof error?.code === "string")
        throw new Error(
          "Could not read a selected file. Check that it is readable, regular, and not a symbolic link.",
        );
      throw error;
    } finally {
      await file?.close();
    }
  }
  return files;
}
