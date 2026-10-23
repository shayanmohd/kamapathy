import type { IncomingMessage } from "node:http";
import { downloadView } from "../downloads";
import { ApiError } from "../errors";
import { send, type RouteDeps, type RouteImpl } from "../http";

// The id segment of /downloads/:id and /downloads/:id/cancel. Paths carry no
// query strings or encoded segments, so this is the raw id.
const idOf = (request: IncomingMessage) =>
  (request.url ?? "").split("/").filter(Boolean)[1] ?? "";

// The one answer for an id that names no held download.
export const downloadNotFound = () =>
  new ApiError(
    "download_not_found",
    "No held download has this ID: it was deleted, its space closed, or an hour passed since it finished.",
  );

// What a space holds, one download's progress, stopping one and deleting
// its bytes. A download is addressed by its own id, so it stays readable
// and deletable after its tab has closed.
export function downloadRoutes({
  downloads,
}: RouteDeps): Record<string, RouteImpl> {
  // Each /downloads/:id route is authorized through its download's space.
  const resolve = (parts: string[]) => {
    const download = downloads.get(parts[1]);
    if (!download) throw downloadNotFound();
    return { spaceId: download.spaceId };
  };
  const held = (request: IncomingMessage) => {
    const download = downloads.get(idOf(request));
    if (!download) throw downloadNotFound();
    return download;
  };
  return {
    "GET /spaces/:id/downloads": {
      handler: async ({ response, space }) =>
        send(response, 200, {
          downloads: downloads.listSpace(space!.id).map(downloadView),
        }),
    },
    "GET /downloads/:id": {
      resolve,
      handler: async ({ request, response }) =>
        send(response, 200, { download: downloadView(held(request)) }),
    },
    "POST /downloads/:id/cancel": {
      resolve,
      handler: async ({ request, response }) =>
        send(response, 200, {
          download: downloadView(downloads.cancel(held(request).id)),
        }),
    },
    "DELETE /downloads/:id": {
      resolve,
      handler: async ({ request, response }) => {
        downloads.remove(held(request).id);
        return send(response, 200, { ok: true });
      },
    },
  };
}
