import {
  NAME_LIMIT,
  cleanExtensionText,
  extensionIdOf,
  isComponentExtension,
} from "../../shared/extensions";
import type { TabSession } from "./session/tab-session";
import type { Step } from "./session/types";

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

/** What the frame registry is asked for: the tab's frames, blocked ones included. */
type FrameReader = Pick<TabSession, "knownFrames" | "frames">;

/**
 * The URL each blocked frame of a tab committed, by the path section 9 gives
 * it. Only the registry holds that URL, and only frames whose owner can be
 * read have a path, so a frame inside a blocked one is not listed.
 */
export async function blockedFrameUrls(
  session: FrameReader,
  step: Step,
): Promise<ReadonlyMap<string, string>> {
  const urls = new Map<string, string>();
  for (const frame of await session.frames(step))
    if (frame.blocked === true) urls.set(frame.path, frame.url);
  return urls;
}

/**
 * The blocked frame around a frame, with the path and URL agents are told
 * about: the outermost one, since the page shows that frame and nothing
 * inside it has a path of its own.
 */
export async function blockedFrameOf(
  session: FrameReader,
  frameId: string,
  step: Step,
): Promise<{ path: string; url: string } | undefined> {
  const known = await session.knownFrames(step);
  const byId = new Map(known.map((frame) => [frame.frameId, frame]));
  let outer: string | undefined;
  for (
    let at = byId.get(frameId);
    at;
    at = at.parentFrameId === undefined ? undefined : byId.get(at.parentFrameId)
  )
    if (at.blocked) outer = at.frameId;
  if (outer === undefined) return undefined;
  const frame = (await session.frames(step)).find(
    (entry) => entry.frameId === outer,
  );
  return frame && { path: frame.path, url: frame.url };
}
