import type { DialogInfo } from "./types";

export class DialogOpenError extends Error {
  constructor(
    readonly dialog: DialogInfo,
    readonly started: boolean,
  ) {
    super(`A JavaScript ${dialog.type} is open on this page.`);
  }
}
export class SessionLostError extends Error {
  constructor(readonly reason: "devtools" | "unavailable") {
    super(
      reason === "devtools"
        ? "Developer tools hold this tab's debugger session."
        : "The tab's debugger session is unavailable.",
    );
  }
}
export class ContextLostError extends Error {
  constructor(readonly started: boolean) {
    super("The page context was destroyed.");
  }
}
export class FrameGoneError extends Error {
  constructor(readonly frameId: string) {
    super("The frame is gone.");
  }
}
export class FrameBlockedError extends Error {
  constructor(readonly frameId: string) {
    super("The frame is blocked.");
  }
}
export class PageCrashedError extends Error {
  constructor() {
    super("The page process stopped.");
  }
}
export class CdpTimeoutError extends Error {
  constructor(
    readonly awaited: "page" | "load",
    readonly timeoutMs?: number,
  ) {
    super("The page did not respond in time.");
  }
}
export class TargetRefusedError extends Error {
  constructor(readonly method: string) {
    super(`${method} is outside this tab's session.`);
  }
}
export class TabClosedError extends Error {
  constructor() {
    super("The tab was closed.");
  }
}
