import { fail } from "./errors";

// Chromium answers a larger capture without an error, repeating the page's
// top from row 16,384, so the output size is checked before the capture.
// The pixel count bounds the memory and time one capture may take.
export const MAX_SIDE = 16384;
export const MAX_PIXELS = 33554432;
export const SCREENSHOT_TIMEOUT_MS = 15000;

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ScreenshotRequest {
  fullPage: boolean;
  clip?: Clip;
  scale: "css" | "device";
  timeoutMs: number;
}
// What Page.getLayoutMetrics reports: the visual viewport in CSS pixels at
// the page's zoom, and the content size in device pixels.
export interface LayoutMetrics {
  cssVisualViewport: {
    pageX: number;
    pageY: number;
    clientWidth: number;
    clientHeight: number;
    zoom?: number;
  };
  contentSize: { width: number; height: number };
}
export interface CapturePlan {
  // Whole CSS pixels of the image's own space, as the clip header reports.
  region: Clip;
  cdpClip: Clip & { scale: number };
  captureBeyondViewport: boolean;
  output: { width: number; height: number };
  pixelRatio: number;
}

const field = (name: string, expected: string): never =>
  fail("invalid_field", `${name} must be ${expected}.`, {
    field: name,
    expected,
  });
const size = (value: unknown, name: string, above: boolean): number => {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (above ? value > 0 : value >= 0)
  )
    return value;
  return field(name, above ? "a number above 0" : "a number of at least 0");
};

const flag = (value: unknown, name: string): boolean =>
  typeof value === "boolean" ? value : field(name, "true or false");
const clipOf = (value: unknown): Clip => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    field("clip", "an object with x, y, width and height");
  const parts = value as Record<string, unknown>;
  return {
    x: size(parts.x, "clip.x", false),
    y: size(parts.y, "clip.y", false),
    width: size(parts.width, "clip.width", true),
    height: size(parts.height, "clip.height", true),
  };
};
const scaleOf = (value: unknown): "css" | "device" =>
  value === "css" || value === "device"
    ? value
    : field("scale", "css or device");
const timeoutOf = (value: unknown): number =>
  Number.isInteger(value) &&
  (value as number) >= 1 &&
  (value as number) <= 60000
    ? (value as number)
    : field("timeoutMs", "an integer from 1 to 60000");

// A screenshot body with its defaults. The schema checks the fields a route
// declares; a clip's width and height must be above 0, which it cannot say.
export function screenshotRequest(
  body: Record<string, unknown> | undefined,
): ScreenshotRequest {
  const given = body ?? {};
  const clip = given.clip === undefined ? undefined : clipOf(given.clip);
  return {
    fullPage:
      given.fullPage === undefined ? false : flag(given.fullPage, "fullPage"),
    ...(clip ? { clip } : {}),
    scale: given.scale === undefined ? "css" : scaleOf(given.scale),
    timeoutMs:
      given.timeoutMs === undefined
        ? SCREENSHOT_TIMEOUT_MS
        : timeoutOf(given.timeoutMs),
  };
}

// What to send Chromium for a request: the region of the image's own space
// to capture, the clip in device-independent pixels from the document
// origin, and the size the image must end up.
export function planCapture(
  request: ScreenshotRequest,
  metrics: LayoutMetrics,
  zoom: number,
  deviceScale: number,
): CapturePlan {
  const factor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const view = metrics.cssVisualViewport;
  // The image's own space: the whole document with fullPage, else the
  // visible viewport. Chromium truncates its CSS content size, so a full
  // page is measured from the device pixels it reports.
  const space = request.fullPage
    ? {
        x: 0,
        y: 0,
        width: Math.round(metrics.contentSize.width / deviceScale / factor),
        height: Math.round(metrics.contentSize.height / deviceScale / factor),
      }
    : {
        x: view.pageX,
        y: view.pageY,
        width: Math.floor(view.clientWidth + 1e-6),
        height: Math.floor(view.clientHeight + 1e-6),
      };
  const region = { x: 0, y: 0, width: space.width, height: space.height };
  if (request.clip) {
    const { x, y, width, height } = request.clip;
    const left = Math.max(Math.floor(x), 0);
    const top = Math.max(Math.floor(y), 0);
    const right = Math.min(Math.ceil(x + width), space.width);
    const bottom = Math.min(Math.ceil(y + height), space.height);
    if (right <= left || bottom <= top)
      fail(
        "clip_outside_page",
        request.fullPage
          ? "The clip is outside the document. Read the page's size from a snapshot first."
          : "The clip is outside the viewport. Scroll the page, or capture with fullPage.",
        { clip: request.clip },
      );
    region.x = left;
    region.y = top;
    region.width = right - left;
    region.height = bottom - top;
  } else if (region.width <= 0 || region.height <= 0)
    fail("empty_screenshot", "The page has not rendered yet. Try again.");
  const output =
    request.scale === "device"
      ? {
          width: Math.round(region.width * factor * deviceScale),
          height: Math.round(region.height * factor * deviceScale),
        }
      : { width: region.width, height: region.height };
  if (
    output.width > MAX_SIDE ||
    output.height > MAX_SIDE ||
    output.width * output.height > MAX_PIXELS
  )
    fail(
      "screenshot_too_large",
      `The image would be ${output.width} by ${output.height} pixels. Capture a clip, or a part of the page.`,
      {
        ...output,
        maxSide: MAX_SIDE,
        maxPixels: MAX_PIXELS,
      },
    );
  const origin = { x: space.x + region.x, y: space.y + region.y };
  return {
    region,
    cdpClip: {
      x: origin.x * factor,
      y: origin.y * factor,
      // Chromium rounds a clip's size in device-independent pixels down, so
      // it is asked for rounded up and the image is cropped after.
      width: Math.ceil(region.width * factor - 1e-6),
      height: Math.ceil(region.height * factor - 1e-6),
      scale: request.scale === "device" ? 1 : 1 / (factor * deviceScale),
    },
    // Pixels beyond the viewport cost the page a resize and its observers,
    // so they are asked for only where the region needs them.
    captureBeyondViewport:
      origin.x < view.pageX - 1e-6 ||
      origin.y < view.pageY - 1e-6 ||
      origin.x + region.width > view.pageX + view.clientWidth + 1e-6 ||
      origin.y + region.height > view.pageY + view.clientHeight + 1e-6,
    output,
    pixelRatio:
      request.scale === "device"
        ? Math.round(factor * deviceScale * 10000) / 10000
        : 1,
  };
}
