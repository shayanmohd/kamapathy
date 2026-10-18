import type {
  PasswordErrorBody,
  PasswordImportSummary,
  PasswordResult,
  SavedLoginSummary,
} from "../../shared/types";
import { hostname } from "../../shared/url";
import { passwordsCopy } from "../copy";

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

// What an import did, in the spec's order; counts of zero say nothing.
export function importSummaryLines(summary: PasswordImportSummary): string[] {
  const { transfer } = passwordsCopy;
  return [
    transfer.imported(summary.added + summary.replaced),
    ...(summary.unchanged ? [transfer.already(summary.unchanged)] : []),
    ...(summary.kept ? [transfer.kept(summary.kept)] : []),
    ...(summary.skipped ? [transfer.skipped(summary.skipped)] : []),
    ...summary.warnings,
  ];
}
