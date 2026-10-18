// The AppKit standard key bindings a macOS chord carries, named as Chromium
// editing commands. Nothing here inserts text or touches the clipboard, so no
// entry is insert, copy, cut, paste, pasteAndMatchStyle or yank.
import type { Chord } from "./keys";

// The mask bits keys.ts defines.
const ALT = 1;
const CONTROL = 2;
const META = 4;
const SHIFT = 8;

// Modifier mask, key name, command.
const TABLE: readonly (readonly [number, string, string])[] = [
  [0, "Backspace", "deleteBackward"],
  [0, "Delete", "deleteForward"],
  [0, "ArrowUp", "moveUp"],
  [0, "ArrowDown", "moveDown"],
  [0, "ArrowLeft", "moveLeft"],
  [0, "ArrowRight", "moveRight"],
  [0, "Home", "scrollToBeginningOfDocument"],
  [0, "End", "scrollToEndOfDocument"],
  [0, "PageUp", "movePageUp"],
  [0, "PageDown", "movePageDown"],
  [SHIFT, "Backspace", "deleteBackward"],
  [SHIFT, "Delete", "deleteForward"],
  [SHIFT, "ArrowUp", "moveUpAndModifySelection"],
  [SHIFT, "ArrowDown", "moveDownAndModifySelection"],
  [SHIFT, "ArrowLeft", "moveLeftAndModifySelection"],
  [SHIFT, "ArrowRight", "moveRightAndModifySelection"],
  [SHIFT, "Home", "moveToBeginningOfDocumentAndModifySelection"],
  [SHIFT, "End", "moveToEndOfDocumentAndModifySelection"],
  [SHIFT, "PageUp", "movePageUpAndModifySelection"],
  [SHIFT, "PageDown", "movePageDownAndModifySelection"],
  [ALT, "ArrowLeft", "moveWordLeft"],
  [ALT, "ArrowRight", "moveWordRight"],
  [ALT, "ArrowUp", "moveParagraphBackward"],
  [ALT, "ArrowDown", "moveParagraphForward"],
  [ALT, "Backspace", "deleteWordBackward"],
  [ALT, "Delete", "deleteWordForward"],
  [ALT | SHIFT, "ArrowLeft", "moveWordLeftAndModifySelection"],
  [ALT | SHIFT, "ArrowRight", "moveWordRightAndModifySelection"],
  [META, "KeyA", "selectAll"],
  [META, "KeyZ", "undo"],
  [META, "ArrowLeft", "moveToBeginningOfLine"],
  [META, "ArrowRight", "moveToEndOfLine"],
  [META, "ArrowUp", "moveToBeginningOfDocument"],
  [META, "ArrowDown", "moveToEndOfDocument"],
  [META, "Backspace", "deleteToBeginningOfLine"],
  [META | SHIFT, "KeyZ", "redo"],
  [META | SHIFT, "ArrowLeft", "moveToBeginningOfLineAndModifySelection"],
  [META | SHIFT, "ArrowRight", "moveToEndOfLineAndModifySelection"],
  [META | SHIFT, "ArrowUp", "moveToBeginningOfDocumentAndModifySelection"],
  [META | SHIFT, "ArrowDown", "moveToEndOfDocumentAndModifySelection"],
  [CONTROL, "KeyA", "moveToBeginningOfParagraph"],
  [CONTROL, "KeyE", "moveToEndOfParagraph"],
  [CONTROL, "KeyB", "moveLeft"],
  [CONTROL, "KeyF", "moveRight"],
  [CONTROL, "KeyP", "moveUp"],
  [CONTROL, "KeyN", "moveDown"],
  [CONTROL, "KeyD", "deleteForward"],
  [CONTROL, "KeyH", "deleteBackward"],
  [CONTROL, "KeyK", "deleteToEndOfParagraph"],
  [CONTROL, "KeyT", "transpose"],
  [CONTROL, "KeyV", "movePageDown"],
  [CONTROL, "KeyW", "deleteWordBackward"],
];

// A chord's signature is its mask and its key's name.
export const MAC_COMMANDS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    TABLE.map(([mask, name, command]) => [`${mask}:${name}`, [command]]),
  );

// What a command does without Chromium's own key handling, for pages where
// the commands do not arrive.
export const MAC_COMMAND_FALLBACK: Readonly<Record<string, string>> = {
  selectAll: "selectAll",
  undo: "undo",
  redo: "redo",
  deleteBackward: "delete",
  deleteForward: "forwardDelete",
};

export function macCommands(
  chord: Chord,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "darwin") return [];
  return [...(MAC_COMMANDS[`${chord.mask}:${chord.key.name}`] ?? [])];
}
