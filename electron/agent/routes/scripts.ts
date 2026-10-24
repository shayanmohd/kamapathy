import { randomBytes } from "node:crypto";
import { remaining } from "../actions";
import type { FetchReply } from "../dom/fetch";
import { ApiError, envelope, fail } from "../errors";
import { evaluateScript, type ScriptStep } from "../evaluate";
import { send, type RouteDeps, type RouteImpl } from "../http";
import { startNdjson } from "../ndjson";
import { CdpTimeoutError } from "../session/errors";
import type { TabSession } from "../session/tab-session";
import { evaluateFields, fetchFields } from "../validate";
import { tabView } from "../views";

// How much of a body one answer carries, and how much one stream may.
const ANSWER_LIMIT = 8 * 1024 * 1024;
const STREAM_LIMIT = 512 * 1024 * 1024;
// How long the page gets to drop a request the route gave up on.
const CANCEL_MS = 2000;
// What an answer from the document the page has left says.
const MOVED =
  "The page navigated during this operation. Inspect the new page before continuing.";

const originOf = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};
// Frees a body the route stopped reading. Its own deadline is short and its
// own signal is none, so an aborted call still reaches the page.
async function cancelFetch(
  session: TabSession,
  frameId: string,
  handle: string,
  namespace: string,
): Promise<void> {
  try {
    await session.evaluateInFrame(
      frameId,
      "fetch",
      { phase: "cancel", handle },
      {
        deadline: Date.now() + CANCEL_MS,
        timeoutMs: CANCEL_MS,
        namespace,
      },
    );
  } catch {
    // The document, the page or the session has gone, and the handle with it.
  }
}

// A call ends as soon as its signal aborts: a switch-off, or a client that
// left. The session waits on its deadline alone, so this is the one place
// either reaches an evaluation that is still running.
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}

