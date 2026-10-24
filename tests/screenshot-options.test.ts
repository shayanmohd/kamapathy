import { describe, expect, it } from "vitest";
import { ApiError } from "../electron/agent/errors";
import {
  MAX_PIXELS,
  MAX_SIDE,
  planCapture,
  screenshotRequest,
  SCREENSHOT_TIMEOUT_MS,
  type LayoutMetrics,
  type ScreenshotRequest,
} from "../electron/agent/screenshot";

// Chromium's own numbers for a window of `window` device-independent pixels
// showing a document `content` CSS pixels large: the visual viewport in CSS
// pixels at the page's zoom, and the content size in device pixels.
const metrics = ({
  window = { width: 1280, height: 800 },
  content = { width: 1280, height: 3000 },
  scroll = { x: 0, y: 0 },
  zoom = 1,
  deviceScale = 1,
}: {
  window?: { width: number; height: number };
  content?: { width: number; height: number };
  scroll?: { x: number; y: number };
  zoom?: number;
  deviceScale?: number;
} = {}): LayoutMetrics => ({
  cssVisualViewport: {
    pageX: scroll.x,
    pageY: scroll.y,
    clientWidth: window.width / zoom,
    clientHeight: window.height / zoom,
    zoom,
  },
  contentSize: {
    width: Math.round(content.width * zoom * deviceScale),
    height: Math.round(content.height * zoom * deviceScale),
  },
});
const request = (
  options: Partial<ScreenshotRequest> = {},
): ScreenshotRequest => ({
  fullPage: false,
  scale: "css",
  timeoutMs: SCREENSHOT_TIMEOUT_MS,
  ...options,
});
const refusal = (run: () => unknown): ApiError => {
  try {
    run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("The call did not fail.");
};

describe("screenshot options", () => {
  it("fills in the defaults and refuses options the page cannot use", () => {
    expect(screenshotRequest(undefined)).toEqual({
      fullPage: false,
      scale: "css",
      timeoutMs: 15000,
    });
    expect(screenshotRequest({})).toEqual(screenshotRequest(undefined));
    expect(
      screenshotRequest({
        fullPage: true,
        clip: { x: 1.5, y: 2.5, width: 10, height: 20.5 },
        scale: "device",
        timeoutMs: 1,
      }),
    ).toEqual({
      fullPage: true,
      clip: { x: 1.5, y: 2.5, width: 10, height: 20.5 },
      scale: "device",
      timeoutMs: 1,
    });
    expect(refusal(() => screenshotRequest({ fullPage: "yes" }))).toMatchObject(
      {
        code: "invalid_field",
        message: "fullPage must be true or false.",
        status: 400,
        fields: { field: "fullPage", expected: "true or false" },
      },
    );
    expect(
      refusal(() => screenshotRequest({ clip: [0, 0, 10, 10] })),
    ).toMatchObject({
      code: "invalid_field",
      fields: { field: "clip" },
    });
    for (const clip of [
      { x: -1, y: 0, width: 10, height: 10 },
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: Number.POSITIVE_INFINITY, y: 0, width: 10, height: 10 },
      { x: "0", y: 0, width: 10, height: 10 },
    ])
      expect(refusal(() => screenshotRequest({ clip }))).toMatchObject({
        code: "invalid_field",
        message: "clip.x must be a number of at least 0.",
        fields: { field: "clip.x", expected: "a number of at least 0" },
      });
    expect(
      refusal(() =>
        screenshotRequest({ clip: { x: 0, y: -0.5, width: 10, height: 10 } }),
      ),
    ).toMatchObject({ fields: { field: "clip.y" } });
    for (const width of [0, -3, undefined, "10"])
      expect(
        refusal(() =>
          screenshotRequest({ clip: { x: 0, y: 0, width, height: 10 } }),
        ),
      ).toMatchObject({
        code: "invalid_field",
        message: "clip.width must be a number above 0.",
        fields: { field: "clip.width", expected: "a number above 0" },
      });
    expect(
      refusal(() =>
        screenshotRequest({ clip: { x: 0, y: 0, width: 10, height: 0 } }),
      ),
    ).toMatchObject({ fields: { field: "clip.height" } });
    for (const scale of ["retina", 2, null])
      expect(refusal(() => screenshotRequest({ scale }))).toMatchObject({
        code: "invalid_field",
        message: "scale must be css or device.",
        fields: { field: "scale", expected: "css or device" },
      });
    for (const timeoutMs of [0, 60001, 1.5, "1000"])
      expect(refusal(() => screenshotRequest({ timeoutMs }))).toMatchObject({
        code: "invalid_field",
        message: "timeoutMs must be an integer from 1 to 60000.",
        fields: { field: "timeoutMs", expected: "an integer from 1 to 60000" },
      });
    expect(screenshotRequest({ timeoutMs: 60000 }).timeoutMs).toBe(60000);
  });

  it("maps CSS clips to CDP at every zoom and display density", () => {
    const clip = { x: 13, y: 17, width: 201, height: 101 };
    for (const zoom of [1, 1.5, 1.1, 1.25, 0.9, 0.67])
      for (const deviceScale of [1, 2]) {
        const layout = metrics({ zoom, deviceScale, scroll: { x: 0, y: 200 } });
        const css = planCapture(request({ clip }), layout, zoom, deviceScale);
        // The clip is already whole pixels, so the region is the clip.
        expect(css.region).toEqual(clip);
        expect(css.cdpClip).toEqual({
          x: 13 * zoom,
          y: (200 + 17) * zoom,
          width: Math.ceil(201 * zoom - 1e-6),
          height: Math.ceil(101 * zoom - 1e-6),
          scale: 1 / (zoom * deviceScale),
        });
        expect(css.output).toEqual({ width: 201, height: 101 });
        expect(css.pixelRatio).toBe(1);
        const device = planCapture(
          request({ clip, scale: "device" }),
          layout,
          zoom,
          deviceScale,
        );
        expect(device.cdpClip).toEqual({ ...css.cdpClip, scale: 1 });
        expect(device.output).toEqual({
          width: Math.round(201 * zoom * deviceScale),
          height: Math.round(101 * zoom * deviceScale),
        });
        expect(device.pixelRatio).toBe(
          Math.round(zoom * deviceScale * 10000) / 10000,
        );
      }
    // The same clip at zoom 1.5 on a 2x display, in full.
    const layout = metrics({
      zoom: 1.5,
      deviceScale: 2,
      scroll: { x: 0, y: 200 },
    });
    expect(planCapture(request({ clip }), layout, 1.5, 2)).toMatchObject({
      cdpClip: { x: 19.5, y: 325.5, width: 302, height: 152, scale: 1 / 3 },
      output: { width: 201, height: 101 },
      pixelRatio: 1,
    });
    expect(
      planCapture(request({ clip, scale: "device" }), layout, 1.5, 2),
    ).toMatchObject({
      output: { width: 603, height: 303 },
      pixelRatio: 3,
    });
    // A zoom Chromium does not report falls back to 1.
    expect(
      planCapture(request({ clip }), layout, Number.NaN, 2).cdpClip,
    ).toMatchObject({ x: 13, y: 217, width: 201, height: 101, scale: 0.5 });
  });

  it("rounds clips outward and keeps them inside the image's own space", () => {
    const layout = metrics({ scroll: { x: 0, y: 500 } });
    // The viewport is the image's space, so a clip starts at its top left.
    expect(
      planCapture(
        request({ clip: { x: 10.4, y: 20.6, width: 100.1, height: 50 } }),
        layout,
        1,
        1,
      ),
    ).toMatchObject({
      region: { x: 10, y: 20, width: 101, height: 51 },
      cdpClip: { x: 10, y: 520, width: 101, height: 51, scale: 1 },
    });
    // A clip the viewport cuts off keeps only what is inside it.
    expect(
      planCapture(
        request({ clip: { x: 1200, y: 700, width: 400, height: 400 } }),
        layout,
        1,
        1,
      ).region,
    ).toEqual({ x: 1200, y: 700, width: 80, height: 100 });
    // With fullPage the document is the space, and the clip is in document
    // coordinates, so the scroll no longer moves it.
    expect(
      planCapture(
        request({
          fullPage: true,
          clip: { x: 0, y: 2900, width: 1280, height: 400 },
        }),
        layout,
        1,
        1,
      ),
    ).toMatchObject({
      region: { x: 0, y: 2900, width: 1280, height: 100 },
      cdpClip: { x: 0, y: 2900, width: 1280, height: 100, scale: 1 },
    });
    const outside = refusal(() =>
      planCapture(
        request({ clip: { x: 1280, y: 0, width: 10, height: 10 } }),
        layout,
        1,
        1,
      ),
    );
    expect(outside).toMatchObject({
      code: "clip_outside_page",
      status: 422,
      fields: { clip: { x: 1280, y: 0, width: 10, height: 10 } },
    });
    expect(
      refusal(() =>
        planCapture(
          request({
            fullPage: true,
            clip: { x: 0, y: 3000, width: 10, height: 10 },
          }),
          layout,
          1,
          1,
        ),
      ).code,
    ).toBe("clip_outside_page");
    // A viewport with no area at all has nothing to capture.
    expect(
      refusal(() =>
        planCapture(
          request(),
          metrics({ window: { width: 0, height: 0 } }),
          1,
          1,
        ),
      ),
    ).toMatchObject({ code: "empty_screenshot", status: 409 });
  });

  it("sizes the viewport and full pages from the numbers Chromium rounds", () => {
    // A fractional CSS viewport keeps whole pixels only.
    expect(
      planCapture(request(), metrics({ zoom: 1.5 }), 1.5, 2),
    ).toMatchObject({
      region: { x: 0, y: 0, width: 853, height: 533 },
      cdpClip: { x: 0, y: 0, width: 1280, height: 800, scale: 1 / 3 },
      output: { width: 853, height: 533 },
    });
    // cssContentSize would read 1,999 for this document; the device content
    // size divided by the density and the zoom reads 2,000.
    const zoom = 1.100000023841858;
    for (const deviceScale of [1, 2]) {
      const layout = metrics({
        content: { width: 1280, height: 2000 },
        zoom,
        deviceScale,
      });
      expect(
        planCapture(request({ fullPage: true }), layout, zoom, deviceScale)
          .region,
      ).toEqual({ x: 0, y: 0, width: 1280, height: 2000 });
    }
  });

  it("captures past the viewport only for a region that leaves it", () => {
    const layout = metrics({ scroll: { x: 0, y: 500 } });
    const beyond = (options: Partial<ScreenshotRequest>) =>
      planCapture(request(options), layout, 1, 1).captureBeyondViewport;
    expect(beyond({})).toBe(false);
    expect(beyond({ clip: { x: 10, y: 10, width: 100, height: 100 } })).toBe(
      false,
    );
    expect(beyond({ clip: { x: 1270, y: 790, width: 10, height: 10 } })).toBe(
      false,
    );
    // A document taller than the viewport, and a clip the scroll left behind.
    expect(beyond({ fullPage: true })).toBe(true);
    expect(
      beyond({ fullPage: true, clip: { x: 0, y: 0, width: 100, height: 100 } }),
    ).toBe(true);
    // A full page that fits the viewport needs nothing beyond it.
    expect(
      planCapture(
        request({ fullPage: true }),
        metrics({ content: { width: 1280, height: 800 } }),
        1,
        1,
      ).captureBeyondViewport,
    ).toBe(false);
    // A fullPage clip inside the visible part of the document.
    expect(
      beyond({
        fullPage: true,
        clip: { x: 0, y: 600, width: 100, height: 100 },
      }),
    ).toBe(false);
  });

  it("refuses an image past the side and pixel limits", () => {
    expect(MAX_SIDE).toBe(16384);
    expect(MAX_PIXELS).toBe(33554432);
    const tall = (height: number, deviceScale = 1) =>
      metrics({ content: { width: 1280, height }, deviceScale });
    expect(
      refusal(() =>
        planCapture(request({ fullPage: true }), tall(20000), 1, 1),
      ),
    ).toMatchObject({
      code: "screenshot_too_large",
      status: 422,
      fields: {
        width: 1280,
        height: 20000,
        maxSide: 16384,
        maxPixels: 33554432,
      },
    });
    // At device scale the output is the limit, not the CSS size.
    expect(
      refusal(() =>
        planCapture(
          request({ fullPage: true, scale: "device" }),
          tall(9000, 2),
          1,
          2,
        ),
      ).fields,
    ).toEqual({
      width: 2560,
      height: 18000,
      maxSide: 16384,
      maxPixels: 33554432,
    });
    expect(
      planCapture(request({ fullPage: true }), tall(16384), 1, 1).output,
    ).toEqual({ width: 1280, height: 16384 });
    // Both sides within the limit, too many pixels in all.
    expect(
      refusal(() =>
        planCapture(
          request({ fullPage: true }),
          metrics({ content: { width: 2560, height: 16384 } }),
          1,
          1,
        ),
      ).fields,
    ).toEqual({
      width: 2560,
      height: 16384,
      maxSide: 16384,
      maxPixels: 33554432,
    });
  });
});
