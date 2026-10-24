import { ApiError } from "./errors";
import type { AutomationController } from "./server";

// What an agent is told while the person keeps page scripts off.
export const SCRIPTS_OFF_MESSAGE =
  "Page scripts are off in Kamapathy's Settings, under Agents. Continue with snapshots and actions.";

// The setting is the only source of truth for this gate.
export function pageScriptsOn(controller: AutomationController): boolean {
  return controller.state.settings.agentPageScripts !== false;
}
// The refusal every script route, the function wait and the page tools share.
export function requirePageScripts(controller: AutomationController): void {
  if (pageScriptsOn(controller)) return;
  throw new ApiError("agent_scripts_off", SCRIPTS_OFF_MESSAGE);
}

// The server's side of the switch: what a call checks before it runs, what it
// waits on while it runs, and what the switch-off cleans up after it.
export interface PageScripts {
  readonly on: boolean;
  require(): void;
  /** Aborted with the agent_scripts_off ApiError when the switch goes off; a new signal once it is on again. */
  signal(): AbortSignal;
  /** Runs once per switch-off, after the signal aborts. Returns an unsubscribe. */
  onOff(hook: () => void): () => void;
  /** Idempotent: runs the effects only when the value changes. */
  apply(on: boolean): void;
  dispose(): void;
}

export function createPageScripts(
  controller: AutomationController,
): PageScripts {
  const hooks = new Set<() => void>();
  // The value the effects have already run for.
  let applied = pageScriptsOn(controller);
  let aborter = new AbortController();
  if (!applied)
    aborter.abort(new ApiError("agent_scripts_off", SCRIPTS_OFF_MESSAGE));
  const apply = (on: boolean) => {
    if (on === applied) return;
    applied = on;
    // Back on: the next call gets a signal of its own, and the one the
    // switch-off failed keeps its aborted one.
    if (on) {
      aborter = new AbortController();
      return;
    }
    aborter.abort(new ApiError("agent_scripts_off", SCRIPTS_OFF_MESSAGE));
    for (const hook of [...hooks])
      try {
        hook();
      } catch {
        // One hook that fails leaves the rest of the cleanup to run.
      }
  };
  // The person's choice reaches the effects even when nothing calls apply.
  const unsubscribe = controller.subscribe(() =>
    apply(pageScriptsOn(controller)),
  );
  return {
    get on() {
      return pageScriptsOn(controller);
    },
    require: () => requirePageScripts(controller),
    signal: () => aborter.signal,
    onOff(hook) {
      hooks.add(hook);
      return () => {
        hooks.delete(hook);
      };
    },
    apply,
    dispose() {
      unsubscribe();
      hooks.clear();
    },
  };
}
