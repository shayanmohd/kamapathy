import {
  cleanExtensionText,
  NAME_LIMIT,
  type ExtensionAction,
  type ExtensionImportProgress,
  type ExtensionRow,
  type ExtensionsView,
} from "../../shared/extensions";
import type { ExtensionHost } from "./host";
import type { ExtensionInstaller } from "./install";
import type { ExtensionUpdates } from "./updates";

export interface ViewSources {
  host: ExtensionHost;
  installer: ExtensionInstaller;
  updates: ExtensionUpdates;
  toolbar: { actions: ExtensionAction[]; disabled?: "isolated" | "agent" };
  imports: ExtensionImportProgress[];
}

// Everything the Extensions modal and the toolbar show, in extensions.json
// order. Extension names reach the shell cleaned, like agent text.
export function extensionsView(sources: ViewSources): ExtensionsView {
  const { host, updates } = sources;
  const rows = host.entries().map((entry): ExtensionRow => {
    const manifest = host.manifestOf(entry.id);
    const icon = host.iconOf(entry.id);
    const update = updates.state(entry.id);
    const error = host.loadError(entry.id);
    return {
      id: entry.id,
      name: cleanExtensionText(manifest?.name ?? entry.id, NAME_LIMIT),
      version: entry.version,
      source: entry.source,
      ...(entry.importedFrom ? { importedFrom: entry.importedFrom } : {}),
      enabled: entry.enabled,
      pinned: entry.pinned,
      ...(icon ? { icon } : {}),
      lines: manifest?.lines ?? [],
      wontWork: manifest?.wontWork ?? [],
      hasOptions: Boolean(manifest?.options),
      ...(update ? { update } : {}),
      ...(error ? { error } : {}),
      ...(entry.source === "unpacked" && !host.developerMode
        ? { needsDeveloperMode: true as const }
        : {}),
    };
  });
  return {
    rows,
    actions: sources.toolbar.actions,
    ...(sources.toolbar.disabled ? { disabled: sources.toolbar.disabled } : {}),
    installing: sources.installer.installing(),
    imports: sources.imports,
  };
}
