import { remaining } from "../actions";
import { fail } from "../errors";
import type { RouteCall, RouteDeps, RouteImpl } from "../http";
import {
  planCapture,
  screenshotRequest,
  type LayoutMetrics,
} from "../screenshot";

// GET and POST /tabs/:id/screenshot. Both capture the tab's own page on its
// own debugger session, with the window in any state, and answer the PNG.
export function screenshotRoutes({
  controller,
  authority,
  actions: { readyContents },
}: RouteDeps): Record<string, RouteImpl> {
  const { authorizeTab } = authority;
  // A capture changes nothing in the page, so run.dispatch stays clear.
  const capture = async ({ response, body, tab, run }: RouteCall) => {
    const request = screenshotRequest(body);
    const deadline = Math.min(run.deadline, Date.now() + request.timeoutMs);
    const guard = () => authorizeTab(tab!.id);
    const { contents, session } = await readyContents(
      tab!.id,
      remaining(deadline),
      false,
      run.park,
    );
    const metrics = await session.send<LayoutMetrics>(
      "Page.getLayoutMetrics",
      {},
      { deadline, guard },
    );
    const zoom = metrics.cssVisualViewport.zoom ?? contents.getZoomFactor();
    // The limits and the clip are decided here, before a view is lent.
    const plan = planCapture(request, metrics, zoom, controller.deviceScale());
    const png = await controller.withVisibleView(tab!.id, () =>
      session.captureScreenshot(
        {
          clip: plan.cdpClip,
          captureBeyondViewport: plan.captureBeyondViewport,
        },
        { deadline, guard },
      ),
    );
    authorizeTab(tab!.id);
    const image = controller.cropPng(
      png,
      plan.output.width,
      plan.output.height,
    );
    if (!image)
      return fail(
        "empty_screenshot",
        "The page has not rendered yet. Try again.",
      );
    if (
      image.width !== plan.output.width ||
      image.height !== plan.output.height
    )
      return fail(
        "screenshot_failed",
        "The page could not render a screenshot. Read a snapshot or try again after the page finishes rendering.",
      );
    controller.addActivity(
      tab!.spaceId,
      request.fullPage
        ? "Agent captured a full-page screenshot"
        : "Agent captured a page screenshot",
      "info",
    );
    if (response.destroyed || response.writableEnded) return;
    const { x, y, width, height } = plan.region;
    response.writeHead(200, {
      "Content-Type": "image/png",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Kamapathy-Clip": `${x},${y},${width},${height}`,
      "X-Kamapathy-Pixel-Ratio": String(plan.pixelRatio),
    });
    return response.end(image.png);
  };
  return {
    "GET /tabs/:id/screenshot": { handler: capture },
    "POST /tabs/:id/screenshot": { handler: capture },
  };
}
