import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fail } from "../electron/agent/errors";
import { createDispatchers } from "../electron/agent/input/dispatch";
import {
  KEYS,
  MODIFIER_BITS,
  chordCommands,
  keyParams,
  parseChord,
  type InputCommand,
} from "../electron/agent/input/keys";
import { inputMarker } from "../electron/agent/input/marker";
import { InputState, interpolate } from "../electron/agent/input/state";
import type { TabSession } from "../electron/agent/session/tab-session";
import type { SendStep, SetupHook } from "../electron/agent/session/types";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const settle = () => vi.advanceTimersByTimeAsync(0);
const key = (name: string) => KEYS[name.toLowerCase()];
const down = (name: string, mask = 0): InputCommand => ({
  method: "Input.dispatchKeyEvent",
  params: keyParams(key(name), "keyDown", mask),
});
const mouse = (
  type: string,
  params: Record<string, unknown> = {},
): InputCommand => ({
  method: "Input.dispatchMouseEvent",
  params: { type, ...params },
});

// The parts of a TabSession a dispatcher uses, with the sends and the shell
// flag recorded in one order.
class FakeContents {
  readonly ignore: { value: boolean; after: number }[] = [];
  constructor(private readonly session: FakeSession) {}
  setIgnoreMenuShortcuts = (value: boolean) => {
    this.ignore.push({ value, after: this.session.sent.length });
  };
}
class FakeSession {
  epoch = 0;
  readonly contents = new FakeContents(this);
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  readonly hooks = new Set<SetupHook>();
  // A send parks until the promise this returns settles.
  onSend?: (command: {
    method: string;
    params: Record<string, unknown>;
  }) => Promise<void> | void;
  private listeners = new Map<string, Set<(event: unknown) => void>>();
  constructor(readonly tabId = "tab-1") {}
  async send(
    method: string,
    params: Record<string, unknown> = {},
    step?: SendStep,
  ): Promise<unknown> {
    step?.guard?.();
    const command = { method, params };
    this.sent.push(command);
    await this.onSend?.(command);
    step?.guard?.();
    return {};
  }
  on(name: string, listener: (event: unknown) => void): () => void {
    const listeners = this.listeners.get(name) ?? new Set();
    this.listeners.set(name, listeners);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  onSessionSetup(hook: SetupHook): () => void {
    this.hooks.add(hook);
    return () => this.hooks.delete(hook);
  }
  emit(name: string, params: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(name) ?? [])])
      listener({ method: name, params, at: Date.now() });
  }
  keys(): string[] {
    return this.sent
      .filter((command) => command.method === "Input.dispatchKeyEvent")
      .map((command) => `${command.params.type}:${command.params.key}`);
  }
}
function dispatcherFor(options: { guard?: () => void } = {}) {
  const session = new FakeSession();
  const dispatchers = createDispatchers({
    guard: options.guard ?? (() => {}),
  });
  const dispatcher = dispatchers.for(session as unknown as TabSession);
  return { session, dispatchers, dispatcher };
}
const step = (): SendStep => ({ deadline: Date.now() + 10000 });

