import { ApiError, fail } from "./errors";
import { CdpTimeoutError, ContextLostError } from "./session/errors";
import type { TabSession } from "./session/tab-session";
import type { SendStep, Step } from "./session/types";

// How long an agent's own source may be, per field.
export const SCRIPT_LIMIT = 16384;
// How large a result the route returns.
export const RESULT_LIMIT = 16 * 1024 * 1024;
// How much of the timeout the page keeps for itself, so Kamapathy hears
// about its own limit before the transport one expires.
export const EXECUTION_MARGIN_MS = 1000;
// How much of an exception's text an error carries.
const DESCRIPTION_LIMIT = 4000;
// How much of it the message itself carries, before the envelope cuts it.
const HEAD_CHARS = 160;
// What names the agent's script wherever the page reports it.
const SOURCE_URL = "\n//# sourceURL=kamapathy-evaluate.js";
// What a probe allows the page, and what the transport allows each of its
// two tries: together the margin the page has to report its own limit.
const PROBE_EXECUTION_MS = 200;
const PROBE_TRANSPORT_MS = EXECUTION_MARGIN_MS / 2;
// How long a termination may take before the page counts as silent.
const TERMINATE_MS = 1000;
// How long before the execution limit is due an internal error still counts
// as that limit.
const LIMIT_WINDOW_MS = 100;

// An agent's page script: an expression, or a function source called with
// one JSON argument.
export interface ScriptSource {
  expression?: string;
  function?: string;
  arg?: unknown;
}
// What one evaluation made: a value the protocol sent by value, the text of
// one it could not, or nothing for a result of undefined.
export type ScriptValue =
  { value: unknown } | { unserializable: string } | Record<string, never>;

// The page script fields of a body, with exactly one source.
export function scriptFields(body: Record<string, unknown>): ScriptSource {
  const hasExpression = body.expression !== undefined;
  const hasFunction = body.function !== undefined;
  if (hasExpression && hasFunction)
    return fail("invalid_field", "Give expression or function, not both.", {
      field: "function",
    });
  if (!hasExpression && !hasFunction)
    return fail(
      "invalid_field",
      "Give expression, or function with the source of a function to call.",
      { field: "expression" },
    );
  const name = hasExpression ? "expression" : "function";
  const source = body[name];
  if (
    typeof source !== "string" ||
    !source.trim() ||
    source.length > SCRIPT_LIMIT
  )
    return fail(
      "invalid_field",
      `${name} must be a nonempty string of at most ${SCRIPT_LIMIT} characters.`,
      { field: name },
    );
  if (hasExpression) {
    // An expression takes no argument, so an arg beside one is a mistake the
    // page would never see.
    if (body.arg !== undefined)
      return fail(
        "invalid_field",
        "arg goes with function. An expression runs as written and takes no argument.",
        { field: "arg" },
      );
    return { expression: source };
  }
  return {
    function: source,
    ...(body.arg === undefined ? {} : { arg: body.arg }),
  };
}

// Page scripts are the person's setting. Section 8's gate owns the reading,
// and this name is the one the waits and the routes already call.
export { requirePageScripts as requireScripts } from "./page-scripts";

// The one expression an evaluation sends, and how far its first line moved.
// A function source is called with its argument, with the line separators
// JSON leaves raw escaped so the expression stays valid JavaScript. The
// comment names the script wherever the page reports it.
export function wrapSource(source: ScriptSource): {
  expression: string;
  columnShift: number;
} {
  if (source.expression !== undefined)
    return { expression: `${source.expression}${SOURCE_URL}`, columnShift: 0 };
  const arg =
    source.arg === undefined
      ? ""
      : JSON.stringify(source.arg)
          .replace(/\u2028/g, "\\u2028")
          .replace(/\u2029/g, "\\u2029");
  return {
    expression: `(${source.function})(${arg})${SOURCE_URL}`,
    columnShift: 1,
  };
}

interface ExceptionDetails {
  text?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: { className?: string; description?: string };
}
interface EvaluateReply {
  result?: {
    type?: string;
    value?: unknown;
    unserializableValue?: string;
  };
  exceptionDetails?: ExceptionDetails;
}

