import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session, WebContents } from "electron";
import { createReceipts } from "../electron/agent/receipts";
import { createTabLog } from "../electron/agent/tab-log";
import {
  createPromptCenter,
  PROMPT_LIMIT,
  type PromptCenter,
  type PromptHost,
} from "../electron/prompts";
import { HOME_URL } from "../shared/state";
import type { Space, Tab } from "../shared/types";
import { FakeContents, FakeController } from "./fake-automation";

type Callback = (allow: boolean) => void;
type Details = Record<string, unknown>;
// The handlers and events a partition's session hands the prompt center.
class FakeSession extends EventEmitter {
  devicePermission?: (details: {
    deviceType: string;
    origin: string;
    device: Record<string, unknown>;
  }) => boolean;
  pairing?: (
    details: Record<string, unknown>,
    response: (answer: { confirmed: boolean }) => void,
  ) => void;
  request!: (
    contents: WebContents | null,
    permission: string,
    callback: Callback,
    details: Details,
  ) => void;
  check!: (
    contents: WebContents | null,
    permission: string,
    origin: string,
    details: Details,
  ) => boolean;
  setPermissionRequestHandler(handler: FakeSession["request"]) {
    this.request = handler;
  }
  setPermissionCheckHandler(handler: FakeSession["check"]) {
    this.check = handler;
  }
  setDevicePermissionHandler(handler: FakeSession["devicePermission"]) {
    this.devicePermission = handler ?? undefined;
  }
  setBluetoothPairingHandler(handler: FakeSession["pairing"]) {
    this.pairing = handler ?? undefined;
  }
}

// Electron's device shapes, trimmed to the fields the center reads.
const usbDevice = (deviceId: string, productName?: string) => ({
  deviceId,
  vendorId: 1256,
  productId: 26720,
  productName,
});
const hidDevice = (deviceId: string, name?: string) => ({ deviceId, name });

const centers: PromptCenter[] = [];
afterEach(() => {
  for (const center of centers.splice(0)) center.clearAll();
  vi.restoreAllMocks();
});

