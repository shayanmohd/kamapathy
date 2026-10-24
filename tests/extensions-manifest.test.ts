import { generateKeyPairSync } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PDF_VIEWER_EXTENSION_ID,
  agentHeld,
  cleanExtensionText,
  compareVersions,
  coversAllHosts,
  extensionIdOf,
  extensionLabel,
  extensionPermission,
  globMatch,
  hostsOf,
  isVersion,
  matchesPattern,
  patternHost,
  permissionLines,
  permissionsOf,
  plainName,
  raisesPermissions,
  runsExtensions,
  storeDetailId,
  storeItemId,
  wontWorkNames,
} from "../shared/extensions";
import {
  ManifestRefusal,
  checkManifest,
  idFromKey,
  idFromKeyBase64,
  injectKey,
  localize,
  readManifest,
} from "../electron/extensions/manifest";
import { extensionRefusalCopy } from "../src/copy";

// The PDF viewer's public key, from Chromium's pdf/manifest.json.
const PDF_VIEWER_KEY =
  "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDN6hM0rsDYGbzQPQfOygqlRtQgKUXMfnSjhIBL7LnReAVBEd7ZmKtyN2qmSasMl4HZpMhVe2rPWVVwBDl6iyNE/Kok6E6v6V3vCLGsOpQAuuNVye/3QxzIldzG/jQAdWZiyXReRVapOhZtLjGfywCvlWq7Sl/e3sbc0vWybSDI2QIDAQAB";
const STORE_ID = "ddkjiahejlhfcafbddmgiahcphecmpfh";
const BASE = { manifest_version: 3, name: "Example", version: "1.0.0" };
const CONTEXT = {
  chromeVersion: "152.0.7977.76",
  locale: "en-US",
  installed: 0,
  replacing: false,
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function folderWith(files: Record<string, unknown>): string {
  const folder = mkdtempSync(join(tmpdir(), "kamapathy-extension-test-"));
  directories.push(folder);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(
      join(folder, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return folder;
}
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestRefusal);
    return (error as Error).message;
  }
  throw new Error("Expected a refusal.");
}
async function refused(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ManifestRefusal);
  return (error as Error).message;
}
function publicKey(): Buffer {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
    type: "spki",
    format: "der",
  });
}

