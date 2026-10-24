import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  classify,
  collectIds,
  INPUT_METHODS,
  METHOD_PATTERN,
  redactEvent,
  type PolicyContext,
  type Verdict,
} from "../electron/agent/cdp-policy";
import type { CdpEvent } from "../electron/agent/session/types";

// Chromium 152.0.7977.76's own protocol, as Electron 44.2.0 reports it at
// /json/protocol with --remote-debugging-port, reduced to the domains and the
// names of their commands and events.
const PROTOCOL: {
  browser: string;
  domains: Record<string, { commands: string[]; events: string[] }>;
} = JSON.parse(
  readFileSync(
    new URL("./fixtures/cdp/protocol-152.json", import.meta.url),
    "utf8",
  ),
);
const ALLOWED = [
  "Accessibility",
  "Animation",
  "Audits",
  "Console",
  "CSS",
  "DeviceOrientation",
  "DOMSnapshot",
  "Inspector",
  "IO",
  "LayerTree",
  "Log",
  "Media",
  "Overlay",
  "Performance",
  "PerformanceTimeline",
  "Preload",
  "Schema",
  "WebAudio",
  "DOM",
  "Emulation",
  "Fetch",
  "Input",
  "Network",
  "Page",
  "Runtime",
  "Security",
];
// Nothing is delivered and no world is the agent's unless a check says so.
const context = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  delivered: () => false,
  worlds: new Set<string>(),
  platform: "darwin",
  ...overrides,
});
const verdict = (
  method: string,
  params: Record<string, unknown> = {},
  overrides: Partial<PolicyContext> = {},
): Verdict => classify(method, params, context(overrides));
const reasonOf = (verdict: Verdict) =>
  "block" in verdict ? verdict.block : "allowed";

