import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../electron/agent/errors";
import {
  KEYS,
  KEY_ALIASES,
  KEY_FORMS,
  MAX_CHORD_CHARS,
  MODIFIER_BITS,
  chordCommands,
  checkClipboardChord,
  keyParams,
  keyType,
  parseChord,
  parseKey,
  suggestKey,
  textCommands,
  type Modifier,
} from "../electron/agent/input/keys";
import {
  MAC_COMMANDS,
  MAC_COMMAND_FALLBACK,
  macCommands,
} from "../electron/agent/input/mac-commands";
import { PRESS_KEYS } from "../electron/agent/validate";
import { ERRORS } from "../skills/kamapathy/scripts/schema/index.mjs";
import {
  KEY_NAMES,
  MAX_CHORD_CHARS as CLIENT_MAX_CHORD_CHARS,
  MODIFIER_NAMES,
  isChord,
  isKeyName,
} from "../skills/kamapathy/scripts/keys.mjs";

const problem = (call: () => unknown) => {
  try {
    call();
  } catch (error) {
    if (error instanceof ApiError)
      return { code: error.code, status: error.status, ...error.fields };
    throw error;
  }
  throw new Error("The call did not fail.");
};
const names = Object.values(KEYS).map((key) => key.name);
// Every printable character of the US layout, plus the space and newline
// spellings both sides accept as a key of their own.
const characters = Array.from(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" +
    "`-=[]\\;',./~!@#$%^&*()_+{}|:\"<>? \n\r",
);

describe("key names and chords", () => {
  it("splits chords, keeps a literal plus and parses today's keys", () => {
    const plus = parseChord("Control++");
    expect(plus.tokens).toEqual(["Control", "+"]);
    expect(plus.key.name).toBe("Equal");
    expect(plus.key.key).toBe("+");
    expect(plus.modifiers).toEqual(["Control"]);
    // The plus needs Shift on the US layout, so the mask holds Control and Shift.
    expect(plus.mask).toBe(MODIFIER_BITS.Control | MODIFIER_BITS.Shift);
    const alone = parseChord("+");
    expect(alone.tokens).toEqual(["+"]);
    expect(alone.key.name).toBe("Equal");
    expect(alone.mask).toBe(MODIFIER_BITS.Shift);

    const chord = parseChord("Control+Shift+KeyA");
    expect(chord.mask).toBe(10);
    expect(chord.modifiers).toEqual(["Control", "Shift"]);
    expect(chord.key.name).toBe("KeyA");
    expect(parseChord("Shift+Shift+KeyA").mask).toBe(MODIFIER_BITS.Shift);
    expect(parseChord("Shift+Shift+KeyA").modifiers).toEqual(["Shift"]);

    for (const spelling of ["enter", "ENTER", "Enter"])
      expect(parseChord(spelling).key.name).toBe("Enter");
    expect(parseChord("arrowleft").key.name).toBe("ArrowLeft");

    expect(parseKey("a")).toMatchObject({ name: "KeyA", key: "a", text: "a" });
    expect(parseKey("a").shift).toBeUndefined();
    expect(parseKey("A")).toMatchObject({
      name: "KeyA",
      key: "A",
      text: "A",
      shift: true,
    });
    expect(parseChord("A").mask).toBe(MODIFIER_BITS.Shift);
    expect(parseChord("a").mask).toBe(0);
    expect(parseKey(" ").name).toBe("Space");
    expect(parseKey("\n").name).toBe("Enter");
  });

  it("parses all 14 keys press supports today unchanged", () => {
    expect(Object.keys(PRESS_KEYS)).toHaveLength(14);
    for (const [name, spec] of Object.entries(PRESS_KEYS)) {
      const key = parseChord(name).key;
      expect(
        { key: key.key, code: key.code, keyCode: key.keyCode, text: key.text },
        name,
      ).toEqual({
        key: spec.key,
        code: spec.code,
        keyCode: spec.keyCode,
        text: spec.text,
      });
    }
  });

  it("refuses too many tokens, too many characters and empty parts", () => {
    expect(
      problem(() => parseChord("Shift+Control+Alt+Meta+Shift+Control+KeyA")),
    ).toMatchObject({
      code: "invalid_key",
      status: 400,
      forms: KEY_FORMS,
    });
    const long = `Shift+${"A".repeat(59)}`;
    expect(long).toHaveLength(MAX_CHORD_CHARS + 1);
    expect(problem(() => parseChord(long))).toMatchObject({
      code: "invalid_key",
      status: 400,
    });
    for (const key of ["", "Control+", "Shift+Control+"])
      expect(
        problem(() => parseChord(key)),
        key,
      ).toMatchObject({
        code: "invalid_key",
        status: 400,
      });
    expect(problem(() => parseChord("KeyA+KeyB"))).toMatchObject({
      code: "invalid_key",
      status: 400,
    });
  });

  it("maps ControlOrMeta per platform", () => {
    expect(parseChord("ControlOrMeta+KeyV", "darwin").modifiers).toEqual([
      "Meta",
    ]);
    expect(parseChord("ControlOrMeta+KeyV", "darwin").mask).toBe(
      MODIFIER_BITS.Meta,
    );
    for (const platform of ["win32", "linux"] as const) {
      expect(
        parseChord("controlormeta+KeyV", platform).modifiers,
        platform,
      ).toEqual(["Control"]);
      expect(parseChord("ControlOrMeta+KeyV", platform).mask, platform).toBe(
        MODIFIER_BITS.Control,
      );
    }
    expect(parseKey("ControlOrMeta", "darwin").name).toBe("Meta");
    expect(parseKey("ControlOrMeta", "linux").name).toBe("Control");
  });

  it("suggests the nearest name", () => {
    expect(suggestKey("Left")).toBe("ArrowLeft");
    expect(suggestKey("Esc")).toBe("Escape");
    expect(suggestKey("Cmd")).toBe("Meta");
    expect(suggestKey("Backspce")).toBe("Backspace");
    expect(suggestKey("Frobnicate")).toBeUndefined();
    const near = problem(() => parseKey("Left"));
    expect(near).toMatchObject({
      code: "invalid_key",
      status: 400,
      suggestion: "ArrowLeft",
      forms: KEY_FORMS,
    });
    expect(ERRORS.invalid_key.fields).toEqual(
      expect.arrayContaining(["suggestion", "forms"]),
    );
    const far = problem(() => parseKey("Frobnicate"));
    expect(far).toMatchObject({ code: "invalid_key", forms: KEY_FORMS });
    expect(far).not.toHaveProperty("suggestion");
    expect(problem(() => parseChord("Ctrl+KeyA"))).toMatchObject({
      code: "invalid_key",
      suggestion: "Control",
    });
    // Names every object carries are keys like any other unknown name.
    for (const token of ["constructor", "__proto__", "toString"]) {
      expect(suggestKey(token), token).toBeUndefined();
      expect(
        problem(() => parseKey(token)),
        token,
      ).toMatchObject({
        code: "invalid_key",
      });
      expect(
        problem(() => parseChord(`${token}+KeyA`)),
        token,
      ).toMatchObject({
        code: "invalid_key",
      });
    }
  });
});

