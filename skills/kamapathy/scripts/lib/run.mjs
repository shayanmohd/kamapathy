// kamapathy run: a script with a lazy client as its globals. Its output is
// held until it ends, a deadline and signals bound it, and the person's
// decisions stop it for good.
import { randomBytes } from "node:crypto";
import { rmSync, writeSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connect } from "../api.mjs";
import { guidance, hardStopCause, KamapathyError } from "./errors.mjs";
import { line, printable } from "./format.mjs";
import { readInput, required } from "./input.mjs";
import { Session, takeNotices } from "./request.mjs";
import { exists } from "./transport.mjs";

const HELD_BYTES = 4 * 1024 * 1024;
const STALLED_MS = 5000;
const SIGNALS = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
  ...(process.platform === "win32" ? { SIGBREAK: 21 } : {}),
};
const PENDING =
  "error: The script stopped with work still pending. Await every call.\n";
const GLOBALS = [
  "kamapathy",
  "createSpace",
  "openSpace",
  "space",
  "spaces",
  "requestSpace",
];

function deadline(value, name) {
  if (
    !/^\d+$/.test(value ?? "") ||
    Number(value) < 1000 ||
    Number(value) > 3600000
  )
    throw new Error(
      `${name} must be an integer from 1000 to 3600000 milliseconds.`,
    );
  return Number(value);
}

// Options come before the source and are checked before stdin is read or
// Kamapathy is reached.
export function parseRunOptions(args, env = process.env) {
  let timeoutMs;
  let index = 0;
  for (; index < args.length && args[index].startsWith("--"); index++) {
    if (args[index] !== "--timeout")
      throw new Error(
        `Unknown run option: ${args[index]}. Run help for usage.`,
      );
    timeoutMs = deadline(args[++index], "--timeout");
  }
  const [first, second] = args.slice(index);
  const source =
    first === "-e"
      ? { kind: "eval", value: required(second, "script code") }
      : first === "-"
        ? { kind: "stdin" }
        : { kind: "file", value: required(first, "script file") };
  timeoutMs ??=
    env.KAMAPATHY_RUN_TIMEOUT_MS === undefined
      ? 300000
      : deadline(env.KAMAPATHY_RUN_TIMEOUT_MS, "KAMAPATHY_RUN_TIMEOUT_MS");
  return { timeoutMs, source, ts: false, envFiles: [] };
}

// The script's globals, each forwarding to the client method of its name.
export function installGlobals(target, client) {
  for (const name of GLOBALS)
    Object.defineProperty(target, name, {
      value: name === "kamapathy" ? client : (...args) => client[name](...args),
      writable: true,
      configurable: true,
      enumerable: false,
    });
}

// The hooks client modules registered, in order and once, within capMs.
// Their errors print nothing and change nothing.
export async function runEndStep(session, { capMs = 5000 } = {}) {
  if (session.hardStop) return;
  session.endStep = true;
  const signal = AbortSignal.any([session.signal, AbortSignal.timeout(capMs)]);
  const capped = new Promise((done) =>
    signal.addEventListener("abort", done, { once: true }),
  );
  const hooks = (async () => {
    for (const hook of session.endHooks) {
      if (signal.aborted) return;
      try {
        await hook({ touched: [...session.touched], signal });
      } catch {}
    }
  })();
  try {
    await Promise.race([hooks, capped]);
  } finally {
    session.endStep = false;
  }
}

// Holds every write to stdout and stderr in order, up to 4 MiB. Writes
// straight to a descriptor are not held.
function capture() {
  const held = { entries: [], bytes: 0, dropped: 0 };
  const original = { 1: process.stdout.write, 2: process.stderr.write };
  const hold = (fd, text) => {
    const bytes = Buffer.byteLength(text);
    if (held.bytes + bytes > HELD_BYTES) held.dropped += bytes;
    else {
      held.bytes += bytes;
      held.entries.push({ fd, text });
    }
  };
  const patch = (fd) =>
    function write(chunk, encoding, callback) {
      if (typeof encoding === "function") callback = encoding;
      hold(
        fd,
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(),
      );
      if (typeof callback === "function") queueMicrotask(() => callback());
      return true;
    };
  process.stdout.write = patch(1);
  process.stderr.write = patch(2);
  return {
    held,
    hold,
    restore() {
      process.stdout.write = original[1];
      process.stderr.write = original[2];
    },
  };
}

// Today's line for an error that ends a run, then, for a hold only the
// person can answer, what to do next.
function errorText(error) {
  const code = typeof error?.code === "string" ? `${error.code}: ` : "";
  const message = error instanceof Error ? error.message : String(error);
  const next = hardStopCause(error) ? "" : guidance(error);
  return `error: ${code}${printable(message)}\n${next ? `${next}\n` : ""}`;
}

// Everything at exit, waiting out a slow reader but giving up on a
// descriptor that takes nothing for 5000 ms.
function writeAll(writes) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const stalled = new Set();
  for (const { fd, text } of writes) {
    if (stalled.has(fd)) continue;
    let rest = Buffer.from(text);
    let waiting;
    while (rest.length)
      try {
        rest = rest.subarray(writeSync(fd, rest));
        waiting = undefined;
      } catch (error) {
        waiting ??= Date.now();
        if (error?.code !== "EAGAIN" || Date.now() - waiting > STALLED_MS) {
          stalled.add(fd);
          break;
        }
        Atomics.wait(sleeper, 0, 0, 2);
      }
  }
}

