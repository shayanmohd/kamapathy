// New interface text lives here so renaming the product touches one file.
export const toolsMenuCopy = {
  label: "Browser menu",
  "new-tab": "New tab",
  space: "New space",
  command: "Search tabs & commands",
  bookmarks: "Bookmarks",
  history: "History",
  downloads: "Downloads",
  passwords: "Passwords",
  split: "Split view",
  find: "Find",
  settings: "Settings",
  "agent-setup": "Set up agents",
  help: "Help",
  update: "Update Kamapathy",
} as const;

// Command palette entries for setup and help.
export const helpCopy: Record<
  "agent-setup" | "help" | "report-issue" | "privacy",
  { title: string; hint: string }
> = {
  "agent-setup": {
    title: "Set up agents",
    hint: "Give your agents Kamapathy's skill",
  },
  help: { title: "Help", hint: "Answers to common questions" },
  "report-issue": { title: "Report an issue", hint: "Tell us what went wrong" },
  privacy: { title: "Privacy", hint: "How Kamapathy handles your data" },
};

export const tabStripCopy = {
  search: "Search tabs",
  filter: "Filter tabs",
  noMatches: "No matching tabs",
  newTab: "New tab",
} as const;

export const settingsCopy = {
  agents: "Agents",
  access: "Agent access",
  isolate: "Isolate agent spaces",
  isolateNote:
    "Give every new agent space a temporary session of its own instead of your sign-ins.",
  spaces:
    "Agent spaces use your sign-ins unless you isolate them, and disappear when you quit. Take over at any time.",
  activity: "Recent activity",
  noActivity: "Actions will appear here when an agent gets to work.",
  import: "Import bookmarks and history",
  importNote: "Bring them over from another browser on this computer.",
  importButton: "Import...",
  passwords: "Passwords",
  offerToSave: "Offer to save passwords",
  offerToSaveNote:
    "Kamapathy asks after you sign in. Saved passwords stay on this computer.",
  savedPasswords: "Saved passwords",
  manage: "Manage...",
} as const;

export const signInsCopy = {
  label: "Separate sign-ins",
  personal: "Keep this space's cookies and sign-ins apart from your other spaces.",
  agent: "Give the agent a temporary session without your sign-ins.",
  forced: "Settings isolates every new agent space.",
} as const;

export const welcomeCopy = {
  title: "Welcome to Kamapathy",
  description:
    "Bring your bookmarks and history from another browser on this computer.",
  signInTitle: "Sign in once",
  signInDescription:
    "Kamapathy shares your sign-ins across your spaces and with your agents, so a site you sign in to here works everywhere. Any space can keep separate sign-ins, and Settings can isolate agent spaces.",
  sites: "Your sites",
  open: "Open",
  opened: "Opened",
  done: "Done",
  noSites:
    "Open the sites you use most and sign in. Your agents can then use them too.",
} as const;

export const importCopy = {
  title: "Import bookmarks and history",
  description:
    "Choose a browser on this computer. Kamapathy reads its bookmarks and history and never changes them.",
  from: "Import from",
  defaultBrowser: "Default browser",
  profile: "Profile",
  bookmarks: "Bookmarks",
  history: "History",
  skip: "Skip",
  import: "Import",
  working: "Importing...",
  continue: "Continue",
  looking: "Looking for browsers...",
  none: "No other browsers were found on this computer.",
  failed: "The import did not finish. Try again.",
  done: (bookmarks: number, history: number) =>
    `Imported ${bookmarks} ${bookmarks === 1 ? "bookmark" : "bookmarks"} and ${history} ${history === 1 ? "site" : "sites"}.`,
} as const;

export const agentBarCopy = {
  status: {
    browsing: "Agent is browsing",
    idle: "Agent is idle",
    paused: "Agent access is off",
    "in-control": "You're in control",
    "needs-you": "You're in control",
    finished: "Agent finished",
    stopped: "You stopped the agent",
  },
  takeOver: "Take over",
  letContinue: "Let agent continue",
  stop: "Stop",
  stopAll: "Stop all agents",
  confirmStop: "Stop the agent in this space?",
  cancel: "Cancel",
  keep: "Keep as personal space",
  keepWarning: "Its temporary sign-ins end and its pages reload.",
} as const;

