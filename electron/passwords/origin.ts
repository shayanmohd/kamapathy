import { PasswordError } from "./errors";

export const ORIGIN_LIMIT = 2048;

function webUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    )
      return url;
  } catch {
    // Not a URL.
  }
}

export function webOrigin(value: string): string | undefined {
  const origin = webUrl(value)?.origin;
  return origin && origin.length <= ORIGIN_LIMIT ? origin : undefined;
}

// What the person typed as a site: a bare host gets https://.
export function loginOrigin(input: string): string {
  const value = input.trim();
  const url = webUrl(
    /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`,
  );
  if (!url) throw new PasswordError("invalid_login", { field: "url" });
  if (url.origin.length > ORIGIN_LIMIT)
    throw new PasswordError("invalid_login", {
      field: "url",
      limit: ORIGIN_LIMIT,
    });
  return url.origin;
}

// https://www.example.com and https://example.com share saved passwords.
// IP addresses, localhost and single-label hosts have no twin.
export function wwwTwin(origin: string): string | undefined {
  const url = webUrl(origin);
  if (!url) return;
  const host = url.hostname;
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return;
  const twin = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
  if (!host.includes(".") || !twin.includes(".")) return;
  return `${url.protocol}//${twin}${url.port ? `:${url.port}` : ""}`;
}

// A page on https at the default port may use what was saved over http.
export function httpUpgradeOrigin(origin: string): string | undefined {
  const url = webUrl(origin);
  return url?.protocol === "https:" && !url.port
    ? `http://${url.host}`
    : undefined;
}

export function asciiHost(origin: string): string {
  return webUrl(origin)?.hostname ?? "";
}

export function isLoopbackOrigin(origin: string): boolean {
  const host = webUrl(origin)?.hostname ?? "";
  return (
    host === "localhost" ||
    host === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}
