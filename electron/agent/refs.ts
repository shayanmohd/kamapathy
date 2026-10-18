import { ApiError } from "./errors";

/** Numbers a snapshot reserves for the refs it may assign. */
export const REF_BLOCK = 100;
/** Numbers a strict resolution reserves for the candidates it reports. */
export const CANDIDATE_REFS = 3;
/** Ranges kept per tab; past this the two oldest merge into one. */
export const MAX_RANGES = 2000;

export type RefState = "live" | "retired" | "unknown";

// API restarts in the same app process must not recycle an old element ref.
let nextElementReference = 1;

/** The number in a ref, or undefined when the ref is not one a snapshot gives. */
export function refNumber(ref: string): number | undefined {
  if (!/^@e[1-9]\d*$/.test(ref)) return undefined;
  const number = Number(ref.slice(2));
  return Number.isSafeInteger(number) ? number : undefined;
}

type Issued = {
  /** Issued numbers as sorted, non-touching [start, end] ranges. */
  ranges: [number, number][];
  /** The counter's value when the tab's refs were last retired. */
  mark: number;
  generation: number;
};

// Which ref numbers each tab was issued, so the main process can tell a ref it
// never issued from one whose element may still be on the page.
export class RefBook {
  private tabs = new Map<string, Issued>();

  /** Takes a block of numbers from the process-wide counter. */
  reserve(count: number): number {
    const first = nextElementReference;
    nextElementReference += count;
    return first;
  }

  /** Records the numbers a page assigned. Ranges only ever grow. */
  record(tabId: string, numbers: readonly number[]): void {
    const sorted = [...new Set(numbers)]
      .filter((number) => Number.isSafeInteger(number) && number > 0)
      .sort((first, second) => first - second);
    if (!sorted.length) return;
    // A recorded number is handed out, so the counter never reaches it again
    // and expireTab's mark is always above it.
    nextElementReference = Math.max(nextElementReference, sorted.at(-1)! + 1);
    const entry = this.entry(tabId);
    for (const number of sorted) {
      const last = entry.ranges.at(-1);
      if (!last || number > last[1] + 1) entry.ranges.push([number, number]);
      else if (number > last[1]) last[1] = number;
      else if (number < last[0]) last[0] = number;
    }
    // Merging the two oldest ranges can only make a never-issued number
    // between them read as issued, which the page then refuses as stale,
    // never the other way round.
    while (entry.ranges.length > MAX_RANGES) {
      const [first, second] = entry.ranges;
      entry.ranges.splice(0, 2, [first[0], second[1]]);
    }
  }

  classify(tabId: string, ref: string): RefState {
    const number = refNumber(ref);
    const entry = this.tabs.get(tabId);
    if (number === undefined || !entry || !issued(entry.ranges, number))
      return "unknown";
    return number < entry.mark ? "retired" : "live";
  }

  /** Lets only a live ref through, before any page work. */
  check(tabId: string, ref: string): void {
    const state = this.classify(tabId, ref);
    if (state === "unknown")
      throw new ApiError(
        "unknown_ref",
        "Kamapathy never issued this ref for this page. Take a snapshot and use a ref from it.",
        { ref },
      );
    if (state === "retired")
      throw new ApiError(
        "stale_ref",
        "Element reference is stale. Take a new snapshot.",
        { ref },
      );
  }

  /** Retires every ref issued for the tab so far. */
  expireTab(tabId: string): void {
    const entry = this.entry(tabId);
    entry.mark = nextElementReference;
    entry.generation += 1;
  }

  /** Page operations add this to their namespace, so retired refs stay gone. */
  generation(tabId: string): number {
    return this.tabs.get(tabId)?.generation ?? 0;
  }

  /** Forgets the tabs that are gone. */
  retain(tabIds: ReadonlySet<string>): void {
    for (const tabId of this.tabs.keys())
      if (!tabIds.has(tabId)) this.tabs.delete(tabId);
  }

  private entry(tabId: string): Issued {
    let entry = this.tabs.get(tabId);
    if (!entry) {
      entry = { ranges: [], mark: 0, generation: 0 };
      this.tabs.set(tabId, entry);
    }
    return entry;
  }
}

function issued(ranges: readonly [number, number][], number: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [start, end] = ranges[middle];
    if (number < start) high = middle - 1;
    else if (number > end) low = middle + 1;
    else return true;
  }
  return false;
}

export const processRefs = new RefBook();