export const spacesCopy = {
  menu: "Spaces",
  button: (space: string, working: number, needsYou: boolean) =>
    [
      `Spaces: ${space}`,
      working ? `${working} ${working === 1 ? "agent" : "agents"} working` : "",
      needsYou ? "an agent needs you" : "",
    ]
      .filter(Boolean)
      .join(", "),
  agents: "Agents",
  yours: "Your spaces",
  accessOff: "Agent access is off · Turn on",
  newSpace: "New space",
  tabs: (count: number) => `${count} ${count === 1 ? "tab" : "tabs"}`,
  details: (name: string) => `Details for ${name}`,
  options: (name: string) => `Options for ${name}`,
  rename: "Rename",
  nameLabel: "Space name",
  colour: "Colour",
  close: "Close space",
  confirmClose: "Confirm close",
  closeWarning: "This closes every tab in this space and removes its session.",
  viewAll: "View all",
  noActivity: "Nothing has happened here yet.",
  activityTitle: (name: string) => `${name} activity`,
  kind: "Kind of space",
  personal: "Personal",
  agent: "Agent",
  grant: "Let an agent use this space",
  accessLine:
    "Agents can read and act on this space's tabs, run their own scripts there while Page scripts is on, and use its sign-ins until you stop them.",
  stopAccess: "Stop agent access",
  request: "An agent is asking for a space",
} as const;

export const spaceRequestCopy = {
  title: "Let an agent use a space?",
  from: "From the agent",
  allow: "Allow",
  deny: "Don't allow",
} as const;

export const statusCopy = {
  browsing: "Browsing",
  idle: "Idle",
  "needs-you": "Needs you",
  "in-control": "You're in control",
  paused: "Agent access is off",
  finished: "Agent finished",
  stopped: "You stopped the agent",
} as const;

export const overviewCopy = {
  title: "All spaces",
  count: (count: number) => `${count} ${count === 1 ? "space" : "spaces"}`,
  close: "Close all spaces",
  open: (name: string) => `Open ${name}`,
  rename: (name: string) => `Rename ${name}`,
  closeSpace: (name: string) => `Close ${name}`,
  confirmClose: (name: string) => `Confirm closing ${name}`,
  newSpace: "New space",
  create: "Create space",
  placeholder: "e.g. Weekend project",
} as const;

export const newTabCopy = {
  shortcuts: "Shortcuts",
  add: "Add shortcut",
  menu: (title: string) => `${title} shortcut`,
  edit: "Edit",
  remove: "Remove",
  editTitle: "Edit shortcut",
  editDescription: "Change the name or address of this shortcut.",
  save: "Save shortcut",
  saved: "Shortcut saved.",
} as const;

export const passwordsCopy = {
  title: "Passwords",
  search: "Search passwords...",
  opening: "Unlocking passwords...",
  empty: "No saved passwords yet. Kamapathy offers to save one when you sign in.",
  locked:
    "Saved passwords are locked. Choose Try again and allow Kamapathy's keychain access.",
  unavailable: "Kamapathy can't save passwords without a system keyring.",
  web: "Saved passwords are available in the desktop app.",
  tryAgain: "Try again",
  startOver: "Start over",
  startOverConfirm:
    "Start over with no saved passwords? The unreadable file stays in Kamapathy's passwords folder.",
  compromised: (count: number) =>
    count === 1
      ? "1 password is marked compromised."
      : `${count} passwords are marked compromised.`,
  showCompromised: "Show",
  showAll: "Show all",
  compromisedTag: "Compromised",
  realm: (realm: string) => `Realm: ${realm}`,
  noUsername: "No username",
  show: "Show",
  hide: "Hide",
  copyUsername: "Copy username",
  copyPassword: "Copy password",
  copied: "Copied",
  edit: "Edit",
  delete: "Delete",
  confirmDelete: "Delete this password?",
  cancel: "Cancel",
  save: "Save",
  add: "Add password",
  siteUrl: "Site URL",
  username: "Username",
  password: "Password",
  note: "Note",
  neverSaved: "Never saved",
  remove: "Remove",
  footnote: "Stored on this computer, encrypted with your system's keychain.",
  transfer: {
    import: "Import...",
    export: "Export...",
    replace: "Replace saved passwords that differ",
    start: "Import",
    imported: (count: number) =>
      count === 1 ? "Imported 1 password." : `Imported ${count} passwords.`,
    already: (count: number) =>
      count === 1 ? "1 was already saved." : `${count} were already saved.`,
    kept: (count: number) =>
      count === 1
        ? "1 differs from saved ones and was kept."
        : `${count} differ from saved ones and were kept.`,
    skipped: (count: number) =>
      count === 1 ? "1 row was skipped." : `${count} rows were skipped.`,
    trash: (name: string) =>
      `Move ${name} to the Trash? It holds your passwords in plain text.`,
    moveToTrash: "Move to Trash",
    keepFile: "Keep file",
    exported: (count: number) =>
      count === 1 ? "Exported 1 password." : `Exported ${count} passwords.`,
  },
} as const;
// The Move to Applications offer at start on macOS.
export const moveCopy = {
  question: "Move Kamapathy to Applications?",
  detail:
    "From Applications it keeps working after you eject the disk image, and agents can start it.",
  move: "Move to Applications",
  notNow: "Not now",
  replace: "Replace Kamapathy in Applications?",
  replaceButton: "Replace",
  cancel: "Cancel",
  failed: "Kamapathy couldn't move itself.",
  failedDetail:
    "Drag Kamapathy into the Applications folder, then open it from there.",
} as const;

