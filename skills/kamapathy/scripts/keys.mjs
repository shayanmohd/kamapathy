// The key names and chord grammar the client checks before a request, kept
// equal to the server table in electron/agent/input/keys.ts. Node built-ins
// only, so the skill can import it anywhere.

export const KEY_NAMES = [
  "Alt",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "Backquote",
  "Backslash",
  "Backspace",
  "BracketLeft",
  "BracketRight",
  "CapsLock",
  "Comma",
  "ContextMenu",
  "Control",
  "Delete",
  "Digit0",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "End",
  "Enter",
  "Equal",
  "Escape",
  "F1",
  "F10",
  "F11",
  "F12",
  "F13",
  "F14",
  "F15",
  "F16",
  "F17",
  "F18",
  "F19",
  "F2",
  "F20",
  "F21",
  "F22",
  "F23",
  "F24",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "Home",
  "Insert",
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "KeyZ",
  "Meta",
  "Minus",
  "Numpad0",
  "Numpad1",
  "Numpad2",
  "Numpad3",
  "Numpad4",
  "Numpad5",
  "Numpad6",
  "Numpad7",
  "Numpad8",
  "Numpad9",
  "NumpadAdd",
  "NumpadDecimal",
  "NumpadDivide",
  "NumpadEnter",
  "NumpadMultiply",
  "NumpadSubtract",
  "PageDown",
  "PageUp",
  "Period",
  "Quote",
  "Semicolon",
  "Shift",
  "Slash",
  "Space",
  "Tab",
];
export const MODIFIER_NAMES = [
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "ControlOrMeta",
];
export const MAX_CHORD_CHARS = 64;

const MAX_CHORD_TOKENS = 6;
// The left-hand code spellings the server also accepts.
const ALIASES = ["ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft"];
// Every character the US layout types, with the space and newline spellings.
const CHARACTERS = new Set([
  ...Array.from("abcdefghijklmnopqrstuvwxyz"),
  ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"),
  ...Array.from("0123456789"),
  ...Array.from(")!@#$%^&*("),
  ...Array.from("`-=[]\\;',./"),
  ...Array.from('~_+{}|:"<>?'),
  " ",
  "\n",
  "\r",
]);
const lowered = (names) => new Set(names.map((name) => name.toLowerCase()));
const KEYS = lowered([...KEY_NAMES, ...ALIASES, "ControlOrMeta"]);
const MODIFIERS = lowered([...MODIFIER_NAMES, ...ALIASES]);

export const isKeyName = (token) =>
  typeof token === "string" && KEYS.has(token.toLowerCase());

// Tokens split on +, and a + that starts a token is the plus key itself.
function splitChord(key) {
  const tokens = [];
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

export function isChord(value) {
  if (typeof value !== "string" || value.length > MAX_CHORD_CHARS) return false;
  const tokens = splitChord(value);
  if (tokens.length > MAX_CHORD_TOKENS || tokens.some((token) => !token))
    return false;
  const key = tokens[tokens.length - 1];
  return (
    tokens.slice(0, -1).every((token) => MODIFIERS.has(token.toLowerCase())) &&
    (isKeyName(key) || (Array.from(key).length === 1 && CHARACTERS.has(key)))
  );
}
