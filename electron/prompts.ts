import { randomUUID } from "node:crypto";
import type { Session, WebContents, WebFrameMain } from "electron";
import { cleanAgentText } from "../shared/agent-text";
import { agentRules } from "../shared/state";
import {
  DEVICE_KINDS,
  HOLDABLE,
  permissionKeysFor,
  permissionWords,
  promptKindFor,
  SAVED_SITE_PERMISSIONS,
  type DeviceKind,
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

export type { DeviceKind };
export const PROMPT_LIMIT = 8; // held prompts per space
export const CREDENTIAL_ORIGINS = 8; // origins an agent space may store
// The most of a site's own words any prompt shows.
const ORIGIN_TEXT = 120;
// The chooser kinds Kamapathy opens. Electron 44.2.0 emits no
// select-serial-port and blocks the main process for the whole time a serial
// or Bluetooth request is pending, so those two are refused instead of asked
// (phase 6 Verify first 7).
const CHOOSABLE: readonly DeviceKind[] = ["usb", "hid"];

/** What an agent space answers one server challenge from one origin with. */
export interface HttpCredentials {
  origin: string;
  username: string;
  password: string;
}

export interface PromptHost {
  readonly state: BrowserState;
  spaceOf(contents: WebContents | null): Space | undefined;
  tabOf(contents: WebContents | null): Tab | undefined;
  agentControlled(tabId: string): boolean;
  /** webContents.fromFrame, which only the main process can call. */
  contentsForFrame(frame: WebFrameMain | null): WebContents | null;
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
  /** Installs the permission and device handlers on a partition's session. */
  attachSession(browsingSession: Session): () => void;
  /** Installs the device handlers on a partition's session; part of
   *  attachSession's disposer, exported for the tests. */
  attachDevices(browsingSession: Session): () => void;
  /** Installs the Bluetooth chooser, which a page's contents owns. */
  attachBluetooth(contents: WebContents): void;
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
  /** A tab's login event. True when Kamapathy answered or held it, so the
   *  caller calls preventDefault. False leaves Electron's own default, which
   *  cancels the challenge. */
  tabLogin(
    contents: WebContents | null,
    details: {
      url: string;
      isMainFrame?: boolean;
      isRequestForNavigation?: boolean;
      firstAuthAttempt?: boolean;
    },
    authInfo: {
      isProxy: boolean;
      scheme: string;
      host: string;
      port: number;
      realm: string;
    },
    callback: (username?: string, password?: string) => void,
  ): boolean;
  /** app login, for requests with no WebContents: cancelled. */
  appLogin(callback: (username?: string, password?: string) => void): void;
  selectClientCertificate(
    contents: WebContents | null,
    url: string,
    list: Electron.Certificate[],
    callback: (certificate?: Electron.Certificate) => void,
  ): void;
  /** Memory only, never returned, logged or persisted. */
  setHTTPCredentials(
    spaceId: string,
    credentials: HttpCredentials | null,
  ): void;
  /** Every space's credentials: the agent server stopped. */
  clearCredentials(): void;
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
  answer(allow: boolean, choice?: PromptAnswer): void;
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
// One device row the bar shows, with the id Electron answers the chooser by.
interface Device {
  id: string;
  name: string;
  electronId: string;
}
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
  // The device list and page behind each waiting chooser, by prompt id.
  const choosers = new Map<
    string,
    { kind: DeviceKind; contents: WebContents; devices: Device[] }
  >();
  // One device a person connected, for this app run only. The partition is
  // what Electron asks about later, since its device handler names no page.
  const grants: {
    browsingSession: Session;
    spaceId: string;
    origin: string;
    kind: DeviceKind;
    deviceId: string;
  }[] = [];
  // What a space may answer one challenge with, per origin in the order they
  // were stored. Memory only: nothing here is published, logged or written.
  const credentials = new Map<
    string,
    Map<string, { username: string; password: string }>
  >();
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
    host.state.sitePermissions = rows.slice(-SAVED_SITE_PERMISSIONS);
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
  const end = (
    id: string,
    allow: boolean,
    save = false,
    choice?: PromptAnswer,
  ) => {
    const item = waiting.get(id);
    if (!item) return;
    waiting.delete(id);
    item.drop();
    const space = host.state.spaces.find(
      (entry) => entry.id === item.prompt.spaceId,
    );
    if (save && space) remember(space, item.origin, item.keys, allow);
    item.answer(allow, choice);
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
  const hostOf = (url: string | undefined): string | undefined => {
    const origin = originOf(url);
    return origin ? new URL(origin).hostname : undefined;
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
    // A device chooser asks here before it opens. Kamapathy lets the kinds
    // it can show through to the chooser, where the person decides, and
    // answers no for the rest, which cancels the request with no prompt.
    if (DEVICE_KINDS.includes(permission as DeviceKind)) {
      if (!CHOOSABLE.includes(permission as DeviceKind)) return false;
      return Boolean(host.tabOf(contents) && host.spaceOf(contents));
    }
    const space = host.spaceOf(contents);
    const keys = permissionKeysFor(permission, {
      mediaType: details.mediaType,
    });
    const web = originOf(origin);
    if (!space || !keys || !web) return false;
    return decided(space, web, keys) === true;
  };

  const usbRow = (device: Electron.USBDevice): Device => ({
    id: `${device.vendorId}:${device.productId}:${device.deviceId}`,
    name: words(device.productName || "USB device"),
    electronId: device.deviceId,
  });
  const hidRow = (device: Electron.HIDDevice): Device => ({
    id: device.deviceId,
    name: words(device.name || "Device"),
    electronId: device.deviceId,
  });
  const bluetoothRow = (device: Electron.BluetoothDevice): Device => ({
    id: device.deviceId,
    name: words(device.deviceName || "Bluetooth device"),
    electronId: device.deviceId,
  });

  // A site asked for a device. The person always chooses, in an agent tab as
  // in their own, and exactly the device they pick is granted.
  const openChooser = (
    kind: DeviceKind,
    browsingSession: Session | null,
    contents: WebContents | null,
    devices: Device[],
    choose: (deviceId: string) => void,
  ) => {
    let chosen = false;
    const answerChooser = (deviceId: string) => {
      if (chosen) return;
      chosen = true;
      choose(deviceId);
    };
    const tab = host.tabOf(contents);
    const space = host.spaceOf(contents);
    if (!contents || contents.isDestroyed() || !tab || !space) {
      answerChooser("");
      return;
    }
    const origin = originOf(contents.getURL());
    if (!origin) {
      answerChooser("");
      return;
    }
    const agent = driving(space, tab);
    let pending = 0;
    for (const item of waiting.values())
      if (item.prompt.spaceId === space.id) pending += 1;
    if (!CHOOSABLE.includes(kind) || pending >= PROMPT_LIMIT) {
      refuse(space, tab, origin, kind, agent, () => answerChooser(""));
      return;
    }
    const live = [...devices];
    const prompt: PendingPrompt = {
      id: randomUUID(),
      spaceId: space.id,
      tabId: tab.id,
      kind,
      origin: words(origin),
      at: now(),
      agent,
      devices: live.map(({ id, name }) => ({ id, name })),
    };
    if (agent && !holds.has(space.id))
      holds.set(space.id, host.holdForPerson(space.id, "device", kind));
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
      keys: [],
      answer(allow, choice) {
        // A device that left the list while the person read it is gone.
        const picked = allow
          ? live.find((device) => device.id === choice?.deviceId)
          : undefined;
        if (!picked) {
          answerChooser("");
          return;
        }
        if (browsingSession)
          grants.push({
            browsingSession,
            spaceId: space.id,
            origin,
            kind,
            deviceId: picked.electronId,
          });
        answerChooser(picked.electronId);
      },
      held: agent,
      drop() {
        choosers.delete(prompt.id);
        contents.removeListener("did-start-navigation", onNavigation);
        contents.removeListener("destroyed", onGone);
      },
    });
    choosers.set(prompt.id, { kind, contents, devices: live });
    publish();
  };
  // A device appeared or went away while a chooser waited, so the bar's list
  // follows it.
  const updateDevices = (
    kind: DeviceKind,
    contents: WebContents | null,
    device: Device,
    added: boolean,
  ) => {
    for (const [id, chooser] of choosers) {
      if (chooser.kind !== kind) continue;
      if (contents && chooser.contents !== contents) continue;
      const rest = chooser.devices.filter((item) => item.id !== device.id);
      if (added) rest.push(device);
      chooser.devices.splice(0, chooser.devices.length, ...rest);
      const item = waiting.get(id);
      if (item)
        item.prompt.devices = chooser.devices.map(({ id: row, name }) => ({
          id: row,
          name,
        }));
    }
    publish();
  };
  // Whether a device the page already knows may be used: only one this
  // partition and origin were granted in this run, and no prompt here.
  const mayUseDevice = (
    browsingSession: Session,
    details: { deviceType: string; origin: string; device: unknown },
  ) => {
    const origin = originOf(details.origin);
    const device = details.device as { deviceId?: unknown };
    if (!origin || typeof device?.deviceId !== "string") return false;
    return grants.some(
      (grant) =>
        grant.browsingSession === browsingSession &&
        grant.origin === origin &&
        grant.kind === details.deviceType &&
        grant.deviceId === device.deviceId,
    );
  };
  const attachDevices = (browsingSession: Session) => {
    let live = true;
    const onUsb = (
      event: Electron.Event,
      details: { deviceList: Electron.USBDevice[]; frame: WebFrameMain | null },
      callback: (deviceId?: string) => void,
    ) => {
      event.preventDefault();
      if (!live) {
        callback("");
        return;
      }
      openChooser(
        "usb",
        browsingSession,
        host.contentsForFrame(details.frame),
        details.deviceList.map(usbRow),
        callback,
      );
    };
    const onHid = (
      event: Electron.Event,
      details: { deviceList: Electron.HIDDevice[]; frame: WebFrameMain | null },
      callback: (deviceId?: string | null) => void,
    ) => {
      event.preventDefault();
      if (!live) {
        callback("");
        return;
      }
      openChooser(
        "hid",
        browsingSession,
        host.contentsForFrame(details.frame),
        details.deviceList.map(hidRow),
        callback,
      );
    };
    const onUsbAdded = (
      _event: Electron.Event,
      device: Electron.USBDevice,
      contents: WebContents,
    ) => updateDevices("usb", contents, usbRow(device), true);
    const onUsbRemoved = (
      _event: Electron.Event,
      device: Electron.USBDevice,
      contents: WebContents,
    ) => updateDevices("usb", contents, usbRow(device), false);
    const onHidAdded = (
      _event: Electron.Event,
      details: { device: Electron.HIDDevice; frame: WebFrameMain | null },
    ) =>
      updateDevices(
        "hid",
        host.contentsForFrame(details.frame),
        hidRow(details.device),
        true,
      );
    const onHidRemoved = (
      _event: Electron.Event,
      details: { device: Electron.HIDDevice; frame: WebFrameMain | null },
    ) =>
      updateDevices(
        "hid",
        host.contentsForFrame(details.frame),
        hidRow(details.device),
        false,
      );
    browsingSession.on("select-usb-device", onUsb);
    browsingSession.on("select-hid-device", onHid);
    browsingSession.on("usb-device-added", onUsbAdded);
    browsingSession.on("usb-device-removed", onUsbRemoved);
    browsingSession.on("hid-device-added", onHidAdded);
    browsingSession.on("hid-device-removed", onHidRemoved);
    browsingSession.setDevicePermissionHandler((details) =>
      live ? mayUseDevice(browsingSession, details) : false,
    );
    // Kamapathy has no pairing screen, and the design grants only the
    // chooser, so every pairing request is refused.
    browsingSession.setBluetoothPairingHandler((_details, response) =>
      response({ confirmed: false }),
    );
    return () => {
      live = false;
      browsingSession.removeListener("select-usb-device", onUsb);
      browsingSession.removeListener("select-hid-device", onHid);
      browsingSession.removeListener("usb-device-added", onUsbAdded);
      browsingSession.removeListener("usb-device-removed", onUsbRemoved);
      browsingSession.removeListener("hid-device-added", onHidAdded);
      browsingSession.removeListener("hid-device-removed", onHidRemoved);
      browsingSession.setDevicePermissionHandler(null);
      browsingSession.setBluetoothPairingHandler(null);
    };
  };

  // One request only the person can answer, shown in the bar and, in a space
  // an agent drives, holding it until they answer. False when the space
  // already holds as many requests as it may.
  const raise = (
    space: Space,
    tab: Tab,
    contents: WebContents,
    kind: PromptKind,
    reason: HoldReason,
    fields: Partial<PendingPrompt>,
    answer: (allow: boolean, choice?: PromptAnswer) => void,
    origin: string,
  ): boolean => {
    const agent = driving(space, tab);
    let pending = 0;
    for (const item of waiting.values())
      if (item.prompt.spaceId === space.id) pending += 1;
    if (pending >= PROMPT_LIMIT) return false;
    const prompt: PendingPrompt = {
      id: randomUUID(),
      spaceId: space.id,
      tabId: tab.id,
      kind,
      at: now(),
      agent,
      ...fields,
    };
    if (agent && !holds.has(space.id))
      holds.set(space.id, host.holdForPerson(space.id, reason, kind));
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
      keys: [],
      answer,
      held: agent,
      drop() {
        contents.removeListener("did-start-navigation", onNavigation);
        contents.removeListener("destroyed", onGone);
      },
    });
    publish();
    return true;
  };

  // A server or proxy asked for a name and password. Only the person answers
  // one, unless the space stored credentials for exactly this origin.
  const tabLogin: PromptCenter["tabLogin"] = (
    contents,
    details,
    authInfo,
    callback,
  ) => {
    let answered = false;
    // Electron reads a callback with no name and password as a cancellation.
    const settle = (username?: string, password?: string) => {
      if (answered) return;
      answered = true;
      if (username === undefined) callback();
      else callback(username, password);
    };
    const tab = host.tabOf(contents);
    const space = host.spaceOf(contents);
    if (!contents || contents.isDestroyed() || !tab || !space) return false;
    // A challenge missing Chromium's own fields is read as a navigation,
    // which is the one the person is shown (phase 6 Verify first 8).
    const navigation = details.isRequestForNavigation !== false;
    // Something the page merely loaded, from another host, is a third
    // party's business and is cancelled without asking.
    if (
      !authInfo.isProxy &&
      !navigation &&
      authInfo.host !== hostOf(contents.getURL())
    )
      return false;
    const kind: PromptKind = authInfo.isProxy
      ? "proxy_sign_in"
      : "http_sign_in";
    const origin = originOf(details.url) ?? "";
    const stored = credentials.get(space.id);
    // Stored credentials answer one challenge from their own origin, in a
    // tab the agent has. A repeat, and every proxy, goes to the person.
    if (
      !authInfo.isProxy &&
      details.firstAuthAttempt !== false &&
      origin &&
      stored?.has(origin) &&
      host.agentControlled(tab.id)
    ) {
      const found = stored.get(origin)!;
      stored.delete(origin);
      settle(found.username, found.password);
      return true;
    }
    return raise(
      space,
      tab,
      contents,
      kind,
      "http_auth",
      {
        signIn: {
          host: words(authInfo.host),
          ...(authInfo.realm ? { realm: words(authInfo.realm) } : {}),
          proxy: authInfo.isProxy,
          retry: details.firstAuthAttempt === false,
        },
      },
      (allow, choice) => {
        const given = allow ? choice?.credentials : undefined;
        if (
          !given ||
          typeof given.username !== "string" ||
          typeof given.password !== "string"
        ) {
          settle();
          return;
        }
        settle(given.username, given.password);
      },
      origin,
    );
  };

  // A site asked for a certificate. Kamapathy never picks one.
  const selectClientCertificate: PromptCenter["selectClientCertificate"] = (
    contents,
    url,
    list,
    callback,
  ) => {
    let answered = false;
    // Nothing sent is a callback with no certificate at all.
    const settle = (certificate?: Electron.Certificate) => {
      if (answered) return;
      answered = true;
      if (certificate) callback(certificate);
      else callback();
    };
    const tab = host.tabOf(contents);
    const space = host.spaceOf(contents);
    if (!contents || contents.isDestroyed() || !tab || !space || !list.length) {
      settle();
      return;
    }
    const origin = originOf(url) ?? originOf(contents.getURL());
    const raised = raise(
      space,
      tab,
      contents,
      "client_certificate",
      "client_certificate",
      {
        ...(origin ? { origin: words(origin) } : {}),
        certificates: list.map((item) => ({
          id: item.fingerprint,
          subject: words(item.subjectName),
          issuer: words(item.issuerName),
          expires: item.validExpiry,
        })),
      },
      (allow, choice) =>
        settle(
          allow
            ? list.find((item) => item.fingerprint === choice?.certificateId)
            : undefined,
        ),
      origin ?? "",
    );
    if (!raised) settle();
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
    for (let index = grants.length - 1; index >= 0; index -= 1)
      if (spaceId === undefined || grants[index].spaceId === spaceId)
        grants.splice(index, 1);
    if (spaceId === undefined) credentials.clear();
    else credentials.delete(spaceId);
  };

  return {
    attachSession(browsingSession) {
      let live = true;
      const detachDevices = attachDevices(browsingSession);
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
        detachDevices();
        browsingSession.setPermissionCheckHandler(() => false);
        browsingSession.setPermissionRequestHandler(
          (_contents, _permission, callback) => callback(false),
        );
      };
    },
    attachDevices,
    attachBluetooth(contents) {
      contents.on("select-bluetooth-device", (event, devices, callback) => {
        // Without this Chromium picks the first device it finds.
        event.preventDefault();
        openChooser(
          "bluetooth",
          null,
          contents,
          devices.map(bluetoothRow),
          callback,
        );
      });
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
    tabLogin,
    appLogin(callback) {
      // A request with no page gets nobody to ask.
      callback();
    },
    selectClientCertificate,
    setHTTPCredentials(spaceId, given) {
      if (!given) {
        credentials.delete(spaceId);
        return;
      }
      const stored = credentials.get(spaceId) ?? new Map();
      credentials.set(spaceId, stored);
      // Storing an origin again arms it again, and a ninth drops the oldest.
      stored.delete(given.origin);
      stored.set(given.origin, {
        username: given.username,
        password: given.password,
      });
      for (const origin of [...stored.keys()].slice(0, -CREDENTIAL_ORIGINS))
        stored.delete(origin);
    },
    clearCredentials() {
      credentials.clear();
    },
    setReceipts(sink) {
      receipts = sink;
    },
    answer(answer) {
      if (typeof answer?.id !== "string") return;
      end(answer.id, answer.allow === true, true, answer);
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
