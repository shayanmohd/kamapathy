// Counts the native input every frame of an agent tab receives. It runs as
// an isolated init script, so the counters exist from a document's first
// frame and in out-of-process frames, where a lazily installed listener
// never reaches. The `input` page operation reads the same slots and keeps
// its own installation as a fallback for documents this missed. The move
// slot keeps where the last move landed, in its document's own pixels, for
// section 5's routing check; a pointer event's coordinates keep the
// fractions a mouse event's drop.
import type { TabSession } from "../session/tab-session";

export const COUNTER_SOURCE = `const world = globalThis;
const counts = (world.kamapathyInput ||= { mouse: 0, key: 0, drag: 0, move: 0 });
const listening = (world.kamapathyListening ||= new WeakSet());
if (!listening.has(document)) {
  listening.add(document);
  // Only trusted events count, since a page can dispatch its own. A press
  // counts by its pointerdown, which Chromium fires even where it fires no
  // mousedown: on a control that cancels its pointerdown or is disabled.
  addEventListener("pointerdown", (event) => { if (event.isTrusted) counts.mouse += 1; }, { capture: true });
  addEventListener("keydown", (event) => { if (event.isTrusted) counts.key += 1; }, { capture: true });
  // An HTML5 drag starts unless the page cancels dragstart, which its own
  // handlers decide after this listener runs.
  addEventListener("dragstart", (event) => {
    if (!event.isTrusted) return;
    setTimeout(() => { if (!event.defaultPrevented) counts.drag += 1; });
  }, { capture: true });
  addEventListener("pointermove", (event) => {
    if (!event.isTrusted) return;
    counts.move += 1;
    // A press while another button is held fires no pointerdown, only a
    // move whose button names it and whose buttons include it.
    const bit = [1, 4, 2][event.button];
    if (bit && event.buttons & bit) counts.mouse += 1;
    world.kamapathyLanding = { x: event.clientX, y: event.clientY, doc: document };
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
