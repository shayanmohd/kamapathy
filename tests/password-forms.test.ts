import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { dialog, Menu, screen } from "electron";
import type { BrowserController } from "../electron/controller";
import type { RegistryEvent } from "../electron/agent/tab-registry";
import { FORM_CHANNELS } from "../electron/passwords/form-dom";
import {
  connectForms,
  FORM_LIMITS,
  FormBroker,
  underPersonControl,
  type FormFrame,
  type FormHost,
} from "../electron/passwords/forms";
import type { Sealer } from "../electron/passwords/seal";
import { Vault } from "../electron/passwords/vault";
import { initialState, newTab } from "../shared/state";
import type { BrowserState, Space } from "../shared/types";

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  screen: { getCursorScreenPoint: vi.fn() },
}));

type SenderEvent = { senderFrame: FormFrame | null };
let nextFrameId = 1;

class FakeFrame implements FormFrame {
  readonly frameTreeNodeId = nextFrameId++;
  detached = false;
  send = vi.fn();
  constructor(
    public origin: string,
    public url = `${origin}/`,
  ) {}
}

// Handlers and listeners by channel, as on webContents.ipc.
class FakeIpc {
  handlers = new Map<string, (event: SenderEvent) => unknown>();
  listeners = new Map<
    string,
    ((event: SenderEvent, payload: unknown) => void)[]
  >();
  handle(channel: string, listener: (event: SenderEvent) => unknown) {
    if (this.handlers.has(channel))
      throw new Error(
        `Attempted to register a second handler for '${channel}'`,
      );
    this.handlers.set(channel, listener);
  }
  on(
    channel: string,
    listener: (event: SenderEvent, payload: unknown) => void,
  ) {
    this.listeners.set(channel, [
      ...(this.listeners.get(channel) ?? []),
      listener,
    ]);
  }
  removeHandler(channel: string) {
    this.handlers.delete(channel);
  }
  removeAllListeners(channel?: string) {
    if (channel === undefined) this.listeners.clear();
    else this.listeners.delete(channel);
  }
}

// A tab's page: a main frame and the given subframes.
class FakeContents extends EventEmitter {
  readonly ipc = new FakeIpc();
  readonly mainFrame: FakeFrame & { framesInSubtree: FakeFrame[] };
  destroyed = false;
  constructor(origin: string, ...subframes: string[]) {
    super();
    const main = new FakeFrame(origin);
    this.mainFrame = Object.assign(main, {
      framesInSubtree: [main, ...subframes.map((item) => new FakeFrame(item))],
    });
  }
  get frames() {
    return this.mainFrame.framesInSubtree;
  }
  isDestroyed() {
    return this.destroyed;
  }
  getZoomFactor() {
    return 1;
  }
  // Origins come from the sender frame, never from the page's address.
  getURL(): string {
    throw new Error("getURL was called.");
  }
  // Invokes hello as a frame's preload does: a handler that throws rejects.
  hello(frame: FakeFrame | null = this.mainFrame): Promise<unknown> {
    const handler = this.ipc.handlers.get(FORM_CHANNELS.hello);
    if (!handler)
      return Promise.reject(
        new Error(`No handler registered for '${FORM_CHANNELS.hello}'`),
      );
    return new Promise((resolve) => resolve(handler({ senderFrame: frame })));
  }
  report(
    channel: "field" | "captured" | "outcome",
    payload: unknown,
    frame: FakeFrame | null = this.mainFrame,
  ) {
    for (const listener of this.ipc.listeners.get(FORM_CHANNELS[channel]) ?? [])
      listener({ senderFrame: frame }, payload);
  }
  registrations() {
    return {
      handlers: this.ipc.handlers.size,
      listeners: this.ipc.listeners.size,
      navigations: this.listenerCount("did-frame-navigate"),
      destroyed: this.listenerCount("destroyed"),
    };
  }
}
const attached = { handlers: 1, listeners: 3, navigations: 1, destroyed: 1 };
const removed = { handlers: 0, listeners: 0, navigations: 0, destroyed: 0 };

function fakeHost(state: BrowserState) {
  return {
    state: () => state,
    view: vi.fn(() => undefined),
    windowFocused: vi.fn(() => true),
    contentOrigin: vi.fn(() => ({ x: 0, y: 0 })),
    cursor: vi.fn(() => ({ x: 0, y: 0 })),
    setPrompts: vi.fn(),
    popup: vi.fn(),
    confirm: vi.fn(async () => true),
    openManager: vi.fn(),
  } satisfies FormHost;
}