describe("input state", () => {
  it("keeps the position, held buttons, keys and the modifier mask", () => {
    const state = new InputState("tab-1");
    expect(state.view()).toEqual({
      x: 0,
      y: 0,
      buttons: 0,
      keys: [],
      modifiers: 0,
    });
    state.pressButton("left");
    state.pressButton("right");
    expect(state.buttons).toBe(3);
    state.pressButton("left");
    expect(state.buttons).toBe(3);
    expect(state.releaseButton("left")).toBe(true);
    expect(state.buttons).toBe(2);
    expect(state.releaseButton("left")).toBe(false);
    expect(state.releaseButton("middle")).toBe(false);

    state.holdKey(key("Shift"));
    state.holdKey(key("Control"));
    state.holdKey(key("KeyA"));
    expect(state.modifiers).toBe(10);
    expect(state.keyNames).toEqual(["Shift", "Control", "KeyA"]);
    expect(state.releaseKey(key("KeyA"))).toBe(true);
    expect(state.releaseKey(key("KeyA"))).toBe(false);
    expect(state.heldKeys().map((held) => held.name)).toEqual([
      "Shift",
      "Control",
    ]);
    state.moveTo({ x: 12, y: 34 });
    expect(state.view()).toEqual({
      x: 12,
      y: 34,
      buttons: 2,
      keys: ["Shift", "Control"],
      modifiers: 10,
    });
    const letGo = state.clear();
    expect(letGo.keys.map((held) => held.name)).toEqual(["Control", "Shift"]);
    expect(letGo.buttons).toEqual(["right"]);
    expect(state.view()).toEqual({
      x: 12,
      y: 34,
      buttons: 0,
      keys: [],
      modifiers: 0,
    });
    state.touch(5000);
    expect(state.touchedAt()).toBe(5000);
  });

  it("interpolates a move from the stored position", () => {
    expect(interpolate({ x: 0, y: 0 }, { x: 40, y: 20 }, 1)).toEqual([
      { x: 40, y: 20 },
    ]);
    expect(interpolate({ x: 0, y: 0 }, { x: 40, y: 20 }, 4)).toEqual([
      { x: 10, y: 5 },
      { x: 20, y: 10 },
      { x: 30, y: 15 },
      { x: 40, y: 20 },
    ]);
    expect(interpolate({ x: 5, y: 5 }, { x: 5, y: 5 }, 1)).toEqual([
      { x: 5, y: 5 },
    ]);
    expect(interpolate({ x: 5, y: 5 }, { x: 5, y: 5 }, 3)).toHaveLength(3);
  });
});

