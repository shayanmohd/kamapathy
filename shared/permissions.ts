// The permissions Kamapathy grants, how Electron's own names map onto them,
// and the words people and agents read. Nothing else is ever granted.
export type PermissionKey =
  | "geolocation"
  | "notifications"
  | "camera"
  | "microphone"
  | "midi"
  | "midi-sysex"
  | "clipboard-read"
  | "clipboard-write"
  | "fullscreen"
  | "pointer-lock"
  | "display-capture"
  | "speaker-selection";
export const PERMISSION_KEYS: readonly PermissionKey[] = [
  "geolocation",
  "notifications",
  "camera",
  "microphone",
  "midi",
  "midi-sysex",
  "clipboard-read",
  "clipboard-write",
  "fullscreen",
  "pointer-lock",
  "display-capture",
  "speaker-selection",
];
/** The permissions a request in an agent tab may hold for the person. */
export const HOLDABLE: readonly PermissionKey[] = [
  "geolocation",
  "notifications",
  "camera",
  "microphone",
  "midi",
];
/** The device choosers a site can open. */
export type DeviceKind = "usb" | "hid" | "serial" | "bluetooth";
export const DEVICE_KINDS: readonly DeviceKind[] = [
  "usb",
  "hid",
  "serial",
  "bluetooth",
];
export type PromptKind =
  | "location"
  | "notifications"
  | "camera"
  | "microphone"
  | "camera_microphone"
  | "midi"
  | "usb"
  | "hid"
  | "serial"
  | "bluetooth"
  | "http_sign_in"
  | "proxy_sign_in"
  | "client_certificate"
  | PermissionKey;

export function isPermissionKey(value: unknown): value is PermissionKey {
  return (
    typeof value === "string" &&
    PERMISSION_KEYS.includes(value as PermissionKey)
  );
}

// Electron's permission strings. A media request lists the types it wants
// and a media check names one; anything else is not a permission Kamapathy
// grants.
const NAMES: Record<string, PermissionKey> = {
  geolocation: "geolocation",
  notifications: "notifications",
  midi: "midi",
  midiSysex: "midi-sysex",
  "clipboard-read": "clipboard-read",
  "clipboard-sanitized-write": "clipboard-write",
  fullscreen: "fullscreen",
  pointerLock: "pointer-lock",
  "display-capture": "display-capture",
  "speaker-selection": "speaker-selection",
};
const MEDIA: Record<string, PermissionKey> = {
  audio: "microphone",
  video: "camera",
};

/** Electron's permission string and request details to Kamapathy's keys;
 *  undefined for anything Kamapathy never grants. */
export function permissionKeysFor(
  permission: string,
  details?: { mediaTypes?: readonly string[]; mediaType?: string },
): PermissionKey[] | undefined {
  if (permission !== "media") {
    const key = NAMES[permission];
    return key ? [key] : undefined;
  }
  const types =
    details?.mediaTypes ?? (details?.mediaType ? [details.mediaType] : []);
  if (!types.length || types.some((type) => !MEDIA[type])) return undefined;
  const keys = [...new Set(types.map((type) => MEDIA[type]))];
  // One order, so a saved camera and microphone decision reads the same way
  // whichever order the page asked in.
  return PERMISSION_KEYS.filter((key) => keys.includes(key));
}

/** The prompt kind a set of keys asks under: camera and microphone together
 *  become camera_microphone, geolocation becomes location. */
export function promptKindFor(keys: readonly PermissionKey[]): PromptKind {
  if (keys.includes("camera") && keys.includes("microphone"))
    return "camera_microphone";
  const key = keys[0];
  if (key === "geolocation") return "location";
  return key;
}

const WORDS: Record<PromptKind, string> = {
  location: "location",
  geolocation: "location",
  notifications: "notifications",
  camera: "camera",
  microphone: "microphone",
  camera_microphone: "camera and microphone",
  midi: "MIDI devices",
  "midi-sysex": "MIDI devices and their system messages",
  "clipboard-read": "the clipboard",
  "clipboard-write": "the clipboard",
  fullscreen: "full screen",
  "pointer-lock": "the pointer",
  "display-capture": "your screen",
  "speaker-selection": "your speakers",
  usb: "a USB device",
  hid: "a device",
  serial: "a serial port",
  bluetooth: "a Bluetooth device",
  http_sign_in: "a sign-in",
  proxy_sign_in: "a proxy sign-in",
  client_certificate: "a certificate",
};

/** The words activity lines and the bar use: "location", "camera and microphone". */
export function permissionWords(kind: PromptKind): string {
  return WORDS[kind] ?? kind;
}

/** The words a device prompt uses: "a USB device", "a Bluetooth device". */
export function deviceWords(kind: DeviceKind): string {
  return WORDS[kind];
}
