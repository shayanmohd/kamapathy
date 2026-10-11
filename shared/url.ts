import { HOME_URL } from "./state";
import type { Settings } from "./types";

export function normalizeUrl(
  input: string,
  engine: Settings["searchEngine"] = "duckduckgo",
): string {
  const value = input.trim();
  if (!value || value === HOME_URL) return HOME_URL;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (url.username || url.password)
      throw new Error("URLs containing credentials are not supported.");
    return url.href;
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?([/?#]|$)/i.test(value))
    return new URL(`http://${value}`).href;
  if (
    /^[a-z][a-z\d+.-]*:/i.test(value) &&
    !/^[^\s/:]+\.\w+:\d+([/?#]|$)/.test(value)
  )
    throw new Error("Only HTTP and HTTPS addresses are supported.");
  if (/^[^\s/]+\.[^\s/.]+(:\d+)?(\/[^\s]*)?$/.test(value)) {
    const url = new URL(`https://${value}`);
    if (url.username || url.password)
      throw new Error("URLs containing credentials are not supported.");
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
