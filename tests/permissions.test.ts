import { describe, expect, it } from "vitest";
import {
  HOLDABLE,
  isPermissionKey,
  PERMISSION_KEYS,
  permissionKeysFor,
  permissionWords,
  promptKindFor,
} from "../shared/permissions";

describe("permissions", () => {
  it("maps every Electron permission and media detail to its keys, words and prompt kind, and refuses unknown ones", () => {
    expect(permissionKeysFor("geolocation")).toEqual(["geolocation"]);
    expect(permissionKeysFor("notifications")).toEqual(["notifications"]);
    expect(permissionKeysFor("midi")).toEqual(["midi"]);
    expect(permissionKeysFor("midiSysex")).toEqual(["midi-sysex"]);
    expect(permissionKeysFor("clipboard-read")).toEqual(["clipboard-read"]);
    expect(permissionKeysFor("clipboard-sanitized-write")).toEqual([
      "clipboard-write",
    ]);
    expect(permissionKeysFor("fullscreen")).toEqual(["fullscreen"]);
    expect(permissionKeysFor("pointerLock")).toEqual(["pointer-lock"]);
    expect(permissionKeysFor("display-capture")).toEqual(["display-capture"]);
    expect(permissionKeysFor("speaker-selection")).toEqual([
      "speaker-selection",
    ]);
    // A request names its media types; a check names the one it asks about.
    expect(permissionKeysFor("media", { mediaTypes: ["video"] })).toEqual([
      "camera",
    ]);
    expect(permissionKeysFor("media", { mediaTypes: ["audio"] })).toEqual([
      "microphone",
    ]);
    expect(
      permissionKeysFor("media", { mediaTypes: ["audio", "video", "video"] }),
    ).toEqual(["camera", "microphone"]);
    expect(permissionKeysFor("media", { mediaType: "video" })).toEqual([
      "camera",
    ]);
    expect(permissionKeysFor("media", { mediaType: "audio" })).toEqual([
      "microphone",
    ]);
    // Everything Kamapathy never grants, and media with nothing it knows.
    for (const permission of [
      "media",
      "idle-detection",
      "openExternal",
      "window-management",
      "storage-access",
      "top-level-storage-access",
      "keyboardLock",
      "deprecated-sync-clipboard-read",
      "usb",
      "hid",
      "serial",
      "unknown",
      "",
    ])
      expect(permissionKeysFor(permission)).toBeUndefined();
    expect(permissionKeysFor("media", { mediaTypes: [] })).toBeUndefined();
    expect(
      permissionKeysFor("media", { mediaTypes: ["audio", "screen"] }),
    ).toBeUndefined();
    expect(
      permissionKeysFor("media", { mediaType: "unknown" }),
    ).toBeUndefined();
    // The prompt a set of keys asks under.
    expect(promptKindFor(["geolocation"])).toBe("location");
    expect(promptKindFor(["camera"])).toBe("camera");
    expect(promptKindFor(["microphone"])).toBe("microphone");
    expect(promptKindFor(["camera", "microphone"])).toBe("camera_microphone");
    expect(promptKindFor(["microphone", "camera"])).toBe("camera_microphone");
    expect(promptKindFor(["midi"])).toBe("midi");
    expect(promptKindFor(["midi-sysex"])).toBe("midi-sysex");
    // The words a line about a request uses.
    expect(permissionWords("location")).toBe("location");
    expect(permissionWords("camera_microphone")).toBe("camera and microphone");
    expect(permissionWords("usb")).toBe("a USB device");
    expect(permissionWords("http_sign_in")).toBe("a sign-in");
    for (const kind of [
      "location",
      "notifications",
      "camera",
      "microphone",
      "camera_microphone",
      "midi",
      "usb",
      "hid",
      "serial",
      "bluetooth",
      "http_sign_in",
      "proxy_sign_in",
      "client_certificate",
      ...PERMISSION_KEYS,
    ] as const)
      expect(permissionWords(kind)).toBeTruthy();
    // The keys, and only the five a request in an agent tab may hold.
    expect(PERMISSION_KEYS).toHaveLength(12);
    for (const key of PERMISSION_KEYS) expect(isPermissionKey(key)).toBe(true);
    for (const value of ["", "camera-microphone", "midi_sysex", 1, null])
      expect(isPermissionKey(value)).toBe(false);
    expect(HOLDABLE).toEqual([
      "geolocation",
      "notifications",
      "camera",
      "microphone",
      "midi",
    ]);
    for (const key of HOLDABLE) expect(isPermissionKey(key)).toBe(true);
  });
});
