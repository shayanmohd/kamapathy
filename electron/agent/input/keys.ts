// The US key layout agents name, with Playwright's key names, chord parsing,
// name suggestions and the rules that turn a chord into Input commands. Pure
// data and functions, so routes, the client checks and tests share one table.
import { suggest } from "../../../skills/kamapathy/scripts/schema/index.mjs";
import { fail } from "../errors";
import { macCommands } from "./mac-commands";

export type Modifier = "Alt" | "Control" | "Meta" | "Shift";

// Chromium's modifier bits, as Input.dispatchKeyEvent takes them.
export const MODIFIER_BITS: Readonly<Record<Modifier, number>> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

export interface KeyDef {
  // The canonical name: ArrowLeft, KeyA, Digit1, Numpad0, F12, Space.
  name: string;
  key: string;
  code: string;
  // Sent as both windowsVirtualKeyCode and nativeVirtualKeyCode.
  keyCode: number;
  // What it types with no modifier but Shift.
  text?: string;
  // Set on the variant Shift types, such as the A of KeyA.
  shift?: boolean;
  // 3 for the numeric keypad.
  location?: number;
  keypad?: true;
  // Set on Shift, Control, Alt and Meta themselves.
  modifier?: Modifier;
}
export interface Chord {
  tokens: string[];
  modifiers: Modifier[];
  mask: number;
  key: KeyDef;
}
export interface InputCommand {
  method:
    | "Input.dispatchKeyEvent"
    | "Input.dispatchMouseEvent"
    | "Input.dispatchWheelEvent"
    | "Input.insertText";
  params: Record<string, unknown>;
}

export const MAX_CHORD_TOKENS = 6;
export const MAX_CHORD_CHARS = 64;
export const KEY_FORMS =
  "Use a key name such as Enter, KeyA or ArrowLeft, a printable character, or a chord such as Shift+KeyA.";

// Keys that type a character on their own and another one with Shift:
// name, key code, the character, the character Shift types.
const TYPING: readonly (readonly [string, number, string, string])[] = [
  ...Array.from({ length: 26 }, (_, index) => {
    const letter = String.fromCharCode(97 + index);
    return [
      `Key${letter.toUpperCase()}`,
      65 + index,
      letter,
      letter.toUpperCase(),
    ] as const;
  }),
  ...[")", "!", "@", "#", "$", "%", "^", "&", "*", "("].map(
    (shifted, digit) =>
      [`Digit${digit}`, 48 + digit, String(digit), shifted] as const,
  ),
  ["Backquote", 192, "`", "~"],
  ["Minus", 189, "-", "_"],
  ["Equal", 187, "=", "+"],
  ["BracketLeft", 219, "[", "{"],
  ["BracketRight", 221, "]", "}"],
  ["Backslash", 220, "\\", "|"],
  ["Semicolon", 186, ";", ":"],
  ["Quote", 222, "'", '"'],
  ["Comma", 188, ",", "<"],
  ["Period", 190, ".", ">"],
  ["Slash", 191, "/", "?"],
];

const table: KeyDef[] = [];
const shifted: Record<string, KeyDef> = {};
for (const [name, keyCode, plain, upper] of TYPING) {
  table.push({ name, key: plain, code: name, keyCode, text: plain });
  shifted[name] = {
    name,
    key: upper,
    code: name,
    keyCode,
    text: upper,
    shift: true,
  };
}
for (const [name, keyCode, key, text] of [
  ["Enter", 13, "Enter", "\r"],
  ["Space", 32, " ", " "],
] as const)
  table.push({ name, key, code: name, keyCode, text });
for (const [name, keyCode] of [
  ["ArrowLeft", 37],
  ["ArrowUp", 38],
  ["ArrowRight", 39],
  ["ArrowDown", 40],
  ["Home", 36],
  ["End", 35],
  ["PageUp", 33],
  ["PageDown", 34],
  ["Insert", 45],
  ["Delete", 46],
  ["Backspace", 8],
  ["Tab", 9],
  ["Escape", 27],
  ["CapsLock", 20],
  ["ContextMenu", 93],
] as const)
  table.push({ name, key: name, code: name, keyCode });
