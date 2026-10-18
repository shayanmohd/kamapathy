import { fail } from "../errors";

export const MAX_GLOB = 2048;

export interface UrlGlob {
  readonly source: string;
  // A glob with no star, brace or backslash that parses as a URL. It is
  // compared normalized, so https://example.com matches https://example.com/.
  readonly plain: boolean;
  matches(url: string): boolean;
}

// One alternative group holds literals and stars, never another group.
type Token =
  | { kind: "literal"; code: number }
  | { kind: "star"; cross: boolean }
  | { kind: "slashStar" }
  | { kind: "group"; alternatives: Token[][] };

const SLASH = "/".charCodeAt(0);
// State kinds. A split consumes nothing and is followed during the epsilon
// closure, so only literal and star states ever sit in the active set.
const LITERAL = 0,
  STAR_IN_SEGMENT = 1,
  STAR = 2,
  SPLIT = 3;

type Exit = { state: number; second: boolean };
type Part = { entry: number; exits: Exit[] };

function parse(glob: string, field: string): Token[] {
  const braces = () =>
    fail(
      "invalid_field",
      "Braces in a URL glob hold one level of alternatives, such as {a,b}.",
      { field },
    );
  const tokens: Token[] = [];
  let group: { kind: "group"; alternatives: Token[][] } | undefined;
  let sequence = tokens;
  const literal = (character: string) =>
    sequence.push({ kind: "literal", code: character.charCodeAt(0) });
  let index = 0;
  while (index < glob.length) {
    const character = glob[index];
    if (character === "\\") {
      if (index + 1 === glob.length)
        fail("invalid_field", "A URL glob cannot end with a backslash.", {
          field,
        });
      literal(glob[index + 1]);
      index += 2;
      continue;
    }
    if (character === "{") {
      if (group) return braces();
      group = { kind: "group", alternatives: [[]] };
      sequence = group.alternatives[0];
      index += 1;
      continue;
    }
    if (character === "}") {
      if (!group) return braces();
      tokens.push(group);
      group = undefined;
      sequence = tokens;
      index += 1;
      continue;
    }
    if (character === "," && group) {
      sequence = [];
      group.alternatives.push(sequence);
      index += 1;
      continue;
    }
    if (character === "*") {
      let stars = 0;
      while (glob[index] === "*") {
        stars += 1;
        index += 1;
      }
      const cross = stars > 1;
      const last = sequence.at(-1);
      // A ** directly after a / and followed by one may match nothing, so
      // https://example.com/**/done matches https://example.com/done.
      if (
        cross &&
        glob.charCodeAt(index) === SLASH &&
        last?.kind === "literal" &&
        last.code === SLASH
      ) {
        sequence.push({ kind: "slashStar" });
        index += 1;
        continue;
      }
      if (last?.kind === "star") last.cross = last.cross || cross;
      else sequence.push({ kind: "star", cross });
      continue;
    }
    literal(character);
    index += 1;
  }
  if (group) return braces();
  return tokens;
}