describe("input dispatcher", () => {
  it("adds the held modifiers and buttons to every command and records the result", async () => {
    const { session, dispatcher } = dispatcherFor();
    await dispatcher.key([down("Shift", MODIFIER_BITS.Shift)], step());
    expect(dispatcher.state.view()).toMatchObject({
      keys: ["Shift"],
      modifiers: 8,
    });
    await dispatcher.pointer([mouse("mouseMoved", { x: 10, y: 20 })], step());
    expect(session.sent.at(-1)!.params).toMatchObject({
      type: "mouseMoved",
      modifiers: 8,
      buttons: 0,
    });
    await dispatcher.pointer(
      [
        mouse("mousePressed", {
          x: 10,
          y: 20,
          button: "left",
          clickCount: 1,
        }),
        mouse("mouseMoved", { x: 12, y: 20 }),
      ],
      step(),
    );
    expect(
      session.sent.slice(-2).map((command) => command.params.buttons),
    ).toEqual([1, 1]);
    expect(dispatcher.state.view()).toMatchObject({ x: 12, y: 20, buttons: 1 });
    // A command that names its own modifiers or buttons keeps them.
    await dispatcher.pointer(
      [mouse("mouseMoved", { x: 12, y: 20, modifiers: 0, buttons: 0 })],
      step(),
    );
    expect(session.sent.at(-1)!.params).toMatchObject({
      modifiers: 0,
      buttons: 0,
    });
    // Key commands carry the mask their chord built.
    const chord = chordCommands(parseChord("Control+KeyA"), { mask: 8 });
    await dispatcher.key([...chord.down, ...chord.up], step());
    expect(
      session.sent.slice(-4).map((command) => command.params.modifiers),
    ).toEqual([10, 10, 10, 8]);
  });

  it("releases held keys in reverse, then the mouse", async () => {
    const { session, dispatcher, dispatchers } = dispatcherFor();
    const hold = async () => {
      await dispatcher.key(
        [
          down("Shift", MODIFIER_BITS.Shift),
          down("Control", MODIFIER_BITS.Shift | MODIFIER_BITS.Control),
        ],
        step(),
      );
      await dispatcher.pointer(
        [
          mouse("mousePressed", {
            x: 10,
            y: 20,
            button: "left",
            clickCount: 1,
          }),
        ],
        step(),
      );
      session.sent.length = 0;
    };
    // A cross-document navigation, reported with a different epoch.
    await hold();
    session.epoch = 1;
    session.emit("frame", { change: "navigated" });
    await settle();
    expect(session.sent).toEqual([
      {
        method: "Input.dispatchKeyEvent",
        params: keyParams(key("Control"), "keyUp", MODIFIER_BITS.Shift),
      },
      {
        method: "Input.dispatchKeyEvent",
        params: keyParams(key("Shift"), "keyUp", 0),
      },
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseReleased",
          x: 10,
          y: 20,
          button: "left",
          clickCount: 1,
          buttons: 0,
          modifiers: 0,
        },
      },
    ]);
    expect(dispatcher.state.view()).toEqual({
      x: 10,
      y: 20,
      buttons: 0,
      keys: [],
      modifiers: 0,
    });

    // Sixty seconds without input requests.
    await hold();
    await vi.advanceTimersByTimeAsync(60001);
    expect(session.keys()).toEqual(["keyUp:Control", "keyUp:Shift"]);
    expect(session.sent.at(-1)!.params).toMatchObject({
      type: "mouseReleased",
      buttons: 0,
    });

    // The session letting go lets no mouse release out.
    await hold();
    session.emit("releasing");
    await settle();
    expect(session.sent.map((command) => command.method)).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);
    // A released session can send nothing more, so it holds nothing, and
    // the position stays for the tab's next session.
    expect(dispatcher.state.view()).toEqual({
      x: 10,
      y: 20,
      buttons: 0,
      keys: [],
      modifiers: 0,
    });

    // On request, keys only or everything.
    await hold();
    expect(await dispatcher.release(step(), { keysOnly: true })).toEqual([
      "Control",
      "Shift",
    ]);
    expect(session.sent.map((command) => command.method)).toEqual([
      "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent",
    ]);
    expect(await dispatcher.release(step())).toEqual(["left"]);
    expect(await dispatcher.release(step())).toEqual([]);
    expect(await dispatchers.release(session as unknown as TabSession)).toEqual(
      [],
    );
    dispatchers.dispose();
  });

  it("authorizes every command and stops at a takeover", async () => {
    let allowed = false;
    const guard = vi.fn(() => {
      if (!allowed)
        fail("human_control", "The person took over this space.", {
          reason: "manual",
        });
    });
    const { session, dispatcher } = dispatcherFor({ guard });
    await expect(
      dispatcher.key([down("KeyA"), down("KeyB")], step()),
    ).rejects.toMatchObject({ code: "human_control" });
    expect(session.sent).toEqual([]);

    allowed = true;
    session.onSend = () => {
      allowed = false;
    };
    await expect(
      dispatcher.send([down("KeyA"), down("KeyB"), down("KeyC")], step()),
    ).rejects.toMatchObject({ code: "human_control" });
    expect(session.keys()).toEqual(["keyDown:a"]);
  });

  it("spans setIgnoreMenuShortcuts over a key operation and marks each key", async () => {
    const { session, dispatcher } = dispatcherFor();
    const chord = chordCommands(parseChord("Meta+KeyW"), { mask: 0 }, "darwin");
    await dispatcher.key([...chord.down, ...chord.up], step());
    expect(session.contents.ignore).toEqual([
      { value: true, after: 0 },
      { value: false, after: 4 },
    ]);
    const shell = {
      type: "keyDown",
      key: "w",
      code: "KeyW",
      alt: false,
      control: false,
      meta: true,
      shift: false,
    };
    expect(inputMarker.keyInFlight(session.contents, shell)).toBe(true);
    expect(inputMarker.keyInFlight(session.contents, shell)).toBe(false);
    expect(inputMarker.busy(session.contents)).toBe(false);

    // A nested operation restores the flag once.
    session.contents.ignore.length = 0;
    session.sent.length = 0;
    let carryOn!: () => void;
    session.onSend = (command) =>
      command.params.code === "KeyA" && command.params.type === "keyDown"
        ? new Promise<void>((resolve) => {
            carryOn = resolve;
          })
        : undefined;
    const outer = dispatcher.key([down("KeyA")], step());
    await settle();
    expect(session.contents.ignore).toEqual([{ value: true, after: 0 }]);
    session.onSend = undefined;
    const inner = dispatcher.key([down("KeyB")], step());
    await settle();
    expect(inputMarker.busy(session.contents)).toBe(true);
    carryOn();
    await Promise.all([outer, inner]);
    expect(session.contents.ignore).toEqual([
      { value: true, after: 0 },
      { value: false, after: 2 },
    ]);
    expect(inputMarker.busy(session.contents)).toBe(false);
  });
});
