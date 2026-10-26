// Section 9's owner binding. This complete function is serialized and called
// with a frame's owner element as `this`, in Kamapathy's world of the group
// around it, so later reads and actions reach the frame through the owner the
// main process already resolved. It has no imports and shares nothing with the
// page: the table lives in the isolated world's own globals.

export function bindFrameOwner(
  this: Element,
  key: string,
): { local: string; readable: boolean } {
  const owner = this;
  const world = globalThis as unknown as {
    __kamapathyFrames?: {
      byKey: Map<string, Element>;
      keyOf: WeakMap<Element, string>;
    };
  };
  const table = (world.__kamapathyFrames ||= {
    byKey: new Map<string, Element>(),
    keyOf: new WeakMap<Element, string>(),
  });
  // One entry per owner: a frame bound again under another key drops the old
  // one, so a key never names a frame the main process moved on from.
  const held = table.keyOf.get(owner);
  if (held !== undefined && held !== key) table.byKey.delete(held);
  table.byKey.set(key, owner);
  table.keyOf.set(owner, key);
  const isFrame = (element: Element) =>
    element.localName === "iframe" || element.localName === "frame";
  // The frames of one document in the order a person sees them, through open
  // shadow roots and slots, as the page script's own walk counts them, so a
  // path here is the path a snapshot prints.
  const framesIn = (doc: Document) => {
    const found: Element[] = [];
    const into = (nodes: Iterable<Node>) => {
      for (const node of nodes) {
        if (node.nodeType !== 1) continue;
        const element = node as Element;
        if (isFrame(element)) {
          found.push(element);
          continue;
        }
        if (element.shadowRoot) into(element.shadowRoot.childNodes);
        else if (element.localName === "slot") {
          const assigned = (element as HTMLSlotElement).assignedNodes({
            flatten: true,
          });
          into(assigned.length ? assigned : element.childNodes);
        } else into(element.childNodes);
      }
    };
    into(doc.childNodes);
    return found;
  };
  // The frame's own path inside this group: the index of every frame between
  // this world's document and the owner, outermost first.
  const path: number[] = [];
  for (let frame: Element | null = owner; frame;) {
    const doc: Document | null = frame.ownerDocument;
    if (!doc) break;
    const index = framesIn(doc).indexOf(frame);
    if (index < 0) break;
    path.unshift(index);
    if (doc === document) break;
    frame = doc.defaultView?.frameElement ?? null;
  }
  return {
    local: path.join("/"),
    readable: !!(
      isFrame(owner) && (owner as HTMLIFrameElement).contentDocument
    ),
  };
}
