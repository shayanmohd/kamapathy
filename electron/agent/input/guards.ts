// Section 5's guards: agent input that would leave the page or open
// something native is refused before anything is sent. The checks read the
// page with the tab's own session, so a hit inside a closed shadow root or
// over a frame in its own process is seen.
//
// What a probe of Electron 44 (Chromium 152) in a hidden window showed,
// which shaped this file. DOM.getNodeForLocation takes whole coordinates
// only, since a fractional x or y answers "Invalid parameters", and answers
// "No node found at given location" for a point over nothing. It pierces
// closed shadow roots: a select and an iframe inside one were both
// reported. Over a frame in its own process it answers the owner element,
// whose DOM.describeNode names the frame it holds in frameId, and looks no
// further, so the check goes on inside that frame, on the frame's own
// session. With includeUserAgentShadowDOM the hit is the control's inner
// part, which carries none of the control's own attributes, so the author
// level decides the kind and the deeper hit is only asked for a date input,
// to tell its picker indicator from the fields that take typing.
import { fail, toApiError } from "../errors";
import {
  NO_EXTENSION_NAMES,
  blockedFrameOf,
  extensionFrame,
  extensionInputMessage,
  type ExtensionNames,
} from "../extension-frames";
import { TargetRefusedError } from "../session/errors";
import type { TabSession } from "../session/tab-session";
import type { KnownFrame, SendStep, Step } from "../session/types";
import { MODIFIER_BITS, type Chord } from "./keys";
import type { Button } from "./state";

export type PickerKind = "select" | "color" | "date";
/** The focused control the key guards read, with the frame it sits in. */
export interface FocusedControl {
  kind: string;
  blockedFrame?: true;
  /** A blocked frame's section 9 path and extension, when it is one of the person's. */
  frame?: string;
  extension?: string;
}
export interface HitNode {
  backendNodeId: number;
  // The frame the hit is checked for: the frame a frame owner holds, else
  // the frame the node sits in.
  frameId?: string;
  /** For a frame owner, the frame the owner element itself sits in. */
  around?: string;
  nodeName: string;
  attributes: Record<string, string>;
  editable: boolean;
}

// The key forms that open a focused control's picker. In the probe's hidden
// window no key opened a select's popup, as no press did either, so these
// stay as the spec names them: a shown window is the case they guard, and a
// native popup would hold the browser process while it is open.
export const PICKER_KEY_NAMES: readonly string[] = ["Space", "Enter", "F4"];
export const PICKER_ALT_KEYS: readonly string[] = ["ArrowUp", "ArrowDown"];
export const PICKER_MAC_KEYS: readonly string[] = ["ArrowUp", "ArrowDown"];

// The user agent's part that opens a date, time, month or week input's
// picker. In the probe a press on it opened the picker every time, and a
// press on the fields beside it opened nothing.
const PICKER_INDICATOR = "-webkit-calendar-picker-indicator";
const DATE_TYPES = ["date", "datetime-local", "month", "week", "time"];
const TEXT_TYPES = [
  "text",
  "search",
  "tel",
  "url",
  "email",
  "password",
  "number",
];
const PICKER_KINDS: readonly string[] = ["select", "color", "date"];

const refusesInput = (frame: KnownFrame) => frame.blocked || frame.unavailable;
// DOM.describeNode gives attributes as one flat list of names and values.
const attributesOf = (flat: readonly string[] = []) => {
  const attributes: Record<string, string> = {};
  for (let index = 0; index + 1 < flat.length; index += 2)
    attributes[flat[index].toLowerCase()] = flat[index + 1];
  return attributes;
};
const typeOf = (attributes: Record<string, string>) =>
  (attributes.type ?? "text").toLowerCase();
// What a primary selection would be pasted into. A hit inside an editing
// host answers for itself only, since the hit test names no ancestors.
const editableNode = (nodeName: string, attributes: Record<string, string>) => {
  const editing = attributes.contenteditable;
  if (editing !== undefined && editing !== "false") return true;
  if (nodeName === "textarea") return true;
  return nodeName === "input" && TEXT_TYPES.includes(typeOf(attributes));
};

// A read that failed says nothing about the point, and nor does one sent to
// a frame whose session ended after the registry was read. A refusal, or a
// page the agent lost, still stops here.
const passOn = (error: unknown) => {
  if (toApiError(error) && !(error instanceof TargetRefusedError)) throw error;
};

