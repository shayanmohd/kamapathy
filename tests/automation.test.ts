import { statSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as netConnect } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../electron/agent/errors";
import { takeWaitSlot } from "../electron/agent/expectations";
import {
  createPageScripts,
  SCRIPTS_OFF_MESSAGE,
} from "../electron/agent/page-scripts";
import {
  createExtractor,
  type Extractor,
  type PdfChild,
} from "../electron/agent/pdf/extract";
import type { PdfPages } from "../electron/agent/pdf/worker";
import { MAX_HOMES, RefBook } from "../electron/agent/refs";
import { watchLeaveGuard } from "../electron/agent/routes/navigation";
import { FORMS, REF_HINT } from "../electron/agent/selectors";
import { PAGE_STATE_SOURCE } from "../electron/agent/session/operations";
import {
  startAutomation,
  type AutomationServer,
  type TestProbe,
} from "../electron/agent/server";
import {
  ACTIONS,
  API_LEVEL,
  COMMANDS,
  ENTRIES,
  ERRORS,
  ROUTES,
  routeKey,
} from "../skills/kamapathy/scripts/schema/index.mjs";
import type {
  BrowserAction,
  BrowserState,
  Space,
  UpdateReminder,
  UpdateState,
  UpdateStatus,
} from "../shared/types";
import {
  FakeContents,
  FakeController,
  FakeDownloadItem,
  socketFetch,
  testSocket,
} from "./fake-automation";
import { attachedTarget, frameOwners } from "./fake-cdp";

