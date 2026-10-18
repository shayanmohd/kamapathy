export type PageStateOperation = "info" | "loadProbe";

// This complete function is serialized into a separate Chromium world. It has no
// imports, Node APIs, or access to the browser interface's preload bridge. A
// document cannot see its own frame's load state, so the route adds `loading`.
export function pageState(operation: PageStateOperation) {
  if (operation === "info") {
    const root = document.documentElement;
    return {
      ok: true as const,
      viewport: {
        width: Math.round(innerWidth),
        height: Math.round(innerHeight),
      },
      scroll: { x: Math.round(scrollX), y: Math.round(scrollY) },
      document: {
        width: Math.round(root.scrollWidth),
        height: Math.round(root.scrollHeight),
      },
      readyState: document.readyState,
    };
  }
  // The timing entry tells a finished DOMContentLoaded apart from readyState
  // "interactive", which a blocking handler still holds. A document loaded
  // before tracking began may have no entry.
  const timing = performance.getEntriesByType("navigation");
  const entry = timing[0] as PerformanceNavigationTiming | undefined;
  return {
    ok: true as const,
    readyState: document.readyState,
    domContentLoaded: entry
      ? entry.domContentLoadedEventEnd > 0
      : document.readyState !== "loading",
    load: entry ? entry.loadEventEnd > 0 : document.readyState === "complete",
  };
}
