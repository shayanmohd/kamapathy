import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSignInPasswords,
  SAVE_AFTER_COMMIT_MS,
  SIGN_IN_CONFIRM,
  SIGN_IN_LOGINS,
  type SignInChallenge,
} from "../electron/passwords/sign-in";
import { memorySealer, type Sealer } from "../electron/passwords/seal";
import { Vault, type VaultFiles } from "../electron/passwords/vault";
import { initialState, newTab } from "../shared/state";
import type { Space } from "../shared/types";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const reverse = (text: string) => Buffer.from(text, "utf8").reverse();
// Seals by reversing bytes: the file is never text, and no keychain is used.
const reversing: Sealer = {
  check: async () => {},
  seal: async (text) => reverse(text),
  open: async (sealed) => ({
    text: Buffer.from(sealed).reverse().toString("utf8"),
    stale: false,
  }),
};
function memoryFiles() {
  const store = new Map<string, Buffer>();
  return {
    async read(path: string) {
      return store.get(path);
    },
    async write(path: string, data: Buffer) {
      store.set(path, data);
    },
    async rename(from: string, to: string) {
      const data = store.get(from);
      if (!data) throw new Error("No such file.");
      store.delete(from);
      store.set(to, data);
    },
  } satisfies VaultFiles;
}
// The run's own sealer, with what it was asked to hold.
function recordingSealer() {
  const base = memorySealer();
  const sealer = {
    seals: [] as string[],
    opens: 0,
    check: base.check,
    async seal(text: string) {
      sealer.seals.push(text);
      return base.seal(text);
    },
    async open(sealed: Buffer) {
      sealer.opens += 1;
      return base.open(sealed);
    },
  };
  return sealer;
}

// A page the save waits on: did-navigate, destroyed and nothing else.
class FakePage extends EventEmitter {
  destroyed = false;
  isDestroyed() {
    return this.destroyed;
  }
  navigate(url: string, code: number) {
    this.emit("did-navigate", {}, url, code, "OK");
  }
  destroy() {
    this.destroyed = true;
    this.emit("destroyed");
  }
  listening() {
    return this.listenerCount("did-navigate") + this.listenerCount("destroyed");
  }
  get contents() {
    return this as unknown as Electron.WebContents;
  }
}

// The person's spaces, a granted Work space and an agent space they took
// over, with a tab in each.
function browserState() {
  const state = initialState("darwin");
  const work = state.spaces.find((space) => space.id === "work")!;
  work.access = "granted";
  const agent: Space = {
    id: "agent",
    name: "Task",
    color: "purple",
    kind: "agent",
    owner: "human",
    signIns: "shared",
    createdAt: 0,
    access: "granted",
  };
  state.spaces.push(agent);
  const agentTab = newTab(agent.id, "https://files.example/");
  state.tabs.push(agentTab);
  const [personalTab, workTab] = state.tabs;
  return {
    state,
    agent,
    tabs: { personal: personalTab, work: workTab, agent: agentTab },
  };
}

function setup() {
  let clock = 1_000_000;
  const vault = new Vault({
    path: "/passwords/vault.bin",
    sealer: reversing,
    files: memoryFiles(),
    now: () => clock,
  });
  const { state, agent, tabs } = browserState();
  const confirm = vi.fn(async (_message: string, _button: string) => true);
  const memory = recordingSealer();
  const passwords = createSignInPasswords({
    vault,
    state: () => state,
    confirm,
    memory,
    now: () => clock,
  });
  return {
    vault,
    state,
    agent,
    tabs,
    confirm,
    memory,
    passwords,
    now: () => clock,
    advance(ms: number) {
      clock += ms;
      vi.advanceTimersByTime(ms);
    },
    // Time passing while the timer is starved, as a busy main process does.
    drift(ms: number) {
      clock += ms;
    },
  };
}

// Everything here reads and writes in memory, so promises settle on their own.
const settle = async () => {
  for (let step = 0; step < 50; step += 1) await Promise.resolve();
};
const staff: SignInChallenge = {
  origin: "https://files.example",
  realm: "Staff only",
  isProxy: false,
  mainFrame: true,
};
const saved = (username: string) => ({ id: expect.any(String), username });