for (let number = 1; number <= 24; number++)
  table.push({
    name: `F${number}`,
    key: `F${number}`,
    code: `F${number}`,
    keyCode: 111 + number,
  });
for (const [name, keyCode] of [
  ["Shift", 16],
  ["Control", 17],
  ["Alt", 18],
  ["Meta", 91],
] as const)
  table.push({
    name,
    key: name,
    code: `${name}Left`,
    keyCode,
    modifier: name,
  });
// The numeric keypad as it types with Num Lock on.
for (let digit = 0; digit <= 9; digit++)
  table.push({
    name: `Numpad${digit}`,
    key: String(digit),
    code: `Numpad${digit}`,
    keyCode: 96 + digit,
    text: String(digit),
    location: 3,
    keypad: true,
  });
for (const [name, keyCode, key] of [
  ["NumpadMultiply", 106, "*"],
  ["NumpadAdd", 107, "+"],
  ["NumpadSubtract", 109, "-"],
  ["NumpadDecimal", 110, "."],
  ["NumpadDivide", 111, "/"],
] as const)
  table.push({
    name,
    key,
    code: name,
    keyCode,
    text: key,
    location: 3,
    keypad: true,
  });
table.push({
  name: "NumpadEnter",
  key: "Enter",
  code: "NumpadEnter",
  keyCode: 13,
  text: "\r",
  location: 3,
  keypad: true,
});

export const KEYS: Readonly<Record<string, KeyDef>> = Object.fromEntries(
  table.map((key) => [key.name.toLowerCase(), key]),
);
const NAMES = table.map((key) => key.name);

// The left-hand code spellings Playwright also accepts for the modifiers.
export const KEY_ALIASES: Readonly<Record<string, string>> = {
  shiftleft: "Shift",
  controlleft: "Control",
  altleft: "Alt",
  metaleft: "Meta",
};

// A character to the key that types it. The main keyboard wins, so the
// keypad is reachable by name only.
const CHARACTERS: Record<string, KeyDef> = {
  " ": KEYS.space,
  "\n": KEYS.enter,
  "\r": KEYS.enter,
};
for (const [name, , plain, upper] of TYPING) {
  CHARACTERS[plain] = KEYS[name.toLowerCase()];
  CHARACTERS[upper] = shifted[name];
}

// Spellings people and other tools use for keys this table names otherwise.
const HINTS: Readonly<Record<string, string>> = {
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  esc: "Escape",
  cmd: "Meta",
  command: "Meta",
  option: "Alt",
  ctrl: "Control",
  return: "Enter",
  del: "Delete",
  ins: "Insert",
  pgup: "PageUp",
  pgdn: "PageDown",
};

// A map entry by a name an agent chose, so names every object carries are
// not keys of their own.
const entry = <T>(
  map: Readonly<Record<string, T>>,
  name: string,
): T | undefined => (Object.hasOwn(map, name) ? map[name] : undefined);

export function suggestKey(token: string): string | undefined {
  return entry(HINTS, token.toLowerCase()) ?? suggest(token, NAMES);
}

const badKey = (message: string, token?: string): never => {
  const suggestion = token === undefined ? undefined : suggestKey(token);
  return fail(
    "invalid_key",
    `${message}${suggestion ? ` Did you mean ${suggestion}?` : ""} ${KEY_FORMS}`,
    { ...(suggestion ? { suggestion } : {}), forms: KEY_FORMS },
  );
};
const shown = (token: string) =>
  JSON.stringify(token.slice(0, MAX_CHORD_CHARS));

function modifierOf(
  token: string,
  platform: NodeJS.Platform,
): Modifier | undefined {
  const lower = token.toLowerCase();
  if (lower === "controlormeta")
    return platform === "darwin" ? "Meta" : "Control";
  const name = entry(KEY_ALIASES, lower) ?? token;
  return entry(KEYS, name.toLowerCase())?.modifier;
}

