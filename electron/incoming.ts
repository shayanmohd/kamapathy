import { statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fileKind, isFileUrl, isWebUrl } from "../shared/url";

const LIMIT = 20;
const WINDOW_MS = 2000;

export interface IncomingOptions {
  // process.defaultApp: the arguments include the app path.
  defaultApp: boolean;
  isFile?: (path: string) => boolean;
}

function regularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** One value from the operating system: an http(s) URL without credentials,
 *  or a file: URL (empty or localhost host) or path naming an existing regular
 *  file of a registered type. Relative paths resolve against cwd. Returns the
 *  canonical href. */
export function incomingItem(
  value: string,
  cwd: string,
  isFile: (path: string) => boolean = regularFile,
): string | undefined {
  try {
    if (isWebUrl(value)) return new URL(value).href;
    if (/^file:/i.test(value))
      return isFileUrl(value) && fileKind(value) && isFile(fileURLToPath(value))
        ? new URL(value).href
        : undefined;
    const path = resolve(cwd, value);
    const url = pathToFileURL(path).href;
    return isFile(path) && fileKind(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Skips argv[0] and, in development, the app path; with --single-argument
 *  exactly one non-switch argument or none; otherwise the first 20 non-switch
 *  arguments. */
export function incomingItems(
  argv: readonly string[],
  cwd: string,
  options: IncomingOptions,
): string[] {
  const rest = argv.slice(1);
  // Electron takes the first argument that is no switch as the app path,
  // which is argv[1] unless switches come first.
  const app = options.defaultApp
    ? rest.findIndex((argument) => !argument.startsWith("-"))
    : -1;
  if (app !== -1) rest.splice(app, 1);
  const single = rest.indexOf("--single-argument");
  const values = rest
    .slice(single + 1)
    .filter((argument) => !argument.startsWith("-"));
  // A link handler passes one argument; more means the link carried quotes.
  if (single !== -1 && values.length !== 1) return [];
  return values
    .slice(0, LIMIT)
    .map((value) => incomingItem(value, cwd, options.isFile))
    .filter((item): item is string => item !== undefined);
}

/** True for at most 20 calls in any 2 s. */
export function incomingLimiter(
  now: () => number = () => performance.now(),
): () => boolean {
  let passed: number[] = [];
  return () => {
    const time = now();
    passed = passed.filter((at) => at > time - WINDOW_MS);
    if (passed.length >= LIMIT) return false;
    passed.push(time);
    return true;
  };
}
