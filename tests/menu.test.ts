import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { menuTemplate } from "../electron/menu";
import {
  AGENT_GUIDE_URL,
  HELP_LINKS,
  HELP_URL,
  ISSUES_URL,
  PRIVACY_URL,
} from "../shared/links";
import {
  isActionName,
  paletteActions,
  toolsMenuLayout,
} from "../src/lib/actions";

const kamapathyWindow = { id: 1 };
function flatten(
  items: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ]);
}
function template(darwin: boolean, send = vi.fn(), open = vi.fn()) {
  return menuTemplate({
    darwin,
    appName: "Kamapathy",
    shell: () => kamapathyWindow,
    send,
    open,
  });
}
// Electron passes the menu item, the focused window and the event.
function click(item: MenuItemConstructorOptions, target: unknown) {
  (item.click as ((item: unknown, target: unknown) => void) | undefined)?.(
    undefined,
    target,
  );
}
function build(darwin = true) {
  const send = vi.fn();
  const open = vi.fn();
  const items = flatten(template(darwin, send, open));
  for (const item of items) click(item, kamapathyWindow);
  return {
    items,
    sent: send.mock.calls.map(([name]) => name as string),
    opened: open.mock.calls.map(([url]) => url as string),
  };
}
function helpItems(darwin: boolean, send = vi.fn(), open = vi.fn()) {
  const menu = template(darwin, send, open);
  const help = menu[menu.length - 1];
  return {
    menu,
    help,
    items: (Array.isArray(help.submenu) ? help.submenu : []).filter(
      (item) => item.type !== "separator",
    ),
  };
}
function viewItems() {
  const view = template(true).find((item) => item.label === "View");
  return (Array.isArray(view?.submenu) ? view.submenu : [])
    .filter((item) => item.label)
    .map((item) => [item.label, item.accelerator ?? ""]);
}

describe("application menu", () => {
  it("sends only actions the window understands", () => {
    const { sent } = build();
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((name) => !isActionName(name))).toEqual([]);
  });
  it("shows shortcuts in the View menu without registering them a second time", () => {
    expect(viewItems()).toEqual([
      ["Search Tabs and Commands", "CmdOrCtrl+K"],
      ["Spaces", ""],
      ["Bookmarks", "CmdOrCtrl+Shift+B"],
      ["History", "Cmd+Y"],
      ["Downloads", "CmdOrCtrl+Shift+J"],
      ["Passwords", ""],
      ["Extensions", ""],
      ["Split View", ""],
      ["Find", "CmdOrCtrl+F"],
      ["Save Page Screenshot", ""],
      ["Developer Tools", "F12"],
      ["Zoom In", "CmdOrCtrl+Plus"],
      ["Zoom Out", "CmdOrCtrl+-"],
      ["Actual Size", "CmdOrCtrl+0"],
    ]);
    const history = build().items.find((item) => item.label === "History");
    expect(history?.registerAccelerator).toBe(false);
  });
  it("lists every command of the browser menu", () => {
    const { sent, opened } = build();
    // The browser menu's Help is the Help menu's first link.
    for (const name of toolsMenuLayout)
      if (name === "help") expect(opened).toContain(HELP_LINKS.help);
      else if (name) expect(sent).toContain(name);
  });
  it("Help items pass the fixed URLs to open and send agent-setup", () => {
    for (const darwin of [true, false]) {
      const send = vi.fn();
      const open = vi.fn();
      const { menu, help, items } = helpItems(darwin, send, open);
      // Help comes last, after the Window menu.
      expect(help.role).toBe("help");
      expect(menu[menu.length - 2].role).toBe("windowMenu");
      expect(items.map((item) => item.label)).toEqual([
        "Kamapathy Help",
        "What's New",
        "Set Up Agents…",
        "Agent Guide",
        "Privacy",
        "Report an Issue",
      ]);
      for (const item of items) click(item, kamapathyWindow);
      expect(open.mock.calls).toEqual([
        [HELP_URL],
        [AGENT_GUIDE_URL],
        [PRIVACY_URL],
        [ISSUES_URL],
      ]);
      expect(send.mock.calls).toEqual([["whats-new"], ["agent-setup"]]);
    }
    // Links work with no Kamapathy window in front; Set Up Agents… needs it.
    const send = vi.fn();
    const open = vi.fn();
    for (const item of helpItems(true, send, open).items)
      click(item, undefined);
    expect(open).toHaveBeenCalledTimes(4);
    expect(send).not.toHaveBeenCalled();
  });
  it("Help lists What's New, which sends whats-new", () => {
    const send = vi.fn();
    const { items } = helpItems(true, send);
    expect(items.map((item) => item.label).slice(0, 2)).toEqual([
      "Kamapathy Help",
      "What's New",
    ]);
    click(items[1], kamapathyWindow);
    expect(send.mock.calls).toEqual([["whats-new"]]);
  });
  it("lists Set up agents and Help in the browser menu and four help commands in the palette", () => {
    expect(toolsMenuLayout.slice(-3)).toEqual([
      "settings",
      "agent-setup",
      "help",
    ]);
    expect(paletteActions.slice(-4)).toEqual([
      "agent-setup",
      "help",
      "report-issue",
      "privacy",
    ]);
    for (const name of [...toolsMenuLayout, ...paletteActions])
      if (name) expect(isActionName(name)).toBe(true);
    expect(new Set(paletteActions).size).toBe(paletteActions.length);
  });
  it("keeps the app menu named after the app", () => {
    expect(template(true)[0].label).toBe("Kamapathy");
    expect(template(false)[0].label).toBe("File");
  });
  it("shows Ctrl+H for History off macOS", () => {
    const history = flatten(template(false)).find(
      (item) => item.label === "History",
    );
    expect(history?.accelerator).toBe("Ctrl+H");
  });
  it("ignores menu keys pressed in windows that are not Kamapathy's", () => {
    const send = vi.fn();
    for (const item of flatten(template(true, send))) {
      click(item, { id: 2 });
      click(item, undefined);
    }
    expect(send).not.toHaveBeenCalled();
  });
});
