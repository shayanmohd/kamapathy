import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, envelope } from "../electron/agent/errors";
import type { Park } from "../electron/agent/http";
import {
  ACTION_LEVELS,
  BACKOFF_MS,
  DEFAULT_ACTION_TIMEOUT_MS,
  LOAD_WAIT_MS,
  MAX_SCROLL_GESTURES,
  SCROLL_SETTLE_MS,
  SETTLE_MS,
  TRANSIENT_BLOCKERS,
  confirmDelivery,
  createGesture,
  runAttempts,
  settleAfterInput,
} from "../electron/agent/input/wait";
import { CdpTimeoutError } from "../electron/agent/session/errors";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// A park that frees the lane while the wait runs. Every entry counts as a
// chance for another request in the space to run.
const parker = () => {
  const state = { parks: 0, others: 0 };
  const park: Park = async (wait) => {
    state.parks += 1;
    const value = await wait();
    state.others += 1;
    return value;
  };
  return { state, park };
};
const loop = <T>(
  options: {
    timeoutMs?: number;
    deadline?: number;
    park: Park;
    selector?: string;
    action?: string;
    signal?: AbortSignal;
  },
  attempt: Parameters<typeof runAttempts<T>>[1],
) =>
  runAttempts<T>(
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
      deadline: options.deadline ?? Date.now() + 60000,
      park: options.park,
      action: options.action ?? "click",
      ...(options.selector === undefined ? {} : { selector: options.selector }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    attempt,
  );
// Runs the loop to its end with the clock driven, and gives back what it threw.
const ended = async (running: Promise<unknown>) => {
  const settled = running.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(120000);
  const result = await settled;
  if ("error" in result) {
    expect(result.error).toBeInstanceOf(ApiError);
    return result.error as ApiError;
  }
  throw new Error(`The loop returned ${JSON.stringify(result.value)}.`);
};

describe("the attempt loop", () => {
  it("names the level and the blockers section 5 waits on", () => {
    expect(BACKOFF_MS).toEqual([50, 100, 250, 500]);
    expect([
      DEFAULT_ACTION_TIMEOUT_MS,
      SETTLE_MS,
      LOAD_WAIT_MS,
      MAX_SCROLL_GESTURES,
      SCROLL_SETTLE_MS,
    ]).toEqual([3000, 100, 15000, 6, 500]);
    expect(ACTION_LEVELS).toEqual({
      click: "pointer-enabled",
      dblclick: "pointer-enabled",
      hover: "pointer",
      drag: "pointer",
      fill: "enabled",
      select: "enabled",
      focus: "enabled",
      press: "enabled",
    });
    expect([...TRANSIENT_BLOCKERS]).toEqual([
      "no_match",
      "detached",
      "hidden",
      "disabled",
      "read_only",
      "not_focused",
      "moving",
      "covered",
      "outside_viewport",
      "option_missing",
      "frame_not_ready",
    ]);
  });

  it("retries a transient blocker with the backoff, every gap inside park", async () => {
    const { state, park } = parker();
    const started = Date.now();
    const at: number[] = [];
    const error = await ended(
      loop({ park, timeoutMs: 3000, selector: "#buy" }, async (context) => {
        at.push(Date.now() - started);
        expect(context.attempt).toBe(at.length - 1);
        expect(context.waitedMs).toBe(Date.now() - started);
        return { done: false, blocked: { blocker: "covered" } };
      }),
    );
    expect(error.code).toBe("action_timeout");
    // The gaps are 50, 100, 250 and then 500 until the timeout.
    const gaps = at.slice(1).map((moment, index) => moment - at[index]);
    expect(gaps.slice(0, 5)).toEqual([50, 100, 250, 500, 500]);
    expect(at[0]).toBe(0);
    expect(at.at(-1)).toBe(3000);
    // Nothing waited outside the park, so the space ran other requests
    // between every pair of attempts.
    expect(state.parks).toBe(at.length - 1);
    expect(state.others).toBe(at.length - 1);
  });

  it("stops waiting when the request's own deadline or its client is gone", async () => {
    const { state, park } = parker();
    let attempts = 0;
    // The request's budget bounds the loop, whatever timeout it was given.
    const bounded = await ended(
      loop({ park, timeoutMs: 60000, deadline: Date.now() + 120 }, async () => {
        attempts += 1;
        return { done: false, blocked: { blocker: "covered" } };
      }),
    );
    expect(bounded.code).toBe("action_timeout");
    expect(attempts).toBe(3);
    // A client that left is not waited for.
    const aborted = new AbortController();
    let after = 0;
    const gone = await ended(
      loop({ park, timeoutMs: 60000, signal: aborted.signal }, async () => {
        after += 1;
        aborted.abort();
        return { done: false, blocked: { blocker: "hidden" } };
      }),
    );
    expect(after).toBe(1);
    expect(gone.code).toBe("action_timeout");
    expect(state.parks).toBe(2);
  });

  it("makes exactly one attempt when the timeout is zero", async () => {
    const { state, park } = parker();
    let attempts = 0;
    const error = await ended(
      loop({ park, timeoutMs: 0 }, async () => {
        attempts += 1;
        return { done: false, blocked: { blocker: "hidden" } };
      }),
    );
    expect(attempts).toBe(1);
    expect(state.parks).toBe(0);
    expect(error.code).toBe("action_timeout");
    expect(error.fields.timeoutMs).toBe(0);
  });

  it("returns the attempt's value as soon as one is done", async () => {
    const { state, park } = parker();
    const running = loop<{ point: { x: number } }>({ park }, async (context) =>
      context.attempt === 1
        ? { done: true, value: { point: { x: 4 } } }
        : { done: false, blocked: { blocker: "moving" } },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(await running).toEqual({ point: { x: 4 } });
    expect(state.parks).toBe(1);
  });

  it("ends a selector that never matched as no_match with waitedMs", async () => {
    const { park } = parker();
    const error = await ended(
      loop({ park, timeoutMs: 500, selector: "#late" }, async () => ({
        done: false,
        blocked: { blocker: "no_match" },
      })),
    );
    expect(error.code).toBe("no_match");
    expect(error.status).toBe(422);
    expect(error.fields).toEqual({ selector: "#late", waitedMs: 500 });
    expect(error.fields.retryable).toBeUndefined();
    expect(error.message).toContain("Take a snapshot");
  });

  it("ends every other blocker as action_timeout the agent may retry", async () => {
    const { park } = parker();
    const error = await ended(
      loop({ park, timeoutMs: 3000, action: "click" }, async () => ({
        done: false,
        blocked: {
          blocker: "covered",
          detail: "banner",
          interceptor: 'div#consent.banner "Accept all"',
        },
      })),
    );
    expect(error.code).toBe("action_timeout");
    expect(error.status).toBe(504);
    expect(error.message).toBe(
      "click timed out after 3000 ms: Another element covers the target.",
    );
    expect(error.fields).toEqual({
      awaited: "actionable",
      blocker: "covered",
      detail: "banner",
      interceptor: 'div#consent.banner "Accept all"',
      timeoutMs: 3000,
    });
    const body = envelope(error, false);
    expect(body.status).toBe(504);
    expect(body.error.retryable).toBe(true);
    expect(body.error.dispatched).toBeUndefined();
    // Each action names itself, and a blocker without a detail says less.
    const frame = await ended(
      loop({ park, timeoutMs: 250, action: "fill" }, async () => ({
        done: false,
        blocked: { blocker: "frame_not_ready", detail: "attaching" },
      })),
    );
    expect(frame.message).toBe(
      "fill timed out after 250 ms: The frame holding the target is still loading.",
    );
    expect(frame.fields).toEqual({
      awaited: "actionable",
      blocker: "frame_not_ready",
      detail: "attaching",
      timeoutMs: 250,
    });
  });

  it("keeps the last real blocker the page reported", async () => {
    const { park } = parker();
    // A stall and an unready frame are kept only while nothing else was
    // reported.
    const stalled = await ended(
      loop({ park, timeoutMs: 150 }, async (context) => {
        if (context.attempt === 0) throw new CdpTimeoutError("page", 15000);
        return { done: false, blocked: { blocker: "frame_not_ready" } };
      }),
    );
    expect(stalled.fields.blocker).toBe("frame_not_ready");
    // A later real blocker replaces them.
    const covered = await ended(
      loop({ park, timeoutMs: 250 }, async (context) => {
        if (context.attempt === 0) throw new CdpTimeoutError("page", 15000);
        if (context.attempt === 1)
          return { done: false, blocked: { blocker: "frame_not_ready" } };
        return { done: false, blocked: { blocker: "covered" } };
      }),
    );
    expect(covered.fields.blocker).toBe("covered");
    // The real blocker stays, however the page answers afterwards.
    const kept = await ended(
      loop({ park, timeoutMs: 250 }, async (context) => {
        if (context.attempt === 0)
          return { done: false, blocked: { blocker: "disabled" } };
        if (context.attempt === 1)
          return { done: false, blocked: { blocker: "frame_not_ready" } };
        throw new CdpTimeoutError("page", 15000);
      }),
    );
    expect(kept.fields.blocker).toBe("disabled");
  });

  it("fails permanent codes on the attempt that raised them", async () => {
    for (const code of [
      "ambiguous_match",
      "invalid_selector",
      "stale_ref",
      "unknown_ref",
      "not_editable",
      "native_popup_blocked",
      "human_control",
    ]) {
      const { state, park } = parker();
      let attempts = 0;
      const error = await ended(
        loop({ park, timeoutMs: 3000 }, async () => {
          attempts += 1;
          throw new ApiError(code, "No.", { field: code });
        }),
      );
      expect(error.code, code).toBe(code);
      expect(error.fields.field, code).toBe(code);
      expect(attempts, code).toBe(1);
      expect(state.parks, code).toBe(0);
    }
  });

  it("never repeats input once a gesture has pressed", async () => {
    const { park } = parker();
    let attempts = 0;
    const error = await ended(
      loop({ park, timeoutMs: 3000 }, async (context) => {
        attempts += 1;
        // The first look is blocked before any input, so it is tried again.
        if (attempts === 1)
          return { done: false, blocked: { blocker: "covered" } };
        context.gesture.press();
        expect(context.gesture.committed).toBe(true);
        // The re-check before the second press finds the target covered.
        return context.gesture.refuse();
      }),
    );
    expect(attempts).toBe(2);
    expect(error.code).toBe("element_obscured");
    expect(error.status).toBe(409);
    expect(error.fields).toEqual({ presses: 1 });
    const body = envelope(error, true);
    expect(body.error.dispatched).toBe(true);
    expect(body.error.retryable).toBeUndefined();
    // A blocker reported after the commit point ends the loop as well.
    let later = 0;
    const timedOut = await ended(
      loop({ park, timeoutMs: 3000 }, async (context) => {
        later += 1;
        context.gesture.press();
        return { done: false, blocked: { blocker: "moving" } };
      }),
    );
    expect(later).toBe(1);
    expect(timedOut.code).toBe("action_timeout");
    expect(timedOut.fields.blocker).toBe("moving");
  });

  it("counts the presses a gesture made", () => {
    const gesture = createGesture();
    expect([gesture.presses, gesture.committed]).toEqual([0, false]);
    gesture.press();
    gesture.press();
    expect([gesture.presses, gesture.committed]).toEqual([2, true]);
    expect(() => gesture.refuse()).toThrow(ApiError);
    try {
      gesture.refuse();
    } catch (error) {
      expect((error as ApiError).fields).toEqual({ presses: 2 });
    }
  });
});

describe("confirming delivery", () => {
  // Counters the page answers with, one reading per call.
  const readings = (values: number[]) => {
    let at = 0;
    return async () => ({ mouse: values[Math.min(at++, values.length - 1)] });
  };

  it("returns at once when a counter moved", async () => {
    let deliveries = 0;
    let frames = 0;
    const value = await confirmDelivery({
      kind: "mouse",
      counters: readings([2, 3]),
      frames: async () => {
        frames += 1;
      },
      epoch: () => 1,
      budget: Date.now() + 30000,
      deliver: async () => {
        deliveries += 1;
        return "clicked";
      },
    });
    expect([value, deliveries, frames]).toEqual(["clicked", 1, 0]);
  });

  it("resends at most twice more, then reports input that never arrived", async () => {
    let deliveries = 0;
    let frames = 0;
    const running = confirmDelivery({
      kind: "mouse",
      counters: readings([0]),
      frames: async () => {
        frames += 1;
      },
      epoch: () => 1,
      budget: Date.now() + 30000,
      deliver: async () => {
        deliveries += 1;
      },
    }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    const error = (await running) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("input_not_delivered");
    expect(error.message).toBe(
      "The page did not accept native input. Inspect the page before retrying.",
    );
    expect([deliveries, frames]).toEqual([3, 2]);
    const body = envelope(error, true);
    expect(body.status).toBe(409);
    expect(body.error.dispatched).toBe(true);
    expect(body.error.retryable).toBeUndefined();
  });

  it("counts a navigation during the gesture as delivery", async () => {
    let epoch = 1;
    let deliveries = 0;
    const value = await confirmDelivery({
      kind: "key",
      counters: async () => ({ key: 0 }),
      frames: async () => {},
      epoch: () => epoch,
      budget: Date.now() + 30000,
      deliver: async () => {
        deliveries += 1;
        epoch += 1;
        return "pressed";
      },
    });
    expect([value, deliveries]).toEqual(["pressed", 1]);
  });

  it("sends no resend past the budget", async () => {
    let deliveries = 0;
    let frames = 0;
    const error = (await confirmDelivery({
      kind: "mouse",
      counters: readings([0]),
      frames: async () => {
        frames += 1;
      },
      epoch: () => 1,
      budget: Date.now() + 200,
      deliver: async () => {
        deliveries += 1;
      },
    }).catch((raised: unknown) => raised)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe("input_not_delivered");
    expect([deliveries, frames]).toEqual([1, 0]);
  });
});

describe("settling after input", () => {
  // The parts of a WebContents the settle reads.
  class FakeLoading {
    loading: boolean;
    waits = 0;
    private listeners: (() => void)[] = [];
    constructor(loading: boolean) {
      this.loading = loading;
    }
    isLoadingMainFrame() {
      return this.loading;
    }
    once(_name: string, listener: () => void) {
      this.waits += 1;
      this.listeners.push(listener);
      return this;
    }
    removeListener(_name: string, listener: () => void) {
      this.listeners = this.listeners.filter((other) => other !== listener);
      return this;
    }
    stop() {
      this.loading = false;
      for (const listener of this.listeners.splice(0)) listener();
    }
    get listening() {
      return this.listeners.length;
    }
  }
  const settle = (contents: FakeLoading, budgetMs: number) => {
    const { state, park } = parker();
    return {
      state,
      contents,
      running: settleAfterInput({
        contents: contents as unknown as WebContents,
        park,
        budget: Date.now() + budgetMs,
        guard: () => {},
      }),
    };
  };

  it("waits the settle inside park and answers at once for a page that is not loading", async () => {
    const contents = new FakeLoading(false);
    const started = Date.now();
    const { state, running } = settle(contents, 30000);
    const answer = running.then((value) => ({ value, at: Date.now() }));
    await vi.advanceTimersByTimeAsync(200);
    expect(await answer).toEqual({ value: {}, at: started + SETTLE_MS });
    expect(state.parks).toBe(1);
    expect(contents.waits).toBe(0);
  });

  it("waits out a load that started and reports one that outlives the wait", async () => {
    const contents = new FakeLoading(true);
    const { state, running } = settle(contents, 60000);
    const answer = running.then((value) => value);
    await vi.advanceTimersByTimeAsync(SETTLE_MS);
    expect(contents.listening).toBe(1);
    contents.stop();
    await vi.advanceTimersByTimeAsync(10);
    expect(await answer).toEqual({});
    expect(contents.listening).toBe(0);
    expect(state.parks).toBe(2);

    const slow = new FakeLoading(true);
    const timing = settle(slow, 60000);
    const late = timing.running.then((value) => ({ value, at: Date.now() }));
    const started = Date.now();
    await vi.advanceTimersByTimeAsync(LOAD_WAIT_MS + SETTLE_MS + 10);
    expect(await late).toEqual({
      value: { loading: true },
      at: started + SETTLE_MS + LOAD_WAIT_MS,
    });
    expect(slow.listening).toBe(0);
  });

  it("starts no load wait past the budget", async () => {
    const contents = new FakeLoading(true);
    const { running } = settle(contents, 200);
    const answer = running.then((value) => value);
    await vi.advanceTimersByTimeAsync(300);
    expect(await answer).toEqual({ loading: true });
    expect(contents.waits).toBe(0);
  });
});