export function parseKey(
  token: string,
  platform: NodeJS.Platform = process.platform,
): KeyDef {
  if (Array.from(token).length === 1) {
    const character = entry(CHARACTERS, token);
    if (character) return character;
    return badKey(`${shown(token)} is not a character the US layout types.`);
  }
  const lower = token.toLowerCase();
  if (lower === "controlormeta")
    return platform === "darwin" ? KEYS.meta : KEYS.control;
  const known = entry(KEYS, (entry(KEY_ALIASES, lower) ?? token).toLowerCase());
  if (known) return known;
  return badKey(`${shown(token)} is not a key Kamapathy knows.`, token);
}

// Tokens split on +, and a + that starts a token is the plus key itself.
function splitChord(key: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let start = true;
  for (const character of key) {
    if (character === "+" && !start) {
      tokens.push(token);
      token = "";
      start = true;
      continue;
    }
    token += character;
    start = false;
  }
  tokens.push(token);
  return tokens;
}

export function parseChord(
  key: string,
  platform: NodeJS.Platform = process.platform,
): Chord {
  if (key.length > MAX_CHORD_CHARS)
    return badKey(`A key is at most ${MAX_CHORD_CHARS} characters.`);
  const tokens = splitChord(key);
  if (tokens.length > MAX_CHORD_TOKENS)
    return badKey(`A chord holds at most ${MAX_CHORD_TOKENS} keys.`);
  if (tokens.some((token) => token === ""))
    return badKey("A chord has an empty part.");
  const modifiers: Modifier[] = [];
  let mask = 0;
  for (const token of tokens.slice(0, -1)) {
    const modifier = modifierOf(token, platform);
    if (!modifier)
      return badKey(
        `${shown(token)} is not a modifier. Only Shift, Control, Alt, Meta and ControlOrMeta come before the key.`,
        token,
      );
    mask |= MODIFIER_BITS[modifier];
    if (!modifiers.includes(modifier)) modifiers.push(modifier);
  }
  const final = parseKey(tokens[tokens.length - 1], platform);
  if (final.shift) mask |= MODIFIER_BITS.Shift;
  return { tokens, modifiers, mask, key: final };
}

// The key as this mask types it: Shift picks the key's shifted character.
const typedBy = (key: KeyDef, mask: number) =>
  (mask & MODIFIER_BITS.Shift) !== 0 && !key.shift
    ? (shifted[key.name] ?? key)
    : key;

export function keyType(key: KeyDef, mask: number): "keyDown" | "rawKeyDown" {
  return (mask & ~MODIFIER_BITS.Shift) === 0 &&
    typedBy(key, mask).text !== undefined
    ? "keyDown"
    : "rawKeyDown";
}

export function keyParams(
  key: KeyDef,
  type: "keyDown" | "rawKeyDown" | "keyUp",
  mask: number,
  options: { autoRepeat?: boolean; commands?: readonly string[] } = {},
): Record<string, unknown> {
  const typed = typedBy(key, mask);
  const text =
    type === "keyDown" && keyType(key, mask) === "keyDown"
      ? typed.text
      : undefined;
  return {
    type,
    key: typed.key,
    code: key.code,
    windowsVirtualKeyCode: key.keyCode,
    nativeVirtualKeyCode: key.keyCode,
    modifiers: mask,
    ...(text === undefined ? {} : { text, unmodifiedText: text }),
    ...(key.location === undefined ? {} : { location: key.location }),
    ...(key.keypad ? { isKeypad: true } : {}),
    ...(options.autoRepeat ? { autoRepeat: true } : {}),
    ...(options.commands?.length ? { commands: [...options.commands] } : {}),
  };
}

