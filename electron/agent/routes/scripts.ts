import { remaining } from "../actions";
import { fail } from "../errors";
import { evaluateScript, type ScriptStep } from "../evaluate";
import { send, type RouteDeps, type RouteImpl } from "../http";
import { evaluateFields } from "../validate";
import { tabView } from "../views";

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

// POST /tabs/:id/evaluate: the agent's own code in the page's main frame.
export function scriptRoutes(deps: RouteDeps): Record<string, RouteImpl> {
  const {
    controller,
    authority,
    actions: { readyContents },
    pageScripts,
  } = deps;
  const { authorizeTab } = authority;
  return {
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
