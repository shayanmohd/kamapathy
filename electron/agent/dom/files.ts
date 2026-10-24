// The page side of file inputs: the walk from a match to the input a person
// would use, and the bytes going in through a DataTransfer. This complete
// function is serialized into Kamapathy's isolated world, so it has no
// imports and reads nothing outside itself. The page script passes the match
// it resolved and a way to ref the input this picks; the file chooser passes
// the node it resolved instead, which may be detached and has no ref.

export type FileOperation = "retargetFile" | "applyFiles";
export interface FilePayload {
  files?: { name: string; type: string; data: string }[];
  /** The ref the retarget answered with, which the apply files. */
  ref?: string;
  /** The ref number the main process reserved for the input picked here. */
  firstRef?: number;
}
/** Most files one call puts on an input. */
export const MAX_INPUT_FILES = 8;

export function fileOperation(
  operation: FileOperation,
  payload: Record<string, unknown>,
  namespace: string,
  element?: unknown,
  refFor?: (chosen: Element) => string | undefined,
): Record<string, unknown> {
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
  const HTML = "http://www.w3.org/1999/xhtml";
  const isElement = (value: unknown): value is Element =>
    !!value && (value as Node).nodeType === 1;
  // Elements of a same-origin frame belong to that frame's realm, where
  // instanceof against this document's constructors is false, so a file
  // input is told apart by its tag and type.
  const fileInput = (value: unknown): value is HTMLInputElement =>
    isElement(value) &&
    value.namespaceURI === HTML &&
    value.localName === "input" &&
    (value as HTMLInputElement).type === "file";
  // Up the composed chain: parents, then the host of an open shadow root.
  const up = (node: Element): Element | null =>
    node.parentElement ??
    (node.getRootNode() as { host?: Element }).host ??
    null;
  const labelControl = (node: Element) => {
    if (node.localName !== "label" || node.namespaceURI !== HTML)
      return undefined;
    const control = (node as HTMLLabelElement).control;
    return fileInput(control) ? control : undefined;
  };

  // The element to work from: the node the chooser resolved, or the one this
  // ref was issued for. A file input's ref is never moved to another
  // element, so a ref whose element is gone means the page changed.
  let match: Element | undefined;
  if (isElement(element)) match = element;
  else if (typeof payload.ref === "string") {
    const world = globalThis as unknown as {
      __kamapathyReferences?: {
        namespace: string;
        document: Document;
        elements: Map<string, Element>;
      };
    };
    const registry = world.__kamapathyReferences;
    const held =
      registry &&
      registry.namespace === namespace &&
      registry.document === document
        ? registry.elements.get(payload.ref)
        : undefined;
    if (!held || !held.isConnected)
      return failure(
        "The page changed during the transfer. Take a fresh snapshot.",
        "page_changed",
      );
    match = held;
  }
  if (!match)
    return failure(
      "Provide an element reference or a selector.",
      "invalid_target",
    );

  // Why this input cannot take files, reading up the composed chain.
  const unusable = (input: HTMLInputElement) => {
    if (input.webkitdirectory) return "Directory uploads are not supported.";
    for (let node: Element | null = input; node; node = up(node)) {
      if (node.hasAttribute("inert"))
        return "This file input is in an inert part of the page.";
      if (
        node.matches(":disabled") ||
        node.getAttribute("aria-disabled") === "true"
      )
        return "This file input is disabled.";
    }
    return undefined;
  };

  if (operation === "retargetFile") {
    // The order a person's eye follows: the input itself, the control of a
    // label, the control of the label around the match, then the one file
    // input the match holds, through open shadow roots.
    let input = fileInput(match) ? match : labelControl(match);
    if (!input)
      // The nearest enclosing label, whose control a click would reach.
      for (let node = up(match); node; node = up(node))
        if (node.localName === "label" && node.namespaceURI === HTML) {
          input = labelControl(node);
          break;
        }
    let count = 0;
    if (!input) {
      const found: HTMLInputElement[] = [];
      // An element, then its open shadow root's elements, then its children,
      // the order the selector engine walks. A closed root has no shadowRoot,
      // so nothing enters it.
      const inside = (node: Element) => {
        const shadow = node.shadowRoot;
        if (shadow) for (const child of shadow.children) step(child);
        for (const child of node.children) step(child);
      };
      const step = (node: Element) => {
        if (fileInput(node)) found.push(node);
        inside(node);
      };
      inside(match);
      count = found.length;
      if (count === 1) input = found[0];
    }
    if (count > 1)
      return failure(
        `This target holds ${count} file inputs. Name the one to file, or its label.`,
        "multiple_file_inputs",
        { count },
      );
    if (!input)
      return failure(
        "This target is not a file input and holds none. Take a snapshot and name the file input or its label.",
        "invalid_upload_target",
      );
    const problem = unusable(input);
    if (problem) return failure(problem, "invalid_upload_target");
    const ref = refFor?.(input);
    if (ref === undefined)
      return failure("Kamapathy could not reference this file input.");
    return { ok: true, ref };
  }

  if (!fileInput(match))
    return failure("This target is not a file input.", "invalid_upload_target");
  const input = match;
  const problem = unusable(input);
  if (problem) return failure(problem, "invalid_upload_target");
  const files = Array.isArray(payload.files)
    ? (payload.files as { name: string; type: string; data: string }[])
    : [];
  // An empty list clears the selection, so it answers to neither check.
  if (files.length) {
    if (!input.multiple && files.length !== 1)
      return failure("This input accepts one file at a time.", "invalid_files");
    const accepted = input.accept
      .toLowerCase()
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    for (const file of files)
      if (
        accepted.length &&
        !accepted.some((rule) =>
          rule.startsWith(".")
            ? file.name.toLowerCase().endsWith(rule)
            : rule.endsWith("/*")
              ? file.type.toLowerCase().startsWith(rule.slice(0, -1))
              : rule === file.type.toLowerCase(),
        )
      )
        return failure(
          "A file does not match this input's accepted file types.",
          "invalid_file_type",
        );
  }
  // The input's own realm: a same-origin frame has its own constructors, and
  // its files setter refuses a call from another one.
  const view = input.ownerDocument?.defaultView ?? window;
  try {
    const transfer = new view.DataTransfer();
    for (const file of files) {
      const binary = view.atob(file.data);
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0),
      );
      transfer.items.add(
        new view.File([bytes], file.name, { type: file.type }),
      );
    }
    const selection = Object.getOwnPropertyDescriptor(
      view.HTMLInputElement.prototype,
      "files",
    );
    if (!selection?.set) return failure("This page replaced its file inputs.");
    selection.set.call(input, transfer.files);
    input.dispatchEvent(new view.Event("input", { bubbles: true }));
    input.dispatchEvent(new view.Event("change", { bubbles: true }));
  } catch {
    return failure("The file input refused these files.");
  }
  return { ok: true, selected: input.files ? input.files.length : 0 };
}

/** Self-contained: serialized whole into Kamapathy's isolated world. */
export const FILES_SOURCE = fileOperation.toString();

/**
 * The Runtime.callFunctionOn declaration the chooser path uses on a resolved
 * input node, which has no ref to look up.
 */
export function applyCallSource(): string {
  return `function(payload){return (${FILES_SOURCE})("applyFiles",payload,"",this)}`;
}
