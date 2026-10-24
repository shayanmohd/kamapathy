import { describe, expect, it, vi } from "vitest";
import {
  defaultBrowserStatus,
  LINUX_DESKTOP_FILE,
  makeDefaultBrowser,
  WINDOWS_URL_PROG_ID,
  type DefaultBrowserEnv,
} from "../electron/default-browser";

vi.mock("electron", () => ({ app: {}, shell: {} }));

const START_MENU_COMMAND =
  "HKCU\\Software\\Clients\\StartMenuInternet\\Kamapathy\\shell\\open\\command";
const USER_CHOICE =
  "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice";
const installed =
  "C:\\Users\\me\\AppData\\Local\\Programs\\Kamapathy\\Kamapathy.exe";
const startMenu = (data: string) =>
  `\r\nHKEY_CURRENT_USER\\Software\\Clients\\StartMenuInternet\\Kamapathy\\shell\\open\\command\r\n    (Default)    REG_SZ    ${data}\r\n\r\n`;
const userChoice = (progId: string) =>
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice\r\n    ProgId    REG_SZ    ${progId}\r\n\r\n`;

interface Fake {
  /** Output per "command arg arg"; any other command fails. */
  outputs?: Record<string, string>;
  files?: string[];
  defaults?: ("http" | "https")[];
}

function fake(
  platform: NodeJS.Platform,
  {
    outputs = {},
    files = [],
    defaults = [],
    ...rest
  }: Fake & Partial<DefaultBrowserEnv> = {},
) {
  const env: DefaultBrowserEnv = {
    platform,
    defaultApp: false,
    execPath:
      platform === "win32"
        ? installed
        : platform === "darwin"
          ? "/Applications/Kamapathy.app/Contents/MacOS/Kamapathy"
          : "/opt/Kamapathy/kamapathy",
    env: {},
    home: platform === "win32" ? "C:\\Users\\me" : "/home/me",
    isDefaultProtocolClient: vi.fn((protocol) => defaults.includes(protocol)),
    setAsDefaultProtocolClient: vi.fn(() => true),
    openExternal: vi.fn(async () => {}),
    run: vi.fn(async (command: string, args: string[]) => {
      const key = [command, ...args].join(" ");
      if (key in outputs) return outputs[key];
      throw new Error(`${command} exited with code 1`);
    }),
    exists: vi.fn((path: string) => files.includes(path)),
    ...rest,
  };
  return env;
}

const windowsInstalled = (progId?: string, command = `"${installed}"`) => ({
  [`reg query ${START_MENU_COMMAND} /ve`]: startMenu(command),
  ...(progId
    ? { [`reg query ${USER_CHOICE} /v ProgId`]: userChoice(progId) }
    : {}),
});
const linuxDesktop = `/usr/share/applications/${LINUX_DESKTOP_FILE}`;
const xdgDefault = (name: string) => ({
  "xdg-settings get default-web-browser": `${name}\n`,
});

describe("default browser status", () => {
  it("status per platform: development before any command runs", async () => {
    for (const platform of ["darwin", "win32", "linux", "freebsd"] as const) {
      const env = fake(platform, {
        defaultApp: true,
        execPath: "/Volumes/Kamapathy/Kamapathy.app/Contents/MacOS/Kamapathy",
        files: [linuxDesktop],
        defaults: ["http", "https"],
        outputs: {
          ...windowsInstalled(WINDOWS_URL_PROG_ID),
          ...xdgDefault(LINUX_DESKTOP_FILE),
        },
      });
      expect(await defaultBrowserStatus(env)).toEqual({
        state: "unavailable",
        reason: "development",
      });
      expect(env.run).not.toHaveBeenCalled();
      expect(env.exists).not.toHaveBeenCalled();
      expect(env.isDefaultProtocolClient).not.toHaveBeenCalled();
    }
  });

  it("status per platform: macOS", async () => {
    const diskImage = fake("darwin", {
      execPath:
        "/Volumes/Kamapathy 0.2.0/Kamapathy.app/Contents/MacOS/Kamapathy",
      defaults: ["http", "https"],
    });
    expect(await defaultBrowserStatus(diskImage)).toEqual({
      state: "unavailable",
      reason: "disk-image",
    });
    expect(diskImage.isDefaultProtocolClient).not.toHaveBeenCalled();
    expect(
      await defaultBrowserStatus(
        fake("darwin", { defaults: ["http", "https"] }),
      ),
    ).toEqual({ state: "default" });
    for (const defaults of [["http"], ["https"], []] as const)
      expect(
        await defaultBrowserStatus(fake("darwin", { defaults: [...defaults] })),
      ).toEqual({ state: "available" });
  });

  it("status per platform: Windows", async () => {
    const portable = fake("win32", {
      execPath: "C:\\Users\\me\\AppData\\Local\\Temp\\2bXkW1\\Kamapathy.exe",
      env: {
        PORTABLE_EXECUTABLE_FILE:
          "D:\\Kamapathy-0.2.0-windows-x64-portable.exe",
        PORTABLE_EXECUTABLE_APP_FILENAME: "Kamapathy",
      },
      outputs: windowsInstalled(WINDOWS_URL_PROG_ID),
    });
    expect(await defaultBrowserStatus(portable)).toEqual({
      state: "unavailable",
      reason: "portable",
    });
    expect(portable.run).not.toHaveBeenCalled();

    // Variables leaked by another portable app describe a different executable.
    const leaked = fake("win32", {
      env: {
        PORTABLE_EXECUTABLE_FILE: "D:\\Other-portable.exe",
        PORTABLE_EXECUTABLE_APP_FILENAME: "Other",
      },
      outputs: windowsInstalled("ChromeHTML"),
    });
    expect(await defaultBrowserStatus(leaked)).toEqual({ state: "available" });

    const missing = fake("win32");
    expect(await defaultBrowserStatus(missing)).toEqual({
      state: "unavailable",
      reason: "not-installed",
    });
    expect(missing.run).toHaveBeenCalledTimes(1);
    expect(missing.run).toHaveBeenCalledWith(
      "reg",
      ["query", START_MENU_COMMAND, "/ve"],
      expect.anything(),
    );
    for (const command of [
      '"C:\\Program Files\\Kamapathy\\Kamapathy.exe"',
      '"C:\\Users\\me\\AppData\\Local\\Programs\\Kamapathy\\Other.exe" --single-argument %1',
      "(value not set)",
      "",
    ])
      expect(
        await defaultBrowserStatus(
          fake("win32", {
            outputs: windowsInstalled(WINDOWS_URL_PROG_ID, command),
          }),
        ),
      ).toEqual({ state: "unavailable", reason: "not-installed" });

    const isDefault = fake("win32", {
      outputs: windowsInstalled(WINDOWS_URL_PROG_ID),
    });
    expect(await defaultBrowserStatus(isDefault)).toEqual({ state: "default" });
    expect(isDefault.run).toHaveBeenLastCalledWith(
      "reg",
      ["query", USER_CHOICE, "/v", "ProgId"],
      expect.anything(),
    );
    // The same executable in another spelling, with arguments after it.
    expect(
      await defaultBrowserStatus(
        fake("win32", {
          outputs: windowsInstalled(
            WINDOWS_URL_PROG_ID,
            '"c:\\users\\ME\\AppData\\Local\\Programs\\Kamapathy\\.\\KAMAPATHY.EXE" --flag',
          ),
        }),
      ),
    ).toEqual({ state: "default" });
    expect(
      await defaultBrowserStatus(
        fake("win32", {
          outputs: windowsInstalled(WINDOWS_URL_PROG_ID, installed),
        }),
      ),
    ).toEqual({ state: "default" });
    expect(
      await defaultBrowserStatus(
        fake("win32", { outputs: windowsInstalled("MSEdgeHTM") }),
      ),
    ).toEqual({ state: "available" });
    // No UserChoice key: the person never chose a browser.
    expect(
      await defaultBrowserStatus(
        fake("win32", { outputs: windowsInstalled() }),
      ),
    ).toEqual({ state: "available" });
  });

  it("status per platform: Linux", async () => {
    const unintegrated = fake("linux", {
      outputs: xdgDefault(LINUX_DESKTOP_FILE),
    });
    expect(await defaultBrowserStatus(unintegrated)).toEqual({
      state: "unavailable",
      reason: "not-installed",
    });
    expect(unintegrated.run).not.toHaveBeenCalled();
    expect(unintegrated.exists).toHaveBeenCalledWith(
      `/home/me/.local/share/applications/${LINUX_DESKTOP_FILE}`,
    );
    expect(unintegrated.exists).toHaveBeenCalledWith(
      `/usr/local/share/applications/${LINUX_DESKTOP_FILE}`,
    );
    expect(unintegrated.exists).toHaveBeenCalledWith(linuxDesktop);

    const where = async (files: string[], env: NodeJS.ProcessEnv = {}) =>
      (
        await defaultBrowserStatus(
          fake("linux", { files, env, outputs: xdgDefault("firefox.desktop") }),
        )
      ).state;
    expect(await where([linuxDesktop])).toBe("available");
    expect(
      await where([`/home/me/.local/share/applications/${LINUX_DESKTOP_FILE}`]),
    ).toBe("available");
    expect(
      await where([`/data/me/applications/${LINUX_DESKTOP_FILE}`], {
        XDG_DATA_HOME: "/data/me",
      }),
    ).toBe("available");
    expect(
      await where(
        [`/home/me/.local/share/applications/${LINUX_DESKTOP_FILE}`],
        {
          XDG_DATA_HOME: "/data/me",
        },
      ),
    ).toBe("unavailable");
    expect(
      await where(
        [`/var/lib/flatpak/exports/share/applications/${LINUX_DESKTOP_FILE}`],
        { XDG_DATA_DIRS: "/opt/share:/var/lib/flatpak/exports/share" },
      ),
    ).toBe("available");
    expect(await where([linuxDesktop], { XDG_DATA_DIRS: "/opt/share" })).toBe(
      "unavailable",
    );

    const isDefault = fake("linux", {
      files: [linuxDesktop],
      outputs: xdgDefault(LINUX_DESKTOP_FILE),
    });
    expect(await defaultBrowserStatus(isDefault)).toEqual({ state: "default" });
    expect(isDefault.run).toHaveBeenCalledWith(
      "xdg-settings",
      ["get", "default-web-browser"],
      expect.anything(),
    );
    expect(
      await defaultBrowserStatus(fake("linux", { files: [linuxDesktop] })),
    ).toEqual({ state: "available" });
  });

  it("status per platform: other systems", async () => {
    expect(await defaultBrowserStatus(fake("freebsd"))).toEqual({
      state: "unavailable",
      reason: "not-installed",
    });
  });
});

describe("making Kamapathy the default browser", () => {
  it("make default: macOS registers http, then https", async () => {
    const env = fake("darwin", { defaults: ["https"] });
    await makeDefaultBrowser(env);
    expect(vi.mocked(env.setAsDefaultProtocolClient).mock.calls).toEqual([
      ["http"],
      ["https"],
    ]);
    expect(env.openExternal).not.toHaveBeenCalled();
    expect(env.run).not.toHaveBeenCalled();
  });

  it("make default: Windows opens the Default apps page for Kamapathy", async () => {
    const env = fake("win32", { outputs: windowsInstalled("ChromeHTML") });
    await makeDefaultBrowser(env);
    expect(vi.mocked(env.openExternal).mock.calls).toEqual([
      ["ms-settings:defaultapps?registeredAppUser=Kamapathy"],
    ]);
    expect(env.setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it("make default: Linux asks xdg-settings with a timeout", async () => {
    const env = fake("linux", {
      files: [linuxDesktop],
      outputs: {
        ...xdgDefault("firefox.desktop"),
        [`xdg-settings set default-web-browser ${LINUX_DESKTOP_FILE}`]: "",
      },
    });
    await makeDefaultBrowser(env);
    expect(env.run).toHaveBeenLastCalledWith(
      "xdg-settings",
      ["set", "default-web-browser", LINUX_DESKTOP_FILE],
      { timeoutMs: 5000 },
    );
    expect(env.setAsDefaultProtocolClient).not.toHaveBeenCalled();
    expect(env.openExternal).not.toHaveBeenCalled();
  });

  it("make default: nothing runs unless Kamapathy can become the default", async () => {
    const cases = [
      fake("darwin", { defaultApp: true }),
      fake("darwin", {
        execPath: "/Volumes/Kamapathy/Kamapathy.app/Contents/MacOS/Kamapathy",
      }),
      fake("darwin", { defaults: ["http", "https"] }),
      fake("win32"),
      fake("win32", {
        execPath: "C:\\Temp\\x\\Kamapathy.exe",
        env: {
          PORTABLE_EXECUTABLE_FILE: "D:\\Kamapathy-portable.exe",
          PORTABLE_EXECUTABLE_APP_FILENAME: "Kamapathy",
        },
      }),
      fake("win32", { outputs: windowsInstalled(WINDOWS_URL_PROG_ID) }),
      fake("linux"),
      fake("linux", {
        files: [linuxDesktop],
        outputs: xdgDefault(LINUX_DESKTOP_FILE),
      }),
      fake("freebsd"),
    ];
    for (const env of cases) {
      await makeDefaultBrowser(env);
      expect(env.setAsDefaultProtocolClient).not.toHaveBeenCalled();
      expect(env.openExternal).not.toHaveBeenCalled();
      for (const [command, args] of vi.mocked(env.run).mock.calls)
        expect([command, args[0]]).not.toEqual(["xdg-settings", "set"]);
    }
  });
});
