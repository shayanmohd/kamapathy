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
  live(element: Element): boolean;
  normalizeText(text: string): string;
  failure(
    error: string,
    code?: string,
    fields?: Record<string, unknown>,
  ): Record<string, unknown>;
  reboundResult(): Record<string, unknown>;
}

export function actionOperations(host: ActionHost) {
  // Control and bidirectional formatting characters, which never reach an
  // agent's terminal.
  const MARKS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;
  const MAX_NAME = 120;
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
      const scaleX = local.width ? (top.right - top.left) / local.width : 1;
      const scaleY = local.height ? (top.bottom - top.top) / local.height : 1;
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
  const slot = globalThis as unknown as { __kamapathyScroll?: Mark };
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

  const actionPoint = (payload: Record<string, unknown>) => {
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

  const focusedKind = (_payload?: Record<string, unknown>) => {
    let active = document.activeElement;
    for (let depth = 0; active && depth < 32; depth++) {
      const inner =
        active.shadowRoot?.activeElement ||
        host.frameDocument(active)?.activeElement ||
        null;
      if (!inner) break;
      active = inner;
    }
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

  return { actionPoint, stableBox, scrollRequest, viewport, focusedKind };
}
