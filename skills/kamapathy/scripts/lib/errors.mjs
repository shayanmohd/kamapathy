// Errors the client raises or receives, and what a run says after the ones
// that stop it.
import { ERRORS, isTransient } from "../schema/errors.mjs";
import { line } from "./format.mjs";

const OWN = new Set(["name", "stack", "cause", "message", "code"]);

/** An API or client failure. `code` and `message` come from Kamapathy. */
export class KamapathyError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ status?: number, results?: object[], failedIndex?: number, [field: string]: unknown }} [details]
   * Every other field of the error body becomes a property of its own.
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "KamapathyError";
    /** @type {string} */
    this.code = code;
    /** @type {number | undefined} HTTP status of the failed request. */
    this.status = details.status;
    /** @type {object[] | undefined} Steps a failed batch completed before stopping. */
    this.results = details.results;
    /** @type {number | undefined} Zero-based index of the batch step that failed. */
    this.failedIndex = details.failedIndex;
    for (const [key, value] of Object.entries(details))
      if (!OWN.has(key) && !(key in this) && value !== undefined)
        this[key] = value;
    // Kamapathy says when its own errors can be retried; the client's own
    // codes take it from the registry.
    if (
      this.retryable === undefined &&
      ERRORS[code]?.status === null &&
      isTransient(code, details)
    )
      this.retryable = true;
  }
}

// Why an error stops a run for good, or null. Takeovers and handoffs, the
// person's Stop and agent access going off are the person's decisions.
export function hardStopCause(error) {
  if (
    error?.code === "human_control" &&
    [undefined, "manual", "handoff"].includes(error.reason)
  )
    return "control";
  if (error?.code === "space_ended" && error.endedBy === "person")
    return "stopped";
  if (
    error?.code === "automation_stopped" ||
    (error?.code === "not_connected" && error.reason === "access_off")
  )
    return "access";
  return null;
}

// A hold a script did not catch: only the person can answer it.
const heldBy = (error) =>
  error?.code === "human_control" &&
  ![undefined, "manual", "handoff", "failed"].includes(error.reason);

// What a run prints instead of its output after a hard stop, or the line
// after an uncaught hold's error; empty otherwise.
export function guidance(error, { maxMessage = 300 } = {}) {
  switch (hardStopCause(error)) {
    case "control":
      return [
        "Kamapathy stopped this run: the person has control of the space.",
        line(error.message).slice(0, maxMessage),
        "Output from this run was withheld. Stop here, do not retry or work around it, and continue only when the person asks.",
      ].join("\n");
    case "stopped":
      return [
        "Kamapathy stopped this run: the person stopped the agent in this space.",
        "Output from this run was withheld. Stop here and tell the person; only they can let an agent use it again.",
      ].join("\n");
    case "access":
      return [
        "Kamapathy stopped this run: agent access is turned off.",
        "Output from this run was withheld. Stop here and tell the person. Only they can turn agent access on, in Settings under Agents.",
      ].join("\n");
  }
  if (heldBy(error))
    return `Tell the person what is waiting for their answer in Kamapathy, then run kamapathy wait-for-control ${line(error.spaceId)} and start a new run when it returns.`;
  return "";
}
