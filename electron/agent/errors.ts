import {
  CdpTimeoutError,
  ContextLostError,
  DialogOpenError,
  FrameBlockedError,
  FrameGoneError,
  PageCrashedError,
  SessionLostError,
  TabClosedError,
  TargetRefusedError,
} from "./session/errors";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export const fail = (
  status: number,
  code: string,
  message: string,
  fields?: Record<string, unknown>,
): never => {
  throw new ApiError(status, code, message, fields);
};
// What a tab session's error means to the agent. Other errors have no
// meaning of their own and stay unknown.
export function toApiError(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  if (error instanceof DialogOpenError) {
    const { type, message, defaultValue } = error.dialog;
    return new ApiError(
      409,
      "dialog_open",
      `A JavaScript ${type} is still open on this page. Hand off to the person to close it, then inspect the page.`,
      {
        dialog: {
          type,
          message,
          ...(defaultValue === undefined ? {} : { defaultValue }),
        },
        started: error.started,
      },
    );
  }
  if (error instanceof SessionLostError)
    return new ApiError(
      409,
      "debugger_busy",
      error.reason === "devtools"
        ? "Developer tools on this tab block agent access. Ask the person to close them."
        : "Kamapathy lost its connection to this tab. Try again shortly.",
      { reason: error.reason },
    );
  if (
    error instanceof ContextLostError ||
    error instanceof FrameGoneError ||
    error instanceof FrameBlockedError
  )
    return new ApiError(
      409,
      "page_changed",
      "The page navigated during this operation. Inspect the new page before continuing.",
    );
  if (error instanceof PageCrashedError)
    return new ApiError(
      409,
      "page_crashed",
      "The page process stopped. Navigate the tab to load it again before continuing.",
    );
  if (error instanceof CdpTimeoutError)
    return new ApiError(
      504,
      "page_timeout",
      "The page did not respond in time.",
      { awaited: error.awaited },
    );
  if (error instanceof TargetRefusedError)
    return new ApiError(
      403,
      "cdp_method_blocked",
      "This protocol command is limited to this tab's own page and frames.",
      { method: error.method, reason: "scope" },
    );
  if (error instanceof TabClosedError)
    return new ApiError(409, "tab_closed", "The tab was closed.");
  return undefined;
}

export function errorBody(
  error: unknown,
  fallbackMessage: string,
): {
  status: number;
  error: { code: string; message: string; [field: string]: unknown };
} {
  const known = toApiError(error);
  if (!known)
    return {
      status: 500,
      error: { code: "operation_failed", message: fallbackMessage },
    };
  return {
    status: known.status,
    error: { code: known.code, message: known.message, ...known.fields },
  };
}
