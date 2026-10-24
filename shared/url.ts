import { HOME_URL } from "./state";
import type { Settings } from "./types";

// Files on this computer that open in a tab: inert ones in a normal view,
// markup without scripts.
export const INERT_FILE_TYPES: readonly string[] = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "txt",
  "webm",
];
export const MARKUP_FILE_TYPES: readonly string[] = [
  "html",
  "htm",
  "xhtml",
  "svg",
];
export type FileKind = "inert" | "markup";
// Never handed to another app, whatever app claims them.
export const BLOCKED_EXTERNAL_SCHEMES: readonly string[] = [
  "about",
  "afp",
  "blob",
  "chrome",
  "chrome-extension",
  "chrome-untrusted",
  "data",
  "devtools",
  "disk",
  "disks",
  "file",
  "filesystem",
  "hcp",
  "ie.http",
  "javascript",
  "kamapathy",
  "ms-help",
  "ms-msdt",
  "ms-officecmd",
  "nntp",
  "res",
  "search",
  "search-ms",
  "shell",
  "vbscript",
  "view-source",
  "vnd.ms.radio",
];
export const URL_MESSAGES = {
  unsupported: "Kamapathy opens web addresses and files only.",
  credentials: "URLs containing credentials are not supported.",
  fileSpace: "Files on this computer open only in your personal spaces.",
  fileType: "This file type doesn't open in Kamapathy.",
  fileMissing: "That file was not found.",
  extensionSpace: "Extension pages open only in your personal spaces.",
  extensionMissing: "That extension isn't installed or is turned off.",
} as const;
// What a space accepts besides web pages. Spaces an agent can reach get
// neither.
export interface UrlOptions {
  allowFile?: boolean;
  extensionIds?: readonly string[];
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

// A file: URL whose host is empty or localhost, which the parser empties. A
// path starting with two slashes is another computer's share on Windows.
export function isFileUrl(url: string): boolean {
  const parsed = parse(url);
  return (
    parsed?.protocol === "file:" &&
    !parsed.host &&
    !parsed.pathname.startsWith("//")
  );
}

// The registered kind of a file: URL by its last path segment's extension,
// in any case. The query and hash never count.
export function fileKind(url: string): FileKind | undefined {
  const parsed = parse(url);
  if (parsed?.protocol !== "file:") return undefined;
  const type = /\.([^./]+)$/.exec(parsed.pathname)?.[1].toLowerCase();
  if (type && INERT_FILE_TYPES.includes(type)) return "inert";
  if (type && MARKUP_FILE_TYPES.includes(type)) return "markup";
  return undefined;
}

// The id of a chrome-extension://<id>/ URL when it is 32 letters a to p.
export function extensionId(url: string): string | undefined {
  const parsed = parse(url);
  if (
    parsed?.protocol === "chrome-extension:" &&
    !parsed.username &&
    !parsed.password &&
    /^[a-p]{32}$/.test(parsed.host)
  )
    return parsed.host;
  return undefined;
}

// Another app's link Kamapathy may offer to open: a valid scheme of 2 to 32
// characters, not a web page or a file, not blocklisted, and at most 2048
// characters.
export function isExternalAppUrl(url: string): boolean {
  if (url.length > 2048) return false;
  const scheme = parse(url)?.protocol.slice(0, -1).toLowerCase();
  return (
    scheme !== undefined &&
    /^[a-z][a-z0-9+.-]{1,31}$/.test(scheme) &&
    scheme !== "http" &&
    scheme !== "https" &&
    !BLOCKED_EXTERNAL_SCHEMES.includes(scheme)
  );
}

export function normalizeUrl(
  input: string,
  engine: Settings["searchEngine"] = "duckduckgo",
  options: UrlOptions = {},
): string {
  const value = input.trim();
  if (!value || value === HOME_URL) return HOME_URL;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password)
      throw new Error(URL_MESSAGES.credentials);
    return url.href;
  }
  // Whether the file exists is for the caller to check.
  if (/^file:/i.test(value)) {
    if (!options.allowFile) throw new Error(URL_MESSAGES.fileSpace);
    if (!isFileUrl(value)) throw new Error(URL_MESSAGES.unsupported);
    if (!fileKind(value)) throw new Error(URL_MESSAGES.fileType);
    return new URL(value).href;
  }
  if (/^chrome-extension:/i.test(value)) {
    if (!options.extensionIds) throw new Error(URL_MESSAGES.extensionSpace);
    const id = extensionId(value);
    if (!id || !options.extensionIds.includes(id))
      throw new Error(URL_MESSAGES.extensionMissing);
    return new URL(value).href;
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(value))
    return new URL(`http://${value}`).href;
  if (
    /^[a-z][a-z\d+.-]*:/i.test(value) &&
    !/^[^\s/:]+\.\w+:\d+([/?#]|$)/.test(value)
  )
    throw new Error(URL_MESSAGES.unsupported);
  if (/^[^\s/]+\.[^\s/.]+(:\d+)?(\/[^\s]*)?$/.test(value)) {
    const url = new URL(`https://${value}`);
    if (url.username || url.password)
      throw new Error(URL_MESSAGES.credentials);
    return url.href;
  }
  const bases = {
    duckduckgo: "https://duckduckgo.com/?q=",
    google: "https://www.google.com/search?q=",
    bing: "https://www.bing.com/search?q=",
  };
  return bases[engine] + encodeURIComponent(value);
}
export function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
export function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

// A popup may show about:blank, a web page, or a blob: URL that a web page
// made. Everything else, data: URLs included, is refused.
export function isPopupUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "about:")
      return parsed.pathname === "blank" && !parsed.search;
    // A blob: URL's path starts with the origin that made it.
    if (parsed.protocol === "blob:") return isWebUrl(parsed.pathname);
    return isWebUrl(url);
  } catch {
    return false;
  }
}

export function isGoogleSignInRejectedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === "https://accounts.google.com" &&
      !url.username && !url.password &&
      /^\/(?:v\d+\/)?signin\/rejected\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function googleSignInFallback(value: string): string | undefined {
  if (!isGoogleSignInRejectedUrl(value)) return;
  const rejected = new URL(value);
  try {
    const destination = new URL(rejected.searchParams.get("continue") || "");
    if (destination.origin === "https://play.google.com" &&
        !destination.username && !destination.password &&
        destination.pathname.startsWith("/console/"))
      return "https://play.google.com/console/";
  } catch {
    // Only fixed public destinations leave the application. Authentication
    // query parameters and provider redirects are never sent to the OS shell.
  }
  return "https://accounts.google.com/";
}

export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return url;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.host.replace(/^www\./, "")}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}
