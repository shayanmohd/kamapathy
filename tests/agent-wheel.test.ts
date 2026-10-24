import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../electron/agent/errors";
import {
  WHEEL_GAP_MS,
  WHEEL_STEP_PX,
  pointerCommands,
  scrollToPoint,
  wheelEvents,
} from "../electron/agent/input/actions";
import type { InputDispatcher } from "../electron/agent/input/dispatch";
import type { InputCommand } from "../electron/agent/input/keys";
import { InputState } from "../electron/agent/input/state";
import type { DispatchStep } from "../electron/agent/input/dispatch";

const sums = (events: { deltaX: number; deltaY: number }[]) => ({
  deltaX: events.reduce((total, event) => total + event.deltaX, 0),
  deltaY: events.reduce((total, event) => total + event.deltaY, 0),
});
// A list rises to one peak and falls, allowing equal neighbours.
const risesThenFalls = (values: number[]) => {
  const peak = values.indexOf(Math.max(...values));
  return (
    values
      .slice(0, peak + 1)
      .every((value, at, all) => at === 0 || all[at - 1] <= value) &&
    values
      .slice(peak)
      .every((value, at, all) => at === 0 || all[at - 1] >= value)
  );
};

describe("wheel gestures", () => {
  it("sends one event up to one step and keeps the delta exact", () => {
    expect(WHEEL_STEP_PX).toBe(100);
    expect(wheelEvents(0, 60)).toEqual([{ deltaX: 0, deltaY: 60 }]);
    expect(wheelEvents(0, 100)).toEqual([{ deltaX: 0, deltaY: 100 }]);
    expect(wheelEvents(-40, 0)).toEqual([{ deltaX: -40, deltaY: 0 }]);
    expect(wheelEvents(0, 0)).toEqual([{ deltaX: 0, deltaY: 0 }]);
  });

  it("splits a long delta into at most ten eased events that sum exactly", () => {
    const events = wheelEvents(0, 900);
    expect(events.length).toBeGreaterThan(1);
    expect(events.length).toBeLessThanOrEqual(10);
    expect(sums(events)).toEqual({ deltaX: 0, deltaY: 900 });
    const steps = events.map((event) => event.deltaY);
    expect(risesThenFalls(steps)).toBe(true);
    // No event is a whole step on its own, so the page sees a gesture.
    expect(Math.max(...steps)).toBeLessThan(900);
    const long = wheelEvents(0, 10000);
    expect(long).toHaveLength(10);
    expect(sums(long)).toEqual({ deltaX: 0, deltaY: 10000 });
  });

  it("keeps the sign of a negative delta and moves both axes together", () => {
    const up = wheelEvents(0, -900);
    expect(sums(up)).toEqual({ deltaX: 0, deltaY: -900 });
    expect(up.every((event) => event.deltaY <= 0)).toBe(true);
    expect(risesThenFalls(up.map((event) => -event.deltaY))).toBe(true);
    const both = wheelEvents(-300, 600);
    expect(sums(both)).toEqual({ deltaX: -300, deltaY: 600 });
    expect(both.every((event) => event.deltaX <= 0 && event.deltaY >= 0)).toBe(
      true,
    );
    // Every event carries both axes, so the point travels in a line.
    expect(both.filter((event) => event.deltaX === 0)).toHaveLength(0);
  });

  it("refuses a delta the routes do not accept", () => {
    expect(sums(wheelEvents(0, -10000))).toEqual({ deltaX: 0, deltaY: -10000 });
    for (const [deltaX, deltaY, field] of [
      [0, 10001, "deltaY"],
      [-10001, 0, "deltaX"],
      [Number.NaN, 0, "deltaX"],
    ] as const) {
      let raised: unknown;
      try {
        wheelEvents(deltaX, deltaY);
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeInstanceOf(ApiError);
      expect((raised as ApiError).code).toBe("invalid_field");
      expect((raised as ApiError).fields.field).toBe(field);
    }
  });
});

describe("pointer commands", () => {
  it("names the button, the held buttons, the click count and the mask", () => {
    expect(
      pointerCommands({
        type: "moved",
        point: { x: 12, y: 30 },
        button: "none",
        buttons: 0,
        modifiers: 0,
      }),
    ).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mouseMoved",
          x: 12,
          y: 30,
          button: "none",
          buttons: 0,
          modifiers: 0,
        },
      },
    ]);
    expect(
      pointerCommands({
        type: "pressed",
        point: { x: 4, y: 5 },
        button: "right",
        buttons: 2,
        clickCount: 2,
        modifiers: 8,
      }),
    ).toEqual([
      {
        method: "Input.dispatchMouseEvent",
        params: {
          type: "mousePressed",
          x: 4,
          y: 5,
          button: "right",
          buttons: 2,
          clickCount: 2,
          modifiers: 8,
        },
      },
    ]);
    expect(
      pointerCommands({
        type: "released",
        point: { x: 4, y: 5 },
        button: "left",
        buttons: 0,
        clickCount: 1,
        modifiers: 0,
      })[0].params.type,
    ).toBe("mouseReleased");
  });
});

describe("scrolling a point into view", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // A dispatcher that records the commands and the step each send carried.
  const recorder = () => {
    const sent: { commands: InputCommand[]; step: DispatchStep; at: number }[] =
      [];
    const dispatcher = {
      state: new InputState("tab-1"),
      send: async () => {},
      key: async () => {},
      pointer: async (
        commands: readonly InputCommand[],
        step: DispatchStep,
      ) => {
        sent.push({ commands: [...commands], step, at: Date.now() });
      },
      release: async () => [],
    } as unknown as InputDispatcher;
    return { sent, dispatcher };
  };

  it("sends the eased events at the request's point, 12 ms apart, with no dispatch record", async () => {
    expect(WHEEL_GAP_MS).toBe(12);
    const { sent, dispatcher } = recorder();
    const dispatch = { dispatched: false };
    const running = scrollToPoint({
      request: { x: 300, y: 400, deltaX: 0, deltaY: 900 },
      dispatcher,
      step: { deadline: Date.now() + 10000, dispatch },
    });
    await vi.advanceTimersByTimeAsync(5000);
    await running;
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.map((entry) => entry.at - sent[0].at)).toEqual(
      sent.map((_entry, index) => index * WHEEL_GAP_MS),
    );
    const deltas = sent.map((entry) => ({
      deltaX: entry.commands[0].params.deltaX as number,
      deltaY: entry.commands[0].params.deltaY as number,
    }));
    expect(sums(deltas)).toEqual({ deltaX: 0, deltaY: 900 });
    for (const entry of sent) {
      expect(entry.commands[0].method).toBe("Input.dispatchMouseEvent");
      expect(entry.commands[0].params).toMatchObject({
        type: "mouseWheel",
        x: 300,
        y: 400,
      });
      // A scroll before the commit point never marks the request.
      expect(entry.step.dispatch).toBeUndefined();
    }
    expect(dispatch.dispatched).toBe(false);
  });
});
