import type { BaseWindow, MenuItemConstructorOptions } from "electron";

export function menuTemplate({
  darwin,
  appName,
  shell,
  send,
}: {
  darwin: boolean;
  appName: string;
  shell: () => Pick<BaseWindow, "id"> | null;
  send: (name: string) => void;
}): MenuItemConstructorOptions[] {
  // Kamapathy's shell and pages take these keys before the menu, so off macOS the
  // menu only shows them. On macOS the menu also gets keys pressed in detached
  // DevTools and the About panel, which must not act on Kamapathy's tabs.
  const command = (
    label: string,
    name: string,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    label,
    click: (_item, target) => {
      if (target && target.id === shell()?.id) send(name);
    },
    ...(accelerator ? { accelerator, registerAccelerator: false } : {}),
  });
  const appMenu: MenuItemConstructorOptions[] = darwin
    ? [
        {
          label: appName,
          submenu: [
            { role: "about" },
            { type: "separator" },
            command("Settings…", "settings", "CmdOrCtrl+,"),
            { type: "separator" },
            { role: "services" },
            { type: "separator" },
            { role: "hide" },
            { role: "hideOthers" },
            { role: "unhide" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
      ]
    : [];
  return [
    ...appMenu,
    {
      label: "File",
      submenu: [
        command("New Tab", "new-tab", "CmdOrCtrl+T"),
        command("New Space", "space"),
        command("Reopen Closed Tab", "reopen-tab", "CmdOrCtrl+Shift+T"),
        command("Close Tab", "close-tab", "CmdOrCtrl+W"),
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        command("Search Tabs and Commands", "command", "CmdOrCtrl+K"),
        // On macOS a menu key would still fire while a page types "ß".
        command("Spaces", "spaces", darwin ? undefined : "Alt+S"),
        command("Bookmarks", "bookmarks", "CmdOrCtrl+Shift+B"),
        command("History", "history", darwin ? "Cmd+Y" : "Ctrl+H"),
        command("Downloads", "downloads", "CmdOrCtrl+Shift+J"),
        command("Extensions", "extensions"),
        { type: "separator" },
        command("Split View", "split"),
        command("Find", "find", "CmdOrCtrl+F"),
        { type: "separator" },
        command("Save Page Screenshot", "screenshot"),
        command("Developer Tools", "devtools", "F12"),
        command("Zoom In", "zoom-in", "CmdOrCtrl+Plus"),
        command("Zoom Out", "zoom-out", "CmdOrCtrl+-"),
        command("Actual Size", "zoom-reset", "CmdOrCtrl+0"),
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
}
