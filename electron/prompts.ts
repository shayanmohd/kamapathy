import { randomUUID } from "node:crypto";
import type { Session, WebContents } from "electron";
import { cleanAgentText } from "../shared/agent-text";
import { agentRules } from "../shared/state";
import {
  HOLDABLE,
  permissionKeysFor,
  permissionWords,
  promptKindFor,
  type PermissionKey,
  type PromptKind,
} from "../shared/permissions";
import type {
  BrowserState,
  HoldReason,
  PendingPrompt,
  PromptAnswer,
  Space,
  Tab,
} from "../shared/types";
import { isWebUrl } from "../shared/url";
import { REQUEST_WINDOW_MS } from "./agent/receipts";

export const PROMPT_LIMIT = 8; // held prompts per space
export const SITE_PERMISSIONS = 1000; // saved decisions kept
// The most of a site's own words any prompt shows.
const ORIGIN_TEXT = 120;

export interface PromptHost {
  readonly state: BrowserState;
  spaceOf(contents: WebContents | null): Space | undefined;
  tabOf(contents: WebContents | null): Tab | undefined;
  agentControlled(tabId: string): boolean;
  holdForPerson(spaceId: string, reason: HoldReason, prompt: string): string;
  releaseHold(holdId: string): void;
  addActivity(
    spaceId: string | undefined,
    message: string,
    kind: "info" | "success" | "warning",
  ): void;
  emit(): void;
}
export interface PromptReceipts {
  reportDenied(
    tabId: string,
    denied: { origin: string; permission: string },
  ): boolean;
}
export interface PromptCenter {
  /** Installs the permission handlers on a partition's session. */
  attachSession(browsingSession: Session): () => void;
  /** The receipt wrapper's signals, from electron/agent/receipts.ts. */
  routeStarted(tabId: string): void;
  routeEnded(tabId: string): void;
  /** The agent server hands over its receipt sink while it runs. */
  setReceipts(receipts: PromptReceipts | null): void;
  answer(answer: PromptAnswer): void;
  prompts(): PendingPrompt[];
  /** The tab holding the space's oldest prompt, for space:activate. */
  oldestPromptTab(spaceId: string): string | undefined;
  removeSitePermission(key: {
    spaceId: string;
    origin: string;
    permission: PermissionKey;
  }): void;
  clearSitePermissions(): void;
  /** A space closed, its access ended, or agent access went off. */
  clearSpace(spaceId: string): void;
  clearAll(): void;
}

// A request the person has not answered yet: the prompt they see, the keys
// it would decide, the page's callback and the listeners that end it.
interface Waiting {
  prompt: PendingPrompt;
  origin: string;
  keys: PermissionKey[];
  answer(allow: boolean): void;
  // Whether it counts against the space's hold.
  held: boolean;
  drop(): void;
}
// A tab's request window: how many routes are running on it and when its
// tail ends.
interface Window {
  open: number;
  until: number;
  timer?: ReturnType<typeof setTimeout>;
}

const once = (callback: (allow: boolean) => void) => {
  let answered = false;
  return (allow: boolean) => {
    if (answered) return;
    answered = true;
    callback(allow);
  };
};
const words = (value: string) => cleanAgentText(value).slice(0, ORIGIN_TEXT);

