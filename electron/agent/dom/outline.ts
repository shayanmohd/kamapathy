// The page side of the outline format. This whole function is serialized
// with toString and passed into the page script, so it has no imports and
// reads nothing outside itself. It decides which nodes an outline prints,
// what names they carry and how deep they sit; the page script renders the
// lines, because the state, value and secret rules live there.

export interface OutlineHost {
  scope: Element;
  // Today's walk: open shadow roots, slots and same-origin frames.
  walk(root: Node, visit: (node: Node) => boolean | void): void;
  visible(element: Element, includeAriaHidden?: boolean): boolean;
  // The snapshot's controls in scope, after the viewport filter.
  controls: ReadonlySet<Element>;
  inView(element: Element): boolean;
  textInView(node: Text): boolean;
  roleOf(element: Element): string;
  labelOf(element: Element): string;
  frameDocument(element: Element): Document | null;
  opaqueFrame(element: Element): boolean;
  // Open dialogs and popups in scope, outermost only.
  popupRoots(): Element[];
  // A text node's rendered text, as pageText reads it.
  textOf(node: Text): string;
}
export interface OutlineItem {
  depth: number;
  parent: number;
  element?: Element;
  role?: string;
  name?: string;
  level?: number;
  text?: string;
  control: boolean;
  frame: boolean;
}

