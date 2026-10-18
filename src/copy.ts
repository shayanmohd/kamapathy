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
  split: "Split view",
  find: "Find",
  settings: "Settings",
} as const;

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
  importNote:
    "Bring your bookmarks, history and sign-ins over from another browser on this computer.",
  importButton: "Import...",
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
