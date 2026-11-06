import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../electron/agent/errors";
import {
  EXECUTION_MARGIN_MS,
  RESULT_LIMIT,
  evaluateScript,
  wrapSource,
  type ScriptStep,
} from "../electron/agent/evaluate";
import {
  PageCrashedError,
  SessionLostError,
  TabClosedError,
} from "../electron/agent/session/errors";
import { EventBufferPool } from "../electron/agent/session/event-buffer";
import { TabSession } from "../electron/agent/session/tab-session";
import type { SessionHost } from "../electron/agent/session/types";
import { FakeHost, type FakeDebugger } from "./fake-cdp";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const SOURCE_URL = "\n//# sourceURL=kamapathy-evaluate.js";
// Runs the timers due now and every promise callback they lead to.
const settle = () => vi.advanceTimersByTimeAsync(0);

async function ready() {
  const host = new FakeHost();
  const session = new TabSession(host as unknown as SessionHost, {
    tabId: "tab-1",
    waitForSpaceIdle: async () => {},
    buffer: new EventBufferPool().create("tab-1"),
  });
  session.attach();
  await settle();
  expect(session.state).toBe("ready");
  return { host, cdp: host.debugger, session };
}
// A step as the evaluate route builds one.
const step = (timeoutMs = 15000): ScriptStep => ({
  deadline: Date.now() + timeoutMs,
  timeoutMs,
  replMode: true,
  dispatch: { dispatched: false },
});
// Every Runtime.evaluate the session sent.
const evaluations = (cdp: FakeDebugger) =>
  cdp.sent.filter((command) => command.method === "Runtime.evaluate");
// Records how a promise settles, without leaving a rejection unhandled.
function track<T>(promise: Promise<T>) {
  const outcome: { settled: boolean; value?: T; error?: any } = {
    settled: false,
  };
  promise.then(
    (value) => Object.assign(outcome, { settled: true, value }),
    (error: unknown) => Object.assign(outcome, { settled: true, error }),
  );
  return outcome;
}
// What the evaluation threw, as an ApiError.
const failed = async (promise: Promise<unknown>): Promise<ApiError> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
};

