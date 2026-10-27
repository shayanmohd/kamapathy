import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthority } from "../electron/agent/authority";
import type { ApiError } from "../electron/agent/errors";
import type { Run } from "../electron/agent/http";
import { createPresence } from "../electron/agent/presence";
import { DroppedError } from "../electron/agent/scheduler";
import type { TabSession } from "../electron/agent/session/tab-session";
import {
  cookieMatches,
  cookieUrl,
  createSiteData,
  partitionUse,
  STORAGE_NAMES,
  type ClearRequest,
} from "../electron/agent/site-data";
import { FakeController } from "./fake-automation";

const SHOP = "https://shop.example.com";
const PROMPT = "clear data for shop.example.com";
// A cookie as Electron lists it. Its value is one no answer may carry.
const cookie = (
  fields: Partial<Electron.Cookie> & { name: string; domain: string },
): Electron.Cookie => ({
  value: "secret-value",
  path: "/",
  secure: false,
  httpOnly: true,
  hostOnly: !fields.domain.startsWith("."),
  session: true,
  sameSite: "lax",
  ...fields,
});
const fakeRun = (signal = new AbortController().signal): Run => ({
  deadline: Date.now() + 60000,
  signal,
  dispatch: { dispatched: false },
  park: (wait) => wait(),
});
const request = (fields: Partial<ClearRequest>): ClearRequest => ({
  origin: SHOP,
  timeoutMs: 60000,
  ...fields,
});
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ resolved: value }) as Record<string, unknown>,
    (error: unknown) => {
      if (error instanceof DroppedError) return { dropped: true };
      const api = error as ApiError;
      return { code: api.code, status: api.status, ...api.fields };
    },
  );

// A space with a page on the shop, over the fake controller with the real
// authority and presence, and the frames the tab's session knows.
function setup(options: { isolated?: boolean; frames?: string[] } = {}) {
  const controller = new FakeController();
  const space = controller.createAgentSpace("Research", {
    isolated: options.isolated,
  });
  const authority = createAuthority(controller);
  authority.managedSpaces.add(space.id);
  const presence = createPresence({ controller, authority });
  const tab = controller.openAgentTab(space.id, `${SHOP}/cart`);
  const page = controller.pages.get(tab.id)!;
  const frames = options.frames ?? [SHOP];
  const siteData = createSiteData({
    controller,
    authority,
    presence,
    sessions: {
      get: () =>
        ({
          knownFrames: async () =>
            frames.map((origin, index) => ({
              frameId: `frame-${index}`,
              origin,
            })),
        }) as unknown as TabSession,
    },
  });
  const holds = vi.spyOn(controller, "holdForPerson");
  const releases = vi.spyOn(controller, "releaseHold");
  // The request waiting for the person, once its bar is up.
  const asked = async () => {
    await vi.waitFor(() => expect(controller.state.approvals).toHaveLength(1));
    return controller.state.approvals[0];
  };
  // Nothing of the site's went.
  const untouched = () => {
    expect(page.removedCookies).toEqual([]);
    expect(page.storageClears).toEqual([]);
    expect(page.dataClears).toEqual([]);
  };
  return {
    controller,
    authority,
    space,
    tab,
    page,
    siteData,
    holds,
    releases,
    asked,
    untouched,
  };
}

