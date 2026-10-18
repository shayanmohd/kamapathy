import { randomUUID } from "node:crypto";
import { dialog, Menu, screen } from "electron";
import type { BrowserWindow, WebContents } from "electron";
import { cleanAgentText } from "../../shared/agent-text";
import { agentRules } from "../../shared/state";
import type {
  BrowserState,
  PasswordPrompt,
  PasswordPromptAnswer,
  SavedLoginSummary,
  Space,
} from "../../shared/types";
import type { BrowserController } from "../controller";
import { PasswordError } from "./errors";
import {
  FORM_CHANNELS,
  type CaptureReport,
  type FieldReport,
  type FillMessage,
  type FormFlags,
  type HelloReply,
  type OutcomeReport,
} from "./form-dom";
import { asciiHost, isLoopbackOrigin } from "./origin";
import { memorySealer, type Sealer } from "./seal";
import { VAULT_LIMITS, type Vault } from "./vault";

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

// A capture whose sealed values main has opened.
export interface CaptureInput {
  origin: string;
  kind: "sign-in" | "sign-up" | "change";
  username: string;
  password?: string;
  newPassword?: string;
}
export type SaveDecision =
  | { prompt: "none" }
  | { prompt: "save"; username: string }
  | { prompt: "update"; loginId: string; username: string };

// How long main waits for a sign-in to work, keeps a username-only step's
// value for the next capture, and shows a prompt.
export const CAPTURE_MS = {
  success: 30000,
  lend: 300000,
  prompt: 300000,
} as const;

const NO_PROMPT: SaveDecision = { prompt: "none" };

// What to offer once a sign-in worked. Saved passwords are compared one at
// a time, and a login the person already has is only used.
export async function saveDecision(
  vault: Vault,
  capture: CaptureInput,
  offerToSave: boolean,
): Promise<SaveDecision> {
  if (!offerToSave || vault.isNeverSaved(capture.origin)) return NO_PROMPT;
  const secret =
    capture.kind === "sign-in" ? capture.password : capture.newPassword;
  if (!secret) return NO_PROMPT;
  const matches = vault.matches(capture.origin);
  // A change form says which login it is about through its old password.
  if (capture.kind === "change" && capture.password)
    for (const login of matches)
      if (await vault.passwordEquals(login.id, capture.password)) {
        if (capture.password === secret) {
          vault.touch(login.id);
          return NO_PROMPT;
        }
        return {
          prompt: "update",
          loginId: login.id,
          username: login.username,
        };
      }
  const named = matches.filter((login) => login.username === capture.username);
  for (const login of named)
    if (await vault.passwordEquals(login.id, secret)) {
      vault.touch(login.id);
      return NO_PROMPT;
    }
  const saved =
    named.find((login) => login.origin === capture.origin) ?? named[0];
  if (saved)
    return { prompt: "update", loginId: saved.id, username: saved.username };
  return { prompt: "save", username: capture.username };
}

// The fill menu holds up to 8 usernames, with labels of up to 60
// characters.
export const MENU_LIMITS = { logins: 8, label: 60 } as const;
const FILL_CONFIRM =
  "Agents can read pages in this space, including this password.";

// The menu opens under the field: from the view bounds and the page zoom
// in the main frame, at the cursor for a click in a subframe, and at the
// top center of the view for a key press in one.
export function menuPoint(
  report: FieldReport,
  view: { x: number; y: number; width: number; height: number },
  zoom: number,
  mainFrame: boolean,
): { x: number; y: number } | undefined {
  const { rect } = report;
  if (mainFrame)
    return {
      x: view.x + rect.x * zoom,
      y: view.y + (rect.y + rect.height) * zoom,
    };
  if (report.cause === "click") return undefined;
  return { x: view.x + view.width / 2, y: view.y };
}

// Labels carry what a page may have chosen, so each is cleaned and cut.
// Windows reads a single "&" as an accelerator.
function menuLabel(text: string): string {
  const label = cleanAgentText(text).slice(0, MENU_LIMITS.label);
  return process.platform === "win32" ? label.replace(/&/g, "&&") : label;
}

