// The chrome members Kamapathy bridges, and the function that installs them
// in an extension context's main world. Electron 44 ships no action, windows
// or tabs API worth using, so the preloads replace them with calls over IPC.
export const EXTENSION_CALL = "kamapathy-ext:call";
export const EXTENSION_LISTEN = "kamapathy-ext:listen";
export const EXTENSION_READY = "kamapathy-ext:ready";
export const EXTENSION_EVENT = "kamapathy-ext:event";
export const PAGE_PRELOAD_ID = "kamapathy-extension-page";
export const WORKER_PRELOAD_ID = "kamapathy-extension-worker";

export const BRIDGED_METHODS: Readonly<{
  tabs: readonly string[];
  windows: readonly string[];
  action: readonly string[];
  runtime: readonly string[];
}> = {
  tabs: [
    "get",
    "getCurrent",
    "query",
    "getZoom",
    "getZoomSettings",
    "captureVisibleTab",
    "create",
    "duplicate",
    "update",
    "move",
    "reload",
    "remove",
    "goBack",
    "goForward",
    "setZoom",
    "setZoomSettings",
    "highlight",
  ],
  windows: [
    "get",
    "getCurrent",
    "getLastFocused",
    "getAll",
    "create",
    "update",
    "remove",
  ],
  action: [
    "setTitle",
    "getTitle",
    "setIcon",
    "setPopup",
    "getPopup",
    "setBadgeText",
    "getBadgeText",
    "setBadgeBackgroundColor",
    "getBadgeBackgroundColor",
    "setBadgeTextColor",
    "getBadgeTextColor",
    "enable",
    "disable",
    "isEnabled",
    "getUserSettings",
    "openPopup",
  ],
  runtime: ["openOptionsPage"],
};
// Methods Kamapathy has nothing to answer with; they refuse in the page.
export const UNSUPPORTED_TABS_METHODS: readonly string[] = [
  "discard",
  "group",
  "ungroup",
  "detectLanguage",
];
export const EVENT_NAMES: readonly string[] = [
  "tabs.onCreated",
  "tabs.onUpdated",
  "tabs.onActivated",
  "tabs.onHighlighted",
  "tabs.onRemoved",
  "tabs.onReplaced",
  "tabs.onMoved",
  "tabs.onAttached",
  "tabs.onDetached",
  "tabs.onZoomChange",
  "windows.onCreated",
  "windows.onRemoved",
  "windows.onFocusChanged",
  "windows.onBoundsChanged",
  "action.onClicked",
  "action.onUserSettingsChanged",
];

export type Invoke = (
  api: string,
  method: string,
  args: unknown[],
) => Promise<unknown>;
export type Subscribe = (
  events: string[],
  listener: (event: string, args: unknown[]) => void,
) => void;

