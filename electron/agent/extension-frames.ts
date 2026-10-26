import {
  NAME_LIMIT,
  cleanExtensionText,
  extensionIdOf,
  isComponentExtension,
} from "../../shared/extensions";

// Section 17's agent-facing rule, in one place: which frames belong to one of
// the person's extensions, what agents are told about them, and why input
// there is refused. Snapshots name such a frame, section 5 refuses input in
// it and section 8 keeps its contexts out of reach. Nothing here reads a page.

/** The person's loaded extensions, by id. ExtensionHost answers this. */
export interface ExtensionNames {
  nameOf(id: string): string | undefined;
}
/** No extensions at all: what the agent server runs with until main passes the host. */
export const NO_EXTENSION_NAMES: ExtensionNames = { nameOf: () => undefined };
/** An extension whose page a frame shows, with the name agents are given. */
export interface ExtensionFrame {
  id: string;
  name: string;
}

/**
 * The extension a frame belongs to, by the URL its document committed. Only
 * a page of an extension the person installed counts: Kamapathy's own
 * component extensions, and extensions that are not loaded here, stay plain
 * blocked frames.
 */
export function extensionFrame(
  url: string,
  names: ExtensionNames,
): ExtensionFrame | undefined {
  const id = extensionIdOf(url);
  if (id === undefined || isComponentExtension(id)) return undefined;
  const name = names.nameOf(id);
  if (name === undefined) return undefined;
  return { id, name: cleanExtensionText(name, NAME_LIMIT) };
}

/** Whether an origin belongs to any extension, Kamapathy's own included. */
export function extensionOrigin(origin: string | undefined): boolean {
  return (
    typeof origin === "string" &&
    origin.toLowerCase().startsWith("chrome-extension://")
  );
}

export function extensionInputMessage(name: string): string {
  return `This is part of the ${name} extension. Agents can't use extensions; ask the person to continue there.`;
}
