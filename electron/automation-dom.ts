import type { Decision, Invalid, Picked, Query } from "./agent/dom/select";
import type { SearchAst } from "./agent/selectors";

export interface SnapshotOptions {
  mode: "compact" | "full";
  selector?: string;
  root?: string;
  scope?: "page" | "viewport";
  format?: "list" | "outline";
  maxChars: number;
  maxControls: number;
  offsets?: { text: number; control: number; line: number };
  locators?: boolean;
  firstRef: number;
}
export interface ElementTarget {
  ref?: string;
  selector?: string;
  query?: Query;
  /** A frame owner the main process bound in this world, by its key. */
  owner?: string;
}
/**
 * What a read inside a frame group knows about the world around it: the
 * group root's frame path, the rank its owner carries, and the part of the
 * top viewport the owners can show, which `scope: "viewport"` keeps to.
 * The main process composes the reads, so it ranks controls across groups
 * and prefixes the local paths itself.
 */
export interface FrameContext {
  group: string;
  tier: number;
  area?: { left: number; top: number; right: number; bottom: number };
}
export type PageOperation =
  | "snapshot"
  | "elements"
  | "validate"
  | "target"
  | "click"
  | "fill"
  | "upload"
  | "focus"
  | "check"
  | "scroll"
  | "drag"
  | "input"
  | "frame"
  | "ready"
  | "frameIndex"
  | "frameBox"
  | "activeFrame"
  | "fetch";

