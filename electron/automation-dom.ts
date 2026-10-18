export interface SnapshotOptions {
  mode: "compact" | "full";
  selector?: string;
  maxChars: number;
  maxControls: number;
  firstRef: number;
}
export interface ElementTarget {
  ref?: string;
  selector?: string;
}
export type PageOperation =
  | "snapshot"
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
  | "frameIndex";

// This complete function is serialized into a separate Chromium world. It has no
// imports, Node APIs, or access to the browser interface's preload bridge.
export function pageOperation(
  operation: PageOperation,
  payload: Record<string, unknown>,
  namespace: string,
) {
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
  const failure = (error: string, code = "element_action_failed") => ({
    ok: false as const,
    code,
    error,
  });
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
  // A frame whose content stays out of reach, such as a payment form or a
  // map from another origin.
  const opaqueFrame = (element: Element) =>
    (element.localName === "iframe" || element.localName === "frame") &&
    !frameDocument(element);
  // The frame elements around an element, outermost first, or undefined once
  // its document is no longer shown in this page.
  const framesOf = (element: Element) => {
    const frames: Element[] = [];
    for (let doc = docOf(element); doc !== document; ) {
      const frame = doc.defaultView?.frameElement;
      if (!frame?.isConnected) return undefined;
      frames.unshift(frame);
      doc = docOf(frame);
    }
    return frames;
  };
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
  // Where an element sits in the top viewport, through the frames around it,
  // and the part of that viewport those frames can show.
  const placed = (element: Element) => {
    const box = element.getBoundingClientRect();
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    let x = 0,
      y = 0,
      scaleX = 1,
      scaleY = 1;
    for (const frame of framesOf(element) || []) {
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
  const pageText = (scope: Element, maximum = Infinity) => {
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
  const unique = (selector: string) => {
    try {
      const matches = matching(selector);
      if (matches.length !== 1)
        return failure(
          `Selector matched ${matches.length} elements. Use a unique selector.`,
        );
      return matches[0];
    } catch {
      return failure("Invalid CSS selector.", "invalid_selector");
    }
  };
  // A frame from another origin is listed so an agent knows content is
  // there, but nothing in it can be read or operated from this page.
  const reachable = (element: Element) =>
    opaqueFrame(element)
      ? failure(
          "This control is inside a frame from another origin, which Kamapathy cannot read. Ask the person to continue there.",
          "cross_origin_frame",
        )
      : element;
  const target = (spec = payload as ElementTarget) => {
    if (typeof spec.ref === "string") {
      const element = registry.elements.get(spec.ref);
      if (element && live(element)) return reachable(element);
      const replacement = rebind(spec.ref);
      if (replacement) {
        registry.elements.set(spec.ref, replacement);
        registry.refs.set(replacement, spec.ref);
        rebound.push(spec.ref);
        return reachable(replacement);
      }
      registry.elements.delete(spec.ref);
      registry.fingerprints.delete(spec.ref);
      return failure(
        "Element reference is stale. Take a new snapshot.",
        "stale_ref",
      );
    }
    if (typeof spec.selector === "string") {
      const found = unique(spec.selector);
      return isElement(found) ? reachable(found) : found;
    }
    return failure(
      "Provide an element reference or a unique CSS selector.",
      "invalid_target",
    );
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
    opaqueFrame(element) ||
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
  if (operation === "snapshot") {
    styles = new Map();
    const options = payload as unknown as SnapshotOptions;
    let scope: Element = document.body || document.documentElement;
    if (options.selector) {
      const selected = unique(options.selector);
      if (!isElement(selected)) return selected;
      scope = selected;
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
        (element.matches(query) || opaqueFrame(element)) &&
        isControl(element) &&
        (visible(element) || uploadControl(element))
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
        if (text && text.length <= 200 && visible(element)) {
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
    // When a page has more controls than the budget, list what a person can
    // act on now: open dialogs and popups, then pinned bars on screen, then
    // the rest of the screen, then everything else, keeping page order.
    let chosen = all;
    if (all.length > options.maxControls) {
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
      const onScreen = (element: Element) => {
        const box = placed(element);
        return (
          box.bottom > box.clip.top &&
          box.right > box.clip.left &&
          box.top < box.clip.bottom &&
          box.left < box.clip.right
        );
      };
      const rank = (element: Element) => {
        // A file input hidden inside upload UI sits where its parent is.
        const shown = onScreen(
          element.getClientRects().length
            ? element
            : element.parentElement || element,
        );
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
      chosen = all
        .map((element, index) => ({ element, index, rank: rank(element) }))
        .sort(
          (first, second) =>
            first.rank - second.rank || first.index - second.index,
        )
        .slice(0, options.maxControls)
        .sort((first, second) => first.index - second.index)
        .map((item) => item.element);
    }
    const limit = options.mode === "compact" ? 80 : 200;
    let nextRef = options.firstRef;
    // The numbers this snapshot assigned, so the main process knows which
    // refs the tab was issued.
    const issued: number[] = [];
    let remainingOptions = 100;
    let optionsTruncated = false;
    const prints = new Map<string, Fingerprint>();
    const interactables = chosen.map((element, index) => {
      let ref = registry.refs.get(element);
      if (!ref || registry.elements.get(ref) !== element) {
        const number = nextRef++;
        issued.push(number);
        ref = `@e${number}`;
        registry.refs.set(element, ref);
        registry.elements.set(ref, element);
      }
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
    });
    // A control that looks like another visible control, listed or not and in
    // or outside a scoped snapshot, cannot be told apart from it once it is
    // gone, so its ref never follows a redrawn control.
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
      options.selector
        ? Array.from(document.querySelectorAll(query)).filter(
            (element) => isControl(element) && visible(element),
          )
        : [],
    );
    for (const element of all) others.add(element);
    for (const element of chosen) others.delete(element);
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
      if (lookalikes.get(keyOf(print))! > 1) registry.fingerprints.delete(ref);
      else registry.fingerprints.set(ref, print);
    const omitted = all.length - chosen.length;
    let text = pageText(scope, options.maxChars);
    if (options.mode === "compact")
      text = text
        .replace(/[\t ]+/g, " ")
        .replace(/\n\s*\n\s*\n/g, "\n\n")
        .trim();
    return {
      url: location.href,
      title: document.title,
      text: text.slice(0, options.maxChars),
      interactables,
      ...(issued.length ? { issued } : {}),
      ...(omitted ? { omittedControls: omitted } : {}),
      truncated:
        text.length > options.maxChars || omitted > 0 || optionsTruncated,
    };
  }
  if (operation === "check") {
    let scope: Element = document.body || document.documentElement;
    if (typeof payload.selector === "string") {
      let matches: Element[];
      try {
        matches = matching(payload.selector);
      } catch {
        return failure("Invalid CSS selector.", "invalid_selector");
      }
      if (matches.length !== 1 || !visible(matches[0], true))
        return { ok: true, matched: false };
      scope = matches[0];
    }
    const text = pageText(scope);
    return {
      ok: true,
      matched:
        typeof payload.text === "string"
          ? text.includes(payload.text)
          : typeof payload.selector === "string" ||
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
    const around = framePath(element);
    return { ok: true, path: around ? `${around}/${index}` : `${index}` };
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
    if (!start && !pageScrolls)
      start = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
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
