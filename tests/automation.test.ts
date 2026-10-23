import { statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { watchLeaveGuard } from "../electron/agent/routes/navigation";
import { PAGE_STATE_SOURCE } from "../electron/agent/session/operations";
import {
  startAutomation,
  type AutomationServer,
  type TestProbe,
} from "../electron/agent/server";
import {
  API_LEVEL,
  ROUTES,
  routeKey,
} from "../skills/kamapathy/scripts/schema/index.mjs";
import type { BrowserAction, BrowserState, Space } from "../shared/types";
import {
  FakeContents,
  FakeController,
  socketFetch,
  testSocket,
} from "./fake-automation";

describe("local automation socket", () => {
  let controller: FakeController;
  let api: AutomationServer;
  let socket: ReturnType<typeof testSocket>;
  let send: ReturnType<typeof socketFetch>;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ) =>
    send(path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  // Kamapathy refuses a request by its declared size before reading any body, then
  // closes the connection, so these checks send headers only.
  const declaredSize = (path: string, bytes: number) =>
    new Promise<number>((resolve, reject) => {
      const client = httpRequest(
        {
          socketPath: socket.path,
          path,
          agent: false,
          method: "POST",
          headers: {
            Host: "kamapathy",
            "Content-Type": "application/json",
            "Content-Length": bytes,
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
          client.destroy();
        },
      );
      client.once("error", reject);
      client.flushHeaders();
    });
  const createSpace = async () =>
    (await (await request("/spaces", "POST", { name: "Research" })).json())
      .space as Space;
  const createPage = async () => {
    const space = await createSpace();
    const response = await request(`/spaces/${space.id}/tabs`, "POST", {
      url: "https://example.com/",
    });
    return {
      space,
      tab: (await response.json()).tab as BrowserState["tabs"][number],
    };
  };
  const uploadBody = (overrides: Record<string, unknown> = {}) => ({
    ref: "@e1",
    files: [{ name: "listing.png", type: "image/png", data: "AAEC/w==" }],
    ...overrides,
  });
  const beginUpload = async (tabId: string) => {
    const encoded = JSON.stringify(uploadBody());
    const accessed = controller.accessedTabs.length;
    let client!: ReturnType<typeof httpRequest>;
    const result = new Promise<{ status: number; data: any }>((resolve, reject) => {
      client = httpRequest({
        socketPath: socket.path,
        path: `/tabs/${tabId}/upload`,
        method: "POST",
        headers: {
          Host: "kamapathy",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(encoded),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => resolve({
          status: response.statusCode!,
          data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        }));
      });
      client.once("error", reject);
      client.write(encoded.slice(0, 1));
    });
    // The upload holds its reservation once it has looked up the page.
    await expect.poll(() => controller.accessedTabs.length).toBeGreaterThan(accessed);
    return { client, result, finish: () => client.end(encoded.slice(1)) };
  };
  // One debugger attach serves a tab for as long as the agent has it.
  const expectOneAttach = () => {
    expect(controller.contents.debugger.attachCount).toBe(1);
    expect(controller.contents.debugger.attached).toBe(true);
  };
  beforeEach(async () => {
    controller = new FakeController();
    socket = testSocket();
    api = await startAutomation(controller, { socketPath: socket.path });
    send = socketFetch(socket.path);
  });
  afterEach(async () => {
    await api.close();
    socket.cleanup();
  });

  it("creates agent spaces with the person's sign-ins unless isolation is requested", async () => {
    const shared = await request("/spaces", "POST", { name: "Research" });
    expect(shared.status).toBe(201);
    const created = await shared.json();
    expect(created).toEqual({
      space: expect.objectContaining({
        name: "Research",
        kind: "agent",
        owner: "agent",
        signIns: "shared",
        createdBy: "agent",
        pageBudget: 20,
      }),
      tab: expect.objectContaining({
        spaceId: created.space.id,
        label: "p1",
        openedBy: "agent",
        managed: true,
      }),
      created: true,
    });
    const isolated = await request("/spaces", "POST", {
      name: "Clean",
      isolated: true,
    });
    expect(isolated.status).toBe(201);
    expect((await isolated.json()).space.signIns).toBe("separate");
    expect(controller.isolatedRequests).toEqual([false, true]);
    expect(controller.activity.at(-1)?.message).toBe(
      "Agent connected to a new space",
    );
    const odd = await request("/spaces", "POST", { name: "Odd", isolated: "yes" });
    expect(odd.status).toBe(400);
    expect((await odd.json()).error.code).toBe("invalid_field");
  });
  it("listens only on a private local socket and needs no token", async () => {
    expect(api.endpoint).toBe(socket.path);
    if (process.platform !== "win32") {
      expect(statSync(socket.path).isSocket()).toBe(true);
      expect(statSync(socket.path).mode & 0o077).toBe(0);
    }
    expect((await request("/health")).status).toBe(200);
  });

  it("identifies this server on every response so a client can refuse an impostor", async () => {
    expect(api.instance).toMatch(/^[a-f0-9]{32}$/);
    for (const response of [
      await request("/health"),
      await request("/missing"),
      await request("/health", "GET", undefined, { Origin: "https://example.com" }),
    ])
      expect(response.headers.get("x-kamapathy-instance")).toBe(api.instance);
    const previous = api.instance;
    await api.close();
    api = await startAutomation(controller, { socketPath: socket.path });
    expect(api.instance).not.toBe(previous);
  });

  it("answers health immediately even while a page action is still running", async () => {
    const { tab } = await createPage();
    let release!: () => void;
    controller.contents.result = () =>
      new Promise((resolve) => {
        release = () => resolve({ url: "https://example.com/", title: "", text: "", interactables: [], truncated: false });
      });
    const pending = request(`/tabs/${tab.id}/snapshot`);
    await expect.poll(() => typeof release).toBe("function");
    const started = Date.now();
    expect((await request("/health")).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1000);
    release();
    expect((await pending).status).toBe(200);
  });

  it("rejects requests a browser made", async () => {
    const browserHeaders: Record<string, string>[] = [
      { Origin: "https://malicious.example" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "same-origin" },
    ];
    for (const headers of browserHeaders) {
      expect(
        (await request("/health", "GET", undefined, headers)).status,
        JSON.stringify(headers),
      ).toBe(403);
    }
  });

  it("never lists or opens personal or ungranted manual agent spaces", async () => {
    expect(await (await request("/spaces")).json()).toEqual({ spaces: [] });
    const personal = controller.state.tabs[0];
    const manual = controller.state.tabs.find(
      (tab) => tab.spaceId === "manual-agent",
    )!;
    for (const tab of [personal, manual]) {
      expect((await request(`/tabs/${tab.id}/snapshot`)).status).toBe(404);
      expect(
        (
          await request(`/tabs/${tab.id}/navigate`, "POST", {
            url: "https://example.com/",
          })
        ).status,
      ).toBe(404);
      expect((await request(`/tabs/${tab.id}`, "DELETE")).status).toBe(404);
      expect((await request(`/spaces/${tab.spaceId}/tabs`)).status).toBe(404);
    }
    expect(controller.calls).toEqual([]);
    expect(controller.accessedTabs).toEqual([]);
  });

  it("accepts an explicit UI grant: personal spaces can now be granted, and granting an active managed space changes nothing", async () => {
    expect((await request("/spaces/personal/tabs")).status).toBe(404);
    const personal = api.grantSpace("personal");
    expect(personal).toMatchObject({
      id: "personal",
      kind: "personal",
      owner: "agent",
      access: "granted",
    });
    expect(
      controller.state.tabs
        .filter((tab) => tab.spaceId === "personal")
        .every((tab) => tab.openedBy === "person" && tab.managed === false),
    ).toBe(true);
    expect((await request("/spaces/personal/tabs")).status).toBe(200);
    expect((await request("/spaces/manual-agent/tabs")).status).toBe(404);
    const manual = api.grantSpace("manual-agent");
    expect((await request("/spaces/manual-agent/tabs")).status).toBe(200);
    const tab = controller.state.tabs.find(
      (item) => item.spaceId === "manual-agent",
    )!;
    expect(tab).toMatchObject({ openedBy: "person", managed: false });
    expect((await request(`/tabs/${tab.id}/adopt`, "POST", {})).status).toBe(
      200,
    );
    // A grant in force is never handed over again, so the adopted tab stays
    // the agent's.
    expect(api.grantSpace("manual-agent")).toBe(manual);
    expect(tab.managed).toBe(true);
    await controller.dispatch({
      type: "space:ownership",
      id: "manual-agent",
      owner: "human",
    });
    expect((await request("/spaces/manual-agent/tabs")).status).toBe(409);
    api.grantSpace("manual-agent");
    expect(manual.owner).toBe("human");
    expect(() => api.grantSpace("missing")).toThrow("Space was not found.");
    await api.close();
    expect(() => api.grantSpace("work")).toThrow("Turn on agent access first.");
  });

  it("creates isolated background spaces and tabs without changing the personal selection", async () => {
    const selection = {
      space: controller.state.activeSpaceId,
      tab: controller.state.activeTabId,
    };
    const { space, tab } = await createPage();
    expect(space.kind).toBe("agent");
    expect(tab.spaceId).toBe(space.id);
    expect(controller.state.activeSpaceId).toBe(selection.space);
    expect(controller.state.activeTabId).toBe(selection.tab);
    const listed = await (await request("/spaces")).json();
    expect(listed.spaces.map((item: Space) => item.id)).toEqual([space.id]);
    expect(controller.calls[0]).toMatchObject({
      type: "tab:create",
      background: true,
      spaceId: space.id,
    });
  });

  it("rejects unavailable screenshots before capture while allowing snapshots, then recovers", async () => {
    const { tab } = await createPage();
    controller.captureAvailable = false;
    const unavailable = await request(`/tabs/${tab.id}/screenshot`);
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({
      error: {
        code: "screenshot_unavailable",
        message: expect.stringContaining("Restore or show the Kamapathy window"),
      },
    });
    expect(controller.contents.captureCalls).toBe(0);
    expect((await request(`/tabs/${tab.id}/snapshot`)).status).toBe(200);
    controller.captureAvailable = true;
    const restored = await request(`/tabs/${tab.id}/screenshot`);
    expect(restored.status).toBe(200);
    expect(restored.headers.get("content-type")).toBe("image/png");
    expect(controller.contents.captureCalls).toBe(1);
  });

  it("reports a rendering failure without leaking native capture errors", async () => {
    const { tab } = await createPage();
    controller.contents.captureError = new Error("UnknownVizError internal details");
    const response = await request(`/tabs/${tab.id}/screenshot`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "screenshot_failed",
        message: "The page could not render a screenshot. Read a snapshot or try again after the page finishes rendering.",
        retryable: true,
      },
    });
  });

  it("blocks reads and actions after handoff until the human returns control", async () => {
    const { space, tab } = await createPage();
    expect(
      (await request(`/spaces/${space.id}/handoff`, "POST", {})).status,
    ).toBe(200);
    expect((await request(`/tabs/${tab.id}/snapshot`)).status).toBe(409);
    expect((await request(`/tabs/${tab.id}/screenshot`)).status).toBe(409);
    expect(
      (await request(`/tabs/${tab.id}/click`, "POST", { selector: "#submit" }))
        .status,
    ).toBe(409);
    expect(
      (
        await request(`/tabs/${tab.id}/navigate`, "POST", {
          url: "https://example.com/",
        })
      ).status,
    ).toBe(409);
    expect((await request(`/spaces/${space.id}`, "DELETE")).status).toBe(409);
    expect((await request(`/spaces/${space.id}/tabs`)).status).toBe(409);
    expect(controller.accessedTabs).toEqual([]);
    expect((await (await request("/spaces")).json()).spaces[0].owner).toBe(
      "human",
    );
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "agent",
    });
    const snapshot = await request(`/tabs/${tab.id}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).text).toBe("Hello from the agent page");
    expect(controller.contents.scripts[0].world).toBe("kamapathy");
  });

  it("lets the agent take control back from a person's own takeover and act again", async () => {
    const { space, tab } = await createPage();
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    const refused = await request(`/tabs/${tab.id}/snapshot`);
    expect(refused.status).toBe(409);
    const { error } = await refused.json();
    expect(error.code).toBe("human_control");
    expect(error.message).toBe(
      "The person took over this space. Stop, and resume only when they ask you to.",
    );
    const resumed = await request(`/spaces/${space.id}/resume`, "POST", {});
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      ok: true,
      owner: "agent",
      opened: [],
      closed: [],
    });
    expect(controller.calls.at(-1)).toEqual({
      type: "space:ownership",
      id: space.id,
      owner: "agent",
    });
    expect(controller.activity.at(-1)).toEqual({
      spaceId: space.id,
      message: "Agent took back control of this space",
      kind: "info",
    });
    expect((await (await request("/spaces")).json()).spaces[0].owner).toBe(
      "agent",
    );
    const snapshot = await request(`/tabs/${tab.id}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).text).toBe("Hello from the agent page");
    controller.contents.result = { ok: true, x: 25, y: 45 };
    expect(
      (await request(`/tabs/${tab.id}/click`, "POST", { ref: "@e1" })).status,
    ).toBe(200);
    const { done } = await dispatched(tab.id, {
      url: "https://example.com/next",
      waitUntil: "commit",
    });
    const frame = mainFrame(controller.contents, "loader-2");
    frame.start("https://example.com/next");
    frame.commit("https://example.com/next");
    expect((await done).status).toBe(200);
  });

  it("takes control back after its own handoff and treats a repeated resume as a no-op", async () => {
    const { space, tab } = await createPage();
    expect(
      (await request(`/spaces/${space.id}/handoff`, "POST", {})).status,
    ).toBe(200);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await request(`/spaces/${space.id}/resume`, "POST", {});
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        owner: "agent",
        opened: [],
        closed: [],
      });
    }
    const ownership = (item: BrowserAction) =>
      item.type === "space:ownership";
    expect(controller.calls.filter(ownership)).toEqual([
      {
        type: "space:ownership",
        id: space.id,
        owner: "human",
        reason: "handoff",
      },
      { type: "space:ownership", id: space.id, owner: "agent" },
    ]);
    expect(
      controller.activity.filter(
        (item) => item.message === "Agent took back control of this space",
      ),
    ).toHaveLength(1);
    expect((await request(`/tabs/${tab.id}/snapshot`)).status).toBe(200);
  });

  it("never takes control of personal, ungranted, or unknown spaces", async () => {
    await controller.dispatch({
      type: "space:ownership",
      id: "manual-agent",
      owner: "human",
    });
    const tab = controller.state.tabs.find(
      (item) => item.spaceId === "manual-agent",
    )!;
    for (const id of ["personal", "manual-agent", "missing-space", tab.id]) {
      const response = await request(`/spaces/${id}/resume`, "POST", {});
      expect(response.status, id).toBe(404);
      expect((await response.json()).error.code).toBe("space_not_found");
    }
    expect(
      controller.state.spaces.find((space) => space.id === "manual-agent")!
        .owner,
    ).toBe("human");
    const { space } = await createPage();
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    // Only POST takes control back; other methods still meet human control.
    expect((await request(`/spaces/${space.id}/resume`)).status).toBe(409);
    expect(
      controller.calls.filter(
        (item) => item.type === "space:ownership" && item.owner === "agent",
      ),
    ).toEqual([]);
    expect(controller.accessedTabs).toEqual([]);
  });

  it("cannot take control back once agent access stops, even with a request already queued", async () => {
    const { space, tab } = await createPage();
    let release!: () => void;
    controller.contents.result = () =>
      new Promise((resolve) => {
        release = () => resolve({ text: "" });
      });
    const running = request(`/tabs/${tab.id}/snapshot`).then(
      () => "answered",
      () => "closed",
    );
    await expect.poll(() => typeof release).toBe("function");
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    const queued = request(`/spaces/${space.id}/resume`, "POST", {}).then(
      () => "answered",
      () => "closed",
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await api.close();
    release();
    // Stopping closes every connection, so no response can reach the agent.
    expect(await queued).toBe("closed");
    await expect(
      request(`/spaces/${space.id}/resume`, "POST", {}),
    ).rejects.toThrow();
    expect(await running).toBe("closed");
    const owner = () =>
      controller.state.spaces.find((item) => item.id === space.id)!.owner;
    expect(owner()).toBe("human");
    // Turning access on again starts a server that has forgotten the space.
    api = await startAutomation(controller, { socketPath: socket.path });
    const forgotten = await request(`/spaces/${space.id}/resume`, "POST", {});
    expect(forgotten.status).toBe(404);
    expect(owner()).toBe("human");
  });

  it("does not undo a takeover that happens while a resume sent with control waits", async () => {
    const { space, tab } = await createPage();
    let release!: () => void;
    controller.contents.result = () =>
      new Promise((resolve) => {
        release = () => resolve({ text: "" });
      });
    const running = request(`/tabs/${tab.id}/snapshot`);
    await expect.poll(() => typeof release).toBe("function");
    const queued = request(`/spaces/${space.id}/resume`, "POST", {});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    release();
    expect((await running).status).toBe(409);
    const response = await queued;
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("human_control");
    expect(
      controller.state.spaces.find((item) => item.id === space.id)!.owner,
    ).toBe("human");
    expect(
      controller.activity.some(
        (item) => item.message === "Agent took back control of this space",
      ),
    ).toBe(false);
  });

  it("withholds an in-flight snapshot if the human takes over before it resolves", async () => {
    const { space, tab } = await createPage();
    let resolveSnapshot!: (value: unknown) => void;
    controller.contents.result = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    const response = request(`/tabs/${tab.id}/snapshot`);
    await new Promise<void>((resolve) => {
      const check = () =>
        controller.contents.scripts.length ? resolve() : setTimeout(check, 1);
      check();
    });
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    resolveSnapshot({ text: "A human has now edited this page." });
    const result = await response;
    expect(result.status).toBe(409);
    expect(await result.text()).not.toContain("edited this page");
  });

  it("rejects unsafe URLs, oversized bodies, and malformed JSON", async () => {
    const space = await createSpace();
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hello",
      "kamapathy://newtab",
      "https://user:secret@example.com/",
      "example.com",
    ]) {
      expect(
        (await request(`/spaces/${space.id}/tabs`, "POST", { url })).status,
      ).toBe(400);
    }
    expect(await declaredSize("/spaces", 66000)).toBe(413);
    expect((await request("/spaces", "POST", ["name"])).status).toBe(400);
    const invalid = await send("/spaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(invalid.status).toBe(400);
    expect(
      (await send("/spaces", { method: "POST", body: "{}" })).status,
    ).toBe(415);
    expect(controller.calls).toEqual([]);
  });

  it("serializes selectors as data and exposes no evaluate endpoint", async () => {
    const { tab } = await createPage();
    const selector = '#field"); process.exit(); //';
    controller.contents.result = { ok: true };
    expect(
      (
        await request(`/tabs/${tab.id}/fill`, "POST", {
          selector,
          value: 'quote " and newline\n',
        })
      ).status,
    ).toBe(200);
    const executed = controller.contents.scripts[0];
    expect(
      executed.code.includes(
        `)("fill",${JSON.stringify({ selector, value: 'quote " and newline\n' })},`,
      ),
    ).toBe(true);
    expect(executed.world).toBe("kamapathy");
    expect(
      (
        await request(`/tabs/${tab.id}/evaluate`, "POST", {
          code: "process.exit()",
        })
      ).status,
    ).toBe(404);
    expect(
      (await request(`/tabs/${tab.id}/snapshot?token=secret`)).status,
    ).toBe(400);
  });

  it("forgets provenance when the API restarts", async () => {
    const { space, tab } = await createPage();
    await api.close();
    api = await startAutomation(controller, { socketPath: socket.path });
    expect((await request(`/spaces/${space.id}/tabs`)).status).toBe(404);
    expect((await request(`/tabs/${tab.id}/snapshot`)).status).toBe(404);
    expect(await (await request("/spaces")).json()).toEqual({ spaces: [] });
  });

  it("supports bounded compact, full, scoped, and controls-only observations", async () => {
    const { tab } = await createPage();
    expect((await request(`/tabs/${tab.id}/snapshot`)).status).toBe(200);
    expect(controller.contents.scripts.at(-1)!.code).toContain(
      '"mode":"compact","maxChars":4000,"maxControls":40',
    );
    expect(
      (
        await request(`/tabs/${tab.id}/snapshot`, "POST", {
          mode: "full",
          selector: "#form",
          maxChars: 0,
          maxControls: 7,
        })
      ).status,
    ).toBe(200);
    expect(controller.contents.scripts.at(-1)!.code).toContain(
      '"mode":"full","maxChars":0,"maxControls":7,"selector":"#form"',
    );
    for (const body of [
      { mode: "unknown" },
      { maxChars: -1 },
      { maxChars: 24001 },
      { maxControls: 101 },
      { maxControls: 1.5 },
      { selector: "" },
    ]) {
      expect(
        (await request(`/tabs/${tab.id}/snapshot`, "POST", body)).status,
      ).toBe(400);
    }
  });

  it("changes the reference namespace on document navigation and never reuses allocation ranges", async () => {
    const { tab } = await createPage();
    await request(`/tabs/${tab.id}/snapshot`);
    const first = controller.contents.scripts.at(-1)!.code;
    const firstRef = Number(first.match(/"firstRef":(\d+)/)![1]);
    expect(first.endsWith(`${tab.id}:0")`)).toBe(true);
    controller.contents.emit("did-start-navigation", {
      url: "https://example.com/next",
      isSameDocument: false,
      isMainFrame: true,
    });
    await request(`/tabs/${tab.id}/snapshot`);
    const second = controller.contents.scripts.at(-1)!.code;
    expect(Number(second.match(/"firstRef":(\d+)/)![1])).toBe(firstRef + 100);
    expect(second.endsWith(`${tab.id}:1")`)).toBe(true);
    controller.contents.emit("did-start-navigation", {
      url: "https://example.com/next#section",
      isSameDocument: true,
      isMainFrame: true,
    });
    await request(`/tabs/${tab.id}/snapshot`);
    expect(
      controller.contents.scripts.at(-1)!.code.endsWith(`${tab.id}:1")`),
    ).toBe(true);
  });

  it("keeps the reference namespace of a page across a handoff and resume", async () => {
    const { space, tab } = await createPage();
    const page = controller.contents;
    // The page's first load, which its session saw start.
    page.emit("did-start-navigation", {
      url: "https://example.com/",
      isSameDocument: false,
      isMainFrame: true,
    });
    await request(`/tabs/${tab.id}/snapshot`);
    expect(page.scripts.at(-1)!.code.endsWith(`${tab.id}:1")`)).toBe(true);
    expect(
      (await request(`/spaces/${space.id}/handoff`, "POST", {})).status,
    ).toBe(200);
    await expect.poll(() => page.debugger.attached).toBe(false);
    expect(
      (await request(`/spaces/${space.id}/resume`, "POST", {})).status,
    ).toBe(200);
    await expect.poll(() => page.debugger.attached).toBe(true);
    expect((await request(`/tabs/${tab.id}/snapshot`)).status).toBe(200);
    expect(page.scripts.at(-1)!.code.endsWith(`${tab.id}:1")`)).toBe(true);
  });

  it("rejects ambiguous targets and propagates stale refs without falling back to a selector", async () => {
    const { tab } = await createPage();
    for (const body of [
      {},
      { ref: "@e1", selector: "#field" },
      { ref: "@e0" },
      { ref: "#field" },
    ]) {
      expect(
        (
          await request(`/tabs/${tab.id}/fill`, "POST", {
            ...body,
            value: "test",
          })
        ).status,
      ).toBe(400);
    }
    controller.contents.result = {
      ok: false,
      code: "stale_ref",
      error: "Element reference is stale. Take a new snapshot.",
    };
    const response = await request(`/tabs/${tab.id}/fill`, "POST", {
      ref: "@e1",
      value: "test",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("stale_ref");
    expect(controller.contents.scripts).toHaveLength(1);
    expect(controller.contents.scripts[0].code).toContain(
      ')("fill",{"ref":"@e1","value":"test"}',
    );
  });

  it("refuses a control inside a frame from another origin as a conflict, before any input", async () => {
    const { tab } = await createPage();
    controller.contents.result = {
      ok: false,
      code: "cross_origin_frame",
      error:
        "This control is inside a frame from another origin, which Kamapathy cannot read. Ask the person to continue there.",
    };
    for (const [route, body] of [
      ["click", { ref: "@e2" }],
      ["fill", { ref: "@e2", value: "card" }],
      ["drag", { source: { ref: "@e1" }, target: { ref: "@e2" } }],
    ] as const) {
      const response = await request(`/tabs/${tab.id}/${route}`, "POST", body);
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("cross_origin_frame");
    }
    expect(controller.contents.inputs).toEqual([]);
    controller.contents.result = {
      url: "https://example.com/",
      title: "Example",
      text: "Checkout",
      interactables: [
        {
          index: 0,
          ref: "@e1",
          tag: "button",
          role: "button",
          label: "Pay",
          selector: "button",
          disabled: false,
          frame: "0/1",
        },
        {
          index: 1,
          ref: "@e2",
          tag: "iframe",
          role: "iframe",
          label: "Card details",
          selector: "#card",
          disabled: false,
          crossOrigin: true,
        },
      ],
      truncated: false,
    };
    const snapshot = await (await request(`/tabs/${tab.id}/snapshot`)).json();
    expect(snapshot.interactables.map((control: any) => control.frame)).toEqual(
      ["0/1", undefined],
    );
    expect(snapshot.interactables[1].crossOrigin).toBe(true);
  });

  it("validates an entire batch before performing any action", async () => {
    const { tab } = await createPage();
    const response = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "fill", selector: "#field", value: "test" },
        { type: "evaluate", code: "process.exit()" },
      ],
    });
    expect(response.status).toBe(400);
    expect(controller.contents.scripts).toEqual([]);
    expect(
      (
        await request(`/tabs/${tab.id}/actions`, "POST", {
          actions: Array.from({ length: 21 }, () => ({ type: "snapshot" })),
        })
      ).status,
    ).toBe(400);
  });

  it("returns completed batch steps and stops at the first failed action without retrying", async () => {
    const { tab } = await createPage();
    controller.contents.result = (code: string) =>
      code.includes(')("fill",')
        ? { ok: true }
        : {
            ok: false,
            code: "stale_ref",
            error: "Element reference is stale.",
          };
    const response = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "fill", ref: "@e1", value: "one" },
        { type: "click", ref: "@e2" },
        { type: "fill", ref: "@e3", value: "must not run" },
      ],
    });
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result).toMatchObject({
      ok: false,
      failedIndex: 1,
      error: { code: "stale_ref" },
      results: [{ index: 0, type: "fill", result: { ok: true } }],
    });
    expect(controller.contents.scripts).toHaveLength(2);
    expect(controller.contents.inputs).toEqual([]);
  });

  it("rechecks human ownership between batch steps and withholds earlier observations", async () => {
    const { tab, space } = await createPage();
    let observations = 0;
    controller.addActivity = () => {
      if (++observations === 1)
        controller.state.spaces.find((item) => item.id === space.id)!.owner =
          "human";
    };
    const response = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "snapshot" },
        { type: "fill", selector: "#field", value: "must not run" },
      ],
    });
    expect(response.status).toBe(409);
    const result = await response.json();
    expect(result.error.code).toBe("human_control");
    expect(result.failedIndex).toBe(1);
    expect(result.results[0].result).toEqual({ ok: true, withheld: true });
    expect(JSON.stringify(result)).not.toContain("Hello from the agent page");
    expect(controller.contents.scripts).toHaveLength(1);
  });

  it("dispatches only fixed trusted mouse and keyboard input without changing selected tabs", async () => {
    const { tab } = await createPage();
    const activeTab = controller.state.activeTabId;
    controller.contents.result = { ok: true, x: 25, y: 45 };
    expect(
      (await request(`/tabs/${tab.id}/click`, "POST", { ref: "@e1" })).status,
    ).toBe(200);
    expect(
      controller.contents.inputs.map((input) => input.parameters.type),
    ).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(
      controller.contents.inputs.every(
        (input) => input.method === "Input.dispatchMouseEvent",
      ),
    ).toBe(true);
    expectOneAttach();
    controller.contents.inputs = [];
    expect(
      (
        await request(`/tabs/${tab.id}/press`, "POST", {
          key: "Enter",
          ref: "@e2",
        })
      ).status,
    ).toBe(200);
    expect(
      controller.contents.inputs.map((input) => input.parameters.type),
    ).toEqual(["keyDown", "keyUp"]);
    expect(
      controller.contents.inputs.every(
        (input) => input.method === "Input.dispatchKeyEvent",
      ),
    ).toBe(true);
    expect(controller.state.activeTabId).toBe(activeTab);
    for (const key of ["Control+W", "F12", "a", "constructor"])
      expect(
        (await request(`/tabs/${tab.id}/press`, "POST", { key })).status,
      ).toBe(400);
  });

  it("repeats native input the page never received and reports one that never arrives", async () => {
    const { tab } = await createPage();
    // A page drops native input until it renders a frame after a navigation.
    const page = (received: number) => (code: string) =>
      code.includes(')("input",')
        ? { ok: true, mouse: controller.contents.inputs.filter((input) => input.parameters.type === "mousePressed").length > received ? 1 : 0, key: 0 }
        : { ok: true, x: 25, y: 45 };
    controller.contents.result = page(1);
    expect(
      (await request(`/tabs/${tab.id}/click`, "POST", { ref: "@e1" })).status,
    ).toBe(200);
    expect(
      controller.contents.inputs.map((input) => input.parameters.type),
    ).toEqual([
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
      "mouseMoved",
      "mousePressed",
      "mouseReleased",
    ]);
    expect(
      controller.contents.scripts.some((script) =>
        script.code.includes(')("frame",'),
      ),
    ).toBe(true);
    controller.contents.inputs = [];
    controller.contents.result = page(Number.POSITIVE_INFINITY);
    const response = await request(`/tabs/${tab.id}/click`, "POST", {
      ref: "@e1",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("input_not_delivered");
    expect(
      controller.contents.inputs.filter(
        (input) => input.parameters.type === "mousePressed",
      ),
    ).toHaveLength(3);
    expectOneAttach();
  });

  it("checks ownership immediately before each native input event", async () => {
    const { tab, space } = await createPage();
    controller.contents.result = { ok: true, x: 25, y: 45 };
    controller.contents.afterInput = () => {
      controller.state.spaces.find((item) => item.id === space.id)!.owner =
        "human";
      controller.emit();
    };
    expect(
      (await request(`/tabs/${tab.id}/click`, "POST", { ref: "@e1" })).status,
    ).toBe(409);
    expect(
      controller.contents.inputs.map((input) => input.parameters.type),
    ).toEqual(["mouseMoved"]);
    await expect.poll(() => controller.contents.debugger.attached).toBe(false);
    expect(controller.contents.debugger.attachCount).toBe(1);
  });

  it("keeps one debugger attach per tab across actions, and detaches after takeover and after the space closes", async () => {
    const { space, tab } = await createPage();
    const page = controller.contents;
    page.result = { ok: true, x: 25, y: 45 };
    for (const [route, body] of [
      ["snapshot", {}],
      ["click", { ref: "@e1" }],
      ["press", { key: "Enter", ref: "@e1" }],
      ["fill", { ref: "@e1", value: "Ada" }],
    ] as const)
      expect(
        (await request(`/tabs/${tab.id}/${route}`, "POST", body)).status,
        route,
      ).toBe(200);
    expect(page.debugger.attachCount).toBe(1);
    expect(page.debugger.attached).toBe(true);
    expect(page.scripts.every((script) => script.world === "kamapathy")).toBe(
      true,
    );
    expect(
      (await request(`/spaces/${space.id}/handoff`, "POST", {})).status,
    ).toBe(200);
    await expect.poll(() => page.debugger.attached).toBe(false);
    expect(
      (await request(`/spaces/${space.id}/resume`, "POST", {})).status,
    ).toBe(200);
    await expect.poll(() => page.debugger.attached).toBe(true);
    expect((await request(`/tabs/${tab.id}/snapshot`)).status).toBe(200);
    expect(page.debugger.attachCount).toBe(2);
    expect((await request(`/spaces/${space.id}`, "DELETE")).status).toBe(200);
    await expect.poll(() => page.debugger.attached).toBe(false);
    expect(page.debugger.attachCount).toBe(2);
  });

  it("fails a snapshot at once with dialog_open while a dialog is open", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const dialog = (type: string, message: string) => ({
      url: "https://example.com/",
      frameId: "main",
      message,
      type,
      hasBrowserHandler: true,
      defaultPrompt: "",
    });
    page.emitProtocol(
      "Page.javascriptDialogOpening",
      dialog("confirm", "Leave\u{202E} this page?"),
    );
    const started = Date.now();
    const refused = await request(`/tabs/${tab.id}/snapshot`);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: {
        code: "dialog_open",
        message:
          "A JavaScript confirm is still open on this page. Hand off to the person to close it, then inspect the page.",
        dialog: { type: "confirm", message: "Leave this page?" },
        started: false,
      },
    });
    expect(page.scripts).toEqual([]);
    // A screenshot is a page request too, and nothing is captured.
    const screenshot = await request(`/tabs/${tab.id}/screenshot`);
    expect(screenshot.status).toBe(409);
    expect((await screenshot.json()).error.code).toBe("dialog_open");
    expect(page.captureCalls).toBe(0);
    page.emitProtocol("Page.javascriptDialogClosed", {
      result: true,
      userInput: "",
    });
    expect((await request(`/tabs/${tab.id}/snapshot`)).status).toBe(200);
    // A dialog that opens while the page loads ends the wait for the load.
    const listening = page.listenerCount("did-stop-loading");
    page.isLoadingMainFrame = () => true;
    const waiting = request(`/tabs/${tab.id}/snapshot`);
    await expect
      .poll(() => page.listenerCount("did-stop-loading"))
      .toBeGreaterThan(listening);
    page.emitProtocol(
      "Page.javascriptDialogOpening",
      dialog("alert", "Still loading"),
    );
    const stopped = await waiting;
    expect(stopped.status).toBe(409);
    expect((await stopped.json()).error).toMatchObject({
      code: "dialog_open",
      dialog: { type: "alert", message: "Still loading" },
      started: false,
    });
    expect(page.listenerCount("did-stop-loading")).toBe(listening);
  });

  it("GET /tabs/:id/info answers the page state and the tab", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    page.result = {
      ok: true,
      viewport: { width: 1200, height: 800 },
      scroll: { x: 0, y: 640 },
      document: { width: 1200, height: 5400 },
      readyState: "interactive",
    };
    // A page still loading its main frame answers, and says so.
    page.isLoadingMainFrame = () => true;
    const response = await request(`/tabs/${tab.id}/info`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tab: expect.objectContaining({
        id: tab.id,
        url: "https://example.com/",
        managed: true,
      }),
      viewport: { width: 1200, height: 800 },
      scroll: { x: 0, y: 640 },
      document: { width: 1200, height: 5400 },
      readyState: "interactive",
      loading: true,
    });
    // The fixed page-state function runs, not the snapshot operation.
    expect(page.scripts.at(-1)!.code).toBe(`(${PAGE_STATE_SOURCE})("info")`);
    expect(page.scripts.at(-1)!.world).toBe("kamapathy");
    expect(controller.activity.at(-1)).toMatchObject({
      spaceId: tab.spaceId,
      message: "Agent read the page state",
    });
    page.isLoadingMainFrame = () => false;
    expect(
      (await (await request(`/tabs/${tab.id}/info`)).json()).loading,
    ).toBe(false);
  });

  it("info answers the open dialog without touching the page", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    page.emitProtocol("Page.javascriptDialogOpening", {
      url: "https://example.com/",
      frameId: "main",
      message: "Save your\u{202E} work?",
      type: "confirm",
      hasBrowserHandler: true,
      defaultPrompt: "",
    });
    const response = await request(`/tabs/${tab.id}/info`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tab: expect.objectContaining({ id: tab.id }),
      dialog: { type: "confirm", message: "Save your work?" },
    });
    expect(page.scripts).toEqual([]);
    expect(
      controller.activity.some(
        (entry) => entry.message === "Agent read the page state",
      ),
    ).toBe(false);
  });

  it("reload and info refuse a tab with no page", async () => {
    const { space, tab } = await createPage();
    // Every agent space opens with a tab on the new tab page.
    const blank = controller.state.tabs.find(
      (item) => item.spaceId === space.id && item.id !== tab.id,
    )!;
    const response = await request(`/tabs/${blank.id}/info`);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      code: "no_web_page",
    });
    const reloaded = await request(`/tabs/${blank.id}/reload`, "POST", {});
    expect(reloaded.status).toBe(409);
    expect((await reloaded.json()).error).toMatchObject({
      code: "no_web_page",
    });
  });

  it("watchLeaveGuard reports only the watched tab's overridden guard", async () => {
    const { tab } = await createPage();
    const other = controller.state.tabs.find((item) => item.id !== tab.id)!;
    const quiet = watchLeaveGuard(controller, tab.id);
    controller.leaveGuard(other.id);
    expect(quiet.stop()).toEqual({});
    const watch = watchLeaveGuard(controller, tab.id);
    controller.leaveGuard(tab.id);
    controller.leaveGuard(tab.id);
    expect(watch.stop()).toEqual({
      dialog: { type: "beforeunload", message: "", answer: "accepted" },
    });
    // A guard after the operation belongs to the next one.
    controller.leaveGuard(tab.id);
    expect(watchLeaveGuard(controller, tab.id).stop()).toEqual({});
  });

  // Chromium's main-frame navigation events for one document of a page.
  const mainFrame = (page: FakeContents, loaderId: string) => ({
    start: (url: string, navigationType = "differentDocument") =>
      page.emitProtocol("Page.frameStartedNavigating", {
        frameId: "main",
        loaderId,
        url,
        navigationType,
      }),
    request: (url: string, method = "GET") =>
      page.emitProtocol("Network.requestWillBeSent", {
        requestId: loaderId,
        loaderId,
        documentURL: url,
        request: { url, method, headers: {} },
        type: "Document",
      }),
    response: (status: number) =>
      page.emitProtocol("Network.responseReceived", {
        requestId: loaderId,
        loaderId,
        response: { status },
        type: "Document",
      }),
    failed: (errorText: string) =>
      page.emitProtocol("Network.loadingFailed", {
        requestId: loaderId,
        errorText,
        type: "Document",
      }),
    commit: (url: string) =>
      page.emitProtocol("Page.frameNavigated", {
        frame: {
          id: "main",
          loaderId,
          url,
          securityOrigin: new URL(url).origin,
          mimeType: "text/html",
        },
        type: "Navigation",
      }),
    lifecycle: (name: string) =>
      page.emitProtocol("Page.lifecycleEvent", {
        frameId: "main",
        loaderId,
        name,
        timestamp: 1,
      }),
    stop: () =>
      page.emitProtocol("Page.frameStoppedLoading", { frameId: "main" }),
  });
  // A navigate whose load has reached the page, ready for its events.
  const dispatched = async (
    tabId: string,
    body: Record<string, unknown>,
    loads = 1,
  ) => {
    const page = controller.pages.get(tabId)!;
    const done = request(`/tabs/${tabId}/navigate`, "POST", body);
    void done.catch(() => {});
    await expect.poll(() => page.loads.length).toBe(loads);
    return { done };
  };
  const failure = async (response: Response) => ({
    status: response.status,
    error: (await response.json()).error as Record<string, unknown>,
  });

  it("navigate waits for the state it was asked for and answers the tab", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const { done: committing } = await dispatched(tab.id, {
      url: "https://example.com/next",
      waitUntil: "commit",
    });
    expect(page.loads[0]).toEqual({ url: "https://example.com/next" });
    const first = mainFrame(page, "loader-2");
    first.start("https://example.com/next");
    first.request("https://example.com/next");
    first.response(200);
    first.commit("https://example.com/next");
    const answered = await committing;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({
        id: tab.id,
        url: "https://example.com/next",
        managed: true,
      }),
      httpStatus: 200,
      waitUntil: "commit",
    });
    expect(controller.activity.at(-1)).toMatchObject({
      spaceId: tab.spaceId,
      message: "Agent navigated to example.com",
    });
    // load waits for the load event, and the referer is sent as given.
    const { done: loading } = await dispatched(
      tab.id,
      {
        url: "https://example.com/last",
        waitUntil: "load",
        referer: "https://ref.example/a?b=c",
      },
      2,
    );
    expect(page.loads[1]).toEqual({
      url: "https://example.com/last",
      options: {
        httpReferrer: {
          url: "https://ref.example/a?b=c",
          policy: "unsafe-url",
        },
      },
    });
    const second = mainFrame(page, "loader-3");
    second.start("https://example.com/last");
    second.request("https://example.com/last");
    second.response(201);
    second.commit("https://example.com/last");
    second.lifecycle("DOMContentLoaded");
    let settled = false;
    void loading.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    second.lifecycle("load");
    const loaded = await loading;
    expect(loaded.status).toBe(200);
    expect(await loaded.json()).toMatchObject({
      ok: true,
      httpStatus: 201,
      waitUntil: "load",
    });
  });

  it("navigate enforces its field ranges", async () => {
    const { tab } = await createPage();
    const refuse = async (body: Record<string, unknown>) => {
      const response = await request(`/tabs/${tab.id}/navigate`, "POST", {
        url: "https://example.com/",
        ...body,
      });
      return failure(response);
    };
    for (const body of [
      { timeoutMs: 0 },
      { timeoutMs: 60001 },
      { waitUntil: "idle" },
    ]) {
      const { status, error } = await refuse(body);
      expect(status, JSON.stringify(body)).toBe(400);
      expect(error, JSON.stringify(body)).toMatchObject({
        code: "invalid_field",
        field: Object.keys(body)[0],
      });
    }
    for (const referer of [
      "ftp://example.com/",
      "https://user:pw@example.com/",
    ]) {
      const { status, error } = await refuse({ referer });
      expect(status, referer).toBe(400);
      expect(error, referer).toMatchObject({
        code: "invalid_field",
        field: "referer",
      });
    }
    expect(controller.contents.loads).toEqual([]);
  });

  it("navigate classifies an abort", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    let loader = 1;
    let loads = 0;
    const attempt = async (
      drive: (frame: ReturnType<typeof mainFrame>) => void,
    ) => {
      const url = `https://example.com/${++loader}`;
      const { done } = await dispatched(
        tab.id,
        { url, waitUntil: "commit", timeoutMs: 5000 },
        ++loads,
      );
      drive(mainFrame(page, `loader-${loader}`));
      return { url, ...(await failure(await done)) };
    };
    const download = await attempt((frame) => {
      frame.start(`https://example.com/2`);
      frame.request(`https://example.com/2`);
      frame.response(200);
      frame.failed("net::ERR_ABORTED");
      frame.stop();
      controller.startDownload(tab.id);
    });
    expect(download.status).toBe(422);
    expect(download.error).toMatchObject({
      code: "navigation_download",
      url: download.url,
      armed: false,
      dispatched: true,
    });
    const interrupted = await attempt((frame) => {
      frame.start(`https://example.com/3`);
      mainFrame(page, "loader-other").start("https://example.com/newer");
    });
    expect(interrupted.status).toBe(409);
    expect(interrupted.error).toMatchObject({
      code: "navigation_interrupted",
      url: interrupted.url,
      by: "https://example.com/newer",
    });
    const blocked = await attempt((frame) => {
      frame.start(`https://example.com/4`);
      controller.blockRedirect(tab.id, "file:///etc/passwd");
      frame.stop();
    });
    expect(blocked.status).toBe(422);
    expect(blocked.error).toMatchObject({
      code: "navigation_failed",
      url: blocked.url,
      blockedUrl: "file:///etc/passwd",
      netError: "ERR_BLOCKED_BY_CLIENT",
    });
    expect(blocked.error.retryable).toBeUndefined();
    const refused = await attempt((frame) => {
      frame.start(`https://example.com/5`);
      frame.request(`https://example.com/5`);
      frame.failed("net::ERR_CONNECTION_REFUSED");
    });
    expect(refused.status).toBe(422);
    expect(refused.error).toMatchObject({
      code: "navigation_failed",
      netError: "ERR_CONNECTION_REFUSED",
      retryable: true,
    });
    expect(refused.error.dispatched).toBeUndefined();
  });

  it("a navigation timeout reports what it reached", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const { done: committed } = await dispatched(tab.id, {
      url: "https://example.com/slow",
      waitUntil: "load",
      timeoutMs: 150,
    });
    const frame = mainFrame(page, "loader-2");
    frame.start("https://example.com/slow");
    frame.request("https://example.com/slow");
    frame.response(200);
    frame.commit("https://example.com/slow");
    const timeout = await failure(await committed);
    expect(timeout.status).toBe(504);
    expect(timeout.error).toEqual({
      code: "navigation_timeout",
      message:
        "Navigation to example.com did not reach load within 150 ms. It committed at https://example.com/slow with readyState loading. Continue there, or call waitForLoadState.",
      awaited: "load",
      timeoutMs: 150,
      committed: true,
      url: "https://example.com/slow",
      readyState: "loading",
      dispatched: true,
    });
    // A navigation that never commits says so instead.
    const { done: gone } = await dispatched(
      tab.id,
      { url: "https://example.com/gone", waitUntil: "commit", timeoutMs: 150 },
      2,
    );
    const never = await failure(await gone);
    expect(never.status).toBe(504);
    expect(never.error).toMatchObject({
      code: "navigation_timeout",
      message:
        "Navigation to example.com did not reach commit within 150 ms. It never committed. Check the address and connection.",
      committed: false,
      url: "https://example.com/gone",
    });
    expect(never.error.readyState).toBeUndefined();
  });

  it("navigate still answers tab, and POST /tabs/:id/wait keeps its contract", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const { done: pending } = await dispatched(tab.id, {
      url: "https://example.com/next",
    });
    const frame = mainFrame(page, "loader-2");
    frame.start("https://example.com/next");
    frame.commit("https://example.com/next");
    frame.lifecycle("load");
    const answered = await pending;
    expect(answered.status).toBe(200);
    const body = await answered.json();
    expect(body.tab).toMatchObject({
      id: tab.id,
      url: "https://example.com/next",
      managed: true,
    });
    expect(body.waitUntil).toBe("load");
    // The legacy wait route keeps its body, defaults and 408.
    const wait = ROUTES.find(
      (route) => routeKey(route) === "POST /tabs/:id/wait",
    )!;
    expect(wait.body!.timeoutMs).toMatchObject({ default: 5000, max: 15000 });
    const over = await request(`/tabs/${tab.id}/wait`, "POST", {
      text: "Done",
      timeoutMs: 15001,
    });
    expect(over.status).toBe(400);
    const timedOut = await request(`/tabs/${tab.id}/wait`, "POST", {
      text: "Done",
      timeoutMs: 0,
    });
    expect(timedOut.status).toBe(408);
    expect((await timedOut.json()).error).toMatchObject({
      code: "wait_timeout",
      awaited: "condition",
      timeoutMs: 0,
    });
  });

  it("a fifth pending navigation or wait answers 429 busy", async () => {
    const { tab } = await createPage();
    for (let held = 1; held <= 4; held++)
      await dispatched(
        tab.id,
        {
          url: `https://example.com/${held}`,
          waitUntil: "load",
          timeoutMs: 60000,
        },
        held,
      );
    const fifth = await failure(
      await request(`/tabs/${tab.id}/navigate`, "POST", {
        url: "https://example.com/5",
      }),
    );
    expect(fifth.status).toBe(429);
    expect(fifth.error).toEqual({
      code: "busy",
      message:
        "This page already has 4 navigations or waits in flight. Wait for one to finish.",
      scope: "tab",
      retryAfterMs: 250,
      retryable: true,
    });
    expect(controller.pages.get(tab.id)!.loads).toHaveLength(4);
  });

  it("a takeover ends a navigation wait within 100 ms", async () => {
    const { space, tab } = await createPage();
    const page = controller.contents;
    const { done: pending } = await dispatched(tab.id, {
      url: "https://example.com/slow",
      waitUntil: "load",
      timeoutMs: 60000,
    });
    const frame = mainFrame(page, "loader-2");
    frame.start("https://example.com/slow");
    frame.commit("https://example.com/slow");
    const started = Date.now();
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    const taken = await failure(await pending);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(taken.status).toBe(409);
    expect(taken.error).toMatchObject({
      code: "human_control",
      reason: "manual",
      message:
        "The person took over this space. Stop, and resume only when they ask you to.",
    });
  });

  it("a navigation wait yields its space lane", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const { done: pending } = await dispatched(tab.id, {
      url: "https://example.com/slow",
      waitUntil: "load",
      timeoutMs: 60000,
    });
    mainFrame(page, "loader-2").start("https://example.com/slow");
    const snapshot = await request(`/tabs/${tab.id}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).text).toBe("Hello from the agent page");
    const frame = mainFrame(page, "loader-2");
    frame.commit("https://example.com/slow");
    frame.lifecycle("load");
    expect((await pending).status).toBe(200);
  });

  it("runs a navigate step in a batch under its own timeout", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const batch = request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "navigate", url: "https://example.com/next" },
        { type: "snapshot" },
      ],
    });
    void batch.catch(() => {});
    await expect.poll(() => page.loads.length).toBe(1);
    const frame = mainFrame(page, "loader-2");
    frame.start("https://example.com/next");
    frame.request("https://example.com/next");
    frame.response(200);
    frame.commit("https://example.com/next");
    frame.lifecycle("load");
    const answered = await batch;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({
      ok: true,
      results: [
        {
          index: 0,
          type: "navigate",
          result: { ok: true, httpStatus: 200, waitUntil: "load" },
        },
        { index: 1, type: "snapshot" },
      ],
    });
    // A step that never reaches its state fails the batch, reporting the
    // timeout it ran under.
    const slow = request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "navigate", url: "https://example.com/slow", timeoutMs: 150 },
      ],
    });
    void slow.catch(() => {});
    await expect.poll(() => page.loads.length).toBe(2);
    mainFrame(page, "loader-3").start("https://example.com/slow");
    const timedOut = await slow;
    expect(timedOut.status).toBe(504);
    expect(await timedOut.json()).toMatchObject({
      ok: false,
      failedIndex: 0,
      error: {
        code: "navigation_timeout",
        awaited: "load",
        timeoutMs: 150,
        committed: false,
      },
    });
  });

  // A reload whose dispatch has reached the page, ready for its events.
  const reloading = async (
    tabId: string,
    body: Record<string, unknown> = {},
    reloads = 1,
  ) => {
    const page = controller.pages.get(tabId)!;
    const done = request(`/tabs/${tabId}/reload`, "POST", body);
    void done.catch(() => {});
    await expect.poll(() => page.reloads.length).toBe(reloads);
    return { done };
  };
  // A document the tracker saw arrive, with the method its request reported.
  const committed = async (
    tabId: string,
    url: string,
    method = "GET",
    loads = 1,
  ) => {
    const page = controller.pages.get(tabId)!;
    const { done } = await dispatched(tabId, { url, waitUntil: "commit" }, loads);
    const frame = mainFrame(page, `loader-${loads + 1}`);
    frame.start(url);
    frame.request(url, method);
    frame.response(200);
    frame.commit(url);
    expect((await done).status).toBe(200);
  };

  it("reload waits for its state and keeps the tab's id and label", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    expect(typeof tab.label).toBe("string");
    const { done: reloaded } = await reloading(tab.id, { waitUntil: "load" });
    expect(page.reloads).toEqual([{ ignoreCache: false }]);
    const frame = mainFrame(page, "loader-2");
    frame.start("https://example.com/", "reload");
    frame.request("https://example.com/");
    frame.response(200);
    frame.commit("https://example.com/");
    frame.lifecycle("DOMContentLoaded");
    let settled = false;
    void reloaded.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
    frame.lifecycle("load");
    const answered = await reloaded;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({
        id: tab.id,
        label: tab.label,
        url: "https://example.com/",
        managed: true,
      }),
      httpStatus: 200,
      waitUntil: "load",
    });
    expect(controller.activity.at(-1)).toMatchObject({
      spaceId: tab.spaceId,
      message: "Agent reloaded example.com",
    });
  });

  it("reload refuses to resubmit a POST document", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    await committed(tab.id, "https://example.com/order", "POST");
    const refused = await failure(
      await request(`/tabs/${tab.id}/reload`, "POST", {}),
    );
    expect(refused.status).toBe(409);
    expect(refused.error).toEqual({
      code: "reload_would_resubmit",
      message:
        "Reloading this page would send its form again. Navigate to the address instead, or ask the person to confirm.",
      url: "https://example.com/order",
    });
    expect(page.reloads).toEqual([]);
    // A document the tracker saw arrive from a GET reloads as usual.
    await committed(tab.id, "https://example.com/list", "GET", 2);
    const { done } = await reloading(tab.id, { waitUntil: "commit" });
    const frame = mainFrame(page, "loader-4");
    frame.start("https://example.com/list", "reload");
    frame.commit("https://example.com/list");
    expect((await done).status).toBe(200);
  });

  it("ignoreCache bypasses the cache under the same waits", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const { done } = await reloading(tab.id, {
      waitUntil: "commit",
      ignoreCache: true,
    });
    expect(page.reloads).toEqual([{ ignoreCache: true }]);
    const frame = mainFrame(page, "loader-2");
    frame.start("https://example.com/", "reloadBypassingCache");
    frame.request("https://example.com/");
    frame.response(200);
    frame.commit("https://example.com/");
    const answered = await done;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({ id: tab.id }),
      httpStatus: 200,
      waitUntil: "commit",
    });
    // No page script runs for it, so the Page scripts switch cannot gate it.
    expect(page.scripts).toEqual([]);
    // The batch step takes the same field.
    const batch = request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [{ type: "reload", waitUntil: "commit", ignoreCache: true }],
    });
    void batch.catch(() => {});
    await expect.poll(() => page.reloads.length).toBe(2);
    expect(page.reloads[1]).toEqual({ ignoreCache: true });
    const stepFrame = mainFrame(page, "loader-3");
    stepFrame.start("https://example.com/", "reloadBypassingCache");
    stepFrame.commit("https://example.com/");
    const ran = await batch;
    expect(ran.status).toBe(200);
    expect(await ran.json()).toMatchObject({
      ok: true,
      results: [
        { index: 0, type: "reload", result: { ok: true, waitUntil: "commit" } },
      ],
    });
  });

  it("reload enforces its field ranges", async () => {
    const { tab } = await createPage();
    for (const body of [
      { timeoutMs: 0 },
      { timeoutMs: 60001 },
      { ignoreCache: "yes" },
      { waitUntil: "idle" },
    ]) {
      const { status, error } = await failure(
        await request(`/tabs/${tab.id}/reload`, "POST", body),
      );
      expect(status, JSON.stringify(body)).toBe(400);
      expect(error, JSON.stringify(body)).toMatchObject({
        code: "invalid_field",
        field: Object.keys(body)[0],
      });
    }
    expect(controller.contents.reloads).toEqual([]);
  });

  const sleep = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
  // A URL wait and its answer.
  const waitForUrl = (tabId: string, body: Record<string, unknown>) => {
    const done = request(`/tabs/${tabId}/wait-for-url`, "POST", body);
    void done.catch(() => {});
    return done;
  };
  // A URL wait that is listening, so the page's own events reach it.
  const waiting = async (tabId: string, body: Record<string, unknown>) => {
    const done = waitForUrl(tabId, body);
    await sleep(25);
    return { done };
  };

  it("match mode tests the URL at entry and on every commit", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    // The page is already at https://example.com/, so this glob answers at once.
    const entry = await waitForUrl(tab.id, {
      url: "https://example.com/*",
      waitUntil: "commit",
    });
    expect(entry.status).toBe(200);
    expect(await entry.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({ id: tab.id, managed: true }),
      url: "https://example.com/",
    });
    expect(controller.activity.at(-1)).toMatchObject({
      spaceId: tab.spaceId,
      message: "Agent observed a page condition",
    });
    // A glob that matches only the second commit answers on that commit.
    const { done: pending } = await waiting(tab.id, {
      url: "https://example.com/step/{two,three}",
      waitUntil: "commit",
      timeoutMs: 5000,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    const first = mainFrame(page, "loader-2");
    first.start("https://example.com/step/one");
    first.commit("https://example.com/step/one");
    await sleep(150);
    expect(settled).toBe(false);
    const second = mainFrame(page, "loader-3");
    second.start("https://example.com/step/two");
    second.commit("https://example.com/step/two");
    const answered = await pending;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({
      ok: true,
      url: "https://example.com/step/two",
    });
    // The batch step takes the same glob.
    const batch = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "wait-for-url", url: "https://example.com/step/*", waitUntil: "commit" },
      ],
    });
    expect(batch.status).toBe(200);
    expect(await batch.json()).toMatchObject({
      ok: true,
      results: [
        {
          index: 0,
          type: "wait-for-url",
          result: { ok: true, url: "https://example.com/step/two" },
        },
      ],
    });
  });

  it("match mode then waits for the load state within the same deadline", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const { done: pending } = await waiting(tab.id, {
      url: "https://example.com/done",
      waitUntil: "load",
      timeoutMs: 5000,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    const frame = mainFrame(page, "loader-2");
    frame.start("https://example.com/done");
    frame.commit("https://example.com/done");
    await sleep(150);
    // The URL matched, so only the load event is still missing.
    expect(settled).toBe(false);
    frame.lifecycle("load");
    const answered = await pending;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({
      ok: true,
      url: "https://example.com/done",
    });
    // A load state that runs out after the match is the load state's timeout.
    const { done: slow } = await waiting(tab.id, {
      url: "https://example.com/slow",
      waitUntil: "load",
      timeoutMs: 300,
    });
    const next = mainFrame(page, "loader-3");
    next.start("https://example.com/slow");
    next.commit("https://example.com/slow");
    const timedOut = await failure(await slow);
    expect(timedOut.status).toBe(504);
    expect(timedOut.error).toMatchObject({
      code: "wait_timeout",
      message:
        "The page did not reach load within 300 ms. It is at https://example.com/slow with readyState loading.",
      awaited: "load_state",
      timeoutMs: 300,
      state: "load",
      url: "https://example.com/slow",
      readyState: "loading",
    });
  });

  it("a match in a popup from this page ends the wait", async () => {
    const { tab } = await createPage();
    // The popup opens while the wait runs, so it is a candidate.
    const { done: pending } = await waiting(tab.id, {
      url: "https://pay.example/**",
      waitUntil: "commit",
      timeoutMs: 5000,
    });
    const popup = controller.openPopup(tab.id, "https://pay.example/checkout");
    const failed = await failure(await pending);
    expect(failed.status).toBe(409);
    expect(failed.error).toEqual({
      code: "url_opened_in_popup",
      message: `${tab.label} stayed at https://example.com/, but popup ${popup.label} opened from it at https://pay.example/checkout. The action already happened, so do not repeat it. Continue in ${popup.label}.`,
      lastUrl: "https://example.com/",
      popup: {
        id: popup.id,
        label: popup.label,
        url: "https://pay.example/checkout",
      },
    });
  });

  it("watch mode answers the commit log and the popups", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const first = await waitForUrl(tab.id, {});
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({ id: tab.id }),
      url: "https://example.com/",
      navigation: 0,
      committed: [],
      popups: [],
    });
    // With after it waits for a later commit, then lists it.
    const { done: pending } = await waiting(tab.id, {
      after: 0,
      timeoutMs: 5000,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await sleep(150);
    expect(settled).toBe(false);
    const frame = mainFrame(page, "loader-2");
    frame.start("https://example.com/a");
    frame.commit("https://example.com/a");
    const answered = await pending;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({ id: tab.id }),
      url: "https://example.com/a",
      navigation: 1,
      committed: [{ navigation: 1, url: "https://example.com/a" }],
      popups: [],
    });
    // 34 more commits push the oldest out of the log of 32.
    for (let step = 2; step <= 35; step += 1) {
      const later = mainFrame(page, `loader-${step + 1}`);
      later.start(`https://example.com/${step}`);
      later.commit(`https://example.com/${step}`);
    }
    const kept = await (await waitForUrl(tab.id, { after: 34 })).json();
    expect(kept).toMatchObject({
      navigation: 35,
      committed: [{ navigation: 35, url: "https://example.com/35" }],
    });
    expect(kept.missed).toBeUndefined();
    const dropped = await (await waitForUrl(tab.id, { after: 1 })).json();
    expect(dropped.missed).toBe(true);
    expect(dropped.committed).toHaveLength(32);
    expect(dropped.committed[0]).toEqual({
      navigation: 4,
      url: "https://example.com/4",
    });
    expect(dropped.committed.at(-1)).toEqual({
      navigation: 35,
      url: "https://example.com/35",
    });
  });

  it("a URL wait times out with its fields", async () => {
    const { tab } = await createPage();
    const timedOut = await failure(
      await waitForUrl(tab.id, {
        url: "https://example.com/never",
        waitUntil: "commit",
        timeoutMs: 150,
      }),
    );
    expect(timedOut.status).toBe(504);
    expect(timedOut.error).toEqual({
      code: "wait_timeout",
      message:
        "The page did not reach a URL matching https://example.com/never within 150 ms. It is at https://example.com/.",
      awaited: "url",
      timeoutMs: 150,
      expected: "https://example.com/never",
      lastUrl: "https://example.com/",
      retryable: true,
    });
    // Zero checks once: a match answers, anything else times out at once.
    const once = await waitForUrl(tab.id, {
      url: "https://example.com/",
      waitUntil: "commit",
      timeoutMs: 0,
    });
    expect(once.status).toBe(200);
    const missed = await failure(
      await waitForUrl(tab.id, { url: "https://other.example/", timeoutMs: 0 }),
    );
    expect(missed.status).toBe(504);
    expect(missed.error).toMatchObject({ awaited: "url", timeoutMs: 0 });
  });

  it("a malformed glob and a bad field are refused before the lane", async () => {
    const { tab } = await createPage();
    const refuse = async (body: Record<string, unknown>) =>
      failure(await request(`/tabs/${tab.id}/wait-for-url`, "POST", body));
    const nested = await refuse({ url: "https://a.test/{a,{b}}" });
    expect(nested.status).toBe(400);
    expect(nested.error).toMatchObject({
      code: "invalid_field",
      field: "url",
      message: "Braces in a URL glob hold one level of alternatives, such as {a,b}.",
    });
    const trailing = await refuse({ url: "https://a.test/a\\" });
    expect(trailing.error).toMatchObject({
      code: "invalid_field",
      field: "url",
      message: "A URL glob cannot end with a backslash.",
    });
    for (const [body, field] of [
      [{ timeoutMs: 60001 }, "timeoutMs"],
      [{ url: "https://a.test/*", after: 1 }, "after"],
      [{ waitUntil: "load" }, "waitUntil"],
      [{ after: -1 }, "after"],
    ] as const) {
      const { status, error } = await refuse(body);
      expect(status, JSON.stringify(body)).toBe(400);
      expect(error, JSON.stringify(body)).toMatchObject({
        code: "invalid_field",
        field,
      });
    }
    // A step takes a glob only, so watch mode's field is not one of its own.
    const step = await failure(
      await request(`/tabs/${tab.id}/actions`, "POST", {
        actions: [{ type: "wait-for-url", after: 1 }],
      }),
    );
    expect(step.status).toBe(400);
    expect(step.error).toMatchObject({ code: "unknown_field", field: "after" });
    // Nothing reached the page.
    expect(controller.contents.scripts).toEqual([]);
  });

  it("a URL wait yields its lane and ends on a takeover", async () => {
    const { space, tab } = await createPage();
    const { done: pending } = await waiting(tab.id, {
      url: "https://example.com/never",
      waitUntil: "commit",
      timeoutMs: 60000,
    });
    // The wait sleeps outside its space lane, so another request runs.
    const snapshot = await request(`/tabs/${tab.id}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect((await snapshot.json()).text).toBe("Hello from the agent page");
    const started = Date.now();
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    const taken = await failure(await pending);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(taken.status).toBe(409);
    expect(taken.error).toMatchObject({
      code: "human_control",
      reason: "manual",
    });
  });

  // A load-state wait and its answer.
  const waitForLoadState = (tabId: string, body: Record<string, unknown>) => {
    const done = request(`/tabs/${tabId}/wait-for-load-state`, "POST", body);
    void done.catch(() => {});
    return done;
  };
  // A load-state wait that is listening, so the page's own events reach it.
  const judging = async (tabId: string, body: Record<string, unknown>) => {
    const done = waitForLoadState(tabId, body);
    await sleep(25);
    return { done };
  };
  // A tab's navigation log starts with its first wait or navigation, so a
  // test that drives the page's own events opens it first.
  const tracking = async (tabId: string) => {
    const started = await waitForUrl(tabId, {
      url: "**",
      waitUntil: "commit",
    });
    expect(started.status).toBe(200);
  };
  // A subresource of the page, in flight until it finishes.
  const inFlight = (page: FakeContents, requestId: string, url: string) =>
    page.emitProtocol("Network.requestWillBeSent", {
      requestId,
      loaderId: "loader-2",
      documentURL: "https://example.com/feed",
      request: { url, method: "GET", headers: {} },
      type: "Fetch",
    });
  const finished = (page: FakeContents, requestId: string) =>
    page.emitProtocol("Network.loadingFinished", { requestId });

  it("domcontentloaded needs the handlers finished, not readyState interactive", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    await tracking(tab.id);
    const frame = mainFrame(page, "loader-2");
    frame.start("https://example.com/next");
    frame.commit("https://example.com/next");
    // The page would answer readyState interactive with its DOMContentLoaded
    // handlers still running, which is not the state the agent asked for.
    page.result = {
      ok: true,
      readyState: "interactive",
      domContentLoaded: false,
      load: false,
    };
    const { done: pending } = await judging(tab.id, {
      state: "domcontentloaded",
      timeoutMs: 5000,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await sleep(150);
    expect(settled).toBe(false);
    // Nothing was read from the page: the document's own event decides.
    expect(page.scripts).toEqual([]);
    frame.lifecycle("DOMContentLoaded");
    const answered = await pending;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({ id: tab.id, managed: true }),
      state: "domcontentloaded",
    });
    expect(controller.activity.at(-1)).toMatchObject({
      spaceId: tab.spaceId,
      message: "Agent observed a page condition",
    });
    // The batch step judges the same document, which has reached the state.
    const batch = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [{ type: "wait-for-load-state", state: "domcontentloaded" }],
    });
    expect(batch.status).toBe(200);
    expect(await batch.json()).toMatchObject({
      ok: true,
      results: [
        {
          index: 0,
          type: "wait-for-load-state",
          result: { ok: true, state: "domcontentloaded" },
        },
      ],
    });
  });

  it("load follows a navigation in flight at entry", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    await tracking(tab.id);
    const first = mainFrame(page, "loader-2");
    first.start("https://example.com/one");
    first.commit("https://example.com/one");
    first.lifecycle("load");
    // A cross-document navigation is already in flight, so the document that
    // loaded is not the one the wait judges.
    const second = mainFrame(page, "loader-3");
    second.start("https://example.com/two");
    const { done: pending } = await judging(tab.id, {
      state: "load",
      timeoutMs: 5000,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await sleep(150);
    expect(settled).toBe(false);
    second.commit("https://example.com/two");
    await sleep(150);
    expect(settled).toBe(false);
    second.lifecycle("load");
    const answered = await pending;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ ok: true, state: "load" });
  });

  it("a navigation that fails during the wait ends it", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    await tracking(tab.id);
    const first = mainFrame(page, "loader-2");
    first.start("https://example.com/one");
    first.commit("https://example.com/one");
    const { done: pending } = await judging(tab.id, {
      state: "load",
      timeoutMs: 5000,
    });
    const second = mainFrame(page, "loader-3");
    second.start("https://example.com/two");
    second.request("https://example.com/two");
    second.failed("net::ERR_NAME_NOT_RESOLVED");
    const failed = await failure(await pending);
    expect(failed.status).toBe(422);
    expect(failed.error).toMatchObject({
      code: "navigation_failed",
      url: "https://example.com/two",
      netError: "ERR_NAME_NOT_RESOLVED",
    });
  });

  it("an end without a document keeps the old one", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    await tracking(tab.id);
    const first = mainFrame(page, "loader-2");
    first.start("https://example.com/one");
    first.commit("https://example.com/one");
    first.lifecycle("load");
    const second = mainFrame(page, "loader-3");
    second.start("https://example.com/two");
    const { done: pending } = await judging(tab.id, {
      state: "load",
      timeoutMs: 5000,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await sleep(100);
    expect(settled).toBe(false);
    // The navigation stopped without committing, so the page still shows the
    // document that loaded.
    second.stop();
    const answered = await pending;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ ok: true, state: "load" });
  });

  it("networkidle waits for load and a quiet window, and names what is pending", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    await tracking(tab.id);
    const frame = mainFrame(page, "loader-2");
    frame.start("https://example.com/feed");
    frame.commit("https://example.com/feed");
    frame.lifecycle("load");
    inFlight(page, "r1", "https://example.com/a.json");
    inFlight(page, "r2", "https://example.com/b.json");
    const { done: pending } = await judging(tab.id, {
      state: "networkidle",
      idleMs: 200,
      timeoutMs: 5000,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await sleep(150);
    expect(settled).toBe(false);
    const quiet = Date.now();
    finished(page, "r1");
    finished(page, "r2");
    const answered = await pending;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({
      ok: true,
      state: "networkidle",
    });
    expect(Date.now() - quiet).toBeGreaterThanOrEqual(190);
    // A timeout names the state, the document and what is still in flight.
    const long = `https://example.com/${"q".repeat(260)}`;
    inFlight(page, "r3", "https://example.com/c.json");
    inFlight(page, "r4", long);
    inFlight(page, "r5", "https://example.com/e.json");
    inFlight(page, "r6", "https://example.com/f.json");
    const timedOut = await failure(
      await waitForLoadState(tab.id, { state: "networkidle", timeoutMs: 150 }),
    );
    expect(timedOut.status).toBe(504);
    expect(timedOut.error).toMatchObject({
      code: "wait_timeout",
      message:
        "The page did not reach networkidle within 150 ms. It is at https://example.com/feed with readyState complete.",
      awaited: "load_state",
      timeoutMs: 150,
      state: "networkidle",
      url: "https://example.com/feed",
      readyState: "complete",
      inflight: 4,
      pending: [
        "https://example.com/c.json",
        long.slice(0, 200),
        "https://example.com/e.json",
      ],
    });
  });

  it("a document the tracker never saw commit is probed for its state", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    page.result = {
      ok: true,
      readyState: "loading",
      domContentLoaded: false,
      load: false,
    };
    const timedOut = await failure(
      await waitForLoadState(tab.id, { state: "load", timeoutMs: 150 }),
    );
    expect(timedOut.status).toBe(504);
    expect(timedOut.error).toMatchObject({
      code: "wait_timeout",
      awaited: "load_state",
      state: "load",
      url: "https://example.com/",
      readyState: "loading",
    });
    // One fixed read, and no field of a networkidle wait.
    expect(
      page.scripts.filter(
        (item) => item.code === `(${PAGE_STATE_SOURCE})("loadProbe")`,
      ),
    ).toHaveLength(1);
    expect(timedOut.error.inflight).toBeUndefined();
    expect(timedOut.error.pending).toBeUndefined();
  });

  it("load-state fields are enforced", async () => {
    const { tab } = await createPage();
    for (const body of [
      { idleMs: 10001 },
      { timeoutMs: 60001 },
      { state: "idle" },
    ]) {
      const { status, error } = await failure(
        await request(`/tabs/${tab.id}/wait-for-load-state`, "POST", body),
      );
      expect(status, JSON.stringify(body)).toBe(400);
      expect(error, JSON.stringify(body)).toMatchObject({
        code: "invalid_field",
        field: Object.keys(body)[0],
      });
    }
    // The step takes the same fields, and the plan is checked before it runs.
    const step = await failure(
      await request(`/tabs/${tab.id}/actions`, "POST", {
        actions: [{ type: "wait-for-load-state", idleMs: -1 }],
      }),
    );
    expect(step.status).toBe(400);
    expect(step.error).toMatchObject({
      code: "invalid_field",
      field: "idleMs",
    });
    expect(controller.contents.scripts).toEqual([]);
  });

  it("withholds snapshots and click coordinates that cross a document navigation", async () => {
    const { tab } = await createPage();
    for (const operation of ["snapshot", "click", "press", "drag"]) {
      controller.contents.result = () => {
        controller.contents.emit("did-start-navigation", {
          isMainFrame: true,
          isSameDocument: false,
        });
        return {
          ok: true,
          text: "previous page",
          x: 20,
          y: 30,
          from: { x: 20, y: 30 },
          to: { x: 60, y: 90 },
        };
      };
      const response = await request(
        `/tabs/${tab.id}/${operation}`,
        "POST",
        operation === "snapshot"
          ? {}
          : operation === "press"
            ? { key: "Enter", ref: "@e1" }
            : operation === "drag"
              ? { source: { ref: "@e1" }, target: { ref: "@e2" } }
              : { ref: "@e1" },
      );
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("page_changed");
      expect(controller.contents.inputs).toEqual([]);
    }
  });

  it("stops native input when navigation begins before the press", async () => {
    const { tab } = await createPage();
    controller.contents.result = { ok: true, x: 20, y: 30 };
    controller.contents.afterInput = () =>
      controller.contents.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: false,
      });
    expect(
      (await request(`/tabs/${tab.id}/click`, "POST", { ref: "@e1" })).status,
    ).toBe(409);
    expect(
      controller.contents.inputs.map((input) => input.parameters.type),
    ).toEqual(["mouseMoved"]);
    expectOneAttach();
  });

  it("still releases the mouse when a valid press triggers navigation", async () => {
    const { tab } = await createPage();
    controller.contents.result = { ok: true, x: 20, y: 30 };
    controller.contents.afterInput = () => {
      if (controller.contents.inputs.at(-1)?.parameters.type === "mousePressed")
        controller.contents.emit("did-start-navigation", {
          isMainFrame: true,
          isSameDocument: false,
        });
    };
    expect(
      (await request(`/tabs/${tab.id}/click`, "POST", { ref: "@e1" })).status,
    ).toBe(200);
    expect(
      controller.contents.inputs.map((input) => input.parameters.type),
    ).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
  });

  // A page answering drag, input-count and frame operations. `dragging`
  // reports whether the page started an HTML drag.
  const dragPage = (dragging: () => boolean) => (code: string) =>
    code.includes(')("drag",')
      ? { ok: true, from: { x: 10, y: 20 }, to: { x: 110, y: 220 } }
      : code.includes(')("input",')
        ? {
            ok: true,
            mouse: controller.contents.inputs.filter(
              (input) => input.parameters.type === "mousePressed",
            ).length,
            key: 0,
            drag: dragging() ? 1 : 0,
          }
        : { ok: true };
  const dragData = {
    items: [{ mimeType: "text/plain", data: "shot-1" }],
    dragOperationsMask: 17,
  };
  const dragBody = { source: { ref: "@e1" }, target: { selector: "#zone" } };
  // Chromium reports an HTML drag once the pressed mouse moves past its
  // threshold, if the page lets it start.
  const startDragOnMove = () => {
    let started = false;
    controller.contents.afterInput = () => {
      const last = controller.contents.inputs.at(-1)!.parameters;
      if (!started && last.type === "mouseMoved" && last.buttons === 1) {
        started = true;
        controller.contents.emitProtocol("Input.dragIntercepted", {
          data: dragData,
        });
      }
    };
    return () => started;
  };
  const steps = () =>
    controller.contents.inputs.map((input) =>
      input.method === "Input.setInterceptDrags"
        ? `intercept ${input.parameters.enabled}`
        : (input.parameters.type as string),
    );

  it("drags with pressed mouse moves past drag thresholds when the page starts no HTML drag", async () => {
    const { tab } = await createPage();
    controller.contents.result = dragPage(() => false);
    const response = await request(`/tabs/${tab.id}/drag`, "POST", dragBody);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      url: "https://example.com/",
      drag: "mouse",
    });
    expect(controller.contents.scripts[0].code).toContain(
      ')("drag",{"source":{"ref":"@e1"},"target":{"selector":"#zone"}}',
    );
    expect(steps()).toEqual([
      "intercept true",
      "mouseMoved",
      "mousePressed",
      ...Array(10).fill("mouseMoved"),
      "mouseReleased",
      "intercept false",
    ]);
    const mouse = controller.contents.inputs
      .filter((input) => input.method === "Input.dispatchMouseEvent")
      .map((input) => input.parameters);
    expect(mouse[1]).toMatchObject({ x: 10, y: 20, button: "left", buttons: 1 });
    // The first pressed move goes past Chromium's 4 pixel and the pointer
    // libraries' 5 to 8 pixel thresholds.
    expect(
      Math.hypot((mouse[2].x as number) - 10, (mouse[2].y as number) - 20),
    ).toBeGreaterThanOrEqual(9);
    expect(mouse.slice(2, -1).every((move) => move.buttons === 1)).toBe(true);
    expect(mouse.at(-2)).toMatchObject({ x: 110, y: 220 });
    expect(mouse.at(-1)).toMatchObject({
      type: "mouseReleased",
      x: 110,
      y: 220,
      button: "left",
    });
    expectOneAttach();
    expect(controller.activity.at(-1)!.message).toBe("Agent dragged an element");
  });

  it("moves an HTML drag the page starts with drag events and sends no mouse release after the drop", async () => {
    const { tab } = await createPage();
    controller.contents.result = dragPage(startDragOnMove());
    const response = await request(`/tabs/${tab.id}/drag`, "POST", dragBody);
    expect(response.status).toBe(200);
    expect((await response.json()).drag).toBe("html5");
    expect(steps()).toEqual([
      "intercept true",
      "mouseMoved",
      "mousePressed",
      "mouseMoved",
      "dragEnter",
      ...Array(9).fill("dragOver"),
      "drop",
      "intercept false",
    ]);
    const drags = controller.contents.inputs.filter(
      (input) => input.method === "Input.dispatchDragEvent",
    );
    expect(drags.every((input) => input.parameters.data === dragData)).toBe(true);
    expect(drags.at(-1)!.parameters).toMatchObject({ x: 110, y: 220 });
    expectOneAttach();
  });

  it("ends an HTML drag when the person takes over, without a drop or mouse release", async () => {
    const { tab, space } = await createPage();
    const started = startDragOnMove();
    const startDrag = controller.contents.afterInput!;
    controller.contents.result = dragPage(started);
    controller.contents.afterInput = () => {
      startDrag();
      if (controller.contents.inputs.at(-1)!.parameters.type === "dragOver") {
        controller.state.spaces.find((item) => item.id === space.id)!.owner =
          "human";
        controller.emit();
      }
    };
    const response = await request(`/tabs/${tab.id}/drag`, "POST", dragBody);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("human_control");
    expect(steps().slice(-4)).toEqual([
      "dragEnter",
      "dragOver",
      "dragCancel",
      "intercept false",
    ]);
    expect(steps()).not.toContain("mouseReleased");
    await expect.poll(() => controller.contents.debugger.attached).toBe(false);
    expect(controller.contents.debugger.attachCount).toBe(1);
  });

  it("releases the mouse and reports an HTML drag that never reaches Kamapathy", async () => {
    const { tab } = await createPage();
    let pressed = false;
    controller.contents.result = dragPage(() => pressed);
    controller.contents.afterInput = () => {
      if (controller.contents.inputs.at(-1)!.parameters.type === "mousePressed")
        pressed = true;
    };
    const response = await request(`/tabs/${tab.id}/drag`, "POST", dragBody);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("drag_not_delivered");
    expect(steps().slice(-3)).toEqual([
      "mouseMoved",
      "mouseReleased",
      "intercept false",
    ]);
    expectOneAttach();
  });

  it("refuses to drag when Chromium cannot take over drags", async () => {
    const { tab } = await createPage();
    controller.contents.result = dragPage(() => false);
    controller.contents.afterInput = () => {
      const last = controller.contents.inputs.at(-1)!;
      if (last.method === "Input.setInterceptDrags" && last.parameters.enabled)
        throw new Error("Input.setInterceptDrags is not supported");
    };
    const response = await request(`/tabs/${tab.id}/drag`, "POST", dragBody);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("drag_unavailable");
    expect(
      controller.contents.inputs.some(
        (input) => input.method === "Input.dispatchMouseEvent",
      ),
    ).toBe(false);
    expectOneAttach();
  });

  it("clicks a control drawn with no size in the page, without native input, and reports it", async () => {
    const { tab } = await createPage();
    controller.contents.result = (code: string) =>
      code.includes(')("target",')
        ? { ok: true, empty: true, rebound: ["@e1"] }
        : { ok: true };
    const response = await request(`/tabs/${tab.id}/click`, "POST", {
      ref: "@e1",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      url: "https://example.com/",
      fallback: "dom_click",
      rebound: ["@e1"],
    });
    expect(controller.contents.inputs).toEqual([]);
    expect(
      controller.contents.scripts.map(
        (script) =>
          script.code.slice(script.code.lastIndexOf(')("') + 3).split('"')[0],
      ),
    ).toEqual(["target", "click"]);
  });

  it("reports refs the page moved to a redrawn control for clicks, key presses and drags", async () => {
    const { tab } = await createPage();
    controller.contents.result = (code: string) =>
      code.includes(')("target",')
        ? { ok: true, x: 25, y: 45, rebound: ["@e1"] }
        : code.includes(')("focus",')
          ? { ok: true, rebound: ["@e2"] }
          : code.includes(')("drag",')
            ? {
                ok: true,
                from: { x: 10, y: 20 },
                to: { x: 110, y: 220 },
                rebound: ["@e3", "@e4"],
              }
            : code.includes(')("input",')
              ? {
                  ok: true,
                  mouse: steps().filter((step) => step === "mousePressed")
                    .length,
                  key: steps().filter((step) => step === "keyDown").length,
                  drag: 0,
                }
              : { ok: true };
    const results = await (
      await request(`/tabs/${tab.id}/actions`, "POST", {
        actions: [
          { type: "click", ref: "@e1" },
          { type: "press", key: "Enter", ref: "@e2" },
          { type: "drag", source: { ref: "@e3" }, target: { ref: "@e4" } },
        ],
      })
    ).json();
    expect(results.ok).toBe(true);
    expect(results.results.map((entry: any) => entry.result.rebound)).toEqual([
      ["@e1"],
      ["@e2"],
      ["@e3", "@e4"],
    ]);
  });

  it("validates drag endpoints and scroll targets before touching the page", async () => {
    const { tab } = await createPage();
    for (const body of [
      {},
      { source: "@e1", target: { ref: "@e2" } },
      { source: { ref: "@e1" } },
      { source: [], target: { ref: "@e2" } },
      { source: { ref: "@e1", selector: "#a" }, target: { ref: "@e2" } },
      { source: { ref: "@e0" }, target: { ref: "@e2" } },
      { source: { ref: "@e1" }, target: { selector: "" } },
    ]) {
      const response = await request(`/tabs/${tab.id}/drag`, "POST", body);
      expect(response.status).toBe(400);
    }
    const batch = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "snapshot" },
        { type: "drag", source: { ref: "@e1" }, target: {} },
      ],
    });
    expect(batch.status).toBe(400);
    const unknown = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [{ type: "hover", ref: "@e1" }],
    });
    expect((await unknown.json()).error.message).toContain("drag");
    for (const body of [
      { direction: "down", ref: "@e1", selector: "#panel" },
      { direction: "down", ref: "#panel" },
    ])
      expect(
        (await request(`/tabs/${tab.id}/scroll`, "POST", body)).status,
      ).toBe(400);
    expect(controller.contents.scripts).toEqual([]);
    controller.contents.result = {
      ok: true,
      scrolled: "element",
      selector: "#panel",
      x: 0,
      y: 600,
      moved: true,
    };
    const scrolled = await request(`/tabs/${tab.id}/scroll`, "POST", {
      direction: "down",
      ref: "@e3",
    });
    expect(await scrolled.json()).toEqual(controller.contents.result);
    expect(controller.contents.scripts.at(-1)!.code).toContain(
      ')("scroll",{"direction":"down","pixels":600,"ref":"@e3"}',
    );
  });

  it("honors wait deadlines during loading and stalled page evaluation", async () => {
    const { tab } = await createPage();
    controller.contents.isLoadingMainFrame = () => true;
    controller.contents.result = new Promise(() => {});
    for (const timeoutMs of [50, 0]) {
      const start = performance.now();
      const response = await request(`/tabs/${tab.id}/wait`, "POST", {
        text: "Missing",
        timeoutMs,
      });
      expect(response.status).toBe(408);
      expect((await response.json()).error.code).toBe("wait_timeout");
      expect(performance.now() - start).toBeLessThan(1500);
    }
  });

  it("bounds wait and scroll without accepting arbitrary code or invalid motion", async () => {
    const { tab } = await createPage();
    controller.contents.result = { ok: true, matched: false };
    const timeout = await request(`/tabs/${tab.id}/wait`, "POST", {
      selector: "#late",
      timeoutMs: 0,
    });
    expect(timeout.status).toBe(408);
    expect((await timeout.json()).error.code).toBe("wait_timeout");
    expect(
      (await request(`/tabs/${tab.id}/wait`, "POST", { timeoutMs: 15001 }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(`/tabs/${tab.id}/scroll`, "POST", {
          direction: "down",
          pixels: 2001,
        })
      ).status,
    ).toBe(400);
    controller.contents.result = { ok: true, x: 0, y: 600 };
    expect(
      (await request(`/tabs/${tab.id}/scroll`, "POST", { direction: "down" }))
        .status,
    ).toBe(200);
    expect(controller.contents.scripts.at(-1)!.code).toContain(
      ')("scroll",{"direction":"down","pixels":600}',
    );
  });

  it("passes only selected file bytes to a fixed isolated-world action", async () => {
    const { tab } = await createPage();
    controller.contents.result = { ok: true, selected: 1 };
    const body = uploadBody({
      files: [{ name: 'Listing "draft".png', type: "image/png", data: "AAEC/w==" }],
    });
    const response = await request(`/tabs/${tab.id}/upload`, "POST", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, selected: 1 });
    expect(controller.contents.scripts).toHaveLength(1);
    expect(controller.contents.scripts[0].world).toBe("kamapathy");
    expect(controller.contents.scripts[0].code).toContain(`)("upload",${JSON.stringify(body)},`);
    expect(controller.contents.inputs).toEqual([]);
  });

  it("requires a file input ref and rejects malformed file metadata before execution", async () => {
    const { tab } = await createPage();
    const validFile = uploadBody().files[0];
    const cases = [
      { selector: 'input[type="file"]', files: [validFile] },
      uploadBody({ selector: "#upload" }),
      uploadBody({ ref: "@e0" }),
      uploadBody({ files: [] }),
      uploadBody({ files: Array(9).fill(validFile) }),
      uploadBody({ files: [null] }),
      uploadBody({ files: [{ ...validFile, name: "../secret.png" }] }),
      uploadBody({ files: [{ ...validFile, name: "C:\\secret.png" }] }),
      uploadBody({ files: [{ ...validFile, name: "." }] }),
      uploadBody({ files: [{ ...validFile, name: "name\u0000.png" }] }),
      uploadBody({ files: [{ ...validFile, type: "image/png\r\nOther: value" }] }),
      uploadBody({ files: [{ ...validFile, type: "image/*" }] }),
      ...["not base64", "AAA", "AB==", "AA==\n", "=AAA", "AA===", "AA_="].map((data) =>
        uploadBody({ files: [{ ...validFile, data }] })),
      uploadBody({ files: [{ name: "listing.png", type: "image/png", path: "/private/selected.png" }] }),
    ];
    for (const body of cases) {
      const response = await request(`/tabs/${tab.id}/upload`, "POST", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(controller.contents.scripts).toEqual([]);
  });

  it("keeps ordinary requests at 64 KiB and bounds the dedicated upload body", async () => {
    const { tab } = await createPage();
    controller.contents.result = { ok: true, selected: 1 };
    const data = Buffer.alloc(70000, 42).toString("base64");
    expect(await declaredSize(`/tabs/${tab.id}/fill`, 70000)).toBe(413);
    expect((await request(`/tabs/${tab.id}/upload`, "POST", uploadBody({
      files: [{ name: "bundle.aab", type: "application/octet-stream", data }],
    }))).status).toBe(200);
    const tooLarge = await declaredSize(`/tabs/${tab.id}/upload`, 24 * 1024 * 1024 + 1);
    expect(tooLarge).toBe(413);
    expect(controller.contents.scripts).toHaveLength(1);
  });

  it("rejects decoded files exceeding the aggregate limit", async () => {
    const { tab } = await createPage();
    const data = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
    const response = await request(`/tabs/${tab.id}/upload`, "POST", uploadBody({
      files: ["first.aab", "second.aab"].map((name) => ({ name, type: "application/octet-stream", data })),
    }));
    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("files_too_large");
    expect(controller.contents.scripts).toEqual([]);
  });

  it("denies uploads into personal, ungranted, and handed-off tabs", async () => {
    const personal = controller.state.tabs[0];
    const manual = controller.state.tabs.find((tab) => tab.spaceId === "manual-agent")!;
    for (const tab of [personal, manual])
      expect((await request(`/tabs/${tab.id}/upload`, "POST", uploadBody())).status).toBe(404);
    const { space, tab } = await createPage();
    await controller.dispatch({ type: "space:ownership", id: space.id, owner: "human" });
    expect((await request(`/tabs/${tab.id}/upload`, "POST", uploadBody())).status).toBe(409);
    expect(controller.accessedTabs).toEqual([]);
    expect(controller.contents.scripts).toEqual([]);
  });

  it("preserves stale-ref failures and never falls back to another file input", async () => {
    const { tab } = await createPage();
    controller.contents.result = { ok: false, code: "stale_ref", error: "Observe the current file input." };
    const response = await request(`/tabs/${tab.id}/upload`, "POST", uploadBody());
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("stale_ref");
    expect(controller.contents.scripts).toHaveLength(1);
    expect(controller.contents.inputs).toEqual([]);
  });

  it("rejects uploads when the document navigates during the incoming transfer", async () => {
    const { tab } = await createPage();
    const transfer = await beginUpload(tab.id);
    try {
      controller.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
      transfer.finish();
      const response = await transfer.result;
      expect(response.status).toBe(409);
      expect(response.data.error.code).toBe("page_changed");
      expect(controller.contents.scripts).toEqual([]);
    } finally {
      transfer.client.destroy();
    }
  });

  it("honors human takeover during the incoming transfer", async () => {
    const { space, tab } = await createPage();
    const transfer = await beginUpload(tab.id);
    try {
      await controller.dispatch({ type: "space:ownership", id: space.id, owner: "human" });
      transfer.finish();
      const response = await transfer.result;
      expect(response.status).toBe(409);
      expect(response.data.error.code).toBe("human_control");
      expect(controller.contents.scripts).toEqual([]);
    } finally {
      transfer.client.destroy();
    }
  });

  it("permits one upload transfer and releases its reservation after validation failure", async () => {
    const { tab } = await createPage();
    const transfer = await beginUpload(tab.id);
    try {
      const simultaneous = await request(`/tabs/${tab.id}/upload`, "POST", uploadBody());
      expect(simultaneous.status).toBe(429);
      expect((await simultaneous.json()).error.code).toBe("upload_busy");
      controller.contents.result = { ok: false, code: "stale_ref", error: "Observe again." };
      transfer.finish();
      expect((await transfer.result).status).toBe(409);
      controller.contents.result = { ok: true, selected: 1 };
      expect((await request(`/tabs/${tab.id}/upload`, "POST", uploadBody())).status).toBe(200);
    } finally {
      transfer.client.destroy();
    }
  });

  it("releases the upload reservation when its client disconnects before the body completes", async () => {
    const { tab } = await createPage();
    const transfer = await beginUpload(tab.id);
    const interrupted = transfer.result.catch((error: NodeJS.ErrnoException) => error.code);
    transfer.client.destroy();
    expect(await interrupted).toBe("ECONNRESET");
    controller.contents.result = { ok: true, selected: 1 };
    await expect.poll(async () => {
      const response = await request(`/tabs/${tab.id}/upload`, "POST", uploadBody());
      await response.text();
      return response.status;
    }).toBe(200);
    expect(controller.contents.scripts).toHaveLength(1);
  });

  it("rejects an upload if its tab's native page is replaced during transfer", async () => {
    const { tab } = await createPage();
    const transfer = await beginUpload(tab.id);
    try {
      controller.contents = new FakeContents();
      transfer.finish();
      const response = await transfer.result;
      expect(response.status).toBe(409);
      expect(response.data.error.code).toBe("page_changed");
      expect(controller.contents.scripts).toEqual([]);
    } finally {
      transfer.client.destroy();
    }
  });

  it("withholds upload results when ownership changes during page execution", async () => {
    const { space, tab } = await createPage();
    let finish!: (value: unknown) => void;
    controller.contents.result = new Promise((resolve) => { finish = resolve; });
    const pending = request(`/tabs/${tab.id}/upload`, "POST", uploadBody());
    await expect.poll(() => controller.contents.scripts.length).toBe(1);
    await controller.dispatch({ type: "space:ownership", id: space.id, owner: "human" });
    finish({ ok: true, selected: 1 });
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("human_control");
  });

  // How a request ended: its status and error code, or "closed" if its
  // connection dropped first.
  const settled = (response: Promise<Response>) =>
    response.then(
      async (item) => ({
        status: item.status,
        code: (await item.json()).error?.code,
      }),
      () => "closed",
    );
  // What a request settled to within the time given, else "pending".
  const within = <T>(result: Promise<T>, milliseconds: number) =>
    Promise.race([
      result,
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), milliseconds),
      ),
    ]);
  // A snapshot whose page read waits until it is released.
  const heldSnapshot = async (tabId: string) => {
    let release: (() => void) | undefined;
    controller.pages.get(tabId)!.result = () =>
      new Promise((resolve) => {
        release = () => resolve({ text: "" });
      });
    const result = settled(request(`/tabs/${tabId}/snapshot`));
    await expect.poll(() => release).toBeDefined();
    return { result, release: () => release!() };
  };

  it("reports API level and engine versions from health before the queue", async () => {
    const { tab } = await createPage();
    controller.contents.result = new Promise(() => {});
    const running = request(`/tabs/${tab.id}/snapshot`);
    const response = await request("/health");
    expect(response.status).toBe(200);
    // Electron's and Chromium's versions are present only in the app.
    expect(await response.json()).toEqual({
      status: "ok",
      version: controller.state.version,
      apiLevel: API_LEVEL,
      versions: { node: process.versions.node, v8: process.versions.v8 },
    });
    void running.catch(() => {});
  });

  it("rejects unknown fields on every route and batch action before any page step", async () => {
    const { space, tab } = await createPage();
    // A minimal valid body for each route that reads one.
    const SAMPLES: Record<string, Record<string, unknown>> = {
      "POST /spaces": { name: "Research", isolated: false, pageBudget: 5, reuse: true },
      "POST /tabs/:id/adopt": {},
      "POST /tabs/:id/release": {},
      "POST /spaces/:id/handoff": {},
      "POST /spaces/:id/resume": {},
      "POST /spaces/:id/wait-for-control": { timeoutMs: 1000 },
      "POST /spaces/:id/finish": { keep: "all" },
      "POST /space-requests": { reason: "Book a table" },
      "POST /spaces/:id/tabs": { url: "https://example.com/" },
      "POST /tabs/:id/navigate": { url: "https://example.com/" },
      "POST /tabs/:id/reload": {},
      "POST /tabs/:id/wait-for-url": { url: "https://example.com/*" },
      "POST /tabs/:id/wait-for-load-state": { state: "commit" },
      "POST /tabs/:id/snapshot": {},
      "POST /tabs/:id/actions": { actions: [{ type: "snapshot" }] },
      "POST /tabs/:id/click": { ref: "@e1" },
      "POST /tabs/:id/fill": { ref: "@e1", value: "x" },
      "POST /tabs/:id/press": { key: "Enter" },
      "POST /tabs/:id/scroll": { direction: "down" },
      "POST /tabs/:id/drag": { source: { ref: "@e1" }, target: { ref: "@e2" } },
      "POST /tabs/:id/wait": { text: "Done" },
      "POST /tabs/:id/upload": uploadBody(),
    };
    const tabs = controller.state.tabs.length;
    for (const route of ROUTES.filter((item) => item.method === "POST" && item.body)) {
      const key = routeKey(route);
      expect(SAMPLES, key).toHaveProperty(key);
      const path = route.path.replace(
        ":id",
        route.path.startsWith("/spaces/") ? space.id : tab.id,
      );
      const response = await request(path, "POST", { ...SAMPLES[key], extra: true });
      expect(response.status, key).toBe(400);
      expect((await response.json()).error, key).toEqual({
        code: "unknown_field",
        message: `${key} has no field "extra". Allowed: ${Object.keys(route.body!).join(", ") || "none"}.`,
        field: "extra",
        allowed: Object.keys(route.body!),
        route: key,
        apiLevel: API_LEVEL,
      });
    }
    const response = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [{ type: "snapshot" }, { type: "click", ref: "@e1", button: "right" }],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatchObject({
      code: "unknown_field",
      field: "button",
      index: 1,
      action: "click",
      allowed: ["type", "ref", "selector"],
      route: "POST /tabs/:id/actions",
    });
    expect(controller.contents.scripts).toEqual([]);
    expect(controller.contents.inputs).toEqual([]);
    expect(controller.state.tabs).toHaveLength(tabs);
    expect(controller.state.spaces.find((item) => item.id === space.id)?.owner).toBe("agent");
  });

  it("names unknown routes with the id replaced", async () => {
    const { tab } = await createPage();
    const response = await request(`/tabs/${tab.id}/goto`, "POST", {
      url: "https://example.com/",
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toEqual({
      code: "route_not_found",
      message: `Kamapathy ${controller.state.version} (API level ${API_LEVEL}) has no route POST /tabs/:id/goto. A newer client may need a newer Kamapathy.`,
      method: "POST",
      route: "/tabs/:id/goto",
      apiLevel: API_LEVEL,
      version: controller.state.version,
    });
    expect((await (await request("/nothing/here")).json()).error).toMatchObject({
      method: "GET",
      route: "/nothing/here",
    });
  });

  it("marks transient failures retryable only before anything reached the page", async () => {
    const { tab } = await createPage();
    const click = async () => {
      const response = await request(`/tabs/${tab.id}/click`, "POST", { ref: "@e1" });
      return { status: response.status, error: (await response.json()).error };
    };
    // A covered target is reported before any input.
    controller.contents.result = {
      ok: false,
      code: "element_obscured",
      error: "Another element covers the target.",
    };
    expect(await click()).toEqual({
      status: 409,
      error: {
        code: "element_obscured",
        message: "Another element covers the target.",
        retryable: true,
      },
    });
    controller.contents.result = { ok: false, code: "stale_ref", error: "Take a fresh snapshot." };
    expect(await click()).toEqual({
      status: 409,
      error: { code: "stale_ref", message: "Take a fresh snapshot." },
    });
    // Input the page never received was still sent.
    controller.contents.result = (code: string) =>
      code.includes(')("input",') ? { ok: true, mouse: 0, key: 0 } : { ok: true, x: 25, y: 45 };
    expect(await click()).toMatchObject({
      status: 409,
      error: { code: "input_not_delivered", dispatched: true },
    });
    expect((await click()).error.retryable).toBeUndefined();
  });

  it("keeps 408 wait_timeout on the legacy wait route and in a batch wait step", async () => {
    const { tab } = await createPage();
    controller.contents.result = { ok: true, matched: false };
    const response = await request(`/tabs/${tab.id}/wait`, "POST", {
      text: "Never",
      timeoutMs: 0,
    });
    expect(response.status).toBe(408);
    expect((await response.json()).error).toEqual({
      code: "wait_timeout",
      message: "The requested page condition was not observed before the timeout.",
      awaited: "condition",
      timeoutMs: 0,
      retryable: true,
    });
    const batch = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [{ type: "snapshot" }, { type: "wait", text: "Never", timeoutMs: 0 }],
    });
    expect(batch.status).toBe(408);
    expect(await batch.json()).toMatchObject({
      ok: false,
      failedIndex: 1,
      error: { code: "wait_timeout", awaited: "condition", timeoutMs: 0, retryable: true },
    });
  });

  it("returns 404 for a tab outside the managed spaces before reading its body", async () => {
    const personal = controller.state.tabs[0];
    const manual = controller.state.tabs.find(
      (tab) => tab.spaceId === "manual-agent",
    )!;
    // The declared body never arrives, so only a refusal made before reading
    // it can answer.
    for (const tab of [personal, manual])
      expect(await declaredSize(`/tabs/${tab.id}/click`, 20)).toBe(404);
    expect(controller.accessedTabs).toEqual([]);
  });

  it("admits a request for a tab without a page in a managed space to its space lane", async () => {
    const one = await createPage();
    const two = await createPage();
    // Every agent space opens with a tab on the new tab page.
    const blank = controller.state.tabs.find(
      (tab) => tab.spaceId === one.space.id && tab.id !== one.tab.id,
    )!;
    const otherSpace = await heldSnapshot(two.tab.id);
    expect(
      await within(settled(request(`/tabs/${blank.id}/snapshot`)), 1000),
    ).toEqual({ status: 409, code: "no_web_page" });
    const sameSpace = await heldSnapshot(one.tab.id);
    const queued = settled(request(`/tabs/${blank.id}/snapshot`));
    expect(await within(queued, 100)).toBe("pending");
    sameSpace.release();
    expect(await sameSpace.result).toEqual({ status: 200 });
    expect(await queued).toEqual({ status: 409, code: "no_web_page" });
    otherSpace.release();
    expect(await otherSpace.result).toEqual({ status: 200 });
  });

  it("answers GET /spaces/:id/tabs while a snapshot runs in that space", async () => {
    const { space, tab } = await createPage();
    const snapshot = await heldSnapshot(tab.id);
    expect(
      await within(settled(request(`/spaces/${space.id}/tabs`)), 1000),
    ).toEqual({ status: 200 });
    snapshot.release();
    expect(await snapshot.result).toEqual({ status: 200 });
  });

  it("runs snapshots in different spaces at the same time", async () => {
    const one = await createPage();
    const two = await createPage();
    // The second page is read while the first read still runs.
    const first = await heldSnapshot(one.tab.id);
    const second = await heldSnapshot(two.tab.id);
    first.release();
    second.release();
    expect(await first.result).toEqual({ status: 200 });
    expect(await second.result).toEqual({ status: 200 });
  });

  it("runs a wait and a click in one space together", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    let clicked = false;
    page.result = (code: string) =>
      code.includes(')("check",')
        ? { ok: true, matched: clicked }
        : code.includes(')("input",')
          ? {
              ok: true,
              mouse: page.inputs.filter(
                (input) => input.parameters.type === "mousePressed",
              ).length,
              key: 0,
            }
          : { ok: true, x: 25, y: 45 };
    page.afterInput = () => {
      if (page.inputs.at(-1)!.parameters.type === "mouseReleased")
        clicked = true;
    };
    const wait = settled(
      request(`/tabs/${tab.id}/wait`, "POST", {
        text: "Delayed content ready",
        timeoutMs: 2000,
      }),
    );
    // The click arrives while the wait is checking the page.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const click = settled(
      request(`/tabs/${tab.id}/click`, "POST", { ref: "@e1" }),
    );
    expect(await click).toEqual({ status: 200 });
    expect(await wait).toEqual({ status: 200 });
  });

  it("refuses a 17th pending request in a space with busy scope space and retryable", async () => {
    const { tab } = await createPage();
    const running = await heldSnapshot(tab.id);
    controller.contents.result = { text: "" };
    const queued = Array.from({ length: 15 }, () =>
      settled(request(`/tabs/${tab.id}/snapshot`)),
    );
    // Let the queued requests reach the server.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const refused = await request(`/tabs/${tab.id}/snapshot`);
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toEqual({
      code: "busy",
      message: "This space has 16 requests waiting. Wait for them to finish.",
      scope: "space",
      retryable: true,
    });
    running.release();
    expect(await running.result).toEqual({ status: 200 });
    for (const result of await Promise.all(queued))
      expect(result).toEqual({ status: 200 });
  });

  it("installs the test probe only under KAMAPATHY_TEST_HOOKS=1 and removes it on close", async () => {
    const installed = () =>
      (globalThis as unknown as { __kamapathyTest?: TestProbe })
        .__kamapathyTest;
    const original = process.env.KAMAPATHY_TEST_HOOKS;
    // The server reads the variable once, at start, so each value gets a
    // fresh server and the variable is put back right after.
    const restart = async (value: string | undefined) => {
      await api.close();
      socket.cleanup();
      if (value === undefined) delete process.env.KAMAPATHY_TEST_HOOKS;
      else process.env.KAMAPATHY_TEST_HOOKS = value;
      try {
        socket = testSocket();
        api = await startAutomation(controller, { socketPath: socket.path });
        send = socketFetch(socket.path);
      } finally {
        if (original === undefined) delete process.env.KAMAPATHY_TEST_HOOKS;
        else process.env.KAMAPATHY_TEST_HOOKS = original;
      }
    };
    for (const value of [undefined, "0", "true"]) {
      await restart(value);
      expect(installed(), String(value)).toBeUndefined();
    }
    await restart("1");
    const probe = installed();
    expect(probe).toBeDefined();
    expect(Object.keys(probe!).sort()).toEqual([
      "attaches",
      "frames",
      "hasSession",
      "networkIdle",
      "ready",
    ]);
    const { tab } = await createPage();
    await expect.poll(() => probe!.attaches(tab.id)).toBe(1);
    expect(probe!.hasSession(tab.id)).toBe(true);
    const person = controller.state.tabs.find(
      (item) => item.spaceId === "manual-agent",
    )!;
    expect(probe!.attaches(person.id)).toBe(0);
    expect(probe!.hasSession(person.id)).toBe(false);
    await expect(probe!.frames(person.id)).rejects.toThrow("has no session");
    const frames = await probe!.frames(tab.id);
    expect(frames.map((frame) => [frame.path, frame.crossOrigin])).toEqual([
      ["", false],
    ]);
    controller.contents.result = { ok: true, readyState: "complete" };
    expect(await probe!.ready(tab.id, frames[0].frameId)).toBe("complete");
    const ready = controller.contents.scripts.at(-1)!;
    expect(ready.world).toBe("kamapathy");
    expect(ready.code.endsWith(')("ready",{},"internal")')).toBe(true);
    const asked = Date.now();
    expect(await probe!.networkIdle(tab.id, 50, 2000)).toBeGreaterThanOrEqual(
      asked,
    );
    await api.close();
    expect(installed()).toBeUndefined();
  });
});