// This complete function is serialized into a separate Chromium world. It has no
// imports, Node APIs, or access to the browser interface's preload bridge. The
// selector engine, the outline builder and the in-page fetch travel the same
// way, as arguments, so operations that resolve no selector, read no outline
// and fetch nothing work without them.
export function pageOperation(
  operation: PageOperation,
  payload: Record<string, unknown>,
  namespace: string,
  selectorEngine?: typeof import("./agent/dom/select").selectorEngine,
  outlineBuilder?: typeof import("./agent/dom/outline").outlineBuilder,
  fetchOperation?: typeof import("./agent/dom/fetch").fetchOperation,
) {
  // Section 8's fetch reads no element and keeps its own handles, so it
  // answers before any registry work.
  if (operation === "fetch")
    return fetchOperation!(
      payload.phase as import("./agent/dom/fetch").FetchPhase,
      payload,
    );
  // How a listed control looked, so its ref can follow the control when the
  // page draws it again. It lasts only as long as the document and namespace.
  type Fingerprint = {
    tag: string;
    role: string;
    type: string;
    label: string;
    group: string;
    context: string;
    selector: string;
    frame: string;
    url: string;
  };
  type Registry = {
    namespace: string;
    document: Document;
    elements: Map<string, Element>;
    refs: WeakMap<Element, string>;
    fingerprints: Map<string, Fingerprint>;
    secrets: WeakSet<Element>;
  };
  const world = globalThis as unknown as { __kamapathyReferences?: Registry };
  let registry = world.__kamapathyReferences;
  if (
    !registry ||
    registry.namespace !== namespace ||
    registry.document !== document
  ) {
    registry = {
      namespace,
      document,
      elements: new Map(),
      refs: new WeakMap(),
      fingerprints: new Map(),
      secrets: new WeakSet(),
    };
    // Kamapathy's own reads run under another namespace and leave the agent's
    // refs in place.
    if (operation !== "ready" && operation !== "frameIndex")
      world.__kamapathyReferences = registry;
  }
  const failure = (
    error: string,
    code = "element_action_failed",
    fields?: Record<string, unknown>,
  ) => ({
    ok: false as const,
    code,
    error,
    ...(fields === undefined ? {} : { fields }),
  });
  // Section 9's owner bindings: the main process names each frame's owner in
  // this world, so a read or an action can reach a frame through its owner.
  const frames = (
    globalThis as unknown as {
      __kamapathyFrames?: {
        byKey: Map<string, Element>;
        keyOf: WeakMap<Element, string>;
      };
    }
  ).__kamapathyFrames;
  const keyOfFrame = (element: Element) => frames?.keyOf.get(element);
  // What this read's group knows about the world around it.
  const frameContext = payload.frameContext as FrameContext | undefined;
  // Refs this operation moved to a control the page drew again.
  const rebound: string[] = [];
  const reboundResult = () => (rebound.length ? { rebound } : {});
  // A snapshot reads the same styles many times, so it keeps them while it
  // runs. Other operations read styles fresh, after page handlers run.
  let styles: Map<Element, CSSStyleDeclaration> | undefined;
  const docOf = (node: Node) => node.ownerDocument || (node as Document);
  const styleOf = (element: Element) => {
    let style = styles?.get(element);
    if (!style) {
      style = (docOf(element).defaultView || window).getComputedStyle(element);
      styles?.set(element, style);
    }
    return style;
  };
  // Elements inside a same-origin frame belong to that frame's realm, where
  // instanceof against this document's constructors is false, so kinds of
  // elements are told apart by tag.
  const html = (element: Element | null): element is HTMLElement =>
    !!element && element.namespaceURI === "http://www.w3.org/1999/xhtml";
  const isElement = (value: unknown): value is Element =>
    !!value && (value as Node).nodeType === 1;
  const inputElement = (element: Element): element is HTMLInputElement =>
    element.localName === "input" && html(element);
  const textAreaElement = (
    element: Element,
  ): element is HTMLTextAreaElement =>
    element.localName === "textarea" && html(element);
  const selectElement = (element: Element): element is HTMLSelectElement =>
    element.localName === "select" && html(element);
  // The document of a frame this page may read: one from the same origin.
  const frameDocument = (element: Element) =>
    element.localName === "iframe" || element.localName === "frame"
      ? (element as HTMLIFrameElement).contentDocument
      : null;
  // A frame whose document this world cannot read, such as a payment form
  // from another origin. The main process reads it through its own world.
  const opaqueFrame = (element: Element) =>
    (element.localName === "iframe" || element.localName === "frame") &&
    !frameDocument(element);
  // A frame from another origin this small is a tracking pixel, not content a
  // person sees, so it is left out of the text, the controls and the outline.
  // The frame numbering counts it either way, so no path moves.
  const TINY_FRAME = 4;
  const listedFrame = (element: Element) => {
    if (!opaqueFrame(element)) return false;
    const box = element.getBoundingClientRect();
    return box.width >= TINY_FRAME && box.height >= TINY_FRAME;
  };
  // The frame elements around a document, outermost first, or undefined once
  // it is no longer shown in this page.
  const framesOfDoc = (doc: Document) => {
    const frames: Element[] = [];
    for (let current = doc; current !== document; ) {
      const frame = current.defaultView?.frameElement;
      if (!frame?.isConnected) return undefined;
      frames.unshift(frame);
      current = docOf(frame);
    }
    return frames;
  };
  // The same for the document an element belongs to.
  const framesOf = (element: Element) => framesOfDoc(docOf(element));
  const live = (element: Element) =>
    element.isConnected && framesOf(element) !== undefined;
  // The frames of one document in the order a person sees them, through open
  // shadow roots, which querySelectorAll does not enter. A component hosting
  // a frame in its shadow root would otherwise leave that frame out of the
  // frame paths, the input counters and selector searches.
  const frameLists = new Map<Document, Element[]>();
  const framesIn = (doc: Document) => {
    let frames = frameLists.get(doc);
    if (!frames) {
      const found: Element[] = [];
      walk(doc, (node) => {
        if (
          !isElement(node) ||
          (node.localName !== "iframe" && node.localName !== "frame")
        )
          return;
        found.push(node);
        return false;
      });
      frameLists.set(doc, (frames = found));
    }
    return frames;
  };
  // This document, then every same-origin frame document, depth first.
  let docs: Document[] | undefined;
  const documents = () => {
    if (!docs) {
      const found: Document[] = [];
      const collect = (doc: Document) => {
        found.push(doc);
        for (const frame of framesIn(doc)) {
          const inner = frameDocument(frame);
          if (inner) collect(inner);
        }
      };
      collect(document);
      docs = found;
    }
    return docs;
  };
  // A selector resolves in this document first, then in the frames it can
  // read, depth first, and the first document where it matches decides.
  const matching = (selector: string) => {
    for (const doc of documents()) {
      const found = Array.from(doc.querySelectorAll(selector));
      if (found.length) return found;
    }
    return [] as Element[];
  };
  // Frames are named by their index among the frames of the document around
  // them, such as "0" or "0/1" for a frame inside the first frame.
  const framePath = (element: Element) =>
    (framesOf(element) || [])
      .map((frame) => framesIn(docOf(frame)).indexOf(frame))
      .join("/");
  // The path a frame's own document carries, counted from this world's
  // document: the path of the document around it, then its index there.
  const contentPath = (frame: Element) => {
    const index = framesIn(docOf(frame)).indexOf(frame);
    const around = framePath(frame);
    return around ? `${around}/${index}` : `${index}`;
  };
  const documentAt = (path: string) => {
    let doc: Document | null = document;
    for (const index of path ? path.split("/") : []) {
      const frame: Element | undefined = framesIn(doc)[Number(index)];
      doc = frame ? frameDocument(frame) : null;
      if (!doc) return null;
    }
    return doc;
  };
  // The element around another as a person sees the page: its parent, the
  // host of its shadow root, or the frame showing its document.
  const parentOf = (element: Element): Element | null =>
    element.parentElement ||
    (element.getRootNode() as ShadowRoot).host ||
    docOf(element).defaultView?.frameElement ||
    null;
  // Whether a node is an element or drawn inside it, through shadow roots
  // and frames, which contains does not cross.
  const within = (element: Element, hit: Node | null) => {
    for (let node = hit; node; ) {
      if (node === element) return true;
      node =
        node.nodeType === 11
          ? (node as ShadowRoot).host
          : node.nodeType === 9
            ? (node as Document).defaultView?.frameElement || null
            : node.parentNode;
    }
    return false;
  };
  // Visits nodes in the order a person sees them: through open shadow roots,
  // with slotted content where its slot is, and into same-origin frames. A
  // visit returning false keeps the walk out of that element's subtree.
  const walk = (root: Node, visit: (node: Node) => boolean | void) => {
    const into = (nodes: Iterable<Node>) => {
      for (const node of nodes) step(node);
    };
    const descend = (element: Element) => {
      const inner = frameDocument(element);
      if (element.shadowRoot) into(element.shadowRoot.childNodes);
      else if (element.localName === "slot") {
        const assigned = (element as HTMLSlotElement).assignedNodes({
          flatten: true,
        });
        into(assigned.length ? assigned : element.childNodes);
      } else if (inner) into(inner.childNodes);
      else if (!opaqueFrame(element)) into(element.childNodes);
    };
    const step = (node: Node) => {
      if (node.nodeType === 3) visit(node);
      else if (node.nodeType === 1 && visit(node) !== false)
        descend(node as Element);
    };
    if (root.nodeType === 1) descend(root as Element);
    else into(root.childNodes);
  };
  // Where a frame's document begins inside the document around it, and how
  // much a CSS transform or zoom on the frame scales what it shows: its drawn
  // size against its layout size.
  const frameOrigin = (frame: Element) => {
    const box = frame.getBoundingClientRect();
    const style = styleOf(frame);
    const { offsetWidth, offsetHeight } = frame as HTMLElement;
    const scaleX = offsetWidth ? box.width / offsetWidth : 1;
    const scaleY = offsetHeight ? box.height / offsetHeight : 1;
    return {
      x: box.left + (frame.clientLeft + parseFloat(style.paddingLeft)) * scaleX,
      y: box.top + (frame.clientTop + parseFloat(style.paddingTop)) * scaleY,
      scaleX,
      scaleY,
    };
  };
  // Where a box of a document sits in the top viewport, through the frames
  // around it, and the part of that viewport those frames can show.
  const placedRect = (doc: Document, box: DOMRect) => {
    const clip = frameContext?.area
      ? { ...frameContext.area }
      : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    let x = 0,
      y = 0,
      scaleX = 1,
      scaleY = 1;
    for (const frame of framesOfDoc(doc) || []) {
      const origin = frameOrigin(frame);
      x += origin.x * scaleX;
      y += origin.y * scaleY;
      scaleX *= origin.scaleX;
      scaleY *= origin.scaleY;
      const inner = frameDocument(frame)?.documentElement;
      clip.left = Math.max(clip.left, x);
      clip.top = Math.max(clip.top, y);
      clip.right = Math.min(
        clip.right,
        x + (inner || frame).clientWidth * scaleX,
      );
      clip.bottom = Math.min(
        clip.bottom,
        y + (inner || frame).clientHeight * scaleY,
      );
    }
    return {
      left: x + box.left * scaleX,
      top: y + box.top * scaleY,
      right: x + box.right * scaleX,
      bottom: y + box.bottom * scaleY,
      clip,
    };
  };
  // Where a frame owner shows its document in this world's viewport, at what
  // scale, and the part of the viewport it can show: the frames around the
  // owner's document, then the owner itself. placedRect does the same for a
  // box of a document; this follows one boundary further, into the content.
  const ownerPlacement = (owner: Element) => {
    const clip = frameContext?.area
      ? { ...frameContext.area }
      : { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    let x = 0,
      y = 0,
      scaleX = 1,
      scaleY = 1,
      width = 0,
      height = 0;
    for (const frame of [...(framesOfDoc(docOf(owner)) || []), owner]) {
      const origin = frameOrigin(frame);
      x += origin.x * scaleX;
      y += origin.y * scaleY;
      scaleX *= origin.scaleX;
      scaleY *= origin.scaleY;
      const inner = frameDocument(frame)?.documentElement;
      width = (inner || frame).clientWidth;
      height = (inner || frame).clientHeight;
      clip.left = Math.max(clip.left, x);
      clip.top = Math.max(clip.top, y);
      clip.right = Math.min(clip.right, x + width * scaleX);
      clip.bottom = Math.min(clip.bottom, y + height * scaleY);
    }
    return { x, y, scaleX, scaleY, width, height, area: clip };
  };
  // Where an element sits in the top viewport.
  const placed = (element: Element) =>
    placedRect(docOf(element), element.getBoundingClientRect());
  // Whether a box meets the part of the viewport its frames can show.
  const onScreenBox = (box: ReturnType<typeof placedRect>) =>
    box.bottom > box.clip.top &&
    box.right > box.clip.left &&
    box.top < box.clip.bottom &&
    box.left < box.clip.right;
  const onScreen = (element: Element) => onScreenBox(placed(element));
  // A control with no box of its own, such as a file input inside visible
  // upload UI, is on screen where the element around it is.
  const drawnOnScreen = (element: Element) =>
    onScreen(
      element.getClientRects().length
        ? element
        : element.parentElement || element,
    );
  // What a pointer at a point of the top viewport lands on: the element's
  // frame in every document around it, then the innermost element in its
  // own document, through open shadow roots.
  const hitAt = (element: Element, x: number, y: number) => {
    const deep = (root: Document | ShadowRoot) => {
      let hit = root.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const inner = hit.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === hit) break;
        hit = inner;
      }
      return hit;
    };
    for (const frame of framesOf(element) || []) {
      if (deep(docOf(frame)) !== frame) return null;
      const origin = frameOrigin(frame);
      x = (x - origin.x) / origin.scaleX;
      y = (y - origin.y) / origin.scaleY;
    }
    return deep(docOf(element));
  };
  // aria-hidden removes content from assistive technology, not from the
  // screen. Page text includes it, because component libraries put visible
  // labels and questions there. Controls under it stay excluded, as a modal
  // hides the page behind it this way.
  const visible = (element: Element, includeAriaHidden = false) => {
    if (!element.isConnected) return false;
    const hiding = includeAriaHidden
      ? "[hidden],[inert]"
      : '[hidden],[inert],[aria-hidden="true"]';
    const style = styleOf(element);
    // Ancestors are followed through shadow roots and frames, checking the
    // hiding attributes once per tree, where closest stops.
    let ancestor: Element | null = element;
    let boundary = true;
    while (ancestor) {
      if (boundary && ancestor.closest(hiding)) return false;
      if (
        ancestor.localName === "details" &&
        !(ancestor as HTMLDetailsElement).open &&
        ancestor !== element
      ) {
        const summary = Array.from(ancestor.children).find(
          (child) => child.localName === "summary",
        );
        if (!summary?.contains(element)) return false;
      }
      const inherited = styleOf(ancestor);
      // Component libraries draw their own box and keep the real checkbox or
      // radio on top of it at opacity 0, where it still takes the click.
      const transparentControl =
        ancestor === element &&
        inputElement(element) &&
        (element.type === "checkbox" || element.type === "radio");
      if (
        (inherited.opacity === "0" && !transparentControl) ||
        inherited.display === "none" ||
        inherited.contentVisibility === "hidden"
      )
        return false;
      // Visibility does not inherit into a frame's document, so the frame
      // showing it is checked itself.
      if (
        ancestor !== element &&
        frameDocument(ancestor) &&
        /^(hidden|collapse)$/.test(inherited.visibility)
      )
        return false;
      boundary = !ancestor.parentElement;
      ancestor = parentOf(ancestor);
    }
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      element.getClientRects().length > 0
    );
  };
  // Icon fonts draw a name such as "arrow_drop_down" as one glyph. Pages mark
  // these icons aria-hidden, whose other text a person reads.
  const iconName = (node: Node, parent: Element) =>
    /^\s*[a-z0-9_]+\s*$/.test(node.textContent || "") &&
    !!parent.closest('[aria-hidden="true"]') &&
    /material (icons|symbols)|google symbols/i.test(
      styleOf(parent).fontFamily,
    );
  const pageText = (
    scope: Element,
    maximum = Infinity,
    onlyOnScreen = false,
  ) => {
    let text = "",
      previousBlock: Element | null = null;
    let previousRect: DOMRect | undefined;
    walk(scope, (node) => {
      if (text.length > maximum) return false;
      if (node.nodeType !== 3) return;
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest(
          "script,style,noscript,template,input,textarea,select",
        ) ||
        (html(parent) && parent.isContentEditable) ||
        !visible(parent, true) ||
        iconName(node, parent)
      )
        return;
      const range = docOf(node).createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      );
      if (!rects.length) return;
      // A run of text is on screen when one of its rectangles is.
      if (
        onlyOnScreen &&
        !rects.some((rect) => onScreenBox(placedRect(docOf(node), rect)))
      )
        return;
      let block = parent;
      while (
        block.parentElement &&
        ["inline", "inline-block", "contents"].includes(styleOf(block).display)
      )
        block = block.parentElement;
      const value = /^(pre|break-spaces)/.test(styleOf(parent).whiteSpace)
        ? node.textContent || ""
        : (node.textContent || "").replace(/\s+/g, " ");
      if (
        text &&
        (previousBlock !== block ||
          (previousRect && rects[0].top >= previousRect.bottom - 1))
      )
        text += "\n";
      else if (
        text &&
        previousRect &&
        rects[0].left > previousRect.right + 1 &&
        !/\s$/.test(text) &&
        !/^\s/.test(value)
      )
        text += " ";
      text += value.slice(0, Math.max(0, maximum + 1 - text.length));
      previousBlock = block;
      previousRect = rects.at(-1);
    });
    return text;
  };
  // Sites commonly hide the actual input behind a visible upload panel. Expose
  // its metadata only while its containing UI is visible, never in closed UI.
  const uploadControl = (element: Element) =>
    inputElement(element) && element.type === "file" &&
    element.isConnected && !element.closest('[inert],[aria-hidden="true"]') &&
    (visible(element) || (!!element.parentElement && visible(element.parentElement)));
  const PAGE_CHANGED =
    "The page changed during this operation. Take a new snapshot.";
  const NO_TARGET = "Provide an element reference or a selector.";
  const disabledElement = (element: Element) =>
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled") === "true";
  // Whether something else draws over the middle of the part of an element
  // a person can see. Nothing off screen and nothing without size counts.
  const covered = (element: Element) => {
    const box = placed(element);
    const left = Math.max(box.clip.left, box.left),
      right = Math.min(box.clip.right, box.right);
    const top = Math.max(box.clip.top, box.top),
      bottom = Math.min(box.clip.bottom, box.bottom);
    if (right <= left || bottom <= top) return false;
    return !within(
      element,
      hitAt(element, (left + right) / 2, (top + bottom) / 2),
    );
  };
  const editingHost = (element: Element) => {
    if (!html(element) || !element.isContentEditable) return false;
    const parent = element.parentElement;
    return !(html(parent) && parent.isContentEditable);
  };
  let engine: ReturnType<NonNullable<typeof selectorEngine>> | undefined;
  const engineOf = () =>
    (engine ||= selectorEngine!({
      documents,
      visible,
      disabled: disabledElement,
      covered,
      editingHost,
    }));
  // The nodes a role resolution left for this operation, taken once.
  const takePicked = (key: string | undefined) => {
    const store = (
      globalThis as unknown as { __kamapathyPicked?: Map<string, Picked[]> }
    ).__kamapathyPicked;
    const entries = key === undefined ? undefined : store?.get(key);
    if (entries) store?.delete(key!);
    return entries;
  };
  const pickedFor = (query: Query): readonly Picked[] | undefined | null =>
    query.ast.kind === "role" ? (takePicked(query.picked) ?? null) : undefined;
  // Role words agents write that name a different role here.
  const ROLE_ALIASES: Record<string, string> = {
    textfield: "textbox",
    listboxoption: "option",
    menulistoption: "option",
    image: "img",
  };
  // The role word an element carries: the same word role= matches.
  const roleOf = (element: Element): string => {
    const explicit = (element.getAttribute("role") || "")
      .trim()
      .split(/\s+/)[0]
      .toLowerCase();
    if (explicit && explicit !== "none" && explicit !== "presentation")
      return ROLE_ALIASES[explicit] || explicit;
    const tag = element.localName;
    if ((tag === "a" || tag === "area") && element.hasAttribute("href"))
      return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (inputElement(element)) {
      const type = element.type;
      if (type === "hidden") return "none";
      if (type === "checkbox" || type === "radio") return type;
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (
        ["button", "submit", "reset", "image", "file", "color"].includes(type)
      )
        return "button";
      if (element.hasAttribute("list")) return "combobox";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (selectElement(element))
      return element.multiple || element.size > 1 ? "listbox" : "combobox";
    if (textAreaElement(element)) return "textbox";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    if (editingHost(element)) return "textbox";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "ul" || tag === "ol" || tag === "menu") return "list";
    if (tag === "li") return "listitem";
    if (tag === "table") return "table";
    if (tag === "tr") return "row";
    if (tag === "td") return "cell";
    if (tag === "th")
      return element.getAttribute("scope") === "row"
        ? "rowheader"
        : "columnheader";
    if (tag === "nav") return "navigation";
    if (tag === "main") return "main";
    if (tag === "aside") return "complementary";
    if (tag === "header" || tag === "footer")
      return element.parentElement?.closest("article,aside,main,nav,section")
        ? "generic"
        : tag === "header"
          ? "banner"
          : "contentinfo";
    if (tag === "search") return "search";
    if (tag === "form") return "form";
    if (tag === "section") return "region";
    if (tag === "dialog") return "dialog";
    if (tag === "fieldset" || tag === "details") return "group";
    if (tag === "iframe" || tag === "frame") return "iframe";
    return tag;
  };
  // The ref numbers this operation handed out, beyond a snapshot's own.
  const issuedRefs: number[] = [];
  // What an agent needs to tell matches apart, with a ref to act on. An
  // element that already holds a ref keeps it.
  const candidatesOf = (found: Element[], firstRef: number | undefined) => {
    let next = firstRef;
    return found.map((element) => {
      let ref = registry.refs.get(element);
      if (
        (!ref || registry.elements.get(ref) !== element) &&
        next !== undefined
      ) {
        ref = `@e${next}`;
        issuedRefs.push(next++);
        registry.refs.set(element, ref);
        registry.elements.set(ref, element);
      }
      const frame = framePath(element);
      return {
        ...(ref === undefined ? {} : { ref }),
        tag: element.localName,
        role: roleOf(element),
        name: labelOf(element).slice(0, 80),
        context: contextOf(element).slice(0, 80),
        visible: visible(element, true),
        disabled: disabledElement(element),
        ...(frame ? { frame } : {}),
      };
    });
  };
  const invalidSelector = (selector: string, result: Invalid) => {
    const fields = {
      selector,
      reason: result.reason,
      ...(result.hint === undefined ? {} : { hint: result.hint }),
    };
    return failure(result.message, "invalid_selector", fields);
  };
  // How every operation reports a resolution that gave it no element.
  const selectFailure = (
    selector: string,
    decision: Exclude<Decision, { kind: "match" }>,
    firstRef: number | undefined,
  ) => {
    if (decision.kind === "invalid") return invalidSelector(selector, decision);
    if (decision.kind === "none") {
      const fields = { selector };
      return failure(
        "Nothing on the page matches this selector. Take a snapshot to check the page.",
        "no_match",
        fields,
      );
    }
    if (decision.kind === "blocked")
      return {
        ...failure(
          decision.blocker === "hidden"
            ? "Element is not visible."
            : "Element is disabled.",
        ),
        blocked: { blocker: decision.blocker },
      };
    const { count, visible: shown, hidden } = decision.tally;
    const fields = {
      selector,
      ...decision.tally,
      candidates: candidatesOf(decision.candidates, firstRef),
    };
    const result = failure(
      `Selector matched ${count} elements (${shown} visible, ${hidden} hidden). Use a ref from candidates or a more specific selector.`,
      "ambiguous_match",
      fields,
    );
    return issuedRefs.length ? { ...result, issued: issuedRefs } : result;
  };
  // A target the main process parsed: the engine decides, and the element it
  // picks goes through the same checks a ref does.
  const select = (spec: { selector: string; query: Query }) => {
    const picked = pickedFor(spec.query);
    if (picked === null) return failure(PAGE_CHANGED, "page_changed");
    const decision = engineOf().decide(spec.query, picked);
    return decision.kind === "match"
      ? decision.element
      : selectFailure(spec.selector, decision, spec.query.firstRef);
  };
  const target = (spec = payload as ElementTarget) => {
    if (typeof spec.owner === "string") {
      const owner = frames?.byKey.get(spec.owner);
      return owner && live(owner)
        ? owner
        : failure(PAGE_CHANGED, "page_changed");
    }
    if (typeof spec.ref === "string") {
      const element = registry.elements.get(spec.ref);
      if (element && live(element)) return element;
      const replacement = rebind(spec.ref);
      if (replacement) {
        registry.elements.set(spec.ref, replacement);
        registry.refs.set(replacement, spec.ref);
        rebound.push(spec.ref);
        return replacement;
      }
      registry.elements.delete(spec.ref);
      registry.fingerprints.delete(spec.ref);
      return failure(
        "Element reference is stale. Take a new snapshot.",
        "stale_ref",
        { ref: spec.ref },
      );
    }
    if (typeof spec.selector === "string" && spec.query) {
      return select({ selector: spec.selector, query: spec.query });
    }
    return failure(NO_TARGET, "invalid_target");
  };
  // Where a listed link goes: an absolute web, mail or phone address. A
  // script link and an address over 2,048 characters carry none.
  const hrefOf = (element: Element) => {
    if (!html(element) || !element.matches("a[href],area[href]")) return {};
    const link = element as HTMLAnchorElement;
    return ["http:", "https:", "mailto:", "tel:"].includes(link.protocol) &&
      link.href.length <= 2048
      ? { href: link.href }
      : {};
  };
  const selectorFor = (element: Element) => {
    if (element.id && element.id.length <= 512) {
      const found = matching(`#${CSS.escape(element.id)}`);
      if (found.length === 1 && found[0] === element)
        return `#${CSS.escape(element.id)}`;
    }
    const path: string[] = [];
    let current: Element | null = element;
    while (
      current &&
      current !== docOf(current).documentElement &&
      path.length < 32
    ) {
      const tag = current.localName;
      const siblings: Element[] = current.parentElement
        ? Array.from(current.parentElement.children).filter(
            (sibling) => sibling.localName === tag,
          )
        : [];
      path.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
      current = current.parentElement;
    }
    return path.join(" > ");
  };
  // Native controls and the ARIA roles people operate directly. Lists, menus
  // and tab strips are listed through their items.
  const controlQuery = [
    "a[href]",
    "button",
    "summary",
    'input:not([type="hidden"])',
    "textarea",
    "select",
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[contenteditable="plaintext-only"]',
    ...[
      "button",
      "link",
      "checkbox",
      "radio",
      "combobox",
      "option",
      "listbox",
      "menuitem",
      "menuitemcheckbox",
      "menuitemradio",
      "tab",
      "switch",
      "textbox",
      "searchbox",
      "slider",
      "spinbutton",
      "treeitem",
    ].map((role) => `[role="${role}"]`),
  ].join(",");
  const popupTrigger = '[aria-haspopup]:not([aria-haspopup="false"])';
  const popup =
    'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[role="listbox"],[role="menu"],:popover-open';
  // An element a person can drag, such as an item of a reorderable list.
  const draggable = '[draggable="true"]';
  const query = `${controlQuery},${popupTrigger},${draggable},[tabindex]`;
  // A custom element that takes keyboard focus is a component acting as a
  // control, such as a Material button or select item.
  const isControl = (element: Element) =>
    element.matches(controlQuery) ||
    element.matches(popupTrigger) ||
    element.matches(draggable) ||
    listedFrame(element) ||
    (element.localName.includes("-") &&
      element.hasAttribute("tabindex") &&
      (element as HTMLElement).tabIndex >= 0);
  const insideControl = (element: Element) => {
    for (
      let match = element.closest(query);
      match;
      match = match.parentElement?.closest(query) ?? null
    )
      if (isControl(match)) return true;
    return false;
  };
  const clean = (value: string | null | undefined) =>
    (value || "").replace(/\s+/g, " ").trim();
  // Text an element carries itself, without the icons it marks aria-hidden.
  // Icon fonts render names such as "upload" in text, which would otherwise
  // turn a button's label into "uploadUpload".
  const ownText = (element: Element) => {
    let text = "";
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const hidden = node.parentElement?.closest(
        '[aria-hidden="true"],script,style',
      );
      if (!hidden || !element.contains(hidden)) text += node.textContent;
    }
    return clean(text);
  };
  // The choice a custom select shows as its own text. A select whose list
  // opens inside it, as Angular Material's does, also holds the options, and
  // their text is not its value.
  const shownText = (element: Element) => {
    let text = "";
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const inner = node.parentElement?.closest(
        `[aria-hidden="true"],script,style,${popup},${controlQuery}`,
      );
      if (!inner || inner === element || !element.contains(inner))
        text += node.textContent;
    }
    return clean(text);
  };
  const labelledBy = (element: Element) =>
    clean(
      (element.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((id) => {
          // Ids resolve in the element's own tree, such as its shadow root.
          const root = element.getRootNode() as Document;
          const source =
            id && root.getElementById ? root.getElementById(id) : null;
          return source ? ownText(source) || clean(source.textContent) : "";
        })
        .join(" "),
    );
  const fieldLike = (element: Element) =>
    (inputElement(element) &&
      !["submit", "reset", "button", "image"].includes(element.type)) ||
    textAreaElement(element) ||
    selectElement(element) ||
    (html(element) && element.isContentEditable) ||
    [
      "textbox",
      "searchbox",
      "combobox",
      "spinbutton",
      "slider",
      "switch",
      "checkbox",
      "radio",
    ].includes(element.getAttribute("role") || "");
  // The name a page gives a control, then what a person sees beside it. It
  // depends only on the element and page, not on the rest of a snapshot.
  const labelOf = (element: Element) => {
    if (opaqueFrame(element)) {
      const src = element.getAttribute("src") || "";
      let host = "";
      try {
        host = src ? new URL(src, location.href).host : "";
      } catch {}
      return (
        clean(element.getAttribute("title")) ||
        clean(element.getAttribute("name")) ||
        host
      ).slice(0, 200);
    }
    const field = element as HTMLInputElement;
    let label =
      clean(element.getAttribute("aria-label")) ||
      labelledBy(element) ||
      clean(
        field.labels
          ? Array.from(field.labels)
              .map((source) =>
                source.querySelector('[aria-hidden="true"]')
                  ? ownText(source) || source.innerText
                  : source.innerText,
              )
              .join(" ")
          : "",
      ) ||
      clean(element.getAttribute("placeholder"));
    if (!label) {
      if (
        inputElement(element) &&
        ["submit", "reset", "button"].includes(element.type)
      )
        label = clean(
          element.value ||
            (element.type === "submit"
              ? "Submit"
              : element.type === "reset"
                ? "Reset"
                : ""),
        );
      else if (inputElement(element) && element.type === "image")
        label = clean(element.alt);
      else if (
        !inputElement(element) &&
        !textAreaElement(element) &&
        !selectElement(element) &&
        !(html(element) && element.isContentEditable)
      )
        label =
          element.getAttribute("role") === "combobox"
            ? shownText(element)
            : ["textbox", "searchbox", "spinbutton", "slider"].includes(
                  element.getAttribute("role") || "",
                )
              ? ""
              : ownText(element);
    }
    label ||= clean(element.getAttribute("title"));
    // An icon-only control is best named by its icon.
    if (!label && !fieldLike(element)) label = clean(element.textContent);
    // A question drawn beside a field, without being tied to it, names the
    // field when their shared container holds no other control.
    for (
      let container = fieldLike(element) ? element.parentElement : null,
        depth = 0;
      !label && container && container !== docOf(container).body && depth < 6;
      container = container.parentElement, depth++
    ) {
      if (
        Array.from(container.querySelectorAll(query)).some(
          (other) =>
            other !== element &&
            !element.contains(other) &&
            isControl(other) &&
            visible(other),
        )
      )
        break;
      // A custom text field's own text is its value, not its name.
      const own = clean(pageText(element, 200));
      label = clean(
        own
          ? clean(pageText(container, 400)).replace(own, "")
          : pageText(container, 200),
      );
    }
    return label.slice(0, 200);
  };
  // The nearest text before a set of choices, such as the question above
  // radio buttons a component library draws without a name.
  const textBefore = (container: Element, first: Element) => {
    let root = container;
    for (
      let depth = 0;
      depth < 3 && root.parentElement && root !== docOf(root).body;
      depth++
    )
      root = root.parentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    walker.currentNode = first;
    for (
      let node = walker.previousNode(), steps = 0;
      node && steps < 200;
      node = walker.previousNode(), steps++
    ) {
      const parent = node.parentElement;
      if (
        !parent ||
        !clean(node.textContent) ||
        parent.closest(
          "script,style,noscript,template,input,textarea,select",
        ) ||
        insideControl(parent) ||
        parent.closest("label")?.control ||
        !visible(parent, true) ||
        iconName(node, parent)
      )
        continue;
      let block = parent;
      while (
        block !== root &&
        block.parentElement &&
        ["inline", "inline-block", "contents"].includes(
          styleOf(block).display,
        )
      )
        block = block.parentElement;
      return block.contains(first)
        ? clean(node.textContent)
        : clean(pageText(block, 200));
    }
    return "";
  };
  const groups = new Map<Element, string>();
  // The question a radio button or checkbox answers with its neighbors: a
  // fieldset legend, a named group, or the text before the choices.
  const groupOf = (element: Element) => {
    const role = element.getAttribute("role");
    const native =
      inputElement(element) &&
      (element.type === "radio" || element.type === "checkbox");
    if (!native && role !== "radio" && role !== "checkbox") return "";
    const choices =
      'input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]';
    let container = element.parentElement?.closest(
      'fieldset,[role="radiogroup"],[role="group"]',
    );
    let first = container?.querySelector(choices);
    // Radio buttons sharing a name are one group wherever they are drawn.
    if (!container && native && element.type === "radio" && element.name) {
      const peers = Array.from(
        docOf(element).getElementsByName(element.name),
      ).filter(
        (peer) =>
          inputElement(peer) &&
          peer.type === element.type &&
          peer.form === element.form,
      );
      if (peers.length > 1) {
        container = element.parentElement;
        while (container && !peers.every((peer) => container!.contains(peer)))
          container = container.parentElement;
        first = peers[0];
      }
    }
    if (!container || !first) return "";
    let name = groups.get(container);
    if (name === undefined) {
      const legend = Array.from(container.children).find(
        (child) => child.localName === "legend",
      );
      name =
        clean(container.getAttribute("aria-label")) ||
        labelledBy(container) ||
        (legend ? ownText(legend) || clean(legend.textContent) : "") ||
        textBefore(container, first);
      groups.set(container, name);
    }
    return name.slice(0, 200);
  };
  // Checked, selected, expanded and pressed states, from native controls and
  // the ARIA attributes component libraries set.
  const stateOf = (element: Element) => {
    const role = element.getAttribute("role") || "";
    const aria = (name: string) => {
      const value = element.getAttribute(name);
      return value === "true"
        ? true
        : value === "false"
          ? false
          : value === "mixed"
            ? ("mixed" as const)
            : undefined;
    };
    const state: {
      checked?: boolean | "mixed";
      selected?: boolean;
      expanded?: boolean;
      pressed?: boolean | "mixed";
    } = {};
    if (
      inputElement(element) &&
      (element.type === "checkbox" || element.type === "radio")
    )
      state.checked =
        element.type === "checkbox" && element.indeterminate
          ? "mixed"
          : element.checked;
    else if (
      [
        "checkbox",
        "radio",
        "switch",
        "menuitemcheckbox",
        "menuitemradio",
        "option",
      ].includes(role)
    ) {
      const checked = aria("aria-checked");
      if (checked !== undefined) state.checked = checked;
      else if (role !== "option") state.checked = false;
    }
    if (["option", "tab", "treeitem"].includes(role)) {
      const selected = aria("aria-selected");
      if (typeof selected === "boolean") state.selected = selected;
    }
    const expanded =
      element.localName === "summary" &&
      element.parentElement?.localName === "details"
        ? (element.parentElement as HTMLDetailsElement).open
        : aria("aria-expanded");
    if (typeof expanded === "boolean") state.expanded = expanded;
    const pressed = aria("aria-pressed");
    if (pressed !== undefined) state.pressed = pressed;
    return state;
  };
  // Passwords, one-time codes and payment card fields never show a value, even
  // after a "show password" toggle turns the field into plain text.
  const secretName = /(^|[^a-z])(pass(word|wd|code|phrase)?|pwd|otp|cvc|cvv|pin)([^a-z]|$)/i;
  const secretField = (element: Element) =>
    (inputElement(element) && element.type === "password") ||
    secretName.test(`${element.getAttribute("name") || ""} ${element.id}`) ||
    (element.getAttribute("autocomplete") || "")
      .toLowerCase()
      .split(/\s+/)
      .some(
        (token) =>
          ["current-password", "new-password", "one-time-code"].includes(
            token,
          ) || token.startsWith("cc-"),
      ) ||
    !["", "none"].includes(
      styleOf(element).getPropertyValue("-webkit-text-security"),
    );
  const secret = (element: Element) => {
    if (registry.secrets.has(element)) return true;
    const hidden = secretField(element);
    if (hidden) registry.secrets.add(element);
    return hidden;
  };
  // A field's current value, so an agent can check what it filled.
  const valueOf = (element: Element) => {
    const role = element.getAttribute("role");
    if (inputElement(element))
      return [
        "text",
        "search",
        "tel",
        "url",
        "email",
        "password",
        "number",
        "date",
        "time",
        "datetime-local",
        "month",
        "week",
        "range",
        "color",
      ].includes(element.type)
        ? element.value
        : undefined;
    if (textAreaElement(element)) return element.value;
    if (selectElement(element))
      return element.multiple ? undefined : element.value;
    if (html(element) && element.isContentEditable) return element.innerText;
    if (role === "slider" || role === "spinbutton")
      return (
        element.getAttribute("aria-valuetext") ||
        element.getAttribute("aria-valuenow") ||
        ""
      );
    if (role === "combobox") return shownText(element);
    if ((role === "textbox" || role === "searchbox") && html(element))
      return element.innerText;
    return undefined;
  };
  // The first 200 characters of an element's text, without field contents.
  const leadingText = (element: Element) => {
    let text = "";
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (
      let node = walker.nextNode();
      node && text.length < 400;
      node = walker.nextNode()
    ) {
      const parent = node.parentElement;
      if (
        parent &&
        !parent.closest("script,style,noscript,template,textarea") &&
        !(html(parent) && parent.isContentEditable)
      )
        text += node.textContent;
    }
    return clean(text).slice(0, 200);
  };
  // Text around a control that tells it apart from controls with the same
  // label, such as the Remove buttons of different rows.
  const contextOf = (element: Element) => {
    const own = leadingText(element);
    for (
      let ancestor = element.parentElement, depth = 0;
      ancestor && depth < 4;
      ancestor = ancestor.parentElement, depth++
    ) {
      const text = leadingText(ancestor);
      if (text !== own) return text;
    }
    return "";
  };
  // A ref whose element the page replaced follows the control drawn in its
  // place: the same kind of control with the same label, question and
  // surrounding text, on the same URL, that no other ref holds. The element at
  // the old position comes first, then a single match anywhere. Anything less
  // certain stays stale. A snapshot records no fingerprint for a control that
  // looked like another one, and a file input is never re-bound, so files go
  // only to the input an agent observed.
  const rebind = (ref: string) => {
    const print = registry.fingerprints.get(ref);
    if (
      !print ||
      print.url !== location.href ||
      (print.tag === "input" && print.type.toLowerCase() === "file") ||
      (!print.label && !print.selector.startsWith("#"))
    )
      return undefined;
    const doc = documentAt(print.frame);
    if (!doc) return undefined;
    const matches = (element: Element) => {
      const owner = registry.refs.get(element);
      return (
        element.localName === print.tag &&
        (element.getAttribute("role") || "") === print.role &&
        (element.getAttribute("type") || "") === print.type &&
        !(owner && registry.elements.get(owner) === element) &&
        labelOf(element) === print.label &&
        contextOf(element) === print.context &&
        groupOf(element) === print.group &&
        visible(element)
      );
    };
    try {
      const same = doc.querySelector(print.selector);
      if (same && matches(same)) return same;
    } catch {}
    if (!print.label) return undefined;
    let found: Element | undefined;
    let compared = 0;
    for (const element of doc.getElementsByTagName(print.tag)) {
      if (
        (element.getAttribute("role") || "") !== print.role ||
        (element.getAttribute("type") || "") !== print.type
      )
        continue;
      // Too many lookalikes to compare cannot prove a single match.
      if (++compared > 2000) return undefined;
      if (!matches(element)) continue;
      if (found) return undefined;
      found = element;
    }
    return found;
  };
  // A control drawn with no size, such as a radio button in a list row that
  // takes the row's clicks, cannot take a native click at its own point. It is
  // clicked in the page when the box around it is on screen and uncovered.
  const emptyBox = (element: Element) => {
    const box = element.getBoundingClientRect();
    return box.width === 0 || box.height === 0;
  };
  const emptyBoxBlocked = (element: Element) => {
    const box = placed(element);
    const { clip } = box;
    let host = parentOf(element);
    while (host && emptyBox(host)) host = parentOf(host);
    const around = host && placed(host);
    const x = around
      ? Math.min(Math.max(box.left, around.left, clip.left), around.right - 1)
      : -1;
    const y = around
      ? Math.min(Math.max(box.top, around.top, clip.top), around.bottom - 1)
      : -1;
    if (
      box.left < clip.left ||
      box.top < clip.top ||
      box.left > clip.right ||
      box.top > clip.bottom ||
      x < clip.left ||
      y < clip.top ||
      x >= clip.right ||
      y >= clip.bottom
    )
      return failure("Element is outside the viewport.");
    const hit = hitAt(element, x, y);
    if (!hit || !within(host!, hit))
      return failure("Another element covers the target.", "element_obscured");
  };
  // The boxes a run of text draws, which say whether it is rendered at all
  // and whether the viewport shows it.
  const textRects = (node: Text) => {
    const range = docOf(node).createRange();
    range.selectNodeContents(node);
    return Array.from(range.getClientRects()).filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
  };
  // A text node's rendered text, read as pageText reads it.
  const textOf = (node: Text) => {
    const parent = node.parentElement;
    return !parent ||
      parent.closest("script,style,noscript,template,input,textarea,select") ||
      (html(parent) && parent.isContentEditable) ||
      !visible(parent, true) ||
      iconName(node, parent) ||
      !textRects(node).length
      ? ""
      : node.textContent || "";
  };
  const textOnScreen = (node: Text) =>
    textRects(node).some((rect) =>
      onScreenBox(placedRect(docOf(node), rect)),
    );
  // The open dialogs and popups inside a scope, outermost first and only.
  const popupRootsIn = (root: Element) => {
    const roots: Element[] = [];
    const take = (element: Element) => {
      if (!element.matches(popup) || !visible(element)) return false;
      roots.push(element);
      return true;
    };
    if (take(root)) return roots;
    walk(root, (node) => {
      if (node.nodeType === 1 && take(node as Element)) return false;
    });
    return roots;
  };
  if (operation === "snapshot") {
    styles = new Map();
    const options = payload as unknown as SnapshotOptions;
    const viewport = options.scope === "viewport";
    const outline = options.format === "outline";
    // Where this part starts: a character of the text, a ranked control.
    const offsets = {
      text: options.offsets?.text || 0,
      control: options.offsets?.control || 0,
      line: options.offsets?.line || 0,
    };
    let scope: Element = document.body || document.documentElement;
    // A root is a ref; any other form of scope is a selector the main
    // process parsed.
    const scoped =
      options.root !== undefined
        ? { ref: options.root }
        : options.selector !== undefined
          ? (payload as ElementTarget)
          : undefined;
    if (scoped) {
      const selected = target(scoped);
      if (!isElement(selected)) return selected;
      // A frame of this origin is read as its own document. One from another
      // origin has a world of its own, which the main process reads with this
      // frame as its root.
      if (opaqueFrame(selected))
        return failure(
          "This control is inside a frame from another origin, which Kamapathy cannot read. Ask the person to continue there.",
          "cross_origin_frame",
        );
      const inner = frameDocument(selected);
      scope = inner
        ? inner.body || inner.documentElement || selected
        : selected;
    }
    // A detached element's fingerprint stays, so its ref can follow the
    // control the page draws in its place.
    for (const [ref, element] of registry.elements)
      if (!element.isConnected) registry.elements.delete(ref);
    // Expired references fail safely instead of being assigned to another node.
    while (registry.elements.size > 5000) {
      const ref = registry.elements.keys().next().value!;
      registry.elements.delete(ref);
      registry.fingerprints.delete(ref);
    }
    while (registry.fingerprints.size > 5000)
      registry.fingerprints.delete(registry.fingerprints.keys().next().value!);
    // Controls in the order a person sees them, through shadow roots and
    // frames, which querySelectorAll does not enter. Each element's place in
    // that order sorts in the clickable elements found later.
    const order = new Map<Element, number>();
    const found: Element[] = [];
    const consider = (element: Element) => {
      order.set(element, order.size);
      if (
        (element.matches(query) || listedFrame(element)) &&
        isControl(element) &&
        (visible(element) || uploadControl(element)) &&
        (!viewport || drawnOnScreen(element))
      )
        found.push(element);
    };
    consider(scope);
    walk(scope, (node) => {
      if (node.nodeType === 1) consider(node as Element);
    });
    const listed = new Set(found);
    const holders = new Set<Element>();
    for (const element of found)
      for (
        let parent = parentOf(element);
        parent && !holders.has(parent);
        parent = parentOf(parent)
      )
        holders.add(parent);
    const items =
      '[role="option"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="treeitem"],[role="tab"]';
    const candidates = found.filter((element) => {
      // A wrapper listed only for its focus or popup, or a list of choices, is
      // operated through the controls inside it. A draggable one is also
      // dragged as a whole.
      if (
        holders.has(element) &&
        ((!element.matches(controlQuery) && !element.matches(draggable)) ||
          [
            "listbox",
            "menu",
            "menubar",
            "radiogroup",
            "tablist",
            "tree",
            "grid",
          ].includes(element.getAttribute("role") || ""))
      )
        return false;
      // A row drawn as a button around its controls, as Google's Angular
      // components draw a tree row around its tree item, is also listed
      // through them when it has no name or text of its own.
      if (
        holders.has(element) &&
        element.getAttribute("role") === "button" &&
        !element.matches("a[href],button,summary,input,textarea,select") &&
        !element.matches(draggable) &&
        !element.hasAttribute("aria-label") &&
        !element.hasAttribute("aria-labelledby")
      ) {
        let own = false;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (
          let node = walker.nextNode();
          node && !own;
          node = walker.nextNode()
        ) {
          if (
            !clean(node.textContent) ||
            node.parentElement?.closest('[aria-hidden="true"]')
          )
            continue;
          let inner = node.parentElement;
          while (inner && inner !== element && !listed.has(inner))
            inner = inner.parentElement;
          own = inner === element;
        }
        if (!own) return false;
      }
      // A checkbox, radio button or switch drawn inside an option, menu item,
      // tab or tree item is part of that item.
      if (element.matches('[role="checkbox"],[role="radio"],[role="switch"]'))
        for (
          let parent = element.parentElement;
          parent;
          parent = parent.parentElement
        )
          if (listed.has(parent) && parent.matches(items)) return false;
      return true;
    });
    // Pages also draw clickable and draggable items with no control semantics.
    // A few with their own short text are listed after every other control.
    const clickable: Element[] = [];
    const searchEnd = performance.now() + 50;
    walk(scope, (node) => {
      if (
        node.nodeType !== 1 ||
        clickable.length >= 30 ||
        performance.now() >= searchEnd
      )
        return false;
      const element = node as Element;
      const style = styleOf(element);
      if (
        listed.has(element) ||
        style.display === "none" ||
        /^(script|style|noscript|template|svg|select)$/.test(element.localName)
      )
        return false;
      // The element that sets the pointer, not each child inheriting it.
      if (
        /^(pointer|grab|move)$/.test(style.cursor) &&
        !holders.has(element) &&
        styleOf(parentOf(element) || element).cursor !== style.cursor &&
        !(
          element.localName === "label" &&
          (element as HTMLLabelElement).control
        )
      ) {
        const text =
          clean(element.getAttribute("aria-label")) || ownText(element);
        if (
          text &&
          text.length <= 200 &&
          visible(element) &&
          (!viewport || drawnOnScreen(element))
        ) {
          clickable.push(element);
          return false;
        }
      }
    });
    const all = clickable.length
      ? candidates
          .concat(clickable)
          .sort((first, second) => order.get(first)! - order.get(second)!)
      : candidates;
    // Every control is ranked, whether or not they all fit, because a part
    // takes ranked positions and every part must rank the page alike: open
    // dialogs and popups, then pinned bars on screen, then the rest of the
    // screen, then everything else. An outline prints in page order, so it
    // ranks nothing.
    const rankControls = () => {
      const fallback = new Set(clickable);
      // The nearest fixed or sticky box around an element, if any.
      const pinned = new Map<Element, Element | null>();
      const pinOf = (element: Element) => {
        const chain: Element[] = [];
        let result: Element | null = null;
        for (
          let current: Element | null = element;
          current;
          current = current.parentElement
        ) {
          const known = pinned.get(current);
          if (known !== undefined) {
            result = known;
            break;
          }
          chain.push(current);
          if (["fixed", "sticky"].includes(styleOf(current).position)) {
            result = current;
            break;
          }
        }
        for (const item of chain) pinned.set(item, result);
        return result;
      };
      // A pinned bar, such as a header, a banner or the action bar at the
      // bottom, is short or spans the page. A tall, narrow pinned column, such
      // as a navigation sidebar or a table of contents, stays the same on
      // every page, so it comes after the rest of the screen.
      const bar = (pin: Element) => {
        const box = pin.getBoundingClientRect();
        const view = docOf(pin).defaultView || window;
        return (
          box.height <= view.innerHeight / 3 ||
          box.width >= (view.innerWidth * 2) / 3
        );
      };
      const rank = (element: Element) => {
        // A file input hidden inside upload UI sits where its parent is.
        const shown = drawnOnScreen(element);
        // A drawer kept rendered off screen is not an open popup.
        const open = element.parentElement?.closest(popup);
        const pin = shown ? pinOf(element) : null;
        // The trigger of an open popup shows its current choice.
        const trigger =
          shown &&
          element.getAttribute("aria-expanded") === "true" &&
          !["", "false", null].includes(element.getAttribute("aria-haspopup"));
        const tier = trigger
          ? 0
          : open && onScreen(open)
            ? shown
              ? 0
              : 1
            : !shown
              ? 5
              : !pin
                ? 3
                : bar(pin)
                  ? 2
                  : 4;
        return tier * 2 + (fallback.has(element) ? 1 : 0);
      };
      return all
        .map((element, index) => ({ element, index, rank: rank(element) }))
        .sort(
          (first, second) =>
            first.rank - second.rank || first.index - second.index,
        );
    };
    // Section 9's placeholders: every owner the walk saw and could not read,
    // so the main process can place that frame's own read where its owner
    // sits. The key is the one the main process bound; an owner it has not
    // bound yet is placed by its path alone, and bound on the next pass.
    const framePlaceholders = (ranks: ReturnType<typeof rankControls>) => {
      const tiers = new Map(ranks.map((item) => [item.element, item.rank]));
      return all.filter(listedFrame).map((element) => {
        const box = placed(element);
        const key = keyOfFrame(element);
        return {
          ...(key === undefined ? {} : { key }),
          local: contentPath(element),
          order: order.get(element) ?? 0,
          tier: tiers.get(element) ?? 0,
          box: {
            left: box.left,
            top: box.top,
            right: box.right,
            bottom: box.bottom,
          },
          readable: false,
        };
      });
    };
    // What the composition in the main process needs beside the listing: the
    // group this read belongs to, and the owners inside it left to read.
    const frameRead = (ranks: ReturnType<typeof rankControls>) =>
      frameContext === undefined
        ? {}
        : {
            group: frameContext.group,
            placeholders: framePlaceholders(ranks),
          };
    const limit = options.mode === "compact" ? 80 : 200;
    let nextRef = options.firstRef;
    // The numbers this snapshot assigned, so the main process knows which
    // refs the tab was issued.
    const issued: number[] = [];
    let remainingOptions = 100;
    let optionsTruncated = false;
    const prints = new Map<string, Fingerprint>();
    // The ref a control already holds, or the next number of this
    // snapshot's block, which only a line that is kept takes.
    const refAt = (element: Element) => {
      const held = registry.refs.get(element);
      if (held && registry.elements.get(held) === element)
        return { ref: held, keep: () => {} };
      const number = nextRef;
      const ref = `@e${number}`;
      return {
        ref,
        keep: () => {
          nextRef = number + 1;
          issued.push(number);
          registry.refs.set(element, ref);
          registry.elements.set(ref, element);
        },
      };
    };
    const refFor = (element: Element) => {
      const made = refAt(element);
      made.keep();
      return made.ref;
    };
    // What a listing says about one control, in both formats.
    const entryFor = (element: Element, index: number) => {
      const ref = refFor(element);
      const label = labelOf(element);
      const hidden = secret(element);
      const value = valueOf(element);
      const group = groupOf(element);
      const selector = selectorFor(element);
      const frame = framePath(element);
      prints.set(ref, {
        tag: element.localName,
        role: element.getAttribute("role") || "",
        type: element.getAttribute("type") || "",
        label,
        group,
        context: contextOf(element),
        selector,
        frame,
        url: location.href,
      });
      const entry = {
        index,
        ref,
        tag: element.localName,
        role: element.getAttribute("role") || element.localName,
        type: element.getAttribute("type") || undefined,
        label: label.slice(0, limit),
        selector,
        ...hrefOf(element),
        disabled:
          element.matches(":disabled") ||
          element.getAttribute("aria-disabled") === "true",
        ...stateOf(element),
        ...(!value ||
        (element.getAttribute("role") === "combobox" && value === label)
          ? {}
          : hidden
            ? { valueHidden: true }
            : value.length > limit
              ? { value: value.slice(0, limit), valueTruncated: true }
              : { value }),
        ...(group ? { group: group.slice(0, limit) } : {}),
        ...(frame ? { frame } : {}),
        ...(opaqueFrame(element) ? { crossOrigin: true } : {}),
        ...(opaqueFrame(element) && keyOfFrame(element) !== undefined
          ? { key: keyOfFrame(element) }
          : {}),
        ...(inputElement(element) && element.type === "file"
          ? { accept: element.accept.slice(0, 256), multiple: element.multiple, hidden: !visible(element) }
          : {}),
        ...(selectElement(element)
          ? (() => {
              const choices = Array.from(element.options).filter(
                (option) => option.value.length <= 256,
              );
              const included = choices.slice(
                0,
                Math.min(20, remainingOptions),
              );
              remainingOptions -= included.length;
              const truncated = included.length < element.options.length;
              optionsTruncated ||= truncated;
              return {
                options: included.map((option) => ({
                  value: option.value,
                  label: option.label
                    .replace(/\s+/g, " ")
                    .trim()
                    .slice(0, 80),
                  disabled:
                    option.disabled || !!option.closest("optgroup")?.disabled,
                  ...(option.selected && !hidden ? { selected: true } : {}),
                })),
                ...(truncated ? { optionsTruncated: true } : {}),
              };
            })()
          : {}),
      };
      return entry;
    };
    // What a locator may be built from: the control's own attributes and a
    // link's address, for the controls a part printed. A field's value is
    // never read.
    const LOCATOR_ATTRIBUTES = [
      "data-testid",
      "data-test",
      "data-qa",
      "data-cy",
      "id",
      "name",
      "aria-label",
      "placeholder",
    ];
    const locatorSources = (
      elements: readonly Element[],
      entries: readonly { ref: string }[],
    ) => {
      if (!options.locators) return {};
      return {
        locatorSources: elements.map((element, index) => {
          const attributes: Record<string, string> = {};
          for (const name of LOCATOR_ATTRIBUTES) {
            const value = element.getAttribute(name);
            if (value) attributes[name] = value;
          }
          return {
            ref: entries[index].ref,
            tag: element.localName,
            attributes,
            ...hrefOf(element),
          };
        }),
      };
    };
    // A control that looks like another visible control, listed or not and in
    // or outside a scoped snapshot, cannot be told apart from it once it is
    // gone, so its ref never follows a redrawn control.
    const keepFingerprints = (listedNow: readonly Element[]) => {
      const kindOf = (print: Pick<Fingerprint, "tag" | "role" | "type">) =>
        JSON.stringify([print.tag, print.role, print.type]);
      const keyOf = (print: Omit<Fingerprint, "selector" | "frame" | "url">) =>
        JSON.stringify([
          print.tag,
          print.role,
          print.type,
          print.label,
          print.group,
          print.context,
        ]);
      const lookalikes = new Map<string, number>();
      const kinds = new Set<string>();
      const names = new Set<string>();
      for (const print of prints.values()) {
        lookalikes.set(keyOf(print), (lookalikes.get(keyOf(print)) || 0) + 1);
        kinds.add(kindOf(print));
        names.add(kindOf(print) + print.label);
      }
      const others = new Set(
        scoped || viewport
          ? Array.from(document.querySelectorAll(query)).filter(
              (element) => isControl(element) && visible(element),
            )
          : [],
      );
      for (const element of all) others.add(element);
      for (const element of listedNow) others.delete(element);
      for (const element of others) {
        const print = {
          tag: element.localName,
          role: element.getAttribute("role") || "",
          type: element.getAttribute("type") || "",
          label: "",
          group: "",
          context: "",
        };
        if (!kinds.has(kindOf(print))) continue;
        print.label = labelOf(element);
        if (!names.has(kindOf(print) + print.label)) continue;
        print.group = groupOf(element);
        print.context = contextOf(element);
        const count = lookalikes.get(keyOf(print));
        if (count) lookalikes.set(keyOf(print), count + 1);
      }
      for (const [ref, print] of prints)
        if (lookalikes.get(keyOf(print))! > 1)
          registry.fingerprints.delete(ref);
        else registry.fingerprints.set(ref, print);
    };
    if (outline) {
      const items = outlineBuilder!({
        scope,
        walk,
        visible,
        controls: new Set(all),
        inView: (element) => !viewport || drawnOnScreen(element),
        textInView: (node) => !viewport || textOnScreen(node),
        roleOf,
        labelOf,
        frameDocument,
        opaqueFrame: listedFrame,
        popupRoots: () => popupRootsIn(scope),
        textOf,
      });
      const kids: number[][] = items.map(() => []);
      for (const [at, item] of items.entries())
        if (item.parent >= 0) kids[item.parent].push(at);
      // Text runs on for as many lines as it needs, each a JSON string of
      // at most 400 characters.
      const chunksOf = (value: string) => {
        const chunks: string[] = [];
        for (let at = 0; at < value.length; ) {
          let size = Math.min(398, value.length - at);
          while (
            size > 1 &&
            JSON.stringify(value.slice(at, at + size)).length > 400
          )
            size -= 1;
          chunks.push(value.slice(at, at + size));
          at += size;
        }
        return chunks.length ? chunks : [""];
      };
      type Planned = { item: number; depth: number; chunk?: string };
      const plan: Planned[] = [];
      for (const [at, item] of items.entries())
        if (item.text === undefined) plan.push({ item: at, depth: item.depth });
        else
          for (const chunk of chunksOf(item.text))
            plan.push({ item: at, depth: item.depth, chunk });
      // Control and frame lines are the ones maxControls bounds.
      const counts = (line: Planned) =>
        line.chunk === undefined &&
        (items[line.item].control || items[line.item].frame);
      // No control character and no newline a page wrote reaches a line.
      const oneLine = (value: string) =>
        value
          .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      // One line: the role, the name, a ref for controls and frames, then
      // the same words the text format prints after a control.
      const render = (line: Planned) => {
        const item = items[line.item];
        const blank = () => {};
        if (line.chunk !== undefined)
          return { text: JSON.stringify(line.chunk), keep: blank };
        const element = item.element!;
        const name = (item.name || "").slice(0, limit);
        const words = [oneLine(item.role || "") || element.localName];
        if (name) words.push(JSON.stringify(name));
        const listed = item.control || item.frame;
        const made = listed ? refAt(element) : undefined;
        if (made) words.push(made.ref);
        if (item.role === "option" && !listed) {
          const choice = element as HTMLOptionElement;
          const select = item.parent >= 0 ? items[item.parent].element : null;
          if (choice.value !== (item.name || ""))
            words.push(
              `value=${JSON.stringify(oneLine(choice.value).slice(0, limit))}`,
            );
          if (choice.disabled || !!choice.closest("optgroup")?.disabled)
            words.push("[disabled]");
          if (choice.selected && !(select && secret(select)))
            words.push("[selected]");
          return { text: words.join(" "), keep: blank };
        }
        if (disabledElement(element)) words.push("[disabled]");
        const state = stateOf(element);
        if (state.checked !== undefined)
          words.push(
            state.checked === "mixed"
              ? "[mixed]"
              : state.checked
                ? "[checked]"
                : "[unchecked]",
          );
        if (state.selected) words.push("[selected]");
        if (state.expanded !== undefined)
          words.push(state.expanded ? "[expanded]" : "[collapsed]");
        if (state.pressed !== undefined)
          words.push(
            state.pressed === "mixed"
              ? "[partly pressed]"
              : state.pressed
                ? "[pressed]"
                : "[not pressed]",
          );
        const value = valueOf(element) || "";
        if (
          value &&
          !(
            element.getAttribute("role") === "combobox" &&
            value === (item.name || "")
          )
        )
          words.push(
            secret(element)
              ? "(value hidden)"
              : `value=${JSON.stringify(value.slice(0, limit))}${value.length > limit ? " (truncated)" : ""}`,
          );
        const group = groupOf(element);
        if (group) words.push(`group ${JSON.stringify(group.slice(0, limit))}`);
        if (item.level !== undefined) words.push(`level=${item.level}`);
        const { href } = hrefOf(element);
        if (href) {
          const link = element as HTMLAnchorElement;
          words.push(
            `href=${oneLine(
              link.origin === location.origin
                ? `${link.pathname}${link.search}${link.hash}`
                : href,
            )}`,
          );
        }
        if (inputElement(element) && element.type === "file")
          words.push(
            `file upload: ${element.multiple ? "multiple" : "single"}${
              element.accept
                ? `; accepts ${oneLine(element.accept.slice(0, 256))}`
                : ""
            }${visible(element) ? "" : "; hidden input in visible form"}`,
          );
        if (opaqueFrame(element)) words.push("(not read)");
        let cut = false;
        if (selectElement(element)) {
          const shown = kids[line.item].filter(
            (kid) => items[kid].role === "option",
          ).length;
          cut = shown < element.options.length;
          if (cut) words.push("(more options)");
        }
        return {
          text: words.join(" "),
          keep: made ? made.keep : blank,
          ...(listed ? { element } : {}),
          cut,
        };
      };
      const start = Math.min(offsets.line, plan.length);
      const lines: string[] = [];
      const printed: Element[] = [];
      let used = 0;
      let taken = 0;
      let cutOptions = false;
      const keepLine = (
        line: Planned,
        made: {
          text: string;
          keep: () => void;
          element?: Element;
          cut?: boolean;
        },
      ) => {
        made.keep();
        lines.push("  ".repeat(line.depth) + made.text);
        used += line.depth * 2 + made.text.length + 1;
        if (made.cut) cutOptions = true;
        if (made.element && !printed.includes(made.element))
          printed.push(made.element);
      };
      // A continued part first places the printed elements around its first
      // line, which cost characters but are not progress.
      if (start > 0 && start < plan.length) {
        const chain: number[] = [];
        for (
          let parent = items[plan[start].item].parent;
          parent >= 0;
          parent = items[parent].parent
        )
          chain.unshift(parent);
        for (const parent of chain) {
          const line = { item: parent, depth: items[parent].depth };
          keepLine(line, render(line));
        }
      }
      // Lines are added while they fit, and a part always adds one.
      let at = start;
      for (; at < plan.length; at += 1) {
        const line = plan[at];
        const first = at === start;
        if (!first && counts(line) && taken >= options.maxControls) break;
        const made = render(line);
        if (
          !first &&
          used + line.depth * 2 + made.text.length + 1 > options.maxChars
        )
          break;
        keepLine(line, made);
        if (counts(line)) taken += 1;
      }
      const left = at < plan.length;
      let past = 0;
      for (let rest = at; rest < plan.length; rest += 1)
        if (counts(plan[rest])) past += 1;
      const interactables = printed.map((element, index) =>
        entryFor(element, index),
      );
      keepFingerprints(printed);
      return {
        url: location.href,
        title: document.title,
        outline: lines.join("\n"),
        interactables,
        ...frameRead(rankControls()),
        ...locatorSources(printed, interactables),
        ...reboundResult(),
        ...(issued.length ? { issued } : {}),
        ...(past ? { omittedControls: past } : {}),
        ...(left ? { next: { text: 0, control: 0, line: at } } : {}),
        truncated: left || optionsTruncated || cutOptions,
      };
    }
    // This part's controls, back in the order a person sees them.
    const ranked = rankControls();
    const chosen = ranked
      .slice(offsets.control, offsets.control + options.maxControls)
      .sort((first, second) => first.index - second.index)
      .map((item) => item.element);
    const interactables = chosen.map((element, index) =>
      entryFor(element, index),
    );
    keepFingerprints(chosen);
    const omitted = Math.max(0, all.length - offsets.control - chosen.length);
    const compact = (value: string) =>
      options.mode === "compact"
        ? value
            .replace(/[\t ]+/g, " ")
            .replace(/\n\s*\n\s*\n/g, "\n\n")
            .trim()
        : value;
    // A part reads past its own end, so the normalization at its last
    // character is the one the whole text has there. When the margin was
    // all whitespace, it reads further, up to the whole scope.
    const wanted = offsets.text + options.maxChars;
    let readLimit = wanted + 256;
    let raw = pageText(scope, readLimit, viewport);
    let normalized = compact(raw);
    while (raw.length > readLimit && normalized.length < wanted + 1) {
      readLimit *= 2;
      raw = pageText(scope, readLimit, viewport);
      normalized = compact(raw);
    }
    const text = normalized.slice(offsets.text, wanted);
    const textLeft = normalized.length > wanted;
    // A bound of 0 cannot print its half of the page, so it never asks for
    // it again; truncated still reports what was left out.
    const more =
      (textLeft && options.maxChars > 0) ||
      (omitted > 0 && options.maxControls > 0);
    return {
      url: location.href,
      title: document.title,
      text,
      interactables,
      ...frameRead(ranked),
      ...locatorSources(chosen, interactables),
      ...reboundResult(),
      ...(issued.length ? { issued } : {}),
      ...(omitted ? { omittedControls: omitted } : {}),
      ...(more
        ? {
            next: {
              text: textLeft ? offsets.text + text.length : normalized.length,
              control: offsets.control + chosen.length,
              line: 0,
            },
          }
        : {}),
      truncated: textLeft || omitted > 0 || optionsTruncated,
    };
  }
  if (operation === "check") {
    const spec = payload as ElementTarget;
    const query = spec.query;
    const selector = typeof spec.selector === "string" ? spec.selector : "";
    let scope: Element = document.body || document.documentElement;
    if (typeof spec.ref === "string") {
      // A wait for `selector: "@eN"` waits for that element to be visible.
      const element = target(spec);
      if (!isElement(element)) return element;
      if (!visible(element, true)) return { ok: true, matched: false };
      scope = element;
    } else if (query) {
      const picked = pickedFor(query);
      if (picked === null) return failure(PAGE_CHANGED, "page_changed");
      if (query.state === "hidden" || query.state === "detached") {
        const counts = engineOf().tally(query, picked);
        if ("kind" in counts) return invalidSelector(selector, counts);
        const met =
          query.state === "hidden" ? counts.visible === 0 : counts.count === 0;
        if (!met) return { ok: true, matched: false };
      } else {
        // Without a state this is today's wait route: one visible match.
        const decision = engineOf().decide(
          query.state ? query : { ...query, mode: "strict", level: "visible" },
          picked,
        );
        if (
          decision.kind === "invalid" ||
          (decision.kind === "ambiguous" &&
            query.state &&
            query.mode === "strict")
        )
          return selectFailure(selector, decision, query.firstRef);
        if (decision.kind !== "match") return { ok: true, matched: false };
        scope = decision.element;
      }
    } else if (spec.selector !== undefined) {
      return failure(NO_TARGET, "invalid_target");
    }
    const text = pageText(scope);
    return {
      ok: true,
      matched:
        typeof payload.text === "string"
          ? text.includes(payload.text)
          : query !== undefined ||
            typeof spec.ref === "string" ||
            document.readyState !== "loading",
    };
  }
  if (operation === "input") {
    // Chromium drops native input that a page receives before it renders its
    // first frame after a navigation, so the caller counts what arrived.
    const world = globalThis as unknown as {
      kamapathyInput?: { mouse: number; key: number; drag: number };
      kamapathyListening?: WeakSet<Document>;
    };
    const counts = (world.kamapathyInput ||= { mouse: 0, key: 0, drag: 0 });
    // Events inside a frame never reach the top window, so every document
    // this page can read counts its own, once per document.
    const listening = (world.kamapathyListening ||= new WeakSet());
    for (const doc of documents()) {
      const view = doc.defaultView;
      if (!view || listening.has(doc)) continue;
      listening.add(doc);
      view.addEventListener("mousedown", () => { counts.mouse += 1; }, { capture: true });
      view.addEventListener("keydown", () => { counts.key += 1; }, { capture: true });
      // An HTML5 drag starts unless the page cancels dragstart, which its own
      // handlers decide after this listener runs.
      view.addEventListener("dragstart", (event) => {
        setTimeout(() => { if (!event.defaultPrevented) counts.drag += 1; });
      }, { capture: true });
    }
    return { ok: true, ...counts };
  }
  if (operation === "frame")
    return new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => resolve({ ok: true })),
      ),
    );
  if (operation === "ready")
    return { ok: true, readyState: document.readyState };
  // The path snapshots print for a frame element, counted from this world's
  // document.
  if (operation === "frameIndex") {
    const element = payload.element;
    const index = isElement(element)
      ? framesIn(docOf(element)).indexOf(element)
      : -1;
    if (!isElement(element) || index < 0 || !live(element))
      return failure("The element is not a frame shown in this page.");
    return { ok: true, path: contentPath(element) };
  }
  // Where a bound owner shows its document, for the main process to map
  // points and areas through, and what covers it at a point.
  if (operation === "frameBox") {
    const owner = frames?.byKey.get(payload.key as string);
    if (!owner || !live(owner)) return failure(PAGE_CHANGED, "page_changed");
    const own = frameOrigin(owner);
    const placement = ownerPlacement(owner);
    const spot = payload.point as { x: number; y: number } | undefined;
    const point = spot && {
      x: placement.x + spot.x * placement.scaleX,
      y: placement.y + spot.y * placement.scaleY,
    };
    const { area } = placement;
    const outside = area.right <= area.left || area.bottom <= area.top;
    const at = point || {
      x: (area.left + area.right) / 2,
      y: (area.top + area.bottom) / 2,
    };
    const hit = outside ? null : hitAt(owner, at.x, at.y);
    const blocked = !outside && (!hit || !within(owner, hit));
    return {
      ok: true,
      box: {
        x: own.x,
        y: own.y,
        scaleX: own.scaleX,
        scaleY: own.scaleY,
        width: placement.width,
        height: placement.height,
      },
      area,
      ...(point ? { point } : {}),
      ...(blocked
        ? {
            covered: true as const,
            ...(hit ? { interceptor: candidatesOf([hit], undefined)[0] } : {}),
          }
        : {}),
    };
  }
  // The document holding the focus, or the owner of the frame that holds it,
  // which the main process follows on that frame's own session.
  if (operation === "activeFrame") {
    // Frames agents never enter: an extension, the PDF viewer, an internal
    // page, a local file or Kamapathy's own interface. A page can only tell
    // them apart by the address the frame was given.
    const WEB_FRAME = /^(https?|about|data|blob):$/;
    const blockedFrame = (frame: Element) => {
      const src = frame.getAttribute("src");
      if (!src) return false;
      try {
        return !WEB_FRAME.test(new URL(src, docOf(frame).baseURI).protocol);
      } catch {
        return false;
      }
    };
    const deepActive = (root: Document | ShadowRoot) => {
      let active = root.activeElement;
      while (active?.shadowRoot?.activeElement)
        active = active.shadowRoot.activeElement;
      return active;
    };
    // Input types a person presses or picks rather than types into.
    const PRESSED = /^(submit|reset|button|image|checkbox|radio|file)$/;
    const typing = (element: Element) =>
      (inputElement(element) && !PRESSED.test(element.type)) ||
      textAreaElement(element) ||
      (html(element) && element.isContentEditable);
    let doc = document;
    for (;;) {
      const active = deepActive(doc);
      if (!active) break;
      if (active.localName !== "iframe" && active.localName !== "frame")
        return { ok: true, path: framePath(active), editable: typing(active) };
      const key = keyOfFrame(active);
      const named = key === undefined ? {} : { key };
      if (blockedFrame(active))
        return {
          ok: true,
          path: contentPath(active),
          ...named,
          editable: false,
          blocked: true as const,
        };
      const inner = frameDocument(active);
      if (!inner)
        return {
          ok: true,
          path: contentPath(active),
          ...named,
          editable: false,
        };
      doc = inner;
    }
    return { ok: true, path: framePath(doc.documentElement), editable: false };
  }
  // The listed controls themselves, for the main process to read their
  // backend nodes from.
  if (operation === "elements") {
    const refs = payload.refs as string[];
    return refs.map((ref) => registry.elements.get(ref) ?? null);
  }
  // Whether each locator candidate names its own control alone. Every match
  // counts, hidden ones too, so a locator stands only where it is the one
  // way to this element.
  if (operation === "validate") {
    const checks = payload.checks as { ref: string; candidates: SearchAst[] }[];
    return {
      ok: true,
      valid: checks.map((check) => {
        const element = registry.elements.get(check.ref);
        if (!element) return check.candidates.map(() => false);
        return check.candidates.map((ast) => {
          const found = engineOf().search(ast);
          return (
            found.kind === "matches" &&
            found.matches.length === 1 &&
            found.matches[0] === element
          );
        });
      }),
    };
  }
  if (operation === "scroll") {
    const direction = payload.direction as string;
    const pixels = payload.pixels as number;
    const vertical = direction === "up" || direction === "down";
    const forward = direction === "down" || direction === "right";
    // Whether a box can move this way, as a wheel would move it. Right-to-left
    // boxes scroll horizontally through negative offsets.
    const room = (position: number, extent: number, rtl: boolean) => {
      if (extent < 1) return false;
      const [low, high] = !vertical && rtl ? [-extent, 0] : [0, extent];
      return forward ? position < high - 0.5 : position > low + 0.5;
    };
    const canScroll = (element: Element) => {
      const style = styleOf(element);
      return (
        /^(auto|scroll|overlay)$/.test(
          vertical ? style.overflowY : style.overflowX,
        ) &&
        room(
          vertical ? element.scrollTop : element.scrollLeft,
          vertical
            ? element.scrollHeight - element.clientHeight
            : element.scrollWidth - element.clientWidth,
          style.direction === "rtl",
        )
      );
    };
    // A target scrolls the panel holding it, and its own document is the
    // page, so a control inside a frame scrolls that frame. Without a target,
    // a page that cannot scroll this way scrolls the panel under the middle
    // of the viewport.
    let start: Element | null = null;
    let doc = document;
    if (payload.ref !== undefined || payload.selector !== undefined) {
      const element = target();
      if (!isElement(element)) return element;
      if (!visible(element)) return failure("Element is not visible.");
      start = element;
      doc = docOf(element);
    }
    const view = doc.defaultView || window;
    // The page scrolls unless its overflow, set on the root or passed on from
    // the body, keeps a person from scrolling it.
    const root = doc.scrollingElement || doc.documentElement;
    const rootStyle = styleOf(doc.documentElement);
    const viewport =
      rootStyle.overflowX === "visible" &&
      rootStyle.overflowY === "visible" &&
      doc.body
        ? styleOf(doc.body)
        : rootStyle;
    const pageBox = (element: Element) =>
      element === root ||
      element === doc.documentElement ||
      (element === doc.body && viewport !== rootStyle);
    const pageScrolls =
      !/^(hidden|clip)$/.test(
        vertical ? viewport.overflowY : viewport.overflowX,
      ) &&
      room(
        vertical ? view.scrollY : view.scrollX,
        vertical
          ? root.scrollHeight - root.clientHeight
          : root.scrollWidth - root.clientWidth,
        rootStyle.direction === "rtl",
      );
    const spot = payload.point as { x: number; y: number } | undefined;
    if (!start && !pageScrolls)
      start = document.elementFromPoint(
        spot ? spot.x : innerWidth / 2,
        spot ? spot.y : innerHeight / 2,
      );
    let panel: Element | undefined;
    for (
      let current = start;
      current && !pageBox(current);
      current = current.parentElement
    )
      if (canScroll(current)) {
        panel = current;
        break;
      }
    const offsets = () =>
      panel
        ? [panel.scrollLeft, panel.scrollTop]
        : [view.scrollX, view.scrollY];
    const before = offsets();
    // Scripts can scroll a page a person cannot, such as the page behind a
    // modal that locks scrolling. A wheel would leave it still, and so does
    // Kamapathy.
    if (panel || pageScrolls)
      (panel || view).scrollBy({
        left:
          direction === "right" ? pixels : direction === "left" ? -pixels : 0,
        top: direction === "down" ? pixels : direction === "up" ? -pixels : 0,
        behavior: "instant",
      });
    const [x, y] = offsets();
    return {
      ok: true,
      scrolled: panel ? "element" : "page",
      ...(panel ? { selector: selectorFor(panel) } : {}),
      x,
      y,
      moved: x !== before[0] || y !== before[1],
      ...reboundResult(),
    };
  }
  if (operation === "drag") {
    const source = target(payload.source as ElementTarget);
    if (!isElement(source)) return source;
    const destination = target(payload.target as ElementTarget);
    if (!isElement(destination)) return destination;
    if (!visible(source) || !visible(destination))
      return failure("Element is not visible.");
    if (
      source.matches(":disabled") ||
      source.getAttribute("aria-disabled") === "true"
    )
      return failure("Element is disabled.");
    if (within(source, destination))
      return failure(
        "Drag onto an element outside the one being dragged.",
        "invalid_target",
      );
    if (emptyBox(source) || emptyBox(destination))
      return failure("Element has no area to drag from or onto.");
    // The middle of the part of an element inside the viewport.
    const centre = (element: Element) => {
      const box = placed(element);
      const left = Math.max(box.clip.left, box.left),
        right = Math.min(box.clip.right, box.right);
      const top = Math.max(box.clip.top, box.top),
        bottom = Math.min(box.clip.bottom, box.bottom);
      return right > left && bottom > top
        ? { x: (left + right) / 2, y: (top + bottom) / 2 }
        : undefined;
    };
    source.scrollIntoView({
      block: "center",
      inline: "nearest",
      behavior: "instant",
    });
    if (!centre(destination))
      destination.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: "instant",
      });
    const from = centre(source),
      to = centre(destination);
    if (!from || !to)
      return failure(
        "Scroll so the source and target are both on screen, then drag again.",
        "drag_out_of_view",
      );
    for (const [element, point] of [
      [source, from],
      [destination, to],
    ] as const) {
      const hit = hitAt(element, point.x, point.y);
      if (!hit || !within(element, hit))
        return failure("Another element covers the target.", "element_obscured");
    }
    return { ok: true, from, to, ...reboundResult() };
  }
  const element = target();
  if (!isElement(element)) return element;
  if (!html(element)) return failure("Element does not support this action.");
  if (operation === "upload") {
    if (!uploadControl(element))
      return failure("Use a file input in the currently visible upload form.", "invalid_upload_target");
    const input = element as HTMLInputElement;
    if (input.matches(":disabled") || input.getAttribute("aria-disabled") === "true")
      return failure("File input is disabled.");
    if (input.webkitdirectory)
      return failure("Directory uploads are not supported.");
    const files = payload.files as { name: string; type: string; data: string }[];
    if (!input.multiple && files.length !== 1)
      return failure("This input accepts one file at a time.", "invalid_files");
    const accepted = input.accept.toLowerCase().split(",").map((item) => item.trim()).filter(Boolean);
    for (const file of files) {
      if (accepted.length && !accepted.some((rule) =>
        rule.startsWith(".") ? file.name.toLowerCase().endsWith(rule) :
        rule.endsWith("/*") ? file.type.toLowerCase().startsWith(rule.slice(0, -1)) :
        rule === file.type.toLowerCase()))
        return failure("A file does not match this input's accepted file types.", "invalid_file_type");
    }
    const transfer = new DataTransfer();
    for (const file of files) {
      const binary = atob(file.data);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, { type: file.type }));
    }
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")!.set!.call(input, transfer.files);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: files.length };
  }
  if (!visible(element)) return failure("Element is not visible.");
  if (
    element.matches(":disabled") ||
    element.getAttribute("aria-disabled") === "true"
  )
    return failure("Element is disabled.");
  element.scrollIntoView({
    block: "center",
    inline: "nearest",
    behavior: "instant",
  });
  if (operation === "focus") {
    element.focus({ preventScroll: true });
    // Focus is read from the element's own tree: its shadow root or frame.
    const active = (element.getRootNode() as Document).activeElement;
    if (active !== element && !element.contains(active))
      return failure("Element could not be focused.");
    return { ok: true, ...reboundResult() };
  }
  if (operation === "click") {
    if (!emptyBox(element))
      return failure("The control changed before the click. Inspect it again.");
    const blocked = emptyBoxBlocked(element);
    if (blocked) return blocked;
    element.click();
    return { ok: true, ...reboundResult() };
  }
  if (operation === "target") {
    if (emptyBox(element))
      return (
        emptyBoxBlocked(element) || { ok: true, empty: true, ...reboundResult() }
      );
    const rectangle = placed(element);
    const left = Math.max(rectangle.clip.left, rectangle.left),
      right = Math.min(rectangle.clip.right, rectangle.right);
    const top = Math.max(rectangle.clip.top, rectangle.top),
      bottom = Math.min(rectangle.clip.bottom, rectangle.bottom);
    if (right <= left || bottom <= top)
      return failure("Element is outside the viewport.");
    const x = (left + right) / 2,
      y = (top + bottom) / 2;
    const hit = hitAt(element, x, y);
    if (!hit || !within(element, hit))
      return failure("Another element covers the target.", "element_obscured");
    return { ok: true, x, y, ...reboundResult() };
  }
  if (element.hasAttribute("readonly")) return failure("Element is read only.");
  const value = payload.value as string;
  if (
    inputElement(element) ||
    textAreaElement(element) ||
    selectElement(element)
  ) {
    const validateValue = () => {
      if (inputElement(element)) {
        if (
          ![
            "text",
            "search",
            "tel",
            "url",
            "email",
            "password",
            "number",
            "date",
            "time",
            "datetime-local",
            "month",
            "week",
          ].includes(element.type)
        )
          return failure("This input type does not support fill.");
        // Validate Chromium's normalization before touching the actual field.
        const probe = document.createElement("input");
        probe.type = element.type;
        probe.value = value;
        if (probe.value !== value)
          return failure(
            "The value is not valid for this input type.",
            "invalid_value",
          );
      }
      if (selectElement(element)) {
        if (element.multiple)
          return failure("Multiple selects do not support fill.");
        const matches = Array.from(element.options).filter(
          (option) => option.value === value,
        );
        if (matches.length !== 1)
          return failure(
            "The value must match exactly one option.",
            "invalid_value",
          );
        if (matches[0].disabled || matches[0].closest("optgroup")?.disabled)
          return failure("The requested option is disabled.", "invalid_value");
      }
    };
    const invalidValue = validateValue();
    if (invalidValue) return invalidValue;
    const prototype = inputElement(element)
      ? HTMLInputElement.prototype
      : textAreaElement(element)
        ? HTMLTextAreaElement.prototype
        : HTMLSelectElement.prototype;
    element.focus({ preventScroll: true });
    if (
      !visible(element) ||
      element.matches(":disabled") ||
      element.getAttribute("aria-disabled") === "true" ||
      element.hasAttribute("readonly")
    )
      return failure(
        "The field changed while it was being focused. Inspect it again.",
      );
    const changedValue = validateValue();
    if (changedValue) return changedValue;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      element,
      value,
    );
  } else if (element.isContentEditable) {
    element.focus({ preventScroll: true });
    if (!visible(element) || !element.isContentEditable)
      return failure(
        "The field changed while it was being focused. Inspect it again.",
      );
    element.textContent = value;
  } else return failure("Element is not an editable field.");
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, ...reboundResult() };
}
