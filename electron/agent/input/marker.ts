// What the shell reads to tell an agent's input from the person's. The tab's
// dispatcher records every Input command here; controller.ts consults it in
// before-input-event, in the context-menu handler and in the pane activation,
// so agent keys reach no shortcut or menu role, an agent right click opens no
// native menu and agent mouse input activates no split pane.
//
// The record is a WeakMap keyed by the WebContents object, so the shell
// imports this one symbol and never the agent server.

// How long a right click stays the agent's after its input, and how long an
// unmatched key record is kept.
export const MENU_GUARD_MS = 1000;

export interface MarkedKey {
  key: string;
  code: string;
  type: "keyDown" | "rawKeyDown" | "keyUp";
  mask: number;
}
// The fields of Electron's before-input-event input this match needs.
export interface ShellInput {
  type: string;
  key: string;
  code: string;
  alt: boolean;
  control: boolean;
  meta: boolean;
  shift: boolean;
}
export interface InputMarker {
  /** Spans one agent input operation on a tab. */
  begin(contents: object): () => void;
  busy(contents: object): boolean;
  markKey(contents: object, key: MarkedKey): void;
  keyInFlight(contents: object, input: ShellInput): boolean;
  markPointer(contents: object): void;
  pointerRecent(contents: object, withinMs?: number): boolean;
  humanInput(contents: object): void;
}

type Mark = {
  depth: number;
  keys: (MarkedKey & { at: number })[];
  pointerAt: number;
};
const marks = new WeakMap<object, Mark>();
const markOf = (contents: object): Mark => {
  const found = marks.get(contents);
  if (found) return found;
  const made: Mark = { depth: 0, keys: [], pointerAt: 0 };
  marks.set(contents, made);
  return made;
};
// Electron's mask, as Input.dispatchKeyEvent takes it.
const maskOf = (input: ShellInput) =>
  (input.alt ? 1 : 0) |
  (input.control ? 2 : 0) |
  (input.meta ? 4 : 0) |
  (input.shift ? 8 : 0);
// A key goes up or comes down; rawKeyDown reaches the shell as a keyDown.
const sameWay = (type: string, shell: string) =>
  (type === "keyUp") === (shell === "keyUp");

export const inputMarker: InputMarker = {
  begin(contents) {
    const mark = markOf(contents);
    mark.depth += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      mark.depth -= 1;
      mark.pointerAt = Date.now();
    };
  },
  busy(contents) {
    return markOf(contents).depth > 0;
  },
  markKey(contents, key) {
    const mark = markOf(contents);
    const now = Date.now();
    mark.keys = mark.keys.filter((held) => now - held.at < MENU_GUARD_MS);
    mark.keys.push({ ...key, at: now });
  },
  // True once for the shell event an agent key raises. A key the page
  // swallows leaves no record behind, so the person's own key still works.
  keyInFlight(contents, input) {
    const mark = markOf(contents);
    const now = Date.now();
    mark.keys = mark.keys.filter((held) => now - held.at < MENU_GUARD_MS);
    const mask = maskOf(input);
    const at = mark.keys.findIndex(
      (held) =>
        held.code === input.code &&
        held.key.toLowerCase() === input.key.toLowerCase() &&
        held.mask === mask &&
        sameWay(held.type, input.type),
    );
    if (at < 0) return false;
    mark.keys.splice(at, 1);
    return true;
  },
  markPointer(contents) {
    markOf(contents).pointerAt = Date.now();
  },
  pointerRecent(contents, withinMs = MENU_GUARD_MS) {
    const mark = markOf(contents);
    return mark.depth > 0 || Date.now() - mark.pointerAt <= withinMs;
  },
  // The person's own input, which ends the guard at once. Input that arrives
  // while an agent operation is in flight is the agent's.
  humanInput(contents) {
    const mark = markOf(contents);
    if (mark.depth > 0) return;
    mark.pointerAt = 0;
    mark.keys = [];
  },
};