describe("key events", () => {
  it("sends keyDown with text only for a typing key with no modifier but Shift", () => {
    expect(keyType(KEYS.keya, 0)).toBe("keyDown");
    expect(keyParams(KEYS.keya, "keyDown", 0)).toEqual({
      type: "keyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: 0,
      text: "a",
      unmodifiedText: "a",
    });
    expect(keyType(KEYS.keya, MODIFIER_BITS.Shift)).toBe("keyDown");
    expect(keyParams(KEYS.keya, "keyDown", MODIFIER_BITS.Shift)).toMatchObject({
      key: "A",
      text: "A",
      modifiers: 8,
    });
    expect(keyType(KEYS.keya, MODIFIER_BITS.Control)).toBe("rawKeyDown");
    expect(keyParams(KEYS.keya, "rawKeyDown", MODIFIER_BITS.Control)).toEqual({
      type: "rawKeyDown",
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: MODIFIER_BITS.Control,
    });
    expect(
      keyParams(KEYS.keya, "keyUp", MODIFIER_BITS.Shift),
    ).not.toHaveProperty("text");
    expect(keyParams(KEYS.enter, "keyDown", 0).text).toBe("\r");
    expect(keyType(KEYS.arrowleft, 0)).toBe("rawKeyDown");
    expect(keyParams(KEYS.numpad0, "keyDown", 0)).toMatchObject({
      code: "Numpad0",
      text: "0",
      location: 3,
      isKeypad: true,
    });
    expect(keyParams(KEYS.keya, "keyDown", 0)).not.toHaveProperty("location");
    expect(
      keyParams(KEYS.keya, "keyDown", 0, { autoRepeat: true }).autoRepeat,
    ).toBe(true);
    expect(
      keyParams(KEYS.keya, "keyDown", 0, { commands: ["selectAll"] }).commands,
    ).toEqual(["selectAll"]);
    expect(
      keyParams(KEYS.keya, "keyDown", 0, { commands: [] }),
    ).not.toHaveProperty("commands");
    for (const key of Object.values(KEYS)) {
      const params = keyParams(key, keyType(key, 0), 0);
      expect(params.windowsVirtualKeyCode, key.name).toBe(key.keyCode);
      expect(params.nativeVirtualKeyCode, key.name).toBe(key.keyCode);
      expect(Number.isInteger(key.keyCode), key.name).toBe(true);
    }
  });

  it("presses modifiers in token order and releases them in reverse", () => {
    const chord = chordCommands(
      parseChord("Control+Shift+KeyA"),
      { mask: 0 },
      "linux",
    );
    expect(
      chord.down.map((command) => [
        command.params.code,
        command.params.modifiers,
      ]),
    ).toEqual([
      ["ControlLeft", MODIFIER_BITS.Control],
      ["ShiftLeft", MODIFIER_BITS.Control | MODIFIER_BITS.Shift],
      ["KeyA", 10],
    ]);
    expect(chord.down.at(-1)?.params.type).toBe("rawKeyDown");
    expect(
      chord.up.map((command) => [
        command.params.code,
        command.params.modifiers,
      ]),
    ).toEqual([
      ["KeyA", 10],
      ["ShiftLeft", MODIFIER_BITS.Control],
      ["ControlLeft", 0],
    ]);
    for (const command of [...chord.down, ...chord.up])
      expect(command.method).toBe("Input.dispatchKeyEvent");
    // A held modifier joins the mask, so the key stops typing text.
    const held = chordCommands(
      parseChord("a"),
      { mask: MODIFIER_BITS.Control },
      "linux",
    );
    expect(held.down).toHaveLength(1);
    expect(held.down[0].params).toMatchObject({
      type: "rawKeyDown",
      modifiers: MODIFIER_BITS.Control,
    });
  });

  it("types characters as keys and anything else as inserted text", () => {
    const groups = textCommands("aB\né", "linux");
    expect(groups).toHaveLength(4);
    expect(groups[0].map((command) => command.params.type)).toEqual([
      "keyDown",
      "keyUp",
    ]);
    expect(groups[0][0].params).toMatchObject({ text: "a", modifiers: 0 });
    expect(groups[1][0].params).toMatchObject({
      text: "B",
      modifiers: MODIFIER_BITS.Shift,
    });
    expect(groups[2][0].params).toMatchObject({ code: "Enter", text: "\r" });
    expect(groups[3]).toEqual([
      { method: "Input.insertText", params: { text: "é" } },
    ]);
    expect(textCommands("\r\n", "linux")).toHaveLength(1);
  });
});

