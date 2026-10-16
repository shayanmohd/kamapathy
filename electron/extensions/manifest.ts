import { createHash, createPublicKey } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_EXTENSIONS,
  NAME_LIMIT,
  TITLE_LIMIT,
  cleanExtensionText,
  compareVersions,
  hostsOf,
  isComponentExtension,
  isVersion,
  permissionLines,
  permissionsOf,
  wontWorkNames,
} from "../../shared/extensions";
import { extensionRefusalCopy } from "../../src/copy";

// Its message is the copy shown to the person.
export class ManifestRefusal extends Error {}

// Message names are lowercased: lookups ignore case, as in Chrome.
export type Messages = Record<string, { message?: unknown }>;
export interface ManifestContext {
  chromeVersion: string;
  locale: string;
  installed: number;
  replacing: boolean;
}
export interface CheckedManifest {
  manifest: Record<string, unknown>;
  name: string;
  version: string;
  permissions: string[];
  hosts: string[];
  lines: string[];
  wontWork: string[];
  // The id that manifest.key gives.
  keyId?: string;
  actionTitle?: string;
  // Paths inside the extension, as the manifest gives them.
  popup?: string;
  options?: string;
  worker?: string;
  icons: Record<number, string>;
  actionIcons: Record<number, string>;
}

function refuse(copy: string): never {
  throw new ManifestRefusal(copy);
}

// Chrome's extension id: the first 16 bytes of the key's SHA-256, each hex
// digit written as a letter from a to p.
export function idFromKey(spki: Buffer): string {
  return Array.from(
    createHash("sha256").update(spki).digest("hex").slice(0, 32),
    (digit) => String.fromCharCode(97 + parseInt(digit, 16)),
  ).join("");
}
export function idFromKeyBase64(key: string): string {
  if (
    !key ||
    !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(key)
  )
    refuse(extensionRefusalCopy.invalid);
  const spki = Buffer.from(key, "base64");
  try {
    createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch {
    refuse(extensionRefusalCopy.invalid);
  }
  return idFromKey(spki);
}
export function localize(text: string, messages: Messages | undefined): string {
  return text.replace(/__MSG_([\w@]+?)__/g, (_, name: string) => {
    const key = name.toLowerCase();
    const message =
      messages && Object.hasOwn(messages, key)
        ? messages[key]?.message
        : undefined;
    return typeof message === "string" ? message : "";
  });
}

// The checks, in the order of the spec's table.
export function checkManifest(
  manifest: Record<string, unknown>,
  context: Omit<ManifestContext, "locale">,
): void {
  if (manifest.manifest_version !== 3) refuse(extensionRefusalCopy.version);
  if (Object.hasOwn(manifest, "theme") || Object.hasOwn(manifest, "app"))
    refuse(extensionRefusalCopy.themeOrApp);
  const minimum = manifest.minimum_chrome_version;
  if (minimum !== undefined) {
    if (!isVersion(minimum)) refuse(extensionRefusalCopy.invalid);
    if (compareVersions(minimum, context.chromeVersion) > 0)
      refuse(extensionRefusalCopy.chrome);
  }
  if (manifest.key !== undefined) {
    if (typeof manifest.key !== "string") refuse(extensionRefusalCopy.invalid);
    if (isComponentExtension(idFromKeyBase64(manifest.key)))
      refuse(extensionRefusalCopy.component);
  }
  if (
    typeof manifest.name !== "string" ||
    !manifest.name.trim() ||
    !isVersion(manifest.version)
  )
    refuse(extensionRefusalCopy.invalid);
  if (context.installed >= MAX_EXTENSIONS && !context.replacing)
    refuse(extensionRefusalCopy.limit);
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function pathOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
function iconsOf(value: unknown): Record<number, string> {
  if (typeof value === "string") return value ? { 16: value } : {};
  const icons: Record<number, string> = {};
  for (const [size, path] of Object.entries(objectOf(value)))
    if (/^[1-9]\d{0,3}$/.test(size) && pathOf(path))
      icons[Number(size)] = path as string;
  return icons;
}
async function loadManifest(folder: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(join(folder, "manifest.json"), "utf8");
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR", "EISDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      refuse(extensionRefusalCopy.noManifest);
    throw error;
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    refuse(extensionRefusalCopy.invalid);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    refuse(extensionRefusalCopy.invalid);
  return manifest as Record<string, unknown>;
}
// The first catalog of the app's locale, its language and the extension's
// default locale.
async function messagesFor(
  folder: string,
  locale: string,
  fallback: unknown,
): Promise<Messages | undefined> {
  const wanted = locale.replace(/-/g, "_");
  for (const name of [wanted, wanted.split("_")[0], fallback]) {
    if (typeof name !== "string" || !/^[A-Za-z\d_]+$/.test(name)) continue;
    let text: string;
    try {
      text = await readFile(
        join(folder, "_locales", name, "messages.json"),
        "utf8",
      );
    } catch {
      continue;
    }
    try {
      return Object.fromEntries(
        Object.entries(objectOf(JSON.parse(text.replace(/^\uFEFF/, "")))).map(
          ([key, value]) => [key.toLowerCase(), value],
        ),
      ) as Messages;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function readManifest(
  folder: string,
  context: ManifestContext,
): Promise<CheckedManifest> {
  const manifest = await loadManifest(folder);
  checkManifest(manifest, context);
  const messages = await messagesFor(
    folder,
    context.locale,
    manifest.default_locale,
  );
  const name = cleanExtensionText(
    localize(manifest.name as string, messages),
    NAME_LIMIT,
  );
  if (!name) refuse(extensionRefusalCopy.invalid);
  const action = objectOf(manifest.action);
  const actionTitle =
    typeof action.default_title === "string"
      ? cleanExtensionText(
          localize(action.default_title, messages),
          TITLE_LIMIT,
        )
      : "";
  const popup = pathOf(action.default_popup);
  const options =
    pathOf(objectOf(manifest.options_ui).page) ?? pathOf(manifest.options_page);
  const worker = pathOf(objectOf(manifest.background).service_worker);
  const permissions = permissionsOf(manifest);
  const hosts = hostsOf(manifest);
  return {
    manifest,
    name,
    version: manifest.version as string,
    permissions,
    hosts,
    lines: permissionLines({ permissions, hosts }),
    wontWork: wontWorkNames(manifest),
    ...(typeof manifest.key === "string"
      ? { keyId: idFromKeyBase64(manifest.key) }
      : {}),
    ...(actionTitle ? { actionTitle } : {}),
    ...(popup ? { popup } : {}),
    ...(options ? { options } : {}),
    ...(worker ? { worker } : {}),
    icons: iconsOf(objectOf(manifest.icons)),
    actionIcons: iconsOf(action.default_icon),
  };
}

// Writes the verified developer key as "key", so Electron keeps the store id.
export async function injectKey(
  folder: string,
  publicKey: Buffer,
): Promise<void> {
  const manifest = await loadManifest(folder);
  manifest.key = publicKey.toString("base64");
  const path = join(folder, "manifest.json");
  await writeFile(`${path}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
  await rename(`${path}.tmp`, path);
}
