import {
  ERRORS,
  isTransient,
} from "../../skills/kamapathy/scripts/schema/index.mjs";
import {
  CaptureFailedError,
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

// A code's status comes from the schema's registry, so each code has one.
// wait_timeout answers 408 on the legacy wait route and its batch step.
export function statusFor(
  code: string,
  context: { route?: string; action?: string } = {},
): number {
  const spec = ERRORS[code];
  if (
    spec?.override &&
    (context.route === spec.override.route ||
      context.action === spec.override.action)
  )
    return spec.override.status;
  return spec?.status ?? 500;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: string,
    message: string,
    readonly fields: Record<string, unknown> = {},
  ) {
    super(message);
    this.status = statusFor(code);
  }
}
export const fail = (
  code: string,
  message: string,
  fields?: Record<string, unknown>,
): never => {
  throw new ApiError(code, message, fields);
};
// What a tab session's error means to the agent. Other errors have no
// meaning of their own and stay unknown.
export function toApiError(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  if (error instanceof DialogOpenError) {
    const { type, message, defaultValue } = error.dialog;
    return new ApiError(
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
      "page_changed",
      "The page navigated during this operation. Inspect the new page before continuing.",
    );
  if (error instanceof PageCrashedError)
    return new ApiError(
      "page_crashed",
      "The page process stopped. Navigate the tab to load it again before continuing.",
    );
  if (error instanceof CdpTimeoutError)
    return new ApiError(
      "page_timeout",
      "The page did not respond in time.",
      error.timeoutMs === undefined
        ? { awaited: error.awaited }
        : { awaited: error.awaited, timeoutMs: error.timeoutMs },
    );
  if (error instanceof TargetRefusedError)
    return new ApiError(
      "cdp_method_blocked",
      "This protocol command is limited to this tab's own page and frames.",
      { method: error.method, reason: "scope" },
    );
  if (error instanceof TabClosedError)
    return new ApiError("tab_closed", "The tab was closed.");
  if (error instanceof CaptureFailedError)
    return new ApiError(
      "screenshot_failed",
      "The page could not render a screenshot. Read a snapshot or try again after the page finishes rendering.",
    );
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

// C0, C1 and bidirectional controls, which never reach an agent's terminal.
const CONTROLS =
  /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
const clean = (message: string) => message.replace(CONTROLS, "").slice(0, 300);

// The body of every error response. retryable and dispatched are set here
// and nowhere else: an error is retryable when its code's rule calls it
// transient and nothing reached the page.
export function envelope(
  error: unknown,
  dispatched: boolean,
  context: { route?: string; action?: string; fallback?: string } = {},
): {
  status: number;
  error: {
    code: string;
    message: string;
    retryable?: true;
    dispatched?: true;
    [field: string]: unknown;
  };
} {
  const flags = dispatched ? { dispatched: true as const } : {};
  const known = toApiError(error);
  if (!known)
    return {
      status: 500,
      error: {
        code: "operation_failed",
        message: clean(
          context.fallback ??
            "The browser could not complete this operation. Retry after the page finishes loading.",
        ),
        ...flags,
      },
    };
  const {
    retryable: _retryable,
    dispatched: _dispatched,
    ...fields
  } = known.fields;
  return {
    status: statusFor(known.code, context),
    error: {
      code: known.code,
      message: clean(known.message),
      ...fields,
      ...(!dispatched && isTransient(known.code, known.fields)
        ? { retryable: true as const }
        : {}),
      ...flags,
    },
  };
}
