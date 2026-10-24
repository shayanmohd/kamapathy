export const actionNames = [
  "new-tab",
  "close-tab",
  "reopen-tab",
  "command",
  "address",
  "find",
  "bookmark",
  "reload",
  "space",
  "spaces",
  "split",
  "settings",
  "bookmarks",
  "history",
  "downloads",
  "passwords",
  "extensions",
  "next-tab",
  "previous-tab",
  "screenshot",
  "devtools",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "agent-setup",
  "help",
  "report-issue",
  "privacy",
  "whats-new",
] as const;
export type ActionName = (typeof actionNames)[number];

export function isActionName(value: string): value is ActionName {
  return (actionNames as readonly string[]).includes(value);
}

// The ⋯ menu in order; null draws a divider.
export const toolsMenuLayout = [
  "new-tab",
  "space",
  "command",
  null,
  "bookmarks",
  "history",
  "downloads",
  "passwords",
  "extensions",
  null,
  "split",
  "find",
  "settings",
  "agent-setup",
  "help",
] as const satisfies readonly (ActionName | null)[];
export type ToolsMenuAction = Exclude<(typeof toolsMenuLayout)[number], null>;

// The command palette's commands in order.
export const paletteActions = [
  "new-tab",
  "split",
  "space",
  "spaces",
  "bookmarks",
  "history",
  "downloads",
  "settings",
  "screenshot",
  "devtools",
  "zoom-in",
  "zoom-out",
  "zoom-reset",
  "agent-setup",
  "help",
  "report-issue",
  "privacy",
] as const satisfies readonly ActionName[];
