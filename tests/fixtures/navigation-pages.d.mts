import type { IncomingMessage } from "node:http";

export const navigationPages: Record<string, string>;
export const NAVIGATION_PATHS: Record<string, string>;
export const SLOW_LOAD_MS: number;
export const POLL_MS: number;
export const navigationLog: {
  referers: string[];
  scriptFetches: number;
  posts: number;
  served: { path: string; at: number }[];
};
export function navigationRoute(
  request: IncomingMessage,
  url: URL,
  respond: (
    status: number,
    headers: Record<string, string>,
    body?: string | Buffer,
  ) => void,
): boolean;
