import type { IncomingMessage, ServerResponse } from "node:http";
import { downloadView, STREAM_LIMIT } from "../downloads";
import { ApiError, fail } from "../errors";
import { takeWaitSlot, WAIT_LIMIT } from "../expectations";
import { send, type RouteDeps, type RouteImpl } from "../http";
import { downloadWaitFields } from "../validate";

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

// Writes one chunk and waits for the socket to take it, so a client that
// reads slowly never fills this process. A client that goes away resolves
// this too, and the read stops on the next check.
const write = (response: ServerResponse, chunk: Buffer, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      response.off("close", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    response.on("close", done);
    signal.addEventListener("abort", done);
    response.write(chunk, done);
  });

// What a space holds, one download's progress, stopping one and deleting
// its bytes, waiting for one to finish and reading its bytes. A download is
// addressed by its own id, so it stays readable and deletable after its tab
// has closed.
export function downloadRoutes({
  authority,
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
    "POST /downloads/:id/wait": {
      resolve,
      // A wait runs outside every queue, so it shares one budget of slots
      // with the API's other long polls.
      beforeBody: () => {
        const release = takeWaitSlot();
        if (!release)
          return fail(
            "busy",
            `Kamapathy is already running ${WAIT_LIMIT} waits. Wait for one to answer, then try again.`,
            { scope: "server" },
          );
        return { release };
      },
      handler: async ({ request, response, body, run }) => {
        const { timeoutMs } = downloadWaitFields(body!);
        const download = await downloads.wait(held(request).id, timeoutMs, run);
        // The client went away, so there is nothing to answer.
        if (!download) return;
        return send(response, 200, { download: downloadView(download) });
      },
    },
    "GET /downloads/:id/content": {
      resolve,
      // Bytes leave outside every queue too, under a budget of their own.
      beforeBody: () => {
        const release = downloads.takeStreamSlot();
        if (!release)
          return fail(
            "busy",
            `Kamapathy is already streaming ${STREAM_LIMIT} downloads. Wait for one to finish, then try again.`,
            { scope: "server" },
          );
        return { release };
      },
      handler: async ({ request, response, run }) => {
        const download = held(request);
        const { bytes, read } = downloads.open(download.id);
        // A client that leaves mid-stream fails the write; the read below
        // stops on its own, so the failure needs no report.
        response.on("error", () => {});
        response.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(bytes),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        let written = 0;
        try {
          await read(async (chunk) => {
            // Ownership before every MiB: a takeover, a space that ended, a
            // deleted download or a client that left stops the stream here.
            if (run.signal.aborted) return false;
            try {
              authority.authorizeSpace(download.spaceId);
            } catch {
              return false;
            }
            written += chunk.length;
            await write(response, chunk, run.signal);
            return true;
          });
        } catch {
          // The bytes went while they were read, which the headers can no
          // longer say; the connection drops instead.
          return response.destroy();
        }
        // Short of the length the header promised: the connection drops
        // without an end, so the client knows its file is incomplete.
        if (written === bytes && !run.signal.aborted) response.end();
        else response.destroy();
      },
    },
  };
}