describe("macOS commands", () => {
  it("carries the standard key bindings a chord sends", () => {
    const commands = (key: string) =>
      macCommands(parseChord(key, "darwin"), "darwin");
    expect(commands("Meta+KeyA")).toEqual(["selectAll"]);
    expect(commands("Meta+KeyZ")).toEqual(["undo"]);
    expect(commands("Shift+Meta+KeyZ")).toEqual(["redo"]);
    expect(commands("Meta+ArrowLeft")).toEqual(["moveToBeginningOfLine"]);
    expect(commands("Backspace")).toEqual(["deleteBackward"]);
    const chord = chordCommands(
      parseChord("Meta+KeyA", "darwin"),
      { mask: 0 },
      "darwin",
    );
    expect(chord.down.at(-1)?.params.commands).toEqual(["selectAll"]);
    expect(chord.down[0].params).not.toHaveProperty("commands");
    expect(chord.up.every((command) => !("commands" in command.params))).toBe(
      true,
    );
  });

  it("never carries a clipboard or insert command", () => {
    const all = Object.values(MAC_COMMANDS).flat();
    expect(all.length).toBeGreaterThan(20);
    for (const command of all) {
      expect([
        "insert",
        "copy",
        "cut",
        "paste",
        "pasteAndMatchStyle",
        "yank",
      ]).not.toContain(command);
      expect(command.startsWith("insert"), command).toBe(false);
    }
    for (const [command, fallback] of Object.entries(MAC_COMMAND_FALLBACK)) {
      expect(all, command).toContain(command);
      expect(typeof fallback).toBe("string");
    }
    expect(MAC_COMMAND_FALLBACK.selectAll).toBe("selectAll");
    expect(MAC_COMMAND_FALLBACK.deleteBackward).toBe("delete");
  });

  it("sends no commands away from macOS", () => {
    for (const platform of ["win32", "linux"] as const) {
      expect(
        macCommands(parseChord("Meta+KeyA", platform), platform),
        platform,
      ).toEqual([]);
      const chord = chordCommands(
        parseChord("Meta+KeyA", platform),
        { mask: 0 },
        platform,
      );
      expect(chord.down.at(-1)?.params, platform).not.toHaveProperty(
        "commands",
      );
    }
  });
});

