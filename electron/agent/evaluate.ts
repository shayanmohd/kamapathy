import { ApiError, fail } from "./errors";
import { ContextLostError } from "./session/errors";
import type { TabSession } from "./session/tab-session";
import type { Step } from "./session/types";

// How long an agent's own source may be, per field.
export const SCRIPT_LIMIT = 16384;
// How much of an exception's text an error carries.
const DESCRIPTION_LIMIT = 4000;
// How much of it the message itself carries, before the envelope cuts it.
const HEAD_CHARS = 160;

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

// The one expression an evaluation sends. A function source is called with
// its argument, with the line separators JSON leaves raw escaped so the
// expression stays valid JavaScript.
function expressionFor(source: ScriptSource): {
  expression: string;
  wrapped: boolean;
} {
  if (source.expression !== undefined)
    return { expression: source.expression, wrapped: false };
  const arg =
    source.arg === undefined
      ? ""
      : JSON.stringify(source.arg)
          .replace(/\u2028/g, "\\u2028")
          .replace(/\u2029/g, "\\u2029");
  return { expression: `(${source.function})(${arg})`, wrapped: true };
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
function scriptError(details: ExceptionDetails, wrapped: boolean): ApiError {
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
    (details.columnNumber ?? 0) + 1 - (wrapped && line === 1 ? 1 : 0),
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

// One evaluation in the main frame's main world, so it reads the page's own
// globals. Section 8 adds repl mode, the execution limit and its probe,
// larger results and the frame choices on top of this.
export async function evaluateScript(
  session: TabSession,
  source: ScriptSource,
  step: Step & { timeoutMs: number },
): Promise<ScriptValue> {
  const { expression, wrapped } = expressionFor(source);
  let reply: EvaluateReply;
  try {
    reply = await session.send<EvaluateReply>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
        silent: true,
      },
      { ...step, mutates: true },
    );
  } catch (error) {
    throw asContextLost(error);
  }
  if (reply.exceptionDetails)
    throw scriptError(reply.exceptionDetails, wrapped);
  const result = reply.result;
  if (!result || result.type === "undefined") return {};
  if (result.unserializableValue !== undefined)
    return { unserializable: String(result.unserializableValue) };
  return { value: result.value };
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