export function outlineBuilder(host: OutlineHost): OutlineItem[] {
  const LANDMARKS = [
    "banner",
    "navigation",
    "main",
    "complementary",
    "contentinfo",
    "search",
  ];
  // Printed whatever they hold.
  const STRUCTURE = [
    "dialog",
    "alertdialog",
    "heading",
    "list",
    "listitem",
    "table",
    "row",
    "cell",
    "columnheader",
    "rowheader",
    "canvas",
  ];
  // Printed when they hold a control.
  const CONTAINERS = [
    "group",
    "radiogroup",
    "toolbar",
    "menu",
    "menubar",
    "listbox",
    "tablist",
    "tabpanel",
    "tree",
    "treegrid",
    "grid",
  ];
  // Printed when the page names them.
  const NAMED = ["region", "form", "img"];
  // Named by the one text line inside them.
  const FROM_TEXT = [
    "heading",
    "listitem",
    "row",
    "cell",
    "columnheader",
    "rowheader",
  ];
  // What they are is the information, so an empty one still prints.
  const LEAVES = ["img", "canvas", "option"];
  const INLINE = ["inline", "inline-block", "contents"];
  // A select lists at most 20 options, and a snapshot 100.
  const PER_SELECT = 20;
  let optionBudget = 100;

  const clean = (value: string | null | undefined) =>
    (value || "").replace(/\s+/g, " ").trim();
  // The element around another as a person sees the page, as the snapshot's
  // own walk goes: its parent, the host of its shadow root, or the frame
  // showing its document.
  const up = (node: Node): Element | null => {
    const parent = node.parentNode;
    if (!parent) return null;
    if (parent.nodeType === 1) return parent as Element;
    if (parent.nodeType === 11) return (parent as ShadowRoot).host;
    if (parent.nodeType === 9)
      return (parent as Document).defaultView?.frameElement || null;
    return null;
  };
  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (element: Element) => {
    let style = styles.get(element);
    if (!style) {
      const view = (element.ownerDocument || document).defaultView || window;
      styles.set(element, (style = view.getComputedStyle(element)));
    }
    return style;
  };
  // The box a run of text belongs to, as pageText groups its blocks.
  const blockOf = (element: Element) => {
    let block = element;
    while (block.parentElement && INLINE.includes(styleOf(block).display))
      block = block.parentElement;
    return block;
  };
  const childOf = (element: Element, tag: string) => {
    for (const child of element.children)
      if (child.localName === tag) return child;
    return null;
  };
  const labelledBy = (element: Element) =>
    clean(
      (element.getAttribute("aria-labelledby") || "")
        .split(/\s+/)
        .map((id) => {
          const root = element.getRootNode() as Document;
          const source =
            id && root.getElementById ? root.getElementById(id) : null;
          return source ? source.textContent || "" : "";
        })
        .join(" "),
    );
  // Every element around a control, so a container holding one prints.
  const holders = new Set<Element>();
  for (const control of host.controls)
    for (
      let parent = up(control);
      parent && !holders.has(parent);
      parent = up(parent)
    )
      holders.add(parent);

  const items: OutlineItem[] = [];
  const index = new Map<Element, number>();
  // Legends and captions whose text became their container's name.
  const consumed = new Set<Element>();
  // The text item still being filled, if the last item is one.
  let open: { item: number; block: Element } | undefined;
  const push = (item: OutlineItem) => {
    items.push(item);
    return items.length - 1;
  };
  // The printed element around a node, which decides its depth. Everything
  // else is transparent.
  const ancestorOf = (node: Node) => {
    for (let parent = up(node); parent; parent = up(parent)) {
      const found = index.get(parent);
      if (found !== undefined) return found;
      if (parent === host.scope) break;
    }
    return -1;
  };
  const depthOf = (parent: number) =>
    parent === -1 ? 0 : items[parent].depth + 1;

  const levelOf = (element: Element) => {
    const given = Number(element.getAttribute("aria-level"));
    if (Number.isInteger(given) && given >= 1 && given <= 9) return given;
    const tag = element.localName;
    return /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : undefined;
  };
  const nameOf = (
    element: Element,
    role: string,
    control: boolean,
    frame: boolean,
  ) => {
    if (control || frame) return host.labelOf(element);
    if (role === "img")
      return (
        clean(element.getAttribute("alt")) ||
        clean(element.getAttribute("aria-label")) ||
        labelledBy(element)
      );
    // A heading, listitem, row or cell is named by the text inside it.
    if (FROM_TEXT.includes(role)) return "";
    let name = clean(element.getAttribute("aria-label")) || labelledBy(element);
    const describing =
      element.localName === "fieldset"
        ? childOf(element, "legend")
        : element.localName === "table"
          ? childOf(element, "caption")
          : null;
    if (!name && describing) {
      name = clean(describing.textContent);
      if (name) consumed.add(describing);
    }
    return name;
  };
  const candidate = (element: Element, role: string) =>
    LANDMARKS.includes(role) ||
    STRUCTURE.includes(role) ||
    NAMED.includes(role) ||
    element.localName === "fieldset" ||
    (CONTAINERS.includes(role) && holders.has(element));

  const addElement = (element: Element) => {
    const control = host.controls.has(element);
    const frame = !!host.frameDocument(element) || host.opaqueFrame(element);
    const role = host.roleOf(element);
    if (!control) {
      if (!frame && !candidate(element, role)) return undefined;
      if (!host.visible(element, true) || !host.inView(element))
        return undefined;
    }
    const name = nameOf(element, role, control, frame);
    if (!control && !frame && NAMED.includes(role) && !name) return undefined;
    const level = levelOf(element);
    const parent = ancestorOf(element);
    index.set(element, items.length);
    open = undefined;
    return push({
      depth: depthOf(parent),
      parent,
      element,
      role,
      ...(name ? { name } : {}),
      ...(level === undefined ? {} : { level }),
      control,
      frame,
    });
  };
  // A select's options are its children, within today's option budget.
  const addOptions = (select: Element, parent: number) => {
    const choices = (select as HTMLSelectElement).options;
    if (!choices) return;
    const room = Math.min(PER_SELECT, optionBudget);
    let taken = 0;
    for (let at = 0; at < choices.length && taken < room; at += 1) {
      const option = choices[at];
      if (option.value.length > 256) continue;
      taken += 1;
      const name = clean(option.label);
      push({
        depth: items[parent].depth + 1,
        parent,
        element: option,
        role: "option",
        ...(name ? { name } : {}),
        control: false,
        frame: false,
      });
    }
    optionBudget -= taken;
    open = undefined;
  };
  const addText = (node: Text) => {
    const parent = node.parentElement;
    if (!parent) return;
    const value = clean(host.textOf(node));
    if (!value) return;
    // Text a control, its label or a name already carries is not repeated.
    for (let element: Element | null = parent; element; element = up(element)) {
      if (
        host.controls.has(element) ||
        consumed.has(element) ||
        (element.localName === "label" &&
          !!(element as HTMLLabelElement).control)
      )
        return;
      if (element === host.scope) break;
    }
    if (!host.textInView(node)) return;
    const at = ancestorOf(node);
    const block = blockOf(parent);
    const held = open && items[open.item];
    if (held && open!.block === block && held.parent === at) {
      held.text = `${held.text} ${value}`;
      return;
    }
    open = {
      item: push({
        depth: depthOf(at),
        parent: at,
        text: value,
        control: false,
        frame: false,
      }),
      block,
    };
  };

  const visit = (node: Node): boolean | void => {
    if (node.nodeType === 3) return addText(node as Text);
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const at = addElement(element);
    // Options print as items, so the walk does not read their text.
    if (element.localName === "select") {
      if (at !== undefined) addOptions(element, at);
      return false;
    }
  };
  // An open dialog or popup prints first, with its subtree, and the rest of
  // the scope in tree order without it.
  const popups = host.popupRoots().filter((root) => root !== host.scope);
  const inPopup = new Set(popups);
  for (const root of popups) {
    visit(root);
    host.walk(root, visit);
  }
  visit(host.scope);
  host.walk(host.scope, (node) => {
    if (node.nodeType === 1 && inPopup.has(node as Element)) return false;
    return visit(node);
  });

  // A printed element with no name and nothing inside it says nothing.
  const kids: number[][] = items.map(() => []);
  for (const [at, item] of items.entries())
    if (item.parent >= 0) kids[item.parent].push(at);
  const dropped = new Set<number>();
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at];
    const inside = kids[at].filter((kid) => !dropped.has(kid));
    const only = inside.length === 1 ? items[inside[0]] : undefined;
    if (
      only?.text !== undefined &&
      !item.name &&
      FROM_TEXT.includes(item.role || "")
    ) {
      item.name = only.text;
      dropped.add(inside[0]);
      inside.length = 0;
    }
    if (
      !item.control &&
      !item.frame &&
      item.text === undefined &&
      !item.name &&
      !inside.length &&
      !LEAVES.includes(item.role || "")
    )
      dropped.add(at);
  }
  const places = new Map<number, number>();
  const kept: OutlineItem[] = [];
  for (const [at, item] of items.entries()) {
    if (dropped.has(at)) continue;
    places.set(at, kept.length);
    kept.push({
      ...item,
      parent: item.parent >= 0 ? (places.get(item.parent) ?? -1) : -1,
    });
  }
  return kept;
}
