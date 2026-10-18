// One input state per agent tab, held in the main process: where the pointer
// is, which buttons and keys are down and what mask they make. Element
// actions and the raw mouse and keyboard routes share it, so a held Shift
// reaches the next command and a release knows what to let go.
import { MODIFIER_BITS, type KeyDef } from "./keys";

export type Button = "left" | "middle" | "right";

// Chromium's buttons bitfield, as Input.dispatchMouseEvent takes it.
export const BUTTON_BITS: Readonly<Record<Button, number>> = {
  left: 1,
  right: 2,
  middle: 4,
};

export interface InputView {
  x: number;
  y: number;
  buttons: number;
  keys: string[];
  modifiers: number;
}

export class InputState {
  x = 0;
  y = 0;
  private held: Button[] = [];
  private down: KeyDef[] = [];
  private touched = Date.now();

  constructor(readonly tabId: string) {}

  get buttons(): number {
    return this.held.reduce((bits, button) => bits | BUTTON_BITS[button], 0);
  }
  get modifiers(): number {
    return this.down.reduce(
      (bits, key) => (key.modifier ? bits | MODIFIER_BITS[key.modifier] : bits),
      0,
    );
  }
  get keyNames(): readonly string[] {
    return this.down.map((key) => key.name);
  }

  moveTo(point: { x: number; y: number }): void {
    this.x = point.x;
    this.y = point.y;
  }
  pressButton(button: Button): void {
    if (!this.held.includes(button)) this.held.push(button);
  }
  releaseButton(button: Button): boolean {
    const at = this.held.indexOf(button);
    if (at < 0) return false;
    this.held.splice(at, 1);
    return true;
  }
  holdKey(key: KeyDef): void {
    if (!this.down.some((other) => other.name === key.name))
      this.down.push(key);
  }
  releaseKey(key: KeyDef): boolean {
    const at = this.down.findIndex((other) => other.name === key.name);
    if (at < 0) return false;
    this.down.splice(at, 1);
    return true;
  }
  heldKeys(): KeyDef[] {
    return [...this.down];
  }
  heldButtons(): Button[] {
    return [...this.held];
  }
  view(): InputView {
    return {
      x: this.x,
      y: this.y,
      buttons: this.buttons,
      keys: [...this.keyNames],
      modifiers: this.modifiers,
    };
  }
  // When this tab last had an input request, for the idle release.
  touch(at = Date.now()): void {
    this.touched = at;
  }
  touchedAt(): number {
    return this.touched;
  }
  // Forgets every held key and button, keeping the position. Keys come back
  // last pressed first, which is the order they are let go in.
  clear(): { keys: KeyDef[]; buttons: Button[] } {
    const keys = [...this.down].reverse();
    const buttons = [...this.held];
    this.down = [];
    this.held = [];
    return { keys, buttons };
  }
}

// The points a move visits, evenly spaced, the last exactly on target.
export function interpolate(
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps: number,
): { x: number; y: number }[] {
  const total = Math.max(1, Math.floor(steps));
  return Array.from({ length: total }, (_, index) =>
    index === total - 1
      ? { x: to.x, y: to.y }
      : {
          x: from.x + ((to.x - from.x) * (index + 1)) / total,
          y: from.y + ((to.y - from.y) * (index + 1)) / total,
        },
  );
}