describe("clipboard chords", () => {
  const builder = vi.fn(chordCommands);
  const press = (
    key: string,
    held: Modifier[] = [],
    platform: NodeJS.Platform = "darwin",
  ) => {
    const chord = parseChord(key, platform);
    checkClipboardChord(chord, held, platform);
    const mask = held.reduce(
      (bits, modifier) => bits | MODIFIER_BITS[modifier],
      0,
    );
    return builder(chord, { mask }, platform);
  };

  it("refuses copy, cut and paste chords before any key is sent", () => {
    builder.mockClear();
    const refused: [string, Modifier[], NodeJS.Platform][] = [
      ["Meta+KeyC", [], "darwin"],
      ["Meta+KeyX", [], "darwin"],
      ["Meta+KeyV", [], "darwin"],
      ["Shift+Meta+KeyV", [], "darwin"],
      ["Control+KeyY", [], "darwin"],
      ["KeyV", ["Meta"], "darwin"],
      ...(["win32", "linux"] as const).flatMap(
        (platform): [string, Modifier[], NodeJS.Platform][] => [
          ["Control+KeyC", [], platform],
          ["Control+KeyX", [], platform],
          ["Control+KeyV", [], platform],
          ["Shift+Control+KeyV", [], platform],
          ["Control+Insert", [], platform],
          ["Shift+Insert", [], platform],
          ["Shift+Delete", [], platform],
          ["KeyV", ["Control"], platform],
        ],
      ),
    ];
    for (const [key, held, platform] of refused)
      expect(
        problem(() => press(key, held, platform)),
        `${platform} ${key}`,
      ).toMatchObject({
        code: "clipboard_blocked",
        status: 403,
      });
    expect(builder).not.toHaveBeenCalled();
  });

  it("explains the refusal and leaves other chords alone", () => {
    try {
      press("Meta+KeyV");
      throw new Error("The chord was not refused.");
    } catch (error) {
      expect((error as ApiError).message).toBe(
        "Kamapathy never uses the system clipboard. Use keyboard.paste or fill instead.",
      );
    }
    builder.mockClear();
    for (const [key, held, platform] of [
      ["Control+KeyV", [], "darwin"],
      ["Meta+KeyC", [], "win32"],
      ["Control+KeyA", [], "linux"],
      ["Shift+KeyV", [], "darwin"],
      ["Insert", [], "win32"],
    ] as [string, Modifier[], NodeJS.Platform][])
      expect(
        () => press(key, held, platform),
        `${platform} ${key}`,
      ).not.toThrow();
    expect(builder).toHaveBeenCalledTimes(5);
  });
});

describe("the client's key names", () => {
  it("matches the server table", () => {
    expect(KEY_NAMES).toEqual([...names].sort());
    for (const character of characters)
      expect(
        () => parseKey(character),
        JSON.stringify(character),
      ).not.toThrow();
    for (const key of Object.values(KEYS))
      if (key.text && !key.name.startsWith("Numpad"))
        expect(characters, key.name).toContain(key.text);
    expect(new Set(KEY_NAMES).size).toBe(KEY_NAMES.length);
    expect(MODIFIER_NAMES).toEqual([
      "Shift",
      "Control",
      "Alt",
      "Meta",
      "ControlOrMeta",
    ]);
    expect(CLIENT_MAX_CHORD_CHARS).toBe(MAX_CHORD_CHARS);
    for (const name of names) expect(isKeyName(name), name).toBe(true);
    for (const alias of Object.keys(KEY_ALIASES))
      expect(isKeyName(alias), alias).toBe(true);
    for (const name of [...MODIFIER_NAMES, "controlormeta", "enter"])
      expect(isKeyName(name), name).toBe(true);
    for (const name of ["Left", "Cmd", "", "KeyAA"])
      expect(isKeyName(name), name).toBe(false);
  });

  it("agrees with the server over accepted and rejected spellings", () => {
    const accepted = [
      "Enter",
      "enter",
      "a",
      "A",
      " ",
      "\n",
      "+",
      "Control++",
      "Control+Shift+KeyA",
      "ControlOrMeta+KeyV",
      "F12",
      "Numpad0",
      "Meta",
      ...Object.keys(KEY_ALIASES),
      ...characters,
    ];
    const rejected = [
      "",
      "Control+",
      "Left",
      "Esc",
      "KeyA+KeyB",
      "Shift+Control+Alt+Meta+Shift+Control+KeyA",
      `Shift+${"A".repeat(59)}`,
      "é",
      "\t",
      "KeyAA",
      "constructor",
      "constructor+KeyA",
    ];
    for (const key of accepted) {
      expect(isChord(key), JSON.stringify(key)).toBe(true);
      expect(
        () => parseChord(key, "darwin"),
        JSON.stringify(key),
      ).not.toThrow();
    }
    for (const key of rejected) {
      expect(isChord(key), JSON.stringify(key)).toBe(false);
      expect(() => parseChord(key, "darwin"), JSON.stringify(key)).toThrow();
    }
    expect(isChord(undefined)).toBe(false);
    expect(isChord(42)).toBe(false);
  });
});
