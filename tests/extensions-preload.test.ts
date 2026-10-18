import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  BRIDGED_METHODS,
  EVENT_NAMES,
  UNSUPPORTED_TABS_METHODS,
  installChromeApi,
} from "../electron/extensions/chrome-api";
import { extensionBridgeCopy } from "../src/copy";

type Chrome = Record<string, any>;
interface Call {
  api: string;
  method: string;
  args: unknown[];
}

// The main world gets installChromeApi as source, so every check evaluates
// its text in a fresh context the way executeInMainWorld does.
function install(
  options: { native?: Chrome; result?: unknown; error?: Error } = {},
) {
  const calls: Call[] = [];
  const invoke = vi.fn((api: string, method: string, args: unknown[]) => {
    calls.push({ api, method, args });
    return options.error
      ? Promise.reject(options.error)
      : Promise.resolve(options.result);
  });
  const announced: string[][] = [];
  let dispatch: ((event: string, args: unknown[]) => void) | undefined;
  const subscribe = vi.fn(
    (events: string[], listener: (event: string, args: unknown[]) => void) => {
      announced.push(events);
      dispatch = listener;
    },
  );
  const logged: unknown[] = [];
  const chrome: Chrome = options.native ?? { tabs: {}, runtime: {} };
  const context = createContext({
    chrome,
    console: { error: (...args: unknown[]) => logged.push(...args) },
  });
  const installer = runInContext(
    `(${installChromeApi.toString()})`,
    context,
  ) as typeof installChromeApi;
  installer(invoke, subscribe);
  return {
    chrome,
    invoke,
    calls,
    subscribe,
    announced,
    logged,
    dispatch: (event: string, args: unknown[]) => dispatch?.(event, args),
  };
}
const rejection = async (promise: Promise<unknown>): Promise<string> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  // Errors thrown inside the vm belong to its realm, so read the message.
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === "string" ? message : String(error);
};

