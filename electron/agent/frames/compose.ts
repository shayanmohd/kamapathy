import type { Area, OwnerBox } from "./geometry";

// Section 9's composition, in the main process: several frame group reads of
// one page become one snapshot. A frame's content goes where its owner sits,
// controls are ranked across frames, outlines nest and local frame paths are
// joined with their group's. Nothing here measures or reads a page: it only
// reorders, splices and prefixes what the reads already carry.

/** The owner a read left behind for a frame its world cannot read. */
export interface OwnerPlaceholder {
  /** The binding key the frame's world knows the owner by. */
  key?: string;
  /** The frame path of the owner's content, inside its own group. */
  local: string;
  /** The walk position of the owner in the read around it. */
  order: number;
  /** The rank the read gave the owner, as controls carry it. */
  tier: number;
  box: Area;
  /** The owner's content box, folded through the frames of its own group. */
  content?: OwnerBox;
  /** The part of the top viewport the owner shows, in its group's pixels. */
  area?: Area;
  origin?: string;
  readable: boolean;
  /** An extension, PDF viewer, internal or file frame, never read. */
  blocked?: true;
}
/** What one frame group's read reports, in that group's own paths. */
export interface GroupRead {
  /** The group root's frame path, "" for the top group. */
  group: string;
  /** The placeholder the read around this one left for this group. */
  owner?: OwnerPlaceholder;
  text: { order: number; value: string }[];
  controls: {
    order: number;
    tier: number;
    local: string;
    entry: Record<string, unknown>;
  }[];
  outline: {
    order: number;
    depth: number;
    line: string;
    /** A control or frame line, which maxControls bounds. */
    control?: true;
  }[];
  placeholders: OwnerPlaceholder[];
  /** The characters this read's text parts hold together. */
  chars: number;
  truncated?: true;
}

/**
 * The rank automation-dom gives a control the person cannot see. Its rank()
 * doubles a tier of 5 and adds one for a control found by its text, so every
 * rank from here up is off screen.
 */
export const OFF_SCREEN_TIER = 10;
const offScreen = (tier: number) => tier >= OFF_SCREEN_TIER;
/** The more urgent of a control's own rank and its owner's, or last off screen. */
const rankWith = (tier: number, owner: number) =>
  offScreen(tier) || offScreen(owner)
    ? Math.max(tier, owner)
    : Math.min(tier, owner);

/** A frame path local to a group, as the whole page counts it. */
export function prefixPath(group: string, local: string): string {
  if (!group) return local;
  if (!local) return group;
  return `${group}/${local}`;
}
const segmentsOf = (path: string) => (path ? path.split("/") : []);
/** Depth first by frame path: a frame before the frames inside it, siblings in page order. */
export function comparePaths(first: string, second: string): number {
  const left = segmentsOf(first);
  const right = segmentsOf(second);
  for (let at = 0; at < Math.min(left.length, right.length); at += 1)
    if (left[at] !== right[at]) return Number(left[at]) - Number(right[at]);
  return left.length - right.length;
}
const insidePath = (outer: string, inner: string) => {
  if (outer === inner) return false;
  if (!outer) return true;
  return inner.startsWith(`${outer}/`);
};

/** The reads in document order: the top group first, then depth first by path. */
export function orderReads(reads: readonly GroupRead[]): GroupRead[] {
  return [...reads].sort((first, second) =>
    comparePaths(first.group, second.group),
  );
}

