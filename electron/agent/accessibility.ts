import {
  EDITABLE_ROLES,
  axRoleValues,
  normalizeText,
  type NameMatch,
} from "./selectors";
import type { TabSession } from "./session/tab-session";
import type { KnownFrame, Step } from "./session/types";

// Chromium's computed roles and names, read per frame with
// Accessibility.getFullAXTree and filtered here. queryAXTree answers only
// after a frame's next rendering update, so it never answers in a frame
// that paints nothing, which is why every read filters the full tree.

/** Where a tree was read: a frame of a session, or that session's document. */
export interface AxSource {
  sessionId?: string;
  frameId?: string;
}
export interface AxEntry {
  source: AxSource;
  backendNodeId: number;
  role: string;
  name: string;
  /** A generic node Chromium reports as an editing host of its own. */
  editableRoot: boolean;
}
type AxValue = { value?: unknown };
type AxNode = {
  nodeId?: string;
  parentId?: string;
  ignored?: boolean;
  backendDOMNodeId?: number;
  role?: AxValue;
  name?: AxValue;
  properties?: { name?: string }[];
};
/** How long the enable and disable pair may take to release the state. */
export const AX_RESET_MS = 2000;

// The documents a role read covers: the top document, then each frame the
// main frame's world reads. A frame of another origin, one inside such a
// frame, a blocked or unavailable frame and a frame in its own process are
// never read, because their nodes could only be resolved into a world that
// must not reach them.
export function axSources(
  frames: readonly KnownFrame[],
  mainFrameId: string,
): AxSource[] {
  const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
  const sameOrigin = (frame: KnownFrame): boolean => {
    for (
      let current: KnownFrame | undefined = frame;
      current;
      current =
        current.parentFrameId === undefined
          ? undefined
          : byId.get(current.parentFrameId)
    ) {
      if (current.frameId === mainFrameId) return true;
      if (current.crossOrigin) return false;
    }
    return false;
  };
  const sources: AxSource[] = [{}];
  for (const frame of frames) {
    if (frame.frameId === mainFrameId) continue;
    if (frame.sessionId !== undefined || frame.blocked || frame.unavailable)
      continue;
    if (!sameOrigin(frame)) continue;
    sources.push({ frameId: frame.frameId });
  }
  return sources;
}

// Every named node of each source, with the roles lowercased. A frame whose
// read fails changed while it was read and is left out; the top document's
// failure ends the resolution.
export async function readAx(
  session: TabSession,
  sources: readonly AxSource[],
  step: Step,
): Promise<AxEntry[]> {
  const entries: AxEntry[] = [];
  for (const [index, source] of sources.entries()) {
    let nodes: AxNode[];
    try {
      const reply = await session.send<{ nodes?: AxNode[] }>(
        "Accessibility.getFullAXTree",
        source.frameId === undefined ? {} : { frameId: source.frameId },
        {
          sessionId: source.sessionId,
          deadline: step.deadline,
          signal: step.signal,
          guard: step.guard,
          timeoutMs: Math.max(1, step.deadline - Date.now()),
        },
      );
      nodes = reply.nodes ?? [];
    } catch (error) {
      if (index === 0) throw error;
      continue;
    }
    const byId = new Map<string, AxNode>();
    for (const node of nodes)
      if (node.nodeId !== undefined) byId.set(node.nodeId, node);
    for (const node of nodes) {
      // An ignored node is not the page's structure, and a node without a
      // DOM node of its own, such as an inline text box or a list marker,
      // cannot be resolved.
      if (node.ignored) continue;
      if (typeof node.backendDOMNodeId !== "number") continue;
      const role = String(node.role?.value ?? "").toLowerCase();
      const parent =
        node.parentId === undefined ? undefined : byId.get(node.parentId);
      entries.push({
        source,
        backendNodeId: node.backendDOMNodeId,
        role,
        name: typeof node.name?.value === "string" ? node.name.value : "",
        editableRoot:
          role === "generic" && editable(node) && !(parent && editable(parent)),
      });
    }
  }
  return entries;
}

// The entries a role word covers. A role that stands for an editing host
// also takes the generic nodes Chromium reports as one, marked so the page
// can check that the node really is an editing host.
export function matchRole(
  entries: readonly AxEntry[],
  role: string,
  name?: NameMatch,
): { entry: AxEntry; editable: boolean }[] {
  const values = new Set(
    axRoleValues(role).map((value) => value.toLowerCase()),
  );
  const editableRole = EDITABLE_ROLES.includes(role);
  const part =
    name?.match === "contains"
      ? normalizeText(name.value).toLowerCase()
      : undefined;
  const found: { entry: AxEntry; editable: boolean }[] = [];
  for (const entry of entries) {
    const named = values.has(entry.role);
    const asEditable = !named && editableRole && entry.editableRoot;
    if (!named && !asEditable) continue;
    if (name) {
      if (part === undefined) {
        // An exact name is Chromium's computed name as it stands, which
        // keeps U+00A0, U+00AD and U+200B.
        if (entry.name !== name.value) continue;
      } else if (!normalizeText(entry.name).toLowerCase().includes(part))
        continue;
    }
    found.push({ entry, editable: asEditable });
  }
  return found;
}

// Any accessibility query leaves Chromium's accessibility state alive in the
// renderer, which doubles the cost of DOM changes until it ends. Only this
// pair ends it; disable alone is a no-op when enable was never sent.
export async function resetAccessibility(
  session: TabSession,
  sessionIds: readonly (string | undefined)[],
): Promise<void> {
  await Promise.all(
    [...new Set(sessionIds)].map(async (sessionId) => {
      const at = { sessionId, deadline: Date.now() + AX_RESET_MS };
      try {
        await session.send("Accessibility.enable", {}, at);
        await session.send("Accessibility.disable", {}, at);
      } catch {
        // Tidying up after a page that is gone needs nothing.
      }
    }),
  );
}

const editable = (node: AxNode) =>
  (node.properties ?? []).some((property) => property.name === "editable");