// The size a PNG's header reports.
const pngSize = (image: ArrayBuffer): number[] => {
  const png = Buffer.from(image);
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
};

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
  // A byte stream the client does not read, so the handler stays open on
  // its first chunk and keeps its stream slot.
  const stall = (path: string) =>
    new Promise<{
      response: IncomingMessage;
      client: ReturnType<typeof httpRequest>;
    }>((resolve, reject) => {
      const client = httpRequest(
        {
          socketPath: socket.path,
          path,
          agent: false,
          headers: { Host: "kamapathy" },
        },
        (response) => {
          response.pause();
          resolve({ response, client });
        },
      );
      client.once("error", reject);
      client.end();
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
    FakeController.cleanup();
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

  it("lets go of the controller's navigation hooks when it closes", async () => {
    const subscribed = controller.hookCount;
    expect(subscribed).toBeGreaterThan(0);
    await api.close();
    expect(controller.hookCount).toBe(0);
    api = await startAutomation(controller, { socketPath: socket.path });
    expect(controller.hookCount).toBe(subscribed);
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

  it("captures while hidden", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const response = await request(`/tabs/${tab.id}/screenshot`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-kamapathy-clip")).toBe("0,0,1200,800");
    expect(response.headers.get("x-kamapathy-pixel-ratio")).toBe("1");
    // The window state no longer decides: the tab's view is lent to the
    // capture window, and the capture runs on the tab's own session.
    expect(controller.lent).toEqual([tab.id]);
    expect(page.captures).toEqual([
      {
        format: "png",
        clip: { x: 0, y: 0, width: 1200, height: 800, scale: 1 },
        captureBeyondViewport: false,
        fromSurface: true,
      },
    ]);
    expect(pngSize(await response.arrayBuffer())).toEqual([1200, 800]);
    expect((await request(`/tabs/${tab.id}/snapshot`)).status).toBe(200);
  });

  it("crops to the planned size and answers 409 empty_screenshot for an empty image", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    page.metrics.cssVisualViewport.zoom = 1.25;
    const response = await request(`/tabs/${tab.id}/screenshot`, "POST", {
      clip: { x: 0, y: 0, width: 201, height: 101 },
    });
    expect(response.status).toBe(200);
    expect(page.captures.at(-1)).toMatchObject({
      clip: { x: 0, y: 0, width: 252, height: 127, scale: 0.8 },
    });
    // Chromium's own image is a pixel wider and taller; the answer is not.
    expect(pngSize(await response.arrayBuffer())).toEqual([201, 101]);
    expect(response.headers.get("x-kamapathy-clip")).toBe("0,0,201,101");
    // The page's own zoom factor stands in for a reply without one.
    page.metrics.cssVisualViewport.zoom = undefined;
    page.zoom = 1.25;
    expect((await request(`/tabs/${tab.id}/screenshot`)).status).toBe(200);
    expect(page.captures.at(-1)).toMatchObject({
      clip: { x: 0, y: 0, width: 1500, height: 1000, scale: 0.8 },
    });
    controller.emptyCapture = true;
    const empty = await request(`/tabs/${tab.id}/screenshot`, "POST", {});
    expect(empty.status).toBe(409);
    expect(await empty.json()).toMatchObject({
      error: {
        code: "empty_screenshot",
        message: "The page has not rendered yet. Try again.",
        retryable: true,
      },
    });
  });

  it("refuses clips and sizes the page cannot answer before lending a view", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const outside = await request(`/tabs/${tab.id}/screenshot`, "POST", {
      clip: { x: 1200, y: 0, width: 10, height: 10 },
    });
    expect(outside.status).toBe(422);
    expect(await outside.json()).toMatchObject({
      error: {
        code: "clip_outside_page",
        clip: { x: 1200, y: 0, width: 10, height: 10 },
      },
    });
    page.metrics.contentSize = { width: 1200, height: 20000 };
    const large = await request(`/tabs/${tab.id}/screenshot`, "POST", {
      fullPage: true,
    });
    expect(large.status).toBe(422);
    expect(await large.json()).toMatchObject({
      error: {
        code: "screenshot_too_large",
        width: 1200,
        height: 20000,
        maxSide: 16384,
        maxPixels: 33554432,
      },
    });
    const zero = await request(`/tabs/${tab.id}/screenshot`, "POST", {
      clip: { x: 0, y: 0, width: 0, height: 10 },
    });
    expect(zero.status).toBe(400);
    expect((await zero.json()).error).toMatchObject({
      code: "invalid_field",
      field: "clip.width",
    });
    expect(page.captures).toEqual([]);
    expect(controller.lent).toEqual([]);
  });

  it("answers a GET like a POST with no options and names the capture in the activity", async () => {
    const { space, tab } = await createPage();
    const page = controller.contents;
    expect((await request(`/tabs/${tab.id}/screenshot`)).status).toBe(200);
    expect(
      (await request(`/tabs/${tab.id}/screenshot`, "POST", {})).status,
    ).toBe(200);
    expect(page.captures[0]).toEqual(page.captures[1]);
    page.metrics.contentSize = { width: 1200, height: 2000 };
    const full = await request(`/tabs/${tab.id}/screenshot`, "POST", {
      fullPage: true,
    });
    expect(full.status).toBe(200);
    expect(full.headers.get("x-kamapathy-clip")).toBe("0,0,1200,2000");
    expect(page.captures.at(-1)).toMatchObject({
      clip: { x: 0, y: 0, width: 1200, height: 2000, scale: 1 },
      captureBeyondViewport: true,
    });
    expect(
      controller.activity
        .filter(
          (entry) =>
            entry.spaceId === space.id && entry.message.includes("screenshot"),
        )
        .map((entry) => entry.message),
    ).toEqual([
      "Agent captured a page screenshot",
      "Agent captured a page screenshot",
      "Agent captured a full-page screenshot",
    ]);
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

  it("serializes selectors as data and reads no code from a field it never declared", async () => {
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
    // Section 8's evaluate runs the agent's own expression or function, and
    // nothing it never declared.
    const undeclared = await request(`/tabs/${tab.id}/evaluate`, "POST", {
      code: "process.exit()",
    });
    expect(undeclared.status).toBe(400);
    expect((await undeclared.json()).error).toMatchObject({
      code: "unknown_field",
      field: "code",
    });
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

  it("returns next until the page is covered, and refuses a cursor from another snapshot", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const whole = "Every part of this page, and then the rest of it.";
    // A page that answers from the offsets it is given, as the real one does.
    page.result = (code: string) => {
      const marker = ')("snapshot",';
      const payload = JSON.parse(
        code.slice(
          code.indexOf(marker) + marker.length,
          code.lastIndexOf(',"'),
        ),
      );
      const { text: from, control } = payload.offsets;
      const text = whole.slice(from, from + payload.maxChars);
      const left = whole.length > from + payload.maxChars;
      return {
        url: "https://example.com/",
        title: "Example",
        text,
        interactables: [],
        truncated: left,
        ...(left
          ? {
              next: {
                text: from + payload.maxChars,
                control: control + 1,
                line: 0,
              },
            }
          : {}),
      };
    };
    const take = async (body: Record<string, unknown>) => {
      const response = await request(`/tabs/${tab.id}/snapshot`, "POST", body);
      return { status: response.status, body: await response.json() };
    };
    const parts: string[] = [];
    let cursor: string | undefined;
    let first: string | undefined;
    for (let part = 0; part < 20; part += 1) {
      const got = await take({
        maxChars: 12,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(got.status).toBe(200);
      parts.push(got.body.text);
      cursor = got.body.next;
      first ??= cursor;
      if (cursor === undefined) break;
      expect(cursor.startsWith("c1.")).toBe(true);
      expect(cursor.length).toBeLessThanOrEqual(512);
    }
    // The parts cover the page once, and the last one carries no cursor.
    expect(parts.join("")).toBe(whole);
    expect(cursor).toBeUndefined();
    const covered = Array.from(
      { length: Math.ceil(whole.length / 12) },
      (_unused, part) => ({ text: part * 12, control: part, line: 0 }),
    );
    expect(parts).toHaveLength(covered.length);
    expect(payloads("snapshot").map((payload) => payload.offsets)).toEqual(
      covered,
    );
    // A cursor is good only for the snapshot that made it.
    const scripts = page.scripts.length;
    const other = await take({
      maxChars: 12,
      cursor: first!,
      selector: "#one",
    });
    expect(other.status).toBe(400);
    expect(other.body.error).toEqual({
      code: "invalid_cursor",
      message:
        "This cursor does not continue this snapshot. Ask for the snapshot again without a cursor.",
    });
    // The schema bounds the field; the snapshot path reads what it carries.
    for (const [cursor, code] of [
      ["", "invalid_field"],
      [7, "invalid_field"],
      [`c1.${"x".repeat(513)}`, "invalid_field"],
      ["c1.", "invalid_cursor"],
      ["x1.YWJj", "invalid_cursor"],
      [`c1.${Buffer.from('{"e":0}').toString("base64url")}`, "invalid_cursor"],
    ] as const) {
      const refused = await take({ maxChars: 12, cursor });
      expect(refused.status, String(cursor)).toBe(400);
      expect(refused.body.error.code, String(cursor)).toBe(code);
    }
    // The bounds may change between parts; the scope may not.
    expect((await take({ maxChars: 400, cursor: first! })).status).toBe(200);
    expect(
      (await take({ maxChars: 12, cursor: first!, scope: "viewport" })).status,
    ).toBe(400);
    expect(page.scripts).toHaveLength(scripts + 1);

    // A cursor from before a same-document URL change is refused once the
    // page answers, and one from before a navigation before it is asked.
    page.result = {
      url: "https://example.com/next",
      title: "Example",
      text: "Hello",
      interactables: [],
      truncated: false,
    };
    const moved = await take({ maxChars: 12, cursor: first! });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatchObject({
      code: "page_changed",
      message:
        "The page changed since this cursor's part. Take a snapshot again without a cursor.",
    });
    const reached = page.scripts.length;
    page.emit("did-start-navigation", {
      url: "https://example.com/next",
      isSameDocument: false,
      isMainFrame: true,
    });
    const navigated = await take({ maxChars: 12, cursor: first! });
    expect(navigated.status).toBe(409);
    expect(navigated.body.error.code).toBe("page_changed");
    expect(page.scripts).toHaveLength(reached);
  });

  it("returns an outline instead of text, with its own parts and cursors", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const lines = [
      "main",
      '  heading "Plans" level=2',
      '  button "Save" @e1',
      '  "Terms apply"',
    ];
    // A page that answers an outline request from the line it is given.
    page.result = (code: string) => {
      const marker = ')("snapshot",';
      const payload = JSON.parse(
        code.slice(
          code.indexOf(marker) + marker.length,
          code.lastIndexOf(',"'),
        ),
      );
      const shared = { url: "https://example.com/", title: "Example" };
      if (payload.format !== "outline") {
        const whole = "Plain text, and more of it.";
        const from = payload.offsets.text;
        const left = from + payload.maxChars < whole.length;
        return {
          ...shared,
          text: whole.slice(from, from + payload.maxChars),
          interactables: [],
          truncated: left,
          ...(left
            ? { next: { text: from + payload.maxChars, control: 0, line: 0 } }
            : {}),
        };
      }
      const from = payload.offsets.line;
      const shown = lines.slice(from, from + 2);
      const left = from + shown.length < lines.length;
      return {
        ...shared,
        outline: shown.join("\n"),
        interactables: shown
          .filter((line) => line.includes("@e"))
          .map(() => ({ ref: "@e1", tag: "button", label: "Save" })),
        truncated: left,
        ...(left
          ? { next: { text: 0, control: 0, line: from + shown.length } }
          : {}),
      };
    };
    const take = async (body: Record<string, unknown>) => {
      const response = await request(`/tabs/${tab.id}/snapshot`, "POST", body);
      return { status: response.status, body: await response.json() };
    };
    const first = await take({ format: "outline" });
    expect(first.status).toBe(200);
    expect(page.scripts.at(-1)!.code).toContain('"format":"outline"');
    expect(first.body.outline).toBe(lines.slice(0, 2).join("\n"));
    expect(first.body.text).toBeUndefined();
    expect(first.body.interactables).toEqual([]);
    expect(first.body.next).toMatch(/^c1\./);
    const second = await take({ format: "outline", cursor: first.body.next });
    expect(second.status).toBe(200);
    expect(second.body.outline).toBe(lines.slice(2).join("\n"));
    expect(second.body.interactables).toEqual([
      { ref: "@e1", tag: "button", label: "Save" },
    ]);
    expect(second.body.next).toBeUndefined();
    expect(payloads("snapshot").map((payload) => payload.offsets)).toEqual([
      { text: 0, control: 0, line: 0 },
      { text: 0, control: 0, line: 2 },
    ]);
    // A cursor belongs to the format that made it, either way round.
    const list = await take({ maxChars: 12 });
    expect(list.status).toBe(200);
    expect(list.body.text).toBe("Plain text, ");
    expect(list.body.next).toMatch(/^c1\./);
    for (const [body, code] of [
      [{ cursor: first.body.next }, "invalid_cursor"],
      [{ format: "list", cursor: first.body.next }, "invalid_cursor"],
      [{ format: "outline", cursor: list.body.next }, "invalid_cursor"],
      [{ format: "tree" }, "invalid_field"],
    ] as const) {
      const refused = await take(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.body.error.code, JSON.stringify(body)).toBe(code);
    }
  });

  // A page with frames: each child reported on the page session, the ones
  // Chromium moved to their own process announced as their own target, and
  // the owner binding each frame's world answers.
  type FrameSpec = {
    frameId: string;
    parent?: string;
    url: string;
    local: string;
    readable?: boolean;
    sessionId?: string;
  };
  const addFrames = async (specs: FrameSpec[]) => {
    const page = controller.contents;
    frameOwners(
      page.debugger,
      Object.fromEntries(
        specs.map(({ frameId, local, readable }) => [
          frameId,
          { local, readable: readable === true },
        ]),
      ),
    );
    for (const spec of specs) {
      page.emitProtocol("Page.frameAttached", {
        frameId: spec.frameId,
        parentFrameId: spec.parent ?? "main",
      });
      if (spec.sessionId === undefined) {
        page.emitProtocol("Page.frameNavigated", {
          frame: {
            id: spec.frameId,
            parentId: spec.parent ?? "main",
            loaderId: `loader-${spec.frameId}`,
            url: spec.url,
            securityOrigin: new URL(spec.url).origin,
            mimeType: "text/html",
          },
        });
        continue;
      }
      attachedTarget(page.debugger, {
        sessionId: spec.sessionId,
        targetId: spec.frameId,
        url: spec.url,
      });
      // A frame in its own process is read through that session, which the
      // tab sets up before a snapshot can reach it.
      await expect
        .poll(() =>
          page.debugger.sent.some(
            (command) => command.sessionId === spec.sessionId,
          ),
        )
        .toBe(true);
    }
  };
  // The frame group a read ran in, as its payload carries it.
  const groupOf = (code: string) =>
    /"frameContext":\{"group":"([^"]*)"/.exec(code)?.[1];
  // What one group's read answers: its text in parts, its ranked controls
  // and the frame owners its world could not read.
  const groupRead = (
    group: string,
    read: {
      text?: { order: number; value: string }[];
      controls?: {
        order: number;
        tier: number;
        local?: string;
        entry: Record<string, unknown>;
      }[];
      owners?: Record<string, unknown>[];
    },
  ) => {
    const text = read.text ?? [];
    return {
      url: "https://example.com/",
      title: "Example",
      group,
      text,
      controls: (read.controls ?? []).map((control) => ({
        local: "",
        ...control,
      })),
      outline: [],
      placeholders: read.owners ?? [],
      chars: text.reduce((total, part) => total + part.value.length, 0),
    };
  };
  const owner = (local: string, order: number, key?: string, tier = 6) => ({
    ...(key === undefined ? {} : { key }),
    local,
    order,
    tier,
    box: { left: 0, top: order * 60, right: 300, bottom: order * 60 + 50 },
    readable: false,
  });
  const frameEntry = (
    label: string,
    ref: string,
    contentFrame: string,
    key?: string,
    extra: Record<string, unknown> = {},
  ) => ({
    index: 0,
    ref,
    tag: "iframe",
    role: "iframe",
    label,
    selector: "iframe",
    disabled: false,
    crossOrigin: true,
    contentFrame,
    ...(key === undefined ? {} : { key }),
    ...extra,
  });
  const control = (
    label: string,
    ref: string,
    extra: Record<string, unknown> = {},
  ) => ({
    index: 0,
    ref,
    tag: "button",
    role: "button",
    label,
    selector: "button",
    disabled: false,
    ...extra,
  });

  it("a snapshot counts unread frames", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    // Nine frames one inside another, a frame whose read fails, and a frame
    // whose own session ended.
    const chain = Array.from({ length: 9 }, (_unused, depth) => ({
      frameId: `deep-${depth}`,
      ...(depth === 0 ? {} : { parent: `deep-${depth - 1}` }),
      url: `https://deep${depth}.example/`,
      local: "0",
    }));
    await addFrames([
      ...chain,
      { frameId: "card", url: "https://pay.example/", local: "1" },
      {
        frameId: "gone",
        url: "https://map.example/",
        local: "2",
        sessionId: "gone-session",
      },
    ]);
    page.emitProtocol("Target.detachedFromTarget", {
      sessionId: "gone-session",
      targetId: "gone",
    });
    page.result = (code: string) => {
      const group = groupOf(code);
      if (group === "")
        return groupRead("", {
          text: [{ order: 0, value: "Checkout" }],
          controls: [
            {
              order: 1,
              tier: 6,
              entry: frameEntry("Deep form", "@e11", "0", "deep-0"),
            },
            {
              order: 2,
              tier: 6,
              entry: frameEntry("Card details", "@e12", "1", "card"),
            },
            { order: 3, tier: 6, entry: frameEntry("Map", "@e13", "2", "gone") },
          ],
          owners: [
            owner("0", 1, "deep-0"),
            owner("1", 2, "card"),
            owner("2", 3, "gone"),
          ],
        });
      // The frame that loaded another document while it was read.
      if (group === "1")
        return {
          ok: false,
          code: "page_changed",
          error: "The page changed during this operation. Take a new snapshot.",
        };
      const depth = (group ?? "").split("/").length;
      return groupRead(group ?? "", {
        owners: depth < 9 ? [owner("0", 1, `deep-${depth}`)] : [],
      });
    };
    const response = await request(`/tabs/${tab.id}/snapshot`, "POST", {
      maxControls: 2,
      header: false,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    // The card frame is pending, the map frame unavailable and the ninth
    // nested frame past the levels one read reaches, listed or not.
    expect(body.unreadFrames).toBe(3);
    expect(
      body.interactables.map(
        (entry: Record<string, unknown>) => [
          entry.label,
          entry.content,
          entry.origin,
          entry.contentFrame,
        ],
      ),
    ).toEqual([
      ["Deep form", "read", "https://deep0.example", "0"],
      ["Card details", "pending", "https://pay.example", "1"],
    ]);
    expect(body.interactables[0].key).toBeUndefined();
    // Nothing left unread, nothing reported.
    page.result = groupRead("", { text: [{ order: 0, value: "Checkout" }] });
    const again = await request(`/tabs/${tab.id}/snapshot`, "POST", {
      header: false,
    });
    expect(again.status).toBe(200);
    expect((await again.json()).unreadFrames).toBeUndefined();
  });

  it("the control budget ranks frame controls at the owner's tier", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    await addFrames([
      { frameId: "near", url: "https://near.example/", local: "0" },
      { frameId: "far", url: "https://far.example/", local: "1" },
    ]);
    page.result = (code: string) => {
      const group = groupOf(code);
      if (group === "")
        return groupRead("", {
          text: [{ order: 0, value: "Pay" }],
          controls: [
            { order: 1, tier: 6, entry: control("Save", "@e21") },
            {
              order: 2,
              tier: 6,
              entry: frameEntry("Card details", "@e22", "0", "near"),
            },
            {
              order: 4,
              tier: 10,
              entry: frameEntry("Old offer", "@e23", "1", "far"),
            },
          ],
          // The second owner is off screen, which its rank says.
          owners: [owner("0", 2, "near"), owner("1", 4, "far", 10)],
        });
      if (group === "0")
        return groupRead("0", {
          controls: [
            { order: 1, tier: 0, entry: control("Card number", "@e24") },
            { order: 2, tier: 6, entry: control("Pay now", "@e25") },
          ],
        });
      return groupRead("1", {
        controls: [{ order: 1, tier: 0, entry: control("Claim offer", "@e26") }],
      });
    };
    const take = async (maxControls: number) => {
      const response = await request(`/tabs/${tab.id}/snapshot`, "POST", {
        maxControls,
        header: false,
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    // Every control, each carrying the path of its own document.
    const whole = await take(6);
    expect(
      whole.interactables.map((entry: Record<string, unknown>) => [
        entry.label,
        entry.frame,
      ]),
    ).toEqual([
      ["Save", undefined],
      ["Card details", undefined],
      ["Card number", "0"],
      ["Pay now", "0"],
      ["Old offer", undefined],
      ["Claim offer", "1"],
    ]);
    // Past the budget a frame control keeps the more urgent of its own rank
    // and its owner's, and an off-screen owner's controls go last.
    const part = await take(3);
    expect(
      part.interactables.map((entry: Record<string, unknown>) => entry.label),
    ).toEqual(["Save", "Card details", "Card number"]);
    expect(part.omittedControls).toBe(3);
  });

  it("a frame that loads another document mid-read is listed as pending, and a main-frame navigation is still page_changed", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    await addFrames([
      { frameId: "card", url: "https://pay.example/", local: "0" },
    ]);
    const top = () =>
      groupRead("", {
        text: [{ order: 0, value: "Checkout" }],
        controls: [
          {
            order: 1,
            tier: 6,
            entry: frameEntry("Card details", "@e31", "0", "card"),
          },
        ],
        owners: [owner("0", 1, "card")],
      });
    page.result = (code: string) =>
      groupOf(code) === ""
        ? top()
        : {
            ok: false,
            code: "page_changed",
            error:
              "The page changed during this operation. Take a new snapshot.",
          };
    const first = await request(`/tabs/${tab.id}/snapshot`, "POST", {
      header: false,
    });
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.interactables[0].content).toBe("pending");
    expect(body.unreadFrames).toBe(1);
    // The page itself loading another document still ends the snapshot.
    page.result = (code: string) => {
      if (groupOf(code) === "")
        page.emit("did-start-navigation", {
          url: "https://example.com/next",
          isSameDocument: false,
          isMainFrame: true,
        });
      return top();
    };
    const changed = await request(`/tabs/${tab.id}/snapshot`, "POST", {
      header: false,
    });
    expect(changed.status).toBe(409);
    expect((await changed.json()).error.code).toBe("page_changed");
  });

  it("a blocked frame is listed without an origin", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    // An extension frame: the registry blocks it, and the page sees an
    // address agents never reach.
    await addFrames([
      {
        frameId: "panel",
        url: "chrome-extension://abcdefghijklmnopabcdefghijklmnop/panel.html",
        local: "0",
      },
    ]);
    page.result = groupRead("", {
      text: [{ order: 0, value: "Shop" }],
      controls: [
        {
          order: 1,
          tier: 6,
          entry: frameEntry("Extension panel", "@e41", "0", undefined, {
            blocked: true,
          }),
        },
      ],
      owners: [{ ...owner("0", 1), blocked: true }],
    });
    const response = await request(`/tabs/${tab.id}/snapshot`, "POST", {
      header: false,
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.interactables[0]).toMatchObject({
      label: "Extension panel",
      crossOrigin: true,
      content: "blocked",
    });
    expect(body.interactables[0].origin).toBeUndefined();
    expect(body.interactables[0].contentFrame).toBeUndefined();
    expect(body.unreadFrames).toBeUndefined();
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

  it("ref homes survive a frame's same-document navigation and are evicted past the limit", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    page.result = { ok: true, x: 25, y: 45 };
    const home = { frameId: "frame-1", loaderId: "loader-1", group: "" };
    const first = refs.reserve(MAX_HOMES + 1);
    refs.record(
      tab.id,
      Array.from({ length: MAX_HOMES + 1 }, (_, at) => first + at),
    );
    for (let at = 0; at <= MAX_HOMES; at += 1)
      refs.setHome(tab.id, `@e${first + at}`, home);
    // A navigation inside the same document keeps every home.
    page.emitProtocol("Page.navigatedWithinDocument", {
      frameId: "frame-1",
      url: "https://example.com/#paid",
    });
    expect(refs.home(tab.id, `@e${first + 1}`)).toEqual(home);
    // The oldest home was evicted, and its ref is stale rather than unknown.
    expect(refs.home(tab.id, `@e${first}`)).toBeUndefined();
    const evicted = await request(`/tabs/${tab.id}/click`, "POST", {
      ref: `@e${first}`,
    });
    expect(evicted.status).toBe(409);
    expect((await evicted.json()).error).toEqual({
      code: "stale_ref",
      message: "Element reference is stale. Take a new snapshot.",
      ref: `@e${first}`,
    });
    expect(
      (
        await request(`/tabs/${tab.id}/click`, "POST", {
          ref: `@e${first + 1}`,
        })
      ).status,
    ).toBe(200);
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

  it("reaches a control inside a frame from another origin", async () => {
    const { tab } = await createPage();
    // Section 9 reads and acts in frames from any web origin, so the page
    // script no longer answers cross_origin_frame and the action reaches the
    // frame's own world.
    controller.contents.result = (code: string) =>
      code.includes(')("fill",') ? { ok: true } : { ok: true, x: 25, y: 45 };
    for (const [route, body] of [
      ["click", { ref: "@e2" }],
      ["fill", { ref: "@e2", value: "card" }],
    ] as const) {
      const response = await request(`/tabs/${tab.id}/${route}`, "POST", body);
      expect(response.status).toBe(200);
      expect((await response.json()).ok).toBe(true);
    }
    expect(controller.contents.inputs.length).toBeGreaterThan(0);
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
    expect(page.captures).toEqual([]);
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

  // A function wait and its answer.
  const waitForFunction = (tabId: string, body: Record<string, unknown>) => {
    const done = request(`/tabs/${tabId}/wait-for-function`, "POST", body);
    void done.catch(() => {});
    return done;
  };
  // The page answers main-world evaluations itself: each call is recorded
  // with the moment it arrived, and the test scripts the reply.
  const mainWorld = (
    page: FakeContents,
    reply: (expression: string, count: number) => unknown,
  ) => {
    const calls: { expression: string; at: number }[] = [];
    page.debugger.reply("Runtime.evaluate", (params) => {
      if (params.contextId !== undefined)
        return { result: { type: "object", value: {} } };
      calls.push({ expression: params.expression, at: Date.now() });
      return reply(params.expression, calls.length);
    });
    return calls;
  };
  const truthy = (value: unknown) => ({ result: { type: "object", value } });
  const falsy = { result: { type: "boolean", value: false } };
  // Every page script Kamapathy sends names itself, so the page reports it
  // under that name instead of inline.
  const named = (source: string) =>
    `${source}\n//# sourceURL=kamapathy-evaluate.js`;

  it("the function wait answers the first truthy value", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const source = "window.state && window.state.ready";
    const calls = mainWorld(page, (_expression, count) =>
      count < 3 ? falsy : truthy({ ready: true }),
    );
    const answered = await waitForFunction(tab.id, {
      expression: source,
      intervalMs: 60,
      timeoutMs: 5000,
    });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({ id: tab.id, managed: true }),
      value: { ready: true },
    });
    expect(calls.map((call) => call.expression)).toEqual([
      named(source),
      named(source),
      named(source),
    ]);
    // The checks are the interval apart.
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(50);
    expect(calls[2].at - calls[1].at).toBeGreaterThanOrEqual(50);
    // One main-world evaluation per check: no world of Kamapathy's own and
    // no frame session, so it reads the page's own globals.
    const sent = page.debugger.sent.filter(
      (command) => command.method === "Runtime.evaluate",
    );
    expect(sent).toHaveLength(3);
    for (const command of sent) {
      expect(command.sessionId).toBeUndefined();
      expect(command.params.contextId).toBeUndefined();
      expect(command.params).toMatchObject({
        expression: named(source),
        returnByValue: true,
        awaitPromise: true,
        silent: true,
      });
      // A check reads the page and never stops its scripts.
      expect(command.params.timeout).toBeUndefined();
    }
    expect(controller.activity.at(-1)).toMatchObject({
      spaceId: tab.spaceId,
      message: "Agent observed a page condition",
    });
  });

  it("a function source is called with its argument", async () => {
    const { tab } = await createPage();
    const calls = mainWorld(controller.contents, (expression) =>
      truthy(expression),
    );
    const source = "(item) => item.count > 1 && item.name";
    // The fake answers with the expression it ran, so the answer shows it.
    const withArg = await waitForFunction(tab.id, {
      function: source,
      arg: { count: 2, name: "two\u2028" },
      timeoutMs: 1000,
    });
    expect(withArg.status).toBe(200);
    expect((await withArg.json()).value).toBe(
      named(`(${source})({"count":2,"name":"two\\u2028"})`),
    );
    const alone = await waitForFunction(tab.id, {
      function: source,
      timeoutMs: 1000,
    });
    expect(alone.status).toBe(200);
    expect((await alone.json()).value).toBe(named(`(${source})()`));
    expect(calls).toHaveLength(2);
  });

  it("unserializable results answer with their text, and falsy ones keep looking", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const unserializable = (text: string) => ({
      result: { type: "number", description: text, unserializableValue: text },
    });
    // A truthy value the protocol cannot send by value arrives as its text.
    for (const [expression, text] of [
      ["10n ** 20n", "100000000000000000000n"],
      ["1 / 0", "Infinity"],
    ] as const) {
      mainWorld(page, () => unserializable(text));
      const answered = await waitForFunction(tab.id, {
        expression,
        timeoutMs: 1000,
      });
      expect(answered.status, text).toBe(200);
      expect(await answered.json()).toEqual({
        ok: true,
        tab: expect.objectContaining({ id: tab.id }),
        unserializable: text,
      });
    }
    // NaN, -0 and 0n are no condition, and neither is a result of undefined,
    // so those waits keep looking and end at their deadline.
    for (const text of ["NaN", "-0", "0n"]) {
      mainWorld(page, () => unserializable(text));
      const { status, error } = await failure(
        await waitForFunction(tab.id, { expression: text, timeoutMs: 0 }),
      );
      expect(status, text).toBe(504);
      expect(error, text).toMatchObject({
        code: "wait_timeout",
        awaited: "function",
      });
    }
    mainWorld(page, () => ({ result: { type: "undefined" } }));
    const nothing = await failure(
      await waitForFunction(tab.id, { expression: "void 0", timeoutMs: 0 }),
    );
    expect(nothing.status).toBe(504);
    expect(nothing.error).toMatchObject({ awaited: "function" });
  });

  it("a page exception ends the wait", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const long = `TypeError: no good\n${"x".repeat(5000)}`;
    // A silent evaluation answers with the error object beside its details.
    mainWorld(page, () => ({
      result: { type: "object", className: "TypeError", subtype: "error" },
      exceptionDetails: {
        text: "Uncaught",
        lineNumber: 1,
        columnNumber: 2,
        exception: { className: "TypeError", description: long },
      },
    }));
    const thrown = await failure(
      await waitForFunction(tab.id, {
        function: "(value) => {\n  throw new TypeError('no good')\n}",
        timeoutMs: 1000,
      }),
    );
    expect(thrown.status).toBe(422);
    expect(thrown.error).toMatchObject({
      code: "script_error",
      name: "TypeError",
      line: 2,
      column: 3,
    });
    expect(thrown.error.description).toBe(long.slice(0, 4000));
    expect(String(thrown.error.message)).toContain("line 2, column 3");
    // On line 1 a function source sits one character to the right, where the
    // wrapper's parenthesis is; an expression runs as written.
    const missing = {
      exceptionDetails: {
        text: "Uncaught",
        lineNumber: 0,
        columnNumber: 5,
        exception: {
          className: "ReferenceError",
          description: "ReferenceError: missing is not defined",
        },
      },
    };
    mainWorld(page, () => missing);
    const wrapped = await failure(
      await waitForFunction(tab.id, {
        function: "() => missing",
        timeoutMs: 1000,
      }),
    );
    expect(wrapped.error).toMatchObject({
      code: "script_error",
      name: "ReferenceError",
      line: 1,
      column: 5,
      description: "ReferenceError: missing is not defined",
    });
    const bare = await failure(
      await waitForFunction(tab.id, { expression: "missing", timeoutMs: 1000 }),
    );
    expect(bare.error).toMatchObject({ line: 1, column: 6 });
  });

  it("a context lost to navigation is retried at the next interval", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    await tracking(tab.id);
    const calls = mainWorld(page, (_expression, count) => {
      if (count === 1) throw new Error("Inspected target navigated or closed");
      return truthy("after");
    });
    const pending = waitForFunction(tab.id, {
      expression: "window.ready",
      intervalMs: 80,
      timeoutMs: 5000,
    });
    await sleep(25);
    const frame = mainFrame(page, "loader-2");
    frame.start("https://example.com/next");
    frame.commit("https://example.com/next");
    const answered = await pending;
    expect(answered.status).toBe(200);
    expect((await answered.json()).value).toBe("after");
    expect(calls).toHaveLength(2);
  });

  it("the wait answers 403 while Page scripts are off", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const calls = mainWorld(page, () => truthy(true));
    controller.state.settings.agentPageScripts = false;
    const off = await failure(
      await waitForFunction(tab.id, { expression: "true" }),
    );
    expect(off.status).toBe(403);
    expect(off.error).toEqual({
      code: "agent_scripts_off",
      message:
        "Page scripts are off in Kamapathy's Settings, under Agents. Continue with snapshots and actions.",
    });
    // A plan that holds the step fails before its first action runs.
    const batch = await failure(
      await request(`/tabs/${tab.id}/actions`, "POST", {
        actions: [
          { type: "snapshot" },
          { type: "wait-for-function", expression: "true" },
        ],
      }),
    );
    expect(batch.status).toBe(403);
    expect(batch.error).toMatchObject({ code: "agent_scripts_off" });
    expect(calls).toEqual([]);
    expect(page.scripts).toEqual([]);
    // With the setting on again, the same step runs.
    controller.state.settings.agentPageScripts = true;
    const ran = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "wait-for-function", expression: "true", timeoutMs: 1000 },
      ],
    });
    expect(ran.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("a function wait times out with its fields", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    mainWorld(page, () => falsy);
    const timedOut = await failure(
      await waitForFunction(tab.id, {
        expression: "window.ready",
        intervalMs: 50,
        timeoutMs: 150,
      }),
    );
    expect(timedOut.status).toBe(504);
    expect(timedOut.error).toEqual({
      code: "wait_timeout",
      message:
        "The page function did not return a truthy value within 150 ms. It is at https://example.com/.",
      awaited: "function",
      timeoutMs: 150,
      url: "https://example.com/",
      title: "https://example.com/",
      popups: [],
      // The agent's own code reached the page, so nothing here is retryable.
      dispatched: true,
    });
    // A popup this page opened while it waited is named in the message.
    const pending = waitForFunction(tab.id, {
      expression: "window.ready",
      intervalMs: 50,
      timeoutMs: 300,
    });
    await sleep(40);
    const popup = controller.openPopup(tab.id, "https://example.com/popup");
    const withPopup = await failure(await pending);
    expect(withPopup.status).toBe(504);
    expect(withPopup.error.popups).toEqual([
      { id: popup.id, label: popup.label, url: "https://example.com/popup" },
    ]);
    expect(withPopup.error.message).toBe(
      `The page function did not return a truthy value within 300 ms. It is at https://example.com/. Popup ${popup.label} opened from it at https://example.com/popup, so the condition may be there.`,
    );
  });

  it("the body is validated before the lane", async () => {
    const { tab } = await createPage();
    const refuse = async (body: Record<string, unknown>) =>
      failure(await request(`/tabs/${tab.id}/wait-for-function`, "POST", body));
    for (const [body, field] of [
      [{ expression: "true", function: "() => true" }, "function"],
      [{}, "expression"],
      [{ expression: "x".repeat(16385) }, "expression"],
      [{ expression: "true", intervalMs: 9 }, "intervalMs"],
      [{ expression: "true", timeoutMs: 60001 }, "timeoutMs"],
      [{ expression: "true", arg: 1 }, "arg"],
    ] as const) {
      const { status, error } = await refuse(body);
      expect(status, JSON.stringify(body)).toBe(400);
      expect(error, JSON.stringify(body)).toMatchObject({
        code: "invalid_field",
        field,
      });
    }
    // The step takes the same fields, and the plan is checked before it runs.
    const step = await failure(
      await request(`/tabs/${tab.id}/actions`, "POST", {
        actions: [{ type: "wait-for-function", intervalMs: 10001 }],
      }),
    );
    expect(step.status).toBe(400);
    expect(step.error).toMatchObject({
      code: "invalid_field",
      field: "intervalMs",
    });
    expect(controller.contents.scripts).toEqual([]);
  });

  // Section 8's Page scripts gate: the switch, the signal in-flight script
  // calls share, and the hooks a switch-off runs.
  it("the gate reads the live setting", async () => {
    expect(SCRIPTS_OFF_MESSAGE).toBe(
      "Page scripts are off in Kamapathy's Settings, under Agents. Continue with snapshots and actions.",
    );
    const { tab } = await createPage();
    const calls = mainWorld(controller.contents, () => truthy("ready"));
    const gate = createPageScripts(controller);
    const body = { expression: "window.ready", timeoutMs: 1000 };
    controller.state.settings.agentPageScripts = false;
    expect(gate.on).toBe(false);
    expect(() => gate.require()).toThrow(SCRIPTS_OFF_MESSAGE);
    const off = await failure(await waitForFunction(tab.id, body));
    expect(off.status).toBe(403);
    expect(off.error).toEqual({
      code: "agent_scripts_off",
      message: SCRIPTS_OFF_MESSAGE,
    });
    expect(calls).toEqual([]);
    // The setting is the gate's only source of truth, so the same body runs
    // as soon as it is back on.
    controller.state.settings.agentPageScripts = true;
    expect(gate.on).toBe(true);
    expect(() => gate.require()).not.toThrow();
    const ran = await waitForFunction(tab.id, body);
    expect(ran.status).toBe(200);
    expect(calls).toHaveLength(1);
    gate.dispose();
  });

  it("turning Page scripts off aborts in-flight script calls once", () => {
    const gate = createPageScripts(controller);
    const signal = gate.signal();
    expect(signal.aborted).toBe(false);
    const ran: string[] = [];
    const stopFirst = gate.onOff(() => {
      ran.push("first");
      throw new Error("a hook that fails leaves the rest to run");
    });
    gate.onOff(() => ran.push("second"));
    controller.state.settings.agentPageScripts = false;
    gate.apply(false);
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(ApiError);
    expect(signal.reason.code).toBe("agent_scripts_off");
    expect(signal.reason.message).toBe(SCRIPTS_OFF_MESSAGE);
    expect(ran).toEqual(["first", "second"]);
    // Off again is no switch at all: nothing aborts twice and no hook runs.
    gate.apply(false);
    expect(ran).toEqual(["first", "second"]);
    expect(gate.signal()).toBe(signal);
    // A hook that let go is not called by the next switch-off.
    stopFirst();
    controller.state.settings.agentPageScripts = true;
    gate.apply(true);
    controller.state.settings.agentPageScripts = false;
    gate.apply(false);
    expect(ran).toEqual(["first", "second", "second"]);
    gate.dispose();
  });

  it("the signal is fresh after the switch comes back", () => {
    const gate = createPageScripts(controller);
    const first = gate.signal();
    controller.state.settings.agentPageScripts = false;
    gate.apply(false);
    expect(first.aborted).toBe(true);
    expect(() => gate.require()).toThrow(SCRIPTS_OFF_MESSAGE);
    controller.state.settings.agentPageScripts = true;
    gate.apply(true);
    const second = gate.signal();
    expect(second).not.toBe(first);
    expect(second.aborted).toBe(false);
    // The call the switch-off failed keeps its own aborted signal.
    expect(first.aborted).toBe(true);
    expect(() => gate.require()).not.toThrow();
    gate.dispose();
  });

  it("a batch holding a function wait fails validation while the switch is off", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const calls = mainWorld(page, () => truthy(true));
    controller.state.settings.agentPageScripts = false;
    const batch = await failure(
      await request(`/tabs/${tab.id}/actions`, "POST", {
        actions: [
          { type: "snapshot" },
          { type: "wait-for-function", expression: "true" },
        ],
      }),
    );
    expect(batch.status).toBe(403);
    expect(batch.error).toMatchObject({
      code: "agent_scripts_off",
      message: SCRIPTS_OFF_MESSAGE,
    });
    // The plan answered before its first action ran.
    expect(calls).toEqual([]);
    expect(page.scripts).toEqual([]);
  });

  it("the server exposes setPageScripts", async () => {
    const { tab } = await createPage();
    const calls = mainWorld(controller.contents, () => truthy("ready"));
    const gate = createPageScripts(controller);
    const ran: string[] = [];
    gate.onOff(() => ran.push("off"));
    const body = { expression: "window.ready", timeoutMs: 1000 };
    // What the app does when the person turns the switch off: the server
    // applies the setting, and the state change itself runs the effects once.
    controller.state.settings.agentPageScripts = false;
    api.setPageScripts(false);
    controller.emit();
    expect(ran).toEqual(["off"]);
    expect(gate.signal().aborted).toBe(true);
    const off = await failure(await waitForFunction(tab.id, body));
    expect(off.status).toBe(403);
    expect(off.error.code).toBe("agent_scripts_off");
    expect(calls).toEqual([]);
    controller.state.settings.agentPageScripts = true;
    api.setPageScripts(true);
    controller.emit();
    expect(gate.signal().aborted).toBe(false);
    expect(ran).toEqual(["off"]);
    const allowed = await waitForFunction(tab.id, body);
    expect(allowed.status).toBe(200);
    expect(calls).toHaveLength(1);
    // A gate that was disposed hears no more of the person's choices.
    gate.dispose();
    controller.state.settings.agentPageScripts = false;
    controller.emit();
    expect(ran).toEqual(["off"]);
  });

  // Section 8's evaluate route: the agent's own expression or function in
  // the page's main frame.
  const evaluate = (tabId: string, body: Record<string, unknown>) => {
    const done = request(`/tabs/${tabId}/evaluate`, "POST", body);
    void done.catch(() => {});
    return done;
  };
  // A page that answers only once the test lets it, so a takeover, a
  // navigation or the switch can land while the call is in flight.
  const heldEvaluate = async (
    tabId: string,
    value: unknown,
    body: Record<string, unknown> = {},
  ) => {
    let release: (() => void) | undefined;
    controller.contents.debugger.reply(
      "Runtime.evaluate",
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ result: { type: "string", value } });
        }),
    );
    const done = evaluate(tabId, {
      expression: "document.cookie",
      timeoutMs: 10000,
      ...body,
    });
    await expect.poll(() => typeof release).toBe("function");
    return { done, release: () => release!() };
  };

  it("evaluate answers through the route", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const calls = mainWorld(page, (expression) => {
      if (expression.startsWith("void 0"))
        return { result: { type: "undefined" } };
      if (expression.startsWith("10n"))
        return {
          result: {
            type: "bigint",
            description: "100n",
            unserializableValue: "100n",
          },
        };
      return { result: { type: "object", value: { items: [1, "two"] } } };
    });
    const answered = await evaluate(tab.id, { expression: "window.cart" });
    expect(answered.status).toBe(200);
    // The tab comes from the controller, so a client refreshes its page from
    // the same answer.
    expect(await answered.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({
        id: tab.id,
        url: "https://example.com/",
        title: "https://example.com/",
        managed: true,
      }),
      value: { items: [1, "two"] },
    });
    const unserializable = await evaluate(tab.id, { expression: "10n ** 2n" });
    expect(await unserializable.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({ id: tab.id }),
      unserializable: "100n",
    });
    // Undefined is neither a value nor text, so the answer carries neither.
    const nothing = await evaluate(tab.id, { expression: "void 0" });
    expect(await nothing.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({ id: tab.id }),
    });
    expect(calls.map((call) => call.expression)).toEqual([
      "window.cart\n//# sourceURL=kamapathy-evaluate.js",
      "10n ** 2n\n//# sourceURL=kamapathy-evaluate.js",
      "void 0\n//# sourceURL=kamapathy-evaluate.js",
    ]);
    // A page script reads what the page reads, so the refs a snapshot gave
    // still point at the same elements.
    expect(refs.generation(tab.id)).toBe(0);
    expect(controller.activity.at(-1)).toMatchObject({
      spaceId: tab.spaceId,
      message: "Agent ran a page script",
    });
  });

  it("evaluate validates before the lane", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const calls = mainWorld(page, () => truthy(true));
    for (const [body, field] of [
      [{ expression: "true", function: "() => true" }, "function"],
      [{}, "expression"],
      [{ expression: "x".repeat(16385) }, "expression"],
      [{ expression: "true", arg: 1 }, "arg"],
      [{ expression: "true", timeoutMs: 1999 }, "timeoutMs"],
      [{ expression: "true", timeoutMs: 60001 }, "timeoutMs"],
    ] as const) {
      const { status, error } = await failure(await evaluate(tab.id, body));
      expect(status, JSON.stringify(body)).toBe(400);
      expect(error, JSON.stringify(body)).toMatchObject({
        code: "invalid_field",
        field,
      });
    }
    expect(calls).toEqual([]);
    // An argument is JSON data, so a 1 MiB body of it is sent as it is.
    const source = "(value) => value.length";
    const padding =
      1048576 -
      Buffer.byteLength(JSON.stringify({ function: source, arg: "" }));
    const large = { function: source, arg: "x".repeat(padding) };
    expect(Buffer.byteLength(JSON.stringify(large))).toBe(1048576);
    const accepted = await evaluate(tab.id, large);
    expect(accepted.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await declaredSize(`/tabs/${tab.id}/evaluate`, 1048577)).toBe(413);
  });

  it("evaluate runs on about:blank but not without a page", async () => {
    const { space, tab } = await createPage();
    const calls = mainWorld(controller.contents, () => truthy("blank"));
    // A committed about:blank document is a page for evaluate, which the
    // hint for data URLs relies on.
    controller.navigateAgentTab(tab.id, "about:blank");
    const answered = await evaluate(tab.id, { expression: "location.href" });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({
      ok: true,
      tab: expect.objectContaining({ url: "about:blank" }),
      value: "blank",
    });
    expect(calls).toHaveLength(1);
    // Every agent space opens with a tab on the new tab page, which has no
    // web document of its own.
    const blank = controller.state.tabs.find(
      (item) => item.spaceId === space.id && item.id !== tab.id,
    )!;
    const refused = await failure(
      await evaluate(blank.id, { expression: "1" }),
    );
    expect(refused.status).toBe(409);
    expect(refused.error).toMatchObject({ code: "no_web_page" });
    expect(calls).toHaveLength(1);
  });

  it("a navigation or a takeover during evaluate withholds the value", async () => {
    const { space, tab } = await createPage();
    const navigated = await heldEvaluate(tab.id, "from the old document");
    controller.contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    navigated.release();
    const changed = await failure(await navigated.done);
    expect(changed.status).toBe(409);
    expect(changed.error).toMatchObject({ code: "page_changed" });
    expect(JSON.stringify(changed.error)).not.toContain("old document");
    // A takeover answers after the call, so the value stays with the page.
    const taken = await heldEvaluate(tab.id, "the person's page");
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    taken.release();
    const held = await failure(await taken.done);
    expect(held.status).toBe(409);
    expect(held.error).toMatchObject({
      code: "human_control",
      reason: "manual",
    });
    expect(JSON.stringify(held.error)).not.toContain("person's page");
  });

  it("evaluate answers 403 while Page scripts are off, in flight included", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const calls = mainWorld(page, () => truthy("ready"));
    controller.state.settings.agentPageScripts = false;
    const off = await failure(await evaluate(tab.id, { expression: "1" }));
    expect(off.status).toBe(403);
    expect(off.error).toEqual({
      code: "agent_scripts_off",
      message: SCRIPTS_OFF_MESSAGE,
    });
    expect(calls).toEqual([]);
    // Switching it off fails the calls already running and withholds what
    // they would have answered.
    controller.state.settings.agentPageScripts = true;
    const running = await heldEvaluate(tab.id, "a value from the page");
    controller.state.settings.agentPageScripts = false;
    api.setPageScripts(false);
    const stopped = await failure(await running.done);
    expect(stopped.status).toBe(403);
    expect(stopped.error).toMatchObject({ code: "agent_scripts_off" });
    expect(JSON.stringify(stopped.error)).not.toContain("value from the page");
    running.release();
  });

  // Section 8's in-page fetch: the page runs the request in Kamapathy's
  // world and the route reads its body.
  const fetchRoute = (tabId: string, body: Record<string, unknown>) => {
    const done = request(`/tabs/${tabId}/fetch`, "POST", body);
    void done.catch(() => {});
    return done;
  };
  const FETCH_HEAD = {
    ok: true,
    status: 200,
    statusText: "OK",
    url: "https://example.com/api/cart",
    redirected: false,
    type: "basic",
    headers: { "content-type": "application/json; charset=utf-8" },
  };
  // A page that answers the fetch operation itself. Each phase arrives as
  // the payload the route sent, in order.
  const servePageFetch = (
    answer: (payload: Record<string, any>, count: number) => unknown,
  ) => {
    const marker = ')("fetch",';
    const calls: Record<string, any>[] = [];
    controller.contents.result = (code: string) => {
      const at = code.indexOf(marker);
      if (at < 0) return {};
      const payload = JSON.parse(
        code.slice(at + marker.length, code.lastIndexOf(',"')),
      );
      calls.push(payload);
      return answer(payload, calls.length);
    };
    return calls;
  };
  // The page's answers for one response: the head, then its body in chunks.
  const servePageBody = (
    head: Record<string, unknown>,
    chunks: Buffer[],
    read?: (count: number) => unknown,
  ) =>
    servePageFetch((payload, count) => {
      if (payload.phase === "start")
        return { ok: true, phase: "start", handle: payload.handle, head };
      if (payload.phase === "cancel") return { ok: true, phase: "cancel" };
      const held = read?.(count);
      if (held !== undefined) return held;
      const chunk = chunks.shift() ?? Buffer.alloc(0);
      return {
        ok: true,
        phase: "read",
        data: chunk.toString("base64"),
        bytes: chunk.length,
        done: chunks.length === 0,
      };
    });
  // The lines of an NDJSON answer, in order.
  const ndjson = async (response: Response) =>
    (await response.text())
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, any>);

  it("fetch validates its options before the lane", async () => {
    const { tab } = await createPage();
    const calls = servePageBody(FETCH_HEAD, [Buffer.from("{}")]);
    const many = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`x-item-${index}`, "1"]),
    );
    for (const [body, field] of [
      [{ url: "/api/cart", method: "CONNECT" }, "method"],
      [{ url: "/api/cart", method: "TRACE" }, "method"],
      [{ url: "/api/cart", method: "TRACK" }, "method"],
      [{ url: "/api/cart", method: "GET POST" }, "method"],
      [{ url: "/api/cart", body: "q=1" }, "body"],
      [{ url: "/api/cart", method: "HEAD", body: "q=1" }, "body"],
      [{ url: "/api/cart", headers: many }, "headers"],
      [{ url: "/api/cart", headers: [["accept", "*/*"]] }, "headers"],
      [{ url: "/api/cart", headers: { Cookie: "lab=sugar" } }, "headers"],
      [{ url: "/api/cart", headers: { Host: "example.com" } }, "headers"],
      [{ url: "/api/cart", headers: { Origin: "https://example.com" } }, "headers"],
      [{ url: "/api/cart", headers: { Referer: "https://example.com/" } }, "headers"],
      [{ url: "/api/cart", headers: { "Sec-Fetch-Mode": "cors" } }, "headers"],
      [{ url: "/api/cart", headers: { "Proxy-Authorization": "Basic x" } }, "headers"],
      [{ url: "/api/cart", mode: "navigate" }, "mode"],
      [{ url: "/api/cart", timeoutMs: 999 }, "timeoutMs"],
      [{ url: "/api/cart", timeoutMs: 300001 }, "timeoutMs"],
    ] as const) {
      const { status, error } = await failure(await fetchRoute(tab.id, body));
      expect(status, JSON.stringify(body)).toBe(400);
      expect(error, JSON.stringify(body)).toMatchObject({
        code: "invalid_field",
        field,
      });
    }
    // A forbidden header says which name the browser sets itself.
    const forbidden = await failure(
      await fetchRoute(tab.id, { url: "/api/cart", headers: { Cookie: "a=b" } }),
    );
    expect(forbidden.error.expected).toContain("Cookie");
    for (const url of [
      "ftp://example.com/file",
      "data:text/plain,hello",
      "https://reader:secret@example.com/",
      "blob:https://other.example/8d1",
      "javascript:fetch('/api')",
    ]) {
      const { status, error } = await failure(await fetchRoute(tab.id, { url }));
      expect(status, url).toBe(400);
      expect(error, url).toMatchObject({ code: "invalid_url" });
    }
    expect(calls).toEqual([]);
    expect(await declaredSize(`/tabs/${tab.id}/fetch`, 1048577)).toBe(413);
  });

  it("only a streamed fetch may ask for more than 60000 ms", async () => {
    const { tab } = await createPage();
    servePageBody(FETCH_HEAD, [Buffer.from("saved")]);
    const refused = await failure(
      await fetchRoute(tab.id, { url: "/api/cart", timeoutMs: 120000 }),
    );
    expect(refused.status).toBe(400);
    expect(refused.error).toMatchObject({
      code: "invalid_field",
      field: "timeoutMs",
      expected: "1000 to 60000 ms, or up to 300000 with saveAs",
    });
    // Saving a body may take the longer limit, which only a stream asks for.
    const streamed = await fetchRoute(tab.id, {
      url: "/api/cart",
      timeoutMs: 300000,
      stream: true,
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = await ndjson(streamed);
    expect(lines.at(-1)).toEqual({ end: { bytes: 5 } });
  });

  it("a relative URL resolves against the tab's URL and a blob of the page's origin is allowed", async () => {
    const { tab } = await createPage();
    const calls = servePageBody(FETCH_HEAD, [Buffer.from("{}")]);
    expect((await fetchRoute(tab.id, { url: "/api/cart?q=1" })).status).toBe(200);
    const blob = "blob:https://example.com/8d1f6a1e-0b36-4c3a-9d3e-1f6a1e0b3645";
    expect((await fetchRoute(tab.id, { url: blob })).status).toBe(200);
    expect(
      calls.filter((call) => call.phase === "start").map((call) => call.url),
    ).toEqual(["https://example.com/api/cart?q=1", blob]);
  });

  it("a non-2xx response resolves", async () => {
    const { tab } = await createPage();
    const head = {
      ok: false,
      status: 404,
      statusText: "Not Found",
      url: "https://example.com/api/cart",
      redirected: true,
      type: "basic",
      headers: { "Content-Type": "text/plain", "X-Request-Id": "r-7" },
    };
    servePageBody(head, [Buffer.from("No such cart")]);
    const answered = await fetchRoute(tab.id, { url: "/api/cart" });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      ok: true,
      tab: expect.objectContaining({ id: tab.id }),
      response: {
        ok: false,
        status: 404,
        statusText: "Not Found",
        url: "https://example.com/api/cart",
        redirected: true,
        type: "basic",
        headers: { "content-type": "text/plain", "x-request-id": "r-7" },
        body: "No such cart",
      },
    });
    expect(controller.activity.at(-1)).toMatchObject({
      spaceId: tab.spaceId,
      message: "Agent fetched a URL in the page",
    });
  });

  it("a body over 8 MiB answers result_too_large with the response fields", async () => {
    const { tab } = await createPage();
    const chunks = Array.from({ length: 9 }, () =>
      Buffer.alloc(1024 * 1024, 97),
    );
    const calls = servePageBody(FETCH_HEAD, chunks);
    const refused = await failure(await fetchRoute(tab.id, { url: "/api/cart" }));
    expect(refused.status).toBe(422);
    expect(refused.error).toMatchObject({
      code: "result_too_large",
      limit: 8 * 1024 * 1024,
      status: 200,
      url: "https://example.com/api/cart",
      headers: FETCH_HEAD.headers,
    });
    expect(refused.error.bytes).toBeGreaterThan(8 * 1024 * 1024);
    // The page stops reading the body it will not answer.
    expect(calls.at(-1)).toMatchObject({ phase: "cancel" });
  });

  it("a CORS failure explains itself", async () => {
    const { tab } = await createPage();
    const url = "https://shop.example/api/cart";
    const calls = servePageFetch(() => ({
      ok: false,
      code: "fetch_failed",
      name: "TypeError",
      error: "Failed to fetch",
      pageOrigin: "https://example.com",
    }));
    // The tab's own session saw the request fail, which is where the reason
    // comes from.
    controller.contents.emitProtocol("Network.requestWillBeSent", {
      requestId: "r-1",
      loaderId: "loader-1",
      documentURL: "https://example.com/",
      request: { url, method: "GET", headers: {} },
      timestamp: 1,
      wallTime: 1,
      initiator: { type: "script" },
      type: "Fetch",
      frameId: "main",
    });
    controller.contents.emitProtocol("Network.loadingFailed", {
      requestId: "r-1",
      timestamp: 2,
      type: "Fetch",
      errorText: "net::ERR_FAILED",
      canceled: false,
      corsErrorStatus: {
        corsError: "MissingAllowOriginHeader",
        failedParameter: "",
      },
    });
    const refused = await failure(await fetchRoute(tab.id, { url }));
    expect(refused.status).toBe(422);
    expect(refused.error).toMatchObject({
      code: "fetch_failed",
      url,
      pageOrigin: "https://example.com",
      crossOrigin: true,
      mode: "cors",
      name: "TypeError",
      corsError: "MissingAllowOriginHeader",
      netError: "net::ERR_FAILED",
    });
    expect(refused.error.message).toContain("https://example.com");
    expect(refused.error.message).toContain(url);
    expect(refused.error.message).toContain("no-cors");
    expect(calls).toHaveLength(1);
  });

  it("a timeout cancels the request", async () => {
    const { tab } = await createPage();
    const silent = new Promise(() => {});
    // Nothing answers the start, so the response is what ran out.
    const starting = servePageFetch((payload) =>
      payload.phase === "cancel" ? { ok: true, phase: "cancel" } : silent,
    );
    const awaited = await failure(
      await fetchRoute(tab.id, { url: "/api/cart", timeoutMs: 1000 }),
    );
    expect(awaited.status).toBe(504);
    expect(awaited.error).toMatchObject({
      code: "fetch_timeout",
      awaited: "response",
      timeoutMs: 1000,
    });
    expect(starting.at(-1)).toMatchObject({
      phase: "cancel",
      handle: starting[0].handle,
    });
    // A head that arrived and a body that stalls ran out of body time.
    const reading = servePageBody(FETCH_HEAD, [], (count) =>
      count > 1 ? silent : undefined,
    );
    const body = await failure(
      await fetchRoute(tab.id, { url: "/api/cart", timeoutMs: 1000 }),
    );
    expect(body.status).toBe(504);
    expect(body.error).toMatchObject({
      code: "fetch_timeout",
      awaited: "body",
      timeoutMs: 1000,
    });
    expect(reading.at(-1)).toMatchObject({ phase: "cancel" });
  });

  it("stream true answers NDJSON head, data and end lines", async () => {
    const { tab } = await createPage();
    const chunk = Buffer.alloc(1024 * 1024, 98);
    servePageBody(FETCH_HEAD, [chunk, Buffer.from("tail")]);
    const streamed = await fetchRoute(tab.id, {
      url: "/api/cart",
      stream: true,
    });
    expect(streamed.status).toBe(200);
    expect(streamed.headers.get("content-type")).toBe("application/x-ndjson");
    expect(streamed.headers.get("cache-control")).toBe("no-store");
    const lines = await ndjson(streamed);
    expect(lines[0]).toEqual({ head: FETCH_HEAD });
    expect(lines.at(-1)).toEqual({ end: { bytes: chunk.length + 4 } });
    for (const line of lines.slice(1, -1)) {
      expect(typeof line.data).toBe("string");
      expect(Buffer.from(line.data, "base64").length).toBeLessThanOrEqual(
        1024 * 1024,
      );
    }
    expect(
      Buffer.concat(
        lines.slice(1, -1).map((line) => Buffer.from(line.data, "base64")),
      ).equals(Buffer.concat([chunk, Buffer.from("tail")])),
    ).toBe(true);
    // A failure after the head is a line of its own, and no end follows.
    servePageFetch((payload, count) =>
      payload.phase === "start"
        ? { ok: true, phase: "start", handle: payload.handle, head: FETCH_HEAD }
        : payload.phase === "cancel"
          ? { ok: true, phase: "cancel" }
          : count > 2
            ? {
                ok: false,
                code: "fetch_failed",
                name: "TypeError",
                error: "network error",
                pageOrigin: "https://example.com",
              }
            : {
                ok: true,
                phase: "read",
                data: Buffer.from("part").toString("base64"),
                bytes: 4,
                done: false,
              },
    );
    const broken = await ndjson(
      await fetchRoute(tab.id, { url: "/api/cart", stream: true }),
    );
    expect(broken[0]).toEqual({ head: FETCH_HEAD });
    expect(broken.at(-1)!.error).toMatchObject({ code: "fetch_failed" });
    expect(broken.some((line) => line.end !== undefined)).toBe(false);
    // Half a gigabyte is as much as one body may stream.
    servePageBody(FETCH_HEAD, [], () => ({
      ok: true,
      phase: "read",
      data: Buffer.from("x").toString("base64"),
      bytes: 64 * 1024 * 1024,
      done: false,
    }));
    const capped = await ndjson(
      await fetchRoute(tab.id, { url: "/api/cart", stream: true }),
    );
    expect(capped.at(-1)!.error).toMatchObject({
      code: "result_too_large",
      limit: 512 * 1024 * 1024,
    });
    expect(capped.some((line) => line.end !== undefined)).toBe(false);
  });

  it("a takeover between chunks aborts the read and withholds the result", async () => {
    const { space, tab } = await createPage();
    let taken: (() => void) | undefined;
    // The first chunk arrives, the second waits for this test.
    servePageFetch((payload, count) => {
      if (payload.phase === "start")
        return {
          ok: true,
          phase: "start",
          handle: payload.handle,
          head: FETCH_HEAD,
        };
      if (payload.phase === "cancel") return { ok: true, phase: "cancel" };
      if (count === 2)
        return {
          ok: true,
          phase: "read",
          data: Buffer.from("the agent's bytes").toString("base64"),
          bytes: 17,
          done: false,
        };
      return new Promise((resolve) => {
        taken = () =>
          resolve({
            ok: true,
            phase: "read",
            data: Buffer.from("the person's bytes").toString("base64"),
            bytes: 18,
            done: true,
          });
      });
    });
    const streaming = fetchRoute(tab.id, { url: "/api/cart", stream: true });
    await expect.poll(() => typeof taken).toBe("function");
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    taken!();
    const lines = await ndjson(await streaming);
    expect(lines[0]).toEqual({ head: FETCH_HEAD });
    expect(lines.at(-1)!.error).toMatchObject({
      code: "human_control",
      reason: "manual",
    });
    expect(lines.some((line) => line.end !== undefined)).toBe(false);
    expect(JSON.stringify(lines)).not.toContain("person's bytes");
  });

  it("a navigation between chunks ends the stream and withholds the result", async () => {
    const { tab } = await createPage();
    let navigated: (() => void) | undefined;
    servePageFetch((payload, count) => {
      if (payload.phase === "start")
        return {
          ok: true,
          phase: "start",
          handle: payload.handle,
          head: FETCH_HEAD,
        };
      if (payload.phase === "cancel") return { ok: true, phase: "cancel" };
      if (count === 2)
        return {
          ok: true,
          phase: "read",
          data: Buffer.from("the first page's bytes").toString("base64"),
          bytes: 22,
          done: false,
        };
      // This chunk belongs to the document the page has left.
      return new Promise((resolve) => {
        navigated = () =>
          resolve({
            ok: true,
            phase: "read",
            data: Buffer.from("the old document's bytes").toString("base64"),
            bytes: 24,
            done: true,
          });
      });
    });
    const streaming = fetchRoute(tab.id, { url: "/api/cart", stream: true });
    await expect.poll(() => typeof navigated).toBe("function");
    controller.contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
    });
    navigated!();
    const lines = await ndjson(await streaming);
    expect(lines[0]).toEqual({ head: FETCH_HEAD });
    expect(lines.at(-1)!.error).toMatchObject({ code: "page_changed" });
    expect(lines.some((line) => line.end !== undefined)).toBe(false);
    expect(JSON.stringify(lines)).not.toContain("old document");
  });

  // Section 8's events route: the tab's recorded protocol events, drained
  // outside every queue.
  const drainEvents = (tabId: string, body: Record<string, unknown> = {}) => {
    const done = request(`/tabs/${tabId}/events`, "POST", body);
    void done.catch(() => {});
    return done;
  };

  it("events answers outside the space's queue", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    for (const max of [0, 10001, 1.5]) {
      const { status, error } = await failure(
        await drainEvents(tab.id, { max }),
      );
      expect(status, String(max)).toBe(400);
      expect(error, String(max)).toMatchObject({
        code: "invalid_field",
        field: "max",
      });
    }
    page.debugger.event("Network.loadingFinished", {
      requestId: "1",
      encodedDataLength: 5,
    });
    page.debugger.event("Page.loadEventFired", { timestamp: 1 });
    // A pending evaluate holds the space's lane, and the drain answers now.
    const running = await heldEvaluate(tab.id, "a value from the page");
    const drained = await drainEvents(tab.id, { max: 1 });
    expect(drained.status).toBe(200);
    expect(await drained.json()).toEqual({
      ok: true,
      events: [
        {
          time: expect.any(Number),
          method: "Network.loadingFinished",
          params: { requestId: "1", encodedDataLength: 5 },
        },
      ],
      dropped: 0,
      gaps: [],
      remaining: 1,
    });
    running.release();
    expect((await running.done).status).toBe(200);
  });

  it("events answers 403 while Page scripts are off", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    page.debugger.event("Page.loadEventFired", { timestamp: 1 });
    controller.state.settings.agentPageScripts = false;
    api.setPageScripts(false);
    const off = await failure(await drainEvents(tab.id));
    expect(off.status).toBe(403);
    expect(off.error).toEqual({
      code: "agent_scripts_off",
      message: SCRIPTS_OFF_MESSAGE,
    });
    // The switch-off emptied the log, so nothing waits for the switch.
    controller.state.settings.agentPageScripts = true;
    api.setPageScripts(true);
    expect(await (await drainEvents(tab.id)).json()).toEqual({
      ok: true,
      events: [],
      dropped: 0,
      gaps: [],
      remaining: 0,
    });
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

  it("answers an action that caused nothing without a receipt field, and keeps upload's body while adding them", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    page.result = (code: string) =>
      code.includes(')("target",') ? { ok: true, x: 25, y: 45 } : { ok: true };
    const click = await request(`/tabs/${tab.id}/click`, "POST", {
      ref: "@e1",
    });
    expect(click.status).toBe(200);
    expect(await click.json()).toEqual({
      ok: true,
      url: "https://example.com/",
    });

    // The page opens a window while the upload runs, so its answer names it.
    const body = uploadBody();
    page.result = (code: string) => {
      if (code.includes(')("upload",'))
        controller.openPopup(tab.id, "https://example.com/share");
      return { ok: true, selected: 1 };
    };
    const upload = await request(`/tabs/${tab.id}/upload`, "POST", body);
    expect(upload.status).toBe(200);
    const popup = controller.state.tabs.find(
      (item) => item.openerId === tab.id,
    )!;
    expect(await upload.json()).toEqual({
      ok: true,
      selected: 1,
      popups: [
        {
          id: popup.id,
          label: popup.label,
          url: "https://example.com/share",
        },
      ],
    });
    expect(page.scripts.at(-1)!.code).toContain(
      `)("upload",${JSON.stringify(body)},`,
    );
  });

  it("opens the tab's request window at route entry and ends it when the route ends, failures included", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    // A read changes nothing, so it opens no window.
    expect((await request(`/tabs/${tab.id}/snapshot`)).status).toBe(200);
    expect(controller.routeSignals).toEqual([]);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    page.result = async () => {
      await blocked;
      return { ok: true, x: 25, y: 45 };
    };
    const click = request(`/tabs/${tab.id}/click`, "POST", { ref: "@e1" });
    await expect
      .poll(() => controller.routeSignals)
      .toEqual([`start ${tab.id}`]);
    release();
    expect((await click).status).toBe(200);
    expect(controller.routeSignals).toEqual([
      `start ${tab.id}`,
      `end ${tab.id}`,
    ]);

    controller.routeSignals = [];
    page.result = () => {
      throw new Error("the page went away");
    };
    const failed = await request(`/tabs/${tab.id}/click`, "POST", {
      ref: "@e1",
    });
    expect(failed.status).toBe(500);
    expect(controller.routeSignals).toEqual([
      `start ${tab.id}`,
      `end ${tab.id}`,
    ]);

    // Each batch step runs in its own window, like its own dispatch record.
    controller.routeSignals = [];
    page.result = { ok: true, x: 25, y: 45 };
    const batch = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "click", ref: "@e1" },
        { type: "click", ref: "@e2" },
      ],
    });
    expect(batch.status).toBe(200);
    expect(controller.routeSignals).toEqual([
      `start ${tab.id}`,
      `end ${tab.id}`,
      `start ${tab.id}`,
      `end ${tab.id}`,
    ]);
  });

  it("the popup list reports every tab this tab opened with its label, url, openedAt and unseen flag", async () => {
    const { tab } = await createPage();
    const first = controller.openPopup(tab.id, "https://example.com/one");
    const second = controller.openPopup(tab.id, "https://example.com/two");
    const nested = controller.openPopup(second.id, "https://example.com/three");
    const popupsOf = async (tabId: string) => {
      const response = await request(`/tabs/${tabId}/popups`);
      expect(response.status).toBe(200);
      return (await response.json()).popups as { unseen?: true }[];
    };
    expect(await popupsOf(tab.id)).toEqual([
      {
        id: first.id,
        label: first.label,
        url: "https://example.com/one",
        openedAt: first.createdAt,
        unseen: true,
      },
      {
        id: second.id,
        label: second.label,
        url: "https://example.com/two",
        openedAt: second.createdAt,
        unseen: true,
      },
    ]);
    // Listing a page twice leaves every flag for the run's own notice.
    expect((await popupsOf(tab.id)).map((item) => item.unseen)).toEqual([
      true,
      true,
    ]);
    // A route that addresses a popup reports it, so its flag clears.
    expect((await request(`/tabs/${first.id}/snapshot`)).status).toBe(200);
    expect(await popupsOf(tab.id)).toEqual([
      expect.not.objectContaining({ unseen: true }),
      expect.objectContaining({ id: second.id, unseen: true }),
    ]);
    // A popup of a popup belongs to its own opener.
    expect(await popupsOf(second.id)).toEqual([
      expect.objectContaining({ id: nested.id, label: nested.label }),
    ]);
  });

  it("answers a popup wait with the page the action opened", async () => {
    const { tab } = await createPage();
    const armed = await request(`/tabs/${tab.id}/expectations`, "POST", {
      event: "popup",
    });
    expect(armed.status).toBe(201);
    const { expectation } = await armed.json();
    expect(expectation).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
      event: "popup",
      tabId: tab.id,
      expiresAt: expect.any(Number),
    });
    // The page waits for one popup at a time.
    const again = await request(`/tabs/${tab.id}/expectations`, "POST", {
      event: "popup",
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: {
        code: "expectation_pending",
        message: expect.stringContaining("already waiting"),
        event: "popup",
        expectationId: expectation.id,
      },
    });

    const waiting = request(`/expectations/${expectation.id}/wait`, "POST", {});
    let opened = false;
    controller.contents.result = (code: string) => {
      if (!code.includes(')("target",')) return { ok: true };
      if (!opened) {
        opened = true;
        controller.openPopup(tab.id, "https://example.com/share");
      }
      return { ok: true, x: 25, y: 45 };
    };
    const click = await request(`/tabs/${tab.id}/click`, "POST", {
      ref: "@e1",
    });
    expect(click.status).toBe(200);
    const popup = controller.state.tabs.find(
      (item) => item.openerId === tab.id,
    )!;
    const answered = await waiting;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({
      popup: expect.objectContaining({
        id: popup.id,
        label: popup.label,
        url: "https://example.com/share",
        openerId: tab.id,
      }),
    });
    // The result and the click's receipt both report it, so it is seen.
    expect(popup.unseen).toBeUndefined();
    // One event uses the arm up.
    expect(
      (await request(`/expectations/${expectation.id}/wait`, "POST", {})).status,
    ).toBe(404);
    expect(
      (await request(`/expectations/${expectation.id}`, "DELETE")).status,
    ).toBe(404);
  });

  it("a 17th wait answers 429 busy with scope server and retryable, and expectation routes never take the space lane", async () => {
    const { space, tab } = await createPage();
    const arm = async (tabId: string, event: string) => {
      const response = await request(`/tabs/${tabId}/expectations`, "POST", {
        event,
        timeoutMs: 60000,
      });
      expect(response.status).toBe(201);
      return (await response.json()).expectation.id as string;
    };
    // A click holds the space's lane while the popup list, a wait and a
    // cancel answer beside it.
    const held = await arm(tab.id, "popup");
    let releaseClick!: () => void;
    controller.contents.result = (code: string) =>
      code.includes(')("target",')
        ? new Promise((resolve) => {
            releaseClick = () => resolve({ ok: true, x: 25, y: 45 });
          })
        : { ok: true };
    const click = request(`/tabs/${tab.id}/click`, "POST", { ref: "@e1" });
    await expect.poll(() => releaseClick).toBeDefined();
    expect((await request(`/tabs/${tab.id}/popups`)).status).toBe(200);
    const waiting = request(`/expectations/${held}/wait`, "POST", {});
    expect((await request(`/expectations/${held}`, "DELETE")).status).toBe(200);
    expect((await waiting).status).toBe(404);
    // Arming is a page route, so it waits for the lane the click holds.
    const queued = request(`/tabs/${tab.id}/expectations`, "POST", {
      event: "dialog",
    });
    expect(
      await Promise.race([
        queued.then(() => "answered"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 50)),
      ]),
    ).toBe("waiting");
    releaseClick();
    expect((await click).status).toBe(200);
    const answered = await queued;
    expect(answered.status).toBe(201);
    const { expectation } = await answered.json();
    expect(
      (await request(`/expectations/${expectation.id}`, "DELETE")).status,
    ).toBe(200);

    // Sixteen waits run at once, and each takes one of the slots they share.
    const tabs = [tab.id];
    for (let index = 0; index < 4; index += 1) {
      const opened = await request(`/spaces/${space.id}/tabs`, "POST", {});
      expect(opened.status).toBe(201);
      tabs.push((await opened.json()).tab.id as string);
    }
    const ids: string[] = [];
    for (const tabId of tabs)
      for (const event of ["popup", "download", "filechooser", "dialog"])
        if (ids.length < 17) ids.push(await arm(tabId, event));
    const waits = ids
      .slice(0, 16)
      .map((id) => request(`/expectations/${id}/wait`, "POST", {}));
    await expect
      .poll(() => {
        const release = takeWaitSlot();
        release?.();
        return release === undefined;
      })
      .toBe(true);
    const refused = await request(`/expectations/${ids[16]}/wait`, "POST", {});
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: {
        code: "busy",
        message: expect.stringContaining("16"),
        scope: "server",
        retryable: true,
      },
    });
    for (const id of ids.slice(0, 16))
      expect((await request(`/expectations/${id}`, "DELETE")).status).toBe(200);
    for (const answer of await Promise.all(waits))
      expect(answer.status).toBe(404);
  });

  it("answers a bypassing dialog from the policy, resolves a dialog wait with it, and still fails a page route when one stays open after the backstop fails", async () => {
    const { tab } = await createPage();
    const page = controller.contents;
    const opening = (type: string, message: string) => ({
      url: "https://example.com/",
      frameId: "main",
      message,
      type,
      hasBrowserHandler: true,
      defaultPrompt: "",
    });
    const answers = () =>
      page.debugger.sent.filter(
        (command) => command.method === "Page.handleJavaScriptDialog",
      );
    const armed = await request(`/tabs/${tab.id}/expectations`, "POST", {
      event: "dialog",
    });
    expect(armed.status).toBe(201);
    const { expectation } = await armed.json();
    const waiting = request(`/expectations/${expectation.id}/wait`, "POST", {});
    // A dialog that never reached the page's handler is answered from the
    // same policy, so no dialog ever stays open.
    page.emitProtocol(
      "Page.javascriptDialogOpening",
      opening("confirm", "Bypass?"),
    );
    await expect.poll(() => answers().length).toBe(1);
    expect(answers()[0].params).toEqual({ accept: false });
    page.emitProtocol("Page.javascriptDialogClosed", {
      result: false,
      userInput: "",
    });
    const record = {
      type: "confirm",
      message: "Bypass?",
      answer: "dismissed",
      url: "https://example.com/",
      at: expect.any(Number),
    };
    const answered = await waiting;
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ dialog: record });
    const log = await request(`/tabs/${tab.id}/dialogs`);
    expect(await log.json()).toEqual({ policy: null, dialogs: [record] });

    // A dialog the backstop cannot answer stays open, so phase 1's
    // dialog_open holds this tab's page routes until the person closes it.
    page.debugger.reply("Page.handleJavaScriptDialog", () => {
      throw new Error("No dialog is showing");
    });
    page.emitProtocol(
      "Page.javascriptDialogOpening",
      opening("alert", "Stuck"),
    );
    await expect.poll(() => answers().length).toBe(2);
    const refused = await request(`/tabs/${tab.id}/snapshot`);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatchObject({
      code: "dialog_open",
      dialog: { type: "alert", message: "Stuck" },
      started: false,
    });
    // Nothing answered it, so nothing records it either.
    expect(
      (await (await request(`/tabs/${tab.id}/dialogs`)).json()).dialogs,
    ).toEqual([record]);
  });

  it("the dialog-policy route validates accept, promptText, times and lifetimeMs, DELETE resets, and the dialogs route answers the policy with its records", async () => {
    const { tab } = await createPage();
    const policy = `/tabs/${tab.id}/dialog-policy`;
    for (const body of [
      {},
      { accept: "yes" },
      { accept: true, promptText: "a".repeat(4097) },
      { accept: true, times: 0 },
      { accept: true, times: 21 },
      { accept: true, lifetimeMs: 999 },
      { accept: true, lifetimeMs: 600001 },
      { accept: true, dismiss: true },
    ]) {
      const refused = await request(policy, "POST", body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    const armed = await request(policy, "POST", {
      accept: true,
      promptText: "Ada",
      times: 3,
    });
    expect(armed.status).toBe(200);
    expect(await armed.json()).toEqual({
      policy: {
        accept: true,
        promptText: "Ada",
        remaining: 3,
        expiresAt: expect.any(Number),
      },
    });
    const empty = await request(`/tabs/${tab.id}/dialogs`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      policy: expect.objectContaining({ remaining: 3 }),
      dialogs: [],
    });

    // The page's handler reports what it answered through its binding.
    const binding = controller.contents.debugger.sent.find(
      (command) => command.method === "Runtime.addBinding",
    )!.params.name as string;
    controller.contents.emitProtocol("Runtime.bindingCalled", {
      name: binding,
      executionContextId: 1,
      payload: JSON.stringify({
        type: "prompt",
        message: "Your name?",
        defaultValue: "preset",
        answer: "accepted",
        promptText: "Ada",
        url: "https://example.com/",
      }),
    });
    const listed = await request(`/tabs/${tab.id}/dialogs`);
    expect(await listed.json()).toEqual({
      policy: expect.objectContaining({ remaining: 2 }),
      dialogs: [
        {
          type: "prompt",
          message: "Your name?",
          defaultValue: "preset",
          answer: "accepted",
          promptText: "Ada",
          url: "https://example.com/",
          at: expect.any(Number),
        },
      ],
    });
    // A dialog the action itself causes is in its receipt.
    controller.contents.result = (code: string) => {
      if (!code.includes(')("target",')) return { ok: true };
      controller.contents.emitProtocol("Runtime.bindingCalled", {
        name: binding,
        executionContextId: 1,
        payload: JSON.stringify({
          type: "confirm",
          message: "Delete this file?",
          answer: "accepted",
          url: "https://example.com/",
        }),
      });
      return { ok: true, x: 25, y: 45 };
    };
    const click = await request(`/tabs/${tab.id}/click`, "POST", {
      ref: "@e1",
    });
    expect((await click.json()).dialog).toMatchObject({ type: "confirm" });
    expect(
      (await (await request(`/tabs/${tab.id}/dialogs`)).json()).policy,
    ).toMatchObject({ remaining: 1 });

    const reset = await request(policy, "DELETE");
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ policy: null });
    const after = await request(`/tabs/${tab.id}/dialogs`);
    expect(await after.json()).toEqual({
      policy: null,
      dialogs: [
        expect.objectContaining({ type: "prompt" }),
        expect.objectContaining({ type: "confirm" }),
      ],
    });
    // A page with no debugger session cannot arm one.
    const blank = await request(`/spaces/${tab.spaceId}/tabs`, "POST", {});
    const other = (await blank.json()).tab as { id: string };
    const refused = await request(`/tabs/${other.id}/dialog-policy`, "POST", {
      accept: true,
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.code).toBe("debugger_busy");
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
  // A stand-in for the updater: the routes use only these four methods, so
  // this file needs no Electron.
  class FakeUpdates {
    kind: UpdateState["kind"] = "mac-arm64";
    state: UpdateState["state"] = "available";
    notice: UpdateReminder | null = null;
    started = true;
    hold = false;
    failure: Error | undefined;
    checkCalls = 0;
    downloadCalls = 0;
    private waiting: (() => void)[] = [];
    status(): UpdateStatus {
      return {
        kind: this.kind,
        state: this.state,
        version: "0.2.0",
        checks: true,
      };
    }
    async check(): Promise<UpdateStatus> {
      this.checkCalls++;
      if (this.failure) throw this.failure;
      if (this.hold)
        await new Promise<void>((resolve) => this.waiting.push(resolve));
      return this.status();
    }
    async download(): Promise<{ status: UpdateStatus; started: boolean }> {
      this.downloadCalls++;
      if (this.failure) throw this.failure;
      return { status: this.status(), started: this.started };
    }
    reminder(): UpdateReminder | null {
      return this.notice;
    }
    release(): void {
      for (const resolve of this.waiting.splice(0)) resolve();
    }
  }
  // What electron/updates.ts throws when a check fails or this copy has no
  // installer.
  class FakeFailure extends Error {
    constructor(
      readonly code: string,
      message: string,
      readonly fields: Record<string, unknown>,
    ) {
      super(message);
      this.name = "UpdateFailure";
    }
  }
  const withUpdates = async (updates: FakeUpdates) => {
    await api.close();
    api = await startAutomation(controller, {
      socketPath: socket.path,
      updates,
    });
    return updates;
  };
  // Requests on one connection, answered in order. Their answers are never
  // read, so 32 pending requests stay under the server's connection limit.
  const pipelined = (path: string, count: number) => {
    const client = netConnect(socket.path);
    client.on("error", () => {});
    client.write(
      `POST ${path} HTTP/1.1\r\nHost: kamapathy\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`.repeat(
        count,
      ),
    );
    return client;
  };

  it("reports API level, engine versions and skill folder from health before the queue", async () => {
    // Electron's and Chromium's versions are present only in the app.
    const body = {
      status: "ok",
      version: controller.state.version,
      apiLevel: API_LEVEL,
      versions: { node: process.versions.node, v8: process.versions.v8 },
    };
    expect(await (await request("/health")).json()).toEqual(body);
    await api.close();
    api = await startAutomation(controller, {
      socketPath: socket.path,
      skillPath: "/x/skills/kamapathy",
    });
    const { tab } = await createPage();
    controller.contents.result = new Promise(() => {});
    const running = request(`/tabs/${tab.id}/snapshot`);
    void running.catch(() => {});
    const response = await request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ...body,
      skill: { path: "/x/skills/kamapathy" },
    });
  });

  it("answers update routes without a lane", async () => {
    const updates = await withUpdates(new FakeUpdates());
    const { tab } = await createPage();
    const snapshot = await heldSnapshot(tab.id);
    // The space's lane is busy, and each update route still answers at once.
    for (const [path, method, status] of [
      ["/update", "GET", 200],
      ["/update/check", "POST", 200],
      ["/update/download", "POST", 202],
    ] as const)
      expect(
        await within(
          settled(request(path, method, method === "POST" ? {} : undefined)),
          1000,
        ),
        path,
      ).toEqual({ status });
    snapshot.release();
    expect(await snapshot.result).toEqual({ status: 200 });
    controller.pages.get(tab.id)!.result = { text: "" };
    // Pending update requests, two per connection so 32 of them stay under
    // the server's 32 connections.
    updates.hold = true;
    updates.checkCalls = 0;
    const connections = Array.from({ length: 9 }, () =>
      pipelined("/update/check", 2),
    );
    await expect.poll(() => updates.checkCalls).toBe(18);
    // More than a space's 16, and the space's own cap is untouched.
    const page = settled(request(`/tabs/${tab.id}/snapshot`));
    expect(await within(page, 1000)).toEqual({ status: 200 });
    for (let more = 0; more < 7; more++)
      connections.push(pipelined("/update/check", 2));
    await expect.poll(() => updates.checkCalls).toBe(32);
    const refused = await request("/update");
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toEqual({
      code: "busy",
      message: "Kamapathy has too many requests waiting. Try again shortly.",
      scope: "server",
      retryable: true,
    });
    // Health is answered before admission, so the full server still has it.
    expect((await request("/health")).status).toBe(200);
    updates.release();
    for (const client of connections) client.destroy();
  });

  it("adds update to /health only with a reminder", async () => {
    const updates = await withUpdates(new FakeUpdates());
    const health = async () => (await request("/health")).json();
    expect(await health()).not.toHaveProperty("update");
    updates.notice = { version: "0.3.0", state: "available" };
    expect(await health()).toMatchObject({
      status: "ok",
      update: { version: "0.3.0", state: "available" },
    });
    // Still before admission, while the space's lane runs a page read.
    const { tab } = await createPage();
    const snapshot = await heldSnapshot(tab.id);
    expect(await within(health(), 1000)).toMatchObject({
      update: { version: "0.3.0", state: "available" },
    });
    snapshot.release();
    expect(await snapshot.result).toEqual({ status: 200 });
    // Read for each request, so a reminder that ends disappears.
    updates.notice = null;
    expect(await health()).not.toHaveProperty("update");
  });

  it("maps check failures to 502 with reason and retryable", async () => {
    const updates = await withUpdates(new FakeUpdates());
    expect(await (await request("/update")).json()).toEqual({
      kind: "mac-arm64",
      state: "available",
      version: "0.2.0",
      checks: true,
    });
    const check = async (fields: Record<string, unknown>) => {
      updates.failure = new FakeFailure(
        "update_check_failed",
        "Kamapathy couldn't reach GitHub to check for updates.",
        fields,
      );
      const response = await request("/update/check", "POST", {});
      return { status: response.status, error: (await response.json()).error };
    };
    const failed = (fields: Record<string, unknown>) => ({
      status: 502,
      error: {
        code: "update_check_failed",
        message: "Kamapathy couldn't reach GitHub to check for updates.",
        ...fields,
      },
    });
    expect(await check({ reason: "network" })).toEqual(
      failed({ reason: "network", retryable: true }),
    );
    expect(await check({ reason: "rate_limited", retryAfterMs: 60000 })).toEqual(
      failed({ reason: "rate_limited", retryAfterMs: 60000, retryable: true }),
    );
    expect(await check({ reason: "invalid_response" })).toEqual(
      failed({ reason: "invalid_response" }),
    );
    expect(await check({ reason: "http_status", httpStatus: 404 })).toEqual(
      failed({ reason: "http_status", httpStatus: 404 }),
    );
    expect(await check({ reason: "http_status", httpStatus: 503 })).toEqual(
      failed({ reason: "http_status", httpStatus: 503, retryable: true }),
    );
    updates.failure = undefined;
    const download = async () => {
      const response = await request("/update/download", "POST", {});
      return { status: response.status, body: await response.json() };
    };
    updates.state = "downloading";
    expect(await download()).toMatchObject({
      status: 202,
      body: { state: "downloading" },
    });
    // A second request joins the download that is already running.
    updates.started = false;
    expect(await download()).toMatchObject({ status: 202 });
    updates.state = "ready";
    expect(await download()).toMatchObject({
      status: 200,
      body: { state: "ready" },
    });
    updates.state = "current";
    expect(await download()).toMatchObject({ status: 200 });
    expect(updates.downloadCalls).toBe(4);
  });

  it("refuses update routes in a source run, and a body key with unknown_field", async () => {
    const calls = [
      ["/update", "GET"],
      ["/update/check", "POST"],
      ["/update/download", "POST"],
    ] as const;
    const refusals = async () => {
      const seen = [];
      for (const [path, method] of calls) {
        const response = await request(
          path,
          method,
          method === "POST" ? {} : undefined,
        );
        seen.push({
          path,
          status: response.status,
          error: (await response.json()).error,
        });
      }
      return seen;
    };
    const unsupported = (message: string, reason: string) => ({
      code: "update_unsupported",
      message,
      reason,
      platform: process.platform,
      arch: process.arch,
    });
    // beforeEach started the server without an update service.
    for (const seen of await refusals())
      expect(seen.status, seen.path).toBe(409);
    for (const seen of await refusals())
      expect(seen.error, seen.path).toEqual(
        unsupported("No installer is published for this computer yet.", "platform"),
      );
    const updates = await withUpdates(new FakeUpdates());
    updates.kind = "source";
    for (const seen of await refusals())
      expect(seen.error, seen.path).toEqual(
        unsupported(
          "This copy runs from source. Pull the latest code to update it.",
          "source",
        ),
      );
    updates.kind = "other";
    for (const seen of await refusals())
      expect(seen.error, seen.path).toEqual(
        unsupported("No installer is published for this computer yet.", "platform"),
      );
    // A refusal never reaches the updater's own check or download.
    expect([updates.checkCalls, updates.downloadCalls]).toEqual([0, 0]);
    const response = await request("/update/check", "POST", { force: true });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual({
      code: "unknown_field",
      message: 'POST /update/check has no field "force". Allowed: none.',
      field: "force",
      allowed: [],
      route: "POST /update/check",
      apiLevel: API_LEVEL,
    });
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
      "POST /spaces/:id/status": { text: "Comparing prices" },
      "POST /spaces/:id/fail": { message: "The site needs a phone number" },
      "POST /space-requests": { reason: "Book a table" },
      "POST /spaces/:id/tabs": { url: "https://example.com/" },
      "POST /tabs/:id/navigate": { url: "https://example.com/" },
      "POST /tabs/:id/reload": {},
      "POST /tabs/:id/wait-for-url": { url: "https://example.com/*" },
      "POST /tabs/:id/wait-for-load-state": { state: "commit" },
      "POST /tabs/:id/wait-for-function": { expression: "true" },
      "POST /tabs/:id/evaluate": { expression: "true" },
      "POST /tabs/:id/fetch": { url: "/api/cart" },
      "POST /tabs/:id/events": { max: 10 },
      "POST /tabs/:id/snapshot": {},
      "POST /tabs/:id/actions": { actions: [{ type: "snapshot" }] },
      "POST /tabs/:id/click": { ref: "@e1" },
      "POST /tabs/:id/fill": { ref: "@e1", value: "x" },
      "POST /tabs/:id/press": { key: "Enter" },
      "POST /tabs/:id/scroll": { direction: "down" },
      "POST /tabs/:id/drag": { source: { ref: "@e1" }, target: { ref: "@e2" } },
      "POST /tabs/:id/wait": { text: "Done" },
      "POST /tabs/:id/screenshot": {},
      "POST /tabs/:id/upload": uploadBody(),
      "POST /update/check": {},
      "POST /update/download": {},
      "POST /tabs/:id/pdf/text": { from: 1, maxChars: 0 },
      "POST /tabs/:id/expectations": { event: "popup", timeoutMs: 1000 },
      "POST /expectations/:id/wait": {},
      "POST /tabs/:id/dialog-policy": { accept: false },
      "POST /downloads/:id/cancel": {},
      "POST /downloads/:id/wait": { timeoutMs: 1000 },
      "POST /spaces/:id/http-credentials": {
        origin: "https://shop.example",
        username: "person",
        password: "secret",
      },
    };
    // A wait names its arm, and a cancel its download, not a space or a tab.
    const armed = await request(`/tabs/${tab.id}/expectations`, "POST", {
      event: "popup",
      timeoutMs: 60000,
    });
    const expectationId = (await armed.json()).expectation.id as string;
    expect(
      (
        await request(`/tabs/${tab.id}/expectations`, "POST", {
          event: "download",
          timeoutMs: 60000,
        })
      ).status,
    ).toBe(201);
    const captured = controller.startDownload(
      tab.id,
      new FakeDownloadItem({ filename: "report.pdf" }),
    );
    const downloadId = (captured as { id: string }).id;
    const tabs = controller.state.tabs.length;
    for (const route of ROUTES.filter((item) => item.method === "POST" && item.body)) {
      const key = routeKey(route);
      expect(SAMPLES, key).toHaveProperty(key);
      const path = route.path.replace(
        ":id",
        route.path.startsWith("/spaces/")
          ? space.id
          : route.path.startsWith("/expectations/")
            ? expectationId
            : route.path.startsWith("/downloads/")
              ? downloadId
              : tab.id,
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
      allowed: ["type", "ref", "selector", "label"],
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

  it("no route serves passwords", async () => {
    const passwordNames = /passw|vault|autofill|saved.?login/i;
    const named = (names: string[]) =>
      names.filter((name) => passwordNames.test(name));
    expect(named(ROUTES.map((route) => route.path))).toEqual([]);
    expect(named(ACTIONS.map((action) => action.type))).toEqual([]);
    expect(named(ENTRIES.map((entry) => entry.name))).toEqual([]);
    expect(named(COMMANDS.map((command) => command.name))).toEqual([]);
    // The password manager's error codes answer shell calls only.
    const shellCodes = [
      "invalid_login",
      "import_file_invalid",
      "vault_unavailable",
      "reauth_failed",
      "login_not_found",
      "vault_locked",
      "vault_full",
      "login_exists",
      "vault_write_failed",
    ];
    expect(
      Object.keys(ERRORS).filter((code) => shellCodes.includes(code)),
    ).toEqual([]);
    const { space, tab } = await createPage();
    const page = controller.pages.get(tab.id)!;
    const accessed = controller.accessedTabs.length;
    const calls = controller.calls.length;
    for (const [method, path] of [
      ["GET", "/passwords"],
      ["GET", "/vault"],
      ["GET", `/spaces/${space.id}/passwords`],
      ["POST", `/tabs/${tab.id}/autofill`],
      ["POST", `/tabs/${tab.id}/passwords/fill`],
    ]) {
      const response = await request(
        path,
        method,
        method === "POST" ? {} : undefined,
      );
      expect(response.status, path).toBe(404);
      expect((await response.json()).error.code, path).toBe("route_not_found");
    }
    expect(page.scripts).toEqual([]);
    expect(page.inputs).toEqual([]);
    expect(page.captures).toEqual([]);
    expect(controller.accessedTabs).toHaveLength(accessed);
    expect(controller.calls).toHaveLength(calls);
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

  it("file tabs hidden: never listed, labeled or returned, and tab routes answer tab_not_found", async () => {
    const json = async (path: string, method = "GET", body?: unknown) => {
      const response = await request(path, method, body);
      return { status: response.status, body: await response.json() };
    };
    const notFound = (tabId: string) => ({
      status: 404,
      body: {
        error: {
          code: "tab_not_found",
          message: "Agent tab was not found.",
          tabId,
        },
      },
    });
    const ids = (tabs: { id: string }[]) => tabs.map((tab) => tab.id);
    const workTabs = () =>
      ids(controller.state.tabs.filter((tab) => tab.spaceId === "work"));
    // The person reads a file on this computer beside a web page.
    const blank = controller.state.tabs.find((tab) => tab.spaceId === "work")!;
    const web = controller.openPersonTab("work", "https://example.com/work");
    const file = controller.openPersonTab("work", "file:///tmp/notes.pdf");
    controller.closeTab(blank.id, "person");
    controller.state.activeSpaceId = "work";
    controller.state.activeTabId = file.id;
    // The person answers an agent's request with that space while the file
    // is shown.
    const asked = json("/space-requests", "POST", { reason: "Book a table" });
    await expect.poll(() => controller.state.spaceRequests.length).toBe(1);
    api.answerRequest(controller.state.spaceRequests[0].id, {
      allow: true,
      spaceId: "work",
    });
    expect(await asked).toEqual({
      status: 200,
      body: {
        space: expect.objectContaining({ id: "work", owner: "agent" }),
        tabs: [
          expect.objectContaining({ id: web.id, label: "p1", active: false }),
        ],
        active: null,
      },
    });
    expect(file).not.toHaveProperty("label");
    const listing = await json("/spaces/work/tabs");
    expect(listing.status).toBe(200);
    expect(ids(listing.body.tabs)).toEqual([web.id]);
    expect(listing.body.budget).toEqual({ used: 0, limit: 20 });
    // Every tab route answers as if the tab did not exist, adopt included.
    for (const [path, method, body] of [
      [`/tabs/${file.id}/adopt`, "POST", {}],
      [`/tabs/${file.id}/release`, "POST", {}],
      [`/tabs/${file.id}/snapshot`, "POST", {}],
      [`/tabs/${file.id}/snapshot`, "GET", undefined],
      [`/tabs/${file.id}/navigate`, "POST", { url: "https://example.com/" }],
      [`/tabs/${file.id}`, "DELETE", undefined],
    ] as const)
      expect(await json(path, method, body), `${method} ${path}`).toEqual(
        notFound(file.id),
      );
    expect(file).toMatchObject({ managed: false, url: "file:///tmp/notes.pdf" });
    expect(controller.accessedTabs).not.toContain(file.id);
    expect(controller.calls.map((call) => call.type)).toEqual([]);
    // A boundary taken while a file is shown has no active tab, and lists
    // only the web pages opened meanwhile.
    await controller.dispatch({
      type: "space:ownership",
      id: "work",
      owner: "human",
    });
    const later = controller.openPersonTab("work", "https://example.com/later");
    const another = controller.openPersonTab("work", "file:///tmp/later.png");
    controller.state.activeTabId = file.id;
    const boundary = {
      status: 200,
      body: {
        ok: true,
        owner: "agent",
        active: null,
        opened: [expect.objectContaining({ id: later.id, label: "p2" })],
        closed: [],
      },
    };
    expect(await json("/spaces/work/resume", "POST", {})).toEqual(boundary);
    expect(await json("/spaces/work/wait-for-control", "POST", {})).toEqual(
      boundary,
    );
    controller.state.activeTabId = web.id;
    expect(
      (await json("/spaces/work/resume", "POST", {})).body.active,
    ).toMatchObject({ id: web.id, active: true });
    // A refusal to close the space lists the person's web pages only.
    const refusal = await json("/spaces/work", "DELETE");
    expect(refusal.status).toBe(409);
    expect(refusal.body.error.code).toBe("space_protected");
    expect(ids(refusal.body.error.tabs)).toEqual([web.id, later.id]);
    // finish refuses a file tab in keep before anything closes.
    const page = (
      await json("/spaces/work/tabs", "POST", { url: "https://example.com/" })
    ).body.tab;
    expect(page.label).toBe("p3");
    expect(
      await json("/spaces/work/finish", "POST", { keep: [file.id] }),
    ).toEqual(notFound(file.id));
    expect(
      await json("/spaces/work/finish", "POST", { keep: [page.id, another.id] }),
    ).toEqual(notFound(another.id));
    expect(workTabs()).toEqual([web.id, file.id, later.id, another.id, page.id]);
    // Finishing closes the agent's page and leaves the files open, unlisted.
    expect(await json("/spaces/work/finish", "POST", { keep: [] })).toEqual({
      status: 200,
      body: {
        ok: true,
        spaceId: "work",
        closedSpace: false,
        closed: ["p3"],
        kept: [],
        protected: ["p1", "p2"],
      },
    });
    expect(workTabs()).toEqual([web.id, file.id, later.id, another.id]);
    // An agent space never opens files, and its refusal would not list one.
    const space = await createSpace();
    const own = controller.openPersonTab(space.id, "https://example.com/own");
    controller.openPersonTab(space.id, "file:///tmp/own.pdf");
    const agentRefusal = await json(`/spaces/${space.id}`, "DELETE");
    expect(agentRefusal.status).toBe(409);
    expect(ids(agentRefusal.body.error.tabs)).toEqual([own.id]);
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

  // Section 16's PDF route. A PDF tab answers pdfDocument with its content
  // type, and its own session answers the re-read.
  const PDF_BYTES = Buffer.concat([
    Buffer.from("%PDF-1.7\n"),
    Buffer.from("A short document.\n"),
  ]);
  const PDF_PAGES: PdfPages = {
    title: "Quarterly report",
    pageCount: 3,
    from: 1,
    to: 3,
    pages: [
      { number: 1, text: "Page one" },
      { number: 2, text: "Page two" },
      { number: 3, text: "Page three" },
    ],
    chars: 26,
    truncated: false,
  };
  type PdfRange = { from: number; to?: number; maxChars: number };
  // An extractor the test answers for, in place of the utility process.
  const fakeExtractor = (extract: () => Promise<PdfPages>) => {
    const calls: { bytes: Buffer; request: PdfRange; deadline: number }[] = [];
    const extractor: Extractor = {
      running: () => calls.length,
      extract: (bytes, request, deadline) => {
        calls.push({ bytes: Buffer.from(bytes), request, deadline });
        return extract();
      },
    };
    return { calls, extractor };
  };
  // A PDF worker that answers only when the test ends it.
  class HangingWorker {
    private exits: ((code: number) => void)[] = [];
    postMessage() {}
    on(event: "message" | "exit", listener: (value: never) => void) {
      if (event === "exit") this.exits.push(listener as (code: number) => void);
      return this;
    }
    kill() {
      return true;
    }
    exit() {
      for (const listener of this.exits) listener(0);
    }
  }
  // A server with the test's own extractor, before any space exists.
  const restartWithPdf = async (extractor: Extractor) => {
    await api.close();
    api = await startAutomation(controller, {
      socketPath: socket.path,
      pdf: { extractor },
    });
  };
  const pdfTab = async (
    options: { contentType?: string; body?: () => BodyInit } = {},
  ) => {
    const { space, tab } = await createPage();
    const page = controller.pages.get(tab.id)!;
    const contentType = options.contentType ?? "application/pdf";
    page.result = (code: string) =>
      code.includes("document.contentType") ? { contentType } : {};
    page.fetchPdf = async () => new Response(options.body?.() ?? PDF_BYTES);
    return { space, tab, page };
  };

  it("refuses a pdf range the schema or the route bounds before reaching the page", async () => {
    const { tab, page } = await pdfTab();
    for (const [body, field] of [
      [{ to: 501 }, "to"],
      [{ from: 2, to: 1 }, "to"],
      [{ maxChars: 1000001 }, "maxChars"],
      [{ from: 0 }, "from"],
      [{ timeoutMs: 60001 }, "timeoutMs"],
    ] as const) {
      const response = await request(`/tabs/${tab.id}/pdf/text`, "POST", body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(
        (await response.json()).error,
        JSON.stringify(body),
      ).toMatchObject({ code: "invalid_field", field });
    }
    const wide = await request(`/tabs/${tab.id}/pdf/text`, "POST", { to: 501 });
    expect((await wide.json()).error).toMatchObject({
      message: "to must be an integer from 1 to 500.",
      expected: "an integer from 1 to 500",
    });
    expect(page.scripts).toEqual([]);
    expect(page.fetches).toEqual([]);
  });

  it("answers not_pdf for a tab that is not showing a PDF, without reading bytes", async () => {
    const { tab, page } = await pdfTab({ contentType: "text/html" });
    const response = await request(`/tabs/${tab.id}/pdf/text`, "POST", {});
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      code: "not_pdf",
      contentType: "text/html",
      message: "This tab is not showing a PDF. Use snapshot for web pages.",
    });
    expect(page.fetches).toEqual([]);
  });

  it("never sends a form again: a PDF a POST returned answers pdf_not_refetchable", async () => {
    const { tab, page } = await pdfTab();
    page.emitProtocol("Network.requestWillBeSent", {
      requestId: "loader-1",
      loaderId: "loader-1",
      documentURL: "https://example.com/",
      request: { url: "https://example.com/", method: "POST" },
      type: "Document",
      frameId: "main",
    });
    const response = await request(`/tabs/${tab.id}/pdf/text`, "POST", {});
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      code: "pdf_not_refetchable",
      reason: "post",
    });
    expect(page.fetches).toEqual([]);
  });

  it("stops a PDF streaming past 64 MiB", async () => {
    const chunk = Buffer.alloc(8 * 1024 * 1024, 0x20);
    chunk.write("%PDF-1.7");
    const { tab } = await pdfTab({
      body: () => {
        let left = 12;
        return new ReadableStream({
          pull(stream) {
            if (left-- > 0) stream.enqueue(chunk);
            else stream.close();
          },
        });
      },
    });
    const response = await request(`/tabs/${tab.id}/pdf/text`, "POST", {});
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatchObject({
      code: "pdf_too_large",
      limitBytes: 67108864,
    });
  });

  it("reads a PDF's text page by page and reports it in the space", async () => {
    let answer: PdfPages = PDF_PAGES;
    const { extractor, calls } = fakeExtractor(async () => answer);
    await restartWithPdf(extractor);
    const { space, tab, page } = await pdfTab();
    const response = await request(`/tabs/${tab.id}/pdf/text`, "POST", {
      maxChars: 500,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: "https://example.com/",
      title: "Quarterly report",
      pageCount: 3,
      from: 1,
      to: 3,
      pages: PDF_PAGES.pages,
      chars: 26,
      truncated: false,
    });
    expect(page.fetches.map((item) => item.url)).toEqual([
      "https://example.com/",
    ]);
    expect(calls[0].request).toEqual({ from: 1, maxChars: 500 });
    expect(calls[0].bytes.equals(PDF_BYTES)).toBe(true);
    expect(controller.activity.at(-1)).toMatchObject({
      spaceId: space.id,
      message: "Agent read a PDF (3 pages).",
      kind: "info",
    });
    // A document without a title of its own reads as the tab, and one page
    // is one page.
    answer = {
      title: "",
      pageCount: 1,
      from: 1,
      to: 1,
      pages: [{ number: 1, text: "Only page" }],
      chars: 9,
      truncated: true,
      nextPage: 1,
      noText: true,
    };
    const second = await request(`/tabs/${tab.id}/pdf/text`, "POST", {
      from: 1,
      to: 1,
      maxChars: 4,
    });
    expect(await second.json()).toEqual({
      url: "https://example.com/",
      title: "https://example.com/",
      pageCount: 1,
      from: 1,
      to: 1,
      pages: [{ number: 1, text: "Only page" }],
      chars: 9,
      truncated: true,
      nextPage: 1,
      noText: true,
    });
    expect(calls[1].request).toEqual({ from: 1, to: 1, maxChars: 4 });
    expect(controller.activity.at(-1)?.message).toBe(
      "Agent read a PDF (1 page).",
    );
  });

  it("refuses a PDF whose page changed while Kamapathy read it", async () => {
    const { extractor, calls } = fakeExtractor(async () => PDF_PAGES);
    await restartWithPdf(extractor);
    const { tab, page } = await pdfTab();
    let release!: () => void;
    page.fetchPdf = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response(PDF_BYTES));
      });
    const pending = request(`/tabs/${tab.id}/pdf/text`, "POST", {});
    await expect.poll(() => typeof release).toBe("function");
    page.navigate("https://example.com/other.pdf");
    release();
    const response = await pending;
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatchObject({
      code: "page_changed",
      message:
        "The page changed while Kamapathy read the PDF. Read it again.",
    });
    expect(calls).toEqual([]);
  });

  it("withholds a PDF's text when the person takes over while it is read", async () => {
    let finish!: () => void;
    const { extractor } = fakeExtractor(
      () =>
        new Promise<PdfPages>((resolve) => {
          finish = () => resolve(PDF_PAGES);
        }),
    );
    await restartWithPdf(extractor);
    const { space, tab } = await pdfTab();
    const pending = request(`/tabs/${tab.id}/pdf/text`, "POST", {});
    await expect.poll(() => typeof finish).toBe("function");
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    finish();
    const response = await pending;
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(JSON.parse(text).error.code).toBe("human_control");
    expect(text).not.toContain("Page two");
    expect(
      controller.activity.some((item) =>
        item.message.startsWith("Agent read a PDF"),
      ),
    ).toBe(false);
  });

  it("reads two PDFs at a time and refuses a third with busy", async () => {
    const workers: HangingWorker[] = [];
    await restartWithPdf(
      createExtractor({
        cMapUrl: "/cmaps/",
        fork: () => {
          const worker = new HangingWorker();
          workers.push(worker);
          return worker as unknown as PdfChild;
        },
      }),
    );
    const first = await pdfTab();
    const second = await pdfTab();
    const third = await pdfTab();
    const held = [
      request(`/tabs/${first.tab.id}/pdf/text`, "POST", {}),
      request(`/tabs/${second.tab.id}/pdf/text`, "POST", {}),
    ];
    await expect.poll(() => workers.length).toBe(2);
    const refused = await request(`/tabs/${third.tab.id}/pdf/text`, "POST", {});
    expect(refused.status).toBe(429);
    expect((await refused.json()).error).toMatchObject({
      code: "busy",
      scope: "pdf",
      retryable: true,
    });
    for (const worker of workers) worker.exit();
    for (const response of await Promise.all(held)) {
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe("pdf_unreadable");
    }
  });

  it("reads a PDF without holding its space, so another read there starts", async () => {
    const releases: (() => void)[] = [];
    const { extractor, calls } = fakeExtractor(
      () =>
        new Promise<PdfPages>((resolve) => {
          releases.push(() => resolve(PDF_PAGES));
        }),
    );
    await restartWithPdf(extractor);
    const { tab } = await pdfTab();
    const first = settled(request(`/tabs/${tab.id}/pdf/text`, "POST", {}));
    await expect.poll(() => calls.length).toBe(1);
    // The second read reaches the extractor while the first still waits.
    const second = settled(request(`/tabs/${tab.id}/pdf/text`, "POST", {}));
    await expect.poll(() => calls.length).toBe(2);
    for (const release of releases) release();
    expect(await first).toEqual({ status: 200 });
    expect(await second).toEqual({ status: 200 });
  });

  it("the download list, read, cancel and delete routes authorize their space and answer download_not_found for an unknown id", async () => {
    const { space, tab } = await createPage();
    const armed = await request(`/tabs/${tab.id}/expectations`, "POST", {
      event: "download",
    });
    expect(armed.status).toBe(201);
    const item = new FakeDownloadItem({
      filename: "report.pdf",
      url: "https://example.com/report.pdf",
      mimeType: "application/pdf",
      totalBytes: 9,
    });
    const captured = controller.startDownload(tab.id, item);
    expect(captured).toEqual({ captured: true, id: expect.any(String) });
    const id = (captured as { id: string }).id;
    // The list and the read answer the same view, and no path of this
    // machine is in it.
    const view = {
      id,
      tabId: tab.id,
      url: "https://example.com/report.pdf",
      suggestedFilename: "report.pdf",
      mimeType: "application/pdf",
      state: "progressing",
      receivedBytes: 0,
      totalBytes: 9,
      failure: null,
    };
    const listed = await request(`/spaces/${space.id}/downloads`);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ downloads: [view] });
    expect((await (await request(`/downloads/${id}`)).json()).download).toEqual(
      view,
    );
    // An unknown id is not found on any of the four routes.
    for (const [path, method] of [
      ["/downloads/0123456789abcdef", "GET"],
      ["/downloads/0123456789abcdef/cancel", "POST"],
      ["/downloads/0123456789abcdef", "DELETE"],
      [`/spaces/${space.id}/downloads/0123456789abcdef`, "GET"],
    ] as const) {
      const missing = await request(
        path,
        method,
        method === "POST" ? {} : undefined,
      );
      expect([404, 404]).toContain(missing.status);
      expect((await missing.json()).error.code).toBe(
        path.startsWith("/downloads") ? "download_not_found" : "route_not_found",
      );
    }
    // The person taking over refuses every one of them, as a page route.
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    const held = await request(`/downloads/${id}`);
    expect(held.status).toBe(409);
    expect((await held.json()).error.code).toBe("human_control");
    expect((await request(`/spaces/${space.id}/downloads`)).status).toBe(409);
    await request(`/spaces/${space.id}/resume`, "POST", {});

    // Cancel stops a running download and answers its record; a finished
    // one is left as it is.
    const cancelled = await request(`/downloads/${id}/cancel`, "POST", {});
    expect(cancelled.status).toBe(200);
    expect(item.cancelled).toBe(true);
    item.finish("cancelled", 4);
    const after = (await (await request(`/downloads/${id}`)).json()).download;
    expect(after).toMatchObject({
      state: "cancelled",
      failure: "cancelled",
      receivedBytes: 4,
    });
    expect((await request(`/downloads/${id}/cancel`, "POST", {})).status).toBe(
      200,
    );
    // Delete takes the bytes with it, and the id is gone.
    const removed = await request(`/downloads/${id}`, "DELETE");
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect((await request(`/downloads/${id}`)).status).toBe(404);
    expect(
      (await (await request(`/spaces/${space.id}/downloads`)).json()).downloads,
    ).toEqual([]);
  });

  it("the content route answers 409 download_not_finished, 409 download_failed and 429 busy past four streams, and the wait route 429 busy past the shared wait cap", async () => {
    const { tab } = await createPage();
    // An armed download of this tab, as the controller's handler delivers it.
    const capture = async (filename: string) => {
      expect(
        (
          await request(`/tabs/${tab.id}/expectations`, "POST", {
            event: "download",
          })
        ).status,
      ).toBe(201);
      const item = new FakeDownloadItem({ filename });
      const decision = controller.startDownload(tab.id, item);
      expect(decision.captured).toBe(true);
      return { id: (decision as { id: string }).id, item };
    };
    const { id, item } = await capture("report.bin");
    item.progress(5);
    const running = await request(`/downloads/${id}/content`);
    expect(running.status).toBe(409);
    expect(await running.json()).toEqual({
      error: {
        code: "download_not_finished",
        message: expect.stringContaining("still running"),
        state: "progressing",
        receivedBytes: 5,
        totalBytes: 0,
      },
    });
    item.finish("interrupted", 5);
    const failed = await request(`/downloads/${id}/content`);
    expect(failed.status).toBe(409);
    expect((await failed.json()).error).toMatchObject({
      code: "download_failed",
      failure: "interrupted",
    });

    // Four byte streams are all the socket serves at once.
    const payload = Buffer.alloc(2 * 1024 * 1024, 7);
    const open: Awaited<ReturnType<typeof stall>>[] = [];
    for (let index = 0; index < 4; index += 1) {
      const stream = await capture(`file-${index}.bin`);
      writeFileSync(stream.item.savePath, payload);
      stream.item.finish("completed", payload.length);
      open.push(await stall(`/downloads/${stream.id}/content`));
    }
    const refused = await request(`/downloads/${id}/content`);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({
      error: {
        code: "busy",
        message: expect.stringContaining("4"),
        scope: "server",
        retryable: true,
      },
    });
    // The first stream carries the whole file and names no file of this
    // machine.
    const first = open[0].response;
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("application/octet-stream");
    expect(first.headers["content-length"]).toBe(String(payload.length));
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["x-content-type-options"]).toBe("nosniff");
    expect(Object.keys(first.headers)).not.toContain("content-disposition");
    const chunks: Buffer[] = [];
    first.on("data", (chunk: Buffer) => chunks.push(chunk));
    first.resume();
    await new Promise((resolve) => first.once("end", resolve));
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
    // A client that goes away mid-stream gives its slot back.
    for (const stream of open.slice(1)) stream.client.destroy();
    await expect
      .poll(async () => (await request(`/downloads/${id}/content`)).status)
      .toBe(409);

    // A download wait takes one of the sixteen slots every long poll shares.
    const releases: (() => void)[] = [];
    for (let release = takeWaitSlot(); release; release = takeWaitSlot())
      releases.push(release);
    const busy = await request(`/downloads/${id}/wait`, "POST", {});
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({
      error: {
        code: "busy",
        message: expect.stringContaining("16"),
        scope: "server",
        retryable: true,
      },
    });
    for (const release of releases) release();
    // One that has already stopped answers its wait at once.
    const answered = await request(`/downloads/${id}/wait`, "POST", {
      timeoutMs: 1000,
    });
    expect(answered.status).toBe(200);
    expect((await answered.json()).download).toMatchObject({
      id,
      state: "interrupted",
      failure: "interrupted",
    });
    const invalid = await request(`/downloads/${id}/wait`, "POST", {
      timeoutMs: 0,
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatchObject({
      code: "invalid_field",
    });
  });


  it("http-credentials validates its origin, username and password, answers ok with the origin only, and DELETE clears every origin of the space", async () => {
    const space = await createSpace();
    const path = `/spaces/${space.id}/http-credentials`;
    const post = (body: Record<string, unknown>) =>
      request(path, "POST", {
        origin: "https://shop.example",
        username: "person",
        password: "secret",
        ...body,
      });
    const refuses = async (body: Record<string, unknown>, field: string) => {
      const response = await post(body);
      expect(response.status, field).toBe(400);
      expect((await response.json()).error.code, field).toBe("invalid_field");
    };
    await refuses({ origin: "https://shop.example/orders" }, "path");
    await refuses({ origin: "https://shop.example/?q=1" }, "query");
    await refuses({ origin: "https://shop.example/#top" }, "fragment");
    await refuses({ origin: "ftp://shop.example" }, "scheme");
    await refuses({ origin: "shop.example" }, "bare host");
    await refuses({ origin: "https://person:secret@shop.example" }, "credentials");
    await refuses({ username: "" }, "empty username");
    await refuses({ username: "p".repeat(257) }, "long username");
    await refuses({ password: "s".repeat(1025) }, "long password");
    // The origin is stored as an origin, and an empty password is allowed.
    const stored = await post({
      origin: "https://shop.example:443/",
      password: "",
    });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toEqual({
      ok: true,
      origin: "https://shop.example",
    });
    expect(controller.credentialOrigins.get(space.id)).toEqual([
      "https://shop.example",
    ]);
    expect(controller.activity.at(-1)).toEqual({
      spaceId: space.id,
      message: "Agent stored a sign-in for https://shop.example",
      kind: "info",
    });
    // DELETE clears every origin of the space.
    const cleared = await request(path, "DELETE");
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true });
    expect(controller.credentialOrigins.get(space.id)).toBeUndefined();
  });

  it("a ninth origin reaches the space and credentials are cleared when the server stops", async () => {
    const space = await createSpace();
    const path = `/spaces/${space.id}/http-credentials`;
    for (let index = 0; index <= 8; index += 1) {
      const response = await request(path, "POST", {
        origin: `https://shop${index}.example`,
        username: "person",
        password: "secret",
      });
      expect(response.status, `origin ${index}`).toBe(200);
    }
    // The route stores each one; the prompt center keeps the newest eight.
    expect(controller.credentialOrigins.get(space.id)).toHaveLength(9);
    await api.close();
    expect(controller.credentialOrigins.size).toBe(0);
    expect(controller.clearedPrompts).toContain("credentials");
  });

  it("status and fail validate their bodies, run in the space lane and refuse under human control", async () => {
    const { space, tab } = await createPage();
    const statusOf = async (spaceId: string) =>
      (await (await request(`/spaces/${spaceId}`)).json()).space;
    // Section 11's body check answers the limit first, with the field and
    // what it expected.
    const long = await request(`/spaces/${space.id}/status`, "POST", {
      text: "x".repeat(121),
    });
    expect(long.status).toBe(400);
    expect((await long.json()).error).toMatchObject({
      code: "invalid_field",
      field: "text",
      expected: "a string of at most 120 characters",
    });
    const unknown = await request(`/spaces/${space.id}/status`, "POST", {
      text: "Comparing prices",
      extra: true,
    });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.code).toBe("unknown_field");
    // A status is cleaned, answered and listed, and an empty one clears it.
    const set = await request(`/spaces/${space.id}/status`, "POST", {
      text: "Comparing\u0000prices ",
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ ok: true, status: "Comparingprices" });
    expect(await statusOf(space.id)).toMatchObject({
      status: "Comparingprices",
    });
    const cleared = await request(`/spaces/${space.id}/status`, "POST", {
      text: "",
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ ok: true });
    expect(await statusOf(space.id)).not.toHaveProperty("status");
    // Both run in the space's own lane, behind the page work before them.
    const held = await heldSnapshot(tab.id);
    const queued = settled(
      request(`/spaces/${space.id}/status`, "POST", { text: "Reading" }),
    );
    expect(await within(queued, 100)).toBe("pending");
    held.release();
    expect(await held.result).toEqual({ status: 200 });
    expect(await queued).toEqual({ status: 200 });
    // A failure message must survive cleaning.
    const blank = await request(`/spaces/${space.id}/fail`, "POST", {
      message: " \u200e ",
    });
    expect(blank.status).toBe(400);
    expect((await blank.json()).error).toMatchObject({
      code: "invalid_field",
      field: "message",
      expected: "text that is not empty after cleaning",
    });
    const missing = await request(`/spaces/${space.id}/fail`, "POST", {});
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatchObject({
      code: "invalid_field",
      field: "message",
    });
    const failed = await request(`/spaces/${space.id}/fail`, "POST", {
      message: "The site needs a phone number I do not have",
    });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({
      ok: true,
      owner: "human",
      state: "failed",
      status: "The site needs a phone number I do not have",
    });
    expect(await statusOf(space.id)).toMatchObject({
      owner: "human",
      reason: "failed",
      state: "failed",
      status: "The site needs a phone number I do not have",
    });
    expect(controller.activity.at(-1)).toEqual({
      spaceId: space.id,
      message: "Agent could not finish",
      kind: "warning",
      agentText: "The site needs a phone number I do not have",
    });
    // Afterwards both are refused, naming the failure as the reason.
    for (const [path, body] of [
      ["status", { text: "Still here" }],
      ["fail", { message: "Again" }],
    ] as const) {
      const response = await request(
        `/spaces/${space.id}/${path}`,
        "POST",
        body,
      );
      expect(response.status, path).toBe(409);
      expect((await response.json()).error, path).toMatchObject({
        code: "human_control",
        reason: "failed",
      });
    }
  });

  it("follow routes reveal their tab before the handler runs and observation routes do not", async () => {
    const space = await createSpace();
    // A reveal takes a turn of its own here, so a handler that did not wait
    // for it would be recorded first.
    controller.frames = 1;
    const order: string[] = [];
    const reveal = controller.showAgentTab.bind(controller);
    // Recorded once the reveal is done, so a route that did not wait for it
    // puts its own work first.
    controller.showAgentTab = async (tabId: string) => {
      await reveal(tabId);
      order.push(`show ${tabId}`);
    };
    const dispatch = controller.dispatch.bind(controller);
    controller.dispatch = async (action: BrowserAction) => {
      order.push(action.type);
      return dispatch(action);
    };
    const addActivity = controller.addActivity.bind(controller);
    controller.addActivity = (spaceId, message, kind, agentText) => {
      order.push(message);
      addActivity(spaceId, message, kind, agentText);
    };
    // A new page is revealed once it exists, before the route logs or
    // answers it.
    const opened = await request(`/spaces/${space.id}/tabs`, "POST", {
      url: "https://example.com/",
    });
    expect(opened.status).toBe(201);
    const tab = (await opened.json()).tab as BrowserState["tabs"][number];
    expect(controller.shown).toEqual([tab.id]);
    expect(order).toEqual([`show ${tab.id}`, "Agent opened example.com"]);
    const page = controller.contents;
    page.result = () => {
      order.push("page");
      return {
        url: "https://example.com/",
        title: "Example",
        text: "Hello from the agent page",
        interactables: [],
        truncated: false,
      };
    };
    // Each route that reads or acts on the page reveals it first.
    for (const [path, method, body] of [
      [`/tabs/${tab.id}/snapshot`, "GET", undefined],
      [`/tabs/${tab.id}/snapshot`, "POST", { mode: "full" }],
    ] as const) {
      order.length = 0;
      expect((await request(path, method, body)).status, path).toBe(200);
      expect(order[0], path).toBe(`show ${tab.id}`);
      expect(order, path).toContain("page");
    }
    order.length = 0;
    // Section 5's navigate waits for the page's own load, so the route
    // answers only once those events arrive.
    const { done: navigating } = await dispatched(
      tab.id,
      { url: "https://example.com/next" },
      page.loads.length + 1,
    );
    const document = mainFrame(page, "loader-follow");
    document.start("https://example.com/next");
    document.request("https://example.com/next");
    document.response(200);
    document.commit("https://example.com/next");
    document.lifecycle("DOMContentLoaded");
    document.lifecycle("load");
    expect((await navigating).status).toBe(200);
    // The route loads the page itself, so the reveal is all that comes
    // before its activity entry.
    expect(order).toEqual([`show ${tab.id}`, "Agent navigated to example.com"]);
    // Routes that only read, or hand control over, reveal nothing.
    const revealed = controller.shown.length;
    for (const [path, method, body] of [
      ["/spaces", "GET", undefined],
      [`/spaces/${space.id}`, "GET", undefined],
      [`/spaces/${space.id}/tabs`, "GET", undefined],
      [`/spaces/${space.id}/status`, "POST", { text: "Reading" }],
      [`/spaces/${space.id}/handoff`, "POST", {}],
      [`/spaces/${space.id}/resume`, "POST", {}],
    ] as const) {
      expect((await request(path, method, body)).status, path).toBe(200);
      expect(controller.shown.length, path).toBe(revealed);
    }
    expect(controller.shown).toEqual([tab.id, tab.id, tab.id, tab.id]);
  });

  it("a labeled click and a labeled batch step show their label while they run and for five seconds after", async () => {
    const { space, tab } = await createPage();
    const labelOf = () =>
      controller.state.spaces.find((item) => item.id === space.id)?.task?.label;
    // What the person would see at each page operation of the action.
    const during: string[] = [];
    const watch = (code: string) => {
      const label = labelOf();
      const shown = label
        ? `${label.text} ${label.active ? "running" : "ended"}`
        : "none";
      if (during.at(-1) !== shown) during.push(shown);
      return code.includes(')("drag",')
        ? { ok: true, from: { x: 10, y: 20 }, to: { x: 110, y: 220 } }
        : { ok: true, x: 25, y: 45 };
    };
    controller.contents.result = watch;
    const clicked = await request(`/tabs/${tab.id}/click`, "POST", {
      ref: "@e1",
      label: "Open the first\u0000 result ",
    });
    expect(clicked.status).toBe(200);
    // The label is the agent's cleaned words while its action runs, and it
    // stays afterwards for the interface to count its five seconds.
    expect(during).toEqual(["Open the first result running"]);
    expect(labelOf()).toEqual({
      text: "Open the first result",
      active: false,
      at: expect.any(Number),
    });
    // An action without a label clears the last one instead of keeping it.
    during.length = 0;
    expect(
      (await request(`/tabs/${tab.id}/click`, "POST", { ref: "@e1" })).status,
    ).toBe(200);
    expect(during).toEqual(["none"]);
    expect(labelOf()).toBeUndefined();
    // A failed action still leaves its own label for the person to read.
    controller.contents.result = (code: string) => {
      watch(code);
      return {
        ok: false,
        code: "stale_ref",
        error: "Element reference is stale.",
      };
    };
    during.length = 0;
    expect(
      (
        await request(`/tabs/${tab.id}/fill`, "POST", {
          ref: "@e1",
          value: "Ada",
          label: "Fill the delivery address",
        })
      ).status,
    ).toBe(409);
    expect(during).toEqual(["Fill the delivery address running"]);
    expect(labelOf()).toMatchObject({
      text: "Fill the delivery address",
      active: false,
    });
    // Each batch step owns the label while it runs, in order.
    during.length = 0;
    controller.contents.result = watch;
    const batch = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "fill", ref: "@e1", value: "Ada", label: "Fill the name" },
        { type: "fill", ref: "@e2", value: "Lovelace" },
        { type: "click", ref: "@e3", label: "Open the first result" },
      ],
    });
    expect(batch.status).toBe(200);
    expect(during).toEqual([
      "Fill the name running",
      "none",
      "Open the first result running",
    ]);
    expect(labelOf()).toMatchObject({
      text: "Open the first result",
      active: false,
    });
  });

  it("label is accepted only where the schema declares it", async () => {
    const { space, tab } = await createPage();
    const labelOf = () =>
      controller.state.spaces.find((item) => item.id === space.id)?.task?.label;
    controller.contents.result = (code: string) =>
      code.includes(')("snapshot",')
        ? {
            url: "https://example.com/",
            title: "Example",
            text: "Hello from the agent page",
            interactables: [],
            truncated: false,
          }
        : code.includes(')("drag",')
          ? { ok: true, from: { x: 10, y: 20 }, to: { x: 110, y: 220 } }
          : { ok: true, x: 25, y: 45 };
    for (const [type, body] of [
      ["click", { ref: "@e1" }],
      ["fill", { ref: "@e1", value: "Ada" }],
      ["press", { key: "Enter" }],
      ["scroll", { direction: "down" }],
      ["drag", { source: { ref: "@e1" }, target: { selector: "#zone" } }],
    ] as const) {
      const response = await request(`/tabs/${tab.id}/${type}`, "POST", {
        ...body,
        label: `Step ${type}`,
      });
      expect(response.status, type).toBe(200);
      expect(labelOf(), type).toMatchObject({
        text: `Step ${type}`,
        active: false,
      });
    }
    // Every other route refuses a label, naming the field, what it does
    // take, and the route and level the client checks against.
    for (const [path, body] of [
      [`/tabs/${tab.id}/snapshot`, {}],
      [`/tabs/${tab.id}/navigate`, { url: "https://example.com/next" }],
      [`/tabs/${tab.id}/wait`, { text: "Done" }],
      [`/tabs/${tab.id}/actions`, { actions: [{ type: "click", ref: "@e1" }] }],
      [`/spaces/${space.id}/tabs`, { url: "https://example.com/" }],
      [`/spaces/${space.id}/status`, { text: "Reading" }],
      [`/spaces/${space.id}/handoff`, {}],
    ] as const) {
      const response = await request(path, "POST", {
        ...body,
        label: "Reading the page",
      });
      expect(response.status, path).toBe(400);
      expect((await response.json()).error, path).toMatchObject({
        code: "unknown_field",
        field: "label",
        allowed: expect.not.arrayContaining(["label"]),
        apiLevel: API_LEVEL,
        route: expect.stringContaining(path.split("/")[1]),
      });
    }
    // A batch step that declares no label refuses one before any step runs.
    const step = await request(`/tabs/${tab.id}/actions`, "POST", {
      actions: [
        { type: "click", ref: "@e1", label: "Open the first result" },
        { type: "wait", text: "Done", label: "Wait for the page" },
      ],
    });
    expect(step.status).toBe(400);
    expect((await step.json()).error).toMatchObject({
      code: "unknown_field",
      field: "label",
      action: "wait",
      index: 1,
      allowed: ["type", "selector", "text", "timeoutMs"],
      route: "POST /tabs/:id/actions",
    });
    // A GET carries no body, so a label sent to one is never read, and the
    // label the last action left stands.
    const read = await request(`/tabs/${tab.id}/snapshot`, "GET", {
      label: "Reading the page",
    });
    expect(read.status).toBe(200);
    expect(labelOf()).toMatchObject({ text: "Step drag", active: false });
  });
});
