import { dialog, Menu, screen } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import { agentRules } from "../../shared/state";
import type { BrowserState, PasswordPrompt, Space } from "../../shared/types";
import type { BrowserController } from "../controller";
import {
  FORM_CHANNELS,
  type CaptureReport,
  type FieldReport,
  type FormFlags,
  type HelloReply,
  type OutcomeReport,
} from "./form-dom";
import { memorySealer, type Sealer } from "./seal";
import type { Vault } from "./vault";

// The parts of WebFrameMain and WebContents the broker uses.
export interface FormFrame {
  readonly frameTreeNodeId: number;
  readonly origin: string;
  readonly url: string;
  readonly detached: boolean;
  send(channel: string, ...args: unknown[]): void;
}
export interface FormIpc {
  handle(
    channel: string,
    listener: (event: { senderFrame: FormFrame | null }) => unknown,
  ): void;
  on(
    channel: string,
    listener: (
      event: { senderFrame: FormFrame | null },
      payload: unknown,
    ) => void,
  ): void;
  removeHandler(channel: string): void;
  removeAllListeners(channel?: string): void;
}
export interface FormContents {
  readonly ipc: FormIpc;
  readonly mainFrame: FormFrame & { readonly framesInSubtree: FormFrame[] };
  on(
    event: "did-frame-navigate" | "destroyed",
    listener: (...args: any[]) => void,
  ): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  isDestroyed(): boolean;
  getZoomFactor(): number;
}
// What the broker needs from the controller and the window.
export interface FormHost {
  state(): BrowserState;
  view(tabId: string):
    | {
        bounds: { x: number; y: number; width: number; height: number };
        visible: boolean;
      }
    | undefined;
  windowFocused(): boolean;
  // The window's content area on screen.
  contentOrigin(): { x: number; y: number };
  cursor(): { x: number; y: number };
  setPrompts(prompts: PasswordPrompt[]): void;
  popup(
    items: Electron.MenuItemConstructorOptions[],
    at?: { x: number; y: number },
  ): void;
  confirm(message: string, button: string): Promise<boolean>;
  openManager(): void;
}

// Frames are untrusted: each message is at most 8 KiB of JSON with strings of
// at most 1000 characters, and a frame sends at most 20 a second.
export const FORM_LIMITS = {
  bytes: 8192,
  string: 1000,
  messages: 20,
  windowMs: 1000,
} as const;

// Agent rules are off for the space, or the person has taken it over.
export function underPersonControl(
  space: Pick<Space, "kind" | "access" | "owner">,
): boolean {
  return !agentRules(space) || space.owner === "human";
}

type FormReport =
  | { channel: "field"; payload: FieldReport }
  | { channel: "captured"; payload: CaptureReport }
  | { channel: "outcome"; payload: OutcomeReport };
type Shape = Record<string, (value: unknown) => boolean>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
// Exactly the shape's keys, each with a value it accepts.
function fits(value: unknown, shape: Shape): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === Object.keys(shape).length &&
    keys.every((key) => Object.hasOwn(shape, key) && shape[key](value[key]))
  );
}
const text = (value: unknown) => typeof value === "string";
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);
const is = (expected: unknown) => (value: unknown) => value === expected;
const fieldKind = (value: unknown) =>
  value === "sign-in" || value === "username-only";
const rect = (value: unknown) =>
  fits(value, { x: finite, y: finite, width: finite, height: finite });
const point = (value: unknown) => fits(value, { x: finite, y: finite });
// What the form script sends on each channel. A key press leaves out click.
const SHAPES: Record<FormReport["channel"], Shape[]> = {
  field: [
    { kind: fieldKind, rect, click: point, cause: is("click") },
    { kind: fieldKind, rect, cause: is("key") },
  ],
  captured: [
    { kind: is("sign-in"), username: text, password: text },
    { kind: is("sign-up"), username: text, newPassword: text },
    {
      kind: is("change"),
      username: text,
      password: text,
      newPassword: text,
    },
    { kind: is("username"), username: text },
  ],
  outcome: [
    { passwordField: (value) => typeof value === "boolean" },
    { formGone: is(true) },
  ],
};
const shortStrings = (value: unknown): boolean =>
  typeof value === "string"
    ? value.length <= FORM_LIMITS.string
    : typeof value !== "object" ||
      value === null ||
      Object.values(value).every(shortStrings);
// Within the size limits. Values JSON cannot hold, such as cycles, fail.
function small(payload: unknown): boolean {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    return false;
  }
  return (
    json !== undefined &&
    Buffer.byteLength(json) <= FORM_LIMITS.bytes &&
    shortStrings(payload)
  );
}

