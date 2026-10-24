import type {
  ImportFailure,
  ImportOutcome,
  ImportRequest,
  ImportSource,
} from "../../shared/types";
import { importCopy } from "../copy";

/** Each source the person checked, with the profile ids checked in it. */
export type Selection = ReadonlyMap<string, ReadonlySet<string>>;
export interface ImportChoices {
  selection: Selection;
  bookmarks: boolean;
  history: boolean;
  signIns: boolean;
  passwords: boolean;
  destination: "shared" | "separate";
}
/** The Safari export file the panel accepts, matching the IPC channel's limit. */
export const SAFARI_FILE_LIMIT = 16 * 1024 * 1024;

/** Safari comes in through its own export file, and a blocked source lists no profiles. */
export function selectableSource(source: ImportSource): boolean {
  return (
    source.id !== "safari" &&
    source.status === "ready" &&
    source.profiles.length > 0
  );
}

export function initialSelection(
  sources: readonly ImportSource[],
): Map<string, Set<string>> {
  const ready = sources.filter(selectableSource);
  const first = ready.find((source) => source.default) ?? ready[0];
  const profile = first?.profiles[0];
  if (!first || !profile) return new Map();
  return new Map([[first.id, new Set([profile.id])]]);
}

export function importRequest(choices: ImportChoices): ImportRequest | null {
  const profiles = [...choices.selection].flatMap(([source, ids]) =>
    [...ids].map((profile) => ({ source, profile })),
  );
  if (!profiles.length) return null;
  if (
    !choices.bookmarks &&
    !choices.history &&
    !choices.signIns &&
    !choices.passwords
  )
    return null;
  return {
    profiles,
    bookmarks: choices.bookmarks,
    history: choices.history,
    signIns: choices.signIns ? choices.destination : "none",
    ...(choices.passwords ? { passwords: true } : {}),
  };
}

export function signInsAvailable(
  sources: readonly ImportSource[],
  selection: Selection,
): boolean {
  return sources.some(
    (source) =>
      source.signInsAvailable && (selection.get(source.id)?.size ?? 0) > 0,
  );
}

export function passwordsAvailable(
  sources: readonly ImportSource[],
  selection: Selection,
): boolean {
  return sources.some(
    (source) =>
      source.passwordsAvailable && (selection.get(source.id)?.size ?? 0) > 0,
  );
}

export function blockedSources(
  sources: readonly ImportSource[],
): ImportSource[] {
  return sources.filter((source) => source.status === "needs_permission");
}

export function doneLine(outcome: ImportOutcome, withSignIns: boolean): string {
  // Imports without a password read as they did before.
  const passwords = outcome.passwords ? outcome.passwords : undefined;
  return importCopy.done(
    outcome.bookmarks,
    outcome.history,
    withSignIns ? outcome.signIns : undefined,
    passwords,
  );
}

export function errorText(error: ImportFailure["error"]): string {
  // The archive error carries one of two texts, so main's message wins.
  if (error.code === "invalid_archive") return error.message;
  return importCopy.errors[error.code] ?? error.message;
}
