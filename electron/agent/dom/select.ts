import type { SearchAst } from "../selectors";

// The page side of the selector grammar. This whole function is serialized
// with toString and passed into the page script, so it has no imports and
// reads nothing outside itself. One instance serves one page operation and
// keeps the documents, trees and order it walked.

export type Level =
  "none" | "visible" | "enabled" | "pointer" | "pointer-enabled";
export type Mode = "strict" | "first" | "count";
export type WaitState = "attached" | "visible" | "hidden" | "detached";
export type Blocker = "hidden" | "disabled";
export interface Query {
  ast: SearchAst;
  mode: Mode;
  level: Level;
  state?: WaitState;
  firstRef?: number;
  picked?: string;
}
export interface Picked {
  node: Element;
  editable: boolean;
}
export interface Tally {
  count: number;
  visible: number;
  hidden: number;
  actionable: number;
}
export interface EngineHost {
  documents(): Document[];
  visible(element: Element, includeAriaHidden?: boolean): boolean;
  disabled(element: Element): boolean;
  covered(element: Element): boolean;
  editingHost(element: Element): boolean;
}
export type Invalid = {
  kind: "invalid";
  reason: "css" | "xpath";
  message: string;
  hint?: string;
};
export type Matches = { kind: "matches"; matches: Element[] };
export type Decision =
  | { kind: "match"; element: Element }
  | { kind: "none" }
  | { kind: "blocked"; element: Element; blocker: Blocker }
  | { kind: "ambiguous"; tally: Tally; candidates: Element[] }
  | Invalid;

