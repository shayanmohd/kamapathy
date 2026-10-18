// New interface text lives here so renaming the product touches one file.
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
  importNote: "Bring them over from another browser on this computer.",
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
} as const;