describe("clearing one site's data", () => {
  afterEach(() => {
    FakeController.cleanup();
  });

  it("domain matching follows RFC 6265 and keeps sibling subdomains", () => {
    const shop = new URL(SHOP);
    const at = (domain: string, more: Partial<Electron.Cookie> = {}) => ({
      name: "sid",
      domain,
      path: "/",
      secure: false,
      ...more,
    });
    // A parent-domain cookie reaches the shop; a sibling's never does.
    expect(cookieMatches(at(".example.com"), shop)).toBe(true);
    expect(cookieMatches(at(".shop.example.com"), shop)).toBe(true);
    expect(cookieMatches(at("blog.example.com"), shop)).toBe(false);
    expect(cookieMatches(at(".blog.example.com"), shop)).toBe(false);
    expect(
      cookieMatches(at(".ample.com"), new URL("https://example.com")),
    ).toBe(false);
    // A host-only cookie matches its own host alone, not hosts under it.
    expect(cookieMatches(at("shop.example.com"), shop)).toBe(true);
    expect(cookieMatches(at("example.com"), shop)).toBe(false);
    expect(
      cookieMatches(at("example.com"), new URL("https://example.com")),
    ).toBe(true);
    // A secure cookie goes over http only to a loopback host.
    expect(
      cookieMatches(
        at("shop.example.com", { secure: true }),
        new URL("http://shop.example.com"),
      ),
    ).toBe(false);
    expect(
      cookieMatches(
        at("localhost", { secure: true }),
        new URL("http://localhost:3000"),
      ),
    ).toBe(true);
    // Every path counts until a pick names one, and then path rules apply.
    const cart = at("shop.example.com", { name: "cart", path: "/cart" });
    expect(cookieMatches(cart, shop)).toBe(true);
    expect(cookieMatches(cart, shop, { name: "cart" })).toBe(true);
    expect(cookieMatches(cart, shop, { name: "sid" })).toBe(false);
    expect(cookieMatches(cart, shop, { name: "cart", path: "/cart" })).toBe(
      true,
    );
    expect(
      cookieMatches(cart, shop, { name: "cart", path: "/cart/items" }),
    ).toBe(true);
    expect(cookieMatches(cart, shop, { name: "cart", path: "/cartoon" })).toBe(
      false,
    );
    expect(cookieMatches(cart, shop, { name: "cart", path: "/" })).toBe(false);
    // A pick's domain is the cookie's own, with or without the dot.
    expect(
      cookieMatches(at(".example.com"), shop, {
        name: "sid",
        domain: "example.com",
      }),
    ).toBe(true);
    expect(
      cookieMatches(at("shop.example.com"), shop, {
        name: "sid",
        domain: ".example.com",
      }),
    ).toBe(false);
  });

  it("removal uses the cookie's own scheme and path on the origin's host", async () => {
    const shop = new URL(SHOP);
    expect(cookieUrl({ path: "/", secure: false }, shop)).toBe(
      "http://shop.example.com/",
    );
    expect(cookieUrl({ path: "/account", secure: true }, shop)).toBe(
      "https://shop.example.com/account",
    );
    const { siteData, tab, page } = setup({ isolated: true });
    const jar = () => [
      cookie({ name: "sid", domain: ".example.com" }),
      cookie({
        name: "cart",
        domain: "shop.example.com",
        path: "/cart",
        secure: true,
      }),
      cookie({ name: "theme", domain: "shop.example.com" }),
      // The parent's own host and a sibling keep theirs.
      cookie({ name: "sid", domain: "example.com" }),
      cookie({ name: "sid", domain: "blog.example.com" }),
    ];
    page.jar = jar();
    const all = await siteData.clear(
      tab.id,
      request({ cookies: true }),
      fakeRun(),
    );
    expect(page.removedCookies).toEqual([
      { url: "http://shop.example.com/", name: "sid" },
      { url: "https://shop.example.com/cart", name: "cart" },
      { url: "http://shop.example.com/", name: "theme" },
    ]);
    expect(all.cleared).toEqual({
      cookies: { removed: 3, domains: ["example.com", "shop.example.com"] },
    });
    expect(page.jar.map((item) => item.domain)).toEqual([
      "example.com",
      "blog.example.com",
    ]);
    // A named pick removes only the cookies it names.
    page.jar = jar();
    page.removedCookies = [];
    const picked = await siteData.clear(
      tab.id,
      request({ cookies: [{ name: "cart" }] }),
      fakeRun(),
    );
    expect(page.removedCookies).toEqual([
      { url: "https://shop.example.com/cart", name: "cart" },
    ]);
    expect(picked.cleared).toEqual({
      cookies: { removed: 1, domains: ["shop.example.com"] },
    });
    expect(page.jar.map((item) => item.name)).toEqual([
      "sid",
      "theme",
      "sid",
      "sid",
    ]);
  });

  it("an isolated agent space clears at once for any origin", async () => {
    const { siteData, controller, space, tab, page, holds } = setup({
      isolated: true,
    });
    expect(partitionUse(space)).toBe("isolated");
    page.jar = [cookie({ name: "sid", domain: "elsewhere.example" })];
    const run = fakeRun();
    const result = await siteData.clear(
      tab.id,
      request({
        origin: "https://elsewhere.example",
        cookies: true,
        storage: ["localStorage"],
        cache: true,
      }),
      run,
    );
    expect(result).toEqual({
      ok: true,
      origin: "https://elsewhere.example",
      cleared: {
        cookies: { removed: 1, domains: ["elsewhere.example"] },
        storage: ["localStorage"],
        cache: true,
      },
    });
    expect(run.dispatch.dispatched).toBe(true);
    expect(holds).not.toHaveBeenCalled();
    expect(controller.state.approvals).toEqual([]);
    expect(space.owner).toBe("agent");
    expect(controller.activity.at(-1)).toMatchObject({
      spaceId: space.id,
      message: "Agent cleared site data for https://elsewhere.example",
    });
    // Every other space uses the person's sign-ins, or is the person's.
    expect(partitionUse({ ...space, signIns: "shared" })).toBe("person");
    expect(
      partitionUse({ ...space, kind: "personal", signIns: "separate" }),
    ).toBe("person");
  });

  it("an approval holds the space, Clear runs once and returns control", async () => {
    const { siteData, controller, space, tab, page, holds, releases, asked } =
      setup();
    expect(partitionUse(space)).toBe("person");
    page.jar = [
      cookie({ name: "sid", domain: ".example.com" }),
      cookie({ name: "theme", domain: "shop.example.com" }),
    ];
    const run = fakeRun();
    const clearing = siteData.clear(
      tab.id,
      request({ cookies: true, storage: ["localStorage"], cache: true }),
      run,
    );
    const approval = await asked();
    expect(holds).toHaveBeenCalledExactlyOnceWith(space.id, "approval", PROMPT);
    expect(space).toMatchObject({
      owner: "human",
      control: { reason: "approval", prompt: PROMPT },
    });
    expect(space.task).toMatchObject({ state: "needs-you", reason: PROMPT });
    expect(approval).toEqual({
      id: expect.any(String),
      spaceId: space.id,
      tabId: tab.id,
      origin: SHOP,
      cookies: { count: 2, domains: ["example.com", "shop.example.com"] },
      storage: ["localStorage"],
      cache: true,
    });
    // Nothing goes before the person answers.
    expect(page.removedCookies).toEqual([]);
    expect(page.storageClears).toEqual([]);
    expect(page.dataClears).toEqual([]);
    expect(run.dispatch.dispatched).toBe(false);
    siteData.answer(approval.id, true);
    // A second answer finds nothing left to answer.
    siteData.answer(approval.id, true);
    siteData.answer(approval.id, false);
    expect(await clearing).toEqual({
      ok: true,
      origin: SHOP,
      cleared: {
        cookies: { removed: 2, domains: ["example.com", "shop.example.com"] },
        storage: ["localStorage"],
        cache: true,
      },
      approvedBy: "person",
    });
    expect(page.removedCookies).toHaveLength(2);
    expect(page.storageClears).toHaveLength(1);
    expect(page.dataClears).toHaveLength(1);
    expect(run.dispatch.dispatched).toBe(true);
    expect(controller.state.approvals).toEqual([]);
    expect(releases).toHaveBeenCalledOnce();
    expect(space.owner).toBe("agent");
    expect(space.task?.state).toBeUndefined();
    expect(controller.activity.at(-1)?.message).toBe(
      `Agent cleared site data for ${SHOP}`,
    );
  });

  it("Don't clear, a timeout and a takeover clear nothing", async () => {
    // Don't clear.
    const declined = setup();
    declined.page.jar = [cookie({ name: "sid", domain: ".example.com" })];
    const refusing = rejection(
      declined.siteData.clear(
        declined.tab.id,
        request({ cookies: true }),
        fakeRun(),
      ),
    );
    declined.siteData.answer((await declined.asked()).id, false);
    expect(await refusing).toEqual({
      code: "clear_declined",
      status: 403,
      origin: SHOP,
    });
    declined.untouched();
    expect(declined.page.jar).toHaveLength(1);
    expect(declined.controller.state.approvals).toEqual([]);
    expect(declined.space.owner).toBe("agent");

    // No answer in time. The person was asked, and the bar went with the
    // request.
    const silent = setup();
    const waiting = rejection(
      silent.siteData.clear(
        silent.tab.id,
        request({ storage: true, timeoutMs: 30 }),
        fakeRun(),
      ),
    );
    expect(await waiting).toEqual({
      code: "approval_timeout",
      status: 504,
      awaited: "approval",
      origin: SHOP,
      timeoutMs: 30,
    });
    expect(silent.holds).toHaveBeenCalledOnce();
    silent.untouched();
    expect(silent.controller.state.approvals).toEqual([]);
    expect(silent.space.owner).toBe("agent");

    // The person takes over, which makes the hold theirs.
    const taken = setup();
    const held = rejection(
      taken.siteData.clear(taken.tab.id, request({ cache: true }), fakeRun()),
    );
    const approval = await taken.asked();
    await taken.controller.dispatch({
      type: "space:ownership",
      id: taken.space.id,
      owner: "human",
    });
    expect(await held).toMatchObject({
      code: "human_control",
      status: 409,
      reason: "manual",
    });
    // A Clear that arrives after the takeover finds nothing to answer.
    taken.siteData.answer(approval.id, true);
    taken.untouched();
    expect(taken.controller.state.approvals).toEqual([]);
    expect(taken.space.owner).toBe("human");
    // The mark the approval set goes with it.
    expect(taken.space.task?.state).toBeUndefined();
  });

  it("Stop, agent access off, a closed tab and a disconnected client withdraw the request", async () => {
    // Stop.
    const stopped = setup();
    const stopping = rejection(
      stopped.siteData.clear(
        stopped.tab.id,
        request({ cache: true }),
        fakeRun(),
      ),
    );
    await stopped.asked();
    stopped.controller.endAccess(stopped.space.id, {
      by: "person",
      reason: "stopped",
    });
    expect(await stopping).toMatchObject({ code: "space_ended", status: 409 });
    stopped.untouched();
    expect(stopped.controller.state.approvals).toEqual([]);

    // Agent access off.
    const off = setup();
    const ending = rejection(
      off.siteData.clear(off.tab.id, request({ cache: true }), fakeRun()),
    );
    await off.asked();
    off.siteData.dispose();
    expect(await ending).toEqual({
      code: "automation_stopped",
      status: 503,
    });
    off.untouched();
    expect(off.controller.state.approvals).toEqual([]);
    expect(off.releases).toHaveBeenCalledOnce();

    // The tab closes.
    const closed = setup();
    const closing = rejection(
      closed.siteData.clear(closed.tab.id, request({ cache: true }), fakeRun()),
    );
    await closed.asked();
    closed.controller.closeTab(closed.tab.id, "person");
    expect(await closing).toMatchObject({ code: "tab_closed", status: 409 });
    closed.untouched();
    expect(closed.controller.state.approvals).toEqual([]);

    // The client goes away.
    const gone = setup();
    const abort = new AbortController();
    const leaving = rejection(
      gone.siteData.clear(
        gone.tab.id,
        request({ cache: true }),
        fakeRun(abort.signal),
      ),
    );
    await gone.asked();
    abort.abort();
    expect(await leaving).toEqual({ dropped: true });
    gone.untouched();
    expect(gone.controller.state.approvals).toEqual([]);
    expect(gone.space.owner).toBe("agent");
  });

  it("storage names map to Electron's storages and cache clears by origin", async () => {
    expect(STORAGE_NAMES).toEqual({
      localStorage: "localstorage",
      indexedDB: "indexdb",
      cacheStorage: "cachestorage",
      serviceWorkers: "serviceworkers",
      fileSystem: "filesystem",
    });
    const { siteData, tab, page } = setup({ isolated: true });
    const some = await siteData.clear(
      tab.id,
      request({ storage: ["indexedDB", "serviceWorkers"] }),
      fakeRun(),
    );
    expect(some.cleared).toEqual({ storage: ["indexedDB", "serviceWorkers"] });
    const every = await siteData.clear(
      tab.id,
      request({ storage: true, cache: true }),
      fakeRun(),
    );
    expect(every.cleared).toEqual({
      storage: [
        "localStorage",
        "indexedDB",
        "cacheStorage",
        "serviceWorkers",
        "fileSystem",
      ],
      cache: true,
    });
    // Every clear names the one origin, so nothing clears a whole session.
    expect(page.storageClears).toEqual([
      { origin: SHOP, storages: ["indexdb", "serviceworkers"] },
      {
        origin: SHOP,
        storages: [
          "localstorage",
          "indexdb",
          "cachestorage",
          "serviceworkers",
          "filesystem",
        ],
      },
    ]);
    expect(page.dataClears).toEqual([
      { dataTypes: ["cache"], origins: [SHOP] },
    ]);
  });
});
