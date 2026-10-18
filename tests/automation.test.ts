import { statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RefBook } from "../electron/agent/refs";
import { FORMS, REF_HINT } from "../electron/agent/selectors";
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
  let refs: RefBook;
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
    const tab = (await response.json()).tab as BrowserState["tabs"][number];
    // The refs these checks send as a page's own: @e1 to @e4.
    refs.record(tab.id, [1, 2, 3, 4]);
    return { space, tab };
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
  // The payload each operation travelled with, read back from the scripts the
  // page ran. The namespace is the last argument, so the payload ends at the
  // last comma before a string.
  const payloads = (operation: string): Record<string, any>[] => {
    const marker = `)(${JSON.stringify(operation)},`;
    return controller.contents.scripts
      .filter((script) => script.code.includes(marker))
      .map((script) =>
        JSON.parse(
          script.code.slice(
            script.code.indexOf(marker) + marker.length,
            script.code.lastIndexOf(',"'),
          ),
        ),
      );
  };
  // One debugger attach serves a tab for as long as the agent has it.
  const expectOneAttach = () => {
    expect(controller.contents.debugger.attachCount).toBe(1);
    expect(controller.contents.debugger.attached).toBe(true);
  };
  beforeEach(async () => {
    controller = new FakeController();
    refs = new RefBook();
    socket = testSocket();
    api = await startAutomation(controller, { socketPath: socket.path, refs });
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
    expect(
      (
        await request(`/tabs/${tab.id}/navigate`, "POST", {
          url: "https://example.com/next",
        })
      ).status,
    ).toBe(200);
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
        `)("fill",${JSON.stringify({
          selector,
          query: {
            ast: { kind: "css", css: selector, raw: true },
            level: "enabled",
            mode: "strict",
            firstRef: payloads("fill")[0].query.firstRef,
          },
          value: 'quote " and newline\n',
        })},`,
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
      { scope: "window" },
      { header: "yes" },
      { root: 1 },
    ]) {
      expect(
        (await request(`/tabs/${tab.id}/snapshot`, "POST", body)).status,
      ).toBe(400);
    }
  });

  it("adds a header naming the page, space and tabs", async () => {
    const { space, tab } = await createPage();
    const blank = controller.state.tabs.find(
      (item) => item.spaceId === space.id && item.id !== tab.id,
    )!;
    const popup = controller.openPopup(tab.id, "https://example.com/receipt");
    const person = controller.openPersonTab(space.id);
    // A title is cleaned like other agent text and cut at 60 characters.
    blank.title = `‮${"x".repeat(70)}`;
    const headerOf = async (body?: Record<string, unknown>) =>
      (
        await (body === undefined
          ? request(`/tabs/${tab.id}/snapshot`)
          : request(`/tabs/${tab.id}/snapshot`, "POST", body)
        ).then((response) => response.json())
      ).header;
    const header = {
      page: { id: tab.id, label: "p2", title: "https://example.com/" },
      space: { id: space.id, name: "Research" },
      tabs: [
        {
          id: blank.id,
          label: "p1",
          title: `${"x".repeat(57)}...`,
          openedBy: "agent",
          managed: true,
        },
        {
          id: tab.id,
          label: "p2",
          title: "https://example.com/",
          openedBy: "agent",
          managed: true,
          current: true,
        },
        {
          id: popup.id,
          label: "p3",
          title: "https://example.com/receipt",
          openedBy: "page",
          managed: true,
        },
        {
          id: person.id,
          label: "p4",
          title: "New tab",
          openedBy: "person",
          managed: false,
        },
      ],
    };
    // GET takes the defaults, and a batch step carries the header too.
    expect(await headerOf()).toEqual(header);
    expect(await headerOf({})).toEqual(header);
    const batch = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [{ type: "snapshot" }],
    });
    expect((await batch.json()).results[0].result.header).toEqual(header);
    expect(await headerOf({ header: false })).toBeUndefined();
    // The budget appears only once the space is one page from its limit.
    controller.setPageBudget(space.id, 4);
    expect(await headerOf()).toEqual({
      ...header,
      budget: { used: 3, limit: 4 },
    });
    controller.setPageBudget(space.id, 20);
    controller.pdfTabs.add(tab.id);
    expect(await headerOf()).toEqual({ ...header, pdf: true });
  });

  it("refuses a root beside a selector, a malformed root and an unknown one", async () => {
    const { tab } = await createPage();
    const taking = (body: Record<string, unknown>) =>
      request(`/tabs/${tab.id}/snapshot`, "POST", body);
    const combined = await taking({ root: "@e1", selector: "#form" });
    expect(combined.status).toBe(400);
    expect((await combined.json()).error).toEqual({
      code: "invalid_field",
      message: "root and selector cannot be combined. Give one of them.",
      field: "root",
      expected: "a ref, without selector",
    });
    const malformed = await taking({ root: "@21" });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("invalid_ref");
    const unknown = await taking({ root: "@e9" });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toMatchObject({
      code: "unknown_ref",
      ref: "@e9",
    });
    expect(controller.contents.scripts).toEqual([]);
    // A ref written as the selector is the root it names.
    expect((await taking({ selector: "@e1" })).status).toBe(200);
    expect(controller.contents.scripts.at(-1)!.code).toContain('"root":"@e1"');
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

  it("refuses never-issued and retired refs before any page work", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const activity = controller.activity.length;
    // The page would answer every one of these.
    page.result = { ok: true, x: 25, y: 45, selected: 1 };
    const bodies = (ref: string, live: string) =>
      [
        ["click", { ref }],
        ["fill", { ref, value: "Ada" }],
        ["drag", { source: { ref }, target: { ref: live } }],
        ["drag", { source: { ref: live }, target: { ref } }],
        ["upload", uploadBody({ ref })],
      ] as const;
    for (const [route, body] of bodies("@e9", "@e1")) {
      const response = await request(`/tabs/${tab.id}/${route}`, "POST", body);
      expect(response.status, route).toBe(404);
      expect((await response.json()).error, route).toEqual({
        code: "unknown_ref",
        message:
          "Kamapathy never issued this ref for this page. Take a snapshot and use a ref from it.",
        ref: "@e9",
      });
    }
    refs.expireTab(tab.id);
    // A ref the tab is issued after the retirement is live again.
    const current = refs.reserve(1);
    refs.record(tab.id, [current]);
    for (const [route, body] of bodies("@e2", `@e${current}`)) {
      const response = await request(`/tabs/${tab.id}/${route}`, "POST", body);
      expect(response.status, route).toBe(409);
      expect((await response.json()).error, route).toEqual({
        code: "stale_ref",
        message: "Element reference is stale. Take a new snapshot.",
        ref: "@e2",
      });
    }
    expect(page.scripts).toEqual([]);
    expect(page.inputs).toEqual([]);
    expect(controller.activity).toHaveLength(activity);
  });

  it("records only the refs a snapshot assigned", async () => {
    const { tab } = await createPage();
    controller.contents.result = (code: string) => {
      const firstRef = Number(code.match(/"firstRef":(\d+)/)![1]);
      return {
        url: "https://example.com/",
        title: "Example",
        text: "Hello from the agent page",
        interactables: [],
        truncated: false,
        // Two of the block, and one number outside it.
        issued: [firstRef, firstRef + 2, firstRef + 100],
      };
    };
    const response = await request(`/tabs/${tab.id}/snapshot`);
    expect(response.status).toBe(200);
    const firstRef = Number(
      controller.contents.scripts.at(-1)!.code.match(/"firstRef":(\d+)/)![1],
    );
    expect(await response.json()).toEqual({
      tabId: tab.id,
      url: "https://example.com/",
      title: "Example",
      text: "Hello from the agent page",
      interactables: [],
      truncated: false,
      header: expect.objectContaining({
        page: expect.objectContaining({ id: tab.id }),
      }),
    });
    controller.contents.result = { ok: true, x: 25, y: 45 };
    const click = (number: number) =>
      request(`/tabs/${tab.id}/click`, "POST", { ref: `@e${number}` });
    expect((await click(firstRef)).status).toBe(200);
    expect((await click(firstRef + 2)).status).toBe(200);
    // Reserved with the block but never assigned, and past the block.
    for (const number of [firstRef + 1, firstRef + 100]) {
      const refused = await click(number);
      expect(refused.status, `@e${number}`).toBe(404);
      expect((await refused.json()).error.code).toBe("unknown_ref");
    }
  });

  it("adds the tab's ref generation to the namespace once its refs expire", async () => {
    const { tab } = await createPage();
    await request(`/tabs/${tab.id}/snapshot`);
    const namespace = () => controller.contents.scripts.at(-1)!.code;
    expect(namespace().endsWith(`${tab.id}:0")`)).toBe(true);
    refs.expireTab(tab.id);
    await request(`/tabs/${tab.id}/snapshot`);
    expect(namespace().endsWith(`${tab.id}:0:g1")`)).toBe(true);
    await request(`/tabs/${tab.id}/snapshot`);
    expect(namespace().endsWith(`${tab.id}:0:g1")`)).toBe(true);
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

  it("parses every selector before the lane and answers invalid_selector with no page work", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const activity = controller.activity.length;
    // The page would answer every one of these.
    page.result = { ok: true, x: 25, y: 45 };
    const refused = async (route: string, body: unknown) => {
      const response = await request(`/tabs/${tab.id}/${route}`, "POST", body);
      expect(response.status, route).toBe(400);
      return (await response.json()).error;
    };
    expect(await refused("click", { selector: "@21" })).toEqual({
      code: "invalid_selector",
      message: "This is not a ref. Refs look like @e21.",
      selector: "@21",
      reason: "ref_form",
      forms: FORMS,
      hint: REF_HINT,
    });
    for (const [route, body] of [
      ["fill", { selector: "a >> b", value: "Ada" }],
      ["drag", { source: { ref: "@e1" }, target: { selector: "a >> b" } }],
      ["wait", { selector: "a >> b" }],
      ["snapshot", { selector: "a >> b" }],
    ] as const) {
      const error = await refused(route, body);
      expect(error.code, route).toBe("invalid_selector");
      expect(error.reason, route).toBe("grammar");
      expect(error.selector, route).toBe("a >> b");
      expect(error.forms, route).toEqual(FORMS);
      expect(error.index, route).toBeUndefined();
    }
    // The whole plan is parsed, so the steps before the malformed one never run.
    const batch = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "click", ref: "@e1" },
        { type: "snapshot" },
        { type: "fill", selector: "a >> b", value: "Ada" },
      ],
    });
    expect(batch.status).toBe(400);
    expect((await batch.json()).error).toMatchObject({
      code: "invalid_selector",
      reason: "grammar",
      selector: "a >> b",
      index: 2,
    });
    expect(page.scripts).toEqual([]);
    expect(page.inputs).toEqual([]);
    expect(controller.activity).toHaveLength(activity);
  });

  it("sends each action's level and strict mode with the parsed selector", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const counted = () => ({
      ok: true,
      mouse: page.inputs.filter(
        (input) => input.parameters.type === "mousePressed",
      ).length,
      key: page.inputs.filter((input) =>
        ["keyDown", "rawKeyDown"].includes(input.parameters.type as string),
      ).length,
      drag: 0,
    });
    page.result = (code: string) =>
      code.includes(')("input",')
        ? counted()
        : code.includes(')("drag",')
          ? { ok: true, from: { x: 10, y: 20 }, to: { x: 110, y: 220 } }
          : code.includes(')("check",')
            ? { ok: true, matched: true }
            : { ok: true, x: 25, y: 45 };
    const act = (route: string, body: unknown) =>
      request(`/tabs/${tab.id}/${route}`, "POST", body);
    for (const [route, body] of [
      ["click", { selector: "#save" }],
      ["fill", { selector: "text=Save now", value: "Ada" }],
      ["press", { key: "Enter", selector: "role=textbox" }],
      ["scroll", { direction: "down", selector: "href=/plans" }],
      ["drag", { source: { selector: "#card" }, target: { selector: "#zone" } }],
      ["wait", { selector: "xpath=//button" }],
      ["snapshot", { selector: "#form" }],
    ] as const)
      expect((await act(route, body)).status, route).toBe(200);
    const queryOf = (operation: string) => payloads(operation)[0].query;
    const strict = (ast: unknown, level: string, extra: object = {}) => ({
      ast,
      level,
      mode: "strict",
      firstRef: expect.any(Number),
      ...extra,
    });
    expect(queryOf("target")).toEqual(
      strict({ kind: "css", css: "#save", raw: true }, "pointer-enabled"),
    );
    expect(queryOf("fill")).toEqual(
      strict({ kind: "text", value: "Save now", exact: false }, "enabled"),
    );
    // A role selector also carries the key its picked nodes wait under.
    expect(queryOf("focus")).toEqual(
      strict({ kind: "role", role: "textbox" }, "enabled", {
        picked: expect.any(String),
      }),
    );
    expect(queryOf("scroll")).toEqual(
      strict({ kind: "href", href: "/plans" }, "visible"),
    );
    const drag = payloads("drag")[0];
    expect(drag.source.query).toEqual(
      strict({ kind: "css", css: "#card", raw: true }, "pointer"),
    );
    expect(drag.target.query).toEqual(
      strict({ kind: "css", css: "#zone", raw: true }, "pointer"),
    );
    // Today's wait route has no state of its own.
    expect(queryOf("check")).toEqual(
      strict({ kind: "xpath", xpath: "//button" }, "visible"),
    );
    expect(queryOf("snapshot")).toEqual(
      strict({ kind: "css", css: "#form", raw: true }, "none"),
    );
    // Every strict resolution reserves its own candidate refs.
    const reserved = [
      ...["target", "fill", "focus", "scroll", "check", "snapshot"].map(
        (operation) => queryOf(operation).firstRef,
      ),
      drag.source.query.firstRef,
      drag.target.query.firstRef,
    ];
    expect(new Set(reserved).size).toBe(reserved.length);
    // A ref-form selector is the ref.
    expect((await act("click", { selector: "@e3" })).status).toBe(200);
    expect(payloads("target").at(-1)).toEqual({ ref: "@e3" });
  });

  it("maps page resolution failures to their codes and fields without showing blocked", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const candidates = [
      {
        ref: "@e7",
        tag: "button",
        role: "button",
        name: "Save",
        context: "Invoice 12",
        visible: true,
        disabled: false,
      },
      {
        ref: "@e8",
        tag: "button",
        role: "button",
        name: "Save",
        context: "Invoice 13",
        visible: true,
        disabled: false,
        frame: "0",
      },
    ];
    const click = async () => {
      const response = await request(`/tabs/${tab.id}/click`, "POST", {
        selector: ".save",
      });
      return { status: response.status, error: (await response.json()).error };
    };
    page.result = {
      ok: false,
      code: "no_match",
      error:
        "Nothing on the page matches this selector. Take a snapshot to check the page.",
      fields: { selector: ".save" },
    };
    expect(await click()).toEqual({
      status: 422,
      error: {
        code: "no_match",
        message:
          "Nothing on the page matches this selector. Take a snapshot to check the page.",
        selector: ".save",
        waitedMs: expect.any(Number),
        retryable: true,
      },
    });
    page.result = {
      ok: false,
      code: "ambiguous_match",
      error:
        "Selector matched 2 elements (2 visible, 0 hidden). Use a ref from candidates or a more specific selector.",
      fields: {
        selector: ".save",
        count: 2,
        visible: 2,
        hidden: 0,
        actionable: 2,
        candidates,
      },
    };
    expect(await click()).toEqual({
      status: 422,
      error: {
        code: "ambiguous_match",
        message:
          "Selector matched 2 elements (2 visible, 0 hidden). Use a ref from candidates or a more specific selector.",
        selector: ".save",
        count: 2,
        visible: 2,
        hidden: 0,
        actionable: 2,
        candidates,
      },
    });
    page.result = {
      ok: false,
      code: "invalid_selector",
      error: "The page rejected this CSS selector.",
      fields: { selector: ".save", reason: "css" },
    };
    expect(await click()).toEqual({
      status: 400,
      error: {
        code: "invalid_selector",
        message: "The page rejected this CSS selector.",
        selector: ".save",
        reason: "css",
        forms: FORMS,
      },
    });
    page.result = {
      ok: false,
      code: "stale_ref",
      error: "Element reference is stale. Take a new snapshot.",
      fields: { ref: "@e1" },
    };
    expect(await click()).toEqual({
      status: 409,
      error: {
        code: "stale_ref",
        message: "Element reference is stale. Take a new snapshot.",
        ref: "@e1",
      },
    });
    // A match the action cannot take keeps today's codes, and the page's own
    // blocker never reaches the agent.
    for (const [failure, status, code] of [
      [
        {
          ok: false,
          error: "Element is not visible.",
          blocked: { blocker: "hidden" },
        },
        422,
        "element_action_failed",
      ],
      [
        {
          ok: false,
          code: "element_obscured",
          error: "Another element covers the target.",
          blocked: { blocker: "covered" },
        },
        409,
        "element_obscured",
      ],
    ] as const) {
      page.result = failure;
      const answer = await click();
      expect(answer.status, code).toBe(status);
      expect(answer.error.code, code).toBe(code);
      expect(JSON.stringify(answer), code).not.toContain("blocker");
    }
  });

  it("accepts a candidate ref from ambiguous_match in the next request", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    let candidate = 0;
    page.result = (code: string) => {
      if (code.includes(')("input",'))
        return {
          ok: true,
          mouse: page.inputs.filter(
            (input) => input.parameters.type === "mousePressed",
          ).length,
          key: 0,
        };
      if (!code.includes('"selector":".save"'))
        return { ok: true, x: 25, y: 45 };
      candidate = Number(code.match(/"firstRef":(\d+)/)![1]);
      return {
        ok: false,
        code: "ambiguous_match",
        error:
          "Selector matched 2 elements (2 visible, 0 hidden). Use a ref from candidates or a more specific selector.",
        fields: {
          selector: ".save",
          count: 2,
          visible: 2,
          hidden: 0,
          actionable: 2,
          candidates: [
            {
              ref: `@e${candidate}`,
              tag: "button",
              role: "button",
              name: "Save",
              context: "Invoice 12",
              visible: true,
              disabled: false,
            },
          ],
        },
        issued: [candidate],
      };
    };
    const ambiguous = await request(`/tabs/${tab.id}/click`, "POST", {
      selector: ".save",
    });
    expect(ambiguous.status).toBe(422);
    const ref = (await ambiguous.json()).error.candidates[0].ref;
    expect(ref).toBe(`@e${candidate}`);
    const accepted = await request(`/tabs/${tab.id}/click`, "POST", { ref });
    expect(accepted.status).toBe(200);
    expect(payloads("target").at(-1)).toEqual({ ref });
  });

  it("keeps the wait route polling while a selector is ambiguous and stops at once on invalid_selector", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    // The page reports an ambiguous wait selector as a condition not yet met.
    page.result = { ok: true, matched: false };
    const timedOut = await request(`/tabs/${tab.id}/wait`, "POST", {
      selector: ".save",
      timeoutMs: 300,
    });
    expect(timedOut.status).toBe(408);
    expect((await timedOut.json()).error).toMatchObject({
      code: "wait_timeout",
      awaited: "condition",
      timeoutMs: 300,
    });
    expect(payloads("check").length).toBeGreaterThan(1);
    page.scripts.length = 0;
    page.result = {
      ok: false,
      code: "invalid_selector",
      error: "The page rejected this CSS selector.",
      fields: { selector: ".save", reason: "css" },
    };
    const stopped = await request(`/tabs/${tab.id}/wait`, "POST", {
      selector: ".save",
      timeoutMs: 5000,
    });
    expect(stopped.status).toBe(400);
    expect((await stopped.json()).error).toEqual({
      code: "invalid_selector",
      message: "The page rejected this CSS selector.",
      selector: ".save",
      reason: "css",
      forms: FORMS,
    });
    expect(payloads("check")).toHaveLength(1);
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
      `)("drag",${JSON.stringify({
        source: { ref: "@e1" },
        target: {
          selector: "#zone",
          query: {
            ast: { kind: "css", css: "#zone", raw: true },
            level: "pointer",
            mode: "strict",
            firstRef: payloads("drag")[0].target.query.firstRef,
          },
        },
      })}`,
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
    // A ref written as a selector is that ref.
    controller.contents.result = { ok: true, selected: 1 };
    const accepted = await request(`/tabs/${tab.id}/upload`, "POST", {
      selector: "@e1",
      files: [validFile],
    });
    expect(accepted.status).toBe(200);
    expect(payloads("upload")[0].ref).toBe("@e1");
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
