import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../electron/agent/errors";
import {
  DroppedError,
  Scheduler,
  type Lane,
} from "../electron/agent/scheduler";

const IDLE = { running: 0, pending: 0, perSpace: {} };
const space = (spaceId: string): Lane => ({ kind: "space", spaceId });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
// Lets pending promise callbacks run without moving the clock.
const settle = () => vi.advanceTimersByTimeAsync(0);

// Requests as the server runs them: admitted on arrival, started in a lane
// once the body is read, and finished however they end. `log` records the
// order in which requests start.
function setup() {
  const scheduler = new Scheduler();
  const log: string[] = [];
  const arrive = (name: string, lane: Lane, budgetMs = 10000) => {
    const ticket = scheduler.admit({
      spaceId: lane.kind === "space" ? lane.spaceId : undefined,
      budgetMs,
    });
    const work = deferred<void>();
    const outcome = deferred<unknown>();
    return {
      ticket,
      // The operation deadline, or the error the request ended with.
      outcome: outcome.promise,
      begin(chosen: Lane = lane) {
        ticket
          .start(chosen)
          .then(async (deadline) => {
            log.push(name);
            await work.promise;
            return deadline;
          })
          .finally(() => ticket.finish())
          .then(outcome.resolve, outcome.resolve);
      },
      end: () => work.resolve(),
      fail: (error: Error) => work.reject(error),
    };
  };
  const send = (name: string, lane: Lane, budgetMs?: number) => {
    const request = arrive(name, lane, budgetMs);
    request.begin();
    return request;
  };
  const refusal = (lane: Lane) => {
    try {
      arrive("refused", lane);
    } catch (error) {
      return error;
    }
  };
  return { scheduler, log, arrive, send, refusal };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("agent request scheduler", () => {
  it("runs one request per space in arrival order", async () => {
    const { scheduler, log, arrive, send } = setup();
    const first = send("first", space("a"));
    const second = arrive("second", space("a"));
    const third = arrive("third", space("a"));
    // The third request's body arrives before the second's.
    third.begin();
    second.begin();
    await settle();
    expect(log).toEqual(["first"]);
    first.end();
    await settle();
    expect(log).toEqual(["first", "third"]);
    third.end();
    await settle();
    expect(log).toEqual(["first", "third", "second"]);
    second.end();
    await Promise.all([first.outcome, second.outcome, third.outcome]);
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("runs up to six spaces at once and gives a freed slot to the waiting head that arrived first", async () => {
    const { scheduler, log, send } = setup();
    const running = ["a", "b", "c", "d", "e", "f"].map((id) =>
      send(id, space(id)),
    );
    const waiting = [
      send("g", space("g")),
      send("create", { kind: "server" }),
      send("f again", space("f")),
    ];
    const read = send("read", { kind: "none" });
    await settle();
    expect(log).toEqual(["a", "b", "c", "d", "e", "f", "read"]);
    expect(scheduler.stats().running).toBe(6);
    // Space f's next request arrived after g and the new space request.
    running[5].end();
    await settle();
    expect(log.slice(7)).toEqual(["g"]);
    running[0].end();
    await settle();
    expect(log.slice(7)).toEqual(["g", "create"]);
    running[1].end();
    await settle();
    expect(log.slice(7)).toEqual(["g", "create", "f again"]);
    const all = [...running, ...waiting, read];
    for (const request of all) request.end();
    await Promise.all(all.map((request) => request.outcome));
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("lets a later request in the space run while a wait is parked, then re-enters the wait before later arrivals", async () => {
    const { scheduler, log, send } = setup();
    const wait = send("wait", space("a"));
    await settle();
    const check = deferred<string>();
    const resumed = wait.ticket.park(() => check.promise).then(
      (value) => log.push(`wait ${value}`),
      (error: unknown) => error,
    );
    const click = send("click", space("a"));
    await settle();
    expect(log).toEqual(["wait", "click"]);
    const snapshot = send("snapshot", space("a"));
    check.resolve("checked");
    await settle();
    // The wait does not interrupt the running click.
    expect(log).toEqual(["wait", "click"]);
    click.end();
    await settle();
    expect(log).toEqual(["wait", "click", "wait checked"]);
    wait.end();
    await settle();
    expect(log).toEqual(["wait", "click", "wait checked", "snapshot"]);
    snapshot.end();
    await resumed;
    await Promise.all([wait.outcome, click.outcome, snapshot.outcome]);
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("lets a request in the space run between an action's attempts", async () => {
    const { scheduler, log, send } = setup();
    const click = send("click", space("a"));
    const snapshot = send("snapshot", space("a"));
    await settle();
    expect(log).toEqual(["click"]);
    // The first attempt found the target covered; the next comes in 100 ms.
    const retried = click.ticket
      .park(() => new Promise((resolve) => setTimeout(resolve, 100)))
      .then(
        () => log.push("click again"),
        (error: unknown) => error,
      );
    await settle();
    expect(log).toEqual(["click", "snapshot"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(log).toEqual(["click", "snapshot"]);
    snapshot.end();
    await settle();
    expect(log).toEqual(["click", "snapshot", "click again"]);
    click.end();
    await retried;
    await Promise.all([click.outcome, snapshot.outcome]);
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("refuses past 16 pending in a space with busy scope space and past 32 overall with busy scope server, both retryable", () => {
    const { scheduler, arrive, refusal } = setup();
    const admitted = Array.from({ length: 16 }, (_, index) =>
      arrive(`a${index}`, space("a")),
    );
    const spaceBusy = refusal(space("a"));
    expect(spaceBusy).toBeInstanceOf(ApiError);
    expect(spaceBusy).toMatchObject({
      status: 429,
      code: "busy",
      message: "This space has 16 requests waiting. Wait for them to finish.",
      fields: { scope: "space", retryable: true },
    });
    for (let index = 0; index < 16; index++)
      admitted.push(arrive(`b${index}`, space("b")));
    const lanes: Lane[] = [space("c"), { kind: "server" }, { kind: "none" }];
    for (const lane of lanes)
      expect(refusal(lane)).toMatchObject({
        status: 429,
        code: "busy",
        message: "Kamapathy has too many requests waiting. Try again shortly.",
        fields: { scope: "server", retryable: true },
      });
    expect(scheduler.stats()).toEqual({
      running: 0,
      pending: 32,
      perSpace: { a: 16, b: 16 },
    });
    // A request whose body never arrives still gives its place back.
    for (const request of admitted) request.ticket.finish();
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("counts lane-free requests toward the 32 but not toward their space's 16", async () => {
    const { scheduler, log, arrive, send, refusal } = setup();
    const queued = Array.from({ length: 16 }, (_, index) =>
      arrive(`a${index}`, space("a")),
    );
    // Reads of space a that touch no page, such as its tab list.
    const reads = Array.from({ length: 16 }, (_, index) =>
      send(`read ${index}`, { kind: "none" }),
    );
    await settle();
    expect(log).toHaveLength(16);
    expect(scheduler.stats()).toEqual({
      running: 0,
      pending: 32,
      perSpace: { a: 16 },
    });
    expect(refusal({ kind: "none" })).toMatchObject({
      code: "busy",
      fields: { scope: "server" },
    });
    for (const request of reads) request.end();
    await Promise.all(reads.map((request) => request.outcome));
    for (const request of queued) request.ticket.finish();
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("starts a request whose lane is chosen as none after its body while its space's lane is busy, and queues one given the space lane", async () => {
    const { scheduler, log, arrive, send } = setup();
    const running = send("running", space("a"));
    const continuation = arrive("continuation", space("a"));
    const command = arrive("command", space("a"));
    expect(scheduler.stats().perSpace).toEqual({ a: 3 });
    continuation.begin({ kind: "none" });
    command.begin();
    await settle();
    expect(log).toEqual(["running", "continuation"]);
    running.end();
    await settle();
    expect(log).toEqual(["running", "continuation", "command"]);
    continuation.end();
    command.end();
    await Promise.all(
      [running, continuation, command].map((request) => request.outcome),
    );
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("takes queue time beyond 3000 ms out of the budget", async () => {
    const { scheduler, send } = setup();
    const arrival = Date.now();
    const first = send("first", space("a"));
    const second = send("second", space("a"));
    const third = send("third", space("a"));
    expect(third.ticket.arrival).toBe(arrival);
    expect(third.ticket.runDeadline).toBe(arrival + 13000);
    await vi.advanceTimersByTimeAsync(2000);
    first.end();
    await settle();
    await vi.advanceTimersByTimeAsync(3000);
    second.end();
    third.end();
    // Two seconds in the queue leave the whole budget; five cost two seconds.
    expect(await first.outcome).toBe(arrival + 10000);
    expect(await second.outcome).toBe(arrival + 2000 + 10000);
    expect(await third.outcome).toBe(arrival + 5000 + 8000);
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("returns 504 action_timeout with awaited queue, timeoutMs and retryable to a request still queued at its run deadline, without running it", async () => {
    const { scheduler, log, send } = setup();
    const running = send("running", space("a"), 30000);
    const queued = send("queued", space("a"), 1000);
    await vi.advanceTimersByTimeAsync(3999);
    expect(log).toEqual(["running"]);
    await vi.advanceTimersByTimeAsync(1);
    const error = await queued.outcome;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 504,
      code: "action_timeout",
      message:
        "This request waited behind earlier requests in its space and did not start. It is safe to send again.",
      fields: { awaited: "queue", timeoutMs: 1000, retryable: true },
    });
    running.end();
    await running.outcome;
    expect(log).toEqual(["running"]);
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("drops queued and parked requests whose client disconnected without running them", async () => {
    const { scheduler, log, send } = setup();
    const running = send("running", space("a"));
    const queued = send("queued", space("a"));
    const waiting = send("waiting", space("b"));
    await settle();
    const check = deferred<void>();
    const parked = waiting.ticket.park(() => check.promise).then(
      () => "resumed",
      (error: unknown) => error,
    );
    queued.ticket.drop();
    waiting.ticket.drop();
    expect(await queued.outcome).toBeInstanceOf(DroppedError);
    expect(await parked).toBeInstanceOf(DroppedError);
    // The dropped wait never takes its lane back.
    const next = send("next", space("b"));
    check.resolve();
    await settle();
    expect(log).toEqual(["running", "waiting", "next"]);
    // A running request is untouched, but it cannot park once dropped.
    running.ticket.drop();
    let waited = false;
    const refused = running.ticket
      .park(async () => {
        waited = true;
      })
      .catch((error: unknown) => error);
    expect(await refused).toBeInstanceOf(DroppedError);
    expect(waited).toBe(false);
    for (const request of [running, waiting, next]) request.end();
    await Promise.all(
      [running, waiting, next].map((request) => request.outcome),
    );
    expect(log).toEqual(["running", "waiting", "next"]);
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("does not block its lane when a request fails", async () => {
    const { scheduler, log, send } = setup();
    const failing = send("failing", space("a"));
    const next = send("next", space("a"));
    await settle();
    failing.fail(new Error("The page went away"));
    expect(await failing.outcome).toBeInstanceOf(Error);
    await settle();
    expect(log).toEqual(["failing", "next"]);
    // A wait that fails takes its lane back before the request sees the error.
    const check = deferred<void>();
    const parked = next.ticket.park(() => check.promise).then(
      () => "resumed",
      (error: unknown) => {
        log.push("wait failed");
        return error;
      },
    );
    const other = send("other", space("a"));
    await settle();
    check.reject(new Error("The tab was closed."));
    await settle();
    expect(log).toEqual(["failing", "next", "other"]);
    other.end();
    await settle();
    expect(log).toEqual(["failing", "next", "other", "wait failed"]);
    expect(await parked).toBeInstanceOf(Error);
    next.end();
    await Promise.all([next.outcome, other.outcome]);
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("close() rejects every admitted, queued and parked request and refuses new ones", async () => {
    const { scheduler, log, arrive, send, refusal } = setup();
    const running = send("running", space("a"));
    const queued = send("queued", space("a"));
    const reading = arrive("reading", space("c"));
    const waiting = send("waiting", space("b"));
    await settle();
    const check = deferred<void>();
    const parked = waiting.ticket.park(() => check.promise).then(
      () => "resumed",
      (error: unknown) => error,
    );
    scheduler.close();
    const stopped = { status: 503, code: "automation_stopped" };
    expect(await queued.outcome).toMatchObject(stopped);
    expect(await parked).toMatchObject(stopped);
    reading.begin();
    expect(await reading.outcome).toMatchObject(stopped);
    expect(refusal(space("d"))).toMatchObject(stopped);
    // The running request is untouched and finishes on its own.
    running.end();
    waiting.end();
    check.resolve();
    expect(typeof (await running.outcome)).toBe("number");
    await waiting.outcome;
    expect(log).toEqual(["running", "waiting"]);
    expect(scheduler.stats()).toEqual(IDLE);
  });

  it("whenIdle resolves when the space's running request finishes, or after its timeout", async () => {
    const { scheduler, send } = setup();
    await scheduler.whenIdle("a", 2000);
    const first = send("first", space("a"));
    const second = send("second", space("a"));
    await settle();
    let idle = false;
    scheduler.whenIdle("a", 2000).then(() => (idle = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(idle).toBe(false);
    first.end();
    await settle();
    expect(idle).toBe(true);
    let gaveUp = false;
    scheduler.whenIdle("a", 2000).then(() => (gaveUp = true));
    await vi.advanceTimersByTimeAsync(1999);
    expect(gaveUp).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(gaveUp).toBe(true);
    second.end();
    await Promise.all([first.outcome, second.outcome]);
    expect(scheduler.stats()).toEqual(IDLE);
  });
});