describe("evaluate", () => {
  it("an expression runs as written in replMode", async () => {
    const { cdp, session } = await ready();
    cdp.reply("Runtime.evaluate", () => ({
      result: { type: "string", value: "ok" },
    }));
    const source = "await fetch('/cart').then((r) => r.status)";
    const value = await evaluateScript(session, { expression: source }, step());
    expect(value).toEqual({ value: "ok" });
    const sent = evaluations(cdp);
    expect(sent).toHaveLength(1);
    // The page's own main world: no world of Kamapathy's and no frame
    // session, so the expression reads what the page reads.
    expect(sent[0].sessionId).toBeUndefined();
    expect(sent[0].params).toEqual({
      expression: `${source}${SOURCE_URL}`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
      silent: false,
      replMode: true,
      timeout: 15000 - EXECUTION_MARGIN_MS,
    });
    // The transport limit is the step's own, so the page keeps the margin.
    expect(wrapSource({ expression: source })).toEqual({
      expression: `${source}${SOURCE_URL}`,
      columnShift: 0,
    });
  });

  it("a function is called with its argument", async () => {
    const { cdp, session } = await ready();
    cdp.reply("Runtime.evaluate", (params) => ({
      result: { type: "string", value: params.expression },
    }));
    const source = "(item) => item.name";
    const withArg = await evaluateScript(
      session,
      { function: source, arg: { name: "two  " } },
      step(),
    );
    // JSON leaves the line separators raw, and an expression may not.
    expect(withArg).toEqual({
      value: `(${source})({"name":"two\\u2028\\u2029"})${SOURCE_URL}`,
    });
    const alone = await evaluateScript(session, { function: source }, step());
    expect(alone).toEqual({ value: `(${source})()${SOURCE_URL}` });
    // A called function is no declaration, so it runs without repl mode.
    for (const command of evaluations(cdp))
      expect(command.params.replMode).toBeUndefined();
    expect(wrapSource({ function: source })).toEqual({
      expression: `(${source})()${SOURCE_URL}`,
      columnShift: 1,
    });
  });

  it("values decode", async () => {
    const { cdp, session } = await ready();
    const reply = (result: Record<string, unknown>) => {
      cdp.reply("Runtime.evaluate", () => ({ result }));
      return evaluateScript(session, { expression: "value" }, step());
    };
    expect(
      await reply({ type: "object", value: { items: [1, null, "two"] } }),
    ).toEqual({ value: { items: [1, null, "two"] } });
    expect(await reply({ type: "boolean", value: false })).toEqual({
      value: false,
    });
    for (const text of ["NaN", "Infinity", "-Infinity", "-0", "7n"])
      expect(
        await reply({
          type: text.endsWith("n") ? "bigint" : "number",
          description: text,
          unserializableValue: text,
        }),
        text,
      ).toEqual({ unserializable: text });
    // Undefined is neither a value nor text the protocol could not send.
    expect(await reply({ type: "undefined" })).toEqual({});
  });

  it("source positions are the agent's own", async () => {
    const { cdp, session } = await ready();
    const long = `TypeError: no good\n${"x".repeat(5000)}`;
    const threw = (details: Record<string, unknown>) => {
      cdp.reply("Runtime.evaluate", () => ({
        result: { type: "object", subtype: "error" },
        exceptionDetails: { text: "Uncaught", ...details },
      }));
      return failed(
        evaluateScript(session, { function: "() => missing" }, step()),
      );
    };
    // A function source is sent inside parentheses, so its first line sits
    // one character to the right of what the agent wrote.
    const first = await threw({
      lineNumber: 0,
      columnNumber: 5,
      exception: {
        className: "ReferenceError",
        description: "ReferenceError: missing is not defined",
      },
    });
    expect(first.code).toBe("script_error");
    expect(first.status).toBe(422);
    expect(first.fields).toEqual({
      name: "ReferenceError",
      line: 1,
      column: 5,
      description: "ReferenceError: missing is not defined",
    });
    // A later line is the agent's own, column and all.
    const later = await threw({
      lineNumber: 1,
      columnNumber: 2,
      exception: { className: "TypeError", description: long },
    });
    expect(later.fields).toMatchObject({
      name: "TypeError",
      line: 2,
      column: 3,
    });
    expect(later.fields.description).toBe(long.slice(0, 4000));
    expect(later.message).toContain("line 2, column 3");
    // An expression runs as written, so its columns need no shift.
    cdp.reply("Runtime.evaluate", () => ({
      exceptionDetails: {
        text: "Uncaught",
        lineNumber: 0,
        columnNumber: 5,
        exception: {
          className: "ReferenceError",
          description: "ReferenceError: missing is not defined",
        },
      },
    }));
    const bare = await failed(
      evaluateScript(session, { expression: "missing" }, step()),
    );
    expect(bare.fields).toMatchObject({ line: 1, column: 6 });
  });

  it("a result over 16 MiB answers result_too_large", async () => {
    const { cdp, session } = await ready();
    expect(RESULT_LIMIT).toBe(16 * 1024 * 1024);
    cdp.reply("Runtime.evaluate", () => ({
      result: { type: "string", value: "x".repeat(RESULT_LIMIT) },
    }));
    const tooLarge = await failed(
      evaluateScript(
        session,
        { expression: "document.body.innerHTML" },
        step(),
      ),
    );
    expect(tooLarge.code).toBe("result_too_large");
    expect(tooLarge.status).toBe(422);
    // The size it would have taken, and nothing of the result itself.
    expect(tooLarge.fields).toEqual({
      bytes: RESULT_LIMIT + 2,
      limit: RESULT_LIMIT,
    });
    // A result at the limit still answers.
    cdp.reply("Runtime.evaluate", () => ({
      result: { type: "string", value: "x".repeat(RESULT_LIMIT - 2) },
    }));
    const fits = await evaluateScript(
      session,
      { expression: "document.body.innerHTML" },
      step(),
    );
    expect((fits as { value: string }).value).toHaveLength(RESULT_LIMIT - 2);
  });

  it("the execution limit classifies as stopped and responsive", async () => {
    const { cdp, session } = await ready();
    const hit = async (answer: () => unknown, after = 0) => {
      cdp.reply("Runtime.evaluate", answer);
      const call = track(
        evaluateScript(session, { expression: "spin()" }, step(2000)),
      );
      await vi.advanceTimersByTimeAsync(after);
      expect(call.settled, `after ${after} ms`).toBe(true);
      const error = call.error as ApiError;
      expect(error, `after ${after} ms`).toBeInstanceOf(ApiError);
      return error;
    };
    // Chromium names its own termination, and reports the execution limit as
    // an internal error that arrives as the limit expires.
    const internal = () => {
      let reject!: (error: Error) => void;
      // The page answers nothing else while the script runs.
      cdp.reply("Runtime.evaluate", (params) =>
        params.expression === "1"
          ? new Promise(() => {})
          : new Promise((_, no) => (reject = no)),
      );
      return () => reject(new Error("Internal error"));
    };
    for (const message of ["Execution was terminated", "Request timed out"]) {
      const error = await hit(() => {
        throw new Error(message);
      });
      expect(error.code, message).toBe("evaluation_timeout");
      expect(error.status, message).toBe(504);
      expect(error.fields, message).toEqual({
        awaited: "script",
        timeoutMs: 2000,
        executionStopped: true,
        mayHaveLateEffects: true,
        pageResponsive: true,
      });
    }
    // Its outcome is known from the limit alone, so nothing is probed after
    // it: the one question went out at the limit, before the answer.
    const before = evaluations(cdp).length;
    const fail = internal();
    const call = track(
      evaluateScript(session, { expression: "spin()" }, step(2000)),
    );
    await vi.advanceTimersByTimeAsync(2000 - EXECUTION_MARGIN_MS);
    fail();
    await settle();
    expect(call.settled).toBe(true);
    expect((call.error as ApiError).fields).toEqual({
      awaited: "script",
      timeoutMs: 2000,
      executionStopped: true,
      mayHaveLateEffects: true,
      pageResponsive: true,
    });
    expect(
      evaluations(cdp)
        .slice(before)
        .map((command) => command.params.expression),
    ).toEqual([`spin()${SOURCE_URL}`, "1"]);
    expect(cdp.methods()).not.toContain("Runtime.terminateExecution");
  });

  it("the transport limit probes once, then terminates and probes again", async () => {
    const { cdp, session } = await ready();
    // The script never answers; each question, from the one asked at the
    // page's own limit on, answers or stays silent by turn.
    const silence = (answerFrom: number) => {
      let questions = 0;
      cdp.reply("Runtime.evaluate", (params) => {
        if (params.expression === "1" && ++questions >= answerFrom)
          return { result: { type: "number", value: 1 } };
        return new Promise(() => {});
      });
    };
    const timedOut = async (answerFrom: number) => {
      silence(answerFrom);
      const call = track(
        evaluateScript(session, { expression: "pending()" }, step(2000)),
      );
      // The transport limit, both probe limits, the termination and the
      // probes after it.
      await vi.advanceTimersByTimeAsync(6000);
      expect(call.settled, `from ${answerFrom}`).toBe(true);
      return call.error as ApiError;
    };
    // A page that answers: the work may still finish, and the page answers.
    const pending = await timedOut(1);
    expect(pending.code).toBe("evaluation_timeout");
    expect(pending.fields).toEqual({
      awaited: "script",
      timeoutMs: 2000,
      executionStopped: false,
      mayHaveLateEffects: true,
      pageResponsive: true,
    });
    expect(cdp.methods()).not.toContain("Runtime.terminateExecution");
    // A silent probe, then a termination and a probe that answers.
    const terminated = await timedOut(4);
    expect(terminated.fields).toMatchObject({
      executionStopped: true,
      pageResponsive: true,
    });
    expect(cdp.methods()).toContain("Runtime.terminateExecution");
    // Silence after the termination: the person has to step in.
    const unresponsive = await timedOut(Infinity);
    expect(unresponsive.fields).toMatchObject({
      executionStopped: false,
      pageResponsive: false,
    });
    expect(unresponsive.message).toContain(
      "Reload or close the page before continuing.",
    );
    // Nothing is retried, so the agent decides what happens next.
    expect(unresponsive.fields.mayHaveLateEffects).toBe(true);
  });

  it("the execution limit stopped the script however late its answer lands", async () => {
    const { cdp, session } = await ready();
    // A loaded machine delivers Chromium's answer to its own limit hundreds
    // of milliseconds late, and once the call's own limit has passed.
    for (const lateMs of [150, 500, 950, 1300]) {
      holdUntilLimit(cdp, lateMs);
      const before = evaluations(cdp).length;
      const call = track(
        evaluateScript(session, { expression: "spin()" }, step(2000)),
      );
      await vi.advanceTimersByTimeAsync(2000 - EXECUTION_MARGIN_MS + lateMs);
      expect(call.settled, `${lateMs} ms late`).toBe(true);
      expect(call.error, `${lateMs} ms late`).toBeInstanceOf(ApiError);
      expect((call.error as ApiError).fields, `${lateMs} ms late`).toEqual({
        awaited: "script",
        timeoutMs: 2000,
        executionStopped: true,
        mayHaveLateEffects: true,
        pageResponsive: true,
      });
      expect(cdp.methods()).not.toContain("Runtime.terminateExecution");
      // An answer within the call's own limit leaves nothing to probe.
      if (lateMs < EXECUTION_MARGIN_MS)
        expect(
          evaluations(cdp)
            .slice(before)
            .map((command) => command.params.expression),
        ).toEqual([`spin()${SOURCE_URL}`, "1"]);
    }
  });

  it("an internal error before the limit, or after the page answered at it, is the page's own", async () => {
    const { cdp, session } = await ready();
    const own = (error: unknown) => {
      expect(error).not.toBeInstanceOf(ApiError);
      expect((error as Error).message).toBe("Internal error");
    };
    // A value Chromium cannot return, from a script that finished at once.
    cdp.reply("Runtime.evaluate", () => {
      throw new Error("Internal error");
    });
    const early = track(
      evaluateScript(
        session,
        { function: "() => ({ get x() { throw new Error('no') } })" },
        step(2000),
      ),
    );
    await settle();
    expect(early.settled).toBe(true);
    own(early.error);
    // A script waiting on a promise leaves the page free to answer at the
    // limit, which covers only the script's own run, so a value that fails
    // later is the page's failure however close to the limit it lands.
    for (const lateMs of [50, 500]) {
      cdp.reply("Runtime.evaluate", (params) =>
        params.expression === "1"
          ? { result: { type: "number", value: 1 } }
          : new Promise((_, reject) =>
              setTimeout(
                () => reject(new Error("Internal error")),
                params.timeout + lateMs,
              ),
            ),
      );
      const call = track(
        evaluateScript(
          session,
          { function: "async () => later()" },
          step(2000),
        ),
      );
      await vi.advanceTimersByTimeAsync(2000 - EXECUTION_MARGIN_MS + lateMs);
      expect(call.settled, `${lateMs} ms late`).toBe(true);
      own(call.error);
    }
    expect(cdp.methods()).not.toContain("Runtime.terminateExecution");
  });

  it("a crash, a closed tab or a lost session after the limit is no limit", async () => {
    const ends = [
      [(host: FakeHost) => host.crash(), PageCrashedError],
      [(host: FakeHost) => host.destroy(), TabClosedError],
      [(host: FakeHost) => host.debugger.lose(), SessionLostError],
    ] as const;
    for (const [end, expected] of ends) {
      const { host, cdp, session } = await ready();
      holdUntilLimit(cdp, 60000);
      const call = track(
        evaluateScript(session, { expression: "spin()" }, step(2000)),
      );
      await vi.advanceTimersByTimeAsync(2000 - EXECUTION_MARGIN_MS + 300);
      end(host);
      await settle();
      expect(call.settled, expected.name).toBe(true);
      expect(call.error, expected.name).toBeInstanceOf(expected);
    }
  });

  it("a page that answers a probe slowly still answers, so nothing is stopped", async () => {
    const { cdp, session } = await ready();
    // The script waits on a promise that never settles, and a loaded page
    // answers each question 400 ms after it is asked.
    cdp.reply(
      "Runtime.evaluate",
      (params) =>
        new Promise((resolve) => {
          if (params.expression === "1")
            setTimeout(
              () => resolve({ result: { type: "number", value: 1 } }),
              400,
            );
        }),
    );
    const call = track(
      evaluateScript(session, { expression: "pending()" }, step(2000)),
    );
    await vi.advanceTimersByTimeAsync(6000);
    expect(call.settled).toBe(true);
    expect((call.error as ApiError).fields).toEqual({
      awaited: "script",
      timeoutMs: 2000,
      executionStopped: false,
      mayHaveLateEffects: true,
      pageResponsive: true,
    });
    expect(cdp.methods()).not.toContain("Runtime.terminateExecution");
  });
});

// A page that runs the script until Chromium's own limit stops it, lateMs
// after that limit: Chromium answers the script then, with an internal
// error, and in the same task every question asked meanwhile.
function holdUntilLimit(cdp: FakeDebugger, lateMs: number) {
  let running = true;
  const queued: (() => void)[] = [];
  cdp.reply("Runtime.evaluate", (params) => {
    if (params.expression === "1") {
      const answer = { result: { type: "number", value: 1 } };
      if (!running) return answer;
      return new Promise((resolve) => queued.push(() => resolve(answer)));
    }
    return new Promise((_, reject) =>
      setTimeout(() => {
        running = false;
        reject(new Error("Internal error"));
        for (const answer of queued.splice(0)) answer();
      }, params.timeout + lateMs),
    );
  });
}