// The node under a point, through the tab's own session. Both commands are
// one-shot, so the DOM domain stays disabled.
export async function hitNodeAt(
  session: TabSession,
  point: { x: number; y: number },
  step: Step,
  options: { shadow?: boolean } = {},
): Promise<HitNode | undefined> {
  try {
    const hit = await session.send<{
      backendNodeId?: number;
      frameId?: string;
    }>(
      "DOM.getNodeForLocation",
      {
        x: Math.round(point.x),
        y: Math.round(point.y),
        includeUserAgentShadowDOM: options.shadow === true,
      },
      step,
    );
    if (typeof hit.backendNodeId !== "number") return undefined;
    const described = await session.send<{
      node?: { nodeName?: string; attributes?: string[]; frameId?: string };
    }>("DOM.describeNode", { backendNodeId: hit.backendNodeId }, step);
    const node = described.node;
    if (!node) return undefined;
    const nodeName = (node.nodeName ?? "").toLowerCase();
    const attributes = attributesOf(node.attributes);
    const frameId = node.frameId ?? hit.frameId;
    return {
      backendNodeId: hit.backendNodeId,
      ...(frameId === undefined ? {} : { frameId }),
      ...(node.frameId === undefined || hit.frameId === undefined
        ? {}
        : { around: hit.frameId }),
      nodeName,
      attributes,
      editable: editableNode(nodeName, attributes),
    };
  } catch (error) {
    // A hit test that failed says nothing about the point, so an ordinary
    // press is never refused for it.
    passOn(error);
    return undefined;
  }
}

// A frame inside a closed shadow root, which no page script can see: with
// the focus in one, the document's active element is the root's host. The
// protocol reads closed roots, so it lists the frames under that host that
// a closed root holds, by the ids the registry knows them by.
const FOCUS_GROUP = "kamapathy-focus";
const ACTIVE_ELEMENT = `(() => { let active = document.activeElement; while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement; return active; })()`;
interface DomNode {
  nodeName?: string;
  frameId?: string;
  children?: DomNode[];
  shadowRoots?: (DomNode & { shadowRootType?: string })[];
}
export async function framesInClosedRoots(
  session: TabSession,
  world: { sessionId?: string; contextId: number },
  step: Step,
): Promise<string[]> {
  const on = {
    ...step,
    ...(world.sessionId === undefined ? {} : { sessionId: world.sessionId }),
  };
  try {
    const { result } = await session.send<{ result?: { objectId?: string } }>(
      "Runtime.evaluate",
      {
        expression: ACTIVE_ELEMENT,
        contextId: world.contextId,
        objectGroup: FOCUS_GROUP,
      },
      on,
    );
    if (!result?.objectId) return [];
    const { node } = await session.send<{ node?: DomNode }>(
      "DOM.describeNode",
      { objectId: result.objectId, depth: -1, pierce: true },
      on,
    );
    const found: string[] = [];
    const visit = (item: DomNode, closed: boolean) => {
      const name = (item.nodeName ?? "").toLowerCase();
      if (closed && item.frameId && (name === "iframe" || name === "frame"))
        found.push(item.frameId);
      for (const child of item.children ?? []) visit(child, closed);
      for (const root of item.shadowRoots ?? [])
        visit(root, closed || root.shadowRootType === "closed");
    };
    if (node) visit(node, false);
    return found;
  } catch (error) {
    if (toApiError(error)) throw error;
    return [];
  } finally {
    await session
      .send("Runtime.releaseObjectGroup", { objectGroup: FOCUS_GROUP }, on)
      .catch(() => {});
  }
}

export function pickerKindOf(node: HitNode): PickerKind | undefined {
  if (node.attributes.pseudo === PICKER_INDICATOR) return "date";
  if (node.nodeName === "select") {
    const size = Number(node.attributes.size ?? "1");
    const dropdown =
      node.attributes.multiple === undefined &&
      (!Number.isFinite(size) || size <= 1);
    return dropdown ? "select" : undefined;
  }
  if (node.nodeName === "input" && typeOf(node.attributes) === "color")
    return "color";
  return undefined;
}

export function pickerUse(kind: PickerKind): "selectOption" | "fill" {
  return kind === "select" ? "selectOption" : "fill";
}

// The frames agent input may not reach: extension frames, the PDF viewer
// and other internal pages, and frames whose session ended.
export async function blockedFrames(
  session: TabSession,
  step: Step,
): Promise<Set<string>> {
  const frames = await session.knownFrames(step);
  return new Set(frames.filter(refusesInput).map((frame) => frame.frameId));
}

// What agents are told about a frame their input may not reach. Section 9
// names the frame, and a frame of one of the person's extensions is named
// for them as well, as section 17 says; every other blocked frame answers
// for itself. A registry read that fails, or runs out of time, leaves the
// plain refusal rather than another error.
const POINT_MESSAGE =
  "This point belongs to an extension or an internal page, which agent input never reaches. Act on the page itself.";