describe("the protocol policy", () => {
  it("every method of an allowed domain is classified", () => {
    expect(PROTOCOL.browser).toBe("Chrome/152.0.7977.76");
    for (const domain of ALLOWED)
      expect(Object.keys(PROTOCOL.domains), domain).toContain(domain);
    const unknown: string[] = [];
    for (const domain of ALLOWED)
      for (const name of PROTOCOL.domains[domain].commands) {
        const result = verdict(`${domain}.${name}`);
        if ("block" in result && result.block === "unknown")
          unknown.push(`${domain}.${name}`);
      }
    expect(unknown).toEqual([]);
    // A method of an allowed domain is refused only with a parameter, an
    // identifier or a named reason, never by falling through.
    expect(verdict("DOM.getDocument")).toEqual({ allow: true });
  });

  it("each block reason is given", () => {
    const reasons: Record<string, string[]> = {
      browser: ["Target", "Browser", "SystemInfo", "Tethering", "Tracing"],
      session: [
        "Storage",
        "ServiceWorker",
        "BackgroundService",
        "CacheStorage",
        "IndexedDB",
        "DOMStorage",
        "FileSystem",
      ],
      process: [
        "Debugger",
        "DOMDebugger",
        "EventBreakpoints",
        "HeapProfiler",
        "Profiler",
        "Memory",
      ],
      person: [
        "Autofill",
        "BluetoothEmulation",
        "Cast",
        "DeviceAccess",
        "Extensions",
        "FedCm",
        "PWA",
        "WebAuthn",
      ],
    };
    for (const [reason, domains] of Object.entries(reasons))
      for (const domain of domains) {
        expect(Object.keys(PROTOCOL.domains), domain).toContain(domain);
        for (const name of PROTOCOL.domains[domain].commands)
          expect(
            reasonOf(verdict(`${domain}.${name}`)),
            `${domain}.${name}`,
          ).toBe(reason);
      }
    // Every domain Chromium 152 has that the table does not name, and a
    // domain no Chromium has, are unknown.
    const named = new Set([...ALLOWED, ...Object.values(reasons).flat()]);
    for (const domain of Object.keys(PROTOCOL.domains))
      if (!named.has(domain))
        expect(reasonOf(verdict(`${domain}.enable`)), domain).toBe("unknown");
    expect(verdict("Teleport.toMars")).toMatchObject({ block: "unknown" });
    expect(METHOD_PATTERN.test("Page.navigate")).toBe(true);
    expect(verdict("not a method")).toMatchObject({ block: "unknown" });
  });

  it("the named method refusals hold", () => {
    const refusals: Record<string, string> = {
      "DOM.setFileInputFiles": "filesystem",
      "DOM.getFileInfo": "filesystem",
      "Emulation.setCPUThrottlingRate": "process",
      "Emulation.setTimezoneOverride": "process",
      "Emulation.setLocaleOverride": "process",
      "Network.getCookies": "session",
      "Network.getAllCookies": "session",
      "Network.setCookie": "session",
      "Network.setCookies": "session",
      "Network.deleteCookies": "session",
      "Network.clearBrowserCookies": "session",
      "Network.clearBrowserCache": "session",
      "Network.setCookieControls": "session",
      "Network.loadNetworkResource": "filesystem",
      "Page.setDownloadBehavior": "filesystem",
      "Page.crash": "process",
      "Page.waitForDebugger": "process",
      "Page.deleteCookie": "session",
      "Page.close": "managed",
      "Page.bringToFront": "person",
      "Page.setWebLifecycleState": "person",
      "Page.setSPCTransactionMode": "person",
      "Page.setRPHRegistrationMode": "person",
      "Page.handleJavaScriptDialog": "managed",
      "Page.setInterceptFileChooserDialog": "managed",
      "Runtime.terminateExecution": "process",
      "Input.setIgnoreInputEvents": "person",
      "Input.setInterceptDrags": "managed",
      "Input.dispatchDragEvent": "managed",
    };
    for (const [method, reason] of Object.entries(refusals)) {
      const [domain, name] = method.split(".");
      expect(PROTOCOL.domains[domain].commands, method).toContain(name);
      expect(reasonOf(verdict(method)), method).toBe(reason);
    }
    // The refusal names what to use instead.
    expect(verdict("DOM.setFileInputFiles")).toMatchObject({
      message: expect.stringContaining("page.upload"),
    });
    expect(verdict("Page.close")).toMatchObject({
      message: expect.stringContaining("page.close()"),
    });
    // Security has only its two switches.
    for (const name of PROTOCOL.domains.Security.commands)
      expect(reasonOf(verdict(`Security.${name}`)), name).toBe(
        name === "enable" || name === "disable" ? "allowed" : "person",
      );
  });

  it("parameter checks refuse what the method would reach", () => {
    const credentials = verdict("Fetch.enable", { handleAuthRequests: true });
    expect(credentials).toMatchObject({
      block: "person",
      param: "handleAuthRequests",
      message: expect.stringContaining("space.setHTTPCredentials"),
    });
    expect(
      verdict("Fetch.enable", { patterns: [{ urlPattern: "*" }] }),
    ).toEqual({
      allow: true,
    });
    expect(verdict("Fetch.continueWithAuth")).toMatchObject({
      block: "person",
      message: expect.stringContaining("space.setHTTPCredentials"),
    });
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "data:text/html,<p>hi",
    ])
      expect(
        verdict("Fetch.continueRequest", { requestId: "1", url }),
        url,
      ).toMatchObject({ block: "scope", param: "url" });
    expect(
      verdict("Fetch.continueRequest", {
        requestId: "1",
        url: "https://example.com/a",
      }),
    ).toEqual({ allow: true });
    expect(
      verdict("Page.navigate", { url: "file:///etc/passwd" }),
    ).toMatchObject({ block: "scope", param: "url" });
    expect(verdict("Page.navigate", { url: "https://example.com/" })).toEqual({
      allow: true,
    });
    for (const method of [
      "Page.createIsolatedWorld",
      "Page.addScriptToEvaluateOnNewDocument",
    ]) {
      expect(
        verdict(method, { worldName: "kamapathy-2" }),
        method,
      ).toMatchObject({ block: "scope", param: "worldName" });
      expect(verdict(method, { worldName: "Kamapathy" }), method).toMatchObject(
        {
          block: "scope",
          param: "worldName",
        },
      );
      expect(verdict(method, { worldName: "agent-world" }), method).toEqual({
        allow: true,
      });
    }
    expect(
      verdict("Page.createIsolatedWorld", {
        frameId: "main",
        grantUniveralAccess: true,
      }),
    ).toMatchObject({ block: "scope", param: "grantUniveralAccess" });
    // The clipboard: an editing command, and the chord that runs one.
    for (const command of ["copy", "cut", "paste", "pasteAndMatchStyle"])
      expect(
        verdict("Input.dispatchKeyEvent", {
          type: "keyDown",
          commands: [command],
        }),
        command,
      ).toMatchObject({ block: "person", param: "commands" });
    for (const modifiers of [2, 4])
      expect(
        verdict("Input.dispatchKeyEvent", {
          type: "keyDown",
          modifiers,
          key: "c",
          code: "KeyC",
        }),
        String(modifiers),
      ).toMatchObject({ block: "person", param: "key" });
    expect(
      verdict("Input.dispatchKeyEvent", {
        type: "keyDown",
        modifiers: 8,
        key: "C",
        code: "KeyC",
      }),
    ).toEqual({ allow: true, dispatcher: true });
    // Middle-button presses paste the selection on Linux.
    const middle = { type: "mousePressed", x: 1, y: 1, button: "middle" };
    expect(verdict("Input.dispatchMouseEvent", middle)).toEqual({
      allow: true,
      dispatcher: true,
    });
    expect(
      verdict("Input.dispatchMouseEvent", middle, { platform: "linux" }),
    ).toMatchObject({ block: "person", param: "button" });
  });

  it("identifiers must have been delivered", () => {
    const ids: [string, Record<string, unknown>, string][] = [
      ["Runtime.callFunctionOn", { objectId: "obj-1" }, "objectId"],
      ["DOM.describeNode", { backendObjectId: "obj-1" }, "backendObjectId"],
      ["Runtime.evaluate", { contextId: 7 }, "contextId"],
      ["DOM.resolveNode", { executionContextId: 7 }, "executionContextId"],
      ["Runtime.evaluate", { uniqueContextId: "ctx-1" }, "uniqueContextId"],
      [
        "Runtime.addBinding",
        { name: "b", executionContextName: "world" },
        "executionContextName",
      ],
      ["IO.read", { handle: "stream-1" }, "handle"],
    ];
    for (const [method, params, param] of ids)
      expect(verdict(method, params), method).toMatchObject({
        block: "scope",
        param,
      });
    // A delivered id passes, and so does a world the agent made itself.
    const delivered = {
      delivered: (kind: string, id: string | number) =>
        (kind === "object" && id === "obj-1") ||
        (kind === "context" && (id === 7 || id === "ctx-1")) ||
        (kind === "handle" && id === "stream-1"),
      worlds: new Set(["world"]),
    };
    for (const [method, params] of ids)
      expect(verdict(method, params, delivered), method).toEqual(
        method.startsWith("Input.")
          ? { allow: true, dispatcher: true }
          : { allow: true },
      );
    // Ids nested in a call's arguments are checked too.
    expect(
      verdict(
        "Runtime.callFunctionOn",
        { objectId: "obj-1", arguments: [{ objectId: "obj-2" }] },
        delivered,
      ),
    ).toMatchObject({ block: "scope", param: "objectId" });
    // What a result or an event delivers, by kind.
    expect(
      collectIds("Page.createIsolatedWorld", { executionContextId: 7 }),
    ).toEqual([{ kind: "context", id: 7 }]);
    expect(
      collectIds("Runtime.executionContextCreated", {
        context: { id: 9, uniqueId: "ctx-9", name: "agent-world", origin: "" },
      }),
    ).toEqual([
      { kind: "context", id: 9 },
      { kind: "context", id: "ctx-9" },
      { kind: "world", id: "agent-world" },
    ]);
    expect(
      collectIds("Fetch.takeResponseBodyAsStream", { stream: "stream-2" }),
    ).toEqual([{ kind: "handle", id: "stream-2" }]);
    expect(
      collectIds("DOM.resolveNode", { object: { objectId: "obj-3" } }),
    ).toEqual([{ kind: "object", id: "obj-3" }]);
  });

  it("every Input command is marked for the dispatcher", () => {
    expect([...INPUT_METHODS].sort()).toEqual(
      PROTOCOL.domains.Input.commands.map((name) => `Input.${name}`).sort(),
    );
    for (const name of PROTOCOL.domains.Input.commands) {
      const result = verdict(`Input.${name}`);
      if ("allow" in result) expect(result.dispatcher, name).toBe(true);
      else expect(["person", "managed"], name).toContain(result.block);
    }
  });
});