function setup() {
  const controller = new FakeController();
  let clock = Date.now();
  const tabOf = (contents: WebContents | null): Tab | undefined => {
    for (const [tabId, page] of controller.pages)
      if ((page as unknown as WebContents) === contents)
        return controller.state.tabs.find((tab) => tab.id === tabId);
    return undefined;
  };
  const host: PromptHost = {
    state: controller.state,
    tabOf,
    spaceOf: (contents) => {
      const tab = tabOf(contents);
      return tab
        ? controller.state.spaces.find((space) => space.id === tab.spaceId)
        : undefined;
    },
    agentControlled: (tabId) => controller.agentControlled(tabId),
    // The controller resolves a frame with webContents.fromFrame; the fake
    // pages stand in for their own frames.
    contentsForFrame: (frame) => (frame as unknown as WebContents) ?? null,
    holdForPerson: (spaceId, reason, prompt) =>
      controller.holdForPerson(spaceId, reason, prompt),
    releaseHold: (holdId) => controller.releaseHold(holdId),
    addActivity: (spaceId, message, kind) =>
      controller.addActivity(spaceId, message, kind),
    emit: () => controller.emit(),
  };
  const center = createPromptCenter(host, { now: () => clock });
  centers.push(center);
  const session = new FakeSession();
  const detach = center.attachSession(session as unknown as Session);
  const tabLog = createTabLog({ now: () => clock });
  const receipts = createReceipts({
    tabLog,
    controller,
    prompts: center,
    now: () => clock,
    sleep: async () => {},
  });
  center.setReceipts(receipts);
  // A page in a managed agent tab, and the person's own pages where asked.
  const space = controller.createAgentSpace("Task");
  const tab = controller.openAgentTab(space.id, "https://example.com/");
  const page = controller.pages.get(tab.id)!;
  const pageIn = (spaceId: string, url: string) => {
    const free =
      controller.state.tabs.find(
        (item) => item.spaceId === spaceId && item.url === url,
      ) ??
      controller.state.tabs.find(
        (item) => item.spaceId === spaceId && item.url === HOME_URL,
      ) ??
      controller.openAgentTab(spaceId, url);
    free.url = url;
    controller.getWebContents(free.id);
    const made = controller.pages.get(free.id)!;
    made.url = url;
    return { tab: free, page: made };
  };
  const ask = (
    permission: string,
    details: Details = {},
    target: FakeContents = page,
  ) => {
    const callback = vi.fn();
    session.request(target as unknown as WebContents, permission, callback, {
      isMainFrame: true,
      requestingUrl: target.url,
      ...details,
    });
    return callback;
  };
  // A chooser event, as Electron emits it: usb and hid on the session, and
  // bluetooth on the page's own contents.
  const chooseUsb = (
    devices: ReturnType<typeof usbDevice>[],
    target: FakeContents = page,
  ) => {
    const callback = vi.fn();
    session.emit(
      "select-usb-device",
      { preventDefault: vi.fn() },
      { deviceList: devices, frame: target },
      callback,
    );
    return callback;
  };
  const chooseHid = (
    devices: ReturnType<typeof hidDevice>[],
    target: FakeContents = page,
  ) => {
    const callback = vi.fn();
    session.emit(
      "select-hid-device",
      { preventDefault: vi.fn() },
      { deviceList: devices, frame: target },
      callback,
    );
    return callback;
  };
  // The controller installs the Bluetooth chooser on each page it wires.
  const wired = new Set<FakeContents>();
  const chooseBluetooth = (
    devices: { deviceId: string; deviceName?: string }[],
    target: FakeContents = page,
  ) => {
    if (!wired.has(target)) {
      center.attachBluetooth(target as unknown as WebContents);
      wired.add(target);
    }
    const callback = vi.fn();
    target.emit(
      "select-bluetooth-device",
      { preventDefault: vi.fn() },
      devices,
      callback,
    );
    return callback;
  };
  return {
    controller,
    center,
    session,
    detach,
    chooseUsb,
    chooseHid,
    chooseBluetooth,
    receipts,
    space,
    tab,
    page,
    pageIn,
    ask,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

const held = (space: Space) => space.control?.hold;

describe("the prompt center", () => {
  it("holds a request within 5 s of agent input with reason permission and prompt location", async () => {
    const { controller, center, receipts, space, tab, ask, advance } = setup();
    let callback!: ReturnType<typeof vi.fn>;
    const result = await receipts.with(tab.id, async () => {
      callback = ask("geolocation");
      return { ok: true as const };
    });
    expect(callback).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
    expect(controller.state.prompts).toEqual([
      {
        id: expect.any(String),
        spaceId: space.id,
        tabId: tab.id,
        kind: "location",
        origin: "https://example.com",
        at: expect.any(Number),
        agent: true,
      },
    ]);
    expect(space).toMatchObject({
      owner: "human",
      control: {
        reason: "permission",
        prompt: "location",
        hold: expect.any(String),
      },
    });
    expect(center.oldestPromptTab(space.id)).toBe(tab.id);
    // The window runs 5000 ms past the route, and a second request joins the
    // hold the first one started.
    advance(4000);
    const later = ask("notifications");
    expect(later).not.toHaveBeenCalled();
    expect(center.prompts()).toHaveLength(2);
    expect(controller.activity).toEqual([]);
  });

  it("a goto opens the request window like input", async () => {
    const { center, receipts, space, tab, page, pageIn, ask, advance } =
      setup();
    const other = pageIn(space.id, "https://example.org/");
    // The navigate route opens the window on its own tab only.
    await receipts.with(tab.id, async () => {
      page.navigate("https://example.com/next");
      const denied = ask("geolocation", {}, other.page);
      const holds = ask("geolocation");
      expect(denied).toHaveBeenCalledExactlyOnceWith(false);
      expect(holds).not.toHaveBeenCalled();
      return {};
    });
    expect(center.prompts()).toHaveLength(1);
    // Past the window the same request is refused.
    advance(5001);
    const late = ask("geolocation", { requestingUrl: "https://late.example/" });
    expect(late).toHaveBeenCalledExactlyOnceWith(false);
    expect(center.prompts()).toHaveLength(1);
  });

  it("a request outside the window is denied and reported in the next receipt", async () => {
    const { controller, center, receipts, space, tab, ask, advance } = setup();
    const denied = ask("geolocation");
    expect(denied).toHaveBeenCalledExactlyOnceWith(false);
    expect(center.prompts()).toEqual([]);
    expect(controller.activity).toEqual([
      {
        spaceId: space.id,
        message: "A site's request for location was refused.",
        kind: "warning",
      },
    ]);
    // The same origin and permission again adds no second line.
    ask("geolocation");
    expect(controller.activity).toHaveLength(1);
    // A permission no agent tab may hold is refused inside the window too.
    const clipboard = await receipts.with(tab.id, async () => {
      expect(ask("clipboard-read")).toHaveBeenCalledExactlyOnceWith(false);
      // Nothing Kamapathy grants is reported at all.
      expect(ask("idle-detection")).toHaveBeenCalledExactlyOnceWith(false);
      expect(
        ask("geolocation", { requestingUrl: "about:blank" }),
      ).toHaveBeenCalledExactlyOnceWith(false);
      return {};
    });
    expect(clipboard).toEqual({
      deniedRequests: [
        { origin: "https://example.com", permission: "location" },
        { origin: "https://example.com", permission: "clipboard-read" },
      ],
    });
    // With no agent server running, a refusal is answered and nothing else.
    advance(5001);
    center.setReceipts(null);
    controller.activity.length = 0;
    expect(
      ask("geolocation", { requestingUrl: "https://other.example/" }),
    ).toHaveBeenCalledExactlyOnceWith(false);
    expect(controller.activity).toEqual([]);
  });

  it("answering the last held request returns control unless the person took over", async () => {
    const { controller, center, receipts, space, tab, ask } = setup();
    const callbacks: ReturnType<typeof vi.fn>[] = [];
    await receipts.with(tab.id, async () => {
      callbacks.push(ask("geolocation"), ask("notifications"));
      return {};
    });
    const [first, second] = center.prompts();
    expect(held(space)).toEqual(expect.any(String));
    center.answer({ id: first.id, allow: false });
    expect(callbacks[0]).toHaveBeenCalledExactlyOnceWith(false);
    expect(space.owner).toBe("human");
    center.answer({ id: second.id, allow: true });
    expect(callbacks[1]).toHaveBeenCalledExactlyOnceWith(true);
    expect(space.owner).toBe("agent");
    expect(space).not.toHaveProperty("control");
    expect(center.prompts()).toEqual([]);
    expect(controller.state.prompts).toEqual([]);
    // An answer nobody asked for, and a second answer, change nothing.
    center.answer({ id: first.id, allow: true });
    expect(callbacks[0]).toHaveBeenCalledOnce();
    // The person took over while a request waited: it is answered, and they
    // keep control.
    let third!: ReturnType<typeof vi.fn>;
    await receipts.with(tab.id, async () => {
      third = ask("geolocation", { requestingUrl: "https://again.example/" });
      return {};
    });
    controller.registry.handOver(space.id, { reason: "manual" });
    center.answer({ id: center.prompts()[0].id, allow: true });
    expect(third).toHaveBeenCalledExactlyOnceWith(true);
    expect(space.owner).toBe("human");
    expect(space.control).toMatchObject({ reason: "manual" });
  });

  it("saved decisions stay in their space", () => {
    const { controller, center, session, pageIn, ask } = setup();
    const mine = pageIn("personal", "https://example.com/");
    const theirs = pageIn("work", "https://example.com/");
    const asked = ask("notifications", {}, mine.page);
    expect(asked).not.toHaveBeenCalled();
    expect(center.prompts()).toEqual([
      expect.objectContaining({ spaceId: "personal", agent: false }),
    ]);
    center.answer({ id: center.prompts()[0].id, allow: true });
    expect(asked).toHaveBeenCalledExactlyOnceWith(true);
    expect(controller.state.sitePermissions).toEqual([
      {
        spaceId: "personal",
        origin: "https://example.com",
        permission: "notifications",
        allow: true,
        at: expect.any(Number),
      },
    ]);
    // The check handler answers from the same decision, in that space only.
    const origin = "https://example.com/";
    expect(
      session.check(
        mine.page as unknown as WebContents,
        "notifications",
        origin,
        {},
      ),
    ).toBe(true);
    expect(
      session.check(
        theirs.page as unknown as WebContents,
        "notifications",
        origin,
        {},
      ),
    ).toBe(false);
    expect(session.check(null, "notifications", origin, {})).toBe(false);
    // A request in the space that allowed it needs no prompt; the other
    // space still asks, and its Block is remembered too.
    expect(ask("notifications", {}, mine.page)).toHaveBeenCalledExactlyOnceWith(
      true,
    );
    expect(center.prompts()).toEqual([]);
    const other = ask("notifications", {}, theirs.page);
    expect(other).not.toHaveBeenCalled();
    center.answer({ id: center.prompts()[0].id, allow: false });
    expect(other).toHaveBeenCalledExactlyOnceWith(false);
    expect(
      ask("notifications", {}, theirs.page),
    ).toHaveBeenCalledExactlyOnceWith(false);
    expect(controller.state.sitePermissions).toHaveLength(2);
    // Settings removes one decision and then all of them.
    center.removeSitePermission({
      spaceId: "work",
      origin: "https://example.com",
      permission: "notifications",
    });
    expect(controller.state.sitePermissions).toHaveLength(1);
    center.clearSitePermissions();
    expect(controller.state.sitePermissions).toEqual([]);
    expect(ask("notifications", {}, mine.page)).not.toHaveBeenCalled();
  });

  it("keeps an agent space's decision in memory and drops it with the space", async () => {
    const { controller, center, receipts, space, tab, ask } = setup();
    await receipts.with(tab.id, async () => {
      ask("notifications");
      return {};
    });
    center.answer({ id: center.prompts()[0].id, allow: true });
    expect(controller.state.sitePermissions).toEqual([]);
    expect(ask("notifications")).toHaveBeenCalledExactlyOnceWith(true);
    center.clearSpace(space.id);
    expect(ask("notifications")).not.toHaveBeenCalled();
    expect(center.prompts()).toHaveLength(1);
  });

  it("denies held requests on navigation and releases the hold", async () => {
    const { controller, center, receipts, space, tab, page, ask } = setup();
    let callback!: ReturnType<typeof vi.fn>;
    await receipts.with(tab.id, async () => {
      callback = ask("geolocation");
      return {};
    });
    // Its own frame, and its own document, decide nothing.
    page.emit("did-start-navigation", {
      isMainFrame: false,
      isSameDocument: false,
    });
    page.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: true,
    });
    expect(callback).not.toHaveBeenCalled();
    page.navigate("https://example.com/next");
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
    expect(center.prompts()).toEqual([]);
    expect(space.owner).toBe("agent");
    expect(controller.state.sitePermissions).toEqual([]);
    // A closed page ends its request the same way.
    let closing!: ReturnType<typeof vi.fn>;
    await receipts.with(tab.id, async () => {
      closing = ask("geolocation");
      return {};
    });
    page.destroy();
    expect(closing).toHaveBeenCalledExactlyOnceWith(false);
    expect(space.owner).toBe("agent");
  });

  it("a space holds at most 8 requests and denies the ninth", async () => {
    const { center, receipts, space, tab, ask } = setup();
    const result = await receipts.with(tab.id, async () => {
      for (let index = 1; index <= PROMPT_LIMIT; index += 1)
        expect(
          ask("geolocation", { requestingUrl: `https://s${index}.example/` }),
        ).not.toHaveBeenCalled();
      expect(
        ask("geolocation", { requestingUrl: "https://s9.example/" }),
      ).toHaveBeenCalledExactlyOnceWith(false);
      return {};
    });
    expect(center.prompts()).toHaveLength(PROMPT_LIMIT);
    expect(result).toEqual({
      deniedRequests: [
        { origin: "https://s9.example", permission: "location" },
      ],
    });
    expect(held(space)).toEqual(expect.any(String));
  });

  it("camera and microphone together hold once with prompt camera_microphone", async () => {
    const { center, session, receipts, tab, page, ask } = setup();
    let callback!: ReturnType<typeof vi.fn>;
    await receipts.with(tab.id, async () => {
      callback = ask("media", {
        mediaTypes: ["audio", "video"],
        securityOrigin: "https://example.com/",
        requestingUrl: "https://frame.example/",
      });
      return {};
    });
    expect(center.prompts()).toEqual([
      expect.objectContaining({
        kind: "camera_microphone",
        origin: "https://example.com",
      }),
    ]);
    center.answer({ id: center.prompts()[0].id, allow: true });
    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
    // Both keys are decided, so a camera-only request needs no prompt.
    expect(
      ask("media", {
        mediaTypes: ["video"],
        securityOrigin: "https://example.com/",
      }),
    ).toHaveBeenCalledExactlyOnceWith(true);
    const contents = page as unknown as WebContents;
    const origin = "https://example.com";
    expect(
      session.check(contents, "media", origin, { mediaType: "audio" }),
    ).toBe(true);
    expect(
      session.check(contents, "media", origin, { mediaType: "unknown" }),
    ).toBe(false);
  });

  it("stops answering once its session is detached", () => {
    const { center, session, detach, ask, page } = setup();
    detach();
    expect(ask("geolocation")).toHaveBeenCalledExactlyOnceWith(false);
    expect(center.prompts()).toEqual([]);
    expect(
      session.check(
        page as unknown as WebContents,
        "notifications",
        "https://example.com",
        {},
      ),
    ).toBe(false);
  });

  it("grants only the chosen USB device", () => {
    const { controller, center, session, space, tab, chooseUsb } = setup();
    const callback = chooseUsb([
      usbDevice("dev-a", "Phone"),
      usbDevice("dev-b"),
    ]);
    expect(callback).not.toHaveBeenCalled();
    expect(controller.state.prompts).toEqual([
      {
        id: expect.any(String),
        spaceId: space.id,
        tabId: tab.id,
        kind: "usb",
        origin: "https://example.com",
        at: expect.any(Number),
        agent: true,
        devices: [
          { id: "1256:26720:dev-a", name: "Phone" },
          { id: "1256:26720:dev-b", name: "USB device" },
        ],
      },
    ]);
    expect(space).toMatchObject({
      owner: "human",
      control: { reason: "device", prompt: "usb" },
    });
    center.answer({
      id: controller.state.prompts[0].id,
      allow: true,
      deviceId: "1256:26720:dev-b",
    });
    // Exactly the chosen device, by Electron's own id.
    expect(callback).toHaveBeenCalledExactlyOnceWith("dev-b");
    expect(space.owner).toBe("agent");
    const mayUse = (device: Record<string, unknown>) =>
      session.devicePermission!({
        deviceType: "usb",
        origin: "https://example.com",
        device,
      });
    expect(mayUse(usbDevice("dev-b"))).toBe(true);
    expect(mayUse(usbDevice("dev-a"))).toBe(false);
    expect(
      session.devicePermission!({
        deviceType: "usb",
        origin: "https://other.example",
        device: usbDevice("dev-b"),
      }),
    ).toBe(false);
    // The grant is this run's only, is never written down, and the next
    // request asks again.
    expect(controller.state.sitePermissions).toEqual([]);
    expect(chooseUsb([usbDevice("dev-b")])).not.toHaveBeenCalled();
    center.clearSpace(space.id);
    expect(mayUse(usbDevice("dev-b"))).toBe(false);
  });

  it("a device request in an agent tab holds with reason device and prompt usb, hid, serial or bluetooth, inside the window or not", async () => {
    const {
      controller,
      center,
      receipts,
      session,
      space,
      tab,
      page,
      chooseUsb,
      chooseHid,
      chooseBluetooth,
    } = setup();
    // No route is running, and the chooser still goes to the person.
    chooseUsb([usbDevice("dev-a", "Phone")]);
    expect(center.prompts()).toMatchObject([{ kind: "usb", agent: true }]);
    expect(space).toMatchObject({
      owner: "human",
      control: { reason: "device", prompt: "usb" },
    });
    // Inside a route's window it holds the same way.
    const result = await receipts.with(tab.id, async () => {
      chooseHid([hidDevice("hid-a")]);
      return {};
    });
    expect(result).toEqual({});
    expect(center.prompts()).toMatchObject([
      { kind: "usb" },
      { kind: "hid", devices: [{ id: "hid-a", name: "Device" }] },
    ]);
    // A chooser opens only for a page Kamapathy knows, and serial never
    // opens one at all.
    const contents = page as unknown as WebContents;
    expect(session.check(contents, "usb", "https://example.com/", {})).toBe(
      true,
    );
    expect(session.check(contents, "hid", "https://example.com/", {})).toBe(
      true,
    );
    expect(session.check(contents, "serial", "https://example.com/", {})).toBe(
      false,
    );
    expect(session.check(null, "usb", "https://example.com/", {})).toBe(false);
    // Bluetooth is refused, and the agent reads it in the next receipt.
    const refused = await receipts.with(tab.id, async () => {
      expect(
        chooseBluetooth([{ deviceId: "bt-a", deviceName: "Speaker" }]),
      ).toHaveBeenCalledExactlyOnceWith("");
      return {};
    });
    expect(refused).toEqual({
      deniedRequests: [
        { origin: "https://example.com", permission: "bluetooth" },
      ],
    });
    expect(controller.activity).toEqual([
      {
        spaceId: space.id,
        message: "A site's request for a Bluetooth device was refused.",
        kind: "warning",
      },
    ]);
  });

  it("the device list updates while the prompt waits and a device that disappears cannot be chosen", () => {
    const { center, session, space, page, chooseUsb, chooseHid } = setup();
    const callback = chooseUsb([usbDevice("dev-a", "Phone")]);
    session.emit("usb-device-added", {}, usbDevice("dev-b", "Reader"), page);
    expect(center.prompts()[0].devices).toEqual([
      { id: "1256:26720:dev-a", name: "Phone" },
      { id: "1256:26720:dev-b", name: "Reader" },
    ]);
    session.emit("usb-device-removed", {}, usbDevice("dev-a", "Phone"), page);
    expect(center.prompts()[0].devices).toEqual([
      { id: "1256:26720:dev-b", name: "Reader" },
    ]);
    // The device that went away cannot be connected any more.
    center.answer({
      id: center.prompts()[0].id,
      allow: true,
      deviceId: "1256:26720:dev-a",
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith("");
    expect(
      session.devicePermission!({
        deviceType: "usb",
        origin: "https://example.com",
        device: usbDevice("dev-a"),
      }),
    ).toBe(false);
    expect(space.owner).toBe("agent");
    // HID updates name the frame instead of the page.
    const hid = chooseHid([hidDevice("hid-a", "Pad")]);
    session.emit(
      "hid-device-added",
      {},
      {
        device: hidDevice("hid-b", "Dial"),
        frame: page,
      },
    );
    expect(center.prompts()[0].devices).toEqual([
      { id: "hid-a", name: "Pad" },
      { id: "hid-b", name: "Dial" },
    ]);
    session.emit(
      "hid-device-removed",
      {},
      {
        device: hidDevice("hid-b", "Dial"),
        frame: page,
      },
    );
    expect(center.prompts()[0].devices).toEqual([{ id: "hid-a", name: "Pad" }]);
    center.answer({
      id: center.prompts()[0].id,
      allow: true,
      deviceId: "hid-a",
    });
    expect(hid).toHaveBeenCalledExactlyOnceWith("hid-a");
  });

  it("Block answers an empty choice, and a Bluetooth pairing request is refused", () => {
    const { controller, center, session, space, pageIn, chooseUsb } = setup();
    const blocked = chooseUsb([usbDevice("dev-a", "Phone")]);
    center.answer({ id: center.prompts()[0].id, allow: false });
    expect(blocked).toHaveBeenCalledExactlyOnceWith("");
    expect(space.owner).toBe("agent");
    expect(
      session.devicePermission!({
        deviceType: "usb",
        origin: "https://example.com",
        device: usbDevice("dev-a"),
      }),
    ).toBe(false);
    // Allow without a device is a Block too.
    const empty = chooseUsb([usbDevice("dev-a", "Phone")]);
    center.answer({ id: center.prompts()[0].id, allow: true });
    expect(empty).toHaveBeenCalledExactlyOnceWith("");
    // The person's own space asks without holding anything.
    const mine = pageIn("personal", "https://example.com/");
    chooseUsb([usbDevice("dev-a", "Phone")], mine.page);
    expect(center.prompts()).toMatchObject([
      { spaceId: "personal", kind: "usb", agent: false },
    ]);
    expect(
      controller.state.spaces.find((item) => item.id === "personal"),
    ).not.toHaveProperty("control");
    // Kamapathy has no pairing screen, so pairing is always refused.
    const response = vi.fn();
    session.pairing!(
      { deviceId: "bt-a", pairingKind: "confirm", frame: null },
      response,
    );
    expect(response).toHaveBeenCalledExactlyOnceWith({ confirmed: false });
  });
});
