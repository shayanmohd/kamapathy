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
  type ExtensionImportProgress,
  type ExtensionsView,
} from "../../shared/extensions";
import { extensionInstallCopy, extensionRemoveCopy } from "../../src/copy";
import { SHARED_PARTITION, type BrowserController } from "../controller";
import type { ExtensionBridge } from "./bridge";
import type { ExtensionHost } from "./host";
import { InstallError, type ExtensionInstaller } from "./install";
import type { ExtensionUpdates } from "./updates";
import { extensionsView } from "./view";

export const EXTENSIONS_CHANNEL = "kamapathy:extensions";
export const EXTENSIONS_CHANGED = "kamapathy:extensions-changed";
export const EXTENSION_COMMAND = "kamapathy:extension-command";

// The longest store link the field takes.
const INPUT_LIMIT = 2048;
// Shell pixels a button can sit at.
const ANCHOR_MIN = -10_000;
const ANCHOR_MAX = 100_000;

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

  return {
    push,
    setImports(rows) {
      imports = rows;
      push();
    },
    dispose() {
      if (pending) clearTimeout(pending);
      pending = undefined;
    },
  };
}
