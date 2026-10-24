// Counts the native input every frame of an agent tab receives. It runs as
// an isolated init script, so the counters exist from a document's first
// frame and in out-of-process frames, where a lazily installed listener
// never reaches. The `input` page operation reads the same two slots and
// keeps its own installation as a fallback for documents this missed.
import type { TabSession } from "../session/tab-session";

export const COUNTER_SOURCE = `const world = globalThis;
const counts = (world.kamapathyInput ||= { mouse: 0, key: 0, drag: 0 });
const listening = (world.kamapathyListening ||= new WeakSet());
if (!listening.has(document)) {
  listening.add(document);
  addEventListener("mousedown", () => { counts.mouse += 1; }, { capture: true });
  addEventListener("keydown", () => { counts.key += 1; }, { capture: true });
  // An HTML5 drag starts unless the page cancels dragstart, which its own
  // handlers decide after this listener runs.
  addEventListener("dragstart", (event) => {
    setTimeout(() => { if (!event.defaultPrevented) counts.drag += 1; });
  }, { capture: true });
}`;

export async function registerCounters(
  session: TabSession,
): Promise<() => void> {
  const id = await session.addInitScript(COUNTER_SOURCE, {
    world: "isolated",
  });
  return () => {
    void session.removeInitScript(id).catch(() => {});
  };
}