/* eslint-disable */
// Runs in the extension's main world through executeInMainWorld, which
// serializes it: the body references nothing outside itself, so the method
// lists, the event names and the copy are inlined here on purpose.
export function installChromeApi(invoke: Invoke, subscribe: Subscribe): void {
  type Members = Record<string, any>;
  const native = (globalThis as { chrome?: Members }).chrome;
  if (!native) return;
  const NOT_SUPPORTED = "Not supported in Kamapathy.";
  const bridged: Record<string, string[]> = {
    tabs: [
      "get",
      "getCurrent",
      "query",
      "getZoom",
      "getZoomSettings",
      "captureVisibleTab",
      "create",
      "duplicate",
      "update",
      "move",
      "reload",
      "remove",
      "goBack",
      "goForward",
      "setZoom",
      "setZoomSettings",
      "highlight",
    ],
    windows: [
      "get",
      "getCurrent",
      "getLastFocused",
      "getAll",
      "create",
      "update",
      "remove",
    ],
    action: [
      "setTitle",
      "getTitle",
      "setIcon",
      "setPopup",
      "getPopup",
      "setBadgeText",
      "getBadgeText",
      "setBadgeBackgroundColor",
      "getBadgeBackgroundColor",
      "setBadgeTextColor",
      "getBadgeTextColor",
      "enable",
      "disable",
      "isEnabled",
      "getUserSettings",
      "openPopup",
    ],
  };
  const fired: Record<string, string[]> = {
    tabs: [
      "onCreated",
      "onUpdated",
      "onActivated",
      "onHighlighted",
      "onRemoved",
      "onReplaced",
      "onMoved",
      "onAttached",
      "onDetached",
      "onZoomChange",
    ],
    windows: ["onCreated", "onRemoved", "onFocusChanged", "onBoundsChanged"],
    action: ["onClicked", "onUserSettingsChanged"],
  };
  type Listener = (...args: unknown[]) => void;
  const listeners = new Map<string, Set<Listener>>();
  const report = (value: unknown) => {
    try {
      console.error(value);
    } catch (ignored) {
      // A context without a console drops the message.
    }
  };
  const dispatch = (event: string, args: unknown[]) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const listener of [...set])
      try {
        listener(...(Array.isArray(args) ? args : []));
      } catch (error) {
        report(error);
      }
  };
  const announce = () => {
    try {
      subscribe([...listeners.keys()], dispatch);
    } catch (error) {
      report(error);
    }
  };
  // Native members are replaced where Electron allows it, and only added
  // where it does not.
  const put = (target: Members, name: string, value: unknown) => {
    try {
      Object.defineProperty(target, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      if (target[name] === value) return;
    } catch (error) {
      report(error);
    }
    try {
      target[name] = value;
    } catch (error) {
      report(error);
    }
  };
  const namespace = (name: string): Members | undefined => {
    const existing = native[name];
    if (existing && typeof existing === "object") return existing;
    put(native, name, {});
    const created = native[name];
    return created && typeof created === "object" ? created : undefined;
  };
  // Chrome sets runtime.lastError for the callback form. Where it cannot be
  // set, the callback gets undefined and the error is logged.
  const fail = (callback: Listener, error: unknown) => {
    const message =
      error && (error as Error).message
        ? (error as Error).message
        : String(error);
    const runtime = native.runtime;
    let held = false;
    if (runtime)
      try {
        runtime.lastError = { message };
        held = !!runtime.lastError && runtime.lastError.message === message;
      } catch (ignored) {
        held = false;
      }
    if (!held) report(message);
    try {
      callback(undefined);
    } catch (other) {
      report(other);
    }
    if (held)
      try {
        delete runtime.lastError;
      } catch (ignored) {
        runtime.lastError = undefined;
      }
  };
  // A trailing function argument is the callback and is never sent.
  const wrap =
    (run: (args: unknown[]) => unknown) =>
    (...args: unknown[]) => {
      const callback =
        typeof args[args.length - 1] === "function"
          ? (args.pop() as Listener)
          : undefined;
      const result = (async () => run(args))();
      if (!callback) return result;
      result.then(
        (value) => {
          try {
            callback(value);
          } catch (error) {
            report(error);
          }
        },
        (error) => fail(callback, error),
      );
      return undefined;
    };
  const event = (name: string, fires: boolean) => ({
    addListener(listener: unknown) {
      if (typeof listener !== "function") return;
      const set = listeners.get(name);
      if (set) {
        set.add(listener as Listener);
        return;
      }
      listeners.set(name, new Set([listener as Listener]));
      if (fires) announce();
    },
    removeListener(listener: unknown) {
      const set = listeners.get(name);
      if (!set || !set.delete(listener as Listener)) return;
      if (set.size) return;
      listeners.delete(name);
      if (fires) announce();
    },
    hasListener(listener: unknown) {
      const set = listeners.get(name);
      return !!set && set.has(listener as Listener);
    },
    hasListeners() {
      const set = listeners.get(name);
      return !!set && set.size > 0;
    },
  });
  // Icons arrive as ImageData in the page; the main process takes images it
  // can read.
  const asDataUrl = async (image: any) => {
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d") as any;
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let text = "";
    for (const byte of bytes) text += String.fromCharCode(byte);
    return "data:image/png;base64," + btoa(text);
  };
  const setIcon = wrap(async (args: unknown[]) => {
    const details = (args[0] ?? {}) as Members;
    const data = details.imageData;
    if (!data) return invoke("action", "setIcon", args);
    const images: Record<string, string> = {};
    if (typeof data.width === "number" && data.data)
      images[String(data.width)] = await asDataUrl(data);
    else
      for (const size of Object.keys(data))
        images[size] = await asDataUrl(data[size]);
    return invoke("action", "setIcon", [{ images, tabId: details.tabId }]);
  });

  for (const api of ["tabs", "windows", "action"]) {
    const members = namespace(api);
    if (!members) continue;
    for (const method of bridged[api])
      put(
        members,
        method,
        api === "action" && method === "setIcon"
          ? setIcon
          : wrap((args: unknown[]) => invoke(api, method, args)),
      );
    for (const name of fired[api])
      put(members, name, event(api + "." + name, true));
  }
  const tabs = namespace("tabs");
  if (tabs) {
    for (const method of ["discard", "group", "ungroup", "detectLanguage"])
      put(
        tabs,
        method,
        wrap(() => {
          throw new Error(NOT_SUPPORTED);
        }),
      );
    put(tabs, "TAB_ID_NONE", -1);
    put(tabs, "MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND", 2);
  }
  const windows = namespace("windows");
  if (windows) {
    put(windows, "WINDOW_ID_NONE", -1);
    put(windows, "WINDOW_ID_CURRENT", -2);
  }
  const runtime = namespace("runtime");
  if (runtime) {
    put(
      runtime,
      "openOptionsPage",
      wrap((args: unknown[]) => invoke("runtime", "openOptionsPage", args)),
    );
    put(
      runtime,
      "setUninstallURL",
      wrap(() => undefined),
    );
  }
  // Calls extensions make at startup must not fail, so these are accepted
  // and do nothing.
  const menus = namespace("contextMenus");
  if (menus) {
    let made = 0;
    put(menus, "create", (properties: Members, callback?: unknown) => {
      made += 1;
      const given = properties ? properties.id : undefined;
      const id =
        given === undefined || given === null
          ? "kamapathy-menu-" + made
          : String(given);
      if (typeof callback === "function")
        try {
          (callback as Listener)();
        } catch (error) {
          report(error);
        }
      return id;
    });
    for (const method of ["update", "remove", "removeAll"])
      put(
        menus,
        method,
        wrap(() => undefined),
      );
    put(menus, "onClicked", event("contextMenus.onClicked", false));
    put(menus, "ACTION_MENU_TOP_LEVEL_LIMIT", 6);
  }
}
/* eslint-enable */