const FOCUS_MESSAGE =
  "The frame holding focus belongs to an extension or an internal page, which agent input never reaches. Focus a control in the page first.";
export function refuseFrame(
  message: string,
  named: { frame?: string; extension?: string },
): never {
  const frame = named.frame === undefined ? {} : { frame: named.frame };
  if (named.extension === undefined)
    return fail("input_target_blocked", message, frame);
  return fail("input_target_blocked", extensionInputMessage(named.extension), {
    ...frame,
    extension: named.extension,
  });
}
async function refusePoint(
  session: TabSession,
  frameId: string,
  step: Step,
  names: ExtensionNames,
): Promise<never> {
  const blocked = await blockedFrameOf(session, frameId, step).catch(
    () => undefined,
  );
  const extension = blocked && extensionFrame(blocked.url, names);
  return refuseFrame(POINT_MESSAGE, {
    ...(blocked ? { frame: blocked.path } : {}),
    ...(extension ? { extension: extension.name } : {}),
  });
}

const pickerAt = async (
  session: TabSession,
  point: { x: number; y: number },
  step: Step,
  hit: HitNode,
): Promise<PickerKind | undefined> => {
  const kind = pickerKindOf(hit);
  if (kind) return kind;
  if (hit.nodeName !== "input" || !DATE_TYPES.includes(typeOf(hit.attributes)))
    return undefined;
  const part = await hitNodeAt(session, point, step, { shadow: true });
  return part && pickerKindOf(part);
};

// The hit test takes whole points while Chromium sends input to the exact
// one: a probe of Electron 44 saw a press at x 149.6 land in a frame in its
// own process whose edge is at 150, where the hit test found the page. So
// the frame check also covers the whole points beside a fractional one.
const besideWhole = (point: { x: number; y: number }) => {
  const rounded = `${Math.round(point.x)},${Math.round(point.y)}`;
  const found = new Map<string, { x: number; y: number }>();
  for (const x of [Math.floor(point.x), Math.ceil(point.x)])
    for (const y of [Math.floor(point.y), Math.ceil(point.y)])
      if (`${x},${y}` !== rounded) found.set(`${x},${y}`, { x, y });
  return [...found.values()];
};

// Where input at a point lands, in the document coordinates the hit test
// reads. A probe of Electron 44 saw DOM.getNodeForLocation name what lay a
// page's scroll above where a press landed, and saw mouse, touch, tap,
// scroll and wheel input land at the visual viewport's place in the
// document plus the point, mobile emulation's zoom included. A page that
// cannot say is taken at its top, as a failed hit test is.
async function landingPoint(
  session: TabSession,
  point: { x: number; y: number },
  step: Step,
): Promise<{ x: number; y: number }> {
  try {
    const metrics = await session.send<{
      cssVisualViewport?: { pageX?: unknown; pageY?: unknown };
    }>("Page.getLayoutMetrics", {}, step);
    const { pageX, pageY } = metrics?.cssVisualViewport ?? {};
    const by = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? value : 0;
    return { x: point.x + by(pageX), y: point.y + by(pageY) };
  } catch (error) {
    passOn(error);
    return point;
  }
}

// Where a frame owner shows its frame's document in the viewport of the
// session that hit it, and at what scale: DOM.getBoxModel's content box,
// which reads closed shadow roots and transforms, against its border box
// drawn next to the owner's own size. A probe in Chromium saw a move at the
// content box's left or top edge land in the frame, and one 0.4 pixels
// before it, or at its right or bottom edge, land in the page around it.
async function contentBox(
  session: TabSession,
  backendNodeId: number,
  step: Step,
): Promise<
  | {
      x: number;
      y: number;
      right: number;
      bottom: number;
      scaleX: number;
      scaleY: number;
    }
  | undefined
> {
  try {
    const { model } = await session.send<{
      model?: {
        content?: number[];
        border?: number[];
        width?: number;
        height?: number;
      };
    }>("DOM.getBoxModel", { backendNodeId }, step);
    const content = model?.content;
    const border = model?.border;
    if (content?.length !== 8 || border?.length !== 8) return undefined;
    // The least and greatest of a quad's x values, or of its y values.
    const span = (quad: number[], from: number) => {
      const values = [0, 2, 4, 6].map((corner) => quad[from + corner]);
      return { low: Math.min(...values), high: Math.max(...values) };
    };
    const scaleOf = (from: number, size: number | undefined) => {
      const { low, high } = span(border, from);
      return size && high > low ? (high - low) / size : 1;
    };
    const across = span(content, 0);
    const down = span(content, 1);
    return {
      x: across.low,
      y: down.low,
      right: across.high,
      bottom: down.high,
      scaleX: scaleOf(0, model?.width),
      scaleY: scaleOf(1, model?.height),
    };
  } catch (error) {
    passOn(error);
    return undefined;
  }
}

