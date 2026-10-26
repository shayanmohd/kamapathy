// Section 17's agent-facing rule: a frame showing a page of one of the
// person's extensions is named for the person and never read. The names, the
// cap on them and the refusal message are pure. The snapshot entry runs
// section 9's composition over a tab session whose registry holds a frame
// with an extension URL, which a real page could not be given here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_EXTENSION_NAMES,
  extensionFrame,
  extensionInputMessage,
  extensionOrigin,
  type ExtensionNames,
} from "../electron/agent/extension-frames";
import { createFrameGroups } from "../electron/agent/frames/groups";
import { RefBook } from "../electron/agent/refs";
import { createResolver } from "../electron/agent/resolve";
import type { AutomationController } from "../electron/agent/server";
import { EventBufferPool } from "../electron/agent/session/event-buffer";
import { TabSession } from "../electron/agent/session/tab-session";
import type { SessionHost } from "../electron/agent/session/types";
import {
  createSnapshots,
  type SnapshotRequest,
} from "../electron/agent/snapshot";
import { NAME_LIMIT, PDF_VIEWER_EXTENSION_ID } from "../shared/extensions";
import { FakeHost, frameTree } from "./fake-cdp";

const ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER = "ponmlkjihgfedcbaponmlkjihgfedcba";
const names = (entries: Record<string, string>) => ({
  nameOf: (id: string) => entries[id],
});

describe("extension frames", () => {
  it("names a loaded extension's frame, cleaned and cut to the name limit", () => {
    const held = names({ [ID]: "Price watcher" });
    expect(extensionFrame(`chrome-extension://${ID}/frame.html`, held)).toEqual(
      { id: ID, name: "Price watcher" },
    );
    // A page of the extension, whatever its path or query.
    expect(extensionFrame(`chrome-extension://${ID}/`, held)?.name).toBe(
      "Price watcher",
    );
    expect(
      extensionFrame(`chrome-extension://${ID}/panel.html?tab=1#top`, held)
        ?.name,
    ).toBe("Price watcher");
    // The name comes from the extension, so it is cleaned like agent text
    // and cut to 75 characters.
    const long = `Price‮watcher\n${"x".repeat(90)}`;
    const cut = extensionFrame(
      `chrome-extension://${ID}/frame.html`,
      names({ [ID]: long }),
    );
    expect(cut?.name).toBe(`Pricewatcher ${"x".repeat(NAME_LIMIT - 13)}`);
    expect(cut?.name).toHaveLength(NAME_LIMIT);
    expect(cut?.name).not.toMatch(/[‮\n]/);
  });

  it("names no frame of a component extension, an unknown id or a web page", () => {
    // Kamapathy's own PDF viewer is a plain blocked frame, as section 16
    // says, even if a name is held for it.
    expect(
      extensionFrame(
        `chrome-extension://${PDF_VIEWER_EXTENSION_ID}/index.html`,
        names({ [PDF_VIEWER_EXTENSION_ID]: "Viewer" }),
      ),
    ).toBeUndefined();
    // An extension that is not loaded in this session has no name here.
    expect(
      extensionFrame(
        `chrome-extension://${OTHER}/frame.html`,
        names({ [ID]: "Price watcher" }),
      ),
    ).toBeUndefined();
    const held = names({ [ID]: "Price watcher" });
    for (const url of [
      "https://shop.example/frame.html",
      "about:blank",
      "chrome-extension://short/frame.html",
      "chrome://settings",
      "",
    ])
      expect(extensionFrame(url, held), url).toBeUndefined();
    // Without a host nothing is ever an extension.
    expect(
      extensionFrame(`chrome-extension://${ID}/frame.html`, NO_EXTENSION_NAMES),
    ).toBeUndefined();
  });

  it("knows an extension origin and says what agents may do there", () => {
    expect(extensionOrigin(`chrome-extension://${ID}`)).toBe(true);
    expect(
      extensionOrigin(`chrome-extension://${PDF_VIEWER_EXTENSION_ID}`),
    ).toBe(true);
    for (const origin of [undefined, "", "https://shop.example", "://", "null"])
      expect(extensionOrigin(origin), String(origin)).toBe(false);
    expect(extensionInputMessage("Price watcher")).toBe(
      "This is part of the Price watcher extension. Agents can't use extensions; ask the person to continue there.",
    );
  });
});

// A page whose three frames the walk cannot read: one of a loaded
// extension, Kamapathy's PDF viewer and one of an extension this session
// never loaded. The page answers one read for the top group; nothing is read
// inside any of them.
const PAGE_URL = "https://shop.example/";
type Entry = Record<string, unknown>;
const box = { left: 0, top: 0, right: 100, bottom: 50 };
const frame = (local: string, ref: string, label: string): Entry => ({
  index: Number(local),
  ref,
  tag: "iframe",
  role: "iframe",
  label,
  crossOrigin: true,
  contentFrame: local,
  blocked: true,
});
const read = () => ({
  ok: true,
  url: PAGE_URL,
  title: "Shop",
  group: "",
  text: [{ order: 0, value: "Prices" }],
  controls: [
    { order: 1, tier: 0, local: "", entry: frame("0", "@e1", "watcher") },
    { order: 2, tier: 0, local: "", entry: frame("1", "@e2", "receipt") },
    { order: 3, tier: 0, local: "", entry: frame("2", "@e3", "old") },
    {
      order: 4,
      tier: 0,
      local: "",
      entry: {
        index: 3,
        ref: "@e4",
        tag: "button",
        role: "button",
        label: "Buy",
      },
    },
  ],
  outline: [],
  placeholders: [0, 1, 2].map((at) => ({
    local: String(at),
    order: at + 1,
    tier: 0,
    box,
    readable: false,
    blocked: true as const,
  })),
  chars: 6,
});