// A Thompson machine over the token tree: states hold at most two outgoing
// edges, and a group's alternatives are flattened into the same state list.
function compile(tokens: Token[]) {
  const kinds: number[] = [],
    codes: number[] = [],
    first: number[] = [],
    second: number[] = [];
  const state = (kind: number, code = 0) => {
    kinds.push(kind);
    codes.push(code);
    first.push(-1);
    second.push(-1);
    return kinds.length - 1;
  };
  const patch = (exits: Exit[], target: number) => {
    for (const exit of exits)
      if (exit.second) second[exit.state] = target;
      else first[exit.state] = target;
  };
  const emitToken = (token: Token): Part => {
    if (token.kind === "literal") {
      const index = state(LITERAL, token.code);
      return { entry: index, exits: [{ state: index, second: false }] };
    }
    if (token.kind === "star") {
      const split = state(SPLIT);
      const run = state(token.cross ? STAR : STAR_IN_SEGMENT);
      first[split] = run;
      // The run leads back to the split, so one match of the star may be
      // followed by another or by whatever the split skips to.
      first[run] = split;
      return { entry: split, exits: [{ state: split, second: true }] };
    }
    if (token.kind === "slashStar") {
      const split = state(SPLIT);
      const run = emitToken({ kind: "star", cross: true });
      first[split] = run.entry;
      const slash = state(LITERAL, SLASH);
      patch(run.exits, slash);
      return {
        entry: split,
        exits: [
          { state: split, second: true },
          { state: slash, second: false },
        ],
      };
    }
    const parts = token.alternatives.map(emitSequence);
    let entry = parts[parts.length - 1].entry;
    for (let index = parts.length - 2; index >= 0; index -= 1) {
      const split = state(SPLIT);
      first[split] = parts[index].entry;
      second[split] = entry;
      entry = split;
    }
    return { entry, exits: parts.flatMap((part) => part.exits) };
  };
  const emitSequence = (sequence: Token[]): Part => {
    if (sequence.length === 0) {
      const index = state(SPLIT);
      return { entry: index, exits: [{ state: index, second: false }] };
    }
    const head = emitToken(sequence[0]);
    let exits = head.exits;
    for (let index = 1; index < sequence.length; index += 1) {
      const part = emitToken(sequence[index]);
      patch(exits, part.entry);
      exits = part.exits;
    }
    return { entry: head.entry, exits };
  };

  const whole = emitSequence(tokens);
  const count = kinds.length;
  // The accept marker sits one past the last state, so a patched exit that
  // ends the glob leads to it.
  patch(whole.exits, count);
  const closure = (start: number) => {
    const states: number[] = [];
    let accepts = false;
    const seen = new Set<number>();
    const pending = [start];
    while (pending.length) {
      const index = pending.pop()!;
      if (index < 0 || seen.has(index)) continue;
      seen.add(index);
      if (index === count) accepts = true;
      else if (kinds[index] === SPLIT)
        pending.push(first[index], second[index]);
      else states.push(index);
    }
    return { states, accepts };
  };
  // Each consuming state carries the closure of what follows it, so a match
  // step never walks a split twice.
  const targetFirst = new Int32Array(count),
    targetCount = new Int32Array(count),
    accepting = new Uint8Array(count);
  const targets: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (kinds[index] === SPLIT) continue;
    const reached = closure(first[index]);
    targetFirst[index] = targets.length;
    targetCount[index] = reached.states.length;
    accepting[index] = reached.accepts ? 1 : 0;
    for (const target of reached.states) targets.push(target);
  }
  const start = closure(whole.entry);
  return {
    kinds: Uint8Array.from(kinds),
    codes: Int32Array.from(codes),
    targets: Int32Array.from(targets),
    targetFirst,
    targetCount,
    accepting,
    start: Int32Array.from(start.states),
    startAccepts: start.accepts,
    count,
  };
}

type Machine = ReturnType<typeof compile>;

// State-set simulation: one walk over the URL carrying the set of states it
// can be in, so the work is at most the URL length times the state count and
// nothing backtracks.
function run(machine: Machine, url: string): boolean {
  const { kinds, codes, targets, targetFirst, targetCount, accepting, count } =
    machine;
  let active = new Int32Array(count);
  let next = new Int32Array(count);
  // The step a state last joined the set, so a step holds each state once.
  const joined = new Int32Array(count);
  active.set(machine.start);
  let size = machine.start.length;
  let accepted = machine.startAccepts;
  for (let step = 0; step < url.length; step += 1) {
    const code = url.charCodeAt(step);
    const generation = step + 1;
    let filled = 0;
    accepted = false;
    for (let index = 0; index < size; index += 1) {
      const current = active[index];
      const kind = kinds[current];
      if (kind === LITERAL) {
        if (codes[current] !== code) continue;
      } else if (kind === STAR_IN_SEGMENT && code === SLASH) continue;
      const from = targetFirst[current],
        until = from + targetCount[current];
      for (let slot = from; slot < until; slot += 1) {
        const reached = targets[slot];
        if (joined[reached] === generation) continue;
        joined[reached] = generation;
        next[filled] = reached;
        filled += 1;
      }
      if (accepting[current]) accepted = true;
    }
    const previous = active;
    active = next;
    next = previous;
    size = filled;
    // Nothing can match the rest of the URL once the set empties.
    if (size === 0) return step === url.length - 1 && accepted;
  }
  return accepted;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

export function compileUrlGlob(glob: string, field = "url"): UrlGlob {
  if (glob.length === 0 || glob.length > MAX_GLOB)
    fail(
      "invalid_field",
      `${field} must be a URL glob of 1 to ${MAX_GLOB} characters.`,
      { field },
    );
  const tokens = parse(glob, field);
  const parsed =
    glob.includes("*") || glob.includes("{") || glob.includes("\\")
      ? undefined
      : parseUrl(glob);
  if (parsed)
    return {
      source: glob,
      plain: true,
      matches: (url) => {
        const candidate = parseUrl(url);
        return candidate ? candidate.href === parsed.href : url === glob;
      },
    };
  const machine = compile(tokens);
  return {
    source: glob,
    plain: false,
    matches: (url) => run(machine, url),
  };
}
