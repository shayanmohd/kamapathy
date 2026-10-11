// kamapathy repl: the run globals over one lazy connection, with Ctrl+C
// stopping the calls of the entry in progress.
import repl from "node:repl";
import { inspect } from "node:util";
import { KamapathyError } from "./errors.mjs";
import { line, printable } from "./format.mjs";
import { takeNotices } from "./request.mjs";
import { installGlobals } from "./run.mjs";

const INTERRUPTED =
  "The entry was stopped by Ctrl+C. A call in progress may still have taken effect, so inspect the page before retrying.";

// Node's REPL hands failed entries to the writer as well as results.
function writer(value) {
  if (!(value instanceof Error)) return inspect(value);
  if (value.code === "ERR_SCRIPT_EXECUTION_INTERRUPTED")
    return `error: interrupted: ${INTERRUPTED}`;
  const code = typeof value.code === "string" ? `${value.code}: ` : "";
  return `error: ${code}${printable(value.message)}`;
}

// Resolves 0 when the person types .exit or presses Ctrl+D.
export function startRepl({ input, output, session, client, terminal }) {
  installGlobals(globalThis, client);
  output.write(
    "Kamapathy scripting session. Type help() for the API and .exit to leave.\n",
  );
  // breakEvalOnSigint lets Ctrl+C reach the SIGINT event while an entry
  // awaits; it rules out a custom eval.
  const server = repl.start({
    input,
    output,
    terminal,
    prompt: "kamapathy> ",
    useGlobal: true,
    ignoreUndefined: true,
    breakEvalOnSigint: true,
    writer,
  });
  server.on("SIGINT", () => {
    session.abort(
      new KamapathyError("interrupted", INTERRUPTED, { signal: "SIGINT" }),
    );
    session.rearm();
  });
  // Queued notices print once each, before the next prompt.
  const prompt = server.displayPrompt.bind(server);
  server.displayPrompt = (...args) => {
    for (const text of takeNotices()) output.write(`notice: ${line(text)}\n`);
    return prompt(...args);
  };
  return new Promise((done) => server.once("exit", () => done(0)));
}
