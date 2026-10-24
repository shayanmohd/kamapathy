// One InputDispatcher per TabSession: the only path agent input takes. It
// authorizes each command, records it in the shell's marker, adds the held
// modifiers and buttons, spans setIgnoreMenuShortcuts over a key operation,
// sends on the top page session and lets held input go when the page
// navigates, when the tab falls idle, when the session releases or on
// request.
//
// What a probe of Electron 44 (Chromium 152) showed, which shaped this file:
// agent keys do raise before-input-event on the tab, carrying the key, code
// and modifiers the Input command named, so the shell has to skip them; a
// bare modifier keyDown raises none while its keyUp does, so an unmatched
// record has to expire. The context-menu event followed an agent right click
// after 12 ms, so the shell's menu guard is needed. Focus emulation is needed
// for keys to reach a tab that was never shown: with it off, a focused field
// received no key, input or change event, with it on all three arrived and
// the window stayed hidden and unfocused. Whether an unhandled chord reaches
// an application menu role could not be observed, since the probe never shows
// or focuses a window; the spanned flag stays as the spec asks for it.
import type { CursorPoint } from "../cursor";
import type { TabSession } from "../session/tab-session";
import type { SendStep, Step } from "../session/types";
import {
  KEYS,
  KEY_ALIASES,
  MODIFIER_BITS,
  keyParams,
  type InputCommand,
  type KeyDef,
} from "./keys";
import { inputMarker, type InputMarker } from "./marker";
import { BUTTON_BITS, InputState, type Button } from "./state";

// How long a release and a setup hook wait for the page.
const RELEASE_MS = 2000;
const SETUP_MS = 5000;
const IDLE_MS = 60000;

// final keeps a release going while the session lets go.
export type DispatchStep = Step & { final?: boolean };

export interface InputDispatcher {
  readonly state: InputState;
  send(commands: readonly InputCommand[], step: DispatchStep): Promise<void>;
  /** Spans setIgnoreMenuShortcuts over the operation. */
  key(commands: readonly InputCommand[], step: DispatchStep): Promise<void>;
  /** Marks the pointer and reports its points to the cursor hook. */
  pointer(commands: readonly InputCommand[], step: DispatchStep): Promise<void>;
  /** The names it let go, in release order. */
  release(step: Step, options?: { keysOnly?: boolean }): Promise<string[]>;
}
export interface InputDispatchers {
  for(session: TabSession): InputDispatcher;
  release(
    session: TabSession,
    options?: { keysOnly?: boolean },
  ): Promise<string[]>;
  dispose(): void;
}

type InputHost = TabSession["contents"] & {
  setIgnoreMenuShortcuts?(ignore: boolean): void;
};
// A map entry by a name that came from a command, so names every object
// carries are not keys of their own.
const entry = <T>(
  map: Readonly<Record<string, T>>,
  name: string,
): T | undefined => (Object.hasOwn(map, name) ? map[name] : undefined);
// The key a dispatched event names, by its code.
const keyOf = (params: Record<string, unknown>): KeyDef | undefined => {
  const code = typeof params.code === "string" ? params.code.toLowerCase() : "";
  return entry(KEYS, (entry(KEY_ALIASES, code) ?? code).toLowerCase());
};
const buttonOf = (params: Record<string, unknown>): Button | undefined =>
  typeof params.button === "string" && entry(BUTTON_BITS, params.button)
    ? (params.button as Button)
    : undefined;
const pointOf = (params: Record<string, unknown>) =>
  typeof params.x === "number" &&
  Number.isFinite(params.x) &&
  typeof params.y === "number" &&
  Number.isFinite(params.y)
    ? { x: params.x, y: params.y }
    : undefined;
// A press rings the cursor and a release ends the ring; everything else,
// a wheel included, only moves it.
const moveOf = (params: Record<string, unknown>): CursorPoint["type"] =>
  params.type === "mousePressed"
    ? "press"
    : params.type === "mouseReleased"
      ? "release"
      : "move";
