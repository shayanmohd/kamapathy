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
// Errors other than ApiError carry only the fallback message, so internal
// details never reach the agent.
export function errorBody(
  error: unknown,
  fallbackMessage: string,
): {
  status: number;
  error: { code: string; message: string; [field: string]: unknown };
} {
  if (error instanceof ApiError)
    return {
      status: error.status,
      error: { code: error.code, message: error.message, ...error.fields },
    };
  return {
    status: 500,
    error: { code: "operation_failed", message: fallbackMessage },
  };
}
