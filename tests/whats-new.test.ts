import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isVersion, compareVersions } from "../shared/version";
import {
  notesSince,
  recentNotes,
  releaseNotes,
  type ReleaseNote,
} from "../src/whats-new";

// Built from escapes so this file holds no dash of its own.
const dashes = new RegExp("[\\u2013\\u2014]", "u");
const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const versions = (notes: readonly ReleaseNote[]) =>
  notes.map((note) => note.version);
// Five releases, newest first, to try the limits against.
const testNotes: readonly ReleaseNote[] = [
  "0.5.0",
  "0.4.0",
  "0.3.0",
  "0.2.0",
  "0.1.0",
].map((version) => ({
  version,
  headline: `Kamapathy ${version}`,
  changes: ["Something changed."],
}));

describe("what's new notes", () => {
  it("has notes for the package.json version", () => {
    const { version } = JSON.parse(read("package.json"));
    expect(versions(releaseNotes)).toContain(version);
  });
  it("keeps notes newest first and within limits", () => {
    expect(releaseNotes.length).toBeGreaterThan(0);
    for (const [index, note] of releaseNotes.entries()) {
      expect(isVersion(note.version)).toBe(true);
      const earlier = releaseNotes[index + 1];
      if (earlier)
        expect(compareVersions(note.version, earlier.version)).toBe(1);
      expect(note.headline.length).toBeGreaterThan(0);
      expect(note.headline.length).toBeLessThanOrEqual(90);
      expect(note.changes.length).toBeGreaterThan(0);
      expect(note.changes.length).toBeLessThanOrEqual(6);
      expect(note.agents?.length ?? 0).toBeLessThanOrEqual(4);
      expect(note.steps?.length ?? 0).toBeLessThanOrEqual(4);
      for (const item of [
        note.headline,
        ...note.changes,
        ...(note.agents ?? []),
        ...(note.steps ?? []),
      ]) {
        expect(item.length).toBeGreaterThan(0);
        expect(item.length).toBeLessThanOrEqual(160);
        expect(item).not.toMatch(dashes);
      }
    }
  });
  it("names no device among the requests 0.3.0 asks in the bar", () => {
    const notes = releaseNotes.find((note) => note.version === "0.3.0");
    expect(notes?.changes).toContain(
      "Sites ask for your location, camera or microphone in a bar above the page, and no agent can answer for you.",
    );
  });
  it("shows at most three versions above the last one seen", () => {
    expect(versions(notesSince("0.1.0", "0.4.0", testNotes))).toEqual([
      "0.4.0",
      "0.3.0",
      "0.2.0",
    ]);
    expect(notesSince("0.4.0", "0.4.0", testNotes)).toEqual([]);
    expect(versions(notesSince("0.0.0", "0.2.0", testNotes))).toEqual([
      "0.2.0",
      "0.1.0",
    ]);
    expect(versions(recentNotes("0.4.0", testNotes))).toEqual([
      "0.4.0",
      "0.3.0",
      "0.2.0",
    ]);
  });
});