// A frame showing a web document, read once. A frame that has gone throws
// when it is read.
function webFrame(
  frame: FormFrame | null,
): { frame: FormFrame; id: number; origin: string } | undefined {
  try {
    if (!frame || frame.detached) return undefined;
    const { frameTreeNodeId: id, origin, url } = frame;
    if (/^https?:\/\//.test(origin) && /^https?:/.test(url))
      return { frame, id, origin };
  } catch {
    // The frame has gone.
  }
  return undefined;
}

interface FrameRecord {
  frame: FormFrame;
  // The origin the frame said hello from.
  origin: string;
  flags: FormFlags;
  checkOutcome: boolean;
  // When its recent messages came, for the rate limit.
  times: number[];
}
interface TabRecord {
  contents: FormContents;
  frames: Map<number, FrameRecord>;
  // The control, save setting and vault revision the flags were last
  // checked against.
  signature?: string;
  stop(): void;
}
// A recorded frame still shows a web document at the origin of its hello.
const current = (record: FrameRecord) =>
  webFrame(record.frame)?.origin === record.origin;

export interface FormBrokerOptions {
  vault: Vault;
  host: FormHost;
  memory?: Sealer;
  now?: () => number;
}

// Answers the form script in every web frame of each tab. Frames say hello
// and get flags for their own origin; reports count only from frames of
// spaces the person controls, and the flags follow control, the save
// setting and the vault.
export class FormBroker {
  private readonly vault: Vault;
  private readonly host: FormHost;
  // Seals captured values until the person answers a prompt.
  private readonly memory: Sealer;
  private readonly now: () => number;
  private readonly tabs = new Map<string, TabRecord>();
  private readonly stopVault: () => void;
  private disposed = false;

  constructor(options: FormBrokerOptions) {
    this.vault = options.vault;
    this.host = options.host;
    this.memory = options.memory ?? memorySealer();
    this.now = options.now ?? Date.now;
    this.stopVault = this.vault.on(() => this.controlChanged());
  }

  // Listens on the tab's page in place of a page the tab had before.
  attach(tabId: string, contents: FormContents): void {
    if (this.tabs.get(tabId)?.contents === contents) return;
    this.detach(tabId);
    if (this.disposed || contents.isDestroyed()) return;
    const tab: TabRecord = { contents, frames: new Map(), stop: () => {} };
    const { ipc } = contents;
    ipc.handle(FORM_CHANNELS.hello, (event) =>
      this.hello(tabId, tab, event.senderFrame),
    );
    for (const channel of ["field", "captured", "outcome"] as const)
      ipc.on(FORM_CHANNELS[channel], (event, payload) =>
        this.receive(tabId, tab, channel, event.senderFrame, payload),
      );
    const navigated = () => {
      for (const [id, record] of tab.frames)
        if (!current(record)) tab.frames.delete(id);
    };
    const destroyed = () => this.detach(tabId);
    contents.on("did-frame-navigate", navigated);
    contents.on("destroyed", destroyed);
    tab.stop = () => {
      ipc.removeHandler(FORM_CHANNELS.hello);
      ipc.removeAllListeners(FORM_CHANNELS.field);
      ipc.removeAllListeners(FORM_CHANNELS.captured);
      ipc.removeAllListeners(FORM_CHANNELS.outcome);
      contents.removeListener("did-frame-navigate", navigated);
      contents.removeListener("destroyed", destroyed);
    };
    this.tabs.set(tabId, tab);
  }

  detach(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    this.tabs.delete(tabId);
    tab.stop();
  }

  // Tells each recorded frame whose flags changed. Tabs whose control, save
  // setting and vault revision are as they were are skipped.
  controlChanged(spaceId?: string): void {
    if (this.disposed) return;
    const setting = this.host.state().settings.offerToSavePasswords;
    for (const [tabId, tab] of this.tabs) {
      const space = this.spaceOf(tabId);
      if (spaceId !== undefined && space?.id !== spaceId) continue;
      const control = !!space && underPersonControl(space);
      const signature = `${control} ${setting} ${this.vault.revision}`;
      if (tab.signature === signature) continue;
      tab.signature = signature;
      for (const [id, record] of tab.frames) {
        if (!current(record)) {
          tab.frames.delete(id);
          continue;
        }
        const flags = this.flags(control, record.origin);
        if (
          flags.fill === record.flags.fill &&
          flags.capture === record.flags.capture
        )
          continue;
        record.flags = flags;
        try {
          record.frame.send(FORM_CHANNELS.state, flags);
        } catch {
          // The frame has gone.
        }
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopVault();
    for (const tabId of [...this.tabs.keys()]) this.detach(tabId);
  }

  // A refused hello rejects the frame's invoke, which stops its script.
  private hello(
    tabId: string,
    tab: TabRecord,
    senderFrame: FormFrame | null,
  ): HelloReply {
    const sender = webFrame(senderFrame);
    const times = (sender && tab.frames.get(sender.id)?.times) ?? [];
    if (!sender || !this.allowed(times))
      throw new Error("Saved passwords are not offered in this frame.");
    const space = this.spaceOf(tabId);
    const flags = this.flags(
      !!space && underPersonControl(space),
      sender.origin,
    );
    tab.frames.set(sender.id, {
      frame: sender.frame,
      origin: sender.origin,
      flags,
      checkOutcome: false,
      times,
    });
    // The next change of control checks this tab again.
    delete tab.signature;
    return { ...flags, checkOutcome: false };
  }

  // Refused reports are dropped without an answer.
  private receive(
    tabId: string,
    tab: TabRecord,
    channel: FormReport["channel"],
    senderFrame: FormFrame | null,
    payload: unknown,
  ): void {
    const sender = webFrame(senderFrame);
    const record = sender && tab.frames.get(sender.id);
    if (
      !sender ||
      !record ||
      record.origin !== sender.origin ||
      !this.allowed(record.times) ||
      !small(payload) ||
      !SHAPES[channel].some((shape) => fits(payload, shape))
    )
      return;
    const space = this.spaceOf(tabId);
    if (!space || !underPersonControl(space)) return;
    this.report(tabId, record, { channel, payload } as FormReport);
  }

  // Reports that passed every check, from frames the person controls.
  // Nothing acts on them yet.
  private report(
    _tabId: string,
    _frame: FrameRecord,
    _report: FormReport,
  ): void {}

  // Counts a message unless the frame already sent 20 in the last second.
  private allowed(times: number[]): boolean {
    const now = this.now();
    while (times.length && now - times[0] >= FORM_LIMITS.windowMs)
      times.shift();
    if (times.length >= FORM_LIMITS.messages) return false;
    times.push(now);
    return true;
  }

  private flags(control: boolean, origin: string): FormFlags {
    const { state } = this.vault;
    return {
      fill:
        control && state === "ready" && this.vault.matches(origin).length > 0,
      capture:
        control &&
        this.host.state().settings.offerToSavePasswords &&
        (state === "empty" || state === "ready"),
    };
  }

  private spaceOf(tabId: string): Space | undefined {
    const { tabs, spaces } = this.host.state();
    const spaceId = tabs.find((tab) => tab.id === tabId)?.spaceId;
    return spaces.find((space) => space.id === spaceId);
  }
}

// Connects a broker to a window's controller: every tab view's page, closed
// tabs and changes of control. Electron's modules are read when the host is
// used.
export function connectForms(
  controller: BrowserController,
  window: BrowserWindow,
  vault: Vault,
  options: { openManager(): void },
): FormBroker {
  const broker = new FormBroker({
    vault,
    host: {
      state: () => controller.state,
      view: (tabId) => controller.viewPlacement(tabId),
      windowFocused: () => !window.isDestroyed() && window.isFocused(),
      contentOrigin: () => window.getContentBounds(),
      cursor: () => screen.getCursorScreenPoint(),
      setPrompts: (prompts) => controller.setPasswordPrompts(prompts),
      popup: (items, at) =>
        Menu.buildFromTemplate(items).popup({
          window,
          ...(at && { x: Math.round(at.x), y: Math.round(at.y) }),
        }),
      confirm: (message, button) =>
        dialog
          .showMessageBox(window, {
            type: "question",
            message,
            buttons: [button, "Cancel"],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
          })
          .then((result) => result.response === 0),
      openManager: options.openManager,
    },
  });
  // WebContents has these members, but its overloaded on() does not match.
  const attach = (tabId: string, contents: WebContents) =>
    broker.attach(tabId, contents as unknown as FormContents);
  const stops = [
    controller.onViewCreated(attach),
    controller.registry.on((event) => {
      if (event.type === "closed") broker.detach(event.tabId);
    }),
    controller.subscribe(() => broker.controlChanged()),
  ];
  // The controller may have made views before the broker existed.
  for (const tab of controller.state.tabs) {
    const contents = controller.peekWebContents(tab.id);
    if (contents) attach(tab.id, contents);
  }
  const dispose = broker.dispose.bind(broker);
  broker.dispose = () => {
    for (const stop of stops.splice(0)) stop();
    dispose();
  };
  return broker;
}