const KEY_TYPES = ["keyDown", "rawKeyDown", "keyUp"] as const;
const MASKED = [
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.dispatchWheelEvent",
];

export function createDispatchers(deps: {
  guard(tabId: string): void;
  marker?: InputMarker;
  cursor?(tabId: string, point: CursorPoint): void;
  platform?: NodeJS.Platform;
  idleMs?: number;
  now?(): number;
}): InputDispatchers {
  const marker = deps.marker ?? inputMarker;
  const idleMs = deps.idleMs ?? IDLE_MS;
  const now = deps.now ?? (() => Date.now());
  // One state per tab, so a session that re-attaches, or a new session after
  // the person hands the tab back, takes it over with its position.
  const states = new Map<string, InputState>();
  const made = new Map<
    TabSession,
    { dispatcher: InputDispatcher; drop(): void }
  >();

  const create = (session: TabSession) => {
    const tabId = session.tabId;
    const input = states.get(tabId) ?? new InputState(tabId);
    states.set(tabId, input);
    const host = session.contents as InputHost;
    let menuDepth = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The epoch the last command was sent under; a later event under another
    // one means the main frame navigated across documents.
    let epoch = session.epoch;

    const held = () =>
      input.heldKeys().length > 0 || input.heldButtons().length > 0;
    const ignoreMenu = (change: 1 | -1) => {
      menuDepth += change;
      if (change === 1 && menuDepth === 1) host.setIgnoreMenuShortcuts?.(true);
      if (change === -1 && menuDepth === 0)
        host.setIgnoreMenuShortcuts?.(false);
    };
    // Each command takes the state's held modifiers and buttons unless it
    // names its own, and changes the state it is sent under.
    const prepare = (command: InputCommand): InputCommand => {
      const params = { ...command.params };
      if (command.method === "Input.dispatchKeyEvent") {
        const key = keyOf(params);
        if (key) {
          if (params.type === "keyUp") input.releaseKey(key);
          else input.holdKey(key);
        }
      } else if (
        command.method === "Input.dispatchMouseEvent" ||
        command.method === "Input.dispatchWheelEvent"
      ) {
        const point = pointOf(params);
        if (point) input.moveTo(point);
        const button = buttonOf(params);
        if (button && params.type === "mousePressed") input.pressButton(button);
        if (button && params.type === "mouseReleased")
          input.releaseButton(button);
        // Only a mouse event carries the buttons bitfield.
        if (
          command.method === "Input.dispatchMouseEvent" &&
          params.buttons === undefined
        )
          params.buttons = input.buttons;
      }
      if (MASKED.includes(command.method) && params.modifiers === undefined)
        params.modifiers = input.modifiers;
      return { method: command.method, params };
    };
    const mark = (params: Record<string, unknown>) => {
      const type = KEY_TYPES.find((name) => name === params.type);
      if (!type) return;
      marker.markKey(host, {
        key: String(params.key ?? ""),
        code: String(params.code ?? ""),
        type,
        mask: typeof params.modifiers === "number" ? params.modifiers : 0,
      });
    };
    const run = async (
      commands: readonly InputCommand[],
      step: DispatchStep,
      mode: { pointer?: boolean; menu?: boolean },
    ) => {
      if (commands.length === 0) return;
      const sending: SendStep = {
        deadline: step.deadline,
        signal: step.signal,
        dispatch: step.dispatch,
        guard: step.final
          ? undefined
          : () => {
              step.guard?.();
              deps.guard(tabId);
            },
      };
      const end = marker.begin(host);
      if (mode.menu) ignoreMenu(1);
      try {
        if (mode.pointer) marker.markPointer(host);
        for (const command of commands) {
          if (!step.final) deps.guard(tabId);
          const sent = prepare(command);
          if (sent.method === "Input.dispatchKeyEvent") mark(sent.params);
          const point = mode.pointer ? pointOf(sent.params) : undefined;
          if (point)
            deps.cursor?.(tabId, { ...point, type: moveOf(sent.params) });
          epoch = session.epoch;
          input.touch(now());
          await session.send(sent.method, sent.params, sending);
        }
      } finally {
        if (mode.menu) ignoreMenu(-1);
        end();
        armIdle();
      }
    };
    const letGo = async (
      step: Step,
      options: { keysOnly?: boolean } = {},
    ): Promise<string[]> => {
      const keys = input.heldKeys().reverse();
      const buttons = options.keysOnly ? [] : input.heldButtons();
      if (keys.length === 0 && buttons.length === 0) return [];
      const commands: InputCommand[] = [];
      const released: string[] = [];
      // Each keyUp carries the mask as it is once that key is up.
      let mask = input.modifiers;
      for (const key of keys) {
        if (key.modifier) mask &= ~MODIFIER_BITS[key.modifier];
        commands.push({
          method: "Input.dispatchKeyEvent",
          params: keyParams(key, "keyUp", mask),
        });
        released.push(key.name);
      }
      for (const button of buttons) {
        commands.push({
          method: "Input.dispatchMouseEvent",
          params: {
            type: "mouseReleased",
            x: input.x,
            y: input.y,
            button,
            clickCount: 1,
          },
        });
        released.push(button);
      }
      await run(commands, { ...step, final: true }, {});
      return released;
    };
    const idle = () => {
      if (!held()) return;
      if (now() - input.touchedAt() < idleMs) {
        armIdle();
        return;
      }
      void letGo({ deadline: now() + RELEASE_MS }).catch(() => {});
    };
    const armIdle = () => {
      clearTimeout(timer);
      timer = undefined;
      if (!held()) return;
      timer = setTimeout(
        idle,
        Math.max(0, idleMs - (now() - input.touchedAt())),
      );
    };
    const navigated = () => {
      if (session.epoch === epoch) return;
      epoch = session.epoch;
      if (held()) void letGo({ deadline: now() + RELEASE_MS }).catch(() => {});
    };

    const dispatcher: InputDispatcher = {
      state: input,
      send: (commands, step) => run(commands, step, {}),
      key: (commands, step) => run(commands, step, { menu: true }),
      pointer: (commands, step) => run(commands, step, { pointer: true }),
      release: (step, options) => letGo(step, options),
    };
    const stops = [
      session.on("frame", navigated),
      session.on("lifecycle", navigated),
      session.on("detached", navigated),
      // A release lets keys go, never a button a page may drop something on.
      // The session waits for this, so it goes out before the detach. What it
      // held is then forgotten, since nothing more can be sent for it.
      session.on("releasing", () =>
        letGo({ deadline: now() + RELEASE_MS }, { keysOnly: true })
          .catch(() => {})
          .finally(() => {
            input.clear();
            drop();
          }),
      ),
      session.on("closed", () => {
        drop();
        if (states.get(tabId) === input) states.delete(tabId);
      }),
      // Hidden tabs fire focus, blur and change, and take key input at all,
      // only with focus emulation on, and it moves no operating system focus.
      session.onSessionSetup((sessionId) =>
        session.send(
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
          { sessionId, deadline: now() + SETUP_MS },
        ),
      ),
    ];
    const drop = () => {
      for (const stop of stops.splice(0)) stop();
      clearTimeout(timer);
      timer = undefined;
      if (made.get(session)?.dispatcher === dispatcher) made.delete(session);
    };
    return { dispatcher, drop };
  };

  const dispatcherFor = (session: TabSession) => {
    const found = made.get(session);
    if (found) return found.dispatcher;
    const fresh = create(session);
    made.set(session, fresh);
    return fresh.dispatcher;
  };
  return {
    for: dispatcherFor,
    release: (session, options) =>
      dispatcherFor(session).release({ deadline: now() + RELEASE_MS }, options),
    dispose() {
      for (const entry of [...made.values()]) entry.drop();
      made.clear();
      states.clear();
    },
  };
}
