import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  startAutomation,
  type AutomationServer,
} from "../electron/agent/server";
import type { SpaceView, TabView } from "../electron/agent/views";
import { agentRules, HOME_URL } from "../shared/state";
import { FakeController, socketFetch, testSocket } from "./fake-automation";

describe("agent spaces", () => {
  let controller: FakeController;
  let api: AutomationServer;
  let socket: ReturnType<typeof testSocket>;
  let send: ReturnType<typeof socketFetch>;
  // Every answer these tests read is JSON.
  const request = async (path: string, method = "GET", body?: unknown) => {
    const response = await send(path, {
      method,
      headers:
        body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const createSpace = async (
    body: Record<string, unknown> = { name: "Research" },
  ) => {
    const created = await request("/spaces", "POST", body);
    expect(created.status).toBe(201);
    return created.body as { space: SpaceView; tab: TabView; created: true };
  };
  const openPage = async (spaceId: string, url = "https://example.com/") => {
    const opened = await request(`/spaces/${spaceId}/tabs`, "POST", { url });
    expect(opened.status).toBe(201);
    return opened.body.tab as TabView;
  };
  const listTabs = async (spaceId: string) => {
    const listed = await request(`/spaces/${spaceId}/tabs`);
    expect(listed.status).toBe(200);
    return listed.body as {
      tabs: TabView[];
      closed: { label: string; closedBy: string; at: number }[];
      budget: { used: number; limit: number };
    };
  };
  const stateTab = (id: string) =>
    controller.state.tabs.find((tab) => tab.id === id);
  const spaceTabs = (spaceId: string) =>
    controller.state.tabs.filter((tab) => tab.spaceId === spaceId);
  const listed = async () =>
    (await request("/spaces")).body.spaces.map(
      (space: { id: string }) => space.id,
    );
  const within = <T>(promise: Promise<T>, ms: number) =>
    Promise.race([
      promise,
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), ms),
      ),
    ]);
  const restart = async () => {
    api = await startAutomation(controller, { socketPath: socket.path });
    send = socketFetch(socket.path);
  };
  beforeEach(async () => {
    controller = new FakeController();
    socket = testSocket();
    await restart();
  });
  afterEach(async () => {
    await api.close();
    socket.cleanup();
  });

  it("the first tab is p1, agent-opened and managed", async () => {
    const created = await request("/spaces", "POST", { name: "Research" });
    expect(created).toEqual({
      status: 201,
      body: {
        space: {
          id: expect.any(String),
          name: "Research",
          color: "purple",
          kind: "agent",
          owner: "agent",
          signIns: "shared",
          createdAt: expect.any(Number),
          createdBy: "agent",
          pageBudget: 20,
          recentTabTitles: ["New tab"],
        },
        tab: {
          id: expect.any(String),
          spaceId: expect.any(String),
          title: "New tab",
          url: HOME_URL,
          pinned: false,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          label: "p1",
          openedBy: "agent",
          managed: true,
          active: true,
        },
        created: true,
      },
    });
    const { space, tab } = created.body;
    expect(tab.spaceId).toBe(space.id);
    expect(stateTab(tab.id)).toMatchObject({
      label: "p1",
      openedBy: "agent",
      managed: true,
    });
    const opened = await request(`/spaces/${space.id}/tabs`, "POST", {
      url: "https://example.com/",
    });
    expect(opened.status).toBe(201);
    expect(opened.body.tab).toMatchObject({
      spaceId: space.id,
      url: "https://example.com/",
      label: "p2",
      openedBy: "agent",
      managed: true,
    });
    expect(controller.activity.at(-1)).toEqual({
      spaceId: space.id,
      message: "Agent opened example.com",
      kind: "info",
    });
    // Without a URL the agent gets a blank page.
    const blank = await request(`/spaces/${space.id}/tabs`, "POST", {});
    expect(blank.status).toBe(201);
    expect(blank.body.tab).toMatchObject({
      url: HOME_URL,
      label: "p3",
      openedBy: "agent",
      managed: true,
    });
    expect(controller.activity.at(-1)).toEqual({
      spaceId: space.id,
      message: "Agent opened a blank page",
      kind: "info",
    });
    const listing = await listTabs(space.id);
    expect(
      listing.tabs.map((item) => [item.label, item.openedBy, item.managed]),
    ).toEqual([
      ["p1", "agent", true],
      ["p2", "agent", true],
      ["p3", "agent", true],
    ]);
    expect(
      listing.tabs.filter((item) => item.active).map((item) => item.id),
    ).toEqual([controller.shownTab(space.id)!.id]);
    expect(listing.tabs[0]).not.toHaveProperty("createdAt");
    expect(listing.closed).toEqual([]);
    expect(listing.budget).toEqual({ used: 3, limit: 20 });
  });

  it("reuse matches ids, then first names, never unlisted spaces, and refuses other sign-ins", async () => {
    const first = (await createSpace({ name: "Research" })).space;
    const second = (await createSpace({ name: "Research" })).space;
    // A space named after another space's id loses to that space.
    const namedById = (await createSpace({ name: second.id })).space;
    const reuse = (body: Record<string, unknown>) =>
      request("/spaces", "POST", { reuse: true, ...body });
    const spaces = controller.state.spaces.length;
    expect(await reuse({ name: "Research" })).toEqual({
      status: 200,
      body: {
        space: expect.objectContaining({ id: first.id, name: "Research" }),
        created: false,
      },
    });
    expect(await reuse({ name: second.id })).toEqual({
      status: 200,
      body: {
        space: expect.objectContaining({ id: second.id }),
        created: false,
      },
    });
    // A given budget updates the space it finds.
    expect(await reuse({ name: first.id, pageBudget: 5 })).toEqual({
      status: 200,
      body: {
        space: expect.objectContaining({ id: first.id, pageBudget: 5 }),
        created: false,
      },
    });
    // Other sign-ins are refused before anything changes.
    expect(
      await reuse({ name: "Research", isolated: true, pageBudget: 2 }),
    ).toEqual({
      status: 409,
      body: {
        error: {
          code: "sign_ins_mismatch",
          message:
            "This space uses the person's sign-ins. Open a space with another name to get different sign-ins.",
          spaceId: first.id,
          signIns: "shared",
        },
      },
    });
    expect((await request(`/spaces/${first.id}`)).body.space.pageBudget).toBe(
      5,
    );
    expect((await reuse({ name: "Research", isolated: false })).status).toBe(
      200,
    );
    expect(controller.state.spaces).toHaveLength(spaces);
    // Without reuse a name always makes a new space.
    expect((await request("/spaces", "POST", { name: "Research" })).status).toBe(
      201,
    );
    const clean = (await createSpace({ name: "Clean", isolated: true })).space;
    expect(await reuse({ name: "Clean", isolated: false })).toEqual({
      status: 409,
      body: {
        error: {
          code: "sign_ins_mismatch",
          message:
            "This space uses separate sign-ins. Open a space with another name to get different sign-ins.",
          spaceId: clean.id,
          signIns: "separate",
        },
      },
    });
    expect((await reuse({ name: "Clean" })).body.space.id).toBe(clean.id);
    // Spaces the agent cannot list are never reused, by id or by name.
    for (const name of [
      "personal",
      "Personal",
      "manual-agent",
      "Created by a person",
    ]) {
      const created = await reuse({ name });
      expect(created.status, name).toBe(201);
      expect(created.body).toMatchObject({
        space: { name, kind: "agent", createdBy: "agent" },
        created: true,
      });
      expect(["personal", "manual-agent"]).not.toContain(
        created.body.space.id,
      );
    }
    // A closed space is no longer listed, so its id now matches a name.
    expect((await request(`/spaces/${second.id}`, "DELETE")).status).toBe(200);
    expect(await reuse({ name: second.id })).toEqual({
      status: 200,
      body: {
        space: expect.objectContaining({ id: namedById.id }),
        created: false,
      },
    });
    // The new fields are checked like every declared field.
    expect(
      await request("/spaces", "POST", { name: "Odd", pageBudget: 21 }),
    ).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "invalid_field",
          message: "pageBudget must be an integer from 1 to 20.",
          field: "pageBudget",
        },
      },
    });
    expect(
      await request("/spaces", "POST", { name: "Odd", reuse: "yes" }),
    ).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "invalid_field",
          message: "reuse must be true or false.",
          field: "reuse",
        },
      },
    });
  });

  it("listings carry createdBy and pageBudget and show recentTabTitles from managed tabs only", async () => {
    const { space } = await createSpace({ name: "Research", pageBudget: 6 });
    for (const [path, title] of [
      ["one", "One"],
      ["two", "Two"],
      ["three", "T".repeat(100)],
    ]) {
      const opened = await openPage(space.id, `https://example.com/${path}`);
      stateTab(opened.id)!.title = title;
    }
    const person = controller.openPersonTab(
      space.id,
      "https://example.com/person",
    );
    person.title = "Person";
    const listed = await request("/spaces");
    expect(listed).toEqual({
      status: 200,
      body: {
        spaces: [
          {
            id: space.id,
            name: "Research",
            color: "purple",
            kind: "agent",
            owner: "agent",
            signIns: "shared",
            createdAt: space.createdAt,
            createdBy: "agent",
            pageBudget: 6,
            recentTabTitles: ["T".repeat(80), "Two", "One"],
          },
        ],
      },
    });
    expect(await request(`/spaces/${space.id}`)).toEqual({
      status: 200,
      body: { space: listed.body.spaces[0] },
    });
    // Once adopted, the person's tab is one of the agent's pages.
    expect((await request(`/tabs/${person.id}/adopt`, "POST", {})).status).toBe(
      200,
    );
    expect(
      (await request(`/spaces/${space.id}`)).body.space.recentTabTitles,
    ).toEqual(["Person", "T".repeat(80), "Two"]);
    // While the person has control the space says why, and only reading
    // the space itself still answers.
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    const human = (await request("/spaces")).body.spaces[0];
    expect(human).toMatchObject({
      id: space.id,
      owner: "human",
      reason: "manual",
      createdBy: "agent",
      pageBudget: 6,
    });
    expect(human).not.toHaveProperty("recentTabTitles");
    expect(await request(`/spaces/${space.id}`)).toEqual({
      status: 200,
      body: { space: human },
    });
    expect((await request(`/spaces/${space.id}/tabs`)).status).toBe(409);
    // A space the person made says so and has the default budget.
    api.grantSpace("manual-agent");
    expect((await request("/spaces/manual-agent")).body.space).toMatchObject({
      id: "manual-agent",
      kind: "agent",
      createdBy: "person",
      pageBudget: 20,
    });
    expect((await request("/spaces/personal")).status).toBe(404);
  });

  it("a closed label is never reused and is listed as closed", async () => {
    const { space } = await createSpace();
    const two = await openPage(space.id, "https://example.com/two");
    const three = await openPage(space.id, "https://example.com/three");
    expect(await request(`/tabs/${two.id}`, "DELETE")).toEqual({
      status: 200,
      body: { ok: true, closed: "p2" },
    });
    expect(controller.activity.at(-1)).toEqual({
      spaceId: space.id,
      message: "Agent closed a tab",
      kind: "info",
    });
    expect(stateTab(two.id)).toBeUndefined();
    const four = await openPage(space.id, "https://example.com/four");
    expect([three.label, four.label]).toEqual(["p3", "p4"]);
    const listing = await listTabs(space.id);
    expect(listing.tabs.map((tab) => tab.label)).toEqual(["p1", "p3", "p4"]);
    expect(listing.closed).toEqual([
      { label: "p2", closedBy: "agent", at: expect.any(Number) },
    ]);
    expect(listing.budget).toEqual({ used: 3, limit: 20 });
    expect(await request(`/tabs/${two.id}/snapshot`)).toEqual({
      status: 404,
      body: {
        error: {
          code: "tab_not_found",
          message: "Agent tab was not found.",
          tabId: two.id,
        },
      },
    });
  });

  it("page routes refuse unmanaged tabs until adopted, keeping the label", async () => {
    const { space } = await createSpace();
    const person = controller.openPersonTab(
      space.id,
      "https://example.com/person",
    );
    const page = controller.pages.get(person.id)!;
    const refusal = {
      status: 409,
      body: {
        error: {
          code: "tab_unmanaged",
          message:
            "Kamapathy has not given this page to the agent. Adopt it first with adopt <tab> or space.adopt(page).",
          tabId: person.id,
          label: "p2",
          openedBy: "person",
        },
      },
    };
    const upload = {
      ref: "@e1",
      files: [{ name: "notes.txt", type: "text/plain", data: "AAEC" }],
    };
    for (const [method, path, body] of [
      ["GET", "snapshot", undefined],
      ["POST", "snapshot", {}],
      ["POST", "navigate", { url: "https://example.com/elsewhere" }],
      ["POST", "actions", { actions: [{ type: "snapshot" }] }],
      ["GET", "screenshot", undefined],
      ["POST", "click", { ref: "@e1" }],
      ["POST", "fill", { ref: "@e1", value: "Ada" }],
      ["POST", "press", { key: "Enter" }],
      ["POST", "scroll", { direction: "down" }],
      ["POST", "drag", { source: { ref: "@e1" }, target: { ref: "@e2" } }],
      ["POST", "wait", { text: "Ready" }],
      ["POST", "upload", upload],
    ] as const)
      expect(
        await request(`/tabs/${person.id}/${path}`, method, body),
        `${method} ${path}`,
      ).toEqual(refusal);
    expect(await request(`/tabs/${person.id}`, "DELETE")).toEqual(refusal);
    expect(page.debugger.attachCount).toBe(0);
    expect(page.scripts).toEqual([]);
    expect(page.inputs).toEqual([]);
    expect(controller.accessedTabs).not.toContain(person.id);
    let listing = await listTabs(space.id);
    expect(listing.tabs.find((tab) => tab.id === person.id)).toMatchObject({
      url: "https://example.com/person",
      label: "p2",
      openedBy: "person",
      managed: false,
    });
    expect(listing.budget).toEqual({ used: 1, limit: 20 });
    const adopted = await request(`/tabs/${person.id}/adopt`, "POST", {});
    expect(adopted).toEqual({
      status: 200,
      body: {
        tab: expect.objectContaining({
          id: person.id,
          label: "p2",
          openedBy: "person",
          managed: true,
        }),
      },
    });
    expect(controller.activity.at(-1)).toEqual({
      spaceId: space.id,
      message: "Agent adopted a page",
      kind: "info",
    });
    const snapshot = await request(`/tabs/${person.id}/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(snapshot.body.text).toBe("Hello from the agent page");
    // Adopting a managed tab changes nothing.
    const activity = controller.activity.length;
    expect(await request(`/tabs/${person.id}/adopt`, "POST", {})).toMatchObject(
      { status: 200, body: { tab: { label: "p2", managed: true } } },
    );
    expect(controller.activity).toHaveLength(activity);
    listing = await listTabs(space.id);
    expect(listing.tabs.find((tab) => tab.id === person.id)).toMatchObject({
      label: "p2",
      openedBy: "person",
      managed: true,
    });
    expect(listing.budget).toEqual({ used: 2, limit: 20 });
  });

  it("release refuses agent tabs and leaves released tabs open", async () => {
    const { space, tab: first } = await createSpace();
    const opened = await openPage(space.id);
    for (const tab of [first, opened])
      expect(await request(`/tabs/${tab.id}/release`, "POST", {})).toEqual({
        status: 409,
        body: {
          error: {
            code: "release_refused",
            message:
              "The agent opened this page. Close it instead of releasing it.",
            tabId: tab.id,
            label: tab.label,
          },
        },
      });
    const person = controller.openPersonTab(
      space.id,
      "https://example.com/person",
    );
    expect((await request(`/tabs/${person.id}/adopt`, "POST", {})).status).toBe(
      200,
    );
    expect(await request(`/tabs/${person.id}/release`, "POST", {})).toEqual({
      status: 200,
      body: {
        tab: expect.objectContaining({
          id: person.id,
          label: "p3",
          openedBy: "person",
          managed: false,
        }),
      },
    });
    expect(controller.activity.at(-1)).toEqual({
      spaceId: space.id,
      message: "Agent released a page",
      kind: "info",
    });
    expect(stateTab(person.id)).toMatchObject({
      url: "https://example.com/person",
      managed: false,
    });
    expect(
      (await request(`/tabs/${person.id}/snapshot`)).body.error.code,
    ).toBe("tab_unmanaged");
    // A page's popup is not the agent's own, so it can be released.
    const popup = controller.openPopup(opened.id, "https://example.com/popup");
    expect(await request(`/tabs/${popup.id}/release`, "POST", {})).toMatchObject(
      {
        status: 200,
        body: { tab: { id: popup.id, openedBy: "page", managed: false } },
      },
    );
    const listing = await listTabs(space.id);
    expect(listing.tabs.map((tab) => [tab.label, tab.managed])).toEqual([
      ["p1", true],
      ["p2", true],
      ["p3", false],
      ["p4", false],
    ]);
    expect(listing.budget).toEqual({ used: 2, limit: 20 });
  });

  it("newPage and adopt stop at the budget before dispatching and list every page", async () => {
    const { space, tab: first } = await createSpace({
      name: "Research",
      pageBudget: 2,
    });
    const second = await openPage(space.id);
    const person = controller.openPersonTab(
      space.id,
      "https://example.com/person",
    );
    const calls = controller.calls.length;
    const tabs = controller.state.tabs.length;
    const shown = controller.shownTab(space.id)?.id;
    const refusal = {
      status: 409,
      body: {
        error: {
          code: "page_budget",
          message:
            'Page budget reached (2 of 2) in "Research". Close a page or reuse one with navigate.',
          limit: 2,
          used: 2,
          pages: [
            {
              id: first.id,
              label: "p1",
              title: "New tab",
              url: HOME_URL,
              active: first.id === shown,
            },
            {
              id: second.id,
              label: "p2",
              title: second.title,
              url: "https://example.com/",
              active: second.id === shown,
            },
          ],
        },
      },
    };
    expect(
      await request(`/spaces/${space.id}/tabs`, "POST", {
        url: "https://example.com/more",
      }),
    ).toEqual(refusal);
    expect(await request(`/spaces/${space.id}/tabs`, "POST", {})).toEqual(
      refusal,
    );
    expect(await request(`/tabs/${person.id}/adopt`, "POST", {})).toEqual(
      refusal,
    );
    expect(controller.calls).toHaveLength(calls);
    expect(controller.state.tabs).toHaveLength(tabs);
    expect(stateTab(person.id)!.managed).toBe(false);
    // A larger budget makes room; the next page fills it again.
    expect(
      (
        await request("/spaces", "POST", {
          name: space.id,
          reuse: true,
          pageBudget: 3,
        })
      ).status,
    ).toBe(200);
    expect((await request(`/tabs/${person.id}/adopt`, "POST", {})).status).toBe(
      200,
    );
    const full = await request(`/spaces/${space.id}/tabs`, "POST", {});
    expect(full).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "page_budget",
          message:
            'Page budget reached (3 of 3) in "Research". Close a page or reuse one with navigate.',
          limit: 3,
          used: 3,
        },
      },
    });
    expect(
      full.body.error.pages.map((page: { label: string }) => page.label),
    ).toEqual(["p1", "p2", "p3"]);
    expect((await request(`/tabs/${second.id}`, "DELETE")).status).toBe(200);
    expect(
      (await request(`/spaces/${space.id}/tabs`, "POST", {})).body.tab.label,
    ).toBe("p4");
    // Under the budget, the 20 tabs of a space still stop new pages.
    const roomy = (await createSpace({ name: "Roomy" })).space;
    const blank = controller.openPersonTab(roomy.id);
    for (let count = 2; count < 20; count++)
      expect(
        (await request(`/spaces/${roomy.id}/tabs`, "POST", {})).status,
      ).toBe(201);
    expect(await request(`/spaces/${roomy.id}/tabs`, "POST", {})).toEqual({
      status: 409,
      body: {
        error: {
          code: "tab_limit",
          message:
            "Close a tab before creating another. The limit is 20 per agent space.",
        },
      },
    });
    expect((await request(`/tabs/${blank.id}/adopt`, "POST", {})).status).toBe(
      200,
    );
    expect(
      (await request(`/spaces/${roomy.id}/tabs`, "POST", {})).body.error,
    ).toMatchObject({ code: "page_budget", used: 20, limit: 20 });
  });

  it("popups count against the budget without being blocked", async () => {
    const { space } = await createSpace({ name: "Research", pageBudget: 2 });
    const opener = await openPage(space.id);
    const popup = controller.openPopup(opener.id, "https://example.com/popup");
    let listing = await listTabs(space.id);
    expect(listing.tabs.find((tab) => tab.id === popup.id)).toMatchObject({
      url: "https://example.com/popup",
      label: "p3",
      openedBy: "page",
      openerId: opener.id,
      managed: true,
      unseen: true,
    });
    expect(listing.budget).toEqual({ used: 3, limit: 2 });
    const refused = await request(`/spaces/${space.id}/tabs`, "POST", {});
    expect(refused.body.error).toMatchObject({
      code: "page_budget",
      used: 3,
      limit: 2,
    });
    expect(
      refused.body.error.pages.map((page: { label: string }) => page.label),
    ).toEqual(["p1", "p2", "p3"]);
    // Addressing the popup reports it.
    expect((await request(`/tabs/${popup.id}/snapshot`)).status).toBe(200);
    expect(stateTab(popup.id)).not.toHaveProperty("unseen");
    listing = await listTabs(space.id);
    expect(listing.tabs.find((tab) => tab.id === popup.id)).not.toHaveProperty(
      "unseen",
    );
    expect(await request(`/tabs/${popup.id}`, "DELETE")).toEqual({
      status: 200,
      body: { ok: true, closed: "p3" },
    });
    expect((await request(`/spaces/${space.id}/tabs`, "POST", {})).status).toBe(
      409,
    );
    expect((await request(`/tabs/${opener.id}`, "DELETE")).status).toBe(200);
    expect(
      (await request(`/spaces/${space.id}/tabs`, "POST", {})).body.tab.label,
    ).toBe("p4");
  });

  it("only managed tabs hold a debugger session: adopt attaches and release detaches", async () => {
    const { space } = await createSpace();
    const opened = await openPage(space.id);
    const agentPage = controller.pages.get(opened.id)!;
    await expect.poll(() => agentPage.debugger.attached).toBe(true);
    const person = controller.openPersonTab(
      space.id,
      "https://example.com/person",
    );
    const personPage = controller.pages.get(person.id)!;
    // A popup from a page the agent does not manage is not the agent's either.
    const popup = controller.openPopup(person.id, "https://example.com/popup");
    expect(stateTab(popup.id)!.managed).toBe(false);
    controller.getWebContents(popup.id);
    const popupPage = controller.pages.get(popup.id)!;
    expect(personPage.debugger.attachCount).toBe(0);
    expect(popupPage.debugger.attachCount).toBe(0);
    expect((await request(`/tabs/${person.id}/adopt`, "POST", {})).status).toBe(
      200,
    );
    await expect.poll(() => personPage.debugger.attached).toBe(true);
    expect((await request(`/tabs/${person.id}/release`, "POST", {})).status).toBe(
      200,
    );
    await expect.poll(() => personPage.debugger.attached).toBe(false);
    expect(personPage.debugger.attachCount).toBe(1);
    expect(
      (await request(`/tabs/${person.id}/click`, "POST", { ref: "@e1" })).body
        .error.code,
    ).toBe("tab_unmanaged");
    expect(personPage.inputs).toEqual([]);
    expect(popupPage.debugger.attachCount).toBe(0);
    expect(agentPage.debugger.attached).toBe(true);
    expect(agentPage.debugger.attachCount).toBe(1);
  });

  it("closing the last page leaves a labeled blank replacement", async () => {
    const { space, tab } = await createSpace();
    const closed = await request(`/tabs/${tab.id}`, "DELETE");
    expect(closed).toEqual({
      status: 200,
      body: {
        ok: true,
        closed: "p1",
        replacement: {
          id: expect.any(String),
          spaceId: space.id,
          title: "New tab",
          url: HOME_URL,
          pinned: false,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          label: "p2",
          openedBy: "agent",
          managed: true,
          active: true,
        },
      },
    });
    const listing = await listTabs(space.id);
    expect(listing.tabs).toEqual([closed.body.replacement]);
    expect(listing.closed).toEqual([
      { label: "p1", closedBy: "agent", at: expect.any(Number) },
    ]);
    expect(listing.budget).toEqual({ used: 1, limit: 20 });
    expect(controller.state.spaces.some((item) => item.id === space.id)).toBe(
      true,
    );
    expect(
      await request(`/tabs/${closed.body.replacement.id}`, "DELETE"),
    ).toMatchObject({
      status: 200,
      body: { ok: true, closed: "p2", replacement: { label: "p3" } },
    });
  });

  it("a space holding a person's tab refuses to close with space_protected", async () => {
    const { space } = await createSpace();
    const person = controller.openPersonTab(
      space.id,
      "https://example.com/person",
    );
    const refusal = {
      status: 409,
      body: {
        error: {
          code: "space_protected",
          message:
            "The person opened tabs in this space, so the agent cannot close it. Finish it instead.",
          tabs: [
            {
              id: person.id,
              label: "p2",
              title: person.title,
              url: "https://example.com/person",
            },
          ],
        },
      },
    };
    expect(await request(`/spaces/${space.id}`, "DELETE")).toEqual(refusal);
    // Adopting the tab does not make it the agent's to close.
    expect((await request(`/tabs/${person.id}/adopt`, "POST", {})).status).toBe(
      200,
    );
    expect(await request(`/spaces/${space.id}`, "DELETE")).toEqual(refusal);
    expect(controller.calls.some((call) => call.type === "space:delete")).toBe(
      false,
    );
    expect(stateTab(person.id)).toBeDefined();
    const other = (await createSpace({ name: "Other" })).space;
    await openPage(other.id);
    expect(await request(`/spaces/${other.id}`, "DELETE")).toEqual({
      status: 200,
      body: { ok: true },
    });
    expect(controller.state.spaces.some((item) => item.id === other.id)).toBe(
      false,
    );
  });

  it("human_control carries each reason and message; resume passes manual, handoff and failed but not prompt holds or approvals; an answered hold or approval returns control unless the person took over", async () => {
    const { space } = await createSpace();
    const current = () =>
      controller.state.spaces.find((item) => item.id === space.id)!;
    const refusal = async () =>
      (await request(`/spaces/${space.id}/tabs`)).body.error;
    const resume = () => request(`/spaces/${space.id}/resume`, "POST", {});
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    expect(await refusal()).toEqual({
      code: "human_control",
      message:
        "The person took over this space. Stop, and resume only when they ask you to.",
      spaceId: space.id,
      reason: "manual",
      since: current().control!.since,
    });
    expect((await resume()).status).toBe(200);
    expect((await request(`/spaces/${space.id}/handoff`, "POST", {})).status).toBe(
      200,
    );
    expect(await refusal()).toMatchObject({
      reason: "handoff",
      message:
        "You handed this space to the person. Resume when they say they are done.",
    });
    expect((await resume()).status).toBe(200);
    // Nothing reports a failure yet, so the test records one directly.
    controller.registry.handOver(space.id, { reason: "failed" });
    expect(await refusal()).toMatchObject({
      reason: "failed",
      message:
        "You reported that this task could not be finished. Resume only when the person asks you to.",
    });
    expect((await resume()).status).toBe(200);
    for (const [reason, prompt, message] of [
      [
        "approval",
        "clearing site data for example.com",
        "Kamapathy is asking the person to approve clearing site data for example.com. Wait for control.",
      ],
      [
        "permission",
        "notifications",
        "The site asked for notifications, and only the person can answer. Wait for control.",
      ],
      [
        "device",
        "usb",
        "The site asked for usb, and only the person can answer. Wait for control.",
      ],
      [
        "http_auth",
        "a sign-in to example.com",
        "The site asked for a sign-in to example.com, and only the person can answer. Wait for control.",
      ],
      [
        "client_certificate",
        "a client certificate",
        "The site asked for a client certificate, and only the person can answer. Wait for control.",
      ],
    ] as const) {
      const hold = controller.holdForPerson(space.id, reason, prompt);
      const error = {
        code: "human_control",
        message,
        spaceId: space.id,
        reason,
        prompt,
        since: current().control!.since,
      };
      expect(await refusal(), reason).toEqual(error);
      expect(await resume(), reason).toEqual({ status: 409, body: { error } });
      expect(current().owner).toBe("human");
      controller.releaseHold(hold);
      expect(current().owner, reason).toBe("agent");
      expect(current()).not.toHaveProperty("control");
    }
    // Taking over during a hold makes it manual, and answering the hold
    // then leaves control with the person.
    const held = controller.holdForPerson(space.id, "permission", "camera");
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    expect(await refusal()).toMatchObject({ reason: "manual" });
    controller.releaseHold(held);
    expect(current().owner).toBe("human");
    expect(() =>
      controller.holdForPerson(space.id, "permission", "camera"),
    ).toThrow("The agent does not have control of this space.");
    expect((await resume()).status).toBe(200);
    controller.holdForPerson(space.id, "permission", "x".repeat(200));
    expect(current().control!.prompt).toBe("x".repeat(120));
  });

  it("resume returns the tabs the person opened and closed and their active tab", async () => {
    const { space } = await createSpace();
    const second = await openPage(space.id, "https://example.com/two");
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    const person = controller.openPersonTab(
      space.id,
      "https://example.com/person",
    );
    await controller.dispatch({ type: "tab:close", id: second.id });
    controller.state.activeSpaceId = space.id;
    controller.state.activeTabId = person.id;
    const view = expect.objectContaining({
      id: person.id,
      label: "p3",
      openedBy: "person",
      managed: false,
      active: true,
    });
    const resumed = await request(`/spaces/${space.id}/resume`, "POST", {});
    expect(resumed).toEqual({
      status: 200,
      body: {
        ok: true,
        owner: "agent",
        active: view,
        opened: [view],
        closed: ["p2"],
      },
    });
    // Until control leaves again, resume and wait-for-control return the
    // same boundary.
    expect(await request(`/spaces/${space.id}/resume`, "POST", {})).toEqual(
      resumed,
    );
    expect(
      await request(`/spaces/${space.id}/wait-for-control`, "POST", {}),
    ).toEqual(resumed);
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    expect((await request(`/spaces/${space.id}/resume`, "POST", {})).body).toEqual(
      { ok: true, owner: "agent", active: view, opened: [], closed: [] },
    );
  });

  it("wait-for-control returns without blocking the queue, answers at once when the agent has control, and times out with control_timeout", async () => {
    const { space } = await createSpace();
    const wait = (body: Record<string, unknown> = {}) =>
      request(`/spaces/${space.id}/wait-for-control`, "POST", body);
    const shown = controller.shownTab(space.id)!;
    expect(await wait()).toEqual({
      status: 200,
      body: {
        ok: true,
        owner: "agent",
        active: expect.objectContaining({ id: shown.id, active: true }),
        opened: [],
        closed: [],
      },
    });
    expect((await request(`/spaces/${space.id}/handoff`, "POST", {})).status).toBe(
      200,
    );
    let answered = false;
    const waiting = wait().then((result) => {
      answered = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);
    // Requests in the space's queue still answer while the wait runs.
    expect((await request(`/spaces/${space.id}/tabs`)).status).toBe(409);
    expect((await request(`/spaces/${space.id}`)).status).toBe(200);
    const person = controller.openPersonTab(
      space.id,
      "https://example.com/person",
    );
    expect(answered).toBe(false);
    expect((await request(`/spaces/${space.id}/resume`, "POST", {})).status).toBe(
      200,
    );
    expect(await waiting).toEqual({
      status: 200,
      body: {
        ok: true,
        owner: "agent",
        active: expect.objectContaining({
          id: controller.shownTab(space.id)!.id,
          active: true,
        }),
        opened: [expect.objectContaining({ id: person.id, managed: false })],
        closed: [],
      },
    });
    expect((await request(`/spaces/${space.id}/handoff`, "POST", {})).status).toBe(
      200,
    );
    expect(await wait({ timeoutMs: 50 })).toEqual({
      status: 504,
      body: {
        error: {
          code: "control_timeout",
          message: "Control did not return within 50 ms.",
          awaited: "control",
          timeoutMs: 50,
          reason: "handoff",
          retryable: true,
        },
      },
    });
    // A wait on a space that goes away answers space_not_found.
    const gone = wait();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await controller.dispatch({ type: "space:delete", id: space.id });
    expect(await gone).toMatchObject({
      status: 404,
      body: { error: { code: "space_not_found" } },
    });
  });

  it("at most 8 waits for control run at once", async () => {
    const { space } = await createSpace();
    expect((await request(`/spaces/${space.id}/handoff`, "POST", {})).status).toBe(
      200,
    );
    const answers: { status: number; body: unknown }[] = [];
    const waits = Array.from({ length: 9 }, () =>
      request(`/spaces/${space.id}/wait-for-control`, "POST", {}).then(
        (answer) => {
          answers.push(answer);
          return answer;
        },
      ),
    );
    await expect.poll(() => answers.length).toBe(1);
    expect(answers[0]).toEqual({
      status: 429,
      body: {
        error: {
          code: "busy",
          message: "Kamapathy has 8 waits for control running. Try again shortly.",
          scope: "server",
          retryable: true,
        },
      },
    });
    expect((await request(`/spaces/${space.id}/resume`, "POST", {})).status).toBe(
      200,
    );
    expect((await Promise.all(waits)).map((answer) => answer.status).sort()).toEqual(
      [...Array(8).fill(200), 429],
    );
    // Answered waits give their places back.
    await request(`/spaces/${space.id}/handoff`, "POST", {});
    const again = Array.from({ length: 8 }, () =>
      request(`/spaces/${space.id}/wait-for-control`, "POST", { timeoutMs: 100 }),
    );
    expect((await Promise.all(again)).map((answer) => answer.status)).toEqual(
      Array(8).fill(504),
    );
  });

  it("listings show reason, prompt and since while the person has control and no recentTabTitles", async () => {
    const { space } = await createSpace();
    controller.holdForPerson(space.id, "permission", "notifications");
    const { since } = controller.state.spaces.find(
      (item) => item.id === space.id,
    )!.control!;
    const listed = (await request("/spaces")).body.spaces[0];
    expect(listed).toMatchObject({
      id: space.id,
      owner: "human",
      reason: "permission",
      prompt: "notifications",
      since,
    });
    expect(listed).not.toHaveProperty("recentTabTitles");
    expect((await request(`/spaces/${space.id}`)).body.space).toEqual(listed);
  });

  it("finish checks every id, closes unkept agent and popup pages, protects person tabs, deletes a space with nothing left, then answers space_ended", async () => {
    const { space, tab: first } = await createSpace();
    const kept = await openPage(space.id, "https://example.com/kept");
    const other = await openPage(space.id, "https://example.com/other");
    const popup = controller.openPopup(kept.id, "https://example.com/popup");
    const person = controller.openPersonTab(space.id, "https://example.com/person");
    expect([first, kept, other, popup, person].map((tab) => tab.label)).toEqual(
      ["p1", "p2", "p3", "p4", "p5"],
    );
    const finish = (id: string, keep: unknown) =>
      request(`/spaces/${id}/finish`, "POST", { keep });
    const before = spaceTabs(space.id).map((tab) => tab.id);
    for (const keep of [
      "some",
      {},
      [7],
      [kept.id, kept.id],
      Array.from({ length: 21 }, (_, index) => `tab-${index}`),
    ]) {
      const refused = await finish(space.id, keep);
      expect(refused.status, JSON.stringify(keep)).toBe(400);
      expect(refused.body.error).toMatchObject({
        code: "invalid_field",
        field: "keep",
        expected: '"all" or up to 20 unique tab ids',
      });
    }
    const missing = await request(`/spaces/${space.id}/finish`, "POST", {});
    expect([missing.status, missing.body.error.code]).toEqual([
      400,
      "invalid_field",
    ]);
    // Every id is checked before anything closes.
    const elsewhere = await createSpace({ name: "Elsewhere" });
    for (const tabId of ["missing", elsewhere.tab.id]) {
      const refused = await finish(space.id, [kept.id, tabId]);
      expect(refused.status).toBe(404);
      expect(refused.body.error).toMatchObject({
        code: "tab_not_found",
        tabId,
      });
    }
    // Finishing needs agent control.
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    expect((await finish(space.id, "all")).body.error.code).toBe(
      "human_control",
    );
    expect(
      (await request(`/spaces/${space.id}/resume`, "POST", {})).status,
    ).toBe(200);
    expect(spaceTabs(space.id).map((tab) => tab.id)).toEqual(before);

    expect(await finish(space.id, [kept.id])).toEqual({
      status: 200,
      body: {
        ok: true,
        spaceId: space.id,
        closedSpace: false,
        closed: ["p1", "p3", "p4"],
        kept: ["p2"],
        protected: ["p5"],
      },
    });
    expect(
      spaceTabs(space.id).map((tab) => [tab.label, tab.managed]),
    ).toEqual([
      ["p2", false],
      ["p5", false],
    ]);
    expect(controller.registry.closed(space.id)).toMatchObject([
      { label: "p1", closedBy: "agent" },
      { label: "p3", closedBy: "agent" },
      { label: "p4", closedBy: "agent" },
    ]);
    expect(
      controller.state.spaces.find((item) => item.id === space.id),
    ).toMatchObject({
      owner: "human",
      access: "ended",
      ended: { by: "agent", reason: "finished" },
    });
    expect(controller.activity.at(-1)).toEqual({
      spaceId: space.id,
      message: "Agent finished",
      kind: "success",
    });
    const ended = {
      code: "space_ended",
      message:
        "The agent finished this space. Open or create another space to continue.",
      spaceId: space.id,
      endedBy: "agent",
      reason: "finished",
    };
    for (const [path, method, body] of [
      [`/spaces/${space.id}`, "GET", undefined],
      [`/spaces/${space.id}/tabs`, "GET", undefined],
      [`/spaces/${space.id}/resume`, "POST", {}],
      [`/spaces/${space.id}/finish`, "POST", { keep: "all" }],
      [`/tabs/${kept.id}/snapshot`, "GET", undefined],
    ] as const)
      expect(await request(path, method, body), path).toEqual({
        status: 409,
        body: { error: ended },
      });

    // A space with nothing kept or protected is deleted.
    const done = await createSpace({ name: "Done" });
    await openPage(done.space.id);
    expect(await finish(done.space.id, [])).toEqual({
      status: 200,
      body: {
        ok: true,
        spaceId: done.space.id,
        closedSpace: true,
        closed: ["p1", "p2"],
        kept: [],
        protected: [],
      },
    });
    expect(controller.calls).toContainEqual({
      type: "space:delete",
      id: done.space.id,
    });
    expect(
      controller.state.spaces.some((item) => item.id === done.space.id),
    ).toBe(false);
    expect(
      (await request(`/spaces/${done.space.id}/tabs`)).body.error.code,
    ).toBe("space_not_found");
    // "all" keeps every page the agent manages.
    const all = await createSpace({ name: "Keep all" });
    await openPage(all.space.id);
    expect((await finish(all.space.id, "all")).body).toEqual({
      ok: true,
      spaceId: all.space.id,
      closedSpace: false,
      closed: [],
      kept: ["p1", "p2"],
      protected: [],
    });
    expect(await listed()).toEqual([elsewhere.space.id]);
    // A space the person keeps leaves the agent until they grant it.
    await controller.keepAsPersonal(space.id);
    expect(
      (await request(`/spaces/${space.id}/tabs`)).body.error.code,
    ).toBe("space_not_found");
    api.grantSpace(space.id);
    expect((await request(`/spaces/${space.id}/tabs`)).status).toBe(200);
  });

  it("Stop ends one space and refuses resume until granted again while another works", async () => {
    const one = await createSpace({ name: "One" });
    const page = await openPage(one.space.id);
    const two = await createSpace({ name: "Two" });
    const other = await openPage(two.space.id);
    // Steps in flight fail at their next check and withhold earlier results.
    let observed = 0;
    const record = controller.addActivity.bind(controller);
    controller.addActivity = (spaceId, message, kind) => {
      record(spaceId, message, kind);
      if (++observed === 1) api.endSpace(one.space.id);
    };
    const batch = await request(`/tabs/${page.id}/actions`, "POST", {
      actions: [{ type: "snapshot" }, { type: "snapshot" }],
    });
    controller.addActivity = record;
    expect(batch.status).toBe(409);
    expect(batch.body).toMatchObject({
      ok: false,
      failedIndex: 1,
      results: [
        { index: 0, type: "snapshot", result: { ok: true, withheld: true } },
      ],
      error: { code: "space_ended", endedBy: "person", reason: "stopped" },
    });
    expect(JSON.stringify(batch.body)).not.toContain(
      "Hello from the agent page",
    );
    const stopped = controller.state.spaces.find(
      (item) => item.id === one.space.id,
    )!;
    expect(stopped).toMatchObject({
      owner: "human",
      access: "ended",
      ended: { by: "person", reason: "stopped" },
    });
    expect(controller.activity.at(-1)).toEqual({
      spaceId: one.space.id,
      message: "You stopped the agent",
      kind: "info",
    });
    // Stop closes no tab.
    expect(
      spaceTabs(one.space.id).map((tab) => [tab.label, tab.managed]),
    ).toEqual([
      ["p1", false],
      ["p2", false],
    ]);
    const ended = {
      code: "space_ended",
      message:
        "The person stopped the agent in this space. Stop here and tell them; only they can let an agent use it again.",
      spaceId: one.space.id,
      endedBy: "person",
      reason: "stopped",
    };
    for (const path of [
      `/spaces/${one.space.id}/resume`,
      `/spaces/${one.space.id}/wait-for-control`,
      `/tabs/${page.id}/adopt`,
    ])
      expect(await request(path, "POST", {}), path).toEqual({
        status: 409,
        body: { error: ended },
      });
    // A second Stop changes nothing, and the other space keeps working.
    api.endSpace(one.space.id);
    expect(
      controller.activity.filter(
        (item) => item.message === "You stopped the agent",
      ),
    ).toHaveLength(1);
    expect((await request(`/tabs/${other.id}/snapshot`)).status).toBe(200);
    expect(await listed()).toEqual([two.space.id]);
    // Only the person can let an agent use it again, and then every tab is
    // theirs until the agent adopts it.
    expect(api.grantSpace(one.space.id)).toBe(stopped);
    expect(stopped).toMatchObject({ owner: "agent", access: "granted" });
    expect(stopped.ended).toBeUndefined();
    expect(await listed()).toEqual([one.space.id, two.space.id]);
    expect(
      (await request(`/tabs/${page.id}/snapshot`)).body.error.code,
    ).toBe("tab_unmanaged");
    expect(
      (await request(`/tabs/${page.id}/adopt`, "POST", {})).status,
    ).toBe(200);
    const contents = controller.pages.get(page.id)!;
    await expect.poll(() => contents.debugger.attached).toBe(true);
    expect((await request(`/tabs/${page.id}/snapshot`)).status).toBe(200);
    expect(
      (await request(`/spaces/${one.space.id}/resume`, "POST", {})).body,
    ).toMatchObject({ ok: true, owner: "agent", opened: [], closed: [] });
  });

  it("wait-for-control ends with space_ended on Stop", async () => {
    const { space } = await createSpace();
    await controller.dispatch({
      type: "space:ownership",
      id: space.id,
      owner: "human",
    });
    const waiting = request(`/spaces/${space.id}/wait-for-control`, "POST", {
      timeoutMs: 10000,
    });
    expect(await within(waiting, 200)).toBe("pending");
    api.endSpace(space.id);
    const ended = {
      status: 409,
      body: {
        error: {
          code: "space_ended",
          message:
            "The person stopped the agent in this space. Stop here and tell them; only they can let an agent use it again.",
          spaceId: space.id,
          endedBy: "person",
          reason: "stopped",
        },
      },
    };
    expect(await within(waiting, 2000)).toEqual(ended);
    // Control never returns to a stopped space, so a new wait ends at once.
    expect(
      await within(
        request(`/spaces/${space.id}/wait-for-control`, "POST", {}),
        2000,
      ),
    ).toEqual(ended);
  });

  it("listings list a personal space only while it is granted, under agent rules with unmanaged, labeled tabs", async () => {
    controller.openPersonTab("work", "https://example.com/work");
    expect(await listed()).toEqual([]);
    expect((await request("/spaces/work/tabs")).status).toBe(404);
    const work = api.grantSpace("work");
    expect(work).toMatchObject({
      id: "work",
      kind: "personal",
      owner: "agent",
      access: "granted",
    });
    expect(agentRules(work)).toBe(true);
    expect(await listed()).toEqual(["work"]);
    expect((await request("/spaces")).body.spaces[0]).toMatchObject({
      id: "work",
      kind: "personal",
      owner: "agent",
      createdBy: "person",
      pageBudget: 20,
    });
    const listing = await request("/spaces/work/tabs");
    expect(listing.status).toBe(200);
    expect(listing.body.tabs).toMatchObject([
      { label: "p1", openedBy: "person", managed: false, url: HOME_URL },
      {
        label: "p2",
        openedBy: "person",
        managed: false,
        url: "https://example.com/work",
      },
    ]);
    expect(listing.body.budget.used).toBe(0);
    // The agent's own pages there are labeled in turn and managed.
    expect(await openPage("work", "https://example.com/agent")).toMatchObject({
      label: "p3",
      openedBy: "agent",
      managed: true,
    });
    api.endSpace("work");
    expect(await listed()).toEqual([]);
    expect(work).toMatchObject({ owner: "human", access: "ended" });
    expect(agentRules(work)).toBe(false);
    expect((await request("/spaces/work/tabs")).body.error.code).toBe(
      "space_ended",
    );
    api.grantSpace("work");
    expect(await listed()).toEqual(["work"]);
    // Turning agent access off ends every grant.
    await api.close();
    controller.resetAgentAccess();
    expect(work).toMatchObject({ kind: "personal", owner: "human" });
    expect(work.access).toBeUndefined();
    await restart();
    expect(await listed()).toEqual([]);
    expect((await request("/spaces/work/tabs")).status).toBe(404);
  });

  it("a grant gives no tab a session until adopted, and finish, Stop and access off detach every session", async () => {
    const work = controller.openPersonTab("work", "https://example.com/work");
    const workPage = controller.pages.get(work.id)!;
    api.grantSpace("work");
    expect(work).toMatchObject({
      label: "p2",
      openedBy: "person",
      managed: false,
    });
    expect((await request(`/tabs/${work.id}/snapshot`)).body.error.code).toBe(
      "tab_unmanaged",
    );
    expect(workPage.debugger.attachCount).toBe(0);
    expect(
      (await request(`/tabs/${work.id}/adopt`, "POST", {})).status,
    ).toBe(200);
    await expect.poll(() => workPage.debugger.attached).toBe(true);
    expect((await request(`/tabs/${work.id}/snapshot`)).status).toBe(200);
    // Finish keeps the person's tabs open and ends their sessions.
    expect(
      (await request("/spaces/work/finish", "POST", { keep: "all" })).body,
    ).toEqual({
      ok: true,
      spaceId: "work",
      closedSpace: false,
      closed: [],
      kept: [],
      protected: ["p1", "p2"],
    });
    await expect.poll(() => workPage.debugger.attached).toBe(false);
    // Stop ends the sessions of an agent space.
    const stopped = await createSpace({ name: "Stopped" });
    const stoppedPage = controller.pages.get(
      (await openPage(stopped.space.id)).id,
    )!;
    await expect.poll(() => stoppedPage.debugger.attached).toBe(true);
    api.endSpace(stopped.space.id);
    await expect.poll(() => stoppedPage.debugger.attached).toBe(false);
    // Agent access off ends the rest, and nothing attaches again.
    const running = await createSpace({ name: "Running" });
    const runningPage = controller.pages.get(
      (await openPage(running.space.id)).id,
    )!;
    api.grantSpace("work");
    expect(
      (await request(`/tabs/${work.id}/adopt`, "POST", {})).status,
    ).toBe(200);
    await expect
      .poll(() => runningPage.debugger.attached && workPage.debugger.attached)
      .toBe(true);
    await api.close();
    controller.resetAgentAccess();
    expect([runningPage.debugger.attached, workPage.debugger.attached]).toEqual(
      [false, false],
    );
    expect(controller.state.tabs.some((tab) => tab.managed)).toBe(false);
    const attaches = [runningPage, workPage].map(
      (page) => page.debugger.attachCount,
    );
    await restart();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      [runningPage, workPage].map((page) => page.debugger.attachCount),
    ).toEqual(attaches);
  });

  it("a granted personal space refuses to close, and finish ends its grant with a blank tab replacing a last closed tab", async () => {
    const work = api.grantSpace("work");
    const own = spaceTabs("work")[0];
    expect(await request("/spaces/work", "DELETE")).toEqual({
      status: 409,
      body: {
        error: {
          code: "space_protected",
          message:
            "This space belongs to the person, so the agent cannot close it. Finish it instead.",
          tabs: [{ id: own.id, label: "p1", title: own.title, url: own.url }],
        },
      },
    });
    const page = await openPage("work", "https://example.com/agent");
    // The person closes their own tab, so only the agent's page is left.
    controller.closeTab(own.id, "person");
    expect((await request("/spaces/work", "DELETE")).body.error).toMatchObject({
      code: "space_protected",
      tabs: [],
    });
    expect(await request("/spaces/work/finish", "POST", { keep: [] })).toEqual({
      status: 200,
      body: {
        ok: true,
        spaceId: "work",
        closedSpace: false,
        closed: [page.label],
        kept: [],
        protected: [],
      },
    });
    expect(controller.state.spaces).toContain(work);
    expect(work).toMatchObject({
      kind: "personal",
      owner: "human",
      access: "ended",
      ended: { by: "agent", reason: "finished" },
    });
    expect(spaceTabs("work")).toMatchObject([
      { url: HOME_URL, label: "p3", openedBy: "agent", managed: false },
    ]);
    expect(controller.registry.closed("work")).toMatchObject([
      { label: "p1", closedBy: "person" },
      { label: "p2", closedBy: "agent" },
    ]);
  });

  it("an approved request grants the chosen space under agent rules with unmanaged tabs; declined, expired and withdrawn requests grant nothing", async () => {
    const ask = (body: Record<string, unknown>) =>
      request("/space-requests", "POST", body);
    const waiting = () => controller.state.spaceRequests;
    const work = controller.openPersonTab("work", "https://example.com/work");
    controller.state.activeSpaceId = "work";
    controller.state.activeTabId = work.id;
    const approved = ask({ reason: "Book a table", name: "Work" });
    await expect.poll(() => waiting().length).toBe(1);
    expect(waiting()).toEqual([
      {
        id: expect.any(String),
        reason: "Book a table",
        name: "Work",
        at: expect.any(Number),
      },
    ]);
    expect(() =>
      api.answerRequest("missing", { allow: true, spaceId: "work" }),
    ).toThrow("That request is no longer waiting.");
    api.answerRequest(waiting()[0].id, { allow: true, spaceId: "work" });
    expect(await approved).toEqual({
      status: 200,
      body: {
        space: expect.objectContaining({
          id: "work",
          kind: "personal",
          owner: "agent",
          createdBy: "person",
        }),
        tabs: [
          expect.objectContaining({
            label: "p1",
            openedBy: "person",
            managed: false,
            active: false,
          }),
          expect.objectContaining({
            id: work.id,
            label: "p2",
            openedBy: "person",
            managed: false,
            active: true,
          }),
        ],
        active: expect.objectContaining({ id: work.id, active: true }),
      },
    });
    expect(waiting()).toEqual([]);
    expect(
      agentRules(controller.state.spaces.find((item) => item.id === "work")!),
    ).toBe(true);
    expect((await request(`/tabs/${work.id}/snapshot`)).body.error.code).toBe(
      "tab_unmanaged",
    );
    expect((await request(`/tabs/${work.id}/adopt`, "POST", {})).status).toBe(
      200,
    );
    const personal = () =>
      controller.state.spaces.find((item) => item.id === "personal")!;
    // A request nobody answers expires.
    expect(await ask({ reason: "Check the calendar", timeoutMs: 5000 })).toEqual(
      {
        status: 504,
        body: {
          error: {
            code: "request_timeout",
            message: "The person did not answer within 5000 ms.",
            awaited: "approval",
            timeoutMs: 5000,
          },
        },
      },
    );
    expect(waiting()).toEqual([]);
    // A request whose client goes away is withdrawn.
    const raw = httpRequest({
      socketPath: socket.path,
      path: "/space-requests",
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    raw.on("error", () => {});
    raw.end(JSON.stringify({ reason: "Check the calendar" }));
    await expect.poll(() => waiting().length).toBe(1);
    const withdrawn = waiting()[0].id;
    raw.destroy();
    await expect.poll(() => waiting().length).toBe(0);
    expect(() => api.answerRequest(withdrawn, { allow: false })).toThrow(
      "That request is no longer waiting.",
    );
    // A declined request says nothing about the person's spaces.
    const declined = ask({ reason: "Check the calendar" });
    await expect.poll(() => waiting().length).toBe(1);
    api.answerRequest(waiting()[0].id, { allow: false });
    expect(await declined).toEqual({
      status: 403,
      body: {
        error: {
          code: "request_declined",
          message: "The person did not let an agent use a space.",
        },
      },
    });
    expect(personal().access).toBeUndefined();
    expect(await listed()).toEqual(["work"]);
  }, 20000);

  it("requests are capped, a decline cools down, and request text loses control and bidirectional characters", async () => {
    const ask = (body: Record<string, unknown>) =>
      request("/space-requests", "POST", body);
    const waiting = () => controller.state.spaceRequests;
    for (const [body, field] of [
      [{ reason: "\u202e\u0000\t" }, "reason"],
      [{ reason: "x".repeat(121) }, "reason"],
      [{ reason: "Book a table", name: "\u2066\u2069" }, "name"],
      [{ reason: "Book a table", timeoutMs: 4999 }, "timeoutMs"],
    ] as const) {
      const refused = await ask(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.body.error).toMatchObject({
        code: "invalid_field",
        field,
      });
    }
    expect(
      (await ask({ reason: "\u202e\u0000\t" })).body.error.expected,
    ).toBe("text that is not empty after cleaning");
    expect(waiting()).toEqual([]);
    const first = ask({
      reason: "Book\u202e a\ttable\u0000 \u2028now",
      name: "  Wo\u200erk ",
    });
    await expect.poll(() => waiting().length).toBe(1);
    expect(waiting()[0]).toMatchObject({ reason: "Book a table now", name: "Work" });
    const answers: { status: number; body: { error: Record<string, unknown> } }[] =
      [];
    const more = Array.from({ length: 3 }, (_, index) =>
      ask({ reason: `Request ${index}` }).then((answer) => {
        answers.push(answer);
        return answer;
      }),
    );
    await expect.poll(() => answers.length).toBe(1);
    expect(answers[0]).toEqual({
      status: 429,
      body: {
        error: {
          code: "busy",
          message:
            "Three requests for a space are already waiting. Try again later.",
          scope: "server",
          retryable: true,
        },
      },
    });
    expect(waiting()).toHaveLength(3);
    api.answerRequest(waiting()[0].id, { allow: false });
    expect((await first).status).toBe(403);
    const cooling = await ask({ reason: "Book a table" });
    expect(cooling).toEqual({
      status: 429,
      body: {
        error: {
          code: "busy",
          message: "The person declined a request just now. Try again later.",
          scope: "server",
          retryAfterMs: expect.any(Number),
          retryable: true,
        },
      },
    });
    expect(cooling.body.error.retryAfterMs).toBeGreaterThan(0);
    expect(cooling.body.error.retryAfterMs).toBeLessThanOrEqual(60000);
    for (const item of [...waiting()])
      api.answerRequest(item.id, { allow: false });
    expect((await Promise.all(more)).map((answer) => answer.status).sort()).toEqual(
      [403, 403, 429],
    );
    // Closing the server withdraws a request that still waits.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60001);
    const last = ask({ reason: "Book a table" }).catch(() => "closed");
    await expect.poll(() => waiting().length).toBe(1);
    vi.useRealTimers();
    await api.close();
    expect(await last).toBe("closed");
    expect(waiting()).toEqual([]);
  });
});
