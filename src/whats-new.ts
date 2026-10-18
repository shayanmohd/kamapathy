import { compareVersions } from "../shared/version";

export interface ReleaseNote {
  version: string;
  headline: string;
  changes: string[];
  agents?: string[];
  steps?: string[];
}

// Newest first. docs/releases.md says to add the version's entry before a build.
export const releaseNotes: readonly ReleaseNote[] = [
  {
    version: "0.2.0",
    headline: "Spaces you share with your agents, in plain sight",
    changes: [
      "Personal spaces for your own browsing and agent spaces for whatever you hand off, with one shortcut that lays them all out.",
      "A green ring and a small bar show when an agent is working. Take over pauses it, Let agent continue hands it back, Stop ends its work.",
      "Sign in once and every space and agent can use that session, or give a space separate sign-ins.",
      "Import bookmarks and history from another browser on this computer, on the first launch or later from Settings.",
      "Tabs across the top, one address bar, one menu. No account, no feed, no telemetry.",
    ],
    agents: [
      "Agents reach Kamapathy over a socket on this computer and work in spaces of their own, never in your personal tabs.",
      "Settings, under Agents, adds Kamapathy's skill and the kamapathy command to the agents on this computer.",
      "Snapshots read open shadow roots and same-origin frames, and list cross-origin frames so an agent knows they are there.",
    ],
    steps: [
      "Restart your agents so they load the skill this version ships.",
      "Open a new terminal window if you use the kamapathy command.",
    ],
  },
];

const LIMIT = 3;

// Above the last version seen, up to the running one, newest first.
export function notesSince(
  seen: string,
  running: string,
  notes: readonly ReleaseNote[] = releaseNotes,
  limit = LIMIT,
): ReleaseNote[] {
  return notes
    .filter(
      (note) =>
        compareVersions(note.version, seen) > 0 &&
        compareVersions(note.version, running) <= 0,
    )
    .slice(0, limit);
}

export function recentNotes(
  running: string,
  notes: readonly ReleaseNote[] = releaseNotes,
  limit = LIMIT,
): ReleaseNote[] {
  return notes
    .filter((note) => compareVersions(note.version, running) <= 0)
    .slice(0, limit);
}
