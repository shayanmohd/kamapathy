// The agent cursor's page. It has no preload, no IPC and no network: the
// main process calls the one function below with already cleaned text.

/** What the main process asks the cursor to draw. */
export interface CursorUpdate {
  label: string;
  press: boolean;
  flipX: boolean;
  flipY: boolean;
}
/** What the drawing measures out to, read back by the main process. */
export interface CursorMetrics {
  width: number;
  height: number;
  reducedMotion: boolean;
}
declare global {
  interface Window {
    kamapathyCursor(update: CursorUpdate): CursorMetrics;
  }
}

// The arrow alone, and where the pill sits beside it. The main process keeps
// the same numbers for its placement.
const SIZE = 44;
const PILL = { x: 30, y: 30, height: 24 };

const pill = document.getElementById("pill")!;

window.kamapathyCursor = (update) => {
  const label = typeof update?.label === "string" ? update.label : "";
  pill.textContent = label;
  const classes = document.body.classList;
  classes.toggle("label", label !== "");
  classes.toggle("press", update?.press === true);
  classes.toggle("flip-x", update?.flipX === true);
  classes.toggle("flip-y", update?.flipY === true);
  const width = label ? pill.getBoundingClientRect().width : 0;
  return {
    width: Math.max(SIZE, Math.ceil(PILL.x + width)),
    height: Math.max(SIZE, label ? PILL.y + PILL.height : 0),
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
};
