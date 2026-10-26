// Section 17's agent-facing rule: a frame showing a page of one of the
// person's extensions is named for the person and never read. The names, the
// cap on them and the refusal message are pure, so they are checked here
// without a page.
import { describe, expect, it } from "vitest";
import {
  NO_EXTENSION_NAMES,
  extensionFrame,
  extensionInputMessage,
  extensionOrigin,
} from "../electron/agent/extension-frames";
import { NAME_LIMIT, PDF_VIEWER_EXTENSION_ID } from "../shared/extensions";

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
