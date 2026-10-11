import type { CdpEvent, Gap, TooLarge } from "./types";

export const EVENT_LIMITS = {
  events: 10000,
  tabBytes: 4 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  eventBytes: 1024 * 1024,
};

type Entry = { event: CdpEvent | TooLarge; bytes: number };

// Every tab's event log, kept together under one memory limit.
export class EventBufferPool {
  private buffers = new Set<EventBuffer>();

  constructor(private readonly limits: typeof EVENT_LIMITS = EVENT_LIMITS) {}

  create(tabId: string): EventBuffer {
    return new EventBuffer(tabId, this.limits, this.buffers);
  }

  get totalBytes(): number {
    let total = 0;
    for (const buffer of this.buffers) total += buffer.bytes;
    return total;
  }
}

// One tab's events, held in memory for section 8's events().
export class EventBuffer {
  private entries: Entry[] = [];
  private size = 0;
  private lost = 0;
  private enabled = false;
  private gap?: { reason: Gap["reason"]; from: number };
  private ended: Gap[] = [];
  private redactor?: (event: CdpEvent) => CdpEvent | null;

  constructor(
    readonly tabId: string,
    private readonly limits: typeof EVENT_LIMITS,
    private readonly peers: Set<EventBuffer>,
  ) {
    peers.add(this);
  }

  get recording(): boolean {
    return this.enabled;
  }

  // Bytes of params JSON this log holds.
  get bytes(): number {
    return this.size;
  }

  setRecording(
    on: boolean,
    reason?: "human_control" | "page_scripts_off",
  ): void {
    if (on === this.enabled) return;
    this.enabled = on;
    this.endGap();
    if (!on && reason) this.gap = { reason, from: Date.now() };
  }

  setRedactor(fn: (event: CdpEvent) => CdpEvent | null): void {
    this.redactor = fn;
  }

  record(event: CdpEvent): void {
    if (!this.enabled) return;
    const kept = this.redactor ? this.redactor(event) : event;
    if (!kept) return;
    const bytes = Buffer.byteLength(JSON.stringify(kept.params) ?? "");
    if (bytes > this.limits.eventBytes)
      this.entries.push({
        event: {
          method: kept.method,
          at: kept.at,
          ...(kept.sessionId === undefined
            ? {}
            : { sessionId: kept.sessionId }),
          omitted: "too_large",
          bytes,
        },
        bytes: 0,
      });
    else {
      this.entries.push({ event: kept, bytes });
      this.size += bytes;
    }
    while (
      this.entries.length > this.limits.events ||
      this.size > this.limits.tabBytes
    )
      this.shed();
    // Past the overall limit the largest log loses its oldest events first.
    let total = 0;
    for (const buffer of this.peers) total += buffer.size;
    while (total > this.limits.totalBytes) {
      let largest: EventBuffer = this;
      for (const buffer of this.peers)
        if (buffer.size > largest.size) largest = buffer;
      total -= largest.shed();
    }
  }

  // A debugger lost while recording leaves a gap until its setup ends again.
  openGap(reason: "debugger_detached"): void {
    if (this.enabled && !this.gap) this.gap = { reason, from: Date.now() };
  }

  closeGap(): void {
    if (this.gap?.reason === "debugger_detached") this.endGap();
  }

  drain(max: number): {
    events: (CdpEvent | TooLarge)[];
    dropped: number;
    gaps: Gap[];
    remaining: number;
  } {
    const taken = this.entries.splice(0, Math.max(0, max));
    for (const entry of taken) this.size -= entry.bytes;
    const drained = {
      events: taken.map((entry) => entry.event),
      dropped: this.lost,
      gaps: this.ended,
      remaining: this.entries.length,
    };
    this.lost = 0;
    this.ended = [];
    return drained;
  }

  // Takes the log out of the pool. A disposed log records nothing more.
  dispose(): void {
    this.peers.delete(this);
    this.entries = [];
    this.size = 0;
    this.enabled = false;
  }

  private endGap(): void {
    if (!this.gap) return;
    this.ended.push({ ...this.gap, to: Date.now() });
    this.gap = undefined;
  }

  // Drops the oldest event, counts the loss and returns the bytes it held.
  private shed(): number {
    const entry = this.entries.shift()!;
    this.size -= entry.bytes;
    this.lost += 1;
    return entry.bytes;
  }
}