type Node = { read: GroupRead; children: Node[] };
/** The reads as the tree of groups their paths describe, each level in page order. */
function treeOf(reads: readonly GroupRead[]): Node[] {
  const ordered = orderReads(reads).map((read) => ({ read, children: [] }));
  const roots: Node[] = [];
  for (const node of ordered) {
    // The innermost read around this one owns it; a group whose owner was
    // never read stands on its own.
    let parent: Node | undefined;
    for (const other of ordered)
      if (
        insidePath(other.read.group, node.read.group) &&
        (!parent || other.read.group.length > parent.read.group.length)
      )
        parent = other;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}
/** Where in its owner's read a group's content belongs, by the owner's walk position. */
function splicePoint(node: Node, child: Node): number | undefined {
  for (const placeholder of node.read.placeholders)
    if (prefixPath(node.read.group, placeholder.local) === child.read.group)
      return placeholder.order;
  return undefined;
}
type Row<T> =
  { item: T; child?: undefined } | { child: Node; item?: undefined };
/** A read's own items and the groups inside it, in the order the walk met them. */
function sequence<T extends { order: number }>(
  node: Node,
  items: readonly T[],
): Row<T>[] {
  const rows: { at: number; own: number; row: Row<T> }[] = [];
  for (const item of items)
    rows.push({ at: item.order, own: 0, row: { item } });
  for (const child of node.children)
    rows.push({
      // A group whose placeholder is not in this read follows the read's own
      // items, in path order.
      at: splicePoint(node, child) ?? Number.MAX_SAFE_INTEGER,
      own: 1,
      row: { child },
    });
  // A group's content follows the owner's own item at the same position.
  return rows
    .sort((first, second) => first.at - second.at || first.own - second.own)
    .map((row) => row.row);
}

function textOf(node: Node): string {
  let text = "";
  // A frame's text sits on lines of its own, so the part after it starts a
  // line as well.
  let broken = false;
  const breakLine = (next: string) => {
    if (text && !text.endsWith("\n") && !next.startsWith("\n")) text += "\n";
  };
  for (const row of sequence(node, node.read.text))
    if (row.item) {
      if (broken) breakLine(row.item.value);
      broken = false;
      text += row.item.value;
    } else {
      const inner = textOf(row.child);
      if (!inner) continue;
      breakLine(inner);
      text += inner;
      broken = true;
    }
  return text;
}

/**
 * The page's text with each frame's text where its owner sits, cut to the
 * part the cursor asks for. `chars` counts the whole composed text, and
 * `next` says where the next part starts when this one stopped early.
 */
export function spliceText(
  reads: readonly GroupRead[],
  options: { maxChars: number; from?: number },
): { text: string; chars: number; next?: number } {
  const whole = treeOf(reads).map(textOf).filter(Boolean).join("\n");
  const from = offsetOf(options.from);
  const text = whole.slice(from, from + Math.max(0, options.maxChars));
  const end = from + text.length;
  return {
    text,
    chars: whole.length,
    ...(end < whole.length ? { next: end } : {}),
  };
}

/**
 * One group's text cut to the characters a part can reach, so a frame cannot
 * spend the whole budget before the text around it is placed.
 */
export function boundGroup(
  read: GroupRead,
  from: number,
  maxChars: number,
): GroupRead {
  const limit = offsetOf(from) + Math.max(0, maxChars);
  const text: GroupRead["text"] = [];
  let used = 0;
  let cut = false;
  for (const part of [...read.text].sort(byOrder)) {
    const value = part.value.slice(0, Math.max(0, limit - used));
    cut ||= value.length < part.value.length;
    used += value.length;
    if (value) text.push({ ...part, value });
  }
  if (!cut) return read;
  return { ...read, text, chars: used, truncated: true };
}

type Flat = {
  tier: number;
  at: number;
  group: string;
  local: string;
  entry: Record<string, unknown>;
};
function flatControls(
  nodes: readonly Node[],
  owner: number | undefined,
  flat: Flat[],
): void {
  for (const node of nodes) {
    const tier =
      node.read.owner === undefined
        ? owner
        : owner === undefined
          ? node.read.owner.tier
          : rankWith(node.read.owner.tier, owner);
    for (const row of sequence(node, node.read.controls))
      if (row.item)
        flat.push({
          tier:
            tier === undefined ? row.item.tier : rankWith(row.item.tier, tier),
          at: flat.length,
          group: node.read.group,
          local: row.item.local,
          entry: row.item.entry,
        });
      else flatControls([row.child], tier, flat);
  }
}

/**
 * The controls of every group as one list: ranked together, cut to the part's
 * budget and returned in page order, with each entry's frame paths joined.
 */
export function mergeControls(
  reads: readonly GroupRead[],
  options: { maxControls: number; from?: number },
): { controls: Record<string, unknown>[]; omitted: number } {
  const flat: Flat[] = [];
  flatControls(treeOf(reads), undefined, flat);
  const from = offsetOf(options.from);
  const chosen = [...flat]
    .sort((first, second) => first.tier - second.tier || first.at - second.at)
    .slice(from, from + Math.max(0, options.maxControls))
    .sort((first, second) => first.at - second.at);
  const controls = chosen.map((row, index) => {
    const entry = { ...row.entry };
    // A listed entry's index is its place in this part, as a single
    // document's entries are numbered.
    if (typeof entry.index === "number") entry.index = index;
    const frame = prefixPath(row.group, row.local);
    if (frame) entry.frame = frame;
    if (typeof entry.contentFrame === "string")
      entry.contentFrame = prefixPath(row.group, entry.contentFrame);
    return entry;
  });
  return {
    controls,
    omitted: Math.max(0, flat.length - from - chosen.length),
  };
}

type Line = { depth: number; text: string; control: boolean };
function flatOutline(nodes: readonly Node[], depth: number, lines: Line[]) {
  for (const node of nodes) {
    // A group's lines sit one level under its owner's line.
    let base = depth;
    for (const row of sequence(node, node.read.outline))
      if (row.item) {
        base = depth + row.item.depth + 1;
        lines.push({
          depth: depth + row.item.depth,
          text: "  ".repeat(depth + row.item.depth) + row.item.line,
          control: row.item.control === true,
        });
      } else flatOutline([row.child], base, lines);
  }
}

/**
 * The outline of every group, nested under its iframe line, from the
 * cursor's line within both bounds and after the lines around it. `omitted`
 * counts the control and frame lines after the part that the reads reported.
 */
export function nestOutline(
  reads: readonly GroupRead[],
  options: { maxChars: number; maxControls: number; from?: number },
): { outline: string[]; omitted: number; next?: number } {
  const lines: Line[] = [];
  flatOutline(treeOf(reads), 0, lines);
  const outline: string[] = [];
  let used = 0;
  let taken = 0;
  const from = offsetOf(options.from);
  // A continued part first repeats the lines around its first line, which
  // cost characters but are not progress: each line above it that sits
  // less deep than every line between them, across frames too.
  if (from > 0 && from < lines.length) {
    const around: string[] = [];
    let depth = lines[from].depth;
    for (let above = from - 1; above >= 0 && depth > 0; above -= 1)
      if (lines[above].depth < depth) {
        around.unshift(lines[above].text);
        depth = lines[above].depth;
      }
    for (const text of around) {
      outline.push(text);
      used += text.length + 1;
    }
  }
  let at = from;
  // A part always prints one line, so a cursor never sticks.
  for (; at < lines.length; at += 1) {
    const line = lines[at];
    if (
      at > from &&
      ((line.control && taken >= options.maxControls) ||
        used + line.text.length + 1 > options.maxChars)
    )
      break;
    outline.push(line.text);
    used += line.text.length + 1;
    if (line.control) taken += 1;
  }
  return {
    outline,
    omitted: lines.slice(at).filter((line) => line.control).length,
    ...(at < lines.length ? { next: at } : {}),
  };
}

/** The frames these reads left pending, unavailable or past a limit. */
export function countUnread(
  reads: readonly GroupRead[],
  contentOf: (frame: string) => string,
): number {
  let unread = 0;
  for (const read of reads)
    for (const placeholder of read.placeholders) {
      const content = contentOf(prefixPath(read.group, placeholder.local));
      if (
        content === "pending" ||
        content === "unavailable" ||
        content === "limit"
      )
        unread += 1;
    }
  return unread;
}

const byOrder = (first: { order: number }, second: { order: number }) =>
  first.order - second.order;
const offsetOf = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) || value < 0
    ? 0
    : Math.trunc(value);
