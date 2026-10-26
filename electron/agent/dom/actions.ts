// The page side of section 5's actionability. This whole function is
// serialized with toString and passed into the page script, so it has no
// imports and reads nothing outside itself and its host. One instance serves
// one page operation.

export type ActionKind =
  | "click"
  | "dblclick"
  | "hover"
  | "drag"
  | "fill"
  | "select"
  | "focus"
  | "press";
export type ActionBlocker =
  | "detached"
  | "hidden"
  | "disabled"
  | "read_only"
  | "not_focused"
  | "moving"
  | "covered"
  | "outside_viewport"
  | "option_missing"
  | "frame_not_ready";
export interface Blocked {
  blocker: ActionBlocker;
  detail?: string;
  interceptor?: string;
}
export interface Point {
  x: number;
  y: number;
}
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface ScrollRequest {
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  frame?: string;
}
export type FillMatch =
  "exact" | "equivalent" | "transformed" | "unchanged" | "appended";
export type FillMode = "insert" | "direct" | "delete";
export interface FieldCandidate {
  ref?: string;
  tag: string;
  role: string;
  name: string;
  context: string;
}
export interface ActionHost {
  select(spec: unknown): Element | Record<string, unknown>;
  isElement(value: unknown): value is Element;
  visible(element: Element, includeAriaHidden?: boolean): boolean;
  placed(element: Element): Box & { clip: Box };
  hitAt(element: Element, x: number, y: number): Node | null;
  within(element: Element, hit: Node | null): boolean;
  emptyBox(element: Element): boolean;
  walk(root: Node, visit: (node: Node) => boolean | void): void;
  labelOf(element: Element): string;
  roleOf(element: Element): string;
  styleOf(element: Element): CSSStyleDeclaration;
  docOf(node: Node): Document;
  parentOf(element: Element): Element | null;
  framePath(element: Element): string;
  framesOf(element: Element): Element[] | undefined;
  frameDocument(element: Element): Document | null;
  opaqueFrame(element: Element): boolean;
  editingHost(element: Element): boolean;
  live(element: Element): boolean;
  secret(element: Element): boolean;
  candidates(found: Element[]): FieldCandidate[];
  normalizeText(text: string): string;
  failure(
    error: string,
    code?: string,
    fields?: Record<string, unknown>,
  ): Record<string, unknown>;
  reboundResult(): Record<string, unknown>;
}

// How a field's value is compared with what was asked for. It is a factory so
// the same code runs in the page, where it travels as an argument, and in
// Node through the exports below.
export function fillClassifier() {
  const normalizeValue = (text: string) =>
    text.replace(/\r\n?/g, "\n").replace(/[​﻿]/g, "");
  const numberOf = (text: string) => {
    const bare = text.replace(/,/g, "").trim();
    return bare === "" ? NaN : Number(bare);
  };
  const sameNumber = (asked: string, read: string) => {
    const left = numberOf(asked);
    return isFinite(left) && left === numberOf(read);
  };
  const classifyFill = (
    previous: string,
    value: string,
    read: string,
    options: { append: boolean },
  ): FillMatch => {
    const was = normalizeValue(previous);
    const asked = normalizeValue(value);
    const now = normalizeValue(read);
    const wanted = options.append ? was + asked : asked;
    if (now === wanted) return "exact";
    if (sameNumber(wanted, now)) return "equivalent";
    // An all-digit value reaches a masked field as digits in any layout.
    if (/^[0-9]+$/.test(wanted) && now.replace(/[^0-9]/g, "") === wanted)
      return "equivalent";
    if (now === was) return "unchanged";
    if (!options.append && now === was + asked) return "appended";
    return "transformed";
  };
  return { normalizeValue, classifyFill };
}
export const { classifyFill, normalizeValue } = fillClassifier();