export const agentSetupCopy = {
  title: "Set up agents",
  intro:
    "Add Kamapathy's skill to the agents on this computer. Nothing changes until you choose Set up.",
  checking: "Looking for agents...",
  agentsHeading: "Agents on this computer",
  noAgents: "No agents were found on this computer.",
  ownCopy: "Has its own copy",
  useOurs: "Use Kamapathy's copy",
  command: "Add the kamapathy command",
  pathIn: (file: string) => `Add ~/.local/bin to your PATH in ${file}`,
  pathWindows: "Add it to your PATH",
  pathManual: "Add this line to your shell's startup file:",
  codexRule: "Let Codex run kamapathy without asking",
  codexWarning:
    "Codex will use Kamapathy, including your sign-ins and files it uploads, without asking you first.",
  nodeMissing:
    "The kamapathy command needs Node.js 22.13 or later from nodejs.org.",
  nodeTooOld: (version: string) =>
    `This computer has Node.js ${version}. The kamapathy command needs 22.13 or later.`,
  setUp: "Set up",
  working: "Working...",
  remove: "Remove setup",
  close: "Close",
  done: "Restart your agents to load the skill. Open a new terminal window for the kamapathy command.",
  tryIt: "Try it",
  firstPrompt:
    "Use Kamapathy to check this weekend's weather in Lisbon and tell me which site you used.",
  copy: "Copy",
  copied: "Copied",
  copyPath: "Copy path",
  skillFolder: "Skill folder",
  hints: {
    "claude-code": "In Claude Code, type /kamapathy, then your task.",
    codex: "In Codex, type $kamapathy, then your task.",
  },
  genericHint: "Ask your agent to use Kamapathy, then give it your task.",
  reasons: {
    command_taken: "Another program already uses ~/.local/bin/kamapathy.",
    shadowed: "Another kamapathy command comes first on your PATH.",
    profile_changed:
      "The PATH lines in your startup file were edited, so Kamapathy left them.",
    probe_failed: "Kamapathy couldn't read your shell's PATH.",
    not_writable: "Kamapathy couldn't write there.",
  } as Record<string, string>,
  settingsRow: "Agent setup",
  settingsButton: "Set up...",
  // Lists the agents set up, or names the command when no agent is.
  summary: (names: string[], command: boolean) =>
    !names.length && command
      ? "Set up for the kamapathy command"
      : `Set up for ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]}`,
  notSetUp: "Not set up yet",
  desktopOnly: "Available in the desktop app.",
  testProfile: "Agent setup is off for test profiles.",
} as const;

export const updatesCopy = {
  heading: "Updates",
  switch: "Check for updates",
  switchNote:
    "Once a day, Kamapathy asks GitHub for the newest release. It sends no ID or usage data.",
  unchecked: "Not checked yet.",
  current: (time: string) => `Kamapathy is up to date. Checked ${time}.`,
  available: (version: string) => `Kamapathy ${version} is available.`,
  downloading: (version: string, percent: number) =>
    `Downloading Kamapathy ${version}... ${percent}%`,
  ready: (version: string) => `Kamapathy ${version} is ready to install.`,
  checkFailed: "Couldn't reach GitHub. Try again later.",
  downloadStopped: "The download stopped. Try again.",
  verifyFailed: "The download didn't match its checksum, so it was deleted.",
  cancelled: "Download cancelled.",
  source: "This copy runs from source. Pull the latest code to update it.",
  noInstaller: "No installer is published for this computer yet.",
  checkNow: "Check now",
  download: "Download",
  cancel: "Cancel",
  install: "Install...",
  releaseNotes: "Release notes",
  whatsNew: "What's new",
  installTitle: (version: string) => `Install Kamapathy ${version}`,
  quitAndOpen: "Quit and open installer",
  showInFolder: "Show in folder",
  copyCommand: "Copy command",
  notNow: "Not now",
  agentSpaces: (count: number) =>
    count === 1
      ? "1 agent space is open. It closes when Kamapathy quits."
      : `${count} agent spaces are open. They close when Kamapathy quits.`,
  steps: {
    portable: "Quit Kamapathy, replace your copy with this file, then open it.",
    debian: "Quit Kamapathy, then run:",
    mac: "Drag Kamapathy into Applications and replace the old copy, then open it. If macOS says it can't verify the app, click Open Anyway in System Settings > Privacy & Security.",
    windows:
      "Follow the setup, then open Kamapathy. If SmartScreen appears, click More info, then Run anyway.",
  },
} as const;

export const whatsNewCopy = {
  title: (version: string) => `What's new in Kamapathy ${version}`,
  agents: "For your agents",
  steps: "After updating",
  gotIt: "Got it",
  releaseNotes: "Release notes",
} as const;