// Every request only the person can answer goes through here. A saved
// decision answers first; inside an agent route's request window the space
// is held for the person, and outside it the request is refused and the
// agent is told. Agents never answer anything themselves.
export function createPromptCenter(
  host: PromptHost,
  options: { now?(): number } = {},
): PromptCenter {
  const now = options.now ?? Date.now;
  const waiting = new Map<string, Waiting>();
  // The hold each space is under while it has a held prompt.
  const holds = new Map<string, string>();
  // An agent space's decisions, as "spaceId|origin|permission". They never
  // reach the state or the disk and die with the space.
  const kept = new Map<string, boolean>();
  const windows = new Map<string, Window>();
  let receipts: PromptReceipts | null = null;

  const publish = () => {
    host.state.prompts = [...waiting.values()].map((item) => item.prompt);
    host.emit();
  };
  const saveKey = (
    spaceId: string,
    origin: string,
    permission: PermissionKey,
  ) => `${spaceId}|${origin}|${permission}`;
  const decision = (
    space: Space,
    origin: string,
    permission: PermissionKey,
  ): boolean | undefined => {
    if (space.kind !== "personal")
      return kept.get(saveKey(space.id, origin, permission));
    return host.state.sitePermissions.find(
      (item) =>
        item.spaceId === space.id &&
        item.origin === origin &&
        item.permission === permission,
    )?.allow;
  };
  // What a saved decision answers, when every requested permission has one.
  // A single Block answers no.
  const decided = (
    space: Space,
    origin: string,
    keys: readonly PermissionKey[],
  ): boolean | undefined => {
    const answers = keys.map((key) => decision(space, origin, key));
    if (answers.some((answer) => answer === undefined)) return undefined;
    return answers.every((answer) => answer === true);
  };
  const remember = (
    space: Space,
    origin: string,
    keys: readonly PermissionKey[],
    allow: boolean,
  ) => {
    if (space.kind !== "personal") {
      for (const key of keys) kept.set(saveKey(space.id, origin, key), allow);
      return;
    }
    const rows = host.state.sitePermissions.filter(
      (item) =>
        !(
          item.spaceId === space.id &&
          item.origin === origin &&
          keys.includes(item.permission)
        ),
    );
    for (const key of keys)
      rows.push({
        spaceId: space.id,
        origin,
        permission: key,
        allow,
        at: now(),
      });
    host.state.sitePermissions = rows.slice(-SITE_PERMISSIONS);
  };

  const inWindow = (tabId: string) => {
    const record = windows.get(tabId);
    return record ? record.open > 0 || record.until > now() : false;
  };
  // Control returns to the agent once the space's last held prompt is gone.
  const release = (spaceId: string) => {
    const hold = holds.get(spaceId);
    if (!hold) return;
    for (const item of waiting.values())
      if (item.held && item.prompt.spaceId === spaceId) return;
    holds.delete(spaceId);
    host.releaseHold(hold);
  };
  const end = (id: string, allow: boolean, save = false) => {
    const item = waiting.get(id);
    if (!item) return;
    waiting.delete(id);
    item.drop();
    const space = host.state.spaces.find(
      (entry) => entry.id === item.prompt.spaceId,
    );
    if (save && space) remember(space, item.origin, item.keys, allow);
    item.answer(allow);
    release(item.prompt.spaceId);
    publish();
  };
  // A request the agent's own route did not make, or one no space ever
  // grants: the page is told no, and the agent learns the origin and the
  // permission from its next receipt.
  const refuse = (
    space: Space,
    tab: Tab,
    origin: string,
    kind: PromptKind,
    driven: boolean,
    answer: (allow: boolean) => void,
  ) => {
    answer(false);
    // Only a space an agent drives has receipts to carry the refusal.
    if (!receipts || !driven) return;
    if (receipts.reportDenied(tab.id, { origin, permission: kind }))
      host.addActivity(
        space.id,
        `A site's request for ${permissionWords(kind)} was refused.`,
        "warning",
      );
  };
  // Whether an agent is driving this space now: it owns the space under
  // agent rules and its access has not ended, or the space is held for the
  // person by a prompt of this center rather than by a takeover. The
  // person's own tabs in such a space follow it, so a site cannot interrupt
  // them while an agent works.
  const driving = (space: Space, tab: Tab) => {
    if (host.agentControlled(tab.id)) return true;
    if (
      space.owner === "agent" &&
      space.access !== "ended" &&
      agentRules(space)
    )
      return true;
    const hold = holds.get(space.id);
    return hold !== undefined && space.control?.hold === hold;
  };
  const originOf = (url: string | undefined): string | undefined => {
    if (!url || !isWebUrl(url)) return undefined;
    return new URL(url).origin;
  };

  const onRequest = (
    contents: WebContents | null,
    permission: string,
    callback: (allow: boolean) => void,
    details: {
      requestingUrl?: string;
      securityOrigin?: string;
      mediaTypes?: readonly string[];
    },
  ) => {
    const answer = once(callback);
    const tab = host.tabOf(contents);
    const space = host.spaceOf(contents);
    if (!contents || contents.isDestroyed() || !tab || !space) {
      answer(false);
      return;
    }
    const keys = permissionKeysFor(permission, {
      mediaTypes: details.mediaTypes,
    });
    const origin = originOf(
      (permission === "media" ? details.securityOrigin : undefined) ||
        details.requestingUrl ||
        contents.getURL(),
    );
    if (!keys || !origin) {
      answer(false);
      return;
    }
    const kind = promptKindFor(keys);
    const saved = decided(space, origin, keys);
    if (saved !== undefined) {
      answer(saved);
      return;
    }
    const agent = driving(space, tab);
    // In an agent tab only the five holdable permissions, asked inside the
    // window of a route, reach the person.
    if (
      agent &&
      (!keys.every((key) => HOLDABLE.includes(key)) || !inWindow(tab.id))
    ) {
      refuse(space, tab, origin, kind, agent, answer);
      return;
    }
    let pending = 0;
    for (const item of waiting.values())
      if (item.prompt.spaceId === space.id) pending += 1;
    if (pending >= PROMPT_LIMIT) {
      refuse(space, tab, origin, kind, agent, answer);
      return;
    }
    const prompt: PendingPrompt = {
      id: randomUUID(),
      spaceId: space.id,
      tabId: tab.id,
      kind,
      origin: words(origin),
      at: now(),
      agent,
    };
    if (agent && !holds.has(space.id))
      holds.set(space.id, host.holdForPerson(space.id, "permission", kind));
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ) => {
      if (event.isMainFrame && !event.isSameDocument) end(prompt.id, false);
    };
    const onGone = () => end(prompt.id, false);
    contents.on("did-start-navigation", onNavigation);
    contents.once("destroyed", onGone);
    waiting.set(prompt.id, {
      prompt,
      origin,
      keys,
      answer,
      held: agent,
      drop() {
        contents.removeListener("did-start-navigation", onNavigation);
        contents.removeListener("destroyed", onGone);
      },
    });
    publish();
  };

  // Whether a permission the page already asked for is granted now. Only a
  // saved decision says yes, and only inside its own space.
  const onCheck = (
    contents: WebContents | null,
    permission: string,
    origin: string,
    details: { mediaType?: string },
  ) => {
    const space = host.spaceOf(contents);
    const keys = permissionKeysFor(permission, {
      mediaType: details.mediaType,
    });
    const web = originOf(origin);
    if (!space || !keys || !web) return false;
    return decided(space, web, keys) === true;
  };

  const forget = (spaceId: string | undefined) => {
    for (const [id, item] of [...waiting]) {
      if (spaceId !== undefined && item.prompt.spaceId !== spaceId) continue;
      waiting.delete(id);
      item.drop();
      item.answer(false);
    }
    for (const [space, hold] of [...holds]) {
      if (spaceId !== undefined && space !== spaceId) continue;
      holds.delete(space);
      host.releaseHold(hold);
    }
    for (const key of [...kept.keys()])
      if (spaceId === undefined || key.startsWith(`${spaceId}|`))
        kept.delete(key);
  };

  return {
    attachSession(browsingSession) {
      let live = true;
      browsingSession.setPermissionCheckHandler((...args) =>
        live ? onCheck(...args) : false,
      );
      browsingSession.setPermissionRequestHandler(
        (contents, permission, callback, requestDetails) => {
          if (!live) {
            callback(false);
            return;
          }
          onRequest(contents, permission, callback, {
            requestingUrl: requestDetails.requestingUrl,
            ...("securityOrigin" in requestDetails
              ? { securityOrigin: requestDetails.securityOrigin }
              : {}),
            ...("mediaTypes" in requestDetails
              ? { mediaTypes: requestDetails.mediaTypes }
              : {}),
          });
        },
      );
      return () => {
        live = false;
        browsingSession.setPermissionCheckHandler(() => false);
        browsingSession.setPermissionRequestHandler(
          (_contents, _permission, callback) => callback(false),
        );
      };
    },
    routeStarted(tabId) {
      let record = windows.get(tabId);
      if (!record) {
        record = { open: 0, until: 0 };
        windows.set(tabId, record);
      }
      record.open += 1;
      if (record.timer) {
        clearTimeout(record.timer);
        delete record.timer;
      }
    },
    routeEnded(tabId) {
      const record = windows.get(tabId);
      if (!record) return;
      record.open = Math.max(0, record.open - 1);
      if (record.open > 0) return;
      record.until = now() + REQUEST_WINDOW_MS;
      record.timer = setTimeout(() => {
        delete record.timer;
        if (record.open === 0 && windows.get(tabId) === record)
          windows.delete(tabId);
      }, REQUEST_WINDOW_MS);
    },
    setReceipts(sink) {
      receipts = sink;
    },
    answer(answer) {
      if (typeof answer?.id !== "string") return;
      end(answer.id, answer.allow === true, true);
    },
    prompts() {
      return [...waiting.values()].map((item) => item.prompt);
    },
    oldestPromptTab(spaceId) {
      for (const item of waiting.values())
        if (item.prompt.spaceId === spaceId && item.prompt.tabId)
          return item.prompt.tabId;
      return undefined;
    },
    removeSitePermission({ spaceId, origin, permission }) {
      host.state.sitePermissions = host.state.sitePermissions.filter(
        (item) =>
          !(
            item.spaceId === spaceId &&
            item.origin === origin &&
            item.permission === permission
          ),
      );
      publish();
    },
    clearSitePermissions() {
      host.state.sitePermissions = [];
      publish();
    },
    clearSpace(spaceId) {
      forget(spaceId);
      // A space that is gone keeps no decisions either.
      if (!host.state.spaces.some((space) => space.id === spaceId))
        host.state.sitePermissions = host.state.sitePermissions.filter(
          (item) => item.spaceId !== spaceId,
        );
      publish();
    },
    clearAll() {
      forget(undefined);
      for (const record of windows.values())
        if (record.timer) clearTimeout(record.timer);
      windows.clear();
      receipts = null;
      publish();
    },
  };
}
