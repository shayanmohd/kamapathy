import type { IncomingMessage, ServerResponse } from "node:http";

export const scriptPages: Record<string, string>;
export const scriptPageHeaders: Record<string, Record<string, string>>;
export const SCRIPT_BINARY: Buffer;
export const SCRIPT_BINARY_SHA256: string;
export const WORKER_BODY: string;
export const NETWORK_BODY: string;
export function serveScriptEndpoint(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  events?: Record<string, unknown>[],
): boolean;