export function selectorEngine(host: EngineHost) {
  type Tree = Document | ShadowRoot;
  const CSS_MESSAGE = "The page rejected this CSS selector.";
  const XPATH_MESSAGE =
    "The page rejected this XPath, or it selects something other than elements.";
  const DIGIT_HINT = 'Write ids that start with a digit as [id="1abc"].';
  // Elements whose text is not text of the page, and frame elements, whose
  // documents are searched on their own.
  const SILENT = [
    "head",
    "script",
    "style",
    "noscript",
    "template",
    "title",
    "iframe",
    "frame",
  ];

  // Search order: the documents as the host lists them, and inside each one
  // an element, then its open shadow root's elements, then its children. A
  // closed or user agent root has no shadowRoot, so nothing enters it and
  // nothing reads a root's mode.
  let docs: Document[] | undefined;
  const order = new Map<Element, number>();
  const treeLists = new Map<Document, Tree[]>();
  const documents = () => {
    if (!docs) {
      docs = host.documents();
      for (const doc of docs) {
        const roots: Tree[] = [doc];
        const step = (element: Element) => {
          order.set(element, order.size);
          const shadow = element.shadowRoot;
          if (shadow) {
            roots.push(shadow);
            for (const child of shadow.children) step(child);
          }
          for (const child of element.children) step(child);
        };
        if (doc.documentElement) step(doc.documentElement);
        treeLists.set(doc, roots);
      }
    }
    return docs;
  };
  const trees = (doc: Document) => treeLists.get(doc) || [doc];
  const sorted = (found: Element[]) => {
    const seen = new Set(found);
    return Array.from(seen).sort(
      (first, second) =>
        (order.get(first) ?? Infinity) - (order.get(second) ?? Infinity),
    );
  };

  const normalize = (text: string) =>
    text.replace(/[​­]/g, "").replace(/\s+/g, " ").trim();
  const isHtml = (element: Element) =>
    element.namespaceURI === "http://www.w3.org/1999/xhtml";
  // The text a button, submit or reset input shows, which stands for the
  // children it has none of.
  const buttonValue = (element: Element) => {
    if (element.localName !== "input" || !isHtml(element)) return undefined;
    const field = element as HTMLInputElement;
    if (
      field.type !== "button" &&
      field.type !== "submit" &&
      field.type !== "reset"
    )
      return undefined;
    return (
      field.value ||
      (field.type === "submit"
        ? "Submit"
        : field.type === "reset"
          ? "Reset"
          : "")
    );
  };
  // The nodes an element renders: its shadow root's children, a slot's
  // assigned nodes or its fallback, else its own children.
  const composedChildren = (element: Element): Node[] => {
    const shadow = element.shadowRoot;
    if (shadow) return Array.from(shadow.childNodes);
    if (element.localName === "slot") {
      const assigned = (element as HTMLSlotElement).assignedNodes({
        flatten: true,
      });
      return assigned.length ? assigned : Array.from(element.childNodes);
    }
    return Array.from(element.childNodes);
  };
  const texts = new Map<Element, string>();
  const composedText = (element: Element): string => {
    const known = texts.get(element);
    if (known !== undefined) return known;
    const value = buttonValue(element);
    let text = "";
    if (value !== undefined) text = value;
    else if (!SILENT.includes(element.localName))
      for (const node of composedChildren(element))
        text +=
          node.nodeType === 3
            ? (node as Text).data
            : node.nodeType === 1
              ? composedText(node as Element)
              : "";
    texts.set(element, text);
    return text;
  };
  // The runs of adjacent text an element holds itself, each one ended by an
  // element child. Comments neither end a run nor add to it.
  const ownRuns = (element: Element) => {
    const value = buttonValue(element);
    if (value !== undefined) return [value];
    const runs: string[] = [];
    let run = "";
    for (const node of element.childNodes) {
      if (node.nodeType === 3) run += (node as Text).data;
      else if (node.nodeType === 1) {
        if (run) runs.push(run);
        run = "";
      }
    }
    if (run) runs.push(run);
    return runs;
  };
  const holds = (element: Element, lowered: string) =>
    normalize(composedText(element)).toLowerCase().includes(lowered);
  const says = (element: Element, value: string) =>
    ownRuns(element).some((run) => normalize(run) === value);

  const invalid = (
    reason: Invalid["reason"],
    message: string,
    hint?: string,
  ): Invalid => ({
    kind: "invalid",
    reason,
    message,
    ...(hint === undefined ? {} : { hint }),
  });

  // CSS runs on the document and on each open shadow root alone, so no
  // selector reaches across a shadow boundary.
  const cssFound = (css: string): Element[] | Invalid => {
    const found: Element[] = [];
    for (const doc of documents())
      for (const tree of trees(doc)) {
        let hits: NodeListOf<Element>;
        try {
          hits = tree.querySelectorAll(css);
        } catch {
          return invalid(
            "css",
            CSS_MESSAGE,
            /#[0-9]/.test(css) ? DIGIT_HINT : undefined,
          );
        }
        for (const element of hits) found.push(element);
      }
    return sorted(found);
  };
  // The innermost elements whose rendered text holds the value: an element
  // drops out when something it renders holds the value too.
  const textFound = (value: string) => {
    const lowered = normalize(value).toLowerCase();
    const found: Element[] = [];
    const visit = (element: Element): boolean => {
      if (SILENT.includes(element.localName)) return false;
      let deeper = false;
      for (const node of composedChildren(element))
        if (node.nodeType === 1 && visit(node as Element)) deeper = true;
      const hit = holds(element, lowered);
      if (hit && !deeper) found.push(element);
      return hit || deeper;
    };
    for (const doc of documents())
      if (doc.documentElement) visit(doc.documentElement);
    return sorted(found);
  };
  const exactFound = (value: string) => {
    const wanted = normalize(value);
    const found: Element[] = [];
    for (const doc of documents())
      for (const tree of trees(doc))
        for (const element of tree.querySelectorAll("*"))
          if (says(element, wanted)) found.push(element);
    return sorted(found);
  };
  const hrefFound = (value: string) => {
    let absolute = "";
    try {
      absolute = new URL(value).href;
    } catch {}
    const found: Element[] = [];
    for (const doc of documents())
      for (const tree of trees(doc))
        for (const element of tree.querySelectorAll("a[href]")) {
          const link = element as HTMLAnchorElement;
          if (
            value === link.href ||
            value === link.pathname + link.search + link.hash ||
            (!!absolute && absolute === link.href)
          )
            found.push(element);
        }
    return sorted(found);
  };
  const xpathFound = (xpath: string): Element[] | Invalid => {
    const found: Element[] = [];
    for (const doc of documents()) {
      let result: XPathResult;
      try {
        // 7 is ORDERED_NODE_SNAPSHOT_TYPE as a number, so a frame's own
        // realm does not matter.
        result = doc.evaluate(xpath, doc, null, 7, null);
      } catch {
        return invalid("xpath", XPATH_MESSAGE);
      }
      for (let index = 0; index < result.snapshotLength; index++) {
        const node = result.snapshotItem(index);
        if (!node || node.nodeType !== 1)
          return invalid("xpath", XPATH_MESSAGE);
        found.push(node as Element);
      }
    }
    return sorted(found);
  };
  // The nodes a role resolution picked, kept only where this walk holds
  // them: the identity lookup comes first, so a node from a closed or user
  // agent root is dropped before anything reads it.
  const pickedFound = (picked: readonly Picked[] | undefined) => {
    documents();
    const found: Element[] = [];
    for (const entry of picked || []) {
      if (order.get(entry.node) === undefined) continue;
      if (!entry.node.isConnected) continue;
      if (entry.editable && !host.editingHost(entry.node)) continue;
      found.push(entry.node);
    }
    return sorted(found);
  };

  const search = (
    ast: SearchAst,
    picked?: readonly Picked[],
  ): Matches | Invalid => {
    if (ast.kind === "css") {
      const base = cssFound(ast.css);
      if (!Array.isArray(base)) return base;
      const filter = ast.filter;
      if (!filter) return { kind: "matches", matches: base };
      const value =
        filter.kind === "has-text"
          ? normalize(filter.value).toLowerCase()
          : normalize(filter.value);
      return {
        kind: "matches",
        matches: base.filter((element) =>
          filter.kind === "has-text"
            ? holds(element, value)
            : says(element, value),
        ),
      };
    }
    const found =
      ast.kind === "text"
        ? ast.exact
          ? exactFound(ast.value)
          : textFound(ast.value)
        : ast.kind === "href"
          ? hrefFound(ast.href)
          : ast.kind === "xpath"
            ? xpathFound(ast.xpath)
            : pickedFound(picked);
    return Array.isArray(found) ? { kind: "matches", matches: found } : found;
  };

  const blocker = (element: Element, level: Level): Blocker | undefined => {
    if (level === "none") return undefined;
    if (level === "visible")
      return host.visible(element, true) ? undefined : "hidden";
    if (!host.visible(element)) return "hidden";
    return (level === "enabled" || level === "pointer-enabled") &&
      host.disabled(element)
      ? "disabled"
      : undefined;
  };
  const passes = (element: Element, level: Level) =>
    blocker(element, level) === undefined;
  const pointerLevel = (level: Level) =>
    level === "pointer" || level === "pointer-enabled";
  const actionable = (element: Element, level: Level) =>
    passes(element, level) && (!pointerLevel(level) || !host.covered(element));
  // Covering never blocks a lone candidate. Between candidates the
  // uncovered ones stay, so a control behind a modal backdrop loses to the
  // one the dialog shows.
  const uncovered = (candidates: Element[], level: Level) => {
    if (!pointerLevel(level) || candidates.length < 2) return candidates;
    const open = candidates.filter((element) => !host.covered(element));
    return open.length ? open : candidates;
  };
  const counted = (matches: Element[], level: Level): Tally => {
    const seen = matches.filter((element) => host.visible(element, true));
    return {
      count: matches.length,
      visible: seen.length,
      hidden: matches.length - seen.length,
      actionable: matches.filter((element) => actionable(element, level))
        .length,
    };
  };
  // Up to 3 matches to name, the ones the action could take first.
  const nominate = (matches: Element[], level: Level) =>
    [
      ...matches.filter((element) => actionable(element, level)),
      ...matches.filter((element) => !actionable(element, level)),
    ].slice(0, 3);
  const stopped = (matches: Element[], level: Level): Decision => {
    const stop = blocker(matches[0], level);
    return stop
      ? { kind: "blocked", element: matches[0], blocker: stop }
      : { kind: "match", element: matches[0] };
  };

  const decide = (query: Query, picked?: readonly Picked[]): Decision => {
    const found = search(query.ast, picked);
    if (found.kind !== "matches") return found;
    const matches = found.matches;
    // nth picks from the whole list before any level applies.
    if (query.ast.nth !== undefined) {
      const element = matches.at(query.ast.nth);
      if (!element) return { kind: "none" };
      return stopped([element], query.level);
    }
    if (!matches.length) return { kind: "none" };
    if (query.mode === "first") {
      const first = matches.find((element) => passes(element, query.level));
      return first
        ? { kind: "match", element: first }
        : stopped(matches, query.level);
    }
    // The top document decides while it holds a candidate; otherwise the
    // frame documents decide together.
    const top = documents()[0];
    const inTop = uncovered(
      matches.filter(
        (element) =>
          element.ownerDocument === top && passes(element, query.level),
      ),
      query.level,
    );
    const group = inTop.length
      ? inTop
      : uncovered(
          matches.filter(
            (element) =>
              element.ownerDocument !== top && passes(element, query.level),
          ),
          query.level,
        );
    if (group.length === 1) return { kind: "match", element: group[0] };
    if (group.length > 1)
      return {
        kind: "ambiguous",
        tally: counted(matches, query.level),
        candidates: nominate(matches, query.level),
      };
    return stopped(matches, query.level);
  };

  const tally = (query: Query, picked?: readonly Picked[]): Tally | Invalid => {
    const found = search(query.ast, picked);
    if (found.kind !== "matches") return found;
    let matches = found.matches;
    if (query.ast.nth !== undefined) {
      const element = matches.at(query.ast.nth);
      matches = element ? [element] : [];
    }
    return counted(matches, query.level);
  };

  return { search, blocker, decide, tally };
}