describe("event redaction", () => {
  const event = (method: string, params: unknown): CdpEvent => ({
    method,
    params,
    at: 1000,
  });
  const redact = (
    item: CdpEvent,
    overrides: {
      delivered?: (kind: string, id: string | number) => boolean;
      owns?: (domain: "Page" | "Network") => boolean;
      fromAgent?: boolean;
    } = {},
  ) =>
    redactEvent(item, {
      delivered: () => true,
      owns: () => false,
      fromAgent: false,
      ...overrides,
    });

  it("redaction hides only cookie values", () => {
    const request = event("Network.requestWillBeSentExtraInfo", {
      requestId: "1",
      headers: {
        Cookie: "session=secret",
        "User-Agent": "Kamapathy",
        accept: "*/*",
      },
      associatedCookies: [
        {
          cookie: { name: "session", value: "secret", domain: "example.com" },
          blockedReasons: [],
        },
      ],
      connectTiming: { requestTime: 1 },
    });
    expect(redact(request)?.params).toEqual({
      requestId: "1",
      headers: {
        Cookie: "(hidden)",
        "User-Agent": "Kamapathy",
        accept: "*/*",
      },
      associatedCookies: [
        {
          cookie: { name: "session", value: "(hidden)", domain: "example.com" },
          blockedReasons: [],
        },
      ],
      connectTiming: { requestTime: 1 },
    });
    const response = event("Network.responseReceivedExtraInfo", {
      requestId: "1",
      headers: { "set-cookie": "a=1, b=2", date: "now" },
      headersText:
        "HTTP/1.1 200 OK\r\nSet-Cookie: a=1; Path=/\r\nContent-Type: text/html\r\n",
      blockedCookies: [
        {
          blockedReasons: ["SameSiteStrict"],
          cookieLine: "a=1; Path=/",
          cookie: { name: "a", value: "1" },
        },
      ],
      exemptedCookies: [
        {
          exemptionReason: "None",
          cookieLine: "b=2",
          cookie: { name: "b", value: "2" },
        },
      ],
      statusCode: 200,
    });
    expect(redact(response)?.params).toEqual({
      requestId: "1",
      headers: { "set-cookie": "(hidden)", date: "now" },
      headersText:
        "HTTP/1.1 200 OK\r\nSet-Cookie: (hidden)\r\nContent-Type: text/html\r\n",
      blockedCookies: [
        {
          blockedReasons: ["SameSiteStrict"],
          cookieLine: "(hidden)",
          cookie: { name: "a", value: "(hidden)" },
        },
      ],
      exemptedCookies: [
        {
          exemptionReason: "None",
          cookieLine: "(hidden)",
          cookie: { name: "b", value: "(hidden)" },
        },
      ],
      statusCode: 200,
    });
    // A header list, as Fetch reports one, and the request's own headers.
    const paused = event("Fetch.requestPaused", {
      requestId: "1",
      request: {
        url: "https://example.com/",
        headers: { cookie: "session=secret", referer: "https://example.com/" },
      },
      responseHeaders: [
        { name: "Set-Cookie", value: "a=1" },
        { name: "Content-Type", value: "text/html" },
      ],
    });
    expect(redact(paused, { fromAgent: true })?.params).toEqual({
      requestId: "1",
      request: {
        url: "https://example.com/",
        headers: { cookie: "(hidden)", referer: "https://example.com/" },
      },
      responseHeaders: [
        { name: "Set-Cookie", value: "(hidden)" },
        { name: "Content-Type", value: "text/html" },
      ],
    });
    // An event with nothing to hide is the event itself.
    const plain = event("Network.loadingFinished", {
      requestId: "1",
      encodedDataLength: 10,
    });
    expect(redact(plain)).toBe(plain);
  });

  it("drops what is never recorded", () => {
    expect(
      redact(event("Target.attachedToTarget", { sessionId: "s-1" })),
    ).toBeNull();
    expect(
      redact(event("ServiceWorker.workerVersionUpdated", { versions: [] })),
    ).toBeNull();
    // A context the tab never delivered to the agent.
    const console = event("Runtime.consoleAPICalled", {
      type: "log",
      args: [],
      executionContextId: 3,
      timestamp: 1,
    });
    expect(redact(console, { delivered: () => false })).toBeNull();
    expect(redact(console, { delivered: () => true })).toBe(console);
    // The creation of a context names no context it had to be given first.
    const created = event("Runtime.executionContextCreated", {
      context: {
        id: 3,
        uniqueId: "ctx-3",
        name: "",
        origin: "https://example.com",
      },
    });
    expect(redact(created, { delivered: () => false })).toBe(created);
  });

  it("drops Kamapathy's own copy once the agent owns the domain", () => {
    const network = event("Network.requestWillBeSent", { requestId: "1" });
    const page = event("Page.loadEventFired", { timestamp: 1 });
    expect(
      redact(network, { owns: (domain) => domain === "Network" }),
    ).toBeNull();
    expect(redact(page, { owns: (domain) => domain === "Network" })).toBe(page);
    expect(redact(page, { owns: () => true })).toBeNull();
    // The agent's own copies are kept whatever it owns.
    expect(redact(network, { owns: () => true, fromAgent: true })).toBe(
      network,
    );
  });
});
