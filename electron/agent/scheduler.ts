import { ApiError } from "./errors";

export type Lane =
  | { kind: "space"; spaceId: string }
  | { kind: "server" }
  | { kind: "none" };
export interface SchedulerLimits {
  running: number;
  perSpace: number;
  total: number;
  graceMs: number;
}
export const LIMITS: SchedulerLimits = {
  running: 6,
  perSpace: 16,
  total: 32,
  graceMs: 3000,
};
export class DroppedError extends Error {}
export interface SchedulerStats {
  running: number;
  pending: number;
  perSpace: Record<string, number>;
}
export interface Ticket {
  readonly arrival: number;
  readonly runDeadline: number;
  start(lane: Lane): Promise<number>;
  park<T>(wait: () => Promise<T>): Promise<T>;
  drop(): void;
  finish(): void;
}

// A request from admission to finish. It has a waiter while it waits for its
// lane or while its parked wait runs.
interface Entry {
  readonly budgetMs: number;
  readonly runDeadline: number;
  readonly spaceId?: string;
  lane?: string;
  order: number;
  dropped: boolean;
  finished: boolean;
  waiter?: { resolve(): void; reject(error: unknown): void };
}
interface LaneQueue {
  holder?: Entry;
  queue: Entry[];
  idle: (() => void)[];
}

const stopped = () =>
  new ApiError(503, "automation_stopped", "Automation is disabled.");

export class Scheduler {
  private readonly entries = new Set<Entry>();
  private readonly perSpace = new Map<string, number>();
  private readonly lanes = new Map<string, LaneQueue>();
  private running = 0;
  private sequence = 0;
  private closed = false;

  constructor(private readonly limits: SchedulerLimits = LIMITS) {}

  admit({ spaceId, budgetMs }: { spaceId?: string; budgetMs: number }): Ticket {
    if (this.closed) throw stopped();
    if (
      spaceId !== undefined &&
      (this.perSpace.get(spaceId) ?? 0) >= this.limits.perSpace
    )
      throw new ApiError(
        429,
        "busy",
        `This space has ${this.limits.perSpace} requests waiting. Wait for them to finish.`,
        { scope: "space", retryable: true },
      );
    if (this.entries.size >= this.limits.total)
      throw new ApiError(
        429,
        "busy",
        "Kamapathy has too many requests waiting. Try again shortly.",
        { scope: "server", retryable: true },
      );
    const arrival = Date.now();
    const entry: Entry = {
      budgetMs,
      runDeadline: arrival + budgetMs + this.limits.graceMs,
      spaceId,
      order: 0,
      dropped: false,
      finished: false,
    };
    this.entries.add(entry);
    if (spaceId !== undefined)
      this.perSpace.set(spaceId, (this.perSpace.get(spaceId) ?? 0) + 1);
    return {
      arrival,
      runDeadline: entry.runDeadline,
      start: (lane) => this.start(entry, lane),
      park: (wait) => this.park(entry, wait),
      drop: () => this.drop(entry),
      finish: () => this.finish(entry),
    };
  }

  whenIdle(spaceId: string, timeoutMs: number): Promise<void> {
    const lane = this.lanes.get(`space:${spaceId}`);
    if (!lane?.holder) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      lane.idle.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  stats(): SchedulerStats {
    return {
      running: this.running,
      pending: this.entries.size,
      perSpace: Object.fromEntries(this.perSpace),
    };
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries) this.reject(entry, stopped());
  }

  // The sequence number taken here orders each lane by body arrival.
  private start(entry: Entry, lane: Lane): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      if (this.closed) return reject(stopped());
      if (entry.dropped) return reject(new DroppedError());
      entry.order = ++this.sequence;
      const begin = () => {
        const now = Date.now();
        resolve(now + Math.min(entry.budgetMs, entry.runDeadline - now));
      };
      if (lane.kind === "none") return begin();
      entry.lane = lane.kind === "space" ? `space:${lane.spaceId}` : "server";
      // The run deadline applies only until the request first starts.
      const timer = setTimeout(
        () =>
          this.reject(
            entry,
            new ApiError(
              504,
              "action_timeout",
              "This request waited behind earlier requests in its space and did not start. It is safe to send again.",
              { awaited: "queue", timeoutMs: entry.budgetMs, retryable: true },
            ),
          ),
        entry.runDeadline - Date.now(),
      );
      entry.waiter = {
        resolve: () => {
          clearTimeout(timer);
          begin();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.enqueue(entry);
    });
  }

  // The lane and slot are free while the wait runs. The request then queues
  // with its original number, ahead of later arrivals.
  private park<T>(entry: Entry, wait: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(stopped());
      if (entry.dropped) return reject(new DroppedError());
      this.release(entry);
      let resume = () => {};
      entry.waiter = { resolve: () => resume(), reject };
      Promise.resolve()
        .then(wait)
        .then(
          (value) => {
            resume = () => resolve(value);
          },
          (error: unknown) => {
            resume = () => reject(error);
          },
        )
        .then(() => {
          if (!entry.waiter) return;
          if (entry.lane) this.enqueue(entry);
          else this.grant(entry);
        });
    });
  }

  private drop(entry: Entry) {
    if (entry.finished) return;
    entry.dropped = true;
    this.reject(entry, new DroppedError());
  }

  private finish(entry: Entry) {
    if (entry.finished) return;
    entry.finished = true;
    this.reject(entry, new DroppedError());
    this.release(entry);
    this.entries.delete(entry);
    if (entry.spaceId === undefined) return;
    const count = this.perSpace.get(entry.spaceId)! - 1;
    if (count) this.perSpace.set(entry.spaceId, count);
    else this.perSpace.delete(entry.spaceId);
  }

  private enqueue(entry: Entry) {
    let lane = this.lanes.get(entry.lane!);
    if (!lane) this.lanes.set(entry.lane!, (lane = { queue: [], idle: [] }));
    lane.queue.push(entry);
    lane.queue.sort((a, b) => a.order - b.order);
    this.pump();
  }

  // A free slot goes to the earliest arrival among the heads of lanes that
  // are running nothing.
  private pump() {
    while (this.running < this.limits.running) {
      let next: LaneQueue | undefined;
      for (const lane of this.lanes.values())
        if (
          !lane.holder &&
          lane.queue.length &&
          (!next || lane.queue[0].order < next.queue[0].order)
        )
          next = lane;
      if (!next) return;
      const entry = next.queue.shift()!;
      next.holder = entry;
      this.running++;
      this.grant(entry);
    }
  }

  private grant(entry: Entry) {
    const waiter = entry.waiter!;
    entry.waiter = undefined;
    waiter.resolve();
  }

  private reject(entry: Entry, error: unknown) {
    const waiter = entry.waiter;
    if (!waiter) return;
    entry.waiter = undefined;
    const lane = entry.lane ? this.lanes.get(entry.lane) : undefined;
    const index = lane ? lane.queue.indexOf(entry) : -1;
    if (lane && index >= 0) {
      lane.queue.splice(index, 1);
      if (!lane.holder && !lane.queue.length) this.lanes.delete(entry.lane!);
    }
    waiter.reject(error);
  }

  private release(entry: Entry) {
    const lane = entry.lane ? this.lanes.get(entry.lane) : undefined;
    if (!lane || lane.holder !== entry) return;
    lane.holder = undefined;
    this.running--;
    const idle = lane.idle.splice(0);
    if (!lane.queue.length) this.lanes.delete(entry.lane!);
    for (const done of idle) done();
    this.pump();
  }
}
