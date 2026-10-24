import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  cleanExtensionText,
  isComponentExtension,
  isExtensionId,
  NAME_LIMIT,
  storeItemId,
  type ExtensionAnchor,
  type ExtensionCommand,
  type ExtensionCommandResult,
  type ExtensionImportList,
  type ExtensionImportProgress,
  type ExtensionImportRequest,
  type ExtensionImportResult,
  type ExtensionsView,
} from "../../shared/extensions";
import type { ImportSelection } from "../../shared/types";
import {
  extensionInstallCopy,
  extensionRemoveCopy,
  importCopy,
} from "../../src/copy";
import { SHARED_PARTITION, type BrowserController } from "../controller";
import { isChromiumFamily, type BrowserId, type ImportEnv } from "../import";
import type { ExtensionBridge } from "./bridge";
import type { ExtensionHost } from "./host";
import {
  extensionCandidates,
  importExtensions,
  type ExtensionImportContext,
} from "./import";
import { InstallError, type ExtensionInstaller } from "./install";
import type { ExtensionUpdates } from "./updates";
import { extensionsView } from "./view";

export const EXTENSIONS_CHANNEL = "kamapathy:extensions";
export const EXTENSIONS_CHANGED = "kamapathy:extensions-changed";
export const EXTENSION_COMMAND = "kamapathy:extension-command";
export const EXTENSION_IMPORT_CANDIDATES =
  "kamapathy:extension-import-candidates";
export const IMPORT_EXTENSIONS = "kamapathy:import-extensions";

// The longest store link the field takes.
const INPUT_LIMIT = 2048;
// Shell pixels a button can sit at.
const ANCHOR_MIN = -10_000;
const ANCHOR_MAX = 100_000;
// A profile folder's name, and how many extensions one import may name.
const PROFILE_LIMIT = 255;
const IDS_LIMIT = 100;

function invalid(): never {
  throw new Error("Invalid extension command.");
}
// Exactly these keys, nothing else.
function fields(record: Record<string, unknown>, names: string[]): void {
  const wanted = new Set(names);
  for (const key of Object.keys(record)) if (!wanted.has(key)) invalid();
  for (const name of names) if (!(name in record)) invalid();
}
function idOf(value: unknown): string {
  if (!isExtensionId(value) || isComponentExtension(value)) invalid();
  return value;
}
function flagOf(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}
function anchorOf(value: unknown): ExtensionAnchor {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  fields(record, ["x", "y", "width", "height"]);
  const number = (name: string): number => {
    const found = record[name];
    if (
      typeof found !== "number" ||
      !Number.isFinite(found) ||
      found < ANCHOR_MIN ||
      found > ANCHOR_MAX
    )
      invalid();
    return found;
  };
  return {
    x: number("x"),
    y: number("y"),
    width: number("width"),
    height: number("height"),
  };
}

// Nothing but the shell's own commands, in the exact shape the view sends.
export function parseExtensionCommand(value: unknown): ExtensionCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "install": {
      fields(record, ["type", "input"]);
      const input = record.input;
      if (typeof input !== "string" || input.length > INPUT_LIMIT) invalid();
      return { type: "install", input };
    }
    case "load-unpacked":
      fields(record, ["type"]);
      return { type: "load-unpacked" };
    case "reload":
      fields(record, ["type", "id"]);
      return { type: "reload", id: idOf(record.id) };
    case "enable":
      fields(record, ["type", "id", "enabled"]);
      return {
        type: "enable",
        id: idOf(record.id),
        enabled: flagOf(record.enabled),
      };
    case "pin":
      fields(record, ["type", "id", "pinned"]);
      return {
        type: "pin",
        id: idOf(record.id),
        pinned: flagOf(record.pinned),
      };
    case "remove":
      fields(record, ["type", "id"]);
      return { type: "remove", id: idOf(record.id) };
    case "options":
      fields(record, ["type", "id"]);
      return { type: "options", id: idOf(record.id) };
    case "review":
      fields(record, ["type", "id"]);
      return { type: "review", id: idOf(record.id) };
    case "click":
      fields(record, ["type", "id", "anchor"]);
      return {
        type: "click",
        id: idOf(record.id),
        anchor: anchorOf(record.anchor),
      };
    case "anchors": {
      fields(record, ["type", "buttons", "puzzle"]);
      const { buttons, puzzle } = record;
      if (!buttons || typeof buttons !== "object" || Array.isArray(buttons))
        invalid();
      const anchors: Record<string, ExtensionAnchor> = {};
      for (const [id, anchor] of Object.entries(
        buttons as Record<string, unknown>,
      ))
        anchors[idOf(id)] = anchorOf(anchor);
      return {
        type: "anchors",
        buttons: anchors,
        puzzle: puzzle === null ? null : anchorOf(puzzle),
      };
    }
    default:
      return invalid();
  }
}

