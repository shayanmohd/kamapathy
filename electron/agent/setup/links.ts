import {
  lstatSync,
  readlinkSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { errorCode } from "./paths";

export type EntryState = "linked" | "available" | "own_copy";

export const samePath = (a: string, b: string, platform: NodeJS.Platform) =>
  platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

// Where a symlink or junction points, resolved against its folder; null for
// anything that is not a link. Throws when nothing is there.
export function linkTarget(path: string): string | null {
  if (!lstatSync(path).isSymbolicLink()) return null;
  return resolve(dirname(path), readlinkSync(path).replace(/^\\\\\?\\/, ""));
}

export function entryState(
  entry: string,
  stable: string,
  platform: NodeJS.Platform,
): EntryState {
  let target;
  try {
    target = linkTarget(entry);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "available";
    throw error;
  }
  return target !== null && samePath(target, resolve(stable), platform)
    ? "linked"
    : "own_copy";
}

// POSIX entries are absolute symlinks to S; Windows entries are junctions.
export function linkEntry(
  entry: string,
  stable: string,
  platform: NodeJS.Platform,
): void {
  symlinkSync(
    resolve(stable),
    entry,
    platform === "win32" ? "junction" : undefined,
  );
}

// Removes the entry only when it links to S, and never recursively.
export function unlinkEntry(
  entry: string,
  stable: string,
  platform: NodeJS.Platform,
): boolean {
  if (entryState(entry, stable, platform) !== "linked") return false;
  if (platform === "win32") rmdirSync(entry);
  else unlinkSync(entry);
  return true;
}

// The install-skill.mjs convention, beside the entry.
export const backupPath = (entry: string, now: number, random: string) =>
  join(dirname(entry), `.kamapathy-backup-${now}-${random}`);
