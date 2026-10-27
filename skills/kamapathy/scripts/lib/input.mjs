// What commands and page methods read: stdin, targets, options and upload
// files.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { isChord } from "../keys.mjs";
import { pointFrom } from "../schema/index.mjs";
import { KamapathyError } from "./errors.mjs";

export function required(value, label) {
  if (typeof value !== "string" || !value)
    throw new Error(`Missing ${label}. Run help for usage.`);
  return value;
}
export function target(value) {
  const text = required(value, "element ref or CSS selector");
  return /^@e\d+$/.test(text) ? { ref: text } : { selector: text };
}

// The body fields an element action's options name, under the names the
// routes use: delay and timeout become delayMs and timeoutMs, a position
// comes from either spelling, and the rest keep their own names. The entry
// has already refused every option it does not declare.
const KEPT = ["button", "clickCount", "steps", "force", "append", "label"];
const POSITIONS = ["position", "sourcePosition", "targetPosition"];
export function pointerOptions(options = {}, entry) {
  const body = {};
  for (const name of KEPT)
    if (options[name] !== undefined) body[name] = options[name];
  if (options.delay !== undefined) body.delayMs = options.delay;
  if (options.timeout !== undefined) body.timeoutMs = options.timeout;
  for (const name of POSITIONS)
    if (options[name] !== undefined)
      body[name] = position(options[name], entry, name);
  return body;
}

// A point from an { x, y } object or an "x,y" string.
export function position(value, entry, option = "position") {
  const point = typeof value === "string" ? pointFrom(value) : value;
  if (!point || typeof point.x !== "number" || typeof point.y !== "number")
    throw new KamapathyError(
      "invalid_option",
      `${entry} got an invalid option: ${option} must be { x, y } or "x,y" in pixels.`,
      { entry, option },
    );
  return { x: point.x, y: point.y };
}

// selectOption's choices as the route's array: a lone value, label or
// object is wrapped, and null clears the select.
export function choices(values) {
  if (values === null) return [];
  return Array.isArray(values) ? values : [values];
}

// Which argument of press is the key: a chord is the key and anything else
// is the target, so both argument orders work and a lone target is refused
// instead of guessed at.
export function pressArguments(first, second) {
  if (isChord(first))
    return { key: first, ...(second === undefined ? {} : { target: second }) };
  if (second !== undefined && isChord(second))
    return { key: second, target: first };
  throw new KamapathyError(
    "invalid_argument",
    "page.press got no key. Expected page.press(key, target?) or page.press(target, key), where the key is a name such as Enter, a printable character or a chord such as Shift+KeyA.",
    { entry: "page.press" },
  );
}
// Reads standard input to its end, at most limit bytes, and gives up on a
// pipe that stays open longer than timeoutMs. 64 KiB is every command's
// limit except the page script ones, which take their route's 1 MiB.
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
      if (size > limit)
        throw new Error(
          `Standard input exceeds ${limit % 1048576 ? `${limit / 1024} KiB` : `${limit / 1048576} MiB`}.`,
        );
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

// Reads 1 to 8 regular files for an upload body.
export async function readUploadFiles(paths) {
  if (paths.length < 1 || paths.length > 8)
    throw new Error("Upload requires between 1 and 8 selected file paths.");
  return readFiles(paths, { min: 1 });
}

// Reads min to max regular files for a file input: basenames, MIME types and
// base64 bytes, bytes in total at most. Errors never disclose the local
// paths.
export async function readFiles(
  paths,
  { min = 0, max = 8, bytes: limit = 16 * 1024 * 1024 } = {},
) {
  if (paths.length < min || paths.length > max)
    throw new Error(
      min > 0
        ? `Select between ${min} and ${max} file paths.`
        : `Select at most ${max} file paths.`,
    );
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
      if (!stat.isFile() || stat.size > limit - total)
        throw new Error(
          `Select regular files totaling at most ${Math.floor(limit / (1024 * 1024))} MiB.`,
        );
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