// What the page threw, at the place in the agent's own source.
function scriptError(details: ExceptionDetails, columnShift: number): ApiError {
  const description = (
    details.exception?.description ??
    details.text ??
    "The page function failed."
  ).slice(0, DESCRIPTION_LIMIT);
  const name =
    details.exception?.className ??
    /\b([A-Z]\w*Error)\b/.exec(description)?.[1] ??
    "Error";
  const line = (details.lineNumber ?? 0) + 1;
  // A function source is sent inside parentheses, so its first line sits one
  // character to the right of what the agent wrote.
  const column = Math.max(
    1,
    (details.columnNumber ?? 0) + 1 - (line === 1 ? columnShift : 0),
  );
  return new ApiError(
    "script_error",
    `The page function failed at line ${line}, column ${column}: ${description.split("\n")[0].slice(0, HEAD_CHARS)}`,
    { name, line, column, description },
  );
}
// A navigation during the call ends the context. The session maps these
// messages only for its own worlds, and this evaluation uses none.
const LOST_STARTED =
  /Execution context was destroyed|Inspected target navigated or closed/;
const asContextLost = (error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  if (/Cannot find context with specified id/.test(message))
    return new ContextLostError(false);
  if (LOST_STARTED.test(message)) return new ContextLostError(true);
  return error;
};

// One evaluation's step: how long the transport waits, how long the page may
// run before Chromium stops it, and the world it runs in. Without a world it
// is the main frame's main world, so it reads the page's own globals.
export interface ScriptStep extends Step {
  timeoutMs: number;
  /** Sent as Runtime.evaluate's own timeout; without one the page keeps running. */
  executionMs?: number;
  contextId?: number;
  sessionId?: string;
  replMode?: boolean;
  silent?: boolean;
}

// What one evaluation made, or the failure it was. A value larger than the
// route returns is a failure of its own, so nothing of it is sent.
export function decodeResult(
  reply: EvaluateReply,
  columnShift: number,
): ScriptValue {
  if (reply.exceptionDetails)
    throw scriptError(reply.exceptionDetails, columnShift);
  const result = reply.result;
  if (!result || result.type === "undefined") return {};
  if (result.unserializableValue !== undefined)
    return { unserializable: String(result.unserializableValue) };
  const encoded = JSON.stringify(result.value);
  const bytes = encoded === undefined ? 0 : Buffer.byteLength(encoded);
  if (bytes > RESULT_LIMIT)
    return fail(
      "result_too_large",
      `The result is ${bytes} bytes, over the ${RESULT_LIMIT} this route returns. Return less of it, or read it in parts.`,
      { bytes, limit: RESULT_LIMIT },
    );
  return { value: result.value };
}

// One Runtime.evaluate: the main frame's main world unless the step names a
// frame world.
export async function evaluateOnce(
  session: TabSession,
  source: ScriptSource,
  step: ScriptStep,
): Promise<ScriptValue> {
  const { expression, columnShift } = wrapSource(source);
  let reply: EvaluateReply;
  try {
    reply = await session.send<EvaluateReply>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: false,
        silent: step.silent ?? false,
        // Repl mode is the expression form's: top-level await works and a
        // declaration may repeat. A called function needs neither.
        ...(step.replMode && source.expression !== undefined
          ? { replMode: true }
          : {}),
        ...(step.contextId === undefined ? {} : { contextId: step.contextId }),
        ...(step.executionMs === undefined
          ? {}
          : { timeout: step.executionMs }),
      },
      { ...step, mutates: true },
    );
  } catch (error) {
    throw asContextLost(error);
  }
  return decodeResult(reply, columnShift);
}

export interface Recovery {
  executionStopped: boolean;
  pageResponsive: boolean;
}

// The trivial question that needs the page's main thread, which a running
// script holds.
const ask = (session: TabSession, step: SendStep) =>
  session.send(
    "Runtime.evaluate",
    { expression: "1", returnByValue: true, timeout: PROBE_EXECUTION_MS },
    step,
  );

// Whether the page still answers. A probe gets 200 ms of execution and
// 500 ms of transport, and one more try on its own limit.
export async function probePage(
  session: TabSession,
  step: Step,
): Promise<boolean> {
  const once = () =>
    ask(session, {
      deadline: Date.now() + PROBE_TRANSPORT_MS,
      timeoutMs: PROBE_TRANSPORT_MS,
      signal: step.signal,
    }).then(
      () => true,
      () => false,
    );
  return (await once()) || (await once());
}