// POST /tabs/:id/evaluate and POST /tabs/:id/fetch: the agent's own code and
// the agent's own requests in the page's main frame.
export function scriptRoutes(deps: RouteDeps): Record<string, RouteImpl> {
  const { controller, authority, actions, pageScripts } = deps;
  const { readyContents } = actions;
  const { authorizeTab } = authority;
  return {
    // POST /tabs/:id/fetch: the page's own fetch, with its cookies, origin,
    // CSP and CORS. A body larger than one answer streams as NDJSON lines.
    "POST /tabs/:id/fetch": {
      handler: async ({ response, body, tab, run }) => {
        pageScripts.require();
        const { timeoutMs, stream, ...start } = fetchFields(body!, tab!.url);
        // A fetch needs a committed document, not a finished page.
        const { session } = await readyContents(
          tab!.id,
          remaining(run.deadline),
          true,
          run.park,
        );
        const epoch = session.epoch;
        const signal = AbortSignal.any([run.signal, pageScripts.signal()]);
        // One promise for the whole call, so a long read adds no listener
        // per chunk. Its own catch keeps an abort between chunks quiet.
        const aborted = untilAborted(signal);
        void aborted.catch(() => {});
        // Checked before every call, after the head and between chunks: a
        // takeover, a switch-off or a new document ends the read here.
        const guard = () => {
          authorizeTab(tab!.id);
          pageScripts.require();
          if (session.epoch !== epoch) fail("page_changed", MOVED);
        };
        const namespace = actions.namespace(tab!.id, session);
        const deadline = Math.min(run.deadline, Date.now() + timeoutMs);
        const frameId = await session.mainFrameId({ deadline, signal, guard });
        // The route names the handle, so a cancel reaches a request whose
        // response has not arrived.
        const handle = randomBytes(16).toString("hex");
        // The page still holds the handle, so giving up has to free it.
        let open = true;
        const call = async (
          payload: Record<string, unknown>,
          awaited: "response" | "body",
        ): Promise<FetchReply> => {
          try {
            return (await Promise.race([
              session.evaluateInFrame(frameId, "fetch", payload, {
                deadline,
                signal,
                guard,
                dispatch: run.dispatch,
                timeoutMs: Math.max(1, deadline - Date.now()),
                namespace,
              }),
              aborted,
            ])) as FetchReply;
          } catch (error) {
            if (!(error instanceof CdpTimeoutError)) throw error;
            throw new ApiError(
              "fetch_timeout",
              `The fetch did not answer within ${timeoutMs} ms. Kamapathy cancelled the request; the server may already have it.`,
              { awaited, timeoutMs },
            );
          }
        };
        // What the page could not fetch, with the reason Kamapathy's own
        // network tracker saw for that URL.
        const refuse = (reply: Extract<FetchReply, { ok: false }>): never => {
          open = false;
          if (reply.code === "page_changed") return fail("page_changed", MOVED);
          if (reply.code !== "fetch_failed")
            return fail("invalid_url", `The page cannot fetch ${start.url}.`);
          const target = originOf(start.url);
          const crossOrigin =
            target !== undefined && target !== reply.pageOrigin;
          const seen = session.network.failureFor(start.url);
          const refused = crossOrigin && start.mode !== "no-cors";
          return fail(
            "fetch_failed",
            seen?.corsError || refused
              ? `${reply.pageOrigin} cannot read ${start.url}: the server does not allow it${seen?.corsError ? ` (${seen.corsError})` : ""}. Use mode no-cors for an opaque response, or fetch from a tab on that site.`
              : `The page could not fetch ${start.url}: ${reply.error}`,
            {
              url: start.url,
              pageOrigin: reply.pageOrigin,
              crossOrigin,
              mode: start.mode,
              name: reply.name,
              ...(seen?.corsError === undefined
                ? {}
                : { corsError: seen.corsError }),
              ...(seen?.blockedReason === undefined
                ? {}
                : { blockedReason: seen.blockedReason }),
              ...(seen?.netError === undefined
                ? {}
                : { netError: seen.netError }),
            },
          );
        };
        const readChunk = async () => {
          const chunk = await call({ phase: "read", handle }, "body");
          if (!chunk.ok) return refuse(chunk);
          if (chunk.phase !== "read")
            return fail("operation_failed", "The page did not read the body.");
          return chunk;
        };
        try {
          const started = await call(
            { phase: "start", handle, ...start },
            "response",
          );
          if (!started.ok) return refuse(started);
          if (started.phase !== "start")
            return fail(
              "operation_failed",
              "The page did not start the fetch.",
            );
          guard();
          const head = {
            ok: started.head.ok === true,
            status: started.head.status,
            statusText: started.head.statusText,
            url: started.head.url,
            redirected: started.head.redirected === true,
            type: started.head.type,
            headers: Object.fromEntries(
              Object.entries(started.head.headers ?? {}).map(
                ([name, value]) => [name.toLowerCase(), value],
              ),
            ),
          };
          const tooLarge = (bytes: number, limit: number) =>
            new ApiError(
              "result_too_large",
              `The body is over the ${limit} bytes ${limit === ANSWER_LIMIT ? "one answer carries. Save it to a file with saveAs" : "one stream carries. Ask the server for part of it"}.`,
              {
                bytes,
                limit,
                status: head.status,
                url: head.url,
                headers: head.headers,
              },
            );
          controller.addActivity(
            authorizeTab(tab!.id).spaceId,
            "Agent fetched a URL in the page",
            "info",
          );
          if (stream) {
            const writer = startNdjson(response);
            let bytes = 0;
            try {
              await writer.write({ head });
              for (;;) {
                const chunk = await readChunk();
                guard();
                // The page counts the bytes it read, and the line carries
                // them, so nothing is decoded on the way through.
                bytes +=
                  typeof chunk.bytes === "number" && chunk.bytes > 0
                    ? chunk.bytes
                    : 0;
                if (bytes > STREAM_LIMIT) throw tooLarge(bytes, STREAM_LIMIT);
                if (chunk.data) await writer.write({ data: chunk.data });
                if (chunk.done) {
                  open = false;
                  break;
                }
              }
              await writer.write({ end: { bytes } });
            } catch (error) {
              // The head is already sent, so the failure is a line of its
              // own and no end follows it.
              await writer.write({
                error: envelope(error, run.dispatch.dispatched, {
                  route: "POST /tabs/:id/fetch",
                }).error,
              });
            }
            return writer.end();
          }
          const parts: Buffer[] = [];
          let bytes = 0;
          for (;;) {
            const chunk = await readChunk();
            guard();
            const data = Buffer.from(chunk.data, "base64");
            bytes += data.length;
            if (bytes > ANSWER_LIMIT) throw tooLarge(bytes, ANSWER_LIMIT);
            parts.push(data);
            if (chunk.done) {
              open = false;
              break;
            }
          }
          const current = authorizeTab(tab!.id);
          return send(response, 200, {
            ok: true,
            tab: tabView(current, controller.shownTab(current.spaceId)),
            response: { ...head, body: Buffer.concat(parts).toString("utf8") },
          });
        } finally {
          // A call that stopped early leaves no body open in the page.
          if (open) await cancelFetch(session, frameId, handle, namespace);
        }
      },
    },
    "POST /tabs/:id/evaluate": {
      handler: async ({ response, body, tab, run }) => {
        pageScripts.require();
        const { timeoutMs, ...source } = evaluateFields(body!);
        // Evaluate waits for a committed document only, so a page still
        // loading its subresources runs the script now.
        const { session } = await readyContents(
          tab!.id,
          remaining(run.deadline),
          true,
          run.park,
        );
        const epoch = session.epoch;
        const signal = AbortSignal.any([run.signal, pageScripts.signal()]);
        const guard = () => {
          authorizeTab(tab!.id);
          pageScripts.require();
        };
        const step: ScriptStep = {
          deadline: Math.min(run.deadline, Date.now() + timeoutMs),
          signal,
          guard,
          dispatch: run.dispatch,
          timeoutMs,
          replMode: true,
        };
        const result = await Promise.race([
          evaluateScript(session, source, step),
          untilAborted(signal),
        ]);
        // The answer passes the guard first, so a takeover or a switch-off
        // keeps the value with the page.
        guard();
        if (session.epoch !== epoch)
          return fail(
            "page_changed",
            "The page navigated during this operation. Inspect the new page before continuing.",
          );
        const current = authorizeTab(tab!.id);
        controller.addActivity(
          current.spaceId,
          "Agent ran a page script",
          "info",
        );
        return send(response, 200, {
          ok: true,
          tab: tabView(current, controller.shownTab(current.spaceId)),
          ...result,
        });
      },
    },
  };
}