describe("extension manifests", () => {
  it("refusal copy and localization", async () => {
    const copy = extensionRefusalCopy;
    expect(
      refusal(() => checkManifest({ ...BASE, manifest_version: 2 }, CONTEXT)),
    ).toBe(copy.version);
    expect(refusal(() => checkManifest({ ...BASE, theme: {} }, CONTEXT))).toBe(
      copy.themeOrApp,
    );
    expect(
      refusal(() => checkManifest({ ...BASE, app: { launch: {} } }, CONTEXT)),
    ).toBe(copy.themeOrApp);
    expect(
      refusal(() =>
        checkManifest({ ...BASE, minimum_chrome_version: "153" }, CONTEXT),
      ),
    ).toBe(copy.chrome);
    expect(
      refusal(() => checkManifest(BASE, { ...CONTEXT, installed: 100 })),
    ).toBe(copy.limit);
    // The first check that fails decides the copy.
    expect(
      refusal(() =>
        checkManifest({ ...BASE, manifest_version: 2, theme: {} }, CONTEXT),
      ),
    ).toBe(copy.version);
    expect(
      refusal(() =>
        checkManifest({ ...BASE, app: {} }, { ...CONTEXT, installed: 100 }),
      ),
    ).toBe(copy.themeOrApp);
    for (const manifest of [
      { ...BASE, name: undefined },
      { ...BASE, name: " " },
      { ...BASE, name: 7 },
      { ...BASE, version: "1.0.0.0.0" },
      { ...BASE, version: 1 },
      { ...BASE, minimum_chrome_version: 120 },
      { ...BASE, minimum_chrome_version: "soon" },
      { ...BASE, key: "not base64!" },
      { ...BASE, key: "" },
      { ...BASE, key: Buffer.from("not a key").toString("base64") },
      { ...BASE, key: 5 },
    ])
      expect(refusal(() => checkManifest(manifest, CONTEXT))).toBe(
        copy.invalid,
      );
    expect(() =>
      checkManifest(
        { ...BASE, minimum_chrome_version: "152.0.7977.76" },
        CONTEXT,
      ),
    ).not.toThrow();
    expect(() =>
      checkManifest(BASE, { ...CONTEXT, installed: 99 }),
    ).not.toThrow();
    expect(() =>
      checkManifest(BASE, { ...CONTEXT, installed: 100, replacing: true }),
    ).not.toThrow();

    expect(await refused(readManifest(folderWith({}), CONTEXT))).toBe(
      copy.noManifest,
    );
    expect(
      await refused(readManifest(join(folderWith({}), "missing"), CONTEXT)),
    ).toBe(copy.noManifest);
    for (const text of ["{", "[]", "null", '"manifest"'])
      expect(
        await refused(
          readManifest(folderWith({ "manifest.json": text }), CONTEXT),
        ),
      ).toBe(copy.invalid);
    expect(
      await refused(
        readManifest(
          folderWith({ "manifest.json": { ...BASE, manifest_version: 2 } }),
          CONTEXT,
        ),
      ),
    ).toBe(copy.version);

    const folder = folderWith({
      "manifest.json": `\uFEFF${JSON.stringify({
        ...BASE,
        name: "__MSG_appName__",
        default_locale: "fr",
        action: { default_title: "__MSG_Title__ \u202Enow" },
      })}`,
      "_locales/en_US/messages.json": {
        APPNAME: { message: "American name" },
        title: { message: "Open\nit" },
      },
      "_locales/en/messages.json": { appname: { message: "English name" } },
      "_locales/fr/messages.json": { AppName: { message: "Nom" } },
      // Where a locale of "../fr" would lead.
      "fr/messages.json": { appname: { message: "Outside" } },
    });
    const checked = await readManifest(folder, CONTEXT);
    expect(checked.name).toBe("American name");
    expect(checked.actionTitle).toBe("Open it now");
    rmSync(join(folder, "_locales/en_US"), { recursive: true });
    expect((await readManifest(folder, CONTEXT)).name).toBe("English name");
    expect(
      (await readManifest(folder, { ...CONTEXT, locale: "de-DE" })).name,
    ).toBe("Nom");
    expect(
      (await readManifest(folder, { ...CONTEXT, locale: "../fr" })).name,
    ).toBe("Nom");
    rmSync(join(folder, "_locales/fr"), { recursive: true });
    // A name that localizes to nothing is not a name.
    expect(
      await refused(readManifest(folder, { ...CONTEXT, locale: "de" })),
    ).toBe(copy.invalid);

    expect(
      localize("__MSG_a__ and __MSG_B__ __MSG_c__", {
        a: { message: "x" },
        b: { message: "y" },
        c: { message: 5 },
      }),
    ).toBe("x and y ");
    expect(localize("__MSG_constructor__", {})).toBe("");
    expect(localize("Plain", undefined)).toBe("Plain");

    const long = await readManifest(
      folderWith({
        "manifest.json": {
          ...BASE,
          name: `Ext\u202Eension\n${"n".repeat(80)}`,
        },
      }),
      CONTEXT,
    );
    expect(Array.from(long.name).length).toBeLessThanOrEqual(75);
    expect(long.name).toBe(`Extension ${"n".repeat(65)}`);
  });

  it("a key that yields mhjfbmdgcfjbbpaeojofohoefgiehjai is refused", async () => {
    expect(idFromKeyBase64(PDF_VIEWER_KEY)).toBe(PDF_VIEWER_EXTENSION_ID);
    expect(
      refusal(() => checkManifest({ ...BASE, key: PDF_VIEWER_KEY }, CONTEXT)),
    ).toBe(extensionRefusalCopy.component);
    expect(
      await refused(
        readManifest(
          folderWith({ "manifest.json": { ...BASE, key: PDF_VIEWER_KEY } }),
          CONTEXT,
        ),
      ),
    ).toBe(extensionRefusalCopy.component);
    const key = publicKey();
    const checked = await readManifest(
      folderWith({ "manifest.json": { ...BASE, key: key.toString("base64") } }),
      CONTEXT,
    );
    expect(checked.keyId).toBe(idFromKey(key));
    expect(checked.keyId).toMatch(/^[a-p]{32}$/);
    expect(
      (await readManifest(folderWith({ "manifest.json": BASE }), CONTEXT))
        .keyId,
    ).toBeUndefined();
  });

  it("permission lines for <all_urls>, 2 hosts, 5 hosts and tabs", async () => {
    const hosts = ["a", "b", "c", "d", "e"].map(
      (name) => `https://${name}.example/*`,
    );
    expect(permissionLines({ permissions: [], hosts: ["<all_urls>"] })).toEqual(
      ["Read and change all your data on all websites"],
    );
    expect(
      permissionLines({ permissions: [], hosts: hosts.slice(0, 2) }),
    ).toEqual(["Read and change your data on a.example and b.example"]);
    expect(permissionLines({ permissions: [], hosts })).toEqual([
      "Read and change your data on a.example, b.example, c.example and 2 other sites",
    ]);
    expect(permissionLines({ permissions: ["tabs"], hosts: [] })).toEqual([
      "Read your browsing history",
    ]);
    expect(
      permissionLines({ permissions: [], hosts: hosts.slice(0, 1) }),
    ).toEqual(["Read and change your data on a.example"]);
    expect(
      permissionLines({ permissions: [], hosts: hosts.slice(0, 3) }),
    ).toEqual([
      "Read and change your data on a.example, b.example and c.example",
    ]);
    expect(
      permissionLines({ permissions: [], hosts: hosts.slice(0, 4) }),
    ).toEqual([
      "Read and change your data on a.example, b.example, c.example and 1 other site",
    ]);
    // Subdomain patterns show their domain once; file patterns and invalid
    // patterns show nothing.
    expect(
      permissionLines({
        permissions: [
          "geolocation",
          "storage",
          "clipboardWrite",
          "tabs",
          "clipboardRead",
        ],
        hosts: [
          "*://*.a.example/*",
          "https://a.example/x",
          "file:///*",
          "https://b*.example/*",
          "http://localhost:8080/*",
        ],
      }),
    ).toEqual([
      "Read and change your data on a.example and localhost",
      "Read your browsing history",
      "Read data you copy and paste",
      "Change data you copy and paste",
      "Know your physical location",
    ]);
    expect(
      permissionLines({
        permissions: ["tabs"],
        hosts: ["https://a.example/*", "*://*/*"],
      }),
    ).toEqual([
      "Read and change all your data on all websites",
      "Read your browsing history",
    ]);
    expect(
      permissionLines({ permissions: ["storage"], hosts: ["file:///*"] }),
    ).toEqual([]);

    const manifest = {
      ...BASE,
      permissions: [
        "tabs",
        "storage",
        "https://ignored.example/*",
        "<all_urls>",
        5,
        "tabs",
      ],
      host_permissions: ["https://a.example/*", 7],
      content_scripts: [
        { matches: ["https://b.example/*", "https://a.example/*"] },
        null,
        { matches: "x" },
      ],
    };
    expect(permissionsOf(manifest)).toEqual(["tabs", "storage"]);
    expect(hostsOf(manifest)).toEqual([
      "https://a.example/*",
      "https://b.example/*",
    ]);
    const checked = await readManifest(
      folderWith({ "manifest.json": manifest }),
      CONTEXT,
    );
    expect(checked.lines).toEqual([
      "Read and change your data on a.example and b.example",
      "Read your browsing history",
    ]);
    expect(checked).toMatchObject({
      permissions: ["tabs", "storage"],
      hosts: ["https://a.example/*", "https://b.example/*"],
    });
  });

  it("won't work names", async () => {
    const manifest = {
      ...BASE,
      permissions: [
        "storage",
        "declarativeNetRequest",
        "notifications",
        "declarativeNetRequestWithHostAccess",
        "nativeMessaging",
        "declarativeNetRequestFeedback",
        "identity",
        "tabs",
        "cookies",
        "downloads",
        "sidePanel",
        "fileBrowserHandler",
        "https://example.com/*",
      ],
      commands: {},
      side_panel: {},
      declarative_net_request: {},
    };
    const names = [
      "Blocking content with rules",
      "Notifications",
      "Talking to apps on your computer",
      "Signing in with Google",
      "Reading and changing cookies",
      "Managing downloads",
      "The side panel",
      "File browser handler",
      "Keyboard shortcuts",
    ];
    expect(wontWorkNames(manifest)).toEqual(names);
    expect(
      (await readManifest(folderWith({ "manifest.json": manifest }), CONTEXT))
        .wontWork,
    ).toEqual(names);
    expect(
      wontWorkNames({
        ...BASE,
        permissions: [
          "activeTab",
          "clipboardRead",
          "clipboardWrite",
          "geolocation",
          "scripting",
          "storage",
          "tabs",
          "unlimitedStorage",
          "webRequest",
        ],
        host_permissions: ["<all_urls>"],
      }),
    ).toEqual([]);
    expect(
      wontWorkNames({
        ...BASE,
        omnibox: {},
        commands: {},
        permissions: ["system.cpu", "system.memory", "constructor"],
      }),
    ).toEqual([
      "System information",
      "Constructor",
      "Address bar keywords",
      "Keyboard shortcuts",
    ]);
    expect(plainName("enterprise.platformKeys")).toBe(
      "Enterprise platform keys",
    );
    // Declared names come from the extension, so they are cleaned and capped.
    expect(
      wontWorkNames({
        ...BASE,
        permissions: ["\u202EoddName\n", "aB".repeat(60)],
      }),
    ).toEqual(["Odd name", `A${" ba".repeat(24)} b`]);
  });

  it("storeItemId", () => {
    for (const input of [
      `https://chromewebstore.google.com/detail/ublock-origin-lite/${STORE_ID}`,
      `https://chromewebstore.google.com/detail/${STORE_ID}`,
      `https://chromewebstore.google.com/detail/ublock-origin-lite/${STORE_ID}?hl=en`,
      `https://chromewebstore.google.com/detail/ublock-origin-lite/${STORE_ID}#reviews`,
      `https://chromewebstore.google.com/detail/ublock-origin-lite/${STORE_ID}/reviews`,
      `  https://chromewebstore.google.com/detail/${STORE_ID}  `,
      `  ${STORE_ID}\n`,
    ])
      expect(storeItemId(input)).toBe(STORE_ID);
    for (const input of [
      `http://chromewebstore.google.com/detail/ublock-origin-lite/${STORE_ID}`,
      `https://chrome.google.com/webstore/detail/ublock-origin-lite/${STORE_ID}`,
      `https://chromewebstore.google.com.example/detail/${STORE_ID}`,
      `https://chromewebstore.google.com/detail/${STORE_ID.toUpperCase()}`,
      STORE_ID.toUpperCase(),
      STORE_ID.slice(1),
      `${STORE_ID}a`,
      `https://chromewebstore.google.com/detail/${STORE_ID}a`,
      "",
    ])
      expect(storeItemId(input)).toBeUndefined();
    expect(
      storeDetailId(
        `https://chromewebstore.google.com/detail/name/${STORE_ID}?hl=en`,
      ),
    ).toBe(STORE_ID);
    expect(storeDetailId(STORE_ID)).toBeUndefined();
  });

  it("key injection", async () => {
    const key = publicKey();
    const original = {
      manifest_version: 3,
      name: "Store item",
      version: "2.0",
      permissions: ["tabs"],
      nested: { list: [1, 2], text: "\u00E9" },
    };
    const folder = folderWith({
      "manifest.json": `\uFEFF${JSON.stringify(original)}`,
    });
    await injectKey(folder, key);
    const text = readFileSync(join(folder, "manifest.json"), "utf8");
    const expected = { ...original, key: key.toString("base64") };
    expect(text).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(idFromKeyBase64(JSON.parse(text).key)).toBe(idFromKey(key));
    expect(readdirSync(folder)).toEqual(["manifest.json"]);
    // The verified key replaces any key the archive carried.
    const other = publicKey();
    await injectKey(folder, other);
    expect(
      JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")).key,
    ).toBe(other.toString("base64"));
    expect((await readManifest(folder, CONTEXT)).keyId).toBe(idFromKey(other));
  });

  it("raises permissions only for new lines or uncovered hosts", () => {
    const granted = {
      permissions: ["storage"],
      hosts: ["*://*.example.com/*", "https://other.example/*"],
    };
    expect(
      raisesPermissions(granted, {
        ...granted,
        permissions: ["storage", "tabs"],
      }),
    ).toBe(true);
    expect(
      raisesPermissions(granted, {
        ...granted,
        permissions: ["storage", "unlimitedStorage", "notifications"],
      }),
    ).toBe(false);
    expect(
      raisesPermissions(granted, {
        permissions: [],
        hosts: ["https://mail.example.com/*"],
      }),
    ).toBe(false);
    expect(
      raisesPermissions(granted, {
        permissions: [],
        hosts: ["https://example.com/*", "*://*.mail.example.com/*"],
      }),
    ).toBe(false);
    expect(
      raisesPermissions(granted, {
        permissions: [],
        hosts: ["https://new.example/*"],
      }),
    ).toBe(true);
    expect(
      raisesPermissions(granted, { permissions: [], hosts: ["<all_urls>"] }),
    ).toBe(true);
    // The same pattern, or another pattern for the same shown host.
    expect(
      raisesPermissions(granted, {
        permissions: [],
        hosts: ["https://other.example/*", "http://other.example/path"],
      }),
    ).toBe(false);
    expect(
      raisesPermissions(
        { permissions: [], hosts: ["https://mail.example.com/*"] },
        { permissions: [], hosts: ["*://*.example.com/*"] },
      ),
    ).toBe(true);
    const everything = { permissions: ["tabs"], hosts: ["<all_urls>"] };
    expect(
      raisesPermissions(everything, {
        permissions: ["tabs"],
        hosts: ["https://mail.example.com/*", "*://*/*"],
      }),
    ).toBe(false);
    expect(
      raisesPermissions(
        { permissions: [], hosts: ["*://*/*"] },
        { permissions: [], hosts: ["<all_urls>"] },
      ),
    ).toBe(false);
  });

  it("match patterns and title globs", () => {
    const cases: [string, string, boolean][] = [
      ["<all_urls>", "https://a.example/x", true],
      ["<all_urls>", "http://127.0.0.1:8080/", true],
      ["<all_urls>", "file:///etc/passwd", false],
      ["<all_urls>", `chrome-extension://${STORE_ID}/popup.html`, false],
      ["<all_urls>", "ftp://a.example/", false],
      ["<all_urls>", "about:blank", false],
      ["<all_urls>", "not a url", false],
      ["*://*/*", "https://a.example/x?y", true],
      ["*://*/*", "http://localhost:3000/", true],
      ["*://*/*", "file:///etc/passwd", false],
      ["https://*.example.com/*", "https://example.com/", true],
      ["https://*.example.com/*", "https://mail.example.com/inbox?q=1", true],
      ["https://*.example.com/*", "http://mail.example.com/", false],
      ["https://*.example.com/*", "https://example.com.evil.test/", false],
      ["https://*.example.com/*", "https://notexample.com/", false],
      ["http://localhost:8080/*", "http://localhost:8080/a", true],
      ["http://localhost:8080/*", "http://localhost:8081/a", false],
      ["http://localhost:8080/*", "http://localhost/a", false],
      ["http://127.0.0.1/*", "http://127.0.0.1:43210/page", true],
      ["https://example.com:443/*", "https://example.com/", true],
      ["http://localhost:*/*", "http://localhost:9/", true],
      ["https://EXAMPLE.com/foo*", "https://example.com/foo/bar", true],
      ["https://example.com/foo*", "https://example.com/foo?x=1", true],
      ["https://example.com/foo*", "https://example.com/bar", false],
      ["https://example.com/", "https://example.com/?q", false],
      ["https://exa*mple.com/*", "https://example.com/", false],
      ["https://example.com", "https://example.com/", false],
      ["example.com/*", "https://example.com/", false],
      ["file:///*", "file:///etc/passwd", false],
      ["https://example.com#x/*", "https://example.com/", false],
      ["https://a@example.com/*", "https://example.com/", false],
    ];
    for (const [pattern, url, expected] of cases)
      expect([pattern, url, matchesPattern(pattern, url)]).toEqual([
        pattern,
        url,
        expected,
      ]);
    expect(
      ["<all_urls>", "*://*/*", "https://*/*", "http://*:8080/*"].every(
        coversAllHosts,
      ),
    ).toBe(true);
    expect(
      ["https://*.example.com/*", "file:///*", "https://*.*/*", "nope"].some(
        coversAllHosts,
      ),
    ).toBe(false);
    expect(patternHost("*://*.example.com/*")).toBe("example.com");
    expect(patternHost("http://localhost:8080/*")).toBe("localhost");
    expect(patternHost("https://B\u00FCcher.example/*")).toBe(
      "xn--bcher-kva.example",
    );
    expect(patternHost("<all_urls>")).toBeUndefined();
    expect(patternHost("file:///*")).toBeUndefined();
    expect(patternHost("https://\u202Eevil.example/*")).toBeUndefined();

    expect(globMatch("Inbox*", "Inbox (3)")).toBe(true);
    expect(globMatch("inbox*", "Inbox (3)")).toBe(false);
    expect(globMatch("In?ox", "Inbox")).toBe(true);
    expect(globMatch("*", "")).toBe(true);
    expect(globMatch("a*b*c", "aXXbYYc")).toBe(true);
    expect(globMatch("a*b*c", "aXXbYY")).toBe(false);
    expect(globMatch("?", "\u{1F600}")).toBe(true);
    const started = Date.now();
    expect(globMatch(`${"*a".repeat(40)}b`, "a".repeat(20000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("versions, extension URLs, labels, cleaned text and space rules", () => {
    for (const value of ["1", "1.0", "1.2.3.4", "65535.0"])
      expect(isVersion(value)).toBe(true);
    for (const value of [
      "",
      "1.",
      ".1",
      "1.2.3.4.5",
      "65536",
      "1.a",
      " 1",
      1,
      null,
    ])
      expect(isVersion(value)).toBe(false);
    expect(compareVersions("1.0", "1")).toBe(0);
    expect(compareVersions("1.2", "1.10")).toBeLessThan(0);
    expect(compareVersions("153", "152.0.7977.76")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0.1", "2")).toBeGreaterThan(0);

    expect(extensionIdOf(`chrome-extension://${STORE_ID}/popup.html`)).toBe(
      STORE_ID,
    );
    expect(extensionIdOf(`chrome-extension://${STORE_ID}`)).toBe(STORE_ID);
    expect(extensionIdOf(`chrome-extension://${STORE_ID}?x`)).toBe(STORE_ID);
    expect(
      extensionIdOf(`chrome-extension://${PDF_VIEWER_EXTENSION_ID}/index.html`),
    ).toBe(PDF_VIEWER_EXTENSION_ID);
    expect(extensionIdOf(`chrome-extension://${STORE_ID}a/`)).toBeUndefined();
    expect(extensionIdOf(`https://${STORE_ID}/`)).toBeUndefined();
    expect(extensionLabel("Marker")).toBe("Extension: Marker");
    expect(cleanExtensionText(" Bad\u202E\nname ", 75)).toBe("Bad name");
    expect(cleanExtensionText("ab cd", 3)).toBe("ab");
    expect(cleanExtensionText("\u{1F600}\u{1F600}\u{1F600}", 2)).toBe(
      "\u{1F600}\u{1F600}",
    );
    expect(cleanExtensionText(5, 75)).toBe("");

    expect(agentHeld({ kind: "agent", owner: "agent" })).toBe(true);
    expect(agentHeld({ kind: "agent", owner: "human" })).toBe(false);
    expect(
      agentHeld({ kind: "personal", owner: "human", access: "granted" }),
    ).toBe(true);
    expect(
      agentHeld({ kind: "personal", owner: "human", access: "ended" }),
    ).toBe(false);
    expect(agentHeld({ kind: "personal", owner: "human" })).toBe(false);
    expect(runsExtensions({ kind: "agent", signIns: "separate" })).toBe(false);
    expect(runsExtensions({ kind: "agent", signIns: "shared" })).toBe(true);
    expect(runsExtensions({ kind: "personal", signIns: "separate" })).toBe(
      true,
    );

    expect(extensionPermission(["clipboardRead"], "clipboard-read")).toBe(true);
    expect(
      extensionPermission(["clipboardWrite"], "clipboard-sanitized-write"),
    ).toBe(true);
    expect(extensionPermission(["geolocation"], "geolocation")).toBe(true);
    expect(extensionPermission(["clipboardWrite"], "clipboard-read")).toBe(
      false,
    );
    expect(
      extensionPermission(["notifications", "media"], "notifications"),
    ).toBe(false);
    expect(extensionPermission(["toString"], "toString")).toBe(false);
  });

  it("reads the toolbar action, options page, worker and icons", async () => {
    const checked = await readManifest(
      folderWith({
        "manifest.json": {
          ...BASE,
          action: { default_popup: "popup.html", default_icon: "icon.png" },
          options_ui: { page: "options.html" },
          options_page: "old-options.html",
          background: { service_worker: "worker.js" },
          icons: {
            "16": "16.png",
            "128": "128.png",
            big: "x.png",
            "0": "0.png",
            "32": 5,
          },
        },
      }),
      CONTEXT,
    );
    expect(checked).toMatchObject({
      name: "Example",
      version: "1.0.0",
      popup: "popup.html",
      options: "options.html",
      worker: "worker.js",
      icons: { 16: "16.png", 128: "128.png" },
      actionIcons: { 16: "icon.png" },
    });
    expect(checked.actionTitle).toBeUndefined();
    expect(Object.keys(checked.icons)).toEqual(["16", "128"]);
    const other = await readManifest(
      folderWith({
        "manifest.json": {
          ...BASE,
          action: {
            default_icon: { "19": "19.png", "38": "38.png" },
            default_title: " ",
          },
          options_page: "old-options.html",
        },
      }),
      CONTEXT,
    );
    expect(other.actionIcons).toEqual({ 19: "19.png", 38: "38.png" });
    expect(other.options).toBe("old-options.html");
    expect(other.actionTitle).toBeUndefined();
    expect(other.popup).toBeUndefined();
    expect(other.worker).toBeUndefined();
    expect(other.icons).toEqual({});
  });
});