function invalidImport(): never {
  throw new Error(importCopy.errors.import_invalid_request);
}
function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalidImport();
  return value as Record<string, unknown>;
}
// These keys, and no others; profile may be left out.
function onlyFields(record: Record<string, unknown>, names: string[]): void {
  for (const key of Object.keys(record))
    if (!names.includes(key)) invalidImport();
}
// Only the browsers whose extensions Kamapathy can read.
function sourceOf(value: unknown): string {
  if (typeof value !== "string" || !isChromiumFamily(value as BrowserId))
    invalidImport();
  return value;
}
function profileOf(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > PROFILE_LIMIT)
    invalidImport();
  return value;
}
export function parseImportSelection(value: unknown): ImportSelection {
  const record = recordOf(value);
  onlyFields(record, ["source", "profile"]);
  const profile = profileOf(record.profile);
  return {
    source: sourceOf(record.source),
    ...(profile === undefined ? {} : { profile }),
  };
}
export function parseExtensionImportRequest(
  value: unknown,
): ExtensionImportRequest {
  const record = recordOf(value);
  onlyFields(record, ["source", "profile", "ids"]);
  const ids = record.ids;
  if (!Array.isArray(ids) || ids.length > IDS_LIMIT) invalidImport();
  for (const id of ids)
    if (!isExtensionId(id) || isComponentExtension(id)) invalidImport();
  const profile = profileOf(record.profile);
  return {
    source: sourceOf(record.source),
    ...(profile === undefined ? {} : { profile }),
    ids: ids as string[],
  };
}

export interface ExtensionIpcDeps {
  ipc: Pick<IpcMain, "handle">;
  validateSender(event: IpcMainInvokeEvent): BrowserController;
  window(): BrowserWindow | null;
  controller(): BrowserController | null;
  host: ExtensionHost;
  installer: ExtensionInstaller;
  updates: ExtensionUpdates;
  bridge: ExtensionBridge;
  confirmRemove(name: string): Promise<boolean>;
  confirmImport(browser: string, count: number): Promise<boolean>;
  // app.getLocale() and process.versions.chrome, for reading manifests.
  locale: string;
  chromeVersion: string;
  // Where the other browsers keep their data; this computer unless a test
  // says otherwise.
  env?: ImportEnv;
}
export interface ExtensionIpc {
  push(): void;
  setImports(rows: ExtensionImportProgress[]): void;
  dispose(): void;
}

