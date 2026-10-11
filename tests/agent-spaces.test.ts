import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  startAutomation,
  type AutomationServer,
} from "../electron/agent/server";
import type { SpaceView, TabView } from "../electron/agent/views";
import { HOME_URL } from "../shared/state";
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
});
