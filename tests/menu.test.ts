import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { menuTemplate } from "../electron/menu";
import { isActionName, toolsMenuLayout } from "../src/lib/actions";

const kamapathyWindow = { id: 1 };
function flatten(
  items: MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ]);
}
function template(darwin: boolean, send = vi.fn()) {
  return menuTemplate({
    darwin,
    appName: "Kamapathy",
    shell: () => kamapathyWindow,
    send,
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
  const items = flatten(template(darwin, send));
  for (const item of items) click(item, kamapathyWindow);
  return { items, sent: send.mock.calls.map(([name]) => name as string) };
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
    const { sent } = build();
    for (const name of toolsMenuLayout) if (name) expect(sent).toContain(name);
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