// The shell's only way to the person's extensions: the view it draws and the
// commands its buttons send, both behind the sender check.
export function registerExtensionIpc(deps: ExtensionIpcDeps): ExtensionIpc {
  let imports: ExtensionImportProgress[] = [];
  let pending: ReturnType<typeof setTimeout> | undefined;
  // One import at a time, as in section 15's panel.
  let importing = false;

  function view(): ExtensionsView {
    const controller = deps.controller();
    return extensionsView({
      host: deps.host,
      installer: deps.installer,
      updates: deps.updates,
      toolbar: controller
        ? deps.bridge.toolbar(controller.state)
        : { actions: [] },
      imports,
    });
  }
  function send(): void {
    pending = undefined;
    const window = deps.window();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(EXTENSIONS_CHANGED, view());
  }
  function push(): void {
    pending ??= setTimeout(send, 0);
  }
  function setImports(rows: ExtensionImportProgress[]): void {
    imports = rows;
    push();
  }
  // Developer mode is the person's setting, never the shell's claim.
  function importContext(
    controller: BrowserController,
  ): ExtensionImportContext {
    return {
      host: deps.host,
      developerMode: controller.state.settings.extensionDeveloperMode,
      chromeVersion: deps.chromeVersion,
      locale: deps.locale,
      ...(deps.env ? { env: deps.env } : {}),
    };
  }
  // The space the person is looking at, when it runs extensions: where an
  // options page opens.
  function partitionFor(controller: BrowserController): string {
    const space = controller.state.spaces.find(
      (item) => item.id === controller.state.activeSpaceId,
    );
    const partition = space ? controller.partitionOf(space.id) : undefined;
    return partition && deps.host.partitions().includes(partition)
      ? partition
      : SHARED_PARTITION;
  }

  deps.ipc.handle(EXTENSIONS_CHANNEL, (event) => {
    deps.validateSender(event);
    return view();
  });
  deps.ipc.handle(
    EXTENSION_COMMAND,
    async (event, value: unknown): Promise<ExtensionCommandResult> => {
      const controller = deps.validateSender(event);
      const command = parseExtensionCommand(value);
      switch (command.type) {
        case "install": {
          const id = storeItemId(command.input);
          if (!id) throw new InstallError(extensionInstallCopy.invalidInput);
          const outcome = await deps.installer.installFromStore(id);
          return { ok: true, id: outcome.id, added: outcome.added };
        }
        case "load-unpacked": {
          if (!controller.state.settings.extensionDeveloperMode)
            throw new InstallError(extensionRemoveCopy.developerModeOff);
          const outcome = await deps.installer.loadUnpacked();
          return { ok: true, id: outcome.id, added: outcome.added };
        }
        case "reload":
          await deps.installer.reloadUnpacked(command.id);
          return { ok: true, id: command.id };
        case "enable":
          await deps.host.setEnabled(command.id, command.enabled);
          return { ok: true, id: command.id };
        case "pin":
          await deps.host.setPinned(command.id, command.pinned);
          return { ok: true, id: command.id };
        case "remove": {
          const name = cleanExtensionText(
            deps.host.nameOf(command.id) ?? command.id,
            NAME_LIMIT,
          );
          if (!(await deps.confirmRemove(name))) return { ok: true };
          await deps.host.remove(command.id);
          return { ok: true, id: command.id };
        }
        case "options":
          deps.bridge.openOptionsPage(
            command.id,
            partitionFor(controller),
            true,
          );
          return { ok: true, id: command.id };
        case "review":
          await deps.updates.review(command.id);
          return { ok: true, id: command.id };
        case "click":
          await deps.bridge.click(command.id, command.anchor);
          return { ok: true, id: command.id };
        case "anchors":
          deps.bridge.setAnchors(command.buttons, command.puzzle);
          return { ok: true };
      }
    },
  );

  deps.ipc.handle(
    EXTENSION_IMPORT_CANDIDATES,
    async (event, value: unknown): Promise<ExtensionImportList> => {
      const controller = deps.validateSender(event);
      const selection = parseImportSelection(value);
      const { list } = await extensionCandidates(
        selection.source as BrowserId,
        selection.profile,
        importContext(controller),
      );
      return list;
    },
  );
  deps.ipc.handle(
    IMPORT_EXTENSIONS,
    async (event, value: unknown): Promise<ExtensionImportResult> => {
      const controller = deps.validateSender(event);
      const request = parseExtensionImportRequest(value);
      if (importing) throw new Error(importCopy.errors.import_busy);
      importing = true;
      try {
        return await importExtensions(request, {
          ...importContext(controller),
          installer: deps.installer,
          confirm: deps.confirmImport,
          progress: setImports,
        });
      } finally {
        importing = false;
        setImports([]);
      }
    },
  );

  return {
    push,
    setImports,
    dispose() {
      if (pending) clearTimeout(pending);
      pending = undefined;
    },
  };
}