export function menuItems(input: {
  logins: SavedLoginSummary[];
  frameOrigin: string;
  tabOrigin: string;
  choose(id: string): void;
  manage(): void;
}): Electron.MenuItemConstructorOptions[] {
  const host = asciiHost(input.frameOrigin);
  const items: Electron.MenuItemConstructorOptions[] = [];
  const header = (text: string) =>
    items.push({ label: menuLabel(text), enabled: false });
  if (host !== asciiHost(input.tabOrigin)) header(`Passwords for ${host}`);
  if (
    input.frameOrigin.startsWith("http:") &&
    !isLoopbackOrigin(input.frameOrigin)
  )
    header("This connection isn't secure.");
  for (const login of input.logins.slice(0, MENU_LIMITS.logins)) {
    const from = asciiHost(login.origin);
    const name = login.username || "No username";
    items.push({
      label: menuLabel(from === host ? name : `${name} (${from})`),
      click: () => input.choose(login.id),
    });
  }
  items.push(
    { type: "separator" },
    { label: menuLabel("Manage passwords..."), click: () => input.manage() },
  );
  return items;
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
  // Its place in the tab's frame tree, which outlives its documents.
  node: number;
  // The origin the frame said hello from.
  origin: string;
  flags: FormFlags;
  checkOutcome: boolean;
  // The field the person last asked the menu for in this frame.
  lastField?: { node: number; origin: string; at: number };
  // When its recent messages came, for the rate limit.
  times: number[];
}
// A capture waiting for the sign-in to work. Its values stay sealed.
interface PendingCapture {
  node: number;
  origin: string;
  kind: CaptureInput["kind"];
  username: string;
  password?: Buffer;
  newPassword?: Buffer;
  timer: ReturnType<typeof setTimeout>;
}
// What a prompt carries beside what the shell sees.
interface HeldPrompt {
  prompt: PasswordPrompt;
  origin: string;
  // The password to save, still sealed.
  secret: Buffer;
  loginId?: string;
  timer: ReturnType<typeof setTimeout>;
}
interface TabRecord {
  contents: FormContents;
  frames: Map<number, FrameRecord>;
  capture?: PendingCapture;
  // A username-only step's value for the next password-only capture.
  lent?: { origin: string; username: string; at: number };
  prompt?: HeldPrompt;
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
    if (this.forget(tab)) this.publish();
  }

  // The person's answer to a save or update prompt. The vault is written
  // first: a failure keeps the prompt, so the bar can show its message. A
  // prompt that is gone takes no answer.
  async answer(
    promptId: string,
    answer: PasswordPromptAnswer,
  ): Promise<{ ok: true }> {
    const tab = [...this.tabs.values()].find(
      (record) => record.prompt?.prompt.id === promptId,
    );
    const held = tab?.prompt;
    if (!tab || !held) return { ok: true };
    if (answer.action === "save") {
      const { username } = answer;
      if (typeof username !== "string")
        throw new PasswordError("invalid_login", { field: "username" });
      if (username.length > VAULT_LIMITS.username)
        throw new PasswordError("invalid_login", {
          field: "username",
          limit: VAULT_LIMITS.username,
        });
      const password = await this.opened(held.secret);
      const existing = this.vault.find("form", held.origin, username);
      if (existing) await this.vault.update(existing.id, { password });
      else
        await this.vault.add({
          kind: "form",
          origin: held.origin,
          username,
          password,
        });
    } else if (answer.action === "update" && held.loginId !== undefined)
      await this.vault.update(held.loginId, {
        password: await this.opened(held.secret),
      });
    else if (answer.action === "never")
      await this.vault.addNeverSaved(held.origin);
    if (tab.prompt === held && this.dropPrompt(tab)) this.publish();
    return { ok: true };
  }

  // Tells each recorded frame whose flags changed. Tabs whose control, save
  // setting and vault revision are as they were are skipped.
  controlChanged(spaceId?: string): void {
    if (this.disposed) return;
    const setting = this.host.state().settings.offerToSavePasswords;
    let dropped = false;
    for (const [tabId, tab] of this.tabs) {
      const space = this.spaceOf(tabId);
      if (spaceId !== undefined && space?.id !== spaceId) continue;
      const control = !!space && underPersonControl(space);
      if (!control && this.forget(tab)) dropped = true;
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
    if (dropped) this.publish();
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
    // A new document of the capturing frame, or of the main frame, is asked
    // whether it still shows a password field.
    const checkOutcome =
      tab.capture !== undefined &&
      (sender.id === tab.capture.node || sender.id === this.mainNode(tab));
    tab.frames.set(sender.id, {
      frame: sender.frame,
      node: sender.id,
      origin: sender.origin,
      flags,
      checkOutcome,
      times,
    });
    // The next change of control checks this tab again.
    delete tab.signature;
    return { ...flags, checkOutcome };
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
  private report(tabId: string, frame: FrameRecord, report: FormReport): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (report.channel === "field")
      this.field(tabId, tab, frame, report.payload);
    else if (report.channel === "captured")
      void this.captured(tabId, tab, frame, report.payload);
    else if (report.channel === "outcome")
      this.outcome(tabId, tab, frame, report.payload);
  }

  // The person asked for saved passwords in an empty field. The menu opens
  // only while the vault has matches for the frame's own origin and the
  // person can see the tab.
  private field(
    tabId: string,
    tab: TabRecord,
    frame: FrameRecord,
    report: FieldReport,
  ): void {
    if (this.vault.state !== "ready") return;
    const logins = this.vault.matches(frame.origin);
    if (logins.length === 0) return;
    const view = this.host.view(tabId);
    if (!view?.visible || !this.host.windowFocused()) return;
    const main = this.mainFrameOf(tab);
    if (!main) return;
    const { node, origin } = frame;
    frame.lastField = { node, origin, at: this.now() };
    const items = menuItems({
      logins,
      frameOrigin: origin,
      tabOrigin: main.origin,
      choose: (loginId) => void this.choose(tabId, node, origin, loginId),
      manage: () => this.host.openManager(),
    });
    this.host.popup(
      items,
      menuPoint(report, view.bounds, main.zoom, node === main.node),
    );
  }

  // The person chose a login. Everything is checked again after each wait,
  // and the password reaches only the frame that reported the field, at the
  // origin it reported from. A failure fills nothing and says nothing.
  private async choose(
    tabId: string,
    node: number,
    origin: string,
    loginId: string,
  ): Promise<void> {
    try {
      const space = this.spaceOf(tabId);
      if (!space || !this.reporting(tabId, node, origin)) return;
      if (agentRules(space) && !(await this.host.confirm(FILL_CONFIRM, "Fill")))
        return;
      const login = this.vault
        .matches(origin)
        .find((match) => match.id === loginId);
      if (!login || !this.reporting(tabId, node, origin)) return;
      const { password } = await this.vault.reveal(loginId);
      const frame = this.reporting(tabId, node, origin);
      if (!frame) return;
      const message: FillMessage = {
        origin,
        username: login.username,
        password,
      };
      frame.frame.send(FORM_CHANNELS.fill, message);
      this.vault.touch(loginId);
    } catch {
      // Nothing is filled.
    }
  }

  // The frame that reported the field, while the person still controls its
  // tab, the vault is ready and the frame shows the same document.
  private reporting(
    tabId: string,
    node: number,
    origin: string,
  ): FrameRecord | undefined {
    const space = this.spaceOf(tabId);
    const frame = this.tabs.get(tabId)?.frames.get(node);
    if (!space || !underPersonControl(space) || this.vault.state !== "ready")
      return undefined;
    if (
      !frame ||
      frame.origin !== origin ||
      frame.lastField?.origin !== origin ||
      !current(frame)
    )
      return undefined;
    return frame;
  }

  // What the person submitted is sealed at once and waits for the sign-in
  // to work. The newest capture is the one the tab keeps.
  private async captured(
    tabId: string,
    tab: TabRecord,
    frame: FrameRecord,
    payload: CaptureReport,
  ): Promise<void> {
    if (!frame.flags.capture) return;
    const { node, origin } = frame;
    if (payload.kind === "username") {
      tab.lent = { origin, username: payload.username, at: this.now() };
      return;
    }
    let { username } = payload;
    const lent = tab.lent;
    if (
      payload.kind === "sign-in" &&
      !username &&
      lent &&
      lent.origin === origin &&
      this.now() - lent.at < CAPTURE_MS.lend
    ) {
      username = lent.username;
      delete tab.lent;
    }
    const sealed = async (text?: string) =>
      text === undefined ? undefined : await this.memory.seal(text);
    const password = await sealed(
      "password" in payload ? payload.password : undefined,
    );
    const newPassword = await sealed(
      "newPassword" in payload ? payload.newPassword : undefined,
    );
    if (this.tabs.get(tabId) !== tab) return;
    this.dropCapture(tab);
    tab.capture = {
      node,
      origin,
      kind: payload.kind,
      username,
      ...(password === undefined ? {} : { password }),
      ...(newPassword === undefined ? {} : { newPassword }),
      timer: setTimeout(() => this.dropCapture(tab), CAPTURE_MS.success),
    };
  }

  // A new document without a password field, or the captured field going
  // away, means the sign-in worked. A password field that came back means
  // it did not.
  private outcome(
    tabId: string,
    tab: TabRecord,
    frame: FrameRecord,
    payload: OutcomeReport,
  ): void {
    const capture = tab.capture;
    if (!capture) return;
    if ("formGone" in payload) {
      if (frame.node !== capture.node || frame.origin !== capture.origin)
        return;
    } else {
      if (!frame.checkOutcome) return;
      if (payload.passwordField) {
        this.dropCapture(tab);
        return;
      }
    }
    this.dropCapture(tab);
    void this.succeeded(tabId, tab, capture);
  }

  private async succeeded(
    tabId: string,
    tab: TabRecord,
    capture: PendingCapture,
  ): Promise<void> {
    const secret =
      capture.kind === "sign-in" ? capture.password : capture.newPassword;
    if (!secret) return;
    const password = capture.password && (await this.opened(capture.password));
    const newPassword =
      capture.newPassword && (await this.opened(capture.newPassword));
    const decision = await saveDecision(
      this.vault,
      {
        origin: capture.origin,
        kind: capture.kind,
        username: capture.username,
        ...(password === undefined ? {} : { password }),
        ...(newPassword === undefined ? {} : { newPassword }),
      },
      this.host.state().settings.offerToSavePasswords,
    );
    if (decision.prompt === "none" || this.tabs.get(tabId) !== tab) return;
    this.dropPrompt(tab);
    tab.prompt = {
      prompt: {
        id: randomUUID(),
        tabId,
        kind: decision.prompt,
        host: asciiHost(capture.origin),
        username: decision.username,
      },
      origin: capture.origin,
      secret,
      ...(decision.prompt === "update" ? { loginId: decision.loginId } : {}),
      timer: setTimeout(() => {
        if (this.dropPrompt(tab)) this.publish();
      }, CAPTURE_MS.prompt),
    };
    this.publish();
  }

  // Prompts are runtime state of the window, one per tab.
  private publish(): void {
    const prompts: PasswordPrompt[] = [];
    for (const tab of this.tabs.values())
      if (tab.prompt) prompts.push(tab.prompt.prompt);
    this.host.setPrompts(prompts);
  }

  private dropCapture(tab: TabRecord): void {
    if (!tab.capture) return;
    clearTimeout(tab.capture.timer);
    delete tab.capture;
  }
  private dropPrompt(tab: TabRecord): boolean {
    if (!tab.prompt) return false;
    clearTimeout(tab.prompt.timer);
    delete tab.prompt;
    return true;
  }
  // Nothing of the person's sign-ins outlives their control of the tab.
  private forget(tab: TabRecord): boolean {
    this.dropCapture(tab);
    delete tab.lent;
    return this.dropPrompt(tab);
  }
  private async opened(sealed: Buffer): Promise<string> {
    return (await this.memory.open(sealed)).text;
  }
  // The frame tree node of the tab's main frame, if its page is still there.
  private mainNode(tab: TabRecord): number | undefined {
    return this.mainFrameOf(tab)?.node;
  }
  // The tab's main frame and the zoom its page is drawn at.
  private mainFrameOf(
    tab: TabRecord,
  ): { node: number; origin: string; zoom: number } | undefined {
    try {
      const { frameTreeNodeId: node, origin } = tab.contents.mainFrame;
      return { node, origin, zoom: tab.contents.getZoomFactor() };
    } catch {
      return undefined;
    }
  }

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
