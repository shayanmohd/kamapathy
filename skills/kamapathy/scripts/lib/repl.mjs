// kamapathy repl: the run globals over one lazy connection, with Ctrl+C
// stopping the calls of the entry in progress.
import repl from "node:repl";
import { inspect } from "node:util";
import { describeError } from "../diagnostics.mjs";
import { KamapathyError } from "./errors.mjs";
import { line, printable } from "./format.mjs";
import { loadHelperModule } from "./helper-module.mjs";
import { takeNotices } from "./request.mjs";
import { installGlobals } from "./run.mjs";

const INTERRUPTED =
  "The entry was stopped by Ctrl+C. A call in progress may still have taken effect, so inspect the page before retrying.";

// Node's REPL hands failed entries to the writer as well as results.
function writer(value) {
  if (!(value instanceof Error)) return inspect(value);
  if (value.code === "ERR_SCRIPT_EXECUTION_INTERRUPTED")
    return `error: interrupted: ${INTERRUPTED}`;
  return describeError(value).join("\n");
}

// Resolves 0 when the person types .exit or presses Ctrl+D, and 1 when the
// workspace helpers.mjs cannot be loaded.
export async function startRepl({
  input,
  output,
  session,
  client,
  terminal,
  env,
}) {
  installGlobals(globalThis, client);
  // The person's own helpers before the prompt, so the session starts with
  // them or not at all.
  try {
    await loadHelperModule(env?.KAMAPATHY_WORKSPACE, globalThis);
  } catch (error) {
    if (!(error instanceof KamapathyError)) throw error;
    output.write(`error: ${error.code}: ${printable(error.message)}\n`);
    return 1;
  }
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