const keyEvent = (
  key: KeyDef,
  type: "keyDown" | "rawKeyDown" | "keyUp",
  mask: number,
  options?: { autoRepeat?: boolean; commands?: readonly string[] },
): InputCommand => ({
  method: "Input.dispatchKeyEvent",
  params: keyParams(key, type, mask, options),
});

// The modifiers go down in token order and come up in reverse, each event
// carrying the mask as it is at that moment. The caller inserts its own
// delay between the two lists.
export function chordCommands(
  chord: Chord,
  held: { mask: number },
  platform: NodeJS.Platform = process.platform,
): { down: InputCommand[]; up: InputCommand[] } {
  const down: InputCommand[] = [];
  let mask = held.mask;
  for (const modifier of chord.modifiers) {
    mask |= MODIFIER_BITS[modifier];
    down.push(keyEvent(KEYS[modifier.toLowerCase()], "keyDown", mask));
  }
  const full = mask | chord.mask;
  down.push(
    keyEvent(chord.key, keyType(chord.key, full), full, {
      commands: macCommands({ ...chord, mask: full }, platform),
    }),
  );
  const up: InputCommand[] = [keyEvent(chord.key, "keyUp", full)];
  for (const modifier of [...chord.modifiers].reverse()) {
    mask &= ~MODIFIER_BITS[modifier];
    up.push(keyEvent(KEYS[modifier.toLowerCase()], "keyUp", mask));
  }
  return { down, up };
}

// One group per character: key events for what the US layout types, one
// insertText for anything else, and Enter for a newline. The held mask
// travels with each character, so typing while the agent holds Shift types
// what a person holding it would.
export function textCommands(
  text: string,
  platform: NodeJS.Platform = process.platform,
  held: { mask: number } = { mask: 0 },
): InputCommand[][] {
  return Array.from(text.replace(/\r\n/g, "\n")).map((character) => {
    const key = CHARACTERS[character];
    if (!key)
      return [
        { method: "Input.insertText", params: { text: character } },
      ] satisfies InputCommand[];
    const { down, up } = chordCommands(
      {
        tokens: [character],
        modifiers: [],
        mask: key.shift ? MODIFIER_BITS.Shift : 0,
        key,
      },
      held,
      platform,
    );
    return [...down, ...up];
  });
}

// Copy, cut and paste chords, held modifiers included. Nothing in Kamapathy
// reaches the system clipboard, so these never become key events.
const CLIPBOARD_CHORDS: readonly (readonly [number, string])[] = [
  [MODIFIER_BITS.Control, "KeyC"],
  [MODIFIER_BITS.Control, "KeyX"],
  [MODIFIER_BITS.Control, "KeyV"],
  [MODIFIER_BITS.Shift | MODIFIER_BITS.Control, "KeyV"],
  [MODIFIER_BITS.Control, "Insert"],
  [MODIFIER_BITS.Shift, "Insert"],
  [MODIFIER_BITS.Shift, "Delete"],
];
const MAC_CLIPBOARD_CHORDS: readonly (readonly [number, string])[] = [
  [MODIFIER_BITS.Meta, "KeyC"],
  [MODIFIER_BITS.Meta, "KeyX"],
  [MODIFIER_BITS.Meta, "KeyV"],
  [MODIFIER_BITS.Shift | MODIFIER_BITS.Meta, "KeyV"],
  [MODIFIER_BITS.Control, "KeyY"],
];

export function checkClipboardChord(
  chord: Chord,
  heldModifiers: readonly Modifier[],
  platform: NodeJS.Platform = process.platform,
): void {
  const mask = heldModifiers.reduce(
    (bits, modifier) => bits | MODIFIER_BITS[modifier],
    chord.mask,
  );
  const refused =
    platform === "darwin" ? MAC_CLIPBOARD_CHORDS : CLIPBOARD_CHORDS;
  if (refused.some(([bits, name]) => bits === mask && name === chord.key.name))
    fail(
      "clipboard_blocked",
      "Kamapathy never uses the system clipboard. Use keyboard.paste or fill instead.",
    );
}
