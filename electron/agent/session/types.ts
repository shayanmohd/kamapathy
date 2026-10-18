import type { WebContents } from "electron";

export type SessionState =
  | "attaching"
  | "ready"
  | "devtools"
  | "unavailable"
  | "crashed"
  | "released";
export type CdpEvent = {
  method: string;
  params: any;
  sessionId?: string;
  at: number;
};
export type TooLarge = {
  method: string;
  at: number;
  sessionId?: string;
  omitted: "too_large";
  bytes: number;
};
export type Gap = {
  reason: "human_control" | "page_scripts_off" | "debugger_detached";
  from: number;
  to: number;
};
export interface Step {
  deadline: number;
  signal?: AbortSignal;
  guard?: () => void;
  // Set once anything that can change the page has been sent.
  dispatch?: { dispatched: boolean };
}
export type SendStep = Step & {
  sessionId?: string;
  mutates?: true;
  timeoutMs?: number;
};
export interface FrameInfo {
  frameId: string;
  parentFrameId?: string;
  url: string;
  origin: string;
  sessionId?: string;
  crossOrigin: boolean;
  path: string;
  loaderId: string;
  lifecycle: "unknown" | "commit" | "domcontentloaded" | "load";
  unavailable?: true;
  blocked?: true;
}
// A frame as the registry holds it, for callers that read each frame
// themselves instead of the index paths frames() works out.
export interface KnownFrame {
  frameId: string;
  parentFrameId?: string;
  origin: string;
  sessionId?: string;
  crossOrigin: boolean;
  blocked: boolean;
  unavailable: boolean;
}
export interface DialogInfo {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue?: string;
  frameId?: string;
  sessionId?: string;
}
export type SessionHost = Pick<
  WebContents,
  | "debugger"
  | "getURL"
  | "isDestroyed"
  | "isDevToolsOpened"
  | "on"
  | "once"
  | "removeListener"
>;
export type SetupHook = (sessionId?: string) => Promise<void>;
