import type { ServerResponse } from "node:http";

/** One NDJSON line per object, with the bytes written so far. */
export interface NdjsonWriter {
  write(line: Record<string, unknown>): Promise<void>;
  end(): void;
  readonly bytes: number;
}

// Answers 200 with the stream's headers, then writes one object per line.
// Each write waits for the socket to take it, so a client that reads slowly
// never fills this process, and a client that goes away resolves it too.
export function startNdjson(response: ServerResponse): NdjsonWriter {
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  let bytes = 0;
  const gone = () => response.destroyed || response.writableEnded;
  return {
    get bytes() {
      return bytes;
    },
    write(line) {
      const text = `${JSON.stringify(line)}\n`;
      if (gone()) return Promise.resolve();
      bytes += Buffer.byteLength(text);
      return new Promise<void>((resolve) => {
        const done = () => {
          response.off("close", done);
          resolve();
        };
        response.on("close", done);
        response.write(text, done);
      });
    },
    end() {
      if (!gone()) response.end();
    },
  };
}