// The person's spaces, a granted Work space and an agent space, with a tab
// in each.
function browserState() {
  const state = initialState("darwin");
  const work = state.spaces.find((space) => space.id === "work")!;
  work.access = "granted";
  work.owner = "agent";
  const agent: Space = {
    id: "agent",
    name: "Task",
    color: "purple",
    kind: "agent",
    owner: "agent",
    signIns: "shared",
    createdAt: 0,
    access: "granted",
  };
  state.spaces.push(agent);
  const agentTab = newTab(agent.id, "https://a.example/");
  state.tabs.push(agentTab);
  const [personalTab, workTab] = state.tabs;
  return {
    state,
    work,
    agent,
    tabs: { personal: personalTab, work: workTab, agent: agentTab },
  };
}

const reverse = (text: string) => Buffer.from(text, "utf8").reverse();
const reversing: Sealer = {
  check: async () => {},
  seal: async (text) => reverse(text),
  open: async (sealed) => ({
    text: Buffer.from(sealed).reverse().toString("utf8"),
    stale: false,
  }),
};
const directories: string[] = [];
function vaultAt(): Vault {
  const directory = mkdtempSync(join(tmpdir(), "kamapathy-forms-test-"));
  directories.push(directory);
  return new Vault({
    path: join(directory, "passwords", "vault.bin"),
    sealer: reversing,
  });
}
// An opened vault with a login for each origin.
async function openVault(...origins: string[]): Promise<Vault> {
  const vault = vaultAt();
  await vault.open();
  for (const origin of origins)
    await vault.add({
      kind: "form",
      origin,
      username: "alice",
      password: "secret",
    });
  return vault;
}

const brokers: FormBroker[] = [];
function brokerFor(vault: Vault, state: BrowserState, now?: () => number) {
  const host = fakeHost(state);
  const broker = new FormBroker({ vault, host, ...(now ? { now } : {}) });
  brokers.push(broker);
  return { broker, host };
}
// Reports that pass every check reach report().
function reports() {
  return vi.spyOn(
    FormBroker.prototype as unknown as {
      report(tabId: string, frame: unknown, report: unknown): void;
    },
    "report",
  );
}
const reported = (spy: ReturnType<typeof reports>) =>
  spy.mock.calls.map(([tabId, , report]) => ({ tabId, ...(report as object) }));