async function openPage(extensions: ExtensionNames) {
  const host = new FakeHost({ url: PAGE_URL });
  const cdp = host.debugger;
  cdp.reply("Page.getFrameTree", () =>
    frameTree([
      { id: "main", url: PAGE_URL },
      {
        id: "ext",
        parentId: "main",
        url: `chrome-extension://${ID}/frame.html`,
        origin: `chrome-extension://${ID}`,
      },
      {
        id: "pdf",
        parentId: "main",
        url: `chrome-extension://${PDF_VIEWER_EXTENSION_ID}/index.html`,
        origin: `chrome-extension://${PDF_VIEWER_EXTENSION_ID}`,
      },
      {
        id: "old",
        parentId: "main",
        url: `chrome-extension://${OTHER}/frame.html`,
        origin: `chrome-extension://${OTHER}`,
      },
    ]),
  );
  // What the registry needs to path a blocked frame: the owner element of
  // the frame, resolved into the page's world, and the index that world
  // counts it at. The frame's own world is never opened.
  const owners = ["ext", "pdf", "old"];
  cdp.reply("DOM.getFrameOwner", (params) => {
    const at = owners.indexOf(params.frameId);
    if (at < 0) throw new Error("Frame with the given id was not found.");
    return { backendNodeId: at + 1 };
  });
  cdp.reply("DOM.resolveNode", (params) => ({
    object: {
      type: "object",
      subtype: "node",
      objectId: `owner-${params.backendNodeId}`,
    },
  }));
  cdp.reply("Runtime.callFunctionOn", (params) => ({
    result: {
      type: "object",
      value: { ok: true, path: String(Number(params.objectId.slice(6)) - 1) },
    },
  }));
  const session = new TabSession(host as unknown as SessionHost, {
    tabId: "tab-1",
    waitForSpaceIdle: async () => {},
    buffer: new EventBufferPool().create("tab-1"),
  });
  session.attach();
  await vi.advanceTimersByTimeAsync(0);
  const refs = new RefBook();
  const groups = createFrameGroups(session, { refs, tabId: "tab-1" });
  const snapshots = createSnapshots({
    controller: {
      state: { tabs: [{ id: "tab-1", url: PAGE_URL, title: "Shop" }] },
    } as unknown as AutomationController,
    evaluatePage: async (_id, _session, operation) =>
      operation === "snapshot" ? read() : { ok: true },
    resolver: createResolver({ refs }),
    namespace: () => "snapshots",
    frames: { for: () => groups, dispose: () => {} },
    extensions,
  });
  const request: SnapshotRequest = {
    mode: "full",
    maxChars: 24000,
    maxControls: 100,
    scope: "page",
    format: "list",
    locators: false,
    header: false,
  };
  const taking = snapshots.take("tab-1", session, request, Date.now() + 10000, {
    deadline: Date.now() + 10000,
  });
  await vi.advanceTimersByTimeAsync(0);
  const listing = await taking;
  groups.dispose();
  await session.release();
  return listing;
}

describe("extension frames in a snapshot", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives a loaded extension's frame a blocked entry naming the extension, with nothing inside", async () => {
    const listing = await openPage(names({ [ID]: "Price watcher" }));
    const entries = listing.interactables as Entry[];
    expect(entries.map((entry) => entry.ref)).toEqual([
      "@e1",
      "@e2",
      "@e3",
      "@e4",
    ]);
    // The extension's own frame: named for the person, never read.
    expect(entries[0]).toMatchObject({
      ref: "@e1",
      role: "iframe",
      label: "Extension: Price watcher",
      extension: "Price watcher",
      content: "blocked",
      crossOrigin: true,
    });
    expect(entries[0]).not.toHaveProperty("origin");
    expect(entries[0]).not.toHaveProperty("contentFrame");
    // The PDF viewer and an extension this session never loaded stay plain
    // blocked entries, with the label the page gave them.
    for (const entry of [entries[1], entries[2]]) {
      expect(entry.content).toBe("blocked");
      expect(entry).not.toHaveProperty("extension");
      expect(entry).not.toHaveProperty("origin");
    }
    expect(entries[1].label).toBe("receipt");
    expect(entries[2].label).toBe("old");
    // Nothing from inside any of them, and a blocked frame is not an unread
    // one: the page's own text and control are all there is.
    expect(listing.text).toBe("Prices");
    expect(listing).not.toHaveProperty("unreadFrames");
    expect(entries[3]).toMatchObject({ ref: "@e4", label: "Buy" });
  });

  it("cuts a long name to 75 characters and strips what it may not show", async () => {
    const long = `Price‮watcher\n${"x".repeat(90)}`;
    const listing = await openPage(names({ [ID]: long }));
    const entry = (listing.interactables as Entry[])[0];
    const name = `Pricewatcher ${"x".repeat(NAME_LIMIT - 13)}`;
    expect(entry.extension).toBe(name);
    expect(entry.label).toBe(`Extension: ${name}`);
    expect(String(entry.extension)).toHaveLength(NAME_LIMIT);
  });
});