describe("the extension chrome bridge", () => {
  it("replaces tabs members and adds windows, action and options members", async () => {
    const sendMessage = () => undefined;
    const connect = () => undefined;
    const { chrome, calls } = install({
      native: { tabs: { sendMessage, connect }, runtime: { id: "marker" } },
    });
    expect(chrome.tabs.sendMessage).toBe(sendMessage);
    expect(chrome.tabs.connect).toBe(connect);
    expect(chrome.runtime.id).toBe("marker");
    for (const [api, methods] of Object.entries(BRIDGED_METHODS))
      for (const method of methods) {
        expect(typeof chrome[api][method]).toBe("function");
        await chrome[api][method]();
      }
    expect(calls.map(({ api, method }) => `${api}.${method}`)).toEqual(
      Object.entries(BRIDGED_METHODS).flatMap(([api, methods]) =>
        methods.map((method) => `${api}.${method}`),
      ),
    );
    for (const name of EVENT_NAMES) {
      const [api, event] = name.split(".");
      expect(typeof chrome[api][event].addListener).toBe("function");
    }
    expect(chrome.tabs.TAB_ID_NONE).toBe(-1);
    expect(chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND).toBe(2);
    expect(chrome.windows.WINDOW_ID_NONE).toBe(-1);
    expect(chrome.windows.WINDOW_ID_CURRENT).toBe(-2);
  });

  it("methods return promises and call callbacks with their results", async () => {
    const { chrome, calls } = install({ result: [{ id: 7 }] });
    await expect(chrome.tabs.query({ active: true })).resolves.toEqual([
      { id: 7 },
    ]);
    expect(calls.at(-1)).toEqual({
      api: "tabs",
      method: "query",
      args: [{ active: true }],
    });
    const callback = vi.fn();
    expect(chrome.tabs.get(7, callback)).toBeUndefined();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith([{ id: 7 }]));
    expect(calls.at(-1)).toEqual({ api: "tabs", method: "get", args: [7] });
  });

  it("events report the names they listen to and receive dispatched events", () => {
    const { chrome, announced, dispatch, logged } = install();
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const listener = vi.fn();
    chrome.tabs.onUpdated.addListener(throwing);
    expect(announced.at(-1)).toEqual(["tabs.onUpdated"]);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.windows.onFocusChanged.addListener(listener);
    expect(announced.at(-1)).toEqual([
      "tabs.onUpdated",
      "windows.onFocusChanged",
    ]);
    expect(chrome.tabs.onUpdated.hasListener(listener)).toBe(true);
    expect(chrome.tabs.onUpdated.hasListeners()).toBe(true);
    expect(chrome.tabs.onRemoved.hasListeners()).toBe(false);
    dispatch("tabs.onUpdated", [1, { status: "complete" }, { id: 1 }]);
    expect(throwing).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith(1, { status: "complete" }, { id: 1 });
    expect(logged.length).toBe(1);
    chrome.tabs.onUpdated.removeListener(throwing);
    chrome.tabs.onUpdated.removeListener(listener);
    expect(announced.at(-1)).toEqual(["windows.onFocusChanged"]);
    expect(chrome.tabs.onUpdated.hasListener(listener)).toBe(false);
    dispatch("tabs.onUpdated", [2]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("discard, group, ungroup and detectLanguage reject with Not supported in Kamapathy.", async () => {
    const { chrome, invoke } = install();
    expect(UNSUPPORTED_TABS_METHODS.length).toBe(4);
    for (const method of UNSUPPORTED_TABS_METHODS)
      expect(await rejection(chrome.tabs[method](7))).toBe(
        extensionBridgeCopy.notSupported,
      );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("setUninstallURL and contextMenus accept calls and do nothing", async () => {
    const { chrome, invoke, subscribe } = install();
    await expect(
      chrome.runtime.setUninstallURL("https://example.com/bye"),
    ).resolves.toBeUndefined();
    const listener = vi.fn();
    chrome.contextMenus.onClicked.addListener(listener);
    expect(chrome.contextMenus.onClicked.hasListener(listener)).toBe(true);
    const created = vi.fn();
    expect(chrome.contextMenus.create({ title: "Open" }, created)).toMatch(
      /\S/,
    );
    expect(created).toHaveBeenCalled();
    expect(chrome.contextMenus.create({ id: "mine" })).toBe("mine");
    await expect(
      chrome.contextMenus.update("mine", { title: "Other" }),
    ).resolves.toBeUndefined();
    await expect(chrome.contextMenus.remove("mine")).resolves.toBeUndefined();
    await expect(chrome.contextMenus.removeAll()).resolves.toBeUndefined();
    expect(chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT).toBe(6);
    expect(invoke).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("a failed call reaches its callback as lastError, or as undefined with a logged error", async () => {
    const error = new Error("No tab with id 7.");
    const held = install({ error });
    let seen: unknown;
    const callback = vi.fn(() => {
      seen = held.chrome.runtime.lastError;
    });
    held.chrome.tabs.get(7, callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(undefined));
    expect((seen as { message: string }).message).toBe("No tab with id 7.");
    expect(held.chrome.runtime.lastError).toBeUndefined();
    expect(held.logged).toEqual([]);
    expect(await rejection(held.chrome.tabs.get(7))).toBe("No tab with id 7.");
    const logging = install({
      native: { tabs: {}, runtime: Object.freeze({}) },
      error,
    });
    const other = vi.fn();
    logging.chrome.tabs.get(7, other);
    await vi.waitFor(() => expect(other).toHaveBeenCalledWith(undefined));
    expect(logging.logged).toContain("No tab with id 7.");
  });

  it("installChromeApi is self-contained", () => {
    const chrome: Chrome = {};
    const context = createContext({ chrome });
    const installer = runInContext(
      `(${installChromeApi.toString()})`,
      context,
    ) as typeof installChromeApi;
    installer(
      () => Promise.resolve(undefined),
      () => undefined,
    );
    for (const [api, methods] of Object.entries(BRIDGED_METHODS))
      for (const method of methods)
        expect(typeof chrome[api][method]).toBe("function");
    for (const method of UNSUPPORTED_TABS_METHODS)
      expect(typeof chrome.tabs[method]).toBe("function");
    for (const name of EVENT_NAMES) {
      const [api, event] = name.split(".");
      expect(typeof chrome[api][event].addListener).toBe("function");
    }
    expect(typeof chrome.runtime.setUninstallURL).toBe("function");
    expect(typeof chrome.contextMenus.create).toBe("function");
    expect(installChromeApi.toString()).not.toMatch(
      /BRIDGED_METHODS|EVENT_NAMES|UNSUPPORTED_TABS_METHODS|extensionBridgeCopy|require\(/,
    );
  });
});