afterEach(() => {
  for (const broker of brokers.splice(0)) broker.dispose();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const off = { fill: false, capture: false, checkOutcome: false };
const rect = { x: 10, y: 20, width: 200, height: 32 };
const signIn = { kind: "sign-in", username: "alice", password: "secret" };

describe("form broker", () => {
  it("agent-controlled frames get fill and capture false and are ignored", async () => {
    expect(underPersonControl({ kind: "personal", owner: "human" })).toBe(true);
    expect(
      underPersonControl({ kind: "personal", access: "ended", owner: "human" }),
    ).toBe(true);
    expect(
      underPersonControl({
        kind: "personal",
        access: "granted",
        owner: "agent",
      }),
    ).toBe(false);
    expect(
      underPersonControl({
        kind: "personal",
        access: "granted",
        owner: "human",
      }),
    ).toBe(true);
    expect(underPersonControl({ kind: "agent", owner: "agent" })).toBe(false);
    expect(underPersonControl({ kind: "agent", owner: "human" })).toBe(true);

    const vault = await openVault("https://a.example");
    const { state, tabs, agent, work } = browserState();
    const { broker, host } = brokerFor(vault, state);
    const spy = reports();
    const pages = {
      agent: new FakeContents("https://a.example"),
      work: new FakeContents("https://a.example"),
      personal: new FakeContents("https://a.example"),
    };
    broker.attach(tabs.agent.id, pages.agent);
    broker.attach(tabs.work.id, pages.work);
    broker.attach(tabs.personal.id, pages.personal);
    expect(await pages.agent.hello()).toEqual(off);
    expect(await pages.work.hello()).toEqual(off);
    for (const page of [pages.agent, pages.work]) {
      page.report("field", {
        kind: "sign-in",
        rect,
        click: { x: 4, y: 6 },
        cause: "click",
      });
      page.report("field", { kind: "sign-in", rect, cause: "key" });
      page.report("captured", { ...signIn, password: "typed by an agent" });
      page.report("outcome", { passwordField: false });
      page.report("outcome", { formGone: true });
    }
    expect(spy).not.toHaveBeenCalled();
    for (const [name, method] of Object.entries(host))
      if (name !== "state") expect(method).not.toHaveBeenCalled();
    // A personal space nobody granted is the person's from the start.
    expect(await pages.personal.hello()).toEqual({
      fill: true,
      capture: true,
      checkOutcome: false,
    });

    // The person takes over the agent space.
    agent.owner = "human";
    agent.control = { reason: "manual", since: 1 };
    broker.controlChanged(agent.id);
    expect(pages.agent.mainFrame.send).toHaveBeenCalledExactlyOnceWith(
      FORM_CHANNELS.state,
      { fill: true, capture: true },
    );
    expect(pages.work.mainFrame.send).not.toHaveBeenCalled();
    expect(pages.personal.mainFrame.send).not.toHaveBeenCalled();
    pages.agent.report("captured", signIn);
    pages.work.report("captured", signIn);
    expect(reported(spy)).toEqual([
      { tabId: tabs.agent.id, channel: "captured", payload: signIn },
    ]);

    // Stop gives the person the granted space; control going back to the
    // agent turns the agent space off again.
    work.access = "ended";
    work.owner = "human";
    agent.owner = "agent";
    delete agent.control;
    broker.controlChanged();
    expect(pages.work.mainFrame.send).toHaveBeenCalledExactlyOnceWith(
      FORM_CHANNELS.state,
      { fill: true, capture: true },
    );
    expect(pages.agent.mainFrame.send).toHaveBeenLastCalledWith(
      FORM_CHANNELS.state,
      { fill: false, capture: false },
    );
    pages.agent.report("captured", signIn);
    expect(spy).toHaveBeenCalledOnce();
    expect(pages.personal.mainFrame.send).not.toHaveBeenCalled();
    for (const [name, method] of Object.entries(host))
      if (name !== "state") expect(method).not.toHaveBeenCalled();
  });

  it("the origin comes from senderFrame", async () => {
    const vault = await openVault("https://a.example");
    const { state, tabs } = browserState();
    // The tab's address says a.example; its main frame is on b.example.
    tabs.personal.url = "https://a.example/";
    const { broker } = brokerFor(vault, state);
    const page = new FakeContents("https://b.example", "https://a.example");
    broker.attach(tabs.personal.id, page);
    expect(await page.hello(page.frames[1])).toEqual({
      fill: true,
      capture: true,
      checkOutcome: false,
    });
    expect(await page.hello(page.mainFrame)).toEqual({
      fill: false,
      capture: true,
      checkOutcome: false,
    });

    // A frame on another origin than its hello is not heard until its new
    // document says hello.
    const spy = reports();
    const sub = page.frames[1];
    page.report("captured", signIn, sub);
    expect(spy).toHaveBeenCalledOnce();
    sub.origin = "https://c.example";
    sub.url = "https://c.example/";
    page.report("captured", signIn, sub);
    expect(spy).toHaveBeenCalledOnce();
    expect(await page.hello(sub)).toEqual({
      fill: false,
      capture: true,
      checkOutcome: false,
    });
    page.report("captured", signIn, sub);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("oversized, rapid and non-web messages are dropped", async () => {
    let time = 10_000;
    const vault = await openVault();
    const { state, tabs } = browserState();
    const { broker } = brokerFor(vault, state, () => time);
    const spy = reports();
    const page = new FakeContents("https://a.example");
    const frame = page.mainFrame;
    broker.attach(tabs.personal.id, page);
    expect(await page.hello()).toEqual({
      fill: false,
      capture: true,
      checkOutcome: false,
    });

    // Three-byte characters fill the payload without a string over 1000.
    const change = (newPassword: string) => ({
      kind: "change",
      username: "€".repeat(1000),
      password: "€".repeat(1000),
      newPassword,
    });
    const largest = change("€".repeat(566) + "x".repeat(432));
    const oversized = change("€".repeat(566) + "x".repeat(433));
    expect(Buffer.byteLength(JSON.stringify(largest))).toBe(FORM_LIMITS.bytes);
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBe(8193);
    const longest = { ...signIn, username: "a".repeat(1000) };
    page.report("captured", largest);
    page.report("captured", oversized);
    page.report("captured", longest);
    page.report("captured", { ...signIn, username: "a".repeat(1001) });
    page.report("captured", { ...signIn, password: "p".repeat(1001) });
    page.report("field", {
      kind: "sign-in",
      rect,
      click: { x: 1, y: 2 },
      cause: "click",
      extra: "x".repeat(1001),
    });
    expect(reported(spy)).toEqual([
      { tabId: tabs.personal.id, channel: "captured", payload: largest },
      { tabId: tabs.personal.id, channel: "captured", payload: longest },
    ]);

    // Frames that are not on the web, gone or unknown are refused.
    for (const [origin, url] of [
      ["null", "https://sandboxed.example/"],
      ["chrome-extension://x", "chrome-extension://x/page.html"],
      ["file://", "file:///Users/alice/page.html"],
      ["https://a.example", "about:blank"],
    ]) {
      const other = new FakeFrame(origin, url);
      await expect(page.hello(other)).rejects.toThrow();
      page.report("captured", signIn, other);
    }
    frame.detached = true;
    await expect(page.hello()).rejects.toThrow();
    page.report("captured", signIn);
    frame.detached = false;
    await expect(page.hello(null)).rejects.toThrow();
    page.report("captured", signIn, null);
    // A frame read after it went away throws.
    const gone = new FakeFrame("https://a.example");
    Object.defineProperty(gone, "origin", {
      get() {
        throw new Error(
          "Render frame was disposed before WebFrameMain could be accessed",
        );
      },
    });
    await expect(page.hello(gone)).rejects.toThrow();
    page.report("captured", signIn, gone);
    // A frame that never said hello is not heard.
    page.report("captured", signIn, new FakeFrame("https://a.example"));
    expect(spy).toHaveBeenCalledTimes(2);

    // 20 messages a second from one frame, hello included.
    time += FORM_LIMITS.windowMs;
    expect(await page.hello()).toMatchObject({ capture: true });
    for (let count = 1; count < FORM_LIMITS.messages; count += 1)
      page.report("outcome", { passwordField: false });
    expect(spy).toHaveBeenCalledTimes(2 + 19);
    await expect(page.hello()).rejects.toThrow();
    page.report("outcome", { formGone: true });
    time += 999;
    await expect(page.hello()).rejects.toThrow();
    page.report("outcome", { formGone: true });
    expect(spy).toHaveBeenCalledTimes(2 + 19);
    // Another frame of the tab has its own count.
    const second = new FakeFrame("https://a.example");
    expect(await page.hello(second)).toMatchObject({ capture: true });
    page.report("outcome", { formGone: true }, second);
    expect(spy).toHaveBeenCalledTimes(2 + 20);
    time += 1;
    expect(await page.hello()).toMatchObject({ capture: true });
    page.report("outcome", { formGone: true });
    expect(reported(spy).at(-1)).toEqual({
      tabId: tabs.personal.id,
      channel: "outcome",
      payload: { formGone: true },
    });
    expect(spy).toHaveBeenCalledTimes(2 + 21);
  });

  it("drops reports whose shape differs from what the form script sends", async () => {
    let time = 0;
    const vault = await openVault();
    const { state, tabs } = browserState();
    // Messages a second apart never reach the rate limit.
    const { broker } = brokerFor(vault, state, () => (time += 1000));
    const spy = reports();
    const page = new FakeContents("https://a.example");
    broker.attach(tabs.personal.id, page);
    await page.hello();
    const valid: ["field" | "captured" | "outcome", unknown][] = [
      [
        "field",
        { kind: "sign-in", rect, click: { x: 1, y: 2 }, cause: "click" },
      ],
      ["field", { kind: "username-only", rect, cause: "key" }],
      ["captured", signIn],
      ["captured", { kind: "sign-up", username: "", newPassword: "new" }],
      [
        "captured",
        {
          kind: "change",
          username: "alice",
          password: "old",
          newPassword: "new",
        },
      ],
      ["captured", { kind: "username", username: "alice" }],
      ["outcome", { passwordField: true }],
      ["outcome", { passwordField: false }],
      ["outcome", { formGone: true }],
    ];
    const invalid: ["field" | "captured" | "outcome", unknown][] = [
      ["field", { kind: "sign-up", rect, cause: "key" }],
      ["field", { kind: "sign-in", rect, cause: "click" }],
      ["field", { kind: "sign-in", rect, click: { x: 1, y: 2 }, cause: "key" }],
      ["field", { kind: "sign-in", rect, click: undefined, cause: "key" }],
      [
        "field",
        { kind: "sign-in", rect: { ...rect, x: Infinity }, cause: "key" },
      ],
      [
        "field",
        { kind: "sign-in", rect: { ...rect, y: Number.NaN }, cause: "key" },
      ],
      ["field", { kind: "sign-in", rect: { ...rect, z: 1 }, cause: "key" }],
      [
        "field",
        { kind: "sign-in", rect: { x: 1, y: 2, width: 3 }, cause: "key" },
      ],
      ["field", { kind: "sign-in", rect: [1, 2, 3, 4], cause: "key" }],
      ["field", { kind: "sign-in", rect: { ...rect, x: "1" }, cause: "key" }],
      [
        "field",
        { kind: "sign-in", rect, click: { x: 1, y: 2, z: 3 }, cause: "click" },
      ],
      ["captured", { kind: "sign-in", username: "alice" }],
      ["captured", { ...signIn, password: 5 }],
      ["captured", { ...signIn, newPassword: "new" }],
      ["captured", { ...signIn, origin: "https://b.example" }],
      ["captured", { kind: "sign-up", username: "alice", password: "new" }],
      ["captured", { kind: "change", username: "alice", password: "old" }],
      ["captured", { kind: "username", username: "alice", password: "x" }],
      ["captured", { kind: "login", username: "alice", password: "x" }],
      ["captured", ["sign-in", "alice", "secret"]],
      ["outcome", { passwordField: "no" }],
      ["outcome", { formGone: false }],
      ["outcome", { passwordField: true, formGone: true }],
      ["outcome", {}],
      ["outcome", null],
      ["outcome", undefined],
      ["outcome", "formGone"],
      ["outcome", 1n],
    ];
    for (const [channel, payload] of invalid) page.report(channel, payload);
    expect(spy).not.toHaveBeenCalled();
    for (const [channel, payload] of valid) page.report(channel, payload);
    expect(reported(spy)).toEqual(
      valid.map(([channel, payload]) => ({
        tabId: tabs.personal.id,
        channel,
        payload,
      })),
    );
  });

  it("pushes state to every frame when control, the setting or the vault changes", async () => {
    const vault = vaultAt();
    const { state, tabs, work } = browserState();
    const { broker } = brokerFor(vault, state);
    const page = new FakeContents(
      "https://a.example",
      "https://a.example",
      "https://a.example",
      "https://b.example",
    );
    const [main, moving, leaving, other] = page.frames;
    const granted = new FakeContents("https://a.example");
    broker.attach(tabs.personal.id, page);
    broker.attach(tabs.work.id, granted);
    // Nothing is captured while the vault opens.
    for (const frame of page.frames)
      expect(await page.hello(frame)).toEqual(off);
    expect(await granted.hello()).toEqual(off);
    await vault.open();
    for (const frame of page.frames)
      expect(frame.send).toHaveBeenCalledExactlyOnceWith(FORM_CHANNELS.state, {
        fill: false,
        capture: true,
      });
    expect(granted.mainFrame.send).not.toHaveBeenCalled();

    state.settings.offerToSavePasswords = false;
    broker.controlChanged();
    broker.controlChanged();
    for (const frame of page.frames) {
      expect(frame.send).toHaveBeenCalledTimes(2);
      expect(frame.send).toHaveBeenLastCalledWith(FORM_CHANNELS.state, {
        fill: false,
        capture: false,
      });
    }
    state.settings.offerToSavePasswords = true;
    broker.controlChanged();
    for (const frame of page.frames) {
      expect(frame.send).toHaveBeenCalledTimes(3);
      expect(frame.send).toHaveBeenLastCalledWith(FORM_CHANNELS.state, {
        fill: false,
        capture: true,
      });
      frame.send.mockClear();
    }

    // One frame moves to another origin and one is detached before a login
    // for a.example is saved.
    moving.origin = "https://elsewhere.example";
    moving.url = "https://elsewhere.example/";
    leaving.detached = true;
    await vault.add({
      kind: "form",
      origin: "https://a.example",
      username: "alice",
      password: "secret",
    });
    expect(main.send).toHaveBeenCalledExactlyOnceWith(FORM_CHANNELS.state, {
      fill: true,
      capture: true,
    });
    for (const frame of [moving, leaving, other])
      expect(frame.send).not.toHaveBeenCalled();
    expect(granted.mainFrame.send).not.toHaveBeenCalled();
    // Its new document says hello for its own origin.
    expect(await page.hello(moving)).toEqual({
      fill: false,
      capture: true,
      checkOutcome: false,
    });

    // The person stops the agent in the granted space.
    work.access = "ended";
    work.owner = "human";
    broker.controlChanged(work.id);
    expect(granted.mainFrame.send).toHaveBeenCalledExactlyOnceWith(
      FORM_CHANNELS.state,
      { fill: true, capture: true },
    );
    expect(main.send).toHaveBeenCalledOnce();
  });

  it("forgets frames that navigate away and pages that close", async () => {
    const vault = await openVault();
    const { state, tabs } = browserState();
    const { broker } = brokerFor(vault, state);
    const spy = reports();
    const page = new FakeContents("https://a.example", "https://b.example");
    const [main, sub] = page.frames;
    broker.attach(tabs.personal.id, page);
    expect(page.registrations()).toEqual(attached);
    await page.hello(main);
    await page.hello(sub);

    // The subframe navigates away and comes back without saying hello: it
    // was forgotten when it left.
    sub.origin = "https://c.example";
    sub.url = "https://c.example/";
    page.emit("did-frame-navigate");
    sub.origin = "https://b.example";
    sub.url = "https://b.example/";
    page.report("captured", signIn, sub);
    state.settings.offerToSavePasswords = false;
    broker.controlChanged();
    expect(sub.send).not.toHaveBeenCalled();
    expect(main.send).toHaveBeenCalledOnce();
    expect(spy).not.toHaveBeenCalled();
    state.settings.offerToSavePasswords = true;

    // Attaching the same page again keeps what it knows.
    broker.attach(tabs.personal.id, page);
    expect(page.registrations()).toEqual(attached);
    broker.controlChanged();
    expect(main.send).toHaveBeenCalledTimes(2);

    // A new page for the tab replaces the old one.
    const next = new FakeContents("https://a.example");
    broker.attach(tabs.personal.id, next);
    expect(page.registrations()).toEqual(removed);
    expect(next.registrations()).toEqual(attached);
    await expect(page.hello()).rejects.toThrow("No handler registered");
    await next.hello();
    broker.detach(tabs.personal.id);
    expect(next.registrations()).toEqual(removed);
    broker.detach(tabs.personal.id);

    // A page that is destroyed drops its tab.
    const closing = new FakeContents("https://a.example");
    broker.attach(tabs.work.id, closing);
    closing.destroyed = true;
    closing.emit("destroyed");
    expect(closing.registrations()).toEqual(removed);
    const dead = new FakeContents("https://a.example");
    dead.destroyed = true;
    broker.attach(tabs.work.id, dead);
    expect(dead.registrations()).toEqual(removed);

    // Disposing removes everything, the vault's listener included.
    const last = new FakeContents("https://a.example");
    broker.attach(tabs.personal.id, last);
    await last.hello();
    broker.dispose();
    expect(last.registrations()).toEqual(removed);
    await vault.add({
      kind: "form",
      origin: "https://a.example",
      username: "alice",
      password: "secret",
    });
    broker.controlChanged();
    expect(last.mainFrame.send).not.toHaveBeenCalled();
    const after = new FakeContents("https://a.example");
    broker.attach(tabs.personal.id, after);
    expect(after.registrations()).toEqual(removed);
  });

  it("connectForms wires the broker to the controller and the window", async () => {
    const vault = await openVault("https://a.example");
    const { state, tabs } = browserState();
    const existing = new FakeContents("https://a.example");
    const views = new Set<(tabId: string, contents: unknown) => void>();
    const registry = new Set<(event: RegistryEvent) => void>();
    const subscribers = new Set<(state: BrowserState) => void>();
    const subscribe =
      <T>(listeners: Set<T>) =>
      (listener: T) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
    const placement = {
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      visible: true,
    };
    const controller = {
      state,
      onViewCreated: subscribe(views),
      subscribe: subscribe(subscribers),
      registry: { on: subscribe(registry) },
      peekWebContents: vi.fn((tabId: string) =>
        tabId === tabs.personal.id ? existing : undefined,
      ),
      viewPlacement: vi.fn(() => placement),
      setPasswordPrompts: vi.fn(),
    };
    const window = {
      destroyed: false,
      isDestroyed: () => window.destroyed,
      isFocused: () => true,
      getContentBounds: () => ({ x: 40, y: 50, width: 800, height: 600 }),
    };
    const openManager = vi.fn();
    const broker = connectForms(
      controller as unknown as BrowserController,
      window as unknown as BrowserWindow,
      vault,
      { openManager },
    );
    brokers.push(broker);
    expect(controller.peekWebContents).toHaveBeenCalledTimes(state.tabs.length);
    expect(await existing.hello()).toEqual({
      fill: true,
      capture: true,
      checkOutcome: false,
    });

    const opened = new FakeContents("https://a.example");
    for (const listener of views) listener(tabs.agent.id, opened);
    expect(await opened.hello()).toEqual(off);
    for (const listener of registry)
      listener({
        type: "opened",
        spaceId: "agent",
        tabId: tabs.agent.id,
        openedBy: "agent",
      });
    expect(opened.registrations()).toEqual(attached);
    for (const listener of registry)
      listener({
        type: "closed",
        spaceId: "agent",
        tabId: tabs.agent.id,
        closedBy: "agent",
      });
    expect(opened.registrations()).toEqual(removed);

    // Every state change rechecks control.
    state.settings.offerToSavePasswords = false;
    for (const listener of subscribers) listener(state);
    expect(existing.mainFrame.send).toHaveBeenCalledExactlyOnceWith(
      FORM_CHANNELS.state,
      { fill: true, capture: false },
    );

    // The host calls through Electron's modules when it is used, so stubs
    // made later take effect.
    const host = (broker as unknown as { host: FormHost }).host;
    expect(host.state()).toBe(state);
    expect(host.view(tabs.personal.id)).toBe(placement);
    expect(controller.viewPlacement).toHaveBeenCalledWith(tabs.personal.id);
    expect(host.windowFocused()).toBe(true);
    expect(host.contentOrigin()).toMatchObject({ x: 40, y: 50 });
    vi.mocked(screen.getCursorScreenPoint).mockReturnValue({ x: 7, y: 8 });
    expect(host.cursor()).toEqual({ x: 7, y: 8 });
    const prompt = {
      id: "p",
      tabId: tabs.personal.id,
      kind: "save",
      host: "a.example",
      username: "alice",
    } as const;
    host.setPrompts([prompt]);
    expect(controller.setPasswordPrompts).toHaveBeenCalledWith([prompt]);
    const menu = { popup: vi.fn() };
    vi.mocked(Menu.buildFromTemplate).mockReturnValue(
      menu as unknown as Electron.Menu,
    );
    const items = [{ label: "alice" }];
    host.popup(items, { x: 10.4, y: 20.6 });
    expect(Menu.buildFromTemplate).toHaveBeenCalledWith(items);
    expect(menu.popup).toHaveBeenLastCalledWith({ window, x: 10, y: 21 });
    host.popup(items);
    expect(menu.popup).toHaveBeenLastCalledWith({ window });
    vi.mocked(dialog.showMessageBox).mockResolvedValue({
      response: 0,
      checkboxChecked: false,
    });
    expect(await host.confirm("Agents can read this page.", "Fill")).toBe(true);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(window, {
      type: "question",
      message: "Agents can read this page.",
      buttons: ["Fill", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    const showMessageBox = vi.fn(async () => ({
      response: 1,
      checkboxChecked: false,
    }));
    const original = dialog.showMessageBox;
    dialog.showMessageBox = showMessageBox as typeof dialog.showMessageBox;
    try {
      expect(await host.confirm("Agents can read this page.", "Fill")).toBe(
        false,
      );
      expect(showMessageBox).toHaveBeenCalledOnce();
    } finally {
      dialog.showMessageBox = original;
    }
    host.openManager();
    expect(openManager).toHaveBeenCalledOnce();
    window.destroyed = true;
    expect(host.windowFocused()).toBe(false);

    broker.dispose();
    expect(existing.registrations()).toEqual(removed);
    expect([views.size, registry.size, subscribers.size]).toEqual([0, 0, 0]);
  });
});
