import type { CdpEvent } from "./types";

export type LifecycleState = "unknown" | "commit" | "domcontentloaded" | "load";

const ORDER: Record<LifecycleState, number> = {
  unknown: 0,
  commit: 1,
  domcontentloaded: 2,
  load: 3,
};
// Turning lifecycle events on replays each document's events so far, and
// names its commit "commit" there rather than "init".
const NAMES = new Map<string, LifecycleState>([
  ["init", "commit"],
  ["commit", "commit"],
  ["DOMContentLoaded", "domcontentloaded"],
  ["load", "load"],
]);
const READY_STATES: Record<
  "loading" | "interactive" | "complete",
  LifecycleState
> = {
  loading: "commit",
  interactive: "domcontentloaded",
  complete: "load",
};

export const reached = (state: LifecycleState, wanted: LifecycleState) =>
  ORDER[state] >= ORDER[wanted];

// How far each frame's documents have loaded, by frameId and loaderId.
export class LifecycleTracker {
  private frames = new Map<string, Map<string, LifecycleState>>();

  apply(
    event: CdpEvent,
  ): { frameId: string; loaderId: string; state: LifecycleState } | undefined {
    const { params } = event;
    if (event.method === "Page.lifecycleEvent") {
      const state = NAMES.get(params.name);
      return state && this.advance(params.frameId, params.loaderId, state);
    }
    if (event.method === "Page.frameNavigated")
      // A document back from the back-forward cache loaded long ago.
      return this.advance(
        params.frame.id,
        params.frame.loaderId,
        params.type === "BackForwardCacheRestore" ? "load" : "commit",
      );
    return undefined;
  }

  state(frameId: string, loaderId: string): LifecycleState {
    return this.frames.get(frameId)?.get(loaderId) ?? "unknown";
  }

  settle(
    frameId: string,
    loaderId: string,
    readyState: "loading" | "interactive" | "complete",
  ): void {
    this.advance(frameId, loaderId, READY_STATES[readyState]);
  }

  forget(frameId: string): void {
    this.frames.delete(frameId);
  }

  clear(): void {
    this.frames.clear();
  }

  // States only move forward within a document. A frame keeps its last two
  // documents, so a wait can still name the one just replaced.
  private advance(frameId: string, loaderId: string, state: LifecycleState) {
    const documents =
      this.frames.get(frameId) ?? new Map<string, LifecycleState>();
    this.frames.set(frameId, documents);
    const known = documents.get(loaderId);
    if (known && reached(known, state)) return undefined;
    if (!known)
      for (const older of [...documents.keys()].slice(0, -1))
        documents.delete(older);
    documents.set(loaderId, state);
    return { frameId, loaderId, state };
  }
}
