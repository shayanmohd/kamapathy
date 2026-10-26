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
// whose DOM.describeNode names the frame it holds in frameId, so that is
// the frame the input would reach. With includeUserAgentShadowDOM the hit
// is the control's inner part, which carries none of the control's own
// attributes, so the author level decides the kind and the deeper hit is
// only asked for a date input, to tell its picker indicator from the fields
// that take typing.
import { fail, toApiError } from "../errors";
import {
  NO_EXTENSION_NAMES,
  blockedFrameOf,
  extensionFrame,
  extensionInputMessage,
  type ExtensionNames,
} from "../extension-frames";
import type { TabSession } from "../session/tab-session";
import type { KnownFrame, Step } from "../session/types";
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
  // The frame the input would reach: the frame a frame owner holds, else
  // the frame the node sits in.
  frameId?: string;
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
      nodeName,
      attributes,
      editable: editableNode(nodeName, attributes),
    };
  } catch (error) {
    // A hit test that failed says nothing about the point, so an ordinary
    // press is never refused for it. A refusal, or a page the agent lost,
    // still stops here.
    if (toApiError(error)) throw error;
    return undefined;
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

// What agents are told about a frame their input may not reach. A frame of
// one of the person's extensions is named for them, as section 17 says;
// every other blocked frame answers for itself. A registry read that fails,
// or runs out of time, leaves the plain refusal rather than another error.
const POINT_MESSAGE =
  "This point belongs to an extension or an internal page, which agent input never reaches. Act on the page itself.";
const FOCUS_MESSAGE =
  "The frame holding focus belongs to an extension or an internal page, which agent input never reaches. Focus a control in the page first.";
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
  if (!blocked || !extension)
    return fail("input_target_blocked", POINT_MESSAGE);
  return fail("input_target_blocked", extensionInputMessage(extension.name), {
    frame: blocked.path,
    extension: extension.name,
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

// Every press goes through this, force included, and a move with no press
// is checked for its frame alone.
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
  },
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const hit = await hitNodeAt(session, point, step);
  if (!hit) return;
  if (hit.frameId !== undefined) {
    const frames = await session.knownFrames(step);
    const frame = frames.find((entry) => entry.frameId === hit.frameId);
    if (!frame || refusesInput(frame))
      await refusePoint(
        session,
        hit.frameId,
        step,
        options.extensions ?? NO_EXTENSION_NAMES,
      );
  }
  if (!options.press) return;
  if (platform === "linux" && options.button === "middle" && hit.editable)
    fail(
      "clipboard_blocked",
      "A middle press on Linux pastes the system's primary selection, which Kamapathy never uses. Use fill or keyboard.paste instead.",
    );
  const kind = await pickerAt(session, point, step, hit);
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
  if (focused.blockedFrame) {
    const name = focused.extension;
    if (name === undefined) return fail("input_target_blocked", FOCUS_MESSAGE);
    return fail("input_target_blocked", extensionInputMessage(name), {
      ...(focused.frame === undefined ? {} : { frame: focused.frame }),
      extension: name,
    });
  }
  if (!chord || !PICKER_KINDS.includes(focused.kind)) return;
  if (!opensPicker(chord, platform)) return;
  const use = pickerUse(focused.kind as PickerKind);
  fail(
    "native_popup_blocked",
    `This key would open the browser's own ${focused.kind} picker, which no agent can answer. Use ${use} instead.`,
    { use },
  );
}
