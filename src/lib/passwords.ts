import type {
  PasswordErrorBody,
  PasswordResult,
  SavedLoginSummary,
} from "../../shared/types";
import { hostname } from "../../shared/url";

// Every passwords bridge call resolves with its result or an error body.
export function isPasswordError<T>(
  result: PasswordResult<T>,
): result is { error: PasswordErrorBody } {
  const body = (result as { error?: PasswordErrorBody } | null | undefined)
    ?.error;
  return !!body && typeof body.code === "string";
}

export function loginHost(origin: string): string {
  return hostname(origin);
}

function compare(first: string, second: string): number {
  return first.toLowerCase().localeCompare(second.toLowerCase());
}

export function sortLogins(logins: SavedLoginSummary[]): SavedLoginSummary[] {
  return [...logins].sort(
    (first, second) =>
      compare(loginHost(first.origin), loginHost(second.origin)) ||
      compare(first.username, second.username),
  );
}

export function filterLogins(
  logins: SavedLoginSummary[],
  query: string,
  compromisedOnly: boolean,
): SavedLoginSummary[] {
  const needle = query.trim().toLowerCase();
  return logins.filter((login) => {
    if (compromisedOnly && !login.compromised) return false;
    if (!needle) return true;
    return (
      loginHost(login.origin).toLowerCase().includes(needle) ||
      login.username.toLowerCase().includes(needle)
    );
  });
}

export function compromisedCount(logins: SavedLoginSummary[]): number {
  return logins.filter((login) => login.compromised).length;
}