describe("saved HTTP sign-ins", () => {
  it("lists up to 8 http logins for the challenge's origin and realm, none for proxies", async () => {
    const { vault, state, passwords } = setup();
    await vault.open();
    // Ten sign-ins for one challenge, used in the order they were added.
    for (let index = 0; index < 10; index += 1)
      await vault.add({
        kind: "http",
        origin: "https://files.example",
        realm: "Staff only",
        username: `user${index}`,
        password: `secret-${index}`,
        usedAt: 1000 + index,
      });
    await vault.add({
      kind: "http",
      origin: "https://files.example",
      realm: "Everyone",
      username: "guest",
      password: "guest",
    });
    await vault.add({
      kind: "form",
      origin: "https://files.example",
      username: "typed",
      password: "typed",
    });
    expect(passwords.savedLogins(staff)).toEqual(
      [9, 8, 7, 6, 5, 4, 3, 2].map((index) => saved(`user${index}`)),
    );
    expect(passwords.savedLogins(staff)).toHaveLength(SIGN_IN_LOGINS);
    expect(passwords.savedLogins({ ...staff, realm: "Everyone" })).toEqual([
      saved("guest"),
    ]);
    expect(passwords.savedLogins({ ...staff, realm: "" })).toEqual([]);
    expect(
      passwords.savedLogins({ ...staff, origin: "https://other.example" }),
    ).toEqual([]);
    // A proxy is answered by the person alone.
    expect(passwords.savedLogins({ ...staff, isProxy: true })).toEqual([]);

    expect(passwords.canSave(staff)).toBe(true);
    expect(passwords.canSave({ ...staff, isProxy: true })).toBe(false);
    expect(passwords.canSave({ ...staff, mainFrame: false })).toBe(false);
    state.settings.offerToSavePasswords = false;
    expect(passwords.canSave(staff)).toBe(false);

    // A vault that is not ready lists nothing and takes nothing.
    const waiting = setup();
    expect(waiting.vault.state).toBe("opening");
    expect(waiting.passwords.savedLogins(staff)).toEqual([]);
    expect(waiting.passwords.canSave(staff)).toBe(false);
    // An empty one has nothing to list and can still save.
    expect(await waiting.vault.open()).toBe("empty");
    expect(waiting.passwords.savedLogins(staff)).toEqual([]);
    expect(waiting.passwords.canSave(staff)).toBe(true);
  });

  it("uses a saved login only for its own challenge and confirms under agent rules", async () => {
    const { vault, tabs, confirm, passwords, now } = setup();
    await vault.open();
    const login = await vault.add({
      kind: "http",
      origin: "https://files.example",
      realm: "Staff only",
      username: "ada",
      password: "hunter2",
    });
    const form = await vault.add({
      kind: "form",
      origin: "https://files.example",
      username: "ada",
      password: "hunter2",
    });
    // The person's own space asks nothing, and the use is recorded.
    expect(await passwords.useSaved(tabs.personal.id, login.id, staff)).toEqual(
      { username: "ada", password: "hunter2" },
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(vault.get(login.id)?.usedAt).toBe(now());
    await vault.flush();

    const no = async (loginId: string, challenge: SignInChallenge) =>
      expect(
        await passwords.useSaved(tabs.personal.id, loginId, challenge),
      ).toBeUndefined();
    await no(form.id, staff);
    await no(login.id, { ...staff, origin: "https://other.example" });
    await no(login.id, { ...staff, realm: "Everyone" });
    await no(login.id, { ...staff, isProxy: true });
    await no("missing", staff);
    // A tab of no space signs in to nothing.
    expect(await passwords.useSaved("gone", login.id, staff)).toBeUndefined();

    // An agent space the person took over, and a granted personal space,
    // say what agents would see before the sign-in is used.
    for (const tabId of [tabs.agent.id, tabs.work.id]) {
      confirm.mockClear();
      expect(await passwords.useSaved(tabId, login.id, staff)).toEqual({
        username: "ada",
        password: "hunter2",
      });
      expect(confirm).toHaveBeenCalledExactlyOnceWith(
        SIGN_IN_CONFIRM,
        "Sign in",
      );
      await vault.flush();
    }
    expect(SIGN_IN_CONFIRM).toBe("Agents can see sign-ins used in this space.");
    confirm.mockResolvedValue(false);
    expect(
      await passwords.useSaved(tabs.agent.id, login.id, staff),
    ).toBeUndefined();
  });

  it("saves typed credentials after a non-401 commit, never on 401", async () => {
    vi.useFakeTimers();
    const { vault, passwords, memory, advance, drift, now } = setup();
    await vault.open();
    const page = new FakePage();
    passwords.saveAfterCommit(page.contents, staff, {
      username: "ada",
      password: "hunter2",
    });
    await settle();
    // The typed password waits sealed, and is opened only to be saved.
    expect(memory.seals).toEqual(["hunter2"]);
    expect(memory.opens).toBe(0);
    expect(vault.list()).toEqual([]);
    expect(page.listening()).toBe(2);
    page.navigate("https://files.example/private/", 200);
    await settle();
    expect(vault.list()).toMatchObject([
      {
        kind: "http",
        origin: "https://files.example",
        realm: "Staff only",
        username: "ada",
      },
    ]);
    expect(memory.opens).toBe(1);
    expect(page.listening()).toBe(0);
    const [first] = vault.list();

    // The same username under another password is updated, and the
    // compromised mark goes with the old password.
    await vault.update(first.id, { password: "old" });
    const marked = await vault.add({
      kind: "http",
      origin: "https://shop.example",
      realm: "Orders",
      username: "ada",
      password: "old",
      compromised: "leaked",
    });
    const orders: SignInChallenge = {
      origin: "https://shop.example",
      realm: "Orders",
      isProxy: false,
      mainFrame: true,
    };
    const second = new FakePage();
    passwords.saveAfterCommit(second.contents, orders, {
      username: "ada",
      password: "new",
    });
    advance(1000);
    second.navigate("https://shop.example/orders", 302);
    await settle();
    expect(vault.list()).toHaveLength(2);
    expect(vault.get(marked.id)?.compromised).toBeUndefined();
    expect(vault.get(marked.id)?.changedAt).toBe(now());
    expect(await vault.passwordEquals(marked.id, "new")).toBe(true);

    // Saving what is already saved only records the use.
    const changedAt = vault.get(marked.id)!.changedAt;
    const third = new FakePage();
    passwords.saveAfterCommit(third.contents, orders, {
      username: "ada",
      password: "new",
    });
    advance(1000);
    third.navigate("https://shop.example/orders", 200);
    await settle();
    expect(vault.list()).toHaveLength(2);
    expect(vault.get(marked.id)).toMatchObject({
      changedAt,
      usedAt: now(),
    });
    await vault.flush();

    // A refused sign-in, another origin, a page that went away and a
    // commit that comes too late all save nothing.
    const quiet = async (
      prepare: (page: FakePage) => void,
      typed = { username: "zoe", password: "zoe-secret" },
    ) => {
      const page = new FakePage();
      passwords.saveAfterCommit(page.contents, staff, typed);
      await settle();
      prepare(page);
      await settle();
      expect(vault.list()).toHaveLength(2);
      expect(page.listening()).toBe(0);
    };
    await quiet((page) => page.navigate("https://files.example/private/", 401));
    await quiet((page) => page.navigate("https://other.example/", 200));
    await quiet((page) => {
      page.destroy();
      page.navigate("https://files.example/private/", 200);
    });
    await quiet(() => {
      advance(SAVE_AFTER_COMMIT_MS + 1);
    });
    // A commit that arrives late is dropped even if its timer was starved.
    const late = new FakePage();
    passwords.saveAfterCommit(late.contents, staff, {
      username: "zoe",
      password: "zoe-secret",
    });
    await settle();
    drift(SAVE_AFTER_COMMIT_MS + 1);
    late.navigate("https://files.example/private/", 200);
    await settle();
    expect(vault.list()).toHaveLength(2);
    expect(late.listening()).toBe(0);
    // Nothing more was saved, so nothing of the person's was opened again.
    expect(memory.seals).toHaveLength(8);
    expect(memory.opens).toBe(3);
  });
});
