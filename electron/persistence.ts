import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SAVED_SITE_PERMISSIONS } from "../shared/permissions";
import { restoreState } from "../shared/restore";
import type { BrowserState } from "../shared/types";
import { isFileUrl } from "../shared/url";
export { validSettings } from "../shared/restore";

export function readState(
  path: string,
  platform: BrowserState["platform"],
  version: string,
): BrowserState {
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    /* Start fresh. */
  }
  return restoreState(saved, platform, version);
}

export function writeState(path: string, state: BrowserState): void {
  // Labels, origins, budgets, grants and other agent state live for one run,
  // so only these fields are written.
  const spaces = state.spaces
    .filter((space) => space.kind === "personal")
    .map(({ id, name, color, kind, owner, signIns, createdAt }) => ({
      id,
      name,
      color,
      kind,
      owner,
      signIns,
      createdAt,
    }));
  const ids = new Set(spaces.map((space) => space.id));
  // Files on this computer are never written down.
  const tabs = state.tabs
    .filter((tab) => ids.has(tab.spaceId) && !isFileUrl(tab.url))
    .map(({ id, spaceId, title, url, pinned }) => ({
      id,
      spaceId,
      title,
      url,
      pinned,
    }));
  const activeSpaceId = ids.has(state.activeSpaceId)
    ? state.activeSpaceId
    : spaces[0]?.id;
  const activeTabId =
    tabs.find((tab) => tab.id === state.activeTabId)?.id ??
    tabs.find((tab) => tab.spaceId === activeSpaceId)?.id;
  // Of the update state, only the last check's result outlives a run.
  const { checkedAt, latest } = state.update;
  // The person's own answers, for the spaces this save keeps.
  const sitePermissions = state.sitePermissions
    .filter((item) => ids.has(item.spaceId))
    .slice(-SAVED_SITE_PERMISSIONS);
  const payload = {
    spaces,
    tabs,
    activeSpaceId,
    activeTabId,
    bookmarks: state.bookmarks,
    history: state.history,
    sitePermissions,
    settings: state.settings,
    update: { checkedAt, latest },
  };
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(payload, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}
