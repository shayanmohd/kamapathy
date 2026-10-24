// New interface text lives here so renaming the product touches one file.
import type { ImportErrorCode } from "../shared/types";

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
  extensions: "Extensions",
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
  background:
    "While agents are working, closing the window keeps Kamapathy running. Quit to stop them.",
  import: "Import bookmarks and history",
  importNote:
    "Bring your bookmarks, history and sign-ins over from another browser on this computer.",
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
  description: "A calm browser you share with your agents.",
  spacesCard:
    "Your spaces: tabs you browse yourself. Agents never see them unless you share a space.",
  agentsCard:
    "Agent spaces: where agents work, in plain view. Take over whenever you like.",
  start: "Get started",
  privacyTitle: "Your data stays here",
  privacy:
    "History, bookmarks, passwords and site data stay on this computer. There is no account and no telemetry.",
  importTitle: "Bring your browser with you",
  importDescription:
    "Bring your bookmarks, history and, if you like, your sign-ins from another browser on this computer.",
  agentsTitle: "Connect your agent",
  agentsLater: "Set up later",
  agentsElsewhere:
    "You can connect an agent any time from Settings, under Agents.",
  signInTitle: "Sign in once",
  signInDescription:
    "Kamapathy shares your sign-ins across your spaces and with your agents, so a site you sign in to here works everywhere. Any space can keep separate sign-ins, and Settings can isolate agent spaces.",
  finishTitle: "You're all set",
  finish: "Start browsing, or ask your agent to use Kamapathy.",
  startBrowsing: "Start browsing",
  next: "Next",
  back: "Back",
  step: (n: number) => `Step ${n} of 6`,
  sites: "Your sites",
  open: "Open",
  opened: "Opened",
  noSites:
    "Open the sites you use most and sign in. Your agents can then use them too.",
} as const;

export const signInNoticeCopy = {
  heading: "Google rejected this sign-in.",
  elsewhere:
    "Continue in your default browser, or sign in there and import the sign-in.",
  whenDefault: "Sign in with another browser, then import the sign-in here.",
  open: "Open in default browser",
  importSignIns: "Import sign-ins...",
  copyLink: "Copy link",
  copied: "Link copied.",
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
  allProfiles: "All profiles",
  signIns: "Sign-ins (cookies)",
  signInsHint:
    "Sign-ins come from Chrome, Chromium, Edge, Brave, Arc, Vivaldi and Opera.",
  sharedChoice: "Add them to your shared sign-ins",
  sharedNote:
    "These sign-ins will work in every space that shares your sign-ins, and for agents there.",
  separateChoice: "A new space for each profile",
  separateNote:
    "Each profile gets a personal space of its own, with sign-ins kept apart from your other spaces.",
  keychainNote:
    "macOS asks for your password once for each browser, so Kamapathy can read its sign-ins.",
  needsPermission: "Needs permission",
  permission: "Kamapathy needs permission to read this browser's data.",
  openSettings: "Open system settings",
  safariTitle: "Safari",
  safariSteps:
    "In Safari, choose File > Export Browsing Data to File. Then choose that .zip file here, or drop it on this box.",
  chooseZip: "Choose .zip file",
  dropZip: "Drop the Safari .zip file here",
  tooLarge: "That file is larger than 16 MB. Choose the file Safari exported.",
  done: (bookmarks: number, history: number, signIns?: number) => {
    const counted = `Imported ${bookmarks} ${bookmarks === 1 ? "bookmark" : "bookmarks"}`;
    const sites = `${history} ${history === 1 ? "site" : "sites"}`;
    if (signIns === undefined) return `${counted} and ${sites}.`;
    return `${counted}, ${sites} and ${signIns} ${signIns === 1 ? "sign-in" : "sign-ins"}.`;
  },
  spaces: (names: string[]) => `New spaces: ${names.join(", ")}.`,
  errors: {
    import_invalid_request: "Something was wrong with that import. Try again.",
    source_not_found: "That browser was not found on this computer.",
    profile_not_found: "That profile was not found.",
    import_busy: "An import is already running.",
    read_blocked: "Kamapathy needs permission to read this browser's data.",
    keychain_denied:
      "Kamapathy could not get the sign-in key from your keychain.",
    cookies_unavailable:
      "Sign-ins from this browser could not be imported on this system.",
    invalid_archive: "That is not the file Safari exported. Choose it again.",
  } satisfies Record<ImportErrorCode, string>,
} as const;

