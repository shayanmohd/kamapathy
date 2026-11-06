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
    version: "0.3.0",
    headline:
      "Saved passwords, extensions and update checks, and agents that do more on a page",
    changes: [
      "Kamapathy now asks GitHub once a day for a new version, sending no ID or usage data. Download it or turn this off in Settings, under Updates.",
      "Kamapathy saves and fills your passwords, kept encrypted on this computer, and can import them from other browsers. No agent command reaches them.",
      "Add extensions from the Chrome Web Store, or bring over those you added from it in another browser. They also run in agent spaces that share your sign-ins.",
      "Make Kamapathy your default browser in Settings. Links and files from other apps open in a personal space no agent can reach.",
      "An agent's own cursor, its status and a label for each step show what it is doing, and Stop ends its work in one space.",
      "Sites ask for your location, camera or microphone in a bar above the page, and no agent can answer for you.",
    ],
    agents: [
      "An agent can ask to use one of your spaces, and Let an agent use this space, in a space's options, offers one. Stop ends its access.",
      "Agents read and act inside frames from any site and draw on canvases. Input Kamapathy finds aimed at your extensions or the PDF viewer is refused.",
      "Agents in different spaces now work at the same time and can keep working after you close the window.",
      "Agents handle popups, dialogs, file choosers and the downloads they ask for.",
    ],
    steps: [
      "Page scripts is on, so agents can run their own scripts in agent tabs. To keep them to snapshots, clicks and typing, turn it off in Settings, under Agents.",
      "Open Set up agents from the menu or Settings, tick Use Kamapathy's copy for any agent with its own copy, choose Set up, then restart your agents.",
      "If you run scripts written for 0.2.0, open Release notes below for the list of changes they may notice.",
    ],
  },
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
      "Snapshots read open shadow roots and same-origin frames, and list cross-origin frames so an agent knows they are there.",
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