// Every press goes through this, force included, and a move with no press
// is checked for its frame alone. A hit on the owner of a frame in its own
// process is followed into that frame, through every such frame the point
// lies in, so a frame nested in one is checked too.
export async function checkPointerTarget(
  session: TabSession,
  point: { x: number; y: number },
  step: Step,
  options: {
    button: Button;
    press: boolean;
    platform?: NodeJS.Platform;
    /** Section 17's loaded extensions, which name the frame a refusal is about. */
    extensions?: ExtensionNames;
    /** Filled in with the frame the input would reach, which a raw press counts its delivery in. */
    reached?: { frameId?: string };
  },
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const checkFrame = async (found: HitNode | undefined) => {
    const frameId = found?.frameId;
    if (frameId === undefined) return;
    const frames = await session.knownFrames(step);
    const frame = frames.find((entry) => entry.frameId === frameId);
    if (!frame || refusesInput(frame))
      await refusePoint(
        session,
        frameId,
        step,
        options.extensions ?? NO_EXTENSION_NAMES,
      );
  };
  const known = await session.knownFrames(step);
  // The session hit-tested, the point in its own viewport, and what lies
  // there.
  let on: SendStep = step;
  let local = point;
  let at = point;
  let hit: HitNode | undefined;
  let reached: string | undefined;
  // Each pass enters a frame inside the last, so there are never more
  // passes than the frames the tab holds.
  for (let depth = 0; depth <= known.length; depth += 1) {
    at = await landingPoint(session, local, on);
    hit = await hitNodeAt(session, at, on);
    await checkFrame(hit);
    // Input goes to the exact point, which lies on the same side of an edge
    // at a whole pixel as the whole point below it, so that point's hit
    // says where the input goes.
    let below = hit;
    for (const whole of besideWhole(at)) {
      const near = await hitNodeAt(session, whole, on);
      await checkFrame(near);
      if (whole.x === Math.floor(at.x) && whole.y === Math.floor(at.y))
        below = near;
    }
    if (below?.around === undefined) {
      reached = below?.frameId ?? reached;
      break;
    }
    // A point inside the owner's content box reaches the frame it holds,
    // and one on its border or padding the document around it.
    const owner = below;
    const box = await contentBox(session, owner.backendNodeId, on);
    const inside =
      !box ||
      (local.x >= box.x &&
        local.x < box.right &&
        local.y >= box.y &&
        local.y < box.bottom);
    reached = inside ? owner.frameId : owner.around;
    const frame = known.find((entry) => entry.frameId === owner.frameId);
    if (!box || !inside || !frame?.ownSession || frame.sessionId === undefined)
      break;
    on = { ...step, sessionId: frame.sessionId };
    local = {
      x: (local.x - box.x) / box.scaleX,
      y: (local.y - box.y) / box.scaleY,
    };
  }
  if (options.reached) options.reached.frameId = reached;
  if (!hit || !options.press) return;
  if (platform === "linux" && options.button === "middle" && hit.editable)
    fail(
      "clipboard_blocked",
      "A middle press on Linux pastes the system's primary selection, which Kamapathy never uses. Use fill or keyboard.paste instead.",
    );
  const kind = await pickerAt(session, at, on, hit);
  if (kind)
    fail(
      "native_popup_blocked",
      `This press would open the browser's own ${kind} picker, which no agent can answer. Use ${pickerUse(kind)} instead.`,
      { use: pickerUse(kind) },
    );
}

const opensPicker = (chord: Chord, platform: NodeJS.Platform) => {
  const name = chord.key.name;
  if (chord.mask === 0)
    return (
      PICKER_KEY_NAMES.includes(name) ||
      (platform === "darwin" && PICKER_MAC_KEYS.includes(name))
    );
  return chord.mask === MODIFIER_BITS.Alt && PICKER_ALT_KEYS.includes(name);
};

// The focused control as the page reports it, which section 9 will read
// from the focused frame instead. Inserted text and a release carry no
// chord, so only the frame check applies to them.
export function checkKeyTarget(
  focused: FocusedControl,
  chord?: Chord,
  platform: NodeJS.Platform = process.platform,
): void {
  if (focused.blockedFrame) refuseFrame(FOCUS_MESSAGE, focused);
  if (!chord || !PICKER_KINDS.includes(focused.kind)) return;
  if (!opensPicker(chord, platform)) return;
  const use = pickerUse(focused.kind as PickerKind);
  fail(
    "native_popup_blocked",
    `This key would open the browser's own ${focused.kind} picker, which no agent can answer. Use ${use} instead.`,
    { use },
  );
}