export const agentBarCopy = {
  status: {
    browsing: "Agent is browsing",
    idle: "Agent is idle",
    paused: "Agent access is off",
    "in-control": "You're in control",
    "needs-you": "You're in control",
    done: "Agent is done",
    stopped: "You stopped the agent",
    failed: "Agent could not finish",
    error: "A page stopped working",
  },
  // What the bar says for needs-you while the agent still has the space.
  agentNeedsYou: "Agent needs you",
  takeOver: "Take over",
  letContinue: "Let agent continue",
  stop: "Stop",
  stopAll: "Stop all agents",
  confirmStop: "Stop the agent in this space?",
  cancel: "Cancel",
  keep: "Keep as personal space",
  keepWarning: "Its temporary sign-ins end and its pages reload.",
} as const;

// The one phrase the bar announces. The agent's own words never join it;
// they follow in the status line.
export function agentBarPhrase(
  status: keyof typeof agentBarCopy.status,
  agentOwns: boolean,
): string {
  return status === "needs-you" && agentOwns
    ? agentBarCopy.agentNeedsYou
    : agentBarCopy.status[status];
}

export const spacesCopy = {
  menu: "Spaces",
  button: (
    space: string,
    working: number,
    needsYou: boolean,
    failed: boolean,
  ) =>
    [
      `Spaces: ${space}`,
      working ? `${working} ${working === 1 ? "agent" : "agents"} working` : "",
      needsYou ? "an agent needs you" : "",
      failed ? "an agent could not finish" : "",
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
  done: "Done",
  stopped: "You stopped the agent",
  failed: "Failed",
  error: "Page stopped",
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

export const extensionRefusalCopy = {
  version: "It was made for an older version of Chrome.",
  themeOrApp: "Themes and apps aren't supported.",
  chrome: "It needs a newer version of Chrome.",
  component: "Its ID is already used by Kamapathy.",
  limit: "Kamapathy supports up to 100 extensions.",
  invalid: "Its manifest isn't valid.",
  noManifest: "That folder has no manifest.json.",
  loadFailed: "Couldn't load it.",
} as const;

export const extensionInstallCopy = {
  consentTitle: (name: string) => `Add "${name}"?`,
  agentSpaces: "It also runs in agent spaces that share your sign-ins.",
  wontWork: (names: readonly string[]) =>
    `Won't work in Kamapathy: ${names.join(", ")}.`,
  cancel: "Cancel",
  add: "Add extension",
  notInStore: "It isn't in the Chrome Web Store.",
  failedChecks: "The download didn't pass Kamapathy's checks.",
  downloadFailed: "Kamapathy couldn't download it. Try again.",
  alreadyAdded: "It's already added.",
  couldNotAdd: (name: string, message: string) =>
    `Couldn't add ${name}. ${message}`,
  invalidInput: "Paste a Chrome Web Store link or a 32-letter ID.",
} as const;

export const extensionRemoveCopy = {
  title: (name: string) => `Remove "${name}"?`,
  detail: "Its data in Kamapathy is deleted.",
  cancel: "Cancel",
  remove: "Remove",
  chooseFolder: "Load unpacked",
  developerModeOff: "Turn on developer mode to load a folder.",
  pinLimit: "You can pin up to 8 extensions.",
  folderChanged: "Its folder changed. Load it again.",
} as const;

export const extensionBridgeCopy = {
  notSupported: "Not supported in Kamapathy.",
  tooLarge: "This request is too large.",
  invalid: (name: string) => `The arguments for ${name} aren't valid.`,
  failed: "Kamapathy couldn't do that. Try again.",
  noTab: (id: number) => `No tab with id: ${id}.`,
  noWindow: (id: number) => `No window with id: ${id}.`,
  cantCapture: "This extension can't capture this tab.",
  notShown: "Only the shown space can be captured.",
  cantOpen: "Extensions can't open this URL.",
  noSpace: "Open a space that runs this extension first.",
  agentTab: "An agent is using this tab.",
  cantClose: "This window can't be closed by an extension.",
  tooManyWindows: "This extension already has 4 windows open.",
  noOptions: "This extension has no options page.",
  iconTooLarge: "Icons can be at most 128 pixels.",
  notFocused: "Kamapathy's window isn't in front.",
  noPopup: "This extension has no popup.",
} as const;

export const extensionsCopy = {
  title: "Extensions",
  note: "Extensions run in your spaces and in agent spaces that share your sign-ins. They never run in isolated spaces.",
  storeLabel: "Add from Chrome Web Store",
  storePlaceholder: "Paste a store link or ID",
  add: "Add",
  adding: "Adding...",
  added: "Added",
  loadUnpacked: "Load unpacked",
  sourceStore: "Chrome Web Store",
  sourceUnpacked: "Unpacked",
  sourceImported: (browser: string) => `From ${browser}`,
  can: "It can",
  wontWork: "Won't work in Kamapathy",
  pin: "Pin to toolbar",
  options: "Options",
  reload: "Reload",
  remove: "Remove",
  turnOn: (name: string) => `Turn ${name} on or off`,
  needsOk: "Needs your OK to update",
  review: "Review",
  staged: (version: string) =>
    `Version ${version} installs when Kamapathy restarts.`,
  updateFailed: "The last update didn't pass Kamapathy's checks.",
  needsDeveloperMode: "Turn on developer mode to use this.",
  empty: "No extensions yet. Add one from the Chrome Web Store.",
  puzzle: "Extensions",
  manage: "Manage extensions",
  isolated: "Extensions don't run in isolated spaces.",
  agent: "An agent is working here. Take control to use extensions.",
  chip: "Add to Kamapathy",
  settingsTitle: "Extensions",
  updates: "Update extensions automatically",
  updatesHint: "Checks the Chrome Web Store once a day.",
  developer: "Developer mode",
  developerHint: "Load extensions from a folder.",
  desktopOnly: "This feature is available in the desktop app.",
  details: (name: string) => `About ${name}`,
} as const;

export const fileCopy = {
  icon: "File on this computer",
  scriptsOff: "Scripts are off for files on this computer.",
} as const;

export const defaultBrowserCopy = {
  label: "Default browser",
  isDefault: "Kamapathy is your default browser.",
  available: "Open links from other apps in Kamapathy.",
  make: "Make default",
  development: "Available in the installed app.",
  diskImage: "Move Kamapathy to Applications first.",
  portable: "Available when Kamapathy is installed.",
  linuxNotInstalled: "Install the .deb package to use this.",
  windowsNotInstalled: "Reinstall Kamapathy to use this.",
  choice: "Make Kamapathy your default browser",
  macConfirm: "macOS asks you to confirm.",
  windowsSettings: "Windows opens Settings so you can choose Kamapathy.",
} as const;
export const promptBarCopy = {
  location: "{origin} wants to know your location",
  notifications: "{origin} wants to show notifications",
  camera: "{origin} wants to use your camera",
  microphone: "{origin} wants to use your microphone",
  camera_microphone: "{origin} wants to use your camera and microphone",
  midi: "{origin} wants to use your MIDI devices",
  usb: "{origin} wants to connect to a USB device",
  hid: "{origin} wants to connect to a device",
  serial: "{origin} wants to connect to a serial port",
  bluetooth: "{origin} wants to connect to a Bluetooth device",
  other: "{origin} wants a browser permission",
  block: "Block",
  allow: "Allow",
  connect: "Connect",
  noDevices: "No devices found.",
  signIn: "Sign in to {host}",
  realm: 'The site says "{realm}"',
  retry: "That didn't work. Try again.",
  username: "Username",
  password: "Password",
  certificate: "{host} asks for a certificate",
  dontSend: "Don't send",
  agentWaiting: "The agent is waiting for you.",
  remembered: "Kamapathy remembers this for {space}.",
  // The oldest request is on screen; the rest wait their turn.
  count: (total: number) => `1 of ${total}`,
  devices: "Devices",
  certificates: "Certificates",
} as const;

export const sitePermissionsCopy = {
  title: "Site permissions",
  note: "Remove one to be asked again.",
  remove: "Remove",
  removeAll: "Remove all",
  empty: "Sites you answer will appear here.",
  allowed: "Allowed",
  blocked: "Blocked",
  removeOne: (permission: string, origin: string) =>
    `Remove ${permission} for ${origin}`,
} as const;
