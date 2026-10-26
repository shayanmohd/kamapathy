// The main process's copy of the page's frame math: a point, a rectangle and
// the visible part of a frame, mapped outward through every owner, and a top
// level area mapped back into a frame for a viewport snapshot.
import { describe, expect, it } from "vitest";
import {
  emptyArea,
  innerArea,
  mapPoint,
  mapRect,
  scaleOf,
  visibleArea,
  type Area,
  type OwnerBox,
} from "../electron/agent/frames/geometry";

const VIEWPORT: Area = { left: 0, top: 0, right: 800, bottom: 600 };
const owner = (over: Partial<OwnerBox>): OwnerBox => ({
  x: 0,
  y: 0,
  scaleX: 1,
  scaleY: 1,
  width: 300,
  height: 200,
  ...over,
});
const round = (area: Area): Area => ({
  left: Math.round(area.left),
  top: Math.round(area.top),
  right: Math.round(area.right),
  bottom: Math.round(area.bottom),
});

describe("frame geometry", () => {
  it("translates points through two offset, scaled owners", () => {
    const outer = owner({ x: 100, y: 50, scaleX: 2, scaleY: 3 });
    const inner = owner({ x: 10, y: 5, scaleX: 0.5, scaleY: 0.5 });
    // One level at a time: the point of the inner document lands in the
    // outer one, and that lands in the top viewport.
    const once = mapPoint({ x: 20, y: 10 }, [inner]);
    expect(once).toEqual({ x: 10 + 20 * 0.5, y: 5 + 10 * 0.5 });
    expect(mapPoint(once, [outer])).toEqual({
      x: 100 + 20 * 2,
      y: 50 + 10 * 3,
    });
    // The whole chain, outermost first, gives the same point.
    expect(mapPoint({ x: 20, y: 10 }, [outer, inner])).toEqual({
      x: 140,
      y: 80,
    });
    // The scales multiply along the chain.
    expect(scaleOf([outer, inner])).toEqual({ scaleX: 1, scaleY: 1.5 });
    expect(scaleOf([outer])).toEqual({ scaleX: 2, scaleY: 3 });
    expect(scaleOf([])).toEqual({ scaleX: 1, scaleY: 1 });
    expect(mapPoint({ x: 7, y: 9 }, [])).toEqual({ x: 7, y: 9 });
    // A rectangle maps corner by corner, with the chain's scale.
    expect(
      mapRect({ left: 20, top: 10, right: 40, bottom: 30 }, [outer, inner]),
    ).toEqual({ left: 140, top: 80, right: 160, bottom: 110 });
  });

  it("intersects visible areas at every boundary", () => {
    // An owner scrolled half out of the viewport can show only its top half.
    const outer = owner({ x: 100, y: 300, width: 400, height: 500 });
    expect(visibleArea(VIEWPORT, [outer])).toEqual({
      left: 100,
      top: 300,
      right: 500,
      bottom: 600,
    });
    // A nested owner narrows the area again, inside its owner's part.
    const inner = owner({ x: 20, y: 100, width: 200, height: 200 });
    expect(visibleArea(VIEWPORT, [outer, inner])).toEqual({
      left: 120,
      top: 400,
      right: 320,
      bottom: 600,
    });
    // A content box wider than the viewport is bounded by the viewport, and
    // the owner's scale applies to the size it shows.
    expect(
      visibleArea(VIEWPORT, [
        owner({
          x: 100,
          y: 300,
          scaleX: 2,
          scaleY: 2,
          width: 400,
          height: 500,
        }),
      ]),
    ).toEqual({ left: 100, top: 300, right: 800, bottom: 600 });
    // A frame sitting inside a scrolled owner is clipped by the owner, not
    // only by the viewport.
    expect(
      visibleArea(VIEWPORT, [
        owner({ x: 0, y: 0, width: 200, height: 200 }),
        owner({ x: 150, y: 150, width: 400, height: 400 }),
      ]),
    ).toEqual({ left: 150, top: 150, right: 200, bottom: 200 });
    expect(visibleArea(VIEWPORT, [])).toEqual(VIEWPORT);
    expect(emptyArea(visibleArea(VIEWPORT, [outer, inner]))).toBe(false);
  });

  it("reports an empty area as outside the viewport", () => {
    // An owner scrolled past the bottom of the viewport shows nothing.
    const gone = visibleArea(VIEWPORT, [
      owner({ x: 0, y: 700, width: 400, height: 300 }),
    ]);
    expect(emptyArea(gone)).toBe(true);
    // So does a nested frame below its owner's visible part.
    expect(
      emptyArea(
        visibleArea(VIEWPORT, [
          owner({ x: 0, y: 0, width: 400, height: 200 }),
          owner({ x: 0, y: 400, width: 400, height: 300 }),
        ]),
      ),
    ).toBe(true);
    // A box with no width or height is empty as well.
    expect(emptyArea({ left: 5, top: 0, right: 5, bottom: 10 })).toBe(true);
    expect(emptyArea({ left: 0, top: 9, right: 10, bottom: 9 })).toBe(true);
    expect(emptyArea({ left: 0, top: 0, right: 1, bottom: 1 })).toBe(false);
  });

  it("maps a top-level area into a frame for viewport scope", () => {
    const owners = [
      owner({ x: 100, y: 50, scaleX: 2, scaleY: 3 }),
      owner({ x: 10, y: 5, scaleX: 0.5, scaleY: 0.5 }),
    ];
    const rect: Area = { left: 12, top: 34, right: 56, bottom: 78 };
    // innerArea undoes mapRect for the same chain.
    const back = innerArea(mapRect(rect, owners), owners);
    expect(back.left).toBeCloseTo(rect.left, 9);
    expect(back.top).toBeCloseTo(rect.top, 9);
    expect(back.right).toBeCloseTo(rect.right, 9);
    expect(back.bottom).toBeCloseTo(rect.bottom, 9);
    // What a viewport snapshot of the frame may read: the part of the top
    // viewport the frame shows, in the frame's own pixels.
    const scrolled = [owner({ x: 0, y: 400, width: 300, height: 400 })];
    expect(round(innerArea(visibleArea(VIEWPORT, scrolled), scrolled))).toEqual(
      {
        left: 0,
        top: 0,
        right: 300,
        bottom: 200,
      },
    );
    // A halved owner shows twice as much of its own document.
    const half = [
      owner({ x: 0, y: 0, scaleX: 0.5, scaleY: 0.5, width: 400, height: 400 }),
    ];
    expect(round(innerArea(visibleArea(VIEWPORT, half), half))).toEqual({
      left: 0,
      top: 0,
      right: 400,
      bottom: 400,
    });
    expect(innerArea(VIEWPORT, [])).toEqual(VIEWPORT);
  });
});