export function actionOperations(
  host: ActionHost,
  classifier: typeof fillClassifier,
) {
  const { classifyFill } = classifier();
  const { failure } = host;
  // Control and bidirectional formatting characters, which never reach an
  // agent's terminal.
  const MARKS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;
  const MAX_NAME = 120;
  // What a field read gives back: enough to check a fill, never a page's
  // whole contents.
  const MAX_VALUE = 200;
  const MAX_CANDIDATES = 3;
  const MAX_OPTIONS = 20;
  const READS = 5;
  const READ_GAP_MS = 50;
  const MAX_POSITION = 10000;
  const STABLE_PX = 0.5;
  const STALL_MS = 100;
  const MAX_SCROLLS = 6;
  const HTML_NS = "http://www.w3.org/1999/xhtml";
  // Elements :disabled applies to, and the checks each action needs.
  const DISABLEABLE = [
    "button",
    "input",
    "select",
    "textarea",
    "option",
    "optgroup",
  ];
  const NEEDS_ENABLED = [
    "click",
    "dblclick",
    "drag",
    "fill",
    "select",
    "focus",
    "press",
  ];
  const NEEDS_POINT = ["click", "dblclick", "hover", "drag"];
  // Native controls and the ARIA widget roles a person operates directly,
  // which may take the hit for something inside them.
  const INTERACTIVE = [
    "button",
    "input",
    "select",
    "textarea",
    "option",
    "summary",
    "label",
  ];
  const WIDGETS = [
    "button",
    "checkbox",
    "combobox",
    "grid",
    "gridcell",
    "link",
    "listbox",
    "menu",
    "menubar",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "radiogroup",
    "scrollbar",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "tablist",
    "textbox",
    "tree",
    "treegrid",
    "treeitem",
  ];
  // The roles WAI-ARIA 1.2 lists aria-disabled for, with their subclasses.
  const ARIA_DISABLED = [
    "application",
    "button",
    "checkbox",
    "columnheader",
    "combobox",
    "composite",
    "grid",
    "gridcell",
    "group",
    "input",
    "link",
    "listbox",
    "menu",
    "menubar",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "radio",
    "radiogroup",
    "row",
    "rowheader",
    "scrollbar",
    "searchbox",
    "select",
    "separator",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "tablist",
    "textbox",
    "toolbar",
    "tree",
    "treegrid",
    "treeitem",
  ];
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

  const tagOf = (element: Element) =>
    element.namespaceURI === HTML_NS ? element.localName : "";
  const elementOf = (node: Node | null) =>
    !node ? null : node.nodeType === 1 ? (node as Element) : node.parentElement;
  const clean = (value: string) =>
    host.normalizeText(value).replace(MARKS, "").replace(/\s+/g, " ").trim();
  const cut = (value: string) =>
    value.length > MAX_NAME ? value.slice(0, MAX_NAME) : value;
  // What an agent needs to recognize an element it did not ask for: how the
  // page writes it, then the text a person reads on it.
  const marker = (element: Element) => {
    let name = element.localName;
    if (element.id) name += `#${element.id}`;
    for (const token of Array.from(element.classList)) name += `.${token}`;
    const role = host.roleOf(element);
    if (role && role !== element.localName) name += ` [role=${role}]`;
    return name;
  };
  const named = (element: Element) => {
    const label = clean(host.labelOf(element));
    return cut(label ? `${marker(element)} "${label}"` : marker(element));
  };
  const modalAround = (element: Element) => {
    for (let node: Element | null = element; node; node = host.parentOf(node))
      if (node.localName === "dialog" && node.matches(":modal")) return node;
    return null;
  };
  // What took the hit: the modal that holds it, else the deepest element.
  const interceptorName = (hit: Node | null) => {
    const element = elementOf(hit);
    if (!element) return "";
    const modal = modalAround(element);
    if (!modal) return named(element);
    const label = clean(host.labelOf(modal));
    return cut(label ? `dialog "${label}"` : "dialog");
  };
  const coveredBy = (hit: Node | null): Blocked => {
    const interceptor = interceptorName(hit);
    return {
      blocker: "covered",
      ...(interceptor ? { interceptor } : {}),
    };
  };

  const firstLegend = (fieldset: Element) => {
    for (const child of Array.from(fieldset.children))
      if (child.localName === "legend") return child;
    return null;
  };
  // Native disabled states first, then the inherited aria-disabled: the
  // nearest ancestor-or-self whose role supports it decides.
  const enabledBlocker = (element: Element): Blocked | undefined => {
    const disabled = (node: Element): Blocked => ({
      blocker: "disabled",
      ...(node === element ? {} : { detail: cut(marker(node)) }),
    });
    for (let node: Element | null = element; node; node = host.parentOf(node)) {
      const tag = tagOf(node);
      if (DISABLEABLE.includes(tag) && node.matches(":disabled"))
        return disabled(node);
      if (tag === "fieldset" && (node as HTMLFieldSetElement).disabled) {
        const legend = firstLegend(node);
        if (!legend || !host.within(legend, element)) return disabled(node);
      }
    }
    for (let node: Element | null = element; node; node = host.parentOf(node)) {
      const marked = node.getAttribute("aria-disabled");
      if (
        (marked !== "true" && marked !== "false") ||
        !ARIA_DISABLED.includes(host.roleOf(node))
      )
        continue;
      return marked === "true" ? disabled(node) : undefined;
    }
    return undefined;
  };
  const readOnlyBlocker = (element: Element): Blocked | undefined =>
    element.hasAttribute("readonly") ? { blocker: "read_only" } : undefined;
  const firstBlocker = (
    element: Element,
    kind: ActionKind,
  ): Blocked | undefined => {
    if (!host.live(element)) return { blocker: "detached" };
    if (host.docOf(element).readyState === "loading")
      return { blocker: "frame_not_ready" };
    if (!host.visible(element)) return { blocker: "hidden" };
    if (NEEDS_ENABLED.includes(kind)) {
      const stop = enabledBlocker(element);
      if (stop) return stop;
    }
    return kind === "fill" ? readOnlyBlocker(element) : undefined;
  };

  const intersect = (first: Box, second: Box): Box => ({
    left: Math.max(first.left, second.left),
    top: Math.max(first.top, second.top),
    right: Math.min(first.right, second.right),
    bottom: Math.min(first.bottom, second.bottom),
  });
  const area = (box: Box) =>
    Math.max(0, box.right - box.left) * Math.max(0, box.bottom - box.top);
  const middleOf = (box: Box): Point => ({
    x: (box.left + box.right) / 2,
    y: (box.top + box.bottom) / 2,
  });
  const holds = (box: Box, spot: Point) =>
    spot.x >= box.left &&
    spot.x <= box.right &&
    spot.y >= box.top &&
    spot.y <= box.bottom;
  const clamp = (value: number, low: number, high: number) =>
    Math.min(Math.max(value, low), high);
  const topViewport = (): Box => ({
    left: 0,
    top: 0,
    right: innerWidth,
    bottom: innerHeight,
  });
  // How a document's own pixels reach the top viewport: the frames around it
  // move and scale everything they show.
  const maps = new Map<Document, Mapping>();
  type Mapping = { scaleX: number; scaleY: number; x: number; y: number };
  const mapOf = (doc: Document): Mapping => {
    let map = maps.get(doc);
    if (!map) {
      const root = doc.documentElement || doc.body;
      const local = root.getBoundingClientRect();
      const top = host.placed(root);
      // A document that holds nothing in flow has a root with no height of
      // its own, and a page of positioned boxes is one. The frames around it
      // scale both axes together, so the axis that measured answers for the
      // one that could not.
      const alongX = local.width ? (top.right - top.left) / local.width : 0;
      const alongY = local.height ? (top.bottom - top.top) / local.height : 0;
      const scaleX = alongX || alongY || 1;
      const scaleY = alongY || alongX || 1;
      map = {
        scaleX,
        scaleY,
        x: top.left - local.left * scaleX,
        y: top.top - local.top * scaleY,
      };
      maps.set(doc, map);
    }
    return map;
  };
  const toTop = (map: Mapping, box: Box): Box => ({
    left: map.x + box.left * map.scaleX,
    top: map.y + box.top * map.scaleY,
    right: map.x + box.right * map.scaleX,
    bottom: map.y + box.bottom * map.scaleY,
  });
  const toLocal = (map: Mapping, box: Box): Box => ({
    left: (box.left - map.x) / map.scaleX,
    top: (box.top - map.y) / map.scaleY,
    right: (box.right - map.x) / map.scaleX,
    bottom: (box.bottom - map.y) / map.scaleY,
  });
  const borderBox = (element: Element): Box => {
    const box = host.placed(element);
    return {
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom,
    };
  };
  // What an element shows of what it holds: its padding box, without the
  // border and the scrollbars, where it has one.
  const paddingBox = (node: Element): Box => {
    const local = node.getBoundingClientRect();
    const laid = node as unknown as {
      offsetWidth?: number;
      offsetHeight?: number;
    };
    const scaleX = laid.offsetWidth ? local.width / laid.offsetWidth : 0;
    const scaleY = laid.offsetHeight ? local.height / laid.offsetHeight : 0;
    const inner =
      scaleX && scaleY && node.clientWidth && node.clientHeight
        ? {
            left: local.left + node.clientLeft * scaleX,
            top: local.top + node.clientTop * scaleY,
            right: local.left + (node.clientLeft + node.clientWidth) * scaleX,
            bottom: local.top + (node.clientTop + node.clientHeight) * scaleY,
          }
        : {
            left: local.left,
            top: local.top,
            right: local.right,
            bottom: local.bottom,
          };
    return toTop(mapOf(host.docOf(node)), inner);
  };
  // Everything that cuts a box off: the frames around it, and every ancestor
  // that clips what it shows.
  const clipOf = (element: Element) => {
    let clip = host.placed(element).clip;
    for (let node = host.parentOf(element); node; node = host.parentOf(node)) {
      const style = host.styleOf(node);
      const cutsX = style.overflowX !== "visible";
      const cutsY = style.overflowY !== "visible";
      if (!cutsX && !cutsY) continue;
      const box = paddingBox(node);
      clip = {
        left: cutsX ? Math.max(clip.left, box.left) : clip.left,
        top: cutsY ? Math.max(clip.top, box.top) : clip.top,
        right: cutsX ? Math.min(clip.right, box.right) : clip.right,
        bottom: cutsY ? Math.min(clip.bottom, box.bottom) : clip.bottom,
      };
    }
    return clip;
  };
  const topRects = (element: Element) => {
    const map = mapOf(host.docOf(element));
    return Array.from(element.getClientRects()).map((rect) =>
      toTop(map, {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      }),
    );
  };
  // The centre of the visible part of the largest visible rect: the one with
  // the most of itself inside every clip, the first of equals.
  const visiblePoint = (element: Element, clip: Box) => {
    let best: Box | undefined;
    let most = 0;
    for (const rect of topRects(element)) {
      const shown = intersect(rect, clip);
      const size = area(shown);
      if (size > most) {
        most = size;
        best = shown;
      }
    }
    return best ? middleOf(best) : undefined;
  };
  // A point an agent asked for, measured from the border box's top left.
  const positioned = (element: Element, position: Point, clip: Box) => {
    const { x, y } = position;
    if (
      !isFinite(x) ||
      !isFinite(y) ||
      Math.abs(x) > MAX_POSITION ||
      Math.abs(y) > MAX_POSITION
    )
      return undefined;
    const box = borderBox(element);
    const map = mapOf(host.docOf(element));
    const spot = { x: box.left + x * map.scaleX, y: box.top + y * map.scaleY };
    return holds(clip, spot) ? spot : undefined;
  };
  // A control drawn with no size, such as a radio in a list row that takes
  // the row's clicks, is pressed in the page instead. It counts as reachable
  // where the box around it is in view and uncovered.
  const holderOf = (element: Element) => {
    let holder = host.parentOf(element);
    while (holder && host.emptyBox(holder)) holder = host.parentOf(holder);
    return holder;
  };
  const emptySpot = (element: Element, holder: Element, clip: Box): Point => {
    const box = borderBox(element);
    const around = borderBox(holder);
    return {
      x: Math.min(Math.max(box.left, around.left, clip.left), around.right - 1),
      y: Math.min(Math.max(box.top, around.top, clip.top), around.bottom - 1),
    };
  };
  const emptyPoint = (element: Element, clip: Box, force: boolean) => {
    const holder = holderOf(element);
    if (!holder) return { blocked: { blocker: "outside_viewport" as const } };
    const spot = emptySpot(element, holder, clip);
    if (!holds(clip, spot))
      return { blocked: { blocker: "outside_viewport" as const } };
    if (!force) {
      const hit = host.hitAt(element, spot.x, spot.y);
      if (!host.within(holder, hit)) return { blocked: coveredBy(hit) };
    }
    return { empty: true as const };
  };
  // Whether the page could press the target where it stands.
  const inView = (element: Element, clip: Box, position?: Point) => {
    if (host.emptyBox(element)) {
      const holder = holderOf(element);
      return !!holder && holds(clip, emptySpot(element, holder, clip));
    }
    return position === undefined
      ? !!visiblePoint(element, clip)
      : !!positioned(element, position, clip);
  };

  // The hit may be the target, something drawn inside it, or an interactive
  // element around it, as a label around a checkbox is.
  const interactive = (node: Element) => {
    const tag = tagOf(node);
    return (
      INTERACTIVE.includes(tag) ||
      (tag === "a" && node.hasAttribute("href")) ||
      (node as HTMLElement).isContentEditable === true ||
      WIDGETS.includes(host.roleOf(node))
    );
  };
  const accepts = (element: Element, hit: Node | null) => {
    if (!hit) return false;
    if (host.within(element, hit)) return true;
    const found = elementOf(hit);
    for (let node = host.parentOf(element); node; node = host.parentOf(node))
      if (node === found) return interactive(node);
    return false;
  };

  const controlKind = (element: Element) => {
    const tag = tagOf(element);
    if (tag === "select") {
      const choice = element as HTMLSelectElement;
      return !choice.multiple && choice.size <= 1 ? "select" : "other";
    }
    if (tag === "input") {
      const field = element as HTMLInputElement;
      if (field.type === "color") return "color";
      if (DATE_TYPES.includes(field.type)) return "date";
      return TEXT_TYPES.includes(field.type) ? "editable" : "other";
    }
    if (tag === "textarea") return "editable";
    return (element as HTMLElement).isContentEditable === true
      ? "editable"
      : "other";
  };
  // A hint only: the main process decides with its own hit test.
  const pickerOf = (element: Element) => {
    const kind = controlKind(element);
    return kind === "select" || kind === "color" || kind === "date"
      ? kind
      : undefined;
  };

  // The boxes that can bring the target into view, outermost first: a frame
  // comes into view before the panel inside it.
  type Step = { container?: Element; doc: Document; aim: Element };
  const scrollBox = (node: Element) => {
    const style = host.styleOf(node);
    const scrolls = (overflow: string) =>
      overflow === "auto" || overflow === "scroll" || overflow === "overlay";
    return scrolls(style.overflowY) || scrolls(style.overflowX);
  };
  const roomIn = (node: Element) =>
    node.scrollHeight - node.clientHeight >= 1 ||
    node.scrollWidth - node.clientWidth >= 1;
  const scrollerOf = (step: Step) =>
    step.container || step.doc.scrollingElement || step.doc.documentElement;
  const chainOf = (element: Element) => {
    const steps: Step[] = [];
    let aim = element;
    for (let node = host.parentOf(element); node; node = host.parentOf(node)) {
      const doc = host.docOf(node);
      if (doc !== host.docOf(aim)) {
        steps.push({ doc: host.docOf(aim), aim });
        aim = node;
      } else if (scrollBox(node) && roomIn(node))
        steps.push({ container: node, doc, aim });
    }
    steps.push({ doc: document, aim });
    return steps.reverse();
  };
  const stepBox = (step: Step): Box => {
    if (step.container)
      return intersect(paddingBox(step.container), clipOf(step.container));
    const owner = step.doc.defaultView?.frameElement as Element | null;
    return owner ? intersect(paddingBox(owner), clipOf(owner)) : topViewport();
  };
  const stepRoom = (step: Step) => roomIn(scrollerOf(step));
  type Ask = {
    request: ScrollRequest;
    node: Element;
    left: number;
    top: number;
  };
  const askFor = (step: Step): Ask => {
    const shown = stepBox(step);
    const aim = step.aim.getBoundingClientRect();
    const map = mapOf(step.doc);
    const drawn = middleOf(borderBox(step.aim));
    const where =
      area(shown) > 0
        ? middleOf(shown)
        : {
            x: clamp(drawn.x, 0, innerWidth),
            y: clamp(drawn.y, 0, innerHeight),
          };
    // The wheel lands in the top viewport; its delta moves the container's
    // own pixels, so the point ends up in the middle of what it shows.
    const centre = middleOf(toLocal(map, shown));
    const node = scrollerOf(step);
    const frame = host.framePath(step.container || step.doc.documentElement);
    return {
      request: {
        x: where.x,
        y: where.y,
        deltaX: (aim.left + aim.right) / 2 - centre.x,
        deltaY: (aim.top + aim.bottom) / 2 - centre.y,
        ...(frame ? { frame } : {}),
      },
      node,
      left: node.scrollLeft,
      top: node.scrollTop,
    };
  };
  const scrollFor = (element: Element) => {
    const needing = chainOf(element).filter(
      (step) => !holds(stepBox(step), middleOf(borderBox(step.aim))),
    );
    if (!needing.length) return undefined;
    const roomy = needing.filter(stepRoom);
    return askFor(roomy.length ? roomy[0] : needing[needing.length - 1]);
  };
  // The scroller the last request named, so a gesture that moved nothing is
  // told from one that worked.
  type Mark = { node: Element; left: number; top: number };
  // A secret field's own value stays in this world: the main process hands
  // the previous value back to the read, and a secret one never leaves.
  const slot = globalThis as unknown as {
    __kamapathyScroll?: Mark;
    __kamapathySecret?: string;
  };
  const mark = (ask: Ask) => {
    slot.__kamapathyScroll = {
      node: ask.node,
      left: ask.left,
      top: ask.top,
    };
  };
  const forget = () => {
    delete slot.__kamapathyScroll;
  };
  const unmoved = (ask: Ask) => {
    const last = slot.__kamapathyScroll;
    return (
      !!last &&
      last.node === ask.node &&
      last.left === ask.left &&
      last.top === ask.top
    );
  };

  const spanOf = (first: Box, second: Box): Box => ({
    left: Math.min(first.left, second.left),
    top: Math.min(first.top, second.top),
    right: Math.max(first.right, second.right),
    bottom: Math.max(first.bottom, second.bottom),
  });
  const fits = (shown: Box, box: Box) =>
    box.right - box.left <= shown.right - shown.left &&
    box.bottom - box.top <= shown.bottom - shown.top;
  // Whether some scroll offset has both boxes meeting what is shown, which
  // is what a drag across the screen needs. Two boxes further apart than the
  // viewport can never meet it together, however tall either one is.
  const shareable = (shown: Box, first: Box, second: Box) =>
    Math.max(first.left, second.left) - Math.min(first.right, second.right) <
      shown.right - shown.left &&
    Math.max(first.top, second.top) - Math.min(first.bottom, second.bottom) <
      shown.bottom - shown.top;
  const inside = (shown: Box, box: Box) =>
    box.left >= shown.left &&
    box.right <= shown.right &&
    box.top >= shown.top &&
    box.bottom <= shown.bottom;
  // How far a scroller has to move to show a box it can hold.
  const shiftTo = (low: number, high: number, from: number, to: number) =>
    high > to ? high - to : low < from ? low - from : 0;
  // The gesture that brings both ends of a drag into view: the least move
  // that shows the box around the two of them, since centring one end would
  // push the other out. A pair too large for what a step shows falls back to
  // centring the end that is off screen.
  const dragAsk = (element: Element, span: Box): Ask | undefined => {
    const needing = chainOf(element).filter(
      (step) => !inside(stepBox(step), span),
    );
    if (!needing.length) return undefined;
    const roomy = needing.filter(stepRoom);
    const step = roomy.length ? roomy[0] : needing[needing.length - 1];
    const shown = stepBox(step);
    if (area(shown) <= 0 || !fits(shown, span)) return askFor(step);
    const map = mapOf(step.doc);
    const box = toLocal(map, span);
    const view = toLocal(map, shown);
    const node = scrollerOf(step);
    const frame = host.framePath(step.container || step.doc.documentElement);
    const where = middleOf(shown);
    return {
      request: {
        x: where.x,
        y: where.y,
        deltaX: shiftTo(box.left, box.right, view.left, view.right),
        deltaY: shiftTo(box.top, box.bottom, view.top, view.bottom),
        ...(frame ? { frame } : {}),
      },
      node,
      left: node.scrollLeft,
      top: node.scrollTop,
    };
  };

  const blockedResult = (
    stop: Blocked,
    rest: Record<string, unknown> = {},
  ) => ({
    ok: true as const,
    ...rest,
    blocked: stop,
    ...host.reboundResult(),
  });
  const settle = () =>
    new Promise<void>((done) => {
      let answered = false;
      const once = () => {
        if (answered) return;
        answered = true;
        done();
      };
      requestAnimationFrame(() => requestAnimationFrame(once));
      setTimeout(once, STALL_MS);
    });

  // Both ends of a drag, measured in one layout so the two points belong
  // to the same page. The source keeps today's rules: it must be enabled,
  // the drop must lie outside it, and neither end can be acted on without
  // an area of its own.
  type DragEnd = "source" | "target";
  const dragPoints = (payload: Record<string, unknown>) => {
    const source = host.select(payload.source);
    if (!host.isElement(source)) return source;
    const destination = host.select(payload.target);
    if (!host.isElement(destination)) return destination;
    if (host.within(source, destination))
      return failure(
        "Drag onto an element outside the one being dragged.",
        "invalid_target",
      );
    if (host.emptyBox(source) || host.emptyBox(destination))
      return failure("Element has no area to drag from or onto.");
    const stopped = (stop: Blocked, end: DragEnd) => {
      const blocked: Blocked & { end: DragEnd } = { ...stop, end };
      return blockedResult(blocked);
    };
    const ends = [
      {
        end: "source" as DragEnd,
        element: source,
        kind: "drag" as ActionKind,
        position: payload.sourcePosition as Point | undefined,
      },
      {
        end: "target" as DragEnd,
        element: destination,
        kind: "hover" as ActionKind,
        position: payload.targetPosition as Point | undefined,
      },
    ];
    for (const { end, element, kind } of ends) {
      const stop = firstBlocker(element, kind);
      if (stop) return stopped(stop, end);
    }
    const boxes = ends.map(({ element }) => borderBox(element));
    const outOfView = () =>
      failure(
        "Scroll so the source and target are both on screen, then drag again.",
        "drag_out_of_view",
      );
    const force = payload.force === true;
    const scrolls = typeof payload.scrolls === "number" ? payload.scrolls : 0;
    const spots: Point[] = [];
    for (const { end, element, position } of ends) {
      const clip = clipOf(element);
      const shown = visiblePoint(element, clip);
      if (!shown) {
        // A pair too far apart to share the screen is refused for good; one
        // that is merely off screen is scrolled in.
        if (!shareable(topViewport(), boxes[0], boxes[1])) return outOfView();
        const ask = dragAsk(element, spanOf(boxes[0], boxes[1]));
        if (!ask) return outOfView();
        // Six gestures, or one that moved nothing, and the page scrolls
        // this end itself.
        if (scrolls >= MAX_SCROLLS || unmoved(ask)) {
          forget();
          element.scrollIntoView({
            block: "center",
            inline: "center",
            behavior: "instant",
          });
          return {
            ok: true as const,
            intoView: true as const,
            ...host.reboundResult(),
          };
        }
        mark(ask);
        return {
          ok: true as const,
          scroll: { ...ask.request, end },
          ...host.reboundResult(),
        };
      }
      const spot =
        position === undefined ? shown : positioned(element, position, clip);
      if (!spot) return stopped({ blocker: "outside_viewport" }, end);
      spots.push(spot);
    }
    forget();
    const [from, to] = spots;
    const measured = { ok: true as const, from, to, ...host.reboundResult() };
    if (force) return measured;
    for (const [index, { end, element }] of ends.entries()) {
      const hit = host.hitAt(element, spots[index].x, spots[index].y);
      if (!accepts(element, hit))
        return { ...measured, blocked: { ...coveredBy(hit), end } };
    }
    return measured;
  };

  const actionPoint = (payload: Record<string, unknown>) => {
    if (payload.kind === "drag") return dragPoints(payload);
    const found = host.select(payload);
    if (!host.isElement(found)) return found;
    const element = found;
    const kind = payload.kind as ActionKind;
    const stop = firstBlocker(element, kind);
    if (stop) return blockedResult(stop, { box: borderBox(element) });
    const picker = pickerOf(element);
    const base = {
      ok: true as const,
      box: borderBox(element),
      ...(picker ? { picker } : {}),
      ...host.reboundResult(),
    };
    if (!NEEDS_POINT.includes(kind)) return base;
    const force = payload.force === true;
    const clip = clipOf(element);
    if (host.emptyBox(element))
      return { ...base, ...emptyPoint(element, clip, force) };
    const shown = visiblePoint(element, clip);
    if (!shown) {
      const ask = scrollFor(element);
      if (!ask) return { ...base, blocked: { blocker: "outside_viewport" } };
      mark(ask);
      return { ...base, scroll: ask.request };
    }
    const position = payload.position as Point | undefined;
    const spot =
      position === undefined ? shown : positioned(element, position, clip);
    if (!spot) return { ...base, blocked: { blocker: "outside_viewport" } };
    if (!force) {
      const hit = host.hitAt(element, spot.x, spot.y);
      if (!accepts(element, hit))
        return { ...base, point: spot, blocked: coveredBy(hit) };
    }
    return { ...base, point: spot };
  };

  const stableBox = async (payload: Record<string, unknown>) => {
    const found = host.select(payload);
    if (!host.isElement(found)) return found;
    const element = found;
    if (!host.live(element)) return blockedResult({ blocker: "detached" });
    const before = borderBox(element);
    await settle();
    if (!host.live(element)) return blockedResult({ blocker: "detached" });
    const after = borderBox(element);
    const moved = Math.max(
      Math.abs(after.left - before.left),
      Math.abs(after.top - before.top),
      Math.abs(after.right - before.right),
      Math.abs(after.bottom - before.bottom),
    );
    return {
      ok: true as const,
      box: after,
      moved,
      ...(moved > STABLE_PX ? { blocked: { blocker: "moving" } } : {}),
      ...host.reboundResult(),
    };
  };

  const scrollRequest = (payload: Record<string, unknown>) => {
    const found = host.select(payload);
    if (!host.isElement(found)) return found;
    const element = found;
    const stop = firstBlocker(element, "hover");
    if (stop) return blockedResult(stop);
    const position = payload.position as Point | undefined;
    const clip = clipOf(element);
    const rest = host.reboundResult();
    if (inView(element, clip, position)) {
      forget();
      return { ok: true as const, settled: true as const, ...rest };
    }
    const ask = scrollFor(element);
    if (!ask) {
      forget();
      return blockedResult({ blocker: "outside_viewport" });
    }
    const scrolls = typeof payload.scrolls === "number" ? payload.scrolls : 0;
    // Six gestures, or one that moved nothing, and the page scrolls itself.
    if (scrolls >= MAX_SCROLLS || unmoved(ask)) {
      forget();
      element.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "instant",
      });
      return { ok: true as const, intoView: true as const, ...rest };
    }
    mark(ask);
    return { ok: true as const, scroll: ask.request, ...rest };
  };

  const viewport = (_payload?: Record<string, unknown>) => ({
    ok: true as const,
    width: innerWidth,
    height: innerHeight,
    // How many device pixels a CSS pixel draws, which carries the zoom.
    zoom: devicePixelRatio,
  });

  // What holds the caret, through shadow roots and the frames this page can
  // read.
  const deepActive = () => {
    let active = document.activeElement;
    for (let depth = 0; active && depth < 32; depth++) {
      const inner =
        active.shadowRoot?.activeElement ||
        host.frameDocument(active)?.activeElement ||
        null;
      if (!inner) break;
      active = inner;
    }
    return active;
  };

  const focusedKind = (_payload?: Record<string, unknown>) => {
    const active = deepActive();
    const doc = active && host.docOf(active);
    if (
      !active ||
      !doc ||
      active === doc.body ||
      active === doc.documentElement
    )
      return { ok: true as const, kind: "none" as const };
    const frame = host.framePath(active);
    const place = frame ? { frame } : {};
    return host.opaqueFrame(active)
      ? {
          ok: true as const,
          kind: "other" as const,
          blockedFrame: true as const,
          ...place,
        }
      : { ok: true as const, kind: controlKind(active), ...place };
  };

  // What fill can put a value into, and the way it gets there. "host" names
  // an element inside an editing host, which fill retargets to.
  type FillKind =
    "text" | "direct" | "host" | "kind" | "readonly_select" | "none";
  const fillKindOf = (element: Element): FillKind => {
    const tag = tagOf(element);
    if (tag === "input") {
      const type = (element as HTMLInputElement).type;
      if (type === "range" || type === "color" || DATE_TYPES.includes(type))
        return "direct";
      return TEXT_TYPES.includes(type) ? "text" : "kind";
    }
    if (tag === "textarea") return "text";
    if (tag === "select") {
      const list = element as HTMLSelectElement;
      if (list.multiple) return "kind";
      return list.options.length ? "direct" : "readonly_select";
    }
    if ((element as HTMLElement).isContentEditable !== true) return "none";
    return host.editingHost(element) ? "text" : "host";
  };
  const editingAround = (element: Element) => {
    for (let node: Element | null = element; node; node = host.parentOf(node))
      if (host.editingHost(node)) return node;
    return null;
  };
  const fieldValue = (field: Element) => {
    const tag = tagOf(field);
    if (tag === "input" || tag === "textarea" || tag === "select")
      return (field as HTMLInputElement).value;
    return (field as HTMLElement).innerText ?? "";
  };
  // The value setter the element's own realm defines, which a framework's own
  // property on the element does not hide.
  const valueSetter = (field: Element) => {
    for (
      let proto = Object.getPrototypeOf(field);
      proto;
      proto = Object.getPrototypeOf(proto)
    ) {
      const found = Object.getOwnPropertyDescriptor(proto, "value");
      if (found?.set) return found.set;
    }
    return undefined;
  };
  // What a person's own edit leaves behind: an input event a framework sees
  // through its root listener, then a change event.
  const fireEdit = (field: Element) => {
    field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const invalidValue = () =>
    failure("The value is not valid for this input type.", "invalid_value");
  const notEditable = (reason: string) => {
    const fields = { reason };
    return failure(
      "Nothing at, around or inside the target can take typing or a value.",
      "not_editable",
      fields,
    );
  };
  const ambiguousField = (found: Element[]) => {
    const fields = {
      candidates: host
        .candidates(found.slice(0, MAX_CANDIDATES))
        .map((item) => ({
          ...(item.ref === undefined ? {} : { ref: item.ref }),
          tag: item.tag,
          role: item.role,
          name: item.name,
          context: item.context,
        })),
    };
    return failure(
      "Retargeting found several fields. Name the one to use.",
      "ambiguous_field",
      fields,
    );
  };

  // Where a retarget ends: one element, the ones to choose between, or why
  // there is nothing to act on.
  type Aim =
    | { field: Element }
    | { many: Element[] }
    | { stop: "kind" | "readonly_select" | "frame" | "none" };
  // The one candidate the action can take, else the candidates to choose
  // between, the ones it can take first and in page order.
  const pickOne = (found: Element[], frame: boolean, kind: ActionKind): Aim => {
    const open = found.filter((node) => !firstBlocker(node, kind));
    if (open.length === 1) return { field: open[0] };
    if (open.length > 1)
      return {
        many: [...open, ...found.filter((node) => !open.includes(node))],
      };
    if (found.length === 1) return { field: found[0] };
    if (found.length > 1) return { many: found };
    return { stop: frame ? "frame" : "none" };
  };
  const insideTarget = (
    element: Element,
    takes: (node: Element) => boolean,
  ) => {
    const found: Element[] = [];
    let frame = false;
    host.walk(element, (node) => {
      if (!host.isElement(node)) return undefined;
      if (host.opaqueFrame(node)) {
        frame = true;
        return false;
      }
      if (!takes(node)) return undefined;
      found.push(node);
      return false;
    });
    return { found, frame };
  };
  const fillable = (node: Element) => {
    const kind = fillKindOf(node);
    return kind === "text" || kind === "direct";
  };
  const fillTarget = (element: Element): Aim => {
    const kind = fillKindOf(element);
    if (kind === "text" || kind === "direct") return { field: element };
    if (kind === "kind" || kind === "readonly_select") return { stop: kind };
    if (kind === "host") {
      const around = editingAround(element);
      if (around) return { field: around };
    }
    const { found, frame } = insideTarget(element, fillable);
    return pickOne(found, frame, "fill");
  };
  const selectTarget = (element: Element): Aim => {
    if (tagOf(element) === "select") return { field: element };
    if (tagOf(element) === "label") {
      const control = (element as HTMLLabelElement).control;
      if (control && tagOf(control) === "select") return { field: control };
    }
    const { found, frame } = insideTarget(
      element,
      (node) => tagOf(node) === "select",
    );
    return pickOne(found, frame, "select");
  };
  const FOCUSABLE = ["button", "input", "select", "textarea", "summary"];
  const focusable = (node: Element) => {
    const tag = tagOf(node);
    if (FOCUSABLE.includes(tag)) return true;
    if (tag === "a" || tag === "area") return node.hasAttribute("href");
    if (tag === "iframe" || tag === "frame") return true;
    if (tag === "audio" || tag === "video")
      return node.hasAttribute("controls");
    if (node.hasAttribute("tabindex")) return true;
    if ((node as HTMLElement).isContentEditable === true) return true;
    return WIDGETS.includes(host.roleOf(node));
  };
  // The nearest focusable ancestor in the target's own document, else the one
  // editable element inside it.
  const focusAround = (element: Element): Aim => {
    const doc = host.docOf(element);
    for (
      let node = host.parentOf(element);
      node && host.docOf(node) === doc;
      node = host.parentOf(node)
    )
      if (focusable(node)) return { field: node };
    const { found, frame } = insideTarget(element, fillable);
    return pickOne(found, frame, "focus");
  };
  const tryFocus = (element: Element) => {
    (element as HTMLElement).focus({ preventScroll: true });
    return host.within(element, deepActive());
  };

  // What Chromium would make of the value before it is typed: a field that
  // would rewrite it never gets it.
  const typeProblem = (field: Element, value: string) => {
    if (tagOf(field) !== "input") return undefined;
    const probe = host.docOf(field).createElement("input");
    probe.type = (field as HTMLInputElement).type;
    probe.value = value;
    return probe.value === value ? undefined : invalidValue();
  };
  // Today's rule for a select filled by value: one option, and not a
  // disabled one.
  const optionProblem = (list: HTMLSelectElement, value: string) => {
    const found = Array.from(list.options).filter(
      (option) => option.value === value,
    );
    if (found.length !== 1)
      return failure(
        "The value must match exactly one option.",
        "invalid_value",
      );
    return found[0].disabled || found[0].closest("optgroup")?.disabled
      ? failure("The requested option is disabled.", "invalid_value")
      : undefined;
  };
  // Where a retry click would land: the field's own point, when nothing else
  // would take it. Fill never fails on the viewport, so a field out of view
  // simply has no point to retry at.
  const retryPoint = (field: Element) => {
    if (host.emptyBox(field)) return undefined;
    const clip = clipOf(field);
    const spot = visiblePoint(field, clip);
    if (!spot) return undefined;
    return accepts(field, host.hitAt(field, spot.x, spot.y)) ? spot : undefined;
  };
  // A trusted insertion needs the caret where a person's would be: the whole
  // value selected, or the end of it when the agent appends.
  const prepareField = (
    field: Element,
    append: boolean,
  ): Blocked | undefined => {
    (field as HTMLElement).focus({ preventScroll: true });
    if (!host.within(field, deepActive())) return { blocker: "not_focused" };
    const tag = tagOf(field);
    if (tag === "input" || tag === "textarea") {
      const entry = field as HTMLInputElement;
      const end = entry.value.length;
      try {
        entry.setSelectionRange(append ? end : 0, end);
      } catch {
        // Email and number inputs have no selection to set. Selecting the
        // field covers a replacement, and a focused one holds its caret at
        // the end of the value, which is where an append belongs.
        if (!append) entry.select();
      }
      return undefined;
    }
    const doc = host.docOf(field);
    const selection = doc.defaultView?.getSelection();
    if (!selection) return undefined;
    const range = doc.createRange();
    range.selectNodeContents(field);
    if (append) range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return undefined;
  };

  const fillPrepare = (payload: Record<string, unknown>) => {
    const found = host.select(payload);
    if (!host.isElement(found)) return found;
    const aim = fillTarget(found);
    if ("stop" in aim) return notEditable(aim.stop);
    if ("many" in aim) return ambiguousField(aim.many);
    const field = aim.field;
    const stop = firstBlocker(field, "fill");
    if (stop) return blockedResult(stop);
    const value = String(payload.value ?? "");
    const direct = fillKindOf(field) === "direct";
    if (!direct) {
      const refused = typeProblem(field, value);
      if (refused) return refused;
    }
    const append = payload.append === true;
    const hidden = host.secret(field);
    const previous = fieldValue(field);
    if (hidden) slot.__kamapathySecret = previous;
    else delete slot.__kamapathySecret;
    const spot = retryPoint(field);
    const base = {
      ok: true as const,
      mode: (direct
        ? "direct"
        : !append && value === ""
          ? "delete"
          : "insert") as FillMode,
      previous: hidden ? "" : previous,
      ...(hidden ? { valueHidden: true as const } : {}),
      ...(spot ? { point: spot } : {}),
      ...host.reboundResult(),
    };
    if (direct) return base;
    const waiting = prepareField(field, append);
    return waiting ? { ...base, blocked: waiting } : base;
  };

  const fillRead = async (payload: Record<string, unknown>) => {
    const found = host.select(payload);
    if (!host.isElement(found)) return found;
    const aim = fillTarget(found);
    if ("stop" in aim) return notEditable(aim.stop);
    if ("many" in aim) return ambiguousField(aim.many);
    const field = aim.field;
    if (!host.live(field)) return blockedResult({ blocker: "detached" });
    // Five reads, until two in a row agree: a field a component rewrites
    // after its input event settles before the read answers.
    let read = fieldValue(field);
    for (let again = 1; again < READS; again++) {
      await new Promise((done) => setTimeout(done, READ_GAP_MS));
      if (!host.live(field)) return blockedResult({ blocker: "detached" });
      const next = fieldValue(field);
      if (next === read) break;
      read = next;
    }
    const hidden = host.secret(field);
    const previous = hidden
      ? (slot.__kamapathySecret ?? "")
      : String(payload.previous ?? "");
    const match = classifyFill(previous, String(payload.value ?? ""), read, {
      append: payload.append === true,
    });
    return {
      ok: true as const,
      match,
      ...(hidden
        ? { valueHidden: true as const }
        : { value: read.slice(0, MAX_VALUE) }),
      ...host.reboundResult(),
    };
  };

  const setDirectValue = (payload: Record<string, unknown>) => {
    const found = host.select(payload);
    if (!host.isElement(found)) return found;
    const aim = fillTarget(found);
    if ("stop" in aim) return notEditable(aim.stop);
    if ("many" in aim) return ambiguousField(aim.many);
    const field = aim.field;
    const setter = fillKindOf(field) === "direct" && valueSetter(field);
    if (!setter) return notEditable("kind");
    const stop = firstBlocker(field, "fill");
    if (stop) return blockedResult(stop);
    const value = String(payload.value ?? "");
    if (tagOf(field) === "select") {
      const refused = optionProblem(field as HTMLSelectElement, value);
      if (refused) return refused;
    }
    const previous = fieldValue(field);
    (field as HTMLElement).focus({ preventScroll: true });
    setter.call(field, value);
    const now = fieldValue(field);
    // The field's own sanitizer decides: a range must land on the value it
    // was given, and a colour may answer in its own case.
    const kept =
      now === value ||
      (tagOf(field) === "input" &&
        (field as HTMLInputElement).type === "color" &&
        now.toLowerCase() === value.toLowerCase());
    if (!kept) {
      setter.call(field, previous);
      return invalidValue();
    }
    fireEdit(field);
    return {
      ok: true as const,
      ...(host.secret(field)
        ? { valueHidden: true as const }
        : { value: now.slice(0, MAX_VALUE) }),
      ...host.reboundResult(),
    };
  };

  type Choice = { value?: string; label?: string; index?: number };
  const optionName = (option: HTMLOptionElement) =>
    cut(clean(option.label || option.text || option.value));
  const sameLabel = (option: HTMLOptionElement, label: string) =>
    (option.label || option.text).trim() === label.trim();
  // A string matches a value first, then a label; an object matches on every
  // field it carries.
  const matchOption = (options: HTMLOptionElement[], want: string | Choice) => {
    if (typeof want === "string")
      return (
        options.find((option) => option.value === want) ||
        options.find((option) => sameLabel(option, want))
      );
    return options.find((option, index) => {
      if (typeof want.value === "string" && option.value !== want.value)
        return false;
      if (typeof want.label === "string" && !sameLabel(option, want.label))
        return false;
      return !(typeof want.index === "number" && index !== want.index);
    });
  };
  const usable = (want: unknown) =>
    typeof want === "string" ||
    (!!want &&
      typeof want === "object" &&
      (typeof (want as Choice).value === "string" ||
        typeof (want as Choice).label === "string" ||
        typeof (want as Choice).index === "number"));
  const askedFor = (want: string | Choice) => {
    if (typeof want === "string") return cut(clean(want));
    if (typeof want.label === "string") return cut(clean(want.label));
    if (typeof want.value === "string") return cut(clean(want.value));
    return typeof want.index === "number" ? `#${want.index}` : "";
  };

  const selectChoose = (payload: Record<string, unknown>) => {
    const found = host.select(payload);
    if (!host.isElement(found)) return found;
    const aim = selectTarget(found);
    if ("stop" in aim)
      return failure(
        "No select at, for or inside the target.",
        "not_selectable",
      );
    if ("many" in aim) return ambiguousField(aim.many);
    const list = aim.field as HTMLSelectElement;
    const stop = firstBlocker(list, "select");
    if (stop) return blockedResult(stop);
    const wants = (payload.values as (string | Choice)[]) || [];
    if (!wants.every(usable)) {
      const fields = { field: "values" };
      return failure(
        "Each choice needs a value, a label or an index.",
        "invalid_field",
        fields,
      );
    }
    if (!list.multiple && wants.length > 1) {
      const fields = { field: "values" };
      return failure(
        "A single select takes one choice.",
        "invalid_field",
        fields,
      );
    }
    const options = Array.from(list.options);
    const chosen: HTMLOptionElement[] = [];
    for (const want of wants) {
      const option = matchOption(options, want);
      if (!option)
        return {
          ok: true as const,
          blocked: {
            blocker: "option_missing" as const,
            detail: askedFor(want),
          },
          options: options.slice(0, MAX_OPTIONS).map(optionName),
          ...host.reboundResult(),
        };
      chosen.push(option);
    }
    for (const option of options) option.selected = chosen.includes(option);
    // What the select holds afterwards: clearing a single select leaves the
    // option the page falls back to, which an agent needs to see.
    const values = Array.from(list.selectedOptions).map(
      (option) => option.value,
    );
    fireEdit(list);
    return { ok: true as const, values, ...host.reboundResult() };
  };

  const focusTarget = (payload: Record<string, unknown>) => {
    const found = host.select(payload);
    if (!host.isElement(found)) return found;
    const stop = firstBlocker(found, "focus");
    if (stop) return blockedResult(stop);
    const settled = { ok: true as const, ...host.reboundResult() };
    if (tryFocus(found)) return settled;
    const aim = focusAround(found);
    if ("stop" in aim)
      return failure(
        "Nothing focusable at, around or inside the target.",
        "not_focusable",
      );
    if ("many" in aim) return ambiguousField(aim.many);
    const inner = aim.field;
    const second = firstBlocker(inner, "focus");
    if (second) return blockedResult(second);
    return tryFocus(inner)
      ? settled
      : blockedResult({ blocker: "not_focused" });
  };

  // Section 5's paste, which never touches the system clipboard: the page is
  // offered the content in a DataTransfer of its own, and only the plain text
  // the main process inserts afterwards ever reaches a field.
  const pasteDispatch = (payload: Record<string, unknown>) => {
    const text = typeof payload.text === "string" ? payload.text : "";
    const html = typeof payload.html === "string" ? payload.html : undefined;
    const active = deepActive();
    // The walk ended at a frame this page cannot read, so the paste belongs
    // to a frame agents never reach.
    if (active && host.opaqueFrame(active)) return notEditable("frame");
    const at = active || document.body || document.documentElement;
    if (!at) return notEditable("none");
    const data = new DataTransfer();
    data.setData("text/plain", text);
    if (html !== undefined) data.setData("text/html", html);
    const event = new ClipboardEvent("paste", {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    // A handler that cancels the event took the content, whatever has focus.
    if (!at.dispatchEvent(event))
      return { ok: true as const, handled: "page" as const };
    if (controlKind(at) !== "editable") return notEditable("none");
    return { ok: true as const, handled: "none" as const };
  };

  return {
    actionPoint,
    stableBox,
    scrollRequest,
    viewport,
    focusedKind,
    fillPrepare,
    fillRead,
    setDirectValue,
    selectChoose,
    focusTarget,
    pasteDispatch,
  };
}