export async function runScript(args, options = {}) {
  const env = options.env || process.env;
  const { timeoutMs, source } = parseRunOptions(args, env);
  let file;
  let code;
  if (source.kind === "eval") code = source.value;
  else if (source.kind === "stdin")
    code = await readInput(options.stdin || process.stdin, {
      timeoutMs: options.stdinTimeoutMs,
    });
  else {
    file = resolve(source.value);
    if (!(await exists(file)))
      throw new Error(
        "Script file not found. Use run <file.mjs>, run - or run -e <code>.",
      );
  }
  // Tests run scripts in their own process and read the output from sinks.
  const inProcess =
    options.flushOnSettle ?? !!(options.stdout || options.stderr);
  // Errors keep the script's frames through the client's layers.
  Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 50);
  const captured = capture();
  const state = { final: "", status: 0, settled: false, stepped: false };
  const session = new Session({
    env,
    fetch: options.fetch,
    connect: options.connect,
    health: options.health,
    lazy: true,
    run: true,
  });
  for (const hook of options.endHooks ?? []) session.onRunEnd(hook);
  let temporary;
  // The held output, then notices, then the final lines; after a hard stop,
  // only the guidance.
  const writes = () =>
    session.hardStop
      ? [{ fd: 2, text: `${guidance(session.hardStop)}\n` }]
      : [
          ...captured.held.entries,
          ...takeNotices().map((text) => ({
            fd: 2,
            text: `notice: ${line(text)}\n`,
          })),
          ...(state.final ? [{ fd: 2, text: state.final }] : []),
          ...(captured.held.dropped
            ? [
                {
                  fd: 2,
                  text: `Kamapathy: ${captured.held.dropped} more bytes of output were dropped after the first 4 MiB. Write large results to a file.\n`,
                },
              ]
            : []),
        ];
  const step = async () => {
    if (state.stepped || session.signal.aborted) return;
    state.stepped = true;
    await runEndStep(session, { capMs: options.endCapMs });
  };
  let finish;
  const stopped = new Promise((done) => (finish = done));
  // The deadline and signals abort calls in progress and end the run.
  const stop = (error, status) => {
    session.abort(error);
    state.final = errorText(error);
    state.status = status;
    if (inProcess) finish();
    else process.exit(status);
  };
  const timer = setTimeout(
    () =>
      stop(
        new KamapathyError(
          "run_timeout",
          `The script did not finish within ${timeoutMs} ms. A call in progress may still have taken effect, so inspect the page before retrying. Use --timeout for longer tasks.`,
          { timeoutMs },
        ),
        1,
      ),
    timeoutMs,
  );
  timer.unref();
  const rejected = (error) => {
    captured.hold(2, errorText(error));
    state.status = 1;
    if (!inProcess) process.exitCode = 1;
  };
  process.on("unhandledRejection", rejected);
  // The loop drained before the import settled: an await that never resolves.
  const stalled = async () => {
    if (state.settled) return;
    state.final = PENDING;
    process.exitCode = 1;
    await step();
  };
  if (!inProcess) {
    for (const [signal, number] of Object.entries(SIGNALS))
      process.once(signal, () =>
        stop(
          new KamapathyError(
            "interrupted",
            `The run was stopped by ${signal}. A call in progress may still have taken effect, so inspect the page before retrying.`,
            { signal },
          ),
          128 + number,
        ),
      );
    process.on("uncaughtException", (error) => {
      captured.hold(2, errorText(error));
      process.exit(1);
    });
    process.once("beforeExit", stalled);
    // One flush at exit, whatever ended the run. A hard stop wins over the
    // script's own exit code.
    process.once("exit", () => {
      captured.restore();
      writeAll(writes());
      if (session.hardStop) process.exitCode = 3;
      if (temporary) rmSync(temporary, { force: true });
    });
  }
  const client = await connect({ session, lazy: true });
  installGlobals(globalThis, client);
  const work = (async () => {
    try {
      if (code !== undefined) {
        temporary = join(
          tmpdir(),
          `kamapathy-run-${randomBytes(8).toString("hex")}.mjs`,
        );
        await writeFile(temporary, code, { mode: 0o600, flag: "wx" });
        file = temporary;
      }
      await import(pathToFileURL(file).href);
    } catch (error) {
      state.final = errorText(error);
      state.status = 1;
    }
    state.settled = true;
    process.off("beforeExit", stalled);
    await step();
  })();
  await Promise.race([work, stopped]);
  clearTimeout(timer);
  if (temporary) await rm(temporary, { force: true });
  if (!inProcess) return state.status;
  captured.restore();
  process.off("unhandledRejection", rejected);
  for (const { fd, text } of writes())
    (fd === 1 ? options.stdout : options.stderr)?.write(text);
  return session.hardStop ? 3 : state.status;
}