// The three outcomes of a limit, shared with the function wait and with
// cdp_timeout. Chromium's own limit says both answers at once; a transport
// limit asks the page, then stops it and asks again. Chromium sends a busy
// script's limit answer before it answers a probe queued behind it, so once
// the page answers, stoppedLate says whether that answer came.
export async function recoverFromTimeout(
  session: TabSession,
  step: Step,
  hitExecutionLimit: boolean,
  stoppedLate: () => boolean = () => false,
): Promise<Recovery> {
  if (hitExecutionLimit)
    return { executionStopped: true, pageResponsive: true };
  if (await probePage(session, step))
    return { executionStopped: stoppedLate(), pageResponsive: true };
  await session
    .send(
      "Runtime.terminateExecution",
      {},
      {
        deadline: Date.now() + TERMINATE_MS,
        timeoutMs: TERMINATE_MS,
        signal: step.signal,
      },
    )
    .catch(() => {});
  if (await probePage(session, step))
    return { executionStopped: true, pageResponsive: true };
  return { executionStopped: false, pageResponsive: false };
}

export function evaluationTimeout(
  timeoutMs: number,
  recovery: Recovery,
): ApiError {
  const outcome = !recovery.pageResponsive
    ? "The page stopped answering. Reload or close the page before continuing."
    : recovery.executionStopped
      ? "Kamapathy stopped it, and the page answers again."
      : "It may still be running, and the page answers.";
  return new ApiError(
    "evaluation_timeout",
    `The page script did not finish within ${timeoutMs} ms. ${outcome} Anything it already changed stays.`,
    {
      awaited: "script",
      timeoutMs,
      executionStopped: recovery.executionStopped,
      // Work the script started may land after the answer, whatever the page
      // says now.
      mayHaveLateEffects: true,
      pageResponsive: recovery.pageResponsive,
    },
  );
}
// Chromium names a termination when it knows one. Its own execution limit
// arrives as an internal error, as do a value it cannot return and a
// termination from elsewhere, and a loaded machine delivers it late, even
// after the transport limit. So an internal error is that limit once the
// limit is due, unless the page answered the question asked at the limit
// first.
const STOPPED = /terminat|timed out|timeout/i;
const INTERNAL = /internal error/i;
function hitExecutionLimit(
  error: unknown,
  limitAt: number,
  answeredFirst: boolean,
): boolean {
  // A failure with a meaning of its own, such as a page exception, is not
  // the limit however it reads.
  if (error instanceof ApiError || !(error instanceof Error)) return false;
  if (STOPPED.test(error.message)) return true;
  return (
    INTERNAL.test(error.message) &&
    !answeredFirst &&
    Date.now() >= limitAt - LIMIT_WINDOW_MS
  );
}

// One evaluation with its limits: the page keeps the timeout less the
// margin, the transport the whole of it, and either limit ends as
// evaluation_timeout with what the recovery found. What the route calls.
export async function evaluateScript(
  session: TabSession,
  source: ScriptSource,
  step: ScriptStep,
): Promise<ScriptValue> {
  const executionMs = Math.max(1, step.timeoutMs - EXECUTION_MARGIN_MS);
  const limitAt = Date.now() + executionMs;
  // When the script has not answered by its own limit, Kamapathy asks the
  // page the trivial question. Chromium answers one session's commands in
  // order, and the limit covers only the script's own run, so a page that
  // answers the question first was waiting on a promise the script
  // returned. Both answers can land in one task, where their callbacks run
  // in either order, so the page's answer counts from the task after it.
  let answered = false;
  const question = setTimeout(() => {
    ask(session, {
      deadline: step.deadline,
      signal: step.signal,
      guard: step.guard,
    }).then(
      () => setTimeout(() => (answered = true)),
      () => {},
    );
  }, executionMs);
  try {
    return await evaluateOnce(session, source, { ...step, executionMs });
  } catch (error) {
    const execution = hitExecutionLimit(error, limitAt, answered);
    if (!execution && !(error instanceof CdpTimeoutError)) throw error;
    // The script's answer can still come after the call's own limit. A
    // handler on Chromium's reply itself runs before any answer that came
    // after it has passed through the session.
    let stoppedLate = false;
    if (error instanceof CdpTimeoutError)
      error.late?.catch((late: unknown) => {
        stoppedLate = hitExecutionLimit(late, limitAt, answered);
      });
    throw evaluationTimeout(
      step.timeoutMs,
      await recoverFromTimeout(session, step, execution, () => stoppedLate),
    );
  } finally {
    clearTimeout(question);
  }
}

// The unserializable values that are not conditions.
const FALSY = new Set(["NaN", "-0", "0n"]);
// Whether a result ends a wait. A value the protocol could not send arrives
// as text, so its truth comes from what that text says it was.
export function isTruthy(result: ScriptValue): boolean {
  const unserializable = (result as { unserializable?: string }).unserializable;
  if (unserializable !== undefined) return !FALSY.has(unserializable);
  return !!(result as { value?: unknown }).value;
}
