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
      "Emulation.setEmitTouchEventsForMouse": "managed",
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
    // A probe of Electron 44 found that with mouse events turned into touch
    // events, a mouse command Kamapathy sends is delivered but never
    // answered, for the rest of the page's life.
    expect(verdict("Emulation.setEmitTouchEventsForMouse")).toMatchObject({
      message: expect.stringContaining("Input.dispatchTouchEvent"),
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
    // The editor's own clipboard keys: a probe of Electron 44 found
    // Shift+Insert pasting the system clipboard into a field and
    // Shift+Delete cutting the selection onto it.
    for (const key of ["Insert", "Delete"])
      expect(
        verdict("Input.dispatchKeyEvent", {
          type: "keyDown",
          modifiers: 8,
          key,
          code: key,
        }),
        key,
      ).toMatchObject({ block: "person", param: "key" });
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

  it("a view scale or a viewport, which move where input lands, are refused", () => {
    // A probe of Electron 44 saw either one carry a raw mouse event or touch
    // into an out-of-process frame while the hit test named the page there,
    // through Page's older name for the same command too.
    const metrics = { width: 0, height: 0, deviceScaleFactor: 0, mobile: false };
    for (const method of [
      "Emulation.setDeviceMetricsOverride",
      "Page.setDeviceMetricsOverride",
    ]) {
      for (const scale of [2, 0.5])
        expect(
          verdict(method, { ...metrics, scale }),
          `${method} ${scale}`,
        ).toMatchObject({
          block: "scope",
          param: "scale",
          message: expect.stringContaining("deviceScaleFactor"),
        });
      for (const viewport of [
        { x: 0, y: 0, width: 400, height: 300, scale: 2 },
        { x: 100, y: 100, width: 800, height: 600, scale: 1 },
      ])
        expect(
          verdict(method, { ...metrics, viewport }),
          `${method} ${JSON.stringify(viewport)}`,
        ).toMatchObject({ block: "scope", param: "viewport" });
      // Every other field keeps working, and so does a scale of 1.
      for (const params of [
        { ...metrics, scale: 1 },
        { width: 400, height: 300, deviceScaleFactor: 2, mobile: true },
        {
          ...metrics,
          screenWidth: 400,
          screenHeight: 300,
          screenOrientation: { type: "landscapePrimary", angle: 90 },
        },
        {
          width: 1600,
          height: 1200,
          deviceScaleFactor: 1,
          mobile: false,
          dontSetVisibleSize: true,
        },
      ])
        expect(
          verdict(method, params),
          `${method} ${JSON.stringify(params)}`,
        ).toEqual({ allow: true });
    }
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

  it("an agent never takes or names Kamapathy's worlds or Electron's preload world", () => {
    // Electron runs every page's preload scripts in a world of this name,
    // which a probe of Electron 44 saw every agent session report.
    for (const method of [
      "Page.createIsolatedWorld",
      "Page.addScriptToEvaluateOnNewDocument",
    ])
      for (const worldName of [
        "Electron Isolated Context",
        "electron isolated context",
      ])
        expect(
          verdict(method, { worldName }),
          `${method} ${worldName}`,
        ).toMatchObject({ block: "scope", param: "worldName" });
    // Naming either is refused by the name itself, whatever the agent holds.
    for (const name of ["kamapathy", "Kamapathy-2", "Electron Isolated Context"])
      expect(
        verdict(
          "Runtime.addBinding",
          { name: "b", executionContextName: name },
          { worlds: new Set([name]) },
        ),
        name,
      ).toMatchObject({ block: "scope", param: "executionContextName" });
  });

  it("a reserved world name stays reserved whatever its whitespace or case", () => {
    for (const name of [
      " kamapathy",
      "kamapathy\n",
      "\t KAMAPATHY-2 ",
      " Electron Isolated Context",
      "Electron Isolated Context ",
      "Electron  Isolated\t\tContext",
      "\u00a0electron\nISOLATED\u3000context\r\n",
    ]) {
      const where = JSON.stringify(name);
      for (const method of [
        "Page.createIsolatedWorld",
        "Page.addScriptToEvaluateOnNewDocument",
      ])
        expect(
          verdict(method, { worldName: name }),
          `${method} ${where}`,
        ).toMatchObject({ block: "scope", param: "worldName" });
      expect(
        verdict(
          "Runtime.addBinding",
          { name: "b", executionContextName: name },
          { worlds: new Set([name]) },
        ),
        where,
      ).toMatchObject({ block: "scope", param: "executionContextName" });
    }
    // A name of the agent's own that merely holds one of them is its own.
    for (const name of ["my kamapathy", "Electron Isolated Context 2"])
      expect(
        verdict("Page.createIsolatedWorld", { worldName: name }),
        name,
      ).toEqual({ allow: true });
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
      blocked?: (frameId: string) => boolean;
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
    // Audits carries a Set-Cookie line of its own, however deep.
    const issue = event("Audits.issueAdded", {
      issue: {
        code: "CookieIssue",
        details: {
          cookieIssueDetails: {
            rawCookieLine: "a=1; Path=/",
            cookieWarningReasons: ["WarnSameSiteUnspecified"],
          },
        },
      },
    });
    expect(redact(issue, { fromAgent: true })?.params).toEqual({
      issue: {
        code: "CookieIssue",
        details: {
          cookieIssueDetails: {
            rawCookieLine: "(hidden)",
            cookieWarningReasons: ["WarnSameSiteUnspecified"],
          },
        },
      },
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

  it("keeps an extension's own worlds out of the events and out of reach", () => {
    const ID = "abcdefghijklmnopabcdefghijklmnop";
    // A content script of one of the person's extensions runs in a world of
    // its own, which agents are never given.
    const created = (origin: string, auxData?: Record<string, unknown>) =>
      event("Runtime.executionContextCreated", {
        context: {
          id: 4,
          uniqueId: "ctx-4",
          name: "Price watcher",
          origin,
          ...(auxData ? { auxData } : {}),
        },
      });
    expect(redact(created(`chrome-extension://${ID}`))).toBeNull();
    // An origin reported beside the frame counts the same.
    expect(
      redact(
        created("", {
          type: "isolated",
          frameId: "frame-x",
          origin: `chrome-extension://${ID}`,
        }),
      ),
    ).toBeNull();
    // Kamapathy's own PDF viewer is an extension like any other here.
    expect(
      redact(created("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai")),
    ).toBeNull();
    // A web page's own world is recorded as before.
    expect(redact(created("https://example.com"))).not.toBeNull();
    // Nothing delivered that context, so its end is dropped as well, and
    // every command naming it, or an object from it, is out of scope.
    expect(
      redact(
        event("Runtime.executionContextDestroyed", {
          executionContextId: 4,
          executionContextUniqueId: "ctx-4",
        }),
        { delivered: () => false },
      ),
    ).toBeNull();
    for (const [method, params, param] of [
      ["Runtime.evaluate", { contextId: 4 }, "contextId"],
      ["Runtime.evaluate", { uniqueContextId: "ctx-4" }, "uniqueContextId"],
      ["DOM.resolveNode", { executionContextId: 4 }, "executionContextId"],
      [
        "Runtime.addBinding",
        { name: "b", executionContextName: "Price watcher" },
        "executionContextName",
      ],
      ["Runtime.callFunctionOn", { objectId: "obj-ext" }, "objectId"],
    ] as const)
      expect(verdict(method, params), method).toMatchObject({
        block: "scope",
        param,
      });
  });

  it("keeps the worlds of a frame the tab blocks and an undelivered context's exceptions out of the events", () => {
    // The page's own world in a frame agents never reach, such as a local
    // page, carries no extension origin.
    const created = event("Runtime.executionContextCreated", {
      context: {
        id: 5,
        uniqueId: "ctx-5",
        name: "",
        origin: "file://",
        auxData: { frameId: "frame-f", isDefault: true, type: "default" },
      },
    });
    const blocked = (frameId: string) => frameId === "frame-f";
    expect(redact(created, { blocked })).toBeNull();
    expect(redact(created, { blocked: () => false })).toBe(created);
    expect(redact(created)).toBe(created);
    // An exception names its context inside its details.
    const thrown = event("Runtime.exceptionThrown", {
      timestamp: 1,
      exceptionDetails: {
        exceptionId: 1,
        text: "Uncaught",
        lineNumber: 0,
        columnNumber: 0,
        executionContextId: 5,
        exception: { type: "object", objectId: "obj-5" },
      },
    });
    expect(redact(thrown, { delivered: () => false })).toBeNull();
    expect(redact(thrown, { delivered: () => true })).toBe(thrown);
  });

  it("keeps Kamapathy's worlds and Electron's preload world out of the events", () => {
    // Both are reported to an agent's session as the page's own origin.
    const created = (name: string) =>
      event("Runtime.executionContextCreated", {
        context: {
          id: 6,
          uniqueId: "ctx-6",
          name,
          origin: "https://example.com",
          auxData: { frameId: "main", isDefault: false, type: "isolated" },
        },
      });
    for (const name of ["kamapathy", "Electron Isolated Context"])
      expect(redact(created(name)), name).toBeNull();
    // A world an agent made under a name of its own is recorded as before.
    expect(redact(created("agent-world"))).not.toBeNull();
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
